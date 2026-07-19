// One open cue file: its Project, its playback engine, and every operation that
// acts on them. The app can hold several of these at once (one per document
// tab); AppState owns the list and forwards the active one's members so the UI
// mostly doesn't have to care.

import { AudioEngine } from '../audio/AudioEngine';
import { loadAudioBytes, writeCueFile, writeMediaFile } from '../fs/projectFs';
import type { Folder } from './folder.svelte';
import {
  defaultAudioCue,
  defaultHttpCue,
  defaultProxyCue,
  defaultTimerCue,
  makeId,
  defaultGlobalCue,
  type AudioCue,
  type Cue,
  type CueRef,
  type CueType,
  type GlobalAction,
  type GlobalCue,
  type PlaybackState,
  type Project,
  type Tab,
  type TimerAction,
  type TimerCue,
  type Trigger,
  type TriggerAction,
  type TriggerEvent,
} from '../types';

export interface HttpFlash {
  state: 'firing' | 'ok' | 'error';
  at: number;
}

/** One thing a hovered cue would do to another cue. */
export interface TriggerHint {
  /** The hovered cue's event that fires it. */
  event: TriggerEvent;
  /** What the target receives. */
  action: TriggerAction;
  /** True if clicking the hovered cue right now would fire this. */
  now: boolean;
}

/** What a tile needs to paint itself. */
export interface CueDisplay {
  name: string;
  color: string;
  state: PlaybackState;
  /** No media, or the file named by the cue isn't in the folder. */
  missing: boolean;
  /** Media is still being read/decoded — not an error, just not ready yet. */
  pending: boolean;
}

/**
 * The app-level services a document drives but doesn't own: the single global
 * countdown timer, and access to sibling documents for cross-document global
 * cues.
 */
export interface TimerHost {
  setTimer(seconds: number): void;
  pauseTimer(): void;
  resumeTimer(): void;
  clearTimer(): void;
  /** Register what to run when the countdown reaches zero on its own. */
  claimTimer(onFinished: () => void): void;
  /** Every open document, including the caller. */
  eachDocument(fn: (doc: Doc) => void): void;
}

/**
 * How many audio files to read + decode at once when opening a document.
 *
 * Decoding is genuinely parallel (the browser decodes off the main thread, and
 * loudness measurement runs in a worker pool), so serialising it — as this used
 * to — left most of the machine idle. The cap exists because each in-flight file
 * holds its compressed bytes, its decoded buffer, and a copy of that buffer for
 * measurement all at once; unbounded parallelism on a large show would spike
 * memory hard enough to matter.
 */
const DECODE_CONCURRENCY = 4;

export class Doc {
  readonly id = makeId('doc');
  readonly folder: Folder;
  private engine = new AudioEngine();

  project = $state<Project>(null!);
  /** Name of the cue file this was loaded from (null for a new unsaved one). */
  currentFileName = $state<string | null>(null);
  /** File name that Save writes to. */
  saveName = $state('');
  activeTabId = $state('');
  dirty = $state(false);
  loading = $state(false);
  loadProgress = $state({ done: 0, total: 0 });
  errorMessage = $state('');

  /** Playback state per audio cue id. */
  playStates = $state<Record<string, PlaybackState>>({});
  /**
   * Whether each audio cue's media is decoded and ready to fire.
   *
   * This mirrors the engine's binding table into reactive state on purpose. The
   * engine resolves buffers through a plain Map in the shared cache, which
   * nothing can subscribe to — so a tile asking "is my media here?" during
   * render would read `false` while decoding was in flight and never hear about
   * it finishing. Tiles read this record instead, and get repainted the moment
   * their file lands.
   */
  audioStatus = $state<Record<string, 'pending' | 'ready' | 'missing'>>({});
  /** Transient HTTP fire feedback per cue id. */
  httpFlashes = $state<Record<string, HttpFlash>>({});
  /** Bumped by rAF while audio is playing so progress readouts stay live. */
  tick = $state(0);

  private timerHost: TimerHost;
  private rafId = 0;

  // Trigger re-entrancy guard.
  private firing = new Set<string>();
  private propagating = 0;

  constructor(folder: Folder, project: Project, saveName: string, timerHost: TimerHost, sourceName: string | null = null) {
    this.folder = folder;
    this.timerHost = timerHost;
    this.project = project;
    this.saveName = saveName;
    this.currentFileName = sourceName;
    this.activeTabId = project.tabs[0]?.id ?? '';
    this.engine.setMasterVolume(project.masterVolume);

    this.engine.onStateChange = (id, state) => {
      this.playStates[id] = state;
      if (state !== 'idle') this.ensureRaf();
    };
    this.engine.onCueEvent = (id, event) => {
      this.propagate(() => this.fireTriggers(id, event));
    };
  }

  /** Label for this document's tab. */
  get title(): string {
    return this.currentFileName ?? this.saveName;
  }

  // ---- Derived accessors -------------------------------------------------

  get activeTab(): Tab | null {
    return this.project.tabs.find((t) => t.id === this.activeTabId) ?? this.project.tabs[0] ?? null;
  }

  cueAt(tab: Tab, row: number, col: number): Cue | undefined {
    return tab.cues.find((c) => c.row === row && c.col === col);
  }

  findCue(id: string): Cue | null {
    for (const tab of this.project.tabs) {
      const found = tab.cues.find((c) => c.id === id);
      if (found) return found;
    }
    return null;
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Whether any cue in this document is currently sounding. */
  get isPlaying(): boolean {
    // Reads reactive playback state rather than asking the engine, so callers
    // in markup re-evaluate as cues start and stop.
    return Object.values(this.playStates).some((s) => s !== 'idle');
  }

  hasBuffer(id: string): boolean {
    return this.audioStatus[id] === 'ready';
  }

  // ---- Loading / saving --------------------------------------------------

  /** Best-effort resolve a cue's file to an existing path (exact, else basename). */
  private resolveAudioPath(file: string): string | null {
    if (!file) return null;
    const files = this.folder.audioFiles;
    if (files.includes(file)) return file;
    const base = file.split('/').pop();
    return files.find((f) => f.split('/').pop() === base) ?? null;
  }

  /** Bind a cue to its file, keeping `audioStatus` in step with the outcome. */
  private async bindCue(cue: AudioCue, path: string): Promise<void> {
    this.audioStatus[cue.id] = 'pending';
    try {
      await this.engine.load(cue.id, this.folder.id, path, () =>
        loadAudioBytes(this.folder.dir, path),
      );
      this.audioStatus[cue.id] = 'ready';
    } catch (err) {
      this.audioStatus[cue.id] = 'missing';
      throw err;
    }
  }

  /** Read and decode every audio cue's file, a few at a time. */
  async decodeAll(): Promise<void> {
    const jobs: { cue: AudioCue; path: string }[] = [];
    for (const tab of this.project.tabs) {
      for (const cue of tab.cues) {
        if (cue.type !== 'audio') continue;
        const resolved = cue.file ? this.resolveAudioPath(cue.file) : null;
        if (!resolved) {
          // No file set, or the file named in the cue isn't in the folder.
          this.audioStatus[cue.id] = 'missing';
          continue;
        }
        // Point the cue at the actual file found in the folder tree.
        if (resolved !== cue.file) cue.file = resolved;
        // Mark pending up front so the grid — which renders while this runs —
        // shows these as loading rather than as broken.
        this.audioStatus[cue.id] = 'pending';
        jobs.push({ cue, path: resolved });
      }
    }

    this.loading = true;
    this.loadProgress = { done: 0, total: jobs.length };
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        try {
          await this.bindCue(job.cue, job.path);
        } catch (err) {
          console.warn(`Failed to load "${job.path}":`, err);
        }
        this.loadProgress = { done: this.loadProgress.done + 1, total: jobs.length };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(DECODE_CONCURRENCY, jobs.length) }, () => worker()),
    );
    this.loading = false;
  }

  /** Decode a single cue's file (after adding/changing it). */
  async reloadCueAudio(cue: AudioCue): Promise<void> {
    if (!cue.file) {
      this.audioStatus[cue.id] = 'missing';
      return;
    }
    const resolved = this.resolveAudioPath(cue.file) ?? cue.file;
    // Point the cue at the real path so its cache key matches the decoded file.
    if (resolved !== cue.file) cue.file = resolved;
    try {
      await this.bindCue(cue, resolved);
    } catch (err) {
      console.warn(`Failed to load "${resolved}":`, err);
    }
  }

  async save(): Promise<void> {
    try {
      await writeCueFile(this.folder.dir, this.saveName, $state.snapshot(this.project));
      this.currentFileName = this.saveName;
      if (!this.folder.cueFiles.includes(this.saveName)) await this.folder.refreshCueFiles();
      this.dirty = false;
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  /** Stop playback and release this document's buffers. */
  close(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.engine.dispose();
  }

  // ---- Cue resolution ----------------------------------------------------

  resolveRef(ref: CueRef): Cue | null {
    return this.findCue(ref.cueId);
  }

  /** Which tab currently holds this cue. */
  tabOf(cue: Cue): Tab | null {
    return this.project.tabs.find((t) => t.cues.some((c) => c.id === cue.id)) ?? null;
  }

  /** Follow a proxy to the cue that actually holds the media. */
  resolveProxy(cue: Cue, seen = new Set<string>()): Cue | null {
    if (cue.type !== 'proxy') return cue;
    if (seen.has(cue.id)) return null; // cycle
    seen.add(cue.id);
    const src = this.resolveRef(cue.source);
    if (!src) return null;
    return this.resolveProxy(src, seen);
  }

  /** What a tile should display (proxies mirror their source). */
  display(cue: Cue): CueDisplay {
    if (cue.type === 'proxy') {
      const src = this.resolveProxy(cue);
      if (!src || src.type === 'proxy') {
        return { name: 'proxy?', color: '#555', state: 'idle', missing: true, pending: false };
      }
      // A proxy is only "missing" if it points nowhere; otherwise it mirrors
      // whatever its source is doing, including that source still loading.
      const inner = this.display(src);
      return { ...inner, missing: false };
    }
    if (cue.type === 'http' || cue.type === 'timer' || cue.type === 'global') {
      return { name: cue.name, color: cue.color, state: 'idle', missing: false, pending: false };
    }
    const status = this.audioStatus[cue.id] ?? 'missing';
    return {
      name: cue.name,
      color: cue.color,
      state: this.playStates[cue.id] ?? 'idle',
      missing: status === 'missing',
      pending: status === 'pending',
    };
  }

  /**
   * The event clicking this cue would fire right now — what "on this click"
   * means for the trigger badges.
   *
   * An idle cue is about to be started. A playing one is about to be stopped,
   * which fires onPause instead when the cue is set to keep its position.
   * Everything else (timer, http, global) only ever fires onStart when run.
   */
  imminentEvent(cue: Cue): TriggerEvent {
    const subject = this.resolveProxy(cue) ?? cue;
    if (subject.type !== 'audio') return 'onStart';
    if ((this.playStates[subject.id] ?? 'idle') === 'idle') return 'onStart';
    return subject.onStopBehavior === 'pause' ? 'onPause' : 'onStop';
  }

  /**
   * Every cue the given cue's triggers point at, keyed by target id, each
   * carrying what would happen to it and when.
   *
   * This drives the hover preview: hovering a cue marks up the tiles it drives,
   * with `now` distinguishing the ones this click sets off from the ones that
   * fire later in the cue's life. Unlike the dispatch path this includes *all*
   * events, not just the imminent one — the point is to show the whole reach of
   * a cue at a glance.
   *
   * Triggers whose target no longer resolves are dropped; they'd do nothing.
   * A proxy previews its source's triggers, since clicking it is what fires them.
   */
  previewTargets(cueId: string | null): Map<string, TriggerHint[]> {
    const out = new Map<string, TriggerHint[]>();
    if (!cueId) return out;
    const cue = this.findCue(cueId);
    if (!cue) return out;
    const subject = this.resolveProxy(cue);
    if (!subject) return out;

    const imminent = this.imminentEvent(cue);
    const add = (id: string, hint: TriggerHint) => {
      const list = out.get(id);
      if (list) list.push(hint);
      else out.set(id, [hint]);
    };

    for (const trig of subject.triggers) {
      const target = this.resolveRef(trig.target);
      if (!target) continue;
      const hint: TriggerHint = {
        event: trig.event,
        action: trig.action,
        now: trig.event === imminent,
      };
      add(target.id, hint);
      // A proxy target controls something else — mark that tile too, so the
      // chain is visible end to end.
      const effective = this.resolveProxy(target);
      if (effective && effective.id !== target.id) add(effective.id, hint);
    }

    // Imminent first, so the blue badge leads on tiles driven by both.
    for (const list of out.values()) list.sort((a, b) => Number(b.now) - Number(a.now));
    return out;
  }

  // ---- Playback / dispatch ----------------------------------------------

  /** User clicked a tile (or a trigger fired a "click"). */
  activate(cue: Cue): void {
    this.propagate(() => this.performAction(cue, 'click'));
  }

  private performAction(cue: Cue, action: TriggerAction, fade?: boolean): void {
    const target = this.resolveProxy(cue);
    if (!target) return;
    this.firing.add(target.id);

    if (target.type === 'audio') {
      const f = fade ?? false;
      switch (action) {
        case 'click':
          this.engine.toggle(target);
          break;
        case 'start':
          this.engine.start(target, f, true);
          break;
        case 'pause':
          this.engine.pause(target, f);
          break;
        case 'resume':
          this.engine.resume(target, f);
          break;
        case 'stop':
          this.engine.stop(target, f, 'stop');
          break;
      }
    } else if (target.type === 'http') {
      this.fireHttp(target);
    } else if (target.type === 'global') {
      this.runGlobalCue(target);
    } else if (target.type === 'timer') {
      if (action === 'click') {
        this.runTimerCue(target);
      } else if (action === 'set' || action === 'pause' || action === 'resume' || action === 'clear') {
        this.applyTimerAction(target, action);
        this.fireTriggers(target.id, 'onStart');
      }
    }
  }

  private applyTimerAction(cue: TimerCue, action: TimerAction): void {
    switch (action) {
      case 'set':
        // Claim the shared timer so *this* document's cue chains off its end.
        this.timerHost.claimTimer(() => this.propagate(() => this.fireTriggers(cue.id, 'onStop')));
        this.timerHost.setTimer(cue.duration);
        break;
      case 'pause':
        this.timerHost.pauseTimer();
        break;
      case 'resume':
        this.timerHost.resumeTimer();
        break;
      case 'clear':
        this.timerHost.clearTimer();
        break;
    }
  }

  /**
   * Run a global cue: apply its action to every audio cue in scope.
   *
   * Each cue is driven through the same engine calls a trigger would use, so
   * affected cues fire their own onStop/onPause triggers as usual and the
   * re-entrancy guard keeps a global cue from being re-entered by the chains it
   * sets off.
   */
  private runGlobalCue(cue: GlobalCue): void {
    if (cue.scope === 'all') this.timerHost.eachDocument((doc) => doc.applyToAllAudio(cue.action, cue.fade));
    else this.applyToAllAudio(cue.action, cue.fade);
    // Global cues can also chain onStart triggers.
    this.fireTriggers(cue.id, 'onStart');
  }

  /**
   * Apply a global action to every audio cue in this document. Public so a
   * global cue in *another* document can reach in when its scope is 'all'.
   *
   * Non-playing cues are skipped by the engine itself (stop/pause no-op when
   * idle, resume no-ops without a saved position), so this is safe to fire at
   * a whole show.
   *
   * "Everything" means everything *except what this chain already acted on* —
   * the `firing` guard is read but deliberately not added to, and that
   * asymmetry is doing real work in both directions:
   *
   *   * Reading it exempts the cue that set the chain off. A jingle whose
   *     onStart clicks "stop all" silences the show and keeps playing itself,
   *     because starting it marked it before the global cue ran.
   *   * Not adding to it leaves the affected cues free for what comes after.
   *     The global cue's own onStart triggers can start a cue this call just
   *     stopped — the "stop everything, then roll the next track" chain.
   *
   * Loop safety doesn't depend on marking them: performAction marked the
   * *global* cue before calling us, so a chain circling back to it stops there.
   */
  applyToAllAudio(action: GlobalAction, fade: boolean): void {
    this.propagate(() => {
      for (const tab of this.project.tabs) {
        for (const c of tab.cues) {
          if (c.type !== 'audio') continue;
          if (this.firing.has(c.id)) continue;
          if (action === 'stop') this.engine.stop(c, fade, 'stop');
          else if (action === 'pause') this.engine.pause(c, fade);
          else this.engine.resume(c, fade);
        }
      }
    });
  }

  private runTimerCue(cue: TimerCue): void {
    this.applyTimerAction(cue, cue.action);
    // Timer cues can also chain onStart triggers.
    this.fireTriggers(cue.id, 'onStart');
  }

  private fireTriggers(cueId: string, event: Trigger['event']): void {
    const cue = this.findCue(cueId);
    if (!cue) return;
    for (const trig of cue.triggers) {
      if (trig.event !== event) continue;
      const target = this.resolveRef(trig.target);
      if (!target) continue;
      const effective = this.resolveProxy(target);
      if (!effective || this.firing.has(effective.id)) continue;
      this.performAction(effective, trig.action, trig.fade);
    }
  }

  private propagate(fn: () => void): void {
    this.propagating += 1;
    try {
      fn();
    } finally {
      this.propagating -= 1;
      if (this.propagating === 0) this.firing.clear();
    }
  }

  private async fireHttp(cue: Cue): Promise<void> {
    if (cue.type !== 'http') return;
    this.httpFlashes[cue.id] = { state: 'firing', at: Date.now() };
    // HTTP cues can also chain onStart triggers.
    this.fireTriggers(cue.id, 'onStart');
    try {
      const init: RequestInit = {
        method: cue.method,
        headers: cue.headers,
        mode: 'cors',
      };
      if (cue.method !== 'GET' && cue.body) init.body = cue.body;
      const res = await fetch(cue.url, init);
      this.httpFlashes[cue.id] = { state: res.ok ? 'ok' : 'error', at: Date.now() };
    } catch {
      this.httpFlashes[cue.id] = { state: 'error', at: Date.now() };
    }
  }

  setMasterVolume(v: number): void {
    this.project.masterVolume = v;
    this.engine.setMasterVolume(v);
    this.markDirty();
  }

  // ---- Progress readouts (reactive via `tick`) ---------------------------

  progress(cue: AudioCue): number {
    void this.tick; // reactive dependency
    const dur = this.engine.getDuration(cue);
    if (dur <= 0) return 0;
    return Math.min(1, (this.engine.getPosition(cue) - cue.startTime) / dur);
  }

  /** How far through its current fade a cue is (0..1); 1 when not fading. */
  fadeProgress(cue: AudioCue): number {
    void this.tick; // reactive dependency
    return this.engine.getFadeProgress(cue.id);
  }

  /** Live loudness of a playing audio cue (0..1), for reactive glow. */
  level(cue: AudioCue): number {
    void this.tick; // reactive dependency
    // Perceptual-ish boost so typical music produces a lively glow.
    return Math.min(1, this.engine.getLevel(cue.id) * 2.8);
  }

  private ensureRaf(): void {
    if (this.rafId) return;
    const loop = () => {
      this.tick += 1;
      this.rafId = this.engine.activeCount() > 0 ? requestAnimationFrame(loop) : 0;
    };
    this.rafId = requestAnimationFrame(loop);
  }

  // ---- Grid editing ------------------------------------------------------

  /** Create a cue of the given type at a cell. Returns its id so the caller can
   *  open its properties. */
  addNewCue(type: CueType, row: number, col: number): string | null {
    const tab = this.activeTab;
    if (!tab || this.cueAt(tab, row, col)) return null;
    const cue: Cue =
      type === 'audio'
        ? defaultAudioCue(row, col)
        : type === 'proxy'
          ? defaultProxyCue(row, col)
          : type === 'timer'
            ? defaultTimerCue(row, col)
            : type === 'global'
              ? defaultGlobalCue(row, col)
              : defaultHttpCue(row, col);
    tab.cues.push(cue);
    this.markDirty();
    return cue.id;
  }

  /**
   * Import dropped OS audio files: copy each into the folder and add an audio
   * cue, starting at (row, col) and filling empty cells from there.
   */
  async importAudioFiles(files: File[], row: number, col: number): Promise<void> {
    const tab = this.activeTab;
    if (!tab || files.length === 0) return;
    const cells = this.emptyCellsFrom(tab, row, col, files.length);
    const taken = new Set(
      this.folder.audioFiles.filter((f) => !f.includes('/')).map((f) => f.toLowerCase()),
    );
    try {
      for (let i = 0; i < files.length && i < cells.length; i++) {
        const name = await writeMediaFile(this.folder.dir, files[i], taken);
        const cue = defaultAudioCue(cells[i].row, cells[i].col);
        cue.file = name;
        cue.name = name.replace(/\.[^.]+$/, '');
        tab.cues.push(cue);
        // The folder listing must know the file before resolveAudioPath runs.
        this.folder.audioFiles = [...this.folder.audioFiles, name].sort((a, b) => a.localeCompare(b));
        await this.reloadCueAudio(cue);
      }
      this.markDirty();
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  /** Empty grid cells starting at (row, col), wrapping through the grid. */
  private emptyCellsFrom(tab: Tab, row: number, col: number, count: number): { row: number; col: number }[] {
    const { rows, cols } = this.project.grid;
    const total = rows * cols;
    const start = row * cols + col;
    const out: { row: number; col: number }[] = [];
    for (let k = 0; k < total && out.length < count; k++) {
      const i = (start + k) % total;
      const r = Math.floor(i / cols);
      const c = i % cols;
      if (!this.cueAt(tab, r, c)) out.push({ row: r, col: c });
    }
    return out;
  }

  removeCue(id: string): void {
    for (const tab of this.project.tabs) {
      const idx = tab.cues.findIndex((c) => c.id === id);
      if (idx >= 0) {
        tab.cues.splice(idx, 1);
        // Let go of the cue's buffer; it's freed unless another cue shares it.
        this.engine.unload(id);
        delete this.audioStatus[id];
        break;
      }
    }
    this.markDirty();
  }

  /** Move a cue to a cell in the same tab; swap if the target is occupied. */
  moveCue(id: string, row: number, col: number): void {
    const tab = this.activeTab;
    if (!tab) return;
    const cue = tab.cues.find((c) => c.id === id);
    if (!cue) return;
    const occupant = tab.cues.find((c) => c.row === row && c.col === col && c.id !== id);
    if (occupant) {
      occupant.row = cue.row;
      occupant.col = cue.col;
    }
    cue.row = row;
    cue.col = col;
    this.markDirty();
  }

  /** Copy a cue into an empty cell in the same tab. */
  copyCue(id: string, row: number, col: number): void {
    const tab = this.activeTab;
    if (!tab) return;
    if (this.cueAt(tab, row, col)) return; // don't overwrite
    const src = tab.cues.find((c) => c.id === id);
    if (!src) return;
    const clone: Cue = { ...structuredClone($state.snapshot(src)), id: makeId('cue'), row, col };
    tab.cues.push(clone);
    if (clone.type === 'audio') void this.reloadCueAudio(clone);
    this.markDirty();
  }

  setGrid(rows: number, cols: number): void {
    this.project.grid = {
      rows: Math.max(1, Math.floor(rows)),
      cols: Math.max(1, Math.floor(cols)),
    };
    this.markDirty();
  }

  // ---- Cue tabs ----------------------------------------------------------

  addTab(): void {
    const tab: Tab = { id: makeId('tab'), name: `Tab ${this.project.tabs.length + 1}`, cues: [] };
    this.project.tabs.push(tab);
    this.activeTabId = tab.id;
    this.markDirty();
  }

  removeTab(id: string): void {
    if (this.project.tabs.length <= 1) return;
    const idx = this.project.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    for (const cue of this.project.tabs[idx].cues) {
      this.engine.unload(cue.id);
      delete this.audioStatus[cue.id];
    }
    this.project.tabs.splice(idx, 1);
    if (this.activeTabId === id) {
      this.activeTabId = this.project.tabs[Math.max(0, idx - 1)].id;
    }
    this.markDirty();
  }

  renameTab(id: string, name: string): void {
    const tab = this.project.tabs.find((t) => t.id === id);
    if (tab) {
      tab.name = name;
      this.markDirty();
    }
  }
}
