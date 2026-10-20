/* Portal Admin — pure helpers (window.PA.lib).
 *
 * No DOM, no network, no clock unless one is passed in: everything here is a
 * function of its arguments, so portal-relay/test/admin-spa.test.ts can run
 * it in an empty node:vm sandbox. Like every panel script it is one IIFE
 * that assigns a single global, PA.<module>.
 *
 *   LEVEL_CAPS, ALL_CAPS, CAP_GROUPS   the capability model, as slash speaks it
 *   adoptModel                         take the relay's own copy from /admin/me
 *   levelOf, levelLabel, capsSummary   caps → 'Write', 'Write +1', 'Custom'
 *   capsTitle, capsWords               the same in words (tooltips)
 *   isGrantableType, holdsAccess       which channels can hold a direct grant; which
 *                                      have access of their own (any kind but a thread or category)
 *   effectNowText, remainingText,      what the relay lets a persona do after a
 *   guildEffectText, botLimitText      change ('Read — the relay bot can’t send in #welcome')
 *   channelLayout, filterLayout,       the Channels list in Discord's order, its
 *   countsText, botListNote,           counts and warnings in words
 *   botListTitle
 *   sourceChips, pillText,             a channel drawer row: why, and what it can do
 *   directValue, canBlock,
 *   customOptionText
 *   predictDirect, changeKind,         what a direct-grant change would do (only
 *   lowerText, currentlyText,          to ask first: the relay says what it did)
 *   sameCapSet                         the same capabilities, in any order
 *   isRemoved, liftText,               a persona removed from the guild (/ban or
 *   removeAgainText, removedSinceText, Remove from <guild>: the page can't tell which), the lift,
 *   undoRefusedText                    and a change or an Undo the relay refused because of it
 *   grantResultText                    what a direct-grant change did, from the answer
 *   canActInText, personaSummaryText,  the Personas list and the persona drawer:
 *   foldAccessRows, inactiveText,      counts in words, rows that read alike folded,
 *   removeConfirm, removedText         grants that do nothing, Remove from <guild>
 *   chanText, roleText, wherePhrase    ids → names ('#general', '@Mods')
 *   roleMeaning, roleLevelText         an access role in one line
 *   roleNameTaken                      defining a role under a name in use
 *   grantSummary, inviteSummary        what an invite confers, in one line
 *   inviteStatusText                   'Active' · 'Used up' · 'Expired'
 *   errorText                          a refusal from the relay, in words
 *   parseRoute, formatRoute            the panel's #/… addresses (round-trip)
 *   addressText                        a search as an address may hold it
 *   isSafeReturnTo                     a place to come back to after sign-in
 *   makeDraft, readDraft, draftFields  an unsaved form kept across a sign-in
 *   loginErrorText                     why a sign-in came back (?login_error=)
 */
(function (root) {
  'use strict';

  const PA = (root.PA = root.PA || {});

  // ── The capability model ──────────────────────────────────────────────────

  // mirror of portal-relay/src/slash.ts and permissions.ts; parity-tested.
  // The relay sends its own in /admin/me (adoptModel); this copy is for a
  // relay too old to.
  let LEVEL_CAPS = Object.freeze({
    read: Object.freeze(['VIEW_CHANNEL', 'READ_HISTORY']),
    write: Object.freeze([
      'VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'SEND_IN_THREADS',
      'CREATE_THREADS', 'ATTACH_FILES', 'ADD_REACTIONS', 'EDIT_OWN', 'DELETE_OWN',
    ]),
    full: Object.freeze([
      'VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'SEND_IN_THREADS',
      'CREATE_THREADS', 'ATTACH_FILES', 'ADD_REACTIONS', 'EDIT_OWN', 'DELETE_OWN',
      'MANAGE_MESSAGES',
    ]),
  });

  // mirror of portal-relay/src/slash.ts and permissions.ts; parity-tested
  let ALL_CAPS = Object.freeze([
    'VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'SEND_IN_THREADS', 'CREATE_THREADS',
    'ATTACH_FILES', 'ADD_REACTIONS', 'MENTION_EVERYONE', 'EDIT_OWN', 'DELETE_OWN',
    'MANAGE_MESSAGES', 'MANAGE_CHANNELS', 'VOICE_LISTEN', 'VOICE_SPEAK',
  ]);

  /** The presets, lowest first. */
  const LEVELS = Object.freeze(['read', 'write', 'full']);

  const LEVEL_NAME = Object.freeze({ none: 'None', read: 'Read', write: 'Write', full: 'Full', custom: 'Custom' });

  /** What each level means — the same words as the slash help. */
  const LEVEL_HELP = Object.freeze({
    read: 'Read = see the channel and its history.',
    write: 'Write = Read + send, reply in and start threads, attach files, react, edit and delete own messages.',
    full: 'Full = Write + manage messages.',
  });

  /** Checkbox labels (inside Custom… only). */
  const CAP_LABEL = Object.freeze({
    VIEW_CHANNEL: 'View', READ_HISTORY: 'History',
    SEND_MESSAGES: 'Send', SEND_IN_THREADS: 'Reply in threads', CREATE_THREADS: 'Start threads',
    ATTACH_FILES: 'Attach files', ADD_REACTIONS: 'React', EDIT_OWN: 'Edit own messages', DELETE_OWN: 'Delete own messages',
    MENTION_EVERYONE: 'Mention everyone', MANAGE_MESSAGES: 'Manage messages', MANAGE_CHANNELS: 'Manage channels',
    VOICE_LISTEN: 'Listen', VOICE_SPEAK: 'Speak',
  });

  /** The same capabilities in running text ('Write + mention everyone'). */
  const CAP_WORDS = Object.freeze({
    VIEW_CHANNEL: 'view', READ_HISTORY: 'history',
    SEND_MESSAGES: 'send', SEND_IN_THREADS: 'reply in threads', CREATE_THREADS: 'start threads',
    ATTACH_FILES: 'attach files', ADD_REACTIONS: 'react', EDIT_OWN: 'edit own messages', DELETE_OWN: 'delete own messages',
    MENTION_EVERYONE: 'mention everyone', MANAGE_MESSAGES: 'manage messages', MANAGE_CHANNELS: 'manage channels',
    VOICE_LISTEN: 'listen in voice', VOICE_SPEAK: 'speak in voice',
  });

  /** How Custom… groups the checkboxes. Together they hold ALL_CAPS. */
  let CAP_GROUPS = Object.freeze([
    Object.freeze({ key: 'read', label: 'Read', caps: Object.freeze(['VIEW_CHANNEL', 'READ_HISTORY']) }),
    Object.freeze({ key: 'write', label: 'Write', caps: Object.freeze(['SEND_MESSAGES', 'SEND_IN_THREADS', 'CREATE_THREADS', 'ATTACH_FILES', 'ADD_REACTIONS', 'EDIT_OWN', 'DELETE_OWN']) }),
    Object.freeze({ key: 'moderation', label: 'Moderation', caps: Object.freeze(['MENTION_EVERYONE', 'MANAGE_MESSAGES', 'MANAGE_CHANNELS']) }),
    Object.freeze({ key: 'voice', label: 'Voice', caps: Object.freeze(['VOICE_LISTEN', 'VOICE_SPEAK']) }),
  ]);
  const BASE_GROUPS = CAP_GROUPS;

  /**
   * Take the relay's levels and capabilities (from /admin/me) in place of
   * this file's copy, so the panel offers what the relay it talks to knows.
   * Anything malformed is ignored and the copy stays: returns whether it was
   * taken. A capability this file has no label for is offered under Other.
   */
  function adoptModel(levels, caps) {
    const names = (xs) => Array.isArray(xs) && xs.length > 0 && xs.every((x) => typeof x === 'string' && /^[A-Z][A-Z0-9_]*$/.test(x));
    if (!names(caps) || new Set(caps).size !== caps.length || !levels || typeof levels !== 'object') return false;
    const all = new Set(caps);
    if (!all.has('VIEW_CHANNEL') || !all.has('READ_HISTORY')) return false; // the panel's rules lean on these two
    for (const k of LEVELS) if (!names(levels[k]) || !levels[k].every((c) => all.has(c))) return false;
    const lv = {};
    for (const k of LEVELS) lv[k] = Object.freeze(levels[k].slice());
    LEVEL_CAPS = Object.freeze(lv);
    ALL_CAPS = Object.freeze(caps.slice());
    const groups = BASE_GROUPS.map((g) => Object.freeze({ key: g.key, label: g.label, caps: Object.freeze(g.caps.filter((c) => all.has(c))) }))
      .filter((g) => g.caps.length);
    const known = new Set(BASE_GROUPS.flatMap((g) => g.caps));
    const other = caps.filter((c) => !known.has(c));
    if (other.length) groups.push(Object.freeze({ key: 'other', label: 'Other', caps: Object.freeze(other) }));
    CAP_GROUPS = Object.freeze(groups);
    PA.lib.LEVEL_CAPS = LEVEL_CAPS;
    PA.lib.ALL_CAPS = ALL_CAPS;
    PA.lib.CAP_GROUPS = CAP_GROUPS;
    return true;
  }

  const capIndex = (c) => {
    const i = ALL_CAPS.indexOf(c);
    return i < 0 ? ALL_CAPS.length : i;
  };
  /** Distinct caps in ALL_CAPS order (unknown names last, kept). */
  function sortCaps(caps) {
    return Array.from(new Set(caps || [])).sort((a, b) => capIndex(a) - capIndex(b) || (a < b ? -1 : a > b ? 1 : 0));
  }

  /**
   * Where a capability set sits on the Read/Write/Full ladder:
   *   level  'none' | 'read' | 'write' | 'full' | 'custom'
   *   base   the highest preset wholly inside caps (null if none is)
   *   extra  caps beyond that preset (all of them when base is null)
   * 'custom' covers both a preset plus extras ('Write +1') and a set that
   * holds no preset at all (no View, say).
   */
  function levelOf(caps) {
    const set = new Set(caps || []);
    if (!set.size) return { level: 'none', base: null, extra: [] };
    let base = null;
    for (let i = LEVELS.length - 1; i >= 0; i--) {
      if (LEVEL_CAPS[LEVELS[i]].every((c) => set.has(c))) { base = LEVELS[i]; break; }
    }
    const inBase = new Set(base ? LEVEL_CAPS[base] : []);
    const extra = sortCaps([...set].filter((c) => !inBase.has(c)));
    return { level: base && !extra.length ? base : 'custom', base, extra };
  }

  /** 'Read' · 'Write' · 'Full' · 'Write +1' · 'Custom' · 'None'. */
  function levelLabel(caps) {
    const l = levelOf(caps);
    if (l.level !== 'custom') return LEVEL_NAME[l.level];
    return l.base ? LEVEL_NAME[l.base] + ' +' + l.extra.length : LEVEL_NAME.custom;
  }

  /** 'view, history, send' — in ALL_CAPS order. */
  function capsWords(caps) {
    return sortCaps(caps).map((c) => CAP_WORDS[c] || String(c).toLowerCase().replace(/_/g, ' ')).join(', ');
  }

  /** In a sentence: 'Write', 'Write + mention everyone', 'Custom (view, send)',
   *  'Custom (send) — can’t see the channel', 'None'. */
  function capsSummary(caps) {
    const s = summaryParts(caps);
    return s.blind ? s.text + ' — can’t see the channel' : s.text;
  }

  /** capsSummary in its two parts — the level in words, and whether it
   *  can't see the channel (a set without View) — so that a longer sentence
   *  can end on the warning: 'still Custom (send) via role x — can’t see
   *  the channel'. */
  function summaryParts(caps) {
    const l = levelOf(caps);
    if (l.level !== 'custom') return { text: LEVEL_NAME[l.level], blind: false };
    if (l.base) return { text: LEVEL_NAME[l.base] + ' + ' + capsWords(l.extra), blind: false };
    return { text: 'Custom (' + capsWords(caps) + ')', blind: !new Set(caps).has('VIEW_CHANNEL') };
  }

  /** A tooltip: what the level means, with any extras named in words. */
  function capsTitle(caps) {
    const l = levelOf(caps);
    if (l.level === 'none') return 'No capabilities.';
    if (l.level !== 'custom') return LEVEL_HELP[l.level];
    if (l.base) return LEVEL_HELP[l.base] + ' Also: ' + capsWords(l.extra) + '.';
    const noView = !new Set(caps).has('VIEW_CHANNEL');
    return 'Custom: ' + capsWords(caps) + '.' + (noView ? ' Without View it can’t see the channel, unless a role already gives view.' : '');
  }

  /** Channels that can hold a direct grant. A thread uses its parent's access
   *  and a category grants nothing, so neither is a grant target. */
  function isGrantableType(type) {
    return type === 'text' || type === 'voice' || type === 'forum';
  }

  /** Channels with access of their own (as access.ts holdsAccess): every kind
   *  but a thread and a category — the grantable ones, and kinds the relay
   *  doesn't name (a stage or media channel), which it serves all the same. */
  function holdsAccess(type) {
    return type !== 'thread' && type !== 'category';
  }

  // ── What a change leaves a persona with ───────────────────────────────────
  // From the relay's answer to a grant change (`effective`): its own account
  // of what the persona can do there now, within what its bot can do.

  /** Why the relay's bot holds a persona back in a channel, from the
   *  capabilities it lacks there: 'the relay bot can’t send in #welcome'. */
  function botLimitText(lacks, where) {
    const l = lacks || [];
    if (l.includes('VIEW_CHANNEL')) return 'the relay bot can’t see ' + where;
    if (l.includes('SEND_MESSAGES')) return 'the relay bot can’t send in ' + where;
    if (l.includes('READ_HISTORY')) return 'the relay bot can’t read the history of ' + where;
    return 'the relay bot can’t ' + orList(sortCaps(l).map((c) => CAP_WORDS[c] || String(c).toLowerCase().replace(/_/g, ' '))) + ' in ' + where;
  }

  /** How an access sentence ends: ' — can’t see the channel' (a set
   *  without View), ' — the relay bot can’t send in #welcome', both, or ''.
   *  When the bot can't see the channel, that alone says why. */
  function limitsText(ex, parts, where) {
    const lacks = ex.botLimited && Array.isArray(ex.botLacks) ? ex.botLacks : [];
    const out = [];
    if (parts.blind && !lacks.includes('VIEW_CHANNEL')) out.push('can’t see the channel');
    if (lacks.length) out.push(botLimitText(lacks, where));
    return out.length ? ' — ' + out.join('; ') : '';
  }

  /** What a persona can do in a channel now, for 'Effective now: …':
   *  'Write' · 'Read — the relay bot can’t send in #welcome' · 'no access'. */
  function effectNowText(ex, where) {
    if (!ex || !Array.isArray(ex.effective)) return '';
    const parts = summaryParts(ex.effective);
    return (ex.effective.length ? parts.text : 'no access') + limitsText(ex, parts, where);
  }

  /**
   * After a direct grant is removed, what the relay's answer says is left:
   * 'still Write via role g1-chatters' · 'no remaining access in #research'.
   * `where` names the channel the grant was on; `accessWhere` the channel
   * whose access applies there, when that is another one (a thread's is its
   * parent's, and the answer is then the parent's: ex.parentId). A channel
   * that is gone (ex.missing) leaves nothing to say: ''.
   */
  function remainingText(ex, where, accessWhere) {
    if (!ex || !Array.isArray(ex.effective)) return '';
    if (!ex.effective.length) return 'no remaining access in ' + where;
    const at = accessWhere || where;
    const via = viaParts(ex, 'the direct grant in ' + at);
    const parts = summaryParts(ex.effective);
    return 'still ' + parts.text + (via.length ? ' via ' + via.join(' and ') : '') + limitsText(ex, parts, at);
  }

  /** What an explanation's sources that count add up from, in words:
   *  ['role g1-chatters', 'the guild-wide level'] — `direct` names the
   *  direct grant ('the direct grant in #research'). */
  function viaParts(ex, direct) {
    const live = ((ex && ex.sources) || []).filter((s) => !s.shadowedBy);
    const roles = live.filter((s) => s.kind === 'role').map((s) => s.name);
    const via = [];
    if (roles.length) via.push((roles.length === 1 ? 'role ' : 'roles ') + roles.join(', '));
    if (live.some((s) => s.kind === 'direct' && s.caps && s.caps.length)) via.push(direct);
    if (live.some((s) => s.kind === 'guildWide' && s.caps && s.caps.length)) via.push('the guild-wide level');
    if (live.some((s) => s.kind === 'personaDefault')) via.push('the persona default');
    if (live.some((s) => s.kind === 'relayDefault')) via.push('the relay default');
    return via;
  }

  /** A guild-wide change's answer, for 'Effective now: …': 'Read in 14
   *  channels, Write in 2 (direct grants)' — the biggest group first, and
   *  '(direct grants)' on a group that is all direct grants. */
  function guildEffectText(e, guild) {
    const counts = (e && e.counts) || {};
    const direct = (e && e.direct) || {};
    const groups = ['full', 'write', 'read', 'custom']
      .filter((k) => counts[k] > 0)
      .map((k) => ({ k, n: counts[k], d: direct[k] || 0 }))
      .sort((a, b) => b.n - a.n);
    if (!groups.length) return 'no access in any channel of ' + guild;
    return groups.map((g, i) => LEVEL_NAME[g.k] + ' in ' + (i === 0 ? plural(g.n, 'channel') : g.n) + (g.d === g.n ? ' (direct grants)' : '')).join(', ');
  }

  // ── The Channels tab: who can act where ───────────────────────────────────
  // Everything here formats what the relay said (GET …/channels,
  // …/access/summary, …/channels/:cid/access): the panel never works out on
  // its own what a persona can do. The one exception, predictDirect(), only
  // decides whether to ask before a change (does it lower access that came
  // from guild-wide or a default?); what the change did is always the relay's
  // answer. test/access.test.ts holds predictDirect to the relay's own preview.

  /** Where a persona's capabilities in a channel are counted: only where it
   *  can see the channel (as slash /list counts), under its level; null when
   *  it isn't counted. As access.ts countedLevel; parity-tested. */
  function countedLevel(effective) {
    if (!Array.isArray(effective) || effective.indexOf('VIEW_CHANNEL') < 0) return null;
    const l = levelOf(effective).level;
    return l === 'none' ? null : l;
  }

  /** How many personas a channel's counts hold. */
  function countsTotal(c) {
    return c ? (c.read || 0) + (c.write || 0) + (c.full || 0) + (c.custom || 0) : 0;
  }

  /** A channel's counts in words: '3 can write · 2 can read · 1 full · 1
   *  custom' (a level nobody is at is left out), '—' when nobody can act
   *  there, '' when the counts aren't known. */
  function countsText(c) {
    if (!c) return '';
    const parts = [];
    if (c.write) parts.push(c.write + ' can write');
    if (c.read) parts.push(c.read + ' can read');
    if (c.full) parts.push(c.full + ' full');
    if (c.custom) parts.push(c.custom + ' custom');
    return parts.length ? parts.join(' · ') : '—';
  }

  /** A channel's counts from the rows of its access read (…/channels/:cid/
   *  access lists everyone who can do anything there): what the summary
   *  counts for it, so the list follows what a drawer read or changed
   *  without asking for the whole summary again. */
  function countsFromRows(rows) {
    const out = { read: 0, write: 0, full: 0, custom: 0 };
    for (const r of rows || []) {
      const k = countedLevel(r && r.effective);
      if (k) out[k] += 1;
    }
    return out;
  }

  /** The list's warning for a channel whose bot can't do everything Write
   *  needs, from what it lacks (the summary's botLacks): 'relay can only read
   *  here' when it can't send, else 'relay is limited here'. Null when it
   *  can (or can't see the channel at all: those are listed apart). An older
   *  relay says only the bot's level: below Write is 'limited' — it can't
   *  tell a bot that can't send from one that only can't start threads. */
  function botListNote(s) {
    if (!s || s.botCantView || s.botBase === undefined) return null;
    if (Array.isArray(s.botLacks)) {
      if (!s.botLacks.length) return null;
      return s.botLacks.includes('SEND_MESSAGES') ? 'relay can only read here' : 'relay is limited here';
    }
    if (s.botBase === 'write' || s.botBase === 'full') return null;
    return 'relay is limited here';
  }

  /** That warning's tooltip: what the bot can't do, as the channel drawer's
   *  banner says it. */
  function botListTitle(s) {
    const lacks = s && Array.isArray(s.botLacks) ? s.botLacks : null;
    if (!lacks || !lacks.length) return 'The relay’s bot can’t do everything Write needs in this channel.';
    const t = lacks.includes('SEND_MESSAGES') ? 'The relay bot can only Read here — anything above Read does nothing until the bot gets Send Messages in this channel.'
      : botLimitText(lacks, 'this channel') + ', so Write and Full do only what it can.';
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  /** The channel drawer's banner when the relay's bot can't do everything
   *  Write needs there (from its capabilities in the channel), or null. */
  function botBannerText(botCaps) {
    const bot = new Set(botCaps || []);
    if (!bot.has('VIEW_CHANNEL')) return 'The relay bot can’t see this channel. Grants here take effect once it can.';
    if (!bot.has('SEND_MESSAGES')) return 'The relay bot can only Read here — anything above Read does nothing until the bot gets Send Messages in this channel.';
    const lacks = LEVEL_CAPS.write.filter((c) => !bot.has(c));
    if (!lacks.length) return null;
    const t = botLimitText(lacks, 'this channel');
    return t.charAt(0).toUpperCase() + t.slice(1) + ', so Write and Full do only what it can.';
  }

  /** 'just now' · '12 s ago' · '3 min ago' · '2 h ago'. */
  function agoText(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return s + ' s ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    return Math.floor(m / 60) + ' h ago';
  }

  const cmpText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  /** Discord's sidebar order within one category: text-like channels before
   *  voice ones (Discord numbers the two kinds apart), each by position. */
  function bySidebar(a, b) {
    return (a.type === 'voice' ? 1 : 0) - (b.type === 'voice' ? 1 : 0) || (a.position || 0) - (b.position || 0) ||
      cmpText(String(a.name || ''), String(b.name || '')) || cmpText(a.id, b.id);
  }

  /**
   * The Channels list, from GET …/channels ({channels, categories}) and
   * …/access/summary, in Discord's order: channels outside any category
   * first, then each category by position. Every channel with access of
   * its own is listed (holdsAccess) — never a thread (it uses its channel's
   * access) or a category — a kind the panel can't give access on included
   * (`grantable` false: the relay serves it, and roles, guild-wide levels and
   * defaults reach it); those the relay's bot can't see go to `hidden`, in
   * the same order.
   *   → { groups: [{ id, name, rows }], hidden: [rows], truncated, count }
   * A row: { id, name, type, grantable, announcement, categoryId,
   * categoryName, counts (null when unknown), total, botBase, botCantView,
   * botLacks }.
   */
  function channelLayout(chans, summary) {
    const all = (chans && chans.channels) || [];
    const stats = {};
    for (const s of (summary && summary.channels) || []) stats[s.id] = s;
    const truncated = !!(summary && summary.truncated);
    const cats = all.filter((c) => c.type === 'category').slice().sort(bySidebar);
    const catName = {};
    for (const c of cats) catName[c.id] = c.name || c.id;
    const rows = all
      .filter((c) => holdsAccess(c.type))
      .map((c) => {
        const s = stats[c.id];
        const counts = s && s.counts && !truncated ? s.counts : null;
        const cat = c.categoryId && Object.prototype.hasOwnProperty.call(catName, c.categoryId) ? c.categoryId : null;
        return {
          id: c.id, name: c.name || null, type: c.type, announcement: !!c.announcement, position: c.position || 0,
          grantable: typeof c.grantable === 'boolean' ? c.grantable : isGrantableType(c.type),
          categoryId: cat, categoryName: cat ? catName[cat] : null,
          counts, total: counts ? countsTotal(counts) : null,
          botBase: s ? s.botBase : undefined, botCantView: !!(s && s.botCantView), botLacks: s ? s.botLacks : undefined,
        };
      });
    const rank = { '': -1 };
    cats.forEach((c, i) => { rank[c.id] = i; });
    const inOrder = (a, b) => rank[a.categoryId || ''] - rank[b.categoryId || ''] || bySidebar(a, b);
    const seen = rows.filter((r) => !r.botCantView);
    const groups = [{ id: null, name: null, rows: seen.filter((r) => !r.categoryId).sort(bySidebar) }]
      .concat(cats.map((c) => ({ id: c.id, name: catName[c.id], rows: seen.filter((r) => r.categoryId === c.id).sort(bySidebar) })))
      .filter((g) => g.rows.length);
    return { groups, hidden: rows.filter((r) => r.botCantView).sort(inOrder), truncated, count: rows.length };
  }

  /** The layout with only the rows a filter keeps: `q` in the channel's name
   *  (any case, a leading # ignored), `show` 'agents' (someone can act
   *  there) or 'empty' (nobody can). Groups left empty are dropped. */
  function filterLayout(layout, q, show) {
    const needle = String(q || '').trim().toLowerCase().replace(/^#/, '');
    const keep = (r) => (!needle || String(r.name || r.id).toLowerCase().indexOf(needle) >= 0) &&
      (show !== 'agents' || (r.total || 0) > 0) && (show !== 'empty' || r.total === 0);
    return Object.assign({}, layout, {
      groups: layout.groups.map((g) => Object.assign({}, g, { rows: g.rows.filter(keep) })).filter((g) => g.rows.length),
      hidden: layout.hidden.filter(keep),
    });
  }

  /** A channel as a list or a drawer title names it: '#research', or
   *  'lounge' / 'ideas' for a voice or forum channel, or one of a kind the
   *  panel doesn't name (whose kind is a badge beside it). */
  function channelTitle(c) {
    const name = (c && c.name) || (c && c.id) || '';
    return c && (c.type === 'voice' || c.type === 'forum' || c.type === 'unknown') ? name : '#' + name;
  }

  /** The badge beside a channel's name: 'announcement' · 'voice' · 'forum' ·
   *  'other kind' (a stage or media channel, say: the relay calls those
   *  unknown, and the panel can't give access on one). */
  function channelBadge(c) {
    if (!c) return null;
    if (c.announcement) return 'announcement';
    if (c.type === 'unknown') return 'other kind';
    return c.type === 'voice' || c.type === 'forum' ? c.type : null;
  }

  /** The tooltip of that 'other kind' badge. */
  const OTHER_KIND_HELP = 'A kind of channel the panel can’t give access on (a stage or media channel, say). Access from access roles, guild-wide levels and defaults still applies here, and a direct grant set in Discord can be removed.';

  const SOURCE_ORDER = { removed: 0, direct: 1, block: 2, role: 3, guildWide: 4, personaDefault: 5, relayDefault: 6 };

  /**
   * Why a persona can (or can't) act in a channel, as the channel drawer's
   * chips — from the relay's explanation (a row of …/channels/:cid/access):
   * 'direct grant' · 'blocked here' · 'role g1-chatters' · 'role
   * g1-mods-mirror · mirrors @Mods' · 'guild-wide' · 'persona default' ·
   * 'relay default' · 'overrides guild-wide Write'. A direct grant's chip
   * names what it replaces here; a persona removed from the guild (with
   * /ban or Remove from <guild>: the relay records only that it was) has
   * that one chip. → [{ kind, text, title }]. opts.isSuper adds that the
   * persona default applies in every guild; opts.guild names the guild.
   */
  function sourceChips(row, names, opts) {
    const o = opts || {};
    const src = ((row && row.sources) || []).slice()
      .sort((a, b) => (SOURCE_ORDER[a.kind] == null ? 9 : SOURCE_ORDER[a.kind]) - (SOURCE_ORDER[b.kind] == null ? 9 : SOURCE_ORDER[b.kind]));
    if (src.some((s) => s.kind === 'removed')) {
      const g = o.guild || 'this guild';
      return [{ kind: 'removed', text: 'removed from this guild', title: 'Removed from ' + g + ' (with /ban, or Remove from ' + g + '): nothing it holds applies here until an admin of this guild gives it access again.' }];
    }
    const hasGuildWide = src.some((s) => s.kind === 'guildWide');
    const out = [];
    for (const s of src) {
      const caps = s.caps || [];
      const replaced = s.shadowedBy === 'direct' || s.shadowedBy === 'block';
      switch (s.kind) {
        case 'direct':
          out.push({ kind: 'direct', text: 'direct grant', title: 'Direct grant here: ' + capsSummary(caps) + '. ' + capsTitle(caps) });
          break;
        case 'block':
          // What it blocks is named by the chip of what it replaces ('overrides
          // guild-wide Read'), and the row's 'Blocked here' pill; with nothing
          // to replace, it does nothing — and says so.
          if (!src.some((x) => (x.kind === 'guildWide' || x.kind === 'personaDefault') && (x.caps || []).length)) {
            out.push({ kind: 'block', text: 'blocks nothing', title: 'An empty direct grant with no guild-wide level or persona default to block: it does nothing here.' });
          }
          break;
        case 'role': {
          const ids = s.how === 'mirror' && Array.isArray(s.mirror) ? s.mirror.map((m) => m.id) : [];
          out.push({
            kind: 'role',
            text: 'role ' + s.name + (ids.length ? ' · mirrors ' + orList(ids.map((id) => roleText(id, names))) : ''),
            title: 'Access role ' + s.name + ' gives ' + capsSummary(caps) + ' here' +
              (ids.length ? (s.mirrorCaps ? ', as far as ' : ', wherever ') + orList(ids.map((id) => roleText(id, names))) + (s.mirrorCaps ? ' may act here.' : ' can see.') : '.'),
          });
          break;
        }
        case 'guildWide':
          if (replaced) {
            if (caps.length) out.push({ kind: 'override', text: 'overrides guild-wide ' + levelLabel(caps), title: 'The direct grant here replaces the guild-wide ' + capsSummary(caps) + ' in this channel.' });
          } else if (caps.length) out.push({ kind: 'guildWide', text: 'guild-wide', title: 'Guild-wide: ' + capsSummary(caps) + ' in every channel without its own grant.' });
          else out.push({ kind: 'guildWide', text: 'denied guild-wide', title: 'Denied guild-wide: the persona default doesn’t apply in this guild. Roles still apply.' });
          break;
        case 'personaDefault':
          if (s.shadowedBy === 'guildWide' || (replaced && hasGuildWide)) break;
          if (replaced) out.push({ kind: 'override', text: 'overrides persona default ' + levelLabel(caps), title: 'The direct grant here replaces the persona default (' + capsSummary(caps) + ') in this channel.' });
          else out.push({ kind: 'personaDefault', text: 'persona default', title: 'Persona default: ' + capsSummary(caps) + (o.isSuper ? ' — it applies in every guild.' : '.') });
          break;
        case 'relayDefault':
          out.push({ kind: 'relayDefault', text: 'relay default', title: 'The relay’s default for a persona with no settings of its own: ' + capsSummary(caps) + '.' });
          break;
        default:
          break;
      }
    }
    return out;
  }

  /** A persona's 'Can do here' pill: 'Read' · 'Write' · 'Write +1' ·
   *  'Custom' · '—', with '(bot-limited)' when the relay's bot cuts it
   *  down; the tooltip says what it means in words. → { text, title, level, limited }. */
  function pillText(row, where) {
    const eff = (row && Array.isArray(row.effective)) ? row.effective : [];
    const limited = !!(row && row.botLimited);
    const level = levelOf(eff).level;
    let title = eff.length ? capsTitle(eff) : 'Can’t act here.';
    if (limited) title += ' Cut down: ' + botLimitText(row.botLacks || [], where || 'this channel') + '.';
    return { text: (eff.length ? levelLabel(eff) : '—') + (limited ? ' (bot-limited)' : ''), title, level, limited };
  }

  /** The direct-grant control's value for a stored grant: '' (none), 'read',
   *  'write', 'full', 'custom', or 'block' (an empty grant). */
  function directValue(direct) {
    if (direct == null) return '';
    if (!direct.length) return 'block';
    const l = levelOf(direct).level;
    return l === 'custom' ? 'custom' : l;
  }

  /** The source that decides a persona's own access in a channel (beside its
   *  access roles), from its explanation: 'direct' (a grant or a block),
   *  'guildWide', 'personaDefault', 'relayDefault', or null. */
  function ownSource(row) {
    for (const s of (row && row.sources) || []) {
      if (s.shadowedBy) continue;
      if (s.kind === 'direct' || s.kind === 'block') return 'direct';
      if (s.kind === 'guildWide' || s.kind === 'personaDefault' || s.kind === 'relayDefault') return s.kind;
    }
    return null;
  }

  /** What a persona's own settings give in a channel when it has no direct
   *  grant there: the guild-wide level, else the persona default, else the
   *  relay default (a persona with no settings). */
  function fallbackCaps(row) {
    const src = (row && row.sources) || [];
    const pick = (k) => src.find((s) => s.kind === k);
    const s = pick('guildWide') || pick('personaDefault') || pick('relayDefault');
    return s ? s.caps || [] : [];
  }

  /** Is 'Block guild-wide here' worth offering: would guild-wide or a
   *  default give the persona something in this channel? */
  function canBlock(row) {
    const src = (row && row.sources) || [];
    return !src.some((s) => s.kind === 'removed') && fallbackCaps(row).length > 0;
  }

  /**
   * What a persona could do in a channel with its direct grant there set to
   * `direct` (caps; [] a block; null: none) — from its explanation now (a row
   * of …/channels/:cid/access, or null for a persona with nothing there) and
   * the bot's capabilities there. As the relay resolves it: its access roles
   * there, with the direct grant in place of the guild-wide level and the
   * defaults (with none, those apply again); a grant that gives something
   * ends a /ban here, nothing else does; then only what the bot can do.
   * Only used to decide whether to ask first; test/access.test.ts holds it to
   * the relay's own preview.
   */
  function predictDirect(row, botCaps, direct) {
    const src = (row && row.sources) || [];
    if (src.some((s) => s.kind === 'removed') && !(direct && direct.length)) return [];
    const policy = new Set();
    for (const s of src) if (s.kind === 'role') for (const c of s.caps || []) policy.add(c);
    for (const c of direct ? direct : fallbackCaps(row)) policy.add(c);
    const bot = new Set(botCaps || []);
    return ALL_CAPS.filter((c) => policy.has(c) && bot.has(c));
  }

  /**
   * What setting a persona's direct grant in a channel to `direct` would do:
   *   { kind: 'add' | 'raise' | 'lower' | 'same', before, after, from, direct }
   * 'add' when it can't act there now, 'lower' when it would lose anything,
   * 'raise' when it would only gain. `from` is what decides its own access
   * there now (ownSource) — a lowering of guild-wide or a default access is
   * asked about first (needsLowerConfirm). `direct` is the setting asked for.
   */
  function changeKind(row, botCaps, direct) {
    const before = (row && Array.isArray(row.effective)) ? row.effective : [];
    const after = predictDirect(row, botCaps, direct);
    const a = new Set(after);
    const b = new Set(before);
    const lost = before.some((c) => !a.has(c));
    const gained = after.some((c) => !b.has(c));
    let kind = 'raise';
    if (!lost && !gained) kind = 'same';
    else if (!countedLevel(before) && countedLevel(after)) kind = 'add';
    else if (lost) kind = 'lower';
    return { kind, before, after, from: ownSource(row), direct: direct == null ? null : direct };
  }

  const FROM_WORDS = { guildWide: 'guild-wide', personaDefault: 'persona default', relayDefault: 'relay default', direct: 'direct grant' };

  /** Ask before this change? When it gives a direct grant (or a block) that
   *  lowers access that came from guild-wide or a default. */
  function needsLowerConfirm(change, direct) {
    return !!change && direct != null && change.kind === 'lower' &&
      (change.from === 'guildWide' || change.from === 'personaDefault' || change.from === 'relayDefault');
  }

  /** 'This lowers Cass from Write (guild-wide) to Read in #research. Roles still apply.' */
  function lowerText(name, change, where) {
    const from = summaryParts(change.before).text + (FROM_WORDS[change.from] ? ' (' + FROM_WORDS[change.from] + ')' : '');
    const to = change.after.length ? summaryParts(change.after).text : 'no access';
    return 'This lowers ' + name + ' from ' + from + ' to ' + to + ' in ' + where + '. Roles still apply.';
  }

  /** Was the persona removed from this guild (with /ban or Remove from
   *  <guild> — either records the same thing)? From its
   *  explanation in a channel (a row of …/channels/:cid/access, or a
   *  change's answer). */
  function isRemoved(row) {
    return !!row && ((row.sources) || []).some((s) => s.kind === 'removed');
  }

  /** The Add form's 'Currently:' line for a persona picked to add:
   *  'Aria: Write via role g1-chatters — no direct grant needed' · 'Nyx: no
   *  access' · 'Cass: Write via the guild-wide level — this lowers it to Read'
   *  · 'Quill: removed from Guild One — adding it lifts that'
   *  (`removedFrom`: the guild's name, for a persona removed there). A change
   *  that leaves what it can do as it is says what Add does to the persona's
   *  own direct grant here: there is none to add ('no direct grant needed'),
   *  it is already that level, or it changes it and nothing else. */
  function currentlyText(name, row, change, removedFrom) {
    if (removedFrom) return name + ': removed from ' + removedFrom + ' — adding it lifts that';
    const eff = (row && Array.isArray(row.effective)) ? row.effective : [];
    let s = name + ': ';
    if (!eff.length) s += 'no access';
    else {
      const via = viaParts(row, 'the direct grant here');
      s += summaryParts(eff).text + (via.length ? ' via ' + via.join(' and ') : '');
    }
    if (change && eff.length && change.kind === 'same') {
      const own = row && Array.isArray(row.direct) ? row.direct : null;
      const asked = Array.isArray(change.direct) ? change.direct : null;
      if (!own || !asked) s += ' — no direct grant needed';
      else if (sameCapSet(own, asked)) s += ' — the direct grant is already ' + levelLabel(asked);
      else s += ' — this changes its direct grant here to ' + levelLabel(asked) + ', not what it can do here';
    } else if (change && change.kind === 'lower') s += ' — this lowers it to ' + (change.after.length ? summaryParts(change.after).text : 'no access');
    return s;
  }

  /** The same capabilities, in any order. */
  function sameCapSet(a, b) {
    const x = new Set(a || []);
    const y = new Set(b || []);
    return x.size === y.size && Array.from(x).every((c) => y.has(c));
  }

  /** Before a change that gives a persona removed from the guild access
   *  again: 'Quill was removed from Guild One, so nothing it holds applies
   *  there. Giving it Write in #research lifts that: anything it still holds
   *  in Guild One applies again.' Never 'with /ban': the panel's Remove from
   *  <guild> records the same removal, and the page can't tell which it was. */
  function liftText(name, caps, where, guild) {
    return name + ' was removed from ' + guild + ', so nothing it holds applies there. Giving it ' +
      levelLabel(caps) + ' in ' + where + ' lifts that: anything it still holds in ' + guild + ' applies again.';
  }

  /** Both ways to remove a persona from a guild again, once a removal was
   *  lifted: 'To remove it again, use Remove from Guild One or /ban in
   *  Discord.' */
  function removeAgainText(guild) {
    return 'To remove it again, use Remove from ' + guild + ' or /ban in Discord.';
  }

  /** The last line of a confirm that lifts a removal from the guild. */
  const UNDO_KEEPS_LIFT = 'Undo takes the grant away again, but the removal stays lifted.';

  /**
   * A change the relay refused because the persona was removed from the
   * guild after this page read it (409 BANNED: a removal is only lifted when
   * the admin is asked first): 'Not saved: Aria was removed from Guild One
   * since this page was loaded. Reloaded — nothing was changed. To give it
   * access again, try once more: you'll be asked before its removal is
   * lifted.' (`reloaded` false: the page couldn't read it again.)
   */
  function removedSinceText(prefix, name, guild, reloaded) {
    return (prefix || 'Not saved') + ': ' + name + ' was removed from ' + guild + ' since this page was loaded. ' +
      (reloaded === false ? 'Nothing was changed. Reload the page to see that.'
        : 'Reloaded — nothing was changed. To give it access again, try once more: you’ll be asked before its removal is lifted.');
  }

  /**
   * An Undo the relay refused, in words that blame no one:
   *   BANNED   — the persona was removed from the guild after the change;
   *              an Undo never lifts a removal.
   *   CONFLICT — it was changed again since (by this admin too, perhaps).
   * Anything else: errorText. `ctx` is errorText's, with { name, guild }.
   */
  function undoRefusedText(e, ctx) {
    const c = ctx || {};
    if (e && e.code === 'BANNED') {
      return 'Not undone: ' + (c.name || 'it') + ' was removed from ' + (c.guild || 'this guild') + ' after that change, and Undo doesn’t lift a removal. To give it access again, add it again: you’ll be asked first.';
    }
    if (e && e.code === 'CONFLICT') {
      return 'Not undone: it was changed again since. ' + (c.reloaded === false ? 'Reload the page to see it now.' : 'Reloaded — check it, and change it by hand if you need to.');
    }
    return errorText(e, 'Not undone', c);
  }

  /**
   * What a direct-grant change did, in the copy guide's words, from the
   * relay's answer (`ex`, its `effective`): 'Aria → Write in #research.
   * Effective now: Write.' · '… No change to what Aria can do there: Write.'
   * · 'Removed Aria’s direct grant in #research — still Write via role
   * g1-chatters.' · 'Blocked guild-wide access for Aria in #research. …'.
   *   o: { name, next (caps; [] a block; null removed), before (what it could
   *        do there before), ex, where, liftedFrom (the guild's name, when the
   *        change ended its removal from the guild), accessWhere (the channel whose
   *        access applies there, when that is another one: a thread's parent) }
   * An answer without the channel explained (it was deleted meanwhile, or an
   * older relay) says what was done.
   */
  function grantResultText(o) {
    const { name, next, before, ex, where } = o;
    const lifted = o.liftedFrom ? ' That lifted its removal from ' + o.liftedFrom + '.' : '';
    if (!ex || !Array.isArray(ex.effective)) {
      return next == null ? 'Removed ' + name + '’s direct grant in ' + where + '.'
        : name + ' → ' + (next.length ? capsSummary(next) : 'blocked') + ' in ' + where + '.' + lifted;
    }
    const nowText = effectNowText(ex, where);
    if (next == null) {
      const left = remainingText(ex, where, o.accessWhere);
      return 'Removed ' + name + '’s direct grant in ' + where + (left ? ' — ' + left : '') + '.';
    }
    if (!next.length) return 'Blocked guild-wide access for ' + name + ' in ' + where + '. Effective now: ' + nowText + '.';
    // Nothing it can do changed (a role or guild-wide gave it already) — but
    // when the relay's bot is what holds it back, that is the news.
    if (!ex.botLimited && sameCapSet(before, ex.effective)) return name + ' → ' + capsSummary(next) + ' in ' + where + '. No change to what ' + name + ' can do there: ' + nowText + '.' + lifted;
    return name + ' → ' + capsSummary(next) + ' in ' + where + '. Effective now: ' + nowText + '.' + lifted;
  }

  // ── The persona drawer and the Personas list ──────────────────────────────

  const BY_LEVEL = ['full', 'write', 'read', 'custom'];

  /** A persona row's 'Can act in': 'in 14 channels (9 Write · 5 Read)' from
   *  its per-level counts (the summary's), '—' when it can act nowhere, ''
   *  when the counts aren't known. */
  function canActInText(c) {
    if (!c) return '';
    const n = countsTotal(c);
    if (!n) return '—';
    return 'in ' + plural(n, 'channel') + ' (' + BY_LEVEL.filter((k) => c[k]).map((k) => c[k] + ' ' + LEVEL_NAME[k]).join(' · ') + ')';
  }

  /** The persona drawer's summary line: 'Write in 3 · Read in 12 channels
   *  here' (the last number names the unit), or 'No access here'. */
  function personaSummaryText(c) {
    const parts = BY_LEVEL.filter((k) => c && c[k]).map((k) => ({ k, n: c[k] }));
    if (!parts.length) return 'No access here';
    const last = parts[parts.length - 1];
    return parts.map((p) => LEVEL_NAME[p.k] + ' in ' + p.n).join(' · ') + (last.n === 1 ? ' channel here' : ' channels here');
  }

  /** What makes two access rows read alike: the same capabilities, cut down
   *  by the bot alike, for the same reasons (and the same direct grant). */
  function rowSignature(row) {
    const caps = (xs) => sortCaps(xs || []).join(',');
    const src = ((row && row.sources) || []).map((s) => [s.kind, s.name || '', s.shadowedBy || '', caps(s.caps)].join(':')).sort();
    return [caps(row && row.effective), row && row.botLimited ? 'limited' : '', row && Array.isArray(row.direct) ? caps(row.direct) + '!' : '-', src.join('|')].join('#');
  }

  /**
   * The persona drawer's table, folded: rows that read alike (rowSignature)
   * six times or more are one line each — 'Write in 240 channels · via role
   * g1-everyone' — with the rows under it (shown on request); every other row
   * is on its own. `rows` in the order the table lists them.
   *   → { runs: [{ key, rows, text }] (largest first), rest: [rows] }
   */
  function foldAccessRows(rows, min) {
    const at = min == null ? 6 : min;
    const bySig = new Map();
    for (const r of rows || []) {
      const k = rowSignature(r);
      if (!bySig.has(k)) bySig.set(k, []);
      bySig.get(k).push(r);
    }
    const runs = [];
    const folded = new Set();
    for (const [key, rs] of bySig) {
      if (rs.length < at) continue;
      for (const r of rs) folded.add(r);
      runs.push({ key, rows: rs, text: runText(rs[0], rs.length) });
    }
    runs.sort((a, b) => b.rows.length - a.rows.length);
    return { runs, rest: (rows || []).filter((r) => !folded.has(r)) };
  }

  /** 'Write in 240 channels · via role g1-everyone' · 'Read (bot-limited) in
   *  17 channels · via role g1-everyone' · 'Write in 6 channels · via direct
   *  grants'. */
  function runText(row, n) {
    const eff = (row && row.effective) || [];
    const via = viaParts(row, 'direct grants');
    return (eff.length ? levelLabel(eff) : 'No access') + (row && row.botLimited ? ' (bot-limited)' : '') + ' in ' + plural(n, 'channel') +
      (via.length ? ' · via ' + via.join(' and ') : '');
  }

  /** A direct grant that does nothing, as the persona drawer lists it (an
   *  item of …/personas/:pid/access `inactive`): 'design-review — thread;
   *  uses #research’s access' · 'Research — category' · 'deleted channel, or
   *  one the relay can’t see' · '#random — blocks nothing (no guild-wide or
   *  persona default to block)'. */
  function inactiveText(item, names) {
    const l = (names && names.channels && names.channels[item.channelId]) || {};
    const name = l.name || null;
    switch (item.reason) {
      case 'thread': return (name || 'a thread') + ' — thread; uses ' + (l.parentName ? '#' + l.parentName : 'its channel') + '’s access';
      case 'category': return (name || 'a category') + ' — category';
      case 'blocks-nothing': return chanText(item.channelId, names) + ' — blocks nothing (no guild-wide or persona default to block)';
      default: return 'deleted channel, or one the relay can’t see';
    }
  }

  /**
   * The confirm before "Remove from <guild>", from what the persona's access
   * read showed (…/personas/:pid/access): what goes, that other guilds stay
   * as they are, and that only an admin of the guild can give it access there
   * again. → { title, body, confirmLabel, grants } (`grants`: how many direct
   * grants go, for the result line).
   */
  function removeConfirm(name, guild, access) {
    const a = access || {};
    const roles = (a.roles || []).map((r) => r.name);
    const grants = (a.rows || []).filter((r) => Array.isArray(r.direct)).length + (a.inactive || []).filter((x) => x.reason !== 'blocks-nothing').length;
    const parts = [];
    if (roles.length) parts.push((roles.length === 1 ? 'access role ' : 'access roles ') + roles.join(', '));
    if (grants) parts.push(plural(grants, 'direct grant'));
    return {
      title: 'Remove ' + name + ' from ' + guild + '?',
      body: [
        (parts.length ? 'This removes ' + parts.join(' and ') + ', and denies' : 'This denies') + ' guild-wide access here.',
        name + ' can’t give itself access here again — claiming an invite won’t bring it back. Only an admin of ' + guild + ' can, by giving it access here.',
        'Other guilds are not affected. You can add ' + name + ' back later.',
      ],
      confirmLabel: 'Remove from ' + guild,
      grants,
    };
  }

  /** What "Remove from <guild>" did, from the relay's answer: 'Removed Quill
   *  from Guild One: access role g1-mods-mirror and 1 direct grant are gone,
   *  and guild-wide access is denied. No remaining access in Guild One.' */
  function removedText(name, guild, r) {
    const roles = (r && r.rolesRemoved) || [];
    const grants = (r && r.grants) || 0;
    const parts = [];
    if (roles.length) parts.push((roles.length === 1 ? 'access role ' : 'access roles ') + roles.join(', '));
    if (grants) parts.push(plural(grants, 'direct grant'));
    const gone = parts.length ? parts.join(' and ') + (roles.length + grants === 1 ? ' is' : ' are') + ' gone, and guild-wide access is denied' : 'guild-wide access is denied';
    if (r && r.accessFullyRevoked === false) {
      return 'Removed ' + name + ' from ' + guild + ' (' + gone + '), but access still resolves in ' + guild + ' — this should be impossible; please report it.';
    }
    return 'Removed ' + name + ' from ' + guild + ': ' + gone + '. No remaining access in ' + guild + '.';
  }

  /** What the direct-grant control's Custom option reads when a custom set
   *  is stored: 'Write +1 (custom)' · 'Custom' · 'Custom — can’t see the
   *  channel' (a set without View). */
  function customOptionText(caps) {
    const l = levelLabel(caps);
    if (l !== LEVEL_NAME.custom) return l + ' (custom)';
    return new Set(caps || []).has('VIEW_CHANNEL') ? l : l + ' — can’t see the channel';
  }

  // ── Names ─────────────────────────────────────────────────────────────────
  // `names` is the API's name map ({channels, discordRoles, guilds, personas},
  // keyed by id), optionally folded with the guild's live channel list.

  /** '#general' · 'lounge (voice)' · 'ideas (forum)' · 'Research (category)' ·
   *  'design-review (thread in #research)' · 'deleted channel' — or the id
   *  when nothing is known about it. */
  function chanText(cid, names) {
    const l = names && names.channels && names.channels[cid];
    if (!l) return String(cid);
    if (l.unavailable || l.hidden) return 'channel the relay can’t see';
    if (l.missing) return 'deleted channel';
    if (!l.name) return String(cid);
    switch (l.type) {
      case 'category': return l.name + ' (category)';
      case 'voice': return l.name + ' (voice)';
      case 'forum': return l.name + ' (forum)';
      case 'unknown': return l.name + ' (other kind)';
      case 'thread': return l.name + (l.parentName ? ' (thread in #' + l.parentName + ')' : ' (thread)');
      default: return '#' + l.name;
    }
  }

  /** '@Mods' (the id when the role is unknown). */
  function roleText(rid, names) {
    const l = names && names.discordRoles && names.discordRoles[rid];
    if (!l || !l.name) return String(rid);
    return l.name.charAt(0) === '@' ? l.name : '@' + l.name;
  }

  function guildText(gid, names) {
    return (names && names.guilds && names.guilds[gid]) || String(gid);
  }

  /** '1 channel', '2 channels'. */
  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many || one + 's');
  }

  /** 'a', 'a or b', 'a, b or c'. */
  function orList(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' or ' + items[items.length - 1];
  }

  /**
   * Where a scope applies, as a phrase: 'in #general, #research',
   * 'in 12 channels', 'in every channel of Guild One', 'wherever @Mods can
   * see'. Up to `max` channels (default 3) are named; more are counted.
   */
  function wherePhrase(scope, names, guildId, max) {
    const most = max == null ? 3 : max;
    if (!scope || typeof scope !== 'object') return 'nowhere';
    if (scope.all === true) return 'in every channel of ' + (guildId ? guildText(guildId, names) : 'its guild');
    if (Array.isArray(scope.channels)) {
      const n = scope.channels.length;
      if (!n) return 'in no channel';
      if (n > most) return 'in ' + plural(n, 'channel');
      return 'in ' + scope.channels.map((c) => chanText(c, names)).join(', ');
    }
    const ids = Array.isArray(scope.mirrorRoles) ? scope.mirrorRoles : typeof scope.mirrorRole === 'string' ? [scope.mirrorRole] : null;
    if (ids) return ids.length ? 'wherever ' + orList(ids.map((r) => roleText(r, names))) + ' can see' : 'nowhere';
    return 'nowhere';
  }

  function isMirror(scope) {
    return !!scope && (typeof scope.mirrorRole === 'string' || Array.isArray(scope.mirrorRoles));
  }

  /** The Discord roles a mirror scope follows, as '@Mods or @Researchers'. */
  function mirrorText(scope, names) {
    const ids = Array.isArray(scope.mirrorRoles) ? scope.mirrorRoles : [scope.mirrorRole];
    return orList(ids.map((r) => roleText(r, names)));
  }

  /** An access role's level column: 'Write', or for a role that follows each
   *  channel's Discord permissions, 'Mirrors @Mods · Full' (Full at most). */
  function roleLevelText(role, names) {
    if (!role) return '—';
    if (isMirror(role.scope) && role.mirrorCaps) return 'Mirrors ' + mirrorText(role.scope, names) + ' · ' + levelLabel(role.caps);
    return levelLabel(role.caps);
  }

  /**
   * An access role in one line, for pickers and chips: 'Write in 2
   * channels', 'Write in #general', 'Read in every channel of Guild One',
   * 'Full wherever @Mods can see', 'Mirrors @Mods · Full'.
   */
  function roleMeaning(role, names) {
    if (!role) return 'no longer defined';
    const sc = role.scope;
    if (isMirror(sc)) {
      return role.mirrorCaps ? roleLevelText(role, names) : levelLabel(role.caps) + ' ' + wherePhrase(sc, names, role.guildId);
    }
    return levelLabel(role.caps) + ' ' + wherePhrase(sc, names, role.guildId, 1);
  }

  /**
   * Defining an access role under a name that is taken. Names are shared by
   * every guild and the relay replaces a role of the same name wherever it
   * belongs, so creating it again from another guild would move it there:
   * its holders would lose its access in its own guild. So:
   *   another guild's role → { refuse: 'Not created: Guild Two already has …' }
   *   this guild's role    → { title, body, confirmLabel } for the confirm
   *                          that edits it (the relay replaces it only when
   *                          asked to, naming the guild it belongs to).
   * `names` should name the existing role's guild, channels and Discord roles
   * (the roles endpoint's ?names=1); a guild it can't name is 'another guild'.
   */
  function roleNameTaken(name, existing, role, guildId, names) {
    const owner = existing && existing.guildId;
    if (owner !== guildId) {
      const known = owner ? names && names.guilds && names.guilds[owner] : null;
      // Its meaning, with no id standing in for a guild that has no name.
      const n = Object.assign({}, names, { guilds: Object.assign({}, names && names.guilds) });
      if (owner && !known) n.guilds[owner] = 'that guild';
      const then = known ? ', or switch to ' + known + ' to change it there'
        : owner ? ', or switch to that guild (id ' + owner + ') to change it there' : '';
      return {
        refuse: 'Not created: ' + (known || 'another guild') + ' already has an access role named ' + name +
          ' (' + roleMeaning(existing, n) + '), and access role names are shared by every guild. Pick another name' + then + '.',
      };
    }
    return {
      title: 'A role named ' + name + ' already exists — edit it instead?',
      body: 'It is ' + guildText(guildId, names) + '’s access role ' + name + ' (' + roleMeaning(existing, names) +
        '). Editing it to this definition gives every persona that holds it ' + roleMeaning(role, names) +
        ' instead. This can’t be undone; to go back, define it again as it was.',
      confirmLabel: 'Edit access role',
    };
  }

  /**
   * What an invite confers: 'roles: g1-chatters · Write in #general'.
   * Roles AND grant, whichever it carries (slash /invite stores both).
   */
  function grantSummary(inv, names) {
    const parts = [];
    if (inv && Array.isArray(inv.roles) && inv.roles.length) parts.push('roles: ' + inv.roles.join(', '));
    if (inv && inv.grant) parts.push(levelLabel(inv.grant.caps) + ' ' + wherePhrase(inv.grant.scope, names, inv.guildId));
    if (inv && !inv.grant && Array.isArray(inv.caps) && inv.caps.length) parts.push(levelLabel(inv.caps) + ' everywhere (old-style invite)');
    return parts.length ? parts.join(' · ') : 'no access';
  }

  // ── Invites ───────────────────────────────────────────────────────────────

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** 'Thu 23 Oct' in local time; the year is added when it isn't now's. */
  function shortDate(when, now) {
    const d = new Date(when);
    if (isNaN(d.getTime())) return '?';
    const n = new Date(now == null ? d.getTime() : now);
    const s = DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
    return d.getFullYear() === n.getFullYear() ? s : s + ' ' + d.getFullYear();
  }

  /** 'Single use' · 'Up to 5 uses' · 'Unlimited uses'. */
  function usesText(maxUses) {
    if (typeof maxUses !== 'number') return 'Unlimited uses';
    return maxUses === 1 ? 'Single use' : 'Up to ' + maxUses + ' uses';
  }

  /** '0 of 1 used' · '3 used' (no limit). */
  function usedText(inv) {
    const used = (inv && inv.uses) || 0;
    return typeof (inv && inv.maxUses) === 'number' ? used + ' of ' + inv.maxUses + ' used' : used + ' used';
  }

  /** Who may use an invite: 'A new agent' · 'An existing persona' · 'Either'. */
  function modeText(mode) {
    return mode === 'augment' ? 'An existing persona' : mode === 'both' ? 'Either' : 'A new agent';
  }

  /** 'Single use · expires Thu 23 Oct · roles: g1-readers'. */
  function inviteSummary(inv, names, now) {
    const expires = inv && inv.expiresAt ? 'expires ' + shortDate(inv.expiresAt, now) : 'never expires';
    return [usesText(inv && inv.maxUses), expires, grantSummary(inv, names)].join(' · ');
  }

  /** An invite's status from the relay, as the list shows it. */
  function inviteStatusText(status) {
    return status === 'used' ? 'Used up' : status === 'expired' ? 'Expired' : status === 'active' ? 'Active' : '—';
  }

  // ── Refusals ──────────────────────────────────────────────────────────────

  const NOT_GUILD_ADMIN = 'You’re not an admin of this guild, or we couldn’t verify your Discord permissions right now.';

  /**
   * Did the request get no answer from the relay itself? Not when the
   * connection failed (NETWORK), and not when the proxy in front of it
   * (Caddy) answered in its place: a 5xx without the relay's error body —
   * 502 or 504 when the relay went away mid-request (a crash or a restart,
   * perhaps just after it stored the change), 502 or 503 when it isn't
   * running. The relay's own answers always carry a code.
   */
  function noAnswer(e) {
    return !!e && (e.code === 'NETWORK' || (!e.code && e.status >= 500));
  }

  /**
   * A failed change as its status line: '<prefix>: <reason>. <what to do>.'
   * `e` is the API error ({status, code, message, method, …the error body's
   * fields}), `ctx` what the request was about: { channelId, names } for a
   * grant, { roleName } for an access role. The relay's codes get the copy
   * guide's words; anything else says what the relay said.
   *
   * No answer from the relay (noAnswer): a read that failed changed nothing,
   * but a change may have been made before the answer was lost — so it says
   * to look before trying again (another try could mint a second invite).
   * The same for the relay's own INTERNAL error on a change: it can come
   * after the change was stored (say, writing its audit record failed).
   */
  function errorText(e, prefix, ctx) {
    const p = prefix || 'Not saved';
    const c = ctx || {};
    const code = e && e.code;
    const label = c.channelId && c.names && c.names.channels ? c.names.channels[c.channelId] : null;
    const bare = (label && label.name) || 'That channel';
    const read = !!e && e.method === 'GET';
    if (noAnswer(e)) {
      return read
        ? 'Couldn’t reach the relay. Nothing was changed. Try again.'
        : 'The relay didn’t answer, so this change may or may not have been made. Reload the page and check before you try again.';
    }
    if (!read && code === 'INTERNAL') {
      return 'The relay ran into an error, so this change may or may not have been made. Reload the page and check before you try again.';
    }
    switch (code) {
      case 'RATE_LIMITED': return 'Paused for a few seconds (rate limit).';
      case 'CSRF': return p + ': this page’s security token is out of date. Reload the page and try again.';
      case 'THREAD_TARGET': {
        const parentId = (e && e.parentId) || (label && label.parentId);
        const parent = parentId ? chanText(parentId, c.names) : 'its channel';
        return p + ': ' + bare + ' is a thread. Threads use ' + parent + '’s access — give access there.';
      }
      case 'CATEGORY_TARGET': return p + ': ' + bare + ' is a category. Pick its channels instead.';
      case 'NOT_GRANTABLE': return p + ': ' + (label ? chanText(c.channelId, c.names) : 'that channel') + ' can’t hold access. Pick a text, voice or forum channel.';
      case 'EMPTY_CAPS': return p + ': pick a level, or use Remove.';
      case 'UNKNOWN_CAP': return p + ': the relay doesn’t know one of these capabilities. Reload the page and try again.';
      case 'TARGET_REQUIRED': return p + ': this page is out of date. Reload the page and try again.';
      case 'EXISTS': return 'A role named ' + (c.roleName || 'that') + ' already exists — edit it instead?';
      case 'GUILD_MISMATCH': return p + ': ' + (c.roleName ? 'access role ' + c.roleName : 'that access role') + ' belongs to another guild now. Reload the page and try again.';
      case 'INVALID_NAME': return p + ': an access role name uses lower-case letters, digits, dots, dashes and underscores (up to 64), starting with a letter or digit.';
      case 'BANNED': return p + ': it was removed from this guild since this page was loaded. Reload the page to see that, then try again.';
      // The change was made against what this page loaded, and that changed.
      case 'CONFLICT': return p + ': someone else changed this a moment ago. ' + (c.reloaded ? 'Reloaded — check and try again.' : 'Reload the page and try again.');
      default: break;
    }
    if (e && e.status === 401) return p + ': your session ended. Sign in again, then save it.';
    if (code === 'FORBIDDEN' && e.reason === 'NOT_GUILD_ADMIN') return NOT_GUILD_ADMIN;
    const why = String((e && e.message) || 'something went wrong').trim().replace(/[.\s]+$/, '');
    return p + ': ' + why + '.';
  }

  // ── Routes ────────────────────────────────────────────────────────────────
  // Every place in the panel has an address after '#' (Caddy serves one page,
  // so the path can't carry it):
  //
  //   #/                                   home: the last guild and tab
  //   #/g/{gid}/channels[?q&show&cat]      #/g/{gid}/channels/c/{cid}
  //   #/g/{gid}/personas[?q]               #/g/{gid}/personas/p/{pid} · …/personas/add
  //   #/g/{gid}/give[?p&c&lvl]
  //   #/g/{gid}/invites[?status&q]         #/g/{gid}/invites/new[?c&lvl&r] · …/invites/i/{inviteId}
  //   #/g/{gid}/roles[?q]                  #/g/{gid}/roles/r/{name} · …/roles/new
  //   #/g/{gid}/audit[?q&actor&persona&channel&action&reads]
  //   #/all/personas[?q&guild]             #/all/personas/p/{pid}[?guild]
  //   #/all/audit[?guild&q&actor&…]        #/guilds
  //
  // A route is { area: 'home' | 'g' | 'all' | 'guilds', gid, view, drawer,
  // query }: `drawer` is null or { kind, id? } (the panel open over the list),
  // `query` the leaf's parameters (the list's, or the drawer's when one is
  // open). Ids are checked here, so a link can't carry anything else; an
  // invite appears only as the hash of its code, never as the code — and a
  // search that looks like one (inv_…) is kept as its first 12 characters,
  // as the audit shows codes. Unknown query keys are dropped; a bad value
  // makes the whole route invalid (null). The lists' search boxes keep ?q= on
  // every list, not only the ones above that list it. On #/all/personas,
  // ?guild= is the guild in view: the scope switch's, and the one an open
  // persona's 'Access in <guild>' is about.

  const SNOWFLAKE = /^\d{5,25}$/;
  /** Any id the relay can hold (operators choose some by hand: spaces, '+'
   *  and the like), so every persona has an address: up to 100 characters,
   *  none of them a control character. */
  const PERSONA_ID = /^[^\u0000-\u001f\u007f]{1,100}$/;
  const INVITE_ID = /^[0-9a-f]{24}$/;
  const MAX_IDS = 20;
  const MAX_TEXT = 200;
  /** How much of an invite code an address may hold: what the audit shows. */
  const CODE_SHOWN = 12;

  const isSnowflake = (s) => typeof s === 'string' && SNOWFLAKE.test(s);
  const isPersonaId = (s) => typeof s === 'string' && PERSONA_ID.test(s) && s !== '.' && s !== '..';

  /** Search text as an address may hold it: a whole invite code (inv_…) is
   *  cut to the first 12 characters — the audit's own prefix, which still
   *  finds it — so a code never lands in the history or a shared link. */
  function addressText(v) {
    return /^inv_/i.test(v) && v.length > CODE_SHOWN ? v.slice(0, CODE_SHOWN) : v;
  }
  const isRoleName = (s) => typeof s === 'string' && s.length >= 1 && s.length <= 64 && s.indexOf('/') < 0 && s !== '.' && s !== '..';

  /** Query value kinds: one id, a list of ids, free text, or one of a set. */
  const ONE = { gid: isSnowflake, cid: isSnowflake, uid: isSnowflake, pid: isPersonaId, role: isRoleName };
  const AUDIT_ACTIONS = ['access', 'roles', 'invites', 'sessions', 'identity'];
  const AUDIT_QUERY = { q: 'text', actor: 'uid', persona: 'pid', channel: 'cid', action: AUDIT_ACTIONS, reads: ['1'] };

  /** The grammar: area → view → { query, drawers: segment → { kind, id?, query? } }.
   *  Query keys are listed in the order formatRoute writes them. */
  const GRAMMAR = {
    g: {
      channels: { query: { q: 'text', show: ['all', 'agents', 'empty'], cat: 'cid' }, drawers: { c: { kind: 'channel', id: 'cid' } } },
      personas: { query: { q: 'text' }, drawers: { p: { kind: 'persona', id: 'pid' }, add: { kind: 'add' } } },
      give: { query: { p: 'pid[]', c: 'cid[]', lvl: LEVELS } },
      invites: {
        query: { status: ['active', 'spent', 'all'], q: 'text' },
        drawers: { new: { kind: 'mint', query: { c: 'cid', lvl: LEVELS, r: 'role[]' } }, i: { kind: 'invite', id: 'invite' } },
      },
      roles: { query: { q: 'text' }, drawers: { r: { kind: 'role', id: 'role' }, new: { kind: 'newRole' } } },
      audit: { query: AUDIT_QUERY },
    },
    all: {
      personas: { query: { q: 'text', guild: 'gid' }, drawers: { p: { kind: 'persona', id: 'pid', query: { guild: 'gid' } } } },
      audit: { query: Object.assign({ guild: 'gid' }, AUDIT_QUERY) },
    },
  };
  const ID_CHECK = { cid: isSnowflake, pid: isPersonaId, role: isRoleName, invite: (s) => typeof s === 'string' && INVITE_ID.test(s) };

  /** encodeURIComponent, plus the five characters it leaves alone, so every
   *  address fits isSafeReturnTo's character set; ':' (in persona ids) stays
   *  readable. */
  function enc(s) {
    return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%3A/g, ':');
  }
  /** A path segment, decoded (null when it doesn't decode). */
  function dec(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return null;
    }
  }
  /** A query key or value: '+' is a space there, as in any query string. */
  const decQ = (s) => dec(s.replace(/\+/g, ' '));

  /** One query value, checked: the value to keep, or undefined when it is bad.
   *  `raw` is still encoded, so a list splits on real commas only. */
  function queryValue(kind, raw) {
    if (Array.isArray(kind)) {
      const v = decQ(raw);
      return kind.indexOf(v) >= 0 ? v : undefined;
    }
    if (kind === 'text') {
      const v = decQ(raw);
      if (v == null || v.length > MAX_TEXT) return undefined;
      return addressText(v.trim());
    }
    if (kind.slice(-2) === '[]') {
      const check = ONE[kind.slice(0, -2)];
      const items = raw.split(',').map(decQ);
      if (items.length > MAX_IDS || items.some((x) => x == null || !check(x))) return undefined;
      return items.filter((x, i) => items.indexOf(x) === i);
    }
    const v = decQ(raw);
    return v != null && ONE[kind](v) ? v : undefined;
  }

  /** The query string after '?', against `spec`: { ok, query }. */
  function parseQuery(text, spec) {
    const query = {};
    if (!text) return { ok: true, query };
    for (const part of text.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const key = decQ(eq < 0 ? part : part.slice(0, eq));
      const raw = eq < 0 ? '' : part.slice(eq + 1);
      if (key == null) return { ok: false };
      if (!spec || !Object.prototype.hasOwnProperty.call(spec, key)) continue; // unknown: dropped
      if (Object.prototype.hasOwnProperty.call(query, key)) continue; // the first one counts
      if (raw === '') continue; // empty: as if absent
      const v = queryValue(spec[key], raw);
      if (v === undefined) return { ok: false };
      if (v === '' || (Array.isArray(v) && !v.length)) continue;
      query[key] = v;
    }
    return { ok: true, query };
  }

  /** '#/g/…' → a route, area 'home' for '#/' (or nothing), or null when
   *  it isn't one of the panel's addresses. */
  function parseRoute(hash) {
    if (typeof hash !== 'string') return null;
    if (hash === '' || hash === '#' || hash === '#/') return { area: 'home', gid: null, view: null, drawer: null, query: {} };
    if (hash.length > 2048 || hash.slice(0, 2) !== '#/') return null;
    const qi = hash.indexOf('?');
    const path = qi < 0 ? hash.slice(2) : hash.slice(2, qi);
    const qtext = qi < 0 ? '' : hash.slice(qi + 1);
    const raw = path.split('/');
    if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop(); // one trailing '/' is fine
    const segs = [];
    for (const s of raw) {
      const d = dec(s);
      if (d == null || d === '' || d === '.' || d === '..') return null;
      segs.push(d);
    }
    let area = segs[0];
    let gid = null;
    let rest;
    if (area === 'guilds') {
      if (segs.length !== 1) return null;
      return { area: 'guilds', gid: null, view: 'guilds', drawer: null, query: {} };
    }
    if (area === 'g') {
      gid = segs[1];
      if (!isSnowflake(gid)) return null;
      rest = segs.slice(2);
    } else if (area === 'all') {
      rest = segs.slice(1);
    } else return null;
    const views = GRAMMAR[area];
    const view = rest[0];
    if (!view || !Object.prototype.hasOwnProperty.call(views, view)) return null;
    const v = views[view];
    let drawer = null;
    let spec = v.query;
    if (rest.length > 1) {
      const d = v.drawers && Object.prototype.hasOwnProperty.call(v.drawers, rest[1]) ? v.drawers[rest[1]] : null;
      if (!d) return null;
      if (d.id) {
        if (rest.length !== 3 || !ID_CHECK[d.id](rest[2])) return null;
        drawer = { kind: d.kind, id: rest[2] };
      } else {
        if (rest.length !== 2) return null;
        drawer = { kind: d.kind };
      }
      spec = d.query || null;
    }
    const q = parseQuery(qtext, spec);
    if (!q.ok) return null;
    return { area, gid, view, drawer, query: q.query };
  }

  /** A route → its address, canonical: parseRoute(formatRoute(r)) is r, and
   *  formatRoute(parseRoute(h)) is h for any canonical h. Null for a route
   *  this grammar can't write. */
  function formatRoute(r) {
    if (!r || typeof r !== 'object') return null;
    if (r.area === 'home') return '#/';
    if (r.area === 'guilds') return '#/guilds';
    const views = GRAMMAR[r.area];
    if (!views || !Object.prototype.hasOwnProperty.call(views, r.view)) return null;
    if (r.area === 'g' && !isSnowflake(r.gid)) return null;
    const v = views[r.view];
    let path = r.area === 'g' ? '#/g/' + r.gid + '/' + r.view : '#/all/' + r.view;
    let spec = v.query;
    if (r.drawer) {
      const seg = Object.keys(v.drawers || {}).find((k) => v.drawers[k].kind === r.drawer.kind);
      if (!seg) return null;
      const d = v.drawers[seg];
      path += '/' + seg;
      if (d.id) {
        if (!ID_CHECK[d.id](r.drawer.id)) return null;
        path += '/' + enc(r.drawer.id);
      }
      spec = d.query || null;
    }
    const parts = [];
    const query = r.query || {};
    for (const k of Object.keys(spec || {})) {
      const val = query[k];
      if (val == null || val === '' || (Array.isArray(val) && !val.length)) continue;
      const one = spec[k] === 'text' ? addressText(String(val)) : val;
      parts.push(k + '=' + (Array.isArray(one) ? one.map(enc).join(',') : enc(one)));
    }
    return parts.length ? path + '?' + parts.join('&') : path;
  }

  /** May `s` (from sessionStorage) be a place to return to after sign-in? Only
   *  a panel address in a narrow character set; it is only ever parsed into a
   *  route, never assigned to location. */
  function isSafeReturnTo(s) {
    // The same length limit as parseRoute (2048 in all), so any address the
    // panel routes to can be come back to after a sign-in.
    return typeof s === 'string' && /^#\/[A-Za-z0-9/%._~?=&,:-]{0,2046}$/.test(s) && parseRoute(s) !== null;
  }

  // ── Drafts ────────────────────────────────────────────────────────────────
  // A form's unsaved state, kept in sessionStorage across "Sign in again" and
  // put back when the same admin returns to the same place within 30 minutes.
  // Only the fields listed here are kept: never an invite code, a token, a
  // picture or anything a reveal showed.

  const CAP_NAME = /^[A-Z][A-Z0-9_]{0,40}$/;
  const FIELD = {
    text: (v) => typeof v === 'string' && v.length <= 500,
    snowflake: isSnowflake,
    snowflakes: (v) => Array.isArray(v) && v.length <= 500 && v.every(isSnowflake),
    roles: (v) => Array.isArray(v) && v.length <= 500 && v.every(isRoleName),
    caps: (v) => Array.isArray(v) && v.length <= 64 && v.every((c) => typeof c === 'string' && CAP_NAME.test(c)),
    digits: (v) => typeof v === 'string' && /^\d{0,9}$/.test(v),
    target: (v) => v === '__guild__' || isSnowflake(v),
  };
  const oneOf = (xs) => (v) => xs.indexOf(v) >= 0;

  /** Per form: field → check. */
  const DRAFT_FORMS = {
    // The mint drawer (never the minted code).
    mint: {
      label: FIELD.text, kind: oneOf(['roles', 'channels', 'mirror']), roles: FIELD.roles, channels: FIELD.snowflakes,
      mirrorRole: FIELD.snowflake, caps: FIELD.caps, uses: oneOf(['1', '5', '25', 'unlimited', 'other']), usesOther: FIELD.digits,
      expires: oneOf(['1', '7', '30', 'never']), mode: oneOf(['mint', 'augment', 'both']),
    },
    // The persona drawer's guild-wide level (More): whose, and what level.
    // (An older panel kept one channel here too; it comes back in Add to channels.)
    grant: { personaId: isPersonaId, target: FIELD.target, caps: FIELD.caps },
    // The channel drawer's Add form: whom to add (at most 10) and at what level.
    chanAdd: { personas: (v) => Array.isArray(v) && v.length <= 10 && v.every(isPersonaId), caps: FIELD.caps },
    // The persona drawer's Add to channels: whose, where (at most 50) and what level.
    personaAdd: { personaId: isPersonaId, channels: (v) => Array.isArray(v) && v.length <= 50 && v.every(isSnowflake), caps: FIELD.caps },
    // A Custom… editor open in a row of either drawer, not applied: whose
    // direct grant, in which channel, and the boxes ticked. It comes back
    // open, never applied.
    dgCustom: { personaId: isPersonaId, channelId: isSnowflake, caps: FIELD.caps, base: (v) => v === null || FIELD.caps(v) },
    // Defining an access role.
    role: {
      name: FIELD.text, where: oneOf(['all', 'channels', 'mirrorRole', 'mirrorRoles']), channels: FIELD.snowflakes,
      mirrorRole: FIELD.snowflake, mirrorRoles: FIELD.snowflakes, caps: FIELD.caps,
    },
  };
  const DRAFT_MAX_AGE = 30 * 60_000;

  /** The fields of `form` a draft may keep: the listed ones, when well-formed. */
  function draftFields(form, fields) {
    const schema = Object.prototype.hasOwnProperty.call(DRAFT_FORMS, form) ? DRAFT_FORMS[form] : null;
    const out = {};
    if (!schema || !fields || typeof fields !== 'object') return out;
    for (const k of Object.keys(schema)) {
      if (Object.prototype.hasOwnProperty.call(fields, k) && schema[k](fields[k])) out[k] = Array.isArray(fields[k]) ? fields[k].slice() : fields[k];
    }
    return out;
  }

  /** { v: 1, userId, route, form, fields, at }, or null when it can't be one. */
  function makeDraft(o) {
    if (!o || typeof o.userId !== 'string' || !o.userId || !isSafeReturnTo(o.route)) return null;
    if (!Object.prototype.hasOwnProperty.call(DRAFT_FORMS, o.form) || typeof o.at !== 'number') return null;
    return { v: 1, userId: o.userId, route: o.route, form: o.form, fields: draftFields(o.form, o.fields), at: o.at };
  }

  /** A stored draft (an object or its JSON) if it is this admin's and younger
   *  than 30 minutes; otherwise null. */
  function readDraft(stored, o) {
    let d = stored;
    if (typeof d === 'string') {
      try {
        d = JSON.parse(d);
      } catch {
        return null;
      }
    }
    if (!d || typeof d !== 'object' || d.v !== 1 || !o || typeof o.userId !== 'string' || d.userId !== o.userId) return null;
    if (typeof d.at !== 'number' || !(o.now - d.at >= 0) || o.now - d.at > DRAFT_MAX_AGE) return null;
    return makeDraft(d);
  }

  // ── Sign-in errors ────────────────────────────────────────────────────────

  /** ?login_error=<code> → what the sign-in card says. Only these words are
   *  ever shown: nothing from the URL reaches the page. */
  const LOGIN_ERRORS = {
    cancelled: 'Sign-in was cancelled in Discord.',
    expired: 'That sign-in took too long or the relay restarted. Try again.',
    mismatch: 'Sign-in was started in another tab. Try again here.',
    discord_error: 'Discord didn’t respond. Try again in a minute.',
    rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
    not_admin: 'You don’t manage any guild this relay serves. Ask the server owner for Manage Server, or ask the relay operator to add you.',
    // What a relay without the codes above sends.
    failed: 'Sign-in didn’t finish: it was cancelled, took too long, or was started in another tab. Try again.',
    discord: 'Discord didn’t respond. Try again in a minute.',
  };

  /** null when there is no code; a generic line for a code not in the table. */
  function loginErrorText(code) {
    if (code == null) return null;
    return Object.prototype.hasOwnProperty.call(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code] : 'Sign-in didn’t finish. Try again.';
  }

  PA.lib = {
    LEVEL_CAPS, ALL_CAPS, LEVELS, LEVEL_NAME, LEVEL_HELP, CAP_LABEL, CAP_WORDS, CAP_GROUPS, adoptModel,
    sortCaps, levelOf, levelLabel, capsWords, capsSummary, capsTitle, isGrantableType, holdsAccess,
    botLimitText, effectNowText, remainingText, guildEffectText,
    countedLevel, countsTotal, countsText, countsFromRows, botListNote, botListTitle, botBannerText, agoText,
    channelLayout, filterLayout, channelTitle, channelBadge, OTHER_KIND_HELP, sourceChips, pillText, directValue,
    ownSource, fallbackCaps, canBlock, predictDirect, changeKind, needsLowerConfirm, lowerText, isRemoved, currentlyText, sameCapSet, liftText, removeAgainText, customOptionText,
    UNDO_KEEPS_LIFT, removedSinceText, undoRefusedText, grantResultText, canActInText, personaSummaryText, rowSignature, foldAccessRows, runText, inactiveText, removeConfirm, removedText,
    chanText, roleText, guildText, plural, wherePhrase, isMirror, roleLevelText, roleMeaning, roleNameTaken, grantSummary,
    shortDate, usesText, usedText, modeText, inviteSummary, inviteStatusText,
    NOT_GUILD_ADMIN, noAnswer, errorText,
    isSnowflake, isPersonaId, isRoleName, parseRoute, formatRoute, isSafeReturnTo, addressText,
    DRAFT_FORMS, draftFields, makeDraft, readDraft, loginErrorText,
  };
})(typeof window !== 'undefined' ? window : globalThis);
