/**
 * GET /api/v1/health — liveness + runtime config (consolidated to stay under
 * the Vercel Hobby 12-function cap; config is public non-secret data).
 *
 * `gateway_url` is the CURRENT gateway WSS endpoint, published into
 * app_config by the gateway tunnel service whenever the quick tunnel
 * rotates. Clients fetch this at startup — no APK rebuild on churn.
 * null means the gateway tunnel has not published yet.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { rest } from "../../lib/supabase.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  let gatewayUrl: string | null = null;
  try {
    const rows = await rest<{ value: string }>("GET", "app_config", {
      query: { key: "eq.gateway_url", select: "value" },
    });
    gatewayUrl = rows[0]?.value ?? null;
  } catch {
    gatewayUrl = null; // config is best-effort; health stays 200
  }
  res.status(200).setHeader("content-type", "application/json")
    .end(JSON.stringify({ ok: true, service: "friday-one-control-plane", gateway_url: gatewayUrl }));
}
