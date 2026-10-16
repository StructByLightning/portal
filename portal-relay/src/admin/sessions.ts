/**
 * Server-side admin sessions (RFC-005 §5.2, §7). The cookie carries only an
 * opaque id; everything authoritative — identity, the derived admin-guild set,
 * super-admin flag, CSRF token — lives here, server-side. Short TTL so an admin
 * who loses Discord rights loses panel rights on the next login (admin rights are
 * re-derived from Discord at every login, never refreshed mid-session).
 *
 * Also holds short-lived OAuth `state` values for CSRF protection of the
 * login→callback round-trip. They live only in memory: a sign-in that spans a
 * relay restart comes back as `expired`, and the panel says to try again.
 */
import { randomBytes } from 'node:crypto';

export interface AdminSession {
  id: string;
  userId: string;
  userName: string;
  /** Guilds this admin may manage (super-admins may manage any — see isSuper). */
  adminGuilds: Set<string>;
  /** id → name for the admin's guilds, for the panel switcher. */
  guildNames: Record<string, string>;
  isSuper: boolean;
  /** Double-submit CSRF token; required on mutating requests (P2+). */
  csrf: string;
  createdAt: number;
  expiresAt: number;
}

/** How long a sign-in may take between /admin/login and the callback. */
export const STATE_TTL_MS = 10 * 60_000;
/** Sign-ins in flight at once, all browsers together; past it the oldest go. */
const MAX_PENDING_LOGINS = 10_000;

/** A sign-in started at /admin/login, waiting for its callback. */
interface PendingLogin {
  expiresAt: number;
  /** Started with ?reauth=1 (only noted on the login.ok record). */
  reauth: boolean;
}

/** What consumeState found. */
export type StateCheck = { ok: true; reauth: boolean } | { ok: false; why: 'unknown' | 'expired' };

export class SessionStore {
  private sessions = new Map<string, AdminSession>();
  private states = new Map<string, PendingLogin>();
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private ttlMs: number,
    private now: () => number = () => Date.now(),
  ) {}

  /** Start the periodic expiry sweep (no-op timer unref so it never blocks exit). */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(this.ttlMs, 60_000));
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  // ── OAuth state (CSRF for the login redirect) ──

  issueState(opts: { reauth?: boolean } = {}): string {
    if (this.states.size >= MAX_PENDING_LOGINS) {
      this.sweep();
      // Still full: the oldest sign-ins in flight make room (Map keeps
      // insertion order).
      for (const k of this.states.keys()) {
        if (this.states.size < MAX_PENDING_LOGINS) break;
        this.states.delete(k);
      }
    }
    const s = token();
    this.states.set(s, { expiresAt: this.now() + STATE_TTL_MS, reauth: opts.reauth === true });
    return s;
  }

  /** 'live': issued here, not used, not expired. 'unknown': never issued
   *  here, already used, or forgotten (a restart, the sweep). */
  stateStatus(state: string | undefined): 'live' | 'expired' | 'unknown' {
    const p = state ? this.states.get(state) : undefined;
    if (!p) return 'unknown';
    return p.expiresAt > this.now() ? 'live' : 'expired';
  }

  /** Validate-and-consume a state value (single use, live or not). */
  consumeState(state: string | undefined): StateCheck {
    const p = state ? this.states.get(state) : undefined;
    if (!p) return { ok: false, why: 'unknown' };
    this.states.delete(state!);
    return p.expiresAt > this.now() ? { ok: true, reauth: p.reauth } : { ok: false, why: 'expired' };
  }

  // ── Sessions ──

  create(input: Omit<AdminSession, 'id' | 'csrf' | 'createdAt' | 'expiresAt'>): AdminSession {
    const t = this.now();
    const s: AdminSession = {
      ...input,
      id: token(),
      csrf: token(),
      createdAt: t,
      expiresAt: t + this.ttlMs,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string | undefined): AdminSession | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) if (s.expiresAt <= t) this.sessions.delete(id);
    for (const [s, p] of this.states) if (p.expiresAt <= t) this.states.delete(s);
  }
}

function token(): string {
  return randomBytes(32).toString('base64url');
}
