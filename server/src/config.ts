/**
 * Central configuration.
 *
 * This module exists to solve audit finding F-10: the terminal child process
 * inherited the server's entire environment via `env: { ...process.env }`,
 * which handed a live shell the JWT signing secret, the database password
 * and the fingerprint pepper. A prompt injection into Hermes or OpenCode
 * could read them with a single `env` command.
 *
 * The fix has two halves:
 *
 *  1. `env.ts` reads the secrets into this typed object and then DELETES them
 *     from `process.env`. Anything that later reads `process.env` — including
 *     a child process spawned with `...process.env` — no longer sees them.
 *  2. `terminal.ts` builds an explicit allowlist environment for the child
 *     rather than spreading the server's environment into it.
 *
 * The secrets are still in memory (they have to be, to sign tokens and open
 * database connections). This is about not handing them to another process
 * for free.
 *
 * This module must be imported AFTER `./env.js`, which is what loads
 * server/.env in the first place. ES modules evaluate in declaration order,
 * so `import "./env.js"` first in an entrypoint guarantees the .env file is
 * read before this module snapshots the values.
 */

export interface ServerConfig {
  databaseUrl: string;
  jwtSecret: string;
  fingerprintPepper: string;
  allowedEmails: string;
  fsRoots: string;
  storageDir: string;
  /**
   * Working directory (and, via childEnv, the child's HOME) for terminal
   * sessions. Point this at a dedicated directory so the terminal does not
   * run in the owner's home, where .hermes and .ssh live.
   */
  terminalCwd: string;
  host: string;
  port: number;
  logLevel: string;
  appVersion: string;
  corsOrigins: string;
  maxUploadBytes: number;
  maxDownloadBytes: number;
  rateLimitMax: number;
  loginMaxFailures: number;
  loginIpMax: number;
}

/** The names that are scrubbed from process.env once they are captured. */
const SECRET_ENV_NAMES = [
  "DATABASE_URL",
  "JWT_SECRET",
  "FINGERPRINT_PEPPER",
  "FRIDAY_OWNER_PASSWORD",
] as const;

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`${name} is not set`);
  }
  return v;
}

/**
 * The owner bootstrap credential, captured BEFORE the scrub below.
 *
 * seed-owner.ts reads it at module scope, and it is the documented recovery
 * path for a lost or exposed owner password. It must survive the environment
 * scrub long enough for that script to use it — and it must never be handed
 * to a spawned child, which the scrub guarantees.
 */
export const ownerCredentials = {
  email: (process.env.FRIDAY_OWNER_EMAIL ?? "").trim().toLowerCase(),
  password: process.env.FRIDAY_OWNER_PASSWORD ?? "",
};

export const config: ServerConfig = {
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  fingerprintPepper: required("FINGERPRINT_PEPPER"),
  allowedEmails: process.env.ALLOWED_EMAILS ?? "",
  fsRoots: process.env.FS_ROOTS ?? "/home/ubuntu/friday-one/storage",
  storageDir: process.env.STORAGE_DIR ?? "/home/ubuntu/friday-one/storage",
  terminalCwd: process.env.TERMINAL_CWD ?? "/home/ubuntu",
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  logLevel: process.env.LOG_LEVEL ?? "info",
  appVersion: process.env.APP_VERSION ?? "0.1.0",
  corsOrigins: process.env.CORS_ORIGINS ?? "",
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 200 * 1024 * 1024),
  maxDownloadBytes: Number(process.env.MAX_DOWNLOAD_BYTES ?? 500 * 1024 * 1024),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 120),
  loginMaxFailures: Number(process.env.LOGIN_MAX_FAILURES ?? 5),
  loginIpMax: Number(process.env.LOGIN_IP_MAX ?? 10),
};

// Scrub the secrets from the process environment. From here on, a child
// spawned with `...process.env` inherits the non-secret configuration but NOT
// the signing key, the database password or the pepper.
//
// `DB_PASSWORD` style variables are left alone: they are not used by this
// application and removing them could break the systemd unit's environment
// for other services.
for (const name of SECRET_ENV_NAMES) {
  delete process.env[name];
}

/**
 * A minimal, explicit environment for a spawned child process.
 *
 * Only the variables a terminal actually needs are included. Notably absent:
 * the JWT secret, the database URL and the fingerprint pepper — and, because
 * the child's HOME is set to the working directory rather than the owner's
 * home, the child's own `~/.hermes` and `~/.ssh` are out of reach too.
 */
export function childEnv(opts: {
  home: string;
  term: string;
  cols: number;
  rows: number;
}): Record<string, string> {
  const lang = process.env.LANG ?? process.env.LC_ALL ?? "C.UTF-8";
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: opts.home,
    LANG: lang,
    TERM: opts.term,
    COLUMNS: String(opts.cols),
    LINES: String(opts.rows),
    COLORTERM: "truecolor",
    FORCE_COLOR: "1",
    // Agents (Hermes, OpenCode) look for a writable home for their own state.
    // They are pointed at the terminal's working directory, not the owner's.
    XDG_CONFIG_HOME: `${opts.home}/.config`,
    XDG_DATA_HOME: `${opts.home}/.local/share`,
    XDG_CACHE_HOME: `${opts.home}/.cache`,
  };
}
