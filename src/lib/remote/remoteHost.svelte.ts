// The host side of the phone remote: it lives inside the main player, joins a
// trystero room when the operator switches the remote on, mirrors the player's
// live state to any connected phones, and applies the commands they send back.
//
// Modelled on `trello.svelte.ts` (a persisted-settings runes singleton) and on
// the screen bridge in `screen/screen.ts` (a push/subscribe channel to another
// context). trystero replaces `window.opener` as the transport, because the
// phone is a different device.
//
// Off by default, and off every time the app starts: nothing here contacts a
// relay until `enable()` is called from the toolbar. Only the pairing identity
// (secret + room id) is persisted, so the same QR can be reused across sessions
// — the *connection* is always an explicit, per-session choice.

import { joinRoom, type DataPayload, type Room } from 'trystero/nostr';
import { app } from '../state/project.svelte';
import {
  applyCommand,
  pairUrl as buildPairUrl,
  randomSecret,
  REMOTE_APP_ID,
  type RemoteHostActions,
  type RemoteSnapshot,
} from './protocol';

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

interface StoredPair {
  secret: string;
  roomId: string;
}

function loadPair(): StoredPair | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPair>;
    if (typeof parsed.secret === 'string' && typeof parsed.roomId === 'string' && parsed.secret && parsed.roomId) {
      return { secret: parsed.secret, roomId: parsed.roomId };
    }
    return null;
  } catch {
    // Corrupt or unavailable storage must never stop the player from opening.
    return null;
  }
}

export type HostStatus = 'off' | 'waiting' | 'connected';

export class RemoteHost {
  /** Whether the remote is switched on this session. Never persisted true. */
  enabled = $state(false);
  /** The pairing secret (trystero password) and room — the QR encodes these. */
  secret = $state('');
  roomId = $state('');
  /** Phones currently connected. */
  peerCount = $state(0);
  status = $state<HostStatus>('off');
  lastError = $state('');
  /** Whether the pairing panel (QR + status) is open. UI state, not persisted. */
  panelOpen = $state(false);

  private room: Room | null = null;
  private sendState: ((snapshot: RemoteSnapshot) => Promise<void>) | null = null;
  private started = false;
  private lastSnapshot: RemoteSnapshot | null = null;
  private lastSentAt = 0;
  private flushTimer = 0;
  private heartbeatTimer = 0;

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

  /** The URL the QR encodes, or '' before a pairing identity exists. */
  get pairUrl(): string {
    if (!this.secret || !this.roomId) return '';
    return buildPairUrl(location.origin, { roomId: this.roomId, secret: this.secret });
  }

  /**
   * Load (or mint) the pairing identity. Deliberately does *not* connect —
   * called once at app boot, it must leave the remote fully offline.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    const pair = loadPair();
    if (pair) {
      this.secret = pair.secret;
      this.roomId = pair.roomId;
    } else {
      this.mintPair();
    }
  }

  toggleEnabled(): void {
    if (this.enabled) this.disable();
    else this.enable();
  }

  /** Switch the remote on — the first point at which we contact any relay. */
  enable(): void {
    if (this.enabled) return;
    if (!this.secret || !this.roomId) this.mintPair();
    this.enabled = true;
    this.connect();
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.disconnect();
  }

  /**
   * Mint a fresh secret and room, invalidating any QR already scanned: a phone
   * paired on the old secret can no longer join. Reconnects under the new
   * identity if the remote was on.
   */
  regenerate(): void {
    const wasOn = this.enabled;
    if (wasOn) this.disconnect();
    this.mintPair();
    if (wasOn) this.connect();
  }

  private mintPair(): void {
    this.secret = randomSecret(32);
    this.roomId = randomSecret(16);
    this.persist();
  }

  private connect(): void {
    if (this.room || !this.enabled) return;
    this.status = 'waiting';
    this.lastError = '';
    try {
      const room = joinRoom({ appId: REMOTE_APP_ID, password: this.secret }, this.roomId);
      this.room = room;

      // trystero's payload type wants a JSON index signature our snapshot type
      // doesn't carry; the value is plain JSON, so cast at the boundary.
      const state = room.makeAction('state');
      this.sendState = (snapshot) => state.send(snapshot as unknown as DataPayload);

      const cmd = room.makeAction('cmd');
      cmd.onMessage = (data) => {
        // Untrusted: parseCommand inside applyCommand is the gate.
        applyCommand(this.actions, data);
      };

      room.onPeerJoin = () => {
        this.peerCount = Object.keys(room.getPeers()).length;
        this.status = 'connected';
        // Catch the phone up on the current state at once, rather than waiting
        // for the next change to push one.
        if (this.lastSnapshot) void state.send(this.lastSnapshot as unknown as DataPayload);
      };
      room.onPeerLeave = () => {
        this.peerCount = Object.keys(room.getPeers()).length;
        if (this.peerCount === 0) this.status = 'waiting';
      };

      this.heartbeatTimer = setInterval(() => {
        if (this.peerCount > 0 && this.lastSnapshot) this.flush();
      }, HEARTBEAT_MS) as unknown as number;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.status = 'off';
      this.room = null;
      this.sendState = null;
    }
  }

  private disconnect(): void {
    this.peerCount = 0;
    this.status = 'off';
    this.sendState = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = 0;
    }
    const room = this.room;
    this.room = null;
    if (room) void room.leave();
  }

  /**
   * Hand in the latest mirrored state. Called from RemoteBridge whenever the
   * player's state changes — which can be every animation frame while audio
   * plays — so the actual network send is throttled: send immediately if enough
   * time has passed, otherwise coalesce to a single trailing send.
   */
  pushState(snapshot: RemoteSnapshot): void {
    this.lastSnapshot = snapshot;
    if (!this.sendState || this.peerCount === 0) return;
    const dt = Date.now() - this.lastSentAt;
    if (dt >= PUSH_THROTTLE_MS) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), PUSH_THROTTLE_MS - dt) as unknown as number;
    }
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }
    this.lastSentAt = Date.now();
    if (this.sendState && this.lastSnapshot && this.peerCount > 0) {
      void this.sendState(this.lastSnapshot);
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ secret: this.secret, roomId: this.roomId }));
    } catch {
      // Private-mode storage failures are not worth interrupting a show for.
    }
  }
}

export const remoteHost = new RemoteHost();
