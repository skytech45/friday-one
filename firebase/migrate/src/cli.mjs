#!/usr/bin/env node
/**
 * friday-migrate — Supabase → Firebase data migration (DATA_MIGRATION.md).
 *
 *   export    --out <dir>                         (env SUPABASE_URL, SUPABASE_SECRET_KEY)
 *   plan      --snapshot <dir> --out <plan.json>
 *   import    --plan <plan.json> --project <id> [--dry-run] [--overwrite] [--confirm-project <id>]
 *   reconcile --plan <plan.json> --project <id>  (exit 1 unless everything matches)
 *
 * Writing to any project that is not `demo-*` requires `--confirm-project`
 * with the same ID, so a typo or a wrong default never touches a real project.
 * Credentials: Application Default Credentials (gcloud auth application-default
 * login, or a CI identity); no key file is read by this tool.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { exportSnapshot, loadSnapshot } from "./export.mjs";
import { transform } from "./transform.mjs";
import { importPlan } from "./importer.mjs";
import { reconcile } from "./reconcile.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    snapshot: { type: "string" },
    plan: { type: "string" },
    project: { type: "string" },
    "confirm-project": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    overwrite: { type: "boolean", default: false },
  },
});

function need(name) {
  const v = values[name] ?? process.env[name.toUpperCase().replaceAll("-", "_")];
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

function firebase() {
  const projectId = need("project");
  const app = initializeApp({ projectId });
  return { projectId, db: getFirestore(app), auth: getAuth(app) };
}

function summarize(report) {
  const lines = Object.entries(report.tables).map(([t, c]) =>
    `  ${t.padEnd(22)} source ${String(c.source).padStart(5)}  planned ${String(c.planned).padStart(5)}  skipped ${String(c.skipped).padStart(4)}  failed ${String(c.failed).padStart(4)}`);
  return [
    "tables:", ...lines,
    `failed records: ${report.failed.length}`,
    `flagged for review: ${report.flagged.length}`,
  ].join("\n");
}

async function main() {
  const command = positionals[0];
  if (command === "export") {
    const manifest = await exportSnapshot({
      supabaseUrl: need("supabase-url"),
      secretKey: need("supabase-secret-key"),
      outDir: need("out"),
    });
    console.log(`exported from ${manifest.sourceHost} at ${manifest.exportedAt}`);
    for (const [name, meta] of Object.entries(manifest.files)) console.log(`  ${name}: ${meta.rows}`);
    return;
  }
  if (command === "plan") {
    const plan = transform(loadSnapshot(need("snapshot")));
    writeFileSync(need("out"), JSON.stringify(plan, null, 2), { mode: 0o600 });
    console.log(summarize(plan.report));
    if (plan.report.failed.length > 0) process.exitCode = 2; // review before importing
    return;
  }
  if (command === "import") {
    const plan = JSON.parse(readFileSync(need("plan"), "utf8"));
    const { projectId, db, auth } = firebase();
    if (!projectId.startsWith("demo-") && !values["dry-run"] && values["confirm-project"] !== projectId) {
      throw new Error(`refusing to write to ${projectId}: pass --confirm-project ${projectId} (and have authorization)`);
    }
    const result = await importPlan(plan, { db, auth, overwrite: values.overwrite, dryRun: values["dry-run"] });
    console.log(JSON.stringify(result, null, 2));
    if (result.users.failed.length || result.docs.failed.length) process.exitCode = 1;
    return;
  }
  if (command === "reconcile") {
    const plan = JSON.parse(readFileSync(need("plan"), "utf8"));
    const { db, auth } = firebase();
    const result = await reconcile(plan, { db, auth });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error("usage: friday-migrate <export|plan|import|reconcile> [options] (see src/cli.mjs)");
}

main().catch((e) => {
  console.error(`friday-migrate: ${e.message}`);
  process.exitCode = 1;
});
