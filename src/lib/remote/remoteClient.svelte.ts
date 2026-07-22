// The phone side of the remote: reads the pairing info out of the page's hash
// fragment, opens a WebSocket to the same site's Cloudflare Worker (which routes
// it to the room's Durable Object), holds the latest state snapshot for the UI
// to render, and sends whitelisted commands back.
//
// Runs on remote.html, a separate Vite entry — a different device from the
// player, which is why the messages go through the Worker + DO rather than the
// same-origin window bridge the projector screen uses.

import {
  parsePairHash,
  type ControllerFrame,
  type ControllerInbound,
  type RemoteCommand,
  type RemoteSnapshot,
} from './protocol';
import { rlog } from './log';

export type ClientStatus = 'connecting' | 'connected' | 'reconnecting' | 'error';

/** How long to wait before retrying after the link drops. */
const RECONNECT_MS = 2000;

/**
 * Flag the feed stale after this long with no snapshot. The host beats every
 * 4s, so ~2 missed beats means the link is genuinely frozen rather than just
 * quiet — the operator needs to know the numbers on screen may be stale.
 */
const STALE_MS = 9000;

/** Drop a learned ack/mismatch id after this long so the tracking maps don't
 *  grow unboundedly over a long session. Generous compared to how briefly
 *  RemotePage actually needs one (its own prediction queue expires in a few
 *  seconds), just to stay well clear of any legitimate delay. */
const ACK_TTL_MS = 10000;

export class RemoteClient {
  status = $state<ClientStatus>('connecting');
  /** The most recent state the host pushed, or null before the first arrives. */
  snapshot = $state<RemoteSnapshot | null>(null);
  /**
   * Bumped every time the host speaks (any snapshot). The UI uses it to tell
   * "the host has said something since my tap" apart from "still waiting" — the
   * signal that clears a button's just-sent acknowledgement.
   */
  rev = $state(0);
  /** True when connected but no snapshot has arrived for a while (frozen link). */
  stale = $state(false);
  error = $state('');
  /** Ids of commands the host has applied and confirmed matched the state the
   *  phone claimed when it sent them. Reassigned (never mutated in place) on
   *  every update so Svelte's reactivity picks up the change. */
  ackedIds = $state<Set<string>>(new Set());
  /** Ids of commands the host applied but whose claimed starting state (see
   *  `activateCue`'s `fromState`) didn't match reality — the phone's own
   *  prediction of the outcome can't be trusted. */
  mismatchedIds = $state<Set<string>>(new Set());

  private socket: WebSocket | null = null;
  private roomId = '';
  private key = '';
  private reconnectTimer = 0;
  private staleTimer = 0;
  private lastSnapshotAt = 0;
  private started = false;
  /** Bumps every (re)connect so a superseded socket's late events are ignored. */
  private epoch = 0;
  /** When each id in `ackedIds`/`mismatchedIds` was learned, for TTL pruning. */
  private ackedAt = new Map<string, number>();
  private mismatchedAt = new Map<string, number>();

  /** Read the fragment and connect. Fails loudly if the link has no pairing code. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const pair = parsePairHash(location.hash);
    if (!pair) {
      this.status = 'error';
      this.error = 'This link has no pairing code. Re-scan the QR shown in the player.';
      return;
    }
    this.roomId = pair.roomId;
    this.key = pair.key;
    rlog('client', 'start; room', this.roomId);
    this.connect();

    // A phone's connection comes and goes as it moves around a venue; rejoin as
    // soon as the network is back rather than waiting out the retry timer.
    window.addEventListener('online', () => {
      if (this.status !== 'connected') this.connect();
    });

    // Watch for a frozen feed: connected, but nothing has arrived past the beat.
    this.staleTimer = setInterval(() => {
      this.stale =
        this.status === 'connected' &&
        this.lastSnapshotAt > 0 &&
        Date.now() - this.lastSnapshotAt > STALE_MS;
    }, 1000) as unknown as number;
  }

  private socketUrl(): string {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const room = encodeURIComponent(this.roomId);
    const key = encodeURIComponent(this.key);
    return `${scheme}//${location.host}/api/remote/${room}?role=controller&key=${key}`;
  }

  private connect(): void {
    this.teardownSocket();
    // Keep whatever we last showed on screen while we reconnect, so the operator
    // isn't left staring at a blank remote mid-show.
    this.status = this.snapshot ? 'reconnecting' : 'connecting';
    const epoch = ++this.epoch;
    const isCurrent = () => epoch === this.epoch;
    try {
      const socket = new WebSocket(this.socketUrl());
      this.socket = socket;
      rlog('client', 'connecting');

      socket.onopen = () => {
        if (!isCurrent()) return;
        this.status = 'connected';
        rlog('client', 'socket open');
      };

      socket.onmessage = (ev) => {
        if (!isCurrent()) return;
        this.onMessage(ev.data);
      };

      socket.onclose = () => {
        if (!isCurrent()) return;
        rlog('client', 'socket closed; reconnecting');
        this.socket = null;
        this.status = 'reconnecting';
        this.scheduleReconnect();
      };

      socket.onerror = () => {
        if (!isCurrent()) return;
        rlog('client', 'socket error');
        // onclose follows an error and drives the reconnect; nothing to do here.
      };
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      rlog('client', 'connect failed:', this.error);
      this.scheduleReconnect();
    }
  }

  private onMessage(raw: unknown): void {
    let msg: ControllerInbound;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : '') as ControllerInbound;
    } catch {
      return;
    }
    if (msg.k === 'state') {
      this.snapshot = msg.d as RemoteSnapshot;
      this.rev++;
      this.status = 'connected';
      this.lastSnapshotAt = Date.now();
      this.stale = false;
      if (Array.isArray(msg.ack)) this.ackedIds = this.mergeIds(msg.ack, this.ackedAt);
      if (Array.isArray(msg.mismatch)) this.mismatchedIds = this.mergeIds(msg.mismatch, this.mismatchedAt);
    }
  }

  /** Merge validated string ids from an inbound array into `at` (pruning
   *  entries past `ACK_TTL_MS`) and return a fresh Set reflecting it — a new
   *  instance every time, since a `$state<Set<...>>` needs reassignment, not
   *  in-place mutation, for Svelte to notice the change. */
  private mergeIds(raw: unknown[], at: Map<string, number>): Set<string> {
    const now = Date.now();
    for (const id of raw) {
      if (typeof id === 'string') at.set(id, now);
    }
    for (const [id, seenAt] of at) {
      if (now - seenAt > ACK_TTL_MS) at.delete(id);
    }
    return new Set(at.keys());
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = 0;
      this.connect();
    }, RECONNECT_MS) as unknown as number;
  }

  /**
   * Fire a command at the host with a fresh id, so a later `state` frame's
   * `ack`/`mismatch` can refer back to it. No-op until the socket is open.
   * Returns the id if the command actually left the phone, or null if it
   * didn't — the caller only tracks a prediction for a command that was
   * really sent.
   */
  send(cmd: RemoteCommand): string | null {
    if (this.socket?.readyState !== WebSocket.OPEN) return null;
    const id = crypto.randomUUID();
    const frame: ControllerFrame = { k: 'cmd', id, d: cmd };
    try {
      this.socket.send(JSON.stringify(frame));
      return id;
    } catch {
      // A failing send means the socket is closing; the reconnect path handles it.
      return null;
    }
  }

  private teardownSocket(): void {
    this.epoch++; // Orphan the current socket's callbacks.
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Already closing — nothing to do.
      }
    }
  }
}

export const remoteClient = new RemoteClient();
