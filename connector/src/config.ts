/**
 * Connector configuration.
 *
 * Secrets live in a file ONLY the connector's OS account can read (0600),
 * never in the repo, never in the process environment of anything else.
 * The systemd unit passes the path; this module loads and scrubs it.
 *
 * NOTHING here is allowed to be a privileged backend secret: the connector
 * holds exactly one thing of value — its own revocable credential.
 */
import { readFileSync, statSync } from "node:fs";

export interface ConnectorConfig {
  /** Realtime gateway WSS endpoint (Phase 4 deliverable). */
  gatewayUrl: string;
  /** Control plane base URL for pairing redemption (HTTPS). */
  controlPlaneUrl: string;
  /**
   * The connector credential (bearer). Loaded from the credential file
   * written by pairing; file must be 0600 and owned by this account.
   */
  credentialFile: string;
  /** Project roots this connector is allowed to operate in. */
  allowedRoots: string[];
  /** Where policies are read from (synced by the control plane). */
  policyDir: string;
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  const cfg: ConnectorConfig = {
    gatewayUrl: env.FRIDAY_GATEWAY_URL ?? "",
    controlPlaneUrl: required("FRIDAY_CONTROL_PLANE_URL", env).replace(/\/$/, ""),
    credentialFile: env.FRIDAY_CREDENTIAL_FILE ?? "/etc/friday-connector/credential",
    allowedRoots: (env.FRIDAY_ALLOWED_ROOTS ?? "").split(":").filter(Boolean),
    policyDir: env.FRIDAY_POLICY_DIR ?? "/etc/friday-connector/policies",
  };
  // The gateway may be unset while Phase 4 lands — pairing still works. But
  // never run the serve loop without one: an idle connector that claims to be
  // connected is a lie in the status UI.
  if (!cfg.gatewayUrl) {
    console.warn("[config] FRIDAY_GATEWAY_URL not set: pairing-only mode");
  }
  return cfg;
}

/** Read the credential file, verify its permissions, scrub the value. */
export function readCredential(path: string): string {
  const st = statSync(path);
  if (st.mode & 0o077) {
    throw new Error(`${path} must not be readable by group/others (chmod 600)`);
  }
  return readFileSync(path, "utf8").trim();
}
