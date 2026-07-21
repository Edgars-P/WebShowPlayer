// Timer cues drive the one global countdown the projector screen shows. These
// tests take the dispatch path a click actually takes, then read back the two
// things the operator's tile is painted from: which cue holds the clock, and how
// far through it is — including dragging that playhead, which is the only way
// the countdown ever moves other than by elapsing.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAudioStubs, makeFakeDir } from '../test-utils/webAudioStub';

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

const timerCue = (id: string, col: number, over: Record<string, unknown> = {}) => ({
  id,
  type: 'timer',
  row: 1,
  col,
  triggers: [],
  name: id,
  color: '#8b5cf6',
  action: 'set',
  duration: 300,
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
      timerCue('t-set', 0),
      timerCue('t-set-short', 1, { duration: 60 }),
      timerCue('t-pause', 2, { action: 'pause' }),
      timerCue('t-resume', 3, { action: 'resume' }),
      timerCue('t-clear', 4, { action: 'clear' }),
    ]),
  ),
  'showB.wsp': JSON.stringify(showProject('b', [timerCue('t-b-set', 0, { duration: 120 })])),
};

const fakeDir = makeFakeDir({
  cueFiles: CUE_FILES,
  audioFiles: ['track.mp3'],
  videoFiles: [],
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
const fire = (doc: ReturnType<typeof docA>, id: string) => doc.activate(cueIn(doc, id));
const stateOf = (doc: ReturnType<typeof docA>, id: string) => doc.display(cueIn(doc, id)).state;

describe('timer cues', () => {
  beforeEach(() => {
    // Both the clock the app counts against and the interval it counts on, so a
    // case can spend time deliberately rather than waiting for it.
    vi.useFakeTimers();
    app.clearTimer();
  });

  afterAll(() => vi.useRealTimers());

  /** Let `seconds` of show time pass, ticks included. */
  const elapse = (seconds: number) => vi.advanceTimersByTime(seconds * 1000);

  describe('the tile of the cue holding the clock', () => {
    it('lights while its countdown runs, and only that one', () => {
      fire(docA(), 't-set');

      expect(app.ownsTimer('t-set')).toBe(true);
      expect(stateOf(docA(), 't-set')).toBe('playing');
      expect(stateOf(docA(), 't-set-short')).toBe('idle');
    });

    it('leaves the control actions dark: none of them owns the time', () => {
      fire(docA(), 't-set');
      fire(docA(), 't-pause');

      expect(stateOf(docA(), 't-pause')).toBe('idle');
      expect(stateOf(docA(), 't-resume')).toBe('idle');
      expect(stateOf(docA(), 't-clear')).toBe('idle');
      // A held clock is still a countdown in front of the audience.
      expect(stateOf(docA(), 't-set')).toBe('playing');
    });

    it('goes out when the countdown is cleared', () => {
      fire(docA(), 't-set');
      fire(docA(), 't-clear');

      expect(app.ownsTimer('t-set')).toBe(false);
      expect(stateOf(docA(), 't-set')).toBe('idle');
    });

    it('goes out when the countdown reaches zero', () => {
      fire(docA(), 't-set-short'); // 60s
      elapse(61);

      expect(app.timer.finished).toBe(true);
      expect(stateOf(docA(), 't-set-short')).toBe('idle');
    });

    it('follows the clock across documents, one holder at a time', () => {
      fire(docA(), 't-set');
      fire(docB(), 't-b-set');

      expect(stateOf(docA(), 't-set')).toBe('idle');
      expect(stateOf(docB(), 't-b-set')).toBe('playing');
      expect(app.timer.duration).toBe(120);
    });
  });

  describe('progress', () => {
    it('counts time spent, so the bar fills as the clock empties', () => {
      fire(docA(), 't-set-short'); // 60s
      expect(app.timerProgressFraction).toBe(0);

      elapse(15);
      expect(app.timerProgressFraction).toBeCloseTo(0.25, 2);

      elapse(30);
      expect(app.timerProgressFraction).toBeCloseTo(0.75, 2);
    });

    it('is nothing at all with no countdown set', () => {
      expect(app.timerProgressFraction).toBe(0);
    });
  });

  describe('scrubbing', () => {
    it('moves the playhead within the countdown, keeping its length', () => {
      fire(docA(), 't-set-short'); // 60s

      app.seekTimer(0.25);

      expect(app.timer.remaining).toBeCloseTo(45, 1);
      // The cue was set for a minute; dragging the bar moves through it rather
      // than redefining it.
      expect(app.timer.duration).toBe(60);
      expect(app.timerProgressFraction).toBeCloseTo(0.25, 2);
    });

    it('carries on from where it was dropped', () => {
      fire(docA(), 't-set-short');
      app.seekTimer(0.5);

      elapse(10);

      expect(app.timer.remaining).toBeCloseTo(20, 1);
    });

    it('holds the new position while paused, and resumes from it', () => {
      fire(docA(), 't-set-short');
      fire(docA(), 't-pause');

      app.seekTimer(0.9);
      elapse(10); // a paused clock spends nothing

      expect(app.timer.remaining).toBeCloseTo(6, 1);

      fire(docA(), 't-resume');
      elapse(5);
      expect(app.timer.remaining).toBeCloseTo(1, 1);
    });

    it('stays inside the countdown however far the pointer goes', () => {
      fire(docA(), 't-set-short');

      app.seekTimer(-2);
      expect(app.timer.remaining).toBeCloseTo(60, 1);

      app.seekTimer(3);
      expect(app.timer.remaining).toBe(0);
    });

    it('run to the end, it finishes the way it would have on its own', () => {
      const t = cueIn(docA(), 't-set-short') as unknown as { triggers: unknown[] };
      t.triggers = [{ events: ['onStop'], target: { cueId: 'a-a' }, action: 'start' }];

      fire(docA(), 't-set-short');
      app.seekTimer(1);
      elapse(1); // the next tick is what notices

      expect(app.timer.finished).toBe(true);
      expect(docA().playStates['a-a']).toBe('playing');

      t.triggers = [];
      docA().applyToAllAudio('stop', false);
    });

    it('does nothing with no countdown to scrub', () => {
      app.seekTimer(0.5);
      expect(app.timer.remaining).toBe(0);
      expect(app.timer.duration).toBe(0);
    });
  });
});
