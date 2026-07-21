// The player's Cloudflare TURN credential minter, modelled on `trello.svelte.ts`
// (a persisted-settings runes singleton). The operator pastes a Cloudflare TURN
// key — a key id plus an API token — once; it is stored in localStorage exactly
// like the Trello credentials. The player uses the token to mint short-lived
// ICE-server credentials from Cloudflare and hands them to the phone *through
// the pairing QR* (see `remoteHost.pairUrl`). The API token therefore never
// leaves the computer: the phone only ever receives ready, expiring ICE-server
// entries, not the means to make more.
//
// Entirely optional. With no key configured this is inert, `iceServers` stays
// empty, and the remote falls back to direct P2P + STUN just as before.

import { rlog } from './log';
import {
  credentialsUrl,
  EMPTY_TURN_SETTINGS,
  parseIceServers,
  type IceServer,
  type TurnSettings,
} from './turn';

const STORAGE_KEY = 'showplayer.turn';
/** Ask Cloudflare for credentials valid this long (24h — comfortably a show). */
const TTL_SECONDS = 86_400;
/** Re-mint this long before they lapse, so a live QR always shows fresh creds. */
const REFRESH_MARGIN_MS = 30 * 60_000;

export function loadSettings(): TurnSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_TURN_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<TurnSettings>;
    return {
      keyId: typeof parsed.keyId === 'string' ? parsed.keyId : '',
      apiToken: typeof parsed.apiToken === 'string' ? parsed.apiToken : '',
    };
  } catch {
    // Corrupt or unavailable storage must never stop the player from opening.
    return { ...EMPTY_TURN_SETTINGS };
  }
}

export class TurnState {
  settings = $state<TurnSettings>({ ...EMPTY_TURN_SETTINGS });
  /** The current minted ICE servers, or [] when unconfigured / not yet minted. */
  iceServers = $state<IceServer[]>([]);
  /** Epoch ms the current credentials lapse; 0 when none are held. */
  expiresAt = $state(0);
  error = $state('');

  private started = false;
  private inflight: Promise<IceServer[]> | null = null;

  /** Whether a usable TURN key is present. */
  get configured(): boolean {
    return !!this.settings.keyId.trim() && !!this.settings.apiToken.trim();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.settings = loadSettings();
  }

  /** Persist a pasted key and mint credentials with it immediately. */
  save(next: TurnSettings): void {
    this.settings = { keyId: next.keyId.trim(), apiToken: next.apiToken.trim() };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // Private-mode storage failures are not worth interrupting a show for.
    }
    this.iceServers = [];
    this.expiresAt = 0;
    this.error = '';
    void this.ensure();
  }

  /** Forget the stored key entirely and drop any minted credentials. */
  clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // As above — storage being unavailable is not fatal.
    }
    this.settings = { ...EMPTY_TURN_SETTINGS };
    this.iceServers = [];
    this.expiresAt = 0;
    this.error = '';
  }

  /**
   * Ensure fresh credentials are cached, minting new ones if they are missing or
   * within the refresh margin of expiry. Never throws: on any failure it clears
   * `iceServers` and records the reason, leaving the remote to fall back to
   * direct P2P. Concurrent callers share one in-flight request.
   */
  async ensure(): Promise<IceServer[]> {
    if (!this.configured) return [];
    if (this.iceServers.length && Date.now() < this.expiresAt - REFRESH_MARGIN_MS) {
      return this.iceServers;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.mint().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async mint(): Promise<IceServer[]> {
    const { keyId, apiToken } = this.settings;
    try {
      const res = await fetch(credentialsUrl(keyId), {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      });
      if (!res.ok) throw new Error(`Cloudflare TURN responded ${res.status}`);
      const servers = parseIceServers(await res.json());
      if (!servers.length) throw new Error('no ICE servers in Cloudflare response');
      this.iceServers = servers;
      this.expiresAt = Date.now() + TTL_SECONDS * 1000;
      this.error = '';
      rlog('turn', 'minted credentials, servers:', servers.length);
      return servers;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.iceServers = [];
      this.expiresAt = 0;
      rlog('turn', 'mint failed:', this.error);
      return [];
    }
  }
}

export const turn = new TurnState();
