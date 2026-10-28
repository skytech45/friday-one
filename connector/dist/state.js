/**
 * Observable connector state for `fridayone status` / `doctor`.
 *
 * The connector writes a small JSON file on every real lifecycle event
 * (connecting, authenticated by the gateway, disconnected with its close
 * code, revoked, unpaired). Status tools read THIS instead of guessing from
 * DNS or an open TCP port: "connected" means the gateway accepted our
 * credential (auth.resume.ok), nothing less.
 *
 * Contains no secrets (no credential, token or payload), so it may be
 * world-readable (systemd RuntimeDirectory, default /run/friday-connector).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export const DEFAULT_STATE_FILE = "/run/friday-connector/state.json";
/** Strip anything credential-shaped and bound the length before it is persisted. */
export function sanitizeError(message) {
    return message
        .replace(/(credential|token|authorization|password|secret)(["'=:\s]+)[^\s"',}]+/gi, "$1$2[redacted]")
        .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
        .slice(0, 300);
}
export class StateFile {
    path;
    now;
    current;
    constructor(path, version, gatewayUrl, now = () => new Date()) {
        this.path = path;
        this.now = now;
        let host = null;
        try {
            host = gatewayUrl ? new URL(gatewayUrl).host : null;
        }
        catch {
            host = null;
        }
        this.current = {
            version,
            pid: process.pid,
            state: "starting",
            since: this.now().toISOString(),
            serverId: null,
            connectorId: null,
            gatewayHost: host,
            lastConnectedAt: null,
            lastCloseCode: null,
            lastError: null,
            reconnects: 0,
            agents: [],
        };
    }
    get snapshot() {
        return { ...this.current, agents: [...this.current.agents] };
    }
    /** Merge an update; a state change resets `since`. Never throws. */
    update(patch) {
        const next = { ...this.current, ...patch };
        if (patch.state && patch.state !== this.current.state)
            next.since = this.now().toISOString();
        if (patch.lastError)
            next.lastError = sanitizeError(patch.lastError);
        this.current = next;
        this.flush();
    }
    /** Atomic replace (write temp + rename) so readers never see half a file. */
    flush() {
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            const tmp = `${this.path}.${process.pid}.tmp`;
            writeFileSync(tmp, `${JSON.stringify(this.current, null, 2)}\n`, { mode: 0o644 });
            renameSync(tmp, this.path);
        }
        catch {
            // Status is advisory: an unwritable runtime dir must never stop the connector.
        }
    }
}
