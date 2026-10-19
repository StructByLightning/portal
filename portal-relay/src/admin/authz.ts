/**
 * Authorization model (RFC-005 §5.3). Two roles:
 *   - super-admin: configured operator; may act in ANY guild.
 *   - guild-admin: derived from live Discord perms; may act only in guilds they
 *     administer.
 *
 * Enforcement is server-side on every request: the client's claimed guild is
 * never trusted — we re-check the session's derived admin-guild set.
 */
import type { AdminSession } from './sessions.js';

/**
 * May this session manage `guildId`? Super-admins always may. Anyone else
 * needs both: admin rights in the guild (their OAuth snapshot, or a configured
 * delegate) AND the guild being one the relay SERVES (bot joined + allowed).
 * Discord reports admin rights for every server a user owns or runs — a guild
 * the relay doesn't serve is not one this panel administers, and an invite
 * minted "for" it would still be enrollable on this relay.
 */
export function canManageGuild(session: AdminSession, guildId: string, isServed: (guildId: string) => boolean): boolean {
  if (session.isSuper) return true;
  return session.adminGuilds.has(guildId) && isServed(guildId);
}

/** Catalog authoring (named access roles) is super-admin-only (RFC-005 §5.3). */
export function canAuthorRoles(session: AdminSession): boolean {
  return session.isSuper;
}
