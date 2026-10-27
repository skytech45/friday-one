/**
 * Export the Supabase project to a snapshot directory (read-only on the
 * source: GET requests only).
 *
 * - Migrated tables: every row, paged by primary key.
 * - Not-migrated tables: row COUNT only. In particular `enrollments` is
 *   never read, so `credential_pickup` (a plaintext credential, F-M1) never
 *   lands on disk.
 * - Auth users: the GoTrue admin API (ids, emails, identities). Password
 *   hashes are not exported (decision D2: Google only).
 *
 * The snapshot contains personal data (emails). Write it outside the repo,
 * keep it 0600, and delete it after the rollback window (DATA_MIGRATION.md).
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EXPORTED_TABLES = [
  "profiles", "servers", "connector_credentials", "agents", "projects",
  "permission_policies", "permission_requests", "command_jobs", "audit_events",
];
export const COUNTED_TABLES = ["enrollments", "pairing_codes", "rate_limit_hits", "agent_sessions", "chat_messages", "app_config"];
const PAGE = 1000;

const sha256 = (v) => createHash("sha256").update(v).digest("hex");

async function get(url, key, extraHeaders = {}, method = "GET") {
  const res = await fetch(url, {
    method,
    headers: { apikey: key, authorization: `Bearer ${key}`, ...extraHeaders },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET ${new URL(url).pathname} -> ${res.status}`);
  return res;
}

async function exportTable(base, key, table) {
  const pk = table === "app_config" ? "key" : "id";
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${base}/rest/v1/${table}?select=*&order=${pk}.asc&limit=${PAGE}&offset=${offset}`;
    const page = await (await get(url, key)).json();
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

/** Row count via HEAD (no body, primary key only): row data never crosses the wire. */
async function countTable(base, key, table) {
  const pk = table === "app_config" ? "key" : "id";
  const res = await get(`${base}/rest/v1/${table}?select=${pk}`, key, { prefer: "count=exact" }, "HEAD");
  const total = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
  if (!total) throw new Error(`no row count for ${table}`);
  return Number(total[1]);
}

async function exportUsers(base, key) {
  const all = [];
  for (let page = 1; ; page++) {
    const body = await (await get(`${base}/auth/v1/admin/users?page=${page}&per_page=${PAGE}`, key)).json();
    const users = Array.isArray(body) ? body : body.users ?? [];
    for (const u of users) {
      // Keep only what the plan needs; drop tokens, factors, raw metadata.
      all.push({
        id: u.id,
        email: u.email ?? null,
        email_confirmed_at: u.email_confirmed_at ?? null,
        created_at: u.created_at ?? null,
        banned_until: u.banned_until ?? null,
        user_metadata: { full_name: u.user_metadata?.full_name ?? null, name: u.user_metadata?.name ?? null },
        identities: (u.identities ?? []).map((i) => ({
          provider: i.provider,
          id: i.id ?? null,
          provider_id: i.provider_id ?? null,
          identity_data: { sub: i.identity_data?.sub ?? null },
        })),
      });
    }
    if (users.length < PAGE) return all;
  }
}

/**
 * @param {{ supabaseUrl: string, secretKey: string, outDir: string }} opts
 * @returns {Promise<object>} the manifest
 */
export async function exportSnapshot({ supabaseUrl, secretKey, outDir }) {
  const base = supabaseUrl.replace(/\/$/, "");
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const manifest = { exportedAt: new Date().toISOString(), sourceHost: new URL(base).host, files: {}, counts: {} };
  const save = (name, data) => {
    const text = JSON.stringify(data);
    const file = join(outDir, `${name}.json`);
    writeFileSync(file, text, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
    manifest.files[name] = { rows: data.length, sha256: sha256(text) };
  };
  save("auth_users", await exportUsers(base, secretKey));
  for (const table of EXPORTED_TABLES) save(table, await exportTable(base, secretKey, table));
  for (const table of COUNTED_TABLES) manifest.counts[table] = await countTable(base, secretKey, table);
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

/** Loads a snapshot and verifies every file against the manifest hashes. */
export function loadSnapshot(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const snapshot = { manifest: { exportedAt: manifest.exportedAt, sourceHost: manifest.sourceHost }, counts: manifest.counts ?? {} };
  for (const [name, meta] of Object.entries(manifest.files)) {
    const text = readFileSync(join(dir, `${name}.json`), "utf8");
    if (sha256(text) !== meta.sha256) throw new Error(`snapshot file ${name}.json does not match the manifest (modified or truncated)`);
    snapshot[name] = JSON.parse(text);
  }
  return snapshot;
}
