# FRIDAY One — Connector Installation Guide

The connector is a small service on your Linux VPS. It connects **out** to
the FRIDAY One gateway (no inbound ports), runs only operations your
policies allow, and talks to OpenCode or Hermes on that server.

> **Status (2026-10-28):** use release **`v0.9.1`** or later. Its assets
> were downloaded and checked after publishing (checksums, pinned versions,
> the connector starts). `v0.6.0` and `v0.9.0` ship a connector that does not
> start and an installer that cannot pair (FULL_SYSTEM_AUDIT.md A-1/A-3).
> A full app-to-agent run on a real VPS has not been done yet.

## 1. Supported systems

| | Tested | Notes |
|---|---|---|
| OS | Ubuntu 22.04, Ubuntu 24.04, Debian 12 | others refused unless `FRIDAY_ALLOW_UNTESTED_OS=1` |
| Architecture | x86_64, aarch64 | |
| Init | systemd | required |
| Runtime | Node.js ≥ 20 | **not installed by the installer**; install it first |

## 2. VPS requirements

- ~100 MB free disk in `/opt`, 512 MB RAM or more (more for the agent itself).
- `sudo` access for installation and setup only. The connector never runs as root.

## 3. Network

Outbound HTTPS (443) to the control plane and the gateway. **No inbound
port** is opened or needed; leave your firewall and SSH settings as they are.

## 4. Prepare the app

1. Install the FRIDAY One app and sign in.
2. Keep it open on **Add Server**; you'll generate a pairing session in step 7.

## 5. Download and verify the installer

These commands install `v0.9.1`; for a newer release, change the tag in
both URLs. Versioned URLs are reproducible; avoid `latest` for installs.

```bash
curl -fsSLO https://github.com/skytech45/friday-one/releases/download/v0.9.1/install.sh
```

```bash
curl -fsSLO https://github.com/skytech45/friday-one/releases/download/v0.9.1/install.sh.sha256
```

```bash
sha256sum -c install.sh.sha256
```

```bash
less install.sh
```

## 6. Install

```bash
sudo bash install.sh
```

It downloads the connector and the `fridayone` CLI for this version,
verifies their SHA-256 checksums (it stops on any mismatch), creates the
`friday-connector` account (no login, no sudo) and installs a hardened
systemd unit. It does **not** start the service until you pair.

| Path | Contents |
|---|---|
| `/opt/friday-connector/` | connector bundle, its checksum, `VERSION` |
| `/usr/local/bin/fridayone` | the CLI |
| `/etc/friday-connector/connector.env` | URLs and project roots (0640, no secrets) |
| `/etc/friday-connector/credential` | the connector's credential (0600, service account only) |
| `/etc/systemd/system/friday-connector.service` (+ `.d/`) | unit + your project roots |
| `/run/friday-connector/state.json` | live connection state (no secrets) |
| `/var/lib/friday-connector/` | the service account's home (agent config lives here) |

## 7. Run `fridayone setup`

```bash
sudo fridayone setup
```

The wizard:
1. checks OS, architecture, systemd, Node.js and disk;
2. asks for the **control plane URL** (HTTPS only) and checks `/api/v1/health`;
3. takes the **gateway URL** advertised by the control plane (you can override it).
   The hosted control plane currently advertises an `https://` address. In
   `v0.9.1` setup rejects it: type the same address with `wss://` instead.
   Later releases convert `https://` to `wss://` automatically;
4. asks which **project directories** the agent may work in (they must
   exist; system paths are refused) and grants write access to those only;
5. asks for the **enrollment token**. In the app: *Add Server → Generate
   Pairing Session*, then copy the token. It's read without echo and never
   stored or put in shell history.

## 8. Complete pairing (QR or numeric code)

The connector prints a **QR code** and a **16–20 digit code**. In the app,
scan the QR, or choose *Pair with Key* and type the code. Codes expire after
10 minutes and work once. The wizard waits until the app has claimed it.

## 9. Confirm the gateway connection

The wizard starts the service and waits until the gateway **accepts the
credential**. Then it prints a stage-by-stage report: package installed,
configuration saved, pairing successful, gateway authenticated, gateway
connected, agent available. Later, at any time:

```bash
fridayone status
```

`status` exits 0 only when the gateway has authenticated this connector.
A resolving hostname or an open port does not count.

## 10. Agents

Install OpenCode and/or Hermes **for the `friday-connector` account**: its
home is `/var/lib/friday-connector`, and the model-provider keys belong
there, not in the connector's config. Check what the connector can see:

```bash
fridayone doctor
```

Connector enrollment and the gateway connection need **no** model provider
key; only running prompts does.

## 11. First test command

In the app, open the server's chat, pick the agent and a project
directory, and send a harmless prompt, for example "list the files in this
project". The answer streams live. If a policy denies it, the app shows
`policy_deny`, which also proves the gate works.

## 12. Status and logs

```bash
fridayone status
```

```bash
fridayone doctor
```

```bash
fridayone logs -f
```

Logs come from the systemd journal, with credential-shaped values redacted.

## 13. Update

```bash
sudo fridayone update v0.9.1
```

Replace `v0.9.1` with the release you're moving to.

This downloads that release's installer, verifies its checksum, replaces the
binaries, keeps your configuration and pairing, and restarts the service if
it was running.

## 14. Rotate the credential or re-pair

- **Rotate:** in the app, *Security → Rotate*. The connector picks it up
  automatically: within a minute on `v0.9.x` connectors, within 15 minutes
  on connectors from the Firebase migration.
- **Re-pair:** `sudo fridayone setup`, answer *yes* to pairing again, then
  revoke the old server in the app.

## 15. Revoke a server

In the app, *Security → Revoke*. The gateway closes the connection; the
connector stops without restarting and `fridayone status` shows **revoked**.

## 16. Uninstall

```bash
sudo fridayone uninstall
```

This keeps `/etc/friday-connector`. To remove the configuration, the
credential and the service account too:

```bash
sudo fridayone uninstall --purge
```

Also revoke the server in the app, so its credential is dead server-side.

## 17. Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
