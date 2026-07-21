// Prefix-tagged console logging for the phone remote, on by default so that
// field problems — reconnection especially, which only shows up on real
// networks — are diagnosable straight from the browser console on either the
// player or the phone. Silence it with `localStorage.setItem('remoteDebug', 'off')`.

export function rlog(scope: string, ...args: unknown[]): void {
  try {
    if (localStorage.getItem('remoteDebug') === 'off') return;
  } catch {
    // No localStorage (or blocked) — just log.
  }
  // eslint-disable-next-line no-console
  console.info(`[remote:${scope}]`, ...args);
}
