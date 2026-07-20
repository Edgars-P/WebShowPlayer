// The projector pop-out: one always-on external screen the whole app shares.
//
// It shows two things, and only ever one at a time — a countdown timer, and a
// video clip. Video wins whenever it holds the slot, on the theory that if
// you've put a picture on the screen you meant the audience to look at it, not
// at the clock.
//
// This module owns the window handle and the bridge the page reads its state
// from; the timer maths lives in ../timer/timer, and the page itself is
// ScreenPage.svelte (mounted at screen.html).

import { EMPTY_TIMER, type TimerView } from '../timer/timer';
import type { VideoFit } from '../types';

/** The single global video slot, as the screen page sees it. */
export interface VideoView {
  /**
   * The clip currently on screen, or null when the slot is empty.
   *
   * The File is handed over by reference rather than as a URL: object URLs are
   * owned by the document that created them, and the page — which may be opened,
   * closed, and reopened under a running slot — is the one that knows when it's
   * done with the picture. It mints its own URL and revokes it on teardown.
   */
  file: File | null;
  /**
   * Bumped every time a new clip is loaded into the slot. The page rebuilds its
   * object URL when this changes, so re-playing the *same* File still restarts
   * the clip, and a late `ended` report from a clip that has already been
   * replaced can be recognised as stale and ignored.
   */
  generation: number;
  playing: boolean;
  loop: boolean;
  muted: boolean;
  /** 0..1, the clip's own audio track. Independent of the Web Audio master. */
  volume: number;
  fit: VideoFit;
  /**
   * Where the opener wants the clip moved to, in seconds.
   *
   * The position itself can't be the signal — scrubbing back to a spot the clip
   * has already passed would be a no-op — so the token is what the page watches,
   * and it's bumped on every request. Monotonic for the life of the app: a page
   * that attaches mid-show adopts whatever token it finds without seeking, so a
   * stale request can't yank a running clip.
   */
  seekToken: number;
  seekPosition: number;
}

export interface ScreenView {
  timer: TimerView;
  video: VideoView;
}

/**
 * What the clip is actually doing, as measured off the media element.
 *
 * The opener decides *what* plays; only the page can observe how that is going,
 * so it reports back and the opener holds the result as the state of record —
 * that's what the launchpad tile paints itself from.
 */
export interface VideoStatus {
  /** Seconds into the clip. */
  position: number;
  /** Length of the clip in seconds, or 0 before metadata has arrived. */
  duration: number;
  /** Whether the element is genuinely running, as opposed to asked to run. */
  playing: boolean;
}

export const IDLE_STATUS: VideoStatus = { position: 0, duration: 0, playing: false };

export interface ScreenBridge {
  getSnapshot(): ScreenView;
  /** Subscribe to live updates; returns an unsubscribe function. */
  subscribe(cb: (v: ScreenView) => void): () => void;
  /**
   * The page reporting that the clip played to its end. Only the page knows
   * this — it owns the media element — and the opener needs it to fire the
   * video cue's onEnd triggers.
   */
  videoEnded(generation: number): void;
  /** Live playback readout, pushed per frame while a clip runs. */
  videoProgress(generation: number, status: VideoStatus): void;
  /** The page going away, taking any picture with it. */
  screenClosing(): void;
}

export const EMPTY_VIDEO: VideoView = {
  file: null,
  generation: 0,
  playing: false,
  loop: false,
  muted: false,
  volume: 1,
  fit: 'contain',
  seekToken: 0,
  seekPosition: 0,
};

const EMPTY_VIEW: ScreenView = { timer: EMPTY_TIMER, video: EMPTY_VIDEO };

/** What the opener wants to hear back from the screen. */
export interface ScreenReports {
  videoEnded(generation: number): void;
  videoProgress(generation: number, status: VideoStatus): void;
  screenClosing(): void;
  /**
   * A screen page attached or detached. Video cues are inert without one, so
   * this has to be a push rather than something the app polls for.
   */
  livenessChanged(live: boolean): void;
}

export class ScreenWindow {
  private win: Window | null = null;
  private lastView: ScreenView = EMPTY_VIEW;
  private listeners = new Set<(v: ScreenView) => void>();

  constructor(reports: ScreenReports) {
    // Expose the bridge on *our own* window, not the popup's. `window.open(url)`
    // navigates the popup to a fresh document (and thus a fresh global `window`),
    // which would wipe out any property set on its window handle right after
    // open() returns. This window never navigates, so it's stable — the popup
    // reads it back via `window.opener` once its own script starts.
    const bridge: ScreenBridge = {
      getSnapshot: () => this.lastView,
      subscribe: (cb) => {
        this.listeners.add(cb);
        reports.livenessChanged(true);
        return () => {
          this.listeners.delete(cb);
          reports.livenessChanged(this.listeners.size > 0);
        };
      },
      videoEnded: (generation) => reports.videoEnded(generation),
      videoProgress: (generation, status) => reports.videoProgress(generation, status),
      screenClosing: () => reports.screenClosing(),
    };
    (window as unknown as { __screenBridge: ScreenBridge }).__screenBridge = bridge;
  }

  /**
   * Whether a screen page is attached and listening.
   *
   * Deliberately *not* "do we hold a window handle": after the opener reloads,
   * the popup outlives it and re-attaches to the new bridge, so there's a real
   * screen with no handle to it. A live subscription is the truthful signal,
   * and unlike a window handle it changes by event rather than needing a poll.
   */
  isLive(): boolean {
    return this.listeners.size > 0;
  }

  private hasWindow(): boolean {
    return !!this.win && !this.win.closed;
  }

  /** Open (or focus) the pop-out. Returns false if the popup was blocked. */
  open(): boolean {
    if (this.hasWindow()) {
      this.win!.focus();
      return true;
    }
    // Named target: if a popup from a previous life of this page is still up,
    // this adopts it (reloading it) rather than opening a second screen.
    const win = window.open('/screen.html', 'show-screen', 'width=900,height=520');
    if (!win) return false;
    this.win = win;
    return true;
  }

  render(v: ScreenView): void {
    this.lastView = v;
    for (const cb of this.listeners) cb(v);
  }

  close(): void {
    if (this.hasWindow()) this.win!.close();
    this.win = null;
    this.listeners.clear();
  }
}
