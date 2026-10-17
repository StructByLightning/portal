#!/usr/bin/env node
// Admin panel preview — the real AdminServer and the real panel, over an
// invented fixture world. Nothing here talks to Discord or to a relay:
//
//   - the stores (identity, permissions, invites, audit) live in a temp dir,
//     seeded with made-up guilds, channels, personas and invites;
//   - Discord OAuth is answered by an injected fetch, and Discord's consent
//     screen is replaced by /dev-authorize, so the panel's own /admin/login and
//     /admin/callback run for real;
//   - guild, channel and Discord-role data come from the fixture tables below.
//
// Run (from portal-relay/):
//   node --import tsx scripts/admin-preview.mts [--scale small|large] [--ttl ms] [--no-avatars] [--port 8833]
//
// Then open http://127.0.0.1:8833/dev-login?as=op   (op | gwen | dee | otto)
//   /dev-login?as=<user>[&deny=1][&hold=1]
//                                  sign in as a fixture user (deny=1: cancel at
//                                  "Discord"; hold=1: stop at a consent page, as
//                                  Discord does the first time, until it is reset
//                                  by a /dev-login without hold=1)
//   /dev-authorize[?deny=1][&hold=1]  stands in for Discord's authorize page
//   /dev-restart                   rebuild the AdminServer over the same stores
//                                  (ends every session and every sign-in in flight,
//                                  like a relay restart)
//
// The front passes X-Forwarded-For through untouched, so a request from the
// browser counts as 127.0.0.1 for the sign-in rate limit, and a curl can pick
// its own address:
//   curl -si -H 'X-Forwarded-For: 203.0.113.5' 'http://127.0.0.1:8833/admin/callback?code=x&state=y'
//
// Fixture users:
//   op    super-admin (PORTAL_SUPERADMINS)
//   gwen  Manage Server in Guild One and Guild Three (the relay serves only One)
//   dee   no Discord rights; a configured delegate for Guild Two (PORTAL_GUILD_ADMINS)
//   otto  manages only Guild Three, which the relay does not serve → refused sign-in
//
// Every name and id in this file is invented. Keep it that way: this repo is public.
//
// When a later change adds a member to AdminDeps, add its fake here (and in
// scripts/admin-dev.mjs) in the same change.
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { Capability } from '@animalabs/portal-protocol';
import { AdminServer, type AdminDeps } from '../src/admin/server.js';
import { AuditLog } from '../src/admin/audit.js';
import { ChannelNameResolver } from '../src/admin/names.js';
import { IdentityStore, generateToken, hashToken } from '../src/identity.js';
import { ALL_CAPS, PermissionsStore } from '../src/permissions.js';
import { InviteStore } from '../src/invites.js';
import { LEVEL_CAPS } from '../src/slash.js';
import type { ChannelMeta } from '../src/discord-bot.js';

// ── Options ──

function parseArgs(argv: string[]) {
  const out = { scale: 'small' as 'small' | 'large', ttlMs: 30 * 60_000, avatars: true, port: 8833 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    if (a === '--scale') {
      const v = val();
      if (v !== 'small' && v !== 'large') die('--scale is small or large');
      out.scale = v;
    } else if (a === '--ttl') {
      out.ttlMs = Number(val());
      if (!Number.isFinite(out.ttlMs) || out.ttlMs < 1000) die('--ttl is a number of milliseconds (at least 1000)');
    } else if (a === '--no-avatars') out.avatars = false;
    else if (a === '--port') {
      out.port = Number(val());
      if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) die('--port is a TCP port');
    } else if (a === '--help' || a === '-h') {
      console.log('node --import tsx scripts/admin-preview.mts [--scale small|large] [--ttl ms] [--no-avatars] [--port 8833]');
      process.exit(0);
    } else die(`unknown option ${a} (try --help)`);
  }
  return out;
}

function die(msg: string): never {
  console.error(`admin-preview: ${msg}`);
  process.exit(2);
}

const opts = parseArgs(process.argv.slice(2));
const ORIGIN = `http://127.0.0.1:${opts.port}`;
const NOW = Date.now();
const DAY = 86_400_000;

// ── The fixture world ──

const G1 = '100000000000000001';
const G2 = '100000000000000002';
const G3 = '100000000000000003';

/** Guilds as "Discord" knows them. `joined`: the relay's bot is in it. */
const GUILDS = [
  { id: G1, name: 'Guild One', memberCount: 48, joined: true },
  { id: G2, name: 'Guild Two', memberCount: 12, joined: true },
  { id: G3, name: 'Guild Three', memberCount: 7, joined: false },
];
/** The relay's allow-list (editable from the Guilds tab). */
const allowed = new Set([G1, G2]);

const USERS = {
  op: { id: '200000000000000001', username: 'op', global_name: 'Op' },
  gwen: { id: '200000000000000002', username: 'gwen', global_name: 'Gwen' },
  dee: { id: '200000000000000003', username: 'dee', global_name: 'Dee' },
  otto: { id: '200000000000000004', username: 'otto', global_name: 'Otto' },
} as const;
type UserKey = keyof typeof USERS;

const MANAGE_GUILD = String(0x20);
/** What /users/@me/guilds says for each user (Discord-side rights). */
const OAUTH_GUILDS: Record<UserKey, Array<{ id: string; name: string; owner: boolean; permissions: string }>> = {
  op: [],
  gwen: [
    { id: G1, name: 'Guild One', owner: false, permissions: MANAGE_GUILD },
    { id: G3, name: 'Guild Three', owner: false, permissions: MANAGE_GUILD },
  ],
  dee: [{ id: G2, name: 'Guild Two', owner: false, permissions: '0' }],
  otto: [{ id: G3, name: 'Guild Three', owner: false, permissions: MANAGE_GUILD }],
};

/** Discord roles. The @everyone role's id is the guild's id. */
const ROLE = {
  mods: '100000000000003001',
  researchers: '100000000000003002',
  portalAria: '100000000000003003',
};
const DISCORD_ROLES: Record<string, Array<{ id: string; name: string }>> = {
  [G1]: [
    { id: G1, name: '@everyone' },
    { id: ROLE.mods, name: 'Mods' },
    { id: ROLE.researchers, name: 'Researchers' },
    { id: ROLE.portalAria, name: 'portal-aria' }, // a pooled addressing role
  ],
  [G2]: [{ id: G2, name: '@everyone' }],
};
const POOL_PREFIX = 'portal-';

type Level = 'read' | 'write' | 'full';
interface FixtureChannel {
  id: string;
  name: string;
  type: ChannelMeta['type'];
  guildId: string;
  /** Discord category (for channels) or parent channel (for threads). */
  categoryId?: string;
  parentId?: string;
  position: number;
  /** Discord announcement channel (the relay maps it to `text`). */
  announcement?: boolean;
  /** What the relay's bot may do here (none = it can't see the channel;
   *  full = every capability, as a bot with broad permissions has;
   *  nothreads = all but starting threads, as where Create Public Threads
   *  is denied). */
  bot: Level | 'none' | 'nothreads';
  /** What members holding each Discord role may do here. */
  access: Partial<Record<'everyone' | 'mods' | 'researchers', Level>>;
}

const C = {
  catGeneral: '100000000000001001',
  catResearch: '100000000000001002',
  catArchive: '100000000000001003',
  welcome: '100000000000001010',
  general: '100000000000001011',
  random: '100000000000001012',
  lounge: '100000000000001013',
  research: '100000000000001021',
  designReview: '100000000000001022',
  labNotes: '100000000000001023',
  ideas: '100000000000001024',
  oldLogs: '100000000000001031',
  townHall: '100000000000001014',
  showAndTell: '100000000000001015',
  lobby: '100000000000002011',
  desk: '100000000000002012',
  // Not in the fixture: a channel of Guild One since deleted.
  gone: '100000000000001099',
};
const everywhere = { everyone: 'write', mods: 'full', researchers: 'write' } as const;
const CHANNELS: FixtureChannel[] = [
  { id: C.welcome, name: 'welcome', type: 'text', guildId: G1, position: 0, announcement: true, bot: 'read', access: { everyone: 'read', mods: 'full', researchers: 'read' } },
  { id: C.catGeneral, name: 'General', type: 'category', guildId: G1, position: 1, bot: 'full', access: everywhere },
  { id: C.general, name: 'general', type: 'text', guildId: G1, categoryId: C.catGeneral, position: 0, bot: 'full', access: everywhere },
  { id: C.random, name: 'random', type: 'text', guildId: G1, categoryId: C.catGeneral, position: 1, bot: 'full', access: everywhere },
  { id: C.lounge, name: 'lounge', type: 'voice', guildId: G1, categoryId: C.catGeneral, position: 2, bot: 'full', access: everywhere },
  // A stage channel: the relay calls its kind 'unknown', and serves it all the same.
  { id: C.townHall, name: 'town-hall', type: 'unknown', guildId: G1, categoryId: C.catGeneral, position: 3, bot: 'full', access: everywhere },
  // The bot can send here, but not start threads.
  { id: C.showAndTell, name: 'show-and-tell', type: 'text', guildId: G1, categoryId: C.catGeneral, position: 4, bot: 'nothreads', access: everywhere },
  { id: C.catResearch, name: 'Research', type: 'category', guildId: G1, position: 2, bot: 'full', access: { mods: 'full', researchers: 'write' } },
  { id: C.research, name: 'research', type: 'text', guildId: G1, categoryId: C.catResearch, position: 0, bot: 'full', access: { mods: 'full', researchers: 'write' } },
  { id: C.designReview, name: 'design-review', type: 'thread', guildId: G1, parentId: C.research, position: 0, bot: 'full', access: { mods: 'full', researchers: 'write' } },
  { id: C.labNotes, name: 'lab-notes', type: 'text', guildId: G1, categoryId: C.catResearch, position: 1, bot: 'full', access: { mods: 'full', researchers: 'write' } },
  { id: C.ideas, name: 'ideas', type: 'forum', guildId: G1, categoryId: C.catResearch, position: 2, bot: 'full', access: { mods: 'full', researchers: 'write' } },
  { id: C.catArchive, name: 'Archive', type: 'category', guildId: G1, position: 3, bot: 'none', access: { mods: 'read' } },
  { id: C.oldLogs, name: 'old-logs', type: 'text', guildId: G1, categoryId: C.catArchive, position: 0, bot: 'none', access: { mods: 'read' } },
  { id: C.lobby, name: 'lobby', type: 'text', guildId: G2, position: 0, bot: 'full', access: { everyone: 'write' } },
  { id: C.desk, name: 'desk', type: 'text', guildId: G2, position: 1, bot: 'full', access: { everyone: 'write' } },
];

const READ = LEVEL_CAPS.read;
const WRITE = LEVEL_CAPS.write;
const FULL = LEVEL_CAPS.full;

const ACCESS_ROLES = {
  'g1-readers': { caps: READ, scope: { all: true }, guildId: G1 },
  'g1-chatters': { caps: WRITE, scope: { channels: [C.general, C.research] }, guildId: G1 },
  'g1-mods-mirror': { caps: FULL, scope: { mirrorRole: ROLE.mods }, guildId: G1, mirrorCaps: true },
  'g2-desk': { caps: WRITE, scope: { all: true }, guildId: G2 },
};

// Ids as the relay mints them (a name, a dash, six hex digits): the ones the
// panel's acceptance steps name, e.g. #/g/<G1>/personas/p/aria-1a2b3c.
const P = {
  aria: 'aria-1a2b3c',
  cass: 'cass-2b3c4d',
  nyx: 'nyx-7a8b9c',
  juniper: 'juniper-3c4d5e',
  quill: 'quill-4d5e6f',
  sol: 'sol-6d7e8f',
};

const PERSONAS = [
  { id: P.aria, displayName: 'Aria', color: [0x5b, 0x8d, 0xef] },
  { id: P.cass, displayName: 'Cass', color: [0xe0, 0x7a, 0x5f] },
  { id: P.nyx, displayName: 'Nyx', color: [0x3d, 0x40, 0x5b] },
  { id: P.juniper, displayName: 'Juniper', color: [0x81, 0xb2, 0x9a] },
  { id: P.quill, displayName: 'Quill', color: [0xf2, 0xcc, 0x8f] },
  { id: P.sol, displayName: 'Sol', color: [0xf4, 0xa2, 0x61] },
];

const PERMISSIONS: Record<string, unknown> = {
  // Aria: talks in #general and #research through her access role, and holds
  // her own direct grant in #research too — and one in the town-hall stage
  // channel, as slash /add stores it when run in its chat.
  [P.aria]: { roles: ['g1-chatters'], policy: { default: [], guilds: { [G1]: { channels: { [C.research]: WRITE, [C.townHall]: WRITE } } } } },
  // Cass: reads all of Guild One guild-wide, but is blocked in #random.
  [P.cass]: { policy: { default: [], guilds: { [G1]: { default: READ, channels: { [C.random]: [] } } } } },
  // Nyx: no entry at all — no access anywhere.
  // Juniper: grants on a thread id and a category id, which grant nothing.
  [P.juniper]: { policy: { default: [], guilds: { [G1]: { channels: { [C.designReview]: WRITE, [C.catResearch]: READ } } } } },
  // Quill: mirrors @Mods with their per-channel permissions, and holds a block
  // in #random that blocks nothing (no guild-wide level or persona default).
  [P.quill]: { roles: ['g1-mods-mirror'], policy: { default: [], guilds: { [G1]: { channels: { [C.random]: [] } } } } },
  // Sol: a persona default (every guild) plus Guild Two's desk role, and a
  // grant in Guild One on a channel since deleted.
  [P.sol]: { roles: ['g2-desk'], policy: { default: READ, guilds: { [G1]: { channels: { [C.gone]: WRITE } } } } },
};

const newCode = () => `inv_${randomBytes(18).toString('base64url')}`;
const iso = (ms: number) => new Date(ms).toISOString();
const INVITES: Array<Record<string, unknown>> = [
  { code: newCode(), label: 'guests', guildId: G1, roles: ['g1-readers'], maxUses: 5, uses: 1, expiresAt: iso(NOW + 6 * DAY), createdAt: iso(NOW - 1 * DAY) },
  { code: newCode(), label: 'used-up', guildId: G1, roles: ['g1-readers'], maxUses: 1, uses: 1, createdAt: iso(NOW - 4 * DAY) },
  { code: newCode(), label: 'expired', guildId: G1, grant: { caps: READ, scope: { channels: [C.general] } }, uses: 0, expiresAt: iso(NOW - 2 * 3_600_000), createdAt: iso(NOW - 8 * DAY) },
  { code: newCode(), label: 'slash-invite by Gwen', guildId: G1, roles: ['g1-chatters'], grant: { caps: WRITE, scope: { channels: [C.general] } }, maxUses: 1, uses: 0, createdAt: iso(NOW - 2 * DAY) },
  { code: newCode(), label: 'augment', guildId: G1, roles: ['g1-readers'], mode: 'both', maxUses: 3, uses: 0, expiresAt: iso(NOW + 20 * DAY), createdAt: iso(NOW - 3 * 3_600_000) },
  { code: newCode(), label: 'g2-only', guildId: G2, roles: ['g2-desk'], maxUses: 2, uses: 0, createdAt: iso(NOW - 5 * DAY) },
];

type AuditLine = { ts: string; actor: { id: string; name: string; kind: 'admin' | 'persona' }; action: string; target?: string; guildId?: string; ok: boolean; before?: unknown; after?: unknown; detail?: Record<string, unknown> };
const admin = (u: UserKey) => ({ id: USERS[u].id, name: USERS[u].global_name, kind: 'admin' as const });
const AUDIT: AuditLine[] = [
  { ts: iso(NOW - 6 * DAY), actor: admin('op'), action: 'login.ok', ok: true, detail: { isSuper: true, adminGuilds: [] } },
  { ts: iso(NOW - 6 * DAY + 60_000), actor: admin('op'), action: 'persona.role.assign', target: P.aria, guildId: G1, ok: true, after: { role: 'g1-chatters' } },
  { ts: iso(NOW - 5 * DAY), actor: admin('gwen'), action: 'slash.add', target: P.aria, guildId: G1, ok: true, detail: { via: 'slash', channelId: C.research, level: 'write' } },
  { ts: iso(NOW - 5 * DAY + 90_000), actor: admin('dee'), action: 'persona.role.assign', target: P.sol, guildId: G2, ok: true, after: { role: 'g2-desk' } },
  { ts: iso(NOW - 5 * DAY + 120_000), actor: admin('dee'), action: 'invite.mint', target: INVITES[5].code as string, guildId: G2, ok: true, after: INVITES[5] },
  { ts: iso(NOW - 4 * DAY), actor: admin('gwen'), action: 'invite.mint', target: INVITES[1].code as string, guildId: G1, ok: true, after: INVITES[1] },
  { ts: iso(NOW - 3 * DAY), actor: admin('gwen'), action: 'persona.grant.set', target: P.cass, guildId: G1, ok: true, after: { caps: READ } },
  { ts: iso(NOW - 3 * DAY + 30_000), actor: admin('gwen'), action: 'persona.grant.set', target: P.cass, guildId: G1, ok: true, after: { channelId: C.random, caps: [] } },
  { ts: iso(NOW - 2 * DAY), actor: admin('gwen'), action: 'slash.invite', target: INVITES[3].code as string, guildId: G1, ok: true, detail: { via: 'slash', channelId: C.general, roles: ['g1-chatters'], channelLevel: 'write' } },
  { ts: iso(NOW - 1 * DAY), actor: admin('gwen'), action: 'invite.mint', target: INVITES[0].code as string, guildId: G1, ok: true, after: INVITES[0] },
  { ts: iso(NOW - 20 * 3_600_000), actor: admin('op'), action: 'persona.role.revoke', target: P.cass, guildId: G1, ok: true, before: { role: 'g1-readers' } },
  { ts: iso(NOW - 6 * 3_600_000), actor: admin('otto'), action: 'authz.denied', guildId: G1, ok: false, detail: { via: 'slash', channelId: C.general, command: 'add' } },
  { ts: iso(NOW - 5 * 3_600_000), actor: admin('otto'), action: 'login.denied', ok: false, detail: { reason: 'no_manageable_guild' } },
  { ts: iso(NOW - 3 * 3_600_000), actor: admin('op'), action: 'invite.mint', target: INVITES[4].code as string, guildId: G1, ok: true, after: INVITES[4] },
];

// ── --scale large: a busy guild ──

if (opts.scale === 'large') {
  // Deterministic, so two runs look alike.
  let seed = 0x5eed;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const big: FixtureChannel[] = [];
  let n = 0;
  const sf = (k: number) => `1000000000005${String(k).padStart(5, '0')}`;
  for (let cat = 1; cat <= 8; cat++) {
    const catId = sf(++n);
    big.push({ id: catId, name: `Area ${cat}`, type: 'category', guildId: G1, position: 3 + cat, bot: 'full', access: everywhere });
    for (let i = 1; i <= 36; i++) {
      const id = sf(++n);
      big.push({ id, name: `area${cat}-room-${String(i).padStart(2, '0')}`, type: i % 12 === 0 ? 'voice' : 'text', guildId: G1, categoryId: catId, position: i, bot: i % 17 === 0 ? 'read' : 'full', access: everywhere });
      if (i % 3 === 0) big.push({ id: sf(++n), name: `thread-${cat}-${i}`, type: 'thread', guildId: G1, parentId: id, position: 0, bot: 'full', access: everywhere });
    }
  }
  CHANNELS.push(...big);
  // Aria also holds an access role for every channel of Guild One, so her
  // drawer folds hundreds of rows that read alike into one line.
  (ACCESS_ROLES as Record<string, unknown>)['g1-everyone'] = { caps: WRITE, scope: { all: true }, guildId: G1 };
  (PERMISSIONS[P.aria] as { roles: string[] }).roles.push('g1-everyone');
  const rooms = big.filter((c) => c.type === 'text' || c.type === 'voice');
  for (let i = 1; i <= 200; i++) {
    const id = `persona-${String(i).padStart(3, '0')}`;
    PERSONAS.push({ id, displayName: `Persona ${String(i).padStart(3, '0')}`, color: [Math.floor(rnd() * 200) + 30, Math.floor(rnd() * 200) + 30, Math.floor(rnd() * 200) + 30] });
    const roles: string[] = [];
    if (rnd() < 0.35) roles.push('g1-readers');
    if (rnd() < 0.25) roles.push('g1-chatters');
    if (rnd() < 0.1) roles.push('g2-desk');
    const channels: Record<string, Capability[]> = {};
    const grants = Math.floor(rnd() * 6);
    for (let g = 0; g < grants; g++) channels[pick(rooms).id] = pick([READ, WRITE, FULL]);
    PERMISSIONS[id] = { roles, policy: { default: [], ...(grants ? { guilds: { [G1]: { channels } } } : {}) } };
  }
  for (let i = 1; i <= 60; i++) {
    const created = NOW - Math.floor(rnd() * 30 * DAY);
    const maxUses = pick([1, 1, 1, 5, 25]);
    const uses = rnd() < 0.4 ? maxUses : Math.floor(rnd() * maxUses);
    const expiring = rnd() < 0.5;
    INVITES.push({
      code: newCode(), label: `batch-${String(i).padStart(2, '0')}`, guildId: G1,
      ...(rnd() < 0.5 ? { roles: [pick(['g1-readers', 'g1-chatters'])] } : { grant: { caps: pick([READ, WRITE]), scope: { channels: [pick(rooms).id] } } }),
      maxUses, uses, createdAt: iso(created),
      // Expired ones stay within the store's 24 h grace, so the next write keeps them.
      ...(expiring ? { expiresAt: iso(rnd() < 0.3 ? NOW - Math.floor(rnd() * 20 * 3_600_000) : NOW + Math.floor(rnd() * 14 * DAY)) } : {}),
    });
  }
  const actions = ['persona.grant.set', 'persona.grant.clear', 'persona.role.assign', 'persona.role.revoke', 'slash.add', 'slash.remove', 'invite.mint', 'invite.revoke'];
  for (let i = 0; i < 500; i++) {
    const action = pick(actions);
    const who = pick(['op', 'gwen', 'gwen', 'op'] as const);
    const persona = `persona-${String(1 + Math.floor(rnd() * 200)).padStart(3, '0')}`;
    const room = pick(rooms).id;
    AUDIT.push({
      ts: iso(NOW - 30 * DAY + Math.floor(rnd() * 30 * DAY)), actor: admin(who), action, guildId: G1, ok: rnd() > 0.05,
      ...(action.startsWith('invite.') ? { target: (pick(INVITES).code as string) } : { target: persona }),
      ...(action.startsWith('slash.') ? { detail: { via: 'slash', channelId: room, level: pick(['read', 'write', 'full']) } } : {}),
      ...(action === 'persona.grant.set' ? { after: { channelId: room, caps: pick([READ, WRITE]) } } : {}),
      ...(action === 'persona.grant.clear' ? { before: { channelId: room } } : {}),
      ...(action.startsWith('persona.role.') ? { after: { role: pick(['g1-readers', 'g1-chatters']) } } : {}),
    });
  }
  AUDIT.sort((a, b) => a.ts.localeCompare(b.ts));
}

// ── Seed the stores ──

const dir = mkdtempSync(join(tmpdir(), 'portal-admin-preview-'));
const avatarDir = opts.avatars ? join(dir, 'avatars') : undefined;
if (avatarDir) mkdirSync(avatarDir);
writeFileSync(join(dir, 'identity.json'), JSON.stringify({
  personas: PERSONAS.map((p, i) => {
    let avatar = '';
    // Every other generated persona has no picture, as in real life.
    if (avatarDir && (i < 6 || i % 2 === 0)) {
      avatar = `${p.id}.png`;
      writeFileSync(join(avatarDir, avatar), solidPng(64, p.color as [number, number, number]));
    }
    return { id: p.id, displayName: p.displayName, avatar, token: hashToken(`preview-token-${p.id}`) };
  }),
}, null, 2));
writeFileSync(join(dir, 'permissions.json'), JSON.stringify({ roles: ACCESS_ROLES, personas: PERMISSIONS }, null, 2));
// In the order they were made, as the relay's store keeps them (it appends each
// new invite; the panel lists them newest first).
const byCreated = (a: Record<string, unknown>, b: Record<string, unknown>) => String(a.createdAt).localeCompare(String(b.createdAt));
writeFileSync(join(dir, 'invites.json'), JSON.stringify({ invites: [...INVITES].sort(byCreated) }, null, 2));
const auditPath = join(dir, 'audit.jsonl');
writeFileSync(auditPath, AUDIT.map((r) => JSON.stringify(r)).join('\n') + '\n');

const identity = new IdentityStore(join(dir, 'identity.json'), avatarDir ? `${ORIGIN}/admin/avatars` : '');
const permissions = new PermissionsStore(join(dir, 'permissions.json'));
const invites = new InviteStore(join(dir, 'invites.json'));
const audit = new AuditLog(auditPath);

// ── Fake Discord: channels, roles, mirror lookup ──

const channelById = new Map(CHANNELS.map((c) => [c.id, c]));
const joinedGuilds = () => GUILDS.filter((g) => g.joined);
const servedGuilds = () => joinedGuilds().filter((g) => allowed.has(g.id));

const levelCaps = (l: Level | 'none' | undefined): Capability[] => (l && l !== 'none' ? LEVEL_CAPS[l] : []);
const roleKey = (gid: string, rid: string): 'everyone' | 'mods' | 'researchers' | null =>
  rid === gid ? 'everyone' : rid === ROLE.mods ? 'mods' : rid === ROLE.researchers ? 'researchers' : null;

// Which channels a Discord role can see, and what it may do in each. Worked
// out once per role, as the relay's mirror cache does.
const mirrors = new Map<string, Map<string, Set<Capability>>>();
permissions.setMirrorLookup((gid, rid) => {
  const k = `${gid}/${rid}`;
  const hit = mirrors.get(k);
  if (hit) return hit;
  const out = new Map<string, Set<Capability>>();
  const key = roleKey(gid, rid);
  if (key) {
    for (const c of CHANNELS) {
      if (c.guildId !== gid || c.type === 'category') continue;
      const caps = levelCaps(c.access[key]);
      if (caps.length) out.set(c.id, new Set(caps));
    }
  }
  mirrors.set(k, out);
  return out;
});

// What the relay's bot can do in a channel — as computeCapabilities works it
// out: a channel Discord's cache doesn't hold lets only the two capabilities
// with no Discord permission behind them through.
const BOT_CAPS: Record<Level | 'none' | 'nothreads', Capability[]> = {
  none: [], read: LEVEL_CAPS.read, write: LEVEL_CAPS.write, full: ALL_CAPS, nothreads: ALL_CAPS.filter((c) => c !== 'CREATE_THREADS'),
};
const botCaps = (_gid: string, cid: string): Capability[] => {
  const c = channelById.get(cid);
  return c ? [...BOT_CAPS[c.bot]] : ['EDIT_OWN', 'DELETE_OWN'];
};

const meta = (c: FixtureChannel): ChannelMeta => ({
  id: c.id, name: c.name, type: c.type, guildId: c.guildId,
  ...(c.parentId ? { parentId: c.parentId } : {}),
  ...(c.type === 'thread' ? { archived: false } : {}),
  isThread: c.type === 'thread',
});
const names = new ChannelNameResolver({
  cached: (id) => {
    const c = channelById.get(id);
    return c ? meta(c) : null;
  },
  // Anything not in the fixture is a deleted channel.
  fetch: async () => 'deleted',
});

// ── Fake Discord: OAuth ──

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fakeDiscord = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith('/oauth2/token')) {
    const code = new URLSearchParams(String(init?.body ?? '')).get('code') ?? '';
    const who = /^dev-(\w+)$/.exec(code)?.[1];
    if (!who || !(who in USERS)) return json({ error: 'invalid_grant' }, 400);
    return json({ access_token: `dev-token-${who}`, token_type: 'Bearer' });
  }
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  const who = /^Bearer dev-token-(\w+)$/.exec(auth)?.[1] as UserKey | undefined;
  if (!who || !(who in USERS)) return json({ message: '401: Unauthorized' }, 401);
  if (url.endsWith('/users/@me')) return json(USERS[who]);
  if (url.endsWith('/users/@me/guilds')) return json(OAUTH_GUILDS[who]);
  return json({ message: 'not faked' }, 404);
}) as typeof fetch;

// ── The admin API ──

const deps: AdminDeps = {
  config: {
    port: 0,
    oauthClientId: 'preview-client',
    oauthClientSecret: 'preview-secret',
    redirectUri: `${ORIGIN}/admin/callback`,
    postLoginUrl: '/',
    superadmins: [USERS.op.id],
    guildAdmins: { [G2]: [USERS.dee.id] },
    sessionTtlMs: opts.ttlMs,
    auditPath,
    cookieSecure: false,
    ...(avatarDir ? { avatarDir } : {}),
  },
  identity,
  permissions,
  invites,
  audit,
  listGuilds: () => servedGuilds().map(({ id, name, memberCount }) => ({ id, name, memberCount })),
  listAllGuilds: () => joinedGuilds().map(({ id, name, memberCount }) => ({ id, name, memberCount, allowed: allowed.has(id) })),
  allowlist: {
    editable: true,
    list: () => [...allowed],
    allow: (gid) => !allowed.has(gid) && !!allowed.add(gid),
    disallow: (gid) => allowed.delete(gid),
  },
  listRoles: (gid) => (DISCORD_ROLES[gid] ?? []).map((r) => ({ ...r, guildId: gid, pooled: r.name.startsWith(POOL_PREFIX) })),
  listChannels: (gid) =>
    joinedGuilds().some((g) => g.id === gid)
      ? CHANNELS.filter((c) => c.guildId === gid).map((c) => ({ id: c.id, name: c.name, type: c.type, ...(c.parentId ? { parentId: c.parentId } : {}) }))
      : [],
  resolveChannels: (ids) => names.resolve(ids),
  discordRole: (rid) => {
    for (const [gid, rs] of Object.entries(DISCORD_ROLES)) {
      const r = rs.find((x) => x.id === rid);
      if (r) return { name: r.name, guildId: gid };
    }
    return null;
  },
  channelInGuild: (gid, cid) => channelById.get(cid)?.guildId === gid,
  closePersona: (pid) => console.error(`[preview] closePersona ${pid}`),
  // A simplified claim: the invite's roles and channel/all grant, nothing else.
  applyClaim: (pid, code) => {
    const inv = invites.check(code, Date.now());
    if (typeof inv === 'string') throw new Error(`invite ${inv}`);
    if (inv.mode !== 'augment' && inv.mode !== 'both') throw new Error('invite is not claimable (mint-only)');
    if (inv.roles?.length) permissions.addPersonaRoles(pid, inv.roles);
    const sc = inv.grant?.scope;
    if (inv.grant && inv.guildId && sc && 'channels' in sc) {
      for (const cid of sc.channels) permissions.setChannel(pid, inv.guildId, cid, inv.grant.caps);
    } else if (inv.grant && inv.guildId && sc && 'all' in sc) {
      permissions.setGuildDefault(pid, inv.guildId, inv.grant.caps);
    }
    invites.consume(code);
    return { roles: permissions.getRoleNames(pid) };
  },
  rotatePersonaToken: (pid) => {
    const cur = identity.get(pid);
    if (!cur) throw new Error('no such persona');
    const token = generateToken();
    identity.upsert({ ...cur, token: hashToken(token) });
    return token;
  },
  revokePersonaToken: (pid) => {
    const cur = identity.get(pid);
    if (cur) identity.upsert({ ...cur, token: hashToken(generateToken()) });
  },
  newInviteCode: newCode,
  // As Relay.capsFor: nothing for a persona it doesn't know or in a guild it
  // doesn't serve; else the persona's access within what the bot can do.
  capsFor: (pid, cid, gid) => {
    if (!identity.get(pid) || (gid && !allowed.has(gid))) return [];
    const policy = permissions.resolve(pid, gid, cid);
    const bot = new Set(botCaps(gid, cid));
    return ALL_CAPS.filter((c) => policy.has(c) && bot.has(c));
  },
  botCaps,
  // As Relay.permChannelId: a thread's access is its parent's.
  permChannelId: (cid) => {
    const c = channelById.get(cid);
    return c?.type === 'thread' && c.parentId ? c.parentId : cid;
  },
  listChannelLayout: (gid) =>
    joinedGuilds().some((g) => g.id === gid)
      ? CHANNELS.filter((c) => c.guildId === gid && c.type !== 'thread')
        .map((c) => ({ id: c.id, categoryId: c.categoryId ?? null, position: c.position, announcement: !!c.announcement }))
      : [],
  canAccessGuild: (pid, gid) => permissions.couldAccessGuild(pid, gid, (cid) => channelById.get(cid)?.guildId === gid),
  // No agents run in the preview: nothing to re-send.
  resync: (pid) => {
    console.error(`[preview] resync ${pid}`);
    return 0;
  },
};

let api = new AdminServer(deps, fakeDiscord);
await api.listen();

// ── The front: static panel + /admin proxy + dev routes ──

const PANEL = normalize(fileURLToPath(new URL('../../portal-admin/', import.meta.url)));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
};

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function send(res: ServerResponse, status: number, text: string, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';

function proxy(req: IncomingMessage, res: ServerResponse) {
  const up = httpRequest(
    { host: '127.0.0.1', port: api.boundPort, method: req.method, path: req.url, headers: req.headers },
    (r) => {
      const headers = { ...r.headers };
      // Discord's consent screen → the dev stand-in (same query: state & co).
      const loc = typeof headers.location === 'string' ? headers.location : '';
      if (loc.startsWith(DISCORD_AUTHORIZE)) headers.location = '/dev-authorize' + loc.slice(DISCORD_AUTHORIZE.length);
      res.writeHead(r.statusCode ?? 502, headers);
      r.pipe(res);
    },
  );
  up.on('error', (e) => send(res, 502, `admin API unreachable: ${e.message}`));
  req.pipe(up);
}

function serveStatic(res: ServerResponse, pathname: string) {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'bad path');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = normalize(join(PANEL, rel));
  if (!file.startsWith(PANEL.endsWith(sep) ? PANEL : PANEL + sep)) return send(res, 403, 'forbidden');
  if (!existsSync(file) || statSync(file).isDirectory()) return send(res, 404, 'not found');
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    // As the Caddyfile does for the page: always revalidate it.
    'cache-control': rel === '/index.html' ? 'no-cache' : 'no-store',
  });
  res.end(readFileSync(file));
}

const escapeHtml = (t: string) =>
  t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The stand-in for Discord's consent screen (hold mode): two links, as the
 *  real one has two buttons. Nothing on it comes from the request but the
 *  callback addresses, escaped. */
function consentPage(res: ServerResponse, name: string, allow: string, cancel: string) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize (preview)</title>
<style>body{font:16px system-ui,sans-serif;margin:0;padding:48px 16px;background:#f4f4f6;color:#1d1d22}
main{max-width:420px;margin:auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px #0002}
a{display:inline-block;margin:16px 12px 0 0;padding:10px 18px;border-radius:8px;text-decoration:none}
#allow{background:#4b55d6;color:#fff}#cancel{color:#4b55d6}</style>
<main><h1>Discord (preview stand-in)</h1>
<p>Portal admin wants to know who you are and which servers you manage. Signing in as <b>${escapeHtml(name)}</b>.</p>
<a id="allow" href="${escapeHtml(allow)}">Authorize</a><a id="cancel" href="${escapeHtml(cancel)}">Cancel</a></main>`);
}

async function restartApi() {
  await api.close();
  api = new AdminServer(deps, fakeDiscord);
  await api.listen();
}

const front = createServer((req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);
  const path = url.pathname;
  if (path === '/dev-login') {
    const as = url.searchParams.get('as') ?? '';
    if (!(as in USERS)) return send(res, 400, `Pick a fixture user: /dev-login?as=${Object.keys(USERS).join('|')}`);
    const flag = (name: string) =>
      url.searchParams.get(name) === '1' ? `dev_${name}=1; Path=/; HttpOnly; SameSite=Lax` : `dev_${name}=; Path=/; Max-Age=0`;
    res.writeHead(302, {
      location: '/admin/login',
      'cache-control': 'no-store',
      'set-cookie': [`dev_user=${as}; Path=/; HttpOnly; SameSite=Lax`, flag('deny'), flag('hold')],
    });
    return res.end();
  }
  if (path === '/dev-authorize') {
    const who = cookie(req, 'dev_user');
    if (!who || !(who in USERS)) return send(res, 400, 'No fixture user chosen: start at /dev-login?as=op');
    const state = url.searchParams.get('state') ?? '';
    const back = (q: Record<string, string>) => `/admin/callback?${new URLSearchParams({ ...q, state })}`;
    const allow = back({ code: `dev-${who}` });
    const cancel = back({ error: 'access_denied' });
    if (url.searchParams.get('hold') === '1' || cookie(req, 'dev_hold') === '1') return consentPage(res, USERS[who as UserKey].global_name, allow, cancel);
    const deny = url.searchParams.get('deny') === '1' || cookie(req, 'dev_deny') === '1';
    res.writeHead(302, { location: deny ? cancel : allow, 'cache-control': 'no-store' });
    return res.end();
  }
  if (path === '/dev-restart') {
    restartApi().then(
      () => send(res, 200, 'Admin API restarted over the same stores: every session has ended.\n'),
      (e) => send(res, 500, `restart failed: ${(e as Error).message}\n`),
    );
    return;
  }
  if (path === '/admin' || path.startsWith('/admin/')) return proxy(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  serveStatic(res, path);
});

front.listen(opts.port, '127.0.0.1', () => {
  console.log(`preview ${ORIGIN}/dev-login`);
  console.log(`  sign in as: ${Object.keys(USERS).map((u) => `${ORIGIN}/dev-login?as=${u}`).join('  ')}`);
  console.log(`  scale ${opts.scale} · session ${Math.round(opts.ttlMs / 1000)} s · avatars ${opts.avatars ? 'on' : 'off'}`);
  console.log(`  stores (throwaway): ${dir}`);
});
front.on('error', (e) => die((e as Error).message));

const shutdown = () => {
  front.close();
  api.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── A tiny PNG encoder (solid colour with a lighter disc), for avatars ──

function solidPng(size: number, [r, g, b]: [number, number, number]): Buffer {
  const row = 1 + size * 3;
  const raw = Buffer.alloc(row * size);
  const mid = size / 2;
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const inDisc = (x - mid + 0.5) ** 2 + (y - mid * 0.8) ** 2 < (size * 0.22) ** 2;
      const k = inDisc ? 0.55 : 0;
      const o = y * row + 1 + x * 3;
      raw[o] = Math.round(r + (255 - r) * k);
      raw[o + 1] = Math.round(g + (255 - g) * k);
      raw[o + 2] = Math.round(b + (255 - b) * k);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
