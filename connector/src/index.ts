/**
 * FRIDAY Connector entrypoint.
 *
 * STATUS: pairing verified end-to-end; gateway connection LIVE against the
 * local gateway (Phase 4). What remains for later phases: adapter runtime
 * (Phase 5, ACP), command execution loop, PTY bridge migration.
 *
 * Security posture: runs as a dedicated unprivileged account; its only
 * secret is its own revocable credential; the policy gate fails closed.
 */
import { loadConfig, readCredential } from "./config.js";
import { installCredential, redeemPairingCode } from "./pairing.js";
import { loadPolicy } from "./policy.js";
import { GatewayConnection } from "./gateway.js";

const CONNECTOR_VERSION = "0.1.0";

/** Identity holder: filled from the gateway's auth.resume.ok (mutable ref). */
const ids = { serverId: "00000000-0000-0000-0000-000000000000", connectorId: "" };

async function main(): Promise<void> {
  const cfg = loadConfig();
  const command = process.argv[2] ?? "run";

  if (command === "pair") {
    const code = process.env.FRIDAY_PAIRING_CODE ?? "";
    if (!code) throw new Error("FRIDAY_PAIRING_CODE is required for `pair` (single-use, from the app)");
    const result = await redeemPairingCode(cfg.controlPlaneUrl, code, CONNECTOR_VERSION);
    installCredential(cfg.credentialFile, result.credential);
    console.log(`paired: server ${result.serverId}; credential written to ${cfg.credentialFile}`);
    return;
  }

  if (command === "run") {
    const credential = readCredential(cfg.credentialFile);
    console.log(`connector ${CONNECTOR_VERSION} starting`);

    if (cfg.gatewayUrl) {
      const conn = new GatewayConnection({
        url: cfg.gatewayUrl,
        ids,
        credential: () => readCredential(cfg.credentialFile),
        onMessage: (env) => {
          if (env.event_type === "auth.resume.ok") {
            const p = env.payload as { server_id?: string; connector_id?: string };
            if (typeof p.server_id === "string") ids.serverId = p.server_id;
            if (typeof p.connector_id === "string") ids.connectorId = p.connector_id;
            console.log(`gateway accepted us: server=${ids.serverId} connector=${ids.connectorId}`);            return;
          }
          console.log(`[gateway] inbound: ${env.event_type}`);
        },
        log: console.log,
      });
      conn.start();
    } else {
      console.warn("[config] FRIDAY_GATEWAY_URL not set: running disconnected");
    }

    // Policy file presence is a startup assertion: the gate must have
    // SOMETHING to enforce, even an empty rule set, or we fail closed loudly.
    try {
      const policy = loadPolicy(cfg.policyDir);
      console.log(`policy loaded: v${policy.version}, ${policy.rules.length} rule(s)`);
    } catch {
      console.warn(`no policy file under ${cfg.policyDir}: fail-closed defaults apply`);
    }
    return;
  }

  throw new Error(`unknown command: ${command} (use: pair | run)`);
}

main().catch((err) => {
  console.error("connector failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
