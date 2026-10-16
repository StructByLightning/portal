// Inline mirror grants (invite `grant` with a mirrorRole/mirrorRoles scope)
// materialize as shared content-addressed access roles at enroll/claim time,
// so they resolve LIVE against Discord visibility. Pins the regression that
// motivated this: a channel created AFTER enrollment must become visible to
// the persona without any re-enroll or policy hand-edit (the old snapshot
// behavior froze the channel list at enroll time and new rooms stayed
// invisible until an operator noticed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.js';
import type { RelayConfig } from '../src/config.js';

const GUILD = 'g1';
const CHAN_A = 'chan-a';
const CHAN_NEW = 'chan-new'; // created "after enrollment" in the live test
const DISCORD_ROLE = 'dr-everyone';
const EXISTING = 'existing-1';
const RW = ['READ_HISTORY', 'SEND_MESSAGES', 'VIEW_CHANNEL'] as const;

function makeRelay() {
  const dir = mkdtempSync(join(tmpdir(), 'portal-mirror-'));
  writeFileSync(
    join(dir, 'identity.json'),
    JSON.stringify({ personas: [{ id: EXISTING, displayName: 'Existing', avatar: '', token: 'tok-e' }] }),
  );
  writeFileSync(
    join(dir, 'permissions.json'),
    JSON.stringify({
      personas: {
        [EXISTING]: { default: [], guilds: { [GUILD]: { default: [], channels: { [CHAN_A]: ['VIEW_CHANNEL'] } } } },
      },
    }),
  );
  writeFileSync(
    join(dir, 'invites.json'),
    JSON.stringify({
      invites: [
        { code: 'mirror-mint', grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } }, guildId: GUILD },
        { code: 'mirror-aug', mode: 'augment', grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } }, guildId: GUILD },
        { code: 'mirror-noguild', mode: 'both', grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } } },
      ],
    }),
  );

  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [GUILD],
    identityPath: join(dir, 'identity.json'),
    permissionsPath: join(dir, 'permissions.json'),
    invitesPath: join(dir, 'invites.json'),
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;

  // What the mirrored Discord role can currently see, per channel: the fake
  // mirror lookup reads this map live, mimicking MirrorCache over a real bot.
  const visible = new Map<string, string[]>([[CHAN_A, [...RW]]]);
  relay.mirror = { lookup: (g: string, r: string) => (g === GUILD && r === DISCORD_ROLE ? visible : new Map()), invalidateGuild: () => {}, invalidateRole: () => {}, flush: () => {} };

  // Discord-side perms wide open so effective caps = pure policy resolution.
  relay.bot = {
    channelForPerms: (cid: string) =>
      cid === CHAN_A || cid === CHAN_NEW
        ? { guildId: GUILD, permissionsFor: () => ({ has: () => true }) }
        : undefined,
    meIn: () => ({}),
    listGuilds: () => [{ id: GUILD, name: 'G', memberCount: 2 }],
    memberNameMatches: () => false,
    membersComplete: () => true,
    listChannelMetas: () => [],
    isGuildAllowed: (gid: string) => gid === GUILD,
  };
  relay.roles = {
    getRoleFor: () => 'role', roleByGuildFor: () => ({}),
    bind: async () => 'role', unbind: async () => {},
  };
  relay.gateway = {
    activePersonas: () => [], streamPersonas: () => [], hasStream: () => false,
    sessionsOf: () => [], personaSubscribed: () => false, dispatch: () => {}, seqOf: () => 0,
  };

  const caps = (pid: string, cid: string) => [...relay.capsFor(pid, cid, GUILD)].sort();
  return { relay, visible, caps, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('enroll with a mirror grant materializes a live access role, not a snapshot', async () => {
  const t = makeRelay();
  try {
    const enrolled = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'newbie' });
    assert.ok(!('error' in enrolled), JSON.stringify(enrolled));
    const pid = enrolled.personaId;

    // Assigned a content-addressed role, no frozen inline channel list.
    const roles = t.relay.permissions.getRoleNames(pid) as string[];
    assert.equal(roles.length, 1);
    assert.match(roles[0], new RegExp(`^mirror-${GUILD}-[0-9a-f]{32}$`));
    const role = t.relay.permissions.getRole(roles[0]);
    assert.deepEqual(role, { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE }, guildId: GUILD });
    assert.equal(t.relay.permissions.getPolicy(pid), undefined);

    // Resolves through the live mirror on the channel visible today...
    assert.deepEqual(t.caps(pid, CHAN_A), [...RW]);

    // ...and — the regression this exists to pin — on a channel created
    // AFTER enrollment, with no re-enroll and no policy edit.
    assert.deepEqual(t.caps(pid, CHAN_NEW), []);
    t.visible.set(CHAN_NEW, [...RW]);
    assert.deepEqual(t.caps(pid, CHAN_NEW), [...RW]);
  } finally {
    t.cleanup();
  }
});

test('identical mirror grants share one catalog role across enrollments', async () => {
  const t = makeRelay();
  try {
    const a = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'first' });
    const b = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'second' });
    assert.ok(!('error' in a) && !('error' in b));
    const [ra] = t.relay.permissions.getRoleNames(a.personaId) as string[];
    const [rb] = t.relay.permissions.getRoleNames(b.personaId) as string[];
    assert.equal(ra, rb);
  } finally {
    t.cleanup();
  }
});

test('augment claim adds the live role and leaves the existing inline policy intact', () => {
  const t = makeRelay();
  try {
    t.relay.applyInviteAugment(EXISTING, 'mirror-aug');
    const roles = t.relay.permissions.getRoleNames(EXISTING) as string[];
    assert.equal(roles.length, 1);
    assert.match(roles[0], new RegExp(`^mirror-${GUILD}-[0-9a-f]{32}$`));
    // Union semantics: mirror caps arrive, the pre-existing channel grant survives.
    assert.deepEqual(t.caps(EXISTING, CHAN_A), [...RW]);
    t.visible.set(CHAN_NEW, [...RW]);
    assert.deepEqual(t.caps(EXISTING, CHAN_NEW), [...RW]);
    const pol = t.relay.permissions.getPolicy(EXISTING);
    assert.deepEqual(pol?.guilds?.[GUILD]?.channels?.[CHAN_A], ['VIEW_CHANNEL']);
  } finally {
    t.cleanup();
  }
});

test('mirror grant without guildId: enroll denies, augment rejects loudly', async () => {
  const t = makeRelay();
  try {
    const before = t.relay.identity.all().length;
    const enrolled = await t.relay.enroll({ invite: 'mirror-noguild', desiredName: 'lost' });
    assert.ok('error' in enrolled, 'refused up front, not a persona with no access');
    assert.match(enrolled.error, /names no guild/);
    assert.equal(t.relay.identity.all().length, before, 'no persona created');
    assert.equal(t.relay.invites.get('mirror-noguild').uses ?? 0, 0, 'no use consumed');

    assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'mirror-noguild'), /names no guild/);
  } finally {
    t.cleanup();
  }
});

test('a rejected augment changes nothing: no roles granted, invite not consumed', () => {
  const t = makeRelay();
  try {
    // Roles plus a mirror grant missing its guild: the whole claim is invalid.
    t.relay.invites.mint({
      code: 'roles-and-bad-mirror', label: 'x', mode: 'augment', maxUses: 1, roles: ['some-role'],
      grant: { caps: ['VIEW_CHANNEL'], scope: { mirrorRole: 'r1' } },
    });
    t.relay.permissions.setRole('some-role', { caps: ['VIEW_CHANNEL'], scope: { all: true }, guildId: GUILD });
    const before = t.relay.permissions.getRoleNames(EXISTING);
    for (let i = 0; i < 2; i++) {
      assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'roles-and-bad-mirror'), /names no guild/);
    }
    assert.deepEqual(t.relay.permissions.getRoleNames(EXISTING), before, 'no roles granted by a rejected claim');
    assert.equal(t.relay.invites.get('roles-and-bad-mirror').uses ?? 0, 0, 'no use consumed');
  } finally {
    t.cleanup();
  }
});

test('a mirror grant reuses only an IDENTICAL access role; a name hit on anything else is refused before any change', async () => {
  const t = makeRelay();
  try {
    // Find the name this grant materializes to, then plant a DIFFERENT role under it.
    const first = await t.relay.enroll({ invite: 'mirror-mint', desiredName: 'probe' });
    const name = t.relay.permissions.getRoleNames(first.personaId)[0];
    t.relay.permissions.setRole(name, { caps: ['MANAGE_MESSAGES'], scope: { all: true }, guildId: 'some-other-guild' });
    t.relay.invites.mint({ code: 'mirror-again', grant: { caps: [...RW], scope: { mirrorRole: DISCORD_ROLE } }, guildId: GUILD } as any);
    const count = t.relay.identity.all().length;
    const res = await t.relay.enroll({ invite: 'mirror-again', desiredName: 'collider' });
    assert.ok('error' in res && /conflicts with an existing access role/.test(res.error));
    assert.equal(t.relay.identity.all().length, count, 'no persona created');
    assert.equal(t.relay.invites.get('mirror-again').uses ?? 0, 0, 'no use consumed');
    assert.throws(() => t.relay.applyInviteAugment(EXISTING, 'mirror-aug'), /conflicts with an existing access role/);
    assert.ok(!t.relay.permissions.getRoleNames(EXISTING).includes(name), 'the foreign role was not handed out');
  } finally {
    t.cleanup();
  }
});

test('augmenting a persona never narrows what it already had', () => {
  const t = makeRelay();
  try {
    const merge = (base: any, add: any) => t.relay.mergePolicy(base, add);
    // Guild default [VIEW, READ]; a channel augment adds SEND on chan-x: that
    // channel keeps VIEW+READ (it would have resolved to the guild default).
    const ch = merge({ default: [], guilds: { G: { default: ['VIEW_CHANNEL', 'READ_HISTORY'] } } },
      { default: [], guilds: { G: { channels: { x: ['SEND_MESSAGES'] } } } });
    assert.deepEqual(ch.guilds.G.channels.x.sort(), ['READ_HISTORY', 'SEND_MESSAGES', 'VIEW_CHANNEL']);
    assert.deepEqual(ch.guilds.G.default, ['VIEW_CHANNEL', 'READ_HISTORY'], 'guild default untouched');
    // A persona-wide default [VIEW, READ, SEND]; an {all} augment for G with [VIEW]
    // must not narrow G to [VIEW].
    const all = merge({ default: ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'] },
      { default: [], guilds: { G: { default: ['VIEW_CHANNEL'] } } });
    assert.deepEqual(all.guilds.G.default.sort(), ['READ_HISTORY', 'SEND_MESSAGES', 'VIEW_CHANNEL']);
    // An {all} augment reaches a narrower existing channel override; an explicit deny stays.
    const reach = merge({ default: [], guilds: { G: { channels: { narrow: ['VIEW_CHANNEL'], denied: [] } } } },
      { default: [], guilds: { G: { default: ['VIEW_CHANNEL', 'SEND_MESSAGES'] } } });
    assert.deepEqual(reach.guilds.G.channels.narrow.sort(), ['SEND_MESSAGES', 'VIEW_CHANNEL']);
    assert.deepEqual(reach.guilds.G.channels.denied, []);
    // A channel-only augment does not pin the guild default (undefined stays transparent).
    const pin = merge({ default: ['VIEW_CHANNEL'] }, { default: [], guilds: { G: { channels: { y: ['SEND_MESSAGES'] } } } });
    assert.equal(pin.guilds.G.default, undefined);
  } finally {
    t.cleanup();
  }
});
