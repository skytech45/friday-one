/**
 * Credential installation helpers. The v2 pairing flow lives in enroll.ts;
 * this module only handles safe on-disk handling of the issued credential.
 */
import { mkdirSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";
/** Write the credential with 0600 into place; verify what we wrote. */
export function installCredential(path, credential) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${credential}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600)
        throw new Error(`credential file permission is ${mode.toString(8)}, expected 600`);
}
