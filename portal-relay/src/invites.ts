/**
 * Invite store — admin-minted access-rights *templates* that let new agents
 * self-register. An invite carries a capability profile plus optional limits
 * (max-uses, expiry); every persona enrolled through it inherits the same
 * caps. Live: hot-reloads on file edit (so an admin can add/revoke invites
 * without a restart) and persists its own use-count bumps.
 *
 * Separate from identity (who) and permissions (what) on purpose: an invite is
 * the *factory* for both — on a successful claim the relay mints an identity
 * and stamps the invite's caps as that persona's default policy.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { InviteTemplate, InvitesFile } from './config.js';
import { WatchedFile } from './file-watch.js';

/**
 * Why an invite's grant (or deprecated blanket caps) can't be applied as
 * written, or null. A grant needs a guild (every scope resolves inside one),
 * at least one capability, and exactly one scope: a non-empty channel list,
 * one or more Discord roles to mirror, or `all: true`. Enroll and claim refuse
 * such an invite before anything is created or consumed; loading warns.
 */
export function grantShapeProblem(inv: InviteTemplate): string | null {
  const grant = inv.grant ?? (inv.caps?.length ? { caps: inv.caps, scope: { all: true as const } } : undefined);
  if (!grant) return null;
  if (!inv.guildId) return 'invite grants access but names no guild — it must be re-minted with a guild';
  const caps = (grant as { caps?: unknown }).caps;
  if (!Array.isArray(caps) || caps.length === 0 || !caps.every((c) => typeof c === 'string' && c)) {
    return 'invite grant names no capabilities';
  }
  const sc = (grant as { scope?: unknown }).scope as Record<string, unknown> | undefined;
  if (!sc || typeof sc !== 'object' || Object.keys(sc).length !== 1) {
    return 'invite grant scope must be exactly one of channels, mirrorRole, mirrorRoles or all';
  }
  const ids = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x);
  const ok =
    sc.all === true ||
    ids(sc.channels) ||
    (typeof sc.mirrorRole === 'string' && sc.mirrorRole !== '') ||
    ids(sc.mirrorRoles);
  return ok ? null : 'invite grant scope is malformed';
}

/**
 * Why an invite can't be claimed as written, or null: a field a claim reads
 * holds a value outside its declared type, or the grant can't be applied
 * (grantShapeProblem). Every relay writer builds these fields from checked
 * values, so a hand edit is what reaches them. Read as found, `roles` as a
 * string throws mid-enroll, a numeric `guildId` grants nothing and spends the
 * invite, a misspelled `mode` mints, and a non-numeric count never exhausts.
 * Enroll and claim refuse such an invite before anything is created or
 * consumed, the admin mint route refuses to store one, and loading warns,
 * naming an expiry that isn't a date too.
 * `null` reads as absent, as it always has, except in `maxUses`: a null count
 * has always exhausted the invite, so it is refused rather than opened.
 */
export function inviteShapeProblem(inv: InviteTemplate): string | null {
  const f = inv as unknown as Record<string, unknown>;
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const checks: Array<[string, (v: unknown) => boolean, string]> = [
    ['guildId', (v) => typeof v === 'string', 'must be a string'],
    ['mintedBy', (v) => typeof v === 'string', 'must be a string'],
    ['namePrefix', (v) => typeof v === 'string', 'must be a string'],
    ['mode', (v) => v === 'mint' || v === 'augment' || v === 'both', 'must be "mint", "augment" or "both"'],
    ['roles', strings, 'must be a list of access role names'],
    ['subscriptions', strings, 'must be a list of channel ids'],
    ['uses', (v) => typeof v === 'number', 'must be a number'],
  ];
  for (const [field, ok, why] of checks) {
    if (f[field] !== undefined && f[field] !== null && !ok(f[field])) return `invite ${field} ${why}`;
  }
  if (f.maxUses !== undefined && !(typeof f.maxUses === 'number' && f.maxUses > 0)) {
    return 'invite maxUses must be a number above 0';
  }
  // check() already refuses such an expiry; this names it at load, since the
  // next save drops it with the expired invites.
  const at = expiryOf(inv);
  if (at !== undefined && Number.isNaN(at)) return "invite expiresAt isn't a date, so it reads as expired and the next save drops it";
  return grantShapeProblem(inv);
}

/** When an invite expires, in ms since the epoch, or undefined for never.
 *  Only a string names an expiry: absent, null, '' and false read as none, as
 *  they always have, and any other value can't be read as a time, so it
 *  counts as long expired (NaN). `Date.parse` would read a number as a date
 *  string: 2030 as 2030-01-01, 99999 as the year 99999. */
function expiryOf(inv: InviteTemplate): number | undefined {
  const at = (inv as { expiresAt?: unknown }).expiresAt;
  if (at === undefined || at === null || at === '' || at === false) return undefined;
  return typeof at === 'string' ? Date.parse(at) : NaN;
}

export type InviteRejection =
  | 'unknown'
  | 'expired'
  | 'exhausted';

export class InviteStore {
  private byCode = new Map<string, InviteTemplate>();
  private file?: WatchedFile;

  constructor(private path: string) {
    this.reload();
  }

  startWatching(): void {
    this.file = new WatchedFile(this.path, () => this.reload());
    this.file.start();
  }

  stopWatching(): void {
    this.file?.stop();
  }

  /** Validate a code without consuming it. Returns the template or a reason. */
  check(code: string, nowMs: number): InviteTemplate | InviteRejection {
    const inv = this.byCode.get(code);
    if (!inv) return 'unknown';
    const at = expiryOf(inv);
    // Fail CLOSED on an unparseable expiry: `NaN <= now` is false, so the
    // naive comparison silently turned a malformed timestamp into a
    // never-expiring invite — the most dangerous default a bearer-code
    // store can have.
    if (at !== undefined && (!Number.isFinite(at) || at <= nowMs)) return 'expired';
    if (inv.maxUses !== undefined && (inv.uses ?? 0) >= inv.maxUses) return 'exhausted';
    return inv;
  }

  /** Bump an invite's use count and persist. Call after a successful mint. */
  consume(code: string): void {
    const inv = this.byCode.get(code);
    if (!inv) return;
    inv.uses = (inv.uses ?? 0) + 1;
    this.persist();
  }

  all(): InviteTemplate[] {
    return [...this.byCode.values()];
  }

  get(code: string): InviteTemplate | undefined {
    return this.byCode.get(code);
  }

  // ── Mutations (persist) — RFC-005 admin API ──

  /** Add a new invite template. Throws on duplicate code. Returns it. */
  mint(template: InviteTemplate): InviteTemplate {
    if (this.byCode.has(template.code)) throw new Error(`duplicate invite code ${template.code}`);
    const inv = { uses: 0, ...template };
    this.byCode.set(inv.code, inv);
    this.persist();
    return inv;
  }

  /** Remove an invite (forward-only: past grants persist — RFC-005 §5.8). */
  revoke(code: string): boolean {
    const ok = this.byCode.delete(code);
    if (ok) this.persist();
    return ok;
  }

  // ── File IO ──

  private reload(): void {
    const next = JSON.parse(readFileSync(this.path, 'utf8')) as InvitesFile;
    if (!Array.isArray(next.invites)) throw new Error('invites file: invites must be an array');
    const byCode = new Map<string, InviteTemplate>();
    for (const inv of next.invites) {
      if (!inv.code) throw new Error('invite missing code');
      if (byCode.has(inv.code)) throw new Error(`duplicate invite code ${inv.code}`);
      byCode.set(inv.code, inv);
    }
    this.byCode = byCode;
    // An invite a claim can't read as written (a field of the wrong type, a
    // grant with no guild, no caps or a malformed scope) is refused at enroll
    // and claim. Flag it so it is fixed rather than discovered by the agent
    // that tries it.
    const bad = [...byCode.values()]
      .map((i) => [i, inviteShapeProblem(i)] as const)
      .filter(([, why]) => why)
      .map(([i, why]) => `${i.label ?? i.code.slice(0, 12)} (${why})`);
    if (bad.length) {
      console.error(`[portal-relay] invites: ${bad.length} invite(s) will be refused: ${bad.join('; ')}`);
    }
  }

  private persist(): void {
    this.pruneExpired();
    const data: InvitesFile = { invites: this.all() };
    const json = JSON.stringify(data, null, 2) + '\n';
    if (this.file) this.file.write(json);
    else writeFileSync(this.path, json);
  }

  /**
   * Drop invites that expired more than 24h ago. Machine mints (mint_invite,
   * TTL ≤ 60min) would otherwise accumulate forever and every persist() is a
   * full-file rewrite — O(total) bytes per mint. The 24h grace keeps a short
   * forensic tail on disk; the audit log holds provenance permanently. An
   * unparseable expiresAt counts as long-expired (fail closed, matches check).
   */
  private pruneExpired(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [code, inv] of this.byCode) {
      const at = expiryOf(inv);
      if (at === undefined) continue;
      if (!Number.isFinite(at) || at <= cutoff) this.byCode.delete(code);
    }
  }
}
