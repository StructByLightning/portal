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
    if (e && e.status === 401) return p + ': your session ended. Sign in again.';
    if (code === 'FORBIDDEN' && e.reason === 'NOT_GUILD_ADMIN') return NOT_GUILD_ADMIN;
    const why = String((e && e.message) || 'something went wrong').trim().replace(/[.\s]+$/, '');
    return p + ': ' + why + '.';
  }

  PA.lib = {
    LEVEL_CAPS, ALL_CAPS, LEVELS, LEVEL_NAME, LEVEL_HELP, CAP_LABEL, CAP_WORDS, CAP_GROUPS, adoptModel,
    sortCaps, levelOf, levelLabel, capsWords, capsSummary, capsTitle, isGrantableType,
    chanText, roleText, guildText, plural, wherePhrase, isMirror, roleLevelText, roleMeaning, roleNameTaken, grantSummary,
    shortDate, usesText, usedText, modeText, inviteSummary, inviteStatusText,
    NOT_GUILD_ADMIN, errorText,
  };
})(typeof window !== 'undefined' ? window : globalThis);
