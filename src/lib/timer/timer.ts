// Global countdown timer: shared formatting/colour helpers plus a projector
// pop-out window that the main app drives directly (same-origin DOM access).

export interface TimerView {
  duration: number;
  remaining: number;
  running: boolean;
  finished: boolean;
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

const WINDOW_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Timer</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  #wrap {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #000;
    font-family: 'Segoe UI', system-ui, sans-serif;
  }
  #time {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    font-size: 26vw;
    line-height: 1;
    color: #fff;
    letter-spacing: 0.02em;
    /* Zoom + fade for appear/disappear. */
    opacity: 0;
    transform: scale(0.7);
    transition: opacity 0.45s ease, transform 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  #bar {
    position: fixed;
    left: 0;
    bottom: 0;
    height: 2vh;
    width: 0%;
    opacity: 0;
    transition: width 0.2s linear, opacity 0.45s ease, background 0.3s ease;
  }
  #wrap.running #time, #wrap.finished #time { opacity: 1; transform: scale(1); }
  #wrap.running #bar, #wrap.finished #bar { opacity: 1; }
  #wrap.clear #time { opacity: 0; transform: scale(0.7); }
  #wrap.clear #bar { opacity: 0; }
  /* Paused: clearly dimmed, but still on-screen. */
  #wrap.paused #time { opacity: 0.7; transform: scale(0.96); }
  #wrap.paused #bar { opacity: 0.7; }
  /* Smooth breathing fade when finished (no hard flashing). */
  #wrap.finished #time { animation: breathe 1.4s ease-in-out infinite; }
  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
</style>
</head>
<body>
  <div id="wrap"><div id="time"></div><div id="bar"></div></div>
</body>
</html>`;

export class TimerWindow {
  private win: Window | null = null;
  private timeEl: HTMLElement | null = null;
  private barEl: HTMLElement | null = null;
  private wrapEl: HTMLElement | null = null;

  isOpen(): boolean {
    return !!this.win && !this.win.closed;
  }

  /** Open (or focus) the pop-out. Returns false if the popup was blocked. */
  open(): boolean {
    if (this.isOpen()) {
      this.win!.focus();
      return true;
    }
    const win = window.open('', 'show-timer', 'width=900,height=520');
    if (!win) return false;
    win.document.open();
    win.document.write(WINDOW_HTML);
    win.document.close();
    this.win = win;
    this.wrapEl = win.document.getElementById('wrap');
    this.timeEl = win.document.getElementById('time');
    this.barEl = win.document.getElementById('bar');
    return true;
  }

  render(v: TimerView): void {
    if (!this.isOpen() || !this.wrapEl || !this.timeEl || !this.barEl) return;
    const clear = v.duration <= 0 && !v.finished;
    const paused = !clear && !v.finished && !v.running;
    this.wrapEl.className = clear
      ? 'clear'
      : v.finished
        ? 'finished'
        : paused
          ? 'paused'
          : 'running';
    // When clearing, leave the last digits/colour in place so the CSS zoom+fade
    // animates them out instead of blanking instantly.
    if (clear) return;
    this.timeEl.textContent = formatTime(v.remaining);
    const color = timerColor(v);
    this.timeEl.style.color = color;
    this.barEl.style.background = color;
    this.barEl.style.width = `${remainingFraction(v) * 100}%`;
  }

  close(): void {
    if (this.isOpen()) this.win!.close();
    this.win = null;
    this.timeEl = this.barEl = this.wrapEl = null;
  }
}
