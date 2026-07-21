// A trigger's Fade box defaults to on in the inspector (TriggerEditor renders
// `checked={trig.fade ?? true}`). A brand-new trigger therefore carries no
// `fade` field at all, and the dispatch path must read that absence as "fade",
// to match what the operator sees. These tests drive real playback through the
// stubbed Web Audio graph so they cover the path a fired trigger actually takes.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installAudioStubs, makeFakeDir } from '../test-utils/webAudioStub';

installAudioStubs();

const audioCue = (id: string, col: number, extra: Record<string, unknown> = {}) => ({
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
  fadeOut: 2,
  volume: 1,
  loop: false,
  onStopBehavior: 'stop',
  ...extra,
});

const project = (extra: Record<string, unknown>) => ({
  version: 1,
  grid: { rows: 4, cols: 8 },
  masterVolume: 1,
  tabs: [
    {
      id: 'tab-1',
      name: 'main',
      cues: [
        audioCue('bed', 0),
        // Fresh triggers, exactly as the UI creates them: no `fade` key.
        audioCue('stopper', 1, {
          triggers: [{ events: ['onStart'], target: { cueId: 'bed' }, action: 'stop' }],
          ...extra,
        }),
      ],
    },
  ],
});

const fakeDir = makeFakeDir({
  cueFiles: { 'show.wsp': JSON.stringify(project({})) },
  audioFiles: ['track.mp3'],
});
(globalThis as Record<string, unknown>).showDirectoryPicker = async () => fakeDir;

let app: typeof import('./project.svelte').app;

beforeAll(async () => {
  ({ app } = await import('./project.svelte'));
  await app.openFolder();
});

const doc = () => app.docs[0];
const cue = (id: string) => doc().findCue(id)!;
const stateOf = (id: string) => doc().playStates[id] ?? 'idle';

describe('trigger fade default', () => {
  beforeEach(() => {
    app.stopAllAudio(false);
  });

  it('fades out when a fresh trigger (no fade field) fires a stop', () => {
    doc().activate(cue('bed'));
    expect(stateOf('bed')).toBe('playing');

    // Firing "stopper" runs its onStart trigger: stop "bed". With no explicit
    // fade, the default is on, so the bed winds down rather than cutting.
    doc().activate(cue('stopper'));
    expect(stateOf('bed')).toBe('fadingOut');
  });

  it('cuts instantly when the trigger explicitly opts out of fade', () => {
    const trig = (cue('stopper') as unknown as { triggers: { fade?: boolean }[] }).triggers[0];
    trig.fade = false;

    doc().activate(cue('bed'));
    doc().activate(cue('stopper'));
    expect(stateOf('bed')).toBe('idle');

    trig.fade = undefined;
  });
});
