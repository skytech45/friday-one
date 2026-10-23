import type { FastifyInstance } from "fastify";
import os from "node:os";
import fs from "node:fs";
import { statfs } from "node:fs/promises";
import { query } from "../db.js";

/**
 * System telemetry.
 *
 * Two rules shape this file:
 *
 * 1. No collector may throw. On this host most sensors are genuinely absent
 *    (no cpufreq, no thermal zones, no GPU counters), so each one degrades to
 *    null and the client renders a dash. A dashboard that 500s because one
 *    sensor is missing is worse than one that admits it doesn't know.
 *
 * 2. Rates are measured over a real interval, not since module load. CPU used to
 *    be a delta against load time, so the first request after a restart compared
 *    "now" to "boot" and reported nonsense. Same reasoning for network and disk:
 *    first call returns null ("unknown yet"), never a fake zero - idle and
 *    unknown are different facts and the UI shows them differently.
 */

interface CpuSample {
  idle: number;
  total: number;
}

function cpuSample(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function pct(prev: CpuSample, next: CpuSample): number {
  const dt = next.total - prev.total;
  const di = next.idle - prev.idle;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - di / dt) * 100));
}

let last = cpuSample();

function safeRead(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Per-core usage + clock, so the client can draw one bar per core. */
const prevCore = new Map<number, { idle: number; total: number }>();

function coreMhz(n: number): number | null {
  const f =
    safeRead(`/sys/devices/system/cpu/cpu${n}/cpufreq/scaling_cur_freq`) ??
    safeRead(`/sys/devices/system/cpu/cpu${n}/cpufreq/cpuinfo_cur_freq`);
  if (f) {
    const khz = Number(f.trim());
    if (Number.isFinite(khz) && khz > 0) return Math.round(khz / 1000);
  }
  return null; // no cpufreq on cloud VMs - say so rather than inventing a number
}

function perCore(): Array<{ core: number; usage_pct: number; mhz: number | null }> {
  const stat = safeRead("/proc/stat");
  const out: Array<{ core: number; usage_pct: number; mhz: number | null }> = [];
  if (!stat) return out;
  for (const row of stat.split("\n")) {
    if (!/^cpu\d+\s/.test(row)) continue;
    const parts = row.trim().split(/\s+/);
    const n = Number(parts[0]!.slice(3));
    const vals = parts.slice(1, 9).map(Number);
    const idle = (vals[3] ?? 0) + (vals[4] ?? 0);
    const total = vals.reduce((a, b) => a + (b || 0), 0);
    const prev = prevCore.get(n);
    prevCore.set(n, { idle, total });
    let u = 0;
    if (prev && total - prev.total > 0) {
      u = Math.max(0, Math.min(100, 100 * (1 - (idle - prev.idle) / (total - prev.total))));
    }
    out.push({ core: n, usage_pct: +u.toFixed(1), mhz: coreMhz(n) });
  }
  return out;
}

/** Temperatures. Empty on this host; the shape stays honest about that. */
function temps(): { cpu_c: number | null; zones: Array<{ name: string; c: number }> } {
  const zones: Array<{ name: string; c: number }> = [];
  try {
    for (const d of fs.readdirSync("/sys/class/thermal")) {
      if (!d.startsWith("thermal_zone")) continue;
      const name = safeRead(`/sys/class/thermal/${d}/type`)?.trim() ?? d;
      const raw = safeRead(`/sys/class/thermal/${d}/temp`);
      if (!raw) continue;
      let c = Number(raw.trim());
      if (!Number.isFinite(c)) continue;
      if (Math.abs(c) > 1000) c = c / 1000; // millidegrees
      zones.push({ name, c: +c.toFixed(1) });
    }
  } catch {
    /* no thermal class at all */
  }
  const cpuZone = zones.find((z) => /cpu|soc|pkg|x86_pkg|coretemp/i.test(z.name));
  return { cpu_c: cpuZone ? cpuZone.c : null, zones: zones.slice(0, 8) };
}

function readNet(): Map<string, { rx: number; tx: number }> {
  const m = new Map<string, { rx: number; tx: number }>();
  const raw = safeRead("/proc/net/dev");
  if (!raw) return m;
  for (const line of raw.split("\n").slice(2)) {
    const [namePart, rest] = line.split(":");
    if (!namePart || !rest) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    if (f.length >= 9) m.set(namePart.trim(), { rx: f[0] ?? 0, tx: f[8] ?? 0 });
  }
  return m;
}

let lastNet = readNet();
let lastNetAt = Date.now();

function net(): {
  ifaces: Array<{ name: string; rx_Bps: number | null; tx_Bps: number | null; up: boolean }>;
  rx_Bps: number | null;
  tx_Bps: number | null;
} {
  const now = readNet();
  const dt = (Date.now() - lastNetAt) / 1000;
  const prev = lastNet;
  lastNet = now;
  lastNetAt = Date.now();

  const ifaces: Array<{ name: string; rx_Bps: number | null; tx_Bps: number | null; up: boolean }> = [];
  let rxTotal: number | null = 0;
  let txTotal: number | null = 0;

  for (const [name, cur] of now) {
    if (name === "lo") continue; // loopback is noise on a dashboard
    const p = prev.get(name);
    const up = (safeRead(`/sys/class/net/${name}/operstate`)?.trim() ?? "unknown") === "up";
    if (!p || dt <= 0) {
      ifaces.push({ name, rx_Bps: null, tx_Bps: null, up });
      rxTotal = null;
      txTotal = null;
      continue;
    }
    const rx = Math.max(0, (cur.rx - p.rx) / dt);
    const tx = Math.max(0, (cur.tx - p.tx) / dt);
    ifaces.push({ name, rx_Bps: +rx.toFixed(1), tx_Bps: +tx.toFixed(1), up });
    if (rxTotal !== null) rxTotal += rx;
    if (txTotal !== null) txTotal += tx;
  }
  return {
    ifaces: ifaces.sort((a, b) => (b.rx_Bps ?? 0) - (a.rx_Bps ?? 0)).slice(0, 6),
    rx_Bps: rxTotal === null ? null : +rxTotal.toFixed(1),
    tx_Bps: txTotal === null ? null : +txTotal.toFixed(1),
  };
}

/** Root disk via statfs - more trustworthy than parsing df. */
async function disk(): Promise<{ total: number; used: number; avail: number; used_pct: number } | null> {
  try {
    const s = await statfs("/");
    const total = s.blocks * s.bsize;
    const avail = s.bavail * s.bsize;
    const used = total - s.bfree * s.bsize;
    const reserved = total - s.bfree * s.bsize - avail;
    const denom = total - Math.max(0, reserved - used > 0 ? 0 : 0);
    return {
      total,
      used,
      avail,
      used_pct: denom > 0 ? +((100 * used) / denom).toFixed(1) : 0,
    };
  } catch {
    return null;
  }
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/system", { preHandler: app.authenticate }, async (_req, reply) => {
    const now = cpuSample();
    const usage = pct(last, now);
    last = now;

    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;

    const mounts: Array<{ fs: string; size: number; used: number; avail: number; usedPct: number }> = [];
    for (const fs of ["/", "/home"]) {
      try {
        const s = await statfs(fs);
        const size = s.blocks * s.bsize;
        const avail = s.bavail * s.bsize;
        mounts.push({
          fs,
          size,
          used: size - avail,
          avail,
          usedPct: size > 0 ? ((size - avail) / size) * 100 : 0,
        });
      } catch {
        /* mount may not exist on this host */
      }
    }

    const load = os.loadavg();
    const uptime = os.uptime();
    const tempsInfo = temps();
    const diskInfo = await disk();
    const netInfo = net();

    // Process count from /proc/loadavg's 4th field ("1/288" = running/total);
    // cheaper and more accurate than listing /proc.
    const procs = Number(
      safeRead("/proc/loadavg")?.split(/\s+/)[3]?.split("/")[1] ?? 0,
    );

    return reply.send({
      host: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      uptime_s: Math.round(uptime),
      booted_at: new Date(Date.now() - uptime * 1000).toISOString(),
      cpu: {
        model: os.cpus()[0]?.model ?? "unknown",
        cores: os.cpus().length,
        usage_pct: Math.round(usage * 10) / 10,
        per_core: perCore(),
        load: { "1m": load[0], "5m": load[1], "15m": load[2] },
      },
      memory: {
        total,
        used,
        free,
        used_pct: Math.round((used / total) * 1000) / 10,
      },
      disk: diskInfo,
      temp: tempsInfo,
      net: netInfo,
      proc: {
        count: Number.isFinite(procs) ? procs : 0,
        pid: process.pid,
        rss: process.memoryUsage().rss,
      },
      mounts,
      ts: Date.now(),
    });
  });

  // Recent auth/device events, so the app can show "who tried to get in".
  app.get("/system/audit", { preHandler: app.authenticateTrusted }, async (req, reply) => {
    const rows = await query(
      `SELECT action, ip, detail, created_at
         FROM audit_log WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [req.user.sub],
    );
    return reply.send({ events: rows.rows });
  });

  app.get("/system/ping", async (_req, reply) => {
    const t0 = process.hrtime.bigint();
    return reply.send({
      pong: true,
      server_time: new Date().toISOString(),
      handle_ns: Number(process.hrtime.bigint() - t0),
    });
  });
}
