/**
 * Background credential-rotation checks (plan §8).
 *
 * The connector learns that the owner requested a rotation from the
 * `rotation_due` flag on `/policies/sync`. That check used to run every
 * 60 s, which made the sync about 97% of all Firestore reads
 * (docs/COST_AND_QUOTAS.md §2). It now runs every 15 min by default.
 *
 * This does NOT weaken enforcement: the policy gate still fetches the
 * effective rules immediately before EVERY execution (index.ts,
 * handleDispatch, fail closed), and revocation reaches the live socket from
 * the gateway. Only how quickly an owner-requested rotation starts changes.
 */
export const DEFAULT_ROTATION_CHECK_MS = 15 * 60_000;
/** Never faster than the old cadence; a value given in seconds by mistake falls back. */
export const MIN_ROTATION_CHECK_MS = 60_000;
export const MAX_ROTATION_CHECK_MS = 60 * 60_000;
/** `FRIDAY_ROTATION_CHECK_MS` if valid and in range, else the default. */
export function rotationCheckIntervalMs(env = process.env, warn = console.warn) {
    const raw = env.FRIDAY_ROTATION_CHECK_MS?.trim();
    if (!raw)
        return DEFAULT_ROTATION_CHECK_MS;
    const ms = /^\d+$/.test(raw) ? Number(raw) : Number.NaN; // plain milliseconds only
    if (!Number.isInteger(ms) || ms < MIN_ROTATION_CHECK_MS || ms > MAX_ROTATION_CHECK_MS) {
        warn(`[config] FRIDAY_ROTATION_CHECK_MS=${raw} outside ${MIN_ROTATION_CHECK_MS}..${MAX_ROTATION_CHECK_MS} ms: ` +
            `using ${DEFAULT_ROTATION_CHECK_MS}`);
        return DEFAULT_ROTATION_CHECK_MS;
    }
    return ms;
}
/**
 * Runs `check` once now (so a pending rotation starts at boot), then every
 * `intervalMs`. A failing check is logged; it never becomes an unhandled
 * rejection, which would terminate the connector.
 */
export function startRotationChecks(check, intervalMs, every = setInterval, log = console.error) {
    const run = () => {
        check().catch((e) => log(`rotation check failed: ${e instanceof Error ? e.message : String(e)}`));
    };
    run();
    return every(run, intervalMs);
}
