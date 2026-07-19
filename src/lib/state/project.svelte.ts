// Central app state (Svelte 5 runes). Owns the list of open documents (one per
// cue file), the folders they came from, and the genuinely global bits: the
// countdown timer, the context menu, and the properties modal.
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
import { TimerWindow, type TimerView } from '../timer/timer';
import { Doc, type CueDisplay, type TriggerHint, type TimerHost } from './doc.svelte';
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

export class AppState implements TimerHost {
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
  /** Whether a drag-enabling modifier (Shift or Ctrl) is currently held. */
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
  timer = $state<TimerView>({ duration: 0, remaining: 0, running: false, finished: false });
  /** Bumped whenever decoded-audio residency changes, so readouts can react. */
  memoryVersion = $state(0);

  private folders: Folder[] = [];
  private timerEndsAt = 0;
  private timerInterval = 0;
  private timerWindow = new TimerWindow();
  /** What to run when the countdown reaches zero on its own — set by whichever
   *  document's timer cue last started it. */
  private onTimerFinished: (() => void) | null = null;

  // ---- Documents ---------------------------------------------------------

  get activeDoc(): Doc | null {
    return this.docs.find((d) => d.id === this.activeDocId) ?? this.docs[0] ?? null;
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
      } else {
        folder = new Folder(opened.dir, opened.cueFiles, opened.audioFiles);
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

  // ---- Global timer ------------------------------------------------------

  claimTimer(onFinished: () => void): void {
    this.onTimerFinished = onFinished;
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
    this.onTimerFinished = null;
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
      const finished = this.onTimerFinished;
      this.onTimerFinished = null;
      finished?.();
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
}

export const app = new AppState();
