import assert from "node:assert/strict";
import test from "node:test";
import {
  agentSpecs,
  availableAgentSpecs,
  binOf,
  commandAvailable,
  isKnownAdapter,
  reportedAgents,
  resolveAgent,
} from "./agents.js";

test("binOf takes the executable from a command line", () => {
  assert.equal(binOf("opencode acp"), "opencode");
  assert.equal(binOf("/usr/local/bin/opencode acp"), "/usr/local/bin/opencode");
  assert.equal(binOf("   "), "");
});

test("commandAvailable resolves absolute and PATH binaries", () => {
  assert.equal(commandAvailable("/bin/sh"), true);
  assert.equal(commandAvailable("/nonexistent/friday-agent"), false);
  assert.equal(commandAvailable("sh", {}, "/bin"), true);
  assert.equal(commandAvailable("friday-missing", {}, "/bin"), false);
  assert.equal(commandAvailable(""), false);
});

test("agent specs honour overrides and keep stable adapter ids", () => {
  const specs = agentSpecs({
    FRIDAY_ACP_HERMES_CMD: "/bin/sh",
    FRIDAY_ACP_OPENCODE_CMD: "/bin/echo opencode acp",
  });
  assert.deepEqual(specs.map((s) => s.adapter), ["hermes", "opencode"]);
  assert.equal(specs[0]!.cmd, "/bin/sh");
  assert.equal(specs[1]!.cmd, "/bin/echo opencode acp");
});

test("legacy FRIDAY_ACP_CMD remains the hermes command", () => {
  const specs = agentSpecs({ FRIDAY_ACP_CMD: "/opt/hermes-acp" });
  assert.equal(specs[0]!.adapter, "hermes");
  assert.equal(specs[0]!.cmd, "/opt/hermes-acp");
  assert.equal(specs[1]!.adapter, "opencode"); // new default still present
});

test("availableAgentSpecs filters commands whose binary is missing", () => {
  const available = availableAgentSpecs(
    {
      FRIDAY_ACP_HERMES_CMD: "/nonexistent/hermes-acp",
      FRIDAY_ACP_OPENCODE_CMD: "/bin/sh",
    },
    "/bin",
  );
  assert.deepEqual(available.map((s) => s.adapter), ["opencode"]);
});

test("resolveAgent defaults to the first agent and rejects unknown ids", () => {
  const available = agentSpecs({
    FRIDAY_ACP_HERMES_CMD: "/bin/sh",
    FRIDAY_ACP_OPENCODE_CMD: "/bin/sh",
  });
  assert.equal(resolveAgent(available, null)?.adapter, "hermes");
  assert.equal(resolveAgent(available, undefined)?.adapter, "hermes");
  assert.equal(resolveAgent(available, "opencode")?.adapter, "opencode");
  assert.equal(resolveAgent(available, "not-an-agent"), null);
  assert.equal(resolveAgent([], "hermes"), null);
});

test("only registry-shaped adapter ids are accepted", () => {
  assert.equal(isKnownAdapter("hermes"), true);
  assert.equal(isKnownAdapter("opencode-2"), true);
  assert.equal(isKnownAdapter("Hermes"), false);
  assert.equal(isKnownAdapter("../etc/passwd"), false);
  assert.equal(isKnownAdapter(""), false);
});

test("reportedAgents includes versions only when known", () => {
  const available = agentSpecs({});
  const versions = new Map<string, string | null>([["hermes", "0.22.5"]]);
  const reported = reportedAgents(available, versions);
  assert.deepEqual(reported[0], { adapter: "hermes", version: "0.22.5", health: "healthy" });
  assert.deepEqual(reported[1], { adapter: "opencode", version: null, health: "healthy" });
});
