# FRIDAY One — Cost and Quotas (Firebase stack)

**Read this first.** Usage volumes below are derived from the code (exact
intervals and query shapes). **Prices and free-tier allowances are not
quoted as facts**: they change, and must be checked on the official pricing
pages (Firestore, Cloud Functions, Cloud Run, Cloud Logging) and the GCP
pricing calculator for `asia-south1` before production settings are
chosen. Free-tier eligibility is not a guarantee that production stays free.
The Blaze plan is required (decision D5).

## 1. What drives usage (per active, connected server)

| Source | Frequency (from code) | Firestore | Functions | Cloud Run |
|---|---|---|---|---|
| Connector rotation check (every 60 s in connector ≤ 0.1.x; **every 15 min** after the §2 change: 96/day) | 1,440 /day (old) | reads: credential 1 + server 1 + policy query max(1, P) | 1,440 invocations/day | — |
| Pre-execution policy sync | 1 per prompt | same as above | 1 per prompt | — |
| Connector heartbeat (every 15 s) | 5,760 msgs/day | `lastSeenAt` write ≤ 1/min → **1,440 writes/day** | — | socket traffic |
| Gateway revocation listeners | 2 per connected connector | ~2 reads per (re)connect + 1 per change; reconnects ≥ every 60 min (Cloud Run) → ~48 reads/day | — | — |
| Prompt (job) | per prompt | ~1 create + 4–6 transactional updates, each reading the job | — | streaming over WSS (no Firestore) |
| App opens server list (`/servers`) | per open/refresh | S servers + 2 subcollection queries per server (≥ 1 read each) | 1 | — |
| App gateway heartbeat (every 15 s) | while chat is open | none | — | socket traffic |

**Worked example (old 60 s cadence):** one server, P = 5 policies, 20
prompts/day, app opened 10×/day:

| Metric | Per day | Per month (30 d) |
|---|---|---|
| Firestore reads | sync 1,440 × 7 ≈ 10,080 + prompts ~200 + app ~60 + listeners ~50 ≈ **10,400** | ≈ 312,000 |
| Firestore writes | heartbeat 1,440 + prompts ~120 + audit ~10 ≈ **1,570** | ≈ 47,000 |
| Function invocations | 1,440 + 20 + 10 ≈ **1,470** | ≈ 44,000 |

So **the per-minute policy sync dominates reads**: about 97% of them.

## 2. Rotation check slowed to 15 min (done, connector after 2026-10-27)

The connector's two uses of `/policies/sync` are now split
(`connector/src/rotation.ts`):

- the **pre-execution** fetch is unchanged: before every command, fail
  closed (CI test `dispatch.test.ts`);
- the background **rotation check** runs every **15 min** instead of 60 s
  (`FRIDAY_ROTATION_CHECK_MS`, 1–60 min).

Same worked example after the change:

| Metric | Per day | Per month |
|---|---|---|
| Firestore reads | rotation 96 × 7 ≈ 670 + pre-execution 20 × 7 = 140 + prompts ~200 + app ~60 + listeners ~50 ≈ **1,120** | ≈ 34,000 |
| Function invocations | 96 + 20 + 10 ≈ **126** | ≈ 3,800 |

That is about 9× fewer reads and 12× fewer invocations per server. Trade-off:
an owner-requested rotation starts within 15 min instead of 1 min.
Revocation is unaffected (the gateway closes the live socket and the API
refuses the credential immediately). **Connectors only get this after they
upgrade**; older ones keep the 60 s cadence.

## 3. Fixed cost: the gateway on Cloud Run

`min-instances=1`, `max-instances=1`, CPU always allocated (needed for
heartbeats, the idle sweep and revocation listeners), 24×7 ≈ 2.59 M
instance-seconds/month.

`monthly ≈ vCPU × 2.59M × price(vCPU-s) + GiB × 2.59M × price(GiB-s)`
(always-allocated pricing tier), plus network egress for streamed output.

Pick the smallest CPU and memory Cloud Run allows with that concurrency, and
confirm with a load test (1 instance, target concurrent sockets = connectors
+ open app chats). This is the **only cost that does not scale to zero**.
Price it before deploying.

## 4. Other services

| Service | Usage | Note |
|---|---|---|
| Firebase Auth (Google provider) | sign-ins + token refreshes | check whether the plan's monthly-active-user allowance covers expected users |
| Cloud Functions (`api`) | ≈ 1,470 invocations/day/server; 256 MiB, ≤ 30 s, usually < 1 s | plus Cloud Build minutes and Artifact Registry storage per deploy |
| Cloud Logging | one structured line per API call + gateway logs | set a retention period; exclude debug logs |
| Secret Manager | **none used**: no backend secret exists (runtime identities only) | — |
| Firestore storage | KB per server; audit ≤ 365 d, jobs ≤ 90 d (TTL) | negligible at this scale |

## 5. Limits that matter

| Limit | Where it bites | Mitigation |
|---|---|---|
| Gateway = 1 instance | concurrent sockets per instance (`--concurrency`, max 1000) | capacity test; multi-instance needs a shared routing bus (out of scope) |
| Cloud Run request timeout ≤ 60 min | every WebSocket | clients reconnect with backoff (tested) |
| Firestore sustained writes per document (~1/s) | `rateLimits/{bucket}` under attack; `servers/{id}` is ≤ 1/min | per-IP buckets spread load; limiter fails closed (503) |
| `api` `maxInstances: 10` | burst of app/connector calls | raise after measuring; it also caps cost |
| Firestore `in` query ≤ 30 values | `serverScope in [id, "all"]` uses 2 | — |

## 6. Budget and monitoring (set up before production)

- **Billing budget** on each project with alerts at 50%, 90% and 100%
  (email + Pub/Sub). Budgets alert; they do not cap spend.
- **Alerts:** `api` 5xx rate > 1% for 5 min; gateway container restarts;
  Firestore reads/day above 2× the expected value from §1 (unexpected usage);
  log-based metric on `connector deauthorized` spikes; `rate_limited` spikes
  (pairing abuse).
- **Weekly check** for the first month: reads, writes and invocations against §1.
