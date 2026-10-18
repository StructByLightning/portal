// The admin panel's effective-access model (src/access.ts) held to what the
// relay enforces: a real Relay, its own AdminDeps wiring and its own capsFor,
// over a fake Discord whose bot is limited in some channels and doesn't have
// one cached at all.
//
// For every persona × channel, of every kind of source — access roles of
// every scope (all, channels, mirror, mirror with per-channel caps), a direct
// grant, a block, a guild-wide level and deny, a persona default, the file
// default, a /ban, another guild's roles, a guild the relay doesn't serve, a
// persona the relay doesn't know:
//   - explain().effective is exactly capsFor();
//   - the sources it names that aren't shadowed add up to resolve();
//   - its policy source is the one explainPolicy picks;
//   - the summary's counts are capsFor's, counted;
//   - the access endpoints' rows are capsFor's;
//   - a preview ({direct}) is what the grant route would make it;
//   - the panel's own guess at a change (portal-admin/lib.js predictDirect,
//     which only decides whether to ask before lowering access) is that
//     preview, and its counting is the summary's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionsBitField } from 'discord.js';
import type { Capability } from '@animalabs/portal-protocol';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';
import type { ChannelMeta } from '../src/discord-bot.js';
import { MirrorCache } from '../src/mirror-cache.js';
import { AdminServer, accessDepsOf, type AdminDeps } from '../src/admin/server.js';
import {
  ALL_CAPS, LEVEL_CAPS, accessSummary, capsLabel, countedLevel, explain, levelOf, zeroCounts, type AccessSource,
} from '../src/access.js';
import { ALL_CAPS as PERMISSIONS_ALL_CAPS } from '../src/permissions.js';
import { LEVEL_CAPS as SLASH_LEVEL_CAPS } from '../src/slash.js';

const F = PermissionsBitField.Flags;
const READ = LEVEL_CAPS.read;
const WRITE = LEVEL_CAPS.write;
const FULL = LEVEL_CAPS.full;

const G1 = 'guild-one';
const G2 = 'guild-two';
const G3 = 'guild-three'; // the bot is in it; the relay doesn't serve it

/** Every permission the relay maps to a capability. */
const ALL_BITS = [
  F.ViewChannel, F.ReadMessageHistory, F.SendMessages, F.SendMessagesInThreads, F.CreatePublicThreads,
  F.AttachFiles, F.AddReactions, F.MentionEveryone, F.ManageMessages, F.ManageChannels, F.Connect, F.Speak,
];

interface Chan { id: string; guildId: string; type: ChannelMeta['type']; parentId?: string; categoryId?: string; bot: bigint[] }
const CHANNELS: Chan[] = [
  { id: 'c-open', guildId: G1, type: 'text', categoryId: 'cat', bot: ALL_BITS },
  { id: 'c-readonly', guildId: G1, type: 'text', categoryId: 'cat', bot: [F.ViewChannel, F.ReadMessageHistory] },
  { id: 'c-hidden', guildId: G1, type: 'text', bot: [] },
  { id: 'c-nosend', guildId: G1, type: 'text', bot: [F.ViewChannel, F.ReadMessageHistory, F.AddReactions, F.MentionEveryone] },
  { id: 'c-voice', guildId: G1, type: 'voice', categoryId: 'cat', bot: ALL_BITS },
  { id: 'c-forum', guildId: G1, type: 'forum', bot: [F.ViewChannel, F.ReadMessageHistory, F.SendMessages, F.SendMessagesInThreads] },
  // A kind the relay doesn't name (a stage or media channel): it serves it all the same.
  { id: 'c-stage', guildId: G1, type: 'unknown', categoryId: 'cat', bot: ALL_BITS },
  { id: 'cat', guildId: G1, type: 'category', bot: ALL_BITS },
  { id: 'th', guildId: G1, type: 'thread', parentId: 'c-open', bot: ALL_BITS },
  { id: 'c2', guildId: G2, type: 'text', bot: ALL_BITS },
  { id: 'c3', guildId: G3, type: 'text', bot: ALL_BITS },
];
/** A channel the persona has a grant on, but Discord's cache doesn't hold. */
const UNCACHED = 'c-gone';

/** What each Discord role of G1 may do in each channel (the mirror cache). */
const DISCORD_ROLES: Record<string, Record<string, Capability[]>> = {
  'dr-mods': { 'c-open': FULL, 'c-readonly': WRITE, 'c-nosend': WRITE, 'c-hidden': READ },
  'dr-everyone': { 'c-open': READ, 'c-voice': [...READ, 'VOICE_LISTEN', 'VOICE_SPEAK'] },
};

const ROLES = {
  'r-all': { caps: READ, scope: { all: true }, guildId: G1 },
  'r-chans': { caps: WRITE, scope: { channels: ['c-open', 'c-readonly', 'c-nosend'] }, guildId: G1 },
  'r-mirror': { caps: WRITE, scope: { mirrorRole: 'dr-mods' }, guildId: G1 },
  'r-mirrorcaps': { caps: [...FULL, 'VOICE_LISTEN'], scope: { mirrorRoles: ['dr-mods', 'dr-everyone'] }, guildId: G1, mirrorCaps: true },
  'r-g2': { caps: WRITE, scope: { all: true }, guildId: G2 },
  'r-g3': { caps: WRITE, scope: { all: true }, guildId: G3 },
};

const PERSONAS: Record<string, unknown> = {
  'p-roles': { roles: ['r-all', 'r-chans', 'r-g2'] },
  'p-mirror': { roles: ['r-mirror'] },
  'p-mcaps': { roles: ['r-mirrorcaps'] },
  'p-direct': { policy: { default: [], guilds: { [G1]: { channels: {
    'c-open': FULL, 'c-readonly': WRITE, 'c-hidden': READ, [UNCACHED]: WRITE, th: WRITE, cat: READ,
    'c-nosend': [...WRITE, 'MENTION_EVERYONE'], 'c-stage': WRITE, // c-stage: what slash /add stores when run in its chat

  } } } } },
  'p-guildwide': { roles: ['r-chans'], policy: { default: [], guilds: { [G1]: { default: WRITE, channels: { 'c-open': [], 'c-voice': READ } } } } },
  'p-deny': { policy: { default: READ, guilds: { [G1]: { default: [], channels: { 'c-forum': WRITE } } } } },
  'p-pdefault': { policy: { default: [...READ, 'MENTION_EVERYONE'], guilds: { [G2]: { default: [] } } } },
  // The legacy shape: a persona default, and a guild entry with channels only
  // (its persona default still applies in G1's other channels).
  'p-legacy': { default: READ, guilds: { [G1]: { channels: { 'c-voice': [...READ, 'VOICE_LISTEN', 'VOICE_SPEAK'], 'c-forum': [] } } } },
  'p-banned': { roles: ['r-all', 'r-g2'], policy: { default: READ, guilds: { [G1]: { default: [] } } }, bans: [G1] },
  'p-ghost': { roles: ['r-all'] }, // a permissions entry, but the relay doesn't know this persona
  'p-g3': { roles: ['r-g3'] },
  'p-custom': { policy: { default: [], guilds: { [G1]: { channels: { 'c-open': ['SEND_MESSAGES', 'ADD_REACTIONS'] } } } } },
  // A legacy grant on a thread only: a thread uses its parent's access, so it gives nothing.
  'p-thread': { policy: { default: [], guilds: { [G1]: { channels: { th: WRITE } } } } },
  // Guild-wide Write, blocked in c-open ('Block guild-wide here').
  'p-blocked': { policy: { default: [], guilds: { [G1]: { default: WRITE, channels: { 'c-open': [] } } } } },
  // p-none has no entry: the file default applies to it everywhere.
};
const IDENTITIES = ['p-roles', 'p-mirror', 'p-mcaps', 'p-direct', 'p-guildwide', 'p-deny', 'p-pdefault', 'p-legacy', 'p-banned', 'p-g3', 'p-custom', 'p-thread', 'p-blocked', 'p-none'];
const EVERYONE = [...IDENTITIES, 'p-ghost', 'p-nobody'];
const FILE_DEFAULT: Capability[] = ['VIEW_CHANNEL', 'READ_HISTORY'];

function meta(c: Chan): ChannelMeta {
  return { id: c.id, name: c.id, type: c.type, guildId: c.guildId, isThread: c.type === 'thread', ...(c.parentId ? { parentId: c.parentId } : {}) };
}

/** A Relay (with the admin API's deps wired as in production) over a fake bot. */
function makeRelay() {
  const dir = mkdtempSync(join(tmpdir(), 'portal-access-'));
  const identityPath = join(dir, 'identity.json');
  const permissionsPath = join(dir, 'permissions.json');
  writeFileSync(identityPath, JSON.stringify({ personas: IDENTITIES.map((id) => ({ id, displayName: id.slice(2), avatar: '', token: `tok-${id}` })) }));
  writeFileSync(permissionsPath, JSON.stringify({ default: FILE_DEFAULT, roles: ROLES, personas: PERSONAS }));
  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [G1, G2],
    identityPath, permissionsPath,
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
    admin: {
      port: 0, oauthClientId: 'cid', oauthClientSecret: 'sec', redirectUri: 'https://example.test/admin/callback',
      postLoginUrl: '/done', superadmins: ['op'], guildAdmins: {}, sessionTtlMs: 60_000,
      auditPath: join(dir, 'audit.jsonl'), cookieSecure: false,
    },
  };
  const relay = new Relay(config) as any;
  const joined = [G1, G2, G3];
  const allowed = [G1, G2];
  relay.bot = {
    channelForPerms: (id: string) => {
      const c = CHANNELS.find((x) => x.id === id);
      return c ? { guildId: c.guildId, permissionsFor: () => new PermissionsBitField(c.bot) } : undefined;
    },
    meIn: (g: string) => (joined.includes(g) ? { id: 'bot' } : null),
    isGuildAllowed: (g: string) => allowed.includes(g),
    listGuilds: () => joined.filter((g) => allowed.includes(g)).map((id) => ({ id, name: id, memberCount: 1 })),
    listAllGuilds: () => joined.map((id) => ({ id, name: id, memberCount: 1, allowed: allowed.includes(id) })),
    listChannelMetas: (g: string) => CHANNELS.filter((c) => c.guildId === g).map(meta),
    listChannelLayout: (g: string) =>
      CHANNELS.filter((c) => c.guildId === g && c.type !== 'thread').map((c, i) => ({ id: c.id, categoryId: c.categoryId ?? null, position: i, announcement: false })),
    channelMetaFromCache: (id: string) => {
      const c = CHANNELS.find((x) => x.id === id);
      return c ? meta(c) : null;
    },
    fetchChannelMetaUncached: async () => 'deleted',
    roleCapsByChannel: (g: string, r: string) =>
      new Map(Object.entries(g === G1 ? (DISCORD_ROLES[r] ?? {}) : {}).map(([cid, caps]) => [cid, new Set(caps)])),
    everyoneRoleId: () => 'dr-everyone',
    listRoles: (g: string) => (g === G1 ? Object.keys(DISCORD_ROLES).map((id) => ({ id, guildId: G1, name: id, pooled: false })) : []),
    roleLabel: (id: string) => (DISCORD_ROLES[id] ? { name: id, guildId: G1 } : null),
  };
  // The mirror cache asks the bot it was made with: give it this one.
  relay.mirror = new MirrorCache(relay.bot);
  const deps: AdminDeps = relay.admin.deps;
  const capsFor = (pid: string, cid: string, gid: string): Capability[] => relay.capsFor(pid, cid, gid);
  return { relay, deps, capsFor, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Every channel the parity runs over: each with its guild, and the uncached one in G1. */
const PAIRS = [...CHANNELS.map((c) => ({ cid: c.id, gid: c.guildId })), { cid: UNCACHED, gid: G1 }];

const shadowed = (s: AccessSource) => 'shadowedBy' in s && s.shadowedBy !== undefined;
const capsOf = (s: AccessSource): Capability[] => ('caps' in s ? s.caps : []);
const sorted = (xs: Iterable<string>) => [...xs].sort();

test('access.ts holds the relay’s own capability tables (slash and permissions re-export them)', () => {
  assert.equal(PERMISSIONS_ALL_CAPS, ALL_CAPS);
  assert.equal(SLASH_LEVEL_CAPS, LEVEL_CAPS);
  assert.equal(capsLabel(WRITE), 'write');
  assert.equal(capsLabel(['VIEW_CHANNEL', 'SEND_MESSAGES']), 'VIEW_CHANNEL, SEND_MESSAGES');
  assert.equal(capsLabel([]), 'none');
  assert.deepEqual(levelOf([...WRITE, 'MENTION_EVERYONE']), { level: 'custom', base: 'write', extra: ['MENTION_EVERYONE'] });
  assert.deepEqual(levelOf(['SEND_MESSAGES']), { level: 'custom', base: null, extra: ['SEND_MESSAGES'] });
  assert.deepEqual(levelOf(FULL), { level: 'full', base: 'full', extra: [] });
  assert.deepEqual(levelOf([]), { level: 'none', base: null, extra: [] });
});

test('parity: explain().effective is exactly capsFor() for every persona × channel, every kind of source', () => {
  const t = makeRelay();
  try {
    const a = accessDepsOf(t.deps);
    const kinds = new Set<string>();
    let limited = 0;
    for (const pid of EVERYONE) {
      for (const { cid, gid } of PAIRS) {
        const ex = explain(a, pid, gid, cid);
        const enforced = t.capsFor(pid, cid, gid);
        assert.deepEqual(ex.effective, enforced, `${pid} in ${cid}`);
        assert.deepEqual({ level: ex.level, base: ex.base, extra: ex.extra }, levelOf(enforced), `${pid} in ${cid}: level`);
        // The bot's half: what the policy gives and the bot can't do.
        if (ex.botLimited) limited++;
        assert.deepEqual(sorted([...ex.effective, ...ex.botLacks]), sorted(t.relay.identity.get(pid) && gid !== G3 ? ex.policyCaps : ex.effective), `${pid} in ${cid}: effective + botLacks = policy`);
        for (const s of ex.sources) kinds.add(s.kind + ('how' in s ? ':' + s.how + (s.mirrorCaps ? '+caps' : '') : ''));
      }
    }
    for (const k of ['removed', 'direct', 'block', 'role:all', 'role:channels', 'role:mirror', 'role:mirror+caps', 'guildWide', 'personaDefault', 'relayDefault']) {
      assert.ok(kinds.has(k), `the fixture exercises ${k} (saw ${[...kinds].join(', ')})`);
    }
    assert.ok(limited > 0, 'the fixture exercises the bot’s limits');
  } finally {
    t.cleanup();
  }
});

test('parity: the sources that aren’t shadowed add up to resolve(), and the policy source is explainPolicy’s', () => {
  const t = makeRelay();
  try {
    const a = accessDepsOf(t.deps);
    const P = t.deps.permissions;
    for (const pid of EVERYONE) {
      for (const { cid, gid } of PAIRS) {
        const ex = explain(a, pid, gid, cid);
        const union = new Set(ex.sources.filter((s) => !shadowed(s)).flatMap(capsOf));
        assert.deepEqual(sorted(union), sorted(P.resolve(pid, gid, cid)), `${pid} in ${cid}`);
        assert.deepEqual(ex.policyCaps, ALL_CAPS.filter((c) => P.resolve(pid, gid, cid).has(c)));
        // Only G's own access roles are ever named.
        for (const s of ex.sources) if (s.kind === 'role') assert.equal(P.getRole(s.name)?.guildId, gid, `${pid} in ${cid}: ${s.name}`);
        const pol = P.getPolicy(pid);
        if (!pol || P.isBanned(pid, gid)) continue;
        const why = P.explainPolicy(pol, gid, cid);
        const live = ex.sources.filter((s) => !shadowed(s) && ['direct', 'block', 'guildWide', 'personaDefault'].includes(s.kind));
        const expectKind = { channel: ['direct', 'block'], guildDefault: ['guildWide'], personaDefault: ['personaDefault'] }[why.source];
        if (why.source === 'personaDefault' && !why.caps.length) assert.deepEqual(live, [], `${pid} in ${cid}`);
        else {
          assert.equal(live.length, 1, `${pid} in ${cid}: one policy source decides`);
          assert.ok(expectKind.includes(live[0].kind), `${pid} in ${cid}: ${live[0].kind} for ${why.source}`);
          assert.deepEqual(sorted(capsOf(live[0])), sorted(why.caps));
        }
      }
    }
    // resolvePolicy is explainPolicy's caps.
    assert.deepEqual(P.explainPolicy({ default: READ, guilds: { [G1]: { channels: { x: [] } } } }, G1, 'x'), { source: 'channel', caps: [] });
    assert.deepEqual(P.explainPolicy({ default: READ, guilds: { [G1]: { default: [] } } }, G1, 'x'), { source: 'guildDefault', caps: [] });
    assert.deepEqual(P.explainPolicy({ default: READ, guilds: { [G1]: { channels: { y: WRITE } } } }, G1, 'x'), { source: 'personaDefault', caps: READ });
  } finally {
    t.cleanup();
  }
});

test('parity: the summary counts what capsFor allows, channel by channel and persona by persona', () => {
  const t = makeRelay();
  try {
    const a = accessDepsOf(t.deps);
    for (const gid of [G1, G2, G3]) {
      const channelIds = CHANNELS.filter((c) => c.guildId === gid && c.type !== 'thread' && c.type !== 'category').map((c) => c.id);
      const s = accessSummary(a, gid, channelIds, EVERYONE, 100_000);
      assert.equal(s.considered, EVERYONE.length);
      for (const [i, cid] of channelIds.entries()) {
        const want = zeroCounts();
        for (const pid of EVERYONE) {
          const level = countedLevel(t.capsFor(pid, cid, gid));
          if (level) want[level]++;
        }
        assert.deepEqual(s.channels[i].counts, want, `${gid} ${cid}`);
        const bot = t.deps.botCaps(gid, cid);
        assert.equal(s.channels[i].botBase, levelOf(bot).base);
        assert.equal(s.channels[i].botCantView, !bot.includes('VIEW_CHANNEL'));
      }
      for (const [i, pid] of EVERYONE.entries()) {
        const want = zeroCounts();
        for (const cid of channelIds) {
          const level = countedLevel(t.capsFor(pid, cid, gid));
          if (level) want[level]++;
        }
        assert.deepEqual(s.personas[i].counts, want, `${gid} ${pid}`);
      }
    }
    const capped = accessSummary(a, G1, ['c-open', 'c-readonly'], EVERYONE, EVERYONE.length * 2 - 1);
    assert.equal(capped.truncated, true);
    assert.ok(capped.channels.every((c) => !('counts' in c)) && capped.personas.every((p) => !('counts' in p)));
  } finally {
    t.cleanup();
  }
});

test('parity: a preview ({direct}) is what the grant route then makes it', async () => {
  const cases: Array<[string, string, Capability[] | null]> = [
    ['p-banned', 'c-open', WRITE], // a grant lifts the ban
    ['p-banned', 'c-open', []], // a block doesn't
    ['p-none', 'c-readonly', WRITE], // a first entry starts from the file default
    ['p-none', 'c-open', null], // removing nothing changes nothing
    ['p-guildwide', 'c-open', null], // removing a block: the guild-wide level is back
    ['p-direct', 'c-nosend', FULL],
    ['p-legacy', 'c-forum', null],
    ['p-mcaps', 'c-voice', READ],
  ];
  for (const [pid, cid, caps] of cases) {
    const t = makeRelay();
    try {
      const a = accessDepsOf(t.deps);
      const preview = explain(a, pid, G1, cid, { direct: caps });
      // As setGrant / clearGrant do it.
      const P = t.deps.permissions;
      if (caps === null) P.clearChannel(pid, G1, cid);
      else {
        if (caps.length) P.liftBan(pid, G1);
        P.setChannel(pid, G1, cid, caps);
      }
      assert.deepEqual(preview.effective, t.capsFor(pid, cid, G1), `${pid} ${cid} ${JSON.stringify(caps)}`);
      assert.deepEqual(preview.direct, caps === null ? null : ALL_CAPS.filter((c) => caps.includes(c)));
      // And what it says about the persona now is what it says without a preview.
      const now = explain(a, pid, G1, cid);
      assert.deepEqual(now.effective, preview.effective);
      assert.deepEqual(now.sources, preview.sources);
    } finally {
      t.cleanup();
    }
  }
});

test('parity: the access endpoints, over the relay’s own wiring, show capsFor', async () => {
  const t = makeRelay();
  const fakeDiscord = (async (url: string | URL) => {
    const u = String(url);
    const body = u.endsWith('/oauth2/token') ? { access_token: 'x', token_type: 'Bearer' } : u.endsWith('/users/@me') ? { id: 'op', username: 'op' } : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const server = new AdminServer(t.deps, fakeDiscord);
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const login = await fetch(`${base}/admin/login`, { redirect: 'manual' });
    const [, stateCookie, state] = /(portal_admin_state_[0-9a-f]{16})=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')!;
    const cb = await fetch(`${base}/admin/callback?code=c&state=${state}`, { redirect: 'manual', headers: { cookie: `${stateCookie}=${state}` } });
    const cookie = `portal_admin_session=${/portal_admin_session=([^;]+)/.exec(cb.headers.get('set-cookie') ?? '')![1]}`;
    const get = async (path: string) => {
      const r = await fetch(base + path, { headers: { cookie } });
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get('server-timing') ?? '', /^access;dur=\d+(\.\d+)?$/, path);
      return r.json();
    };
    // Every channel with access of its own: c-stage, of a kind the panel
    // can't give access on, too — the relay serves it with capsFor's caps.
    const holding = CHANNELS.filter((c) => c.guildId === G1 && c.type !== 'thread' && c.type !== 'category');
    assert.ok(holding.some((c) => c.type === 'unknown'));
    for (const c of holding) {
      const body = await get(`/admin/g/${G1}/channels/${c.id}/access`);
      assert.deepEqual(body.botCaps, t.deps.botCaps(G1, c.id));
      for (const pid of IDENTITIES) {
        const row = body.rows.find((r: any) => r.personaId === pid);
        const enforced = t.capsFor(pid, c.id, G1);
        const hasDirect = !!(t.deps.permissions.getPolicy(pid)?.guilds?.[G1]?.channels ?? {})[c.id];
        if (!enforced.length && !hasDirect) assert.equal(row, undefined, `${pid} in ${c.id}: no row`);
        else assert.deepEqual(row?.effective, enforced, `${pid} in ${c.id}`);
      }
    }
    for (const pid of IDENTITIES) {
      const body = await get(`/admin/g/${G1}/personas/${pid}/access`);
      for (const c of holding) {
        const row = body.rows.find((r: any) => r.channelId === c.id);
        const enforced = t.capsFor(pid, c.id, G1);
        if (enforced.length) assert.deepEqual(row?.effective, enforced, `${pid} in ${c.id}`);
        else if (row) assert.deepEqual(row.effective, [], `${pid} in ${c.id}`);
        // A direct grant there is a row, never “inactive”, whatever the kind.
        const own = (t.deps.permissions.getPolicy(pid)?.guilds?.[G1]?.channels ?? {})[c.id];
        if (own && (own.length || t.capsFor(pid, c.id, G1).length)) assert.ok(row, `${pid}: its grant in ${c.id} is a row`);
        if (own?.length) assert.ok(!body.inactive.some((x: any) => x.channelId === c.id), `${pid}: its grant in ${c.id} isn’t inactive`);
      }
    }
    const summary = await get(`/admin/g/${G1}/access/summary`);
    for (const ch of summary.channels) {
      const want = zeroCounts();
      for (const pid of IDENTITIES) {
        const level = countedLevel(t.capsFor(pid, ch.id, G1));
        if (level) want[level]++;
      }
      assert.deepEqual(ch.counts, want, ch.id);
    }
    assert.deepEqual(summary.channels.map((c: any) => c.id).sort(), holding.map((c) => c.id).sort(), 'every channel with access of its own, nothing else');
    for (const pid of IDENTITIES) {
      const want = zeroCounts();
      for (const c of holding) {
        const level = countedLevel(t.capsFor(pid, c.id, G1));
        if (level) want[level]++;
      }
      const got = summary.personas.find((p: any) => p.id === pid);
      if (got) assert.deepEqual(got.counts, want, pid);
      else assert.deepEqual(want, zeroCounts(), `${pid}: left out only when it can act nowhere`);
    }
  } finally {
    await server.close();
    t.cleanup();
  }
});

test('parity: a grant change answers with what the relay enforces where it was made — a thread with its channel’s, a channel that is gone with nothing', async () => {
  const t = makeRelay();
  const fakeDiscord = (async (url: string | URL) => {
    const u = String(url);
    const body = u.endsWith('/oauth2/token') ? { access_token: 'x', token_type: 'Bearer' } : u.endsWith('/users/@me') ? { id: 'op', username: 'op' } : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const server = new AdminServer(t.deps, fakeDiscord);
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const login = await fetch(`${base}/admin/login`, { redirect: 'manual' });
    const [, stateCookie, state] = /(portal_admin_state_[0-9a-f]{16})=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')!;
    const cb = await fetch(`${base}/admin/callback?code=c&state=${state}`, { redirect: 'manual', headers: { cookie: `${stateCookie}=${state}` } });
    const cookie = `portal_admin_session=${/portal_admin_session=([^;]+)/.exec(cb.headers.get('set-cookie') ?? '')![1]}`;
    const { csrf } = await (await fetch(`${base}/admin/me`, { headers: { cookie } })).json();
    const remove = async (pid: string, cid: string) => {
      const r = await fetch(`${base}/admin/g/${G1}/personas/${pid}/grants?channelId=${encodeURIComponent(cid)}`, { method: 'DELETE', headers: { cookie, 'x-csrf-token': csrf } });
      assert.equal(r.status, 200, `${pid} ${cid}`);
      return (await r.json()).effective;
    };
    // p-direct holds a direct grant on every kind of channel: a thread (its
    // grant first, while the parent's own grant still gives Full), the
    // channel Discord's cache doesn't hold, a category, and text channels.
    const pid = 'p-direct';
    const held = Object.keys(t.deps.permissions.getPolicy(pid)!.guilds![G1].channels!);
    const order = ['th', UNCACHED, 'cat', ...held.filter((c) => !['th', UNCACHED, 'cat'].includes(c))];
    assert.deepEqual([...order].sort(), [...held].sort());
    const seen = new Set<string>();
    for (const cid of order) {
      const effective = await remove(pid, cid);
      const meta: ChannelMeta | null = t.relay.bot.channelMetaFromCache(cid);
      if (!meta) {
        assert.deepEqual(effective, { missing: true }, `${cid}: no channel, nothing to explain`);
        seen.add('missing');
        continue;
      }
      // The relay's own answer for what the persona can do there: its
      // channel directory entry, read where the relay checks access.
      const relaySays = t.relay.toPortalChannel(meta, pid).capabilities;
      assert.deepEqual(effective.effective, relaySays, cid);
      if (meta.isThread) {
        assert.equal(effective.parentId, meta.parentId, `${cid}: its parent’s access`);
        assert.deepEqual(effective.effective, FULL, `${cid}: the parent’s direct Full still reaches it`);
        assert.notDeepEqual(t.capsFor(pid, cid, G1), relaySays, 'the thread id on its own would say otherwise');
        seen.add('thread');
      } else {
        assert.equal('parentId' in effective, false, cid);
        seen.add(meta.type);
      }
    }
    assert.deepEqual([...seen].sort(), ['category', 'missing', 'text', 'thread', 'unknown']);
  } finally {
    await server.close();
    t.cleanup();
  }
});

test('parity: every capability gate on a thread id checks its channel — as the directory, sending and the panel do', () => {
  const t = makeRelay();
  try {
    const allows = (pid: string, cid: string, cap: Capability) => {
      try {
        t.relay.requireCap(pid, cid, cap);
        return true;
      } catch (e) {
        assert.equal((e as { code?: string }).code, 'FORBIDDEN');
        return false;
      }
    };
    const thMeta = t.relay.bot.channelMetaFromCache('th');
    let differs = 0;
    for (const pid of EVERYONE) {
      const parent = t.capsFor(pid, 'c-open', G1);
      // The directory's caps for the thread (what list_channels and identify send) are its parent's.
      assert.deepEqual(t.relay.toPortalChannel(thMeta, pid).capabilities, parent, `${pid}: directory`);
      for (const cap of ALL_CAPS) {
        // list_pins, subscribe_channel, channel_missed, create_thread, delete_channel, voice_*, edits and reactions all go through requireCap.
        assert.equal(allows(pid, 'th', cap), parent.includes(cap), `${pid} ${cap} on the thread`);
      }
      assert.equal(t.relay.canSubscribe(pid, 'th'), parent.includes('VIEW_CHANNEL'), `${pid}: canSubscribe`);
      if (!sameSet(t.capsFor(pid, 'th', G1), parent)) differs++;
    }
    assert.ok(differs > 0, 'the fixture has personas whose thread id alone would say otherwise');
    // A grant on the thread only gives nothing there (the panel lists it as doing nothing) …
    assert.deepEqual(t.capsFor('p-thread', 'th', G1), WRITE, 'capsFor on the raw thread id would give Write');
    assert.equal(allows('p-thread', 'th', 'READ_HISTORY'), false);
    // … and a guild-wide level blocked in the channel is blocked in its threads too.
    assert.deepEqual(t.capsFor('p-blocked', 'c-open', G1), []);
    assert.deepEqual(t.capsFor('p-blocked', 'th', G1), WRITE, 'the raw thread id would give the guild-wide Write');
    assert.equal(allows('p-blocked', 'th', 'READ_HISTORY'), false);
    assert.equal(t.relay.canSubscribe('p-blocked', 'th'), false);
    // A channel that isn't a thread is checked as itself.
    assert.equal(allows('p-direct', 'c-readonly', 'READ_HISTORY'), t.capsFor('p-direct', 'c-readonly', G1).includes('READ_HISTORY'));
  } finally {
    t.cleanup();
  }
});

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** portal-admin/lib.js, in an empty sandbox (it is the panel's pure code). */
function panelLib(): any {
  const ctx = vm.createContext({}) as Record<string, any>;
  vm.runInContext(readFileSync(new URL('../../portal-admin/lib.js', import.meta.url), 'utf8'), ctx, { filename: 'lib.js' });
  return ctx.PA.lib;
}
const plainOf = (v: unknown) => JSON.parse(JSON.stringify(v));

test('parity: the panel’s guess at a direct-grant change (lib.predictDirect) is the relay’s own preview, for every persona × channel × change', () => {
  const t = makeRelay();
  try {
    const lib = panelLib();
    const a = accessDepsOf(t.deps);
    const changes: Array<Capability[] | null> = [null, [], READ, WRITE, FULL, ['SEND_MESSAGES', 'ADD_REACTIONS'], [...WRITE, 'MENTION_EVERYONE'], [...READ, 'VOICE_LISTEN', 'VOICE_SPEAK']];
    const grantable = CHANNELS.filter((c) => c.guildId === G1 && ['text', 'voice', 'forum'].includes(c.type));
    let n = 0;
    const kinds = new Set<string>();
    for (const pid of IDENTITIES) {
      for (const c of grantable) {
        // The row the channel drawer reads (its fields, as JSON carries them).
        const ex = explain(a, pid, G1, c.id);
        const row = plainOf({ effective: ex.effective, direct: ex.direct, sources: ex.sources, botLimited: ex.botLimited, botLacks: ex.botLacks });
        const from = lib.changeKind(row, t.deps.botCaps(G1, c.id), WRITE).from;
        if (from) kinds.add(from);
        for (const d of changes) {
          const want = explain(a, pid, G1, c.id, { direct: d }).effective;
          const got = plainOf(lib.predictDirect(row, t.deps.botCaps(G1, c.id), d));
          assert.deepEqual(got, want, `${pid} in ${c.id} with ${JSON.stringify(d)}`);
          n++;
        }
      }
    }
    assert.ok(n > 500, `${n} cases`);
    for (const k of ['direct', 'guildWide', 'personaDefault', 'relayDefault']) assert.ok(kinds.has(k), `the fixture has a persona whose own access comes from ${k}`);
  } finally {
    t.cleanup();
  }
});

test('parity: the panel counts a channel’s rows as the summary counts it (lib.countedLevel, lib.countsFromRows)', async () => {
  const lib = panelLib();
  for (const caps of [[], READ, WRITE, FULL, [...WRITE, 'MENTION_EVERYONE'], ['SEND_MESSAGES'], ['VIEW_CHANNEL'], ['EDIT_OWN', 'DELETE_OWN'], ALL_CAPS]) {
    assert.equal(lib.countedLevel(caps), countedLevel(caps as Capability[]), JSON.stringify(caps));
  }
  const t = makeRelay();
  const fakeDiscord = (async (url: string | URL) => {
    const u = String(url);
    const body = u.endsWith('/oauth2/token') ? { access_token: 'x', token_type: 'Bearer' } : u.endsWith('/users/@me') ? { id: 'op', username: 'op' } : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const server = new AdminServer(t.deps, fakeDiscord);
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const login = await fetch(`${base}/admin/login`, { redirect: 'manual' });
    const [, stateCookie, state] = /(portal_admin_state_[0-9a-f]{16})=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')!;
    const cb = await fetch(`${base}/admin/callback?code=c&state=${state}`, { redirect: 'manual', headers: { cookie: `${stateCookie}=${state}` } });
    const cookie = `portal_admin_session=${/portal_admin_session=([^;]+)/.exec(cb.headers.get('set-cookie') ?? '')![1]}`;
    const get = async (path: string) => (await fetch(base + path, { headers: { cookie } })).json();
    const summary = await get(`/admin/g/${G1}/access/summary`);
    for (const ch of summary.channels) {
      const body = await get(`/admin/g/${G1}/channels/${ch.id}/access`);
      assert.deepEqual(plainOf(lib.countsFromRows(body.rows)), ch.counts, ch.id);
    }
  } finally {
    await server.close();
    t.cleanup();
  }
});
