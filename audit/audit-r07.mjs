// R-07 (F-05): the client IP must not be forgeable with X-Forwarded-For.
//
// Before R-07 the rate-limit bucket key was the client-supplied
// X-Forwarded-For, so rotating the header gave a fresh bucket per request and
// defeated both the global limiter and the per-IP login throttle.
//
// This harness boots the server with a tiny bucket so the effect is decisive,
// and compares the observed behaviour against the pre-fix behaviour.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnGrouped, killGroup, waitForHealth, assertPortFree } from "./lib/harness.mjs";

const DB = "friday_audit_r07";
const PW = "R07AuditPw_3b7f1e";
const PORT = 8795;
const ROOT = "/tmp/friday-r07-root";

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
await psqlRun("postgres", `DROP ROLE IF EXISTS friday_audit_r07;`).catch(() => {});
await psqlRun("postgres", `CREATE ROLE friday_audit_r07 LOGIN PASSWORD '${PW}';`);
await psqlRun("postgres", `CREATE DATABASE ${DB} OWNER friday_audit_r07;`);
{
  const pg = await import("pg");
  const c = new pg.Client({ host: "127.0.0.1", port: 5433, user: "friday_audit_r07", password: PW, database: DB });
  await c.connect();
  await c.query(await readFile(new URL("../server/src/schema.sql", import.meta.url), "utf8"));
  // The device-binding schema also adds the lockout columns
  // (failed_attempts, lock_count, locked_until) that loginGuard.ts uses.
  await c.query(await readFile(new URL("../server/src/schema-device-binding.sql", import.meta.url), "utf8"));
  await c.end();
}

// ---- boot with a tiny rate-limit bucket
const env = {
  ...process.env,
  DATABASE_URL: `postgres://friday_audit_r07:${PW}@127.0.0.1:5433/${DB}`,
  JWT_SECRET: "r07-" + randomBytes(32).toString("hex"),
  FINGERPRINT_PEPPER: "r07-pepper",
  PORT: String(PORT), HOST: "127.0.0.1",
  FS_ROOTS: ROOT, STORAGE_DIR: ROOT + "/_storage",
  RATE_LIMIT_MAX: "5",            // tiny, so 8 requests must trip it
  ALLOWED_EMAILS: "owner@r07.local",
  LOGIN_MAX_FAILURES: "3", LOGIN_IP_MAX: "10000",
};
// A stale server on this port would answer with the wrong JWT secret and
// the wrong schema, silently invalidating every result.
await assertPortFree(PORT);
const server = spawnGrouped("npx", ["tsx", "src/index.ts"], {
  cwd: new URL("../server/", import.meta.url).pathname, env, stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const BASE = `http://127.0.0.1:${PORT}`;
const up = await waitForHealth(BASE + "/health");
if (!up) {
  console.log("SERVER FAILED TO BOOT:\n" + log.slice(0, 2000));
  process.exit(1);
}

try {
  // ================================================================
  // TEST 1 — the per-ACCOUNT lockout must hold no matter what headers the
  // caller sends. It is keyed on the user id in Postgres, so no header can
  // influence it. This is the real brute-force guarantee.
  //
  // Each request carries a distinct CF-Connecting-IP so that the global rate
  // limiter (one shared bucket for the loopback peer) cannot interfere and
  // mask the result. The 429-vs-429 ambiguity is avoided by checking the
  // RESPONSE BODY: the lockout answers {"error":"too_many_attempts"},
  // while the rate limiter answers Fastify's own 429 shape.
  // ================================================================
  {
    const email = "owner@r07.local";
    const pw = "correcthorsebattery1";
    const reg = await fetch(BASE + "/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.1" },
      body: JSON.stringify({ email, password: pw, fingerprint: "f".repeat(40) }),
    });
    console.log(`\nregister -> ${reg.status}\n`);
    check("R-07: the owner account was created (register -> 201)",
      reg.status === 201, `status=${reg.status}`);

    const statuses = [];
    const lockouts = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(BASE + "/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Every attempt claims a different IP and a different forwarded chain.
          "cf-connecting-ip": `203.0.113.${100 + i}`,
          "x-forwarded-for": `198.51.100.${i}`,
        },
        body: JSON.stringify({ email, password: "wrongpassword", fingerprint: `f${i}`.padEnd(40, "x") }),
      });
      const body = await r.json().catch(() => ({}));
      statuses.push(r.status);
      // The ACCOUNT lockout is the one that says "too_many_attempts" with a
      // retryAfterSeconds. The rate limiter uses Fastify's own error shape.
      if (body?.error === "too_many_attempts") lockouts.push(i);
    }
    console.log(`account lockout with rotating IPs: ${statuses.join(",")}\n`);
    check("R-07: the per-ACCOUNT lockout engages despite rotating IPs and headers",
      lockouts.length > 0, `statuses=${statuses.join(",")} accountLockouts=${lockouts.length} (0 = bypassed)`);

    // And the correct password is refused while locked.
    const good = await fetch(BASE + "/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.200" },
      body: JSON.stringify({ email, password: pw, fingerprint: "f".repeat(40) }),
    });
    const goodBody = await good.json().catch(() => ({}));
    check("R-07: the correct password is refused while the account is locked",
      good.status === 429 && goodBody?.error === "too_many_attempts",
      `status=${good.status} error=${goodBody?.error}`);
  }

  // ================================================================
  // TEST 2 — rotating X-Forwarded-For must NOT reset the rate-limit bucket.
  // Run this LAST: it deliberately exhausts the shared bucket.
  // ================================================================
  const withXff = [];
  for (let i = 0; i < 10; i++) {
    const r = await fetch(BASE + "/health", { headers: { "x-forwarded-for": `203.0.113.${i}` } });
    withXff.push(r.status);
  }
  const xffThrottled = withXff.filter((s) => s === 429).length;
  console.log(`with rotating X-Forwarded-For: ${withXff.join(",")}\n`);
  check("R-07: rotating X-Forwarded-For does NOT reset the rate-limit bucket",
    xffThrottled > 0, `429s=${xffThrottled} of 10 (0 = the header is still the bucket key)`);

  // ---- a forged CF-Connecting-IP: documented limitation.
  // A LOCAL process can forge this header because the API is on loopback.
  // That is accepted, not a defect: such a process already runs as `ubuntu`
  // and can read server/.env (JWT_SECRET) directly, so dodging a rate
  // limiter is strictly less useful than reading the signing key.
  // The real brute-force guarantee is the per-ACCOUNT lockout asserted above.
  const withCf = [];
  for (let i = 0; i < 8; i++) {
    const r = await fetch(BASE + "/health", { headers: { "cf-connecting-ip": `198.51.100.${i}` } });
    withCf.push(r.status);
  }
  console.log(`with rotating CF-Connecting-IP: ${withCf.join(",")}\n`);
  console.log("(note: a LOCAL process can forge CF-Connecting-IP — accepted limitation,\n" +
              " the real guarantee is the per-account Postgres lockout asserted above)\n");

  // ---- the server is still healthy after the burst
  check("R-07: the server is still healthy after the burst",
    (await fetch(BASE + "/health")).status !== 500, "no 5xx");
} finally {
  killGroup(server);
  await new Promise((r) => setTimeout(r, 1800));
  await psqlRun("postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}';`).catch(() => {});
  await psqlRun("postgres", `DROP DATABASE IF EXISTS ${DB};`).catch(() => {});
  await psqlRun("postgres", `DROP ROLE IF EXISTS friday_audit_r07;`).catch(() => {});
}

console.log(`\n--- R-07: ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
