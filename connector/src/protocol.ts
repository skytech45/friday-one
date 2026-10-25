/**
 * Protocol envelope schemas — the TypeScript mirror of docs/REALTIME_PROTOCOL.md.
 * Both the gateway and the connector validate with THESE schemas; unknown
 * event_type values for high-risk classes fail closed (never executed).
 */
import { z } from "zod";

export const ENVELOPE_BASE = z.object({
  protocol_version: z.literal(1),
  message_id: z.string().uuid(),
  correlation_id: z.string().uuid().nullable(),
  server_id: z.string().uuid(),
  connector_id: z.string().uuid().nullable(),
  agent_id: z.string().uuid().nullable(),
  session_id: z.string().max(256).nullable(),
  event_type: z.string().min(1).max(80),
  issued_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable(),
  sequence: z.number().int().nonnegative(),
  idempotency_key: z.string().max(128).nullable(),
  payload: z.unknown(),
});

export type Envelope = z.infer<typeof ENVELOPE_BASE>;

/** Event types the CONNECTOR may receive. Anything not listed → reject. */
export const CONNECTOR_INBOUND = [
  "auth.resume.ok",
  "command.dispatch",
  "permission.decided",
  "command.cancel",
  "policy.update",
  "connector.revoked",
] as const;

/** High-risk classes: an unknown type inside these fails closed. */
export const HIGH_RISK_PREFIXES = ["command.", "permission.", "terminal."] as const;

export function isInboundAllowed(eventType: string): boolean {
  if ((CONNECTOR_INBOUND as readonly string[]).includes(eventType)) return true;
  // Unknown types in high-risk classes are ALWAYS rejected; unknown harmless
  // types (future informational events) are logged and ignored.
  if (HIGH_RISK_PREFIXES.some((p) => eventType.startsWith(p))) return false;
  return false;
}

export function isExpired(env: Envelope, now = Date.now()): boolean {
  if (env.expires_at === null) return false;
  return new Date(env.expires_at).getTime() < now;
}

export function makeEnvelope(fields: {
  correlationId?: string | null;
  serverId: string;
  connectorId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  eventType: string;
  expiresAt?: string | null;
  sequence: number;
  idempotencyKey?: string | null;
  payload: unknown;
}): Envelope {
  return {
    protocol_version: 1,
    message_id: crypto.randomUUID(),
    correlation_id: fields.correlationId ?? crypto.randomUUID(),
    server_id: fields.serverId,
    connector_id: fields.connectorId ?? null,
    agent_id: fields.agentId ?? null,
    session_id: fields.sessionId ?? null,
    event_type: fields.eventType,
    issued_at: new Date().toISOString(),
    expires_at: fields.expiresAt ?? null,
    sequence: fields.sequence,
    idempotency_key: fields.idempotencyKey ?? null,
    payload: fields.payload,
  };
}
