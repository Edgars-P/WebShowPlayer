// A project folder that one or more open documents share.
//
// Two cue files from the same folder point at the same audio tree, so the
// folder — not the document — owns the directory handle and the file listings.
// Sharing it also means their decoded buffers share cache keys, so a track used
// by both is decoded once.

import { listAudioFiles, listCueFiles } from '../fs/projectFs';
import { makeId } from '../types';

export class Folder {
  readonly id = makeId('folder');
  readonly dir: FileSystemDirectoryHandle;
  /** Cue-file names in the folder root (for the chooser). */
  cueFiles = $state<string[]>([]);
  /** Audio files anywhere in the tree, as folder-relative paths. */
  audioFiles = $state<string[]>([]);

  constructor(dir: FileSystemDirectoryHandle, cueFiles: string[], audioFiles: string[]) {
    this.dir = dir;
    this.cueFiles = cueFiles;
    this.audioFiles = audioFiles;
  }

  get name(): string {
    return this.dir.name;
  }

  async refreshAudioFiles(): Promise<void> {
    this.audioFiles = await listAudioFiles(this.dir);
  }

  async refreshCueFiles(): Promise<void> {
    this.cueFiles = await listCueFiles(this.dir);
  }
}
