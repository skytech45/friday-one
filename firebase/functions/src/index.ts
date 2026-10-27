/**
 * Cloud Functions entry point: one 2nd-gen HTTPS function, `api`, serving
 * /api/v1/* (migration plan §2.3). Clients use the function URL as their
 * base, e.g. https://asia-south1-<project>.cloudfunctions.net/api
 */
import { onRequest } from "firebase-functions/v2/https";
import { handle } from "./app.js";

export const api = onRequest(
  {
    region: "asia-south1", // decision D4
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 10,
    concurrency: 40,
    cors: false, // native app + connector only; no browser callers
  },
  async (req, res) => {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : v;
    const query: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.query)) query[k] = typeof v === "string" ? v : undefined;

    const out = await handle({
      method: req.method,
      path: req.path.replace(/^\/api(?=\/api\/v1)/, ""), // tolerate a /api function-name prefix
      query,
      headers,
      body: req.body,
    });
    for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
    res.status(out.status).json(out.body);
  },
);
