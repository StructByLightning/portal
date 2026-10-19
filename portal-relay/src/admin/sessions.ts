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
 * Each is counted against the client address that started it, so one
 * address can hold only its own share: it makes room from its own oldest,
 * and when every address together is at the cap, the addresses holding the
 * most give way first — never an admin's single sign-in for a flood's.
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
/** Sign-ins in flight at once, every address together: a memory backstop. */
const MAX_PENDING_LOGINS = 10_000;
/** Sign-ins in flight from one client address; past it, its own oldest go. */
const MAX_PENDING_PER_CLIENT = 100;

/** A sign-in started at /admin/login, waiting for its callback. */
interface PendingLogin {
  expiresAt: number;
  /** Started with ?reauth=1 (only noted on the login.ok record). */
  reauth: boolean;
  /** The client address that started it (its share of the cap). */
  client: string;
  /** Issue order: higher is newer. */
  seq: number;
}

/** What consumeState found. */
export type StateCheck = { ok: true; reauth: boolean } | { ok: false; why: 'unknown' | 'expired' };

export class SessionStore {
  private sessions = new Map<string, AdminSession>();
  private states = new Map<string, PendingLogin>();
  /** Each client address's states in flight, oldest first. */
  private byClient = new Map<string, Set<string>>();
  private issued = 0;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly maxPending: number;
  private readonly maxPendingPerClient: number;

  constructor(
    private ttlMs: number,
    private now: () => number = () => Date.now(),
    limits: { maxPending?: number; maxPendingPerClient?: number } = {},
  ) {
    this.maxPending = limits.maxPending ?? MAX_PENDING_LOGINS;
    this.maxPendingPerClient = limits.maxPendingPerClient ?? MAX_PENDING_PER_CLIENT;
  }

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

  /** A new sign-in for `client` (its address). Room is made first: from this
   *  address's own oldest when it holds its share, then — every address
   *  together at the cap, after the expired go — from whichever address
   *  holds the most, so a flood from a few addresses can't push out the
   *  sign-ins of everyone else. */
  issueState(opts: { reauth?: boolean; client?: string } = {}): string {
    const client = opts.client ?? '';
    const mine = this.byClient.get(client);
    if (mine && mine.size >= this.maxPendingPerClient) this.sweep();
    while ((this.byClient.get(client)?.size ?? 0) >= this.maxPendingPerClient && this.dropOldest(client));
    if (this.states.size >= this.maxPending) this.sweep();
    while (this.states.size >= this.maxPending && this.dropOldest(this.busiestClient()));
    const s = token();
    this.states.set(s, { expiresAt: this.now() + STATE_TTL_MS, reauth: opts.reauth === true, client, seq: ++this.issued });
    let set = this.byClient.get(client);
    if (!set) this.byClient.set(client, (set = new Set()));
    set.add(s);
    return s;
  }

  /** The address with the most sign-ins in flight. */
  private busiestClient(): string {
    let best = '';
    let most = -1;
    for (const [c, set] of this.byClient) {
      if (set.size > most) {
        best = c;
        most = set.size;
      }
    }
    return best;
  }

  /** Forget `client`'s oldest sign-in in flight. Returns whether there was one. */
  private dropOldest(client: string): boolean {
    const oldest = this.byClient.get(client)?.values().next().value;
    if (oldest === undefined) return false;
    this.forgetState(oldest);
    return true;
  }

  private forgetState(state: string): void {
    const p = this.states.get(state);
    if (!p) return;
    this.states.delete(state);
    const set = this.byClient.get(p.client);
    set?.delete(state);
    if (set && !set.size) this.byClient.delete(p.client);
  }

  /** 'live': issued here, not used, not expired. 'unknown': never issued
   *  here, already used, or forgotten (a restart, the sweep). */
  stateStatus(state: string | undefined): 'live' | 'expired' | 'unknown' {
    const p = state ? this.states.get(state) : undefined;
    if (!p) return 'unknown';
    return p.expiresAt > this.now() ? 'live' : 'expired';
  }

  /** Where a state came in the order they were issued (higher is newer;
   *  undefined when it isn't held here). */
  stateIssueOrder(state: string): number | undefined {
    return this.states.get(state)?.seq;
  }

  /** Validate-and-consume a state value (single use, live or not). */
  consumeState(state: string | undefined): StateCheck {
    const p = state ? this.states.get(state) : undefined;
    if (!p) return { ok: false, why: 'unknown' };
    this.forgetState(state!);
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
    for (const [s, p] of this.states) if (p.expiresAt <= t) this.forgetState(s);
  }
}

function token(): string {
  return randomBytes(32).toString('base64url');
}
