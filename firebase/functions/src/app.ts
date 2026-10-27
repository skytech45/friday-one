/**
 * /api/v1 router. Paths, methods, status codes and response bodies match
 * the Vercel control plane, so the Android app and the connector only change
 * their base URL. Deliberate differences are listed in
 * docs/FIREBASE_MIGRATION_PLAN.md §8 (F-M2 POST poll, F-M3 expiry, F-M9
 * jobs ownership, F-M10 credential binding, 503 on limiter outage).
 */
import { logger } from "firebase-functions";
import { COL, db } from "./db.js";
import { fail, field, json, type ApiRequest, type ApiResponse } from "./http.js";
import { verifyConnector, verifyUser, type AuthUser } from "./auth.js";
import { clientIp, consumeLimit, limitResponse } from "./ratelimit.js";
import { claimEnrollment, createEnrollment, openEnrollmentSession, pickupCredential, revokeServer } from "./enrollments.js";
import { ensureProfile, listJobs, listServers, ownsServer, requestRotation } from "./servers.js";
import { changePolicy, createPolicy, listPolicies, validatePolicyInput, type PolicyPatch } from "./policies.js";
import { policySync, rotateCredential } from "./connector.js";
import { listAudit } from "./audit.js";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

type Handler = (req: ApiRequest, params: string[]) => Promise<ApiResponse>;

function pageSize(req: ApiRequest): number {
  const n = Number(req.query.limit);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_PAGE) : DEFAULT_PAGE;
}

/** Wraps a handler that needs a signed-in user. */
function withUser(fn: (req: ApiRequest, user: AuthUser, params: string[]) => Promise<ApiResponse>, checkRevoked = false): Handler {
  return async (req, params) => {
    const user = await verifyUser(req, { checkRevoked });
    if (!user) return fail(401, "unauthorized");
    return fn(req, user, params);
  };
}

// ---- connector enrollment session --------------------------------------
async function sessionOpen(req: ApiRequest): Promise<ApiResponse> {
  const limit = await consumeLimit("sessionOpen", clientIp(req));
  if (!limit.ok) return limitResponse(limit);
  const token = field(req.body, "token");
  if (typeof token !== "string" || !token) return fail(400, "invalid_request");
  const sess = await openEnrollmentSession(token);
  if (!sess) return fail(403, "invalid_or_expired_token");
  return json(200, {
    enrollment_id: sess.enrollmentId,
    server_id: sess.serverId,
    display_code: sess.displayCode,
    display_code_expires_at: sess.displayCodeExpiresAt,
  });
}

/** Poll for the credential. POST (token in body) is preferred; GET ?token= stays for connector 0.1.x (F-M2). */
async function sessionPoll(req: ApiRequest, token: unknown): Promise<ApiResponse> {
  const limit = await consumeLimit("sessionPoll", clientIp(req));
  if (!limit.ok) return limitResponse(limit);
  if (typeof token !== "string" || !token) return fail(400, "invalid_request");
  const pickup = await pickupCredential(token);
  if (pickup) {
    return json(200, {
      state: "paired",
      server_id: pickup.serverId,
      enrollment_id: pickup.enrollmentId,
      credential: pickup.credential,
    });
  }
  return json(200, { state: "pending" }); // not claimed yet, or already picked up
}

// ---- app routes -----------------------------------------------------------
const createEnrollmentRoute: Handler = async (req, params) => {
  const limit = await consumeLimit("enrollCreate", clientIp(req));
  if (!limit.ok) return limitResponse(limit);
  return withUser(async (r, user) => {
    const raw = field(r.body, "name");
    const name = typeof raw === "string" ? raw.trim().slice(0, 120) : "";
    if (!name) return fail(400, "invalid_request");
    await ensureProfile(user);
    const out = await createEnrollment(user.uid, name);
    return json(201, {
      enrollment_id: out.enrollmentId,
      server_id: out.serverId,
      enrollment_token: out.enrollmentToken,
      expires_at: out.expiresAt,
    });
  }, true)(req, params);
};

const claimRoute: Handler = async (req, params) => {
  const ip = clientIp(req);
  const pre = await consumeLimit("claim", ip);
  if (!pre.ok) return limitResponse(pre);
  return withUser(async (r, user, [id]) => {
    const raw = field(r.body, "code");
    const code = typeof raw === "string" ? raw.trim() : "";
    if (!id || !/^\d{16,20}$/.test(code)) return fail(400, "invalid_request");
    const result = await claimEnrollment(id, user.uid, code);
    if (!result.ok) {
      // Failed claims cost 5x, so bulk guessing across enrollments stops fast.
      const failLimit = await consumeLimit("claimFail", ip, 5);
      if (!failLimit.ok) return limitResponse(failLimit);
      return fail(result.reason === "not_found" ? 404 : 403, result.reason);
    }
    return json(200, { state: "claim_requested", server_id: result.serverId });
  }, true)(req, params);
};

const serverAction: Handler = async (req, params) => {
  const limit = await consumeLimit("revoke", clientIp(req));
  if (!limit.ok) return limitResponse(limit);
  return withUser(async (_r, user, [id, action]) => {
    if (!id) return fail(400, "invalid_request");
    if (action === "revoke") {
      return (await revokeServer(id, user.uid)) ? json(200, { state: "revoked" }) : fail(404, "not_found_or_not_active");
    }
    if (action === "rotate") {
      return (await requestRotation(id, user.uid)) ? json(200, { rotation_requested: true }) : fail(404, "not_found_or_not_active");
    }
    return fail(404, "unknown_action");
  }, true)(req, params);
};

const policiesCreate = withUser(async (req, user) => {
  const parsed = validatePolicyInput(req.body);
  if (!parsed.ok) return fail(400, parsed.why);
  if (parsed.v.serverId !== null && !(await ownsServer(parsed.v.serverId, user.uid))) {
    return fail(403, "not_your_server");
  }
  return json(201, { policy: await createPolicy(user.uid, parsed.v) });
}, true);

const policyChange = withUser(async (req, user, [id]) => {
  if (!id) return fail(400, "invalid_request");
  let change: PolicyPatch | "delete";
  if (req.method === "DELETE") {
    change = "delete";
  } else {
    const patch: PolicyPatch = {};
    const enabled = field(req.body, "enabled");
    const decision = field(req.body, "decision");
    if (typeof enabled === "boolean") patch.enabled = enabled;
    if (decision === "allow" || decision === "deny" || decision === "require_approval") patch.decision = decision;
    if (Object.keys(patch).length === 0) return fail(400, "nothing_to_update");
    change = patch;
  }
  return (await changePolicy(user.uid, id, change)) ? json(200, { ok: true }) : fail(404, "not_found");
}, true);

// ---- connector-credential routes -----------------------------------------
async function syncRoute(req: ApiRequest): Promise<ApiResponse> {
  if (!req.headers["x-connector-credential"]) return fail(401, "unauthenticated");
  const cred = await verifyConnector(req);
  if (!cred) return fail(403, "credential_revoked");
  const out = await policySync(cred);
  return out ? json(200, out) : fail(403, "server_not_active");
}

async function rotateRoute(req: ApiRequest, action: string | undefined): Promise<ApiResponse> {
  if (action !== "rotate-credential") return fail(404, "unknown_action");
  if (!req.headers["x-connector-credential"]) return fail(401, "unauthenticated");
  const newHash = field(req.body, "new_credential_hash");
  if (typeof newHash !== "string" || !/^[a-f0-9]{64}$/.test(newHash)) return fail(400, "invalid_hash");
  const cred = await verifyConnector(req);
  if (!cred) return fail(403, "credential_invalid");
  const out = await rotateCredential(cred, newHash);
  return out.ok ? json(200, { rotated: true, grace_seconds: out.graceSeconds }) : fail(out.status, out.error);
}

async function health(): Promise<ApiResponse> {
  let gatewayUrl: string | null = null;
  try {
    const v = (await db.collection(COL.appConfig).doc("gateway_url").get()).get("value");
    gatewayUrl = typeof v === "string" ? v : null;
  } catch {
    gatewayUrl = null; // config is best-effort; health stays 200
  }
  return json(200, { ok: true, service: "friday-one-control-plane", gateway_url: gatewayUrl });
}

// ---- routing table ----------------------------------------------------------
const ID = "([A-Za-z0-9_-]{1,128})";
const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  { method: "GET", pattern: /^\/api\/v1\/health$/, handler: health },
  { method: "GET", pattern: /^\/api\/v1\/servers$/, handler: withUser(async (_r, user) => {
    await ensureProfile(user);
    return json(200, { servers: await listServers(user.uid) });
  }) },
  { method: "POST", pattern: new RegExp(`^/api/v1/servers/${ID}/(revoke|rotate)$`), handler: serverAction },
  { method: "POST", pattern: /^\/api\/v1\/enrollments$/, handler: createEnrollmentRoute },
  { method: "POST", pattern: /^\/api\/v1\/enrollments\/session$/, handler: (req) => sessionOpen(req) },
  { method: "POST", pattern: /^\/api\/v1\/enrollments\/session\/poll$/, handler: (req) => sessionPoll(req, field(req.body, "token")) },
  { method: "GET", pattern: /^\/api\/v1\/enrollments\/session$/, handler: (req) => sessionPoll(req, req.query.token) },
  { method: "POST", pattern: new RegExp(`^/api/v1/enrollments/${ID}/claim$`), handler: claimRoute },
  { method: "GET", pattern: /^\/api\/v1\/policies$/, handler: withUser(async (_r, user) => json(200, { policies: await listPolicies(user.uid) })) },
  { method: "POST", pattern: /^\/api\/v1\/policies$/, handler: policiesCreate },
  { method: "GET", pattern: /^\/api\/v1\/policies\/sync$/, handler: (req) => syncRoute(req) },
  { method: "PATCH", pattern: new RegExp(`^/api/v1/policies/${ID}$`), handler: policyChange },
  { method: "DELETE", pattern: new RegExp(`^/api/v1/policies/${ID}$`), handler: policyChange },
  { method: "POST", pattern: /^\/api\/v1\/connector\/([a-z-]{1,40})$/, handler: (req, [a]) => rotateRoute(req, a) },
  { method: "GET", pattern: /^\/api\/v1\/jobs$/, handler: withUser(async (req, user) => {
    const serverId = req.query.server_id;
    const jobs = await listJobs(user.uid, serverId, pageSize(req));
    return jobs === null ? fail(404, "not_found") : json(200, { jobs });
  }) },
  { method: "GET", pattern: /^\/api\/v1\/audit$/, handler: withUser(async (req, user) => json(200, { events: await listAudit(user.uid, pageSize(req)) })) },
];

/** Entry point: route, run, and turn unexpected errors into a sanitized 500. */
export async function handle(req: ApiRequest): Promise<ApiResponse> {
  const started = Date.now();
  const length = Number(req.headers["content-length"] ?? 0);
  if (length > MAX_BODY_BYTES) return fail(413, "payload_too_large");

  const candidates = routes.filter((r) => r.pattern.test(req.path));
  if (candidates.length === 0) return fail(404, "not_found");
  const route = candidates.find((r) => r.method === req.method);
  if (!route) return fail(405, "method_not_allowed");

  let res: ApiResponse;
  try {
    const params = (route.pattern.exec(req.path) ?? []).slice(1);
    res = await route.handler(req, params);
  } catch (e) {
    // Never log request bodies, headers or tokens; the error name is enough.
    logger.error("api_error", { route: route.pattern.source, method: req.method, error: (e as Error).name });
    res = fail(500, "internal_error");
  }
  logger.info("api", { route: route.pattern.source, method: req.method, status: res.status, ms: Date.now() - started });
  return res;
}
