/* Portal Admin — the Channels tab and the channel drawer (window.PA.channels).
 *
 * The panel's first tab: who can act in each channel of the guild, at what
 * level, and why — slash /list and /caps for every channel at once — and, in
 * a channel's drawer, adding personas and changing their direct grants in
 * place, with a 10 s Undo.
 *
 * Everything shown about access is the relay's own: the list reads GET
 * …/channels and …/access/summary, the drawer …/channels/:cid/access, and
 * every change answers with what the persona can do there now (its
 * `effective`), which replaces the row and moves the list's counts. Nothing
 * here works out access by itself; PA.lib.changeKind only decides whether to
 * ask before a change that would lower guild-wide or default access.
 *
 * Like every panel script, one IIFE that assigns a single global,
 * PA.channels. app.js hands over the helpers it shares (the API client,
 * addresses, the drawer glue) with attach(env) when it boots.
 */
(function () {
'use strict';

const PA = (window.PA = window.PA || {});

/** app.js's helpers (see attach). */
let env = null;

/** On window focus, a list older than this is asked for again. */
const REFETCH_AFTER_MS = 60_000;
/** How long the Undo of a change stays up. */
const UNDO_MS = 10_000;
/** A write the relay paused (429) is tried again after this, at most 3 times. */
const RETRY_MS = 3_000;
const MAX_RETRIES = 3;
/** Personas one Add can take. */
const MAX_ADD = 10;

const el = (tag, attrs, children) => PA.ui.el(tag, attrs, children);
const clear = (n) => PA.ui.clear(n);
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// ── Data: per guild, its channels and the access summary ──────────────────
// Cached per guild (the list and a drawer opened from it share it), asked
// for again once older than a minute (on window focus, or when the list is
// drawn again), and patched from the answers to changes, so the list follows
// a change without a round trip.

const cache = {};    // gid → { chans, summary, at, seen } — at 0: ask again
const inflight = {}; // gid → the request in flight
let generation = 0;  // forget() bumps it: an answer asked for before is not kept
/** gid → how many changes a channel drawer made there. An answer asked for
 *  before the latest one (`seen` less than this) has the Personas tab's
 *  per-persona counts from before it: the drawer patches only the channel's
 *  counts in place (patchSummary), so those are asked for again. */
const changes = {};

function load(gid, force) {
  const have = cache[gid];
  if (!force && have && have.at && Date.now() - have.at <= REFETCH_AFTER_MS) return Promise.resolve(have);
  const seen = changes[gid] || 0;
  // A request sent before the latest change answers from before it.
  if (inflight[gid] && inflight[gid].seen === seen) return inflight[gid];
  const g = env.gpath(gid);
  const gen = generation;
  const p = Promise.all([
    env.api('GET', g + '/channels'),
    // Without counts the list still lists: the summary failing (an older
    // relay, a hiccup) leaves them out, and says so.
    env.api('GET', g + '/access/summary').catch((e) => {
      if (e.status === 401 || e.handled) throw e;
      return null;
    }),
  ]).then(([chans, summary]) => {
    const v = { chans: chans || {}, summary, at: Date.now(), seen };
    // Not over an answer asked for after it, nor one forgotten meanwhile.
    if (gen === generation && !(cache[gid] && (cache[gid].seen || 0) > seen)) cache[gid] = v;
    else v.at = 0; // shown once, asked again next time
    return v;
  });
  p.seen = seen;
  inflight[gid] = p;
  const done = () => { if (inflight[gid] === p) delete inflight[gid]; };
  p.then(done, done);
  return p;
}

/** A drawer read (or changed) who can act in a channel: the list's counts
 *  for it become what those rows add up to — the same count the summary
 *  makes. Resolves whether they changed. A change that ended a /ban changed
 *  the persona in every channel of the guild (`everywhere`): the list asks
 *  again next time. */
function patchSummary(gid, cid, rows, everywhere) {
  const c = cache[gid];
  if (!c) return false;
  if (everywhere) {
    c.at = 0;
    return true;
  }
  const s = c.summary && !c.summary.truncated && Array.isArray(c.summary.channels) ? c.summary.channels.find((x) => x.id === cid) : null;
  if (!s || !s.counts) return false;
  const next = PA.lib.countsFromRows(rows);
  const same = ['read', 'write', 'full', 'custom'].every((k) => (s.counts[k] || 0) === next[k]);
  s.counts = next;
  return !same;
}

/** A channel drawer changed who can act in a channel of `gid`: the
 *  Personas tab's counts are asked for again when it is next drawn. */
function noteChange(gid) {
  changes[gid] = (changes[gid] || 0) + 1;
}

/** What the list knows of a channel (its name, for a drawer's first title). */
function knownChannel(gid, cid) {
  const c = cache[gid];
  const all = (c && c.chans && c.chans.channels) || [];
  return all.find((x) => x.id === cid) || null;
}

// ── Writes: one at a time, each with what it expects to replace ───────────

let tail = Promise.resolve();

/** Run `task` after every write queued before it. A relay that says "slow
 *  down" (429) is asked again after a few seconds, up to three times;
 *  `onPause` says so meanwhile. */
function enqueue(task, onPause) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await task();
      } catch (e) {
        if (e && (e.status === 429 || e.code === 'RATE_LIMITED') && attempt < MAX_RETRIES) {
          if (onPause) onPause();
          await new Promise((r) => setTimeout(r, RETRY_MS));
          continue;
        }
        throw e;
      }
    }
  };
  const p = tail.then(run, run);
  tail = p.catch(() => {});
  return p;
}

/** Set a persona's direct grant in a channel to `next` (caps; [] blocks;
 *  null removes it), through the hardened grant route: a preset by name, a
 *  block as {deny}, anything else as caps — with `expect`, what this page
 *  last saw there, so a change made meanwhile is refused (409), not
 *  overwritten. `opts.lift`: the admin was asked and chose to lift the
 *  persona's removal from the guild ({liftBan: true}); without it the relay
 *  refuses a grant to a removed persona (409 BANNED), so an Undo or a change
 *  queued before a removal can never lift it. */
function writeGrant(gid, pid, cid, next, expect, opts) {
  const P = env.gpath(gid) + '/personas/' + encodeURIComponent(pid) + '/grants';
  if (next == null) return env.api('DELETE', P + '?channelId=' + encodeURIComponent(cid), { expect });
  // A relay older than the panel's grant API reads a grant without caps as
  // a deny: it is sent the caps alone (a block as none).
  if (env.grantApi && !env.grantApi()) return env.api('PUT', P, { channelId: cid, caps: next.slice() });
  const body = { channelId: cid };
  const v = PA.lib.directValue(next);
  if (v === 'block') body.deny = true;
  else if (v === 'custom') body.caps = next.slice();
  else body.level = v;
  body.expect = expect;
  if (opts && opts.lift && next.length) body.liftBan = true;
  return env.api('PUT', P, body);
}

/**
 * The Undo toasts of one drawer, so that a newer change to the same persona
 * in the same channel retires the older one's Undo (it would put back what
 * was there before the admin's own newer change, and be refused as changed
 * meanwhile) and so that a removal from the guild can retire them all.
 * add(list, line) → the entry ({ list, line, toast, retired }) whose list
 * the Undo runs (set entry.toast to the toast that carries it). Each item
 * has a `key`: the persona in a channel drawer, the channel in a persona's.
 */
function undoBook() {
  const entries = [];
  return {
    add(list, line) {
      const entry = { list: list.slice(), line, toast: null, retired: false };
      const keys = new Set(list.map((u) => u.key));
      for (const old of entries) {
        if (old.retired) continue;
        old.list = old.list.filter((u) => !keys.has(u.key));
        if (!old.list.length) retire(old);
      }
      entries.push(entry);
      if (entries.length > 50) entries.shift();
      return entry;
    },
    /** Every Undo of this drawer (for `pid`, when given) stops applying. */
    retireAll(pid) {
      for (const e of entries) {
        if (e.retired) continue;
        if (pid !== undefined) e.list = e.list.filter((u) => u.pid !== pid);
        if (pid === undefined || !e.list.length) retire(e);
      }
    },
  };
  function retire(e) {
    e.retired = true;
    if (e.toast) e.toast.dismiss();
  }
}

// ── The Channels tab ───────────────────────────────────────────────────────

/** Collapsed groups, per admin and guild (localStorage; a convenience):
 *  the keys whose state differs from the default — a category ('cat:<id>')
 *  folded, or the 'hidden' group (folded by default) unfolded. */
function collapseStore(gid) {
  const key = 'pa.collapsed:' + env.userId() + ':' + gid;
  let set;
  try {
    const v = JSON.parse(env.local.get(key) || '[]');
    set = new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 500) : []);
  } catch {
    set = new Set();
  }
  return {
    isOpen: (k) => (k === 'hidden' ? set.has(k) : !set.has(k)),
    remember(k, open) {
      if (open === (k !== 'hidden')) set.delete(k);
      else set.add(k);
      env.local.set(key, JSON.stringify([...set]));
    },
  };
}

/** 'Personas who can act here, where they can see it: 1 at Write, 2 at Read.' */
function countsTitle(c) {
  const parts = ['write', 'read', 'full', 'custom'].filter((k) => c[k]).map((k) => c[k] + ' at ' + PA.lib.LEVEL_NAME[k]);
  return parts.length ? 'Personas who can act here, where they can see it: ' + parts.join(', ') + '.' : 'Nobody can act here.';
}

/**
 * The Channels tab: a toolbar built once (filter, chips, 'updated … ago')
 * and the rows, which are all that a filter, a chip or a refetch redraws —
 * so the filter keeps its focus and caret. The address follows the filter
 * and the chips in place (?q= ?show=); ?cat= unfolds one category only.
 */
async function render(view, stale) {
  const lib = PA.lib;
  const ui = PA.ui;
  const gid = env.state.guildId;
  const q0 = (env.state.route && env.state.route.query) || {};
  const f = { q: q0.q || '', show: q0.show || 'all', cat: q0.cat || null };
  const store = collapseStore(gid);

  clear(view);
  // A relay older than the access views: say so, in place of a list whose
  // counts and drawers it can't answer.
  if (env.accessApi && !env.accessApi()) {
    view.appendChild(env.relayOutdated('who can act in each channel'));
    return;
  }
  const search = el('input', {
    id: 'list-search', class: 'search', type: 'search', placeholder: 'Filter channels…', 'aria-label': 'Filter channels',
    value: f.q, autocomplete: 'off',
  });
  const chips = [['all', 'All'], ['agents', 'With agents'], ['empty', 'Empty']].map(([v, text]) =>
    el('button', { class: 'chip', 'data-show': v, 'aria-pressed': String(f.show === v), text }));
  const chipBox = el('div', { class: 'chips', role: 'group', 'aria-label': 'Which channels to show' }, chips);
  const updated = el('span', { class: 'muted updated' });
  const status = ui.statusLine(null);
  const results = el('div', { class: 'results' });
  view.appendChild(el('div', { class: 'toolbar' }, [search, chipBox, el('div', { class: 'toolbar-actions' }, [updated])]));
  view.appendChild(status.node);
  view.appendChild(results);
  results.appendChild(el('p', { class: 'muted loading', role: 'status', text: 'Loading…' }));

  let data = null;
  let rowNodes = new Map(); // channel id → its <li>, built once per answer
  let seq = 0;
  let urlTimer = null;
  let tickTimer = null;
  let scrolledTo = null; // the ?cat= already scrolled to

  const list = {
    kind: 'channels',
    search,
    status,
    results,
    /** The list's part of the address, as it is now. */
    query() {
      const q = {};
      if (f.q) q.q = f.q;
      if (f.show && f.show !== 'all') q.show = f.show;
      if (f.cat) q.cat = f.cat;
      return q;
    },
    /** The address changed under the list (Back, an edited address). */
    onQuery(q) {
      const next = { q: q.q || '', show: q.show || 'all', cat: q.cat || null };
      if (next.q === f.q && next.show === f.show && next.cat === f.cat) return;
      Object.assign(f, next);
      search.value = f.q;
      scrolledTo = null;
      draw();
    },
    /** Redraw from what is known (a drawer patched it); ask again only when
     *  that is out of date. */
    refresh: () => refresh(false),
    reload: () => refresh(true),
    isOld: () => !!data && (!cache[gid] || !cache[gid].at || Date.now() - data.at > REFETCH_AFTER_MS),
  };
  env.setList(list);

  function syncChips(counted) {
    for (const c of chips) {
      c.setAttribute('aria-pressed', String(c.dataset.show === f.show));
      c.disabled = !counted && c.dataset.show !== 'all';
      if (c.disabled) c.setAttribute('title', 'Counts aren’t available for this guild.');
      else c.removeAttribute('title');
    }
  }

  function tickUpdated() {
    clearTimeout(tickTimer);
    if (env.state.list !== list || !data) return;
    updated.textContent = 'updated ' + lib.agoText(Date.now() - data.at);
    updated.setAttribute('title', new Date(data.at).toLocaleString());
    tickTimer = setTimeout(tickUpdated, 5_000);
  }

  function rowNode(r, inHidden) {
    const hit = rowNodes.get(r.id);
    if (hit) return hit;
    const href = env.formatRoute(env.route('g', gid, 'channels', { kind: 'channel', id: r.id }));
    const badge = lib.channelBadge(r);
    const warn = lib.botListNote(r);
    const badgeTitle = r.type === 'unknown' ? lib.OTHER_KIND_HELP : null;
    const counts = r.counts ? lib.countsText(r.counts) : '';
    const li = el('li', { class: 'chan-item' }, [el('a', { class: 'chan-row', href, 'data-key': 'channel:' + r.id }, [
      el('span', { class: 'chan-name', text: lib.channelTitle(r) }),
      badge ? el('span', { class: 'badge', title: badgeTitle, text: badge }) : null,
      inHidden && r.categoryName ? el('span', { class: 'muted chan-cat', text: 'in ' + r.categoryName }) : null,
      warn ? el('span', { class: 'chan-warn', title: lib.botListTitle(r) }, [
        el('span', { 'aria-hidden': 'true', text: '⚠ ' }), warn,
      ]) : null,
      counts ? el('span', { class: 'chan-counts', title: countsTitle(r.counts), text: counts }) : null,
    ])]);
    rowNodes.set(r.id, li);
    return li;
  }

  function groupNode(key, head, rows, open, inHidden) {
    const listId = ui.uid('chan-group');
    const ul = el('ul', { id: listId, class: 'chan-list' + (open ? '' : ' hidden') }, rows.map((r) => rowNode(r, inHidden)));
    let btn = null;
    if (head) {
      btn = el('button', { class: 'cat-head', 'data-group': key, 'data-key': 'group:' + key, 'aria-expanded': String(open), 'aria-controls': listId }, head);
      btn.addEventListener('click', () => {
        const nowOpen = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', String(nowOpen));
        ul.classList.toggle('hidden', !nowOpen);
        // A filter shows every match: folding then is for the moment only.
        if (!f.q) store.remember(key, nowOpen);
        if (f.cat) {
          f.cat = null;
          env.syncQuery();
        }
      });
    }
    return el('section', { class: 'chan-group' + (head ? '' : ' chan-group-plain'), 'data-group': key }, [btn, ul]);
  }

  function draw() {
    if (!data) return;
    const t0 = now();
    const counted = !!data.summary && !data.summary.truncated;
    syncChips(counted);
    const layout = lib.channelLayout(data.chans, data.summary);
    const shown = lib.filterLayout(layout, f.q, counted ? f.show : 'all');
    // ?cat=: only that category unfolded (its channels the bot can't see,
    // if that is all it has, are in the last group).
    let catKey = null;
    if (f.cat) {
      if (layout.groups.some((g) => g.id === f.cat)) catKey = 'cat:' + f.cat;
      else if (layout.hidden.some((r) => r.categoryId === f.cat)) catKey = 'hidden';
    }
    const isOpen = (k) => (f.q ? true : catKey ? k === catKey : store.isOpen(k));
    const a = document.activeElement;
    const focusKey = a && results.contains(a) && a.dataset ? a.dataset.key || null : null;

    const out = el('div', { class: 'chan-board' });
    if (!layout.count) {
      out.appendChild(el('p', { class: 'empty-note', role: 'status', text: 'No channels cached for this guild yet — the relay sees channels once the bot has joined.' }));
    } else {
      if (data.summary && data.summary.truncated) {
        out.appendChild(el('p', { class: 'muted hint', text: 'Counts unavailable for a guild this size — open a channel to see who can act there.' }));
      } else if (!data.summary) {
        out.appendChild(el('p', { class: 'muted hint', text: 'Counts unavailable right now — open a channel to see who can act there.' }));
      }
      const groups = el('div', { class: 'chan-groups' });
      for (const g of shown.groups) {
        const key = g.id ? 'cat:' + g.id : 'none';
        const all = layout.groups.find((x) => x.id === g.id);
        const n = (all || g).rows.length;
        const head = g.id
          ? [el('span', { class: 'cat-name', text: g.name }), el('span', { class: 'cat-count', text: ' · ' + lib.plural(n, 'channel') })]
          : null;
        groups.appendChild(groupNode(key, head, g.rows, g.id ? isOpen(key) : true, false));
      }
      if (shown.hidden.length) {
        groups.appendChild(groupNode('hidden', [el('span', { text: 'The relay can’t see these (' + shown.hidden.length + ')' })], shown.hidden, isOpen('hidden'), true));
      }
      if (!shown.groups.length && !shown.hidden.length) {
        const why = f.q ? 'No channel matches “' + f.q + '”.'
          : f.show === 'agents' ? 'No channel has a persona that can act in it.' : 'Every channel has a persona that can act in it.';
        out.appendChild(el('p', { class: 'empty-note', role: 'status', text: why }));
      } else out.appendChild(groups);
      out.appendChild(el('p', { class: 'muted hint chan-foot', text: 'Threads use their channel’s access and aren’t listed.' }));
    }
    clear(results);
    results.appendChild(out);
    if (focusKey) {
      const node = Array.from(results.querySelectorAll('[data-key]')).find((n) => n.dataset.key === focusKey);
      if (node) node.focus();
    }
    // ?cat=: bring that category into view, once.
    if (catKey && scrolledTo !== f.cat) {
      scrolledTo = f.cat;
      const sec = Array.from(results.querySelectorAll('section')).find((s) => s.dataset && s.dataset.group === catKey);
      if (sec && typeof sec.scrollIntoView === 'function') sec.scrollIntoView({ block: 'start' });
    }
    if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
      try { performance.measure('pa:channels-draw', { start: t0, end: now() }); } catch { /* not measured */ }
    }
  }

  async function refresh(force) {
    const mine = ++seq;
    results.setAttribute('aria-busy', 'true');
    try {
      const d = await load(gid, force);
      if (mine !== seq || stale() || env.state.list !== list) return;
      // A new answer, or counts a drawer's change patched in place: the rows
      // are built again.
      rowNodes = new Map();
      data = d;
      draw();
      tickUpdated();
    } catch (e) {
      if (mine !== seq || e.handled || env.state.list !== list) return;
      clear(results);
      results.appendChild(e.status === 401 ? env.sessionEndedNote() : env.loadError(env.couldntLoad('this guild’s channels', e), () => refresh(true)));
    } finally {
      if (mine === seq) results.removeAttribute('aria-busy');
    }
  }

  search.addEventListener('input', () => {
    f.q = search.value.trim();
    f.cat = null;
    draw();
    // The address follows in place (Back never steps through keystrokes).
    clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      urlTimer = null;
      if (env.state.list === list) env.syncQuery();
    }, 150);
  });
  for (const c of chips) {
    c.addEventListener('click', () => {
      if (c.disabled || f.show === c.dataset.show) return;
      f.show = c.dataset.show;
      draw();
      env.syncQuery();
    });
  }

  await refresh(false);
}

// ── The channel drawer ─────────────────────────────────────────────────────

/** Open a channel's drawer (#/g/{gid}/channels/c/{cid}). A thread's address
 *  becomes its channel's, saying so; a category's becomes the list with
 *  that category unfolded. */
async function openDrawer(gid, cid) {
  const known = knownChannel(gid, cid);
  const d = env.openDrawer({ title: known && known.type !== 'thread' && known.type !== 'category' ? PA.lib.channelTitle(known) : 'Channel', key: 'channel:' + cid });
  await loadInto(d, gid, cid, null);
}

async function loadInto(d, gid, cid, note) {
  // A relay older than the access views can't say who can act here.
  const outdated = () => d.setBody(env.relayOutdated('who can act in this channel'));
  if (env.accessApi && !env.accessApi()) return outdated();
  let data;
  try {
    data = await env.api('GET', env.gpath(gid) + '/channels/' + encodeURIComponent(cid) + '/access');
  } catch (e) {
    if (!d.isCurrent() || e.handled) return;
    if (e.status === 404) {
      // No such channel — unless the relay was rolled back since this tab asked.
      const old = env.outdatedAfter404 ? await env.outdatedAfter404() : false;
      if (!d.isCurrent()) return;
      if (old) return outdated();
      d.setTitle('Channel');
      d.setBody(el('p', { class: 'empty-note', role: 'status', title: 'Channel id ' + cid, text: 'This is a deleted channel, or a channel the relay can’t see.' }));
      return;
    }
    d.setBody(e.status === 401 ? env.sessionEndedNote() : env.loadError(env.couldntLoad('this channel', e), () => loadInto(d, gid, cid, note)));
    return;
  }
  if (!d.isCurrent()) return;
  if (data.inert === 'thread') {
    if (!data.parentId) {
      d.setTitle(PA.lib.chanText(cid, data.names));
      d.setBody(el('p', { class: 'empty-note', role: 'status', text: 'This is a thread, and the channel it belongs to isn’t known. Threads use their channel’s access.' }));
      return;
    }
    // In place: the address is now the channel's, as if it had been opened.
    env.replaceDrawerRoute(env.route('g', gid, 'channels', { kind: 'channel', id: data.parentId }), 'channel:' + data.parentId);
    d.setTitle(PA.lib.chanText(data.parentId, data.names));
    return loadInto(d, gid, data.parentId, 'Threads use ' + PA.lib.chanText(data.parentId, data.names) + '’s access.');
  }
  if (data.inert === 'category') {
    env.navigate(env.route('g', gid, 'channels', null, { cat: cid }), { replace: true });
    return;
  }
  drawDrawer(d, gid, cid, data, note);
}

function drawDrawer(d, gid, cid, data, note) {
  const lib = PA.lib;
  const ui = PA.ui;
  const ch = data.channel || { id: cid };
  let names = data.names || {};
  let rows = (data.rows || []).slice();
  let botCaps = data.botCaps || [];
  const grantable = ch.grantable !== false;
  const where = lib.chanText(cid, names);
  const guild = env.guildName(gid);
  const rowOf = (pid) => rows.find((r) => r.personaId === pid) || null;
  // Reads of the channel overlap with each other and with changes (only
  // writes are queued). Each read, and each change's answer drawn into a row,
  // takes the next number: a read that answers after a later read was drawn
  // is dropped, and a row put in by a change made after a read was sent
  // stays over that read's older one.
  let seq = 0;
  let drawnRead = 0;
  const putAt = new Map(); // persona id → the number of the change drawn into its row
  /** Where `row` goes in `list`: name order, as the relay sends them. */
  const slotOf = (list, row) => {
    const key = (r) => (r.displayName || r.personaId).toLowerCase();
    const j = list.findIndex((r) => key(r) > key(row) || (key(r) === key(row) && r.personaId > row.personaId));
    return j < 0 ? list.length : j;
  };
  d.setTitle(lib.channelTitle(ch));

  // ── Header: where it is, Discord, the bot's limits ──
  const cat = ch.categoryId && names.channels && names.channels[ch.categoryId] ? names.channels[ch.categoryId].name : null;
  const kind = ch.announcement ? 'announcement' : ch.type === 'unknown' ? 'a kind of channel the panel can’t give access on' : ch.type || 'channel';
  const top = el('div', { class: 'chan-head' }, [
    el('p', { class: 'chan-sub muted' }, [
      el('span', { text: (cat ? 'in ' + cat + ' · ' : '') + kind }),
      el('a', { href: 'https://discord.com/channels/' + gid + '/' + cid, target: '_blank', rel: 'noopener', text: 'Open in Discord' }),
    ]),
  ]);
  const noteLine = ui.statusLine(top);
  if (note) noteLine.info(note);
  if (!grantable) {
    top.appendChild(el('p', { class: 'hint muted', text: 'Access can’t be given on this kind of channel here. What access roles, guild-wide levels and defaults give applies, and a direct grant set in Discord can be removed.' }));
  }
  const banner = el('p', { class: 'banner banner-warn hidden', role: 'note' });
  top.appendChild(banner);
  function syncBanner() {
    const b = lib.botBannerText(botCaps);
    banner.textContent = b || '';
    banner.classList.toggle('hidden', !b);
  }
  syncBanner();

  // ── Who can act here ──
  const whoHead = el('h3');
  const whoStatus = ui.statusLine(null);
  const statusRow = el('tr', { class: 'row-status hidden' }, [el('td', { colspan: '4' }, [whoStatus.node])]);
  const tbody = el('tbody');
  const whoTable = el('div', { class: 'table-wrap' }, [el('table', { class: 'grid cards who-table' }, [
    el('thead', {}, [el('tr', {}, ['Persona', 'Can do here', 'Why', 'Direct grant'].map((h) => el('th', { scope: 'col', text: h })))]),
    tbody,
  ])]);
  const whoEmpty = el('p', { class: 'empty-note hidden', text: 'Nobody can act here yet' + (grantable ? ' — add a persona above.' : '.') });
  const undos = undoBook();
  /** Custom… editors open in rows, not applied (persona id → { caps, start },
   *  the last touched last): drawn open again by every redraw until Apply or
   *  Cancel, and unsaved once ticked away from where they started — so
   *  closing the drawer asks, and Sign in again keeps the last one. One whose
   *  row a read of the channel no longer has is dropped (drawRows): nothing
   *  shows it. */
  const edits = new Map();
  const editTouched = [];
  const ctrlOf = new Map(); // persona id → its row's control as drawn now
  const editChanged = (e) => !!e && !lib.sameCapSet(e.caps, e.start);
  /** The open edits on rows the drawer has now, as [persona id, edit]. */
  const liveEdits = () => Array.from(edits.entries()).filter(([pid]) => !!rowOf(pid));
  const editsDirty = () => liveEdits().some(([, e]) => editChanged(e));
  d.trackDirty(editsDirty);
  /** After a conflict: an open Custom… edit in this row now starts over the
   *  grant as the relay has it (its ticks kept), and the rows are drawn again. */
  function rebaseEdit(pid) {
    const e = edits.get(pid);
    if (!e) return;
    const row = rowOf(pid);
    edits.set(pid, Object.assign({}, e, { base: row && row.direct != null ? row.direct.slice() : null }));
    drawRows();
  }
  function noteEdit(pid, e) {
    edits.delete(pid); // re-set: the last touched is last
    if (e) edits.set(pid, e);
    for (const fn of editTouched) fn();
  }

  /** A result about one persona, on the line under its row (where the
   *  change was made); at the top of the table when it has none. */
  function report(kind, msg, opts, pid) {
    const tr = pid ? Array.from(tbody.children).find((n) => n.dataset && n.dataset.pid === pid) : null;
    const after = tr ? tr.nextSibling : tbody.firstChild;
    if (after !== statusRow) tbody.insertBefore(statusRow, after);
    statusRow.classList.remove('hidden');
    return whoStatus[kind](msg, opts);
  }
  const paused = (pid) => () => report('info', 'Paused for a few seconds (rate limit).', null, pid);

  function rowTr(row) {
    const name = row.displayName || row.personaId;
    const href = env.formatRoute(env.route('g', gid, 'personas', { kind: 'persona', id: row.personaId }));
    const eff = Array.isArray(row.effective) ? row.effective : [];
    const blocked = Array.isArray(row.direct) && !row.direct.length;
    const chips = lib.sourceChips(row, names, { isSuper: env.isSuper(), guild });
    // A channel the panel can't give access on: a direct grant stored there
    // (slash /add run in its chat) can still be removed.
    const pid = row.personaId;
    const control = grantable || row.direct !== null ? ui.directGrantControl({
      value: row.direct,
      canBlock: lib.canBlock(row),
      label: 'Direct grant for ' + name + ' in ' + where,
      key: 'dg:' + pid,
      apply: (next, meta) => change(pid, next, meta),
      removeOnly: !grantable,
      editing: grantable ? edits.get(pid) || null : null,
      // Only the row's control as drawn now speaks for it.
      onEditing: (e) => { if (ctrlOf.get(pid) === control) noteEdit(pid, e); },
    }) : null;
    if (control) ctrlOf.set(pid, control);
    else ctrlOf.delete(pid);
    return el('tr', { 'data-pid': row.personaId, class: eff.length ? null : 'who-none' }, [
      el('td', { 'data-label': 'Persona' }, [el('span', { class: 'who-name' }, [
        env.avatarThumb(row.avatarUrl, ''),
        href ? el('a', { class: 'link', href, title: row.personaId, text: name }) : el('span', { title: row.personaId, text: name }),
      ])]),
      el('td', { 'data-label': 'Can do here' }, [el('span', { class: 'who-can' }, [
        ui.levelPill(row, where),
        blocked ? el('span', { class: 'badge badge-warn', title: 'Blocks guild-wide and persona-default access in this channel. Roles still apply.', text: 'Blocked here' }) : null,
      ])]),
      el('td', { 'data-label': 'Why' }, [chips.length
        ? el('span', { class: 'src-chips' }, chips.map((c) => el('span', { class: 'src-chip src-' + c.kind, title: c.title, text: c.text })))
        : el('span', { class: 'muted', text: '—' })]),
      el('td', { 'data-label': 'Direct grant' }, [control ? control.node : el('span', { class: 'muted', text: row.direct ? lib.levelLabel(row.direct) : '—' })]),
    ]);
  }

  function drawRows() {
    const keep = statusRow.classList.contains('hidden') ? null : statusRow.previousSibling && statusRow.previousSibling.dataset ? statusRow.previousSibling.dataset.pid : null;
    // Focus on a row's control (its select, a box of its open Custom…) comes
    // back to the same one drawn again.
    const a = document.activeElement;
    const focusKey = a && tbody.contains(a) && a.dataset ? a.dataset.key || null : null;
    // A Custom… edit whose row this read no longer has goes with it: nothing
    // is left unsaved that the drawer doesn't show.
    const here = new Set(rows.map((r) => r.personaId));
    for (const pid of Array.from(edits.keys())) if (!here.has(pid)) edits.delete(pid);
    for (const pid of Array.from(ctrlOf.keys())) if (!here.has(pid)) ctrlOf.delete(pid);
    clear(tbody);
    for (const r of rows) tbody.appendChild(rowTr(r));
    if (focusKey) {
      const hit = Array.from(tbody.querySelectorAll('[data-key]')).find((x) => x.dataset.key === focusKey);
      if (hit) hit.focus();
    }
    const n = rows.filter((r) => Array.isArray(r.effective) && r.effective.length).length;
    whoHead.textContent = 'Who can act here (' + n + ')';
    whoTable.classList.toggle('hidden', !rows.length);
    whoEmpty.classList.toggle('hidden', rows.length > 0);
    const at = keep ? Array.from(tbody.children).find((x) => x.dataset.pid === keep) : null;
    if (!statusRow.classList.contains('hidden')) tbody.insertBefore(statusRow, at ? at.nextSibling : tbody.firstChild);
  }

  /** Take the names a change's answer brings (the Discord roles its
   *  explanation mirrors): a source this drawer's first read didn't name is
   *  shown by name, never as an id. */
  function learnNames(r) {
    const n = r && r.names;
    if (!n || typeof n !== 'object') return;
    names = Object.assign({}, names, {
      channels: Object.assign({}, names.channels, n.channels),
      discordRoles: Object.assign({}, names.discordRoles, n.discordRoles),
    });
  }

  /** A persona's row from a change's answer (the relay's explanation of the
   *  channel for it), or null when the answer has none. */
  function rowFrom(pid, base, ex) {
    if (!ex || !Array.isArray(ex.effective)) return null;
    return {
      personaId: pid, displayName: (base && base.displayName) || pid, avatarUrl: base ? base.avatarUrl : undefined,
      effective: ex.effective, level: ex.level, base: ex.base, extra: ex.extra, direct: ex.direct === undefined ? null : ex.direct,
      sources: ex.sources || [], botLimited: !!ex.botLimited, botLacks: ex.botLacks || [],
    };
  }

  /** Put a row in (in name order, as the relay sends them), or replace it.
   *  `refocus`: the change came from the row's own control, whose focus
   *  went when it was turned off — the new row's control gets it. */
  function put(row, refocus) {
    if (!row) return;
    putAt.set(row.personaId, ++seq);
    const i = rows.findIndex((r) => r.personaId === row.personaId);
    const oldTr = Array.from(tbody.children).find((n) => n.dataset && n.dataset.pid === row.personaId) || null;
    const tr = rowTr(row);
    if (i >= 0) rows[i] = row;
    else rows.splice(slotOf(rows, row), 0, row);
    const a = document.activeElement;
    const lost = !a || a === document.body || !a.isConnected || (oldTr && oldTr.contains(a));
    if (oldTr) replaceNode(tbody, tr, oldTr);
    else {
      const next = rows[rows.indexOf(row) + 1];
      const nextTr = next ? Array.from(tbody.children).find((n) => n.dataset && n.dataset.pid === next.personaId) : null;
      tbody.insertBefore(tr, nextTr || null);
    }
    const n = rows.filter((r) => Array.isArray(r.effective) && r.effective.length).length;
    whoHead.textContent = 'Who can act here (' + n + ')';
    whoTable.classList.remove('hidden');
    whoEmpty.classList.add('hidden');
    if (refocus && lost) {
      const sel = tr.querySelector('select');
      if (sel) sel.focus();
    }
    syncCurrently();
  }

  /** Read the channel again (after "someone else changed this"): the rows,
   *  the bot's limits, the names. Resolves whether it could (true too when
   *  a read sent after it is drawn already, and this older answer dropped). */
  async function reloadRows(pid) {
    const mine = ++seq;
    try {
      const fresh = await env.api('GET', env.gpath(gid) + '/channels/' + encodeURIComponent(cid) + '/access');
      if (!d.isCurrent() || fresh.inert) return false;
      if (mine < drawnRead) return true;
      drawnRead = mine;
      // A row a change put in after this read was sent is newer than the read's.
      const next = (fresh.rows || []).slice();
      for (const r of rows) {
        if ((putAt.get(r.personaId) || 0) < mine) continue;
        const i = next.findIndex((x) => x.personaId === r.personaId);
        if (i >= 0) next[i] = r;
        else next.splice(slotOf(next, r), 0, r);
      }
      rows = next;
      botCaps = fresh.botCaps || [];
      learnNames(fresh);
      if (patchSummary(gid, cid, rows, false)) env.markStale();
      const a = document.activeElement;
      const lost = !a || a === document.body || !a.isConnected;
      drawRows();
      syncBanner();
      syncCurrently();
      if (pid && lost) {
        const tr = Array.from(tbody.children).find((n) => n.dataset && n.dataset.pid === pid);
        const sel = tr && tr.querySelector('select');
        if (sel) sel.focus();
        else {
          whoHead.setAttribute('tabindex', '-1');
          whoHead.focus();
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /** What a change did, in the copy guide's words, from the relay's answer
   *  (lib.grantResultText, which the persona drawer says it with too).
   *  `liftedBan`: the change ended the persona's removal from the guild. */
  function resultText(name, next, before, ex, liftedBan) {
    return lib.grantResultText({ name, next, before, ex, where, liftedFrom: liftedBan ? guild : null });
  }

  /** Send one change and take the relay's answer for the row. Resolves
   *  { ok, text, undo } — undo: what restores it ({ key, pid, prev, next,
   *  lifted }), or null where nothing could put it back (a channel the panel
   *  can't give access on). `base`: what is known of a persona without a row
   *  here (the Add pick: name, picture, whether the directory said it was
   *  removed from the guild). `refocus`: the change came from the row's own
   *  control. `lift`: the admin was asked, and chose to lift its removal
   *  from the guild. */
  async function send(pid, name, next, base, refocus, lift, meta) {
    const row = rowOf(pid);
    // `meta.expect`: a Custom… edit's own starting grant (see directGrantControl).
    const expect = meta && Object.prototype.hasOwnProperty.call(meta, 'expect') ? meta.expect : row ? row.direct : null;
    const before = row ? row.effective : [];
    const wasRemoved = lib.isRemoved(row) || !!(base && base.removed);
    try {
      const r = await enqueue(() => writeGrant(gid, pid, cid, next, expect, { lift }), paused(pid));
      learnNames(r);
      // Saved from the row's own control: a Custom… edit it applied is done
      // (the row is drawn again with it closed).
      if (refocus) edits.delete(pid);
      const ex = r && r.effective;
      const fresh = rowFrom(pid, row || base, ex);
      if (fresh) put(fresh, refocus);
      else await reloadRows(refocus ? pid : null);
      // The relay says when a grant ended a /ban (an older one doesn't: then
      // a row that was removed and isn't any more says it).
      const lifted = !!(r && r.liftedBan) || (wasRemoved && !!fresh && !lib.isRemoved(fresh));
      // Lifted, the persona changed in every channel of the guild: the list asks again.
      patchSummary(gid, cid, rows, lifted);
      noteChange(gid);
      env.markStale();
      const undo = grantable ? { key: pid, pid, name, prev: expect, next: next == null ? null : next.slice(), lifted } : null;
      return { ok: true, text: resultText(name, next, before, ex, lifted), undo };
    } catch (e) {
      if (e && e.code === 'BANNED') noteChange(gid);
      return { ok: false, error: e };
    }
  }

  /** The list behind follows a change made after this drawer closed (an Undo). */
  function afterClose() {
    if (d.isCurrent()) return;
    const l = env.state.list;
    if (l && l.kind === 'channels') l.refresh();
  }

  /** Put changes back as they were, newest first — each sent with what it
   *  set as `expect`, so one changed again since is refused, not undone —
   *  and never lifting a removal from the guild made since (the relay
   *  refuses that unasked). The outcome is said on the line the change was
   *  (`entry.line`), so another change's Undo stays up. */
  async function undo(entry) {
    const list = entry.list;
    const line = entry.line;
    const lines = [];
    let bad = false;
    let conflict = false;
    let pid = null;
    for (const u of list.slice().reverse()) {
      pid = u.pid;
      const row = rowOf(u.pid);
      try {
        const r = await enqueue(() => writeGrant(gid, u.pid, cid, u.prev, u.next), paused(u.pid));
        learnNames(r);
        const fresh = rowFrom(u.pid, row || { displayName: u.name }, r && r.effective);
        if (fresh) put(fresh, false);
        else if (d.isCurrent()) await reloadRows(null);
        patchSummary(gid, cid, rows, false);
        noteChange(gid);
        env.markStale();
        const nowText = fresh ? lib.effectNowText(r.effective, where) : '';
        // Undo takes the grant back; a removal it lifted stays lifted.
        lines.push('Undone: ' + (u.prev == null ? 'no direct grant for ' + u.name + ' in ' + where : u.name + ' → ' + (u.prev.length ? lib.capsSummary(u.prev) : 'blocked') + ' in ' + where) +
          '.' + (nowText ? ' Effective now: ' + nowText + '.' : '') +
          (u.lifted ? ' Its removal from ' + guild + ' stays lifted. ' + lib.removeAgainText(guild) : ''));
      } catch (e) {
        bad = true;
        if (e.code === 'CONFLICT' || e.code === 'BANNED') conflict = true;
        lines.push(lib.undoRefusedText(e, { channelId: cid, names, reloaded: d.isCurrent(), name: u.name, guild }));
      }
    }
    if (conflict && d.isCurrent()) await reloadRows(pid);
    const kind = bad ? 'err' : 'ok';
    if (line && line !== whoStatus) line[kind](parts(lines), { toastText: lines.join(' ') });
    else report(kind, parts(lines), { toastText: lines.join(' ') }, list.length === 1 ? pid : null);
    afterClose();
  }

  const parts = (lines) => (lines.length === 1 ? lines[0] : lines.map((t) => el('span', { class: 'status-part', text: t })));
  /** Say a change on `line` (whoStatus: under the persona's row), with an
   *  Undo of `list` for 10 s — retiring any older Undo of the same persona
   *  here. */
  function said(line, kind, msg, opts, list, pid) {
    const undoable = (list || []).filter(Boolean);
    const entry = undoable.length ? undos.add(undoable, line) : null;
    const o = Object.assign({}, opts);
    if (entry) Object.assign(o, { action: { label: 'Undo', ariaLabel: 'Undo the last change in ' + where, run: () => undo(entry) }, ms: UNDO_MS });
    const toast = line === whoStatus ? report(kind, msg, o, pid) : line[kind](msg, o);
    if (entry) entry.toast = toast;
  }

  /** A row's direct-grant control picked `next`: ask first when it lowers
   *  guild-wide or default access, then send it. Resolves true when saved. */
  async function change(pid, next, meta) {
    const row = rowOf(pid);
    const name = (row && row.displayName) || pid;
    const ck = lib.changeKind(row, botCaps, next);
    const lift = lib.isRemoved(row) && !!next && next.length > 0;
    if (lift) {
      // Giving access to a persona removed from the guild lifts the removal in the
      // whole guild: asked first, as the confirm says.
      const go = await ui.confirmDialog({
        title: 'Lift ' + name + '’s removal from ' + guild + '?',
        body: [lib.liftText(name, next, where, guild), lib.UNDO_KEEPS_LIFT],
        confirmLabel: 'Give access and lift',
      });
      if (!go) return false;
    } else if (lib.needsLowerConfirm(ck, next)) {
      const go = await ui.confirmDialog(next.length ? {
        title: 'Lower ' + name + '’s access in ' + where + '?',
        body: [lib.lowerText(name, ck, where), 'You can undo it for a few seconds afterwards, or set it again any time.'],
        confirmLabel: 'Lower to ' + lib.levelLabel(next),
      } : {
        title: 'Block guild-wide access for ' + name + ' in ' + where + '?',
        body: ['Blocks guild-wide and persona-default access in this channel. ' + lib.lowerText(name, ck, where)],
        confirmLabel: 'Block guild-wide here',
      });
      if (!go) return false;
    }
    const res = await send(pid, name, next, row, true, lift, meta);
    if (res.ok) {
      said(whoStatus, 'ok', res.text, null, [res.undo], pid);
      return true;
    }
    const e = res.error;
    if (e.code === 'CONFLICT') {
      const ok = await reloadRows(pid);
      // A Custom… edit stays open with its ticks, now over the grant as it is:
      // the admin sees the change, and Apply again replaces it knowingly.
      if (ok) rebaseEdit(pid);
      report('err', lib.errorText(e, 'Not saved', { reloaded: ok }), null, pid);
      return false;
    }
    if (e.code === 'BANNED') {
      // Removed from the guild since this was read: the row says so now, and
      // the next try asks before lifting that.
      const ok = await reloadRows(pid);
      report('err', lib.removedSinceText('Not saved', name, guild, ok), null, pid);
      return false;
    }
    report('err', lib.errorText(e, next == null ? 'Not removed' : 'Not saved', { channelId: cid, names }), null, pid);
    return false;
  }

  // ── Add personas ──
  let addSection = null;
  let syncCurrently = () => {};
  if (grantable) {
    const addStatus = ui.statusLine(null);
    /** A persona of the directory as a pick: named, with where it stands
     *  here, and whether it was removed from the guild. */
    const itemOf = (p) => {
      const row = rowOf(p.id);
      const removed = !!p.removed || lib.isRemoved(row);
      const here = row && row.effective && row.effective.length ? lib.levelLabel(row.effective) + ' here'
        : removed ? 'removed from ' + guild
          : p.hasAccessHere ? 'no access here' : 'no access in ' + guild;
      return { value: p.id, label: p.displayName || p.id, title: p.id, hint: p.id + ' · ' + here, avatarUrl: p.avatarUrl, removed };
    };
    const removedPick = (it) => !!it.removed || lib.isRemoved(rowOf(it.value));
    const ta = ui.typeahead({
      label: 'Personas',
      placeholder: 'Type a persona’s name…',
      max: MAX_ADD,
      name: 'persona',
      empty: 'No persona matches.',
      source: async (q) => {
        const r = await env.api('GET', env.gpath(gid) + '/persona-directory' + env.qs({ q }));
        return (r.personas || []).map(itemOf);
      },
    });
    ta.input.id = ui.uid('field');
    const level = ui.levelControl({ value: lib.LEVEL_CAPS.write, label: 'Level' });
    const currentlyList = el('ul', { class: 'currently-list' });
    const currently = el('div', { class: 'currently hidden' }, [el('div', { class: 'field-label', text: 'Currently:' }), currentlyList]);
    const addBtn = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Add' });
    const why = el('span', { class: 'field-hint' });
    const form = el('form', { class: 'add-form', novalidate: true }, [
      el('div', { class: 'field' }, [el('label', { for: ta.input.id, text: 'Personas' }), ta.node]),
      ui.field({ label: 'Level', control: level.node }),
      currently,
      el('div', { class: 'inline' }, [addBtn, why]),
      addStatus.node,
    ]);
    const tracker = d.track(form);

    syncCurrently = () => {
      const items = ta.items();
      const caps = level.value();
      clear(currentlyList);
      for (const it of items) {
        const row = rowOf(it.value);
        const ck = caps.length ? lib.changeKind(row, botCaps, caps) : null;
        currentlyList.appendChild(el('li', { text: lib.currentlyText(it.label, row, ck, removedPick(it) ? guild : null) }));
      }
      currently.classList.toggle('hidden', !items.length);
      const missing = !items.length ? 'Pick a persona to add.' : !caps.length ? 'Pick a level.' : '';
      // Through setDisabled: after an Add clears the picks this runs inside
      // the submit, and busy() would otherwise turn the button back on.
      ui.setDisabled(addBtn, !!missing);
      why.textContent = missing;
    };
    ta.onChange(syncCurrently);
    level.onChange(syncCurrently);

    ui.onSubmit(form, async () => {
      const items = ta.items();
      const caps = level.value();
      if (!items.length || !caps.length) return; // Add is off until both are picked
      const asks = items
        .map((it) => ({ it, ck: lib.changeKind(rowOf(it.value), botCaps, caps) }))
        .filter((c) => lib.needsLowerConfirm(c.ck, caps));
      // Adding a persona removed from the guild lifts that removal.
      const lifts = items.filter(removedPick);
      if (asks.length || lifts.length) {
        const title = !lifts.length
          ? (asks.length === 1 ? 'Lower ' + asks[0].it.label + '’s access in ' + where + '?' : 'Lower access for ' + asks.length + ' personas in ' + where + '?')
          : asks.length ? 'Lower access and lift removals from ' + guild + '?'
            : lifts.length === 1 ? 'Lift ' + lifts[0].label + '’s removal from ' + guild + '?' : 'Lift the removal of ' + lifts.length + ' personas from ' + guild + '?';
        const go = await ui.confirmDialog({
          title,
          body: asks.map((c) => lib.lowerText(c.it.label, c.ck, where))
            .concat(lifts.map((it) => lib.liftText(it.label, caps, where, guild)), lifts.length ? [lib.UNDO_KEEPS_LIFT] : []),
          confirmLabel: lifts.length ? 'Add and lift' : 'Add at ' + lib.levelLabel(caps),
        });
        if (!go) return;
      }
      addStatus.clear();
      const lines = [];
      const done = []; // what Undo puts back
      const left = [];
      const saved = new Set(); // the personas the relay took
      let conflict = false;
      for (const it of items) {
        const lift = removedPick(it); // asked above
        const res = await send(it.value, it.label, caps, { displayName: it.label, avatarUrl: it.avatarUrl, removed: !!it.removed }, false, lift);
        if (res.ok) {
          lines.push(res.text);
          done.push(res.undo);
          saved.add(it.value);
          continue;
        }
        left.push(it);
        if (res.error.code === 'CONFLICT' || res.error.code === 'BANNED') conflict = true;
        if (res.error.code === 'BANNED') {
          // Removed since it was picked: it stays picked, and the next Add asks first.
          it.removed = true;
          lines.push(lib.removedSinceText('Not saved for ' + it.label, it.label, guild, true));
          continue;
        }
        lines.push(lib.errorText(res.error, 'Not saved for ' + it.label, { channelId: cid, names, reloaded: true }));
        if (res.error.status === 401) {
          // The session ended: the rest would be refused too. They stay
          // picked (and kept across Sign in again).
          for (const rest of items.slice(items.indexOf(it) + 1)) left.push(rest);
          break;
        }
      }
      if (conflict) await reloadRows(null);
      // What is picked now, less who was added: one that failed stays to be
      // tried again, and one picked while the Add was at work stays too —
      // unsaved, so closing the drawer still asks.
      const rest = ta.items().filter((it) => !saved.has(it.value));
      ta.set(rest);
      if (!rest.length) tracker.reset();
      syncCurrently();
      said(addStatus, left.length ? 'err' : 'ok', parts(lines), { toastText: lines.join(' ') }, done, null);
    }, { busyLabel: 'Adding…' });

    /** Put picks kept as ids back as the directory names them (and says
     *  whether each was removed with /ban); one it doesn't know any more is
     *  left out. Picks made meanwhile stay, after them. */
    async function restorePicks(ids) {
      let found = null;
      try {
        const r = await env.api('GET', env.gpath(gid) + '/persona-directory' + env.qs({ ids: ids.join(',') }));
        found = new Map((r.personas || []).map((p) => [p.id, p]));
      } catch { /* below: what this drawer knows */ }
      if (!d.isCurrent()) return;
      const back = ids
        .map((id) => (found ? (found.has(id) ? itemOf(found.get(id)) : null)
          : { value: id, label: (rowOf(id) || {}).displayName || id, title: id }))
        .filter(Boolean);
      const taken = new Set(back.map((it) => it.value));
      ta.set(back.concat(ta.items().filter((it) => !taken.has(it.value))));
      syncCurrently();
    }

    // Kept across "Sign in again": whom to add and at what level — or a
    // row's Custom… edit, whichever with changes was touched last.
    const addHooks = {
      serialize: () => ({ personas: ta.values(), caps: level.value() }),
      restore(fl) {
        if (fl.caps) level.set(fl.caps);
        if (fl.personas && fl.personas.length) restorePicks(fl.personas.slice(0, MAX_ADD));
        syncCurrently();
      },
      isDirty: () => tracker.isDirty(),
    };
    const customHooks = {
      serialize() {
        const changed = liveEdits().filter(([, e]) => editChanged(e));
        const last = changed[changed.length - 1];
        return last ? { personaId: last[0], channelId: cid, caps: last[1].caps.slice(), base: last[1].base == null ? null : last[1].base.slice() } : {};
      },
      // It comes back open — never applied — in this channel's drawer, on a
      // row that is still here.
      belongs: (f) => f.channelId === cid && typeof f.personaId === 'string' && !!rowOf(f.personaId),
      restore(f) {
        const row = rowOf(f.personaId);
        const cur = row ? row.direct : null;
        // Started over `base` before the sign-in (a draft from an older
        // panel: over the grant as it is now).
        const base = Object.prototype.hasOwnProperty.call(f, 'base') ? f.base : cur;
        edits.set(f.personaId, { caps: (f.caps || []).slice(), start: ui.customStart(cur), base: base == null ? null : base.slice() });
        restoredPid = f.personaId;
        drawRows();
      },
      isDirty: editsDirty,
    };
    let restoredPid = null;
    const restoredAdd = env.keepForm(d, 'chanAdd', addHooks, addStatus);
    // 'Restored your unsaved change…' under the row it is in.
    const restoredCustom = env.keepForm(d, 'dgCustom', customHooks, { info: (msg) => report('info', msg, null, restoredPid) });
    if (restoredAdd && !restoredCustom) d.registerForm('chanAdd', addHooks);
    ta.onChange(() => d.registerForm('chanAdd', addHooks));
    level.onChange(() => d.registerForm('chanAdd', addHooks));
    editTouched.push(() => d.registerForm('dgCustom', customHooks));
    syncCurrently();
    addSection = el('section', { class: 'drawer-section' }, [el('h3', { text: 'Add personas' }), form]);
  }

  drawRows();
  // What this read says is the list's count for the channel now (another
  // tab or slash may have changed it since the list was drawn).
  if (patchSummary(gid, cid, rows, false)) env.markStale();
  const body = el('div', { class: 'drawer-sections' }, [
    top,
    addSection,
    el('section', { class: 'drawer-section' }, [whoHead, whoTable, whoEmpty]),
    el('div', { class: 'drawer-foot' }, [
      grantable ? el('a', { class: 'btn btn-sm', href: env.formatRoute(env.route('g', gid, 'invites', { kind: 'mint' }, { c: cid, lvl: 'write' })), text: 'Invite a new agent here' }) : null,
      el('p', { class: 'hint muted' }, ['In Discord: ', el('code', { text: '/add persona:… level:write' }), ' — run it in ' + where]),
    ]),
  ]);
  d.setBody(body);
}

function replaceNode(parent, node, old) {
  parent.insertBefore(node, old);
  parent.removeChild(old);
}

/** On coming back to the window: a list older than a minute asks again. */
function onFocus() {
  const l = env && env.state.list;
  if (l && l.kind === 'channels' && l.isOld()) l.reload();
}

PA.channels = {
  /** app.js's helpers: { api, gpath, qs, state, route, formatRoute, navigate,
   *  openDrawer, replaceDrawerRoute, markStale, setList, syncQuery,
   *  guildName, avatarThumb, loadError, couldntLoad, sessionEndedNote,
   *  keepForm, isSuper, userId, local, grantApi, accessApi, relayOutdated,
   *  outdatedAfter404 }. */
  attach(e) {
    const first = !env;
    env = e;
    if (first && typeof window.addEventListener === 'function') window.addEventListener('focus', onFocus);
  },
  render,
  openDrawer,
  /** The persona drawer changes direct grants through the same queue and
   *  the same hardened route (see enqueue and writeGrant), and keeps its
   *  Undo toasts the same way (undoBook). */
  enqueue,
  writeGrant,
  undoBook,
  /** The guild's access summary (cached with the channels, as the list has
   *  it): the Personas list counts where each persona can act from it —
   *  asked for again when a channel drawer changed something since it was
   *  read (its per-persona counts aren't patched in place). */
  summary(gid) {
    const c = cache[gid];
    const behind = !!c && (c.seen || 0) < (changes[gid] || 0);
    return load(gid, behind).then((v) => v.summary);
  },
  /** Forget what is known about a guild (every guild when none is named):
   *  something changed elsewhere in the panel, so the next look asks again. */
  forget(gid) {
    generation++;
    for (const k of Object.keys(cache)) if (gid === undefined || k === gid) delete cache[k];
    for (const k of Object.keys(inflight)) if (gid === undefined || k === gid) delete inflight[k];
  },
};
})();
