// End-to-end exercise of the multi-document flow against a fake project folder:
// opening several cue files side by side, keeping their state isolated, sharing
// decoded audio between them, and releasing only what a closed document
// uniquely held.

import { beforeAll, describe, expect, it } from 'vitest';
import { installAudioStubs, makeFakeDir } from '../test-utils/webAudioStub';

const stubs = installAudioStubs();

const audioCue = (id: string, file: string, col = 0) => ({
  id,
  type: 'audio',
  row: 0,
  col,
  triggers: [],
  name: id,
  color: '#3b82f6',
  file,
  startTime: 0,
  endTime: null,
  fadeIn: 0,
  fadeOut: 0.5,
  volume: 1,
  loop: false,
  onStopBehavior: 'stop',
});

const AUDIO_FILES = ['shared.mp3', 'onlyA.mp3', 'onlyB.mp3'];
const CUE_FILES = {
  // showA uses shared.mp3 twice — two cues, one file.
  'showA.wsp': JSON.stringify({
    version: 1,
    grid: { rows: 4, cols: 8 },
    masterVolume: 1,
    tabs: [
      {
        id: 'tab-a',
        name: 'A',
        cues: [
          audioCue('cue-a1', 'shared.mp3', 0),
          audioCue('cue-a2', 'onlyA.mp3', 1),
          audioCue('cue-a3', 'shared.mp3', 2),
        ],
      },
    ],
  }),
  'showB.wsp': JSON.stringify({
    version: 1,
    grid: { rows: 2, cols: 2 },
    masterVolume: 0.5,
    tabs: [
      {
        id: 'tab-b',
        name: 'B',
        cues: [audioCue('cue-b1', 'shared.mp3', 0), audioCue('cue-b2', 'onlyB.mp3', 1)],
      },
    ],
  }),
};

const fakeDir = makeFakeDir({ cueFiles: CUE_FILES, audioFiles: AUDIO_FILES });
(globalThis as Record<string, unknown>).showDirectoryPicker = async () => fakeDir;

let app: typeof import('./project.svelte').app;
let audioCache: typeof import('../audio/sharedAudio').audioCache;

beforeAll(async () => {
  ({ app } = await import('./project.svelte'));
  ({ audioCache } = await import('../audio/sharedAudio'));
});

describe('multi-document app state', () => {
  it('offers a chooser when the folder holds several cue files', async () => {
    await app.openFolder();
    expect(app.status).toBe('choosing');
    expect(app.cueFiles).toEqual(['showA.wsp', 'showB.wsp']);
    expect(app.docs).toHaveLength(0);
  });

  it('opens a cue file, decoding each distinct audio file once', async () => {
    const before = stubs.decodes;
    await app.openCueFile('showA.wsp');

    expect(app.docs).toHaveLength(1);
    expect(app.activeDoc?.title).toBe('showA.wsp');
    expect(app.status).toBe('ready');
    // Three audio cues, but two distinct files — shared.mp3 is decoded once.
    expect(stubs.decodes - before).toBe(2);
    expect(app.project?.grid).toEqual({ rows: 4, cols: 8 });
  });

  it('reports decoded cues as ready, not missing', () => {
    // Regression: `display()` used to read buffer residency straight from the
    // engine's (non-reactive) Map, so tiles rendered during decoding painted as
    // "media missing" and never re-evaluated — they only corrected themselves
    // once played, because that happened to touch reactive playback state.
    const doc = app.activeDoc!;
    for (const cue of doc.project.tabs[0].cues) {
      const info = doc.display(cue);
      expect(info.missing, `${cue.id} should not be missing`).toBe(false);
      expect(info.pending, `${cue.id} should not still be pending`).toBe(false);
      expect(doc.hasBuffer(cue.id)).toBe(true);
    }
  });

  it('marks cues pending while decoding, then ready — never missing', async () => {
    const doc = app.activeDoc!;
    const cue = doc.project.tabs[0].cues[0];

    const decoding = doc.reloadCueAudio(cue as never);
    // Observed mid-flight: pending, and specifically NOT missing, so the tile
    // shows a loading state rather than an error.
    expect(doc.display(cue).pending).toBe(true);
    expect(doc.display(cue).missing).toBe(false);

    await decoding;
    expect(doc.display(cue).pending).toBe(false);
    expect(doc.display(cue).missing).toBe(false);
  });

  it('reports a cue whose file is absent from the folder as missing', async () => {
    const doc = app.activeDoc!;
    const cue = doc.project.tabs[0].cues[1] as unknown as { file: string; id: string };
    const original = cue.file;

    cue.file = 'not-in-this-folder.mp3';
    await doc.reloadCueAudio(cue as never);
    expect(doc.display(cue as never).missing).toBe(true);
    expect(doc.display(cue as never).pending).toBe(false);

    cue.file = original;
    await doc.reloadCueAudio(cue as never);
    expect(doc.display(cue as never).missing).toBe(false);
  });

  it('opens a second document alongside the first, reusing shared audio', async () => {
    const before = stubs.decodes;
    app.showChooser();
    await app.openCueFile('showB.wsp');

    expect(app.docs).toHaveLength(2);
    expect(app.activeDoc?.title).toBe('showB.wsp');
    // showB's shared.mp3 is already resident from showA; only onlyB.mp3 is new.
    expect(stubs.decodes - before).toBe(1);
    expect(audioCache.stats().files).toBe(3);
  });

  it('forwards active-document state to the top-level accessors', () => {
    expect(app.project?.grid).toEqual({ rows: 2, cols: 2 });
    expect(app.project?.masterVolume).toBe(0.5);
    expect(app.activeTabId).toBe('tab-b');
  });

  it('keeps edits isolated to the document they were made in', () => {
    const [docA, docB] = app.docs;

    app.markDirty();
    expect(docB.dirty).toBe(true);
    expect(docA.dirty).toBe(false);
    expect(app.anyDirty).toBe(true);

    app.addTab();
    expect(docB.project.tabs).toHaveLength(2);
    expect(docA.project.tabs).toHaveLength(1);

    app.setGrid(6, 6);
    expect(docB.project.grid).toEqual({ rows: 6, cols: 6 });
    expect(docA.project.grid).toEqual({ rows: 4, cols: 8 });
  });

  it('restores a document’s own view when switching back to it', () => {
    const [docA] = app.docs;
    app.selectDoc(docA.id);

    expect(app.activeDoc?.title).toBe('showA.wsp');
    expect(app.project?.grid).toEqual({ rows: 4, cols: 8 });
    expect(app.activeTabId).toBe('tab-a');
    expect(app.dirty).toBe(false); // showA was never edited
  });

  it('switches to an already-open file rather than opening it twice', async () => {
    const before = stubs.decodes;
    await app.openCueFile('showB.wsp');

    expect(app.docs).toHaveLength(2);
    expect(app.activeDoc?.title).toBe('showB.wsp');
    expect(stubs.decodes - before).toBe(0);
  });

  it('frees only the audio a closed document uniquely held', () => {
    // showB holds shared.mp3 (also in showA) and onlyB.mp3 (its own).
    app.closeDoc(app.activeDoc!.id);

    expect(app.docs).toHaveLength(1);
    expect(app.activeDoc?.title).toBe('showA.wsp');
    // onlyB.mp3 is gone; shared.mp3 and onlyA.mp3 remain for showA.
    expect(audioCache.stats().files).toBe(2);
  });

  describe('creating a named cue file', () => {
    it('pre-fills an unused default name', () => {
      app.showChooser();
      app.promptNewCueFile();
      expect(app.newFileFolder).not.toBeNull();
      // cues.wsp isn't taken in this folder, so it's offered as-is.
      expect(app.newFileName).toBe('cues.wsp');
      expect(app.newFileError).toBeNull();
      expect(app.newFileWarning).toBeNull();
    });

    it('rejects an invalid name and refuses to create', () => {
      const before = app.docs.length;
      app.newFileName = 'sub/act one';
      expect(app.newFileError).toBeTruthy();

      app.createCueFile();
      expect(app.docs).toHaveLength(before); // nothing created
      expect(app.newFileFolder).not.toBeNull(); // dialog stays open
    });

    it('warns without blocking when the name is already on disk', () => {
      // showB.wsp exists in the folder but its tab was closed earlier.
      app.newFileName = 'showB.wsp';
      expect(app.newFileError).toBeNull(); // still creatable — overwrite is allowed
      expect(app.newFileWarning).toMatch(/already exists/);
    });

    it('prefers the open-tab warning when the name is both on disk and open', () => {
      // showA.wsp is open, so two documents would fight over the same file —
      // more actionable than "this file exists", so it's the one we show.
      app.newFileName = 'showA.wsp';
      expect(app.newFileError).toBeNull();
      expect(app.newFileWarning).toMatch(/already open/);
    });

    it('creates the document with the typed name, adding .wsp', () => {
      const before = app.docs.length;
      app.newFileName = 'act one';
      expect(app.newFileError).toBeNull();

      app.createCueFile();

      expect(app.docs).toHaveLength(before + 1);
      expect(app.activeDoc?.saveName).toBe('act one.wsp');
      expect(app.activeDoc?.title).toBe('act one.wsp');
      // Nothing is on disk until Save, so it starts dirty.
      expect(app.activeDoc?.dirty).toBe(true);
      expect(app.newFileFolder).toBeNull(); // dialog closed
      expect(app.status).toBe('ready');
    });

    it('cancelling creates nothing', () => {
      const before = app.docs.length;
      app.promptNewCueFile();
      app.newFileName = 'never-made.wsp';
      app.cancelNewCueFile();

      expect(app.docs).toHaveLength(before);
      expect(app.newFileFolder).toBeNull();
    });

    it('suggests a non-colliding default once the obvious name is taken', async () => {
      // Save the "act one.wsp" document so it exists in the folder listing.
      const doc = app.docs.find((d) => d.saveName === 'act one.wsp')!;
      await doc.save();
      expect(doc.folder.cueFiles).toContain('act one.wsp');

      app.promptNewCueFile();
      expect(app.newFileName).toBe('cues.wsp'); // still free

      // But a name that *is* taken gets flagged.
      app.newFileName = 'act one.wsp';
      expect(app.newFileWarning).toBeTruthy();
      app.cancelNewCueFile();

      // Tidy up so the closing tests see the expected document set.
      app.closeDoc(doc.id);
    });
  });

  it('releases everything once the last document closes', () => {
    app.closeDoc(app.activeDoc!.id);

    expect(app.docs).toHaveLength(0);
    expect(app.status).toBe('empty');
    expect(audioCache.stats()).toEqual({ files: 0, bytes: 0 });
  });
});
