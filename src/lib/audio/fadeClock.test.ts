// A fade runs on the audio clock, but the timers that move a cue through its
// states run on the wall clock, and on the first cue of a session those two are
// a long way apart: the context is suspended until a gesture and isn't waited
// for, so the ramps go down against a `currentTime` that hasn't started moving.
//
// These tests hold the two clocks apart on purpose. What they are protecting is
// the launchpad tile, which paints the wedge from the audio clock and commits on
// the state change: let the state run ahead and the tile commits to full while
// its wedge still has a second to go — on the first play, and no other.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceAudioClock, installAudioStubs, makeFakeDir, resetAudioClock } from '../test-utils/webAudioStub';
import type { AudioCue } from '../types';

installAudioStubs();

const audioCue = (id: string, col: number, over: Record<string, unknown> = {}) => ({
  id,
  type: 'audio',
  row: 0,
  col,
  triggers: [],
  name: id,
  color: '#3b82f6',
  file: 'track.mp3',
  startTime: 0,
  endTime: null,
  fadeIn: 3,
  fadeOut: 3,
  fadeOutOnEnd: false,
  volume: 1,
  loop: false,
  onStopBehavior: 'stop',
  ...over,
});

const CUE_FILES = {
  'show.wsp': JSON.stringify({
    version: 1,
    grid: { rows: 2, cols: 4 },
    masterVolume: 1,
    tabs: [{ id: 'tab-1', name: 'A', cues: [audioCue('c1', 0)] }],
  }),
};

const fakeDir = makeFakeDir({ cueFiles: CUE_FILES, audioFiles: ['track.mp3'] });
(globalThis as Record<string, unknown>).showDirectoryPicker = async () => fakeDir;

let app: typeof import('../state/project.svelte').app;

beforeAll(async () => {
  ({ app } = await import('../state/project.svelte'));
  await app.openFolder(); // single cue file -> opens directly
});

const doc = () => app.docs[0];
const cue = () => doc().findCue('c1')! as AudioCue;
const state = () => doc().playStates['c1'] ?? 'idle';

/** Wall-clock time passing with the audio clock stopped, as at a cold start. */
const wallOnly = (seconds: number) => vi.advanceTimersByTime(seconds * 1000);

/** Both clocks running together, as everywhere after the context has started. */
const bothClocks = (seconds: number) => {
  advanceAudioClock(seconds);
  vi.advanceTimersByTime(seconds * 1000);
};

describe('fades while the audio clock is still starting up', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAudioClock();
  });

  afterEach(() => {
    doc().applyToAllAudio('stop', false);
    vi.useRealTimers();
  });

  it('holds a cue in its fade-in until the audio has finished fading', () => {
    doc().activate(cue()); // 3s fade-in

    // Three seconds of wall time — the whole fade, as far as a timeout knows.
    wallOnly(3);

    // But not a sample of it has played, so the tile must not commit: it paints
    // the wedge off the audio clock, and the wedge hasn't moved either.
    expect(state()).toBe('fadingIn');
    expect(doc().fadeProgress(cue())).toBeLessThan(1);
  });

  it('lets it through once the audio clock has caught up', () => {
    doc().activate(cue());
    wallOnly(3);

    advanceAudioClock(3); // the context finally starts
    wallOnly(3.1); // and the re-armed timer comes round

    expect(state()).toBe('playing');
    expect(doc().fadeProgress(cue())).toBe(1);
  });

  it('keeps the state and the fade in step once both clocks run together', () => {
    // The ordinary case, and the one the first play should look like: the fade
    // is only over when the tile says it is.
    advanceAudioClock(1); // a context that was already running
    doc().activate(cue());

    bothClocks(2.9);
    expect(state()).toBe('fadingIn');
    expect(doc().fadeProgress(cue())).toBeGreaterThan(0.9);

    bothClocks(0.2);
    expect(state()).toBe('playing');
  });

  it('moves the readout clock on the same beat as the state', () => {
    // The tile takes its state from `playStates` and everything else — how long
    // the fade is, how far through it is — from behind `tick`. Leave `tick` to
    // the animation loop and there is a frame where the two disagree, and the
    // disagreement is not harmless: a fresh `fadingIn` alongside the fade length
    // of a moment ago, which is zero, is indistinguishable from a cut, and the
    // tile starts committing to a full card before correcting itself.
    const before = doc().tick;

    doc().activate(cue());

    expect(doc().playStates['c1']).toBe('fadingIn');
    expect(doc().tick).toBeGreaterThan(before);
    expect(doc().fadeSeconds(cue())).toBe(3);
  });

  it('does not cut a fade-out short either', () => {
    advanceAudioClock(1);
    doc().activate(cue());
    bothClocks(3.1); // playing
    resetAudioClock(); // the clock stalls, as it can on a cold context

    doc().activate(cue()); // click again: 3s fade-out
    expect(state()).toBe('fadingOut');

    wallOnly(3.1);
    // Finalizing here would drop the tail of the fade on the floor and put the
    // tile out while the cue was still audible.
    expect(state()).toBe('fadingOut');

    advanceAudioClock(10);
    wallOnly(3.1);
    expect(state()).toBe('idle');
  });
});
