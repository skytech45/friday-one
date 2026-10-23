# FRIDAY One — shared context for every agent

Read this fully before touching anything. It is the contract.

## What we are building

One Android app (Kotlin + Jetpack Compose, MVVM + Repository) that controls an
Ubuntu box: machine telemetry, a **file explorer with upload/download**, the
**Hermes TUI** and the **OpenCode TUI** embedded, auth, device binding, and
crash reporting. A Node.js + TypeScript (Fastify) + PostgreSQL backend serves it
over a Cloudflare Tunnel.

## Where things are

| Thing | Path |
|---|---|
| Android app | `/home/ubuntu/friday-one/android` |
| Backend | `/home/ubuntu/friday-one/server` |
| Infra | `/home/ubuntu/friday-one/infra` |
| Backend URL (dev) | `http://127.0.0.1:8788` |
| Backend URL (public) | `https://society-tucson-achieve-course.trycloudflare.com` |
| Postgres | docker container `friday-pg`, `postgres://friday:***@127.0.0.1:5433/friday` (password in `infra/.env`) |

## Build rules — do not skip

**Android builds MUST use the wrapper.** This host is aarch64 but the Android
SDK is x86_64 and runs under qemu:

```bash
cd /home/ubuntu/friday-one/android
flock /tmp/gradle.lock ./build.sh debug        # ALWAYS wrap in flock
```

- `QEMU_LD_PREFIX=/usr/x86_64-linux-gnu` is set by `build.sh`. Without it aapt2
  dies with `Could not open '/lib64/ld-linux-x86-64.so.2'` and AGP misreports it
  as "AAPT2 daemon startup failed".
- **Only use an ELF aapt2.** AGP rejects a shell-script override with "does not
  point to an AAPT2 executable". Never try to wrap aapt2 in a script.
- The box has **2 cores**. Always `flock /tmp/gradle.lock` so concurrent agents
  serialise instead of thrashing. A full build can take several minutes.
- Backend: `cd /home/ubuntu/friday-one/server && npx tsc --noEmit` must be clean.

## Non-negotiables

1. **Never weaken auth or the path jail to make something work.** The
   filesystem routes resolve `realpath()` and assert containment in
   `FS_ROOTS`; device trust is enforced server-side. If a task seems to need
   one of these relaxed, stop and say so instead of doing it.
2. **No secret in any committed file.** No keys, tokens or passwords in source,
   config, logs or test fixtures. Read them from the environment.
3. **Comment the WHY, not the WHAT.** If a line exists to work around a specific
   host quirk or a security property, say so in one sentence.
4. **Do not reformat or delete code you were not asked to change.** Other agents
   are editing this repo concurrently.
5. **Stay inside your file ownership** (see TASKS.md). Two agents editing one
   file silently destroys work.
6. **Never emit model-output wrappers into a file.** A previous agent wrote a
   literal `</content>` as the last line of two Kotlin files, which compiles as
   "Expecting a top level declaration" at EOF and wastes a whole build cycle.
   If you write files via a tool, the content is exactly what you pass - no
   fences, no `</content>`, no trailing prose. Same for `</output>` and ```.
7. **Finish, or say you did not.** An agent once wrote zero files, left an empty
   package, printed "now writing all files…", and exited 0. Producing nothing
   while reporting progress is the worst possible outcome: it looks like success
   until someone compiles. If you run out of room, say exactly what is missing.

## Definition of done for every task

- Code compiles: backend `npx tsc --noEmit` clean; Android `flock /tmp/gradle.lock ./build.sh debug` succeeds.
- You ran it and saw it work, or you state plainly what you could not verify.
- **Never report success you did not observe.** A plausible sentence is worse
  than an honest "blocked on X".
