/**
 * Pairing: redeem a short-lived, single-use code for the connector credential.
 *
 * Flow (SYSTEM_DESIGN §7): the owner requests enrollment in the app; the
 * control plane issues a cryptographically random code (hashed at rest,
 * rate-limited redemption); the operator runs THIS on the server with their
 * own SSH access; over TLS we exchange the code for a bearer credential bound
 * to one server + owner. The code is never logged; the credential is written
 * 0600 and never echoed.
 */
import { mkdirSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";

export interface PairingResult {
  serverId: string;
  credential: string;
  credentialExpiresAt: string | null;
}

/**
 * Redeem `code` at the control plane. The code is transmitted ONLY over the
 * HTTPS body; on failure the code is discarded by the caller (single use).
 */
export async function redeemPairingCode(
  controlPlaneUrl: string,
  code: string,
  connectorVersion: string,
): Promise<PairingResult> {
  const res = await fetch(`${controlPlaneUrl}/api/v1/servers/enrollments/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, connector_version: connectorVersion }),
  });
  if (!res.ok) {
    // Deliberately terse: never echo the code or server-side detail.
    throw new Error(`pairing rejected (HTTP ${res.status})`);
  }
  const body = (await res.json()) as {
    server_id: string;
    credential: string;
    credential_expires_at: string | null;
  };
  return {
    serverId: body.server_id,
    credential: body.credential,
    credentialExpiresAt: body.credential_expires_at ?? null,
  };
}

/** Write the credential with 0600 into place; verify what we wrote. */
export function installCredential(path: string, credential: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${credential}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error(`credential file permission is ${mode.toString(8)}, expected 600`);
}
