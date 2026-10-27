/**
 * Regression test for F-M9: GET /api/v1/jobs?server_id=X must not list the
 * jobs of a server the caller does not own.
 *
 * Runs the real Vercel handler against a fake Supabase (PostgREST + JWKS)
 * with ES256-signed access tokens, and records which server IDs the handler
 * asks PostgREST for.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ALICE_SERVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB_SERVER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const servers = [
  { id: ALICE_SERVER, owner_id: ALICE },
  { id: BOB_SERVER, owner_id: BOB },
];
const jobs = [
  { id: "job-a", server_id: ALICE_SERVER, operation: "session.prompt", state: "completed", updated_at: "2026-10-27T00:00:00Z" },
  { id: "job-b", server_id: BOB_SERVER, operation: "session.prompt", state: "completed", updated_at: "2026-10-27T00:00:00Z" },
];

/** server IDs the handler asked command_jobs for, per request. */
const jobQueries: string[] = [];

function matches(filter: string | null, value: string): boolean {
  if (filter === null) return true;
  if (filter.startsWith("eq.")) return value === filter.slice(3);
  if (filter.startsWith("in.(")) return filter.slice(4, -1).split(",").includes(value);
  throw new Error(`unsupported filter ${filter}`);
}

const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "ES256", use: "sig" };

const fake = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
  if (url.pathname === "/rest/v1/servers") {
    const owner = url.searchParams.get("owner_id");
    return res.end(JSON.stringify(servers.filter((s) => matches(owner, s.owner_id)).map((s) => ({ id: s.id }))));
  }
  if (url.pathname === "/rest/v1/command_jobs") {
    const filter = url.searchParams.get("server_id");
    jobQueries.push(filter ?? "");
    return res.end(JSON.stringify(jobs.filter((j) => matches(filter, j.server_id))));
  }
  res.statusCode = 404;
  res.end("[]");
});

let base = "";
let handler: (req: unknown, res: unknown) => Promise<void>;

before(async () => {
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.SUPABASE_URL = base;
  process.env.SUPABASE_SECRET_KEY = "test-secret";
  process.env.SUPABASE_JWKS_URL = `${base}/jwks`;
  handler = (await import("../api/v1/jobs.js")).default as typeof handler;
});

after(() => fake.close());

const tokenFor = (sub: string): Promise<string> =>
  new SignJWT({ email: `${sub}@example.test` })
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .setSubject(sub)
    .setIssuer(`${base}/auth/v1`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

/** Minimal VercelRequest/VercelResponse doubles. */
async function getJobs(sub: string, serverId?: string): Promise<{ status: number; body: { jobs?: { id: string }[]; error?: string } }> {
  let status = 0;
  let body = "";
  const res = {
    status(s: number) { status = s; return res; },
    setHeader() { return res; },
    end(b: string) { body = b; return res; },
  };
  await handler({
    method: "GET",
    headers: { authorization: `Bearer ${await tokenFor(sub)}` },
    query: serverId ? { server_id: serverId } : {},
  }, res);
  return { status, body: JSON.parse(body) };
}

test("owner can list jobs for their own server", async () => {
  const r = await getJobs(ALICE, ALICE_SERVER);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.jobs?.map((j) => j.id), ["job-a"]);
});

test("owner's unfiltered list covers only their servers", async () => {
  const r = await getJobs(ALICE);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.jobs?.map((j) => j.id), ["job-a"]);
});

test("F-M9: another user's server_id is refused and never queried", async () => {
  jobQueries.length = 0;
  const r = await getJobs(BOB, ALICE_SERVER);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "not_found");
  assert.equal(r.body.jobs, undefined);
  assert.ok(!jobQueries.some((q) => q.includes(ALICE_SERVER)), `queried alice's jobs: ${jobQueries.join(" | ")}`);
});

test("unknown server_id is refused", async () => {
  const r = await getJobs(ALICE, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(r.status, 404);
});
