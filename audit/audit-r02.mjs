// R-02 (F-04): registration must FAIL CLOSED when ALLOWED_EMAILS is empty.
// Boots the real server with an empty allowlist and asserts that an anonymous
// caller cannot register a trusted device. Uses its own port and its own
// database, and cleans up after itself.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const DB = "friday_audit_r02";
const PW = "R02AuditPw_5a8c2e";
const PORT = 8798;
const ROOT = "/tmp/friday-r02-root";

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

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? "  [" + detail + "]" : ""}`);
  ok ? pass++ : fail++;
};

// ---- isolated db
await psqlRun("postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}';`).catch(() => {});
await psqlRun("postgres", `DROP DATABASE IF EXISTS ${DB};`).catch(() => {});
await psqlRun("postgres", `DROP ROLE IF EXISTS friday_audit_r02;`).catch(() => {});
await psqlRun("postgres", `CREATE ROLE friday_audit_r02 LOGIN PASSWORD '${PW}';`);
await psqlRun("postgres", `CREATE DATABASE ${DB} OWNER friday_audit_r02;`);
{
  const pg = await import("pg");
  const c = new pg.Client({ host: "127.0.0.1", port: 5433, user: "friday_audit_r02", password: PW, database: DB });
  await c.connect();
  await c.query(await readFile(new URL("../server/src/schema.sql", import.meta.url), "utf8"));
  await c.query(await readFile(new URL("../server/src/schema-device-binding.sql", import.meta.url), "utf8"));
  await c.end();
}

// ---- boot with an EMPTY allowlist
const env = {
  ...process.env,
  DATABASE_URL: `postgres://friday_audit_r02:${PW}@127.0.0.1:5433/${DB}`,
  JWT_SECRET: "r02-" + randomBytes(32).toString("hex"),
  FINGERPRINT_PEPPER: "r02-pepper-" + randomBytes(16).toString("hex"),
  PORT: String(PORT),
  HOST: "127.0.0.1",
  LOG_LEVEL: "info",
  FS_ROOTS: ROOT,
  STORAGE_DIR: ROOT + "/_storage",
  RATE_LIMIT_MAX: "120",
  CORS_ORIGINS: "",
  ALLOWED_EMAILS: "",            // <-- the misconfiguration under test
  LOGIN_MAX_FAILURES: "3",
  LOGIN_IP_MAX: "10000",
};
const server = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: new URL("../server/", import.meta.url).pathname, env, stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d.toString()));
server.stderr.on("data", (d) => (log += d.toString()));

const BASE = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { const r = await fetch(BASE + "/health"); if (r.ok) { up = true; break; } } catch {}
}
if (!up) {
  console.log("SERVER FAILED TO BOOT:\n" + log.slice(0, 2000));
  process.exit(1);
}

try {
  // ---- the actual test
  const r = await fetch(BASE + "/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "attacker@evil.local", password: "supersecret123",
      fingerprint: "f" + "a".repeat(32), name: "x", platform: "x", appVersion: "1",
    }),
  });
  const body = await r.json().catch(() => ({}));
  console.log(`\nPOST /auth/register (ALLOWED_EMAILS="") -> ${r.status} ${JSON.stringify(body).slice(0, 200)}\n`);

  check("R-02: registration with an empty allowlist is REFUSED (503)",
    r.status === 503, `status=${r.status} (503 = failed closed)`);
  check("R-02: no access token is issued",
    !body.accessToken && !body.refreshToken, `access=${body.accessToken}`);
  check("R-02: no trusted device is created",
    body.trusted !== true, `trusted=${body.trusted}`);
  check("R-02: the error says registration is not configured",
    body.error === "registration_not_configured", `error=${body.error}`);

  // A login attempt must also not be possible (no user was ever created).
  const l = await fetch(BASE + "/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "attacker@evil.local", password: "supersecret123",
      fingerprint: "f" + "a".repeat(32),
    }),
  });
  check("R-02: the attacker account was NOT created (login -> 401)",
    l.status === 401, `status=${l.status}`);
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  server.kill("SIGKILL");
  await psqlRun("postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}';`).catch(() => {});
  await psqlRun("postgres", `DROP DATABASE IF EXISTS ${DB};`).catch(() => {});
  await psqlRun("postgres", `DROP ROLE IF EXISTS friday_audit_r02;`).catch(() => {});
}

console.log(`\n--- R-02: ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
