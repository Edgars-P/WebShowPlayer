// Sidebar state: credentials, the polled list, and the poll loop itself.
//
// Read-only by design — nothing here writes back to Trello, so a mis-click
// during a show can't reorder anyone's board.

import {
  fetchFirstList,
  parseBoardRef,
  TrelloError,
  type TrelloList,
} from '../trello/client';

/** How often to re-fetch while the window is visible. */
export const POLL_MS = 15_000;
/** Slower loop after a 429, until a fetch succeeds again. */
export const BACKOFF_MS = 60_000;

const STORAGE_KEY = 'showplayer.trello';

export interface TrelloSettings {
  /** Whatever the user pasted — board URL, short link, or id. */
  board: string;
  key: string;
  token: string;
  /** Whether the sidebar is shown at all. */
  enabled: boolean;
}

const EMPTY: TrelloSettings = { board: '', key: '', token: '', enabled: false };

export function loadSettings(): TrelloSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<TrelloSettings>;
    return {
      board: typeof parsed.board === 'string' ? parsed.board : '',
      key: typeof parsed.key === 'string' ? parsed.key : '',
      token: typeof parsed.token === 'string' ? parsed.token : '',
      enabled: parsed.enabled === true,
    };
  } catch {
    // Corrupt or unavailable storage shouldn't stop the player from opening.
    return { ...EMPTY };
  }
}

/** URL that mints a never-expiring read-only token for the given API key. */
export function authorizeUrl(key: string): string {
  const q = new URLSearchParams({
    expiration: 'never',
    scope: 'read',
    response_type: 'token',
    name: 'Show Player',
    key,
  });
  return `https://trello.com/1/authorize?${q}`;
}

export class TrelloState {
  settings = $state<TrelloSettings>({ ...EMPTY });

  list = $state<TrelloList | null>(null);
  error = $state('');
  loading = $state(false);
  /** Epoch ms of the last successful fetch; 0 before the first one. */
  lastUpdated = $state(0);

  /** Collapsed to a thin rail, so the stage can have the width back. */
  collapsed = $state(false);
  /** Whether the credentials form is showing instead of the cards. */
  settingsOpen = $state(false);

  private timer = 0;
  private inflight: AbortController | null = null;
  private backingOff = false;
  private started = false;

  /** Board id/short link the current settings point at, or null if unusable. */
  get boardRef(): string | null {
    return parseBoardRef(this.settings.board);
  }

  /** Whether we have everything needed to make a request. */
  get configured(): boolean {
    return !!this.boardRef && !!this.settings.key.trim() && !!this.settings.token.trim();
  }

  /** Begin polling. Safe to call more than once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.settings = loadSettings();
    if (!this.settings.enabled) return;
    this.settingsOpen = !this.configured;
    this.schedule();
    void this.refresh();
  }

  /**
   * Show or hide the sidebar from the toolbar. Turning it on for the first time
   * lands on the credentials form, since there's nothing to poll yet.
   */
  toggleEnabled(): void {
    const enabled = !this.settings.enabled;
    this.saveSettings({ ...this.settings, enabled });
    if (enabled) {
      this.collapsed = false;
      if (!this.configured) this.settingsOpen = true;
    }
  }

  /** Persist the form and immediately re-fetch with the new credentials. */
  saveSettings(next: TrelloSettings): void {
    this.settings = { ...next };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // Private-mode storage failures are not worth interrupting a show for.
    }
    this.error = '';
    this.list = null;
    this.lastUpdated = 0;
    if (this.settings.enabled && this.configured) {
      this.settingsOpen = false;
      this.schedule();
      void this.refresh();
    } else {
      this.stopPolling();
    }
  }

  /** Forget the stored credentials entirely. */
  clearSettings(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // As above — storage being unavailable is not fatal.
    }
    this.settings = { ...EMPTY };
    this.list = null;
    this.error = '';
    this.lastUpdated = 0;
    this.stopPolling();
  }

  /** One fetch. Any in-flight request is abandoned first. */
  async refresh(): Promise<void> {
    const board = this.boardRef;
    if (!board || !this.configured) return;

    this.inflight?.abort();
    const ctl = new AbortController();
    this.inflight = ctl;
    this.loading = true;

    try {
      const list = await fetchFirstList(board, this.settings.key.trim(), this.settings.token.trim(), ctl.signal);
      if (ctl.signal.aborted) return;
      this.list = list;
      this.error = list ? '' : 'That board has no lists.';
      this.lastUpdated = Date.now();
      if (this.backingOff) {
        // Recovered from a 429 — go back to the normal cadence.
        this.backingOff = false;
        this.schedule();
      }
    } catch (err) {
      if (ctl.signal.aborted) return;
      if (err instanceof TrelloError) {
        this.error = err.message;
        if (err.isAuth) this.settingsOpen = true;
        if (err.status === 429 && !this.backingOff) {
          this.backingOff = true;
          this.schedule();
        }
      } else {
        // Offline, DNS, or a blocked request — all look the same from here.
        this.error = 'Could not reach Trello.';
      }
    } finally {
      if (this.inflight === ctl) {
        this.inflight = null;
        this.loading = false;
      }
    }
  }

  /**
   * Poll only while the window is visible. A show player sits open for hours,
   * and there's no point spending rate limit on a board nobody is looking at.
   */
  handleVisibility(hidden: boolean): void {
    if (!this.settings.enabled) return;
    if (hidden) {
      this.stopPolling();
    } else {
      this.schedule();
      void this.refresh();
    }
  }

  private schedule(): void {
    this.stopPolling();
    const every = this.backingOff ? BACKOFF_MS : POLL_MS;
    this.timer = setInterval(() => void this.refresh(), every) as unknown as number;
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = 0;
    }
  }
}

export const trello = new TrelloState();
