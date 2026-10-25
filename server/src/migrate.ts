import "./env.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

// Migrations need CREATE/ALTER on the schema — privileges the application
// role must not have (F-09). They run as the bootstrap role from
// MIGRATE_DATABASE_URL, which only this short-lived process reads before the
// server starts; the server itself connects with the least-privilege
// DATABASE_URL. Falls back to DATABASE_URL so test harnesses (which provision
// an owning role anyway) keep working unchanged.
const migrateUrl = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!migrateUrl) {
  console.error("migration failed: neither MIGRATE_DATABASE_URL nor DATABASE_URL is set");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: migrateUrl,
  max: 1,
  connectionTimeoutMillis: 5_000,
});

async function main(): Promise<void> {
  // Applied in order. Both files use IF NOT EXISTS throughout, so re-running is
  // safe - which matters because this runs on every boot.
  for (const file of ["schema.sql", "schema-device-binding.sql"]) {
    const sql = await readFile(join(here, file), "utf8");
    await pool.query(sql);
  }
  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::text as n from information_schema.tables where table_schema = 'public'",
  );
  console.log(`migrated: ${rows[0]?.n ?? "?"} tables in public`);
}

main()
  .catch(async (err) => {
    console.error("migration failed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
