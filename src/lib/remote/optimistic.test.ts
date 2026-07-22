import { describe, it, expect } from 'vitest';
import { predictSnapshot } from './optimistic';
import type { RemoteCue, RemoteSnapshot } from './protocol';

function cue(over: Partial<RemoteCue> & { id: string }): RemoteCue {
  return {
    name: '',
    color: '#3b82f6',
    state: 'idle',
    missing: false,
    pending: false,
    unavailable: false,
    subtitle: '',
    subtitleIcon: null,
    row: 0,
    col: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    ...over,
  };
}

function snapshot(over: Partial<RemoteSnapshot> = {}): RemoteSnapshot {
  return {
    v: 1,
    docs: [{ id: 'doc-1', title: 'Show A' }],
    activeDocId: 'doc-1',
    tabs: [{ id: 'tab-1', name: 'Act 1', cues: [] }],
    activeTabId: 'tab-1',
    timer: { active: false, running: false, finished: false, remaining: 0 },
    video: { active: false, playing: false, remaining: 0 },
    screenLive: false,
    anyPlaying: false,
    master: 1,
    ...over,
  };
}

function withCues(cues: RemoteCue[], over: Partial<RemoteSnapshot> = {}): RemoteSnapshot {
  return snapshot({ tabs: [{ id: 'tab-1', name: 'Act 1', cues }], ...over });
}

describe('predictSnapshot: activateCue', () => {
  it('idle with a fade-in goes to fadingIn', () => {
    const snap = withCues([cue({ id: 'a', state: 'idle', fadeInSec: 2 })]);
    const next = predictSnapshot(snap, { t: 'activateCue', cueId: 'a', fromState: 'idle' });
    expect(next?.tabs[0].cues[0].state).toBe('fadingIn');
  });

  it('idle with no fade-in goes straight to playing', () => {
    const snap = withCues([cue({ id: 'a', state: 'idle', fadeInSec: 0 })]);
    const next = predictSnapshot(snap, { t: 'activateCue', cueId: 'a', fromState: 'idle' });
    expect(next?.tabs[0].cues[0].state).toBe('playing');
  });

  it('fadingIn always snaps to playing regardless of fade values', () => {
    for (const fadeOutSec of [0, 3]) {
      const snap = withCues([cue({ id: 'a', state: 'fadingIn', fadeOutSec })]);
      const next = predictSnapshot(snap, { t: 'activateCue', cueId: 'a', fromState: 'fadingIn' });
      expect(next?.tabs[0].cues[0].state).toBe('playing');
    }
  });

  it('playing with a fade-out goes to fadingOut', () => {
    const snap = withCues([cue({ id: 'a', state: 'playing', fadeOutSec: 2 })]);
    const next = predictSnapshot(snap, { t: 'activateCue', cueId: 'a', fromState: 'playing' });
    expect(next?.tabs[0].cues[0].state).toBe('fadingOut');
  });

  it('playing with no fade-out goes straight to idle', () => {
    const snap = withCues([cue({ id: 'a', state: 'playing', fadeOutSec: 0 })]);
    const next = predictSnapshot(snap, { t: 'activateCue', cueId: 'a', fromState: 'playing' });
    expect(next?.tabs[0].cues[0].state).toBe('idle');
  });

  it('fadingOut always snaps to idle regardless of fade values', () => {
    for (const fadeInSec of [0, 3]) {
      const snap = withCues([cue({ id: 'a', state: 'fadingOut', fadeInSec })]);
      const next = predictSnapshot(snap, { t: 'activateCue', cueId: 'a', fromState: 'fadingOut' });
      expect(next?.tabs[0].cues[0].state).toBe('idle');
    }
  });

  it('returns null for an unknown cue id', () => {
    const snap = withCues([cue({ id: 'a', state: 'idle' })]);
    const next = predictSnapshot(snap, { t: 'activateCue', cueId: 'missing', fromState: 'idle' });
    expect(next).toBeNull();
  });

  it('never touches a sibling cue', () => {
    const snap = withCues([
      cue({ id: 'a', state: 'idle', fadeInSec: 1 }),
      cue({ id: 'b', state: 'playing', fadeOutSec: 1 }),
    ]);
    const next = predictSnapshot(snap, { t: 'activateCue', cueId: 'a', fromState: 'idle' });
    expect(next?.tabs[0].cues[1]).toBe(snap.tabs[0].cues[1]);
  });
});

describe('predictSnapshot: stopAll', () => {
  it('fades playing/fadingIn cues to fadingOut when fade is true', () => {
    const snap = withCues(
      [
        cue({ id: 'a', state: 'playing' }),
        cue({ id: 'b', state: 'fadingIn' }),
        cue({ id: 'c', state: 'idle' }),
        cue({ id: 'd', state: 'fadingOut' }),
      ],
      { anyPlaying: true },
    );
    const next = predictSnapshot(snap, { t: 'stopAll', fade: true });
    expect(next?.tabs[0].cues.map((c) => c.state)).toEqual(['fadingOut', 'fadingOut', 'idle', 'fadingOut']);
    expect(next?.anyPlaying).toBe(false);
  });

  it('cuts playing/fadingIn cues straight to idle when fade is false', () => {
    const snap = withCues(
      [cue({ id: 'a', state: 'playing' }), cue({ id: 'b', state: 'fadingIn' })],
      { anyPlaying: true },
    );
    const next = predictSnapshot(snap, { t: 'stopAll', fade: false });
    expect(next?.tabs[0].cues.map((c) => c.state)).toEqual(['idle', 'idle']);
  });

  it('spans multiple tabs', () => {
    const snap = snapshot({
      tabs: [
        { id: 't1', name: 'A', cues: [cue({ id: 'a', state: 'playing' })] },
        { id: 't2', name: 'B', cues: [cue({ id: 'b', state: 'fadingIn' })] },
      ],
      anyPlaying: true,
    });
    const next = predictSnapshot(snap, { t: 'stopAll', fade: true });
    expect(next?.tabs[0].cues[0].state).toBe('fadingOut');
    expect(next?.tabs[1].cues[0].state).toBe('fadingOut');
  });
});

describe('predictSnapshot: timer', () => {
  it('timerPause/timerResume flip running only when active', () => {
    const active = snapshot({ timer: { active: true, running: false, finished: false, remaining: 10 } });
    expect(predictSnapshot(active, { t: 'timerPause' })?.timer.running).toBe(false);
    expect(predictSnapshot(active, { t: 'timerResume' })?.timer.running).toBe(true);

    const inactive = snapshot({ timer: { active: false, running: false, finished: false, remaining: 0 } });
    expect(predictSnapshot(inactive, { t: 'timerPause' })).toBeNull();
    expect(predictSnapshot(inactive, { t: 'timerResume' })).toBeNull();
  });

  it('timerClear forces active/running/finished false unconditionally', () => {
    const snap = snapshot({ timer: { active: true, running: true, finished: false, remaining: 5 } });
    const next = predictSnapshot(snap, { t: 'timerClear' });
    expect(next?.timer).toEqual({ active: false, running: false, finished: false, remaining: 5 });
  });
});

describe('predictSnapshot: video', () => {
  it('videoPause/videoResume flip playing only when active', () => {
    const active = snapshot({ video: { active: true, playing: false, remaining: 10 } });
    expect(predictSnapshot(active, { t: 'videoPause' })?.video.playing).toBe(false);
    expect(predictSnapshot(active, { t: 'videoResume' })?.video.playing).toBe(true);

    const inactive = snapshot({ video: { active: false, playing: false, remaining: 0 } });
    expect(predictSnapshot(inactive, { t: 'videoPause' })).toBeNull();
    expect(predictSnapshot(inactive, { t: 'videoResume' })).toBeNull();
  });

  it('videoClear forces active/playing false unconditionally', () => {
    const snap = snapshot({ video: { active: true, playing: true, remaining: 5 } });
    const next = predictSnapshot(snap, { t: 'videoClear' });
    expect(next?.video).toEqual({ active: false, playing: false, remaining: 5 });
  });
});

describe('predictSnapshot: screen and doc', () => {
  it('openScreen sets screenLive, or null if already live', () => {
    expect(predictSnapshot(snapshot({ screenLive: false }), { t: 'openScreen' })?.screenLive).toBe(true);
    expect(predictSnapshot(snapshot({ screenLive: true }), { t: 'openScreen' })).toBeNull();
  });

  it('selectDoc changes only activeDocId, leaving tabs/cues untouched', () => {
    const snap = withCues([cue({ id: 'a' })]);
    const next = predictSnapshot(snap, { t: 'selectDoc', docId: 'doc-2' });
    expect(next?.activeDocId).toBe('doc-2');
    expect(next?.tabs).toBe(snap.tabs);
  });

  it('selectDoc returns null when the doc is already active', () => {
    const snap = snapshot({ activeDocId: 'doc-1' });
    expect(predictSnapshot(snap, { t: 'selectDoc', docId: 'doc-1' })).toBeNull();
  });
});

describe('predictSnapshot: unpredicted commands', () => {
  it('setTab and setMaster always return null', () => {
    const snap = snapshot();
    expect(predictSnapshot(snap, { t: 'setTab', tabId: 't2' })).toBeNull();
    expect(predictSnapshot(snap, { t: 'setMaster', value: 0.5 })).toBeNull();
  });
});
