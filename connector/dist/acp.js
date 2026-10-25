/**
 * ACP client adapter — drives an Agent Client Protocol agent over stdio
 * (newline-delimited JSON-RPC 2.0). One implementation drives both verified
 * agents on this host: hermes-acp 0.22.5 and `opencode acp` 2.1.3 (see
 * docs/ADAPTER_CONTRACT.md for the evidence).
 *
 * Lifecycle: initialize → session/new → session/prompt (streaming
 * session/update notifications) → session/cancel. Conformance requirements
 * from the contract: clean cycles, streaming backpressure, crash isolation —
 * the exit handler rejects every pending request rather than hanging.
 */
import { spawn } from "node:child_process";
export class AcpAgent {
    cmd;
    log;
    child;
    nextId = 1;
    buffer = "";
    pending = new Map();
    /** Streaming updates + permission requests from the agent, by session. */
    handlers = new Map();
    unhandled = [];
    info = null;
    exited = false;
    constructor(cmd, log) {
        this.cmd = cmd;
        this.log = log;
        // The agent needs ITS OWN config home (~/.hermes for Hermes) — without it
        // the adapter hangs waiting for provider setup. This is the agent's home,
        // NOT a secrets channel: the child env is an explicit allowlist with no
        // server secrets (F-10 discipline). A dedicated agent account is the
        // long-term fix (todo F-16).
        const agentHome = process.env.FRIDAY_AGENT_HOME ?? "/home/ubuntu";
        // FRIDAY_ACP_CMD is a full command line (e.g. "/usr/local/bin/opencode acp").
        const [bin, ...args] = cmd.split(/\s+/);
        this.child = spawn(bin, args, {
            cwd: "/tmp",
            env: {
                PATH: "/usr/local/bin:/usr/bin:/bin:/home/ubuntu/.local/bin",
                HOME: agentHome,
                TERM: "xterm-256color",
                LANG: "C.UTF-8",
            },
        });
        this.child.stdout.on("data", (d) => this.onData(d.toString("utf8")));
        this.child.stderr.on("data", (d) => log(`[acp stderr] ${d.toString().trimEnd().slice(0, 200)}`));
        this.child.on("exit", (code, signal) => {
            this.exited = true;
            const err = new Error(`agent exited (code=${code} signal=${signal})`);
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(err);
            }
            this.pending.clear();
            this.handlers.clear();
        });
        this.child.on("error", (e) => {
            this.exited = true;
            const err = new Error(`agent spawn failed: ${e.message}`);
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(err);
            }
            this.pending.clear();
        });
    }
    static spawn(cmd, log) {
        return new AcpAgent(cmd, log);
    }
    onData(chunk) {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line)
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                this.log(`[acp] unparseable line dropped: ${line.slice(0, 120)}`);
                continue;
            }
            this.onMessage(msg);
        }
    }
    onMessage(msg) {
        const id = typeof msg.id === "number" ? msg.id : null;
        if (id !== null && (msg.result !== undefined || msg.error !== undefined)) {
            const p = this.pending.get(id);
            if (!p)
                return;
            this.pending.delete(id);
            clearTimeout(p.timer);
            if (msg.error !== undefined) {
                const e = msg.error;
                p.reject(new Error(`agent error ${e.code}: ${e.message}`));
            }
            else {
                p.resolve(msg.result);
            }
            return;
        }
        // Notification or agent→client request (e.g. session/update,
        // session/request_permission). Route by sessionId when present.
        const params = (msg.params ?? {});
        const handler = params.sessionId ? this.handlers.get(params.sessionId) : undefined;
        if (handler) {
            handler(msg);
        }
        else {
            this.unhandled.push(msg);
            if (this.unhandled.length > 100)
                this.unhandled.shift();
        }
    }
    request(method, params, timeoutMs = 60_000) {
        if (this.exited)
            return Promise.reject(new Error("agent not running"));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`agent request timeout: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
    }
    notify(method, params) {
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    }
    async initialize() {
        const result = (await this.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }));
        this.info = {
            protocolVersion: result.protocolVersion,
            name: result.agentInfo.name,
            version: result.agentInfo.version,
            capabilities: result.agentCapabilities,
        };
        return this.info;
    }
    async newSession(cwd) {
        const result = (await this.request("session/new", { cwd, mcpServers: [] }));
        return result.sessionId;
    }
    /**
     * Run one prompt turn. Streaming deltas arrive via onDelta (agent_message_chunk
     * updates); resolves when the agent replies with a stopReason.
     */
    async prompt(sessionId, text, onDelta) {
        this.handlers.set(sessionId, (msg) => {
            if (msg.method !== "session/update")
                return;
            const params = msg.params;
            const update = params.update;
            if (update?.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
                onDelta(update.content.text);
            }
            // Unknown update kinds are ignored deliberately — the contract says
            // capabilities are declared, not invented.
        });
        try {
            const result = (await this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, 120_000));
            return { stopReason: result.stopReason };
        }
        finally {
            this.handlers.delete(sessionId);
        }
    }
    cancel(sessionId) {
        this.notify("session/cancel", { sessionId });
    }
    shutdown() {
        if (!this.exited) {
            this.child.kill("SIGTERM");
            setTimeout(() => {
                if (!this.exited)
                    this.child.kill("SIGKILL");
            }, 2000);
        }
    }
}
