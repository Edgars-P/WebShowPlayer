// File System Access API layer: pick a project folder, discover cue files,
// read/write them (native .wsp/.json plus best-effort .lsp import), and load
// audio files from anywhere in the folder tree.

import type { CueRef, Project, ProxyCue } from '../types';
import { defaultProject, PROJECT_VERSION } from '../types';
import { convertLisp, looksLikeLisp } from './lisp';

const CUE_EXTS = ['.wsp', '.json', '.lsp'];
const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.webm'];
const MAX_DEPTH = 6;

export const DEFAULT_CUE_FILE = 'cues.wsp';

export interface FolderContents {
  dir: FileSystemDirectoryHandle;
  /** Cue-file names in the folder root (e.g. cues.wsp, old.lsp). */
  cueFiles: string[];
  /** Audio files anywhere in the tree, as folder-relative paths ("sub/a.mp3"). */
  audioFiles: string[];
}

export interface LoadedCueFile {
  project: Project;
  /** File name that Save should write to. */
  saveName: string;
}

export function isFsAccessSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export async function pickProjectFolder(): Promise<FolderContents> {
  if (!isFsAccessSupported()) {
    throw new Error('This browser does not support the File System Access API. Use Chrome or Edge.');
  }
  const dir = await window.showDirectoryPicker!({ mode: 'readwrite' });
  const [cueFiles, audioFiles] = await Promise.all([listCueFiles(dir), listAudioFiles(dir)]);
  return { dir, cueFiles, audioFiles };
}

function hasExt(name: string, exts: string[]): boolean {
  const lower = name.toLowerCase();
  return exts.some((e) => lower.endsWith(e));
}

/** Cue files live in the folder root. */
export async function listCueFiles(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && hasExt(entry.name, CUE_EXTS)) names.push(entry.name);
  }
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

/** Recursively list audio files, returning folder-relative paths. */
export async function listAudioFiles(
  dir: FileSystemDirectoryHandle,
  prefix = '',
  depth = 0,
): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of dir.values()) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      if (hasExt(entry.name, AUDIO_EXTS)) out.push(rel);
    } else if (entry.kind === 'directory' && depth < MAX_DEPTH && !entry.name.startsWith('.')) {
      out.push(...(await listAudioFiles(entry as FileSystemDirectoryHandle, rel, depth + 1)));
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** Save target for a given source cue-file name: .lsp imports become .wsp. */
export function saveNameFor(name: string): string {
  return name.toLowerCase().endsWith('.lsp') ? name.replace(/\.lsp$/i, '.wsp') : name;
}

export async function readCueFile(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<LoadedCueFile> {
  const handle = await dir.getFileHandle(name);
  const text = await (await handle.getFile()).text();
  const saveName = saveNameFor(name);
  if (!text.trim()) return { project: defaultProject(), saveName };
  const data = JSON.parse(text) as unknown;
  const isLisp = name.toLowerCase().endsWith('.lsp') || looksLikeLisp(data);
  const project = isLisp ? convertLisp(data) : normalizeProject(data as Partial<Project>);
  return { project, saveName };
}

/** Old CueRef shape (position-based), from before refs became id-based. */
interface LegacyCueRef {
  tab: string;
  row: number;
  col: number;
}

function isLegacyRef(r: unknown): r is LegacyCueRef {
  return !!r && typeof r === 'object' && 'row' in r && 'col' in r && !('cueId' in r);
}

/** Migrate a possibly-old-shape ref to the current id-based CueRef. Unresolvable
 *  (dangling) refs become the same "unset" state a fresh trigger already has. */
function migrateRef(r: CueRef | LegacyCueRef, project: Project): CueRef {
  if (!isLegacyRef(r)) return r;
  const tab = project.tabs.find((t) => t.id === r.tab);
  const found = tab?.cues.find((c) => c.row === r.row && c.col === r.col);
  return { cueId: found?.id ?? '' };
}

/** Fill in missing/invalid fields so older or hand-edited files still load. */
function normalizeProject(p: Partial<Project>): Project {
  const base = defaultProject();
  const project: Project = {
    version: typeof p.version === 'number' ? p.version : PROJECT_VERSION,
    grid: { rows: p.grid?.rows ?? base.grid.rows, cols: p.grid?.cols ?? base.grid.cols },
    masterVolume: typeof p.masterVolume === 'number' ? p.masterVolume : 1,
    tabs: Array.isArray(p.tabs) && p.tabs.length > 0 ? (p.tabs as Project['tabs']) : base.tabs,
  };
  for (const tab of project.tabs) {
    if (!Array.isArray(tab.cues)) tab.cues = [];
    for (const cue of tab.cues) if (!Array.isArray(cue.triggers)) cue.triggers = [];
  }
  // Migrate any old position-based refs (triggers + proxy sources) to id-based,
  // now that every cue's real id is known.
  for (const tab of project.tabs) {
    for (const cue of tab.cues) {
      for (const trig of cue.triggers) trig.target = migrateRef(trig.target, project);
      if (cue.type === 'proxy') (cue as ProxyCue).source = migrateRef((cue as ProxyCue).source, project);
    }
  }
  return project;
}

export async function writeCueFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  project: Project,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(project, null, 2));
  await writable.close();
}

export function isAudioFile(name: string): boolean {
  return hasExt(name, AUDIO_EXTS);
}

function uniqueFileName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot >= 0 ? name.slice(0, dot) : name;
  const ext = dot >= 0 ? name.slice(dot) : '';
  let i = 2;
  while (taken.has(`${stem}-${i}${ext}`.toLowerCase())) i++;
  return `${stem}-${i}${ext}`;
}

/**
 * Copy a dropped audio File into the folder root, avoiding name clashes with
 * `taken` (lowercased names, mutated to include the new one). Returns the name.
 */
export async function writeMediaFile(
  dir: FileSystemDirectoryHandle,
  file: File,
  taken: Set<string>,
): Promise<string> {
  const name = uniqueFileName(file.name, taken);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file);
  await writable.close();
  taken.add(name.toLowerCase());
  return name;
}

/** Load an audio file by folder-relative path (traverses subfolders). */
export async function loadAudioBytes(
  dir: FileSystemDirectoryHandle,
  relPath: string,
): Promise<ArrayBuffer> {
  const parts = relPath.split('/').filter(Boolean);
  let d = dir;
  for (let i = 0; i < parts.length - 1; i++) {
    d = await d.getDirectoryHandle(parts[i]);
  }
  const handle = await d.getFileHandle(parts[parts.length - 1]);
  return (await handle.getFile()).arrayBuffer();
}
