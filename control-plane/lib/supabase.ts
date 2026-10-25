/**
 * Service-role PostgREST calls. The secret key stays server-side (Vercel env),
 * and every call here is owner-scoped explicitly because RLS is not consulted
 * by the service role — the CONTROL PLANE is the authorization layer here.
 */
import { createHash, randomBytes } from "node:crypto";
import { env } from "./env.js";

const REST = `${env.supabaseUrl}/rest/v1`;

async function rest<T>(
  method: string,
  path: string,
  opts: { body?: unknown; prefer?: string; query?: Record<string, string> } = {},
): Promise<T[]> {
  const url = new URL(`${REST}/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      apikey: env.supabaseSecretKey,
      authorization: `Bearer ${env.supabaseSecretKey}`,
      "content-type": "application/json",
      ...(opts.prefer ? { prefer: opts.prefer } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) {
    throw new Error(`supabase ${method} ${path} -> ${res.status}`);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T[]) : [];
}

function prefer(header: string): Record<string, string> {
  return { prefer: header };
}

export const sha256hex = (v: string): string => createHash("sha256").update(v).digest("hex");

export interface ServerRow {
  id: string;
  owner_id: string;
  name: string;
  enrollment_state: string;
}

export async function insertServer(ownerId: string, name: string): Promise<ServerRow> {
  const rows = await rest<ServerRow>("POST", "servers", {
    body: { owner_id: ownerId, name, enrollment_state: "pending" },
    prefer: "return=representation",
  });
  return rows[0]!;
}

/** Creator of the enrollment must own the server row. */
export async function getOwnedServer(serverId: string, ownerId: string): Promise<ServerRow | null> {
  const rows = await rest<ServerRow>(
    "GET",
    "servers",
    { query: { id: `eq.${serverId}`, owner_id: `eq.${ownerId}` } },
  );
  return rows[0] ?? null;
}

export interface PairingCodeRow {
  id: string;
  server_id: string;
  code_hash: string;
  expires_at: string;
  used_at: string | null;
}

export async function insertPairingCode(serverId: string, ttlSeconds: number): Promise<{
  code: string;
  expiresAt: string;
}> {
  const code = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await rest("POST", "pairing_codes", {
    body: { server_id: serverId, code_hash: sha256hex(code), expires_at: expiresAt },
  });
  return { code, expiresAt };
}

/**
 * Atomically consume a pairing code: the UPDATE only lands while the row is
 * unused and unexpired, so a racing double-redemption loses exactly once.
 */
export async function consumePairingCode(code: string): Promise<PairingCodeRow | null> {
  const codeHash = sha256hex(code);
  const now = new Date().toISOString();
  const rows = await rest<PairingCodeRow>("UPDATE", "pairing_codes", {
    body: { used_at: now },
    prefer: "return=representation",
    query: {
      code_hash: `eq.${codeHash}`,
      used_at: "is.null",
      expires_at: `gt.${now}`,
    },
  });
  return rows[0] ?? null;
}

export async function issueConnectorCredential(serverId: string): Promise<string> {
  const credential = randomBytes(32).toString("base64url");
  const rows = await rest<{ id: string }>("POST", "connector_credentials", {
    body: { server_id: serverId, credential_hash: sha256hex(credential) },
    prefer: "return=representation",
  });
  await rest("PATCH", "servers", {
    body: { connector_id: rows[0]!.id, enrollment_state: "active", updated_at: new Date().toISOString() },
    query: { id: `eq.${serverId}` },
  });
  return credential;
}
