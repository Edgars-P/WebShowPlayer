// Central app state (Svelte 5 runes). Owns the list of open documents (one per
// cue file), the folders they came from, and the genuinely global bits: the
// countdown timer, the video slot, the projector screen they share, the context
// menu, and the properties modal.
//
// Most members here just forward to the active document, so components can keep
// saying `app.project` / `app.markDirty()` without knowing that several
// documents may be open at once.

import { audioCache } from '../audio/sharedAudio';
import {
  cueFileNameError,
  DEFAULT_CUE_FILE,
  normalizeCueFileName,
  pickProjectFolder,
  readCueFile,
} from '../fs/projectFs';
import { defaultProject, type Cue, type Tab, type TriggerAction } from '../types';
import { EMPTY_TIMER, remainingFraction, type TimerView } from '../timer/timer';
import { EMPTY_VIDEO, IDLE_STATUS, ScreenWindow, type VideoStatus, type VideoView } from '../screen/screen';
import { Doc, type CueDisplay, type TriggerHint, type ScreenHost, type VideoRequest } from './doc.svelte';
import { Folder } from './folder.svelte';

export type AppStatus = 'empty' | 'loading' | 'choosing' | 'ready' | 'error';
export type { CueDisplay, HttpFlash } from './doc.svelte';

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

export class AppState implements ScreenHost {
  status = $state<AppStatus>('empty');
  errorMessage = $state('');
  /** Progress of a folder-level open, before a document exists to own it. */
  loadProgress = $state({ done: 0, total: 0 });

  /** Open documents, in tab order. */
  docs = $state<Doc[]>([]);
  activeDocId = $state('');
  /** Folder whose cue files the chooser is currently offering. */
  chooserFolder = $state<Folder | null>(null);

  /** Cue currently shown in the properties modal (null = closed). */
  propertiesCueId = $state<string | null>(null);
  /** Open right-click context menu (null = none). */
  contextMenu = $state<ContextMenuState | null>(null);

  /** Tile the pointer is over, driving the trigger-chain preview. */
  hoveredCueId = $state<string | null>(null);
  /** Whether a pick-up modifier (Shift, Alt or Ctrl) is held, for the cursor. */
  dragModifier = $state(false);

  /**
   * Cues the hovered tile's triggers would act on right now, and with what
   * action. Derived once here rather than per tile, so hovering is one pass
   * over the hovered cue's triggers instead of one per cue in the grid.
   */
  previewTargets = $derived(
    this.activeDoc?.previewTargets(this.hoveredCueId) ?? new Map<string, TriggerHint[]>(),
  );

  /** The single global countdown timer slot, shared by all documents. */
  timer = $state<TimerView>({ ...EMPTY_TIMER });
  /** The timer cue currently holding the countdown, so its tile can show it. */
  timerCueId = $state<string | null>(null);
  /** The single global video slot, shared by all documents. */
  video = $state<VideoView>({ ...EMPTY_VIDEO });
  /**
   * What the clip on the screen is actually doing, reported back by the screen
   * page each frame. The slot above is intent; this is the observation, and
   * it's what the launchpad tile paints from.
   */
  videoStatus = $state<VideoStatus>({ ...IDLE_STATUS });
  /** The video cue currently holding the slot, so its tile can show it. */
  videoCueId = $state<string | null>(null);
  /**
   * Whether a screen page is attached. Video cues need somewhere to put a
   * picture, so without one they don't run at all — and their tiles say so.
   */
  screenLive = $state(false);
  /** Bumped whenever decoded-audio residency changes, so readouts can react. */
  memoryVersion = $state(0);

  private folders: Folder[] = [];
  private timerEndsAt = 0;
  private timerInterval = 0;
  private screenWindow = new ScreenWindow({
    videoEnded: (generation) => this.videoEnded(generation),
    videoProgress: (generation, status) => this.videoProgress(generation, status),
    screenClosing: () => this.screenClosing(),
    livenessChanged: (live) => {
      this.screenLive = live;
      // A screen that goes away takes its picture with it; one that arrives
      // needs catching up on whatever the slots already hold.
      if (live) this.renderScreen();
    },
  });
  /** What to run when the countdown reaches zero on its own — set by whichever
   *  document's timer cue last started it. */
  private onTimerFinished: (() => void) | null = null;
  /** What to run when the clip plays out — set by whichever document's video
   *  cue last filled the slot. */
  private onVideoEnded: (() => void) | null = null;

  // ---- Documents ---------------------------------------------------------

  get activeDoc(): Doc | null {
    return this.docs.find((d) => d.id === this.activeDocId) ?? this.docs[0] ?? null;
  }

  /** Surface a document-level failure in the app-wide error bar. */
  reportError(message: string): void {
    this.errorMessage = message;
  }

  /** Every open document — used by global cues scoped to 'all'. */
  eachDocument(fn: (doc: Doc) => void): void {
    // Snapshot: a handler could in principle open or close a document.
    for (const doc of [...this.docs]) fn(doc);
  }

  /**
   * Stop every audio cue in every open document — the toolbar's panic buttons.
   * `fade` false cuts instantly; true lets each cue use its own fade-out time.
   * Always reaches across documents: if you're hitting this, you want silence,
   * not silence in the tab you happen to be looking at.
   */
  stopAllAudio(fade: boolean): void {
    this.eachDocument((doc) => doc.applyToAllAudio('stop', fade));
  }

  /** Whether anything is currently making sound, in any document. */
  get anyPlaying(): boolean {
    return this.docs.some((d) => d.isPlaying);
  }

  selectDoc(id: string): void {
    if (this.docs.some((d) => d.id === id)) {
      this.activeDocId = id;
      this.propertiesCueId = null;
      this.contextMenu = null;
    }
  }

  /** Close a document, releasing its audio. Returns false if the user cancelled. */
  closeDoc(id: string): boolean {
    const idx = this.docs.findIndex((d) => d.id === id);
    if (idx < 0) return true;
    const doc = this.docs[idx];
    if (doc.dirty && !confirm(`"${doc.title}" has unsaved changes. Close it anyway?`)) {
      return false;
    }
    doc.close();
    this.docs.splice(idx, 1);
    this.memoryVersion++;
    if (this.activeDocId === doc.id) {
      this.activeDocId = this.docs[Math.max(0, idx - 1)]?.id ?? '';
      this.propertiesCueId = null;
    }
    if (this.docs.length === 0) this.status = 'empty';
    return true;
  }

  /** Total decoded audio held across every open document. */
  get audioMemory(): { files: number; bytes: number } {
    void this.memoryVersion; // reactive dependency
    return audioCache.stats();
  }

  // ---- Loading -----------------------------------------------------------

  /** Reuse the Folder for a directory we already have open, if any. */
  private async findFolder(dir: FileSystemDirectoryHandle): Promise<Folder | null> {
    for (const folder of this.folders) {
      if (await folder.dir.isSameEntry(dir)) return folder;
    }
    return null;
  }

  /** Pick a folder and open its cue file, or show a chooser if there are several. */
  async openFolder(): Promise<void> {
    try {
      this.status = 'loading';
      this.errorMessage = '';
      const opened = await pickProjectFolder();
      let folder = await this.findFolder(opened.dir);
      if (folder) {
        folder.cueFiles = opened.cueFiles;
        folder.audioFiles = opened.audioFiles;
        folder.videoFiles = opened.videoFiles;
      } else {
        folder = new Folder(opened.dir, opened.cueFiles, opened.audioFiles, opened.videoFiles);
        this.folders.push(folder);
      }

      if (opened.cueFiles.length === 0) {
        // Nothing to open, so we're creating — which means naming it, same as
        // the explicit "New cue file" action.
        this.status = this.docs.length > 0 ? 'ready' : 'empty';
        this.promptNewCueFile(folder);
      } else if (opened.cueFiles.length === 1) {
        await this.openCueFile(opened.cueFiles[0], folder);
      } else {
        this.chooserFolder = folder;
        this.status = 'choosing';
      }
    } catch (err) {
      this.status = this.docs.length > 0 ? 'ready' : 'error';
      this.errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  /** Open one of a folder's cue files as a new document tab. */
  async openCueFile(name: string, folder = this.chooserFolder ?? this.activeDoc?.folder): Promise<void> {
    if (!folder) return;
    // Already open? Just switch to it rather than decoding a second copy.
    const existing = this.docs.find((d) => d.folder === folder && d.currentFileName === name);
    if (existing) {
      this.selectDoc(existing.id);
      this.chooserFolder = null;
      this.status = 'ready';
      return;
    }
    try {
      this.status = 'loading';
      this.errorMessage = '';
      const { project, saveName } = await readCueFile(folder.dir, name);
      const doc = new Doc(folder, project, saveName, this, name);
      this.addDoc(doc);
      this.chooserFolder = null;
      this.status = 'ready';
      await doc.decodeAll();
      this.memoryVersion++;
    } catch (err) {
      this.status = this.docs.length > 0 ? 'ready' : 'error';
      this.errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  // ---- Creating a cue file ----------------------------------------------

  /** Folder the new-file dialog is creating into (null = dialog closed). */
  newFileFolder = $state<Folder | null>(null);
  /** Name being typed in the new-file dialog. */
  newFileName = $state('');

  /** Open the "new cue file" dialog, pre-filled with an unused default name. */
  promptNewCueFile(folder = this.chooserFolder ?? this.activeDoc?.folder ?? null): void {
    if (!folder) return;
    this.newFileFolder = folder;
    this.newFileName = this.uniqueName(folder, DEFAULT_CUE_FILE);
  }

  /** Why the typed name is unusable, or null if it's fine. */
  get newFileError(): string | null {
    return cueFileNameError(this.newFileName);
  }

  /**
   * Non-blocking warning about the typed name: it already exists on disk, or a
   * document is already open on it. Saving will overwrite either way — that's
   * allowed, it just shouldn't be a surprise.
   */
  get newFileWarning(): string | null {
    const folder = this.newFileFolder;
    if (!folder || this.newFileError) return null;
    const name = normalizeCueFileName(this.newFileName);
    if (this.docs.some((d) => d.folder === folder && d.saveName === name)) {
      return `“${name}” is already open in another tab. Saving both will overwrite one with the other.`;
    }
    if (folder.cueFiles.includes(name)) {
      return `“${name}” already exists in this folder. Saving will overwrite it.`;
    }
    return null;
  }

  /** Create the document the dialog describes. No-op if the name is invalid. */
  createCueFile(): void {
    const folder = this.newFileFolder;
    if (!folder || this.newFileError) return;
    const doc = new Doc(folder, defaultProject(), normalizeCueFileName(this.newFileName), this);
    doc.dirty = true; // nothing on disk yet — Save is the thing that creates it
    this.addDoc(doc);
    this.newFileFolder = null;
    this.chooserFolder = null;
    this.status = 'ready';
  }

  cancelNewCueFile(): void {
    this.newFileFolder = null;
    // Opening a folder with no cue files goes straight to this dialog, so
    // backing out of it with nothing open means there's nothing to show.
    if (this.docs.length === 0) this.status = 'empty';
    else if (this.status !== 'choosing') this.status = 'ready';
  }

  /** Re-open the cue-file chooser for the active document's folder. It doubles
   *  as the "create one instead" entry point, so an empty folder still opens it. */
  showChooser(): void {
    const folder = this.activeDoc?.folder;
    if (folder) {
      this.chooserFolder = folder;
      this.status = 'choosing';
    }
  }

  /** Dismiss the chooser without opening anything (only if something's open). */
  cancelChooser(): void {
    if (this.docs.length === 0) return;
    this.chooserFolder = null;
    this.status = 'ready';
  }

  private addDoc(doc: Doc): void {
    this.docs.push(doc);
    this.activeDocId = doc.id;
    this.propertiesCueId = null;
  }

  private uniqueName(folder: Folder, name: string): string {
    const taken = folder.cueFiles;
    if (!taken.includes(name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot >= 0 ? name.slice(0, dot) : name;
    const ext = dot >= 0 ? name.slice(dot) : '';
    let i = 2;
    while (taken.includes(`${stem}-${i}${ext}`)) i++;
    return `${stem}-${i}${ext}`;
  }

  // ---- Properties modal & context menu -----------------------------------

  get propertiesCue(): Cue | null {
    if (this.propertiesCueId == null) return null;
    return this.activeDoc?.findCue(this.propertiesCueId) ?? null;
  }

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

  // ---- Active-document forwarding ----------------------------------------

  get project() {
    return this.activeDoc?.project ?? null;
  }
  get activeTab(): Tab | null {
    return this.activeDoc?.activeTab ?? null;
  }
  get activeTabId(): string {
    return this.activeDoc?.activeTabId ?? '';
  }
  set activeTabId(id: string) {
    if (this.activeDoc) this.activeDoc.activeTabId = id;
  }
  get dirty(): boolean {
    return this.activeDoc?.dirty ?? false;
  }
  /** Whether any open document has unsaved changes (for the unload warning). */
  get anyDirty(): boolean {
    return this.docs.some((d) => d.dirty);
  }
  get saveName(): string {
    return this.activeDoc?.saveName ?? '';
  }
  get cueFiles(): string[] {
    return this.chooserFolder?.cueFiles ?? this.activeDoc?.folder.cueFiles ?? [];
  }
  get audioFiles(): string[] {
    return this.activeDoc?.folder.audioFiles ?? [];
  }
  get videoFiles(): string[] {
    return this.activeDoc?.folder.videoFiles ?? [];
  }
  /** Decode progress of the active document, falling back to the folder-level one. */
  get progressView(): { done: number; total: number } {
    const doc = this.activeDoc;
    return doc && doc.loading ? doc.loadProgress : this.loadProgress;
  }

  markDirty(): void {
    this.activeDoc?.markDirty();
  }
  save(): Promise<void> {
    return this.activeDoc?.save() ?? Promise.resolve();
  }
  cueAt(tab: Tab, row: number, col: number) {
    return this.activeDoc?.cueAt(tab, row, col);
  }
  display(cue: Cue): CueDisplay {
    return (
      this.activeDoc?.display(cue) ??
      { name: '', color: '#555', state: 'idle', missing: true, pending: false }
    );
  }
  activate(cue: Cue): void {
    this.activeDoc?.activate(cue);
  }
  progress(cue: Parameters<Doc['progress']>[0]): number {
    return this.activeDoc?.progress(cue) ?? 0;
  }
  level(cue: Parameters<Doc['level']>[0]): number {
    return this.activeDoc?.level(cue) ?? 0;
  }
  fadeProgress(cue: Parameters<Doc['fadeProgress']>[0]): number {
    return this.activeDoc?.fadeProgress(cue) ?? 1;
  }
  fadeSeconds(cue: Parameters<Doc['fadeSeconds']>[0]): number {
    return this.activeDoc?.fadeSeconds(cue) ?? 0;
  }
  remaining(cue: Parameters<Doc['remaining']>[0]): number {
    return this.activeDoc?.remaining(cue) ?? 0;
  }
  duration(cue: Parameters<Doc['duration']>[0]): number {
    return this.activeDoc?.duration(cue) ?? 0;
  }
  seekTo(cue: Parameters<Doc['seekTo']>[0], fraction: number): void {
    this.activeDoc?.seekTo(cue, fraction);
  }
  resolveRef(ref: Parameters<Doc['resolveRef']>[0]) {
    return this.activeDoc?.resolveRef(ref) ?? null;
  }
  resolveProxy(cue: Cue) {
    return this.activeDoc?.resolveProxy(cue) ?? null;
  }
  tabOf(cue: Cue) {
    return this.activeDoc?.tabOf(cue) ?? null;
  }
  hasBuffer(id: string): boolean {
    return this.activeDoc?.hasBuffer(id) ?? false;
  }
  async reloadCueAudio(cue: Parameters<Doc['reloadCueAudio']>[0]): Promise<void> {
    await this.activeDoc?.reloadCueAudio(cue);
    this.memoryVersion++;
  }
  setGrid(rows: number, cols: number): void {
    this.activeDoc?.setGrid(rows, cols);
  }
  setMasterVolume(v: number): void {
    this.activeDoc?.setMasterVolume(v);
  }
  get httpFlashes() {
    return this.activeDoc?.httpFlashes ?? {};
  }

  /** Create a cue and open its properties. */
  addNewCue(type: Parameters<Doc['addNewCue']>[0], row: number, col: number): void {
    const id = this.activeDoc?.addNewCue(type, row, col);
    if (id) this.openProperties(id);
  }
  removeCue(id: string): void {
    this.activeDoc?.removeCue(id);
    if (this.propertiesCueId === id) this.propertiesCueId = null;
    this.memoryVersion++;
  }
  moveCue(id: string, row: number, col: number): void {
    this.activeDoc?.moveCue(id, row, col);
  }
  copyCue(id: string, row: number, col: number): void {
    this.activeDoc?.copyCue(id, row, col);
  }
  async importAudioFiles(files: File[], row: number, col: number): Promise<void> {
    await this.activeDoc?.importAudioFiles(files, row, col);
    this.memoryVersion++;
  }
  addTab(): void {
    this.activeDoc?.addTab();
  }
  removeTab(id: string): void {
    this.activeDoc?.removeTab(id);
    this.memoryVersion++;
  }
  renameTab(id: string, name: string): void {
    this.activeDoc?.renameTab(id, name);
  }
  moveTab(id: string, toIndex: number): void {
    this.activeDoc?.moveTab(id, toIndex);
  }
  /** Move a cue to another tab; reports when the target tab has no room. */
  moveCueToTab(cueId: string, tabId: string): void {
    const moved = this.activeDoc?.moveCueToTab(cueId, tabId) ?? false;
    if (!moved) {
      this.errorMessage = 'That tab has no empty cell for the cue.';
      return;
    }
    if (this.propertiesCueId === cueId) this.propertiesCueId = null;
  }

  // ---- Global timer ------------------------------------------------------

  /**
   * Hand the countdown to a cue: its chain runs when the clock reaches zero,
   * and its tile is the one that lights while it runs. One holder at a time,
   * like the video slot — a second `set` cue takes the timer over rather than
   * sharing it, so exactly one tile ever shows the countdown.
   */
  claimTimer(cueId: string | null, onFinished: () => void): void {
    this.timerCueId = cueId;
    this.onTimerFinished = onFinished;
  }

  /** Whether the given cue is the one holding the countdown right now. */
  ownsTimer(cueId: string): boolean {
    return this.timerCueId === cueId && this.timer.duration > 0 && !this.timer.finished;
  }

  /**
   * How far through the countdown, 0..1 — the timer cue's progress bar. Counted
   * as time *spent*, not time left, so the bar fills the way every other cue's
   * does; the tile's own readout is what says how much is left.
   */
  get timerProgressFraction(): number {
    return this.timer.duration <= 0 ? 0 : 1 - remainingFraction(this.timer);
  }

  /**
   * Scrub the countdown to a fraction (0..1) of its length.
   *
   * The duration is left alone — the cue was set for that long, and dragging
   * the bar is moving the playhead within it, not redefining it. A running
   * clock gets a new end time to match; a paused one just keeps the number,
   * and starts from there when it resumes.
   */
  seekTimer(fraction: number): void {
    const dur = this.timer.duration;
    if (dur <= 0) return;
    const spent = Math.min(1, Math.max(0, fraction)) * dur;
    this.timer.remaining = Math.max(0, dur - spent);
    if (this.timer.running) {
      this.timerEndsAt = Date.now() + this.timer.remaining * 1000;
      this.timer.endsAt = this.timerEndsAt;
    }
    this.renderScreen();
  }

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
    this.renderScreen();
  }

  pauseTimer(): void {
    if (!this.timer.running) return;
    this.timer.remaining = Math.max(0, (this.timerEndsAt - Date.now()) / 1000);
    this.timer.running = false;
    this.timer.endsAt = null;
    this.stopTimerInterval();
    this.renderScreen();
  }

  resumeTimer(): void {
    if (this.timer.running || this.timer.finished || this.timer.remaining <= 0) return;
    this.timer.running = true;
    this.timerEndsAt = Date.now() + this.timer.remaining * 1000;
    this.timer.endsAt = this.timerEndsAt;
    this.startTimerInterval();
    this.renderScreen();
  }

  clearTimer(): void {
    this.timer.duration = 0;
    this.timer.remaining = 0;
    this.timer.running = false;
    this.timer.finished = false;
    this.timer.endsAt = null;
    this.onTimerFinished = null;
    this.timerCueId = null;
    this.stopTimerInterval();
    this.renderScreen();
  }

  openScreenWindow(): void {
    if (!this.screenWindow.open()) {
      this.errorMessage = 'Screen pop-out was blocked. Allow popups for this site and try again.';
      return;
    }
    // Catch the new window up on whatever the slots already hold.
    this.renderScreen();
  }

  private timerTick(): void {
    const rem = Math.max(0, (this.timerEndsAt - Date.now()) / 1000);
    this.timer.remaining = rem;
    if (rem <= 0) {
      this.timer.running = false;
      this.timer.finished = true;
      this.timer.endsAt = null;
      this.stopTimerInterval();
      const finished = this.onTimerFinished;
      this.onTimerFinished = null;
      finished?.();
    }
    this.renderScreen();
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

  // ---- Global video ------------------------------------------------------

  /** Whether a clip currently holds the screen. */
  get videoActive(): boolean {
    return this.video.file != null;
  }

  /** Whether the given cue is the one holding the screen right now. */
  ownsVideo(cueId: string): boolean {
    return this.videoCueId === cueId && this.video.file != null;
  }

  /** Whether the slot is meant to be running (intent, not observation). */
  get videoPlaying(): boolean {
    return this.video.playing;
  }

  /** How far through the clip, 0..1 — the video cue's progress bar. */
  get videoProgressFraction(): number {
    const { position, duration } = this.videoStatus;
    if (duration <= 0) return 0;
    return Math.min(1, Math.max(0, position / duration));
  }

  /**
   * Scrub the clip on screen to a fraction (0..1) of its length.
   *
   * The screen page owns the media element, so this only asks; the readout it
   * pushes back is what the tile normally paints from, and that won't move
   * until the seek lands a frame or two later. Nudging the local copy first
   * keeps the scrub handle under the pointer instead of snapping back.
   */
  seekVideo(fraction: number): void {
    const { duration } = this.videoStatus;
    if (!this.video.file || duration <= 0) return;
    const position = Math.min(1, Math.max(0, fraction)) * duration;
    this.video.seekPosition = position;
    this.video.seekToken++;
    this.videoStatus = { ...this.videoStatus, position };
    this.renderScreen();
  }

  claimVideo(onEnded: () => void): void {
    this.onVideoEnded = onEnded;
  }

  /**
   * Put a clip on the screen, replacing whatever was there. One slot, like the
   * timer: a second video cue takes the screen over rather than sharing it.
   */
  setVideo(req: VideoRequest): void {
    this.video.file = req.file;
    // A fresh generation even for the same File, so re-firing a cue restarts
    // the clip instead of leaving it parked on its last frame.
    this.video.generation++;
    this.video.playing = true;
    this.video.loop = req.loop;
    this.video.muted = req.muted;
    this.video.volume = req.volume;
    this.video.fit = req.fit;
    this.videoCueId = req.cueId;
    // Nothing measured yet: the old clip's position must not leak into the new
    // cue's tile for the frame or two before the screen reports back.
    this.videoStatus = { ...IDLE_STATUS };
    this.renderScreen();
  }

  pauseVideo(): void {
    if (!this.video.file || !this.video.playing) return;
    this.video.playing = false;
    this.renderScreen();
  }

  resumeVideo(): void {
    if (!this.video.file || this.video.playing) return;
    this.video.playing = true;
    this.renderScreen();
  }

  clearVideo(): void {
    this.video.file = null;
    this.video.playing = false;
    // Bumped on the way out too, so an `ended` report still in flight for the
    // clip we just pulled is recognisable as stale.
    this.video.generation++;
    this.videoCueId = null;
    this.videoStatus = { ...IDLE_STATUS };
    this.onVideoEnded = null;
    this.renderScreen();
  }

  /**
   * The screen page reporting that a clip played out. The picture leaves the
   * screen — a show shouldn't be left holding a frozen last frame — which also
   * floats the timer back in behind it.
   */
  private videoEnded(generation: number): void {
    if (generation !== this.video.generation) return; // stale: already replaced
    const ended = this.onVideoEnded;
    this.clearVideo();
    ended?.();
  }

  /** Live readout from the screen page, for the clip it's actually showing. */
  private videoProgress(generation: number, status: VideoStatus): void {
    if (generation !== this.video.generation) return; // stale: already replaced
    this.videoStatus = status;
  }

  /**
   * The screen window went away. Whatever it was showing is gone with it, so
   * the slot empties — but silently: the clip didn't reach its end, so its
   * onEnd chain must not fire.
   */
  private screenClosing(): void {
    if (!this.video.file) return;
    this.clearVideo();
  }

  private renderScreen(): void {
    this.screenWindow.render({
      timer: $state.snapshot(this.timer),
      // A shallow copy, not $state.snapshot: the view is flat, and snapshotting
      // would structuredClone the File — copying the entire clip's bytes on
      // every push, several times a second while the timer runs.
      video: { ...this.video },
    });
  }
}

export const app = new AppState();
