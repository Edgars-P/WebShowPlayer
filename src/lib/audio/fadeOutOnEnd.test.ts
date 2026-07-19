// "Fade out at end" schedules a gain ramp that lands exactly on the cue's out
// point, so a clip bows out instead of cutting. These tests read the automation
// the engine schedules on the gain node, which is where the behaviour actually
// lives — the audible result is a ramp on the audio clock, not anything the
// playback state machine can show.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installAudioStubs, lastGainNode, makeFakeDir, resetGainNodes } from '../test-utils/webAudioStub';

installAudioStubs();

/** The engine's near-silence floor; ramps target this rather than a true zero. */
const MIN_GAIN = 0.0001;
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

interface Tweaks {
  fadeOut?: number;
  fadeOutOnEnd?: boolean;
  fadeIn?: number;
  startTime?: number;
  endTime?: number | null;
  loop?: boolean;
}

/** Configure the one audio cue and fire it; returns its gain automation. */
function play(tweaks: Tweaks) {
  const doc = app.activeDoc!;
  const cue = doc.findCue('c1') as unknown as Record<string, unknown>;
  Object.assign(cue, { fadeIn: 0, fadeOut: 0, fadeOutOnEnd: false, startTime: 0, endTime: null, loop: false }, tweaks);
  resetGainNodes();
  doc.activate(cue as never);
  return lastGainNode()!.events;
}

function stopAll() {
  app.stopAllAudio(false);
}

const ramps = (events: ReturnType<typeof play>) => events.filter((e) => e.kind === 'ramp');
/** The ramp down to silence, if one was scheduled. */
const fadeDown = (events: ReturnType<typeof play>) =>
  ramps(events).find((e) => e.value <= MIN_GAIN);

describe('fade out at end', () => {
  beforeEach(() => stopAll());

  it('schedules no fade when the option is off', () => {
    const events = play({ fadeOut: 3, fadeOutOnEnd: false });
    expect(fadeDown(events)).toBeUndefined();
    // Just the one gain set at start.
    expect(events).toEqual([{ kind: 'set', value: 1, time: 0 }]);
  });

  it('ramps to silence landing exactly on the end of the file', () => {
    const events = play({ fadeOut: 3, fadeOutOnEnd: true });
    const down = fadeDown(events)!;

    expect(down).toBeDefined();
    // Lands on the out point, not before or after it.
    expect(down.time).toBeCloseTo(BUFFER_SECONDS, 6);
    // ...having held full level until the fade begins.
    expect(events).toContainEqual({ kind: 'set', value: 1, time: BUFFER_SECONDS - 3 });
  });

  it('lands on a custom end time rather than the end of the file', () => {
    const events = play({ fadeOut: 2, fadeOutOnEnd: true, endTime: 10 });
    const down = fadeDown(events)!;

    expect(down.time).toBeCloseTo(10, 6);
    expect(events).toContainEqual({ kind: 'set', value: 1, time: 8 });
  });

  it('measures the fade from the start time, not the head of the file', () => {
    const events = play({ fadeOut: 4, fadeOutOnEnd: true, startTime: 20, endTime: 30 });
    const down = fadeDown(events)!;

    // Plays 20s -> 30s, so 10s of audio: fade runs from 6s to 10s after the hit.
    expect(down.time).toBeCloseTo(10, 6);
    expect(events).toContainEqual({ kind: 'set', value: 1, time: 6 });
  });

  it('never fades longer than the audio that is left', () => {
    // Only 1s of audio, but a 3s fade configured — fade over the 1s available
    // rather than starting before the cue does.
    const events = play({ fadeOut: 3, fadeOutOnEnd: true, startTime: 59 });
    const down = fadeDown(events)!;

    expect(down.time).toBeCloseTo(1, 6);
    const set = events.find((e) => e.kind === 'set' && e.value === 1)!;
    expect(set.time).toBeGreaterThanOrEqual(0);
  });

  it('waits for the fade-in to finish before fading out again', () => {
    // 2s in, 3s out, but only 4s of audio — the two would otherwise overlap.
    const events = play({ fadeIn: 2, fadeOut: 3, fadeOutOnEnd: true, endTime: 4 });
    const up = ramps(events).find((e) => e.value > MIN_GAIN)!;
    const down = fadeDown(events)!;

    expect(up.time).toBeCloseTo(2, 6); // fade-in completes
    expect(down.time).toBeCloseTo(4, 6); // fade-out still lands on the out point
    const holdAt = events.find((e) => e.kind === 'set' && e.value === 1 && e.time > 0)!;
    expect(holdAt.time).toBeGreaterThanOrEqual(2); // fade-out starts after fade-in
  });

  it('does nothing for a looping cue, which has no end to reach', () => {
    const events = play({ fadeOut: 3, fadeOutOnEnd: true, loop: true });
    expect(fadeDown(events)).toBeUndefined();
  });

  it('does nothing when no fade-out time is set', () => {
    const events = play({ fadeOut: 0, fadeOutOnEnd: true });
    expect(fadeDown(events)).toBeUndefined();
  });

  it('clamps an end time that runs past the file', () => {
    // endTime beyond the buffer would otherwise schedule the fade after the
    // audio has already run out, so it would never be heard.
    const events = play({ fadeOut: 5, fadeOutOnEnd: true, endTime: 999 });
    const down = fadeDown(events)!;

    expect(down.time).toBeCloseTo(BUFFER_SECONDS, 6);
    expect(events).toContainEqual({ kind: 'set', value: 1, time: BUFFER_SECONDS - 5 });
  });

  it('still honours the volume trim while fading', () => {
    const doc = app.activeDoc!;
    (doc.findCue('c1') as unknown as { volume: number }).volume = 0.5;
    const events = play({ fadeOut: 3, fadeOutOnEnd: true });

    // Holds at the trimmed level, then falls from there.
    expect(events).toContainEqual({ kind: 'set', value: 0.5, time: BUFFER_SECONDS - 3 });
    (doc.findCue('c1') as unknown as { volume: number }).volume = 1;
  });

  describe('clicking mid-fade finishes the fade', () => {
    it('snaps a fading-in cue up to full level and keeps it playing', () => {
      const doc = app.activeDoc!;
      const events = play({ fadeIn: 10 });
      expect(doc.playStates['c1']).toBe('fadingIn');

      doc.activate(doc.findCue('c1') as never);

      expect(doc.playStates['c1']).toBe('playing'); // still playing, not stopped
      // Automation cancelled, then pinned at full level immediately.
      const cancel = events.findIndex((e) => e.kind === 'cancel');
      expect(cancel).toBeGreaterThan(-1);
      expect(events[cancel + 1]).toEqual({ kind: 'set', value: 1, time: 0 });
    });

    it('re-lays the end fade that cancelling the fade-in wiped out', () => {
      const doc = app.activeDoc!;
      const events = play({ fadeIn: 10, fadeOut: 4, fadeOutOnEnd: true });
      doc.activate(doc.findCue('c1') as never);

      // The end-of-clip fade must survive the cancel, still landing on the out
      // point — otherwise finishing a fade-in silently drops it.
      const after = events.slice(events.findIndex((e) => e.kind === 'cancel'));
      const down = after.find((e) => e.kind === 'ramp' && e.value <= MIN_GAIN)!;
      expect(down).toBeDefined();
      expect(down.time).toBeCloseTo(BUFFER_SECONDS, 6);
    });

    it('cuts a fading-out cue to silence immediately', () => {
      const doc = app.activeDoc!;
      play({ fadeOut: 10 });
      doc.activate(doc.findCue('c1') as never); // start the fade-out
      expect(doc.playStates['c1']).toBe('fadingOut');

      doc.activate(doc.findCue('c1') as never); // and finish it
      expect(doc.playStates['c1']).toBe('idle');
    });

    it('cuts short a cue drifting out on its own end fade', async () => {
      const doc = app.activeDoc!;
      // Only 2s of audio left against a 4s fade, so the end fade begins at once
      // — but the tile only flips to fadingOut when the engine's timer fires,
      // so wait for it rather than assuming.
      play({ fadeOut: 4, fadeOutOnEnd: true, startTime: BUFFER_SECONDS - 2 });
      await new Promise((r) => setTimeout(r, 0));
      expect(doc.playStates['c1']).toBe('fadingOut');

      // This cue is drifting out on its own, not from a deliberate stop, so the
      // click routes through a normal instant stop rather than just finalizing.
      doc.activate(doc.findCue('c1') as never);
      expect(doc.playStates['c1']).toBe('idle');
    });

    it('a normal playing cue still just stops', () => {
      const doc = app.activeDoc!;
      play({ fadeIn: 0, fadeOut: 0 });
      expect(doc.playStates['c1']).toBe('playing');

      doc.activate(doc.findCue('c1') as never);
      expect(doc.playStates['c1']).toBe('idle');
    });
  });

  describe('fade progress readout', () => {
    // Drives the bar under the fading-in/out label, so it has to reflect the
    // real fade window rather than a guess.
    const progress = () => app.activeDoc!.fadeProgress(app.activeDoc!.findCue('c1') as never);

    it('is 1 for a cue playing at full level', () => {
      play({ fadeIn: 0 });
      expect(progress()).toBe(1);
    });

    it('starts at 0 when a fade-in begins', () => {
      play({ fadeIn: 8 });
      // The stub clock sits at 0, so this is the very start of the fade.
      expect(progress()).toBe(0);
    });

    it('starts at 0 when a fade-out begins', () => {
      const doc = app.activeDoc!;
      play({ fadeOut: 6 });
      doc.activate(doc.findCue('c1') as never);
      expect(doc.playStates['c1']).toBe('fadingOut');
      expect(progress()).toBe(0);
    });

    it('reports complete once a fade-in is finished early by a click', () => {
      const doc = app.activeDoc!;
      play({ fadeIn: 8 });
      doc.activate(doc.findCue('c1') as never);

      // Snapped to full level, so there is no fade left to show.
      expect(doc.playStates['c1']).toBe('playing');
      expect(progress()).toBe(1);
    });

    it('tracks the scheduled end fade once it takes over', async () => {
      const doc = app.activeDoc!;
      // 2s of audio against a 4s fade: the end fade starts immediately.
      play({ fadeOut: 4, fadeOutOnEnd: true, startTime: BUFFER_SECONDS - 2 });
      await new Promise((r) => setTimeout(r, 0));

      expect(doc.playStates['c1']).toBe('fadingOut');
      expect(progress()).toBe(0); // at the top of the 2s fade window
    });

    it('is 1 for a cue that is not playing at all', () => {
      app.stopAllAudio(false);
      expect(progress()).toBe(1);
    });
  });

  it('an explicit stop cancels the scheduled end fade', () => {
    const doc = app.activeDoc!;
    const events = play({ fadeOut: 3, fadeOutOnEnd: true });
    expect(fadeDown(events)).toBeDefined();

    doc.activate(doc.findCue('c1') as never); // toggle off
    // stop() cancels pending automation before scheduling its own fade, so the
    // end-of-clip ramp can't fight the stop.
    expect(events.some((e) => e.kind === 'cancel')).toBe(true);
  });
});
