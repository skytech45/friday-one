/**
 * Capability sanitisation tests (plan §7/§9). Pure functions: no network,
 * no database. Run with `npm test` after `npm run build`.
 */
import assert from "node:assert/strict";
import { sanitizeAgents, sanitizeProjects } from "./dist/agents.js";

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.log(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

check("keeps valid agents and caps version length", () => {
  const out = sanitizeAgents([
    { adapter: "hermes", version: "0.22.5", health: "healthy" },
    { adapter: "opencode", version: "x".repeat(80) },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { adapter: "hermes", version: "0.22.5", health: "healthy" });
  assert.equal(out[1].version.length, 40);
  assert.equal(out[1].health, "unknown");
});

check("rejects malformed adapter ids and duplicate adapters", () => {
  const out = sanitizeAgents([
    { adapter: "../evil" },
    { adapter: "Hermes" },
    { adapter: "" },
    { adapter: "hermes" },
    { adapter: "hermes" },
    null,
    "nope",
  ]);
  assert.deepEqual(out.map((a) => a.adapter), ["hermes"]);
});

check("bounds the agent list", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ adapter: `a${i}` }));
  assert.equal(sanitizeAgents(many).length, 20);
});

check("non-array payloads yield no agents", () => {
  assert.deepEqual(sanitizeAgents(undefined), []);
  assert.deepEqual(sanitizeAgents({ adapter: "hermes" }), []);
});

check("keeps absolute project roots, derives a label", () => {
  const out = sanitizeProjects([
    { root: "/srv/app" },
    { root: "/srv/other", label: "Other" },
  ]);
  assert.deepEqual(out, [
    { root: "/srv/app", label: "app" },
    { root: "/srv/other", label: "Other" },
  ]);
});

check("rejects relative, NUL and duplicate roots", () => {
  const out = sanitizeProjects([
    { root: "relative/path" },
    { root: "/srv/app\0evil" },
    { root: "/srv/app" },
    { root: "/srv/app" },
    {},
    null,
  ]);
  assert.deepEqual(out.map((p) => p.root), ["/srv/app"]);
});

check("bounds the project list and long labels", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ root: `/srv/p${i}`, label: "x".repeat(200) }));
  const out = sanitizeProjects(many);
  assert.equal(out.length, 50);
  assert.equal(out[0].label.length, 120);
});

console.log(`\n${pass} checks passed${process.exitCode ? " (with failures)" : ""}`);
