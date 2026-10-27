/**
 * GET /api/v1/jobs?server_id= — the owner's recent command jobs.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAccessToken } from "../../lib/auth.js";
import { listJobs } from "../../lib/policies.js";
import { json, fail } from "../../lib/util.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") return fail(res, 405, "method_not_allowed");
  const user = await verifyAccessToken(req.headers.authorization);
  if (!user) return fail(res, 401, "unauthorized");
  const serverId = typeof req.query?.server_id === "string" ? req.query.server_id : undefined;
  try {
    const jobs = await listJobs(user.id, serverId);
    if (jobs === null) return fail(res, 404, "not_found");
    json(res, 200, { jobs });
  } catch {
    fail(res, 500, "list_failed");
  }
}
