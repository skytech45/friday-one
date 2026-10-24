// R-09 / R-11 (F-10): the terminal child must NOT inherit the server's secrets.
//
// Before the fix, terminal.ts spawned the PTY with `env: { ...process.env }`,
// so a live shell held JWT_SECRET, DATABASE_URL and FINGERPRINT_PEPPER, and
// could read ~/.hermes/auth.json, ~/.ssh/authorized_keys and the server .env.
//
// After the fix:
//   * config.ts scrubs the secrets from process.env at startup;
//   * the child gets an explicit allowlist environment;
//   * the child's HOME is the terminal's working directory, not the owner's.
//
// This harness opens a real terminal, runs commands inside it, and reads the
// answers back over the WebSocket.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { spawnGrouped, killGroup, waitForHealth, assertPortFree } from "./lib/harness.mjs";

const DB = "friday_audit_r09";
const PW = "R09AuditPw_7d2e4f";
const PORT = 8793;
// A working directory for the terminal that is NOT the owner's home.
const WORKDIR = realpathSync(await mkdtemp("/tmp/friday-r09-home-"));

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

await psqlRun("postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}';`).catch(() => {});
await psqlRun("postgres", `DROP DATABASE IF EXISTS ${DB};`).catch(() => {});
await psqlRun("postgres", `DROP ROLE IF EXISTS friday_audit_r09;`).catch(() => {});
await psqlRun("postgres", `CREATE ROLE friday_audit_r09 LOGIN PASSWORD '${PW}';`);
await psqlRun("postgres", `CREATE DATABASE ${DB} OWNER friday_audit_r09;`);
{
  const pg = await import("pg");
  const c = new pg.Client({ host: "127.0.0.1", port: 5433, user: "friday_audit_r09", password: PW, database: DB });
  await c.connect();
  await c.query(await readFile(new URL("../server/src/schema.sql", import.meta.url), "utf8"));
  await c.query(await readFile(new URL("../server/src/schema-device-binding.sql", import.meta.url), "utf8"));
  await c.end();
}

// Canaries that must never reach the child.
const JWT_CANARY = "JWT_CANARY_" + randomBytes(8).toString("hex");
const DB_CANARY = "DBURL_CANARY_" + randomBytes(8).toString("hex");
const PEPPER_CANARY = "PEPPER_CANARY_" + randomBytes(8).toString("hex");

// A secret file in the OWNER's home, to prove HOME redirection works.
const ownerHomeSecret = join(process.env.HOME ?? "/home/ubuntu", ".friday-r09-canary");
await writeFile(ownerHomeSecret, "OWNER_HOME_SECRET\n");

// The terminal's working directory: the child should see THIS as its home.
await mkdir(join(WORKDIR, "work"), { recursive: true });
await writeFile(join(WORKDIR, "work", "marker.txt"), "in-workdir\n");

const env = {
  ...process.env,
  DATABASE_URL: `postgres://friday_audit_r09:${PW}@127.0.0.1:5433/${DB}?${DB_CANARY}`,
  JWT_SECRET: `${JWT_CANARY}-secret`,
  FINGERPRINT_PEPPER: PEPPER_CANARY,
  PORT: String(PORT), HOST: "127.0.0.1",
  FS_ROOTS: WORKDIR, STORAGE_DIR: join(WORKDIR, "storage"),
  TERMINAL_CWD: WORKDIR,
  RATE_LIMIT_MAX: "1000",
  ALLOWED_EMAILS: "owner@r09.local",
  LOGIN_MAX_FAILURES: "3", LOGIN_IP_MAX: "10000",
};

await assertPortFree(PORT);
const server = spawnGrouped("npx", ["tsx", "src/index.ts"], {
  cwd: new URL("../server/", import.meta.url).pathname, env, stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const BASE = `http://127.0.0.1:${PORT}`;
try {
  if (!(await waitForHealth(BASE + "/health"))) {
    console.log("SERVER FAILED TO BOOT:\n" + log.slice(0, 2500));
    process.exit(1);
  }

  // Register + get a token.
  const reg = await fetch(BASE + "/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "owner@r09.local", password: "correcthorsebattery1",
      fingerprint: "f".repeat(40), name: "r09", platform: "linux", appVersion: "1",
    }),
  });
  const regBody = await reg.json().catch(() => ({}));
  console.log(`\nregister -> ${reg.status}\n`);
  if (!regBody.accessToken) {
    console.log("no token issued; aborting");
    process.exit(1);
  }

  // Open a terminal and run commands in it, collecting the output.
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal?kind=shell&token=${regBody.accessToken}`);
  let out = "";
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), 15000);
    ws.on("open", () => { clearTimeout(t); resolve(); });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });
  ws.on("message", (d) => { out += d.toString(); });

  // The PTY echoes everything we send, so a plain sentinel appears in the
  // ECHO of the command before any real output. Two defences:
  //   1. `stty -echo` stops the terminal echoing our input at all.
  //   2. the sentinel is computed by the shell ($((6*7)) -> 42), so the
  //      echoed command text never contains the literal marker.
  ws.send("stty -echo\n");
  await new Promise((r) => setTimeout(r, 900));

  const runCmd = async (cmd) => {
    out = "";
    const token = Math.random().toString(36).slice(2, 8);
    // Sent as `echo R09END_<token>_$((6*7))`; the OUTPUT is `R09END_<token>_42`
    // and that literal string is what we wait for.
    const marker = `R09END_${token}_42`;
    ws.send(`${cmd}\n`);
    ws.send(`echo R09END_${token}_$((6*7))\n`);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !out.includes(marker)) {
      await new Promise((r) => setTimeout(r, 120));
    }
    const idx = out.indexOf(marker);
    if (idx < 0) console.log(`  (warning: marker not seen for "${cmd.slice(0, 40)}")`);
    const body = idx >= 0 ? out.slice(0, idx) : out;
    // Drop any residual CR noise and prompt lines so assertions read cleanly.
    return body.replace(/\r/g, "");
  };

  // 1. The secrets must not be in the child's environment.
  //    Capture the environment once and reuse it, but ALSO assert the capture
  //    actually happened — otherwise "not found" is meaningless.
  const envDump = await runCmd("env");
  const envLines = envDump.split("\n").filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l.trim()));
  check("R-09: the environment was actually captured (non-empty)",
    envLines.length > 0, `${envLines.length} variables parsed from the terminal`);
  check("R-09: JWT_SECRET is NOT in the terminal environment",
    envLines.length > 0 && !envDump.includes(JWT_CANARY),
    envDump.includes(JWT_CANARY) ? "LEAKED" : "absent");
  check("R-09: DATABASE_URL is NOT in the terminal environment",
    envLines.length > 0 && !envDump.includes(DB_CANARY),
    envDump.includes(DB_CANARY) ? "LEAKED" : "absent");
  check("R-09: FINGERPRINT_PEPPER is NOT in the terminal environment",
    envLines.length > 0 && !envDump.includes(PEPPER_CANARY),
    envDump.includes(PEPPER_CANARY) ? "LEAKED" : "absent");

  // 2. The child's HOME must be the working directory, not the owner's home.
  const homeOut = await runCmd("echo HOME=$HOME");
  const homeLine = homeOut.split("\n").reverse().find((l) => /HOME=\//.test(l)) ?? "(not found)";
  check("R-11: the terminal HOME is the working directory, not the owner's",
    homeLine.includes(`HOME=${WORKDIR}`), homeLine.trim());

  // 3. The child's environment should be small and explicit.
  console.log(`  (child env has ${envLines.length} variables)`);
  check("R-11: the child environment is a small explicit allowlist (<= 20 vars)",
    envLines.length > 0 && envLines.length <= 20, `${envLines.length} variables`);

  // 4. The terminal must still work: PATH, TERM and a shell.
  const uidOut = await runCmd("echo UID_$(id -u)");
  const uidMatch = uidOut.match(/UID_(\d+)/);
  check("R-11: the terminal is still functional (id -u returned a uid)",
    !!uidMatch, uidMatch ? `uid=${uidMatch[1]}` : JSON.stringify(uidOut.slice(0, 120)));

  // 5. HOME redirection alone is not a boundary: the child still runs as the
  //    owner's uid, so an absolute path into the owner's home is readable.
  //    Record that honestly — R-10 (a separate OS user) is the real fix.
  const absOut = await runCmd(`test -r ${process.env.HOME}/.friday-r09-canary && echo READABLE || echo DENIED`);
  console.log(`  (absolute-path probe into the owner's home: ${(absOut.match(/READABLE|DENIED/) ?? ["?"])[0]})`);

  ws.close();
} finally {
  killGroup(server);
  await new Promise((r) => setTimeout(r, 1800));
  await psqlRun("postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}';`).catch(() => {});
  await psqlRun("postgres", `DROP DATABASE IF EXISTS ${DB};`).catch(() => {});
  await psqlRun("postgres", `DROP ROLE IF EXISTS friday_audit_r09;`).catch(() => {});
  await rm(WORKDIR, { recursive: true, force: true }).catch(() => {});
  await rm(ownerHomeSecret, { force: true }).catch(() => {});
}

console.log(`\n--- R-09/R-11: ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
