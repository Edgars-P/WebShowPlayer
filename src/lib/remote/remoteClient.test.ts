import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A controllable stand-in for the browser WebSocket. Only the surface the client
// touches is modelled: settable onopen/onmessage/onclose/onerror, a send spy, a
// close(), a static OPEN, and an instance readyState. The helper methods let a
// test drive the events the real socket would otherwise fire.
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  // --- test drivers, mimicking what the browser would call ---
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

// Imported after the fake is in place so the module picks it up as global.
import { RemoteClient } from './remoteClient.svelte';

function stateFrame() {
  return { k: 'state', d: { v: 1, docs: [], activeDocId: '', tabs: [], activeTabId: '' } };
}

describe('RemoteClient reconnect', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.useFakeTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    (globalThis as unknown as { location: unknown }).location = {
      hash: '#room=room1&key=derivedkey',
      protocol: 'https:',
      host: 'player.example',
    };
    (globalThis as unknown as { window: unknown }).window = { addEventListener: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a superseded socket cannot tear down the freshly reconnected socket', () => {
    const client = new RemoteClient();
    client.start();

    const s1 = FakeWebSocket.instances[0];
    expect(s1).toBeDefined();
    expect(s1.url).toContain('role=controller');
    expect(s1.url).toContain('key=derivedkey');

    // First connection comes up and a snapshot arrives.
    s1.open();
    s1.message(stateFrame());
    expect(client.status).toBe('connected');
    expect(client.snapshot).not.toBeNull();

    // The link drops: the current socket closes.
    s1.drop();
    expect(client.status).toBe('reconnecting');

    // The reconnect timer fires and a fresh socket is opened.
    vi.advanceTimersByTime(2000);
    const s2 = FakeWebSocket.instances[1];
    expect(s2).toBeDefined();
    expect(s2).not.toBe(s1);

    // The fresh socket connects — the remote is live again.
    s2.open();
    expect(client.status).toBe('connected');

    // Now the OLD socket fires a late onclose, as a backgrounded phone's stale
    // socket does when it finally tears down. Without the epoch guard this flips
    // the live status back to 'reconnecting' and schedules a reconnect that kills
    // the fresh socket — the "connects for a split second, then drops" loop.
    s1.drop();
    expect(client.status).toBe('connected');

    // And no stray reconnect was scheduled off the dead socket.
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('a late message on a dead socket cannot resurrect a stale snapshot as connected', () => {
    const client = new RemoteClient();
    client.start();

    const s1 = FakeWebSocket.instances[0];
    s1.open();
    s1.message(stateFrame());
    s1.drop();
    vi.advanceTimersByTime(2000);
    const s2 = FakeWebSocket.instances[1];
    s2.open();
    expect(client.status).toBe('connected');

    // A late message on the dead socket must be ignored, not mark us connected.
    client.status = 'reconnecting';
    s1.message(stateFrame());
    expect(client.status).toBe('reconnecting');
  });

  it('sends commands as cmd frames on the open socket, returning the generated id', () => {
    const client = new RemoteClient();
    client.start();
    const s1 = FakeWebSocket.instances[0];
    s1.open();

    const id = client.send({ t: 'stopAll', fade: false });
    expect(s1.sent).toHaveLength(1);
    const parsed = JSON.parse(s1.sent[0]);
    expect(parsed).toMatchObject({ k: 'cmd', d: { t: 'stopAll', fade: false } });
    expect(typeof parsed.id).toBe('string');
    expect(parsed.id).toBe(id);
  });
});

describe('RemoteClient acks', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.useFakeTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    (globalThis as unknown as { location: unknown }).location = {
      hash: '#room=room1&key=derivedkey',
      protocol: 'https:',
      host: 'player.example',
    };
    (globalThis as unknown as { window: unknown }).window = { addEventListener: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collects acked ids from a state frame's ack array", () => {
    const client = new RemoteClient();
    client.start();
    const s1 = FakeWebSocket.instances[0];
    s1.open();
    s1.message({ ...stateFrame(), ack: ['id-1', 'id-2'] });
    expect(client.ackedIds.has('id-1')).toBe(true);
    expect(client.ackedIds.has('id-2')).toBe(true);
    expect(client.mismatchedIds.size).toBe(0);
  });

  it("collects mismatched ids from a state frame's mismatch array, independently of ack", () => {
    const client = new RemoteClient();
    client.start();
    const s1 = FakeWebSocket.instances[0];
    s1.open();
    s1.message({ ...stateFrame(), ack: ['ok-1'], mismatch: ['bad-1'] });
    expect(client.ackedIds.has('ok-1')).toBe(true);
    expect(client.mismatchedIds.has('bad-1')).toBe(true);
    expect(client.ackedIds.has('bad-1')).toBe(false);
    expect(client.mismatchedIds.has('ok-1')).toBe(false);
  });

  it('ignores a non-array or non-string ack/mismatch payload', () => {
    const client = new RemoteClient();
    client.start();
    const s1 = FakeWebSocket.instances[0];
    s1.open();
    s1.message({ ...stateFrame(), ack: 'not-an-array', mismatch: 'not-an-array' });
    expect(client.ackedIds.size).toBe(0);
    expect(client.mismatchedIds.size).toBe(0);
    s1.message({ ...stateFrame(), ack: [123, null, 'ok'] });
    expect(client.ackedIds.has('ok')).toBe(true);
    expect(client.ackedIds.size).toBe(1);
  });
});
