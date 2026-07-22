import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RemoteSnapshot } from './protocol';

// remoteHost.svelte.ts imports the real `app` singleton (project.svelte.ts),
// whose constructor eagerly builds a ScreenWindow that touches `window` — stub
// it before dynamically importing the module, same pattern as
// state/app.test.ts uses for the same reason.
(globalThis as unknown as { window: unknown }).window = globalThis;

// Same fake WebSocket surface as remoteClient.test.ts's harness — duplicated
// here rather than shared, matching this repo's existing per-file convention.
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

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
}

// Imported after the fake window is in place so AppState's constructor
// doesn't throw when it runs.
const { RemoteHost } = await import('./remoteHost.svelte');

function snapFixture(): RemoteSnapshot {
  // Deliberately partial (cast) — RemoteHost never re-validates a snapshot's
  // shape at runtime, it just stores/forwards it verbatim.
  return { v: 1, docs: [], activeDocId: '', tabs: [], activeTabId: '' } as unknown as RemoteSnapshot;
}

function stateFrames(socket: FakeWebSocket): { ack?: string[]; mismatch?: string[] }[] {
  return socket.sent.map((s) => JSON.parse(s)).filter((f) => f.k === 'state');
}

describe('RemoteHost acks', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.useFakeTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    (globalThis as unknown as { location: unknown }).location = {
      hash: '',
      protocol: 'https:',
      host: 'player.example',
    };
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function connectedHost(): { host: InstanceType<typeof RemoteHost>; socket: FakeWebSocket } {
    const host = new RemoteHost();
    host.start();
    host.setHostKey('k');
    host.enable();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message({ k: 'peers', n: 1 }); // required for flush() to actually send
    return { host, socket };
  }

  it('acks a command id on the next flushed state frame', () => {
    const { host, socket } = connectedHost();
    socket.message({ k: 'cmd', id: 'abc', d: { t: 'timerPause' } });
    host.pushState(snapFixture());
    vi.advanceTimersByTime(200); // PUSH_THROTTLE_MS
    const frame = stateFrames(socket).at(-1);
    expect(frame?.ack).toEqual(['abc']);
    expect(frame?.mismatch).toBeUndefined();
  });

  it('coalesces multiple commands within one throttle window into one ack array', () => {
    const { host, socket } = connectedHost();
    socket.message({ k: 'cmd', id: 'a', d: { t: 'timerPause' } });
    // pauseVideo/timerPause are both harmless no-ops with no video/timer
    // active — unlike openScreen, they never touch `window.open`.
    socket.message({ k: 'cmd', id: 'b', d: { t: 'videoPause' } });
    host.pushState(snapFixture());
    vi.advanceTimersByTime(200);
    const frame = stateFrames(socket).at(-1);
    expect(frame?.ack).toEqual(['a', 'b']);
  });

  it('does not resend an already-acked id on the following flush', () => {
    const { host, socket } = connectedHost();
    socket.message({ k: 'cmd', id: 'a', d: { t: 'timerPause' } });
    host.pushState(snapFixture());
    vi.advanceTimersByTime(200);
    host.pushState(snapFixture());
    vi.advanceTimersByTime(200);
    const frames = stateFrames(socket);
    expect(frames.at(-1)?.ack).toBeUndefined();
  });

  it('reports an activateCue for a cue that cannot be found as a mismatch, not an ack', () => {
    const { host, socket } = connectedHost();
    // No document is open, so app.activeDoc is undefined and the cue lookup
    // fails — the action returns false without needing to stub app further.
    socket.message({
      k: 'cmd',
      id: 'x',
      d: { t: 'activateCue', cueId: 'missing', fromState: 'idle' },
    });
    host.pushState(snapFixture());
    vi.advanceTimersByTime(200);
    const frame = stateFrames(socket).at(-1);
    expect(frame?.mismatch).toEqual(['x']);
    expect(frame?.ack).toBeUndefined();
  });
});
