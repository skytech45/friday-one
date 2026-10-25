/** Small shared helpers for the control-plane functions. */

export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function json(res: import("@vercel/node").VercelResponse, status: number, body: unknown): void {
  res.status(status).setHeader("content-type", "application/json").end(JSON.stringify(body));
}

/** Terse errors only: never echo internals (F-36-style discipline). */
export function fail(res: import("@vercel/node").VercelResponse, status: number, error: string): void {
  json(res, status, { error });
}
