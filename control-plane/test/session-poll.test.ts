/**
 * F-M2: the connector polls with POST (token in the body). The legacy GET
 * keeps working for connectors <= v0.9.0. The credential is handed out once.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

const TOKEN = "enroll-token-123";
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const enrollment = {
  id: "e1", server_id: "s1", owner_id: "u1", state: "claim_requested",
  credential_pickup: "connector-credential-xyz", enrollment_token_hash: HASH,
};
const seenPaths: string[] = [];

const fake = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  seenPaths.push(`${req.method} ${url.pathname}`);
  res.setHeader("content-type", "application/json");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (url.pathname === "/rest/v1/rpc/consume_rate_limit") return res.end(JSON.stringify([{ allowed: true, retry_after_s: 0 }]));
    if (url.pathname === "/rest/v1/enrollments" && req.method === "PATCH") {
      const patch = JSON.parse(body || "{}");
      const matches = url.searchParams.get("enrollment_token_hash") === `eq.${HASH}`
        && url.searchParams.get("state") === `eq.${enrollment.state}`;
      if (patch.state === "paired") {
        if (!matches) return res.end("[]");
        const before = { ...enrollment };
        Object.assign(enrollment, patch);
        return res.end(JSON.stringify([before]));
      }
      if ("credential_pickup" in patch) Object.assign(enrollment, patch);
      return res.end("[]");
    }
    if (url.pathname === "/rest/v1/servers") return res.end("[]");
    res.end("[]");
  });
});

let handler: (req: unknown, res: unknown) => Promise<void>;

before(async () => {
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.SUPABASE_URL = base;
  process.env.SUPABASE_SECRET_KEY = "test-secret";
  process.env.SUPABASE_JWKS_URL = `${base}/jwks`;
  handler = (await import("../api/v1/enrollments/session.js")).default as typeof handler;
});
after(() => fake.close());

async function call(method: string, query: Record<string, string>, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let out = "";
  const res = {
    status(s: number) { status = s; return res; },
    setHeader() { return res; },
    end(b: string) { out = b; return res; },
  };
  await handler({ method, query, body, headers: { "x-vercel-forwarded-for": "10.0.0.1" } }, res);
  return { status, body: JSON.parse(out) };
}

test("POST ?mode=poll (the /session/poll rewrite) hands the credential out once, token in the body", async () => {
  const first = await call("POST", { mode: "poll" }, { token: TOKEN });
  assert.equal(first.status, 200);
  assert.equal(first.body.state, "paired");
  assert.equal(first.body.credential, "connector-credential-xyz");
  const again = await call("POST", { mode: "poll" }, { token: TOKEN });
  assert.deepEqual(again.body, { state: "pending" }, "one-time pickup");
  assert.ok(seenPaths.includes("POST /rest/v1/rpc/consume_rate_limit"), "poll is rate-limited");
});

test("POST poll without a token is rejected; legacy GET still answers", async () => {
  assert.equal((await call("POST", { mode: "poll" }, {})).status, 400);
  const legacy = await call("GET", { token: "unknown-token" });
  assert.deepEqual(legacy.body, { state: "pending" });
});
