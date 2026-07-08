// Realtime channels: a minimal WebSocket fan-out backed by a Durable Object.
//
// - ChannelDO: one instance per channel name (idFromName). Uses the WebSocket
//   Hibernation API so idle channels cost nothing. `broadcast(message)` sends to
//   every connected socket. v1 is intentionally minimal.
//   TODO(v1): no message history / persistence and no presence — a socket that
//   connects after a broadcast misses it. Add a small replay buffer if needed.
// - RealtimeEntrypoint: a ctx.exports WorkerEntrypoint handed to the dynamic
//   site worker as `env.REALTIME`. It exposes ONLY `publish(channel, message)`
//   (narrow capability — the site cannot enumerate sockets or read traffic).

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";

export class ChannelDO extends DurableObject<Env> {
  /** Accept a client WebSocket upgrade (hibernatable). */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernation: the runtime evicts the DO between events and rehydrates the
    // socket set on demand, so we never hold sockets in instance memory.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Send `message` to every connected socket (RPC target for RealtimeEntrypoint). */
  broadcast(message: unknown): void {
    const text = typeof message === "string" ? message : JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // Socket is closing/closed; the hibernation manager will reap it.
      }
    }
  }

  // Hibernation handlers. v1 ignores inbound frames (publish is server-only via
  // RealtimeEntrypoint) and just tidies up on close.
  override webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {}
  override webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code);
    } catch {
      // already closed
    }
  }
}

export class RealtimeEntrypoint extends WorkerEntrypoint<Env> {
  /**
   * Publish a JSON-serializable message to a channel's connected subscribers.
   * The site worker calls this from a route action / loader as
   * `await env.REALTIME.publish("guestbook", { name, message })`.
   */
  async publish(channel: string, message: unknown): Promise<void> {
    const id = this.env.CHANNELS.idFromName(channel);
    const stub = this.env.CHANNELS.get(id);
    await stub.broadcast(message);
  }
}
