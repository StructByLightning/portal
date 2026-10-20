/**
 * Per-IP rate limit for the OAuth callback. Each client address has a token
 * bucket of `perMinute` (default 20) that refills evenly over a minute; a
 * callback takes one token, and one that finds none is refused. Per address,
 * never global, so one noisy address can't lock every admin out.
 *
 * Refusals are reported at most once a minute per address: the first refusal
 * after a quiet minute is reported at once, the ones after it are counted and
 * reported together by the next report — the next refusal a minute later, or
 * sweep() once that minute has passed.
 */
import type { IncomingMessage } from 'node:http';

const MINUTE = 60_000;

interface Bucket {
  tokens: number;
  /** When `tokens` was last brought up to date. */
  at: number;
  /** Refusals not yet reported. */
  unreported: number;
  /** When a refusal was last reported, if ever. */
  reportedAt?: number;
}

export type TakeResult = { ok: true } | { ok: false; report?: { count: number } };

export class LoginRateLimit {
  private buckets = new Map<string, Bucket>();
  private readonly perMinute: number;
  private readonly maxAddresses: number;
  private readonly now: () => number;

  constructor(opts: { perMinute?: number; maxAddresses?: number; now?: () => number } = {}) {
    this.perMinute = opts.perMinute ?? 20;
    this.maxAddresses = opts.maxAddresses ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Take a token for `ip`. A refusal carries `report` when it is the one to
   *  write down now: `count` refusals, this one included. */
  take(ip: string): TakeResult {
    const t = this.now();
    let b = this.buckets.get(ip);
    if (!b) {
      this.makeRoom();
      b = { tokens: this.perMinute, at: t, unreported: 0 };
      this.buckets.set(ip, b);
    }
    this.refill(b, t);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    b.unreported += 1;
    if (b.reportedAt === undefined || t - b.reportedAt >= MINUTE) {
      const count = b.unreported;
      b.unreported = 0;
      b.reportedAt = t;
      return { ok: false, report: { count } };
    }
    return { ok: false };
  }

  /** Reports still owed (refusals counted after the last report, once its
   *  minute has passed), and forget addresses that are quiet again. */
  sweep(): Array<{ ip: string; count: number }> {
    const t = this.now();
    const out: Array<{ ip: string; count: number }> = [];
    for (const [ip, b] of this.buckets) {
      this.refill(b, t);
      const minuteOver = b.reportedAt === undefined || t - b.reportedAt >= MINUTE;
      if (b.unreported > 0 && minuteOver) {
        out.push({ ip, count: b.unreported });
        b.unreported = 0;
        b.reportedAt = t;
        continue;
      }
      if (b.unreported === 0 && minuteOver && b.tokens >= this.perMinute) this.buckets.delete(ip);
    }
    return out;
  }

  private refill(b: Bucket, t: number): void {
    if (t > b.at) b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.at) * this.perMinute) / MINUTE);
    b.at = t;
  }

  /** Keep the table bounded: quiet addresses go first, then the oldest. */
  private makeRoom(): void {
    if (this.buckets.size < this.maxAddresses) return;
    this.sweep();
    for (const k of this.buckets.keys()) {
      if (this.buckets.size < this.maxAddresses) break;
      this.buckets.delete(k);
    }
  }
}

/**
 * The client's address. The admin API binds 127.0.0.1 behind Caddy, which
 * puts the address it saw last in X-Forwarded-For, so when the peer is
 * loopback the rightmost entry is the client. Otherwise (no proxy) it is the
 * peer itself. Bounded, so it can be a map key and an audit field.
 */
export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? '';
  if (isLoopback(peer)) {
    const h = req.headers['x-forwarded-for'];
    const raw = Array.isArray(h) ? h.join(',') : h;
    const last = raw?.split(',').pop()?.trim();
    if (last) return last.slice(0, 64);
  }
  return peer.slice(0, 64) || 'unknown';
}

function isLoopback(addr: string): boolean {
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}
