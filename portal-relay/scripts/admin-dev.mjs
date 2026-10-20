#!/usr/bin/env node
// Local admin-panel test — REAL Discord OAuth, NO BOT (zero Discord side effects).
//
// This runs ONLY the admin HTTP API + serves the SPA. It does NOT start the relay
// or connect the Discord bot, so it can never touch the portal-* role pool that
// production manages. Guild/role/channel data is STUBBED; persona/invite/role
// state lives in a throwaway temp dir. Login is real Discord OAuth (your app), so
// the auth + admin-guild derivation path is exercised for real.
//
// Ports: admin API 8791, front 8780 — does NOT use the relay's 8790, so it runs
// happily alongside an existing relay.
//
// Prereq: in the OAuth2 settings of the Discord app whose client id/secret you
// pass, add redirect:  http://localhost:8780/admin/callback   (adding a redirect
// URI has no effect on the bot or any roles).
//
// Run:
//   PORTAL_OAUTH_CLIENT_ID=...  PORTAL_OAUTH_CLIENT_SECRET=...  \
//   PORTAL_SUPERADMINS=<your-discord-user-id>  \
//   node scripts/admin-dev.mjs
//   → open http://localhost:8780
import { mkdtempSync, writeFileSync, statSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, extname } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { AdminServer } from '../dist/src/admin/server.js';
import { AuditLog } from '../dist/src/admin/audit.js';
import { IdentityStore, generateToken, hashToken } from '../dist/src/identity.js';
import { PermissionsStore as Perms } from '../dist/src/permissions.js';
import { InviteStore } from '../dist/src/invites.js';

const FRONT_PORT = parseInt(process.env.PORTAL_DEV_FRONT_PORT || '8780', 10);
const ADMIN_PORT = 8791;
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`\nMissing ${k}. See the header of this script.\n`); process.exit(1); } return v; };

// ── Seed throwaway state ──
const dir = mkdtempSync(join(tmpdir(), 'portal-admin-dev-'));
writeFileSync(join(dir, 'identity.json'), JSON.stringify({
  personas: [
    { id: 'demo-aria', displayName: 'Aria', avatar: '', token: hashToken('demo-aria-token') },
    { id: 'demo-cass', displayName: 'Cass', avatar: '', token: hashToken('demo-cass-token') },
    // demo-nyx exists but has NO permissions entry → no access in any guild, so it
    // won't appear in the list. Use "Grant access to a persona by ID" with this id.
    { id: 'demo-nyx', displayName: 'Nyx', avatar: '', token: hashToken('demo-nyx-token') },
  ],
}, null, 2));
writeFileSync(join(dir, 'permissions.json'), JSON.stringify({
  roles: {
    reader: { caps: ['VIEW_CHANNEL', 'READ_HISTORY'], scope: { all: true } },
    chatter: { caps: ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'], scope: { all: true } },
  },
  // Non-empty global default → these personas show up in every guild you select.
  personas: {
    'demo-aria': { policy: { default: ['VIEW_CHANNEL', 'READ_HISTORY'] } },
    'demo-cass': { roles: ['chatter'], policy: { default: ['VIEW_CHANNEL'] } },
  },
}, null, 2));
writeFileSync(join(dir, 'invites.json'), JSON.stringify({ invites: [] }, null, 2));

const identity = new IdentityStore(join(dir, 'identity.json'), '');
const permissions = new Perms(join(dir, 'permissions.json'));
const invites = new InviteStore(join(dir, 'invites.json'));

const STUB_CHANNELS = [
  { id: 'c-general', name: 'general', type: 'text' },
  { id: 'c-random', name: 'random', type: 'text' },
  { id: 'c-staff', name: 'staff', type: 'text' },
];
const STUB_ROLES = (gid) => [
  { id: '1111', guildId: gid, name: '@everyone', pooled: false },
  { id: '2222', guildId: gid, name: 'Moderators', pooled: false },
  { id: '3333', guildId: gid, name: 'portal-Aria', pooled: true },
];
let codeN = 0;

const deps = {
  config: {
    port: ADMIN_PORT,
    oauthClientId: need('PORTAL_OAUTH_CLIENT_ID'),
    oauthClientSecret: need('PORTAL_OAUTH_CLIENT_SECRET'),
    redirectUri: `http://localhost:${FRONT_PORT}/admin/callback`,
    postLoginUrl: '/',
    superadmins: (process.env.PORTAL_SUPERADMINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    sessionTtlMs: 30 * 60 * 1000,
    auditPath: join(dir, 'audit.jsonl'),
    cookieSecure: false,
  },
  identity,
  permissions,
  invites,
  audit: new AuditLog(join(dir, 'audit.jsonl')),
  listGuilds: () => [
    { id: 'G_demo_1', name: 'Demo Server One', memberCount: 12 },
    { id: 'G_demo_2', name: 'Demo Server Two', memberCount: 4 },
  ],
  listRoles: (gid) => STUB_ROLES(gid),
  listChannels: () => STUB_CHANNELS,
  channelInGuild: (_gid, cid) => STUB_CHANNELS.some((c) => c.id === cid),
  closePersona: () => {},
  applyClaim: (pid, code) => {
    const inv = invites.get(code);
    const roles = permissions.addPersonaRoles(pid, inv?.roles ?? []);
    invites.consume(code);
    return { roles };
  },
  rotatePersonaToken: (pid) => {
    const cur = identity.get(pid);
    const t = generateToken();
    identity.upsert({ ...cur, token: hashToken(t) });
    return t;
  },
  revokePersonaToken: (pid) => {
    const cur = identity.get(pid);
    identity.upsert({ ...cur, token: hashToken(generateToken()) });
  },
  newInviteCode: () => `inv_dev_${++codeN}`,
  // No bot here: it can do everything in the stub channels, and the persona's
  // access is what it is given.
  capsFor: (pid, cid, gid) => (identity.get(pid) ? [...permissions.resolve(pid, gid, cid)] : []),
  botCaps: () => ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'SEND_IN_THREADS', 'CREATE_THREADS', 'ATTACH_FILES', 'ADD_REACTIONS', 'MENTION_EVERYONE', 'EDIT_OWN', 'DELETE_OWN', 'MANAGE_MESSAGES', 'MANAGE_CHANNELS', 'VOICE_LISTEN', 'VOICE_SPEAK'],
  // No threads here: every channel's access is its own.
  permChannelId: (cid) => cid,
  listChannelLayout: () => STUB_CHANNELS.map((c, i) => ({ id: c.id, categoryId: null, position: i, announcement: false })),
  canAccessGuild: (pid, gid) => permissions.couldAccessGuild(pid, gid, (cid) => STUB_CHANNELS.some((c) => c.id === cid)),
  resync: () => 0,
};

const admin = new AdminServer(deps); // real fetch → real Discord OAuth
await admin.listen();

// ── Front: static SPA + reverse-proxy /admin/* → admin API ──
const SPA_DIR = fileURLToPath(new URL('../../portal-admin', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const front = createServer((req, res) => {
  if (req.url.startsWith('/admin')) {
    const up = httpRequest({ host: '127.0.0.1', port: ADMIN_PORT, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => res.writeHead(502).end(`admin api unreachable: ${e.message}`));
    req.pipe(up);
    return;
  }
  let rel = normalize(decodeURIComponent(req.url.split('?')[0]));
  if (rel === '/' || rel === '') rel = '/index.html';
  const path = join(SPA_DIR, rel);
  if (!path.startsWith(SPA_DIR)) { res.writeHead(403).end('forbidden'); return; }
  try {
    if (statSync(path).isDirectory()) throw new Error('dir');
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(200, { 'content-type': 'text/html' });
    createReadStream(join(SPA_DIR, 'index.html')).pipe(res);
  }
});
await new Promise((r) => front.listen(FRONT_PORT, '127.0.0.1', r));

console.error('\n────────────────────────────────────────────────────────');
console.error(`  admin panel (NO-BOT dev):   http://localhost:${FRONT_PORT}`);
console.error(`  admin API:                  http://127.0.0.1:${ADMIN_PORT}`);
console.error(`  super-admins:               ${deps.config.superadmins.join(', ') || '(none)'}`);
console.error(`  seeded state (throwaway):   ${dir}`);
console.error('  NO bot connected — production portal-* roles are untouched.');
console.error('────────────────────────────────────────────────────────\n');

const shutdown = () => { console.error('[admin-dev] shutting down'); front.close(); admin.close().finally(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
