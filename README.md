# FRIDAY One

FRIDAY One lets you run AI coding agents (**OpenCode**, **Hermes**) on your
own Linux servers and control them from an Android app: pair a VPS, send
prompts, watch the output stream live, approve sensitive actions, set
policies and revoke access.

```text
 Android app ──HTTPS──▶ Control plane (auth, pairing, policies, audit)
      │                         │
      └──────WSS──────▶ Realtime gateway ◀──WSS (outbound only)── Connector on your VPS
                                                                     └─ OpenCode / Hermes
```

- **The app** handles sign-in, pairing (QR or numeric code), servers, chat, approvals, policies and audit.
- **The control plane** owns accounts, pairing, policies and audit records. Today it runs on Vercel + Supabase; a Firebase port is on branch `firebase/migration-phase-0`.
- **The gateway** relays authenticated WebSocket traffic between the app and connectors.
- **The connector** runs on your VPS as an unprivileged service. It connects out only, enforces your policies locally, and drives the agent.

## Status

Not production-ready. The current verified state, known defects and open
gates are in [docs/FULL_SYSTEM_AUDIT.md](docs/FULL_SYSTEM_AUDIT.md) and
[docs/PRODUCTION_READINESS_CHECKLIST.md](docs/PRODUCTION_READINESS_CHECKLIST.md).

> **Install from `v0.9.2` or later.** The `v0.6.0` and `v0.9.0` connector
> bundles do not start and their installer cannot pair (audit A-1, A-3).
> `v0.9.2` assets were downloaded and checked after publishing; a full
> app-to-agent run on a real VPS has not been done yet (gate E-1).

## Supported platforms

| Component | Supported |
|---|---|
| Android app | Android 8.0 (API 26) and later |
| Connector | Ubuntu 22.04 / 24.04, Debian 12 · x86_64, aarch64 · systemd · Node.js ≥ 20 |

## Install the connector on a VPS

Download, verify and read the installer for a specific release (`v0.9.2`
is the current one; use a newer tag from the Releases page if there is one):

```bash
curl -fsSLO https://github.com/skytech45/friday-one/releases/download/v0.9.2/install.sh
```

```bash
curl -fsSLO https://github.com/skytech45/friday-one/releases/download/v0.9.2/install.sh.sha256
```

```bash
sha256sum -c install.sh.sha256 && less install.sh
```

```bash
sudo bash install.sh
```

Then pair it with the app:

```bash
sudo fridayone setup
```

The wizard checks the system, asks for the control plane and your project
directories, then asks for the **enrollment token** from the app (*Add
Server → Generate Pairing Session*). The token is read without echo. It
shows a **QR code and a numeric code**: scan or type it in the app. It
then waits until the gateway has **authenticated** the connector, and
reports each stage separately.

Verify at any time:

```bash
fridayone status
```

```bash
fridayone doctor
```

Full guide: [docs/CONNECTOR_INSTALLATION.md](docs/CONNECTOR_INSTALLATION.md) ·
Problems: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## Connect OpenCode or Hermes

Install the agent so the `friday-connector` account can run it (its home is
`/var/lib/friday-connector`; model-provider keys go there).
`fridayone doctor` shows which agents the connector can see. Pairing and the
gateway connection don't need any model-provider key.

## Security notes

- The connector runs as `friday-connector`: no login, no capabilities, a
  read-only system view, and write access only to the project
  directories you choose. It opens **no inbound port**.
- Downloads are pinned to a version and SHA-256-verified; the install fails closed on any mismatch.
- The connector's only secret is its own revocable credential (0600).
  Enrollment tokens are single-use, short-lived and never stored.
- Every command is re-authorized by the gateway and checked against your
  policy on the VPS right before it runs, failing closed.

## Repository layout

```text
android/        Android app (Kotlin, Jetpack Compose)
control-plane/  Control plane API (Vercel + Supabase)
gateway/        Realtime WebSocket gateway
connector/      VPS connector, install.sh, fridayone CLI (connector/cli/)
infra/          Database migrations, systemd units
docs/           Design, protocol, setup, audit and test reports
```

## Documentation

- [Connector installation](docs/CONNECTOR_INSTALLATION.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Full system audit](docs/FULL_SYSTEM_AUDIT.md) · [End-to-end test report](docs/END_TO_END_TEST_REPORT.md) · [Production readiness](docs/PRODUCTION_READINESS_CHECKLIST.md)
- [Realtime protocol](docs/REALTIME_PROTOCOL.md) · [Backend](docs/BACKEND.md) · [Deploy (legacy stack)](docs/DEPLOY.md) · [Google OAuth setup](docs/GOOGLE_OAUTH_SETUP.md)

## License

No license file has been added yet, so all rights are reserved by the owner.
