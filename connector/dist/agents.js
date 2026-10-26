/**
 * Agent discovery and selection (plan v2 §7/§9).
 *
 * The connector owns the truth about which ACP agents exist on THIS host:
 * it probes the configured commands, reports the usable ones to the gateway,
 * and only ever spawns an agent the app explicitly asked for (or the first
 * available default). Selection is a UI convenience — the policy gate still
 * runs immediately before execution and the connector validates the adapter
 * name against this registry, never against arbitrary client input.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
const ADAPTER_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const DEFAULT_HERMES = "/home/ubuntu/.local/bin/hermes-acp";
const DEFAULT_OPENCODE = "opencode acp";
/**
 * Configured agents. `FRIDAY_ACP_CMD` is the pre-discovery single-agent knob
 * and stays the Hermes default so existing installs keep working.
 */
export function agentSpecs(env = process.env) {
    const legacy = (env.FRIDAY_ACP_CMD ?? "").trim();
    const hermes = (env.FRIDAY_ACP_HERMES_CMD ?? "").trim() || legacy || DEFAULT_HERMES;
    const opencode = (env.FRIDAY_ACP_OPENCODE_CMD ?? "").trim() || DEFAULT_OPENCODE;
    const specs = [
        { adapter: "hermes", cmd: hermes, label: "Hermes" },
        { adapter: "opencode", cmd: opencode, label: "OpenCode" },
    ];
    // Never let an env typo smuggle a malformed adapter id into the DB.
    return specs.filter((s) => ADAPTER_RE.test(s.adapter));
}
export function binOf(cmd) {
    return cmd.trim().split(/\s+/)[0] ?? "";
}
function isExecutableFile(path) {
    try {
        if (!statSync(path).isFile())
            return false;
        accessSync(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * True when the command's binary resolves. Absolute paths are checked
 * directly; bare names are searched on the supplied PATH.
 */
export function commandAvailable(cmd, env = process.env, pathEnv) {
    const bin = binOf(cmd);
    if (!bin)
        return false;
    if (bin.includes("/"))
        return isExecutableFile(bin);
    const dirs = (pathEnv ?? env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/home/ubuntu/.local/bin")
        .split(delimiter)
        .filter(Boolean);
    return dirs.some((d) => isExecutableFile(join(d, bin)));
}
/** Agents that can actually be spawned on this host, in preference order. */
export function availableAgentSpecs(env = process.env, pathEnv) {
    return agentSpecs(env).filter((s) => commandAvailable(s.cmd, env, pathEnv));
}
/** Resolve the app's requested adapter; no request means the default agent. */
export function resolveAgent(available, requested) {
    if (!requested)
        return available[0] ?? null;
    return available.find((a) => a.adapter === requested) ?? null;
}
/** Adapter ids the app may send — never free-form strings. */
export function isKnownAdapter(adapter) {
    return ADAPTER_RE.test(adapter);
}
export function reportedAgents(available, versions = new Map()) {
    return available.map((s) => ({
        adapter: s.adapter,
        version: versions.get(s.adapter) ?? null,
        health: "healthy",
    }));
}
/**
 * Cheap version probe (`<bin> --version`). Best effort: a missing or
 * misbehaving version flag yields null, never a failed connection.
 */
export function probeVersion(cmd, timeoutMs = 3000) {
    const [bin, ...args] = cmd.trim().split(/\s+/);
    if (!bin)
        return null;
    try {
        const r = spawnSync(bin, [...args, "--version"], {
            timeout: timeoutMs,
            encoding: "utf8",
            env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
        });
        if (r.status !== 0)
            return null;
        const out = `${r.stdout ?? ""}`.trim().split("\n")[0] ?? "";
        const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(out);
        return m ? m[1].slice(0, 40) : out.slice(0, 40) || null;
    }
    catch {
        return null;
    }
}
