# FRIDAY One — workstream tasks

Each workstream owns a disjoint set of files. Read `docs/SHARED.md` first.
The "Owns" list is exclusive: never edit a file another stream owns.

---

## WS1 — File explorer: upload & download (owner: WS1)

**Owns:** `android/app/src/main/java/com/friday/one/feature/files/**`
**Must not touch:** `MainActivity.kt`, `TerminalScreen.kt`, `data/Api.kt`

Build the file-explorer package:

1. `FsRepository.kt` — wraps the existing `FridayApi` calls (`listDir`,
   `fs/download`, `fs/upload`). Expose `Result`-returning suspend functions.
2. `FilesViewModel.kt` — MVVM state holder: current path, entries, loading,
   error, sort (name/size/mtime), and a breadcrumb list. Survive rotation.
3. `FilesScreen.kt` — Compose: breadcrumb bar, list with folder/file icons,
   size + mtime per row, pull-to-refresh.
4. **Download**: a row action that streams
   `GET /fs/download?path=...` to `MediaStore`/app files and shows a progress
   indicator. Use `OkHttp` with a `ResponseBody` stream, not Retrofit's default
   buffering, so large files do not exhaust memory.
5. **Upload**: FAB → Android document picker (`ActivityResultContracts.OpenDocument`)
   → `POST /fs/upload` as multipart with the `dest` field set to the current
   directory. Show per-file progress and a success/failure snackbar.
6. A delete action is **not** in scope for this stream (backend has
   `DELETE /files/:id`; leave it).

The backend routes already exist and are verified:
`GET /fs/list`, `GET /fs/download?path=`, `POST /fs/upload` (multipart with a
`dest` field and a `file` field). All require
`Authorization: Bearer <accessToken>` and a **trusted** device.

---

## WS2 — Terminal / TUI quality (owner: WS2)

**Owns:** `android/app/src/main/java/com/friday/one/feature/terminal/**`
**Must not touch:** `MainActivity.kt`, `data/Api.kt`

The current renderer in `TerminalScreen.kt` is a crude ANSI stripper. Replace it
with a real one, without pulling anything from a CDN at runtime:

1. Vendor a terminal renderer into `app/src/main/assets/` (xterm.js + css is
   fine if you commit the files into the repo — **no runtime CDN fetch**).
   Fetch the files with `curl` at build time and commit them, or vendor a
   minimal but correct VT100/VT220 implementation yourself.
2. Handle: SGR colour + bold, cursor movement, erase line/screen, alternate
   screen buffer (Ink-based TUIs like Hermes and OpenCode use it).
3. Send window resize to the backend. The WS protocol reserves control frames
   prefixed with `\u0000`; `\u0000kill` already stops the process. Add
   `\u0000resize:<cols>x<rows>` and handle it in the backend only if WS4 has
   not claimed `server/src/routes/terminal.ts` — coordinate, do not both edit it.
4. Add a keyboard row (Esc, Tab, Ctrl-C, arrows) above the input, and make the
   terminal fill the screen with no wasted chrome.

Test target: run `hermes --tui` and `opencode` through it and confirm the UI
paints rather than showing raw escape codes.

---

## WS3 — Security hardening (owner: WS3)

**Owns:** `android/app/src/main/java/com/friday/one/security/**`,
`android/app/src/main/java/com/friday/one/data/NetworkModule.kt`
**Must not touch:** `MainActivity.kt`, `Api.kt`, `SessionStore.kt`

1. **Certificate pinning** on the OkHttp client for the tunnel host only, with a
   documented rotation path. Do not pin when the host is a loopback address, or
   local development breaks.
2. **Biometric gate**: an `AppLock` that requires `BiometricPrompt` before the
   UI renders when a session exists. Fail closed on error, and fall back to
   device credential. Lock again on every cold start (not on rotation).
3. **Root / tamper signals**: detect `su` binaries, test-keys build tags, and
   writable system partitions. Report as a *signal in the crash/telemetry
   context*, never as a hard block — legitimate users have rooted phones.
4. **Token refresh**: an OkHttp `Authenticator` that calls `POST /auth/refresh`
   with the stored refresh token **and** the current device fingerprint, retries
   once, and clears the session on failure. The backend ties the refresh to the
   fingerprint and deliberately kills the session on a mismatch — preserve that.

---

## WS4 — Backend additions (owner: WS4)

**Owns:** `server/src/**` except `server/src/routes/terminal.ts` unless WS2
agrees.

1. **Range requests** on `GET /fs/download` (`Range: bytes=...` → 206) so the app
   can resume an interrupted download. Reject multi-range with 416.
2. **Search**: `GET /fs/search?q=&root=` — bounded depth, bounded results
   (max 200), skips unreadable directories, stays inside `FS_ROOTS`.
3. **Chunked/resumable upload**: `POST /fs/upload` currently buffers the whole
   file in memory. Stream it to a temp file and rename on completion so a 2 GB
   upload cannot OOM the server.
4. **Tests**: `server/test/*.test.ts` using `node:test` — prove the path jail
   rejects `..`, a symlink out of the roots, and a nested traversal; prove
   unauthenticated and untrusted-device requests get 401/403.
5. Keep `npx tsc --noEmit` clean.

---

## WS5 — Deployment: replace Tailscale with Cloudflare Tunnel (owner: WS5)

**Owns:** `infra/**`, `docs/DEPLOY.md`, `scripts/**`

1. `scripts/run-server.sh` — loads `server/.env`, runs migrations, starts the
   API. `scripts/tunnel.sh` — starts cloudflared.
2. Two systemd units in `infra/systemd/`: `friday-one-api.service` (the backend,
   bound to 127.0.0.1) and `friday-one-tunnel.service` (cloudflared, depends on
   the API). Harden both the way `friday-console.service` is hardened
   (`ProtectSystem=strict`, `NoNewPrivileges`, explicit `ReadWritePaths`).
3. `docs/DEPLOY.md`: document **both** the account-less quick tunnel (what is
   running now, random URL, changes on restart) and the permanent named tunnel
   (custom domain, stable URL, `cloudflared tunnel create` + DNS route). State
   the trade-off plainly: the quick tunnel is fine for testing and unsuitable
   for production because the hostname changes.
4. Note in the doc that the app's `BASE_URL` is baked at build time via
   `-PFRIDAY_BASE_URL=`, so a tunnel URL change requires a rebuild — and
   propose the config-override path as future work.

Do **not** remove the existing Tailscale setup on this box; just make
Cloudflare the documented path for this app.
