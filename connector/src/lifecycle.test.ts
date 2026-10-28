import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { StateFile, sanitizeError } from "./state.js";
import { GatewayConnection } from "./gateway.js";
import { poll } from "./enroll.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("state file: atomic JSON, no temp leftovers, since changes only on state change", () => {
  const dir = mkdtempSync(join(tmpdir(), "friday-state-"));
  const path = join(dir, "state.json");
  let t = Date.parse("2026-10-28T00:00:00Z");
  const s = new StateFile(path, "v1.2.3", "wss://gw.example.test/ws", () => new Date((t += 1000)));
  s.update({ state: "connecting" });
  const first = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(first.state, "connecting");
  assert.equal(first.gatewayHost, "gw.example.test");
  s.update({ reconnects: 3 });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).since, first.since, "same state keeps its since");
  s.update({ state: "connected", serverId: "s1" });
  const connected = JSON.parse(readFileSync(path, "utf8"));
  assert.notEqual(connected.since, first.since);
  assert.equal(connected.serverId, "s1");
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});

test("state file: errors are redacted before they are persisted", () => {
  assert.equal(sanitizeError("bad credential=abc123 here"), "bad credential=[redacted] here");
  assert.equal(sanitizeError('{"token":"zzz"}'), '{"token":"[redacted]"}');
  assert.ok(!sanitizeError(`x ${"A".repeat(40)} y`).includes("AAAA"));
  assert.ok(sanitizeError("e".repeat(1000)).length <= 300);
});

test("gateway: close 4403 is fatal (no reconnect); a normal close reconnects", async (t) => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", r));
  const clients: GatewayConnection[] = [];
  // Always release sockets, so a failing assertion reports instead of hanging.
  t.after(() => {
    for (const c of clients) c.stop();
    for (const s of wss.clients) s.terminate();
    wss.close();
  });
  let connections = 0;
  let mode: "revoke" | "drop" = "drop";
  wss.on("connection", (ws) => {
    connections++;
    ws.once("message", () => ws.close(mode === "revoke" ? 4403 : 1001, mode === "revoke" ? "credential_revoked" : "bye"));
  });
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  const ids = { serverId: "00000000-0000-0000-0000-000000000000", connectorId: "" };

  // Normal close → reconnect.
  const closes: number[] = [];
  const a = new GatewayConnection({ url, ids, credential: () => "c", onMessage: () => {}, log: () => {}, onClosed: (c) => closes.push(c) });
  clients.push(a);
  a.start();
  for (let i = 0; i < 60 && connections < 2; i++) await wait(50);
  a.stop();
  assert.ok(connections >= 2, "reconnected after a normal close");
  assert.ok(closes.includes(1001));

  // 4403 → onFatal once, no further connections.
  mode = "revoke";
  connections = 0;
  const fatal: Array<[number, string]> = [];
  const b = new GatewayConnection({ url, ids, credential: () => "c", onMessage: () => {}, log: () => {}, onFatal: (c, r) => fatal.push([c, r]) });
  clients.push(b);
  b.start();
  for (let i = 0; i < 40 && fatal.length === 0; i++) await wait(50);
  await wait(1500);
  assert.deepEqual(fatal, [[4403, "credential_revoked"]]);
  assert.equal(connections, 1, "never reconnects with a revoked credential");
  b.stop();
  wss.close();
});

test("enroll poll: POST with the token in the body; GET fallback only when asked", async () => {
  const seen: Array<{ method: string; url: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ state: "pending" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await poll(base, "tok-secret", false);
  await poll(base, "tok-secret", true);
  server.close();
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.url, "/api/v1/enrollments/session/poll");
  assert.ok(!seen[0]!.url.includes("tok-secret"), "token not in the URL");
  assert.deepEqual(JSON.parse(seen[0]!.body), { token: "tok-secret" });
  assert.equal(seen[1]!.method, "GET", "legacy fallback");
});
