import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ROTATION_CHECK_MS,
  MAX_ROTATION_CHECK_MS,
  MIN_ROTATION_CHECK_MS,
  rotationCheckIntervalMs,
  startRotationChecks,
} from "./rotation.js";

test("rotation checks default to every 15 minutes", () => {
  assert.equal(DEFAULT_ROTATION_CHECK_MS, 15 * 60_000);
  assert.equal(rotationCheckIntervalMs({}), 15 * 60_000);
});

test("FRIDAY_ROTATION_CHECK_MS overrides within 1..60 min", () => {
  assert.equal(rotationCheckIntervalMs({ FRIDAY_ROTATION_CHECK_MS: "300000" }), 300_000);
  assert.equal(rotationCheckIntervalMs({ FRIDAY_ROTATION_CHECK_MS: String(MIN_ROTATION_CHECK_MS) }), 60_000);
  assert.equal(rotationCheckIntervalMs({ FRIDAY_ROTATION_CHECK_MS: String(MAX_ROTATION_CHECK_MS) }), 3_600_000);
});

test("invalid or out-of-range overrides fall back to the default, with a warning", () => {
  const warnings: string[] = [];
  const warn = (m: string): void => { warnings.push(m); };
  for (const bad of ["60", "59999", "3600001", "abc", "1.5e5", "-1"]) {
    assert.equal(rotationCheckIntervalMs({ FRIDAY_ROTATION_CHECK_MS: bad }, warn), DEFAULT_ROTATION_CHECK_MS, bad);
  }
  assert.equal(warnings.length, 6);
  assert.equal(rotationCheckIntervalMs({ FRIDAY_ROTATION_CHECK_MS: "  " }, warn), DEFAULT_ROTATION_CHECK_MS);
});

test("scheduler checks once at boot, then on the given interval only", async () => {
  let calls = 0;
  const scheduled: number[] = [];
  let tick: (() => void) | null = null;
  const fakeEvery = (fn: () => void, ms: number): ReturnType<typeof setInterval> => {
    scheduled.push(ms);
    tick = fn;
    return 0 as unknown as ReturnType<typeof setInterval>;
  };
  startRotationChecks(async () => { calls++; }, DEFAULT_ROTATION_CHECK_MS, fakeEvery);
  assert.equal(calls, 1, "boot check runs immediately");
  assert.deepEqual(scheduled, [15 * 60_000], "exactly one timer, at 15 min");
  tick!();
  tick!();
  assert.equal(calls, 3);
});

test("a failing check does not break the schedule", async () => {
  let tick: (() => void) | null = null;
  const fakeEvery = (fn: () => void): ReturnType<typeof setInterval> => {
    tick = fn;
    return 0 as unknown as ReturnType<typeof setInterval>;
  };
  let calls = 0;
  const logged: string[] = [];
  startRotationChecks(async () => { calls++; throw new Error("network down"); }, 60_000, fakeEvery, (m) => logged.push(m));
  await new Promise((r) => setImmediate(r)); // let the rejected boot check settle
  tick!();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
  assert.deepEqual(logged, ["rotation check failed: network down", "rotation check failed: network down"]);
});
