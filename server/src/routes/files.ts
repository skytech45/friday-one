import type { FastifyInstance } from "fastify";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, realpath, stat, unlink, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { opendir } from "node:fs/promises";
import { config } from "../config.js";
import { query } from "../db.js";

const ROOTS = config.fsRoots
  .split(",")
  .map((s) => resolve(s.trim()))
  .filter(Boolean);

const STORAGE = resolve(config.storageDir);

// Sensitive paths that must never be served even when they sit inside a root.
// safePath() proves containment; this proves the file is not a credential.
const DENY_SEGMENTS = new Set([
  ".ssh", ".aws", ".gnupg", ".hermes", ".kube", ".docker",
  ".config", ".local/share/keyrings",
]);
const DENY_BASENAMES =
  /^(id_rsa|id_ed25519|\.env(\..*)?|.*\.pem|.*\.key|credentials)$/;

function isDenied(relPath: string): boolean {
  const segs = relPath.split(sep);
  if (segs.some((s) => DENY_SEGMENTS.has(s))) return true;
  return DENY_BASENAMES.test(basename(relPath));
}

/**
 * Resolve `candidate` and prove it stays inside one of the allowed roots.
 *
 * realpath() is what makes this safe: it collapses `..`, symlinks and
 * `/proc/self/cwd` style tricks before the containment check, so a symlink
 * pointing at /etc cannot be used to escape.
 */
export async function safePath(candidate: string): Promise<string> {
  const abs = resolve(candidate);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    // Non-existent leaf (e.g. upload target): validate the parent instead.
    // If the parent also doesn't exist, the path can't be inside any root.
    let parent: string;
    try {
      parent = await realpath(dirname(abs));
    } catch {
      throw Object.assign(new Error("path_outside_roots"), { statusCode: 403 });
    }
    real = join(parent, basename(abs));
  }
  const inside = ROOTS.some((root) => real === root || real.startsWith(root + sep));
  if (!inside) throw Object.assign(new Error("path_outside_roots"), { statusCode: 403 });
  // Contained, but not a credential that should ever leave the box.
  if (isDenied(real)) throw Object.assign(new Error("path_outside_roots"), { statusCode: 403 });
  return real;
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  // Browse the Ubuntu box. Read-only: writing through this route is deliberately
  // not offered, every mutation goes through /files/upload so it is recorded.
  app.get<{ Querystring: { path?: string } }>(
    "/fs/list",
    { preHandler: app.authenticateTrusted },
    async (req, reply) => {
      const target = req.query.path ?? ROOTS[0]!;
      let real: string;
      try {
        real = await safePath(target);
      } catch (e) {
        return reply.code(403).send({ error: "path_outside_roots" });
      }
      const st = await stat(real).catch(() => null);
      if (!st) return reply.code(404).send({ error: "not_found" });
      if (!st.isDirectory()) return reply.code(400).send({ error: "not_a_directory" });

      const { readdir } = await import("node:fs/promises");
      const names = await readdir(real);
      const entries = await Promise.all(
        names.slice(0, 500).map(async (name) => {
          const full = join(real, name);
          const s = await stat(full).catch(() => null);
          if (!s) return null;
          return {
            name,
            path: full,
            dir: s.isDirectory(),
            size: s.size,
            mtime: s.mtimeMs,
            mode: s.mode & 0o777,
          };
        }),
      );
      return reply.send({
        path: real,
        parent: real === ROOTS[0] ? null : dirname(real),
        roots: ROOTS,
        entries: entries.filter(Boolean),
      });
    },
  );

  // Download any file inside the roots, streamed. Supports HTTP Range (RFC 7233).
  app.get<{ Querystring: { path?: string } }>(
    "/fs/download",
    { preHandler: app.authenticateTrusted },
    async (req, reply) => {
      if (!req.query.path) return reply.code(400).send({ error: "path_required" });
      let real: string;
      try {
        real = await safePath(req.query.path);
      } catch {
        return reply.code(403).send({ error: "path_outside_roots" });
      }
      const s = await stat(real).catch(() => null);
      if (!s || !s.isFile()) return reply.code(404).send({ error: "not_found" });
      if (s.size > config.maxDownloadBytes) {
        return reply.code(413).send({ error: "too_large" });
      }

      reply.header("accept-ranges", "bytes");
      reply.header("content-disposition", `attachment; filename="${basename(real)}"`);
      reply.type("application/octet-stream");

      const rangeHeader = req.headers.range;
      if (!rangeHeader) {
        reply.header("content-length", s.size);
        return reply.code(200).send(createReadStream(real));
      }

      // Only single byte-range is supported; multi-range gets 416.
      const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
      if (!match) {
        reply.header("content-range", `bytes */${s.size}`);
        return reply.code(416).send({ error: "unsupported_range" });
      }

      const startStr = match[1];
      const endStr = match[2];
      let start = startStr ? Number(startStr) : 0;
      let end = endStr ? Number(endStr) : s.size - 1;

      // Suffix range: bytes=-N means last N bytes
      if (!startStr && endStr) {
        start = Math.max(0, s.size - end);
        end = s.size - 1;
      }

      if (start >= s.size || end >= s.size || start > end) {
        reply.header("content-range", `bytes */${s.size}`);
        return reply.code(416).send({ error: "range_not_satisfiable" });
      }

      const length = end - start + 1;
      reply.header("content-range", `bytes ${start}-${end}/${s.size}`);
      reply.header("content-length", length);
      return reply.code(206).send(createReadStream(real, { start, end }));
    },
  );

  // Upload into a directory inside the roots, recorded in the files table.
  // Streams to a temp file first so large uploads never buffer fully in memory.
  app.post(
    "/fs/upload",
    { preHandler: app.authenticateTrusted },
    async (req, reply) => {
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: "file_required" });

      const destDir = String((data.fields.dest as { value?: string } | undefined)?.value ?? ROOTS[0]!);
      let dir: string;
      try {
        dir = await safePath(destDir);
      } catch {
        return reply.code(403).send({ error: "path_outside_roots" });
      }
      const ds = await stat(dir).catch(() => null);
      if (!ds?.isDirectory()) return reply.code(400).send({ error: "dest_not_a_directory" });

      const filename = basename(data.filename || "upload.bin").replace(/[\x00-\x1f]/g, "");
      const target = join(dir, filename);

      // Stream to a temp file in the same directory so rename is atomic (same fs).
      const tmpName = `.upload-${randomBytes(8).toString("hex")}.tmp`;
      const tmpPath = join(dir, tmpName);
      const maxBytes = config.maxUploadBytes;

      const hash = createHash("sha256");
      let size = 0;
      const out = createWriteStream(tmpPath);

      try {
        for await (const chunk of data.file) {
          size += chunk.length;
          if (size > maxBytes) {
            out.destroy();
            await unlink(tmpPath).catch(() => {});
            return reply.code(413).send({ error: "too_large" });
          }
          hash.update(chunk);
          out.write(chunk);
        }
        await new Promise<void>((res, rej) => {
          out.end((err?: Error | null) => (err ? rej(err) : res()));
        });
      } catch (err) {
        out.destroy();
        await unlink(tmpPath).catch(() => {});
        throw err;
      }

      await rename(tmpPath, target);

      const storageKey = relative(STORAGE, target).replace(/\\/g, "/");
      const row = await query<{ id: string }>(
        `INSERT INTO files (user_id, path, name, size, mime, sha256, storage_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, path) DO UPDATE
           SET size = EXCLUDED.size, mime = EXCLUDED.mime,
               sha256 = EXCLUDED.sha256, storage_key = EXCLUDED.storage_key
         RETURNING id`,
        [req.user.sub, target, filename, size, data.mimetype, hash.digest("hex"), storageKey],
      );

      return reply.code(201).send({
        id: row.rows[0]?.id,
        path: target,
        name: filename,
        size,
      });
    },
  );

  app.get("/files", { preHandler: app.authenticateTrusted }, async (req, reply) => {
    const rows = await query(
      `SELECT id, path, name, size, mime, sha256, created_at
         FROM files WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.user.sub],
    );
    return reply.send({ files: rows.rows });
  });

  app.delete<{ Params: { id: string } }>(
    "/files/:id",
    { preHandler: app.authenticateTrusted },
    async (req, reply) => {
      const r = await query<{ path: string }>(
        "DELETE FROM files WHERE id = $1 AND user_id = $2 RETURNING path",
        [req.params.id, req.user.sub],
      );
      const row = r.rows[0];
      if (!row) return reply.code(404).send({ error: "not_found" });
      try {
        const real = await safePath(row.path);
        await unlink(real);
      } catch {
        /* metadata is gone; a missing file is not an error worth failing on */
      }
      return reply.send({ ok: true });
    },
  );

  // Bounded filesystem search. Max 200 results, max depth 8, stays inside FS_ROOTS.
  // Skips unreadable directories silently so one EACCES doesn't kill the whole search.
  app.get<{ Querystring: { q?: string; root?: string } }>(
    "/fs/search",
    { preHandler: app.authenticateTrusted },
    async (req, reply) => {
      const q = req.query.q?.trim();
      if (!q) return reply.code(400).send({ error: "q_required" });

      const rawRoot = req.query.root ?? ROOTS[0]!;
      let searchRoot: string;
      try {
        searchRoot = await safePath(rawRoot);
      } catch {
        return reply.code(403).send({ error: "path_outside_roots" });
      }

      const st = await stat(searchRoot).catch(() => null);
      if (!st?.isDirectory()) return reply.code(400).send({ error: "root_not_a_directory" });

      const MAX_RESULTS = 200;
      const MAX_DEPTH = 8;
      const lowerQ = q.toLowerCase();
      const results: Array<{ name: string; path: string; dir: boolean; size: number; mtime: number }> = [];

      // Iterative BFS with depth tracking to avoid unbounded recursion.
      const queue: Array<{ dir: string; depth: number }> = [{ dir: searchRoot, depth: 0 }];

      while (queue.length > 0 && results.length < MAX_RESULTS) {
        const item = queue.shift()!;
        if (item.depth > MAX_DEPTH) continue;

        let entries;
        try {
          entries = await opendir(item.dir);
        } catch {
          // Skip unreadable directories (EACCES, etc.)
          continue;
        }

        try {
          for await (const entry of entries) {
            if (results.length >= MAX_RESULTS) break;
            const fullPath = join(item.dir, entry.name);

            // Every result must still be inside roots after realpath resolution.
            let resolved: string;
            try {
              resolved = await safePath(fullPath);
            } catch {
              continue;
            }

            if (entry.name.toLowerCase().includes(lowerQ)) {
              const s = await stat(resolved).catch(() => null);
              if (s) {
                results.push({
                  name: entry.name,
                  path: resolved,
                  dir: entry.isDirectory(),
                  size: s.size,
                  mtime: s.mtimeMs,
                });
              }
            }

            if (entry.isDirectory() && item.depth < MAX_DEPTH) {
              queue.push({ dir: resolved, depth: item.depth + 1 });
            }
          }
        } finally {
          await entries.close().catch(() => {});
        }
      }

      return reply.send({ q, root: searchRoot, count: results.length, results });
    },
  );
}
