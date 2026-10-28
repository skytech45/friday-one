/**
 * Connector enrollment mode (plan v2.0 §7):
 *   1. exchange the enrollment token for a display session
 *   2. render QR (ASCII) + 16–20 digit code in the terminal
 *   3. poll until the app claims; pick up the credential ONCE
 *   4. install it 0600 and exit — the systemd service then connects
 *
 * The code authorizes PAIRING ONLY. It is never logged, never stored raw.
 */
import { setTimeout as sleep } from "node:timers/promises";
import QRCode from "qrcode";
import { installCredential } from "./pairing.js";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 11 * 60_000; // display code lives 10 min

/**
 * Real scannable QR (plan v2 §4: QR contains an opaque temporary payload,
 * never a permanent secret). Payload: fridayone://pair?e=<enrollment>&c=<code>
 * — the app scans and claims without typing. The numeric code stays as the
 * manual fallback.
 */
async function render(enrollmentId: string, code: string, expiresAt: string): Promise<void> {
  const grouped = code.replace(/(\d{4})(?=\d)/g, "$1 ");
  const payload = `fridayone://pair?e=${enrollmentId}&c=${code}`;
  // `small` is a terminal-renderer option the @types package doesn't model;
  // runtime honours it (verified) — hence the cast.
  const qr = await QRCode.toString(payload, {
    type: "utf8",
    margin: 2,
    small: true,
  } as Parameters<typeof QRCode.toString>[1]);
  const bar = "=".repeat(58);
  console.log(`
${bar}
  FRIDAY CONNECTOR — PAIRING
${bar}
  Scan this QR in the FRIDAY One app (Add Server → Scan QR):

${qr}
  …or type the code manually:

       ${grouped}

  Expires: ${expiresAt}
  One-time only. Never grants shell access.
${bar}
`);
}

/**
 * Poll the enrollment session. POST keeps the token out of URLs and access
 * logs; GET ?token= is only for control planes that predate it.
 */
export function poll(controlPlaneUrl: string, token: string, legacyGet: boolean): Promise<Response> {
  if (legacyGet) {
    return fetch(`${controlPlaneUrl}/api/v1/enrollments/session?token=${encodeURIComponent(token)}`);
  }
  return fetch(`${controlPlaneUrl}/api/v1/enrollments/session/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

export async function enroll(
  controlPlaneUrl: string,
  token: string,
  credentialFile: string,
): Promise<void> {
  // Step 1: open the session; the display code exists only in this response.
  const sessRes = await fetch(`${controlPlaneUrl}/api/v1/enrollments/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!sessRes.ok) {
    throw new Error(`enrollment session rejected (HTTP ${sessRes.status}) — check the install command's token`);
  }
  const sess = (await sessRes.json()) as {
    enrollment_id: string;
    display_code: string;
    display_code_expires_at: string;
  };
  await render(sess.enrollment_id, sess.display_code, sess.display_code_expires_at);

  // Step 2: poll for the claim; pick up the credential exactly once.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let legacyGet = false;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await poll(controlPlaneUrl, token, legacyGet);
    if (!legacyGet && (res.status === 404 || res.status === 405)) {
      // Control plane predates POST polling: fall back once (token in URL, F-M2).
      legacyGet = true;
      continue;
    }
    if (!res.ok) throw new Error(`enrollment poll failed (HTTP ${res.status})`);
    const body = (await res.json()) as { state: string; credential?: string };
    if (body.state === "paired" && typeof body.credential === "string") {
      installCredential(credentialFile, body.credential);
      console.log(`paired ✓ credential installed at ${credentialFile}`);
      console.log("start the service:  sudo systemctl enable --now friday-connector");
      return;
    }
    process.stdout.write(".");
  }
  throw new Error("pairing timed out — the code expired; run enroll again with a fresh install command");
}
