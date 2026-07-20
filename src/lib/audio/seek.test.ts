// Scrubbing. The tile's seek bar is the only thing that moves a cue's position
// without starting or stopping it, and that "without" is the whole risk: the
// engine has to splice a new source onto a live playback while leaving the fade
// automation, the playback state, and every trigger chain hanging off the cue
// exactly as they were.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  installAudioStubs,
  lastGainNode,
  lastSourceNode,
  makeFakeDir,
  resetGainNodes,
  resetSourceNodes,
} from '../test-utils/webAudioStub';

installAudioStubs();

/** The stub decodes every file to a 60-second buffer. */
const BUFFER_SECONDS = 60;

const audioCue = (id: string, col: number) => ({
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
  fadeIn: 0,
  fadeOut: 0,
  fadeOutOnEnd: false,
  volume: 1,
  loop: false,
  onStopBehavior: 'stop',
});

/** c1 is the cue under test; c2 exists only to receive c1's triggers. */
const CUE_FILES = {
  'show.wsp': JSON.stringify({
    version: 1,
    grid: { rows: 2, cols: 4 },
    masterVolume: 1,
    tabs: [{ id: 'tab-1', name: 'A', cues: [audioCue('c1', 0), audioCue('c2', 1)] }],
  }),
};

const fakeDir = makeFakeDir({ cueFiles: CUE_FILES, audioFiles: ['track.mp3'] });
(globalThis as Record<string, unknown>).showDirectoryPicker = async () => fakeDir;

let app: typeof import('../state/project.svelte').app;

beforeAll(async () => {
  ({ app } = await import('../state/project.svelte'));
  await app.openFolder(); // single cue file -> opens directly
});

interface Tweaks {
  fadeIn?: number;
  fadeOut?: number;
  fadeOutOnEnd?: boolean;
  startTime?: number;
  endTime?: number | null;
  loop?: boolean;
  triggers?: unknown[];
}

const DEFAULTS = {
  fadeIn: 0,
  fadeOut: 0,
  fadeOutOnEnd: false,
  startTime: 0,
  endTime: null,
  loop: false,
  triggers: [],
};

function cue(id: string) {
  return app.activeDoc!.findCue(id) as unknown as Record<string, unknown>;
}

/** Configure c1 and fire it. */
function play(tweaks: Tweaks = {}) {
  const c1 = cue('c1');
  Object.assign(c1, DEFAULTS, tweaks);
  Object.assign(cue('c2'), DEFAULTS);
  resetGainNodes();
  resetSourceNodes();
  app.activeDoc!.activate(c1 as never);
  return c1;
}

/** Where the source now playing was told to start reading from, in seconds. */
const sourceOffset = () => lastSourceNode()!.startArgs![1];
const state = (id: string) => app.display(cue(id) as never).state;

beforeEach(() => app.stopAllAudio(false));

describe('seeking', () => {
  it('restarts the source at the new offset', () => {
    const c1 = play();
    app.seekTo(c1 as never, 0.5);

    expect(sourceOffset()).toBeCloseTo(BUFFER_SECONDS / 2, 6);
    expect(app.progress(c1 as never)).toBeCloseTo(0.5, 6);
  });

  it('measures the fraction against the cue trim, not the whole file', () => {
    const c1 = play({ startTime: 10, endTime: 30 });
    app.seekTo(c1 as never, 0.25);

    // A quarter of the way through the 20s the cue actually plays.
    expect(sourceOffset()).toBeCloseTo(15, 6);
  });

  it('retires the source it replaces', () => {
    const c1 = play();
    const first = lastSourceNode()!;
    app.seekTo(c1 as never, 0.5);

    expect(lastSourceNode()).not.toBe(first);
    expect(first.stopped).toBe(true);
    // Silently: the old source ending must not read as the clip playing out.
    expect(first.onended).toBeNull();
    expect(state('c1')).toBe('playing');
  });

  it('fires no triggers — scrubbing is not starting or stopping', () => {
    // Every event a seek might be mistaken for, all pointed at c2. None of them
    // is onStart, so firing c1 leaves c2 idle and any later change is the seek.
    const c1 = play({
      triggers: [
        { event: 'onStop', target: { cueId: 'c2' }, action: 'start' },
        { event: 'onPause', target: { cueId: 'c2' }, action: 'start' },
        { event: 'onEnd', target: { cueId: 'c2' }, action: 'start' },
      ],
    });
    expect(state('c2')).toBe('idle');

    app.seekTo(c1 as never, 0.9);

    expect(state('c2')).toBe('idle');
    expect(state('c1')).toBe('playing');
  });

  it('leaves a fade-in running rather than snapping to full level', () => {
    const c1 = play({ fadeIn: 5 });
    expect(state('c1')).toBe('fadingIn');
    const events = lastGainNode()!.events.length;

    app.seekTo(c1 as never, 0.5);

    // Still easing in, and the ramp on the gain node was not touched.
    expect(state('c1')).toBe('fadingIn');
    expect(lastGainNode()!.events.length).toBe(events);
  });

  it('re-aims the end-of-clip fade at the new out point', () => {
    const c1 = play({ fadeOut: 4, fadeOutOnEnd: true });
    // Scheduled against the original start: the fade runs 56s -> 60s.
    expect(lastGainNode()!.events).toContainEqual({ kind: 'ramp', value: 0.0001, time: 60 });

    // Jump to 30s in: only 30s of audio is left, so the fade must now land 30s
    // from now, not at the 60s mark it was aimed at.
    app.seekTo(c1 as never, 0.5);
    const ramps = lastGainNode()!.events.filter((e) => e.kind === 'ramp');
    expect(ramps[ramps.length - 1].time).toBeCloseTo(30, 6);
  });

  it('never lands exactly on the out point', () => {
    const c1 = play();
    app.seekTo(c1 as never, 1);

    // Dragging to the far right asks for the end of the clip, not for the clip
    // to end — a zero-length playback would stop the cue on the spot.
    expect(sourceOffset()).toBeLessThan(BUFFER_SECONDS);
    expect(state('c1')).toBe('playing');
  });

  it('stores the position of a stopped cue as its resume point', () => {
    const c1 = play();
    app.stopAllAudio(false);
    expect(state('c1')).toBe('idle');

    app.seekTo(c1 as never, 0.25);
    expect(app.progress(c1 as never)).toBeCloseTo(0.25, 6);

    // ...and firing it picks up from there.
    resetSourceNodes();
    app.activeDoc!.activate(c1 as never);
    expect(sourceOffset()).toBeCloseTo(BUFFER_SECONDS / 4, 6);
  });

  it('leaves a cue that is on its way out alone', () => {
    const c1 = play({ fadeOut: 3 });
    app.activeDoc!.activate(c1 as never); // click a playing cue -> fades out
    expect(state('c1')).toBe('fadingOut');
    const source = lastSourceNode()!;

    app.seekTo(c1 as never, 0.5);

    // The fade is landing on silence; moving the audio under it would only make
    // a mess of the last few seconds.
    expect(lastSourceNode()).toBe(source);
    expect(state('c1')).toBe('fadingOut');
  });
});
