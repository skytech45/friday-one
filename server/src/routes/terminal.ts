import type { FastifyInstance } from "fastify";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { assertTokenClaims, assertNoCritHeader } from "../tokenClaims.js";
import { isRevoked } from "../revocation.js";
import { childEnv, config } from "../config.js";
import { query } from "../db.js";

/**
 * Only these commands can be spawned. This is an allowlist on purpose: the
 * WebSocket hands a live terminal to a phone, and a free-form command parameter
 * would be remote code execution by design.
 */
const COMMANDS: Record<string, { cmd: string; label: string }> = {
  // Absolute path: hermes lives in ~/.local/bin, which is deliberately NOT in
  // the terminal child's PATH (childEnv allows only system dirs), so a bare
  // "hermes" fails with ENOENT.
  hermes: { cmd: "/home/ubuntu/.local/bin/hermes --tui", label: "Hermes TUI" },
  opencode: { cmd: "opencode", label: "OpenCode" },
  shell: { cmd: "bash -l", label: "Shell" },
};

// F-17: every terminal is a live PTY on the host, so each one is bounded.
//  - a server-wide cap on concurrent sessions;
//  - backpressure: when the WebSocket's send buffer exceeds the high mark
//    (a client that stopped reading, or a link that collapsed), the child's
//    output streams are PAUSED until the buffer drains below the low mark —
//    otherwise `cat bigfile` buffers unbounded memory in this process;
//  - an idle timeout: a session that receives no client input is closed.
const MAX_TERMINALS = 5;
const SOCKET_BUFFER_HIGH = 4 * 1024 * 1024;
const SOCKET_BUFFER_LOW = 1 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 30 * 60_000;
let liveTerminals = 0;

interface TerminalQuery {
  token?: string;
  kind?: string;
  cols?: string;
  rows?: string;
}

export async function terminalRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: TerminalQuery }>(
    "/ws/terminal",
    { websocket: true },
    async (socket, req) => {
      const q = req.query;
      let sub: string | null = null;
      let did: string | null = null;

      try {
        // Browsers cannot set headers on a WebSocket, so the access token rides
        // in the query string. It is short-lived (15m) and checked before any
        // process is spawned.
        const payload = app.jwt.verify<{ sub: string; did?: string }>(q.token ?? "");
        assertTokenClaims(payload);
        // fast-jwt 5.x ignores `crit`, so the header is checked explicitly.
        const decoded = app.jwt.decode<{ header?: unknown }>(q.token ?? "");
        assertNoCritHeader(decoded?.header);
        sub = payload.sub;
        did = payload.did ?? null;
      } catch {
        socket.close(4401, "unauthorized");
        return;
      }

      const device = await query<{ trusted: boolean; revoked: boolean }>(
        "SELECT trusted, revoked FROM devices WHERE id = $1 AND user_id = $2",
        [did, sub],
      )
        .then((r) => r.rows[0])
        .catch(() => undefined);

      if (!device || !device.trusted || device.revoked) {
        socket.close(4403, "device_not_trusted");
        return;
      }

      // A revoked device's access token must not open a terminal (F-07).
      if (isRevoked(did)) {
        socket.close(4401, "unauthorized");
        return;
      }

      const spec = COMMANDS[q.kind ?? "shell"];
      if (!spec) {
        socket.close(4400, "unknown_terminal");
        return;
      }

      if (liveTerminals >= MAX_TERMINALS) {
        socket.close(4529, "too_many_terminals");
        return;
      }
      liveTerminals++;

      // Clamped generously rather than defensively. The previous 40-column floor
      // was itself wider than a phone in portrait: the PTY was forced to 40 cols
      // even when the screen fit 30, so TUIs wrapped their output for a width
      // that did not exist and text ran off the edge. The client now reports its
      // real fitted size (see assets/terminal/index.html).
      const cols = Math.max(20, Math.min(300, Number(q.cols ?? 100) || 100));
      const rows = Math.max(6, Math.min(120, Number(q.rows ?? 30) || 30));

      // `script` is what gives us a PTY without a native module: it allocates a
      // pseudo-terminal for the child even when its own stdio is a pipe, so TUIs
      // (Ink, OpenCode) get a real tty and behave.
      //
      // `stty` runs FIRST, inside the pty, to set the pty's actual window size.
      // Setting COLUMNS/LINES in the environment is not enough on its own:
      // Node-based TUIs read the size from the tty via ioctl (process.stdout
      // .columns), not from env, so without this they keep drawing for the
      // default 80x24 and their output wraps off a phone screen.
      // node-pty would let us ioctl directly but does not build on this host
      // (native gyp failure), so this is the portable equivalent for the initial
      // size. `exec` replaces the wrapper shell so Ctrl-C still reaches the real
      // process rather than a shell that is merely its parent.
      const sized = `stty rows ${rows} cols ${cols} 2>/dev/null; exec ${spec.cmd}`;
      // The working directory doubles as the child's HOME, so the terminal
      // does not run in the owner's home where .hermes and .ssh live.
      const cwd = config.terminalCwd;
      const child: ChildProcessWithoutNullStreams = spawn(
        "script",
        ["-qfc", sized, "/dev/null"],
        {
          cwd,
          // An explicit allowlist, NOT `...process.env`. The server's
          // environment used to carry JWT_SECRET, DATABASE_URL and
          // FINGERPRINT_PEPPER into the shell, where a prompt injection into
          // Hermes or OpenCode could read them with one command (F-10).
          env: childEnv({
            home: cwd,
            term: "xterm-256color",
            cols,
            rows,
          }),
        },
      );

      req.log.info({ kind: q.kind, pid: child.pid }, "terminal opened");

      let closed = false;
      let idleTimer: ReturnType<typeof setInterval> | null = null;
      let lastClientInput = Date.now();
      const stop = (): void => {
        if (closed) return;
        closed = true;
        liveTerminals--;
        if (idleTimer) clearInterval(idleTimer);
        try {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 2000);
        } catch {
          /* already gone */
        }
      };

      // Backpressure (F-17): ws keeps buffering what we hand it even when the
      // client stops reading. Pause the child above the high watermark and
      // poll until the buffer drains below the low one.
      let paused = false;
      let resumeTimer: ReturnType<typeof setInterval> | null = null;
      const wsSock = socket as unknown as { bufferedAmount: number };
      const applyBackpressure = (): void => {
        if (!paused && wsSock.bufferedAmount > SOCKET_BUFFER_HIGH) {
          paused = true;
          child.stdout.pause();
          child.stderr.pause();
          resumeTimer = setInterval(() => {
            if (closed || wsSock.bufferedAmount <= SOCKET_BUFFER_LOW) {
              if (resumeTimer) clearInterval(resumeTimer);
              resumeTimer = null;
              paused = false;
              if (!closed) {
                child.stdout.resume();
                child.stderr.resume();
              }
            }
          }, 200);
        }
      };

      // Idle timeout (F-17): kill sessions nobody is driving.
      idleTimer = setInterval(() => {
        if (Date.now() - lastClientInput > IDLE_TIMEOUT_MS) {
          req.log.info({ pid: child.pid }, "terminal idle timeout");
          stop();
          if (socket.readyState === socket.OPEN) socket.close(1001, "idle_timeout");
        }
      }, 60_000);

      child.stdout.on("data", (buf: Buffer) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(buf.toString("utf8"));
          applyBackpressure();
        }
      });
      child.stderr.on("data", (buf: Buffer) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(buf.toString("utf8"));
          applyBackpressure();
        }
      });
      child.on("exit", (code) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(`\r\n[process exited: ${code ?? "signal"}]\r\n`);
          socket.close(1000, "process_exited");
        }
        // Not `closed = true` directly: the counter and idle timer must be
        // released exactly as in the socket-close path (F-17).
        stop();
      });

      socket.on("message", (raw: Buffer) => {
        lastClientInput = Date.now();
        let text = raw.toString("utf8");
        // Control frames: resize hint and explicit kill.
        if (text.startsWith("\u0000")) {
          const cmd = text.slice(1);
          if (cmd === "kill") stop();
          return;
        }
        child.stdin.write(text);
      });

      socket.on("close", stop);
      socket.on("error", stop);
    },
  );

  app.get("/ws/terminals", async (_req, reply) =>
    reply.send({
      terminals: Object.entries(COMMANDS).map(([kind, spec]) => ({
        kind,
        label: spec.label,
      })),
    }),
  );
}
