// The authentication decision for a remote WebSocket, kept pure so it can be
// unit-tested in the plain `node` vitest environment without spinning up the
// Workers runtime. `worker/index.ts` calls this before it ever touches the
// Durable Object; a null result means "reject with 401".
//
// Two roles, both gated by the shared `hostKey` the Worker holds as its HOST_KEY
// secret:
//   - host:       the trusted player. Presents `hostKey` directly.
//   - controller: a paired phone. Presents SHA-256(hostKey:roomId), which only
//                 the player could have derived and put in the QR.
// The Worker re-derives the controller key from HOST_KEY + roomId, so it never
// has to store per-session state — rotating the room id alone invalidates every
// old QR.

import { deriveControllerKey, timingSafeEqual } from '../src/lib/remote/derive';

export type RemoteRole = 'host' | 'controller';

/**
 * Validate a presented `key` for `role` on `roomId` against the shared
 * `hostKey`. Resolves to the role when it checks out, or null to reject. All
 * comparisons are constant-time so a wrong guess leaks nothing via timing.
 */
export async function authorizeRemote(
  role: string,
  key: string,
  roomId: string,
  hostKey: string,
): Promise<RemoteRole | null> {
  // A missing HOST_KEY means the Worker is misconfigured; never authorize
  // against an empty secret (every guess would have to match "").
  if (!hostKey || !key || !roomId) return null;
  if (role === 'host') {
    return timingSafeEqual(key, hostKey) ? 'host' : null;
  }
  if (role === 'controller') {
    const expected = await deriveControllerKey(hostKey, roomId);
    return timingSafeEqual(key, expected) ? 'controller' : null;
  }
  return null;
}
