/* Portal Admin SPA — vanilla JS, no dependencies, no build step.
 *
 * Resource-first IA: top-level tabs (Personas / Invites / Access roles / Audit,
 * plus Guilds for super-admins) with a persistent guild scope in the header.
 * Dense tables + a right-side detail drawer for editing one row at a time.
 *
 * Pure API client: every authorization decision is server-side. The CSRF token
 * from /admin/me is echoed in X-CSRF-Token on all mutating requests.
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

const state = {
  me: null,        // { user, isSuper, guilds, csrf }
  guildId: null,   // selected guild id (null when no guild is selectable)
  tab: 'personas',
  personaScope: 'guild', // super-admins: 'guild' (access here) or 'all' personas
  q: '',           // current search query for the active list
  offset: 0,       // current page offset for the active list
  cache: {},       // per-guild { roles, channels } caches
  list: null,      // the active list view: { refresh, search, status }
  listStale: false, // a drawer changed something the list shows: refresh on close
  drawerKey: null, // data-key of the list row the open drawer belongs to
  renderSeq: 0,    // bumped by every render(); a slower, older one stops drawing
};

const $ = (sel, root = document) => root.querySelector(sel);

// ── API layer ──────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, code, message) { super(message || code || ('HTTP ' + status)); this.status = status; this.code = code; }
}

/** JSON request to the admin API. opts.raw sends `body` as-is with
 *  opts.contentType (avatar upload). */
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
  catch { throw new ApiError(0, 'NETWORK', 'network error'); }
  if (res.status === 401) { showLogin(); throw new ApiError(401, 'UNAUTHENTICATED', 'login required'); }
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON */ } }
  if (!res.ok) { const e = (data && data.error) || {}; throw new ApiError(res.status, e.code, e.message); }
  return data || {};
}

const G = () => '/admin/g/' + encodeURIComponent(state.guildId);
function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}

const NOT_GUILD_ADMIN = 'You’re not an admin of this guild, or we couldn’t verify your Discord permissions right now.';

/** A failed change, as a status line: 'Not saved: <reason>. <what to do>.' */
function notDone(e, prefix = 'Not saved') {
  if (e && e.code === 'NETWORK') return 'Couldn’t reach the relay. Nothing was changed. Try again.';
  if (e && e.code === 'CSRF') return prefix + ': this page’s security token is out of date. Reload the page and try again.';
  if (e && e.status === 401) return prefix + ': your session ended. Sign in again.';
  const why = String((e && e.message) || 'something went wrong').trim().replace(/[.\s]+$/, '');
  return prefix + ': ' + why + '.';
}

/** A failed read, as a line: 'Couldn’t load <what>: <reason>.' */
function couldntLoad(what, e) {
  if (e && e.code === 'NETWORK') return 'Couldn’t reach the relay to load ' + what + '. Try again.';
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

// Per-guild role catalog + channels, cached (used by editors/pickers).
async function guildMeta() {
  const key = state.guildId;
  if (!state.cache[key]) {
    const [roles, chans] = await Promise.all([api('GET', G() + '/roles'), api('GET', G() + '/channels')]);
    state.cache[key] = {
      catalog: roles.catalog || {}, discordRoles: roles.discordRoles || [],
      canAuthor: !!roles.canAuthor, channels: chans.channels || [],
    };
  }
  return state.cache[key];
}
function invalidateGuildMeta() { delete state.cache[state.guildId]; }

/** Name maps for the selected guild's own pickers: its channels, its Discord
 *  roles and its name. */
function metaNames(meta) {
  const names = withChannelList(null, meta.channels, meta.discordRoles);
  names.guilds = { [state.guildId]: currentGuildName() };
  return names;
}

/** The access roles bound to the selected guild, by name. Pickers and chips
 *  show only these; another guild's roles are not this guild's to hand out. */
function guildRoleNames(meta) {
  const cat = meta.catalog || {};
  return Object.keys(cat).filter((n) => cat[n] && cat[n].guildId === state.guildId).sort(byName);
}

// ── Boot / auth ──────────────────────────────────────────────────────────────

function showLogin(errMsg) {
  $('#app').classList.add('hidden');
  ui.drawer.close();
  $('#login').classList.remove('hidden');
  const e = $('#login-error');
  if (errMsg) { e.textContent = errMsg; e.classList.remove('hidden'); } else e.classList.add('hidden');
}

// Why a sign-in ended back here (the server redirects with a fixed code; the
// message comes from this table — nothing from the URL is shown).
const LOGIN_ERRORS = {
  not_admin: 'This Discord account doesn’t administer any server portal serves. If it should, ask a portal operator to add the server.',
  failed: 'Sign-in didn’t complete — it may have expired, or been opened twice. Please try again.',
  discord: 'Discord sign-in failed. Please try again.',
};

async function boot() {
  const params = new URLSearchParams(location.search);
  const code = params.get('login_error');
  const loginError = code && Object.prototype.hasOwnProperty.call(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code] : null;
  if (params.has('login_error')) {
    params.delete('login_error');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  }
  let me;
  try { me = await api('GET', '/admin/me'); }
  catch (e) {
    if (e.status === 401) { if (loginError) showLogin(loginError); return; }
    return showLogin('Couldn’t reach the admin API: ' + e.message + '. Reload to try again.');
  }
  state.me = me;
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');

  $('#user-name').textContent = (me.user && me.user.name) || 'admin';
  $('#super-badge').classList.toggle('hidden', !me.isSuper);
  // Super-admin-only tabs (Guilds).
  for (const t of document.querySelectorAll('.tab-super')) t.classList.toggle('hidden', !me.isSuper);

  // Scope the switcher to guilds the bot is actually in (named) — not every
  // guild the admin owns on Discord — so it lands where data exists.
  let guilds = [];
  try { guilds = (await api('GET', '/admin/guilds')).guilds || []; }
  catch { guilds = me.guilds || []; }
  setupScope(me, guilds);

  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => selectTab(t.dataset.tab));
  $('#logout-btn').addEventListener('click', logout);
  // Esc, Tab and the scrim inside the drawer and dialogs are ui.js's.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || ui.drawer.isOpen() || ui.modalOpen()) return;
    const a = document.activeElement;
    if (a && (/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) || a.isContentEditable)) return;
    const s = $('#list-search');
    if (s) { e.preventDefault(); s.focus(); }
  });

  selectTab('personas');
}

function setupScope(me, guilds) {
  guilds = guilds || me.guilds || [];
  const sel = $('#guild-select');
  const stat = $('#guild-static');
  clear(sel);

  if (guilds.length === 1 && !me.isSuper) {
    // Single-guild delegate: scope is fixed; show it as a static label.
    state.guildId = guilds[0].id;
    stat.textContent = guilds[0].name || guilds[0].id;
    stat.classList.remove('hidden');
    sel.classList.add('hidden');
    return;
  }
  stat.classList.add('hidden');
  sel.classList.remove('hidden');
  if (!guilds.length && !me.isSuper) sel.appendChild(el('option', { value: '', text: 'no manageable guilds' }));
  for (const g of guilds) sel.appendChild(el('option', { value: g.id, text: g.name || g.id }));
  if (me.isSuper) sel.appendChild(el('option', { value: '__custom__', text: 'other guild id…' }));
  // Preserve the current selection across repopulation (e.g. allow-list edits).
  state.guildId = guilds.some((g) => g.id === state.guildId)
    ? state.guildId
    : guilds.length ? guilds[0].id : null;
  sel.value = state.guildId || (me.isSuper ? '__custom__' : '');
  if (!setupScope._bound) {
    setupScope._bound = true;
    sel.addEventListener('change', (e) => {
      let v = e.target.value;
      if (v === '__custom__') {
        v = (prompt('Enter the Discord guild id to manage:') || '').trim();
        if (!v) { e.target.value = state.guildId || ''; return; }
        // Keep a synthetic option so the chosen id stays selected.
        if (!Array.from(sel.options).some((o) => o.value === v)) {
          sel.insertBefore(el('option', { value: v, text: v }), sel.lastChild);
        }
        sel.value = v;
      }
      state.guildId = v;
      state.offset = 0; // the search query carries over to the new guild
      // Drawers were built for the previous guild (its pickers, its ids) and
      // submit against the current one — close them rather than let a form
      // opened in one guild write into another.
      ui.drawer.close();
      render();
    });
  }
}

/** Re-fetch the manageable-guild list and rebuild the scope switcher (used
 *  after allow-list edits so new guilds appear without a re-login). */
async function refreshScope() {
  let guilds = [];
  try { guilds = (await api('GET', '/admin/guilds')).guilds || []; }
  catch { guilds = (state.me && state.me.guilds) || []; }
  setupScope(state.me, guilds);
}

async function logout() {
  try { await api('POST', '/admin/logout'); } catch { /* ignore */ }
  state.me = null;
  showLogin();
}

function selectTab(tab) {
  state.tab = tab;
  state.q = ''; state.offset = 0;
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('active', t.dataset.tab === tab);
    if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
  ui.drawer.close();
  render();
}

// ── Drawer glue ───────────────────────────────────────────────────────────────

/** Open the drawer (ui.drawer) for a list row: `key` is the row's data-key,
 *  so focus can find the row again if the list is redrawn on close. */
function openDrawer(opts) {
  state.drawerKey = opts.key || null;
  return ui.drawer.open(Object.assign({}, opts, { onClose: onDrawerClosed }));
}

/** A drawer changed something its list shows. */
function markStale() { state.listStale = true; }

function onDrawerClosed() {
  const key = state.drawerKey;
  state.drawerKey = null;
  if (!state.listStale || !state.list) return;
  state.listStale = false;
  state.list.refresh().then(() => {
    const a = document.activeElement;
    if (!key || (a && a !== document.body && a.isConnected)) return;
    const row = Array.from(document.querySelectorAll('[data-key]')).find((n) => n.dataset.key === key);
    if (row) row.focus();
  });
}

// ── Render dispatch ──────────────────────────────────────────────────────────

const GUILD_TABS = new Set(['personas', 'invites', 'roles', 'audit']);

async function render() {
  const view = $('#view');
  state.list = null;
  // Super-admins reach the global persona list (profile, token) without a
  // guild — e.g. before the relay has joined any.
  const globalPersonas = state.tab === 'personas' && state.me && state.me.isSuper;
  if (GUILD_TABS.has(state.tab) && !state.guildId && !globalPersonas) {
    clear(view);
    view.appendChild(el('div', { class: 'empty' }, [
      el('p', { text: 'Select a guild to manage.' }),
      state.me.isSuper ? el('p', { class: 'muted', text: 'As a super-admin you can pick “other guild id…”.' }) : null,
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
    if (e.status === 401 || stale()) return;
    clear(view);
    const text = e.status === 403 ? NOT_GUILD_ADMIN : couldntLoad('this tab', e);
    view.appendChild(loadError(text, () => render()));
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
        if (mine !== seq || e.status === 401) return;
        clear(results);
        results.appendChild(loadError(couldntLoad('this list', e), () => list.refresh()));
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
    if (id) openPersonaDrawer(id, meta);
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

  // The scope switch keeps the toolbar (and the query); only the results change.
  function syncScope() {
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
  if (scope) {
    scope.addEventListener('change', () => {
      state.personaScope = scope.value;
      state.offset = 0;
      syncScope();
      list.refresh();
    });
  }
}

function personaRow(p, meta, all) {
  const name = p.displayName || p.id;
  const open = () => openPersonaDrawer(p.id, meta, { name });
  // In a guild's list, the guild's own access roles; others are only counted.
  let rolesText = (p.roles || []).join(', ') || '—';
  if (!all && meta) {
    const mine = new Set(guildRoleNames(meta));
    const here = (p.roles || []).filter((r) => mine.has(r));
    const elsewhere = (p.roles || []).length - here.length;
    rolesText = (here.join(', ') || '—') + (elsewhere ? ' (+' + elsewhere + ' elsewhere)' : '');
  }
  return openableRow(open, [
    el('td', { class: 'col-narrow' }, [avatarThumb(p.avatarUrl, '')]),
    el('td', {}, [el('button', { class: 'link', 'data-key': 'persona:' + p.id, text: name, onclick: open })]),
    el('td', {}, [el('code', { text: p.id })]),
    el('td', { class: 'cell-roles', text: rolesText }),
    all
      ? el('td', { class: 'col-narrow', text: String(p.guildCount != null ? p.guildCount : '—') })
      : el('td', {}, [p.hasOverride ? el('span', { class: 'badge badge-warn', text: 'direct grants' }) : el('span', { class: 'muted', text: '—' })]),
  ]);
}

async function openPersonaDrawer(id, meta, hint = {}) {
  const isSuper = !!(state.me && state.me.isSuper);
  // Open at once; the sections arrive when the persona has loaded.
  const d = openDrawer({ title: hint.name || id, subtitle: id, key: 'persona:' + id });
  const missing = (e) => { if (e.status === 404) return null; throw e; };
  let local = null;
  let global = null;
  try {
    [local, global] = await Promise.all([
      // What an admin of this guild may see and change…
      state.guildId ? api('GET', G() + '/personas/' + encodeURIComponent(id)).catch(missing) : null,
      // …and, for super-admins, the persona everywhere.
      isSuper ? api('GET', '/admin/personas/' + encodeURIComponent(id)).catch(missing) : null,
    ]);
  } catch (e) {
    if (e.status !== 401) d.setBody(loadError(couldntLoad(hint.name || id, e), () => openPersonaDrawer(id, meta, hint)));
    return;
  }
  if (!d.isCurrent()) return;
  if (!local && !global) {
    d.setBody(el('p', { class: 'empty-note', role: 'status', text: 'No persona with id “' + id + '”.' }));
    return;
  }
  const displayName = (global && global.displayName) || (local && local.displayName) || id;
  d.setTitle(displayName, id);
  const ctx = { id, displayName, drawer: d };
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
  if (state.guildId && meta) {
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
  const cropper = avatarCropper(ctx, avImg, avInput, status, (on) => {
    cropping = on;
    urlButtons.classList.toggle('hidden', on);
  });
  const form = el('form', { class: 'section-form', novalidate: true }, [
    el('div', { class: 'avatar-row' }, [avImg, el('div', { class: 'avatar-edit' }, [
      ui.field({ label: 'Picture URL', control: avInput }),
      urlButtons,
    ])]),
    cropper.node,
    el('p', { class: 'muted', text: 'Paste an image URL above, or upload + crop a file. Discord fetches it on the next message; past messages keep their old picture.' }),
    status.node,
  ]);
  const tracker = ctx.drawer.track(form);
  cropper.onUploaded = () => tracker.reset();

  async function save(value) {
    try {
      const r = await api('PUT', '/admin/personas/' + encodeURIComponent(id) + '/avatar', { avatar: value });
      avInput.value = r.avatar || '';
      setPreview(avImg, r.avatarUrl);
      tracker.reset();
      markStale();
      status.ok(value
        ? 'Profile picture saved. It shows from ' + displayName + '’s next message.'
        : 'Profile picture removed. ' + displayName + '’s next message uses the default picture.');
    } catch (e) { status.err(notDone(e)); }
  }
  ui.onSubmit(form, () => (cropping ? undefined : save(avInput.value.trim())));
  clearAv.addEventListener('click', () => ui.busy(clearAv, () => { avInput.value = ''; return save(''); }, 'Clearing…'));
  return section('Profile picture', [form]);
}

/** Access in the selected guild: its direct grants (open, first), its access
 *  roles, and — folded under More — applying an invite. */
function guildAccessSection(ctx, detail, meta, onChange = () => {}) {
  const { id, displayName } = ctx;
  const P = () => G() + '/personas/' + encodeURIComponent(id);
  const guild = currentGuildName();
  const names = metaNames(meta);
  const catalog = meta.catalog || {};
  const mine = guildRoleNames(meta);
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
  let assigning = false;
  addRole.addEventListener('change', async () => {
    const role = addRole.value;
    if (!role || assigning) return;
    assigning = true;
    addRole.setAttribute('aria-busy', 'true');
    try {
      const r = await api('POST', P() + '/roles', { role });
      drawRoles(r.roles);
      // The last free role was just given: the picker is off, so keep focus
      // on the new chip's ✕ rather than lose it.
      if (addRole.disabled) {
        const xs = roleTags.querySelectorAll('button.x');
        if (xs.length) xs[xs.length - 1].focus();
      }
      roleStatus.ok('Gave ' + displayName + ' access role ' + role + ' (' + meaning(role) + ').');
      markStale(); onChange();
    } catch (e) { roleStatus.err(notDone(e)); }
    finally { assigning = false; addRole.removeAttribute('aria-busy'); addRole.value = ''; }
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
    const code = claimCode.value.trim();
    if (!code) { claimStatus.err('Not applied: enter an invite code first.'); return; }
    try {
      const r = await api('POST', P() + '/claim', { code });
      drawRoles(r.roles);
      claimCode.value = '';
      claimTracker.reset();
      claimStatus.ok('Applied the invite to ' + displayName + '.');
      markStale(); onChange();
    } catch (e) { claimStatus.err(notDone(e, 'Not applied')); }
  }, { busyLabel: 'Applying…' });
  const more = el('details', { class: 'advanced' }, [el('summary', { text: 'More' }), claimForm]);

  return el('section', { class: 'drawer-section' }, [
    el('h3', { text: 'Access in ' + guild }),
    grantEditor(ctx, detail.guildPolicy, meta.channels, withChannelList(detail.names, meta.channels), onChange),
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
  kids.push(el('div', { class: 'field' }, [el('div', { class: 'field-label', text: 'Guilds it can act in' }),
    guilds.length
      ? el('ul', { class: 'plain' }, guilds.map((g) => el('li', {}, [g.name || g.id, el('span', { class: 'muted mono', text: ' ' + g.id })])))
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
  const polGuilds = pol && pol.guilds ? Object.entries(pol.guilds) : [];
  if ((pol && pol.default && pol.default.length) || polGuilds.length) {
    const grantKids = [];
    if (pol.default && pol.default.length) grantKids.push(el('div', { class: 'cell-roles', title: capsTitle(pol.default), text: 'Persona default (applies in every guild): ' + capsSummary(pol.default) }));
    for (const [gid, gp] of polGuilds) {
      const lines = [];
      if (Array.isArray(gp.default)) lines.push(el('div', { class: 'cell-roles', title: gp.default.length ? capsTitle(gp.default) : undefined, text: 'Guild-wide: ' + (gp.default.length ? capsSummary(gp.default) : 'denied') }));
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
 * Direct grants in the selected guild: what is set (one row per channel, plus
 * the guild-wide level), and a form that sets a level on one channel — text,
 * voice or forum; a thread uses its parent's access and a category grants
 * nothing — or guild-wide. Save stays off until a target and a level are
 * picked, so a grant can't be stored empty by accident.
 */
function grantEditor(ctx, policy0, channels, names, onChange = () => {}) {
  const { id, displayName } = ctx;
  const P = () => G() + '/personas/' + encodeURIComponent(id) + '/grants';
  const guild = currentGuildName();
  const GUILD_WIDE = '__guild__';
  const det = el('details', { class: 'advanced grants', open: true }, [el('summary', { text: 'Direct grants' })]);
  const tableBox = el('div', {});
  const status = ui.statusLine(null);
  let policy = policy0 || null;

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

  function draw(p) {
    policy = p || null;
    clear(tableBox);
    const gd = policy ? policy.default : undefined; // undefined: not set here
    const chans = (policy && policy.channels) || {};
    const keys = Object.keys(chans).sort((a, b) => byName(chanText(a, names), chanText(b, names)));
    const rows = [];
    if (Array.isArray(gd)) {
      let deny = null;
      if (gd.length) {
        deny = el('button', { class: 'btn btn-sm btn-danger', text: 'Deny guild-wide', 'aria-label': 'Deny ' + displayName + ' guild-wide in ' + guild });
        deny.addEventListener('click', () => denyGuildWide(deny));
      }
      rows.push(el('tr', {}, [
        el('td', { text: 'Every channel (guild-wide)' }),
        levelCell(gd, 'Denied', 'Denied guild-wide: ' + displayName + '’s persona default doesn’t apply in ' + guild + '. Access roles and direct grants still do.'),
        el('td', { class: 'col-narrow' }, deny ? [deny] : []),
      ]));
    }
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
  }

  async function removeGrant(cid) {
    try {
      const r = await api('DELETE', P() + '?channelId=' + encodeURIComponent(cid));
      draw(r.guildPolicy);
      target.focus(); // the row whose button had focus is gone
      if (target.value === cid) preload();
      status.ok('Removed ' + displayName + '’s direct grant in ' + chanText(cid, names) + '.');
      markStale(); onChange();
    } catch (e) { status.err(notDone(e, 'Not removed')); }
  }

  async function denyGuildWide(button) {
    const go = await ui.confirmDialog({
      title: 'Deny ' + displayName + ' guild-wide in ' + guild + '?',
      body: [
        displayName + '’s guild-wide ' + levelLabel(policy.default) + ' is replaced by a deny. In every channel of ' + guild +
          ' without its own direct grant, ' + displayName + ' then gets nothing from its own settings: the deny also blocks its persona default here.',
        'Access roles and direct grants still apply. To undo it, set a guild-wide level again.',
      ],
      confirmLabel: 'Deny guild-wide',
      danger: true,
    });
    if (!go) return;
    await ui.busy(button, async () => {
      try {
        const r = await api('DELETE', P());
        draw(r.guildPolicy);
        target.focus();
        if (target.value === GUILD_WIDE) preload();
        status.ok(displayName + ' is denied guild-wide in ' + guild + ': its persona default no longer applies here. Access roles and direct grants still do.');
        markStale(); onChange();
      } catch (e) { status.err(notDone(e, 'Not denied')); }
    }, 'Denying…');
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
    const body = { caps };
    if (t !== GUILD_WIDE) body.channelId = t;
    try {
      const r = await api('PUT', P(), body);
      draw(r.guildPolicy);
      tracker.reset();
      status.ok(t === GUILD_WIDE
        ? displayName + ' → ' + capsSummary(caps) + ' guild-wide in ' + guild + ' (every channel without its own grant).'
        : displayName + ' → ' + capsSummary(caps) + ' in ' + chanText(t, names) + '.');
      markStale(); onChange();
    } catch (e) { status.err(notDone(e)); }
  });

  draw(policy0);
  update();
  det.appendChild(tableBox);
  det.appendChild(form);
  return det;
}

// ── Invites (guild-scoped) ─────────────────────────────────────────────────────

async function renderInvites(view, stale) {
  const meta = await guildMeta();
  if (stale()) return;
  const mintBtn = el('button', { class: 'btn btn-sm btn-primary', text: '+ Mint invite' });
  mintBtn.addEventListener('click', () => openMintDrawer(meta));
  const list = listView(view, {
    placeholder: 'Search invites…',
    actions: [mintBtn],
    load: async () => {
      const data = await api('GET', G() + '/invites' + qs({ q: state.q, limit: LIMIT, offset: state.offset }));
      const names = withChannelList(data.names, meta.channels, meta.discordRoles);
      names.guilds = Object.assign({ [state.guildId]: currentGuildName() }, names.guilds);
      const now = Date.now();
      const rows = (data.invites || []).map((inv) => {
        const revoke = el('button', { class: 'btn btn-sm btn-danger', text: 'Revoke', 'aria-label': 'Revoke invite ' + (inv.label || inv.code) });
        revoke.addEventListener('click', () => revokeInvite(inv, revoke, list));
        const grants = lib.grantSummary(inv, names);
        return el('tr', {}, [
          el('td', {}, [el('code', { text: inv.code })]),
          el('td', { text: inv.label || '—' }),
          el('td', { class: 'col-narrow', text: lib.modeText(inv.mode) }),
          el('td', { class: 'col-narrow', text: lib.usedText(inv) }),
          el('td', { class: 'col-narrow', text: expiryCell(inv.expiresAt, now), title: inv.expiresAt ? new Date(inv.expiresAt).toLocaleString() : undefined }),
          el('td', { class: 'cell-roles', text: grants, title: grants + (inv.grant ? '. ' + capsTitle(inv.grant.caps) : '') }),
          el('td', {}, [revoke]),
        ]);
      });
      return el('div', {}, [
        table([
          { label: 'Code' }, { label: 'Label' }, { label: 'Who can use it', cls: 'col-narrow' },
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

/** A 'Show @everyone' toggle for a Discord-role picker, or null when the guild
 *  has no @everyone role to show. */
function everyoneToggle(discordRoles, onToggle) {
  const has = (discordRoles || []).some((r) => !r.pooled && (r.id === state.guildId || r.name === '@everyone'));
  if (!has) return { node: null, on: () => false };
  const box = el('input', { type: 'checkbox', 'data-no-dirty': true });
  box.addEventListener('change', () => onToggle(box.checked));
  return { node: el('label', { class: 'check-inline' }, [box, el('span', { text: 'Show @everyone' })]), on: () => box.checked };
}

/** One Discord role to mirror: a select that starts at 'Pick a Discord role…'. */
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
  return { select, toggle: toggle.node, value: () => select.value, onChange: (fn) => listeners.push(fn) };
}

/** Several Discord roles to mirror: a checkbox list. */
function mirrorRoleList(discordRoles) {
  const list = ui.checkList({ label: 'Discord roles', empty: 'This guild has no Discord roles to mirror.', options: discordRoleChoices(discordRoles, false) });
  const toggle = everyoneToggle(discordRoles, (on) => list.setOptions(discordRoleChoices(discordRoles, on)));
  return { list, toggle: toggle.node };
}

function openMintDrawer(meta) {
  const d = openDrawer({ title: 'Mint invite' });
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
  const tracker = d.track(form);

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
      const r = await api('POST', G() + '/invites', body);
      tracker.reset();
      markStale();
      status.clear();
      ui.toast('Invite minted.');
      showResult(r.code || '', r.invite || Object.assign({ guildId: state.guildId }, body));
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
    const done = el('button', { class: 'btn', text: 'Done', onclick: () => ui.drawer.close() });
    d.setBody(el('section', { class: 'result-card', 'aria-labelledby': headId }, [
      el('h3', { id: headId, text: 'Invite ready' }),
      el('p', { class: 'invite-code-wrap' }, [codeEl]),
      el('p', { class: 'invite-summary', text: lib.inviteSummary(inv, names, Date.now()) }),
      el('p', { class: 'muted', text: 'Hand this code to the enrolling agent.' }),
      el('div', { class: 'inline' }, [copy, another, done]),
      cardStatus.node,
    ]));
    copy.focus();
  }

  d.setBody(form);
}

async function revokeInvite(inv, button, list) {
  const name = inv.label ? '“' + inv.label + '”' : inv.code;
  const go = await ui.confirmDialog({
    title: 'Revoke invite ' + name + '?',
    body: 'Agents can no longer enroll or claim with it. Access already granted stays.',
    confirmLabel: 'Revoke', danger: true,
  });
  if (!go) return;
  await ui.busy(button, async () => {
    try {
      await api('DELETE', G() + '/invites/' + encodeURIComponent(inv.code));
      list.status.ok('Revoked invite ' + name + '. Agents can no longer use it.');
      list.refresh();
    } catch (e) { list.status.err(notDone(e, 'Not revoked')); }
  }, 'Revoking…');
}

// ── Roles (guild-scoped read, super-admin authoring) ────────────────────────────

async function renderRoles(view, stale) {
  const meta = await guildMeta();
  if (stale()) return;
  let data = null; // fetched once per visit; the filter runs locally
  const actions = [];
  if (meta.canAuthor) {
    const add = el('button', { class: 'btn btn-sm btn-primary', text: '+ Define access role' });
    add.addEventListener('click', () => openRoleDrawer(meta));
    actions.push(add);
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

function openRoleDrawer(meta) {
  // The guild this drawer was opened for — its pickers list this guild's
  // channels and roles, so the role must be saved to it whatever happens to
  // the scope switcher meanwhile.
  const gid = state.guildId;
  const catalog = meta.catalog || {};
  const names = metaNames(meta);
  const d = openDrawer({ title: 'Define access role' });
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

  /** What is still missing before Create can be pressed, or ''. */
  function missing() {
    if (!name.value.trim()) return 'Name the role';
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

  d.track(form);
  ui.onSubmit(form, async () => {
    if (missing()) return; // Create is off until the form is complete
    const roleName = name.value.trim();
    let scope;
    if (kind.value === 'all') scope = { all: true };
    else if (kind.value === 'mirrorRole') scope = { mirrorRole: mirror.value() };
    else if (kind.value === 'mirrorRoles') scope = { mirrorRoles: mirrors.list.values() };
    else scope = { channels: chanList.values() };
    const role = { caps: level.value(), scope, guildId: gid };
    // The relay replaces a role of the same name: say so before it happens.
    if (catalog[roleName]) {
      const go = await ui.confirmDialog({
        title: 'Replace access role ' + roleName + '?',
        body: 'An access role named ' + roleName + ' already exists (' + lib.roleMeaning(catalog[roleName], names) + '). Creating it again replaces it for every persona that holds it.',
        confirmLabel: 'Replace access role',
        danger: true,
      });
      if (!go) return;
    }
    try {
      await api('POST', '/admin/roles', { name: roleName, role });
      invalidateGuildMeta();
      if (state.list && state.list.invalidate) state.list.invalidate();
      markStale();
      // Through the form's line, so an earlier 'Not created' toast goes too.
      status.ok('Created access role ' + roleName + ': ' + lib.roleMeaning(role, names) + '.');
      ui.drawer.close(); // the list redraws with the new role
    } catch (e) { status.err(notDone(e, 'Not created')); }
  }, { busyLabel: 'Creating…' });
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
      // Invite codes appear here as their first 12 characters: a pasted whole
      // code finds its records by that prefix.
      const qCode = q.length > 12 && q.startsWith('inv_') ? q.slice(0, 12) : null;
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
// /admin/personas/:id/avatar/upload. On success it updates the preview img and URL
// field passed in. Pure client-side crop — no server image library needed.
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
      const canvas = el('canvas');
      canvas.width = O; canvas.height = O;
      const c2d = canvas.getContext('2d');
      c2d.drawImage(img, -ox / scale, -oy / scale, V / scale, V / scale, 0, 0, O, O);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) { status.err('Not uploaded: the cropped image couldn’t be rendered. Try again.'); return; }
      try {
        const data = await api('POST', '/admin/personas/' + encodeURIComponent(id) + '/avatar/upload', blob, { raw: true, contentType: 'image/png' });
        avInput.value = (data && data.avatar) || '';
        setPreview(avImg, data && data.avatarUrl);
        markStale();
        end();
        if (handle.onUploaded) handle.onUploaded();
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

/** The scope switcher's label for the selected guild (its name). */
function currentGuildName() {
  const opt = Array.from($('#guild-select').options).find((o) => o.value === state.guildId);
  return (opt && opt.textContent) || $('#guild-static').textContent || state.guildId;
}

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
    const nm = (names.personas && names.personas[t]) || (names.guilds && names.guilds[t]);
    kids.push(nm ? el('span', { text: nm, title: t }) : el('span', { text: t }));
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
document.addEventListener('DOMContentLoaded', boot);
})();
