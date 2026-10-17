# @animalabs/portal-relay

One Discord bot fronting many **webhook personas** — so a fleet of agents shares
a single bot slot instead of one bot each.

## What it does

- **One `discord.js` client**, many identities. Agents post via channel webhooks
  (custom name + avatar), not separate bots.
- **Webhook pool** per parent channel (`webhook-pool.ts`): one webhook serves the
  channel and all its threads via `threadId`; a persona is pinned to one webhook
  (hash) so its message order is preserved, while a >1 pool lets a hot channel
  burst across independent rate-limit buckets.
- **Role pool** per guild (`role-pool.ts`): a sticky-LRU pool of mentionable
  roles is the @-addressing token. Mentioning a persona's role pings nobody but
  routes the message to it. Rename-on-rebind, never delete.
- **Permission engine** (`permissions.ts`): effective capabilities =
  relay policy ∩ what the bot can actually do in the channel.
- **WS gateway** (`gateway.ts`): identify/resume with per-persona seq streams,
  heartbeats, fan-out to all of a persona's live sessions.
- **Relay message ids** (`message-store.ts`): clients address messages by a
  stable relay id; the store maps to the Discord snowflake + webhook + thread.

## Run

```bash
export DISCORD_TOKEN=...               # the single bot token
export PORTAL_IDENTITY=./identity.json # personas + tokens + policy (see identity.example.json)
export PORTAL_AVATAR_BASE_URL=https://relay.example/avatars
export PORTAL_WS_PORT=8790             # gateway, bound to 127.0.0.1
npm run build && node dist/src/index.js
```

The bot needs **Manage Webhooks** + **Manage Roles** (admin is simplest), and
its role must sit above the pooled roles.

## Preview the admin panel

`scripts/admin-preview.mts` runs the real admin API (`src/admin/`) and the
panel (`../portal-admin/`) on one origin, over an invented fixture world. There
is no bot and no Discord app: OAuth is answered by a fake, so the panel's own
`/admin/login` and `/admin/callback` run unchanged.

```bash
node --import tsx scripts/admin-preview.mts [--scale small|large] [--ttl ms] [--no-avatars] [--port 8833]
# → preview http://127.0.0.1:8833/dev-login
```

It listens on 127.0.0.1 only. Sign in as a fixture user:

| Open | Signs in as |
|---|---|
| `/dev-login?as=op` | a super-admin (`PORTAL_SUPERADMINS`) |
| `/dev-login?as=gwen` | Manage Server in Guild One (served) and Guild Three (not served) |
| `/dev-login?as=dee` | the configured delegate for Guild Two (`PORTAL_GUILD_ADMINS`) |
| `/dev-login?as=otto` | someone who manages only Guild Three, so sign-in is refused (`not_admin`) |

- `&deny=1` on `/dev-login` cancels at the fake Discord consent screen
  (`/dev-authorize`), for the failed-sign-in path.
- `/dev-restart` rebuilds the admin API over the same stores. Like a relay
  restart, it ends every session.
- `--ttl` sets the session lifetime in ms (default 30 minutes), to try expiry.
- `--no-avatars` starts with no profile pictures and avatar uploads off.
- `--scale large` adds a busy Guild One: 8 categories of 36 channels with
  threads, 200 more personas, 60 more invites and 500 audit records; Aria
  also holds `g1-everyone` (Write in every channel), so her drawer folds
  hundreds of rows that read alike into one line.

The small world has Guild One (channels in General, Research and Archive
categories, an announcement channel, a thread, a forum, a stage channel the
relay calls `unknown` (Aria holds a direct grant there, as slash `/add` would
store it), a channel where the bot can send but not start threads, and a
channel the bot can't see), Guild Two, four access roles, six personas (Aria, Cass, Nyx,
Juniper, Quill, Sol) with different kinds of access, and invites in every state.
The stores live in a new temp directory each run (the path is printed) and are
thrown away.

Every name and id in the script is invented; keep it that way, since this repo
is public. When a change adds a member to `AdminDeps`, give it a fake in this
script, and in `scripts/admin-dev.mjs`, in the same change.

`/admin/me` reports the admin API the relay speaks (`apiVersion`,
`ADMIN_API_VERSION` in `src/admin/server.ts`; 3 since the access views,
the persona directory, Remove from <guild> and Resync). Update the relay
before the panel: a panel newer than its relay says "This panel needs the
relay updated" in the Channels tab and the channel and persona drawers, and a
relay newer than the panel gets a "The panel was updated — Reload" banner. A
change to what the admin API answers or accepts bumps the version and the
panel's `CLIENT_API` together (`test/admin-spa.test.ts` checks they match).

CI (`.github/workflows/relay-ci.yml`) type-checks the relay and runs the admin,
slash, permissions and invite tests, including `test/admin-spa.test.ts`, which
loads the panel's scripts in `node:vm`.

## Status

Implemented and type-checked: webhook send (threads, files, persona role
mentions, quoted-link replies), role pool, permission checks, gateway
handshake/rpc/dispatch/resume (integration-tested in `test/gateway.test.ts`),
inbound message routing with per-persona addressing, history, edit/delete,
pseudo + visible reactions.

Known seams / TODO:
- **Persistence**: message store + role bindings are in-memory. Restart re-adopts
  webhooks/roles but loses relay-id history → persist (SQLite).
- **Inbound edits**: `message_update` from external edits isn't emitted yet
  (delete is). Needs a best-effort re-fetch to rebuild the PortalMessage.
- **Native reaction ingest** (humans reacting) isn't surfaced as events yet.
- **Self-echo race**: our webhook post is recorded after `send()` resolves; a
  gateway echo arriving first is handled by `ownsWebhook`, but persona
  attribution of a not-yet-recorded echo is dropped rather than mislabeled.
