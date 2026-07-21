import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A controllable stand-in for a trystero room. Only the surface the client
// touches is modelled: settable onPeerJoin/onPeerLeave, makeAction (with a
// settable onMessage and a send spy), getPeers, and an async leave. The helper
// methods let a test drive the events trystero would otherwise fire.
interface FakeAction {
  send: ReturnType<typeof vi.fn>;
  onMessage: ((data: unknown) => void) | null;
}

class FakeRoom {
  onPeerJoin: (() => void) | null = null;
  onPeerLeave: (() => void) | null = null;
  actions: Record<string, FakeAction> = {};
  peers: Record<string, unknown> = {};
  left = false;

  makeAction(name: string): FakeAction {
    const action: FakeAction = { send: vi.fn(async () => {}), onMessage: null };
    this.actions[name] = action;
    return action;
  }

  getPeers(): Record<string, unknown> {
    return this.peers;
  }

  async leave(): Promise<void> {
    this.left = true;
  }

  // --- test drivers, mimicking what trystero would call ---
  joinPeer(id = 'host'): void {
    this.peers[id] = {};
    this.onPeerJoin?.();
  }

  leavePeer(id = 'host'): void {
    delete this.peers[id];
    this.onPeerLeave?.();
  }

  pushState(data: unknown): void {
    this.actions.state.onMessage?.(data);
  }
}

const rooms: FakeRoom[] = [];

vi.mock('trystero/nostr', () => ({
  joinRoom: vi.fn(() => {
    const room = new FakeRoom();
    rooms.push(room);
    return room;
  }),
}));

// Imported after the mock is registered (vi.mock is hoisted above imports).
import { RemoteClient } from './remoteClient.svelte';

function snapshot() {
  return { v: 1, docs: [], activeDocId: '', tabs: [], activeTabId: '' };
}

describe('RemoteClient reconnect', () => {
  beforeEach(() => {
    rooms.length = 0;
    vi.useFakeTimers();
    (globalThis as unknown as { location: unknown }).location = { hash: '#r=room1&k=secretk' };
    (globalThis as unknown as { window: unknown }).window = { addEventListener: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a superseded room cannot tear down the freshly reconnected room', () => {
    const client = new RemoteClient();
    client.start();

    const r1 = rooms[0];
    expect(r1).toBeDefined();

    // First connection comes up and a snapshot arrives.
    r1.pushState(snapshot());
    expect(client.status).toBe('connected');

    // The link drops: the current room reports its last peer gone.
    r1.leavePeer();
    expect(client.status).toBe('reconnecting');

    // The reconnect timer fires and a fresh room is joined.
    vi.advanceTimersByTime(2000);
    const r2 = rooms[1];
    expect(r2).toBeDefined();
    expect(r2).not.toBe(r1);

    // The fresh room connects — the remote is live again.
    r2.joinPeer();
    expect(client.status).toBe('connected');

    // Now the OLD room fires a late onPeerLeave, as it does when a backgrounded
    // phone's stale peer connection finally closes. Without the guard this flips
    // the live status back to 'reconnecting' and schedules a reconnect that
    // tears down r2 — the "connects for a split second, then drops" loop.
    r1.leavePeer('straggler');
    expect(client.status).toBe('connected');

    // And no stray reconnect was scheduled off the dead room: advancing past the
    // retry window joins no further rooms.
    vi.advanceTimersByTime(2000);
    expect(rooms).toHaveLength(2);
  });

  it('a superseded room cannot resurrect a stale snapshot as connected', () => {
    const client = new RemoteClient();
    client.start();

    const r1 = rooms[0];
    r1.pushState(snapshot());
    r1.leavePeer();
    vi.advanceTimersByTime(2000);
    const r2 = rooms[1];
    r2.joinPeer();
    expect(client.status).toBe('connected');

    // A late message on the dead room must be ignored, not mark us connected.
    client.status = 'reconnecting';
    r1.pushState(snapshot());
    expect(client.status).toBe('reconnecting');
  });
});
