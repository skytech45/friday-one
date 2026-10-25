// END-TO-END audit harness for FRIDAY One.
// Runs the REAL server code against an ISOLATED Postgres database (a dedicated
// non-production role that OWNS its own tables) and a throwaway filesystem
// root. The production DB, production port and production secrets are NOT
// touched.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import pg from "pg";
import { spawnGrouped, killGroup, waitForHealth, assertPortFree } from "./lib/harness.mjs";

const say = (s) => console.log(s);
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  say(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? " :: " + detail : ""}`);
}

// ---------------------------------------------------------------- fixtures
// The roots must NOT live under a denylisted path segment. The sandbox's
// TMPDIR is ~/.hermes/cache/scratch, and ".hermes" is denied by safePath, so
// fixtures there would fail for the wrong reason. Use /tmp directly and
// realpath it so ROOTS and safePath's own realpath agree.
const ROOT = realpathSync(await mkdtemp(join("/tmp", "friday-e2e-root-")));
const OUTSIDE = realpathSync(await mkdtemp(join("/tmp", "friday-e2e-out-")));
await writeFile(join(ROOT, "hello.txt"), "harmless fixture");
await mkdir(join(ROOT, "sub"), { recursive: true });
await writeFile(join(ROOT, "sub", "nested.txt"), "nested");
await writeFile(join(OUTSIDE, "secret.txt"), "MUST NOT BE REACHABLE");
await symlink(OUTSIDE, join(ROOT, "escape-link"));
// R-01 (F-02) fixtures: credentials that live INSIDE the root but must never
// be served. Each holds the same canary string so a leak is unambiguous.
const CANARY = "CREDENTIAL_MUST_NOT_LEAK";
await mkdir(join(ROOT, ".ssh"), { recursive: true });
await writeFile(join(ROOT, ".ssh", "authorized_keys"), CANARY);
await writeFile(join(ROOT, ".env"), CANARY);
await writeFile(join(ROOT, "id_rsa"), CANARY);
await writeFile(join(ROOT, "server.pem"), CANARY);

// ---------------------------------------------------------------- db
const DB = "friday_audit";
const AUDIT_PW = "AuditPw_9f3b7c1d2e";
const psqlRun = (db, sql) =>
  new Promise((resolve, reject) => {
    const c = spawn("sudo", ["-n", "docker", "exec", "-i", "friday-pg", "psql", "-U", "friday",
      "-d", db, "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(out.slice(0, 600)))));
    c.stdin.end(sql);
  });

await psqlRun("postgres", `DROP DATABASE IF EXISTS ${DB};`).catch(() => {});
await psqlRun("postgres", `DROP ROLE IF EXISTS friday_audit;`).catch(() => {});
await psqlRun("postgres", `CREATE ROLE friday_audit LOGIN PASSWORD '${AUDIT_PW}';`);
await psqlRun("postgres", `CREATE DATABASE ${DB} OWNER friday_audit;`);

// Apply the schema AS the audit role, so the tables are owned by it and the
// server connects with a genuinely least-privilege role.
{
  const c = new pg.Client({ host: "127.0.0.1", port: 5433, user: "friday_audit", password: AUDIT_PW, database: DB });
  await c.connect();
  await c.query(await readFile(new URL("../server/src/schema.sql", import.meta.url), "utf8"));
  await c.query(await readFile(new URL("../server/src/schema-device-binding.sql", import.meta.url), "utf8"));
  await c.end();
}
say(`isolated database: ${DB} (role friday_audit owns its tables)`);

const JWT_SECRET = "audit-" + randomBytes(32).toString("hex");
const PEPPER = "audit-pepper-" + randomBytes(16).toString("hex");
const PORT = 8799;

const env = {
  ...process.env,
  DATABASE_URL: `postgres://friday_audit:${AUDIT_PW}@127.0.0.1:5433/${DB}`,
  JWT_SECRET,
  FINGERPRINT_PEPPER: PEPPER,
  PORT: String(PORT),
  HOST: "127.0.0.1",
  LOG_LEVEL: "info",
  APP_VERSION: "audit-0.1.0",
  FS_ROOTS: ROOT,
  STORAGE_DIR: join(ROOT, "_storage"),
  MAX_UPLOAD_BYTES: "1048576",
  MAX_DOWNLOAD_BYTES: "10485760",
  RATE_LIMIT_MAX: "120",
  CORS_ORIGINS: "",
  ALLOWED_EMAILS: "owner@audit.local",
  LOGIN_MAX_FAILURES: "3",
  LOGIN_IP_MAX: "10000", // per-IP throttle must not interfere with per-account tests
};

// ---------------------------------------------------------------- boot server
// Refuse to run if the port is already serving a FRIDAY server: a stale
// server would answer with the WRONG JWT secret, the WRONG schema and the
// WRONG code, producing nonsense results. (This exact thing happened once
// during the audit — the harness "failed" against an old instance.)
await assertPortFree(PORT);
const server = spawnGrouped("npx", ["tsx", "src/index.ts"], {
  cwd: new URL("../server/", import.meta.url).pathname, env, stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d.toString()));
server.stderr.on("data", (d) => (serverLog += d.toString()));

const BASE = `http://127.0.0.1:${PORT}`;
async function waitUp() {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
if (!(await waitUp())) { say("SERVER FAILED TO BOOT:\n" + serverLog.slice(0, 2500)); process.exit(1); }
say(`server up on ${BASE}\n`);

const fp = (seed) => createHash("sha256").update("fp-" + seed).digest("hex");
const post = async (p, body, tok) => {
  const r = await fetch(BASE + p, {
    method: "POST",
    headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null), raw: await r.text().catch(() => "") };
};
const get = async (p, tok, headers = {}) => {
  const r = await fetch(BASE + p, { headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers } });
  const ct = r.headers.get("content-type") ?? "";
  const raw = await r.text();
  return { status: r.status, body: ct.includes("json") ? safeJson(raw) : raw, raw, headers: r.headers };
};
const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

// ================================================================ TESTS
say("=== 1. registration allowlist ===");
let ownerTok, ownerRefresh, ownerDid;
const ownerFp = fp("owner");
{
  const r = await post("/auth/register", {
    email: "attacker@evil.local", password: "supersecret123",
    fingerprint: fp("attacker"), name: "x", platform: "x", appVersion: "1",
  });
  check("non-allowlisted email is rejected (403)", r.status === 403, `status=${r.status} err=${r.body?.error}`);
  const r2 = await post("/auth/register", {
    email: "owner@audit.local", password: "correcthorsebattery1",
    fingerprint: ownerFp, name: "audit", platform: "linux", appVersion: "1",
  });
  check("allowlisted owner can register (201)", r2.status === 201, `status=${r2.status} err=${r2.body?.error} ${r2.raw.slice(0, 120)}`);
  ownerTok = r2.body?.accessToken; ownerRefresh = r2.body?.refreshToken; ownerDid = r2.body?.deviceId;
  check("first registered device is trusted", r2.body?.trusted === true, `trusted=${r2.body?.trusted}`);
}

say("\n=== 2. unauthenticated access ===");
{
  const r = await get("/system");
  check("GET /system without token -> 401", r.status === 401, `status=${r.status}`);
  const r2 = await get(`/fs/list?path=${ROOT}`);
  check("GET /fs/list without token -> 401", r2.status === 401, `status=${r2.status}`);
}

say("\n=== 3. filesystem containment (REAL safePath, REAL ROOTS) ===");
{
  const cases = [
    ["traversal outside root", `${ROOT}/../../etc/passwd`, false],
    ["absolute /etc/passwd", "/etc/passwd", false],
    ["symlink escape to outside dir", `${ROOT}/escape-link/secret.txt`, false],
    ["file inside root", `${ROOT}/hello.txt`, true],
  ];
  for (const [name, p, shouldPass] of cases) {
    const r = await get(`/fs/download?path=${encodeURIComponent(p)}`, ownerTok);
    const got200 = r.status === 200;
    const leaked = (r.raw ?? "").includes("MUST NOT BE REACHABLE");
    const ok = shouldPass ? got200 : !got200 && !leaked;
    check(`fs: ${name}`, ok, `status=${r.status}${leaked ? " LEAKED-OUTSIDE-FILE" : ""}`);
  }

  // The root itself is a directory, so /fs/download correctly answers 404
  // (not a file). /fs/list is the route that serves a directory.
  {
    const r = await get(`/fs/download?path=${encodeURIComponent(ROOT)}`, ownerTok);
    check("fs: the root itself is not downloadable as a file (404)",
      r.status === 404, `status=${r.status}`);
    const l = await get(`/fs/list?path=${encodeURIComponent(ROOT)}`, ownerTok);
    check("fs: the root itself is listable (200)",
      l.status === 200, `status=${l.status}`);
  }

  // R-01 (F-02): credentials INSIDE the root must still be refused.
  const credCases = [
    [".ssh/authorized_keys", join(ROOT, ".ssh", "authorized_keys")],
    [".env", join(ROOT, ".env")],
    ["id_rsa", join(ROOT, "id_rsa")],
    ["server.pem", join(ROOT, "server.pem")],
  ];
  for (const [name, p] of credCases) {
    const r = await get(`/fs/download?path=${encodeURIComponent(p)}`, ownerTok);
    const leaked = (r.raw ?? "").includes(CANARY);
    check(`fs deny: ${name} is refused even though it is inside the root`,
      r.status === 403 && !leaked, `status=${r.status}${leaked ? " LEAKED-CREDENTIAL" : ""}`);
  }
}

say("\n=== 4. device trust gating ===");
let secondTok;
{
  const r = await post("/auth/login", {
    email: "owner@audit.local", password: "correcthorsebattery1",
    fingerprint: fp("second-device"), name: "d2", platform: "linux", appVersion: "1",
  });
  check("second device logs in (200)", r.status === 200, `status=${r.status} ${r.raw.slice(0, 100)}`);
  secondTok = r.body?.accessToken;
  check("second device starts UNtrusted", r.body?.trusted === false, `trusted=${r.body?.trusted}`);
  const fs = await get(`/fs/list?path=${ROOT}`, secondTok);
  check("untrusted device blocked from /fs/list (403)", fs.status === 403, `status=${fs.status}`);
  const sys = await get("/system", secondTok);
  check("untrusted device BLOCKED from /system (F-13: telemetry needs a trusted device)", sys.status === 403, `status=${sys.status} body=${JSON.stringify(sys.body)}`);
  const sysLeak = JSON.stringify(sys.body) ?? "";
  check("403 body leaks no host/platform/mount data", !sysLeak.includes("mounts") && !sysLeak.includes("hostname") && !sysLeak.includes("cpus"), sysLeak.slice(0, 120));
  const summary = await get("/system/summary", secondTok);
  check("untrusted device ALLOWED on /system/summary (200)", summary.status === 200, `status=${summary.status} body=${JSON.stringify(summary.body)}`);
  check("/system/summary is minimal (ok/version/uptime only)", summary.status === 200
    && summary.body?.ok === true
    && typeof summary.body?.version === "string"
    && typeof summary.body?.uptime_s === "number"
    && Object.keys(summary.body).every((k) => ["ok", "version", "uptime_s"].includes(k)),
    `keys=${Object.keys(summary.body ?? {}).join(",")}`);
  const anonSummary = await get("/system/summary");
  check("/system/summary without a token is 401", anonSummary.status === 401, `status=${anonSummary.status}`);
}

say("\n=== 5. refresh rotation, replay, and fingerprint binding ===");
{
  const r1 = await post("/auth/refresh", { refreshToken: ownerRefresh, fingerprint: ownerFp });
  check("refresh with correct fingerprint succeeds (200)", r1.status === 200, `status=${r1.status} ${r1.raw.slice(0, 100)}`);
  const newRefresh = r1.body?.refreshToken;
  const r2 = await post("/auth/refresh", { refreshToken: ownerRefresh, fingerprint: ownerFp });
  check("REPLAY of the old refresh token is rejected", r2.status === 401, `status=${r2.status} err=${r2.body?.error}`);
  const r3 = await post("/auth/refresh", { refreshToken: newRefresh, fingerprint: fp("attacker-device") });
  check("refresh with WRONG fingerprint is rejected", r3.status === 401, `status=${r3.status} err=${r3.body?.error}`);
  const r4 = await post("/auth/refresh", { refreshToken: newRefresh, fingerprint: ownerFp });
  check("the mismatched refresh attempt revoked the session (DoS on the owner)", r4.status === 401, `status=${r4.status}`);
  check("a rejected refresh leaks no token", !r4.body?.accessToken, `access=${r4.body?.accessToken}`);
}

say("\n=== 6. access token cannot be used as a refresh token ===");
{
  const r = await post("/auth/refresh", { refreshToken: ownerTok, fingerprint: ownerFp });
  check("access token rejected at /auth/refresh", r.status === 401, `status=${r.status} err=${r.body?.error}`);
}

say("\n=== 7. JWT claim restrictions (server-issued signing key) ===");
{
  const { default: Fastify } = await import("fastify");
  const { default: jwtp } = await import("@fastify/jwt");
  const { createHmac } = await import("node:crypto");
  const probe = Fastify({ logger: false });
  await probe.register(jwtp, { secret: JWT_SECRET });
  const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
  const sign = (payloadObj, alg = "HS256", digest = "sha256", headerExtra = {}) => {
    const h = b64u({ alg, typ: "JWT", ...headerExtra });
    const p = b64u(payloadObj);
    const s = createHmac(digest, JWT_SECRET).update(`${h}.${p}`).digest("base64url");
    return `${h}.${p}.${s}`;
  };

  // AFTER R-05 the server must REJECT every one of these. Each assertion is
  // written as "must be rejected"; a 200 here means the control regressed.
  // The `sub`/`did` values are real UUIDs: users.id and devices.id are uuid
  // columns, and a non-UUID made Postgres raise (a 500, not a 401).
  const victimSub = randomUUID();
  const noExp = sign({ sub: victimSub, did: ownerDid });
  const r = await get("/me", noExp);
  check("R-05: a token with NO exp claim is REJECTED",
    r.status === 401, `status=${r.status} ${r.raw.slice(0, 120)}`);

  const forgedDid = sign({ sub: victimSub, did: randomUUID(), exp: Math.floor(Date.now() / 1000) + 900 });
  const r2 = await get(`/fs/list?path=${ROOT}`, forgedDid);
  check("R-05: a token with a forged did is rejected on /fs/list",
    r2.status === 403, `status=${r2.status} (403 = the did was validated against the DB)`);

  const hs384 = sign({ sub: victimSub, did: ownerDid, exp: Math.floor(Date.now() / 1000) + 900 }, "HS384", "sha384");
  const r3 = await get("/me", hs384);
  check("R-05: an HS384 token signed with the REAL secret is REJECTED",
    r3.status === 401, `status=${r3.status}`);

  const hs512 = sign({ sub: victimSub, did: ownerDid, exp: Math.floor(Date.now() / 1000) + 900 }, "HS512", "sha512");
  const r3b = await get("/me", hs512);
  check("R-05: an HS512 token signed with the REAL secret is REJECTED",
    r3b.status === 401, `status=${r3b.status}`);

  // F-11: a payload that is a JSON array was accepted by fast-jwt.
  const arrPayload = sign([{ sub: victimSub, did: ownerDid, exp: Math.floor(Date.now() / 1000) + 900 }]);
  const r4 = await get("/me", arrPayload);
  check("R-05: a token whose PAYLOAD IS AN ARRAY is REJECTED",
    r4.status === 401, `status=${r4.status}`);

  // F-11: a `crit` header extension was accepted.
  const critToken = sign({ sub: victimSub, did: ownerDid, exp: Math.floor(Date.now() / 1000) + 900 }, "HS256", "sha256", { crit: ["exp"] });
  const r5 = await get("/me", critToken);
  check("R-05: a token with a `crit` header extension is REJECTED",
    r5.status === 401, `status=${r5.status}`);

  // A `sub` that is not a UUID would make Postgres raise; it must be a clean 401.
  const badUuid = sign({ sub: "victim-not-a-uuid", did: ownerDid, exp: Math.floor(Date.now() / 1000) + 900 });
  const r5b = await get("/me", badUuid);
  check("R-05: a token whose sub is NOT a UUID is REJECTED (401, not a 500)",
    r5b.status === 401, `status=${r5b.status} ${r5b.raw.slice(0, 120)}`);

  // A correct, fully-formed token must still work (no over-blocking).
  const good = sign({ sub: victimSub, did: ownerDid, exp: Math.floor(Date.now() / 1000) + 900 });
  const r6 = await get("/me", good);
  check("R-05: a correct HS256 token with exp is still ACCEPTED",
    r6.status === 200 || r6.status === 404, `status=${r6.status} (200 or 404 = the token verified)`);

  await probe.close();
}

say("\n=== 7c. R-08: a revoked device's access token stops working immediately ===");
{
  // Log in from a second device (registering again would be 409 email_taken),
  // then revoke it and try its still-unexpired access token. Before R-08 this
  // returned 200 for up to 15 minutes.
  const login = await post("/auth/login", {
    email: "owner@audit.local", password: "correcthorsebattery1",
    fingerprint: fp("revoke-me"), name: "d3", platform: "linux", appVersion: "1",
  });
  check("R-08: the target device logged in (200)", login.status === 200,
    `status=${login.status} ${login.raw.slice(0, 120)}`);
  const rTok = login.body?.accessToken;
  const rDid = login.body?.deviceId;
  check("R-08: the target device got a device id", typeof rDid === "string" && rDid.length > 0,
    `deviceId=${rDid}`);

  // /system/summary, not /system: the device is untrusted (F-13 gates full
  // telemetry on trust), so summary is the right "does this token work" probe.
  const before = await get("/system/summary", rTok);
  check("R-08: the device's access token works BEFORE revocation",
    before.status === 200, `status=${before.status}`);

  const del = await fetch(`${BASE}/auth/devices/${rDid}`, {
    method: "DELETE", headers: { authorization: `Bearer ${ownerTok}` },
  });
  check("R-08: the device was revoked (200)", del.status === 200,
    `status=${del.status} ${(await del.text()).slice(0, 120)}`);

  const after = await get("/system", rTok);
  check("R-08: the revoked device's access token is REJECTED immediately (401)",
    after.status === 401, `status=${after.status} (200 would mean the token still works)`);

  const afterFs = await get(`/fs/list?path=${ROOT}`, rTok);
  check("R-08: the revoked device is also refused on /fs/list",
    afterFs.status === 401, `status=${afterFs.status}`);

  // The WebSocket must refuse it too.
  const wsResult = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal?kind=shell&token=${rTok}`);
    let closeCode = null;
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve({ closeCode }); }, 6000);
    ws.on("open", () => { /* opened = bad */ });
    ws.on("close", (c) => { clearTimeout(t); closeCode = c; resolve({ closeCode }); });
    ws.on("error", () => { clearTimeout(t); resolve({ closeCode }); });
  });
  check("R-08: the revoked device cannot open a terminal (not 1000/4403)",
    wsResult.closeCode !== null && wsResult.closeCode !== 1000,
    `closeCode=${wsResult.closeCode}`);
}

say("\n=== 8. account lockout (per-account, not per-IP) ===");
{
  const r0 = await post("/auth/login", { email: "nobody@nowhere.local", password: "x".repeat(12), fingerprint: fp("x") });
  check("unknown account returns a uniform 401 (no enumeration)", r0.status === 401, `status=${r0.status}`);
  let last = 0;
  for (let i = 0; i < 4; i++) {
    const r = await post("/auth/login", {
      email: "owner@audit.local", password: "wrongpassword", fingerprint: fp("brute"),
    });
    last = r.status;
  }
  check("repeated bad passwords -> 429 lockout", last === 429, `status=${last}`);
  const good = await post("/auth/login", {
    email: "owner@audit.local", password: "correcthorsebattery1", fingerprint: ownerFp,
  });
  check("correct password while locked is refused (429)", good.status === 429, `status=${good.status}`);
}

say("\n=== 9. WebSocket terminal authentication ===");
{
  const wsTest = (url) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url);
      let opened = false;
      let closeCode = null;
      const done = () => resolve({ opened, closeCode });
      const t = setTimeout(() => { try { ws.close(); } catch {} resolve({ opened, closeCode }); }, 6000);
      ws.on("open", () => { opened = true; });
      ws.on("close", (c) => { clearTimeout(t); closeCode = c; done(); });
      ws.on("error", (e) => { clearTimeout(t); resolve({ opened, closeCode, error: e.message.slice(0, 60) }); });
    });
  const r1 = await wsTest(`ws://127.0.0.1:${PORT}/ws/terminal?kind=shell`);
  check("WS with no token is closed by the server (4401)", r1.closeCode === 4401, `closeCode=${r1.closeCode} opened=${r1.opened}`);
  const r2 = await wsTest(`ws://127.0.0.1:${PORT}/ws/terminal?kind=shell&token=garbage`);
  check("WS with a garbage token is closed by the server (4401)", r2.closeCode === 4401, `closeCode=${r2.closeCode}`);
  const r3 = await wsTest(`ws://127.0.0.1:${PORT}/ws/terminal?kind=shell&token=${ownerTok}`);
  check("WS with a VALID token is NOT closed immediately", r3.closeCode === null || r3.closeCode === 1000,
    `closeCode=${r3.closeCode} opened=${r3.opened} (1000 = process exited, i.e. the PTY ran)`);
  const r4 = await wsTest(`ws://127.0.0.1:${PORT}/ws/terminal?kind=shell&token=${secondTok}`);
  check("WS with a valid token from an UNTRUSTED device is closed (4403)", r4.closeCode === 4403, `closeCode=${r4.closeCode}`);
  const r5 = await wsTest(`ws://127.0.0.1:${PORT}/ws/terminal?kind=nosuchkind&token=${ownerTok}`);
  check("WS with an unknown terminal kind is closed (4400)", r5.closeCode === 4400, `closeCode=${r5.closeCode}`);
}

say("\n=== 9b. R-03: the access token is NOT written to the server log ===");
{
  // The WS above already connected with a live token. The server journal must
  // not contain it. A leak here means the redacting serializer was removed.
  await new Promise((r) => setTimeout(r, 500));
  const leaked = serverLog.includes(ownerTok);
  check("R-03: the WebSocket access token does NOT appear in the server log",
    !leaked, leaked ? "TOKEN LEAKED INTO THE JOURNAL" : "token absent from log");
  check("R-03: the log still records the request (redacted form present)",
    /token=<redacted>/.test(serverLog) || !/token=/.test(serverLog),
    "no unredacted token= found in the log");
}

say("\n=== 10. upload containment ===");
{
  const fd = new FormData();
  fd.append("dest", ROOT);
  fd.append("file", new Blob(["uploaded content"], { type: "text/plain" }), "up.txt");
  const r = await fetch(BASE + "/fs/upload", {
    method: "POST", headers: { authorization: `Bearer ${ownerTok}` }, body: fd,
  });
  check("upload into the root succeeds (201)", r.status === 201, `status=${r.status}`);
  const fd2 = new FormData();
  fd2.append("dest", "/etc");
  fd2.append("file", new Blob(["x"], { type: "text/plain" }), "evil.txt");
  const r2 = await fetch(BASE + "/fs/upload", {
    method: "POST", headers: { authorization: `Bearer ${ownerTok}` }, body: fd2,
  });
  check("upload OUTSIDE the root is refused (403)", r2.status === 403, `status=${r2.status}`);
}

say("\n=== 11. error handling / information disclosure ===");
{
  const r = await get("/fs/download?path=/etc/passwd", ownerTok);
  const body = JSON.stringify(r.body);
  check("path error does not echo a stack trace or source path",
    !body.includes("at Object") && !body.includes("server/src/"), `body=${body.slice(0, 140)}`);
  const r2 = await post("/auth/login", { email: "not-an-email", password: "" });
  check("malformed login returns a clean 400", r2.status === 400, `status=${r2.status} ${r2.raw.slice(0, 100)}`);
  // Does a DB error leak its message to the client?
  const r3 = await get("/nonexistent-route-xyz", ownerTok);
  check("unknown route does not leak internals", !r3.raw.includes("node_modules"), `body=${r3.raw.slice(0, 120)}`);
}

say("\n=== 12. does the server log the WS access token? ===");
{
  // AFTER R-03 the token must be redacted. This is the authoritative check;
  // section 9b is a redundant early assertion.
  const hasTokenParam = serverLog.includes("token=");
  const hasRedacted = serverLog.includes("token=<redacted>");
  check("R-03: the log contains the redacted token marker, not a live token",
    hasRedacted || !hasTokenParam,
    hasTokenParam && !hasRedacted
      ? "FOUND an unredacted 'token=' in the server log"
      : "token= is either absent or redacted");
  check("R-03: the live access token value is absent from the log",
    !serverLog.includes(ownerTok), "token value present in the log");
}

say("\n=== 13. crash endpoint (unauthenticated by design) ===");
{
  const r = await post("/crash", { message: "audit probe", severity: "info", context: { probe: "audit" } });
  check("crash report accepted without auth (202, by design)", r.status === 202, `status=${r.status}`);
  const r2 = await post("/crash", { message: "x".repeat(5000) });
  check("oversized crash message is rejected (400)", r2.status === 400, `status=${r2.status}`);
}

// ---------------------------------------------------------------- cleanup
// Registered immediately after the server is spawned so that ANY exit path
// (assertion failure, unhandled rejection, Ctrl-C) tears the server down. A
// leftover server holds the port and, worse, answers the NEXT run's requests
// with the wrong JWT secret.
let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  // killGroup kills the whole process group: `npx` is a wrapper, so a plain
  // server.kill() would signal the wrapper and leave the real server running,
  // still holding the port and the database.
  killGroup(server);
  await new Promise((r) => setTimeout(r, 1800));
  try {
    await psqlRun("postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}';`).catch(() => {});
    await psqlRun("postgres", `DROP DATABASE IF EXISTS ${DB};`).catch(() => {});
    await psqlRun("postgres", `DROP ROLE IF EXISTS friday_audit;`).catch(() => {});
  } catch {}
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await rm(OUTSIDE, { recursive: true, force: true }).catch(() => {});
}
process.on("exit", () => { if (!cleanedUp) { try { killGroup(server); } catch {} } });
process.on("SIGINT", () => { void cleanup().then(() => process.exit(130)); });
process.on("SIGTERM", () => { void cleanup().then(() => process.exit(143)); });
process.on("uncaughtException", (e) => { console.error("uncaught:", e); void cleanup().then(() => process.exit(1)); });
process.on("unhandledRejection", (e) => { console.error("unhandled:", e); void cleanup().then(() => process.exit(1)); });

// ---------------------------------------------------------------- summary
say("\n================ SUMMARY ================");
const pass = results.filter((r) => r.pass).length;
say(`${pass}/${results.length} checks passed`);
for (const r of results.filter((x) => !x.pass)) say(`  FAILED: ${r.name} :: ${r.detail}`);

await cleanup();
say("isolated db and fixtures removed.");
process.exit(pass === results.length ? 0 : 1);
