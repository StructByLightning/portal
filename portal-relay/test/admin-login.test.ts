// Sign-in that doesn't dead-end: /admin/login and /admin/callback.
//
// Every way back from Discord lands on the panel — postLoginUrl, or
// postLoginUrl?login_error=<one of six words> — never a JSON page. Two tabs,
// Back, Cancel and a restart mid-sign-in each end in the panel or a plain
// message, and the callback is rate limited per client address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { AdminConfig } from '../src/config.js';
import { IdentityStore } from '../src/identity.js';
import { PermissionsStore } from '../src/permissions.js';
import { AdminServer, stateCookieName, type AdminDeps } from '../src/admin/server.js';
import { AuditLog } from '../src/admin/audit.js';
import { LoginRateLimit, clientIp } from '../src/admin/login-limit.js';

const MANAGE_GUILD = '32';

/** The only places a callback may send the browser (postLoginUrl is '/done'). */
const LOCATIONS = new Set([
  '/done',
  '/done?login_error=cancelled',
  '/done?login_error=expired',
  '/done?login_error=mismatch',
  '/done?login_error=discord_error',
  '/done?login_error=rate_limited',
  '/done?login_error=not_admin',
]);

/** Invented Discord users: each signs in with the code `as-<id>`. */
const USERS: Record<string, { guilds: unknown[] }> = {
  admin1: { guilds: [{ id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD }] },
  admin2: { guilds: [{ id: 'G1', name: 'Guild One', permissions: MANAGE_GUILD }] },
  nobody: { guilds: [{ id: 'G9', name: 'Somewhere else', owner: true, permissions: '8' }] },
};

interface World {
  base: string;
  audit: AuditLog;
  /** Make Discord's token endpoint answer with this status from now on. */
  failToken(status: number | null): void;
  /** Codes Discord was asked to exchange. */
  exchanged: string[];
  /** Keep Discord's token endpoint from answering until the returned
   *  function is called. */
  holdToken(): () => void;
  close(): Promise<void>;
}

async function world(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'portal-admin-login-'));
  writeFileSync(join(dir, 'identity.json'), JSON.stringify({ personas: [] }));
  writeFileSync(join(dir, 'permissions.json'), JSON.stringify({ roles: {}, personas: {} }));
  const config: AdminConfig = {
    port: 0,
    oauthClientId: 'cid',
    oauthClientSecret: 'sec',
    redirectUri: 'https://example.test/admin/callback',
    postLoginUrl: '/done',
    superadmins: [],
    guildAdmins: {},
    sessionTtlMs: 60_000,
    auditPath: join(dir, 'audit.jsonl'),
    cookieSecure: false,
  };
  const audit = new AuditLog(config.auditPath);
  const deps: AdminDeps = {
    config,
    identity: new IdentityStore(join(dir, 'identity.json'), ''),
    permissions: new PermissionsStore(join(dir, 'permissions.json')),
    audit,
    listGuilds: () => [{ id: 'G1', name: 'Guild One', memberCount: 1 }],
    listAllGuilds: () => [],
    allowlist: { editable: false, list: () => [], allow: () => false, disallow: () => false },
    listRoles: () => [],
    listChannels: () => [],
    channelInGuild: () => false,
    closePersona: () => {},
    applyClaim: () => ({ roles: [] }),
    rotatePersonaToken: () => 'unused',
    revokePersonaToken: () => {},
    newInviteCode: () => 'unused',
    capsFor: () => [],
    botCaps: () => [],
    permChannelId: (cid) => cid,
    listChannelLayout: () => [],
    canAccessGuild: () => false,
    resync: () => 0,
  };
  let tokenStatus: number | null = null;
  let held: Promise<void> | null = null;
  const exchanged: string[] = [];
  const fakeDiscord = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/oauth2/token')) {
      const code = new URLSearchParams(String(init?.body ?? '')).get('code') ?? '';
      exchanged.push(code);
      if (held) await held;
      if (tokenStatus !== null) return reply({ error: 'server_error', error_description: 'words Discord chose' }, tokenStatus);
      const who = /^as-(\w+)$/.exec(code)?.[1];
      if (!who || !(who in USERS)) return reply({ error: 'invalid_grant' }, 400);
      return reply({ access_token: `tok-${who}`, token_type: 'Bearer' });
    }
    const who = /^Bearer tok-(\w+)$/.exec(new Headers(init?.headers).get('authorization') ?? '')?.[1];
    if (!who || !(who in USERS)) return reply({ message: '401: Unauthorized' }, 401);
    if (url.endsWith('/users/@me')) return reply({ id: who, username: who, global_name: who });
    if (url.endsWith('/users/@me/guilds')) return reply(USERS[who].guilds);
    return reply({}, 404);
  }) as typeof fetch;
  const server = new AdminServer(deps, fakeDiscord);
  await server.listen();
  return {
    base: `http://127.0.0.1:${server.boundPort}`,
    audit,
    failToken: (s) => { tokenStatus = s; },
    exchanged,
    holdToken: () => {
      let release!: () => void;
      held = new Promise<void>((r) => { release = r; });
      return () => { held = null; release(); };
    },
    close: async () => {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One browser: its cookies, kept the way a browser keeps them. */
class Browser {
  cookies = new Map<string, string>();
  /** Every Location a callback sent this browser. */
  callbackLocations: string[] = [];
  constructor(private w: World, private ip = '198.51.100.7') {}

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async get(path: string): Promise<Response> {
    const headers: Record<string, string> = { 'x-forwarded-for': this.ip };
    const c = this.header();
    if (c) headers.cookie = c;
    const res = await fetch(this.w.base + path, { redirect: 'manual', headers });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';').map((x) => x.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      if (attrs.some((a) => a.toLowerCase() === 'max-age=0')) this.cookies.delete(name);
      else this.cookies.set(name, pair.slice(eq + 1));
    }
    if (path.startsWith('/admin/callback')) {
      assert.equal(res.status, 302, `callback ${path} redirects`);
      this.callbackLocations.push(res.headers.get('location') ?? '');
    }
    return res;
  }

  /** /admin/login: the state it sent to "Discord". */
  async startLogin(query = ''): Promise<string> {
    const res = await this.get('/admin/login' + query);
    assert.equal(res.status, 302);
    const state = new URL(res.headers.get('location')!).searchParams.get('state');
    assert.ok(state, 'the authorize URL carries a state');
    return state!;
  }

  /** Discord sends the browser back with a code for `user`. */
  finish(state: string, user = 'admin1'): Promise<Response> {
    return this.get(`/admin/callback?code=as-${user}&state=${encodeURIComponent(state)}`);
  }

  get session(): string | undefined {
    return this.cookies.get('portal_admin_session');
  }

  /** The sign-ins in flight in this browser: its state cookies' values,
   *  newest first. */
  get states(): string[] {
    return [...this.cookies].filter(([k]) => k.startsWith('portal_admin_state_')).map(([, v]) => v).reverse();
  }

  /** A cookie for `state`, as /admin/login would have set it. */
  holdState(state: string): void {
    this.cookies.set(stateCookieName(state), state);
  }

  async me(session = this.session): Promise<number> {
    const res = await fetch(this.w.base + '/admin/me', { headers: session ? { cookie: `portal_admin_session=${session}` } : {} });
    return res.status;
  }
}

function records(w: World, action: string) {
  return w.audit.read({ limit: 1000 }).filter((r) => r.action === action);
}

function setsSession(res: Response): boolean {
  return res.headers.getSetCookie().some((c) => c.startsWith('portal_admin_session=') && !/max-age=0/i.test(c));
}

/** A well-formed state this server never issued. */
const STRANGER = 'A'.repeat(43);

test('two tabs: two sign-ins started in one browser both complete', async () => {
  const w = await world();
  try {
    const b = new Browser(w);
    const s1 = await b.startLogin();
    const s2 = await b.startLogin();
    assert.deepEqual(b.states, [s2, s1], 'a cookie for each');

    const r1 = await b.finish(s1);
    assert.equal(r1.headers.get('location'), '/done');
    assert.ok(setsSession(r1));
    const first = b.session!;
    assert.deepEqual(b.states, [s2], 'the spent state’s cookie goes; the other tab’s stays');

    const r2 = await b.finish(s2);
    assert.equal(r2.headers.get('location'), '/done');
    assert.ok(setsSession(r2));
    assert.notEqual(b.session, first, 'a fresh session');
    assert.deepEqual(b.states, [], 'no sign-in left in flight: no state cookie left');
    assert.equal(await b.me(), 200);
    assert.equal(records(w, 'login.ok').length, 2);
    assert.equal(records(w, 'login.failed').length, 0);
  } finally {
    await w.close();
  }
});

test('two tabs: a sign-in started while another tab’s callback waits on Discord is not erased by it', async () => {
  const w = await world();
  try {
    const b = new Browser(w);
    const s1 = await b.startLogin();
    // Tab one comes back from Discord; Discord takes its time with the code…
    const release = w.holdToken();
    const first = b.finish(s1);
    while (!w.exchanged.includes('as-admin1')) await new Promise((r) => setTimeout(r, 5));
    // …while tab two starts signing in as someone else.
    const s2 = await b.startLogin();
    release();
    assert.equal((await first).headers.get('location'), '/done');
    assert.deepEqual(b.states, [s2], 'tab one’s callback took only its own state with it');

    const r2 = await b.finish(s2, 'admin2');
    assert.equal(r2.headers.get('location'), '/done');
    assert.ok(setsSession(r2), 'tab two’s sign-in went through');
    assert.ok(w.exchanged.includes('as-admin2'), 'its code was exchanged');
    const me = await (await fetch(w.base + '/admin/me', { headers: { cookie: `portal_admin_session=${b.session}` } })).json();
    assert.equal(me.user.id, 'admin2', 'the account switch happened');
    assert.deepEqual(b.states, []);
  } finally {
    await w.close();
  }
});

test('state cookies: the three newest live sign-ins are kept; ones the server no longer knows are dropped', async () => {
  const w = await world();
  try {
    const b = new Browser(w);
    b.holdState(STRANGER);
    b.cookies.set('portal_admin_state_0123456789abcdef', 'not-a-state');
    b.cookies.set('portal_admin_state', `${STRANGER}.not-a-state`); // an earlier version's one cookie
    b.cookies.set('portal_admin_session_x', 'kept'); // not a state cookie: left alone
    const s1 = await b.startLogin();
    assert.deepEqual(b.states, [s1], 'unknown and malformed states are dropped');
    assert.equal(b.cookies.has('portal_admin_state'), false, 'and so is the old single cookie');
    assert.equal(b.cookies.get('portal_admin_session_x'), 'kept');
    const s2 = await b.startLogin();
    const s3 = await b.startLogin();
    const s4 = await b.startLogin();
    assert.deepEqual(b.states, [s4, s3, s2]);
    const set = (await fetch(w.base + '/admin/login', { redirect: 'manual' })).headers.getSetCookie()[0];
    assert.match(set, /; Max-Age=600(;|$)/);
    assert.match(set, /; HttpOnly/);
    assert.match(set, /; Path=\/admin/);
    // The oldest is still live on the server, but this browser forgot it.
    const r = await b.finish(s1);
    assert.equal(r.headers.get('location'), '/done?login_error=mismatch');
    assert.ok((await b.finish(s2)).headers.get('location') === '/done');
  } finally {
    await w.close();
  }
});

test('Back onto a used callback while signed in goes home: no exchange, no new session, no record', async () => {
  const w = await world();
  try {
    const b = new Browser(w);
    const s = await b.startLogin();
    await b.finish(s);
    const session = b.session!;
    const exchanges = w.exchanged.length;
    const before = w.audit.read({ limit: 1000 }).length;

    // The same URL again (Back, or a reload) — and the same state with a code
    // from somewhere else: neither is exchanged, neither replaces the session.
    for (const code of ['as-admin1', 'as-admin2']) {
      const res = await b.get(`/admin/callback?code=${code}&state=${s}`);
      assert.equal(res.headers.get('location'), '/done');
      assert.equal(setsSession(res), false, 'no new session cookie');
      assert.equal(res.headers.getSetCookie().length, 0, 'no cookie touched');
    }
    // Missing or unknown states, signed in: home as well.
    for (const q of ['', `?code=as-admin2`, `?code=as-admin2&state=${STRANGER}`]) {
      assert.equal((await b.get('/admin/callback' + q)).headers.get('location'), '/done');
    }
    assert.equal(b.session, session);
    assert.equal(await b.me(), 200);
    assert.equal(w.exchanged.length, exchanges, 'no code was exchanged');
    assert.equal(w.audit.read({ limit: 1000 }).length, before, 'nothing recorded');
  } finally {
    await w.close();
  }
});

test('Cancel in Discord: login_error=cancelled, the cookie untouched, other sign-ins still usable', async () => {
  const w = await world();
  try {
    const b = new Browser(w);
    const s1 = await b.startLogin();
    const s2 = await b.startLogin();
    const res = await b.get(`/admin/callback?error=access_denied&error_description=The+resource+owner+denied&state=${s1}`);
    assert.equal(res.headers.get('location'), '/done?login_error=cancelled');
    assert.equal(res.headers.getSetCookie().length, 0, 'the state cookie is left alone');
    assert.deepEqual(records(w, 'login.failed').map((r) => r.detail), [{ reason: 'cancelled' }]);

    // Discord's other errors: discord_error, recorded as a known word or 'other'.
    const other = await b.get(`/admin/callback?error=server_error&state=${s1}`);
    assert.equal(other.headers.get('location'), '/done?login_error=discord_error');
    await b.get(`/admin/callback?error=%3Cscript%3E&state=${s1}`);
    assert.deepEqual(records(w, 'login.failed').slice(0, 2).map((r) => r.detail), [
      { reason: 'discord_error', discordError: 'other' },
      { reason: 'discord_error', discordError: 'server_error' },
    ]);

    assert.equal((await b.finish(s2)).headers.get('location'), '/done', 'the other tab signs in');
    assert.equal((await new Browser(w, '198.51.100.8').get('/admin/callback?error=access_denied')).headers.get('location'), '/done?login_error=cancelled');
  } finally {
    await w.close();
  }
});

test('a state this server does not know is expired; one not in this browser is mismatch', async () => {
  const w = await world();
  try {
    // Known to the cookie, unknown here (issued before a restart, say).
    const b = new Browser(w);
    b.holdState(STRANGER);
    const r1 = await b.finish(STRANGER);
    assert.equal(r1.headers.get('location'), '/done?login_error=expired');
    assert.equal(r1.headers.getSetCookie().length, 0, 'no cookie is touched');

    // Issued here for another browser: not in this one's cookie.
    const other = new Browser(w, '198.51.100.8');
    const theirs = await other.startLogin();
    const r2 = await b.finish(theirs);
    assert.equal(r2.headers.get('location'), '/done?login_error=mismatch');
    // No state cookie at all; no state at all.
    const bare = new Browser(w, '198.51.100.9');
    assert.equal((await bare.finish(theirs)).headers.get('location'), '/done?login_error=mismatch');
    assert.equal((await bare.get('/admin/callback?code=as-admin1')).headers.get('location'), '/done?login_error=mismatch');
    // A used state, signed out: expired.
    const s = await bare.startLogin();
    await bare.finish(s);
    const third = new Browser(w, '198.51.100.10');
    third.holdState(s);
    assert.equal((await third.finish(s)).headers.get('location'), '/done?login_error=expired');

    assert.deepEqual(records(w, 'login.failed').map((r) => r.detail!.reason).reverse(), ['expired', 'mismatch', 'mismatch', 'mismatch', 'expired']);
    assert.equal(w.exchanged.length, 1, 'only the good sign-in reached Discord');
    // Their sign-in is still good.
    assert.equal((await other.finish(theirs)).headers.get('location'), '/done');
  } finally {
    await w.close();
  }
});

test('Discord failing the exchange: discord_error, recorded with the step and status; no session', async () => {
  const w = await world();
  try {
    const b = new Browser(w);
    const s1 = await b.startLogin();
    const s2 = await b.startLogin();
    w.failToken(500);
    const res = await b.finish(s1);
    assert.equal(res.headers.get('location'), '/done?login_error=discord_error');
    assert.equal(setsSession(res), false);
    assert.equal(b.session, undefined);
    const rec = records(w, 'login.failed')[0];
    assert.deepEqual(rec.detail, { reason: 'discord_error', step: 'token', failure: 'http', status: 500 });
    assert.doesNotMatch(JSON.stringify(rec), /words Discord chose/, 'Discord’s own words are not recorded');

    // A failure leaves the other sign-in usable.
    w.failToken(null);
    assert.equal((await b.finish(s2)).headers.get('location'), '/done');
    assert.equal(await b.me(), 200);

    // A callback with a good state but no code: discord_error, state kept.
    const s3 = await new Browser(w, '198.51.100.8').startLogin();
    const c = new Browser(w, '198.51.100.8');
    c.holdState(s3);
    assert.equal((await c.get(`/admin/callback?state=${s3}`)).headers.get('location'), '/done?login_error=discord_error');
    assert.equal((await c.finish(s3)).headers.get('location'), '/done', 'the state was not spent');
  } finally {
    await w.close();
  }
});

test('signing in again ends the session the browser had — the same admin or another', async () => {
  const w = await world();
  try {
    const b = new Browser(w);
    await b.finish(await b.startLogin());
    const old = b.session!;
    assert.equal(await b.me(old), 200);

    await b.finish(await b.startLogin('?reauth=1'));
    assert.notEqual(b.session, old);
    assert.equal(await b.me(old), 401, 'the old cookie is signed out');
    assert.equal(await b.me(), 200);
    const oks = records(w, 'login.ok');
    assert.equal(oks[0].detail!.reauth, true, '?reauth=1 marks the record');
    assert.equal('reauth' in oks[1].detail!, false);

    // Another account in the same browser.
    const second = b.session!;
    await b.finish(await b.startLogin(), 'admin2');
    assert.equal(await b.me(second), 401);
    const me = await (await fetch(w.base + '/admin/me', { headers: { cookie: `portal_admin_session=${b.session}` } })).json();
    assert.equal(me.user.id, 'admin2');

    // A refused sign-in leaves the session alone.
    const kept = b.session!;
    await b.finish(await b.startLogin(), 'nobody');
    assert.equal(b.callbackLocations.at(-1), '/done?login_error=not_admin');
    assert.equal(await b.me(kept), 200);
    assert.deepEqual(records(w, 'login.denied')[0].detail, { reason: 'no_manageable_guild' });
  } finally {
    await w.close();
  }
});

test('rate limit: the 21st callback from one address within a minute is refused, with one record', async () => {
  const w = await world();
  try {
    const flood = new Browser(w, '203.0.113.5');
    for (let i = 0; i < 20; i++) {
      assert.equal((await flood.get(`/admin/callback?code=x&state=${STRANGER}`)).headers.get('location'), '/done?login_error=mismatch');
    }
    for (let i = 0; i < 5; i++) {
      assert.equal((await flood.get(`/admin/callback?code=x&state=${STRANGER}`)).headers.get('location'), '/done?login_error=rate_limited');
    }
    // A valid sign-in from that address is refused too, without spending it.
    const s = await flood.startLogin();
    assert.equal((await flood.finish(s)).headers.get('location'), '/done?login_error=rate_limited');

    const limited = records(w, 'login.rate_limited');
    assert.equal(limited.length, 1, 'one record for the minute');
    assert.deepEqual(limited[0].detail, { ip: '203.0.113.5', count: 1 });
    assert.equal(records(w, 'login.failed').length, 20, 'every failure under the limit is recorded');

    // Per address, never global: someone else signs in.
    const other = new Browser(w, '203.0.113.6');
    assert.equal((await other.finish(await other.startLogin())).headers.get('location'), '/done');
    // The rightmost X-Forwarded-For entry is the one that counts (the proxy appends it).
    const viaChain = await fetch(`${w.base}/admin/callback?error=access_denied`, { redirect: 'manual', headers: { 'x-forwarded-for': '203.0.113.5, 203.0.113.7' } });
    assert.equal(viaChain.headers.get('location'), '/done?login_error=cancelled');
  } finally {
    await w.close();
  }
});

test('rate limit: a flood of /admin/login from one address is refused past 20 a minute and cancels no one else’s sign-in', async () => {
  const w = await world();
  try {
    const admin = new Browser(w, '198.51.100.20');
    const s = await admin.startLogin();
    const flood = new Browser(w, '203.0.113.9');
    let started = 0;
    let refused = 0;
    for (let i = 0; i < 60; i++) {
      flood.cookies.clear(); // a cookie-less client
      const res = await flood.get('/admin/login');
      assert.equal(res.status, 302);
      const to = res.headers.get('location') ?? '';
      if (to === '/done?login_error=rate_limited') refused++;
      else if (to.startsWith('https://')) started++;
      else assert.fail('unexpected redirect ' + to);
    }
    assert.equal(started, 20, 'twenty a minute per address');
    assert.equal(refused, 40);
    const limited = records(w, 'login.rate_limited');
    assert.equal(limited.length, 1, 'one record for the minute');
    assert.deepEqual(limited[0].detail, { ip: '203.0.113.9', count: 1, step: 'login' });
    // The callback has its own limit: the flood's address can still finish
    // a sign-in started before the flood, and the admin's goes through.
    assert.equal((await admin.finish(s)).headers.get('location'), '/done');
    assert.equal(await admin.me(), 200);
  } finally {
    await w.close();
  }
});

test('every callback lands on one of seven fixed addresses, whatever the query', async () => {
  const w = await world();
  try {
    const b = new Browser(w);
    const s = await b.startLogin();
    const queries = [
      '', '?', '?code=', '?state=', '?error=', '?error=access_denied', '?error=consent_required',
      '?error=a%0d%0aLocation:%20https://evil.example', '?code=as-admin1&state=https://evil.example',
      `?code=as-admin1&state=${s}&state=${STRANGER}`, `?code=%00&state=${s}x`, `?state=${s}&error=server_error`,
      '?login_error=../../x', '?code=as-admin1&state=' + 'B'.repeat(5000),
    ];
    for (const q of queries) await b.get('/admin/callback' + q);
    await b.finish(s);
    await b.finish(s);
    const n = new Browser(w, '198.51.100.20');
    await n.finish(await n.startLogin(), 'nobody');
    w.failToken(503);
    await n.finish(await n.startLogin());
    const all = [...b.callbackLocations, ...n.callbackLocations];
    assert.ok(all.length >= queries.length + 4);
    for (const loc of all) assert.ok(LOCATIONS.has(loc), `unexpected Location ${JSON.stringify(loc)}`);
  } finally {
    await w.close();
  }
});

// ── The limiter on its own ──

test('LoginRateLimit: 20 a minute per address, refilled evenly; one report a minute, the rest counted', () => {
  let now = 0;
  const lim = new LoginRateLimit({ now: () => now });
  for (let i = 0; i < 20; i++) assert.deepEqual(lim.take('a'), { ok: true });
  assert.deepEqual(lim.take('a'), { ok: false, report: { count: 1 } }, 'the first refusal is reported');
  assert.deepEqual(lim.take('a'), { ok: false }, 'later ones in the minute are counted');
  assert.deepEqual(lim.take('a'), { ok: false });
  assert.deepEqual(lim.take('b'), { ok: true }, 'another address has its own bucket');

  now += 3_000; // one token back (20 a minute)
  assert.deepEqual(lim.take('a'), { ok: true });
  assert.deepEqual(lim.take('a'), { ok: false });

  assert.deepEqual(lim.sweep(), [], 'nothing owed until the minute is over');
  now = 60_000;
  assert.deepEqual(lim.sweep(), [{ ip: 'a', count: 3 }], 'the refusals since the report, once a minute');
  assert.deepEqual(lim.sweep(), []);

  // Drained again within a minute of that report: counted, not reported.
  for (let i = 0; i < 20; i++) lim.take('a');
  assert.equal(lim.take('a').ok, false);
  now = 120_000;
  const r = lim.take('a');
  assert.equal(r.ok, true, 'a minute refills the bucket');
  for (let i = 0; i < 19; i++) lim.take('a');
  assert.deepEqual(lim.take('a'), { ok: false, report: { count: 3 } }, 'the next report carries what was counted, and itself');

  // Quiet addresses are forgotten.
  now = 600_000;
  lim.sweep();
  for (let i = 0; i < 20; i++) assert.equal(lim.take('a').ok, true, 'a fresh bucket');
});

test('LoginRateLimit: the address table stays bounded', () => {
  let now = 0;
  const lim = new LoginRateLimit({ now: () => now, maxAddresses: 3 });
  for (const ip of ['a', 'b', 'c', 'd', 'e']) lim.take(ip);
  // 'e' kept its bucket (one token spent)…
  for (let i = 0; i < 19; i++) assert.equal(lim.take('e').ok, true);
  assert.equal(lim.take('e').ok, false);
  // …while the oldest, 'a', made room: it comes back with a full one.
  for (let i = 0; i < 20; i++) assert.equal(lim.take('a').ok, true);
  assert.equal(lim.take('a').ok, false);
});

test('clientIp: behind a loopback proxy the rightmost X-Forwarded-For entry; otherwise the peer', () => {
  const req = (remoteAddress: string, xff?: string) =>
    ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;
  assert.equal(clientIp(req('127.0.0.1', '192.0.2.1, 203.0.113.9')), '203.0.113.9');
  assert.equal(clientIp(req('::ffff:127.0.0.1', '2001:db8::1')), '2001:db8::1');
  assert.equal(clientIp(req('::1', ' 203.0.113.9 ')), '203.0.113.9');
  assert.equal(clientIp(req('127.0.0.1')), '127.0.0.1', 'no header: the peer');
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.9,')), '127.0.0.1', 'an empty last entry: the peer');
  assert.equal(clientIp(req('192.0.2.50', '203.0.113.9')), '192.0.2.50', 'a peer that is not the proxy can’t pick its address');
  assert.equal(clientIp(req('127.0.0.1', 'x'.repeat(500))).length, 64, 'bounded');
});
