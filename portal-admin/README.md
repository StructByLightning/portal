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
├── ui.js             DOM helpers and widgets (window.PA.ui): toasts, status
│                     lines, busy buttons, confirm dialogs, the level control,
│                     checkbox lists, the drawer, "Your session ended", the
│                     expiry bar, the Not-an-admin view
├── app.js            API client, resource tabs, dense tables, all mutations
│                     (window.PA.app)
├── styles.css        self-contained styling (dense, dark/light, CSP-clean)
├── Caddyfile.example reverse-proxy + static-serve vhost
└── README.md
```

Each script is a classic `defer` script wrapped in one IIFE that assigns a
single global, `window.PA.<module>`; `index.html` loads them in order with a
`?v=` release query, which you bump when a release changes them. Nothing sets
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

- **Personas** — the one place for a persona (portal's only kind of speaker).
  The table (avatar · name · id · access roles · direct grants?) lists the
  personas with access in the selected guild; super-admins can switch it to
  **All personas** (with each one's guild count). Click a row → a right-side
  **drawer**:
  - *Access in <guild>* — its direct grants in this guild first: set Read,
    Write, Full or Custom… on one channel (text, voice or forum — a thread
    uses its parent's access and a category grants nothing) or guild-wide.
    The guild-wide row says whether it is set, denied or not set, with *Unset*
    (fall back to the persona default) and *Deny guild-wide* (block the
    persona default here; access roles still apply). Then this guild's access
    roles, each with what it means; and, under
    *More*, applying an invite made for an existing persona;
  - *(super-admin)* Profile picture (Upload only when the relay keeps uploads,
    `PORTAL_AVATAR_DIR`), *Access in every guild* (where it can act,
    what each access role confers, its direct grants everywhere) and **Token**
    (rotate / revoke) — a token authenticates a persona everywhere, so it is
    not a per-guild action.

  "Grant access by id" reaches a persona that has no access yet. (The former
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
#/g/<guild>/personas[?q=]           #/g/<guild>/personas/p/<persona>
#/g/<guild>/invites[?q=]            #/g/<guild>/invites/new[?r=<role>,…|c=<channel>&lvl=read|write|full]
#/g/<guild>/roles[?q=]              #/g/<guild>/roles/new
#/g/<guild>/audit[?q=]
#/all/personas[?q=]                 #/all/personas/p/<persona>          (super-admins)
#/guilds                                                                 (super-admins)
```

`lib.parseRoute` also knows the addresses later versions add (channels, give
access, invite detail, role detail, the global audit); this version says
"That page isn't available yet" and shows the nearest page there is. Ids are
checked (guilds and channels are 5–25 digits; an invite is only ever the hash
of its code, never the code); anything else is "That link wasn't valid" and
home. A link into a guild you can't manage shows why — never that guild's data
or name — with the guilds you do manage and Try again.

Changing guild, tab or drawer adds a history entry; a search changes `?q=`
in place, so Back never steps through keystrokes. A drawer opened from its
list closes with Back; one reached by a link or a reload is replaced by its
list. Leaving a drawer with unsaved changes (Back, a link, closing the page)
asks first.

## When the session ends

Sessions last 30 minutes (`PORTAL_ADMIN_SESSION_TTL_MS`). Two minutes before
the end a bar under the top bar says when, with **Sign in again**. A request
the relay refuses with 401 never throws the page away: "Your session ended"
comes up over it — "this change was NOT saved" after a change — and the page
and any open form stay as they were. **Sign in again** keeps this address and
the open form's unsaved fields (only the fields listed in `PA.lib.DRAFT_FORMS`:
never an invite code, a token or a picture) in `sessionStorage`, and goes
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

Browser storage is a convenience only (the panel works without it):
`localStorage` keeps `pa.lastGuild:<user>` and `pa.lastTab:<user>` (cleared on
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
  revoking its guild-scoped roles/grants.
- **Super-admins** (in `PORTAL_SUPERADMINS`): all of the above in **any** guild,
  plus authoring the global access-role catalog (Access roles tab) and, on
  Personas, the *All personas* view, profile pictures and **token lifecycle**
  (rotate/revoke).

## API contract (what the SPA expects)

Lists accept `?q=&limit=&offset=` and return `{ items…, total, limit, offset }`.

- `GET /admin/me` → `{user, isSuper, guilds:[{id,name}], csrf, apiVersion, levels, caps,
  features:{invites,avatarUploads,allowlistEditable}, session:{expiresAt}}` — `levels`
  and `caps` are the relay's Read/Write/Full and capability list (the panel keeps a
  copy for an older relay); a relay whose `apiVersion` is newer than the panel's
  `PA.CLIENT_API` gets a "The panel was updated — Reload" banner. `POST /admin/logout`
- `GET /admin/g/:gid/personas` → `{personas:[{id,displayName,roles,hasOverride,directGrants}], total,limit,offset}`;
  `directGrants` is `grants` (a direct grant gives something here), `denied` (denied
  guild-wide, nothing given) or `none`; super-admins also get `otherGuildRoleCount`
- `GET /admin/g/:gid/personas/:id` → `{id,displayName,roles,guildPolicy}` (+ `otherGuildRoleCount` for super-admins).
  A guild-admin gets only that guild's access roles.
- `POST/DELETE /admin/g/:gid/personas/:id/roles[/:role]`; `POST …/claim`
- `PUT /admin/g/:gid/personas/:id/grants` — one target, `{channelId}` or `{guildDefault:true}`,
  and one operation, `{level:'read'|'write'|'full'}`, `{caps:[…]}` (non-empty, known) or
  `{deny:true}`. Refusals: `TARGET_REQUIRED`, `EMPTY_CAPS`, `UNKNOWN_CAP`, `THREAD_TARGET`
  (with `parentId`), `CATEGORY_TARGET`, `NOT_GRANTABLE` (400); a channel of another guild 403.
- `DELETE /admin/g/:gid/personas/:id/grants` with exactly one of `?channelId=`,
  `?guildDefault=deny` (an explicit deny) or `?guildDefault=unset` (fall back to the
  persona default). Audit records carry `before` and `after`.
- `GET /admin/g/:gid/invites?q=&status=active|spent|all` → newest first, each with
  `status` (`active` · `used` · `expired`); `POST …/invites`, `DELETE …/invites/:code`
- `GET /admin/g/:gid/roles` → `{catalog, discordRoles, canAuthor}` (a guild-admin gets
  that guild's roles only); `GET …/channels`; `GET …/audit`
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
- Keyboard: `/` focuses the active search box. Tabs and persona names are
  links. In the drawer, `Esc` (or a click on the dimmed page) asks "Discard
  changes?" when a form has unsaved edits, otherwise leaves a focused field,
  otherwise closes the drawer and puts focus back on the link that opened it.
  `Tab` stays inside the drawer and dialogs; `Enter` submits the section's form.
- Below 640px wide the top bar wraps, tables scroll sideways inside their box,
  and the drawer takes the whole screen.
