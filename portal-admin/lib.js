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
 *   isGrantableType                    which channels can hold a direct grant
 *   chanText, roleText, wherePhrase    ids → names ('#general', '@Mods')
 *   roleMeaning, roleLevelText         an access role in one line
 *   roleNameTaken                      defining a role under a name in use
 *   grantSummary, inviteSummary        what an invite confers, in one line
 *   inviteStatusText                   'Active' · 'Used up' · 'Expired'
 *   errorText                          a refusal from the relay, in words
 *   parseRoute, formatRoute            the panel's #/… addresses (round-trip)
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
    const l = levelOf(caps);
    if (l.level !== 'custom') return LEVEL_NAME[l.level];
    if (l.base) return LEVEL_NAME[l.base] + ' + ' + capsWords(l.extra);
    const set = new Set(caps);
    return 'Custom (' + capsWords(caps) + ')' + (set.has('VIEW_CHANNEL') ? '' : ' — can’t see the channel');
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
   * A failed change as its status line: '<prefix>: <reason>. <what to do>.'
   * `e` is the API error ({status, code, message, …the error body's fields}),
   * `ctx` what the request was about: { channelId, names } for a grant,
   * { roleName } for an access role. The relay's codes get the copy guide's
   * words; anything else says what the relay said.
   */
  function errorText(e, prefix, ctx) {
    const p = prefix || 'Not saved';
    const c = ctx || {};
    const code = e && e.code;
    const label = c.channelId && c.names && c.names.channels ? c.names.channels[c.channelId] : null;
    const bare = (label && label.name) || 'That channel';
    switch (code) {
      case 'NETWORK': return 'Couldn’t reach the relay. Nothing was changed. Try again.';
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
  //   #/all/personas[?q]                   #/all/personas/p/{pid}
  //   #/all/audit[?guild&q&actor&…]        #/guilds
  //
  // A route is { area: 'home' | 'g' | 'all' | 'guilds', gid, view, drawer,
  // query }: `drawer` is null or { kind, id? } (the panel open over the list),
  // `query` the leaf's parameters (the list's, or the drawer's when one is
  // open). Ids are checked here, so a link can't carry anything else; an
  // invite appears only as the hash of its code, never as the code. Unknown
  // query keys are dropped; a bad value makes the whole route invalid (null).
  // The lists' search boxes keep ?q= on every list, not only the ones above
  // that list it.

  const SNOWFLAKE = /^\d{5,25}$/;
  const PERSONA_ID = /^[A-Za-z0-9._:-]{1,100}$/;
  const INVITE_ID = /^[0-9a-f]{24}$/;
  const MAX_IDS = 20;
  const MAX_TEXT = 200;

  const isSnowflake = (s) => typeof s === 'string' && SNOWFLAKE.test(s);
  const isPersonaId = (s) => typeof s === 'string' && PERSONA_ID.test(s) && s !== '.' && s !== '..';
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
      personas: { query: { q: 'text' }, drawers: { p: { kind: 'persona', id: 'pid' } } },
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
      return v.trim();
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
      parts.push(k + '=' + (Array.isArray(val) ? val.map(enc).join(',') : enc(val)));
    }
    return parts.length ? path + '?' + parts.join('&') : path;
  }

  /** May `s` (from sessionStorage) be a place to return to after sign-in? Only
   *  a panel address in a narrow character set; it is only ever parsed into a
   *  route, never assigned to location. */
  function isSafeReturnTo(s) {
    return typeof s === 'string' && /^#\/[A-Za-z0-9/%._~?=&,:-]{0,512}$/.test(s) && parseRoute(s) !== null;
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
    // A direct grant in the persona drawer.
    grant: { target: FIELD.target, caps: FIELD.caps },
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
    sortCaps, levelOf, levelLabel, capsWords, capsSummary, capsTitle, isGrantableType,
    chanText, roleText, guildText, plural, wherePhrase, isMirror, roleLevelText, roleMeaning, roleNameTaken, grantSummary,
    shortDate, usesText, usedText, modeText, inviteSummary, inviteStatusText,
    NOT_GUILD_ADMIN, errorText,
    isSnowflake, isPersonaId, isRoleName, parseRoute, formatRoute, isSafeReturnTo,
    DRAFT_FORMS, draftFields, makeDraft, readDraft, loginErrorText,
  };
})(typeof window !== 'undefined' ? window : globalThis);
