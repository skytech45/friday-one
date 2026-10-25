import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json, fail } from "../../lib/util.js";

/** Liveness for infrastructure checks. Carries zero information. */
export default async function health(_req: VercelRequest, res: VercelResponse): Promise<void> {
  json(res, 200, { ok: true, service: "friday-one-control-plane" });
}
