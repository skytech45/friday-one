# FRIDAY One — Troubleshooting

Start with `fridayone doctor`. It checks everything below and never prints
credentials. `fridayone logs` shows the service journal with secrets redacted.

| Symptom | Likely cause | What to do |
|---|---|---|
| **"invalid or expired" / "pairing failed"** during setup | the enrollment token is single-use and valid for 30 min; the pairing code for 10 min | generate a new pairing session in the app and run `sudo fridayone setup` again |
| **"does not look like an enrollment token"** | partial copy, or extra characters | copy the token again from the app |
| **App can't read the QR** | terminal font or size distorts it | enlarge the terminal, or use *Pair with Key* and type the numeric code |
| **App: sign-in fails** | Google sign-in isn't configured for this build (Firebase debug app or SHA fingerprints missing) | see `docs/FIREBASE_SETUP.md` on the `firebase/migration-phase-0` branch; the app shows "Sign-in is not configured" when its config is missing |
| **"this command changes system files"** | `setup`, `reconnect`, `update` and `uninstall` need root | prefix with `sudo` |
| **doctor: control plane unreachable or TLS invalid** | DNS, firewall egress, proxy, or an intercepted certificate | `curl -v https://<control-plane>/api/v1/health`; allow outbound 443; don't disable TLS checks |
| **setup: invalid gateway URL** with the suggested default | the hosted control plane advertises `https://…` for the gateway | type the same address with `wss://` |
| **doctor: gateway unreachable** | wrong gateway URL or no egress | re-run setup to take the URL from the control plane's `/health` |
| **status: "REFUSED" / revoked** | the server was revoked, or its credential expired after a rotation grace period | `sudo fridayone setup` to pair again |
| **status: disconnected, logs show `reconnect in …ms`** | gateway temporarily unavailable; backoff up to 60 s with jitter | wait; if it persists, run `fridayone doctor`. Connectors **before this fix** never reconnected (audit A-2): upgrade |
| **Service failed, `fridayone logs` shows `Dynamic require of "fs"`** | connector from release `v0.6.0`/`v0.9.0` (audit A-1) | upgrade to a release built from the fixed installer |
| **Service stops right after start (exit 78)** | not paired, or the credential file is missing or has the wrong permissions | `sudo fridayone setup`; don't edit `/etc/friday-connector/credential` by hand |
| **systemd: "start request repeated too quickly"** | 5 failures in 10 min (start limit, by design) | fix the cause from `fridayone logs`, then `sudo systemctl reset-failed friday-connector && sudo fridayone reconnect` |
| **doctor: no agent found** | OpenCode/Hermes not installed for the `friday-connector` account | install it so that account can run it (home `/var/lib/friday-connector`) |
| **Agent errors mention quota / 429** | the model provider is out of quota | not a connector fault: fix the provider account; the connector stays connected |
| **App: `policy_deny`** | a policy denies the action, or none allows it (sensitive actions deny by default) | add an allow rule in the app's Security screen if intended |
| **App: `root_not_allowed`** | the project path isn't one of the roots you allowed | re-run setup and add the directory |
| **Installer: "CHECKSUM MISMATCH"** | tampered or truncated download, or wrong version | do **not** bypass; download again from the releases page; report it if it persists |
| **Installer: "untested OS" / "unsupported architecture"** | not Ubuntu 22.04/24.04, Debian 12, or not x86_64/aarch64 | use a supported VPS (`FRIDAY_ALLOW_UNTESTED_OS=1` exists for experiments, unsupported) |
| **Installer: "Node.js >= 20 is required"** | Node missing or too old | install Node.js 20+ from nodejs.org or your distribution, then re-run |

Still stuck? Open an issue with the *Installation problem* template and
paste `fridayone doctor` output. It contains no secrets, but check it first.
