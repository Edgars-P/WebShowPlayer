// The Cloudflare Worker entry. It does two jobs:
//   1. Serve the built static site (the player, the projector screen, the phone
//      remote page) straight from the `dist/` assets binding.
//   2. Terminate the remote-control WebSocket at `/api/remote/<roomId>`,
//      authenticate it, and hand it to the per-room Durable Object that relays
//      messages between the player and its phones.
//
// The whole remote transport is this Worker plus the DO — no WebRTC, no
// third-party signaling. Every message travels player ⇄ DO ⇄ phone over `wss`.

import { authorizeRemote } from './authorize';
import { RemoteRoom } from './RemoteRoom';

export { RemoteRoom };

export interface Env {
  ASSETS: Fetcher;
  REMOTE_ROOM: DurableObjectNamespace;
  /** Shared secret the player also holds; gates the host and derives phone keys. */
  HOST_KEY: string;
}

/** Match `/api/remote/<roomId>` and pull the room id out. */
function roomIdFrom(pathname: string): string | null {
  const m = /^\/api\/remote\/([^/]+)\/?$/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const roomId = roomIdFrom(url.pathname);

    // Anything that isn't the remote endpoint is a static asset.
    if (!roomId) return env.ASSETS.fetch(request);

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    if (!env.HOST_KEY) {
      // The secret was never provisioned — fail clearly rather than authorizing
      // against an empty key.
      return new Response('Remote is not configured (missing HOST_KEY)', { status: 503 });
    }

    const role = url.searchParams.get('role') ?? '';
    const key = url.searchParams.get('key') ?? '';
    const authorized = await authorizeRemote(role, key, roomId, env.HOST_KEY);
    if (!authorized) return new Response('Unauthorized', { status: 401 });

    // Route to the room's DO, telling it the already-validated role so it never
    // has to re-check the credential.
    const id = env.REMOTE_ROOM.idFromName(roomId);
    const stub = env.REMOTE_ROOM.get(id);
    const forwarded = new Request(request);
    forwarded.headers.set('X-Remote-Role', authorized);
    return stub.fetch(forwarded);
  },
};
