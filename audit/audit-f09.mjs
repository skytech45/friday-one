// F-09 regression: the API server must connect through a least-privilege
// role, not the PostgreSQL superuser that bootstraps the container.
//
// Checks, against the LIVE server/.env:
//   1. DATABASE_URL authenticates as a non-bootstrap role (friday_app);
//   2. that role has no SUPERUSER / CREATEDB / CREATEROLE / REPLICATION /
//      BYPASSRLS;
//   3. CREATE DATABASE is refused for it;
//   4. no CREATE on schema public (DDL refused);
//   5. the DML grants the app needs are present;
//   6. MIGRATE_DATABASE_URL is set and still works (migrate.ts path).
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import pg from "pg";

const envText = readFileSync(new URL("../server/.env", import.meta.url), "utf8");
const readEnv = (name) => {
  const m = envText.match(new RegExp(`^${name}=(\\S+)`, "m"));
  if (!m) throw new Error(`${name} missing from server/.env`);
  return m[1];
};

const appUrl = readEnv("DATABASE_URL");
const migrateUrl = readEnv("MIGRATE_DATABASE_URL");
const appUser = new URL(appUrl).username;
if (appUser === "friday") throw new Error("DATABASE_URL still uses the bootstrap superuser role");
console.log(`app role: ${appUser}`);

// Migrate FIRST: on a fresh database (CI container) the tables do not exist
// yet, and the DML checks below need them. This is also the production order
// — migrate.ts runs as the bootstrap role before the server starts.
const migPre = spawnSync("npx", ["tsx", "src/migrate.ts"], {
  cwd: new URL("../server", import.meta.url).pathname,
  env: { ...process.env, MIGRATE_DATABASE_URL: migrateUrl },
  encoding: "utf8",
});
if (migPre.status !== 0) {
  console.error(`migrate.ts failed: ${(migPre.stderr || "").trim().split("\n").pop()}`);
  process.exit(1);
}
console.log(`pre-migrate: ${(migPre.stdout || "").trim().split("\n").pop()}`);

const c = new pg.Client({ connectionString: appUrl });
await c.connect();

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const role = await c.query(
  "select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls from pg_roles where rolname = current_user",
);
check(role.rows.length === 1, "app role exists");
const r = role.rows[0];
check(!r.rolsuper, "not superuser");
check(!r.rolcreatedb, "no CREATEDB");
check(!r.rolcreaterole, "no CREATEROLE");
check(!r.rolreplication, "no REPLICATION");
check(!r.rolbypassrls, "no BYPASSRLS");

check(!(await c.query("select has_database_privilege(current_user, current_database(), 'CREATE')")).rows[0].has_database_privilege, "no CREATE privilege on database");
check(!(await c.query("select has_schema_privilege(current_user, 'public', 'CREATE')")).rows[0].has_schema_privilege, "no CREATE privilege on schema public");

let createDbRefused = false;
try {
  await c.query("CREATE DATABASE friday_f09_probe");
} catch {
  createDbRefused = true;
}
check(createDbRefused, "CREATE DATABASE statement actually fails");

const tables = ["users", "devices", "sessions", "files", "crash_reports", "audit_log"];
for (const t of tables) {
  const has = await c.query("select has_table_privilege(current_user, $1, $2) as ok", [t, "SELECT, INSERT, UPDATE, DELETE"]);
  check(has.rows[0].ok, `DML on ${t}`);
}
await c.end();

// The bootstrap role must STILL be able to migrate (idempotent re-run).
const mig = spawnSync("npx", ["tsx", "src/migrate.ts"], {
  cwd: new URL("../server", import.meta.url).pathname,
  env: { ...process.env, MIGRATE_DATABASE_URL: migrateUrl },
  encoding: "utf8",
});
check(mig.status === 0, `migrate.ts runs as bootstrap role${mig.status === 0 ? ` (${(mig.stdout || "").trim().split("\n").pop()})` : `: ${(mig.stderr || "").trim().split("\n").pop()}`}`);

console.log(failures === 0 ? "F-09: ALL CHECKS PASS" : `F-09: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
