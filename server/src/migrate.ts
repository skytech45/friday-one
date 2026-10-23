import "./env.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool, closePool } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));

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
  await closePool();
}

main().catch(async (err) => {
  console.error("migration failed:", err);
  await closePool().catch(() => {});
  process.exit(1);
});
