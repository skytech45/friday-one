/**
 * Load server/.env before anything reads process.env.
 *
 * This module must be the FIRST import in an entrypoint: ES modules evaluate in
 * declaration order, so importing "./env.js" first guarantees DATABASE_URL and
 * friends exist before db.ts inspects them at module scope.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(here, "..", ".env"),
  join(here, ".env"),
];

for (const path of candidates) {
  if (existsSync(path)) {
    // Node >= 20.12; skips variables already present in the real environment.
    process.loadEnvFile(path);
    break;
  }
}
