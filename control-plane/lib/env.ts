/**
 * Control-plane environment. Values come from Vercel env vars (set once via
 * `vercel env add`), never from the repo. The publishable key is NOT used
 * server-side; verification uses JWKS (asymmetric) and writes use the secret
 * key via PostgREST.
 */
import { required } from "./util.js";

export const env = {
  supabaseUrl: required("SUPABASE_URL").replace(/\/$/, ""),
  supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
  supabaseJwksUrl: required("SUPABASE_JWKS_URL"),
  /** Comma-separated allowlist; empty disables registration entirely (F-04 lesson). */
  allowedEmails: (process.env.ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
};
