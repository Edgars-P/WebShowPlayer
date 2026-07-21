// Global cues apply one action to every audio cue at once. These tests drive
// real playback through the stubbed Web Audio graph and assert on the resulting
// playback states, so they cover the dispatch path a click actually takes.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installAudioStubs, makeFakeDir } from '../test-utils/webAudioStub';

installAudioStubs();

const audioCue = (id: string, col: number, fadeOut = 0) => ({
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
  fadeOut,
  volume: 1,
  loop: false,
  onStopBehavior: 'stop',
});

const globalCue = (id: string, action: string, fade: boolean, scope: string, col: number) => ({
  id,
  type: 'global',
  row: 1,
  col,
  triggers: [],
  name: id,
  color: '#ef4444',
  action,
  fade,
  scope,
});

const showProject = (prefix: string, extra: unknown[] = []) => ({
  version: 1,
  grid: { rows: 4, cols: 8 },
  masterVolume: 1,
  tabs: [
    {
      id: `tab-${prefix}`,
      name: prefix,
      // Two audio cues in the first tab...
      cues: [audioCue(`${prefix}-a`, 0), audioCue(`${prefix}-b`, 1), ...extra],
    },
    // ...and one in a second tab, so "everything" must cross cue tabs too.
    { id: `tab-${prefix}-2`, name: `${prefix}2`, cues: [audioCue(`${prefix}-c`, 0)] },
  ],
});

const CUE_FILES = {
  'showA.wsp': JSON.stringify(
    showProject('a', [
      globalCue('g-stop', 'stop', false, 'document', 2),
      globalCue('g-stop-fade', 'stop', true, 'document', 3),
      globalCue('g-pause', 'pause', false, 'document', 4),
      globalCue('g-resume', 'resume', false, 'document', 5),
      globalCue('g-stop-all-docs', 'stop', false, 'all', 6),
    ]),
  ),
  'showB.wsp': JSON.stringify(showProject('b')),
};

const fakeDir = makeFakeDir({ cueFiles: CUE_FILES, audioFiles: ['track.mp3'] });
(globalThis as Record<string, unknown>).showDirectoryPicker = async () => fakeDir;

let app: typeof import('./project.svelte').app;

beforeAll(async () => {
  ({ app } = await import('./project.svelte'));
  await app.openFolder(); // two cue files -> chooser
  await app.openCueFile('showA.wsp');
  app.showChooser();
  await app.openCueFile('showB.wsp');
});

const docA = () => app.docs.find((d) => d.currentFileName === 'showA.wsp')!;
const docB = () => app.docs.find((d) => d.currentFileName === 'showB.wsp')!;

const cueIn = (doc: ReturnType<typeof docA>, id: string) => doc.findCue(id)!;
const stateOf = (doc: ReturnType<typeof docA>, id: string) => doc.playStates[id] ?? 'idle';

/**
 * Start every audio cue in both documents, optionally leaving some idle.
 *
 * `activate` is a toggle, so a cue that's already playing would be *stopped* by
 * a second call — anything meant to be fired later in a test must be excluded
 * here, not started and re-clicked.
 */
function startEverything(except: string[] = []) {
  for (const doc of app.docs) {
    for (const tab of doc.project.tabs) {
      for (const cue of tab.cues) {
        if (cue.type === 'audio' && !except.includes(cue.id)) doc.activate(cue);
      }
    }
  }
}

describe('global cues', () => {
  beforeEach(() => {
    // Reset to silence between cases.
    app.stopAllAudio(false);
  });

  it('starts from a known state: everything can be playing at once', () => {
    startEverything();
    expect(stateOf(docA(), 'a-a')).toBe('playing');
    expect(stateOf(docA(), 'a-b')).toBe('playing');
    expect(stateOf(docA(), 'a-c')).toBe('playing'); // second cue tab
    expect(stateOf(docB(), 'b-a')).toBe('playing');
  });

  it('stops everything in its own document, across cue tabs', () => {
    startEverything();
    app.selectDoc(docA().id);
    docA().activate(cueIn(docA(), 'g-stop'));

    expect(stateOf(docA(), 'a-a')).toBe('idle');
    expect(stateOf(docA(), 'a-b')).toBe('idle');
    expect(stateOf(docA(), 'a-c')).toBe('idle');
  });

  it('leaves other documents alone when scoped to this cue file', () => {
    startEverything();
    docA().activate(cueIn(docA(), 'g-stop'));

    expect(stateOf(docA(), 'a-a')).toBe('idle');
    // showB is a different show — untouched.
    expect(stateOf(docB(), 'b-a')).toBe('playing');
    expect(stateOf(docB(), 'b-c')).toBe('playing');
  });

  it('reaches every open document when scoped to all', () => {
    startEverything();
    docA().activate(cueIn(docA(), 'g-stop-all-docs'));

    expect(stateOf(docA(), 'a-a')).toBe('idle');
    expect(stateOf(docB(), 'b-a')).toBe('idle');
    expect(stateOf(docB(), 'b-c')).toBe('idle');
  });

  it('fades out rather than cutting when fade is on', () => {
    // Give the cues a fade-out time so the fade is observable.
    for (const id of ['a-a', 'a-b']) {
      (cueIn(docA(), id) as unknown as { fadeOut: number }).fadeOut = 2;
    }
    startEverything();
    docA().activate(cueIn(docA(), 'g-stop-fade'));

    // Still winding down, not yet idle.
    expect(stateOf(docA(), 'a-a')).toBe('fadingOut');
    expect(stateOf(docA(), 'a-b')).toBe('fadingOut');

    for (const id of ['a-a', 'a-b']) {
      (cueIn(docA(), id) as unknown as { fadeOut: number }).fadeOut = 0;
    }
  });

  it('cuts instantly when fade is off, even for cues with a long fade', () => {
    (cueIn(docA(), 'a-a') as unknown as { fadeOut: number }).fadeOut = 5;
    startEverything();
    docA().activate(cueIn(docA(), 'g-stop'));

    expect(stateOf(docA(), 'a-a')).toBe('idle');
    (cueIn(docA(), 'a-a') as unknown as { fadeOut: number }).fadeOut = 0;
  });

  it('pauses everything, and resume-all brings it back', () => {
    startEverything();
    docA().activate(cueIn(docA(), 'g-pause'));
    expect(stateOf(docA(), 'a-a')).toBe('idle');
    expect(stateOf(docA(), 'a-b')).toBe('idle');

    docA().activate(cueIn(docA(), 'g-resume'));
    expect(stateOf(docA(), 'a-a')).toBe('playing');
    expect(stateOf(docA(), 'a-b')).toBe('playing');
  });

  it('resume-all does nothing for cues that were stopped, not paused', () => {
    startEverything();
    docA().activate(cueIn(docA(), 'g-stop')); // stop discards position
    docA().activate(cueIn(docA(), 'g-resume'));

    expect(stateOf(docA(), 'a-a')).toBe('idle');
  });

  it('is safe to fire when nothing is playing', () => {
    expect(() => docA().activate(cueIn(docA(), 'g-stop'))).not.toThrow();
    expect(() => docA().activate(cueIn(docA(), 'g-resume'))).not.toThrow();
    expect(stateOf(docA(), 'a-a')).toBe('idle');
  });

  describe('the toolbar panic buttons', () => {
    it('stop all silences every document immediately', () => {
      startEverything();
      app.stopAllAudio(false);

      for (const doc of app.docs) {
        for (const tab of doc.project.tabs) {
          for (const cue of tab.cues) {
            if (cue.type === 'audio') expect(stateOf(doc, cue.id)).toBe('idle');
          }
        }
      }
      expect(app.anyPlaying).toBe(false);
    });

    it('fade out all winds everything down using each cue’s own fade', () => {
      (cueIn(docA(), 'a-a') as unknown as { fadeOut: number }).fadeOut = 2;
      (cueIn(docB(), 'b-a') as unknown as { fadeOut: number }).fadeOut = 2;
      startEverything();

      app.stopAllAudio(true);

      expect(stateOf(docA(), 'a-a')).toBe('fadingOut');
      expect(stateOf(docB(), 'b-a')).toBe('fadingOut');
      // A cue with no fade configured still stops at once.
      expect(stateOf(docA(), 'a-b')).toBe('idle');

      (cueIn(docA(), 'a-a') as unknown as { fadeOut: number }).fadeOut = 0;
      (cueIn(docB(), 'b-a') as unknown as { fadeOut: number }).fadeOut = 0;
    });

    it('anyPlaying tracks whether anything is sounding', () => {
      expect(app.anyPlaying).toBe(false);
      startEverything();
      expect(app.anyPlaying).toBe(true);
      app.stopAllAudio(false);
      expect(app.anyPlaying).toBe(false);
    });
  });

  it('fires its own onStart triggers when run', () => {
    // Chain: the global stop cue also starts a specific cue afterwards.
    const g = cueIn(docA(), 'g-stop') as unknown as { triggers: unknown[] };
    g.triggers = [{ events: ['onStart'], target: { cueId: 'a-c' }, action: 'start' }];

    startEverything();
    docA().activate(cueIn(docA(), 'g-stop'));

    // Everything was stopped, then a-c was started again by the trigger.
    expect(stateOf(docA(), 'a-a')).toBe('idle');
    expect(stateOf(docA(), 'a-c')).toBe('playing');

    g.triggers = [];
  });

  describe('the cue that set the chain off keeps playing', () => {
    // The "jingle" pattern: a cue whose onStart clicks "stop all", so hitting it
    // ducks the whole show and the jingle itself plays over the top.
    it('exempts a jingle whose onStart clicks stop-all', () => {
      const jingle = cueIn(docA(), 'a-a') as unknown as { triggers: unknown[] };
      jingle.triggers = [{ events: ['onStart'], target: { cueId: 'g-stop' }, action: 'click' }];

      // The show is playing and the jingle is idle, ready to be fired.
      startEverything(['a-a']);
      expect(stateOf(docA(), 'a-a')).toBe('idle');

      docA().activate(cueIn(docA(), 'a-a'));

      expect(stateOf(docA(), 'a-a')).toBe('playing'); // the jingle survives
      expect(stateOf(docA(), 'a-b')).toBe('idle');
      expect(stateOf(docA(), 'a-c')).toBe('idle');

      jingle.triggers = [];
    });

    it('exempts it when the jingle is started by another trigger, not a click', () => {
      const jingle = cueIn(docA(), 'a-a') as unknown as { triggers: unknown[] };
      const opener = cueIn(docA(), 'a-b') as unknown as { triggers: unknown[] };
      jingle.triggers = [{ events: ['onStart'], target: { cueId: 'g-stop' }, action: 'click' }];
      opener.triggers = [{ events: ['onStart'], target: { cueId: 'a-a' }, action: 'start' }];

      startEverything(['a-a', 'a-b']);
      docA().activate(cueIn(docA(), 'a-b')); // a-b starts a-a, which stops all

      expect(stateOf(docA(), 'a-a')).toBe('playing'); // jingle still exempt
      // a-b is part of the same chain, so it's exempt too — everything the
      // chain touched on its way here keeps playing.
      expect(stateOf(docA(), 'a-b')).toBe('playing');
      expect(stateOf(docA(), 'a-c')).toBe('idle'); // untouched by the chain

      jingle.triggers = [];
      opener.triggers = [];
    });

    it('exempts it across documents when the global cue is scoped to all', () => {
      const jingle = cueIn(docA(), 'a-a') as unknown as { triggers: unknown[] };
      jingle.triggers = [
        { events: ['onStart'], target: { cueId: 'g-stop-all-docs' }, action: 'click' },
      ];

      startEverything(['a-a']);
      docA().activate(cueIn(docA(), 'a-a'));

      expect(stateOf(docA(), 'a-a')).toBe('playing'); // the jingle
      expect(stateOf(docA(), 'a-b')).toBe('idle');
      expect(stateOf(docB(), 'b-a')).toBe('idle'); // other document silenced too

      jingle.triggers = [];
    });

    it('still stops the jingle when stop-all is fired independently afterwards', () => {
      // The exemption is per-chain, not a permanent immunity.
      const jingle = cueIn(docA(), 'a-a') as unknown as { triggers: unknown[] };
      jingle.triggers = [{ events: ['onStart'], target: { cueId: 'g-stop' }, action: 'click' }];

      startEverything(['a-a']);
      docA().activate(cueIn(docA(), 'a-a'));
      expect(stateOf(docA(), 'a-a')).toBe('playing');

      // A separate, later click of stop-all is a fresh chain — nothing exempt.
      docA().activate(cueIn(docA(), 'g-stop'));
      expect(stateOf(docA(), 'a-a')).toBe('idle');

      jingle.triggers = [];
    });

    it('the toolbar stop-all is always a fresh chain and exempts nothing', () => {
      startEverything();
      app.stopAllAudio(false);
      expect(app.anyPlaying).toBe(false);
    });
  });

  it('does not loop when a stopped cue’s onStop triggers the global cue back', () => {
    // a-a's onStop runs the stop-all cue, whose action stops a-a again...
    // The re-entrancy guard must break this, not recurse forever.
    const a = cueIn(docA(), 'a-a') as unknown as { triggers: unknown[] };
    a.triggers = [{ events: ['onStop'], target: { cueId: 'g-stop' }, action: 'click' }];

    startEverything();
    expect(() => docA().activate(cueIn(docA(), 'g-stop'))).not.toThrow();
    expect(stateOf(docA(), 'a-a')).toBe('idle');

    a.triggers = [];
  });

  it('two global cues pointing at each other terminate', () => {
    const g1 = cueIn(docA(), 'g-stop') as unknown as { triggers: unknown[] };
    const g2 = cueIn(docA(), 'g-pause') as unknown as { triggers: unknown[] };
    g1.triggers = [{ events: ['onStart'], target: { cueId: 'g-pause' }, action: 'click' }];
    g2.triggers = [{ events: ['onStart'], target: { cueId: 'g-stop' }, action: 'click' }];

    startEverything();
    expect(() => docA().activate(cueIn(docA(), 'g-stop'))).not.toThrow();

    g1.triggers = [];
    g2.triggers = [];
  });
});
