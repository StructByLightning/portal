// Issue #16: channel creation must authorize the destination before using the
// shared bot. Exercise RPC dispatch with real permission resolution and a bot
// that records every attempted create.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, PermissionsBitField } from 'discord.js';
import type { Capability } from '@animalabs/portal-protocol';
import { Relay } from '../src/relay.js';
import { hashToken } from '../src/identity.js';
import { MirrorCache } from '../src/mirror-cache.js';
import type { PermissionsFile, RelayConfig } from '../src/config.js';
import type { Session } from '../src/gateway.js';

const MANAGE: Capability[] = ['MANAGE_CHANNELS'];
const VIEW: Capability[] = ['VIEW_CHANNEL'];
const GUILD = 'g1';
const OTHER_GUILD = 'g2';
const CATEGORY = 'category';
const OTHER_CATEGORY = 'other-category';
const FOREIGN_CATEGORY = 'foreign-category';
const TEXT = 'text';
const THREAD = 'thread';

function makeRelay(t: TestContext, policy: PermissionsFile) {
  const dir = mkdtempSync(join(tmpdir(), 'portal-create-channel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const identityPath = join(dir, 'identity.json');
  const permissionsPath = join(dir, 'permissions.json');
  writeFileSync(identityPath, JSON.stringify({ personas: [
    { id: 'alice', displayName: 'Alice', avatar: '', token: hashToken('tok-a') },
  ] }));
  writeFileSync(permissionsPath, JSON.stringify(policy));
  const config: RelayConfig = {
    discordToken: 'x', wsPort: 0, avatarBaseUrl: '', guildIds: [GUILD, OTHER_GUILD],
    identityPath, permissionsPath,
    rolePool: { size: 1, prefix: 'portal-' }, webhookPoolSize: 1,
    heartbeatIntervalMs: 30_000, guildMembersIntent: false, watchConfig: false,
    historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024,
    allowPathFiles: false, replyLink: false,
  };
  const relay = new Relay(config) as any;
  const state = {
    allowedGuilds: new Set([GUILD, OTHER_GUILD]),
    botInGuild: true,
    onFetch: undefined as (() => void) | undefined,
    guildPerms: new PermissionsBitField(PermissionsBitField.Flags.ManageChannels),
    categoryPerms: new PermissionsBitField(PermissionsBitField.Flags.ManageChannels),
  };
  const channels = new Map([
    [CATEGORY, { guildId: GUILD, type: ChannelType.GuildCategory }],
    [OTHER_CATEGORY, { guildId: GUILD, type: ChannelType.GuildCategory }],
    [FOREIGN_CATEGORY, { guildId: OTHER_GUILD, type: ChannelType.GuildCategory }],
    [TEXT, { guildId: GUILD, type: ChannelType.GuildText }],
    [THREAD, { guildId: GUILD, type: ChannelType.PublicThread }],
  ]);
  // REST can know about channels before the gateway has cached them.
  const remoteChannels = new Map(channels);
  const fetchCalls: string[] = [];
  const calls: unknown[][] = [];
  // The constructor's MirrorCache holds the real, never-logged-in DiscordBot.
  // Mirror lookups see nothing here unless a test sets a lookup or its own cache.
  relay.mirror = { lookup: () => new Map(), invalidateGuild: () => {}, invalidateRole: () => {}, flush: () => {} };
  relay.bot = {
    isGuildAllowed: (id: string) => state.allowedGuilds.has(id),
    meIn: (id: string) =>
      state.botInGuild && (id === GUILD || id === OTHER_GUILD) ? { permissions: state.guildPerms } : null,
    channelForPerms: (id: string) => {
      const channel = channels.get(id);
      return channel && { ...channel, permissionsFor: () => state.categoryPerms };
    },
    getChannelMeta: async (id: string) => {
      fetchCalls.push(id);
      await state.onFetch?.();
      const channel = remoteChannels.get(id);
      if (!channel) return null;
      channels.set(id, channel); // discord.js fetch caches its result
      return { id, guildId: channel.guildId, type: channel.type === ChannelType.GuildCategory ? 'category' : 'text' };
    },
    channelMetaFromCache: () => null, // no thread is cached: every id is checked as itself
    roleCapsByChannel: (guildId: string) => new Map(
      [...channels].filter(([, channel]) => channel.guildId === guildId)
        .map(([id]) => [id, new Set(MANAGE)]),
    ),
    createTextChannel: async (guildId: string, name: string, categoryId?: string) => {
      calls.push([guildId, name, categoryId]);
      const id = 'created-' + calls.length;
      channels.set(id, { guildId, type: ChannelType.GuildText });
      return { id, guildId, name, type: 'text', isThread: false };
    },
  };
  const rpc = async (params: Record<string, unknown>, personaId = 'alice') => {
    const frames: any[] = [];
    const session = { personaId, send: (frame: unknown) => frames.push(frame) } as unknown as Session;
    await relay.handleRpc(session, {
      id: 'create', method: 'create_text_channel', params: { name: 'new-channel', ...params },
    });
    assert.equal(frames.length, 1);
    assert.equal(frames[0].op, 'rpc_result');
    return frames[0].d;
  };
  const denied = async (params: Record<string, unknown>, personaId = 'alice', code = 'FORBIDDEN') => {
    const before = calls.length;
    const response = await rpc(params, personaId);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, code);
    assert.equal(calls.length, before, 'denied RPC must not reach bot.createTextChannel');
  };
  const allowed = async (params: Record<string, unknown>) => {
    const before = calls.length;
    const response = await rpc(params);
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(calls.length, before + 1);
    assert.deepEqual(calls.at(-1), [params.guildId, 'new-channel', params.categoryId]);
    assert.equal(response.result.channel.name, 'new-channel');
    assert.equal(response.result.channel.guildId, params.guildId);
    assert.equal(response.result.channel.type, 'text');
  };
  return { relay, state, channels, remoteChannels, fetchCalls, calls, rpc, denied, allowed };
}

test('no grant or unrelated capabilities cannot create at the root or in a category', async (t) => {
  for (const policy of [
    {},
    { personas: { alice: { default: [] } } },
    { personas: { alice: { default: VIEW } } },
  ] satisfies PermissionsFile[]) {
    const h = makeRelay(t, policy);
    await h.denied({ guildId: GUILD });
    await h.denied({ guildId: GUILD, categoryId: CATEGORY });
  }
});

test('root creation uses unrestricted policy grants and existing default precedence', async (t) => {
  const cases: Array<{ policy: PermissionsFile; allow: boolean }> = [
    { policy: { default: MANAGE }, allow: true },
    { policy: { default: MANAGE, personas: { alice: { default: [] } } }, allow: false },
    { policy: { default: MANAGE, personas: { alice: { roles: [] } } }, allow: false },
    { policy: { personas: { alice: { default: MANAGE } } }, allow: true },
    { policy: { personas: { alice: { default: [], guilds: { [GUILD]: { default: MANAGE } } } } }, allow: true },
    { policy: { personas: { alice: { default: MANAGE, guilds: { [GUILD]: { default: [] } } } } }, allow: false },
    // A channel override has no bearing on an operation at the guild root.
    { policy: { personas: { alice: { default: MANAGE, guilds: { [GUILD]: { channels: { [TEXT]: [] } } } } } }, allow: true },
    { policy: {
      roles: { manager: { guildId: GUILD, scope: { all: true }, caps: MANAGE } },
      personas: { alice: { roles: ['manager'], policy: { default: [] } } },
    }, allow: true },
    { policy: {
      roles: { manager: { guildId: OTHER_GUILD, scope: { all: true }, caps: MANAGE } },
      personas: { alice: { roles: ['manager'] } },
    }, allow: false },
    // The role/inline union is most-permissive, as for channel resolution.
    { policy: {
      roles: { reader: { guildId: GUILD, scope: { all: true }, caps: VIEW } },
      personas: { alice: { roles: ['reader'], policy: { default: MANAGE } } },
    }, allow: true },
  ];
  for (const { policy, allow } of cases) {
    const h = makeRelay(t, policy);
    await (allow ? h.allowed : h.denied)({ guildId: GUILD });
  }
});

test('category grants stay local: inline, channel-scoped roles, and mirrored roles', async (t) => {
  const policies: PermissionsFile[] = [
    { personas: { alice: { default: [], guilds: { [GUILD]: { channels: { [CATEGORY]: MANAGE } } } } } },
    {
      roles: { manager: { guildId: GUILD, scope: { channels: [CATEGORY] }, caps: MANAGE } },
      personas: { alice: { roles: ['manager'] } },
    },
    ...[false, true].map((mirrorCaps): PermissionsFile => ({
      roles: { manager: { guildId: GUILD, scope: { mirrorRole: 'r1' }, caps: MANAGE, mirrorCaps } },
      personas: { alice: { roles: ['manager'] } },
    })),
  ];
  for (const policy of policies) {
    const h = makeRelay(t, policy);
    h.relay.permissions.setMirrorLookup(() => new Map([[CATEGORY, new Set(MANAGE)]]));
    await h.allowed({ guildId: GUILD, categoryId: CATEGORY });
    await h.denied({ guildId: GUILD });
    await h.denied({ guildId: GUILD, categoryId: OTHER_CATEGORY });
    await h.denied({ guildId: OTHER_GUILD, categoryId: FOREIGN_CATEGORY });
  }
});

test('a text-channel grant cannot authorize sibling channels or root creation', async (t) => {
  const h = makeRelay(t, { personas: { alice: {
    default: [], guilds: { [GUILD]: { channels: { [TEXT]: MANAGE } } },
  } } });
  await h.denied({ guildId: GUILD });
  await h.denied({ guildId: GUILD, categoryId: CATEGORY });
  // Passing the manageable text channel as a category is not an escape hatch.
  await h.denied({ guildId: GUILD, categoryId: TEXT });
});

test('category resolution honors inline overrides and full-fidelity mirror masks', async (t) => {
  const h = makeRelay(t, { personas: { alice: {
    default: MANAGE, guilds: { [GUILD]: { channels: { [CATEGORY]: [] } } },
  } } });
  await h.denied({ guildId: GUILD, categoryId: CATEGORY });
  await h.allowed({ guildId: GUILD, categoryId: OTHER_CATEGORY });
  await h.allowed({ guildId: GUILD });

  const mirror = makeRelay(t, {
    roles: { manager: { guildId: GUILD, scope: { mirrorRoles: ['r1', 'r2'] }, caps: MANAGE, mirrorCaps: true } },
    personas: { alice: { roles: ['manager'] } },
  });
  await mirror.denied({ guildId: GUILD, categoryId: CATEGORY }); // no lookup
  mirror.relay.permissions.setMirrorLookup(() => new Map([[CATEGORY, new Set(VIEW)]]));
  await mirror.denied({ guildId: GUILD, categoryId: CATEGORY }); // visible, but no manage bit
  mirror.relay.permissions.setMirrorLookup(() => new Map([[CATEGORY, new Set(MANAGE)]]));
  await mirror.allowed({ guildId: GUILD, categoryId: CATEGORY });
  await mirror.denied({ guildId: GUILD }); // mirror remains channel-scoped
});

test('a role whose scope names all and a mirror is set aside, so it authorizes neither destination', async (t) => {
  // A scope names one kind (roleShapeProblem): loading sets such a role aside, and setRole refuses it.
  for (const mirrorCaps of [true, false]) {
    for (const mirrorScope of [{ mirrorRole: 'r1' }, { mirrorRoles: ['r1', 'r2'] }]) {
      const role = { guildId: GUILD, scope: { all: true, ...mirrorScope }, caps: MANAGE, mirrorCaps };
      const h = makeRelay(t, { roles: { manager: role }, personas: { alice: { roles: ['manager'] } } });
      h.relay.permissions.setMirrorLookup(() => new Map([[CATEGORY, new Set(MANAGE)]]));
      assert.equal(h.relay.permissions.isQuarantined('manager'), true);
      await h.denied({ guildId: GUILD });
      await h.denied({ guildId: GUILD, categoryId: CATEGORY });
      assert.throws(() => h.relay.permissions.setRole('manager', role), /may name only one of/);
    }
  }
});

test('a valid uncached category is fetched before authorization; cached/root paths need no fetch', async (t) => {
  const h = makeRelay(t, { personas: { alice: { default: MANAGE } } });
  h.channels.delete(CATEGORY);
  await h.allowed({ guildId: GUILD, categoryId: CATEGORY });
  assert.deepEqual(h.fetchCalls, [CATEGORY]);
  assert.ok(h.channels.has(CATEGORY));
  await h.allowed({ guildId: GUILD, categoryId: CATEGORY });
  await h.allowed({ guildId: GUILD });
  assert.deepEqual(h.fetchCalls, [CATEGORY]);
});

test('fetching a category refreshes mirror grants cached before it existed', async (t) => {
  for (const mirrorCaps of [false, true]) {
    const h = makeRelay(t, {
      roles: { manager: { guildId: GUILD, scope: { mirrorRole: 'r1' }, caps: MANAGE, mirrorCaps } },
      personas: { alice: { roles: ['manager'] } },
    });
    h.channels.delete(CATEGORY);
    h.relay.mirror = new MirrorCache(h.relay.bot);
    // Warm the real MirrorCache without the new category.
    assert.equal(h.relay.permissions.resolve('alice', GUILD, CATEGORY).size, 0);
    await h.allowed({ guildId: GUILD, categoryId: CATEGORY });
    assert.deepEqual(h.fetchCalls, [CATEGORY]);
    await h.denied({ guildId: GUILD }); // still local after the refresh
  }
});

test('fetched destinations still require category type, guild membership, and manage authority', async (t) => {
  for (const categoryId of [TEXT, THREAD, FOREIGN_CATEGORY, 'unfetchable']) {
    const h = makeRelay(t, { default: MANAGE });
    h.channels.delete(categoryId);
    await h.denied({ guildId: GUILD, categoryId });
    assert.deepEqual(h.fetchCalls, [categoryId]);
  }
  const h = makeRelay(t, { personas: { alice: { default: VIEW } } });
  h.channels.delete(CATEGORY);
  await h.denied({ guildId: GUILD, categoryId: CATEGORY });
  assert.deepEqual(h.fetchCalls, [CATEGORY]);
});

test('authorization revoked during a category fetch prevents creation', async (t) => {
  for (const revoke of [
    (h: ReturnType<typeof makeRelay>) => h.relay.identity.remove('alice'),
    (h: ReturnType<typeof makeRelay>) => h.state.allowedGuilds.clear(),
    (h: ReturnType<typeof makeRelay>) => h.relay.permissions.setPersonaDefault('alice', []),
    (h: ReturnType<typeof makeRelay>) => { h.state.categoryPerms = new PermissionsBitField(); },
  ]) {
    const h = makeRelay(t, { personas: { alice: { default: MANAGE } } });
    h.channels.delete(CATEGORY);
    h.state.onFetch = () => { revoke(h); };
    await h.denied({ guildId: GUILD, categoryId: CATEGORY });
    assert.deepEqual(h.fetchCalls, [CATEGORY]);
  }
});

test('cached/root creation invokes the bot before returning control for a revocation', async (t) => {
  for (const categoryId of [undefined, CATEGORY]) {
    const h = makeRelay(t, { personas: { alice: { default: MANAGE } } });
    const pending = h.rpc({ guildId: GUILD, categoryId });
    const beforeRevocation = h.calls.length;
    h.relay.permissions.setPersonaDefault('alice', []);
    const response = await pending;
    assert.equal(beforeRevocation, 1, 'the synchronous check and create must stay together');
    assert.equal(h.calls.length, beforeRevocation, 'no new create may start after revocation');
    assert.equal(response.ok, true);
  }
});

test('final authority check cannot yield before create on any destination path', async (t) => {
  for (const destination of ['root', 'cached', 'fetched']) {
    const h = makeRelay(t, { personas: { alice: { default: MANAGE } } });
    if (destination === 'fetched') h.channels.delete(CATEGORY);
    const resolver = destination === 'root' ? 'resolveGuild' : 'resolve';
    const original = h.relay.permissions[resolver].bind(h.relay.permissions);
    let createsAtRevocation: number | undefined;
    h.relay.permissions[resolver] = (...args: unknown[]) => {
      const caps = original(...args);
      // Run immediately after the stack that computed the final authority.
      // The bot call must already have been initiated when this executes.
      if (createsAtRevocation === undefined) queueMicrotask(() => {
        createsAtRevocation = h.calls.length;
        h.relay.permissions.setPersonaDefault('alice', []);
      });
      return caps;
    };
    await h.allowed({ guildId: GUILD, categoryId: destination === 'root' ? undefined : CATEGORY });
    assert.equal(createsAtRevocation, 1, destination + ': no yield after final authorization');
  }
});

test('invalid identity or disallowed guild is rejected before fetching a category', async (t) => {
  const h = makeRelay(t, { default: MANAGE });
  h.channels.delete(CATEGORY);
  await h.denied({ guildId: GUILD, categoryId: CATEGORY }, 'deleted-persona');
  h.state.allowedGuilds.clear();
  await h.denied({ guildId: GUILD, categoryId: CATEGORY });
  assert.deepEqual(h.fetchCalls, []);
});

test('category must exist, be a category, and belong to the requested guild', async (t) => {
  const h = makeRelay(t, { personas: { alice: { default: MANAGE } } });
  for (const categoryId of ['unknown', TEXT, THREAD, FOREIGN_CATEGORY]) {
    await h.denied({ guildId: GUILD, categoryId });
  }
  await h.denied({ guildId: OTHER_GUILD, categoryId: CATEGORY });
  await h.allowed({ guildId: GUILD, categoryId: CATEGORY });
});

test('guild allowlist and current identity gate both destinations, even with file-default rights', async (t) => {
  const h = makeRelay(t, { default: MANAGE });
  for (const categoryId of [undefined, CATEGORY]) {
    await h.denied({ guildId: GUILD, categoryId }, 'deleted-persona');
  }
  h.state.allowedGuilds.clear(); // empty active allowlist denies every guild
  for (const categoryId of [undefined, CATEGORY]) {
    await h.denied({ guildId: GUILD, categoryId });
  }
  h.state.allowedGuilds.add(GUILD);
  await h.allowed({ guildId: GUILD });
  await h.allowed({ guildId: GUILD, categoryId: CATEGORY });
});

test('bot must hold ManageChannels at the destination; missing guild membership denies', async (t) => {
  const h = makeRelay(t, { default: MANAGE });
  h.state.guildPerms = new PermissionsBitField();
  await h.denied({ guildId: GUILD });
  h.state.guildPerms = new PermissionsBitField(PermissionsBitField.Flags.ManageChannels);
  h.state.categoryPerms = new PermissionsBitField();
  await h.denied({ guildId: GUILD, categoryId: CATEGORY });
  await h.allowed({ guildId: GUILD });
  h.state.categoryPerms = new PermissionsBitField(PermissionsBitField.Flags.Administrator);
  await h.allowed({ guildId: GUILD, categoryId: CATEGORY });
  h.state.botInGuild = false;
  await h.denied({ guildId: GUILD });
  await h.denied({ guildId: GUILD, categoryId: CATEGORY });
  h.state.allowedGuilds.add('unknown-guild');
  await h.denied({ guildId: 'unknown-guild' });
});

test('permission revocation is checked on each create RPC', async (t) => {
  const h = makeRelay(t, { personas: { alice: { default: MANAGE } } });
  await h.allowed({ guildId: GUILD });
  await h.allowed({ guildId: GUILD, categoryId: CATEGORY });
  h.relay.permissions.setPersonaDefault('alice', []);
  await h.denied({ guildId: GUILD });
  await h.denied({ guildId: GUILD, categoryId: CATEGORY });
});

test('malformed destination IDs cannot fall through to root authorization', async (t) => {
  const h = makeRelay(t, { default: MANAGE });
  for (const categoryId of ['', false, 0, [], {}]) {
    await h.denied({ guildId: GUILD, categoryId }, 'alice', 'INVALID_PARAMS');
  }
  for (const guildId of ['', null, false, 0, [], {}, undefined]) {
    await h.denied({ guildId }, 'alice', 'INVALID_PARAMS');
  }
});

test('a null categoryId asks for the guild root, as before the gate', async (t) => {
  const root = makeRelay(t, { default: MANAGE });
  const before = root.calls.length;
  const response = await root.rpc({ guildId: GUILD, categoryId: null });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(root.calls.slice(before), [[GUILD, 'new-channel', undefined]]);
  // Root authority is still what it takes: category authority alone doesn't do.
  const local = makeRelay(t, { personas: { alice: { default: [], guilds: { [GUILD]: { channels: { [CATEGORY]: MANAGE } } } } } });
  await local.denied({ guildId: GUILD, categoryId: null });
});

test("a bot that lacks Manage Channels, or isn't in the guild, is named as the gap, not the persona's grant", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const gapLines = () => logged.filter((line) => line.startsWith('[portal-relay] create_text_channel'));
  const h = makeRelay(t, { default: MANAGE });
  h.state.guildPerms = new PermissionsBitField();
  const response = await h.rpc({ guildId: GUILD });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'FORBIDDEN');
  assert.equal(response.error.message,
    `Nothing ran: the relay's Discord bot lacks Manage Channels in server "${GUILD}", so it can't create a channel ` +
    "at the server's top level. Only whoever runs this host can change that, in the server's settings.");
  h.state.botInGuild = false;
  const absent = await h.rpc({ guildId: GUILD });
  assert.equal(absent.ok, false);
  assert.equal(absent.error.code, 'FORBIDDEN');
  assert.equal(absent.error.message,
    `Nothing ran: the relay's Discord bot isn't in server "${GUILD}", so it can't create a channel there. ` +
    'Only whoever runs this host can change that.');
  assert.deepEqual(gapLines(), [
    `[portal-relay] create_text_channel in guild ${GUILD}: the bot lacks Manage Channels`,
    `[portal-relay] create_text_channel in guild ${GUILD}: the bot isn't in the guild`,
  ]);

  // A persona without the right learns nothing about the bot: its own refusal comes first.
  const viewer = makeRelay(t, { personas: { alice: { default: VIEW } } });
  viewer.state.botInGuild = false;
  const own = await viewer.rpc({ guildId: GUILD });
  assert.equal(own.ok, false);
  assert.match(own.error.message, /^Nothing ran: creating a channel at the top level of server "g1" needs MANAGE_CHANNELS/);
  assert.equal(gapLines().length, 2, 'and nothing is logged about the bot');
});

test("each refusal of the persona says what didn't happen, why, and what to do", async (t) => {
  const refusal = async (h: ReturnType<typeof makeRelay>, params: Record<string, unknown>, code: string) => {
    const response = await h.rpc(params);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, code);
    return response.error.message as string;
  };
  const h = makeRelay(t, { personas: { alice: { default: [], guilds: { [GUILD]: { channels: { [CATEGORY]: MANAGE } } } } } });
  assert.equal(await refusal(h, { guildId: GUILD, categoryId: '' }, 'INVALID_PARAMS'),
    'Nothing ran: guildId must be a non-empty string, and categoryId a non-empty string, or null or left out ' +
    "to create at the server's top level.");
  assert.equal(await refusal(h, { guildId: GUILD, categoryId: TEXT }, 'FORBIDDEN'),
    `Nothing ran: "${TEXT}" isn't a category of server "${GUILD}" that the relay can see. Check the id: ` +
    "list_channels, with that guildId, shows the server's categories and your capabilities in each, and creating " +
    'in one needs MANAGE_CHANNELS there. Leaving categoryId out creates at the server\'s top level, which needs ' +
    'MANAGE_CHANNELS across the server.');
  assert.equal(await refusal(h, { guildId: GUILD }, 'FORBIDDEN'),
    `Nothing ran: creating a channel at the top level of server "${GUILD}" needs MANAGE_CHANNELS across the server, ` +
    "which you don't have, so calling again won't change that. Pass a categoryId where list_channels shows you " +
    'MANAGE_CHANNELS, or, if you need this, ask whoever runs this host.');
  h.state.allowedGuilds.delete(GUILD);
  assert.equal(await refusal(h, { guildId: GUILD, categoryId: CATEGORY }, 'FORBIDDEN'),
    `Nothing ran: you have no access to server "${GUILD}" on this relay. Check the id: list_guilds shows the ` +
    'servers you can use. If you need this one, ask whoever runs this host.');
});

test('a server the persona has no access to, or is banned from, is refused as one the relay doesn\'t serve', async (t) => {
  const noAccess = `Nothing ran: you have no access to server "${GUILD}" on this relay. Check the id: list_guilds ` +
    'shows the servers you can use. If you need this one, ask whoever runs this host.';
  const refusedAsUnserved = async (h: ReturnType<typeof makeRelay>) => {
    for (const params of [{ guildId: GUILD }, { guildId: GUILD, categoryId: CATEGORY }, { guildId: GUILD, categoryId: TEXT }]) {
      const response = await h.rpc(params);
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'FORBIDDEN');
      assert.equal(response.error.message, noAccess);
    }
    assert.deepEqual(h.calls, []);
  };
  // Not served at all.
  const unserved = makeRelay(t, { personas: { alice: { default: MANAGE } } });
  unserved.state.allowedGuilds.delete(GUILD);
  await refusedAsUnserved(unserved);
  // Served, but the persona holds nothing there.
  await refusedAsUnserved(makeRelay(t, {
    roles: { elsewhere: { guildId: OTHER_GUILD, scope: { all: true }, caps: MANAGE } },
    personas: { alice: { roles: ['elsewhere'] } },
  }));
  // Banned, beside grants a hand-edited file can still hold there: /ban takes them off, and the admin API
  // refuses new ones. resolveGuild gives such a persona nothing either, as resolve() does, and its rights
  // elsewhere stand.
  const banned = makeRelay(t, {
    roles: { manager: { guildId: GUILD, scope: { all: true }, caps: MANAGE } },
    personas: { alice: { roles: ['manager'], policy: { default: MANAGE }, bans: [GUILD] } },
  });
  await refusedAsUnserved(banned);
  assert.deepEqual([...banned.relay.permissions.resolveGuild('alice', GUILD)], []);
  await banned.allowed({ guildId: OTHER_GUILD });
});

test('resolveGuild reads a server default as resolve() reads it, a hand-edited one that isn\'t a list included', async (t) => {
  for (const serverDefault of ['', false, 0]) {
    for (const personaDefault of [MANAGE, []]) {
      const h = makeRelay(t, {
        personas: { alice: { default: personaDefault, guilds: { [GUILD]: { default: serverDefault } } } },
      } as unknown as PermissionsFile);
      assert.deepEqual([...h.relay.permissions.resolveGuild('alice', GUILD)], [...h.relay.permissions.resolve('alice', GUILD, TEXT)]);
    }
  }
});

test('a persona removed during a category fetch is refused, even where the file default grants', async (t) => {
  // requireCap goes through capsFor, which refuses a persona with no identity before reading any policy.
  const h = makeRelay(t, { default: MANAGE });
  h.channels.delete(CATEGORY);
  h.state.onFetch = () => { h.relay.identity.remove('alice'); };
  await h.denied({ guildId: GUILD, categoryId: CATEGORY });
  assert.deepEqual(h.fetchCalls, [CATEGORY]);
});

test('hand-edited gaps deny root creation rather than throw', async (t) => {
  // A policy with no default anywhere, with and without an entry for this server, and a role reference with
  // no catalog entry.
  for (const policy of [
    { personas: { alice: { guilds: { [GUILD]: { channels: {} } } } } },
    { personas: { alice: { guilds: { [OTHER_GUILD]: { channels: {} } } } } },
    { personas: { alice: { roles: ['no-such-role'] } } },
  ] as unknown as PermissionsFile[]) {
    const h = makeRelay(t, policy);
    await h.denied({ guildId: GUILD });
  }
});
