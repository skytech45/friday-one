/**
 * Load server/.env before anything reads process.env.
 *
 * This module must be the FIRST import in an entrypoint: ES modules evaluate in
 * declaration order, so importing "./env.js" first guarantees DATABASE_URL and
 * friends exist before db.ts inspects them at module scope.
 *
 * PRECEDENCE: the real process environment WINS over the .env file. That is
 * Node's behaviour and it is the right one — systemd's Environment=, a test
 * harness, and a one-off `PORT=8799 npm start` must all be able to override
 * the file. (Forcing the file to win was tried during the audit and broke
 * every harness, because each one binds its own port.)
 *
 * The failure mode that precedence creates is a SILENT one: a stale exported
 * variable quietly wins over the file and the server runs with a value nobody
 * intended. So the file is also parsed just to REPORT conflicts. A warning is
 * loud and cheap; a silent wrong port or a silent wrong root is neither.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(here, "..", ".env"),
  join(here, ".env"),
];

/** Parse a .env file into key/value pairs without touching process.env. */
function parseEnvFile(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Strip a trailing inline comment only when the value is unquoted.
    if (!/^["']/.test(value)) {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out.push([key, value]);
  }
  return out;
}

for (const path of candidates) {
  if (existsSync(path)) {
    // Values already present in the real environment take precedence.
    process.loadEnvFile(path);

    // Report (do not resolve) any key where the environment and the file
    // disagree, so a stale export cannot change behaviour silently.
    const conflicts = parseEnvFile(readFileSync(path, "utf8"))
      .filter(([key, value]) => process.env[key] !== undefined && process.env[key] !== value)
      .map(([key]) => key);
    if (conflicts.length > 0) {
      console.warn(
        `[env] the process environment overrides ${conflicts.length} value(s) from ${path}: ` +
          `${conflicts.join(", ")}. If that is not intended, unset them.`,
      );
    }
    break;
  }
}
