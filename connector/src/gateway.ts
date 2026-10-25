/**
 * Gateway connection: outbound WSS with authentication, heartbeat, bounded
 * reconnect (exponential backoff + full jitter), and resume-after-reconnect.
 *
 * SKELETON STATUS (Phase 4): the gateway does not exist yet. This module is
 * the client side of docs/REALTIME_PROTOCOL.md and is written against that
 * spec so the server side lands onto a working client, not the reverse.
 */
import WebSocket from "ws";
import { ENVELOPE_BASE, makeEnvelope, type Envelope, isInboundAllowed, isExpired } from "./protocol.js";

export interface GatewayOptions {
  url: string;
  /**
   * Mutable identity holder: the server/connector UUIDs are assigned at
   * pairing and confirmed by the gateway's auth.resume.ok; the caller keeps
   * this object up to date from inbound messages.
   */
  ids: { serverId: string; connectorId: string };
  credential: () => string; // read lazily so rotation just works
  onMessage: (env: Envelope) => void;
  log?: (msg: string) => void;
}

const HEARTBEAT_MS = 15_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export class GatewayConnection {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastSequence = 0;
  private pending: Envelope[] = []; // bounded drain after (re)connect

  constructor(private readonly opts: GatewayOptions) {}

  /** Queue a message for delivery; flushed in order on connect. */
  send(env: Envelope): void {
    this.lastSequence = Math.max(this.lastSequence, env.sequence);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(env));
    } else {
      this.pending.push(env);
      if (this.pending.length > 1000) this.pending.shift(); // bounded
    }
  }

  /** Build + send an outbound envelope with the next sequence number. */
  emit(eventType: string, payload: unknown, correlationId?: string): void {
    this.send(
      makeEnvelope({
        serverId: this.opts.ids.serverId,
        connectorId: this.opts.ids.connectorId || null,
        eventType,
        sequence: ++this.lastSequence,
        correlationId: correlationId ?? null,
        payload,
      }),
    );
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    this.ws?.close(1000, "connector_stopping");
  }

  private connect(): void {
    if (this.stopped) return;
    const delay = this.backoffMs();
    if (delay > 0) {
      (this.opts.log ?? console.log)(`[gateway] reconnect in ${delay}ms (attempt ${this.attempts})`);
      setTimeout(() => this.connect(), delay);
      return;
    }
    const ws = new WebSocket(this.opts.url, { followRedirects: false });
    this.ws = ws;

    ws.on("open", () => {
      this.attempts = 0;
      // First message authenticates and carries the resume cursor.
      ws.send(
        JSON.stringify(
          makeEnvelope({
            serverId: this.opts.ids.serverId,
            connectorId: this.opts.ids.connectorId || null,
            eventType: "auth.connector",
            sequence: ++this.lastSequence,
            payload: { credential: this.opts.credential(), last_sequence: this.lastSequence },
          }),
        ),
      );
      this.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify(
              makeEnvelope({
                serverId: this.opts.ids.serverId,
                connectorId: this.opts.ids.connectorId || null,
                eventType: "connector.heartbeat",
                sequence: ++this.lastSequence,
                payload: { uptime_s: Math.round(process.uptime()) },
              }),
            ),
          );
        }
      }, HEARTBEAT_MS);
      const drain = this.pending.splice(0);
      for (const env of drain) this.send(env);
    });

    ws.on("message", (raw) => {
      const parsed = ENVELOPE_BASE.safeParse(JSON.parse(String(raw)));
      if (!parsed.success) {
        (this.opts.log ?? console.log)("[gateway] malformed envelope dropped");
        return;
      }
      const env = parsed.data;
      if (isExpired(env)) return; // never act on expired messages
      if (!isInboundAllowed(env.event_type)) {
        (this.opts.log ?? console.log)(`[gateway] inbound type not allowed: ${env.event_type}`);
        return;
      }
      this.opts.onMessage(env);
    });

    ws.on("close", () => {
      this.clearHeartbeat();
      this.attempts++;
      if (!this.stopped) this.connect(); // backoff applied inside connect()
    });

    ws.on("error", (err) => {
      (this.opts.log ?? console.log)(`[gateway] error: ${err.message}`);
      // 'close' always follows 'error'; reconnect happens there.
    });
  }

  private backoffMs(): number {
    if (this.attempts === 0) return 0;
    const exp = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(this.attempts, 6));
    return Math.floor(Math.random() * exp); // full jitter
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
