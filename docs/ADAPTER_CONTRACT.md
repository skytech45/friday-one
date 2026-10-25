# FRIDAY One — Agent Adapter Contract v1

Status: **draft**. This defines the versioned contract adapters implement and
the capability registry the control plane stores. It also records what was
actually VERIFIED on the target host — the "do not invent methods" evidence
PROMPT.md Phase 5 demands.

## 1. Verified on the target host (2026-10-25, `sky`)

| Agent | Binary | Version | Programmatic interface |
|---|---|---|---|
| Hermes | `~/.local/bin/hermes-acp` | `0.22.5+197.gcb757fa.dirty` | **ACP stdio server** ("Run Hermes Agent as an ACP stdio server"), plus `--check` (dependency/adapter self-verification) and browser_exec setup |
| OpenCode | `/usr/local/bin/opencode` | `2.1.3` | **ACP** (`opencode acp` — "Start an Agent Client Protocol server") **and** a background-service HTTP API (`opencode api <operation>`, OpenAPI operation IDs, `--server` URL, `--session` continuation, `--auto` permission auto-approval) |

**Key architectural finding:** BOTH agents speak **ACP** (Agent Client
Protocol — JSON-RPC over stdio). A single ACP client adapter can drive both,
with per-agent capability flags for what their ACP builds actually support.
This replaces TUI PTY scraping as the primary integration (the legacy
`/ws/terminal` PTY path stays as a fallback, gated on trust as today).

Open items before the Hermes/OpenCode adapters are called real:
- enumerate the ACP methods each build implements (`initialize`, session
  lifecycle, prompt turn, streaming updates) against the ACP schema;
- verify whether either exposes native permission interception over ACP —
  if not, permission support is reported UNSUPPORTED for that agent and the
  policy engine's `require_approval` path wraps at the connector boundary
  instead (never faked — SYSTEM_DESIGN §12);
- OpenCode's `--auto` flag is the OPPOSITE of what we need (auto-approves);
  the adapter must NOT use it.

## 2. Adapter contract (TypeScript, versioned)

```ts
/** Capability keys are the registry's vocabulary. An adapter declares what it
 * can do; undeclared = unsupported; the UI disables it. */
export interface AgentCapabilities {
  "sessions.list": boolean;
  "sessions.read": boolean;
  "sessions.create": boolean;
  "sessions.cancel": boolean;
  "chat.send": boolean;
  "chat.stream": boolean;      // streaming deltas, not just final text
  "permissions.native": boolean; // agent intercepts its own permission prompts
  "terminal.stream": boolean;   // raw PTY bridge (legacy fallback)
  "projects.list": boolean;
}

export interface AgentInfo {
  adapter: string;            // "hermes" | "opencode" | custom id
  adapterVersion: string;
  protocolVersions: string[]; // e.g. ["acp-1"]
  capabilities: AgentCapabilities;
}

export interface AgentAdapter {
  readonly info: AgentInfo;

  /** Launch the agent's ACP server (stdio) and perform initialize handshake. */
  start(): Promise<void>;
  shutdown(): Promise<void>;

  listSessions(): Promise<SessionInfo[]>;
  getSession(sessionId: string): Promise<SessionInfo>;
  createSession(projectRoot: string): Promise<SessionInfo>;
  cancelSession(sessionId: string): Promise<void>;

  sendMessage(sessionId: string, content: string): Promise<void>;
  /** Streams deltas; adapter emits protocol `chat.delta` events. */
  streamSession(sessionId: string, onDelta: (d: { seq: number; delta: string }) => void): Promise<void>;

  /** UNSUPPORTED must throw CapabilityError, never silently degrade. */
  getPendingPermissions(): Promise<PermissionRequest[]>;
  respondToPermission(requestId: string, decision: "allow" | "deny"): Promise<void>;
}

export class CapabilityError extends Error {
  constructor(public readonly capability: keyof AgentCapabilities) {
    super(`agent does not support capability: ${capability}`);
  }
}
```

Rules (restating §12 of SYSTEM_DESIGN as enforceable clauses):
1. Adapters map to VERIFIED interfaces only. No invented methods.
2. Unsupported operations throw `CapabilityError`; the control plane stores
   the capability flags the adapter declared and the UI reads THEM.
3. Native permission control is claimed only with evidence. Otherwise the
   connector reports `"permissions.native": false`.
4. Adapter versions must pass conformance tests (below) before registration.
5. Custom third-party adapters never run with connector privileges by default.

## 3. Conformance test matrix (per adapter, before registration)

1. `start`/`shutdown` clean under repeated cycles (no orphan processes).
2. Every declared capability exercised for real once; every undeclared
   capability asserted to throw `CapabilityError`.
3. Session lifecycle: create → send → stream ≥1 delta → cancel, idempotent.
4. Streaming under load: 1 MiB of deltas with a stalled consumer does not
   buffer unbounded (backpressure applies at the adapter boundary).
5. Crash isolation: killing the agent binary mid-session surfaces an error
   event, not a hang; the connector restarts the adapter cleanly.

## 4. Policy evaluation order (control plane + connector share this)

1. Reject malformed / expired / unsupported requests (fail closed).
2. Verify identities, enrollment state, project scope.
3. Apply explicit `deny` for the most specific matching scope.
4. Among `allow`/`require_approval` matches: most specific scope wins, then
   lowest `priority`, then newest `version`.
5. No match on a sensitive operation → `require_approval` (never allow).
6. The decision binds to `payload_hash` + `policy_version`; the connector
   re-checks policy immediately before execution.
