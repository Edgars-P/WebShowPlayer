// Central app state (Svelte 5 runes) plus the cue-action dispatcher and trigger
// engine. Holds the reactive Project and delegates audio to AudioEngine.

import { AudioEngine } from '../audio/AudioEngine';
import {
  DEFAULT_CUE_FILE,
  listAudioFiles,
  listCueFiles,
  loadAudioBytes,
  pickProjectFolder,
  readCueFile,
  writeCueFile,
  writeMediaFile,
} from '../fs/projectFs';
import {
  defaultAudioCue,
  defaultHttpCue,
  defaultProject,
  defaultProxyCue,
  defaultTimerCue,
  makeId,
  type AudioCue,
  type Cue,
  type CueRef,
  type CueType,
  type PlaybackState,
  type Project,
  type Tab,
  type TimerAction,
  type TimerCue,
  type Trigger,
  type TriggerAction,
} from '../types';
import { TimerWindow, type TimerView } from '../timer/timer';

export type AppStatus = 'empty' | 'loading' | 'choosing' | 'ready' | 'error';

export interface HttpFlash {
  state: 'firing' | 'ok' | 'error';
  at: number;
}

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export class AppState {
  status = $state<AppStatus>('empty');
  errorMessage = $state('');
  loadProgress = $state({ done: 0, total: 0 });

  project = $state<Project | null>(null);
  audioFiles = $state<string[]>([]);
  /** Cue files found in the folder root (for the chooser). */
  cueFiles = $state<string[]>([]);
  /** Name of the currently loaded cue file (null for a new unsaved one). */
  currentFileName = $state<string | null>(null);
  /** File name that Save writes to. */
  saveName = $state(DEFAULT_CUE_FILE);
  activeTabId = $state('');
  /** Cue currently shown in the properties modal (null = closed). */
  propertiesCueId = $state<string | null>(null);
  /** Open right-click context menu (null = none). */
  contextMenu = $state<ContextMenuState | null>(null);
  dirty = $state(false);

  /** Playback state per audio cue id. */
  playStates = $state<Record<string, PlaybackState>>({});
  /** Transient HTTP fire feedback per cue id. */
  httpFlashes = $state<Record<string, HttpFlash>>({});
  /** Bumped by rAF while audio is playing so progress readouts stay live. */
  tick = $state(0);

  /** The single global countdown timer slot. */
  timer = $state<TimerView>({ duration: 0, remaining: 0, running: false, finished: false });

  private engine = new AudioEngine();
  private dir: FileSystemDirectoryHandle | null = null;
  private rafId = 0;

  private timerEndsAt = 0;
  private timerInterval = 0;
  private timerWindow = new TimerWindow();
  /** Id of the timer cue that last set the running countdown, so its onStop
   *  triggers can fire when the timer runs out naturally. */
  private timerCueId: string | null = null;

  // Trigger re-entrancy guard.
  private firing = new Set<string>();
  private propagating = 0;

  constructor() {
    this.engine.onStateChange = (id, state) => {
      this.playStates[id] = state;
      if (state !== 'idle') this.ensureRaf();
    };
    this.engine.onCueEvent = (id, event) => {
      this.propagate(() => this.fireTriggers(id, event));
    };
  }

  // ---- Derived accessors -------------------------------------------------

  get activeTab(): Tab | null {
    if (!this.project) return null;
    return this.project.tabs.find((t) => t.id === this.activeTabId) ?? this.project.tabs[0] ?? null;
  }

  get propertiesCue(): Cue | null {
    if (!this.project || this.propertiesCueId == null) return null;
    for (const tab of this.project.tabs) {
      const found = tab.cues.find((c) => c.id === this.propertiesCueId);
      if (found) return found;
    }
    return null;
  }

  cueAt(tab: Tab, row: number, col: number): Cue | undefined {
    return tab.cues.find((c) => c.row === row && c.col === col);
  }

  // ---- Properties modal & context menu -----------------------------------

  openProperties(id: string): void {
    this.propertiesCueId = id;
  }

  closeProperties(): void {
    this.propertiesCueId = null;
  }

  openMenu(x: number, y: number, items: MenuItem[]): void {
    this.contextMenu = { x, y, items };
  }

  closeMenu(): void {
    this.contextMenu = null;
  }

  // ---- Loading / saving --------------------------------------------------

  /** Pick a folder and open its cue file, or show a chooser if there are several. */
  async openFolder(): Promise<void> {
    try {
      this.status = 'loading';
      this.errorMessage = '';
      const opened = await pickProjectFolder();
      this.dir = opened.dir;
      this.cueFiles = opened.cueFiles;
      this.audioFiles = opened.audioFiles;
      if (opened.cueFiles.length === 0) {
        this.loadProjectData(defaultProject(), DEFAULT_CUE_FILE);
        this.status = 'ready';
      } else if (opened.cueFiles.length === 1) {
        await this.openCueFile(opened.cueFiles[0]);
      } else {
        this.status = 'choosing';
      }
    } catch (err) {
      this.status = this.project ? 'ready' : 'error';
      this.errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  /** Load one of the folder's cue files (used from the chooser). */
  async openCueFile(name: string): Promise<void> {
    if (!this.dir) return;
    try {
      this.status = 'loading';
      this.errorMessage = '';
      const { project, saveName } = await readCueFile(this.dir, name);
      this.loadProjectData(project, saveName, name);
      await this.decodeAll();
      this.status = 'ready';
    } catch (err) {
      this.status = 'error';
      this.errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  /** Start a fresh, empty cue file in the current folder. */
  newCueFile(): void {
    this.loadProjectData(defaultProject(), this.uniqueName(DEFAULT_CUE_FILE));
    this.dirty = true;
    this.status = 'ready';
  }

  /** Re-open the cue-file chooser for the current folder. */
  showChooser(): void {
    if (this.cueFiles.length > 0) this.status = 'choosing';
  }

  private loadProjectData(project: Project, saveName: string, sourceName: string | null = null): void {
    this.engine.clear();
    this.project = project;
    this.saveName = saveName;
    this.currentFileName = sourceName;
    this.activeTabId = project.tabs[0]?.id ?? '';
    this.propertiesCueId = null;
    this.contextMenu = null;
    this.dirty = false;
    this.playStates = {};
    this.engine.setMasterVolume(project.masterVolume);
  }

  /** Best-effort resolve a cue's file to an existing path (exact, else basename). */
  private resolveAudioPath(file: string): string | null {
    if (!file) return null;
    if (this.audioFiles.includes(file)) return file;
    const base = file.split('/').pop();
    return this.audioFiles.find((f) => f.split('/').pop() === base) ?? null;
  }

  private async decodeAll(): Promise<void> {
    if (!this.project || !this.dir) return;
    const audioCues: AudioCue[] = [];
    for (const tab of this.project.tabs) {
      for (const cue of tab.cues) {
        if (cue.type === 'audio' && cue.file) audioCues.push(cue);
      }
    }
    this.loadProgress = { done: 0, total: audioCues.length };
    for (const cue of audioCues) {
      const resolved = this.resolveAudioPath(cue.file);
      if (resolved) {
        // Point the cue at the actual file found in the folder tree.
        if (resolved !== cue.file) cue.file = resolved;
        try {
          await this.engine.decode(cue.id, resolved, await loadAudioBytes(this.dir, resolved));
        } catch (err) {
          console.warn(`Failed to load "${resolved}":`, err);
        }
      }
      this.loadProgress = { done: this.loadProgress.done + 1, total: audioCues.length };
    }
  }

  /** Decode a single cue's file (after adding/changing it). The engine measures
   * the file's loudness-normalization gain the first time it sees the path. */
  async reloadCueAudio(cue: AudioCue): Promise<void> {
    if (!this.dir || !cue.file) return;
    const resolved = this.resolveAudioPath(cue.file) ?? cue.file;
    // Point the cue at the real path so its gain key matches the decoded file.
    if (resolved !== cue.file) cue.file = resolved;
    try {
      await this.engine.decode(cue.id, resolved, await loadAudioBytes(this.dir, resolved));
    } catch (err) {
      console.warn(`Failed to load "${resolved}":`, err);
    }
  }

  async refreshAudioFiles(): Promise<void> {
    if (!this.dir) return;
    this.audioFiles = await listAudioFiles(this.dir);
  }

  private uniqueName(name: string): string {
    if (!this.cueFiles.includes(name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot >= 0 ? name.slice(0, dot) : name;
    const ext = dot >= 0 ? name.slice(dot) : '';
    let i = 2;
    while (this.cueFiles.includes(`${stem}-${i}${ext}`)) i++;
    return `${stem}-${i}${ext}`;
  }

  async save(): Promise<void> {
    if (!this.dir || !this.project) return;
    try {
      await writeCueFile(this.dir, this.saveName, this.project);
      this.currentFileName = this.saveName;
      if (!this.cueFiles.includes(this.saveName)) {
        this.cueFiles = await listCueFiles(this.dir);
      }
      this.dirty = false;
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  markDirty(): void {
    this.dirty = true;
  }

  hasBuffer(id: string): boolean {
    return this.engine.hasBuffer(id);
  }

  // ---- Cue resolution ----------------------------------------------------

  resolveRef(ref: CueRef): Cue | null {
    return this.findCue(ref.cueId);
  }

  /** Which tab currently holds this cue. */
  tabOf(cue: Cue): Tab | null {
    if (!this.project) return null;
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
  display(cue: Cue): { name: string; color: string; state: PlaybackState; missing: boolean } {
    if (cue.type === 'proxy') {
      const src = this.resolveProxy(cue);
      if (!src || src.type === 'proxy') {
        return { name: 'proxy?', color: '#555', state: 'idle', missing: true };
      }
      const inner = this.display(src);
      return { ...inner, missing: false };
    }
    if (cue.type === 'http' || cue.type === 'timer') {
      return { name: cue.name, color: cue.color, state: 'idle', missing: false };
    }
    return {
      name: cue.name,
      color: cue.color,
      state: this.playStates[cue.id] ?? 'idle',
      missing: !this.engine.hasBuffer(cue.id),
    };
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
        this.timerCueId = cue.id;
        this.setTimer(cue.duration);
        break;
      case 'pause':
        this.pauseTimer();
        break;
      case 'resume':
        this.resumeTimer();
        break;
      case 'clear':
        this.clearTimer();
        break;
    }
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

  private findCue(id: string): Cue | null {
    if (!this.project) return null;
    for (const tab of this.project.tabs) {
      const found = tab.cues.find((c) => c.id === id);
      if (found) return found;
    }
    return null;
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
    if (!this.project) return;
    this.project.masterVolume = v;
    this.engine.setMasterVolume(v);
    this.markDirty();
  }

  // ---- Global timer ------------------------------------------------------

  setTimer(seconds: number): void {
    const dur = Math.max(0, seconds);
    if (dur <= 0) {
      this.clearTimer();
      return;
    }
    this.timer.duration = dur;
    this.timer.remaining = dur;
    this.timer.finished = false;
    this.timer.running = true;
    this.timerEndsAt = Date.now() + dur * 1000;
    this.timer.endsAt = this.timerEndsAt;
    this.startTimerInterval();
    this.renderTimer();
  }

  pauseTimer(): void {
    if (!this.timer.running) return;
    this.timer.remaining = Math.max(0, (this.timerEndsAt - Date.now()) / 1000);
    this.timer.running = false;
    this.timer.endsAt = null;
    this.stopTimerInterval();
    this.renderTimer();
  }

  resumeTimer(): void {
    if (this.timer.running || this.timer.finished || this.timer.remaining <= 0) return;
    this.timer.running = true;
    this.timerEndsAt = Date.now() + this.timer.remaining * 1000;
    this.timer.endsAt = this.timerEndsAt;
    this.startTimerInterval();
    this.renderTimer();
  }

  clearTimer(): void {
    this.timer.duration = 0;
    this.timer.remaining = 0;
    this.timer.running = false;
    this.timer.finished = false;
    this.timer.endsAt = null;
    this.timerCueId = null;
    this.stopTimerInterval();
    this.renderTimer();
  }

  openTimerWindow(): void {
    if (!this.timerWindow.open()) {
      this.errorMessage = 'Timer pop-out was blocked. Allow popups for this site and try again.';
      return;
    }
    this.renderTimer();
  }

  private timerTick(): void {
    const rem = Math.max(0, (this.timerEndsAt - Date.now()) / 1000);
    this.timer.remaining = rem;
    if (rem <= 0) {
      this.timer.running = false;
      this.timer.finished = true;
      this.timer.endsAt = null;
      this.stopTimerInterval();
      const cueId = this.timerCueId;
      this.timerCueId = null;
      if (cueId) this.propagate(() => this.fireTriggers(cueId, 'onStop'));
    }
    this.renderTimer();
  }

  private startTimerInterval(): void {
    this.stopTimerInterval();
    this.timerInterval = window.setInterval(() => this.timerTick(), 200);
  }

  private stopTimerInterval(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = 0;
    }
  }

  private renderTimer(): void {
    this.timerWindow.render($state.snapshot(this.timer));
  }

  // ---- Progress readouts (reactive via `tick`) ---------------------------

  progress(cue: AudioCue): number {
    void this.tick; // reactive dependency
    const dur = this.engine.getDuration(cue);
    if (dur <= 0) return 0;
    return Math.min(1, (this.engine.getPosition(cue) - cue.startTime) / dur);
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

  /** Create a cue of the given type at a cell and open its properties. */
  addNewCue(type: CueType, row: number, col: number): void {
    const tab = this.activeTab;
    if (!tab || this.cueAt(tab, row, col)) return;
    const cue: Cue =
      type === 'audio'
        ? defaultAudioCue(row, col)
        : type === 'proxy'
          ? defaultProxyCue(row, col)
          : type === 'timer'
            ? defaultTimerCue(row, col)
            : defaultHttpCue(row, col);
    tab.cues.push(cue);
    this.markDirty();
    this.openProperties(cue.id);
  }

  /**
   * Import dropped OS audio files: copy each into the folder and add an audio
   * cue, starting at (row, col) and filling empty cells from there.
   */
  async importAudioFiles(files: File[], row: number, col: number): Promise<void> {
    const tab = this.activeTab;
    if (!this.dir || !this.project || !tab || files.length === 0) return;
    const cells = this.emptyCellsFrom(tab, row, col, files.length);
    const taken = new Set(
      this.audioFiles.filter((f) => !f.includes('/')).map((f) => f.toLowerCase()),
    );
    try {
      for (let i = 0; i < files.length && i < cells.length; i++) {
        const name = await writeMediaFile(this.dir, files[i], taken);
        const cue = defaultAudioCue(cells[i].row, cells[i].col);
        cue.file = name;
        cue.name = name.replace(/\.[^.]+$/, '');
        tab.cues.push(cue);
        await this.reloadCueAudio(cue);
      }
      await this.refreshAudioFiles();
      this.markDirty();
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  /** Empty grid cells starting at (row, col), wrapping through the grid. */
  private emptyCellsFrom(tab: Tab, row: number, col: number, count: number): { row: number; col: number }[] {
    const { rows, cols } = this.project!.grid;
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
    for (const tab of this.project?.tabs ?? []) {
      const idx = tab.cues.findIndex((c) => c.id === id);
      if (idx >= 0) {
        tab.cues.splice(idx, 1);
        break;
      }
    }
    if (this.propertiesCueId === id) this.propertiesCueId = null;
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
    if (!this.project) return;
    this.project.grid = {
      rows: Math.max(1, Math.floor(rows)),
      cols: Math.max(1, Math.floor(cols)),
    };
    this.markDirty();
  }

  // ---- Tabs --------------------------------------------------------------

  addTab(): void {
    if (!this.project) return;
    const tab: Tab = { id: makeId('tab'), name: `Tab ${this.project.tabs.length + 1}`, cues: [] };
    this.project.tabs.push(tab);
    this.activeTabId = tab.id;
    this.markDirty();
  }

  removeTab(id: string): void {
    if (!this.project || this.project.tabs.length <= 1) return;
    const idx = this.project.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.project.tabs.splice(idx, 1);
    if (this.activeTabId === id) {
      this.activeTabId = this.project.tabs[Math.max(0, idx - 1)].id;
    }
    this.markDirty();
  }

  renameTab(id: string, name: string): void {
    const tab = this.project?.tabs.find((t) => t.id === id);
    if (tab) {
      tab.name = name;
      this.markDirty();
    }
  }
}

export const app = new AppState();
