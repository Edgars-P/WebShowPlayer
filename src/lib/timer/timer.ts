// Global countdown timer: shared formatting/colour helpers plus a projector
// pop-out window. The pop-out is a real Svelte page (timer.html / TimerPage.svelte);
// this module just opens it and reads state back via a bridge object exposed on
// *this* (opener) window, which the popup reaches via `window.opener`.

export interface TimerView {
  duration: number;
  remaining: number;
  running: boolean;
  finished: boolean;
}

export interface TimerBridge {
  getSnapshot(): TimerView;
  /** Subscribe to live updates; returns an unsubscribe function. */
  subscribe(cb: (v: TimerView) => void): () => void;
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Fraction of the set duration still remaining, 0..1. */
export function remainingFraction(v: TimerView): number {
  if (v.duration <= 0) return 0;
  return Math.min(1, Math.max(0, v.remaining / v.duration));
}

/** Colour proportional to remaining time: green (full) → red (empty). */
export function timerColor(v: TimerView): string {
  if (v.finished) return '#ff2b2b';
  const hue = 120 * remainingFraction(v); // 120 = green, 0 = red
  return `hsl(${hue} 90% 55%)`;
}

const EMPTY_VIEW: TimerView = { duration: 0, remaining: 0, running: false, finished: false };

export class TimerWindow {
  private win: Window | null = null;
  private lastView: TimerView = EMPTY_VIEW;
  private listeners = new Set<(v: TimerView) => void>();

  constructor() {
    // Expose the bridge on *our own* window, not the popup's. `window.open(url)`
    // navigates the popup to a fresh document (and thus a fresh global `window`),
    // which would wipe out any property set on its window handle right after
    // open() returns. This window never navigates, so it's stable — the popup
    // reads it back via `window.opener` once its own script starts.
    const bridge: TimerBridge = {
      getSnapshot: () => this.lastView,
      subscribe: (cb) => {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
      },
    };
    (window as unknown as { __timerBridge: TimerBridge }).__timerBridge = bridge;
  }

  isOpen(): boolean {
    return !!this.win && !this.win.closed;
  }

  /** Open (or focus) the pop-out. Returns false if the popup was blocked. */
  open(): boolean {
    if (this.isOpen()) {
      this.win!.focus();
      return true;
    }
    const win = window.open('/timer.html', 'show-timer', 'width=900,height=520');
    if (!win) return false;
    this.win = win;
    return true;
  }

  render(v: TimerView): void {
    this.lastView = v;
    if (!this.isOpen()) return;
    for (const cb of this.listeners) cb(v);
  }

  close(): void {
    if (this.isOpen()) this.win!.close();
    this.win = null;
    this.listeners.clear();
  }
}
