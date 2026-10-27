/**
 * Export against a fake Supabase (PostgREST + GoTrue admin). Checks paging,
 * counts, the manifest, file permissions intent, that not-migrated tables are
 * only counted (no row data requested), and tamper detection on load.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { exportSnapshot, loadSnapshot } from "../src/export.mjs";
import { transform } from "../src/transform.mjs";
import { fixture } from "./fixture.mjs";

const data = fixture();
// Enough rows to force a second page (PAGE = 1000).
data.audit_events = Array.from({ length: 1005 }, (_, i) => ({
  id: i + 1, actor_id: data.auth_users[0].id, server_id: null, action: "x", decision: null, correlation_id: null, detail: {}, created_at: "2026-10-26T10:00:00.000Z",
}));
const KEY = "test-service-key";
const requests = [];
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, path: url.pathname, select: url.searchParams.get("select") });
    if (req.headers.apikey !== KEY) { res.statusCode = 401; return res.end("{}"); }
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/auth/v1/admin/users") {
      const page = Number(url.searchParams.get("page"));
      const per = Number(url.searchParams.get("per_page"));
      return res.end(JSON.stringify({ users: data.auth_users.slice((page - 1) * per, page * per) }));
    }
    const table = url.pathname.replace("/rest/v1/", "");
    const rows = Array.isArray(data[table]) ? data[table] : [];
    if (req.method === "HEAD") {
      const n = Array.isArray(data[table]) ? rows.length : Number(data.counts?.[table] ?? 0);
      res.setHeader("content-range", n === 0 ? "*/0" : `0-${n - 1}/${n}`);
      return res.end();
    }
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    return res.end(JSON.stringify(rows.slice(offset, offset + limit)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("export writes every migrated table, pages, counts the rest, and round-trips through transform", async () => {
  const out = mkdtempSync(join(tmpdir(), "friday-export-"));
  const manifest = await exportSnapshot({ supabaseUrl: base, secretKey: KEY, outDir: out });
  assert.equal(manifest.files.audit_events.rows, 1005, "second page fetched");
  assert.equal(manifest.files.auth_users.rows, 3);
  assert.equal(manifest.counts.enrollments, 1);
  assert.equal(manifest.counts.rate_limit_hits, 4);
  assert.ok(!readdirSync(out).includes("enrollments.json"));

  // Not-migrated tables: HEAD with the primary key only, never a row GET.
  for (const r of requests.filter((x) => x.path === "/rest/v1/enrollments")) {
    assert.equal(r.method, "HEAD");
    assert.equal(r.select, "id");
  }
  const everything = readdirSync(out).map((f) => readFileSync(join(out, f), "utf8")).join("");
  assert.ok(!everything.includes("PLAINTEXT-PICKUP-SECRET"));

  const plan = transform(loadSnapshot(out));
  assert.equal(plan.report.tables.audit_events.planned, 1005);
  assert.equal(plan.report.tables.enrollments.skipped, 1);
});

test("a modified snapshot file is rejected", async () => {
  const out = mkdtempSync(join(tmpdir(), "friday-export-"));
  await exportSnapshot({ supabaseUrl: base, secretKey: KEY, outDir: out });
  const file = join(out, "servers.json");
  writeFileSync(file, readFileSync(file, "utf8").replace("prod-vps", "evil-vps"));
  assert.throws(() => loadSnapshot(out), /does not match the manifest/);
});

test("a wrong service key fails loudly", async () => {
  const out = mkdtempSync(join(tmpdir(), "friday-export-"));
  await assert.rejects(exportSnapshot({ supabaseUrl: base, secretKey: "wrong", outDir: out }), /401/);
});
