/**
 * Transport-neutral request/response types. The router works on these so
 * it can be tested in-process; `index.ts` adapts Cloud Functions' Express
 * request/response to them.
 */
export interface ApiRequest {
  method: string;
  /** Path starting with /api/v1 (any function-name prefix already stripped). */
  path: string;
  query: Record<string, string | undefined>;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export const json = (status: number, body: unknown): ApiResponse => ({ status, body });

/** Uniform error envelope, unchanged from the Vercel API: `{ error: code }`. */
export const fail = (status: number, error: string, headers?: Record<string, string>): ApiResponse => ({
  status,
  body: { error },
  ...(headers ? { headers } : {}),
});

/** Field accessor for an untrusted JSON body. */
export function field(body: unknown, name: string): unknown {
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
}
