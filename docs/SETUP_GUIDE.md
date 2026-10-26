# FRIDAY One — Complete Setup & Pairing Guide

FRIDAY One is a secure, zero-trust cloud server management and autonomous AI agent execution platform. It allows developers and sysadmins to manage Linux cloud servers, execute AI tasks (via OpenCode and Hermes adapters), and review sensitive operational permissions directly from an Android mobile application.

---

## Architecture Overview

```
┌──────────────────────────────────────┐
│        Android Mobile App            │
│   (Jetpack Compose · Apple Theme)    │
│  - Google OAuth / Email Auth         │
│  - QR Scanner & Numeric Key Pairing  │
│  - Live Agent Chat & Approvals       │
└──────────────┬───────────────────────┘
               │
        HTTPS  │  WSS (App Auth)
               ▼
┌───────────────────────────┐      WSS (Outbound)    ┌───────────────────────────┐
│ Control Plane (Vercel)    │◀───────────────────────┤ Realtime Gateway (:8790)  │
│ - Ephemeral Pairing (10m) │                        │ - ReplayGuard & Heartbeat │
│ - Token Verification      │                        │ - Streaming chat.delta    │
│ - Supabase Auth & RLS DB  │                        └─────────────▲─────────────┘
└───────────────────────────┘                                      │
                                                    WSS (Outbound) │ (No Inbound Ports)
                                                                   │
                                                     ┌─────────────┴─────────────┐
                                                     │ Cloud Server (Linux VPS)  │
                                                     │ - `fridayone` CLI Tool    │
                                                     │ - Edge Connector Service  │
                                                     │ - OpenCode / Hermes Agent │
                                                     └───────────────────────────┘
```

### Key Security Principles
1. **No Inbound Open Ports:** The cloud server initiates an **outbound-only** TLS WebSocket connection to the gateway. Firewalls and NAT require zero inbound port holes.
2. **Zero Secrets on Client:** No database connection strings, SSH private keys, or root credentials exist on the Android device.
3. **10-Minute Ephemeral Pairing:** Tokens and QR codes expire automatically after 10 minutes or 5 failed attempts.
4. **Least Privilege & Isolation:** The connector daemon runs under an unprivileged system user (`friday-connector`) with `0600` permission configuration files.
5. **Interactive Policy Approvals:** Dangerous operations fail closed and trigger real-time push cards on the Android app for explicit human sign-off.

---

## 1. Cloud Server Setup (Linux VPS)

Supported distributions: **Ubuntu 20.04+, Ubuntu 22.04+, Debian 11+, Debian 12+**.

### Step 1.1: Install FRIDAY Connector Framework

Run the one-line automated installer with `sudo`:

```bash
curl -fsSL https://friday-one-control-plane-cotts1-2550.vercel.app/install.sh | sudo bash
```

The installer will:
- Check for system requirements (`systemd`, `curl`, `tar`, `node` >= 18).
- Create the isolated system user `friday-connector`.
- Download and verify the signed standalone connector bundle.
- Install the global CLI executable: `/usr/local/bin/fridayone`.
- Register the `systemd` service (`friday-connector.service`).

---

### Step 1.2: Run the Pairing Process

Once installed, simply run the `fridayone` command in your server terminal:

```bash
fridayone
```

You can also pass your 10-minute pairing token directly:
```bash
fridayone <YOUR_PAIRING_TOKEN>
```

When triggered, `fridayone` will:
1. Contact the control plane to initiate an authenticated enrollment session.
2. Render an **ASCII QR Code** directly in the terminal:
   ```
   ▄▄▄▄▄▄▄   ▄ ▄▄ ▄▄▄▄▄▄▄
   █ ▄▄▄ █ █ █ █ █ █ ▄▄▄ █
   █ ███ █ ▄▀█▄█▀█ █ ███ █
   ...
   ```
3. Display the **Numeric Pairing Key** (e.g., `4829-1092-8472-9102`).
4. Wait for the mobile application to claim the server.
5. Securely store the server credential in `/etc/friday/connector.json` with strict `0600` permissions.
6. Enable and start the background systemd service:
   ```bash
   sudo systemctl status friday-connector
   ```

---

## 2. Android Mobile App Setup

### Step 2.1: Install the APK

1. Locate the built APK in the repository:
   ```
   android/app/build/outputs/apk/debug/app-debug.apk
   ```
2. Transfer and install it onto your Android device (or emulator with Android 8.0+ / API 26+).
3. If building from source:
   ```bash
   cd android
   ./gradlew assembleDebug
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```

---

### Step 2.2: Sign In or Create Account

1. Launch **FRIDAY One**.
2. On the authentication screen, select either:
   - **Continue with Google**: Secure OAuth 2.0 PKCE flow.
   - **Email & Password**: Switch between **Sign In** and **Create Account**.

---

### Step 2.3: Pair Your Server

Once logged in, navigate to the **Pairing Dashboard**:

1. **Copy Pairing Token**: The app automatically displays your active 10-minute pairing token with a copy button and live countdown timer.
2. **Execute on Server**: In your VPS terminal, type `fridayone` and paste the token when prompted.
3. Choose one of the two pairing methods on your phone:
   - **Option A — Scan Terminal QR Code:**
     - Tap **Scan Terminal QR Code**.
     - Point your phone camera at the terminal screen displaying the ASCII QR code.
     - The camera will automatically detect the `fridayone://pair` payload and claim the server.
   - **Option B — Pair with Key:**
     - Tap **Pair with Key**.
     - Enter the 16–20 digit numeric pairing key shown in the terminal.
     - Tap **Pair Server**.
4. The app will confirm pairing, and your server will appear under the **Connected Servers** dashboard with a live status indicator (🟢 **ONLINE**).

---

## 3. Server Management & Realtime Agent Chat

### Live Server Dashboard
- View server health, status, and agent telemetry at a glance.
- Monitor active connections, last seen timestamps, and assigned agent runtimes (OpenCode / Hermes).

### Realtime AI Agent Chat
1. Tap **Open Chat** on any online server card.
2. Type natural language commands or instructions (e.g., `"Inspect nginx error logs and report recent 500 errors"` or `"Run test suite and check code coverage"`).
3. The prompt is dispatched over secure WSS directly to the server's local agent runner.
4. Output streams back with live token deltas.

### Permission Approvals & Human-in-the-Loop
- When an agent attempts an action flagged by policy (such as modifying critical system configs or running elevated scripts), execution is paused.
- An **Interactive Approval Card** appears in the chat stream:
  - Displays the requested operation, arguments, and timestamp.
  - Choose **Approve** to authorize the action or **Deny** to reject it.
- You can stop any running job immediately by tapping the **Cancel** button (`command.cancel`).

---

## 4. Useful Server CLI Commands

| Command | Description |
|---|---|
| `fridayone` | Start interactive pairing workflow |
| `fridayone status` | Check connector status and agent health |
| `fridayone upgrade` | Upgrade connector to the latest signed release |
| `sudo systemctl status friday-connector` | Inspect the background service status |
| `sudo journalctl -u friday-connector -f` | Tail live connector and agent logs |
| `sudo systemctl restart friday-connector` | Restart the connector service |

---

## 5. Development & Contribution

### Prerequisites
- Node.js >= 18 & npm
- JDK 17 & Android SDK (API 34)
- Supabase account with configured project schema

### Local Typechecking
```bash
# Typecheck control plane
cd control-plane && npm run typecheck

# Typecheck gateway
cd ../gateway && npm run typecheck

# Typecheck connector
cd ../connector && npm run typecheck
```

### Building Android Release APK
```bash
cd android
./gradlew assembleRelease
```
