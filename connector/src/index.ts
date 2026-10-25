/**
 * FRIDAY Connector entrypoint.
 *
 * STATUS: pairing + policy gate + gateway client skeleton (Phase 1-4 prep).
 * What is deliberately NOT here yet: adapter runtime (Phase 5), the PTY
 * bridge migration, and the gateway to talk to. See connector/README.md.
 *
 * Security posture: runs as a dedicated unprivileged account; its only
 * secret is its own revocable credential; the policy gate fails closed.
 */
import { loadConfig, readCredential } from "./config.js";
import { installCredential, redeemPairingCode } from "./pairing.js";
import { loadPolicy } from "./policy.js";
import { GatewayConnection } from "./gateway.js";

const CONNECTOR_VERSION = "0.1.0";

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
    console.log(`connector ${CONNECTOR_VERSION} starting (pairing-only? ${cfg.gatewayUrl ? "no" : "yes"})`);

    if (cfg.gatewayUrl) {
      // serverId arrives with the auth handshake response; the placeholder is
      // replaced when the gateway echoes the bound identity.
      const conn = new GatewayConnection({
        url: cfg.gatewayUrl,
        serverId: "00000000-0000-0000-0000-000000000000",
        connectorId: "00000000-0000-0000-0000-000000000000",
        credential: () => readCredential(cfg.credentialFile),
        onMessage: (env) => {
          console.log(`[gateway] inbound: ${env.event_type}`);
        },
      });
      conn.start();
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
