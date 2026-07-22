import { describe, it, expect, vi } from 'vitest';
import {
  applyCommand,
  buildSnapshot,
  pairUrl,
  parseCommand,
  parsePairHash,
  randomSecret,
  REMOTE_PROTOCOL,
  type RemoteCue,
  type RemoteHostActions,
  type SnapshotInput,
} from './protocol';

function cue(over: Partial<RemoteCue> & { id: string; row: number; col: number }): RemoteCue {
  return {
    name: '',
    color: '#3b82f6',
    state: 'idle',
    missing: false,
    pending: false,
    unavailable: false,
    subtitle: '',
    subtitleIcon: null,
    fadeInSec: 0,
    fadeOutSec: 0,
    ...over,
  };
}

function baseInput(): SnapshotInput {
  return {
    docs: [{ id: 'doc-1', title: 'Show A' }],
    activeDocId: 'doc-1',
    activeTabId: 'tab-1',
    master: 0.8,
    screenLive: false,
    anyPlaying: false,
    timer: { duration: 0, remaining: 0, running: false, finished: false },
    video: { active: false, playing: false, remaining: 0 },
    tabs: [{ id: 'tab-1', name: 'Act 1', cues: [] }],
  };
}

describe('buildSnapshot', () => {
  it('stamps the protocol version and copies the top-bar state through', () => {
    const input = baseInput();
    input.master = 0.5;
    input.screenLive = true;
    input.anyPlaying = true;
    const snap = buildSnapshot(input);
    expect(snap.v).toBe(REMOTE_PROTOCOL);
    expect(snap.master).toBe(0.5);
    expect(snap.screenLive).toBe(true);
    expect(snap.anyPlaying).toBe(true);
    expect(snap.activeTabId).toBe('tab-1');
    expect(snap.activeDocId).toBe('doc-1');
  });

  it('sorts cues into reading order (row then column) regardless of input order', () => {
    const input = baseInput();
    input.tabs = [
      {
        id: 'tab-1',
        name: 'Act 1',
        cues: [
          cue({ id: 'c', row: 1, col: 0 }),
          cue({ id: 'b', row: 0, col: 1 }),
          cue({ id: 'a', row: 0, col: 0 }),
          cue({ id: 'd', row: 1, col: 1 }),
        ],
      },
    ];
    const ids = buildSnapshot(input).tabs[0].cues.map((c) => c.id);
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not mutate the caller’s cue array', () => {
    const input = baseInput();
    const cues = [cue({ id: 'z', row: 5, col: 0 }), cue({ id: 'y', row: 0, col: 0 })];
    input.tabs = [{ id: 'tab-1', name: 'Act 1', cues }];
    buildSnapshot(input);
    expect(cues.map((c) => c.id)).toEqual(['z', 'y']);
  });

  it('marks the timer active when it has a duration or has finished', () => {
    const running = baseInput();
    running.timer = { duration: 300, remaining: 120, running: true, finished: false };
    expect(buildSnapshot(running).timer).toEqual({
      active: true,
      running: true,
      finished: false,
      remaining: 120,
    });

    const finished = baseInput();
    finished.timer = { duration: 0, remaining: 0, running: false, finished: true };
    expect(buildSnapshot(finished).timer.active).toBe(true);

    expect(buildSnapshot(baseInput()).timer.active).toBe(false);
  });

  it('carries every cue field the phone renders', () => {
    const input = baseInput();
    input.tabs = [
      {
        id: 'tab-1',
        name: 'Act 1',
        cues: [
          cue({ id: 'a', row: 0, col: 0, name: 'Intro', color: '#f00', state: 'playing', subtitle: '−1:00' }),
        ],
      },
    ];
    expect(buildSnapshot(input).tabs[0].cues[0]).toEqual({
      id: 'a',
      row: 0,
      col: 0,
      name: 'Intro',
      color: '#f00',
      state: 'playing',
      missing: false,
      pending: false,
      unavailable: false,
      subtitle: '−1:00',
      subtitleIcon: null,
      fadeInSec: 0,
      fadeOutSec: 0,
    });
  });
});

describe('parseCommand', () => {
  it('accepts each whitelisted command with valid fields', () => {
    expect(parseCommand({ t: 'activateCue', cueId: 'x', fromState: 'idle' })).toEqual({
      t: 'activateCue',
      cueId: 'x',
      fromState: 'idle',
    });
    expect(parseCommand({ t: 'setTab', tabId: 't' })).toEqual({ t: 'setTab', tabId: 't' });
    expect(parseCommand({ t: 'selectDoc', docId: 'd' })).toEqual({ t: 'selectDoc', docId: 'd' });
    expect(parseCommand({ t: 'stopAll', fade: true })).toEqual({ t: 'stopAll', fade: true });
    expect(parseCommand({ t: 'timerPause' })).toEqual({ t: 'timerPause' });
    expect(parseCommand({ t: 'openScreen' })).toEqual({ t: 'openScreen' });
    expect(parseCommand({ t: 'setMaster', value: 0.5 })).toEqual({ t: 'setMaster', value: 0.5 });
  });

  it('accepts every valid fromState value on activateCue', () => {
    for (const fromState of ['idle', 'fadingIn', 'playing', 'fadingOut']) {
      expect(parseCommand({ t: 'activateCue', cueId: 'x', fromState })).toEqual({
        t: 'activateCue',
        cueId: 'x',
        fromState,
      });
    }
  });

  it('rejects unknown, malformed, or wrongly-typed messages', () => {
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand('activateCue')).toBeNull();
    expect(parseCommand({})).toBeNull();
    expect(parseCommand({ t: 'nope' })).toBeNull();
    expect(parseCommand({ t: 'activateCue' })).toBeNull(); // missing cueId/fromState
    expect(parseCommand({ t: 'activateCue', cueId: 42, fromState: 'idle' })).toBeNull();
    expect(parseCommand({ t: 'activateCue', cueId: 'x' })).toBeNull(); // missing fromState
    expect(parseCommand({ t: 'activateCue', cueId: 'x', fromState: 'nope' })).toBeNull(); // invalid fromState
    expect(parseCommand({ t: 'stopAll', fade: 'yes' })).toBeNull();
    expect(parseCommand({ t: 'setMaster', value: 2 })).toBeNull(); // out of range
    expect(parseCommand({ t: 'setMaster', value: -0.1 })).toBeNull();
    // An arbitrary extra property is not a command shape we know.
    expect(parseCommand({ t: 'save' })).toBeNull();
  });
});

describe('applyCommand', () => {
  function stub(activateCueMatches = true): RemoteHostActions & { calls: [string, unknown?, unknown?][] } {
    const calls: [string, unknown?, unknown?][] = [];
    return {
      calls,
      activateCue: (id, fromState) => {
        calls.push(['activateCue', id, fromState]);
        return activateCueMatches;
      },
      setTab: (id) => calls.push(['setTab', id]),
      selectDoc: (id) => calls.push(['selectDoc', id]),
      stopAll: (fade) => calls.push(['stopAll', fade]),
      timerPause: () => calls.push(['timerPause']),
      timerResume: () => calls.push(['timerResume']),
      timerClear: () => calls.push(['timerClear']),
      videoPause: () => calls.push(['videoPause']),
      videoResume: () => calls.push(['videoResume']),
      videoClear: () => calls.push(['videoClear']),
      openScreen: () => calls.push(['openScreen']),
      setMaster: (v) => calls.push(['setMaster', v]),
    };
  }

  it('routes each command to its matching action', () => {
    const host = stub();
    expect(applyCommand(host, { t: 'activateCue', cueId: 'c1', fromState: 'idle' })).toEqual({
      valid: true,
      matched: true,
    });
    expect(applyCommand(host, { t: 'setTab', tabId: 't2' })).toEqual({ valid: true, matched: true });
    expect(applyCommand(host, { t: 'stopAll', fade: false })).toEqual({ valid: true, matched: true });
    expect(applyCommand(host, { t: 'timerClear' })).toEqual({ valid: true, matched: true });
    expect(applyCommand(host, { t: 'setMaster', value: 0.25 })).toEqual({ valid: true, matched: true });
    expect(host.calls).toEqual([
      ['activateCue', 'c1', 'idle'],
      ['setTab', 't2'],
      ['stopAll', false],
      ['timerClear'],
      ['setMaster', 0.25],
    ]);
  });

  it("reports activateCue's matched result, true or false, based on the host's answer", () => {
    expect(applyCommand(stub(true), { t: 'activateCue', cueId: 'c1', fromState: 'idle' }).matched).toBe(true);
    expect(applyCommand(stub(false), { t: 'activateCue', cueId: 'c1', fromState: 'idle' }).matched).toBe(false);
  });

  it('rejects and does not dispatch an invalid command', () => {
    const host = stub();
    expect(applyCommand(host, { t: 'save' })).toEqual({ valid: false, matched: true });
    expect(applyCommand(host, { t: 'activateCue', cueId: 99, fromState: 'idle' })).toEqual({
      valid: false,
      matched: true,
    });
    expect(host.calls).toEqual([]);
  });
});

describe('randomSecret', () => {
  it('is URL-safe and non-repeating', () => {
    const a = randomSecret();
    const b = randomSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // no +, /, or = padding
    expect(a.length).toBeGreaterThanOrEqual(40); // 32 bytes b64 ≈ 43 chars
  });

  it('honours the requested byte length', () => {
    // 16 bytes base64url (no padding) is 22 chars; 32 bytes is 43.
    expect(randomSecret(16).length).toBeLessThan(randomSecret(32).length);
  });
});

describe('parsePairHash / pairUrl round-trip', () => {
  it('reads room and key out of a fragment, with or without the leading #', () => {
    expect(parsePairHash('#room=room1&key=derived')).toEqual({ roomId: 'room1', key: 'derived' });
    expect(parsePairHash('room=room1&key=derived')).toEqual({ roomId: 'room1', key: 'derived' });
  });

  it('returns null when either part is missing', () => {
    expect(parsePairHash('')).toBeNull();
    expect(parsePairHash('#room=room1')).toBeNull();
    expect(parsePairHash('#key=derived')).toBeNull();
  });

  it('round-trips a minted pair through the URL and back', () => {
    const pair = { roomId: crypto.randomUUID(), key: randomSecret(32) };
    const url = pairUrl('https://player.example', pair);
    expect(url.startsWith('https://player.example/remote.html#')).toBe(true);
    const hash = url.slice(url.indexOf('#'));
    expect(parsePairHash(hash)).toEqual(pair);
  });
});
