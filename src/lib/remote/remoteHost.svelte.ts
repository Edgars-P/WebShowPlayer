// The host side of the phone remote: it lives inside the main player, opens a
// WebSocket to this site's own Cloudflare Worker when the operator switches the
// remote on, mirrors the player's live state to any connected phones through the
// per-room Durable Object, and applies the commands they send back.
//
// Modelled on `trello.svelte.ts` (a persisted-settings runes singleton) and on
// the screen bridge in `screen/screen.ts` (a push/subscribe channel to another
// context). The Worker + DO replace `window.opener` as the transport, because
// the phone is a different device — and they replace the old WebRTC/trystero
// path, which was too unreliable in the field.
//
// Off by default, and off every time the app starts: nothing here contacts the
// Worker until `enable()` is called from the toolbar. Only the pairing identity
// (the shared `hostKey` and the room id) is persisted, so the same QR can be
// reused across sessions — the *connection* is always an explicit, per-session
// choice.

import { app } from '../state/project.svelte';
import {
  applyCommand,
  pairUrl as buildPairUrl,
  type HostFrame,
  type HostInbound,
  type RemoteHostActions,
  type RemoteSnapshot,
} from './protocol';
import { deriveControllerKey } from './derive';
import { rlog } from './log';

const STORAGE_KEY = 'showplayer.remote';

/** How often, at most, to push state to phones while it's changing. */
const PUSH_THROTTLE_MS = 200;

/**
 * Re-send the latest snapshot this often even when nothing changes. The bridge
 * only pushes on change, so without this a quiet show and a silently-dropped
 * link look identical to a phone. A steady beat lets the phone tell them apart
 * (and flag a stalled feed) at the cost of one tiny message every few seconds.
 */
const HEARTBEAT_MS = 4000;

/** How long to wait before reopening the socket after it drops. */
const RECONNECT_MS = 2000;

interface StoredPair {
  /** Shared secret; also the Worker's HOST_KEY. Authenticates the host socket. */
  hostKey: string;
  /** Random per-player room id (a UUID); names the Durable Object. */
  roomId: string;
}

function loadPair(): StoredPair | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPair>;
    if (typeof parsed.hostKey === 'string' && typeof parsed.roomId === 'string' && parsed.roomId) {
      return { hostKey: parsed.hostKey, roomId: parsed.roomId };
    }
    return null;
  } catch {
    // Corrupt or unavailable storage must never stop the player from opening.
    return null;
  }
}

/** The `wss://…/api/remote/<room>` URL for this site's own origin. */
function socketUrl(roomId: string, hostKey: string): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const room = encodeURIComponent(roomId);
  const key = encodeURIComponent(hostKey);
  return `${scheme}//${location.host}/api/remote/${room}?role=host&key=${key}`;
}

export type HostStatus = 'off' | 'waiting' | 'connected';

export class RemoteHost {
  /** Whether the remote is switched on this session. Never persisted true. */
  enabled = $state(false);
  /** The shared host secret — also set as the Worker's HOST_KEY. */
  hostKey = $state('');
  /** The room id the DO is named by. The QR encodes this plus a derived key. */
  roomId = $state('');
  /** SHA-256(hostKey:roomId), derived async; the phone's credential in the QR. */
  controllerKey = $state('');
  /** Phones currently connected. */
  peerCount = $state(0);
  status = $state<HostStatus>('off');
  lastError = $state('');
  /** Whether the pairing panel (QR + status) is open. UI state, not persisted. */
  panelOpen = $state(false);

  private socket: WebSocket | null = null;
  private started = false;
  private lastSnapshot: RemoteSnapshot | null = null;
  private lastSentAt = 0;
  private flushTimer = 0;
  private heartbeatTimer = 0;
  private reconnectTimer = 0;
  /** Bumps every (re)connect so a superseded socket's late events are ignored. */
  private epoch = 0;

  /**
   * The whitelist mapped onto `app`. Every one of these is an existing method —
   * the remote adds no new engine behaviour, it only reaches the same controls
   * the operator has. `activateCue` resolves the id across all tabs (so a phone
   * can fire a cue on any tab without switching to it first) and drives it
   * exactly as a click would.
   */
  private actions: RemoteHostActions = {
    activateCue: (id) => {
      const cue = app.activeDoc?.findCue(id);
      if (cue) app.activate(cue);
    },
    setTab: (id) => {
      app.activeTabId = id;
    },
    selectDoc: (id) => app.selectDoc(id),
    stopAll: (fade) => app.stopAllAudio(fade),
    timerPause: () => app.pauseTimer(),
    timerResume: () => app.resumeTimer(),
    timerClear: () => app.clearTimer(),
    videoPause: () => app.pauseVideo(),
    videoResume: () => app.resumeVideo(),
    videoClear: () => app.clearVideo(),
    openScreen: () => app.openScreenWindow(),
    setMaster: (v) => app.setMasterVolume(v),
  };

  /** Whether a usable host key is configured — required to pair or connect. */
  get configured(): boolean {
    return !!this.hostKey.trim();
  }

  /**
   * The URL the QR encodes, or '' before the controller key has been derived.
   * Reactive: the QR re-renders once `controllerKey` resolves and whenever the
   * room id changes.
   */
  get pairUrl(): string {
    if (!this.roomId || !this.controllerKey) return '';
    return buildPairUrl(location.origin, { roomId: this.roomId, key: this.controllerKey });
  }

  /**
   * Load the pairing identity. Deliberately does *not* connect — called once at
   * app boot, it must leave the remote fully offline. A room id is minted on
   * first use so the QR is stable; the host key is supplied by the operator.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    const pair = loadPair();
    if (pair) {
      this.hostKey = pair.hostKey;
      this.roomId = pair.roomId;
    }
    if (!this.roomId) this.roomId = crypto.randomUUID();
    this.persist();
    void this.refreshControllerKey();
  }

  /** Store a pasted host key, re-derive the QR, and reconnect if we were on. */
  setHostKey(key: string): void {
    const wasOn = this.enabled;
    if (wasOn) this.disconnect();
    this.hostKey = key.trim();
    this.persist();
    void this.refreshControllerKey();
    if (wasOn && this.configured) this.connect();
    else if (wasOn) this.enabled = false;
  }

  toggleEnabled(): void {
    if (this.enabled) this.disable();
    else this.enable();
  }

  /** Switch the remote on — the first point at which we contact the Worker. */
  enable(): void {
    if (this.enabled) return;
    if (!this.configured) {
      this.lastError = 'Set a host key first.';
      return;
    }
    this.enabled = true;
    rlog('host', 'enable');
    this.connect();
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    rlog('host', 'disable');
    this.disconnect();
  }

  /**
   * Mint a fresh room id, invalidating any QR already scanned: a phone paired on
   * the old room can no longer reach this player. Reconnects under the new room
   * if the remote was on.
   */
  regenerate(): void {
    const wasOn = this.enabled;
    if (wasOn) this.disconnect();
    this.roomId = crypto.randomUUID();
    this.persist();
    void this.refreshControllerKey();
    if (wasOn) this.connect();
  }

  /** Re-derive the phone's controller key from the current host key + room. */
  private async refreshControllerKey(): Promise<void> {
    if (!this.configured || !this.roomId) {
      this.controllerKey = '';
      return;
    }
    const key = this.roomId;
    const derived = await deriveControllerKey(this.hostKey, this.roomId);
    // Guard against a stale derivation landing after the room changed again.
    if (key === this.roomId) this.controllerKey = derived;
  }

  private connect(): void {
    if (this.socket || !this.enabled || !this.configured) return;
    this.status = 'waiting';
    this.lastError = '';
    const epoch = ++this.epoch;
    const isCurrent = () => epoch === this.epoch;
    try {
      const socket = new WebSocket(socketUrl(this.roomId, this.hostKey));
      this.socket = socket;
      rlog('host', 'connecting room', this.roomId);

      socket.onopen = () => {
        if (!isCurrent()) return;
        rlog('host', 'socket open');
        // Push the latest state at once so a phone that's already waiting gets
        // caught up without waiting for the next change.
        if (this.lastSnapshot) this.flush();
      };

      socket.onmessage = (ev) => {
        if (!isCurrent()) return;
        this.onMessage(ev.data);
      };

      socket.onclose = () => {
        if (!isCurrent()) return;
        rlog('host', 'socket closed');
        this.socket = null;
        this.peerCount = 0;
        this.status = 'waiting';
        if (this.enabled) this.scheduleReconnect();
      };

      socket.onerror = () => {
        if (!isCurrent()) return;
        this.lastError = 'Connection error.';
        rlog('host', 'socket error');
      };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.status = 'off';
      this.socket = null;
      rlog('host', 'connect failed:', this.lastError);
      if (this.enabled) this.scheduleReconnect();
    }
  }

  private onMessage(raw: unknown): void {
    let msg: HostInbound;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : '') as HostInbound;
    } catch {
      return;
    }
    if (msg.k === 'peers') {
      this.peerCount = msg.n;
      this.status = msg.n > 0 ? 'connected' : 'waiting';
      rlog('host', 'peers:', msg.n);
      if (msg.n > 0 && this.lastSnapshot) this.flush();
    } else if (msg.k === 'cmd') {
      // Untrusted: parseCommand inside applyCommand is the gate.
      applyCommand(this.actions, msg.d);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = 0;
      if (this.enabled) this.connect();
    }, RECONNECT_MS) as unknown as number;
  }

  private disconnect(): void {
    this.epoch++; // Orphan the current socket's callbacks.
    this.peerCount = 0;
    this.status = 'off';
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = 0;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }
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

  /**
   * Force a reconnect without changing the pairing — the operator's "Reconnect"
   * button. Cheap now that the transport is a single socket: close it and let
   * the reconnect path bring a fresh one up.
   */
  reconnect(): void {
    if (!this.enabled) return;
    rlog('host', 'manual reconnect');
    this.epoch++;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    }
    this.connect();
  }

  /**
   * Hand in the latest mirrored state. Called from RemoteBridge whenever the
   * player's state changes — which can be every animation frame while audio
   * plays — so the actual network send is throttled: send immediately if enough
   * time has passed, otherwise coalesce to a single trailing send.
   */
  pushState(snapshot: RemoteSnapshot): void {
    this.lastSnapshot = snapshot;
    this.ensureHeartbeat();
    if (this.peerCount === 0 || !this.isOpen()) return;
    const dt = Date.now() - this.lastSentAt;
    if (dt >= PUSH_THROTTLE_MS) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), PUSH_THROTTLE_MS - dt) as unknown as number;
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.peerCount > 0 && this.lastSnapshot && this.isOpen()) this.flush();
    }, HEARTBEAT_MS) as unknown as number;
  }

  private isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }
    if (!this.isOpen() || !this.lastSnapshot || this.peerCount === 0) return;
    this.lastSentAt = Date.now();
    const frame: HostFrame = { k: 'state', d: this.lastSnapshot };
    try {
      this.socket!.send(JSON.stringify(frame));
    } catch {
      // A socket that fails the send is about to close; the reconnect path handles it.
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ hostKey: this.hostKey, roomId: this.roomId }));
    } catch {
      // Private-mode storage failures are not worth interrupting a show for.
    }
  }
}

export const remoteHost = new RemoteHost();
