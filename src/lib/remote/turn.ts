// Pure helpers for Cloudflare TURN credentials — no runes, no DOM, no fetch — so
// both the player (which mints the credentials) and the phone (which receives
// them through the pairing QR) type-check against one definition, and the
// parsing/encoding is unit-testable in the `node` vitest environment, exactly
// like `protocol.ts`.
//
// Why TURN at all: the remote is a direct WebRTC link, which normally connects
// fine. But when a phone changes networks mid-show (a VPN toggles, it roams
// between APs), re-establishing the direct path can fail. A TURN relay gives
// the two peers a guaranteed meeting point to fall back on. It is entirely
// optional: with no key configured the remote behaves exactly as before.

/** An ICE server entry, shaped like the browser's `RTCIceServer`. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Cloudflare TURN key: an id plus the API token that mints credentials. */
export interface TurnSettings {
  keyId: string;
  apiToken: string;
}

export const EMPTY_TURN_SETTINGS: TurnSettings = { keyId: '', apiToken: '' };

/** The Cloudflare endpoint that mints short-lived ICE servers for a TURN key. */
export function credentialsUrl(keyId: string): string {
  return `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
}

/**
 * Normalise Cloudflare's `generate-ice-servers` response into ICE server
 * entries. Cloudflare has returned both an array of servers and, on older
 * endpoints, a single server object under `iceServers`; accept either, and keep
 * only well-formed entries so a malformed response degrades to "no TURN" rather
 * than a broken RTCConfiguration.
 */
export function parseIceServers(payload: unknown): IceServer[] {
  if (!payload || typeof payload !== 'object') return [];
  const raw = (payload as { iceServers?: unknown }).iceServers;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: IceServer[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { urls, username, credential } = item as Record<string, unknown>;
    if (typeof urls !== 'string' && !Array.isArray(urls)) continue;
    if (Array.isArray(urls) && !urls.every((u) => typeof u === 'string')) continue;
    const entry: IceServer = { urls: urls as string | string[] };
    if (typeof username === 'string') entry.username = username;
    if (typeof credential === 'string') entry.credential = credential;
    out.push(entry);
  }
  return out;
}

// URL-safe base64 of the ICE server JSON, so the credentials can ride in the
// pairing URL's hash fragment (and thus the QR) next to the room and secret.

export function encodeIceServers(servers: IceServer[]): string {
  const json = JSON.stringify(servers);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeIceServers(encoded: string): IceServer[] | null {
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(b64)));
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    // Re-validate: these arrived from an old QR / untrusted fragment.
    return parseIceServers({ iceServers: parsed });
  } catch {
    return null;
  }
}
