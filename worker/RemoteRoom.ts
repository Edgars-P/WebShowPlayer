// One Durable Object per room: a dumb, always-reachable pipe between the player
// (the "host") and its phones (the "controllers"). It never parses a payload —
// command validation stays client-side in `parseCommand` — it only routes:
//   - a message from the host goes to every controller (state snapshots),
//   - a message from a controller goes to every host (whitelisted commands),
//   - and it tells the host how many controllers are connected, so the player's
//     UI can show "N devices connected" and stop pushing state when nobody's
//     watching.
//
// It uses the WebSocket Hibernation API (`ctx.acceptWebSocket` + the
// `webSocket*` handlers) so an idle room costs nothing: the DO can be evicted
// between messages and the runtime revives it on the next one, with each
// socket's role recovered from the tag it was accepted under. The Worker
// (`index.ts`) has already authenticated every socket that reaches here.

import { DurableObject } from 'cloudflare:workers';

type Role = 'host' | 'controller';

/** The DO → host peer-count notice; state/cmd payloads are relayed verbatim. */
interface PeersMessage {
  k: 'peers';
  n: number;
}

export class RemoteRoom extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const role = request.headers.get('X-Remote-Role');
    if (role !== 'host' && role !== 'controller') {
      return new Response('Missing role', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // The tag is how a revived DO recovers which side of the pipe this socket is.
    this.ctx.acceptWebSocket(server, [role]);

    if (role === 'controller') {
      this.broadcastPeers();
    } else {
      // Catch a freshly connected host up on the current device count at once.
      this.send(server, { k: 'peers', n: this.count('controller') });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return; // We only speak JSON text.
    const role = this.roleOf(ws);
    // Route to the opposite side. Payloads pass through untouched.
    const targets = role === 'host' ? this.ctx.getWebSockets('controller') : this.ctx.getWebSockets('host');
    for (const target of targets) {
      try {
        target.send(message);
      } catch {
        // A socket mid-close can throw; the close handler will clean it up.
      }
    }
  }

  webSocketClose(ws: WebSocket): void {
    // A departing controller changes the count the hosts should see.
    if (this.roleOf(ws) === 'controller') this.broadcastPeers();
  }

  webSocketError(ws: WebSocket): void {
    if (this.roleOf(ws) === 'controller') this.broadcastPeers();
  }

  /** The role a socket was accepted under, from its hibernation tag. */
  private roleOf(ws: WebSocket): Role | null {
    const tag = this.ctx.getTags(ws)[0];
    return tag === 'host' || tag === 'controller' ? tag : null;
  }

  private count(role: Role): number {
    return this.ctx.getWebSockets(role).length;
  }

  private broadcastPeers(): void {
    const n = this.count('controller');
    for (const host of this.ctx.getWebSockets('host')) this.send(host, { k: 'peers', n });
  }

  private send(ws: WebSocket, msg: PeersMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Ignore a socket that's already gone.
    }
  }
}
