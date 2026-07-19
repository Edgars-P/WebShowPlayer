// Hovering a cue marks up every tile its triggers drive, each carrying what
// would happen and when. All of the cue's triggers are shown, not just the
// imminent one; `now` distinguishes the ones this click fires from the ones
// that fire later in the cue's life.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installAudioStubs, makeFakeDir } from '../test-utils/webAudioStub';

installAudioStubs();

const audioCue = (id: string, col: number, triggers: unknown[] = []) => ({
  id,
  type: 'audio',
  row: 0,
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

const CUE_FILES = {
  'show.wsp': JSON.stringify({
    version: 1,
    grid: { rows: 3, cols: 6 },
    masterVolume: 1,
    tabs: [
      {
        id: 'tab-1',
        name: 'A',
        cues: [
          // Starting `lead` starts `bed`; when `lead` ends, it stops `bed`.
          audioCue('lead', 0, [
            { event: 'onStart', target: { cueId: 'bed' }, action: 'start' },
            { event: 'onEnd', target: { cueId: 'bed' }, action: 'stop' },
          ]),
          audioCue('bed', 1),
          audioCue('lonely', 2),
          // Ducks the bed while it plays and lets it back up on stop — so it
          // has a trigger on the event a click fires in *both* directions.
          audioCue('ducker', 5, [
            { event: 'onStart', target: { cueId: 'bed' }, action: 'pause' },
            { event: 'onStop', target: { cueId: 'bed' }, action: 'resume' },
          ]),
          {
            id: 'ducker-proxy',
            type: 'proxy',
            row: 1,
            col: 2,
            triggers: [],
            source: { cueId: 'ducker' },
          },
          // A proxy for `bed`, and a cue that triggers that proxy.
          { id: 'bed-proxy', type: 'proxy', row: 1, col: 0, triggers: [], source: { cueId: 'bed' } },
          audioCue('via-proxy', 3, [
            { event: 'onStart', target: { cueId: 'bed-proxy' }, action: 'pause' },
          ]),
          // A proxy for `lead` — hovering it should preview lead's chain.
          { id: 'lead-proxy', type: 'proxy', row: 1, col: 1, triggers: [], source: { cueId: 'lead' } },
          // A dangling trigger, pointing at a cue that no longer exists.
          audioCue('broken', 4, [
            { event: 'onStart', target: { cueId: 'deleted-cue' }, action: 'start' },
          ]),
        ],
      },
    ],
  }),
};

const fakeDir = makeFakeDir({ cueFiles: CUE_FILES, audioFiles: ['track.mp3'] });
(globalThis as Record<string, unknown>).showDirectoryPicker = async () => fakeDir;

let app: typeof import('./project.svelte').app;

beforeAll(async () => {
  ({ app } = await import('./project.svelte'));
  await app.openFolder();
});

/** What hovering `id` would mark up, as a plain object keyed by target. */
const preview = (id: string | null) =>
  Object.fromEntries(app.activeDoc!.previewTargets(id));

/** Just the target ids and whether each is imminent — for terser assertions. */
const timing = (id: string | null) =>
  Object.fromEntries(
    [...app.activeDoc!.previewTargets(id)].map(([target, hints]) => [
      target,
      hints.map((h) => (h.now ? 'now' : 'later')),
    ]),
  );

describe('trigger preview', () => {
  beforeEach(() => app.stopAllAudio(false));

  it('highlights nothing when nothing is hovered', () => {
    expect(preview(null)).toEqual({});
    expect(app.previewTargets.size).toBe(0);
  });

  it('marks up every cue the hovered one drives, not just the imminent ones', () => {
    // `lead` starts `bed` on start and stops it on end — one target, two hints.
    expect(preview('lead')).toEqual({
      bed: [
        { event: 'onStart', action: 'start', now: true },
        { event: 'onEnd', action: 'stop', now: false },
      ],
    });
  });

  it('flags which hints this click would fire', () => {
    // Idle: the onStart hint is live, the onEnd one is for later.
    expect(timing('lead')).toEqual({ bed: ['now', 'later'] });
  });

  it('re-flags the timing once the cue is playing', () => {
    const doc = app.activeDoc!;
    doc.activate(doc.findCue('ducker') as never);
    expect(doc.playStates['ducker']).toBe('playing');

    // Clicking now stops it, so the onStop hint becomes the live one.
    expect(preview('ducker')).toEqual({
      bed: [
        { event: 'onStop', action: 'resume', now: true },
        { event: 'onStart', action: 'pause', now: false },
      ],
    });
  });

  it('still shows an end-only cue’s reach while playing, greyed', () => {
    // `lead` acts on its own end; clicking stops it, so nothing is imminent —
    // but the tile it drives is still marked up, just as a later-on target.
    const doc = app.activeDoc!;
    doc.activate(doc.findCue('lead') as never);

    expect(timing('lead')).toEqual({ bed: ['later', 'later'] });
  });

  it('sorts imminent hints first', () => {
    const hints = app.activeDoc!.previewTargets('lead').get('bed')!;
    expect(hints[0].now).toBe(true);
  });

  it('switches back when the cue stops again', () => {
    const doc = app.activeDoc!;
    doc.activate(doc.findCue('lead') as never);
    doc.activate(doc.findCue('lead') as never);
    expect(doc.playStates['lead']).toBe('idle');

    expect(timing('lead')).toEqual({ bed: ['now', 'later'] });
  });

  it('highlights nothing for a cue with no triggers', () => {
    expect(preview('lonely')).toEqual({});
  });

  it('ignores triggers pointing at cues that no longer exist', () => {
    expect(preview('broken')).toEqual({});
  });

  it('marks up both a targeted proxy and what it controls', () => {
    // The chain is visible end to end: the proxy tile and the real cue behind it.
    expect(timing('via-proxy')).toEqual({ 'bed-proxy': ['now'], bed: ['now'] });
  });

  it('previews the source’s chain when hovering a proxy', () => {
    // Clicking a proxy acts on its source, so the source's triggers are what fire.
    expect(preview('lead-proxy')).toEqual(preview('lead'));
  });

  it('follows the proxy’s source for the playing/idle decision too', () => {
    const doc = app.activeDoc!;
    expect(timing('ducker-proxy')).toEqual({ bed: ['now', 'later'] });

    doc.activate(doc.findCue('ducker') as never); // started via the real cue
    const hints = doc.previewTargets('ducker-proxy').get('bed')!;
    expect(hints.find((h) => h.now)?.event).toBe('onStop');
  });

  it('exposes the hovered cue’s preview through the app', () => {
    app.hoveredCueId = 'lead';
    expect([...app.previewTargets.keys()]).toEqual(['bed']);
    expect(app.previewTargets.get('bed')!.map((h) => h.now)).toEqual([true, false]);

    app.hoveredCueId = null;
    expect(app.previewTargets.size).toBe(0);
  });

  it('returns an empty preview for an unknown id', () => {
    expect(preview('no-such-cue')).toEqual({});
  });
});

describe('what "this click" means', () => {
  beforeEach(() => app.stopAllAudio(false));

  const imminent = (id: string) => {
    const doc = app.activeDoc!;
    return doc.imminentEvent(doc.findCue(id)!);
  };

  it('is onStart while idle', () => {
    expect(imminent('lead')).toBe('onStart');
  });

  it('is onStop while playing', () => {
    const doc = app.activeDoc!;
    doc.activate(doc.findCue('lead') as never);
    expect(imminent('lead')).toBe('onStop');
  });

  it('is onPause for a playing cue that keeps its position', () => {
    const doc = app.activeDoc!;
    const cue = doc.findCue('lead') as unknown as { onStopBehavior: string };
    cue.onStopBehavior = 'pause';
    doc.activate(doc.findCue('lead') as never);

    expect(imminent('lead')).toBe('onPause');

    cue.onStopBehavior = 'stop';
  });

  it('is always onStart for cues that only ever run', () => {
    // Timer, http and global cues fire onStart whenever they're triggered.
    const doc = app.activeDoc!;
    const id = doc.addNewCue('global', 2, 0)!;
    expect(doc.imminentEvent(doc.findCue(id)!)).toBe('onStart');
    doc.removeCue(id);
  });
});
