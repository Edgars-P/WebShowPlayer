// The wire contract shared by the host (the main player) and the phone remote
// page. Everything here is plain data and pure functions — deliberately free of
// Svelte runes and the DOM — so both sides type-check against one definition and
// the logic is unit-testable in the `node` vitest environment, exactly like
// `timer.ts` and `cueFill.ts`.
//
// Security note: there is no cipher here. These messages travel over a `wss`
// WebSocket to our Cloudflare Worker, which is TLS-encrypted end to end, and the
// Worker authenticates both ends before relaying a byte (the host with the
// shared `hostKey`, the phone with the derived controller key in the QR — see
// `derive.ts`). A second application-layer cipher would be redundant with TLS,
// so we don't add one. What this module *does* enforce is the command whitelist:
// the host only ever acts on a message that parses into one of the fixed
// `RemoteCommand` shapes below.

import type { PlaybackState } from '../types';

/** Bumped only if the wire shape changes incompatibly. */
export const REMOTE_PROTOCOL = 1;

// ---- State the phone renders (host → phone) -------------------------------

/**
 * The small glyph a cue's subtitle leads with at rest (never shown while a
 * remaining-time countdown has replaced it) — a key rather than a rendered
 * icon, since the wire only carries data: the host and the phone each pick
 * their own icon for it locally.
 */
export type SubtitleIcon = 'proxy' | 'timer' | 'video' | 'globalAll' | 'globalOne' | null;

export interface RemoteCue {
  id: string;
  name: string;
  color: string;
  state: PlaybackState;
  missing: boolean;
  pending: boolean;
  unavailable: boolean;
  /** Second line: the cue's kind at rest, or its remaining time while running. */
  subtitle: string;
  subtitleIcon: SubtitleIcon;
  row: number;
  col: number;
}

export interface RemoteTab {
  id: string;
  name: string;
  cues: RemoteCue[];
}

export interface RemoteDoc {
  id: string;
  title: string;
}

export interface RemoteTimer {
  active: boolean;
  running: boolean;
  finished: boolean;
  /** Seconds left. */
  remaining: number;
}

export interface RemoteVideo {
  active: boolean;
  playing: boolean;
  /** Seconds left, or 0 when unknown. */
  remaining: number;
}

export interface RemoteSnapshot {
  v: number;
  docs: RemoteDoc[];
  activeDocId: string;
  tabs: RemoteTab[];
  activeTabId: string;
  timer: RemoteTimer;
  video: RemoteVideo;
  screenLive: boolean;
  anyPlaying: boolean;
  master: number;
}

/** What `buildSnapshot` needs — plain data the host reads off `app`. */
export interface SnapshotInput {
  docs: RemoteDoc[];
  activeDocId: string;
  activeTabId: string;
  master: number;
  screenLive: boolean;
  anyPlaying: boolean;
  timer: { duration: number; remaining: number; running: boolean; finished: boolean };
  video: { active: boolean; playing: boolean; remaining: number };
  /** Cues per tab, in whatever order — `buildSnapshot` sorts them by cell. */
  tabs: { id: string; name: string; cues: RemoteCue[] }[];
}

/**
 * Fold the host's live state into the compact snapshot the phone renders. Pure:
 * the caller (RemoteBridge) resolves each cue's display and subtitle off `app`
 * and hands the result in, so this stays testable without runes or the DOM.
 *
 * The one derivation worth having here rather than at the call site is cue
 * order: tiles are laid out on a grid by row/col, and the phone shows them as a
 * vertical stack, so they're sorted reading-order (row then column).
 */
export function buildSnapshot(input: SnapshotInput): RemoteSnapshot {
  return {
    v: REMOTE_PROTOCOL,
    docs: input.docs.map((d) => ({ id: d.id, title: d.title })),
    activeDocId: input.activeDocId,
    activeTabId: input.activeTabId,
    tabs: input.tabs.map((t) => ({
      id: t.id,
      name: t.name,
      cues: [...t.cues].sort((a, b) => a.row - b.row || a.col - b.col),
    })),
    timer: {
      active: input.timer.duration > 0 || input.timer.finished,
      running: input.timer.running,
      finished: input.timer.finished,
      remaining: input.timer.remaining,
    },
    video: {
      active: input.video.active,
      playing: input.video.playing,
      remaining: input.video.remaining,
    },
    screenLive: input.screenLive,
    anyPlaying: input.anyPlaying,
    master: input.master,
  };
}

// ---- Transport envelope (player ⇄ Durable Object ⇄ phone) -----------------

// Every WebSocket frame is one JSON object tagged by `k`. The DO relays the
// host's `state` to controllers and a controller's `cmd` to the host verbatim,
// and injects its own `peers` count toward hosts. Received `d` is untrusted and
// re-validated on arrival (commands through `parseCommand`).

/** Sent by the player. `state` is relayed to every controller. */
export type HostFrame = { k: 'state'; d: RemoteSnapshot };
/** Sent by a phone. `cmd` is relayed to the host. */
export type ControllerFrame = { k: 'cmd'; d: RemoteCommand };
/** What the player receives: a relayed command, or the DO's device count. */
export type HostInbound = { k: 'cmd'; d: unknown } | { k: 'peers'; n: number };
/** What a phone receives: a relayed state snapshot. */
export type ControllerInbound = { k: 'state'; d: unknown };

// ---- Commands the phone may send (phone → host) ---------------------------

/**
 * The whitelist. This is the entire vocabulary the host understands from a
 * remote: control and view only. There is deliberately no way to edit a cue,
 * add or remove one, save, or touch the file system — a phone can drive the
 * show, not rewrite it.
 */
export type RemoteCommand =
  | { t: 'activateCue'; cueId: string }
  | { t: 'setTab'; tabId: string }
  | { t: 'selectDoc'; docId: string }
  | { t: 'stopAll'; fade: boolean }
  | { t: 'timerPause' }
  | { t: 'timerResume' }
  | { t: 'timerClear' }
  | { t: 'videoPause' }
  | { t: 'videoResume' }
  | { t: 'videoClear' }
  | { t: 'openScreen' }
  | { t: 'setMaster'; value: number };

/** The actions a `RemoteCommand` maps to. The host adapts these onto `app`. */
export interface RemoteHostActions {
  activateCue(cueId: string): void;
  setTab(tabId: string): void;
  selectDoc(docId: string): void;
  stopAll(fade: boolean): void;
  timerPause(): void;
  timerResume(): void;
  timerClear(): void;
  videoPause(): void;
  videoResume(): void;
  videoClear(): void;
  openScreen(): void;
  setMaster(value: number): void;
}

/**
 * Validate an untrusted inbound message into a `RemoteCommand`, or null if it
 * isn't one. Every field is checked: a message off the wire is attacker-shaped
 * until proven otherwise, and this is the gate that keeps a stray or hostile
 * payload from reaching `app`.
 */
export function parseCommand(raw: unknown): RemoteCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  switch (c.t) {
    case 'activateCue':
      return typeof c.cueId === 'string' ? { t: 'activateCue', cueId: c.cueId } : null;
    case 'setTab':
      return typeof c.tabId === 'string' ? { t: 'setTab', tabId: c.tabId } : null;
    case 'selectDoc':
      return typeof c.docId === 'string' ? { t: 'selectDoc', docId: c.docId } : null;
    case 'stopAll':
      return typeof c.fade === 'boolean' ? { t: 'stopAll', fade: c.fade } : null;
    case 'timerPause':
      return { t: 'timerPause' };
    case 'timerResume':
      return { t: 'timerResume' };
    case 'timerClear':
      return { t: 'timerClear' };
    case 'videoPause':
      return { t: 'videoPause' };
    case 'videoResume':
      return { t: 'videoResume' };
    case 'videoClear':
      return { t: 'videoClear' };
    case 'openScreen':
      return { t: 'openScreen' };
    case 'setMaster':
      return typeof c.value === 'number' && c.value >= 0 && c.value <= 1
        ? { t: 'setMaster', value: c.value }
        : null;
    default:
      return null;
  }
}

/**
 * Validate and dispatch one inbound message. Returns whether it was a valid
 * command — the host can count rejections. Never throws on bad input; an
 * unparseable message is simply ignored.
 */
export function applyCommand(host: RemoteHostActions, raw: unknown): boolean {
  const cmd = parseCommand(raw);
  if (!cmd) return false;
  switch (cmd.t) {
    case 'activateCue':
      host.activateCue(cmd.cueId);
      break;
    case 'setTab':
      host.setTab(cmd.tabId);
      break;
    case 'selectDoc':
      host.selectDoc(cmd.docId);
      break;
    case 'stopAll':
      host.stopAll(cmd.fade);
      break;
    case 'timerPause':
      host.timerPause();
      break;
    case 'timerResume':
      host.timerResume();
      break;
    case 'timerClear':
      host.timerClear();
      break;
    case 'videoPause':
      host.videoPause();
      break;
    case 'videoResume':
      host.videoResume();
      break;
    case 'videoClear':
      host.videoClear();
      break;
    case 'openScreen':
      host.openScreen();
      break;
    case 'setMaster':
      host.setMaster(cmd.value);
      break;
  }
  return true;
}

// ---- Pairing (room + controller key) --------------------------------------

/**
 * A URL-safe random string of `bytes` bytes (default 32 → 256 bits).
 * `getRandomValues` is a CSPRNG and needs no secure context, so this works the
 * same in the app, on the phone, and under vitest. Used to suggest a strong
 * `hostKey` for the operator to paste into both the player and the Worker.
 */
export function randomSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * What a phone needs to connect, read out of a pairing URL's hash fragment: the
 * room to join and the derived controller key that authenticates it. Neither is
 * the shared `hostKey` — the phone never receives that.
 */
export interface PairInfo {
  roomId: string;
  key: string;
}

/**
 * Read the pairing info out of a URL hash fragment (`#room=<id>&key=<derived>`),
 * or null if either part is missing. It lives in the *fragment* so the values
 * aren't sent to the static-asset server on page load; the phone's JS reads them
 * and opens the authenticated WebSocket itself.
 */
export function parsePairHash(hash: string): PairInfo | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(body);
  const roomId = params.get('room');
  const key = params.get('key');
  if (!roomId || !key) return null;
  return { roomId, key };
}

/** Build the pairing URL a QR encodes, from an origin and the pair info. */
export function pairUrl(origin: string, pair: PairInfo): string {
  return `${origin}/remote.html#room=${encodeURIComponent(pair.roomId)}&key=${encodeURIComponent(pair.key)}`;
}
