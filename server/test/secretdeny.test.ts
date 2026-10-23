import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";

// Import the REAL safePath from files.ts. It reads FS_ROOTS at module load and
// requires DATABASE_URL to satisfy db.ts's import guard (a Pool is lazy, so no
// connection is made). Set both before the dynamic import.
//
// The root is created under /tmp (a real dir) rather than os.tmpdir(): the
// sandbox's TMPDIR is ~/.hermes/cache/scratch, and ".hermes" is a denylisted
// segment — putting the fixtures there would trip the denylist for the wrong
// reason. realpathSync(ROOT) makes ROOTS and safePath's own realpath agree, so
// a symlinked tmp base can't cause a false containment failure.
const ROOT = await mkdtemp(join("/tmp", "friday-deny-"));
process.env.FS_ROOTS = realpathSync(ROOT);
process.env.STORAGE_DIR = join(realpathSync(ROOT), "storage");
process.env.DATABASE_URL = "postgres://nodb:nodb@127.0.0.1:5432/nodb";

const { safePath } = await import("../src/routes/files.js");

// Fixtures: credentials the denylist must block, plus normal files it must allow.
await mkdir(join(ROOT, ".ssh"), { recursive: true });
await writeFile(join(ROOT, ".ssh", "authorized_keys"), "ssh-ed25519 AAAA...");
await writeFile(join(ROOT, ".env"), "JWT_SECRET=should-not-serve");
await writeFile(join(ROOT, "credentials"), "token=should-not-serve");
await writeFile(join(ROOT, "notes.txt"), "hello");
await mkdir(join(ROOT, "sub"), { recursive: true });
await writeFile(join(ROOT, "sub", "ok.txt"), "ok");

after(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("secret denylist (F-02 partial)", () => {
  it("allows a normal file inside the root", async () => {
    assert.equal(await safePath(join(ROOT, "notes.txt")), join(ROOT, "notes.txt"));
  });

  it("allows a nested normal file", async () => {
    assert.equal(await safePath(join(ROOT, "sub", "ok.txt")), join(ROOT, "sub", "ok.txt"));
  });

  it("denies .env even though it is inside the root", async () => {
    await assert.rejects(
      () => safePath(join(ROOT, ".env")),
      (e: any) => e.message === "path_outside_roots" && e.statusCode === 403,
    );
  });

  it("denies .ssh/authorized_keys", async () => {
    await assert.rejects(
      () => safePath(join(ROOT, ".ssh", "authorized_keys")),
      (e: any) => e.message === "path_outside_roots",
    );
  });

  it("denies a file named credentials", async () => {
    await assert.rejects(
      () => safePath(join(ROOT, "credentials")),
      (e: any) => e.message === "path_outside_roots",
    );
  });
});
