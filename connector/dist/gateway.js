/**
 * Gateway connection: outbound WSS with authentication, heartbeat, bounded
 * reconnect (exponential backoff + full jitter), and resume-after-reconnect.
 *
 * SKELETON STATUS (Phase 4): the gateway does not exist yet. This module is
 * the client side of docs/REALTIME_PROTOCOL.md and is written against that
 * spec so the server side lands onto a working client, not the reverse.
 */
import WebSocket from "ws";
import { ENVELOPE_BASE, makeEnvelope, isInboundAllowed, isExpired } from "./protocol.js";
const HEARTBEAT_MS = 15_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
export class GatewayConnection {
    opts;
    ws = null;
    attempts = 0;
    heartbeat = null;
    stopped = false;
    lastSequence = 0;
    pending = []; // bounded drain after (re)connect
    constructor(opts) {
        this.opts = opts;
    }
    /** Queue a message for delivery; flushed in order on connect. */
    send(env) {
        this.lastSequence = Math.max(this.lastSequence, env.sequence);
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(env));
        }
        else {
            this.pending.push(env);
            if (this.pending.length > 1000)
                this.pending.shift(); // bounded
        }
    }
    /** Build + send an outbound envelope with the next sequence number. */
    emit(eventType, payload, correlationId) {
        this.send(makeEnvelope({
            serverId: this.opts.ids.serverId,
            connectorId: this.opts.ids.connectorId || null,
            eventType,
            sequence: ++this.lastSequence,
            correlationId: correlationId ?? null,
            payload,
        }));
    }
    start() {
        this.stopped = false;
        this.connect();
    }
    stop() {
        this.stopped = true;
        this.clearHeartbeat();
        this.ws?.close(1000, "connector_stopping");
    }
    connect() {
        if (this.stopped)
            return;
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
            ws.send(JSON.stringify(makeEnvelope({
                serverId: this.opts.ids.serverId,
                connectorId: this.opts.ids.connectorId || null,
                eventType: "auth.connector",
                sequence: ++this.lastSequence,
                payload: { credential: this.opts.credential(), last_sequence: this.lastSequence },
            })));
            this.heartbeat = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(makeEnvelope({
                        serverId: this.opts.ids.serverId,
                        connectorId: this.opts.ids.connectorId || null,
                        eventType: "connector.heartbeat",
                        sequence: ++this.lastSequence,
                        payload: { uptime_s: Math.round(process.uptime()) },
                    })));
                }
            }, HEARTBEAT_MS);
            const drain = this.pending.splice(0);
            for (const env of drain)
                this.send(env);
        });
        ws.on("message", (raw) => {
            const parsed = ENVELOPE_BASE.safeParse(JSON.parse(String(raw)));
            if (!parsed.success) {
                (this.opts.log ?? console.log)("[gateway] malformed envelope dropped");
                return;
            }
            const env = parsed.data;
            if (isExpired(env))
                return; // never act on expired messages
            if (!isInboundAllowed(env.event_type)) {
                (this.opts.log ?? console.log)(`[gateway] inbound type not allowed: ${env.event_type}`);
                return;
            }
            this.opts.onMessage(env);
        });
        ws.on("close", () => {
            this.clearHeartbeat();
            this.attempts++;
            if (!this.stopped)
                this.connect(); // backoff applied inside connect()
        });
        ws.on("error", (err) => {
            (this.opts.log ?? console.log)(`[gateway] error: ${err.message}`);
            // 'close' always follows 'error'; reconnect happens there.
        });
    }
    backoffMs() {
        if (this.attempts === 0)
            return 0;
        const exp = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(this.attempts, 6));
        return Math.floor(Math.random() * exp); // full jitter
    }
    clearHeartbeat() {
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        this.heartbeat = null;
    }
}
