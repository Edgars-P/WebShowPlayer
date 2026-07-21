// The phone side of the remote: reads the pairing info out of the page's hash
// fragment, joins the same trystero room as the host, holds the latest state
// snapshot for the UI to render, and sends whitelisted commands back.
//
// Runs on remote.html, a separate Vite entry — a different device from the
// player, which is the whole reason a WebRTC channel is needed rather than the
// same-origin window bridge the projector screen uses.

import { getRelaySockets, joinRoom, type DataPayload, type Room } from 'trystero/nostr';
import {
  parsePairHash,
  REMOTE_APP_ID,
  type RemoteCommand,
  type RemoteSnapshot,
} from './protocol';
import { rlog } from './log';
import type { IceServer } from './turn';

export type ClientStatus = 'connecting' | 'connected' | 'reconnecting' | 'error';

/** How long to wait before retrying after the link drops. */
const RECONNECT_MS = 2000;

/**
 * Flag the feed stale after this long with no snapshot. The host beats every
 * 4s, so ~2 missed beats means the link is genuinely frozen rather than just
 * quiet — the operator needs to know the numbers on screen may be stale.
 */
const STALE_MS = 9000;

export class RemoteClient {
  status = $state<ClientStatus>('connecting');
  /** The most recent state the host pushed, or null before the first arrives. */
  snapshot = $state<RemoteSnapshot | null>(null);
  /** True when connected but no snapshot has arrived for a while (frozen link). */
  stale = $state(false);
  error = $state('');

  private room: Room | null = null;
  private sendCmd: ((cmd: RemoteCommand) => Promise<void>) | null = null;
  private roomId = '';
  private secret = '';
  /** TURN ICE servers the QR carried, or [] for direct P2P + STUN only. */
  private iceServers: IceServer[] = [];
  private reconnectTimer = 0;
  private staleTimer = 0;
  private lastSnapshotAt = 0;
  private started = false;
  /** True once we've joined at least once — so the first connect skips healing. */
  private hasJoined = false;

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
    this.secret = pair.secret;
    this.iceServers = pair.iceServers ?? [];
    rlog('client', 'start; turn servers from QR:', this.iceServers.length);
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

  private connect(): void {
    this.teardownRoom();
    // On a *reconnect*, force the signaling relays to re-establish first. As on
    // the host, trystero caches relay sockets at module scope, so one that went
    // dead while we were away (a network change — a VPN toggling is the usual
    // culprit) would otherwise be reused and keep us from ever finding the host.
    // Skipped on the very first attempt, when the sockets are fresh anyway.
    if (this.hasJoined) this.refreshSignaling();
    // Keep whatever we last showed on screen while we reconnect, so the operator
    // isn't left staring at a blank remote mid-show.
    this.status = this.snapshot ? 'reconnecting' : 'connecting';
    try {
      const room = joinRoom(
        { appId: REMOTE_APP_ID, password: this.secret, turnConfig: this.iceServers as RTCIceServer[] },
        this.roomId,
      );
      this.room = room;
      this.hasJoined = true;
      rlog('client', 'joined room; turn servers:', this.iceServers.length);

      // A superseded room can still fire callbacks after we've moved on: its
      // `leave()` is async (it lingers ~100ms destroying peers), and an old
      // peer's connection may close or error at any point after we've replaced
      // it — which happens whenever a phone browser is backgrounded and
      // reopened. Those stale callbacks must not touch the live state, or the
      // dead room's onPeerLeave flips us back to 'reconnecting' and schedules a
      // reconnect that tears down the fresh, working room — a loop that
      // "connects for a split second, then drops" forever. Gate every handler
      // on this room still being the current one.
      const isCurrent = () => room === this.room;

      // The payloads are plain JSON; trystero's DataPayload constraint wants an
      // index signature our named types don't carry, so cast at the boundary.
      const state = room.makeAction('state');
      state.onMessage = (data) => {
        if (!isCurrent()) return;
        this.snapshot = data as unknown as RemoteSnapshot;
        this.status = 'connected';
        this.lastSnapshotAt = Date.now();
        this.stale = false;
      };

      const cmd = room.makeAction('cmd');
      this.sendCmd = (c) => cmd.send(c as unknown as DataPayload);

      room.onPeerJoin = () => {
        if (!isCurrent()) return;
        this.status = 'connected';
        rlog('client', 'peer join');
      };
      room.onPeerLeave = () => {
        if (!isCurrent()) return;
        if (Object.keys(room.getPeers()).length === 0) {
          this.status = 'reconnecting';
          rlog('client', 'peer leave; reconnecting');
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      rlog('client', 'join failed:', this.error);
      this.scheduleReconnect();
    }
  }

  /**
   * Force the signaling relays to reconnect — the phone-side twin of the host's
   * method. trystero reuses module-cached relay sockets across rejoins, so one
   * that died on a network change must be closed to be re-established. Relays
   * carry only connection setup, never live session data, so this is safe.
   */
  private refreshSignaling(): void {
    let sockets: Record<string, WebSocket> = {};
    try {
      sockets = getRelaySockets() as Record<string, WebSocket>;
    } catch {
      return;
    }
    rlog('client', 'refreshSignaling;', Object.keys(sockets).length, 'relays');
    for (const socket of Object.values(sockets)) {
      try {
        socket.close();
      } catch {
        // Already closing — nothing to do.
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = 0;
      this.connect();
    }, RECONNECT_MS) as unknown as number;
  }

  /** Fire a command at the host. No-op until a channel is up. */
  send(cmd: RemoteCommand): void {
    if (this.sendCmd) void this.sendCmd(cmd);
  }

  private teardownRoom(): void {
    const room = this.room;
    this.room = null;
    this.sendCmd = null;
    if (room) void room.leave();
  }
}

export const remoteClient = new RemoteClient();
