// Video cues drive the one global video slot the projector screen shows. These
// tests take the dispatch path a click actually takes, and read the slot back
// the way the screen page does — including reporting a finished clip through the
// bridge, which is the only way the opener ever learns a video ended.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installAudioStubs, makeFakeDir } from '../test-utils/webAudioStub';
import type { ScreenBridge } from '../screen/screen';

installAudioStubs();

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
  volume: 1,
  loop: false,
  onStopBehavior: 'stop',
});

const videoCue = (
  id: string,
  col: number,
  over: Partial<Record<string, unknown>> = {},
) => ({
  id,
  type: 'video',
  row: 1,
  col,
  triggers: [],
  name: id,
  color: '#0ea5e9',
  action: 'play',
  file: 'clip.mp4',
  loop: false,
  volume: 1,
  muted: false,
  fit: 'contain',
  onStopBehavior: 'stop',
  ...over,
});

const showProject = (prefix: string, extra: unknown[]) => ({
  version: 1,
  grid: { rows: 4, cols: 8 },
  masterVolume: 1,
  tabs: [{ id: `tab-${prefix}`, name: prefix, cues: [audioCue(`${prefix}-a`, 0), ...extra] }],
});

const CUE_FILES = {
  'showA.wsp': JSON.stringify(
    showProject('a', [
      videoCue('v-play', 0),
      videoCue('v-play-b', 1, { file: 'other.mp4', loop: true, volume: 0.5, fit: 'cover' }),
      videoCue('v-pause', 2, { action: 'pause', file: '' }),
      videoCue('v-resume', 3, { action: 'resume', file: '' }),
      videoCue('v-clear', 4, { action: 'clear', file: '' }),
      videoCue('v-missing', 5, { file: 'nowhere.mp4' }),
      videoCue('v-hold', 6, { file: 'other.mp4', onStopBehavior: 'pause' }),
      videoCue('v-trim', 7, {
        file: 'other.mp4',
        startTime: 5,
        endTime: 20,
        fadeIn: 1,
        fadeOut: 2,
        fadeOutOnEnd: true,
      }),
    ]),
  ),
  'showB.wsp': JSON.stringify(showProject('b', [videoCue('v-b-play', 0, { file: 'other.mp4' })])),
};

const fakeDir = makeFakeDir({
  cueFiles: CUE_FILES,
  audioFiles: ['track.mp3'],
  videoFiles: ['clip.mp4', 'other.mp4'],
});
(globalThis as Record<string, unknown>).showDirectoryPicker = async () => fakeDir;

let app: typeof import('./project.svelte').app;

beforeAll(async () => {
  ({ app } = await import('./project.svelte'));
  await app.openFolder();
  await app.openCueFile('showA.wsp');
  app.showChooser();
  await app.openCueFile('showB.wsp');
});

const docA = () => app.docs.find((d) => d.currentFileName === 'showA.wsp')!;
const docB = () => app.docs.find((d) => d.currentFileName === 'showB.wsp')!;
const cueIn = (doc: ReturnType<typeof docA>, id: string) => doc.findCue(id)!;
const clipName = () => (app.video.file as unknown as { name: string } | null)?.name ?? null;

/** The bridge the screen page talks back through, as the page reaches it. */
const bridge = () =>
  (globalThis as unknown as { __screenBridge: ScreenBridge }).__screenBridge;

/**
 * Let a video cue's file open. Playing is deliberately asynchronous — clips
 * aren't pre-processed, so the bytes are opened at fire time — and the slot
 * isn't filled until that resolves.
 */
const settle = () => new Promise((r) => setTimeout(r, 0));

async function fire(doc: ReturnType<typeof docA>, id: string) {
  doc.activate(cueIn(doc, id));
  await settle();
}

describe('video cues', () => {
  // Video cues are inert without a screen page attached, so every case that
  // expects one to *do* something needs a stand-in for that page. This is the
  // same subscription a real screen makes.
  let detachScreen: (() => void) | null = null;

  beforeEach(() => {
    // Every slot back to empty: several cases assert that a chain did *not*
    // fire, which only means anything from a known-quiet start.
    detachScreen?.();
    detachScreen = bridge().subscribe(() => {});
    app.clearVideo();
    app.clearTimer();
    app.stopAllAudio(false);
  });

  afterAll(() => detachScreen?.());

  it('puts its clip on the screen, carrying the cue’s playback settings', async () => {
    await fire(docA(), 'v-play-b');

    expect(clipName()).toBe('other.mp4');
    expect(app.video.playing).toBe(true);
    expect(app.video.loop).toBe(true);
    expect(app.video.volume).toBe(0.5);
    expect(app.video.fit).toBe('cover');
    expect(app.videoActive).toBe(true);
  });

  it('carries trim and fade settings into the shared slot', async () => {
    await fire(docA(), 'v-trim');

    expect(app.video.startTime).toBe(5);
    expect(app.video.endTime).toBe(20);
    expect(app.video.fadeIn).toBe(1);
    expect(app.video.fadeOut).toBe(2);
    expect(app.video.fadeOutOnEnd).toBe(true);
  });

  it('defaults trim and fade settings for cues saved before they existed', async () => {
    // v-play carries none of these fields at all, the way an older save would.
    await fire(docA(), 'v-play');

    expect(app.video.startTime).toBe(0);
    expect(app.video.endTime).toBe(null);
    expect(app.video.fadeIn).toBe(0);
    expect(app.video.fadeOut).toBe(0);
    expect(app.video.fadeOutOnEnd).toBe(false);
  });

  it('holds one slot globally: a second clip takes the screen over', async () => {
    await fire(docA(), 'v-play');
    expect(clipName()).toBe('clip.mp4');

    // A different document entirely — there is still only one screen.
    await fire(docB(), 'v-b-play');
    expect(clipName()).toBe('other.mp4');
    expect(app.video.playing).toBe(true);
  });

  describe('clicking a cue whose clip is already up', () => {
    it('clears the screen, the way clicking a playing audio cue stops it', async () => {
      await fire(docA(), 'v-play'); // onStopBehavior: 'stop'
      expect(app.videoActive).toBe(true);

      await fire(docA(), 'v-play');

      expect(app.videoActive).toBe(false);
      expect(app.ownsVideo('v-play')).toBe(false);
    });

    it('holds the frame instead when the cue is set to pause', async () => {
      await fire(docA(), 'v-hold'); // onStopBehavior: 'pause'

      await fire(docA(), 'v-hold');
      // Still on screen — a frozen picture, not a blank one.
      expect(app.videoActive).toBe(true);
      expect(app.video.playing).toBe(false);
      expect(app.ownsVideo('v-hold')).toBe(true);

      await fire(docA(), 'v-hold');
      expect(app.video.playing).toBe(true);
      expect(clipName()).toBe('other.mp4');
    });

    it('restarts from the top once the clip is off the screen', async () => {
      await fire(docA(), 'v-play');
      const first = app.video.generation;
      await fire(docA(), 'v-play'); // clears

      await fire(docA(), 'v-play');

      // Same File, new generation — that's what tells the screen to rebuild its
      // source rather than leave the clip parked on its last frame.
      expect(clipName()).toBe('clip.mp4');
      expect(app.video.generation).toBeGreaterThan(first);
    });

    it('takes the screen from a different cue rather than toggling', async () => {
      await fire(docA(), 'v-play');
      // v-hold doesn't own the slot, so its click plays — it doesn't pause the
      // clip someone else put up.
      await fire(docA(), 'v-hold');

      expect(clipName()).toBe('other.mp4');
      expect(app.video.playing).toBe(true);
      expect(app.ownsVideo('v-hold')).toBe(true);
    });

    it('leaves the control actions absolute', async () => {
      await fire(docA(), 'v-play');
      // "Clear screen" means clear the screen, whoever's clip is on it.
      await fire(docA(), 'v-clear');
      expect(app.videoActive).toBe(false);
      // And firing it again on an empty screen is simply a no-op.
      await fire(docA(), 'v-clear');
      expect(app.videoActive).toBe(false);
    });
  });

  it('pauses and resumes without losing the clip', async () => {
    await fire(docA(), 'v-play');

    await fire(docA(), 'v-pause');
    expect(app.video.playing).toBe(false);
    expect(clipName()).toBe('clip.mp4'); // still on screen, just held

    await fire(docA(), 'v-resume');
    expect(app.video.playing).toBe(true);
  });

  it('clears the screen', async () => {
    await fire(docA(), 'v-play');
    await fire(docA(), 'v-clear');

    expect(app.video.file).toBe(null);
    expect(app.videoActive).toBe(false);
  });

  it('leaves the timer running underneath, to reappear when the clip goes', async () => {
    // Priority is the screen page's business — the slots themselves are
    // independent, and the countdown must not be disturbed by a clip.
    app.setTimer(300);
    await fire(docA(), 'v-play');

    expect(app.timer.running).toBe(true);
    expect(app.videoActive).toBe(true);

    await fire(docA(), 'v-clear');
    expect(app.timer.running).toBe(true);
  });

  it('reports a missing clip instead of blanking the screen', async () => {
    await fire(docA(), 'v-play');
    app.errorMessage = '';

    await fire(docA(), 'v-missing');

    expect(app.errorMessage).toMatch(/no playable file/i);
    expect(clipName()).toBe('clip.mp4'); // the clip that was up stays up
  });

  it('marks a play cue with no resolvable clip as missing', () => {
    expect(docA().display(cueIn(docA(), 'v-missing')).missing).toBe(true);
    expect(docA().display(cueIn(docA(), 'v-play')).missing).toBe(false);
    // Control actions need no file of their own.
    expect(docA().display(cueIn(docA(), 'v-clear')).missing).toBe(false);
  });

  describe('when the clip plays out', () => {
    it('frees the screen and fires the cue’s onEnd triggers', async () => {
      const v = cueIn(docA(), 'v-play') as unknown as { triggers: unknown[] };
      v.triggers = [{ events: ['onEnd'], target: { cueId: 'a-a' }, action: 'start' }];

      await fire(docA(), 'v-play');
      bridge().videoEnded(app.video.generation);

      expect(app.videoActive).toBe(false);
      expect(docA().playStates['a-a']).toBe('playing');

      v.triggers = [];
    });

    it('ignores a report for a clip that has already been replaced', async () => {
      const v = cueIn(docA(), 'v-play') as unknown as { triggers: unknown[] };
      v.triggers = [{ events: ['onEnd'], target: { cueId: 'a-a' }, action: 'start' }];

      await fire(docA(), 'v-play');
      const stale = app.video.generation;
      await fire(docA(), 'v-play-b'); // the first clip is off the screen already

      bridge().videoEnded(stale);

      // The clip now playing is untouched, and the replaced cue's chain must
      // not fire late.
      expect(clipName()).toBe('other.mp4');
      expect(docA().playStates['a-a'] ?? 'idle').toBe('idle');

      v.triggers = [];
    });

    it('fires the onEnd chain of whichever document last claimed the slot', async () => {
      const a = cueIn(docA(), 'v-play') as unknown as { triggers: unknown[] };
      const b = cueIn(docB(), 'v-b-play') as unknown as { triggers: unknown[] };
      a.triggers = [{ events: ['onEnd'], target: { cueId: 'a-a' }, action: 'start' }];
      b.triggers = [{ events: ['onEnd'], target: { cueId: 'b-a' }, action: 'start' }];

      await fire(docA(), 'v-play');
      await fire(docB(), 'v-b-play'); // B takes the screen, and the claim with it
      bridge().videoEnded(app.video.generation);

      expect(docB().playStates['b-a']).toBe('playing');
      expect(docA().playStates['a-a'] ?? 'idle').toBe('idle');

      a.triggers = [];
      b.triggers = [];
    });
  });

  describe('feedback on the operator’s grid', () => {
    const report = (over: Partial<{ position: number; duration: number; playing: boolean }> = {}) =>
      bridge().videoProgress(app.video.generation, {
        position: 0,
        duration: 100,
        playing: true,
        ...over,
      });

    it('lights the tile of the cue holding the screen, and only that one', async () => {
      await fire(docA(), 'v-play');
      report();

      expect(app.ownsVideo('v-play')).toBe(true);
      expect(docA().display(cueIn(docA(), 'v-play')).state).toBe('playing');
      // Every other video cue is idle, including one that played earlier.
      expect(docA().display(cueIn(docA(), 'v-play-b')).state).toBe('idle');

      await fire(docA(), 'v-play-b');
      expect(app.ownsVideo('v-play')).toBe(false);
      expect(docA().display(cueIn(docA(), 'v-play')).state).toBe('idle');
      expect(docA().display(cueIn(docA(), 'v-play-b')).state).toBe('playing');
    });

    it('a held clip still reads as on screen, because it still is', async () => {
      await fire(docA(), 'v-play');
      report({ position: 30, playing: false });

      // Paused audio is silent, so it's idle; a paused clip is a frozen frame
      // in front of an audience, so the tile stays lit.
      expect(docA().display(cueIn(docA(), 'v-play')).state).toBe('playing');
      expect(app.videoStatus.playing).toBe(false);
    });

    it('tracks progress from what the screen reports, not from what we asked for', async () => {
      await fire(docA(), 'v-play');
      expect(app.videoProgressFraction).toBe(0);

      report({ position: 25, duration: 100 });
      expect(app.videoProgressFraction).toBeCloseTo(0.25);

      report({ position: 90, duration: 100 });
      expect(app.videoProgressFraction).toBeCloseTo(0.9);
    });

    it('shows no progress before the screen has reported a length', async () => {
      await fire(docA(), 'v-play');
      report({ position: 10, duration: 0 });
      expect(app.videoProgressFraction).toBe(0);
    });

    it('ignores a report for a clip that is no longer on screen', async () => {
      await fire(docA(), 'v-play');
      const stale = app.video.generation;
      report({ position: 50, duration: 100 });

      await fire(docA(), 'v-play-b');

      // The replaced clip's last frames must not bleed into the new cue's tile.
      expect(app.videoProgressFraction).toBe(0);
      bridge().videoProgress(stale, { position: 80, duration: 100, playing: true });
      expect(app.videoProgressFraction).toBe(0);
    });

    it('resets the readout when a new clip takes the screen', async () => {
      await fire(docA(), 'v-play');
      report({ position: 75, duration: 100 });

      await fire(docA(), 'v-play-b');
      expect(app.videoStatus.position).toBe(0);
      expect(app.videoStatus.duration).toBe(0);
    });
  });

  describe('when the screen window goes away', () => {
    it('empties the slot — nothing is on any screen any more', async () => {
      await fire(docA(), 'v-play');
      bridge().screenClosing();

      expect(app.videoActive).toBe(false);
      expect(app.ownsVideo('v-play')).toBe(false);
    });

    it('does not fire the clip’s onEnd chain: it was cut off, not finished', async () => {
      const v = cueIn(docA(), 'v-play') as unknown as { triggers: unknown[] };
      v.triggers = [{ events: ['onEnd'], target: { cueId: 'a-a' }, action: 'start' }];

      await fire(docA(), 'v-play');
      bridge().screenClosing();

      expect(docA().playStates['a-a'] ?? 'idle').toBe('idle');

      v.triggers = [];
    });
  });

  describe('a screen that attached itself to the bridge', () => {
    // What the opener is left with after a reload: the popup outlives it and
    // re-attaches to the new bridge, so there's a live screen but no window
    // handle to it. A subscription is the only evidence, and it has to count.
    it('counts as a screen, so cues run', () => {
      expect(app.screenLive).toBe(true);
    });

    it('receives the slot state it needs to show', async () => {
      const seen: string[] = [];
      const stop = bridge().subscribe((v) =>
        seen.push((v.video.file as unknown as { name: string } | null)?.name ?? 'blank'),
      );

      await fire(docA(), 'v-play');
      await fire(docA(), 'v-clear');

      expect(seen).toContain('clip.mp4');
      expect(seen.at(-1)).toBe('blank');
      stop();
    });
  });

  describe('with no screen attached', () => {
    /** Run a case with the stand-in screen detached, as if it were closed. */
    async function withoutScreen(fn: () => Promise<void> | void) {
      detachScreen?.();
      detachScreen = null;
      try {
        await fn();
      } finally {
        detachScreen = bridge().subscribe(() => {});
      }
    }

    it('a video cue does nothing at all — no clip, no error bar', async () => {
      await withoutScreen(async () => {
        expect(app.screenLive).toBe(false);
        app.errorMessage = '';

        await fire(docA(), 'v-play');

        // Nothing loaded, and no nagging: the cue simply has nowhere to run.
        expect(app.videoActive).toBe(false);
        expect(app.errorMessage).toBe('');
      });
    });

    it('does not fire its triggers either', async () => {
      const v = cueIn(docA(), 'v-play') as unknown as { triggers: unknown[] };
      v.triggers = [{ events: ['onStart'], target: { cueId: 'a-a' }, action: 'start' }];

      await withoutScreen(async () => {
        await fire(docA(), 'v-play');
        // Chaining music off a clip that never plays would put the show out of
        // step with what the audience sees.
        expect(docA().playStates['a-a'] ?? 'idle').toBe('idle');
      });

      v.triggers = [];
    });

    it('marks video tiles unavailable, saying why', async () => {
      await withoutScreen(() => {
        const info = docA().display(cueIn(docA(), 'v-play'));
        expect(info.unavailable).toMatch(/no screen/i);
        // Not the same as broken: the cue itself is fine.
        expect(info.missing).toBe(false);
      });
    });

    it('leaves the tiles available again once a screen attaches', () => {
      expect(docA().display(cueIn(docA(), 'v-play')).unavailable).toBe(null);
    });

    it('leaves audio cues alone — they need no screen', async () => {
      await withoutScreen(() => {
        docA().activate(cueIn(docA(), 'a-a'));
        expect(docA().playStates['a-a']).toBe('playing');
        expect(docA().display(cueIn(docA(), 'a-a')).unavailable).toBeFalsy();
      });
    });
  });

  it('fires its own onStart triggers when run, without waiting on the file', () => {
    // The clip opens asynchronously; a chain that rolls music under the video
    // must not stall on disk waiting for it.
    const v = cueIn(docA(), 'v-play') as unknown as { triggers: unknown[] };
    v.triggers = [{ events: ['onStart'], target: { cueId: 'a-a' }, action: 'start' }];

    docA().activate(cueIn(docA(), 'v-play')); // deliberately not awaited

    expect(docA().playStates['a-a']).toBe('playing');
    expect(app.videoActive).toBe(false); // the clip itself is still opening

    v.triggers = [];
  });
});
