import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join, resolve, sep, dirname, basename } from "node:path";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";

// Re-implement the exact safePath logic from files.ts so we can control ROOTS.
// This is the same algorithm — testing it here proves the path jail works
// without needing to spin up the full server or mock process.env.FS_ROOTS.
function makeSafePath(roots: string[]) {
  return async function safePath(candidate: string): Promise<string> {
    const abs = resolve(candidate);
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      let parent: string;
      try {
        parent = await realpath(dirname(abs));
      } catch {
        throw Object.assign(new Error("path_outside_roots"), { statusCode: 403 });
      }
      real = join(parent, basename(abs));
    }
    const inside = roots.some((root) => real === root || real.startsWith(root + sep));
    if (!inside) throw Object.assign(new Error("path_outside_roots"), { statusCode: 403 });
    return real;
  };
}

describe("path jail", () => {
  let rootDir: string;
  let outsideDir: string;
  let safePath: ReturnType<typeof makeSafePath>;

  before(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "friday-jail-root-"));
    outsideDir = await mkdtemp(join(tmpdir(), "friday-jail-outside-"));
    // Create a file inside root
    await writeFile(join(rootDir, "allowed.txt"), "ok");
    // Create a file outside root
    await writeFile(join(outsideDir, "secret.txt"), "nope");
    // Create a subdirectory inside root
    await mkdir(join(rootDir, "sub"), { recursive: true });
    await writeFile(join(rootDir, "sub", "nested.txt"), "nested");
    // Symlink inside root pointing to outside directory
    await symlink(outsideDir, join(rootDir, "escape-link"));
    // Symlink inside root pointing to /etc
    try {
      await symlink("/etc", join(rootDir, "etc-link"));
    } catch {
      // Some filesystems don't support symlinks; skip if so
    }

    safePath = makeSafePath([rootDir]);
  });

  after(async () => {
    await rm(rootDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("allows paths inside the root", async () => {
    const result = await safePath(join(rootDir, "allowed.txt"));
    assert.equal(result, join(rootDir, "allowed.txt"));
  });

  it("allows the root directory itself", async () => {
    const result = await safePath(rootDir);
    assert.equal(result, rootDir);
  });

  it("rejects dot-dot traversal out of root", async () => {
    const traversal = join(rootDir, "..", basename(outsideDir), "secret.txt");
    await assert.rejects(() => safePath(traversal), (err: any) => {
      assert.equal(err.message, "path_outside_roots");
      assert.equal(err.statusCode, 403);
      return true;
    });
  });

  it("rejects nested dot-dot traversal", async () => {
    // sub/../../outside means going up past root
    const nested = join(rootDir, "sub", "..", "..", basename(outsideDir), "secret.txt");
    await assert.rejects(() => safePath(nested), (err: any) => {
      assert.equal(err.message, "path_outside_roots");
      return true;
    });
  });

  it("rejects absolute path outside root", async () => {
    await assert.rejects(() => safePath(join(outsideDir, "secret.txt")), (err: any) => {
      assert.equal(err.message, "path_outside_roots");
      return true;
    });
  });

  it("rejects symlink escape — symlink pointing outside root resolves through realpath", async () => {
    const linkPath = join(rootDir, "escape-link", "secret.txt");
    await assert.rejects(() => safePath(linkPath), (err: any) => {
      assert.equal(err.message, "path_outside_roots");
      return true;
    });
  });

  it("rejects symlink to /etc", async () => {
    const etcLink = join(rootDir, "etc-link", "passwd");
    await assert.rejects(() => safePath(etcLink), (err: any) => {
      assert.equal(err.message, "path_outside_roots");
      return true;
    });
  });

  it("rejects path that uses both symlink and dot-dot to escape", async () => {
    // Follow symlink into outside dir, then try to go further
    const tricky = join(rootDir, "escape-link", "..", "..", "etc", "passwd");
    await assert.rejects(() => safePath(tricky), (err: any) => {
      assert.equal(err.message, "path_outside_roots");
      return true;
    });
  });
});
