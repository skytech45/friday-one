/**
 * Replay protection (P0 fix; plan/protocol §2 rules 2 + 4).
 *
 * Two layers, both bound to the AUTHENTICATED identity:
 *
 * 1. message_id dedup — a bounded LRU set per identity. A duplicate envelope
 *    is dropped silently (the protocol defines duplicates as idempotent
 *    no-ops; command execution itself is additionally idempotent via
 *    command_jobs).
 *
 * 2. sequence monotonicity — per identity, initialized from the AUTH
 *    message's sequence, then strictly increasing. Stale/out-of-order
 *    sequence = protocol violation = close 4400. The baseline resets on a
 *    new authenticated connection, so a connector/app restart recovers; a
 *    REPLAYED old privileged message within a connection is rejected, and
 *    content-level idempotency (command_jobs unique key) covers replays that
 *    arrive on a fresh connection.
 *
 * State is in-memory and bounded: the gateway is a single-instance,
 * single-threaded Node process, so Map operations are race-free. If the
 * deployment grows to multiple instances, this state must move to the shared
 * store — documented in docs/REALTIME_PROTOCOL.md §2.
 */

const MAX_SEEN = 10_000; // per identity, bounded
const MAX_IDENTITIES = 5_000;

interface IdentityState {
  seen: Set<string>;
  seenOrder: string[]; // FIFO eviction index for `seen`
  lastSeq: number;
  lastActive: number;
}

export class ReplayGuard {
  private identities = new Map<string, IdentityState>();

  /** Call once per authenticated identity (on auth) to set the baseline. */
  initBaseline(identity: string, seq: number): void {
    let state = this.identities.get(identity);
    if (!state) {
      if (this.identities.size >= MAX_IDENTITIES) this.evictOldest();
      state = { seen: new Set(), seenOrder: [], lastSeq: seq, lastActive: Date.now() };
      this.identities.set(identity, state);
      return;
    }
    state.lastSeq = seq;
    state.lastActive = Date.now();
  }

  /**
   * Check an authenticated envelope. Returns "accept" | "duplicate" |
   * "stale". Duplicates should be dropped silently; stale is a protocol
   * violation (caller closes 4400).
   */
  check(identity: string, messageId: string, seq: number): "accept" | "duplicate" | "stale" {
    const state = this.identities.get(identity);
    if (!state) return "stale"; // check() before initBaseline is a bug upstream

    if (state.seen.has(messageId)) return "duplicate";
    if (seq <= state.lastSeq) return "stale";

    state.lastSeq = seq;
    state.lastActive = Date.now();
    state.seen.add(messageId);
    state.seenOrder.push(messageId);
    if (state.seenOrder.length > MAX_SEEN) {
      const evict = state.seenOrder.shift();
      if (evict) state.seen.delete(evict);
    }
    return "accept";
  }

  /** Drop state for a revoked/dead identity. */
  forget(identity: string): void {
    this.identities.delete(identity);
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of this.identities) {
      if (v.lastActive < oldest) { oldest = v.lastActive; oldestKey = k; }
    }
    if (oldestKey) this.identities.delete(oldestKey);
  }
}
