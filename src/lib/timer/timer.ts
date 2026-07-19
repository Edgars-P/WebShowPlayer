// Global countdown timer: the shape of its state, plus the formatting and
// colour helpers the toolbar and the projector screen both render it with.
// The screen window that displays it lives in ../screen/screen.

export interface TimerView {
  duration: number;
  remaining: number;
  running: boolean;
  finished: boolean;
  /**
   * Wall-clock timestamp (`Date.now()` epoch ms) at which the countdown reaches
   * zero, or null when not running. Opener and pop-out share a machine clock, so
   * the pop-out can derive a smooth, always-accurate `remaining` from this each
   * animation frame instead of depending on how often the (often background-
   * throttled) opener pushes snapshots. Ignored unless `running` is true.
   */
  endsAt?: number | null;
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

export const EMPTY_TIMER: TimerView = {
  duration: 0,
  remaining: 0,
  running: false,
  finished: false,
};
