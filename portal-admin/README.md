# portal-admin

The static admin-panel SPA for portal (PORTAL-RFC-005). Dependency-free: plain
HTML + vanilla JS + CSS, no build step, no npm. It is a pure client of the
relay's admin HTTP API — **all** authorization is enforced server-side.

```
portal-admin/
├── index.html        app shell + login + right-side detail drawer + toast stack
├── lib.js            pure helpers (window.PA.lib): the Read/Write/Full levels
│                     and capabilities (a mirror of the relay's, parity-tested),
│                     channel/role names, one-line summaries of roles and invites,
│                     the #/… address grammar, drafts, sign-in error words
├── ui.js             DOM helpers and widgets (window.PA.ui): toasts (with an
│                     Undo), status lines, busy buttons, confirm dialogs, the
│                     level control, checkbox lists, the type-ahead (an ARIA
│                     combobox), a persona's level pill and direct-grant control,
│                     the drawer, "Your session ended", the expiry bar, the
│                     Not-an-admin view
├── channels.js       the Channels tab and the channel drawer (window.PA.channels)
├── app.js            API client, the shell and addresses, the other tabs and
│                     their mutations (window.PA.app)
├── styles.css        self-contained styling (dense, dark/light, CSP-clean)
├── Caddyfile.example reverse-proxy + static-serve vhost
└── README.md
```

Each script is a classic `defer` script wrapped in one IIFE that assigns a
single global, `window.PA.<module>`; `index.html` loads them in order with a
`?v=` release query, which you bump (in every file's query alike) when a
release changes them. Nothing sets
`innerHTML`. `portal-relay/test/admin-spa.test.ts` checks these rules,
`lib.js` (against the relay's own `LEVEL_CAPS` and `ALL_CAPS`) and `ui.js`'s
helpers in `node:vm`.

To try the panel locally without Discord, run the preview harness:
`node --import tsx scripts/admin-preview.mts` in `portal-relay/` (see its
README, "Preview the admin panel").

## Information architecture

**Resource-first**, built for scale (dozens → low hundreds of personas, the whole
point being to beat Discord's 50-bot limit). Top-level tabs are *resources*, with
the guild as a persistent **scope** in the header — not a gate you pass first.

- **Channels** *(the first tab, and where a first visit lands)* — who can act
  where: slash `/list` and `/caps` for every channel. The guild's channels in
  Discord's order (outside any category first, then each category, which
  folds; the fold is remembered per admin and guild), each with how many
  personas can act there at each level ("3 can write · 2 can read · 1 full")
  and a warning where the relay's bot can't do everything Write needs
  ("relay can only read here" when it can't send, else "relay is limited
  here"; the tooltip says what it can't do). Channels of a kind the panel
  can't give access on (a stage or media channel: badge *other kind*) are
  listed too — the relay serves them, and roles, guild-wide levels and
  defaults reach them. Channels the bot can't see are in a folded group at
  the end; threads aren't listed (they use their channel's access — the
  relay checks every action on a thread against its channel).
  A filter and *All · With agents · Empty* narrow the rows. The counts come
  from the relay (`…/access/summary`), are asked for again when you come back
  to the window after a minute, and follow every change made in a drawer.
  Click a channel → its **drawer**:
  - where it is, *Open in Discord*, and a banner when the relay's bot is the
    limit there (it can only Read, or can't see the channel);
  - *Add personas*: pick up to ten with the type-ahead (the guild's persona
    directory), a level (Write unless changed), and a *Currently:* line for
    each ("Aria: Write via role g1-chatters — no direct grant needed"); *Add*
    says what each persona can do now, from the relay's answer;
  - *Who can act here*: each persona's level ("Write", "Write +1", "(bot-
    limited)"), why (direct grant · role … · mirrors @Mods · guild-wide ·
    persona default · relay default · overrides guild-wide Write), and its
    direct grant, changed in place (— · Read · Write · Full · Custom… · Block
    guild-wide here). Every change answers "Effective now: …" (or what is left
    after a removal), offers **Undo** for 10 seconds, and asks first when it
    would lower access that came from guild-wide or a default. A change made
    meanwhile elsewhere is refused and the rows are read again. A newer change
    to the same persona retires the older one's Undo, and an Undo's outcome
    is said where its change was. A *Custom…* edit stays open — through a
    redraw after another row's change — until *Apply* or *Cancel*, and
    counts as unsaved once a box is ticked; a read that no longer lists its
    row (the persona removed from the guild, or no longer able to act there)
    drops it, with nothing left to ask about. On a channel of a kind the panel
    can't give access on, a direct grant set in Discord can only be removed;
  - the slash equivalent, and *Invite a new agent here*.
  Opening a thread's address shows its channel ("Threads use #research's
  access."); a category's opens the list with that category unfolded.
- **Personas** — the one place for a persona (portal's only kind of speaker).
  The table (avatar · name · id · *Can act in* "in 14 channels (9 Write · 5
  Read)", from the access summary · this guild's access roles · flags: denied
  guild-wide, inactive grants) lists the personas with access in the selected
  guild; super-admins can switch it to **All personas** (with each one's guild
  count). **Add persona to <guild>** opens a type-ahead over the guild's
  persona directory (the people slash `/add` offers): any persona, by name or
  id — "Nyx (nyx-7a8b9c)" with a *no access here* tag — and picking one opens
  its drawer. An empty search offers to add one with that name (super-admins
  can also search all personas). Click a row → a right-side **drawer**:
  - its picture, its id (with Copy) and where it can act here ("Write in 3 ·
    Read in 12 channels here");
  - *Access in <guild>* — *Add to channels*: a channel type-ahead (only
    channels that can hold a grant; typing a category offers "Category
    Research (3 channels)", which picks the channels it has now), a level
    (Write unless changed) and *Add*, with a *Currently:* line per channel.
    Then where it can act, by category in Discord's order: what it can do,
    why, and its direct grant, changed in place with the channel drawer's
    control. Six or more rows that read alike fold into one line ("Write in
    240 channels · via role g1-everyone" — *Show*); a run with a *Custom…*
    edit open in it is shown, and its *Hide* waits for *Apply* or *Cancel*.
    *Inactive grants* lists
    the direct grants that do nothing (on a thread, a category or a deleted
    channel, or a block with nothing to block), each with *Remove*. Every
    change answers "Effective now: …" from the relay, offers **Undo** for 10
    seconds, and asks first when it would lower guild-wide or default access,
    or lift a removal (`/ban` or *Remove from <guild>*). Only a change the
    admin was asked about lifts one: the relay refuses any other (an Undo, a
    change from a view read before the removal), and the drawer then says
    the persona was removed since and reads it again. A row whose change is
    still on its way stays off when another change redraws the table;
  - *Access roles in <guild>* — this guild's, each with what it means; ✕ asks
    first ("Aria loses Write in 2 channels unless another grant covers them");
  - **Remove from <guild>** — what slash `/ban` does (the same function on the
    relay): its access roles here and every direct grant here go, guild-wide
    is denied, and only an admin of the guild can give it access there again
    (claiming an invite won't). The confirm lists what goes. It waits for
    changes still being saved in the drawer and goes after them, and takes
    the drawer's Undo toasts down with it. **Resync**
    re-sends its channel list to its running agent (once every few seconds);
  - *More* (folded) — the guild-wide level (*Set level…*, *Unset*: fall back to
    the persona default, *Deny guild-wide*: block the persona default here;
    access roles still apply) and applying an invite made for an existing
    persona;
  - *(super-admin)* **Identity** (folded) — the other guilds it can act in, each
    a link to its drawer there; its profile picture (Upload only when the relay
    keeps uploads, `PORTAL_AVATAR_DIR`); and its **Token** (rotate / revoke) —
    a token authenticates a persona everywhere, so it is not a per-guild
    action. From *All personas* (no guild) the drawer is Identity alone.

  An id that isn't a persona's says "No persona with id …". (The former
  *Identities* tab was the same personas, globally; it is folded in here.)
- **Invites** *(guild-scoped)* — mint (access roles, channels at a level, or a
  mirrored Discord role; single use and 7 days unless changed; who can use
  it under *Advanced*). The code stays on screen with Copy until *Done*.
  List, newest first, with each invite's status (Active / Used up / Expired);
  revoke an active one, delete a spent one. Search (code or label) + pagination.
- **Access roles** *(read guild-scoped, authoring super-admin)* — the named
  access roles, each bound to one guild, shown by level and where they apply.
  Defining a name that is taken asks "A role named … already exists — edit it
  instead?" (another guild's role is not touched from here).
  A guild-admin sees only their guild's; only super-admins may create/delete.
- **Audit** *(guild-scoped)* — every mutation, newest first.

**Scope control:** if you administer exactly one guild it's shown as a fixed
label; otherwise it's a selector. Super-admins also get a "Go to guild id…"
entry, which opens a field for the id in the top bar (they may act in any
guild).

## Addresses

Every place has an address after `#` (Caddy serves one page, so the path
can't carry it), so reload, Back, a shared link and a sign-in keep it:

```
#/                                  the last guild and tab you used here
#/g/<guild>/channels[?q=&show=agents|empty&cat=<category>]
#/g/<guild>/channels/c/<channel>    (a thread's → its channel's; a category's → ?cat=)
#/g/<guild>/personas[?q=]           #/g/<guild>/personas/p/<persona> · …/personas/add (Add persona)
#/g/<guild>/invites[?q=]            #/g/<guild>/invites/new[?r=<role>,…|c=<channel>&lvl=read|write|full]
#/g/<guild>/roles[?q=]              #/g/<guild>/roles/new
#/g/<guild>/audit[?q=]
#/all/personas[?q=&guild=]          #/all/personas/p/<persona>[?guild=] (super-admins)
#/guilds                                                                 (super-admins)
```

On `#/all/personas`, `?guild=` is the guild in view: the scope switch keeps it,
and an open persona's "Access in <guild>" section is about that guild, so a
reload or a sign-in brings the same drawer back. A persona id may be any id the
relay holds (up to 100 characters, on one line); it is percent-encoded in the
address. A search that is a whole invite code (`inv_…`) goes into the address
as its first 12 characters only, as the audit shows codes.

`lib.parseRoute` also knows the addresses later versions add (give access,
invite detail, role detail, the global audit); this version says
"That page isn't available yet" and shows the nearest page there is. Ids are
checked (guilds and channels are 5–25 digits; an invite is only ever the hash
of its code, never the code); anything else is "That link wasn't valid" and
home. A link into a guild you can't manage shows why — never that guild's data
or name — with the guilds you do manage and Try again.

Changing guild, tab or drawer adds a history entry; a search (and the
Channels tab's chips) changes the address in place, so Back never steps
through keystrokes. A drawer opened from its
list closes with Back; one reached by a link or a reload is replaced by its
list. Leaving a drawer with unsaved changes (Back, Forward, a link, closing
the page) asks first; Cancel steps back to the drawer's own history entry
(each entry the panel has been at carries its place in `history.state`), so
Back and Forward still go where they went.

## When the session ends

Sessions last 30 minutes (`PORTAL_ADMIN_SESSION_TTL_MS`). Two minutes before
the end a bar under the top bar says when, with **Sign in again**. A request
the relay refuses with 401 never throws the page away: "Your session ended"
comes up over it — "this change was NOT saved" after a change — and the page
and any open form stay as they were. **Sign in again** keeps this address and
the open form's unsaved fields (only the fields listed in `PA.lib.DRAFT_FORMS`:
never an invite code, a token or a picture) — the last-touched form with
changes, or a row's *Custom…* edit not yet applied, which comes back open and
is never applied by itself — in `sessionStorage`, and goes
through Discord; back in the panel, the same admin within 30 minutes gets the
same place and the form filled in again, with "Restored your unsaved change —
review and save. Nothing was submitted." Nothing is ever sent again by itself.

Coming back to the tab checks the session (`GET /admin/me`). Tabs tell each
other (`BroadcastChannel`) when someone signs in or out; a tab whose CSRF
token went stale because another tab signed in again fetches the new one and
sends its change once more (the relay refuses a bad token before doing
anything). If the browser is now signed in as another admin, the tab reloads.
Sign-in errors (`?login_error=`) are shown from a fixed table and removed
from the address.

## Signing in

Every way back from Discord ends in the panel or on the sign-in card with a
plain sentence and **Try again** — never an error page:

- Up to three sign-ins can be in flight in one browser (Sign in in two tabs,
  then finish both): each tab's sign-in completes.
- After signing in, Back (or a reload) onto the callback — or Discord's page
  sending the browser back with the same sign-in — goes to the panel, still
  signed in. Nothing is exchanged or recorded.
- Signing in again — the same admin, or another one — ends the session that
  browser had.
- Otherwise the callback sends the browser to `PORTAL_ADMIN_POST_LOGIN_URL`
  with one of these `login_error` codes, and the card says:

  | code | the card says |
  | --- | --- |
  | `cancelled` | Sign-in was cancelled in Discord. |
  | `expired` | That sign-in took too long or the relay restarted. Try again. |
  | `mismatch` | Sign-in was started in another tab. Try again here. |
  | `discord_error` | Discord didn't respond. Try again in a minute. |
  | `rate_limited` | Too many sign-in attempts. Wait a minute and try again. |
  | `not_admin` | You don't manage any guild this relay serves. … |

  A failed callback leaves the browser's other sign-ins as they were. Sign-ins
  in flight are kept in memory for ten minutes, so one that spans a relay
  restart comes back as `expired`.

Starting a sign-in (`/admin/login`) and the callback are each rate limited
per client address, 20 a minute (never globally). Each sign-in in flight is
counted against the address that started it: one address holds at most 100,
making room from its own oldest, and when every address together holds
10,000 the address holding the most gives way first — so a flood can't cancel
another admin's sign-in. The address is the rightmost `X-Forwarded-For` entry, which Caddy's
`reverse_proxy` sets to the address it saw, so keep the admin API reachable
only through Caddy. (Behind another proxy, such as a CDN, the limit applies
per address of that proxy.) The audit log records each failed callback as
`login.failed` with a fixed `reason` (`cancelled`, `expired`, `mismatch`,
`discord_error` — with the step and HTTP status when Discord failed the code
exchange), a refused sign-in as `login.denied`, and refusals over the limit as
at most one `login.rate_limited` record per address per minute, with a count
(and `step: login` for refused starts).

Browser storage is a convenience only (the panel works without it):
`localStorage` keeps `pa.lastGuild:<user>`, `pa.lastTab:<user>` and
`pa.collapsed:<user>:<guild>` (the Channels tab's folded groups; all cleared on
Sign out), `sessionStorage` keeps `pa.returnTo` and `pa.draft` for one sign-in.

## How it fits together

```
browser ──HTTPS──▶ Caddy ──┬─ /          → static assets (this dir)
                           └─ /admin/*    → reverse_proxy 127.0.0.1:8791 (relay admin API)
```

The browser holds only an httpOnly session cookie (set by the OAuth flow); the
SPA never sees a token. Every request but a GET carries the `X-CSRF-Token` header
read from `GET /admin/me` — sign-out included. The relay checks it once, before
it routes the request, so a request without it changes nothing.

## Deploy

1. **Copy the assets** to the box that runs Caddy, e.g. `/srv/portal-admin`.

2. **Configure Caddy.** Start from `Caddyfile.example`: set your hostname and
   point `root` at the asset directory. It serves `/` statically and proxies
   `/admin/*` to the relay on `127.0.0.1:8791`. (Keep the `handle /admin/*` block
   before the static handler.)

3. **Register a Discord OAuth app** (Discord Developer Portal → your app →
   OAuth2):
   - Add a redirect URI exactly matching what the relay is configured with, e.g.
     `https://portal-admin.example.com/admin/callback`.
   - Scopes used by the flow: `identify guilds` (the relay requests these).
   - Note the **Client ID** and **Client Secret**.

4. **Configure the relay** (admin API) with these env vars and restart it:

   ```sh
   PORTAL_ADMIN_ENABLED=true
   PORTAL_ADMIN_PORT=8791                 # localhost bind; Caddy proxies to it
   PORTAL_OAUTH_CLIENT_ID=<discord client id>
   PORTAL_OAUTH_CLIENT_SECRET=<discord client secret>
   PORTAL_OAUTH_REDIRECT_URI=https://portal-admin.example.com/admin/callback
   PORTAL_ADMIN_POST_LOGIN_URL=/          # where to land after login (the SPA)
   PORTAL_SUPERADMINS=<discord user id>,<discord user id>
   PORTAL_ADMIN_AUDIT=/var/lib/portal/audit.jsonl
   # optional: PORTAL_ADMIN_SESSION_TTL_MS=1800000
   ```

   For **local dev** without TLS, also set `PORTAL_ADMIN_COOKIE_INSECURE=true` so
   the session cookie is sent over plain http. (See `portal-relay/scripts/
   admin-dev.mjs` for a no-bot local harness.)

## Who can do what

- **Guild-admins** (Discord `ADMINISTRATOR` / `MANAGE_GUILD` / owner of a guild):
  manage invites, personas' access roles, and per-guild direct grants — scoped to guilds
  they administer. They express access by mirroring their own Discord roles or
  picking channels. A guild-admin's tool for "remove an agent from my guild" is
  *Remove from <guild>* in its drawer (slash `/ban`).
- **Super-admins** (in `PORTAL_SUPERADMINS`): all of the above in **any** guild,
  plus authoring the global access-role catalog (Access roles tab) and, on
  Personas, the *All personas* view, profile pictures and **token lifecycle**
  (rotate/revoke).

## API contract (what the SPA expects)

Lists accept `?q=&limit=&offset=` and return `{ items…, total, limit, offset }`.

- `GET /admin/login[?reauth=1]` → Discord; `GET /admin/callback` → the panel (see
  [Signing in](#signing-in)); `reauth=1` only marks the `login.ok` record.
- `GET /admin/me` → `{user, isSuper, guilds:[{id,name}], csrf, apiVersion, levels, caps,
  features:{invites,avatarUploads,allowlistEditable}, session:{expiresAt}}` — `levels`
  and `caps` are the relay's Read/Write/Full and capability list (the panel keeps a
  copy for an older relay); a relay whose `apiVersion` is newer than the panel's
  `PA.CLIENT_API` (3) gets a "The panel was updated — Reload" banner. `apiVersion` 3
  added the effective-access reads (`…/access/summary`, `…/channels/:cid/access`,
  `…/personas/:id/access`), `…/persona-directory`, `…/remove` and `…/resync`. On an
  older relay (deployed after the panel, or rolled back) the Channels tab, a channel's
  drawer and a persona's drawer in a guild say "This panel needs the relay updated —
  Reload once the relay is updated" instead of asking for what it doesn't have; the
  Personas list still lists (without counts, and without *Add persona*), a persona's
  drawer is named from that relay's own `GET …/personas/:id` (which says, itself, when
  there is no such persona), and a super-admin still gets the persona's *Identity*. An access read answered `404` is
  checked against `/admin/me` before anything says the persona or channel is gone (a
  relay rolled back since the tab loaded). A relay older than `apiVersion` 2 (one that
  sends none) reads a grant without `caps` and every guild-wide `DELETE` as a deny, so
  if the relay drops that far under an open drawer, the panel sends it direct grants
  as `{caps}` only (no `channelId` meaning guild-wide), Deny guild-wide as a bare
  `DELETE`, and offers no *Unset*. `POST /admin/logout`
- `GET /admin/g/:gid/personas` → `{personas:[{id,displayName,roles,hasOverride,directGrants,guildWideDenied,
  inactiveGrants}], total,limit,offset}`; `directGrants` is `grants` (a direct grant gives something
  here), `denied` (denied guild-wide, nothing given) or `none`; `inactiveGrants` counts the direct
  grants here that do nothing; super-admins also get `otherGuildRoleCount`
- `GET /admin/g/:gid/personas/:id` → `{id,displayName,roles,guildPolicy}` (+ `otherGuildRoleCount` for super-admins).
  A guild-admin gets only that guild's access roles.
- `POST/DELETE /admin/g/:gid/personas/:id/roles[/:role]`; `POST …/claim`. A role that grants
  something, or an invite that gives access, to a persona removed from that guild is
  `409 BANNED` (nothing given or applied) unless the body says `liftBan: true` — the admin
  was asked, and chose to lift the removal.
- `POST /admin/g/:gid/personas/:id/remove` → `{rolesRemoved, accessFullyRevoked}` — what slash `/ban`
  does in the guild (one shared function): its access roles bound to the guild off, every direct
  grant there dropped, guild-wide pinned to deny, the removal recorded. Audited as
  `persona.guild.remove`.
- `POST /admin/g/:gid/personas/:id/resync` → `{ok}` (+ `pushed`, the channels re-sent, for super-admins
  only) — at most once per 10 s per persona, else `429 RATE_LIMITED {retryAfterMs}`. Audited as
  `persona.resync`.
- `PUT /admin/g/:gid/personas/:id/grants` — one target, `{channelId}` or `{guildDefault:true}`,
  and one operation, `{level:'read'|'write'|'full'}`, `{caps:[…]}` (non-empty, known) or
  `{deny:true}`. Refusals: `TARGET_REQUIRED`, `EMPTY_CAPS`, `UNKNOWN_CAP`, `THREAD_TARGET`
  (with `parentId`), `CATEGORY_TARGET`, `NOT_GRANTABLE` (400); a channel of another guild 403.
- `DELETE /admin/g/:gid/personas/:id/grants` with exactly one of `?channelId=`,
  `?guildDefault=deny` (an explicit deny) or `?guildDefault=unset` (fall back to the
  persona default). Audit records carry `before` and `after`.
- Both grant routes take `expect` (what the panel last saw at the target: caps, or `null`
  for nothing set; compared as sets — anything else there now is `409 CONFLICT {current}`
  and nothing is written) and `batchId` (`^[A-Za-z0-9_-]{1,32}$`, kept in the audit
  record's `detail`); DELETE takes them as a JSON body. Answers carry `effective`: for a
  channel, what the persona can do there now and why (as a row below), with `names`
  for the Discord roles its mirror sources follow; guild-wide,
  `{guildWide:true, channels, counts:{read,write,full,custom}, direct:{…}}` — how many
  of the guild's channels at each level, and how many of those through a direct grant.
  A PUT that gives something to a persona removed from the guild (`/ban`, or Remove) is
  `409 BANNED` and writes nothing unless it says `liftBan: true` (the admin was asked,
  and chose to lift the removal); one that did says `liftedBan: true` (the persona
  changed in every channel of the guild). So an Undo, or any write from a view read
  before the removal, can never lift it. A deny needs no lift.
- `GET /admin/g/:gid/invites?q=&status=active|spent|all` → newest first, each with
  `status` (`active` · `used` · `expired`); `POST …/invites`, `DELETE …/invites/:code`
- `GET /admin/g/:gid/roles` → `{catalog, discordRoles, canAuthor}` (a guild-admin gets
  that guild's roles only); `GET …/audit`
- `GET /admin/g/:gid/channels` → `{channels:[{id,name,type,parentId?,categoryId,position,
  announcement,grantable}], categories:[{id,name,position}]}`
- Effective access — what the relay enforces (its own `capsFor`: the persona's access
  within what the relay's bot can do there, nothing after a `/ban`), and why. Each sends
  `Server-Timing: access;dur=<ms>`.
  - `GET …/access/summary` → `{channels:[{id, counts:{read,write,full,custom}, botBase,
    botCantView, botLacks?}], personas:[{id, counts}], considered, computedAt, truncated?}` —
    per channel with access of its own (any kind but a thread or a category, kinds the
    panel can't give access on included), how many personas can act there at each level
    (counted where they can see it, as `/list` counts); `botLacks`: what of Write the
    relay's bot can't do there. Reused for 5 s, dropped by any permissions
    change; past 100k personas × channels the counts are left out (`truncated`).
  - `GET …/channels/:cid/access` → `{channel, botCaps, botBase, rows:[{personaId,
    displayName, avatarUrl, effective, level, base, extra, direct, sources, botLimited,
    botLacks}], names}`; a thread → `{inert:'thread', parentId}`, a category →
    `{inert:'category', channels}`. A channel that isn't the guild's is one 404, whatever
    the reason. `sources` name the reasons: `direct`, `block`, `role` (`how`: all ·
    channels · mirror), `guildWide`, `personaDefault`, `relayDefault`, `removed` (`/ban`);
    one that doesn't count there carries `shadowedBy`.
  - `GET …/personas/:id/access` → `{persona, removed, guildWide (caps|'deny'|null),
    personaDefault, relayDefault, rows:[{channelId, …}] (every channel with access of its
    own, as the summary counts them), inactive:[{channelId, caps,
    reason: thread|category|missing|blocks-nothing}], roles:[{name, caps, scope, channels}],
    names}` (+ `otherGuildRoleCount` for super-admins)
  - `GET …/persona-directory?q=` → `{personas:[{id, displayName, avatarUrl,
    hasAccessHere, removed?}]}` — at most 25, the people slash `/add` offers: an exact id
    first, then names starting with `q`, then the rest. `removed: true` marks one removed
    from the guild with `/ban` (giving it access there lifts that). `?ids=a,b` gives
    exactly those personas instead, in that order (a form put back after Sign in again).
- `POST /admin/roles {name, role, replace?, expectedGuildId?}` *(super-admin, global)* —
  a name in use is `409 EXISTS` unless `replace:true` names the guild it belongs to
  (else `409 GUILD_MISMATCH`; replacing never moves a role). New names match
  `^[a-z0-9][a-z0-9._-]{0,63}$`. `DELETE /admin/roles/:name`
- `GET /admin/personas` → `{personas:[{id,displayName,roles,guildCount}], total,…}` *(super-admin)*
- `GET /admin/personas/:id` → `{id,displayName,roles,guilds}`; `POST /admin/personas/:id/token` *(super-admin)*

## Notes

- Rotated tokens are shown exactly once — copy and deliver out-of-band.
- No client-side authz: the relay decides on every request. A guild-admin
  following a link into another guild gets the Not-an-admin view (the panel
  asks nothing of a guild that isn't in their list, and shows the same view
  when the relay answers `403`). Token endpoints return `403` for
  non-super-admins.
- Feedback: every result or error appears in the status line of the section it
  came from and stays there; a toast mirrors it. Error toasts stay until
  dismissed (✕) or until the same section reports a newer result; the rest
  fade after about 6 seconds. Toasts stack at the bottom of the screen (left
  of an open drawer on a wide screen), and the page keeps that much room at
  its end, so nothing stays hidden under them. A button that sends a
  request is disabled until the answer arrives, so a double click sends one.
- Keyboard: `/` focuses the active search box. Tabs, channel rows and
  persona names are links. A type-ahead opens its list as you type (or with
  `↓`); `↑`/`↓` move, `Enter` picks, `Esc` closes the list (the next `Esc` is
  the drawer's), `Backspace` in the empty field removes the last pick. On a
  direct grant, a step with the arrow keys is held until `Enter` (or leaving
  the control) applies it; `Esc` puts back what is set, and the next `Esc` is
  the drawer's. In the drawer, `Esc` (or a click on the dimmed page) asks "Discard
  changes?" when a form (or a *Custom…* edit) has unsaved edits, otherwise leaves a focused field,
  otherwise closes the drawer and puts focus back on the link that opened it.
  `Tab` stays inside the drawer and dialogs; `Enter` submits the section's form.
- Below 640px wide the top bar wraps, the Personas list and both drawers'
  rows become labelled cards, other tables scroll sideways inside their box,
  and the drawer takes the whole screen.
