/* Portal Admin SPA — vanilla JS, no dependencies, no build step.
 *
 * Resource-first IA: top-level tabs (Personas / Invites / Access roles / Audit,
 * plus Guilds for super-admins) with a persistent guild scope in the header.
 * Dense tables + a right-side detail drawer for editing one row at a time.
 *
 * Every place has an address after '#' (PA.lib.parseRoute): reload, Back, a
 * shared link and a sign-in all come back to it. One applyRoute() makes the
 * page match the address, whatever changed it — a link, Back, a search.
 *
 * Pure API client: every authorization decision is server-side. The CSRF token
 * from /admin/me is echoed in X-CSRF-Token on all mutating requests. A session
 * that ends mid-task never throws the page away: "Your session ended" comes up
 * over it, and "Sign in again" keeps the place and the unsaved form.
 *
 * Feedback: every result lands in the inline status line of the section it
 * came from (and stays there), mirrored by a toast. DOM helpers and widgets
 * live in ui.js (window.PA.ui); this file assigns only window.PA.app.
 */
(function () {
'use strict';

const ui = window.PA.ui;
const lib = window.PA.lib; // levels, summaries, names (pure; see lib.js)
const { el, clear } = ui;
const { chanText, roleText, guildText, levelLabel, capsSummary, capsTitle } = lib;

const LIMIT = 50;

/** The admin API this panel speaks. /admin/me says which one the relay
 *  speaks; when the relay is newer, the panel asks for a reload. */
const CLIENT_API = 2;

/** The first relay API with the direct-grant operations this panel sends: a
 *  level by name, guild-wide as {guildDefault: true}, and Unset and Deny
 *  guild-wide as their own operations. An older relay (one that sends no
 *  apiVersion: the panel can be deployed before it) reads a grant without
 *  caps as a deny and every guild-wide DELETE as a deny, so it is sent caps
 *  only, and offered no Unset (see grantEditor). */
const GRANT_API = 2;

/** The admin API the relay speaks: 1 for one too old to say. */
function relayApi() {
  const v = state.me && state.me.apiVersion;
  return typeof v === 'number' ? v : 1;
}

const state = {
  me: null,        // /admin/me: { user, isSuper, guilds, csrf, apiVersion, levels, caps, features, session }
  guilds: [],      // the guilds this admin may manage (and the relay serves), named
  guildId: null,   // selected guild id (null when no guild is selectable)
  tab: 'personas',
  personaScope: 'guild', // super-admins: 'guild' (access here) or 'all' personas
  q: '',           // current search query for the active list
  offset: 0,       // current page offset for the active list
  cache: {},       // per-guild { roles, channels } caches
  list: null,      // the active list view: { refresh, search, status }
  listStale: false, // a drawer changed something the list shows: refresh on close
  rowKey: null,    // data-key of the list row the open drawer belongs to
  renderSeq: 0,    // bumped by every render(); a slower, older one stops drawing
  route: null,     // the route the page shows (PA.lib.parseRoute)
  viewKey: null,   // which list is drawn (guild + tab); a change redraws it
  drawerRoute: null, // the address of the open drawer, if a route opened one
  drawerPushed: false, // that drawer was opened from its list: closing it goes Back
  histIdx: 0,      // where this entry is in the tab's history (each entry is stamped)
  routeAt: 0,      // histIdx of the entry state.route was shown at
  restoring: null, // the address a Cancel is stepping back to, until it lands
  draft: null,     // an unsaved form brought back across a sign-in, until used
  leaving: false,  // on the way to sign in: no "Leave site?" question
  expiryTimer: null,
  clockSkew: 0,    // the relay's clock minus this one (from the Date header)
};

const $ = (sel, root = document) => root.querySelector(sel);

// ── Browser storage: conveniences only ─────────────────────────────────────────
// Every access can throw (a private window, blocked site data); the panel works
// without any of it.

function storage(kind) {
  const s = () => window[kind];
  return {
    get(k) { try { return s().getItem(k); } catch { return null; } },
    set(k, v) { try { s().setItem(k, v); } catch { /* not kept */ } },
    del(k) { try { s().removeItem(k); } catch { /* nothing to remove */ } },
    keys() {
      try {
        const out = [];
        for (let i = 0; i < s().length; i++) out.push(s().key(i));
        return out;
      } catch { return []; }
    },
  };
}
const local = storage('localStorage');   // pa.lastGuild:<user>, pa.lastTab:<user>
const session = storage('sessionStorage'); // pa.returnTo, pa.draft, pa.notice
/** Read a sessionStorage key once: it is deleted as it is read. */
function takeSession(k) {
  const v = session.get(k);
  session.del(k);
  return v;
}

const userId = () => (state.me && state.me.user && state.me.user.id) || '';
const isSuper = () => !!(state.me && state.me.isSuper);

// ── API layer ──────────────────────────────────────────────────────────────────

class ApiError extends Error {
  /** `detail`: the rest of the relay's error body (parentId, reason, existing…).
   *  `method`: the request's, so a lost answer to a change can be told from a
   *  failed read (lib.errorText). */
  constructor(status, code, message, detail, method) {
    super(message || code || ('HTTP ' + status));
    this.status = status;
    this.code = code;
    this.method = method;
    for (const k of ['parentId', 'reason', 'existing']) if (detail && detail[k] !== undefined) this[k] = detail[k];
  }
}

/**
 * JSON request to the admin API. opts.raw sends `body` as-is with
 * opts.contentType (avatar upload).
 *   401 → "Your session ended" over the page (not at boot, or with opts.quiet),
 *         and a rejection: nothing is redrawn, so the form stays as it was.
 *   403 CSRF → this tab's token is stale (another tab signed in again): fetch
 *         /admin/me and send once more with the new one — the relay refuses a
 *         bad token before doing anything, so the retry can't double up. A
 *         different admin in the cookie now → reload.
 *   403 FORBIDDEN on a guild route → the Not-an-admin view for that guild.
 */
async function api(method, path, body, opts = {}) {
  const req = { method, credentials: 'same-origin', headers: {} };
  if (opts.raw) {
    req.headers['content-type'] = opts.contentType;
    req.body = body;
  } else if (body !== undefined) {
    req.headers['content-type'] = 'application/json';
    req.body = JSON.stringify(body);
  }
  if (method !== 'GET' && state.me && state.me.csrf) req.headers['X-CSRF-Token'] = state.me.csrf;
  let res;
  try { res = await fetch(path, req); }
  catch { throw new ApiError(0, 'NETWORK', 'network error', null, method); }
  noteClock(res);
  if (res.status === 401) {
    if (!opts.boot && !opts.quiet && state.me) sessionEnded(method === 'GET' ? 'read' : 'mutation');
    throw new ApiError(401, 'UNAUTHENTICATED', 'login required', null, method);
  }
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON */ } }
  if (!res.ok) {
    const b = (data && data.error) || {};
    const e = new ApiError(res.status, b.code, b.message, b, method);
    if (res.status === 403 && b.code === 'CSRF' && method !== 'GET' && !opts.retried && state.me) {
      const fresh = await refreshMe();
      if (fresh) return api(method, path, body, Object.assign({}, opts, { retried: true }));
    }
    const gm = /^\/admin\/g\/([^/?]+)/.exec(path);
    if (res.status === 403 && b.code === 'FORBIDDEN' && b.reason === 'NOT_GUILD_ADMIN' && gm) {
      e.handled = true;
      notGuildAdmin(decodeURIComponent(gm[1]));
    }
    throw e;
  }
  return data || {};
}

/** The relay's clock, from a response's Date header: the session's end is in
 *  its time, and the expiry bar must count in this one. */
function noteClock(res) {
  const h = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('date') : null;
  const at = h ? Date.parse(h) : NaN;
  if (!isNaN(at)) state.clockSkew = at - Date.now();
}

const G = () => gpath(state.guildId);
/** A guild's admin API prefix. Anything that sends a change later (after a
 *  confirm, from a drawer) builds its path from the guild it captured when
 *  it was drawn, never from the guild in view when it is sent. */
const gpath = (gid) => '/admin/g/' + encodeURIComponent(gid);
function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}

const NOT_GUILD_ADMIN = lib.NOT_GUILD_ADMIN;

/** New access-role names, as the relay accepts them. */
const ROLE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A failed change, as a status line: 'Not saved: <reason>. <what to do>.'
 *  `ctx` says what it was about ({channelId, names} or {roleName}), so the
 *  relay's codes can be put in words (lib.errorText). */
function notDone(e, prefix = 'Not saved', ctx) {
  return lib.errorText(e, prefix, ctx);
}

/** A failed read, as a line: 'Couldn’t load <what>: <reason>.' */
function couldntLoad(what, e) {
  if (lib.noAnswer(e)) return 'Couldn’t reach the relay to load ' + what + '. Try again.';
  if (e && e.status === 403 && e.code === 'FORBIDDEN') return NOT_GUILD_ADMIN;
  const why = String((e && e.message) || 'something went wrong').trim().replace(/[.\s]+$/, '');
  return 'Couldn’t load ' + what + ': ' + why + '.';
}

/** An inline load error with a Try again button. */
function loadError(text, retry) {
  return el('div', { class: 'load-error', role: 'alert' }, [
    el('p', { text }),
    retry ? el('button', { class: 'btn btn-sm', text: 'Try again', onclick: retry }) : null,
  ]);
}

// Per-guild role catalog + channels, cached (used by editors/pickers). The
// promise is cached, so a list and a drawer opened together ask once.
function guildMeta(gid = state.guildId) {
  const key = gid;
  if (!state.cache[key]) {
    const p = Promise.all([api('GET', gpath(gid) + '/roles'), api('GET', gpath(gid) + '/channels')]).then(([roles, chans]) => ({
      catalog: roles.catalog || {}, discordRoles: roles.discordRoles || [],
      canAuthor: !!roles.canAuthor, channels: chans.channels || [],
    }));
    state.cache[key] = p;
    p.catch(() => { if (state.cache[key] === p) delete state.cache[key]; });
  }
  return state.cache[key];
}
/** The role catalog changed: it is global, so every guild's cached copy goes. */
function invalidateGuildMeta() { state.cache = {}; }

/** Name maps for a guild's own pickers (the selected one by default): its
 *  channels, its Discord roles and its name. */
function metaNames(meta, gid = state.guildId) {
  const names = withChannelList(null, meta.channels, meta.discordRoles);
  names.guilds = { [gid]: guildName(gid) };
  return names;
}

/** The access roles bound to a guild (the selected one by default), by name.
 *  Pickers and chips show only these; another guild's roles are not this
 *  guild's to hand out. */
function guildRoleNames(meta, gid = state.guildId) {
  const cat = meta.catalog || {};
  return Object.keys(cat).filter((n) => cat[n] && cat[n].guildId === gid).sort(byName);
}

// ── Boot / auth ──────────────────────────────────────────────────────────────

/** The sign-in card: at boot, when there is no session. Mid-session an ended
 *  session is "Your session ended" over the page instead, never this. */
function showLogin(errMsg) {
  $('#app').classList.add('hidden');
  closeDrawerFor('route');
  document.title = 'Portal admin';
  $('#login').classList.remove('hidden');
  const box = $('#login-error');
  clear(box);
  box.classList.toggle('hidden', !errMsg);
  if (errMsg) {
    box.appendChild(el('p', { class: 'error', text: errMsg }));
    box.appendChild(el('a', { class: 'btn', href: '/admin/login', text: 'Try again', onclick: keepReturnTo }));
  }
}

/** Before going to sign in: keep this address to come back to (unless it is
 *  only home, and an earlier one is waiting). */
function keepReturnTo() {
  const r = lib.parseRoute(location.hash);
  const h = r && r.area !== 'home' ? lib.formatRoute(r) : null;
  if (h && lib.isSafeReturnTo(h)) session.set('pa.returnTo', h);
}

/** The open drawer's unsaved form, as a draft for after the sign-in: only
 *  its whitelisted fields (PA.lib.DRAFT_FORMS), only when it has changes,
 *  and only for a drawer that is at its own address — a draft comes back
 *  where its address is, so one kept under a list's address could open in
 *  any drawer of that list. */
function saveDraft() {
  session.del('pa.draft');
  const f = ui.drawer.isOpen() ? ui.drawer.activeForm() : null;
  if (!f || (f.isDirty && !f.isDirty())) return;
  if (!state.drawerRoute || state.drawerRoute !== location.hash) return;
  let fields;
  try { fields = f.serialize(); } catch { return; }
  const d = lib.makeDraft({ userId: userId(), route: location.hash, form: f.key, fields, at: Date.now() });
  if (d) session.set('pa.draft', JSON.stringify(d));
}

/** "Sign in again": keep the place and the unsaved form, then go through
 *  Discord. Nothing is sent again afterwards — the form comes back filled
 *  in, and the admin saves it. */
function signInAgain() {
  keepReturnTo();
  saveDraft();
  state.leaving = true;
  location.assign('/admin/login');
}

/** The session is over (a 401, or a sign-out in another tab): say so over the
 *  page, which stays as it is — and, once that is closed, in the bar (the
 *  drawer's own copy while it is open). */
function sessionEnded(kind) {
  clearTimeout(state.expiryTimer);
  ui.expiryBar().show(kind === 'elsewhere' ? 'You signed out in another tab.' : 'Your session ended.', 'Sign in again', signInAgain);
  ui.sessionEnded({ kind, onSignIn: signInAgain });
}

async function boot() {
  const btn = $('#login-btn');
  if (btn && !boot.bound) { boot.bound = true; btn.addEventListener('click', keepReturnTo); }
  // This entry's place in the tab's history (kept across a reload).
  const hs = history.state;
  state.histIdx = hs && typeof hs.paIdx === 'number' ? hs.paIdx : 0;
  replaceHash(location.pathname + location.search + location.hash);
  const params = new URLSearchParams(location.search);
  // Why a sign-in came back here: a fixed code, put in words by a fixed
  // table (nothing from the URL is shown), and taken out of the address.
  const loginError = lib.loginErrorText(params.has('login_error') ? params.get('login_error') : null);
  if (params.has('login_error')) {
    params.delete('login_error');
    const rest = params.toString();
    replaceHash(location.pathname + (rest ? '?' + rest : '') + location.hash);
  }
  let me;
  try { me = await api('GET', '/admin/me', undefined, { boot: true }); }
  catch (e) {
    if (e.status === 401) return showLogin(loginError);
    return showLogin('Couldn’t reach the admin API: ' + e.message + '. Reload to try again.');
  }
  state.me = me;
  // The relay's own levels and capabilities, when it sends them.
  if (me.levels && me.caps) lib.adoptModel(me.levels, me.caps);
  if (typeof me.apiVersion === 'number' && me.apiVersion > CLIENT_API) showUpdateBanner();
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');

  $('#user-name').textContent = (me.user && me.user.name) || 'admin';
  $('#super-badge').classList.toggle('hidden', !me.isSuper);
  // Super-admin-only tabs (Guilds).
  for (const t of document.querySelectorAll('.tab-super')) t.classList.toggle('hidden', !me.isSuper);

  await loadGuilds();

  // A sign-in that came back with an error while this browser still had a
  // good session: the panel opens, and says what happened.
  if (loginError) ui.toast(loginError, { kind: 'info' });
  if (takeSession('pa.notice') === 'other-user') {
    ui.toast('Another admin signed in in another tab, so this tab now shows ' + ((me.user && me.user.name) || 'their account') + '.', { kind: 'info' });
  }

  // Where to start: this address; else the place kept before signing in;
  // else home. Both are read once, after the sign-in worked.
  const returnTo = takeSession('pa.returnTo');
  state.draft = lib.readDraft(takeSession('pa.draft'), { userId: userId(), now: Date.now() });
  const here = lib.parseRoute(location.hash);
  if (here && here.area === 'home' && lib.isSafeReturnTo(returnTo)) replaceHash(returnTo);

  bindApp();
  scheduleExpiry();
  broadcast('signed-in');
  await applyRoute();
}

function bindApp() {
  if (bindApp.done) return;
  bindApp.done = true;
  $('#logout-btn').addEventListener('click', logout);
  // Back, Forward, a link, an edited address: one place makes the page match.
  window.addEventListener('popstate', onHistory);
  window.addEventListener('hashchange', onHistory);
  window.addEventListener('beforeunload', (e) => {
    if (state.leaving || !ui.drawer.isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });
  // Back to this tab: is the session still good? Better asked now than after
  // typing into a form.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.me) refreshMe();
  });
  // Esc, Tab and the scrim inside the drawer and dialogs are ui.js's.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || ui.drawer.isOpen() || ui.modalOpen()) return;
    const a = document.activeElement;
    if (a && (/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) || a.isContentEditable)) return;
    const s = $('#list-search');
    if (s) { e.preventDefault(); s.focus(); }
  });
  openChannel();
}

/** The relay speaks a newer admin API than this copy of the panel: say so,
 *  with a way to load the new one. */
function showUpdateBanner() {
  if ($('#update-banner')) return;
  const host = $('#notices') || $('#app');
  const reload = el('button', { class: 'btn btn-sm', text: 'Reload', onclick: () => location.reload() });
  host.appendChild(el('div', { id: 'update-banner', class: 'banner banner-update', role: 'status' }, [
    el('span', { text: 'The panel was updated — ' }), reload,
  ]));
}

/** What the relay has switched on (from /admin/me; all on for a relay too
 *  old to say). */
function feature(name) {
  const f = state.me && state.me.features;
  return !f || f[name] !== false;
}

let meInFlight = null;
/**
 * Who is this tab signed in as, now? (Another tab may have signed in again,
 * or out.) The same admin: take the new CSRF token and session end, and put
 * away "Your session ended" if it was up. Another admin: reload. A relay
 * that came back newer (a deploy) gets the same "The panel was updated"
 * banner as at boot. Resolves the new /admin/me, or null (a 401 has already
 * said the session ended).
 */
function refreshMe() {
  if (!meInFlight) {
    meInFlight = (async () => {
      try {
        const me = await api('GET', '/admin/me');
        if (!state.me) return null;
        if (((me.user && me.user.id) || '') !== userId()) { otherAdmin(); return null; }
        state.me.csrf = me.csrf;
        state.me.session = me.session;
        state.me.apiVersion = me.apiVersion; // what changes are sent in (relayApi)
        if (typeof me.apiVersion === 'number' && me.apiVersion > CLIENT_API) showUpdateBanner();
        if (me.levels && me.caps) lib.adoptModel(me.levels, me.caps);
        if (ui.sessionResumed()) ui.toast('You’re signed in again. Carry on where you were.');
        scheduleExpiry();
        return me;
      } catch { return null; }
      finally { meInFlight = null; }
    })();
  }
  return meInFlight;
}

/** The cookie now belongs to another admin (signed in in another tab): this
 *  tab can't act for them with what it shows, so it reloads as them. */
function otherAdmin() {
  session.set('pa.notice', 'other-user');
  state.leaving = true;
  location.reload();
}

// Tabs tell each other when someone signs in or out (same browser, same panel).
let channel = null;
function openChannel() {
  try {
    if (typeof BroadcastChannel !== 'function') return;
    channel = new BroadcastChannel('portal-admin');
    channel.onmessage = (ev) => {
      const m = ev && ev.data;
      if (!m || !state.me) return;
      if (m.type === 'signed-in') refreshMe();
      else if (m.type === 'signed-out') sessionEnded('elsewhere');
    };
  } catch { channel = null; }
}
function broadcast(type) {
  try { if (channel) channel.postMessage({ type }); } catch { /* other tabs find out on their next request */ }
}

/** The bar under the top bar (and at the top of an open drawer): two minutes
 *  before the session ends it says when, with Sign in again (which keeps the
 *  place and the form). */
const EXPIRY_WARN_MS = 2 * 60_000;
function scheduleExpiry() {
  clearTimeout(state.expiryTimer);
  const bar = ui.expiryBar();
  const ends = state.me && state.me.session && typeof state.me.session.expiresAt === 'number'
    ? state.me.session.expiresAt - state.clockSkew : null;
  if (ends == null) return bar.hide();
  const at = clockText(ends);
  const tick = () => {
    const now = Date.now();
    if (now >= ends) return bar.show('Your session ended at ' + at + '.', 'Sign in again', signInAgain);
    if (now >= ends - EXPIRY_WARN_MS) {
      bar.show('Your session ends at ' + at + '.', 'Sign in again', signInAgain);
      state.expiryTimer = setTimeout(tick, ends - now + 250);
      return;
    }
    bar.hide();
    state.expiryTimer = setTimeout(tick, Math.min(ends - EXPIRY_WARN_MS - now, 0x7fffffff));
  };
  tick();
}
function stopExpiry() {
  clearTimeout(state.expiryTimer);
  ui.expiryBar().hide();
}
/** '14:05' (or '2:05 PM'), in this browser's way of writing times. */
function clockText(ms) {
  try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return new Date(ms).toTimeString().slice(0, 5); }
}

/** The guilds this admin may manage and the relay serves (named), for the
 *  switcher — not every guild they happen to own on Discord. */
async function loadGuilds() {
  let guilds;
  try { guilds = (await api('GET', '/admin/guilds')).guilds || []; }
  catch { guilds = (state.me && state.me.guilds) || []; }
  state.guilds = guilds;
  bindSwitcher();
  syncSwitcher();
}

/** After allow-list edits: new guilds appear without a re-login. */
async function refreshScope() {
  await loadGuilds();
  syncShell();
}

async function logout() {
  try { await api('POST', '/admin/logout', undefined, { quiet: true }); } catch { /* signed out either way */ }
  forgetUser(userId());
  broadcast('signed-out');
  stopExpiry();
  ui.sessionResumed();
  state.me = null;
  showLogin();
}

/** Sign out forgets this admin's conveniences in this browser. */
function forgetUser(uid) {
  session.del('pa.draft');
  session.del('pa.returnTo');
  if (!uid) return;
  local.del('pa.lastGuild:' + uid);
  local.del('pa.lastTab:' + uid);
  for (const k of local.keys()) if (k && k.indexOf('pa.collapsed:' + uid + ':') === 0) local.del(k);
}

// ── Routes ───────────────────────────────────────────────────────────────────

const GUILD_VIEWS = new Set(['personas', 'invites', 'roles', 'audit']);
const TAB_NAMES = { personas: 'Personas', invites: 'Invites', roles: 'Access roles', audit: 'Audit', guilds: 'Guilds' };

function route(area, gid, view, drawer = null, query = {}) {
  return { area, gid: gid || null, view, drawer, query };
}

// Every history entry the panel has been at carries its place in the tab's
// history ({ paIdx }, in history.state). A step Back or Forward can then be
// told from a new entry (a link, an edited address), and undone exactly: a
// Cancel on 'Discard changes?' steps back with history.go(), never with a new
// entry, so Back and Forward stay as they were.

function stamp() { return { paIdx: state.histIdx }; }
/** history.replaceState, keeping this entry's place. */
function replaceHash(url) { history.replaceState(stamp(), '', url); }
/** history.pushState, one place further on. */
function pushHash(url) {
  state.histIdx++;
  history.pushState(stamp(), '', url);
}
/** After Back, Forward, a link or an edited address: where are we now? An
 *  entry without a stamp is a new one, one place further on. */
function noteHistory() {
  const s = history.state;
  if (s && typeof s.paIdx === 'number') {
    state.histIdx = s.paIdx;
    return;
  }
  state.histIdx++;
  replaceHash(location.pathname + location.search + location.hash);
}
function onHistory() {
  noteHistory();
  if (state.restoring) {
    const want = state.restoring;
    state.restoring = null;
    // A Cancel's step back landed elsewhere (an entry this tab hadn't
    // stamped, from before an update): put the drawer's address on top.
    if (location.hash !== want) {
      pushHash(want);
      state.drawerPushed = false; // under it now is where the admin was going
    }
  }
  applyRoute();
}
/** Back to the entry at `at`, whose address is `hash` (Cancel). */
function stepBackTo(hash, at) {
  const delta = at - state.histIdx;
  if (delta) {
    state.restoring = hash;
    history.go(delta);
  } else if (location.hash !== hash) replaceHash(hash);
}

/** Go to `r`: a new history entry (Back comes back here), or with
 *  { replace: true } in place of this one (search, filters, fixes). */
function navigate(r, opts = {}) {
  const hash = lib.formatRoute(r);
  if (!hash) return Promise.resolve();
  if (hash !== location.hash) {
    if (opts.replace) replaceHash(hash);
    else pushHash(hash);
  }
  return applyRoute();
}

/** May this admin manage `gid`? The relay decides, on every request; this is
 *  its rule (a guild it serves that this admin administers), so a link into
 *  any other guild never asks for that guild's data. */
function canManage(gid) {
  return isSuper() || state.guilds.some((g) => g.id === gid);
}

/** Where '#/' lands: the last guild and tab this admin used here (while they
 *  may still manage it), else their first guild's Personas. */
function homeRoute() {
  const uid = userId();
  const lastGuild = local.get('pa.lastGuild:' + uid);
  const lastTab = local.get('pa.lastTab:' + uid);
  if (lastTab === 'guilds' && isSuper()) return route('guilds', null, 'guilds');
  const gid = lib.isSnowflake(lastGuild) && canManage(lastGuild) ? lastGuild : state.guilds.length ? state.guilds[0].id : null;
  const view = GUILD_VIEWS.has(lastTab) ? lastTab : 'personas';
  if (gid) return route('g', gid, view);
  return isSuper() ? route('all', null, 'personas') : null;
}

function goHome() {
  const h = homeRoute();
  if (h) return navigate(h, { replace: true });
  // Nowhere to land: a guild-admin none of whose guilds is served now.
  replaceHash('#/');
  state.route = lib.parseRoute('#/');
  state.routeAt = state.histIdx;
  showNotAdmin(null);
}

/** Remember the last guild and tab, for '#/' next time. */
function remember(r) {
  const uid = userId();
  if (!uid) return;
  if (r.area === 'g' && canManage(r.gid)) {
    local.set('pa.lastGuild:' + uid, r.gid);
    local.set('pa.lastTab:' + uid, r.view);
  } else if (r.area === 'guilds' || r.area === 'all') local.set('pa.lastTab:' + uid, r.view);
}

/**
 * The route as this version of the panel shows it ({ route, note }): a view
 * that a later version adds says so (note) and falls back to the nearest one
 * there is; query keys nothing here acts on yet are dropped.
 */
function supported(r) {
  const instead = (to, name) => ({ route: to, note: 'That page isn’t available yet — showing ' + name + ' instead.' });
  if (r.area === 'all' && r.view === 'audit') {
    const gid = r.query.guild && canManage(r.query.guild) ? r.query.guild : state.guildId || (homeRoute() || {}).gid;
    return gid ? instead(route('g', gid, 'audit'), 'the guild’s audit') : instead(route('all', null, 'personas'), 'All personas');
  }
  if (r.area !== 'g' && r.area !== 'all') return { route: r, note: null };
  if (r.view === 'channels' || r.view === 'give') return instead(route('g', r.gid, 'personas'), 'Personas');
  const k = r.drawer && r.drawer.kind;
  if (k === 'add' || k === 'invite' || k === 'role') return instead(route(r.area, r.gid, r.view), TAB_NAMES[r.view]);
  const all = r.area === 'all';
  const keep = k === 'mint' ? ['c', 'lvl', 'r'] : r.drawer ? (all && k === 'persona' ? ['guild'] : []) : all ? ['q', 'guild'] : ['q'];
  const query = {};
  for (const key of keep) if (r.query[key] !== undefined) query[key] = r.query[key];
  return { route: Object.assign({}, r, { query }), note: null };
}

/** Which list is drawn: the same key means the same toolbar and rows (a
 *  super-admin's scope switch between this guild and all personas included). */
function viewKeyOf(r) {
  if (r.area === 'guilds') return 'guilds';
  if (r.view === 'personas') return 'personas:' + (r.area === 'g' ? r.gid : (r.query && r.query.guild) || state.guildId);
  return r.area + ':' + r.view + ':' + (r.gid || '');
}

/** The guild a route is about: its own, or on #/all/personas its ?guild=
 *  (null when it names none). A persona drawer shows this guild's section,
 *  so the drawer is the same after a reload or a sign-in. */
function routeGuild(r) {
  if (r.area === 'g') return r.gid;
  return (r.area === 'all' && r.query && r.query.guild) || null;
}

/** The query of `r`'s list as the page shows it now: the search, and on
 *  #/all/personas the guild in view. */
function listQuery(r) {
  const q = {};
  if (state.q) q.q = state.q;
  if (r.area === 'all' && r.view === 'personas' && state.guildId) q.guild = state.guildId;
  return q;
}

/** The list a drawer route sits on (where closing it goes). */
function listOf(r) {
  return route(r.area, r.gid, r.view, null, listQuery(r));
}

/** The guild a super-admin's all-persona page shows when its address names
 *  none: the one in view, else the home guild. */
function homeGuildId() {
  const h = homeRoute();
  return h && h.area === 'g' ? h.gid : null;
}

let discardAsked = false;

/**
 * Make the page match the address. popstate, hashchange and navigate() all
 * come here, and it is idempotent: the list is redrawn only when the guild or
 * the tab changed (or opts.force: Try again), a search only refreshes the
 * rows, and the drawer opens or closes only when the address says otherwise.
 */
async function applyRoute(opts = {}) {
  if (!state.me) return;
  const hash = location.hash;
  let r = lib.parseRoute(hash);
  if (!r) {
    ui.toast('That link wasn’t valid.', { kind: 'info' });
    return goHome();
  }
  // Home, and a super-admin's pages for anyone else, resolve to a real place.
  if (r.area === 'home' || ((r.area === 'all' || r.area === 'guilds') && !isSuper())) return goHome();
  const sup = supported(r);
  if (sup.note) {
    ui.toast(sup.note, { kind: 'info' });
    return navigate(sup.route, { replace: true });
  }
  r = sup.route;
  const canonical = lib.formatRoute(r);
  if (canonical !== hash) replaceHash(canonical);

  const prev = state.route;
  // Leaving a drawer with unsaved changes (Back, Forward, a link, an edited
  // address): ask first. The address already shows where the admin was
  // going; Discard shows that place. Cancel stays: it steps back to the
  // drawer's own entry with history.go(), so no entry is added or dropped —
  // Forward and Back still go where they went (stepBackTo).
  if (prev && prev.area !== 'home' && ui.drawer.isOpen() && ui.drawer.isDirty() && lib.formatRoute(prev) !== canonical) {
    if (discardAsked) return;
    discardAsked = true;
    const prevHash = lib.formatRoute(prev);
    const at = state.routeAt;
    // One question at a time: Esc may have asked already (ui.drawer shares it).
    const asked = ui.drawer.id();
    const discard = await ui.drawer.confirmDiscard();
    discardAsked = false;
    if (ui.drawer.isOpen() && ui.drawer.id() !== asked) return; // another drawer since
    if (!discard && ui.drawer.isOpen()) return stepBackTo(prevHash, at);
    // Discarded (here, or by Esc's question, which closed it): show the
    // address as it is now.
    closeDrawerFor('route');
    return applyRoute();
  }
  // A kept form is only for the place it was kept at.
  if (state.draft && state.draft.route !== canonical) state.draft = null;
  state.route = r;
  state.routeAt = state.histIdx;

  if (r.area === 'g' && !canManage(r.gid)) return showNotAdmin(r);
  remember(r);
  // A super-admin's all-persona pages: the guild their address names (or,
  // naming none, the one in view, else the home guild) is the guild in view.
  if (r.area === 'all') {
    if (r.query.guild) state.guildId = r.query.guild;
    else if (!state.guildId) state.guildId = homeGuildId();
  }

  const vk = viewKeyOf(r);
  const scope = r.area === 'all' ? 'all' : 'guild';
  const listQ = r.drawer ? null : r.query.q || '';
  if (opts.force || vk !== state.viewKey) {
    closeDrawerFor('route');
    state.viewKey = vk;
    if (r.gid) state.guildId = r.gid;
    state.tab = r.view;
    state.personaScope = scope;
    state.q = listQ || '';
    state.offset = 0;
    syncShell();
    render();
  } else {
    if (state.tab === 'personas' && scope !== state.personaScope) {
      // A super-admin's scope switch: the same toolbar (and search), new rows.
      state.personaScope = scope;
      if (listQ !== null) state.q = listQ;
      state.offset = 0;
      if (state.list && state.list.onScope) state.list.onScope();
    } else if (listQ !== null && listQ !== state.q) {
      state.q = listQ;
      state.offset = 0;
      if (state.list) {
        if (state.list.search) state.list.search.value = state.q;
        state.list.refresh();
      }
    }
    syncShell();
  }

  const dk = r.drawer ? canonical : null;
  if (dk !== state.drawerRoute) {
    closeDrawerFor('route');
    if (r.drawer) {
      // Opened from its own list (a link, a row): closing it goes Back there.
      // Reached by a link from elsewhere or a reload: closing replaces it.
      state.drawerPushed = !!prev && !prev.drawer && prev.area !== 'home' && viewKeyOf(prev) === vk;
      state.drawerRoute = dk;
      openRouteDrawer(r);
    }
  }
}

function openRouteDrawer(r) {
  const k = r.drawer.kind;
  if (k === 'persona') return openPersonaDrawer(r.drawer.id, { gid: routeGuild(r) });
  if (k === 'mint') return openMintDrawer(r.query);
  if (k === 'newRole') return openRoleDrawer();
}

/** The list's search changed: the address follows, in place (Back never
 *  steps through keystrokes). */
function syncQuery() {
  const r = state.route;
  if (!r || r.drawer || !r.view || r.area === 'guilds') return;
  const next = listOf(r);
  const hash = lib.formatRoute(next);
  if (!hash) return;
  state.route = next;
  state.routeAt = state.histIdx;
  if (hash !== location.hash) replaceHash(hash);
}

/** Where a persona's drawer is, from the list being shown. From the list of
 *  all personas the address names the guild in view too, so its 'Access in
 *  <guild>' section comes back on a reload or after signing in again. */
function personaRoute(id) {
  return state.personaScope === 'all' || !state.guildId
    ? route('all', null, 'personas', { kind: 'persona', id }, state.guildId ? { guild: state.guildId } : {})
    : route('g', state.guildId, 'personas', { kind: 'persona', id });
}

/** Tabs are links; their addresses follow the guild. */
function tabHref(tab) {
  if (tab === 'guilds') return '#/guilds';
  if (state.guildId) return lib.formatRoute(route('g', state.guildId, tab)) || '#/';
  return tab === 'personas' && isSuper() ? '#/all/personas' : '#/';
}

/** The tabs, the switcher and the window title, for the route shown. */
function syncShell() {
  const notAdmin = String(state.viewKey || '').startsWith('not-admin');
  for (const t of document.querySelectorAll('.tab')) {
    const tab = t.dataset.tab;
    t.setAttribute('href', tabHref(tab));
    const on = !notAdmin && tab === state.tab;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
  syncSwitcher();
  const all = state.tab === 'personas' && state.personaScope === 'all';
  const tabName = notAdmin ? null : all ? 'All personas' : TAB_NAMES[state.tab];
  const guild = !notAdmin && !all && state.tab !== 'guilds' && state.guildId && canManage(state.guildId) ? currentGuildName() : null;
  document.title = ['Portal admin', tabName, guild].filter(Boolean).join(' — ');
}

/**
 * The guild switcher: a fixed label for an admin of one guild, otherwise a
 * select of the guilds they manage. While the page is about a guild that is
 * not one of these (a link into someone else's), nothing is selected and
 * nothing names it. Super-admins also get 'Go to guild id…'.
 */
function syncSwitcher() {
  const sel = $('#guild-select');
  const stat = $('#guild-static');
  const gid = state.guildId;
  const known = state.guilds.some((g) => g.id === gid);
  if (!isSuper() && state.guilds.length === 1 && (known || !gid)) {
    stat.textContent = state.guilds[0].name || state.guilds[0].id;
    stat.classList.remove('hidden');
    sel.classList.add('hidden');
    return;
  }
  stat.classList.add('hidden');
  // The 'Go to guild id…' field takes the select's place while it is open.
  const go = $('#guild-go');
  sel.classList.toggle('hidden', !!go && !go.classList.contains('hidden'));
  const shown = known || (isSuper() && lib.isSnowflake(gid));
  clear(sel);
  if (!shown) sel.appendChild(el('option', { value: '', text: state.guilds.length ? 'Pick a guild…' : 'No guild to manage' }));
  for (const g of state.guilds) sel.appendChild(el('option', { value: g.id, text: g.name || g.id }));
  // A guild a super-admin went to by id: shown by its id.
  if (shown && !known) sel.appendChild(el('option', { value: gid, text: gid }));
  if (isSuper()) sel.appendChild(el('option', { value: '__custom__', text: 'Go to guild id…' }));
  sel.value = shown ? gid : '';
}

function bindSwitcher() {
  if (bindSwitcher.done) return;
  bindSwitcher.done = true;
  const sel = $('#guild-select');
  sel.addEventListener('change', () => {
    const v = sel.value;
    if (v === '__custom__') {
      syncSwitcher();
      openGuildGo();
      return;
    }
    if (v) switchGuild(v);
  });
}

/** A guild switch keeps the tab (and the search) and closes any drawer. */
function switchGuild(gid) {
  const tab = GUILD_VIEWS.has(state.tab) ? state.tab : 'personas';
  const q = state.route && !state.route.drawer && state.route.query && state.route.query.q;
  navigate(route('g', gid, tab, null, q ? { q } : {}));
}

/** Super-admins: go to a guild by its id, from a field in the top bar. */
function openGuildGo() {
  let form = $('#guild-go');
  if (!form) {
    const input = el('input', {
      id: 'guild-go-id', type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Go to guild id…', 'aria-label': 'Guild id to go to', 'aria-describedby': 'guild-go-err',
    });
    const err = el('span', { id: 'guild-go-err', class: 'field-error', role: 'status' });
    const close = () => {
      form.classList.add('hidden');
      err.textContent = '';
      input.value = '';
      syncSwitcher();
    };
    form = el('form', { id: 'guild-go', class: 'guild-go', novalidate: true }, [
      input,
      el('button', { type: 'submit', class: 'btn btn-sm', text: 'Go' }),
      el('button', { class: 'btn btn-sm btn-ghost', text: '✕', 'aria-label': 'Close the guild id field', onclick: () => { close(); $('#guild-select').focus(); } }),
      err,
    ]);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!lib.isSnowflake(v)) {
        err.textContent = 'That isn’t a guild id (5–25 digits).';
        input.focus();
        return;
      }
      close();
      switchGuild(v);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
      $('#guild-select').focus();
    });
    $('#scope').appendChild(form);
  }
  form.classList.remove('hidden');
  $('#guild-select').classList.add('hidden');
  $('#guild-go-id').focus();
}

/**
 * In place of a guild's view when this admin can't manage it — from a link,
 * or because the relay said so: why (never the guild's name), the guilds
 * they do manage, and Try again. `r` null: they manage none at all.
 */
function showNotAdmin(r) {
  closeDrawerFor('route');
  state.viewKey = 'not-admin:' + (r ? r.gid : '');
  if (r) {
    state.guildId = r.gid;
    state.tab = GUILD_VIEWS.has(r.view) ? r.view : 'personas';
  }
  state.list = null;
  state.renderSeq++; // a list still loading must not draw over this
  syncShell();
  const view = $('#view');
  clear(view);
  view.appendChild(ui.notAdminView({
    guilds: state.guilds.filter((g) => !r || g.id !== r.gid),
    none: !r || (!state.guilds.length && !isSuper()),
    onPick: (gid) => navigate(route('g', gid, state.tab)),
    onRetry: retryRoute,
    onSignOut: logout,
  }));
}

/** The relay refused a guild route: this admin can't manage that guild (any
 *  more), or it couldn't check right now. Its page says so, with Try again
 *  (which asks the relay for the guild list again). */
function notGuildAdmin(gid) {
  if (state.route && state.route.area === 'g' && state.route.gid === gid) showNotAdmin(state.route);
}

/** Try again: ask the relay which guilds this admin manages, and show the
 *  address again. */
async function retryRoute() {
  await loadGuilds();
  await applyRoute({ force: true });
}

// ── Drawer glue ───────────────────────────────────────────────────────────────

/** Open the drawer (ui.drawer) for a list row: `key` is the row's data-key,
 *  so focus can find the row again if the list is redrawn on close. */
function openDrawer(opts) {
  state.rowKey = opts.key || null;
  return ui.drawer.open(Object.assign({}, opts, { onClose: onDrawerClosed }));
}

/** Close the drawer because the address changed (nothing more to do with the
 *  address). */
function closeDrawerFor(reason) {
  state.drawerRoute = null;
  if (ui.drawer.isOpen()) ui.drawer.close(reason);
}

/** A drawer changed something its list shows. */
function markStale() { state.listStale = true; }

function onDrawerClosed(reason) {
  const key = state.rowKey;
  state.rowKey = null;
  // Closed by the admin (✕, Esc, the scrim, Done): the address follows. Back
  // to the list it was opened from; or, for one reached by a link or a
  // reload, its list in place of it. (Closed by Discard while the address
  // has already moved on — Back with unsaved changes — the place it moved to
  // is shown by the applyRoute that asked.)
  if (reason !== 'route') {
    state.drawerRoute = null;
    const r = state.route;
    if (r && r.drawer && location.hash === lib.formatRoute(r)) {
      const list = listOf(r);
      state.route = list;
      if (state.drawerPushed) history.back();
      else replaceHash(lib.formatRoute(list));
    }
  }
  state.drawerPushed = false;
  // Focus goes back to the link that opened it (ui.drawer does that); when
  // there was none (a row click, a link from elsewhere) or the list was
  // redrawn, to the row's link (for a drawer of the toolbar's, its button).
  // Focus left on the hidden drawer counts as lost; a drawer opened since
  // keeps it.
  const focusRow = () => {
    const a = document.activeElement;
    if (!key || ui.drawer.isOpen()) return;
    if (a && a !== document.body && a.isConnected && !a.closest('#drawer')) return;
    const row = Array.from(document.querySelectorAll('[data-key]')).find((n) => n.dataset.key === key);
    if (row) row.focus();
  };
  if (!state.listStale || !state.list) return focusRow();
  state.listStale = false;
  state.list.refresh().then(focusRow);
}

/**
 * Register the drawer's form for "Sign in again" (ui.drawer.registerForm) and,
 * when a draft of it was brought back for this very place, put it back:
 * nothing is sent — the line says so, and the admin saves it. Resolves true
 * when it was restored. hooks.belongs(fields), when given, says whether a
 * draft is this form's own (a grant draft names its persona).
 */
function keepForm(d, key, hooks, status) {
  d.registerForm(key, hooks);
  const dr = state.draft;
  if (!dr || dr.form !== key || !state.route || dr.route !== lib.formatRoute(state.route)) return false;
  if (!state.drawerRoute || state.drawerRoute !== dr.route) return false;
  if (hooks.belongs && !hooks.belongs(dr.fields)) return false;
  state.draft = null;
  try { hooks.restore(dr.fields); } catch (e) { console.error('[portal-admin] restore', e); return false; }
  status.info('Restored your unsaved change — review and save. Nothing was submitted.');
  return true;
}

/** After a save: put the relay's value (`saved`) in `input` and count the
 *  form as saved — unless the admin typed into the field while the save was
 *  at work (it no longer holds `sentText`, what it held when the save was
 *  sent): that text stays, and stays unsaved. */
function settleField(input, sentText, saved, tracker) {
  const typed = input.value;
  input.value = saved;
  tracker.reset();
  if (typed !== sentText) input.value = typed;
}

/** A read that found the session over: say so where the content would be. */
function sessionEndedNote() {
  return el('div', { class: 'load-error', role: 'alert' }, [
    el('p', { text: 'Your session ended. Sign in again to see this.' }),
    el('button', { class: 'btn btn-sm', text: 'Sign in again', onclick: signInAgain }),
  ]);
}

// ── Render dispatch ──────────────────────────────────────────────────────────

const GUILD_TABS = new Set(['personas', 'invites', 'roles', 'audit']);

async function render() {
  const view = $('#view');
  state.list = null;
  // Super-admins reach the global persona list (profile, token) without a
  // guild — e.g. before the relay has joined any.
  const globalPersonas = state.tab === 'personas' && isSuper() && (state.personaScope === 'all' || !state.guildId);
  if (GUILD_TABS.has(state.tab) && !state.guildId && !globalPersonas) {
    clear(view);
    view.appendChild(el('div', { class: 'empty' }, [
      el('p', { text: 'Select a guild to manage.' }),
      isSuper() ? el('p', { class: 'muted', text: 'As a super-admin you can pick “Go to guild id…”.' }) : null,
    ]));
    return;
  }
  clear(view);
  view.appendChild(el('p', { class: 'muted loading', role: 'status', text: 'Loading…' }));
  const tab = state.tab;
  const seq = ++state.renderSeq;
  const stale = () => seq !== state.renderSeq;
  try {
    if (tab === 'personas') await renderPersonas(view, stale);
    else if (tab === 'invites') await renderInvites(view, stale);
    else if (tab === 'roles') await renderRoles(view, stale);
    else if (tab === 'audit') await renderAudit(view, stale);
    else if (tab === 'guilds') await renderGuilds(view);
  } catch (e) {
    if (stale() || e.handled) return;
    clear(view);
    if (e.status === 401) return view.appendChild(sessionEndedNote());
    view.appendChild(loadError(couldntLoad('this tab', e), () => render()));
  }
}

// ── Shared list scaffolding ──────────────────────────────────────────────────

/**
 * A tab's list: the toolbar is built once, and only the results container is
 * redrawn — by search (debounced), paging, or a drawer that changed the list —
 * so the search box keeps its focus and caret.
 *   opts: { placeholder, label, actions, search (default true), load }
 *   load() → Promise<Node> builds the results for the current state.
 * Returns { refresh, search, status, results }; also kept as state.list.
 */
function listView(view, opts) {
  clear(view);
  const results = el('div', { class: 'results' });
  const status = ui.statusLine(null);
  let search = null;
  const bar = [];
  if (opts.search !== false) {
    search = el('input', {
      id: 'list-search', class: 'search', type: 'search', placeholder: opts.placeholder,
      'aria-label': opts.label || opts.placeholder.replace(/…$/, ''), value: state.q, autocomplete: 'off',
    });
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        // Typed, then left (another tab or guild) within the debounce: the
        // new list's box shows state.q, so this box's text must not land there.
        if (state.list !== list) return;
        state.q = search.value.trim(); state.offset = 0; list.refresh();
        syncQuery(); // ?q= in place: Back doesn't step through keystrokes
      }, 250);
    });
    bar.push(search);
  }
  bar.push(...(opts.toolbar || []));
  bar.push(el('div', { class: 'toolbar-actions' }, opts.actions || []));
  view.appendChild(el('div', { class: 'toolbar' }, bar));
  view.appendChild(status.node);
  view.appendChild(results);
  results.appendChild(el('p', { class: 'muted loading', role: 'status', text: 'Loading…' }));

  let seq = 0;
  const list = {
    search, status, results,
    /** Redraw the results; only the latest call draws (replies can cross). */
    async refresh() {
      const mine = ++seq;
      results.setAttribute('aria-busy', 'true');
      try {
        const node = await opts.load();
        if (mine !== seq) return;
        clear(results);
        results.appendChild(node);
      } catch (e) {
        if (mine !== seq || e.handled) return;
        clear(results);
        results.appendChild(e.status === 401 ? sessionEndedNote() : loadError(couldntLoad('this list', e), () => list.refresh()));
      } finally {
        if (mine === seq) results.removeAttribute('aria-busy');
      }
    },
  };
  state.list = list;
  list.refresh();
  return list;
}

/** Pager from {total, limit, offset}; paging redraws the results only. */
function pager(meta, refresh) {
  const total = meta.total != null ? meta.total : 0;
  const limit = meta.limit || LIMIT;
  const offset = meta.offset || 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  const prev = el('button', { class: 'btn btn-sm', text: '‹ Prev', 'aria-label': 'Previous page', disabled: offset <= 0 });
  const next = el('button', { class: 'btn btn-sm', text: 'Next ›', 'aria-label': 'Next page', disabled: to >= total });
  prev.addEventListener('click', () => { state.offset = Math.max(0, offset - limit); refresh(); });
  next.addEventListener('click', () => { state.offset = offset + limit; refresh(); });
  return el('div', { class: 'pager' }, [
    el('span', { class: 'muted', text: total ? `${from}–${to} of ${total}` : 'none' }), prev, next,
  ]);
}

/** A table in a .table-wrap (which scrolls sideways on a phone). */
function table(headers, rows, emptyText) {
  return el('div', { class: 'table-wrap' }, [el('table', { class: 'grid' }, [
    el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { class: h.cls, scope: 'col', text: h.label })))]),
    el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { class: 'muted empty-row', colspan: String(headers.length), text: emptyText || 'Nothing here.' })])]),
  ])]);
}

/** A row that opens something: the whole row is clickable for the mouse; the
 *  keyboard path is the button inside it. */
function openableRow(open, cells) {
  return el('tr', {
    class: 'clickable',
    onclick: (e) => { if (!e.target.closest('button, a, input, select, textarea, label')) open(); },
  }, cells);
}

function section(title, children) {
  return el('section', { class: 'drawer-section' }, [el('h3', { text: title }), ...children]);
}

// ── Personas ─────────────────────────────────────────────────────────────────
// One place for a persona — the only kind of speaker portal has. The list is
// scoped to the selected guild (personas with access there); super-admins can
// widen it to every persona. The drawer shows what an admin of this guild may
// change, and — for super-admins — the persona's profile, its access in every
// guild, and its token.

async function renderPersonas(view, stale) {
  const isSuper = !!(state.me && state.me.isSuper);
  const meta = state.guildId ? await guildMeta() : null;
  if (stale()) return;
  const isAll = () => isSuper && (state.personaScope === 'all' || !state.guildId);

  const actions = [];
  let scope = null;
  if (isSuper && state.guildId) {
    scope = el('select', { class: 'scope-select', 'aria-label': 'Which personas to list' }, [
      el('option', { value: 'guild', text: 'With access in ' + currentGuildName() }),
      el('option', { value: 'all', text: 'All personas' }),
    ]);
    scope.value = isAll() ? 'all' : 'guild';
    actions.push(scope);
  }
  const grantById = el('button', { class: 'btn btn-sm btn-primary', text: '+ Grant access by id' });
  grantById.addEventListener('click', () => {
    const id = (prompt('Persona id to grant access to (must already exist):') || '').trim();
    if (!id) return;
    if (!lib.isPersonaId(id)) {
      list.status.err('Not opened: that isn’t a persona id. Enter one of up to 100 characters, on one line.', { toast: false });
      return;
    }
    navigate(personaRoute(id));
  });
  actions.push(grantById);
  const hint = el('p', { class: 'hint muted' });

  const list = listView(view, {
    placeholder: 'Search personas with access here…',
    actions,
    load: async () => {
      const all = isAll();
      const data = all
        ? await api('GET', '/admin/personas' + qs({ q: state.q, limit: LIMIT, offset: state.offset }))
        : await api('GET', G() + '/personas' + qs({ q: state.q, limit: LIMIT, offset: state.offset }));
      const rows = (data.personas || []).map((p) => personaRow(p, meta, all));
      const empty = state.q
        ? 'No persona matches “' + state.q + '”.'
        : all ? 'No personas yet.' : 'No persona has access in ' + currentGuildName() + ' yet.';
      return el('div', {}, [
        table([
          { label: '', cls: 'col-narrow' }, { label: 'Name' }, { label: 'Id' }, { label: 'Access roles' },
          all ? { label: 'Guilds', cls: 'col-narrow' } : { label: 'Direct grants', cls: 'col-narrow' },
        ], rows, empty),
        pager(data, () => list.refresh()),
      ]);
    },
  });
  view.appendChild(hint);

  // The scope switch (an address: #/all/personas or this guild's) keeps the
  // toolbar and the query; only the results change.
  function syncScope() {
    if (scope) scope.value = isAll() ? 'all' : 'guild';
    const all = isAll();
    const ph = all ? 'Search all personas…' : 'Search personas with access here…';
    list.search.placeholder = ph;
    list.search.setAttribute('aria-label', ph.replace(/…$/, ''));
    grantById.classList.toggle('hidden', all);
    hint.textContent = all
      ? 'Every persona the relay knows. Open one to see its access in every guild, its profile picture and its token.'
      : 'Personas with access in this guild. To add one that has none yet, use “Grant access by id”' +
        (isSuper ? ', switch to All personas,' : '') + ' or mint an invite for an agent to claim.';
  }
  syncScope();
  list.onScope = () => {
    syncScope();
    list.search.value = state.q;
    list.refresh();
  };
  if (scope) {
    scope.addEventListener('change', () => {
      const q = state.q ? { q: state.q } : {};
      navigate(scope.value === 'all'
        ? route('all', null, 'personas', null, Object.assign({ guild: state.guildId }, q))
        : route('g', state.guildId, 'personas', null, q));
    });
  }
}

function personaRow(p, meta, all) {
  const name = p.displayName || p.id;
  // The name is a link to the persona's drawer (an address: reload, Back and
  // sharing keep it); the rest of the row opens it too.
  const href = lib.formatRoute(personaRoute(p.id));
  const open = () => (href ? navigate(personaRoute(p.id)) : openPersonaDrawer(p.id, { name, gid: state.guildId }));
  // In a guild's list, the guild's own access roles; others are only counted.
  let rolesText = (p.roles || []).join(', ') || '—';
  if (!all && meta) {
    const mine = new Set(guildRoleNames(meta));
    const here = (p.roles || []).filter((r) => mine.has(r));
    // A super-admin's rows count the roles of other guilds (the relay says
    // how many); a guild admin's rows hold this guild's only.
    const elsewhere = typeof p.otherGuildRoleCount === 'number' ? p.otherGuildRoleCount : (p.roles || []).length - here.length;
    rolesText = (here.join(', ') || '—') + (elsewhere ? ' (+' + elsewhere + ' elsewhere)' : '');
  }
  return openableRow(open, [
    el('td', { class: 'col-narrow' }, [avatarThumb(p.avatarUrl, '')]),
    el('td', {}, [href
      ? el('a', { class: 'link', href, 'data-key': 'persona:' + p.id, text: name })
      : el('button', { class: 'link', 'data-key': 'persona:' + p.id, text: name, onclick: open })]),
    el('td', {}, [el('code', { text: p.id })]),
    el('td', { class: 'cell-roles', text: rolesText }),
    all
      ? el('td', { class: 'col-narrow', text: String(p.guildCount != null ? p.guildCount : '—') })
      : el('td', {}, [directGrantsBadge(p)]),
  ]);
}

/** A guild list row's 'Direct grants' cell: whether its direct grants give
 *  anything here, or deny it guild-wide. */
function directGrantsBadge(p) {
  const dg = p.directGrants || (p.hasOverride ? 'grants' : 'none');
  if (dg === 'grants') return el('span', { class: 'badge badge-warn', text: 'direct grants' });
  if (dg === 'denied') {
    return el('span', { class: 'badge badge-warn', text: 'denied guild-wide', title: 'Its persona default doesn’t apply in ' + currentGuildName() + '. Access roles still do.' });
  }
  return el('span', { class: 'muted', text: '—' });
}

/**
 * A persona's drawer. `hint.gid` is the guild its 'Access in <guild>'
 * section is about — the one its address names (routeGuild), never just the
 * guild in view — so everything this drawer sends goes to that guild.
 */
async function openPersonaDrawer(id, hint = {}) {
  const isSuper = !!(state.me && state.me.isSuper);
  const gid = hint.gid || null;
  // The name its list row shows, until the persona has loaded.
  const row = Array.from(document.querySelectorAll('[data-key]')).find((n) => n.dataset.key === 'persona:' + id);
  const name = hint.name || (row && row.textContent) || id;
  // Open at once; the sections arrive when the persona has loaded.
  const d = openDrawer({ title: name, subtitle: id, key: 'persona:' + id });
  const missing = (e) => { if (e.status === 404) return null; throw e; };
  let local = null;
  let global = null;
  let meta = null;
  try {
    [local, global, meta] = await Promise.all([
      // What an admin of this guild may see and change…
      gid ? api('GET', gpath(gid) + '/personas/' + encodeURIComponent(id)).catch(missing) : null,
      // …and, for super-admins, the persona everywhere.
      isSuper ? api('GET', '/admin/personas/' + encodeURIComponent(id)).catch(missing) : null,
      gid ? guildMeta(gid) : null,
    ]);
  } catch (e) {
    // (A guild route the relay refused has closed it already, for the
    // Not-an-admin view; from #/all/personas it says so here instead.)
    if (!d.isCurrent()) return;
    d.setBody(e.status === 401 ? sessionEndedNote() : loadError(couldntLoad(name, e), () => openPersonaDrawer(id, hint)));
    return;
  }
  if (!d.isCurrent()) return;
  if (!local && !global) {
    d.setBody(el('p', { class: 'empty-note', role: 'status', text: 'No persona with id “' + id + '”.' }));
    return;
  }
  const displayName = (global && global.displayName) || (local && local.displayName) || id;
  d.setTitle(displayName, id);
  const ctx = { id, displayName, drawer: d, gid };
  const body = el('div', { class: 'drawer-sections' });

  // "Access in every guild" is rebuilt after any change made in this drawer,
  // so the two sections never disagree.
  const everywhere = el('div', {});
  let refreshSeq = 0; // only the latest refresh may draw: replies can land out of order
  const refreshEverywhere = async () => {
    if (!isSuper) return;
    const seq = ++refreshSeq;
    try {
      const fresh = await api('GET', '/admin/personas/' + encodeURIComponent(id));
      if (seq !== refreshSeq) return;
      clear(everywhere);
      everywhere.appendChild(everywhereSection(fresh));
    } catch { /* keep what is shown; the next open refreshes */ }
  };
  // This guild first: it is what the drawer was opened for.
  if (gid && meta) {
    body.appendChild(guildAccessSection(ctx, local || { id, roles: (global && global.roles || []).map((r) => r.name), guildPolicy: null }, meta, refreshEverywhere));
  }
  if (global) {
    body.appendChild(profileSection(ctx, global));
    everywhere.appendChild(everywhereSection(global));
    body.appendChild(everywhere);
    body.appendChild(tokenSection(ctx));
  }
  d.setBody(body);
}

/** Super-admin: the persona's profile picture (global — it shows everywhere). */
function profileSection(ctx, d) {
  const { id, displayName } = ctx;
  const avImg = avatarThumb(d.avatarUrl, 'Profile picture of ' + displayName, 'avatar-preview');
  const avInput = el('input', { type: 'text', name: 'avatar', value: d.avatar || '', placeholder: 'https://…/avatar.png', autocomplete: 'off' });
  const saveAv = el('button', { type: 'submit', class: 'btn btn-sm btn-primary', text: 'Save' });
  const clearAv = el('button', { class: 'btn btn-sm', text: 'Clear' });
  // While a crop is pending, the URL buttons are hidden: Upload is the action.
  const urlButtons = el('div', { class: 'inline' }, [saveAv, clearAv]);
  const status = ui.statusLine(null);
  let cropping = false;
  // Upload only where the relay keeps uploaded pictures (PORTAL_AVATAR_DIR).
  const uploads = feature('avatarUploads');
  const cropper = uploads ? avatarCropper(ctx, avImg, avInput, status, (on) => {
    cropping = on;
    urlButtons.classList.toggle('hidden', on);
  }) : null;
  const form = el('form', { class: 'section-form', novalidate: true }, [
    el('div', { class: 'avatar-row' }, [avImg, el('div', { class: 'avatar-edit' }, [
      ui.field({ label: 'Picture URL', control: avInput }),
      urlButtons,
    ])]),
    cropper ? cropper.node : null,
    el('p', { class: 'muted', text: (uploads ? 'Paste an image URL above, or upload + crop a file.' : 'Paste an image URL above.') +
      ' Discord fetches it on the next message; past messages keep their old picture.' }),
    status.node,
  ]);
  const tracker = ctx.drawer.track(form);
  if (cropper) cropper.onUploaded = (saved, sentText) => settleField(avInput, sentText, saved, tracker);

  /** Save `value`; `sentText` is what the field held when it was sent. */
  async function save(value, sentText) {
    try {
      const r = await api('PUT', '/admin/personas/' + encodeURIComponent(id) + '/avatar', { avatar: value });
      settleField(avInput, sentText, r.avatar || '', tracker);
      setPreview(avImg, r.avatarUrl);
      markStale();
      status.ok(value
        ? 'Profile picture saved. It shows from ' + displayName + '’s next message.'
        : 'Profile picture removed. ' + displayName + '’s next message uses the default picture.');
    } catch (e) { status.err(notDone(e)); }
  }
  ui.onSubmit(form, () => (cropping ? undefined : save(avInput.value.trim(), avInput.value)));
  clearAv.addEventListener('click', () => ui.busy(clearAv, () => { avInput.value = ''; return save('', ''); }, 'Clearing…'));
  return section('Profile picture', [form]);
}

/** Access in the selected guild: its direct grants (open, first), its access
 *  roles, and — folded under More — applying an invite. */
function guildAccessSection(ctx, detail, meta, onChange = () => {}) {
  const { id, displayName, gid } = ctx;
  const P = () => gpath(gid) + '/personas/' + encodeURIComponent(id);
  const guild = guildName(gid);
  const names = metaNames(meta, gid);
  const catalog = meta.catalog || {};
  const mine = guildRoleNames(meta, gid);
  const mineSet = new Set(mine);
  const meaning = (r) => lib.roleMeaning(catalog[r], names);

  // Access roles: this guild's, as chips with a remove button each, and a
  // picker (with what each role means) that assigns the moment one is picked.
  const roleTags = el('div', { class: 'tags' });
  const roleNote = el('p', { class: 'field-hint hidden' });
  const roleStatus = ui.statusLine(null);
  const addRole = el('select', { 'aria-label': 'Add an access role to ' + displayName, 'data-no-dirty': true });
  function drawRoles(roles) {
    const held = roles || [];
    clear(roleTags);
    const here = held.filter((r) => mineSet.has(r));
    for (const r of here) {
      const label = 'Remove access role ' + r + ' from ' + displayName;
      const x = el('button', { class: 'x', text: '✕', 'aria-label': label, title: label });
      x.addEventListener('click', () => ui.busy(x, () => revokeRole(r), '…'));
      roleTags.appendChild(el('span', { class: 'tag', title: capsTitle(catalog[r].caps) }, [
        el('code', { text: r }), el('span', { class: 'tag-meaning', text: '— ' + meaning(r) }), x,
      ]));
    }
    if (!here.length) roleTags.appendChild(el('span', { class: 'muted', text: 'No access roles in ' + guild + '.' }));
    // A super-admin sees every role the persona holds; the ones that aren't
    // this guild's are counted, not offered here.
    const other = held.filter((r) => !mineSet.has(r));
    const elsewhere = other.filter((r) => catalog[r]).length;
    const notes = [];
    if (elsewhere) notes.push('+' + lib.plural(elsewhere, 'role') + ' in other guilds');
    if (other.length > elsewhere) notes.push(lib.plural(other.length - elsewhere, 'role') + ' no longer defined');
    roleNote.textContent = notes.join(' · ');
    roleNote.classList.toggle('hidden', !notes.length);
    // The picker offers what isn't held yet.
    clear(addRole);
    const free = mine.filter((r) => !held.includes(r));
    addRole.appendChild(el('option', { value: '', text: free.length ? '+ Add access role…' : mine.length ? 'Holds every access role here' : 'No access roles defined here' }));
    for (const r of free) addRole.appendChild(el('option', { value: r, text: r + ' — ' + meaning(r) }));
    addRole.disabled = !free.length;
  }
  async function revokeRole(role) {
    try {
      const r = await api('DELETE', P() + '/roles/' + encodeURIComponent(role));
      drawRoles(r.roles);
      addRole.focus(); // the chip that had focus is gone
      roleStatus.ok('Removed access role ' + role + ' from ' + displayName + '.');
      markStale(); onChange();
    } catch (e) { roleStatus.err(notDone(e, 'Not removed')); }
  }
  // One request at a time: the picker is off while a role is being given,
  // and a pick that arrives anyway (a script, a slow relay) waits its turn —
  // none is dropped.
  const queue = [];
  let assigning = false;
  async function giveRoles() {
    assigning = true;
    const hadFocus = document.activeElement === addRole;
    addRole.disabled = true;
    addRole.setAttribute('aria-busy', 'true');
    while (queue.length) {
      const role = queue.shift();
      try {
        const r = await api('POST', P() + '/roles', { role });
        drawRoles(r.roles);
        noteBan(r);
        roleStatus.ok('Gave ' + displayName + ' access role ' + role + ' (' + meaning(role) + ').');
        markStale(); onChange();
      } catch (e) { roleStatus.err(notDone(e)); }
      addRole.disabled = true; // drawRoles turned it back on
    }
    assigning = false;
    addRole.removeAttribute('aria-busy');
    addRole.value = '';
    addRole.disabled = addRole.options.length <= 1; // nothing left to give
    // Turning it off dropped focus: give it back — or, the last free role
    // given, to the new chip's ✕.
    const a = document.activeElement;
    if (hadFocus && (!a || a === document.body || !a.isConnected)) {
      if (!addRole.disabled) addRole.focus();
      else {
        const xs = roleTags.querySelectorAll('button.x');
        if (xs.length) xs[xs.length - 1].focus();
      }
    }
  }
  addRole.addEventListener('change', () => {
    const role = addRole.value;
    if (!role || queue.includes(role)) return;
    queue.push(role);
    if (!assigning) giveRoles();
  });
  drawRoles(detail.roles);
  const rolesBlock = el('div', { class: 'subsection subsection-sep', role: 'group', 'aria-label': 'Access roles' }, [
    el('div', { class: 'field-label', text: 'Access roles' }),
    el('div', { class: 'inline' }, [roleTags, addRole]),
    roleNote,
    roleStatus.node,
  ]);

  // Apply an invite to this persona (an "augment" invite; a new-agent one
  // can't be applied to a persona that exists).
  const claimCode = el('input', { type: 'text', name: 'code', autocomplete: 'off', spellcheck: 'false', placeholder: 'inv_…' });
  const claimBtn = el('button', { type: 'submit', class: 'btn btn-sm', text: 'Apply' });
  const claimStatus = ui.statusLine(null);
  const claimForm = el('form', { class: 'subsection', novalidate: true }, [
    ui.field({ label: 'Apply an invite to ' + displayName, control: claimCode, after: [claimBtn], hint: 'Only invites made for an existing persona can be applied here.' }),
    claimStatus.node,
  ]);
  const claimTracker = ctx.drawer.track(claimForm);
  ui.onSubmit(claimForm, async () => {
    const sentText = claimCode.value;
    const code = sentText.trim();
    if (!code) { claimStatus.err('Not applied: enter an invite code first.'); return; }
    try {
      const r = await api('POST', P() + '/claim', { code });
      drawRoles(r.roles);
      noteBan(r);
      settleField(claimCode, sentText, '', claimTracker); // emptied, unless another code was typed meanwhile
      claimStatus.ok('Applied the invite to ' + displayName + '.');
      markStale(); onChange();
    } catch (e) { claimStatus.err(notDone(e, 'Not applied')); }
  }, { busyLabel: 'Applying…' });
  const more = el('details', { class: 'advanced' }, [el('summary', { text: 'More' }), claimForm]);

  const grants = grantEditor(ctx, detail.guildPolicy, meta.channels, withChannelList(detail.names, meta.channels), onChange, !!detail.banned);
  /** A role given or an invite applied here can lift a /ban: the grants say so. */
  function noteBan(r) {
    if (r && typeof r.banned === 'boolean') grants.setBanned(r.banned);
  }

  return el('section', { class: 'drawer-section' }, [
    el('h3', { text: 'Access in ' + guild }),
    grants.node,
    rolesBlock,
    more,
  ]);
}

/** Super-admin: where the persona can act, what each access role confers, and
 *  its direct grants in every guild (read-only — edit them per guild). */
function everywhereSection(d) {
  const guilds = d.guilds || [];
  const names = d.names || {};
  names.guilds = Object.assign({}, names.guilds);
  guilds.forEach((g) => { if (g.name && !names.guilds[g.id]) names.guilds[g.id] = g.name; });

  const kids = [];
  // Each guild links to this persona's drawer there.
  const there = (gid) => (d.id ? lib.formatRoute(route('g', gid, 'personas', { kind: 'persona', id: d.id })) : null);
  kids.push(el('div', { class: 'field' }, [el('div', { class: 'field-label', text: 'Guilds it can act in' }),
    guilds.length
      ? el('ul', { class: 'plain' }, guilds.map((g) => el('li', {}, [
          there(g.id) ? el('a', { href: there(g.id), text: g.name || g.id }) : g.name || g.id,
          el('span', { class: 'muted mono', text: ' ' + g.id }),
        ])))
      : el('p', { class: 'muted', text: 'None.' })]));

  const roles = d.roles || [];
  kids.push(el('div', { class: 'field' }, [el('div', { class: 'field-label', text: 'Access roles' }),
    roles.length
      ? el('ul', { class: 'plain' }, roles.map((r) => el('li', { title: r.caps ? capsTitle(r.caps) : undefined }, [
          el('code', { text: r.name }),
          el('span', { class: 'muted', text: ' — ' + (r.scope
            ? lib.roleMeaning(r, names) + (r.scope.all || !r.guildId ? '' : ' · ' + guildText(r.guildId, names))
            : 'no longer defined') }),
        ])))
      : el('p', { class: 'muted', text: 'None.' })]));

  const pol = d.policy;
  const bans = Array.isArray(d.bans) ? d.bans : [];
  const polGuilds = pol && pol.guilds ? Object.entries(pol.guilds) : [];
  // A guild it was removed from with /ban, even with nothing set there.
  for (const gid of bans) if (!polGuilds.some(([g]) => g === gid)) polGuilds.push([gid, {}]);
  if ((pol && pol.default && pol.default.length) || polGuilds.length) {
    const grantKids = [];
    if (pol && pol.default && pol.default.length) grantKids.push(el('div', { class: 'cell-roles', title: capsTitle(pol.default), text: 'Persona default (applies in every guild): ' + capsSummary(pol.default) }));
    for (const [gid, gp] of polGuilds) {
      const lines = [];
      if (bans.includes(gid)) lines.push(el('div', { class: 'cell-roles', text: 'Removed with /ban: nothing it holds applies here.' }));
      else if (Array.isArray(gp.default)) lines.push(el('div', { class: 'cell-roles', title: gp.default.length ? capsTitle(gp.default) : undefined, text: 'Guild-wide: ' + (gp.default.length ? capsSummary(gp.default) : 'denied') }));
      const rows = Object.entries(gp.channels || {}).sort((a, b) => byName(chanText(a[0], names), chanText(b[0], names)));
      for (const [cid, caps] of rows) lines.push(el('div', { class: 'grant-line' }, [chanNode(cid, names), el('span', { class: 'muted', title: caps.length ? capsTitle(caps) : undefined, text: ' — ' + (caps.length ? capsSummary(caps) : 'blocked') })]));
      grantKids.push(el('div', { class: 'grant-guild' }, [el('strong', { text: guildText(gid, names), title: gid }), ...lines]));
    }
    kids.push(el('div', { class: 'field' }, [el('div', { class: 'field-label', text: 'Direct grants' }), ...grantKids]));
  }
  return section('Access in every guild', kids);
}

/** Super-admin: the token authenticates the persona everywhere, so its
 *  lifecycle isn't a per-guild action. */
function tokenSection(ctx) {
  const status = ui.statusLine(null);
  const rotate = el('button', { class: 'btn btn-sm', text: 'Rotate token' });
  rotate.addEventListener('click', () => tokenAction(ctx, 'rotate', rotate, status));
  const revoke = el('button', { class: 'btn btn-sm btn-danger', text: 'Revoke token' });
  revoke.addEventListener('click', () => tokenAction(ctx, 'revoke', revoke, status));
  return section('Token', [
    el('p', { class: 'muted', text: 'The token is how an agent logs in as this persona, in every guild. Rotate issues a new one (shown once); revoke invalidates it and drops live sessions.' }),
    el('div', { class: 'inline' }, [rotate, revoke]),
    status.node,
  ]);
}

async function tokenAction(ctx, action, button, status) {
  const name = ctx.displayName;
  const rotate = action === 'rotate';
  const go = await ui.confirmDialog(rotate
    ? { title: 'Rotate the token for ' + name + '?', body: 'The running agent stays connected but must use the new token the next time it connects.', confirmLabel: 'Rotate token' }
    : { title: 'Revoke ' + name + '’s token?', body: 'Its live sessions are dropped now, and the agent can’t connect again until it gets a new token.', confirmLabel: 'Revoke token', danger: true });
  if (!go) return;
  await ui.busy(button, async () => {
    try {
      const r = await api('POST', '/admin/personas/' + encodeURIComponent(ctx.id) + '/token', { action });
      if (rotate) {
        status.ok('Issued a new token for ' + name + '. The old one no longer works for new connections.');
        if (r.token) showSecret(r.token, button);
      } else {
        status.ok('Revoked ' + name + '’s token and dropped its live sessions.');
      }
    } catch (e) { status.err(notDone(e, rotate ? 'Not rotated' : 'Not revoked')); }
  }, rotate ? 'Rotating…' : 'Revoking…');
}

/**
 * Direct grants in the drawer's guild: what is set (the guild-wide level
 * first — set, denied or not set, with Unset and Deny guild-wide — then one
 * row per channel), and a form that sets a level on one channel — text,
 * voice or forum; a thread uses its parent's access and a category grants
 * nothing — or guild-wide. Save stays off until a target and a level are
 * picked, so a grant can't be stored empty by accident. A preset is sent as
 * {level}, Custom… as {caps}.
 *
 * A persona removed from the guild with /ban (`banned0`) has nothing there:
 * the guild-wide row says so, and Unset asks before lifting that. Giving it
 * access (a level here, an access role) lifts it too; the relay's answer says
 * which. Returns { node, setBanned(banned) }.
 *
 * A relay older than GRANT_API is asked only what it reads right: a level
 * as its caps (a channel's, or guild-wide with no channelId) and Deny
 * guild-wide as a bare DELETE. It can't unset a guild-wide level, so Unset
 * isn't offered. Which relay it is, is checked when a change is sent.
 */
function grantEditor(ctx, policy0, channels, names, onChange = () => {}, banned0 = false) {
  const { id, displayName, gid } = ctx;
  const P = () => gpath(gid) + '/personas/' + encodeURIComponent(id) + '/grants';
  const grantApi = () => relayApi() >= GRANT_API;
  const OLD_RELAY_UNSET = 'This relay is older than the panel and can’t unset a guild-wide level. Set another level or deny guild-wide instead, or update the relay.';
  const guild = guildName(gid);
  const GUILD_WIDE = '__guild__';
  const det = el('details', { class: 'advanced grants', open: true }, [el('summary', { text: 'Direct grants' })]);
  const tableBox = el('div', {});
  const banNote = el('p', { class: 'warn-line hidden' });
  const status = ui.statusLine(null);
  let policy = policy0 || null;
  let banned = banned0;
  /** Take the relay's word on the ban, from a change's answer. */
  const noteBanned = (r) => { if (r && typeof r.banned === 'boolean') banned = r.banned; };

  /** Why a grant on this channel does nothing, or null. */
  function inertNote(cid) {
    const l = names.channels && names.channels[cid];
    if (!l) return null;
    if (l.type === 'thread') return 'Does nothing: threads use ' + (l.parentName ? '#' + l.parentName : 'their channel') + '’s access.';
    if (l.type === 'category') return 'Does nothing: a category grants nothing. Pick its channels instead.';
    return null;
  }
  function levelCell(caps, emptyBadge, emptyNote) {
    if (!caps.length) return el('td', { title: emptyNote }, [el('span', { class: 'badge badge-warn', text: emptyBadge })]);
    return el('td', { title: capsTitle(caps), text: levelLabel(caps) });
  }

  /** The guild-wide row: its level, 'Denied' or 'Not set', and what can be
   *  done — Unset (fall back to the persona default) when something is set,
   *  Deny guild-wide unless it already is. */
  function guildWideRow(gd) {
    const buttons = [];
    // An older relay can't unset (it would store a deny): say so instead.
    const noUnset = () => el('span', { class: 'muted', text: 'Unset needs the relay updated', title: OLD_RELAY_UNSET });
    if (banned) {
      // Removed with /ban: Unset is the one thing to offer here (it asks
      // before lifting the removal); it is denied already.
      if (Array.isArray(gd) && !grantApi()) buttons.push(noUnset());
      else if (Array.isArray(gd)) {
        const unset = el('button', { class: 'btn btn-sm', text: 'Unset', 'aria-label': 'Unset ' + displayName + '’s guild-wide level in ' + guild + ' and lift its removal', title: 'Lifts the removal: channels fall back to the persona default.' });
        unset.addEventListener('click', () => unsetGuildWide(unset));
        buttons.push(unset);
      }
      return el('tr', {}, [
        el('td', { text: 'Every channel (guild-wide)' }),
        el('td', { title: displayName + ' was removed from ' + guild + ' with /ban: nothing it holds applies here.' }, [el('span', { class: 'badge badge-warn', text: 'Removed with /ban' })]),
        el('td', { class: 'col-narrow' }, [el('div', { class: 'inline' }, buttons)]),
      ]);
    }
    if (Array.isArray(gd) && !grantApi()) buttons.push(noUnset());
    else if (Array.isArray(gd)) {
      const unset = el('button', { class: 'btn btn-sm', text: 'Unset', 'aria-label': 'Unset ' + displayName + '’s guild-wide level in ' + guild, title: 'Falls back to the persona default.' });
      unset.addEventListener('click', () => unsetGuildWide(unset));
      buttons.push(unset);
    }
    if (!Array.isArray(gd) || gd.length) {
      const deny = el('button', { class: 'btn btn-sm btn-danger', text: 'Deny guild-wide', 'aria-label': 'Deny ' + displayName + ' guild-wide in ' + guild, title: 'Blocks the persona default here; access roles still apply.' });
      deny.addEventListener('click', () => denyGuildWide(deny));
      buttons.push(deny);
    }
    const level = Array.isArray(gd)
      ? levelCell(gd, 'Denied', 'Denied guild-wide: ' + displayName + '’s persona default doesn’t apply in ' + guild + '. Access roles and direct grants still do.')
      : el('td', { class: 'muted', text: 'Not set', title: 'No guild-wide level: channels without their own grant fall back to the persona default.' });
    return el('tr', {}, [
      el('td', { text: 'Every channel (guild-wide)' }),
      level,
      el('td', { class: 'col-narrow' }, [el('div', { class: 'inline' }, buttons)]),
    ]);
  }

  function draw(p) {
    policy = p || null;
    clear(tableBox);
    const gd = policy ? policy.default : undefined; // undefined: not set here
    const chans = (policy && policy.channels) || {};
    const keys = Object.keys(chans).sort((a, b) => byName(chanText(a, names), chanText(b, names)));
    const rows = [guildWideRow(gd)];
    for (const cid of keys) {
      const where = chanText(cid, names);
      const note = inertNote(cid);
      const rm = el('button', { class: 'btn btn-sm btn-danger', text: 'Remove', 'aria-label': 'Remove ' + displayName + '’s direct grant in ' + where });
      rm.addEventListener('click', () => ui.busy(rm, () => removeGrant(cid), 'Removing…'));
      rows.push(el('tr', {}, [
        el('td', {}, [chanNode(cid, names), note ? el('div', { class: 'cell-note', text: note }) : null]),
        levelCell(chans[cid] || [], 'Blocked', 'An empty direct grant: it blocks the guild-wide level and the persona default in this channel. Access roles still apply.'),
        el('td', { class: 'col-narrow' }, [rm]),
      ]));
    }
    tableBox.appendChild(table([{ label: 'Where' }, { label: 'Level' }, { label: '', cls: 'col-narrow' }], rows, 'No direct grants in ' + guild + '.'));
    banNote.textContent = banned
      ? displayName + ' was removed from ' + guild + ' with /ban, so nothing it holds applies here — not its persona default, direct grants or access roles. Giving it access here (a level below, or an access role) lifts that.'
      : '';
    banNote.classList.toggle('hidden', !banned);
  }

  async function removeGrant(cid) {
    try {
      const r = await api('DELETE', P() + '?channelId=' + encodeURIComponent(cid));
      noteBanned(r);
      draw(r.guildPolicy);
      target.focus(); // the row whose button had focus is gone
      if (target.value === cid) preload();
      status.ok('Removed ' + displayName + '’s direct grant in ' + chanText(cid, names) + '.');
      markStale(); onChange();
    } catch (e) { status.err(notDone(e, 'Not removed')); }
  }

  async function denyGuildWide(button) {
    const gd = policy && Array.isArray(policy.default) && policy.default.length ? policy.default : null;
    const go = await ui.confirmDialog({
      title: 'Deny ' + displayName + ' guild-wide in ' + guild + '?',
      body: [
        (gd ? displayName + '’s guild-wide ' + levelLabel(gd) + ' is replaced by a deny. ' : '') + 'In every channel of ' + guild +
          ' without its own direct grant, ' + displayName + ' then gets nothing from its own settings: the deny blocks its persona default here.',
        'Access roles and direct grants still apply. To undo it, use Unset' + (gd ? ' or set a guild-wide level again' : '') + '.',
      ],
      confirmLabel: 'Deny guild-wide',
      danger: true,
    });
    if (!go) return;
    await ui.busy(button, async () => {
      try {
        // An older relay denies guild-wide on a DELETE that names no channel.
        const r = await api('DELETE', P() + (grantApi() ? '?guildDefault=deny' : ''));
        noteBanned(r);
        draw(r.guildPolicy);
        target.focus();
        if (target.value === GUILD_WIDE) preload();
        status.ok(displayName + ' is denied guild-wide in ' + guild + ': its persona default no longer applies here. Access roles and direct grants still do.');
        markStale(); onChange();
      } catch (e) { status.err(notDone(e, 'Not denied')); }
    }, 'Denying…');
  }

  async function unsetGuildWide(button) {
    // Offered only by a relay that can do it; one that turned out older
    // since this was drawn would store a deny instead. Nothing is sent.
    if (!grantApi()) { status.err('Not unset: ' + OLD_RELAY_UNSET); draw(policy); return; }
    const gd = policy && Array.isArray(policy.default) ? policy.default : [];
    // Removed with /ban: unsetting alone would change nothing, so it lifts
    // the removal too — and says so first.
    const lift = banned;
    const go = await ui.confirmDialog(lift ? {
      title: 'Unset ' + displayName + '’s guild-wide level in ' + guild + ' and lift its removal?',
      body: [
        displayName + ' was removed from ' + guild + ' with /ban, so nothing applies to it there. Unsetting lifts that: channels of ' + guild +
          ' without their own direct grant fall back to ' + displayName + '’s persona default, and access roles given here apply again.',
        'To undo it, use /ban in ' + guild + ' again.',
      ],
      confirmLabel: 'Unset and lift',
    } : {
      title: 'Unset ' + displayName + '’s guild-wide level in ' + guild + '?',
      body: [
        (gd.length ? displayName + '’s guild-wide ' + levelLabel(gd) : 'The guild-wide deny') + ' is removed: channels of ' + guild +
          ' without their own direct grant fall back to ' + displayName + '’s persona default.',
        'Access roles and direct grants still apply. To undo it, ' + (gd.length ? 'set a guild-wide level again' : 'deny guild-wide again') + '.',
      ],
      confirmLabel: 'Unset guild-wide',
    });
    if (!go) return;
    if (!grantApi()) { status.err('Not unset: ' + OLD_RELAY_UNSET); draw(policy); return; }
    await ui.busy(button, async () => {
      try {
        const r = await api('DELETE', P() + '?guildDefault=unset' + (lift ? '&liftBan=1' : ''));
        noteBanned(r);
        draw(r.guildPolicy);
        target.focus();
        if (target.value === GUILD_WIDE) preload();
        status.ok(lift
          ? 'Lifted ' + displayName + '’s removal from ' + guild + ' and unset its guild-wide level: channels without their own grant fall back to the persona default.'
          : 'Unset ' + displayName + '’s guild-wide level in ' + guild + ': channels without their own grant fall back to the persona default.');
        markStale(); onChange();
      } catch (e) { status.err(notDone(e, 'Not unset')); }
    }, 'Unsetting…');
  }

  const target = el('select', { name: 'target' }, [el('option', { value: '', text: 'Pick a channel…' })]
    .concat(channelOptions(channels).map((o) => el('option', { value: o.value, text: o.text })))
    .concat([el('option', { value: GUILD_WIDE, text: 'Every channel in ' + guild + ' (guild-wide)…' })]));
  const wideWarn = el('p', { class: 'warn-line hidden', text: 'Applies to every channel without its own grant, including new ones.' });
  const level = ui.levelControl({ label: 'Level' });
  const save = el('button', { type: 'submit', class: 'btn btn-sm btn-primary', text: 'Save' });
  const why = el('span', { class: 'field-hint' });
  const form = el('form', { class: 'subsection grant-form', novalidate: true }, [
    ui.field({ label: 'Where', control: target }),
    wideWarn,
    ui.field({ label: 'Level', control: level.node }),
    el('div', { class: 'inline' }, [save, why]),
    status.node,
  ]);
  const tracker = ctx.drawer.track(form);

  /** The target's current setting: caps, or undefined when it has none. */
  function currentCaps(t) {
    if (!t || !policy) return undefined;
    if (t === GUILD_WIDE) return policy.default;
    return policy.channels ? policy.channels[t] : undefined;
  }
  function update() {
    const missing = !target.value ? 'Pick a channel and a level to save.' : !level.value().length ? 'Pick a level to save.' : '';
    save.disabled = !!missing;
    why.textContent = missing;
  }
  /** Load the picked target's level; picking alone changes nothing. */
  function preload() {
    const caps = currentCaps(target.value);
    level.set(Array.isArray(caps) ? caps : []);
    wideWarn.classList.toggle('hidden', target.value !== GUILD_WIDE);
    tracker.reset();
    update();
  }
  target.addEventListener('change', preload);
  level.onChange(update);

  ui.onSubmit(form, async () => {
    const t = target.value;
    const caps = level.value();
    if (!t || !caps.length) return; // Save is off until both are picked
    const sent = tracker.mark(); // what is saved, if it goes through
    // One target and one operation: a preset by name, Custom… as its caps.
    // An older relay takes caps only (it would store a missing caps as a
    // deny), and reads a grant with no channelId as guild-wide.
    const body = t === GUILD_WIDE ? {} : { channelId: t };
    const k = level.level();
    if (!grantApi()) body.caps = caps;
    else {
      if (t === GUILD_WIDE) body.guildDefault = true;
      if (k && k !== 'custom') body.level = k;
      else body.caps = caps;
    }
    try {
      const r = await api('PUT', P(), body);
      const was = banned;
      noteBanned(r);
      draw(r.guildPolicy);
      // What was sent is saved; a level picked while it was at work is not.
      // Picked another target meanwhile and came back: the form loaded the
      // level from before this save — show the saved one, unless it was
      // changed again since.
      if (!tracker.saved(sent) && target.value === t && !tracker.isDirty()) preload();
      status.ok((t === GUILD_WIDE
        ? displayName + ' → ' + capsSummary(caps) + ' guild-wide in ' + guild + ' (every channel without its own grant).'
        : displayName + ' → ' + capsSummary(caps) + ' in ' + chanText(t, names) + '.') +
        (was && !banned ? ' That lifted its removal from ' + guild + '.' : ''));
      markStale(); onChange();
    } catch (e) { status.err(notDone(e, 'Not saved', { channelId: t === GUILD_WIDE ? null : t, names })); }
  });

  draw(policy0);
  update();
  // Kept across "Sign in again": whose, where and what level, nothing else.
  keepForm(ctx.drawer, 'grant', {
    serialize: () => ({ personaId: id, target: target.value, caps: level.value() }),
    belongs: (f) => f.personaId === id,
    restore(f) {
      if (f.target && Array.from(target.options).some((o) => o.value === f.target)) {
        target.value = f.target;
        preload();
      }
      if (f.caps) level.set(f.caps);
      update();
    },
    isDirty: () => tracker.isDirty(),
  }, status);
  det.appendChild(tableBox);
  det.appendChild(banNote);
  det.appendChild(form);
  return {
    node: det,
    setBanned(b) {
      if (b === banned) return;
      banned = b;
      draw(policy);
    },
  };
}

// ── Invites (guild-scoped) ─────────────────────────────────────────────────────

async function renderInvites(view, stale) {
  const gid = state.guildId; // a revoke confirmed later goes to this guild
  const meta = await guildMeta(gid);
  if (stale()) return;
  // A link: the mint drawer has an address (#/g/{gid}/invites/new).
  const mintBtn = el('a', { class: 'btn btn-sm btn-primary', href: lib.formatRoute(route('g', state.guildId, 'invites', { kind: 'mint' })), 'data-key': 'mint', text: '+ Mint invite' });
  const list = listView(view, {
    placeholder: 'Search invites…',
    actions: [mintBtn],
    load: async () => {
      const data = await api('GET', gpath(gid) + '/invites' + qs({ q: state.q, limit: LIMIT, offset: state.offset }));
      const names = withChannelList(data.names, meta.channels, meta.discordRoles);
      names.guilds = Object.assign({ [state.guildId]: currentGuildName() }, names.guilds);
      const now = Date.now();
      // Newest first, as the relay sends them; each with its status.
      const rows = (data.invites || []).map((inv) => {
        const spent = inv.status === 'used' || inv.status === 'expired';
        const verb = spent ? 'Delete' : 'Revoke';
        const revoke = el('button', { class: 'btn btn-sm btn-danger', text: verb, 'aria-label': verb + ' invite ' + (inv.label || inv.code) });
        revoke.addEventListener('click', () => revokeInvite(gid, inv, revoke, list));
        const grants = lib.grantSummary(inv, names);
        return el('tr', {}, [
          el('td', {}, [el('code', { text: inv.code })]),
          el('td', { text: inv.label || '—' }),
          el('td', { class: 'col-narrow' }, [el('span', { class: spent ? 'muted' : '', text: lib.inviteStatusText(inv.status) })]),
          el('td', { class: 'col-narrow', text: lib.modeText(inv.mode) }),
          el('td', { class: 'col-narrow', text: lib.usedText(inv) }),
          el('td', { class: 'col-narrow', text: expiryCell(inv.expiresAt, now), title: inv.expiresAt ? new Date(inv.expiresAt).toLocaleString() : undefined }),
          el('td', { class: 'cell-roles', text: grants, title: grants + (inv.grant ? '. ' + capsTitle(inv.grant.caps) : '') }),
          el('td', {}, [revoke]),
        ]);
      });
      return el('div', {}, [
        table([
          { label: 'Code' }, { label: 'Label' }, { label: 'Status', cls: 'col-narrow' }, { label: 'Who can use it', cls: 'col-narrow' },
          { label: 'Uses', cls: 'col-narrow' }, { label: 'Expires', cls: 'col-narrow' }, { label: 'Grants' }, { label: '', cls: 'col-narrow' },
        ], rows, state.q ? 'No invite matches “' + state.q + '”.' : 'No invites in this guild.'),
        pager(data, () => list.refresh()),
      ]);
    },
  });
}

/** 'Fri 23 Oct', 'expired Fri 16 Oct' or 'never'. */
function expiryCell(expiresAt, now) {
  if (!expiresAt) return 'never';
  const at = Date.parse(expiresAt);
  return (at <= now ? 'expired ' : '') + lib.shortDate(expiresAt, now);
}

/**
 * The Discord roles a mirror may follow: the guild's own, without the
 * relay's pooled addressing roles, and @everyone only on request.
 */
function discordRoleChoices(discordRoles, withEveryone) {
  const isEveryone = (r) => r.id === state.guildId || r.name === '@everyone';
  return (discordRoles || [])
    .filter((r) => !r.pooled && (withEveryone || !isEveryone(r)))
    .sort((a, b) => (isEveryone(a) ? 1 : 0) - (isEveryone(b) ? 1 : 0) || byName(a.name || '', b.name || ''))
    .map((r) => ({ value: r.id, text: roleText(r.id, { discordRoles: { [r.id]: r } }) }));
}

/** A 'Show @everyone' toggle for a Discord-role picker (node null when the
 *  guild has no @everyone role to show). show() turns it on, as a click would. */
function everyoneToggle(discordRoles, onToggle) {
  const has = (discordRoles || []).some((r) => !r.pooled && (r.id === state.guildId || r.name === '@everyone'));
  if (!has) return { node: null, on: () => false, show() {} };
  const box = el('input', { type: 'checkbox', 'data-no-dirty': true });
  box.addEventListener('change', () => onToggle(box.checked));
  return {
    node: el('label', { class: 'check-inline' }, [box, el('span', { text: 'Show @everyone' })]),
    on: () => box.checked,
    show() {
      if (box.checked) return;
      box.checked = true;
      onToggle(true);
    },
  };
}

/** Is `id` a Discord role the pickers offer only behind 'Show @everyone'? */
function behindEveryone(discordRoles, id) {
  return !discordRoleChoices(discordRoles, false).some((o) => o.value === id) &&
    discordRoleChoices(discordRoles, true).some((o) => o.value === id);
}

/** One Discord role to mirror: a select that starts at 'Pick a Discord role…'.
 *  restore(id) puts back a kept choice — @everyone too, showing it first. */
function mirrorRolePicker(discordRoles) {
  const select = el('select', { name: 'mirrorRole' });
  function fill(withEveryone) {
    const keep = select.value;
    clear(select);
    select.appendChild(el('option', { value: '', text: 'Pick a Discord role…' }));
    const opts = discordRoleChoices(discordRoles, withEveryone);
    for (const o of opts) select.appendChild(el('option', { value: o.value, text: o.text }));
    select.value = opts.some((o) => o.value === keep) ? keep : '';
  }
  const listeners = [];
  const changed = () => { for (const fn of listeners) fn(select.value); };
  select.addEventListener('change', changed);
  const toggle = everyoneToggle(discordRoles, (on) => { fill(on); changed(); });
  fill(false);
  return {
    select, toggle: toggle.node, value: () => select.value, onChange: (fn) => listeners.push(fn),
    restore(id) {
      if (!id) return;
      if (behindEveryone(discordRoles, id)) toggle.show();
      if (Array.from(select.options).some((o) => o.value === id)) select.value = id;
    },
  };
}

/** Several Discord roles to mirror: a checkbox list. restore(ids) puts back
 *  kept choices — @everyone too, showing it first. */
function mirrorRoleList(discordRoles) {
  const list = ui.checkList({ label: 'Discord roles', empty: 'This guild has no Discord roles to mirror.', options: discordRoleChoices(discordRoles, false) });
  const toggle = everyoneToggle(discordRoles, (on) => list.setOptions(discordRoleChoices(discordRoles, on)));
  return {
    list, toggle: toggle.node,
    restore(ids) {
      if (!ids) return;
      if (ids.some((id) => behindEveryone(discordRoles, id))) toggle.show();
      list.setValues(ids);
    },
  };
}

/**
 * The mint drawer (#/g/{gid}/invites/new). `prefill` is the address's query:
 * r (access roles), or c (a channel) with lvl — 'Invite a new agent here'.
 */
async function openMintDrawer(prefill = {}) {
  const gid = state.guildId; // the guild this drawer mints for
  const d = openDrawer({ title: 'Mint invite', key: 'mint' });
  let meta;
  try { meta = await guildMeta(gid); } catch (e) {
    if (d.isCurrent() && !e.handled) d.setBody(e.status === 401 ? sessionEndedNote() : loadError(couldntLoad('this guild’s access roles and channels', e), () => openMintDrawer(prefill)));
    return;
  }
  if (!d.isCurrent()) return;
  const isSuper = !!(state.me && state.me.isSuper);
  const guild = currentGuildName();
  const names = metaNames(meta);
  const catalog = meta.catalog || {};
  const mine = guildRoleNames(meta);

  const label = el('input', { type: 'text', name: 'label', maxlength: '120', autocomplete: 'off' });

  // What it grants. An invite carries access roles OR one channel/mirror
  // grant (the relay takes one or the other), so this is a choice of three.
  const kind = ui.radioGroup({
    label: 'What it grants',
    value: mine.length ? 'roles' : 'channels',
    options: [
      { value: 'roles', text: 'Access roles' },
      { value: 'channels', text: 'Channels' },
      { value: 'mirror', text: 'Mirror a Discord role' },
    ],
  });
  const roleList = ui.checkList({
    label: 'Access roles',
    empty: 'No access roles are defined for ' + guild + '.',
    options: mine.map((r) => ({ value: r, text: r, code: true, hint: lib.roleMeaning(catalog[r], names), title: capsTitle(catalog[r].caps) })),
  });
  const otherRoles = Object.keys(catalog).length - mine.length; // only a super-admin's catalog has any
  const chanList = ui.checkList({ label: 'Channels', empty: 'The relay sees no channels in ' + guild + '.', options: channelOptions(meta.channels) });
  const mirror = mirrorRolePicker(meta.discordRoles);
  const level = ui.levelControl({ value: lib.LEVEL_CAPS.write });
  const kindArea = el('div', { class: 'kind-area' });
  function syncKind() {
    clear(kindArea);
    const k = kind.value();
    if (k === 'roles') {
      kindArea.appendChild(ui.field({ label: 'Access roles', control: roleList.node }));
      if (isSuper && otherRoles > 0) kindArea.appendChild(el('p', { class: 'field-hint', text: '+' + lib.plural(otherRoles, 'role') + ' in other guilds' }));
      return;
    }
    if (k === 'channels') kindArea.appendChild(ui.field({ label: 'Channels', control: chanList.node }));
    else kindArea.appendChild(ui.field({ label: 'Discord role to mirror', control: mirror.select, after: mirror.toggle ? [mirror.toggle] : null, hint: 'The persona gets the level below wherever members with this role can see.' }));
    kindArea.appendChild(ui.field({ label: 'Level', control: level.node }));
  }
  kind.onChange(syncKind);
  syncKind();

  const uses = el('select', { name: 'uses' }, [
    el('option', { value: '1', text: '1' }), el('option', { value: '5', text: '5' }), el('option', { value: '25', text: '25' }),
    el('option', { value: 'unlimited', text: 'Unlimited' }), el('option', { value: 'other', text: 'Other…' }),
  ]);
  const usesOther = el('input', { type: 'number', name: 'usesOther', min: '1', step: '1', class: 'hidden', 'aria-label': 'How many uses' });
  uses.addEventListener('change', () => {
    usesOther.classList.toggle('hidden', uses.value !== 'other');
    if (uses.value === 'other') usesOther.focus();
  });
  const expires = el('select', { name: 'expires' }, [
    el('option', { value: '1', text: '1 day' }), el('option', { value: '7', text: '7 days' }),
    el('option', { value: '30', text: '30 days' }), el('option', { value: 'never', text: 'Never' }),
  ]);
  expires.value = '7';

  const who = ui.radioGroup({
    label: 'Who can use it',
    value: 'mint',
    options: [
      { value: 'mint', text: 'A new agent' },
      { value: 'augment', text: 'An existing persona' },
      { value: 'both', text: 'Either' },
    ],
  });
  const advanced = el('details', { class: 'advanced' }, [
    el('summary', { text: 'Advanced' }),
    ui.field({ label: 'Who can use it', control: who.node, hint: 'An existing persona or Either: anyone holding the code can add this access to a persona that already exists.' }),
  ]);

  const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Mint invite' });
  const status = ui.statusLine(null);
  const form = el('form', { class: 'drawer-sections', novalidate: true }, [
    ui.field({ label: 'Who is it for?', control: label, hint: 'Optional. Shown in the Invites list.' }),
    ui.field({ label: 'What it grants', control: kind.node }),
    kindArea,
    el('div', { class: 'field-row' }, [
      ui.field({ label: 'Uses', control: uses, after: [usesOther] }),
      ui.field({ label: 'Expires', control: expires }),
    ]),
    advanced,
    el('div', {}, [submit]),
    status.node,
  ]);

  // From the address: what to start with (not a change: Discard won't ask).
  const prefRoles = (prefill.r || []).filter((r) => mine.includes(r));
  const prefChannel = prefill.c && channelOptions(meta.channels).some((o) => o.value === prefill.c) ? prefill.c : null;
  if (prefRoles.length) {
    kind.set('roles');
    roleList.setValues(prefRoles);
  } else if (prefChannel) {
    kind.set('channels');
    chanList.setValues([prefChannel]);
  }
  if (prefill.lvl && lib.LEVEL_CAPS[prefill.lvl]) level.set(lib.LEVEL_CAPS[prefill.lvl]);
  syncKind();

  const tracker = d.track(form);
  // Kept across "Sign in again": the form's choices — never a minted code.
  keepForm(d, 'mint', {
    serialize: () => ({
      label: label.value, kind: kind.value(), roles: roleList.values(), channels: chanList.values(),
      mirrorRole: mirror.value() || undefined, caps: level.value(), uses: uses.value, usesOther: usesOther.value,
      expires: expires.value, mode: who.value(),
    }),
    restore(f) {
      if (f.label != null) label.value = f.label;
      if (f.kind) kind.set(f.kind);
      if (f.roles) roleList.setValues(f.roles.filter((r) => mine.includes(r)));
      if (f.channels) chanList.setValues(f.channels);
      mirror.restore(f.mirrorRole);
      if (f.caps) level.set(f.caps);
      if (f.uses) uses.value = f.uses;
      if (f.usesOther != null) usesOther.value = f.usesOther;
      usesOther.classList.toggle('hidden', uses.value !== 'other');
      if (f.expires) expires.value = f.expires;
      if (f.mode) who.set(f.mode);
      if (f.mode && f.mode !== 'mint') advanced.setAttribute('open', '');
      syncKind();
    },
    isDirty: () => tracker.isDirty(),
  }, status);

  ui.onSubmit(form, async () => {
    const no = (why) => status.err('Not minted: ' + why);
    const body = { mode: who.value() || 'mint' };
    if (label.value.trim()) body.label = label.value.trim();
    if (uses.value === 'other') {
      const n = Number(usesOther.value);
      if (!Number.isInteger(n) || n < 1) return no('enter how many times the code can be used — a whole number, 1 or more.');
      body.maxUses = n;
    } else if (uses.value !== 'unlimited') body.maxUses = Number(uses.value);
    if (expires.value !== 'never') body.expiresInDays = Number(expires.value);
    const sent = tracker.mark(); // what is minted, if it goes through
    const k = kind.value();
    if (k === 'roles') {
      const roles = roleList.values();
      if (!roles.length) return no('pick at least one access role.');
      body.roles = roles;
    } else {
      const caps = level.value();
      if (!caps.length) return no('pick a level.');
      if (k === 'channels') {
        const ch = chanList.values();
        if (!ch.length) return no('pick at least one channel.');
        body.grant = { caps, scope: { channels: ch } };
      } else {
        if (!mirror.value()) return no('pick a Discord role to mirror.');
        body.grant = { caps, scope: { mirrorRole: mirror.value() } };
      }
    }
    try {
      const r = await api('POST', gpath(gid) + '/invites', body);
      tracker.saved(sent); // an edit made while minting stays unsaved (Mint another shows it)
      markStale();
      status.clear();
      ui.toast('Invite minted.');
      showResult(r.code || '', r.invite || Object.assign({ guildId: gid }, body));
    } catch (e) { status.err(notDone(e, 'Not minted')); }
  }, { busyLabel: 'Minting…' });

  /** The minted code, on screen until Done: Copy, a summary, Mint another.
   *  The code lives only in this card — never in state, the URL or storage. */
  function showResult(code, inv) {
    const headId = ui.uid('invite-ready');
    const codeEl = el('code', { class: 'invite-code', text: code });
    const cardStatus = ui.statusLine(null);
    const copy = el('button', { class: 'btn btn-primary', text: 'Copy' });
    copy.addEventListener('click', async () => {
      if (await ui.copyText(code, codeEl)) cardStatus.ok('Copied the code.', { toast: false });
      else cardStatus.err('Couldn’t copy automatically. The code is selected: copy it with Ctrl+C (⌘C on a Mac).', { toast: false });
    });
    const another = el('button', { class: 'btn', text: 'Mint another' });
    another.addEventListener('click', () => { d.setBody(form); label.focus(); });
    // As ✕: the form behind the card may hold an edit made while this was
    // minting (it is not in this invite), and closing asks before it goes.
    const done = el('button', { class: 'btn', text: 'Done', onclick: () => d.requestClose() });
    d.setBody(el('section', { class: 'result-card', 'aria-labelledby': headId }, [
      el('h3', { id: headId, text: 'Invite ready' }),
      el('p', { class: 'invite-code-wrap' }, [codeEl]),
      el('p', { class: 'invite-summary', text: lib.inviteSummary(inv, names, Date.now()) }),
      el('p', { class: 'muted', text: 'Hand this code to the enrolling agent.' }),
      tracker.isDirty() ? el('p', { class: 'warn-line', text: 'The form was changed while this invite was being minted; that change isn’t in it. Mint another shows it.' }) : null,
      el('div', { class: 'inline' }, [copy, another, done]),
      cardStatus.node,
    ]));
    copy.focus();
  }

  d.setBody(form);
}

/** Revoke an active invite, or delete a used-up or expired one (which no
 *  agent can use any more) from the list. */
async function revokeInvite(gid, inv, button, list) {
  const name = inv.label ? '“' + inv.label + '”' : inv.code;
  const spent = inv.status === 'used' || inv.status === 'expired';
  const go = await ui.confirmDialog(spent
    ? { title: 'Delete invite ' + name + '?', body: 'It is ' + lib.inviteStatusText(inv.status).toLowerCase() + ', so no agent can use it; this removes it from the list. Access already granted stays.', confirmLabel: 'Delete', danger: true }
    : { title: 'Revoke invite ' + name + '?', body: 'Agents can no longer enroll or claim with it. Access already granted stays.', confirmLabel: 'Revoke', danger: true });
  if (!go) return;
  await ui.busy(button, async () => {
    try {
      await api('DELETE', gpath(gid) + '/invites/' + encodeURIComponent(inv.code));
      list.status.ok(spent ? 'Deleted invite ' + name + '.' : 'Revoked invite ' + name + '. Agents can no longer use it.');
      list.refresh();
    } catch (e) { list.status.err(notDone(e, spent ? 'Not deleted' : 'Not revoked')); }
  }, spent ? 'Deleting…' : 'Revoking…');
}

// ── Roles (guild-scoped read, super-admin authoring) ────────────────────────────

async function renderRoles(view, stale) {
  const meta = await guildMeta();
  if (stale()) return;
  let data = null; // fetched once per visit; the filter runs locally
  const actions = [];
  if (meta.canAuthor) {
    // A link: defining a role has an address (#/g/{gid}/roles/new).
    actions.push(el('a', { class: 'btn btn-sm btn-primary', href: lib.formatRoute(route('g', state.guildId, 'roles', { kind: 'newRole' })), 'data-key': 'newRole', text: '+ Define access role' }));
  }
  const list = listView(view, {
    placeholder: 'Filter access roles…',
    actions,
    load: async () => {
      if (!data) data = await api('GET', G() + '/roles' + qs({ names: '1' }));
      const { catalog, discordRoles, canAuthor, names: rawNames } = data;
      const names = withChannelList(rawNames, meta.channels, discordRoles);
      names.guilds = Object.assign({ [state.guildId]: currentGuildName() }, names.guilds);
      const here = (n) => (catalog[n] && catalog[n].guildId === state.guildId ? 0 : 1);
      // This guild's roles first (a guild-admin only gets those), then by name.
      const roleNames = Object.keys(catalog || {})
        .filter((n) => !state.q || n.toLowerCase().includes(state.q.toLowerCase()))
        .sort((a, b) => here(a) - here(b) || byName(a, b));
      const rows = roleNames.map((n) => {
        const r = catalog[n];
        const mirrorsPerChannel = lib.isMirror(r.scope) && r.mirrorCaps;
        const cells = [
          el('td', {}, [el('code', { text: n })]),
          el('td', {
            text: lib.roleLevelText(r, names),
            title: (mirrorsPerChannel ? 'Each channel’s Discord permissions for the mirrored role, up to this level. ' : '') + capsTitle(r.caps),
          }),
          el('td', { class: 'cell-roles', text: lib.wherePhrase(r.scope, names, r.guildId), title: lib.wherePhrase(r.scope, names, r.guildId, Infinity) }),
        ];
        if (canAuthor) {
          cells.push(el('td', {}, [r.guildId ? el('span', { text: guildText(r.guildId, names) }) : el('span', { class: 'muted', text: '—' })]));
          const del = el('button', { class: 'btn btn-sm btn-danger', text: 'Delete', 'aria-label': 'Delete access role ' + n });
          del.addEventListener('click', () => deleteRole(n, del, list, () => { data = null; }));
          cells.push(el('td', {}, [del]));
        }
        return el('tr', {}, cells);
      });
      const headers = [{ label: 'Name' }, { label: 'Level' }, { label: 'Where' }];
      if (canAuthor) headers.push({ label: 'Guild' }, { label: '', cls: 'col-narrow' });
      return el('div', {}, [
        table(headers, rows, state.q ? 'No access role matches “' + state.q + '”.' : 'No access roles in this guild.'),
        el('p', { class: 'hint muted', text: canAuthor
          ? 'Each access role belongs to one guild. As a super-admin you see every guild’s roles here, and can define or delete them.'
          : 'Access roles are defined by the relay’s operators. Give one to a persona from its drawer, or put it in an invite.' }),
      ]);
    },
  });
  // A role created in the drawer: refetch on the redraw that closing it triggers.
  list.invalidate = () => { data = null; };
}

async function openRoleDrawer() {
  // The guild this drawer was opened for — its pickers list this guild's
  // channels and roles, so the role must be saved to it whatever happens to
  // the scope switcher meanwhile.
  const gid = state.guildId;
  const d = openDrawer({ title: 'Define access role', key: 'newRole' });
  let meta;
  try { meta = await guildMeta(); } catch (e) {
    if (d.isCurrent() && !e.handled) d.setBody(e.status === 401 ? sessionEndedNote() : loadError(couldntLoad('this guild’s channels', e), () => openRoleDrawer()));
    return;
  }
  if (!d.isCurrent()) return;
  if (!meta.canAuthor) {
    // Only super-admins define access roles: a link here lands on the list.
    d.close();
    ui.toast('Only super-admins can define access roles. Ask one to add the role you need.', { kind: 'info' });
    return;
  }
  const names = metaNames(meta);
  const name = el('input', { type: 'text', name: 'name', autocomplete: 'off', spellcheck: 'false' });
  // A role belongs to the guild being viewed and is built from that guild's
  // channels and Discord roles; to define one for another guild, switch first.
  const kind = el('select', { name: 'where' }, [
    el('option', { value: 'all', text: 'All channels' }),
    el('option', { value: 'channels', text: 'Channels' }),
    el('option', { value: 'mirrorRole', text: 'Mirror a Discord role' }),
    el('option', { value: 'mirrorRoles', text: 'Mirror several Discord roles' }),
  ]);
  const chanList = ui.checkList({ label: 'Channels', empty: 'The relay sees no channels here.', options: channelOptions(meta.channels) });
  const mirror = mirrorRolePicker(meta.discordRoles);
  const mirrors = mirrorRoleList(meta.discordRoles);
  const level = ui.levelControl({});
  const area = el('div', {});
  function syncKind() {
    clear(area);
    if (kind.value === 'mirrorRole') area.appendChild(ui.field({ label: 'Discord role', control: mirror.select, after: mirror.toggle ? [mirror.toggle] : null }));
    else if (kind.value === 'mirrorRoles') area.appendChild(ui.field({ label: 'Discord roles', control: mirrors.list.node, after: mirrors.toggle ? [mirrors.toggle] : null }));
    else if (kind.value === 'channels') area.appendChild(ui.field({ label: 'Channels', control: chanList.node }));
  }

  const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Create access role' });
  const why = el('span', { class: 'field-hint' });
  const status = ui.statusLine(null);
  const form = el('form', { class: 'drawer-sections', novalidate: true }, [
    ui.field({ label: 'Name', control: name }),
    ui.field({ label: 'Where', control: kind }),
    area,
    ui.field({ label: 'Level', control: level.node }),
    el('div', { class: 'field' }, [el('div', { class: 'field-label', text: 'Guild' }), el('div', { text: guildText(gid, names) })]),
    el('div', { class: 'inline' }, [submit, why]),
    status.node,
  ]);

  /** A name the catalog holds: the naming rule is for new names, and a role
   *  made before it keeps its name — the relay lets it be replaced under
   *  that name (the save looks it up and asks first). */
  const inCatalog = (n) => Object.prototype.hasOwnProperty.call(meta.catalog || {}, n);
  /** What is still missing before Create can be pressed, or ''. */
  function missing() {
    const n = name.value.trim();
    if (!n) return 'Name the role';
    if (!ROLE_NAME.test(n) && !inCatalog(n)) return 'Use lower-case letters, digits, dots, dashes or underscores in the name (up to 64)';
    if (kind.value === 'channels' && !chanList.values().length) return 'Pick at least one channel';
    if (kind.value === 'mirrorRole' && !mirror.value()) return 'Pick a Discord role';
    if (kind.value === 'mirrorRoles' && !mirrors.list.values().length) return 'Pick at least one Discord role';
    if (!level.value().length) return 'Pick a level';
    return '';
  }
  function update() {
    const m = missing();
    submit.disabled = !!m;
    why.textContent = m ? m + ' to create it.' : '';
  }
  name.addEventListener('input', update);
  kind.addEventListener('change', () => { syncKind(); update(); });
  chanList.onChange(update);
  mirror.onChange(update);
  mirrors.list.onChange(update);
  level.onChange(update);
  syncKind();
  update();

  const tracker = d.track(form);
  // Kept across "Sign in again": the definition so far.
  keepForm(d, 'role', {
    serialize: () => ({
      name: name.value, where: kind.value, channels: chanList.values(), mirrorRole: mirror.value() || undefined,
      mirrorRoles: mirrors.list.values(), caps: level.value(),
    }),
    restore(f) {
      if (f.name != null) name.value = f.name;
      if (f.where) kind.value = f.where;
      syncKind();
      if (f.channels) chanList.setValues(f.channels);
      mirror.restore(f.mirrorRole);
      mirrors.restore(f.mirrorRoles);
      if (f.caps) level.set(f.caps);
      update();
    },
    isDirty: () => tracker.isDirty(),
  }, status);
  ui.onSubmit(form, async () => {
    if (missing()) return; // Create is off until the form is complete
    status.clear(); // a line about the last try is not about this one
    // What is sent is read now; the form stays editable while the relay is
    // asked, and an edit made meanwhile is not part of this save.
    const sent = tracker.mark();
    const roleName = name.value.trim();
    let scope;
    if (kind.value === 'all') scope = { all: true };
    else if (kind.value === 'mirrorRole') scope = { mirrorRole: mirror.value() };
    else if (kind.value === 'mirrorRoles') scope = { mirrorRoles: mirrors.list.values() };
    else scope = { channels: chanList.values() };
    const role = { caps: level.value(), scope, guildId: gid };

    /** The role of that name as the relay has it now (not as the tab showed
     *  it when drawn, so one made or deleted since, here or by another
     *  admin, counts), with names: it may be another guild's, and the line
     *  about it names that guild, its channels and its Discord roles. */
    async function lookup() {
      const now = await api('GET', '/admin/g/' + encodeURIComponent(gid) + '/roles' + qs({ names: '1' }));
      const catalog = (now && now.catalog) || {};
      if (!Object.prototype.hasOwnProperty.call(catalog, roleName)) return { existing: null, seen: names };
      const seen = withChannelList(now.names, meta.channels, meta.discordRoles);
      seen.guilds = Object.assign({ [gid]: guildText(gid, names) }, now.names && now.names.guilds);
      return { existing: catalog[roleName], seen };
    }

    /** Create it, or — when the name is this guild's role — edit it after
     *  asking. The relay refuses a name in use (EXISTS) unless asked to
     *  replace it in the guild it belongs to; if it was made, deleted or
     *  moved between the look and the save, look again, once. Resolves true
     *  when the role was saved. A drawer discarded while the relay was asked
     *  goes no further: no question (it would belong to whatever drawer is
     *  open now) and nothing sent. */
    async function attempt(again) {
      const { existing, seen } = await lookup();
      if (!d.isCurrent()) return false;
      const body = { name: roleName, role };
      if (existing) {
        const taken = lib.roleNameTaken(roleName, existing, role, gid, seen);
        if (taken.refuse) {
          // Another guild's role: replacing it from here would move it, and its
          // holders would lose its access there. Nothing is sent.
          status.err(taken.refuse);
          name.focus();
          return false;
        }
        const go = await ui.confirmDialog({ title: taken.title, body: taken.body, confirmLabel: taken.confirmLabel, danger: true });
        if (!go) return false;
        body.replace = true;
        body.expectedGuildId = existing.guildId;
      }
      try {
        await api('POST', '/admin/roles', body);
      } catch (e) {
        if (!again && (e.code === 'EXISTS' || e.code === 'GUILD_MISMATCH')) return attempt(true);
        throw e;
      }
      invalidateGuildMeta();
      if (state.list && state.list.invalidate) state.list.invalidate();
      markStale();
      // Through the form's line, so an earlier 'Not created' toast goes too
      // (and, if this drawer was closed meanwhile, the toast still says it).
      const done = (existing ? 'Changed access role ' : 'Created access role ') + roleName + ': ' + lib.roleMeaning(role, names) + '.';
      tracker.saved(sent);
      if (d.isCurrent() && tracker.isDirty()) {
        // Changed while it was being saved: that change was not sent. The
        // drawer stays with it, unsaved — closing asks, a sign-in keeps it,
        // and Create sends it (asking first, as the role exists now).
        status.ok(done + ' The form was changed while it was being saved; that change isn’t saved yet.');
        return true;
      }
      status.ok(done);
      d.close(); // the list redraws with the role — never another drawer
      return true;
    }

    try { await attempt(false); } catch (e) {
      // A look that failed after the drawer was discarded changed nothing,
      // and the admin has moved on: nothing to say.
      if (d.isCurrent() || e.method !== 'GET') status.err(notDone(e, 'Not created', { roleName }));
    }
  }, { busyLabel: 'Creating…', settled: update }); // edited while it was at work: Create as the form is now
  d.setBody(form);
}

async function deleteRole(name, button, list, invalidate) {
  const go = await ui.confirmDialog({
    title: 'Delete access role ' + name + '?',
    body: 'Personas holding it lose its access on their next action. This can’t be undone; you can define the role again.',
    confirmLabel: 'Delete', danger: true,
  });
  if (!go) return;
  await ui.busy(button, async () => {
    try {
      await api('DELETE', '/admin/roles/' + encodeURIComponent(name));
      invalidateGuildMeta();
      invalidate();
      list.status.ok('Deleted access role ' + name + '.');
      list.refresh();
    } catch (e) { list.status.err(notDone(e, 'Not deleted')); }
  }, 'Deleting…');
}

// ── Guilds (super-admin, GLOBAL): the relay's guild allow-list ────────────────

async function renderGuilds(view) {
  const input = el('input', { class: 'search', type: 'text', inputmode: 'numeric', name: 'guildId', placeholder: 'guild id to allow…', 'aria-label': 'Guild id to allow', autocomplete: 'off' });
  const add = el('button', { type: 'submit', class: 'btn btn-sm btn-primary', text: 'Allow id' });
  const allowForm = el('form', { class: 'inline toolbar-form hidden', novalidate: true }, [input, add]);
  const list = listView(view, {
    search: false,
    toolbar: [allowForm],
    load: async () => {
      const data = await api('GET', '/admin/guilds/all');
      allowForm.classList.toggle('hidden', !data.editable);
      return guildTables(data, list);
    },
  });
  allowForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const gid = input.value.trim();
    if (!gid || ui.isBusy(add)) return;
    if (await allowGuild(gid, null, list, add)) input.value = '';
  });
}

function guildTables(data, list) {
  const out = el('div', {});
  const allowed = (data.guilds || []).filter((g) => g.allowed);
  const candidates = (data.guilds || []).filter((g) => !g.allowed);

  if (!data.editable) {
    out.appendChild(el('div', { class: 'banner', text:
      'Read-only: the allow-list is env-managed (DISCORD_GUILD_ID). Set PORTAL_GUILDS on the relay to edit it here.' }));
    if ((data.allowlist || []).length === 0) {
      out.appendChild(el('p', { class: 'hint muted', text:
        'No restriction configured — ALL joined guilds are relayed.' }));
    }
  } else if ((data.allowlist || []).length === 0) {
    out.appendChild(el('div', { class: 'banner err', text:
      'Allow-list is EMPTY — the relay is ignoring every guild (deny-all).' }));
  }

  const rows = allowed.map((g) => {
    const cells = [
      el('td', {}, g.present === false
        ? [el('span', { class: 'muted', text: '(unknown)' }), ' ', el('span', { class: 'badge badge-warn', text: 'not joined' })]
        : [g.name || g.id]),
      el('td', {}, [el('code', { text: g.id })]),
      el('td', { class: 'col-narrow', text: g.memberCount != null ? String(g.memberCount) : '—' }),
    ];
    if (data.editable) {
      const rm = el('button', { class: 'btn btn-sm btn-danger', text: 'Remove', 'aria-label': 'Remove ' + (g.name || g.id) + ' from the allow-list' });
      rm.addEventListener('click', () => disallowGuild(g, allowed.length, rm, list));
      cells.push(el('td', { class: 'col-narrow' }, [rm]));
    }
    return el('tr', {}, cells);
  });
  const headers = [{ label: 'Allowed guild' }, { label: 'Id' }, { label: 'Members', cls: 'col-narrow' }];
  if (data.editable) headers.push({ label: '', cls: 'col-narrow' });
  out.appendChild(table(headers, rows, 'No guilds are allowed.'));

  if (candidates.length) {
    out.appendChild(el('h3', { class: 'muted', text: 'Bot is in these guilds, but they are not allowed' }));
    out.appendChild(table(
      [{ label: 'Guild' }, { label: 'Id' }, { label: 'Members', cls: 'col-narrow' },
       ...(data.editable ? [{ label: '', cls: 'col-narrow' }] : [])],
      candidates.map((g) => {
        const allow = data.editable ? el('button', { class: 'btn btn-sm btn-primary', text: 'Allow', 'aria-label': 'Allow ' + (g.name || g.id) }) : null;
        if (allow) allow.addEventListener('click', () => allowGuild(g.id, g.name, list, allow));
        return el('tr', {}, [
          el('td', { text: g.name || g.id }),
          el('td', {}, [el('code', { text: g.id })]),
          el('td', { class: 'col-narrow', text: g.memberCount != null ? String(g.memberCount) : '—' }),
          ...(allow ? [el('td', { class: 'col-narrow' }, [allow])] : []),
        ]);
      }),
    ));
  }

  out.appendChild(el('p', { class: 'hint muted', text:
    'The allow-list controls which Discord guilds the relay serves at all (events, history, sending). ' +
    'Changes apply immediately — no relay restart, no Discord reconnect. Edits are audited.' }));
  return out;
}

/** Resolves true when the guild was allowed. */
async function allowGuild(gid, name, list, button) {
  if (!/^\d{5,25}$/.test(gid)) { list.status.err('Not allowed: that isn’t a Discord guild id (a number of 5–25 digits).'); return false; }
  const label = name || gid;
  const go = await ui.confirmDialog({
    title: 'Allow ' + label + '?',
    body: 'The relay starts serving it immediately: events, history and sending.',
    confirmLabel: 'Allow',
  });
  if (!go) return false;
  return ui.busy(button, async () => {
    try {
      const r = await api('POST', '/admin/guilds', { guildId: gid });
      if (r.warning) list.status.ok('Allowed ' + label + ', but ' + r.warning + '.');
      else list.status.ok('Allowed ' + label + '. The relay serves it now.');
      await refreshScope();
      list.refresh();
      return true;
    } catch (e) { list.status.err(notDone(e, 'Not allowed')); return false; }
  }, 'Allowing…');
}

async function disallowGuild(g, allowedCount, button, list) {
  const name = g.name || g.id;
  const body = ['The relay stops serving it immediately.'];
  if (allowedCount === 1) body.push('This is the LAST allowed guild — the relay will then serve no guild at all.');
  const go = await ui.confirmDialog({
    title: 'Remove ' + name + ' from the allow-list?', body,
    confirmLabel: 'Remove', danger: true,
  });
  if (!go) return;
  await ui.busy(button, async () => {
    try {
      const r = await api('DELETE', '/admin/guilds/' + encodeURIComponent(g.id));
      if (r.denyAll) list.status.err('Removed ' + name + '. The allow-list is now EMPTY: the relay serves no guild.', { toastText: 'Removed ' + name + '. The allow-list is now empty.' });
      else list.status.ok('Removed ' + name + ' from the allow-list. The relay no longer serves it.');
      await refreshScope();
      list.refresh();
    } catch (e) { list.status.err(notDone(e, 'Not removed')); }
  }, 'Removing…');
}

// ── Audit (guild-scoped) ───────────────────────────────────────────────────────

async function renderAudit(view, stale) {
  const meta = await guildMeta();
  if (stale()) return;
  let data = null; // fetched once per visit; the filter runs locally
  listView(view, {
    placeholder: 'Filter audit…',
    load: async () => {
      if (!data) data = await api('GET', G() + '/audit' + qs({ limit: 200 }));
      const names = withChannelList(data.names, meta.channels);
      const q = state.q.toLowerCase();
      // Invite codes of 28+ characters appear here as their first 12 (shorter
      // ones are hidden): a pasted whole code finds its records by that prefix.
      const qCode = q.length >= 28 ? q.slice(0, 12) : null;
      const filtered = (data.records || []).filter((r) => {
        if (!q) return true;
        const hay = (JSON.stringify(r) + ' ' + auditTargetText(r, names)).toLowerCase();
        return hay.includes(q) || (qCode !== null && hay.includes(qCode));
      });
      const rows = filtered.map((r) => el('tr', {}, [
        el('td', { class: 'mono', text: r.ts ? new Date(r.ts).toLocaleString() : '—' }),
        el('td', {}, [(r.actor && r.actor.name) || '?', ' ', el('span', { class: 'muted', text: r.actor ? '(' + r.actor.kind + ')' : '' })]),
        el('td', {}, [el('code', { text: r.action })]),
        el('td', { class: 'cell-roles', title: r.detail ? JSON.stringify(r.detail) : undefined }, auditTarget(r, names)),
        el('td', {}, [el('span', { class: r.ok ? 'badge-ok' : 'badge-no', text: r.ok ? '✓' : '✗', 'aria-label': r.ok ? 'succeeded' : 'failed' })]),
      ]));
      return table([{ label: 'Time' }, { label: 'Actor' }, { label: 'Action' }, { label: 'Target' }, { label: 'OK', cls: 'col-narrow' }], rows,
        q ? 'No record matches “' + state.q + '”.' : 'No audit records for this guild yet.');
    },
  });
}

// ── Shared widgets ───────────────────────────────────────────────────────────

function avatarThumb(url, alt, cls) {
  const img = el('img', { class: 'avatar-thumb' + (cls ? ' ' + cls : ''), alt: alt || '' });
  if (url) img.src = url; else img.classList.add('hidden');
  return img;
}
function setPreview(img, url) {
  if (url) { img.src = url; img.classList.remove('hidden'); } else { img.removeAttribute('src'); img.classList.add('hidden'); }
}

// Upload + square-crop control for a persona avatar. Reads a chosen image, lets
// the admin pan/zoom inside a circular 240px viewport (Discord masks avatars to a
// circle), renders the selected square to a 256×256 canvas, and POSTs the PNG to
// /admin/personas/:id/avatar/upload. On success it updates the preview img, and
// hands the stored URL to handle.onUploaded(saved, sentText) — sentText being what
// the URL field held when the upload went — or, without one, puts it in the field.
// Pure client-side crop — no server image library needed.
// onStage(true|false) reports whether a crop is pending.
function avatarCropper(ctx, avImg, avInput, status, onStage) {
  const { id, displayName } = ctx;
  const fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'hidden', 'aria-label': 'Image file' });
  const pick = el('button', { class: 'btn btn-sm', text: 'Upload image…', onclick: () => fileInput.click() });
  const stage = el('div', {}); // cropper renders here once a file is chosen
  const wrap = el('div', { class: 'avatar-upload' }, [el('div', { class: 'inline' }, [pick, fileInput]), stage]);
  const handle = { node: wrap, onUploaded: null };
  const end = () => {
    clear(stage);
    fileInput.value = '';
    pick.classList.remove('hidden');
    onStage(false);
  };

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) { status.err('Not uploaded: choose an image file (PNG, JPEG, WebP or GIF).'); fileInput.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => buildCropper(img);
      img.onerror = () => { status.err('Not uploaded: that image couldn’t be read. Try another file.'); fileInput.value = ''; };
      img.src = reader.result;
    };
    reader.onerror = () => { status.err('Not uploaded: that file couldn’t be read. Try another file.'); fileInput.value = ''; };
    reader.readAsDataURL(file);
  });

  function buildCropper(img) {
    clear(stage);
    const V = 240, O = 256;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) { status.err('Not uploaded: that image has no size. Try another file.'); fileInput.value = ''; return; }
    onStage(true);
    pick.classList.add('hidden');
    const base = Math.max(V / iw, V / ih); // cover the viewport
    let zoom = 1, scale = base, ox = 0, oy = 0;

    const display = el('img', { class: 'cropper-img', src: img.src, alt: '' });
    const viewport = el('div', { class: 'cropper' }, [display]);
    const zoomInput = el('input', { type: 'range', min: '1', max: '3', step: '0.01', value: '1', class: 'cropper-zoom', 'aria-label': 'Zoom' });

    function apply() {
      const dw = iw * scale, dh = ih * scale;
      ox = Math.min(0, Math.max(V - dw, ox));
      oy = Math.min(0, Math.max(V - dh, oy));
      display.style.width = dw + 'px';
      display.style.height = dh + 'px';
      display.style.left = ox + 'px';
      display.style.top = oy + 'px';
    }
    ox = (V - iw * scale) / 2; oy = (V - ih * scale) / 2; apply();

    zoomInput.addEventListener('input', () => {
      const old = scale;
      zoom = parseFloat(zoomInput.value) || 1;
      scale = base * zoom;
      // Keep the viewport centre fixed across zoom.
      const cx = (-ox + V / 2) / old, cy = (-oy + V / 2) / old;
      ox = V / 2 - cx * scale; oy = V / 2 - cy * scale;
      apply();
    });

    let dragging = false, lx = 0, ly = 0;
    viewport.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; try { viewport.setPointerCapture(e.pointerId); } catch (x) {} });
    viewport.addEventListener('pointermove', (e) => { if (!dragging) return; ox += e.clientX - lx; oy += e.clientY - ly; lx = e.clientX; ly = e.clientY; apply(); });
    const release = (e) => { dragging = false; try { viewport.releasePointerCapture(e.pointerId); } catch (x) {} };
    viewport.addEventListener('pointerup', release);
    viewport.addEventListener('pointercancel', release);

    const up = el('button', { class: 'btn btn-sm btn-primary', text: 'Upload' });
    const cancel = el('button', { class: 'btn btn-sm', text: 'Cancel', onclick: end });
    up.addEventListener('click', () => ui.busy(up, async () => {
      const sentText = avInput.value; // what the URL field held as the upload went
      const canvas = el('canvas');
      canvas.width = O; canvas.height = O;
      const c2d = canvas.getContext('2d');
      c2d.drawImage(img, -ox / scale, -oy / scale, V / scale, V / scale, 0, 0, O, O);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) { status.err('Not uploaded: the cropped image couldn’t be rendered. Try again.'); return; }
      try {
        const data = await api('POST', '/admin/personas/' + encodeURIComponent(id) + '/avatar/upload', blob, { raw: true, contentType: 'image/png' });
        const saved = (data && data.avatar) || '';
        setPreview(avImg, data && data.avatarUrl);
        markStale();
        end();
        if (handle.onUploaded) handle.onUploaded(saved, sentText);
        else avInput.value = saved;
        status.ok('Profile picture uploaded. It shows from ' + displayName + '’s next message.');
      } catch (e) { status.err(notDone(e, 'Not uploaded')); }
    }, 'Uploading…'));

    stage.appendChild(el('div', { class: 'cropper-wrap' }, [
      viewport,
      el('div', { class: 'cropper-controls' }, [
        el('p', { class: 'muted', text: 'Drag to position · zoom' }),
        zoomInput,
        el('div', { class: 'inline' }, [up, cancel]),
      ]),
    ]));
  }

  return handle;
}

// ── Names ─────────────────────────────────────────────────────────────────────
// API responses carry `names` maps — {channels, discordRoles, guilds, personas},
// keyed by id — so the panel shows names and keeps ids in tooltips. Channel
// labels come from the relay, which also names archived threads and deleted
// channels (the guild channel list only holds live ones).

/** Fold the guild's live channel list (and Discord roles) under the server's
 *  name maps; the server's labels win (they carry parent names, flags). */
function withChannelList(names, channels, discordRoles) {
  const out = Object.assign({}, names || {});
  const byId = {};
  for (const c of channels || []) byId[c.id] = c;
  const chans = {};
  for (const c of channels || []) {
    const p = c.parentId ? byId[c.parentId] : null;
    chans[c.id] = { id: c.id, name: c.name || null, type: c.type, parentId: c.parentId, parentName: p ? p.name || null : undefined };
  }
  out.channels = Object.assign(chans, out.channels || {});
  const roles = {};
  for (const r of discordRoles || []) roles[r.id] = { name: r.name, guildId: r.guildId };
  out.discordRoles = Object.assign(roles, out.discordRoles || {});
  return out;
}

/** Channel name as a node: name + small status tags; the id lives in the tooltip
 *  (and is shown only when there is no name to show). */
function chanNode(cid, names) {
  const l = (names && names.channels && names.channels[cid]) || null;
  const kids = [];
  let title = cid;
  if (!l || (!l.name && !l.missing && !l.unavailable)) {
    kids.push(el('code', { text: cid }));
    if (l && l.pending) kids.push(el('span', { class: 'badge', text: 'name loading — reopen' }));
  } else {
    kids.push(el('span', { text: chanText(cid, names) }));
    if (l.missing || l.unavailable) kids.push(el('span', { class: 'muted mono', text: cid }));
    if (l.unavailable) title = cid + ' — deleted, hidden from the bot, or in another guild';
    if (l.archived) kids.push(el('span', { class: 'badge', text: 'archived' }));
  }
  return el('span', { class: 'name-ref', title }, kids);
}

/** A guild's name, as the switcher shows it (its id when it has none). */
function guildName(gid) {
  const g = state.guilds.find((x) => x.id === gid);
  if (g && g.name) return g.name;
  const opt = Array.from($('#guild-select').options).find((o) => o.value === gid);
  return (opt && opt.textContent) || String(gid);
}
/** The selected guild's name. */
function currentGuildName() { return guildName(state.guildId); }

/** Channel picker options: the channels that can hold a grant (text, voice,
 *  forum — never a thread or a category), by name. */
function channelOptions(channels) {
  const names = withChannelList(null, channels);
  return (channels || [])
    .filter((c) => lib.isGrantableType(c.type))
    .map((c) => ({ value: c.id, text: chanText(c.id, names), sort: c.name || c.id }))
    .sort((a, b) => byName(a.sort, b.sort))
    .map(({ value, text }) => ({ value, text }));
}

/** Natural order for names ("thread-3" before "thread-11"). */
function byName(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }

/** Audit "Target" cell: the persona/guild by name, plus the channel acted in. */
function auditTarget(r, names) {
  const kids = [];
  const t = r.target;
  if (t) {
    const persona = names.personas && names.personas[t];
    const nm = persona || (names.guilds && names.guilds[t]);
    // A persona's name links to its drawer in this guild.
    const href = persona && state.guildId ? lib.formatRoute(route('g', state.guildId, 'personas', { kind: 'persona', id: t })) : null;
    kids.push(href ? el('a', { href, text: nm, title: t }) : nm ? el('span', { text: nm, title: t }) : el('span', { text: t }));
  } else if (r.detail) {
    // No target (e.g. a denied slash command): the detail is what says what
    // happened — keep it, minus the channel, which is named below.
    const rest = Object.assign({}, r.detail);
    delete rest.channelId;
    if (Object.keys(rest).length) kids.push(JSON.stringify(rest));
  }
  const cid = auditChannel(r);
  if (cid) kids.push(kids.length ? ' in ' : '', chanNode(cid, names));
  if (!kids.length) kids.push('—');
  return kids;
}
function auditChannel(r) {
  return (r.detail && r.detail.channelId) || (r.after && r.after.channelId) || (r.before && r.before.channelId) || null;
}
function auditTargetText(r, names) {
  const t = r.target ? ((names.personas && names.personas[r.target]) || (names.guilds && names.guilds[r.target]) || '') : '';
  const cid = auditChannel(r);
  return t + (cid ? ' ' + chanText(cid, names) : '');
}

/** A rotated token, shown once. Esc doesn't close it: Done does. Focus then
 *  goes to `returnFocus`. */
function showSecret(token, returnFocus) {
  const pre = el('pre', { class: 'secret', text: token });
  const status = ui.statusLine(null);
  let m = null;
  const copy = el('button', { class: 'btn', text: 'Copy' });
  copy.addEventListener('click', async () => {
    if (await ui.copyText(token, pre)) status.ok('Copied the token to the clipboard.');
    else status.err('Couldn’t copy automatically. The token is selected: copy it with Ctrl+C (⌘C on a Mac).');
  });
  const done = el('button', { class: 'btn btn-primary', text: 'Done', onclick: () => { pre.textContent = ''; m.close(); } });
  m = ui.modal({
    title: 'New token — shown once',
    body: [
      el('p', { class: 'warn' }, ['Copy this now. It will ', el('strong', { text: 'not' }), ' be shown again. Deliver it to the agent out-of-band.']),
      pre,
      status.node,
    ],
    actions: [copy, done],
    initialFocus: copy,
    returnFocus,
  });
}

// ── Go ───────────────────────────────────────────────────────────────────────

window.PA.app = { boot };
window.PA.CLIENT_API = CLIENT_API;
document.addEventListener('DOMContentLoaded', boot);
})();
