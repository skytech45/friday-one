/**
 * Local policy gate — the connector is the FINAL execution authority
 * (SYSTEM_DESIGN §16.4: "Connector is the local execution gate").
 *
 * Skeleton status: this file currently implements the fail-closed decision
 * function against a locally-synced policy file. Evaluation precedence lives
 * in docs/ADAPTER_CONTRACT.md §4 and MUST stay in sync with the control plane.
 *
 * Nothing executes without passing through decide() — including the legacy
 * PTY terminal path once it migrates behind the connector.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Decision = "allow" | "deny" | "require_approval";

export interface LocalPolicy {
  version: number;
  rules: Array<{
    id: string;
    server_scoped: boolean;
    agent_id: string | null;
    project_root: string | null;
    action: string;
    executable: string | null;
    decision: Decision;
    priority: number;
    expires_at: string | null;
  }>;
}

export interface OperationRequest {
  agentId: string | null;
  projectRoot: string | null;
  action: string;
  executable: string | null;
  now?: Date;
}

const SENSITIVE_ACTIONS = new Set([
  "shell.exec",
  "file.write",
  "file.delete",
  "process.spawn",
  "credential.access",
]);

export function loadPolicy(policyDir: string): LocalPolicy {
  return JSON.parse(readFileSync(join(policyDir, "policies.json"), "utf8")) as LocalPolicy;
}

/**
 * Fail-closed evaluation (ADAPTER_CONTRACT §4). If the policy file is
 * unreadable, unparseable, or the operation is sensitive with no matching
 * rule, the answer is require_approval at best, deny for high-risk actions.
 */
export function decide(policy: LocalPolicy | null, op: OperationRequest): Decision {
  if (!policy || typeof policy.version !== "number") {
    return SENSITIVE_ACTIONS.has(op.action) ? "deny" : "require_approval";
  }
  const now = op.now ?? new Date();

  const matches = policy.rules
    .filter((r) => r.action === op.action)
    .filter((r) => !r.expires_at || new Date(r.expires_at) > now)
    .filter((r) => (r.agent_id ? r.agent_id === op.agentId : true))
    .filter((r) => (r.project_root ? r.project_root === op.projectRoot : true))
    .filter((r) => (r.executable ? r.executable === op.executable : true));

  if (matches.length === 0) {
    return SENSITIVE_ACTIONS.has(op.action) ? "deny" : "require_approval";
  }

  // Explicit deny beats everything at equal or broader specificity; then
  // most-specific (has executable > has project > has agent > none), then
  // lowest priority.
  const specificity = (r: (typeof matches)[number]): number =>
    (r.executable ? 8 : 0) + (r.project_root ? 4 : 0) + (r.agent_id ? 2 : 0) + (r.server_scoped ? 1 : 0);
  const sorted = [...matches].sort(
    (a, b) => specificity(b) - specificity(a) || a.priority - b.priority,
  );
  return sorted[0]!.decision;
}
