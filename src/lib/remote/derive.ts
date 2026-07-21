// The one place the controller key is derived, shared by all three sides that
// must agree on it: the player (which mints the QR), the phone's client code,
// and the Cloudflare Worker (which validates the phone's connection). Keeping it
// here means a change to the scheme can never drift between them.
//
// The controller key is SHA-256(hostKey + ":" + roomId), hex-encoded. The player
// holds the shared `hostKey`; the Worker holds the same value as its HOST_KEY
// secret. The phone never sees `hostKey` — it only receives this derived key in
// the pairing QR, and the Worker re-derives and compares to authenticate it. So
// possession of a valid controller key proves nothing but "the trusted player
// vouched for this room", which is exactly what gating a controller needs.
//
// `crypto.subtle` exists in the browser, on the phone, and in the Workers
// runtime alike, so this one function runs unchanged in every context.

/** Hex of SHA-256(`hostKey`:`roomId`) — the QR's controller credential. */
export async function deriveControllerKey(hostKey: string, roomId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${hostKey}:${roomId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string comparison, so validating a presented key against the
 * expected one never leaks how many leading characters matched via timing. Both
 * sides here are short hex/opaque tokens; comparing their UTF-8 bytes is enough.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  // Fold the length difference into the accumulator rather than returning early,
  // so a wrong-length guess costs the same as a wrong-content one.
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
