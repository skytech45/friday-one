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
function required(name, env) {
    const v = env[name];
    if (!v)
        throw new Error(`${name} is not set`);
    return v;
}
export function loadConfig(env = process.env) {
    const cfg = {
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
export function readCredential(path) {
    const st = statSync(path);
    if (st.mode & 0o077) {
        throw new Error(`${path} must not be readable by group/others (chmod 600)`);
    }
    return readFileSync(path, "utf8").trim();
}
