# FRIDAY One — Deployment Guide

## Architecture

The backend (Fastify + TypeScript) binds to `127.0.0.1:8787` and is never
directly exposed to the internet. A Cloudflare Tunnel forwards external HTTPS
traffic to the local port. Two systemd units manage the lifecycle:

| Unit | Script | Purpose |
|---|---|---|
| `friday-one-api.service` | `scripts/run-server.sh` | Runs migrations, starts the Node.js API |
| `friday-one-tunnel.service` | `scripts/tunnel.sh` | Opens the Cloudflare Tunnel |

PostgreSQL runs in a Docker container (`friday-pg`) and is accessed over
`127.0.0.1:5433`. Credentials live in `server/.env` (never committed).

---

## Option A: Quick Tunnel (current setup)

**What it is:** `cloudflared tunnel --url http://127.0.0.1:8787` with no
Cloudflare account, no login, no DNS configuration. Cloudflare assigns a random
`*.trycloudflare.com` hostname on each start.

**Trade-off:** Zero configuration, perfect for development and ad-hoc testing.
The hostname changes every time the tunnel restarts, which means the Android app
must be rebuilt with the new URL. **Unsuitable for production.**

### Running manually

```bash
# Terminal 1 — start the API
./scripts/run-server.sh

# Terminal 2 — start the tunnel (waits for /health before connecting)
./scripts/tunnel.sh
```

The tunnel prints the assigned URL to stdout:
```
INF +-----------------------------------------------------------+
INF |  Your quick Tunnel has been created! Visit it at:         |
INF |  https://<random-words>.trycloudflare.com                 |
INF +-----------------------------------------------------------+
```

### Running via systemd

```bash
sudo cp infra/systemd/friday-one-api.service /etc/systemd/system/
sudo cp infra/systemd/friday-one-tunnel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now friday-one-api.service
sudo systemctl enable --now friday-one-tunnel.service

# Watch the tunnel URL appear in logs:
journalctl -u friday-one-tunnel.service -f
```

---

## Option B: Permanent Named Tunnel (production)

**What it is:** A Cloudflare tunnel bound to your account with a stable hostname
(e.g., `api.friday.example.com`). Requires a Cloudflare account and a domain
managed in Cloudflare DNS.

**Trade-off:** Stable URL means the Android app doesn't need rebuilding on every
restart. Requires initial setup and a Cloudflare account. This is the correct
path for production.

### Setup (one-time)

```bash
# 1. Authenticate with Cloudflare (opens browser)
cloudflared tunnel login

# 2. Create a named tunnel
cloudflared tunnel create friday-one
# Note the tunnel UUID printed here.

# 3. Configure routing — point a DNS record at the tunnel
cloudflared tunnel route dns friday-one api.friday.example.com

# 4. Write the config file (~/.cloudflared/config.yml)
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: <YOUR_TUNNEL_UUID>
credentials-file: /home/ubuntu/.cloudflared/<YOUR_TUNNEL_UUID>.json

ingress:
  - hostname: api.friday.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
EOF
```

### Modified systemd unit for named tunnel

Replace the `ExecStart` in `friday-one-tunnel.service` with:

```ini
ExecStart=/usr/local/bin/cloudflared tunnel run friday-one
```

And add the credentials directory to `ReadWritePaths`:

```ini
ReadWritePaths=/home/ubuntu/.cloudflared
```

Then reload:

```bash
sudo systemctl daemon-reload
sudo systemctl restart friday-one-tunnel.service
```

---

## Security Hardening

Both systemd units follow the same hardening pattern as `friday-console.service`:

| Directive | Effect |
|---|---|
| `NoNewPrivileges=true` | Prevents privilege escalation via setuid binaries |
| `ProtectSystem=strict` | Mounts `/usr`, `/boot`, `/efi` read-only |
| `ProtectHome=read-only` | Home directory visible but not writable |
| `PrivateTmp=true` | Isolated `/tmp` per service |
| `ProtectKernelTunables=true` | Blocks writes to `/proc/sys`, `/sys` |
| `ProtectControlGroups=true` | Makes cgroup hierarchy read-only |
| `RestrictSUIDSGID=true` | Blocks creating setuid/setgid files |
| `LockPersonality=true` | Locks execution domain (no 32-bit compat switches) |
| `ReadWritePaths=` | Explicit allowlist of writable directories |

The API server itself binds only to `127.0.0.1` — it cannot receive traffic
that doesn't come through the tunnel or localhost.

---

## Android App: BASE_URL Build-Time Binding

The Android app's `BASE_URL` is baked into the APK at build time via the Gradle
property `-PFRIDAY_BASE_URL=`:

```bash
cd android
flock /tmp/gradle.lock ./build.sh debug -PFRIDAY_BASE_URL=https://<tunnel-host>.trycloudflare.com
```

**Consequence:** When using a quick tunnel, every tunnel restart may produce a
new hostname, requiring an app rebuild and reinstall. This is why the permanent
named tunnel (Option B) is required before shipping to real devices.

### Future Work: Runtime Config Override

A planned improvement is to allow overriding `BASE_URL` at runtime via a hidden
settings screen or a config file pushed over ADB, so testers can switch tunnel
URLs without recompiling. This is not yet implemented.

---

## Prerequisites

| Dependency | Version | Install |
|---|---|---|
| Node.js | v22 | Pre-installed on this host |
| cloudflared | latest | `/usr/local/bin/cloudflared` |
| Docker | 29.x | For PostgreSQL (`friday-pg` container) |
| PostgreSQL | via Docker | `docker-compose -f infra/docker-compose.yml up -d` |

---

## Existing Tailscale Setup

This box also runs Tailscale for other services (including `friday-console`).
The Cloudflare Tunnel deployment does **not** modify, disable, or replace the
Tailscale configuration. Both coexist: Tailscale for machine-to-machine access,
Cloudflare Tunnel for the mobile app's HTTPS endpoint.

</content>