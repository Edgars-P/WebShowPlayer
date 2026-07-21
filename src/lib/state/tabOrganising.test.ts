// Reordering tabs, and moving cues between them.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installAudioStubs, makeFakeDir } from '../test-utils/webAudioStub';

installAudioStubs();

const audioCue = (id: string, row: number, col: number, triggers: unknown[] = []) => ({
  id,
  type: 'audio',
  row,
  col,
  triggers,
  name: id,
  color: '#3b82f6',
  file: 'track.mp3',
  startTime: 0,
  endTime: null,
  fadeIn: 0,
  fadeOut: 0,
  volume: 1,
  loop: false,
  onStopBehavior: 'stop',
});

/** A 2x2 grid keeps "tab is full" reachable in a test. */
const project = () => ({
  version: 1,
  grid: { rows: 2, cols: 2 },
  masterVolume: 1,
  tabs: [
    {
      id: 'one',
      name: 'One',
      cues: [
        audioCue('a', 0, 0, [{ events: ['onStart'], target: { cueId: 'b' }, action: 'start' }]),
        audioCue('b', 1, 1),
      ],
    },
    { id: 'two', name: 'Two', cues: [audioCue('c', 0, 0)] },
    { id: 'three', name: 'Three', cues: [] },
  ],
});

const fakeDir = makeFakeDir({
  cueFiles: { 'show.wsp': JSON.stringify(project()) },
  audioFiles: ['track.mp3'],
});
(globalThis as Record<string, unknown>).showDirectoryPicker = async () => fakeDir;

let app: typeof import('./project.svelte').app;

beforeAll(async () => {
  ({ app } = await import('./project.svelte'));
  await app.openFolder();
});

const doc = () => app.activeDoc!;
const tabIds = () => doc().project.tabs.map((t) => t.id);
const tabOf = (cueId: string) =>
  doc().project.tabs.find((t) => t.cues.some((c) => c.id === cueId))?.id;
const cellOf = (cueId: string) => {
  const cue = doc().findCue(cueId)!;
  return { row: cue.row, col: cue.col };
};

/** Restore the fixture between tests, since these all mutate structure. */
beforeEach(() => {
  doc().project.tabs = project().tabs as never;
  doc().activeTabId = 'one';
  app.errorMessage = '';
});

describe('reordering tabs', () => {
  it('moves a tab to a new position', () => {
    doc().moveTab('three', 0);
    expect(tabIds()).toEqual(['three', 'one', 'two']);
  });

  it('moves a tab later in the strip', () => {
    doc().moveTab('one', 2);
    expect(tabIds()).toEqual(['two', 'three', 'one']);
  });

  it('is a no-op when dropped on itself', () => {
    doc().dirty = false;
    doc().moveTab('two', 1);
    expect(tabIds()).toEqual(['one', 'two', 'three']);
    expect(doc().dirty).toBe(false); // nothing changed, nothing to save
  });

  it('clamps an out-of-range index instead of losing the tab', () => {
    doc().moveTab('one', 99);
    expect(tabIds()).toEqual(['two', 'three', 'one']);
  });

  it('ignores an unknown tab id', () => {
    doc().moveTab('nope', 0);
    expect(tabIds()).toEqual(['one', 'two', 'three']);
  });

  it('keeps the active tab selected as it moves', () => {
    doc().activeTabId = 'one';
    doc().moveTab('one', 2);
    // Selection follows the tab itself, not the position it used to hold.
    expect(doc().activeTab?.id).toBe('one');
  });

  it('marks the document dirty', () => {
    doc().dirty = false;
    doc().moveTab('three', 0);
    expect(doc().dirty).toBe(true);
  });
});

describe('moving cues between tabs', () => {
  it('moves a cue and keeps its cell when that cell is free', () => {
    // `b` sits at 1,1; tab three is empty, so the cell is available.
    expect(doc().moveCueToTab('b', 'three')).toBe(true);
    expect(tabOf('b')).toBe('three');
    expect(cellOf('b')).toEqual({ row: 1, col: 1 });
  });

  it('drops into the first free cell when its own is taken', () => {
    // `a` is at 0,0 and so is `c` in tab two.
    expect(doc().moveCueToTab('a', 'two')).toBe(true);
    expect(tabOf('a')).toBe('two');
    expect(cellOf('a')).not.toEqual({ row: 0, col: 0 });
    // ...and it hasn't displaced the cue that was already there.
    expect(cellOf('c')).toEqual({ row: 0, col: 0 });
  });

  it('removes the cue from its old tab', () => {
    doc().moveCueToTab('a', 'three');
    expect(doc().project.tabs.find((t) => t.id === 'one')!.cues.map((c) => c.id)).toEqual(['b']);
  });

  it('refuses when the target tab is full, leaving everything put', () => {
    // Fill tab three's 2x2 grid.
    const three = doc().project.tabs.find((t) => t.id === 'three')!;
    three.cues = [
      audioCue('f1', 0, 0),
      audioCue('f2', 0, 1),
      audioCue('f3', 1, 0),
      audioCue('f4', 1, 1),
    ] as never;

    expect(doc().moveCueToTab('a', 'three')).toBe(false);
    expect(tabOf('a')).toBe('one'); // unmoved
  });

  it('surfaces a message rather than silently doing nothing when full', () => {
    const three = doc().project.tabs.find((t) => t.id === 'three')!;
    three.cues = [
      audioCue('f1', 0, 0),
      audioCue('f2', 0, 1),
      audioCue('f3', 1, 0),
      audioCue('f4', 1, 1),
    ] as never;

    app.moveCueToTab('a', 'three');
    expect(app.errorMessage).toMatch(/no empty cell/i);
  });

  it('is a no-op for a cue already in that tab', () => {
    doc().dirty = false;
    expect(doc().moveCueToTab('a', 'one')).toBe(true);
    expect(tabOf('a')).toBe('one');
    expect(doc().dirty).toBe(false);
  });

  it('returns false for unknown cues and tabs', () => {
    expect(doc().moveCueToTab('nope', 'two')).toBe(false);
    expect(doc().moveCueToTab('a', 'nope')).toBe(false);
  });

  it('keeps triggers pointing at the cue working across the move', () => {
    // `a` starts `b`; moving `b` to another tab must not break the reference,
    // since triggers address cues by id, not position.
    doc().moveCueToTab('b', 'two');
    expect(doc().resolveRef({ cueId: 'b' })?.id).toBe('b');

    doc().activate(doc().findCue('a') as never);
    expect(doc().playStates['b']).toBe('playing');
    app.stopAllAudio(false);
  });

  it('keeps the cue’s decoded audio across the move', () => {
    expect(doc().hasBuffer('a')).toBe(true);
    doc().moveCueToTab('a', 'three');
    // The cue keeps its id, so its buffer binding is untouched.
    expect(doc().hasBuffer('a')).toBe(true);
  });
});
