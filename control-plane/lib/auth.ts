/**
 * Supabase access-token verification via JWKS (asymmetric — no shared secret
 * in the control plane at all). SUPABASE_JWKS_URL serves ES256 public keys;
 * tokens are verified for signature + issuer + expiry here, and identity is
 * ALWAYS derived from the verified payload (never from request bodies).
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "./env.js";

const JWKS = createRemoteJWKSet(new URL(env.supabaseJwksUrl));

export interface AuthUser {
  id: string;
  email: string | null;
}

export async function verifyAccessToken(bearer: string | undefined): Promise<AuthUser | null> {
  if (!bearer) return null;
  const token = bearer.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `${env.supabaseUrl}/auth/v1`,
    });
    if (typeof payload.sub !== "string" || payload.sub.length < 1) return null;
    const email = typeof payload.email === "string" ? payload.email : null;
    return { id: payload.sub, email };
  } catch {
    return null;
  }
}
