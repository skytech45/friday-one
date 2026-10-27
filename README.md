# FRIDAY One

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Android](https://img.shields.io/badge/Platform-Android_8.0+-green.svg)](android/)
[![Architecture: Zero--Trust](https://img.shields.io/badge/Security-Zero--Trust_Outbound_WSS-orange.svg)](docs/plans/v2/SYSTEM_DESIGN.md)

**FRIDAY One** is a modern, zero-trust cloud server management and autonomous AI agent platform. It connects your Android mobile device directly to your Linux cloud servers and VPS infrastructure, providing real-time AI agent interactions (powered by OpenCode and Hermes ACP runtimes) with granular human-in-the-loop permission approvals.

---

## ⚡ Quick Start

For full installation and setup instructions, see the **[Complete Setup Guide](docs/SETUP_GUIDE.md)**.

### 1. Install the Connector on your Linux VPS
```bash
curl -fsSL https://friday-one-control-plane-cotts1-2550.vercel.app/install.sh | sudo bash
```

### 2. Pair your Cloud Server
On your server terminal, run:
```bash
fridayone
```
Follow the terminal prompt to enter your pairing token from the mobile app. A terminal ASCII QR code and numeric pairing key will appear.

### 3. Open the Android App
- Log in using **Google OAuth** or **Email/Password**.
- Go to the **Pairing Dashboard**.
- Scan the terminal QR code or enter the numeric pairing key.
- Your server is now connected and ready for AI agent automation!

---

## 🚀 Key Features

- **Apple Dark Minimalist Design**: Premium UI crafted with Jetpack Compose, featuring high-contrast metrics, card elevations, and fluid status indicators.
- **Two Pairing Modes**:
  - **Terminal QR Scanner**: Camera viewfinder powered by ZXing for instant terminal pairing.
  - **Pair with Key**: 16–20 digit one-time code entry for headless or remote terminal workflows.
- **Single-Command Server CLI (`fridayone`)**: Intuitive server-side onboarding and background systemd daemon management.
- **Autonomous AI Agent Execution**: Run OpenCode and Hermes agent workflows directly on your servers with live streaming deltas.
- **Human-in-the-Loop Security**: Interactive permission cards in the chat view allow you to approve or deny sensitive operations on the fly.
- **Zero Inbound Ports Required**: The server connector initiates outbound-only WSS connections through the gateway, working seamlessly behind firewalls and NAT.
- **Zero Secrets on Client**: Client devices never store server credentials, database passwords, or private keys.

---

## 📂 Repository Structure

```
├── android/            # Native Android application (Jetpack Compose, Kotlin)
│   └── app/            # Main module: app/ shell, feature/* screens, core/designsystem, data/ clients
├── connector/          # Cloud server daemon & CLI (`fridayone`, ACP agent adapters)
├── control-plane/      # Vercel serverless API (Pairing state machine, auth, Supabase RPC)
├── gateway/            # Realtime WSS hub (Port 8790, ReplayGuard, streaming deltas)
├── docs/               # System design, API protocols, and setup documentation
│   ├── SETUP_GUIDE.md  # Detailed step-by-step setup and pairing guide
│   ├── PRD.md          # Product requirements document
│   ├── ANDROID_SYSTEM_DESIGN.md # Android app architecture and security requirements
│   ├── UI_UX_GUIDE.md  # Design system and user interaction guidelines
│   └── plans/          # Platform system design (v2) and the Android alignment plan
└── scripts/            # Helper scripts and automation utilities
```

---

## 📖 Documentation

- [Setup & Pairing Guide](docs/SETUP_GUIDE.md)
- [Realtime Protocol v1](docs/REALTIME_PROTOCOL.md)
- [Backend Implementation Details](docs/BACKEND.md)
- [Google OAuth Setup](docs/GOOGLE_OAUTH_SETUP.md)
- [Product Requirements](docs/PRD.md)
- [Platform System Design (v2)](docs/plans/v2/SYSTEM_DESIGN.md)
- [Android System Design](docs/ANDROID_SYSTEM_DESIGN.md)
- [UI/UX Design Guide](docs/UI_UX_GUIDE.md)
- [Android Alignment Plan](docs/plans/android/ALIGNMENT_PLAN.md)

---

## 🔒 Security & Verification

FRIDAY One employs defense-in-depth principles:
- **Rate-limited Pairing**: Ephemeral 10-minute validity, 5-attempt brute-force budget with IP rate-limiting via Supabase RPC.
- **File System Permissions**: Secrets stored under `/etc/friday/connector.json` with strict `0600` permissions.
- **Process Isolation**: The connector daemon runs as a dedicated non-root user (`friday-connector`).
- **Cryptographic Replay Protection**: Gateway enforces sequence baseline and bounded LRU deduplication on message IDs.

---

## 📄 License

This project is licensed under the MIT License.
