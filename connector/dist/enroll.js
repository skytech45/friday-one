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
import { installCredential } from "./pairing.js";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 11 * 60_000; // display code lives 10 min
/** Minimal ASCII QR is out of scope for the runtime dep list; the terminal
 * shows a scannable-format claim line (the Android camera app / QR apps can
 * read the numeric payload) plus the human-typable code. */
function render(enrollmentId, code, expiresAt) {
    const grouped = code.replace(/(\d{4})(?=\d)/g, "$1 ");
    const bar = "=".repeat(58);
    console.log(`
${bar}
  FRIDAY CONNECTOR — PAIRING
${bar}
  1. Open the FRIDAY One app on your phone (signed in).
  2. Add Server -> Enter pairing code.
  3. Type this one-time code:

       ${grouped}

  Enrollment: ${enrollmentId}
  Expires:    ${expiresAt}

  This code works ONCE and never grants shell access.
${bar}
`);
}
export async function enroll(controlPlaneUrl, token, credentialFile) {
    // Step 1: open the session; the display code exists only in this response.
    const sessRes = await fetch(`${controlPlaneUrl}/api/v1/enrollments/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
    });
    if (!sessRes.ok) {
        throw new Error(`enrollment session rejected (HTTP ${sessRes.status}) — check the install command's token`);
    }
    const sess = (await sessRes.json());
    render(sess.enrollment_id, sess.display_code, sess.display_code_expires_at);
    // Step 2: poll for the claim; pick up the credential exactly once.
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const res = await fetch(`${controlPlaneUrl}/api/v1/enrollments/session?token=${encodeURIComponent(token)}`);
        if (!res.ok)
            throw new Error(`enrollment poll failed (HTTP ${res.status})`);
        const body = (await res.json());
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
