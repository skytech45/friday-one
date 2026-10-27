/**
 * Firestore/Auth handles and small shared helpers.
 *
 * SECURITY: the Admin SDK bypasses Firestore Security Rules. Every function
 * that uses `db` must scope reads and writes by an identity it has already
 * verified (a Firebase ID token or a connector credential hash), never by
 * an ID taken from the request body.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";

if (getApps().length === 0) initializeApp();

export const db = getFirestore();
export const auth = getAuth();
export { FieldValue, Timestamp };

export const COL = {
  users: "users",
  servers: "servers",
  agents: "agents",
  projects: "projects",
  jobs: "jobs",
  credentials: "connectorCredentials",
  enrollments: "enrollments",
  enrollmentTokens: "enrollmentTokens",
  policies: "policies",
  audit: "auditEvents",
  rateLimits: "rateLimits",
  appConfig: "appConfig",
} as const;

export const sha256hex = (v: string): string => createHash("sha256").update(v).digest("hex");

/** Constant-time comparison of two hex digests. */
export function hashEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const inMs = (ms: number): Timestamp => Timestamp.fromMillis(Date.now() + ms);
export const inDays = (d: number): Timestamp => inMs(d * 86_400_000);

/** Firestore Timestamp (or absent) → ISO string or null, for API responses. */
export function iso(v: unknown): string | null {
  return v instanceof Timestamp ? v.toDate().toISOString() : null;
}

export function millis(v: unknown): number | null {
  return v instanceof Timestamp ? v.toMillis() : null;
}
