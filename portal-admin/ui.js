/* Portal Admin — DOM helpers and widgets (window.PA.ui).
 *
 * Vanilla JS, no dependencies, no build step. Like every panel script, this
 * file is one IIFE that assigns a single global, window.PA.<module>.
 *
 * Nothing here sets innerHTML: every string reaches the page as text.
 *
 *   el, clear          build and empty DOM nodes
 *   field              a labelled form field (label for= / role=group)
 *   toast              the fixed toast stack (errors stay until dismissed)
 *   statusLine         a section's inline result line (mirrored as a toast)
 *   busy, onSubmit     one request per click: disable, aria-busy, relabel
 *   confirmDialog      an in-page confirm (replaces window.confirm)
 *   levelControl       Read | Write | Full | Custom… (uses PA.lib)
 *   capsEditor         the capabilities one by one (inside Custom…)
 *   checkList, radioGroup   checkbox lists and radio rows
 *   typeahead          an ARIA combobox over an async source, one value or chips
 *   levelPill, directGrantControl   a persona's access in a channel: what it can
 *                      do, and its direct grant there, changed in place
 *   copyText           clipboard, falling back to selecting the text
 *   modal              the shared modal layer (focus trap, Esc)
 *   dirtyTracker       has this form changed since it was drawn or saved?
 *   drawer             the right-side drawer: focus, Esc, scrim, "Discard changes?",
 *                      and the form it holds (registerForm: kept across a sign-in)
 *   sessionEnded       "Your session ended" over the page, which stays as it was
 *   expiryBar          the "Your session ends at 14:05" bar
 *   notAdminView       a guild this admin can't manage (never named)
 */
(function () {
  'use strict';

  const PA = (window.PA = window.PA || {});

  // ── Elements ──────────────────────────────────────────────────────────────

  /**
   * Create an element. attrs: class, text, value, on<event> handlers, and any
   * other attribute (true → present, false/null → absent). A <button> without
   * an explicit type is type="button", so it never submits a form by accident.
   */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    const a = attrs || {};
    for (const k of Object.keys(a)) {
      const v = a[k];
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    if (tag === 'button' && !Object.prototype.hasOwnProperty.call(a, 'type')) node.setAttribute('type', 'button');
    for (const c of [].concat(children == null ? [] : children)) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  let idSeq = 0;
  function uid(prefix) {
    idSeq += 1;
    return (prefix || 'pa') + '-' + idSeq;
  }

  /** A message as nodes: a string, a node, or a list of both. */
  function toNodes(msg) {
    return [].concat(msg == null ? [] : msg).map((m) => (typeof m === 'string' ? document.createTextNode(m) : m));
  }
  /** A message as plain text (for the toast that mirrors a status line). */
  function toText(msg) {
    return [].concat(msg == null ? [] : msg).map((m) => (typeof m === 'string' ? m : m.textContent || '')).join('');
  }

  const LABELABLE = /^(INPUT|SELECT|TEXTAREA|BUTTON|METER|OUTPUT|PROGRESS)$/;

  /**
   * A form field: { label, control, hint, after }. A labelable control gets an
   * id and a <label for>; anything else (a checkbox group, a list of tags)
   * becomes a role=group named by the label. The hint is linked with
   * aria-describedby; `after` (e.g. a button) sits on the control's row.
   */
  function field(opts) {
    const control = opts.control;
    const wrap = el('div', { class: 'field' + (opts.class ? ' ' + opts.class : '') });
    const hint = opts.hint ? el('p', { class: 'field-hint', id: uid('hint'), text: opts.hint }) : null;
    if (LABELABLE.test(control.tagName)) {
      if (!control.id) control.id = uid('field');
      wrap.appendChild(el('label', { for: control.id, text: opts.label }));
      if (hint) control.setAttribute('aria-describedby', hint.id);
    } else {
      const labelId = uid('label');
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-labelledby', labelId);
      wrap.appendChild(el('div', { class: 'field-label', id: labelId, text: opts.label }));
      if (hint) wrap.setAttribute('aria-describedby', hint.id);
    }
    wrap.appendChild(opts.after ? el('div', { class: 'inline' }, [control].concat(opts.after)) : control);
    if (hint) wrap.appendChild(hint);
    return wrap;
  }

  // ── Toasts ────────────────────────────────────────────────────────────────

  const TOAST_MS = 6000;
  const MAX_TOASTS = 5;
  const dismissers = new WeakMap(); // toast node → its dismiss()

  /** The toast in #toasts that holds `n`, if any. */
  function toastOf(n) {
    const host = document.getElementById('toasts');
    while (n && n.parentNode && n.parentNode !== host) n = n.parentNode;
    return n && host && n.parentNode === host ? n : null;
  }

  /**
   * The stack sits at the bottom of the screen, over the page. While it holds
   * messages, --toasts-h on <html> is the height it takes from the bottom of
   * the viewport (0px when empty); styles.css adds that much room at the end
   * of the page and of a narrow drawer, so anything a sticky message covers
   * can be scrolled out from under it.
   */
  let roomKept = false;
  function keepRoomForToasts(host) {
    if (roomKept || typeof ResizeObserver !== 'function') return;
    roomKept = true;
    const root = document.documentElement;
    const update = () => {
      const h = host.children.length ? Math.max(0, Math.ceil(window.innerHeight - host.getBoundingClientRect().top)) : 0;
      root.style.setProperty('--toasts-h', h + 'px');
    };
    new ResizeObserver(update).observe(host);
    window.addEventListener('resize', update);
    update();
  }

  /**
   * Show a toast in #toasts. kind: 'ok' (default) | 'err' | 'info'. Errors are
   * role=alert and sticky with a ✕; the rest hide after about 6 s (opts.ms)
   * unless sticky is set. opts.action { label, run, ariaLabel } adds a button
   * (Undo): pressing it runs it and takes the toast down; while the pointer
   * or focus is on such a toast it doesn't fade. While the drawer is open,
   * Tab reaches the toast's buttons after the drawer's last control, and Esc
   * on a toast dismisses it. Returns { node, dismiss }.
   */
  function toast(msg, opts) {
    const o = opts || {};
    const kind = o.kind || 'ok';
    const sticky = o.sticky != null ? o.sticky : kind === 'err';
    const host = document.getElementById('toasts');
    if (!host) return { node: null, dismiss() {} };
    keepRoomForToasts(host);
    const msgId = uid('toast');
    const node = el('div', { class: 'toast toast-' + kind, role: kind === 'err' ? 'alert' : 'status' }, [
      el('span', { class: 'toast-msg', id: msgId }, [toText(msg)]),
    ]);
    let timer = null;
    if (o.action && typeof o.action.run === 'function') {
      const act = el('button', { class: 'toast-action', text: o.action.label || 'Undo', 'aria-label': o.action.ariaLabel || null, 'aria-describedby': msgId });
      act.addEventListener('click', () => {
        dismiss();
        o.action.run();
      });
      node.appendChild(act);
      // Time to reach it: it doesn't fade while it is pointed at or focused.
      const hold = () => clearTimeout(timer);
      const resume = () => {
        clearTimeout(timer);
        if (!sticky && node.parentNode) timer = setTimeout(dismiss, o.ms || TOAST_MS);
      };
      node.addEventListener('mouseenter', hold);
      node.addEventListener('mouseleave', resume);
      node.addEventListener('focusin', hold);
      node.addEventListener('focusout', resume);
    }
    const dismiss = () => {
      clearTimeout(timer);
      if (!node.parentNode) return;
      // Dismissed from the keyboard: focus moves to the nearest other ✕ (the
      // next message first), else back into the open drawer.
      const hadFocus = toastOf(document.activeElement) === node;
      const sibs = Array.from(node.parentNode.children);
      const i = sibs.indexOf(node);
      node.parentNode.removeChild(node);
      if (!hadFocus) return;
      const x = sibs.slice(i + 1).concat(sibs.slice(0, i).reverse())
        .map((n) => n.querySelector('.toast-x'))
        .find(Boolean);
      if (x) x.focus();
      else if (current) drawerEls().title.focus();
    };
    dismissers.set(node, dismiss);
    if (sticky) {
      node.appendChild(el('button', {
        class: 'toast-x', 'aria-label': 'Dismiss this message', 'aria-describedby': msgId, title: 'Dismiss', text: '✕', onclick: dismiss,
      }));
    } else {
      timer = setTimeout(dismiss, o.ms || TOAST_MS);
    }
    host.appendChild(node);
    // Keep the stack short: drop the oldest passing messages first.
    while (host.children.length > MAX_TOASTS) {
      const old = Array.from(host.children).find((n) => !n.classList.contains('toast-err')) || host.firstChild;
      const drop = dismissers.get(old);
      if (drop) drop();
      else host.removeChild(old);
    }
    return { node, dismiss };
  }

  /**
   * An inline status line appended to `container` — the authoritative place a
   * section's result or error is shown; it stays until the next result. ok()
   * and err() also show a toast (pass { toast: false } to skip it). The toast
   * mirrors the line: a newer result, or clear(), takes down the toast of the
   * one before, so a sticky error does not stay up once its section has
   * reported something newer (say, the same form then succeeded). ok() and
   * err() return that toast ({ node, dismiss }, or null), so an Undo it
   * carries can be taken down on its own once it no longer applies.
   */
  function statusLine(container) {
    const node = el('p', { class: 'status-line hidden', role: 'status' });
    if (container) container.appendChild(node);
    let mirror = null;
    function unmirror() {
      if (mirror) mirror.dismiss();
      mirror = null;
    }
    function set(kind, msg, o) {
      unmirror();
      node.className = 'status-line status-' + kind;
      clear(node);
      for (const n of toNodes(msg)) node.appendChild(n);
      // o.action / o.ms: the toast's button (Undo) and how long it stays.
      if (!o || o.toast !== false) mirror = toast((o && o.toastText) || toText(msg), { kind, action: o && o.action, ms: o && o.ms });
      return mirror;
    }
    return {
      node,
      ok: (msg, o) => set('ok', msg, o),
      err: (msg, o) => set('err', msg, o),
      info: (msg, o) => set('info', msg, Object.assign({ toast: false }, o)),
      /** Take down this line's toast (its Undo with it); the line stays. */
      dismissToast: unmirror,
      clear() {
        unmirror();
        node.className = 'status-line hidden';
        clear(node);
      },
    };
  }

  // ── One request per click ─────────────────────────────────────────────────

  const busyButtons = new WeakSet();
  // The button busy() took focus from, while its work runs: disabling it
  // dropped focus to <body>, so a dialog the work opens returns there.
  let busyFocus = null;
  // On or off, as setDisabled() asked while busy() held the button: what it
  // returns to when the work settles, instead of its state before the click.
  const restDisabled = new WeakMap();

  /**
   * Turn `button` on or off. While busy() holds it, this is the state it
   * returns to when the work is done (busy() would otherwise put back the one
   * from before the click): a form whose work changes what can be sent —
   * picks cleared after a save — sets its button through this.
   */
  function setDisabled(button, disabled) {
    if (busyButtons.has(button)) restDisabled.set(button, !!disabled);
    else button.disabled = !!disabled;
  }

  /**
   * Lock `button` while `work` (a promise, or a function returning one) runs:
   * disabled, aria-busy, relabelled ('Saving…' unless `label` is given).
   * Restores it when the work settles (off, if the work turned it off with
   * setDisabled()). Returns the work's promise. Focus the button had comes
   * back to it — or, the button left off, to `offFocus()` when given.
   */
  function busy(button, work, label, offFocus) {
    const prev = { text: button.textContent, disabled: button.disabled };
    // Disabling a focused button drops focus to <body>; hand it back after.
    const hadFocus = document.activeElement === button;
    if (hadFocus) busyFocus = button;
    busyButtons.add(button);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = label || 'Saving…';
    let p;
    try {
      p = Promise.resolve(typeof work === 'function' ? work() : work);
    } catch (e) {
      p = Promise.reject(e);
    }
    const done = () => {
      busyButtons.delete(button);
      if (busyFocus === button) busyFocus = null;
      button.disabled = restDisabled.has(button) ? restDisabled.get(button) : prev.disabled;
      restDisabled.delete(button);
      button.removeAttribute('aria-busy');
      button.textContent = prev.text;
      const a = document.activeElement;
      if (!hadFocus || !button.isConnected || (a && a !== document.body && a.isConnected)) return;
      if (!button.disabled) button.focus();
      else if (offFocus) focusFirst([offFocus()]);
    };
    return p.then(
      (v) => {
        done();
        return v;
      },
      (e) => {
        done();
        throw e;
      },
    );
  }

  function isBusy(button) {
    return busyButtons.has(button);
  }

  /**
   * Submit `form` through `run` (Enter or the submit button), one at a time:
   * while a submission is pending, further submits are ignored and the submit
   * button is locked with busy(). `run` reports its own result and errors.
   * A `run` that leaves nothing to send turns the button off with
   * setDisabled(); focus the button had then goes to the form's first field.
   * opts.settled() runs once the button is back as it was: a form whose
   * submit button is on only when it is complete says so again then (it can
   * have been edited while the submission was at work).
   */
  function onSubmit(form, run, opts) {
    const o = opts || {};
    let pending = false;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const button = o.button || form.querySelector('button[type="submit"]');
      if (pending || (button && (isBusy(button) || button.disabled))) return;
      pending = true;
      const work = () => run(e);
      const firstField = () => focusables(form).find((n) => n !== button) || null;
      const p = button ? busy(button, work, o.busyLabel, firstField) : Promise.resolve().then(work);
      p.catch((err) => console.error('[portal-admin]', err)).then(() => {
        pending = false;
        if (o.settled) o.settled();
      });
    });
    return form;
  }

  // ── Modals ────────────────────────────────────────────────────────────────

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
    'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

  /** Rendered and reachable: not display:none, and not inside a closed
   *  <details> (whose content still has boxes in some browsers). */
  function shown(n) {
    const closed = n.closest('details:not([open])');
    if (closed && !(n.tagName === 'SUMMARY' && n.parentElement === closed)) return false;
    if (typeof n.checkVisibility === 'function') return n.checkVisibility();
    return n.getClientRects().length > 0;
  }

  function focusables(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter(shown);
  }

  /** Focus the first of `nodes` that takes it (on the page, shown, enabled;
   *  never <body>). Returns whether one did. */
  function focusFirst(nodes) {
    for (const n of nodes) {
      if (!n || n === document.body || !n.isConnected || n.disabled || typeof n.focus !== 'function' || !shown(n)) continue;
      n.focus();
      if (document.activeElement === n) return true;
    }
    return false;
  }

  /**
   * Keep Tab inside `roots`: a dialog, then any layer that joins its cycle
   * (the toast stack). Within a root the browser moves focus as usual; past a
   * root's last control (or before its first) focus goes on to the next root,
   * wrapping round.
   */
  function trapTab(e, roots) {
    const rs = [].concat(roots).filter(Boolean);
    const groups = rs.map(focusables);
    const f = [].concat(...groups);
    const a = document.activeElement;
    const k = rs.findIndex((r) => r.contains(a));
    let to = null;
    if (!f.length) to = rs[0];
    else if (k < 0) to = e.shiftKey ? f[f.length - 1] : f[0];
    else {
      const g = groups[k];
      const i = f.indexOf(a);
      if (e.shiftKey && i < 0) to = [].concat(...groups.slice(0, k)).pop() || f[f.length - 1];
      else if (e.shiftKey && a === g[0]) to = f[(i - 1 + f.length) % f.length];
      else if (!e.shiftKey && i >= 0 && a === g[g.length - 1]) to = f[(i + 1) % f.length];
    }
    if (!to) return;
    e.preventDefault();
    to.focus();
  }

  const modals = [];

  /**
   * Open a modal: { title, body (nodes), actions (buttons), role, onEscape,
   * initialFocus, returnFocus }. Focus moves in, Tab stays in, Esc calls
   * onEscape, and on close focus returns to returnFocus, or else to where it
   * was — the button whose work opened it, when disabling that button had
   * dropped focus to <body> — or else into the open drawer. Returns
   * { box, close }.
   */
  function modal(opts) {
    const titleId = uid('modal-title');
    const title = el('h2', { id: titleId, text: opts.title });
    const box = el('div', { class: 'modal', role: opts.role || 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
      title,
      ...[].concat(opts.body || []),
      el('div', { class: 'modal-actions' }, opts.actions || []),
    ]);
    const backdrop = el('div', { class: 'modal-backdrop' }, [box]);
    const was = document.activeElement;
    const opener = (!was || was === document.body) && busyFocus && busyFocus.isConnected ? busyFocus : was;
    const entry = { box, onEscape: opts.onEscape };
    // index.html's #modals keeps the layer in one place; any page without it
    // still gets one.
    (document.getElementById('modals') || document.body).appendChild(backdrop);
    modals.push(entry);
    (opts.initialFocus || box).focus();
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      const i = modals.indexOf(entry);
      if (i >= 0) modals.splice(i, 1);
      if (focusFirst([opts.returnFocus, opener])) return;
      // Its button is still at work: busy() gives focus back when it is done.
      if (opener && isBusy(opener)) return;
      // Nothing to go back to: stay in the drawer (a dialog itself) if it is
      // open, so a screen reader is still in it.
      if (current) focusFirst([drawerEls().title]);
    }
    return {
      box,
      close,
      isOpen: () => !closed,
      setTitle(text) {
        title.textContent = text;
      },
    };
  }

  function modalOpen() {
    return modals.length > 0;
  }

  /**
   * Ask before acting: { title, body, confirmLabel, cancelLabel, danger }.
   * Resolves true for the confirm button, false for Cancel or Esc. A danger
   * confirm starts on Cancel, so Enter doesn't destroy anything by itself.
   * Asked over an open drawer, it belongs to that drawer: when the drawer
   * closes (Back, a link), the question goes too, as a Cancel — it was about
   * what that drawer showed.
   */
  function confirmDialog(opts) {
    return new Promise((resolve) => {
      let m = null;
      const owner = current;
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        if (owner) owner.dialogs.delete(finish);
        if (m) m.close();
        resolve(v);
      };
      if (owner) owner.dialogs.add(finish);
      const cancel = el('button', { class: 'btn', text: opts.cancelLabel || 'Cancel', onclick: () => finish(false) });
      const ok = el('button', { class: 'btn ' + (opts.danger ? 'btn-danger-solid' : 'btn-primary'), text: opts.confirmLabel || 'OK', onclick: () => finish(true) });
      const body = [].concat(opts.body == null ? [] : opts.body).map((b) => (typeof b === 'string' ? el('p', { text: b }) : b));
      m = modal({
        title: opts.title,
        body,
        actions: [cancel, ok],
        role: 'alertdialog',
        onEscape: () => finish(false),
        initialFocus: opts.danger ? cancel : ok,
      });
    });
  }

  // ── Pickers ───────────────────────────────────────────────────────────────

  /** Call every listener in `list` with `v`. */
  function emit(list, v) {
    for (const fn of list) fn(v);
  }

  /**
   * The level control: Read | Write | Full | Custom… as radio buttons (a
   * role=radiogroup). Custom… opens the capabilities, grouped as in
   * PA.lib.CAP_GROUPS; ticking any Write or Moderation capability ticks View
   * and History too, and leaving View unticked while others are ticked shows
   * 'Without View this only works where a role already gives view.'
   *   opts: { value (caps), allowCustom (default true), label (default 'Level') }
   * Returns { node, value() → caps ([] when no level is picked), level() →
   * 'read' | 'write' | 'full' | 'custom' | null, set(caps), onChange(fn) }.
   * onChange fires on the admin's changes, not on set().
   */
  function levelControl(opts) {
    const o = opts || {};
    const lib = PA.lib;
    const allowCustom = o.allowCustom !== false;
    const name = uid('level');
    const listeners = [];
    const radios = {};
    const kinds = lib.LEVELS.concat(allowCustom ? ['custom'] : []);
    const radioRow = el('div', { class: 'level-options', role: 'radiogroup', 'aria-label': o.label || 'Level' });
    for (const k of kinds) {
      const r = el('input', { type: 'radio', name, value: k });
      radios[k] = r;
      radioRow.appendChild(el('label', { class: 'level-option', title: k === 'custom' ? 'Pick the capabilities one by one.' : lib.LEVEL_HELP[k] }, [
        r, el('span', { text: k === 'custom' ? 'Custom…' : lib.LEVEL_NAME[k] }),
      ]));
    }
    const help = el('p', { class: 'field-hint level-help' });

    const editor = capsEditor({ hidden: true });
    const custom = editor.node;

    const node = el('div', { class: 'level-control' }, [radioRow, help, custom]);

    const kind = () => kinds.find((k) => radios[k].checked) || null;
    function value() {
      const k = kind();
      if (!k) return [];
      return k === 'custom' ? editor.value() : lib.LEVEL_CAPS[k].slice();
    }
    function sync() {
      const k = kind();
      custom.classList.toggle('hidden', k !== 'custom');
      const v = value();
      editor.syncWarn(k === 'custom');
      help.textContent = !k ? '' : k === 'custom' ? (v.length ? lib.capsSummary(v) + '.' : 'Tick at least one capability.') : lib.LEVEL_HELP[k];
      help.classList.toggle('hidden', !k);
    }
    function set(caps) {
      const l = lib.levelOf(caps);
      for (const k of kinds) radios[k].checked = false;
      if (l.level === 'custom' && allowCustom) radios.custom.checked = true;
      else if (radios[l.level]) radios[l.level].checked = true;
      editor.set(caps || []);
      sync();
    }

    for (const k of kinds) {
      radios[k].addEventListener('change', () => {
        // A preset fills the boxes, so Custom… starts from what was picked.
        if (k !== 'custom' && radios[k].checked) editor.set(lib.LEVEL_CAPS[k]);
        sync();
        emit(listeners, value());
      });
    }
    editor.onChange(() => {
      sync();
      emit(listeners, value());
    });
    set(o.value || []);
    return { node, value, level: kind, set, onChange: (fn) => listeners.push(fn) };
  }

  /**
   * The capabilities one by one (inside Custom…), grouped as in
   * PA.lib.CAP_GROUPS: ticking any Write or Moderation capability ticks View
   * and History too, and leaving View unticked while others are ticked shows
   * 'Without View this only works where a role already gives view.'
   *   opts: { value (caps), hidden (start hidden) }
   * Returns { node, value(), set(caps), onChange(fn), syncWarn(active) }:
   * syncWarn(false) hides the warning while the boxes aren't in use.
   * onChange fires on the admin's ticks, not on set().
   */
  function capsEditor(opts) {
    const o = opts || {};
    const lib = PA.lib;
    const listeners = [];
    const boxes = {};
    const node = el('div', { class: 'caps-groups' + (o.hidden ? ' hidden' : '') });
    for (const g of lib.CAP_GROUPS) {
      const labelId = uid('caps');
      node.appendChild(el('div', { class: 'cap-group', role: 'group', 'aria-labelledby': labelId }, [
        el('div', { class: 'cap-group-label', id: labelId, text: g.label }),
        el('div', { class: 'cap-chips' }, g.caps.map((c) => {
          const cb = el('input', { type: 'checkbox', value: c });
          boxes[c] = cb;
          return el('label', { class: 'cap-chip' }, [cb, el('span', { text: lib.CAP_LABEL[c] || lib.capsWords([c]) })]);
        })),
      ]));
    }
    const warn = el('p', { class: 'warn-line hidden', text: 'Without View this only works where a role already gives view.' });
    node.appendChild(warn);
    const value = () => lib.ALL_CAPS.filter((c) => boxes[c] && boxes[c].checked);
    function syncWarn(active) {
      const v = value();
      warn.classList.toggle('hidden', !(active !== false && v.length && boxes.VIEW_CHANNEL && !boxes.VIEW_CHANNEL.checked));
    }
    function set(caps) {
      const s = new Set(caps || []);
      for (const c of Object.keys(boxes)) boxes[c].checked = s.has(c);
      syncWarn();
    }
    const viewImplied = new Set(lib.CAP_GROUPS.filter((g) => g.key === 'write' || g.key === 'moderation').flatMap((g) => g.caps));
    for (const c of Object.keys(boxes)) {
      boxes[c].addEventListener('change', () => {
        if (boxes[c].checked && viewImplied.has(c)) {
          if (boxes.VIEW_CHANNEL) boxes.VIEW_CHANNEL.checked = true;
          if (boxes.READ_HISTORY) boxes.READ_HISTORY.checked = true;
        }
        syncWarn();
        emit(listeners, value());
      });
    }
    set(o.value || []);
    return { node, value, set, onChange: (fn) => listeners.push(fn), syncWarn };
  }

  /**
   * A list of checkboxes (access roles, channels, Discord roles) in a box that
   * scrolls; with more than `filterAt` options (default 8) a filter field sits
   * above it. options: [{ value, text, code (show text in code font), hint }].
   * Returns { node, values(), setValues(values), setOptions(options), onChange(fn) }.
   */
  function checkList(opts) {
    const o = opts || {};
    const listeners = [];
    const list = el('div', { class: 'check-list', role: 'group', 'aria-label': o.label || 'Options' });
    const filter = el('input', { type: 'search', class: 'check-filter', placeholder: 'Filter…', 'aria-label': 'Filter ' + (o.label || 'options').toLowerCase(), autocomplete: 'off', 'data-no-dirty': true });
    const node = el('div', { class: 'check-list-wrap' }, [filter, list]);
    let items = [];
    function applyFilter() {
      const q = filter.value.trim().toLowerCase();
      for (const it of items) it.row.classList.toggle('hidden', !!q && !it.text.toLowerCase().includes(q));
    }
    function setOptions(options) {
      const keep = new Set(values());
      clear(list);
      items = (options || []).map((op) => {
        const cb = el('input', { type: 'checkbox', value: op.value });
        cb.checked = keep.has(op.value);
        cb.addEventListener('change', () => emit(listeners, values()));
        const label = [op.code ? el('code', { text: op.text }) : el('span', { text: op.text })];
        if (op.hint) label.push(el('span', { class: 'muted', text: ' — ' + op.hint }));
        const row = el('label', { class: 'check-item', title: op.title || null }, [cb, el('span', {}, label)]);
        list.appendChild(row);
        return { cb, row, text: op.text + ' ' + (op.hint || '') };
      });
      if (!items.length) list.appendChild(el('p', { class: 'muted check-empty', text: o.empty || 'Nothing to pick.' }));
      filter.classList.toggle('hidden', items.length <= (o.filterAt == null ? 8 : o.filterAt));
      applyFilter();
    }
    function values() {
      return items.filter((it) => it.cb.checked).map((it) => it.cb.value);
    }
    filter.addEventListener('input', applyFilter);
    setOptions(o.options);
    return {
      node,
      values,
      setValues(vs) {
        const want = new Set(vs || []);
        for (const it of items) it.cb.checked = want.has(it.cb.value);
      },
      setOptions,
      onChange: (fn) => listeners.push(fn),
    };
  }

  /**
   * Radio buttons for one choice: { label, options: [{ value, text }], value }.
   * Returns { node, value(), set(v), onChange(fn) }.
   */
  function radioGroup(opts) {
    const name = uid('choice');
    const listeners = [];
    const radios = opts.options.map((op) => {
      const r = el('input', { type: 'radio', name, value: op.value });
      r.checked = op.value === opts.value;
      return r;
    });
    const node = el('div', { class: 'radio-row', role: 'radiogroup', 'aria-label': opts.label }, opts.options.map((op, i) => el('label', { class: 'level-option', title: op.title || null }, [radios[i], el('span', { text: op.text })])));
    for (const r of radios) r.addEventListener('change', () => emit(listeners, r.value));
    return {
      node,
      value: () => (radios.find((r) => r.checked) || { value: '' }).value,
      set(v) {
        for (const r of radios) r.checked = r.value === v;
      },
      onChange: (fn) => listeners.push(fn),
    };
  }

  // ── Type-ahead ────────────────────────────────────────────────────────────

  /**
   * A type-ahead: an ARIA combobox (role=combobox on the text field, a
   * role=listbox popup, aria-activedescendant) over an async source, picking
   * one value or several (chips).
   *   opts: { label (names the list), ariaLabel (names the field when no
   *           <label for> does), placeholder, multiple
   *           (default true), max, name (of the hidden inputs that hold the
   *           picks), source(q) → Promise<[{ value, label, hint, tag, group,
   *           disabled, title }]>, debounce (ms, default 150), empty,
   *           expand(item) → [items] | null (a pick that stands for several:
   *           its items are picked instead — a category's channels),
   *           expanded(item, picked, fresh) (after such a pick: how many of
   *           the `fresh` ones — not picked before — fit under `max`) }
   * At `max` picks a visible note says so (and the live region): a pick
   * past it does nothing else.
   * Options come grouped in the order their groups first appear. ↑/↓ move,
   * Enter picks, Esc closes the list (the next Esc is the drawer's), Tab
   * leaves it, Backspace in an empty field removes the last chip. Typing asks
   * the source after a pause; only the latest answer is shown. Each pick sits
   * in a hidden input named `name`, so a form's dirty tracking counts it; the
   * typed text doesn't count (it is a search).
   * Returns { node, input, values(), items(), set(items), clear(),
   * query(text) (type `text` into the field and ask), onChange(fn), close() };
   * onChange fires on the admin's picks and removals.
   */
  function typeahead(opts) {
    const o = opts || {};
    const multiple = o.multiple !== false;
    const max = o.max || (multiple ? Infinity : 1);
    const listId = uid('ta-list');
    const input = el('input', {
      type: 'text', class: 'ta-input', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false',
      'aria-controls': listId, autocomplete: 'off', spellcheck: 'false', placeholder: o.placeholder || null,
      'aria-label': o.ariaLabel || null, 'data-no-dirty': true,
    });
    const chips = el('span', { class: 'ta-chips' });
    const list = el('div', { id: listId, class: 'ta-list hidden', role: 'listbox', 'aria-label': o.label || 'Suggestions' });
    const live = el('span', { class: 'visually-hidden', role: 'status' });
    const limitText = 'At most ' + max + ' can be picked. Remove one to pick another.';
    const limitNote = el('p', { class: 'field-hint ta-limit hidden', text: limitText });
    const node = el('div', { class: 'typeahead' }, [el('div', { class: 'ta-box' }, [chips, input]), list, live, limitNote]);
    // A press anywhere in the list (its scrollbar too) keeps focus in the field.
    list.addEventListener('mousedown', (e) => e.preventDefault());
    const listeners = [];
    let picked = [];
    let options = []; // the options that can be picked: { item, node }
    let active = -1;
    let seq = 0;
    let timer = null;
    let open = false;

    function setActive(i) {
      const was = options[active];
      if (was) {
        was.node.setAttribute('aria-selected', 'false');
        was.node.classList.remove('active');
      }
      active = i;
      const cur = options[i];
      if (cur) {
        cur.node.setAttribute('aria-selected', 'true');
        cur.node.classList.add('active');
        input.setAttribute('aria-activedescendant', cur.node.id);
        if (typeof cur.node.scrollIntoView === 'function') cur.node.scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    }
    function setOpen(v) {
      open = v;
      list.classList.toggle('hidden', !v);
      input.setAttribute('aria-expanded', v ? 'true' : 'false');
      if (!v) setActive(-1);
    }
    function draw(items, failed) {
      clear(list);
      options = [];
      active = -1;
      const taken = new Set(picked.map((p) => p.value));
      const shown = (items || []).filter((it) => !taken.has(it.value));
      if (!shown.length) {
        const t = failed ? 'Couldn’t load suggestions. Type again to retry.' : o.empty || 'No match.';
        list.appendChild(el('div', { class: 'ta-empty muted', role: 'presentation', text: t }));
        live.textContent = t;
        return;
      }
      const groups = [];
      const byGroup = new Map();
      for (const it of shown) {
        const g = it.group || '';
        if (!byGroup.has(g)) {
          byGroup.set(g, []);
          groups.push(g);
        }
        byGroup.get(g).push(it);
      }
      for (const g of groups) {
        let parent = list;
        if (g) {
          const gid = uid('ta-group');
          parent = el('div', { class: 'ta-group', role: 'group', 'aria-labelledby': gid }, [el('div', { id: gid, class: 'ta-group-label', role: 'presentation', text: g })]);
          list.appendChild(parent);
        }
        for (const it of byGroup.get(g)) {
          const opt = el('div', {
            id: uid('ta-opt'), class: 'ta-option' + (it.disabled ? ' disabled' : ''), role: 'option', 'aria-selected': 'false',
            'aria-disabled': it.disabled ? 'true' : null, title: it.title || null,
          }, [
            el('span', { class: 'ta-label', text: it.label }),
            it.hint ? el('span', { class: 'ta-hint', text: it.hint }) : null,
            it.tag ? el('span', { class: 'badge ta-tag', text: it.tag }) : null,
          ]);
          if (!it.disabled) {
            const i = options.length;
            options.push({ item: it, node: opt });
            opt.addEventListener('click', () => pick(it));
            opt.addEventListener('mousemove', () => { if (active !== i) setActive(i); });
          }
          parent.appendChild(opt);
        }
      }
      live.textContent = options.length === 1 ? '1 result' : options.length + ' results';
      setActive(options.length ? 0 : -1);
    }
    function search() {
      clearTimeout(timer);
      const mine = ++seq;
      const q = input.value.trim();
      timer = setTimeout(async () => {
        timer = null;
        let items = null;
        try { items = await o.source(q); } catch { items = null; }
        if (mine !== seq || document.activeElement !== input) return;
        draw(items, items === null);
        setOpen(true);
      }, o.debounce == null ? 150 : o.debounce);
    }
    function drawChips() {
      limitNote.classList.toggle('hidden', !(multiple && max !== Infinity && picked.length >= max));
      clear(chips);
      for (const p of picked) {
        const hidden = el('input', { type: 'hidden', name: o.name || null, value: p.value });
        if (!multiple) {
          chips.appendChild(hidden);
          continue;
        }
        const label = 'Remove ' + p.label;
        const x = el('button', { class: 'x', text: '✕', 'aria-label': label, title: label });
        x.addEventListener('click', () => {
          remove(p.value);
          input.focus();
        });
        chips.appendChild(el('span', { class: 'tag', title: p.title || null }, [el('span', { text: p.label }), hidden, x]));
      }
    }
    function pick(it) {
      const several = multiple && o.expand ? o.expand(it) : null;
      if (several) {
        const taken = new Set(picked.map((p) => p.value));
        const fresh = several.filter((x) => !taken.has(x.value));
        const room = Math.max(0, max - picked.length);
        const added = Math.min(room, fresh.length);
        picked.push(...fresh.slice(0, room));
        input.value = '';
        live.textContent = fresh.length > room
          ? 'Picked ' + room + ' of ' + fresh.length + ': at most ' + max + ' can be picked.'
          : fresh.length + ' picked from ' + it.label + '.';
        if (o.expanded) o.expanded(it, added, fresh.length);
      } else if (multiple) {
        if (picked.length >= max) {
          // Said where it is seen, not only to a screen reader; the list
          // closes so the pick that did nothing doesn't look pending.
          live.textContent = limitText;
          limitNote.classList.remove('hidden');
          seq++;
          clearTimeout(timer);
          setOpen(false);
          return;
        }
        picked.push(it);
        input.value = '';
        live.textContent = it.label + ' picked.';
      } else {
        picked = [it];
        input.value = it.label;
      }
      drawChips();
      seq++;
      clearTimeout(timer);
      setOpen(false);
      input.focus();
      emit(listeners, values());
    }
    function remove(value) {
      const before = picked.length;
      picked = picked.filter((p) => p.value !== value);
      if (picked.length === before) return;
      drawChips();
      emit(listeners, values());
    }
    function values() {
      return picked.map((p) => p.value);
    }
    input.addEventListener('input', () => {
      // One value, typed over: it is no longer picked.
      if (!multiple && picked.length && input.value !== picked[0].label) {
        picked = [];
        drawChips();
        emit(listeners, values());
      }
      search();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!open) search();
        else if (options.length) setActive((active + 1) % options.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (open && options.length) setActive((active - 1 + options.length) % options.length);
      } else if (e.key === 'Enter') {
        // While the list is open, Enter picks — it never submits the form.
        if (open) {
          e.preventDefault();
          if (options[active]) pick(options[active].item);
        }
      } else if (e.key === 'Escape') {
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          seq++;
          setOpen(false);
        }
      } else if (e.key === 'Backspace') {
        if (multiple && !input.value && picked.length) {
          e.preventDefault();
          const last = picked[picked.length - 1];
          remove(last.value);
          live.textContent = last.label + ' removed.';
        }
      } else if (e.key === 'Tab') setOpen(false);
    });
    input.addEventListener('blur', () => {
      clearTimeout(timer);
      seq++;
      setOpen(false);
    });
    return {
      node,
      input,
      values,
      items: () => picked.slice(),
      set(items) {
        picked = (items || []).slice(0, max === Infinity ? undefined : max);
        if (!multiple) input.value = picked.length ? picked[0].label : '';
        drawChips();
      },
      clear() {
        picked = [];
        input.value = '';
        drawChips();
      },
      query(text) {
        input.value = text || '';
        search();
      },
      close() {
        seq++;
        setOpen(false);
      },
      onChange: (fn) => listeners.push(fn),
    };
  }

  // ── Access, as a channel or persona drawer shows it ───────────────────────

  /** A persona's 'Can do here' pill ('Write', 'Write +1 (bot-limited)', '—'),
   *  from a row of the relay's access read; the tooltip says it in words. */
  function levelPill(row, where) {
    const p = PA.lib.pillText(row, where);
    return el('span', { class: 'pill pill-' + p.level + (p.limited ? ' pill-limited' : ''), title: p.title, text: p.text });
  }

  /** Where Custom… starts for a direct grant `value`: what is set, or
   *  Write when nothing (or a block) is. */
  function customStart(value) {
    return value && value.length ? value.slice() : PA.lib.LEVEL_CAPS.write.slice();
  }

  /**
   * A persona's direct grant in one channel, changed in place:
   * [— | Read | Write | Full | Custom… | Block guild-wide here]. A pick
   * applies at once (no Save): opts.apply(caps | null) → Promise<boolean>,
   * true once it is saved — otherwise the control goes back to what it was.
   * Custom… opens the capabilities inline, with Apply and Cancel. 'Block
   * guild-wide here' ([]) is offered when opts.canBlock, or when it is what
   * is set.
   *
   * A step from the keyboard is held until it is committed: in Chrome on
   * Windows and Linux, and in Firefox, ↑/↓ on a closed select change its
   * value (and fire 'change') at once, so going from — to Write would
   * otherwise save Read on the way. Enter, or leaving the control, applies
   * what it shows; Esc puts back what is set (inside a drawer too: the
   * drawer's own Esc waits for the next one). A pick with the mouse, or
   * from the open list, applies at once.
   * The Custom… editor's ticks are the admin's until Apply or Cancel: the
   * owner keeps them (opts.onEditing) and hands them back when it draws the
   * row again (opts.editing), so a redraw never drops them, and counts them
   * as unsaved once they differ from where the editor started.
   *   opts: { value (caps | null), canBlock, label (the select's name), apply,
   *           key (data-key for the select — and, from it, the editor's
   *           boxes and buttons — so a redraw can give focus back),
   *           busy (drawn while a change to it is still being saved
   *           elsewhere: off, and aria-busy, until setBusy(false)),
   *           removeOnly (a channel the panel can't give access on: what is
   *           set, or — to remove it; nothing else),
   *           editing ({ caps, start }: a Custom… edit open in this row
   *           before it was drawn again — reopened as it was),
   *           onEditing (fn({ caps, start } | null): the open Custom…
   *           editor, as it opens and as its boxes are ticked; null once it
   *           closes — applied, cancelled, or another pick made) }
   * Returns { node, select, value(), editing(), set(value, canBlock,
   * keepEditing), setBusy(on) }.
   */
  function directGrantControl(opts) {
    const lib = PA.lib;
    let value = opts.value == null ? null : opts.value.slice();
    let canBlock = !!opts.canBlock;
    let busyNow = false;
    let held = false;     // a keyboard step shown, not applied yet
    let stepping = false; // a step key was just pressed: its 'change' is held
    let stepTimer = null;
    let editing = null;   // the open Custom… editor: { caps, start }
    const label = opts.label || 'Direct grant';
    const select = el('select', { class: 'dg-select', 'aria-label': label, 'data-no-dirty': true, 'data-key': opts.key || null });
    const edit = el('button', { class: 'btn btn-sm btn-ghost hidden', text: 'Edit…', 'aria-label': 'Edit capabilities — ' + label });
    const heldHint = el('span', { class: 'field-hint dg-held hidden', text: 'Enter to apply · Esc to cancel' });
    const editorBox = el('div', { class: 'dg-custom hidden' });
    const node = el('div', { class: 'dg' }, [el('div', { class: 'dg-row' }, [select, edit, heldHint]), editorBox]);

    function setHeld(on) {
      held = on;
      heldHint.classList.toggle('hidden', !on);
      // While a step is held, Esc is this control's (it puts back what is
      // set): the drawer's Esc, which runs first, leaves it to it.
      if (on) select.setAttribute('data-esc-own', 'true');
      else select.removeAttribute('data-esc-own');
    }
    function fill() {
      clear(select);
      setHeld(false);
      const cur = lib.directValue(value);
      const opt = (v, text, title) => el('option', { value: v, text, title: title || null });
      if (opts.removeOnly) {
        select.appendChild(opt('', '—', 'Remove the direct grant here'));
        if (cur) select.appendChild(opt('keep', cur === 'block' ? 'Blocked guild-wide here' : cur === 'custom' ? lib.customOptionText(value) : lib.LEVEL_NAME[cur], lib.capsTitle(value || [])));
        select.value = cur ? 'keep' : '';
        select.disabled = !cur || busyNow;
        edit.classList.add('hidden');
        return;
      }
      select.appendChild(opt('', '—', 'No direct grant here'));
      for (const k of lib.LEVELS) select.appendChild(opt(k, lib.LEVEL_NAME[k], lib.LEVEL_HELP[k]));
      select.appendChild(opt('custom', cur === 'custom' ? lib.customOptionText(value) : 'Custom…', cur === 'custom' ? lib.capsTitle(value) : 'Pick the capabilities one by one.'));
      if (canBlock || cur === 'block') select.appendChild(opt('block', 'Block guild-wide here', 'Blocks guild-wide and persona-default access in this channel. Roles still apply.'));
      select.value = cur;
      edit.classList.toggle('hidden', cur !== 'custom');
    }
    function closeEditor() {
      clear(editorBox);
      editorBox.classList.add('hidden');
      if (!editing) return;
      editing = null;
      if (opts.onEditing) opts.onEditing(null);
    }
    /** Open Custom…: from what is set (Write when nothing is), or — `was`,
     *  an edit made before this row was drawn again — as it was left. */
    function openEditor(was) {
      closeEditor();
      const start = was && Array.isArray(was.start) ? was.start.slice() : customStart(value);
      // The grant this edit was started over: Apply sends it as `expect`, so
      // a grant someone changed meanwhile is refused, not overwritten — even
      // when the row has been drawn again since with the newer grant.
      const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
      const base = has(was, 'base') ? (was.base == null ? null : was.base.slice()) : value == null ? null : value.slice();
      const editor = capsEditor({ value: was && Array.isArray(was.caps) ? was.caps : start });
      const keyed = (n, k) => {
        if (opts.key) n.setAttribute('data-key', opts.key + ':' + k);
        return n;
      };
      for (const cb of editor.node.querySelectorAll('input')) keyed(cb, cb.value);
      const baseCopy = () => (base == null ? null : base.slice());
      const report = () => {
        editing = { caps: editor.value(), start: start.slice(), base: baseCopy() };
        if (opts.onEditing) opts.onEditing({ caps: editing.caps.slice(), start: start.slice(), base: baseCopy() });
      };
      editor.onChange(report);
      const apply = keyed(el('button', { class: 'btn btn-sm btn-primary', text: 'Apply' }), 'apply');
      const cancel = keyed(el('button', { class: 'btn btn-sm', text: 'Cancel' }), 'cancel');
      const why = el('span', { class: 'field-hint', role: 'status' });
      apply.addEventListener('click', () => {
        const caps = editor.value();
        if (!caps.length) {
          why.textContent = 'Tick at least one capability, or pick —.';
          return;
        }
        run(caps, { expect: baseCopy() });
      });
      cancel.addEventListener('click', () => {
        closeEditor();
        fill();
        select.focus();
      });
      editorBox.appendChild(el('div', { class: 'dg-editor', role: 'group', 'aria-label': 'Capabilities — ' + label }, [
        editor.node, el('div', { class: 'inline' }, [apply, cancel, why]),
      ]));
      editorBox.classList.remove('hidden');
      // Reopened as it was, the owner has it already; opened now, it is told.
      if (was) editing = { caps: editor.value(), start: start.slice(), base: baseCopy() };
      else report();
    }
    async function run(next, meta) {
      if (busyNow) return;
      busyNow = true;
      const hadFocus = node.contains(document.activeElement);
      // As busy() does for a button: a confirm the change asks gives focus
      // back here, once the change is done.
      busyButtons.add(select);
      if (hadFocus) busyFocus = select;
      select.disabled = true;
      edit.disabled = true;
      node.setAttribute('aria-busy', 'true');
      let ok = false;
      try { ok = await opts.apply(next, meta); } catch (e) { console.error('[portal-admin]', e); ok = false; }
      busyButtons.delete(select);
      if (busyFocus === select) busyFocus = null;
      busyNow = false;
      node.removeAttribute('aria-busy');
      select.disabled = false;
      edit.disabled = false;
      if (ok) {
        value = next == null ? null : next.slice();
        closeEditor();
      }
      fill();
      // Turning it off dropped focus: give it back (if it is still on the page).
      const a = document.activeElement;
      if (hadFocus && select.isConnected && (!a || a === document.body || !a.isConnected)) select.focus();
    }
    /** Apply what the select shows (a pick, or a held step committed). */
    function commit() {
      setHeld(false);
      const v = select.value;
      if (v === 'custom') {
        openEditor();
        return;
      }
      if (v === 'keep' || v === lib.directValue(value)) return; // back where it was: nothing to send
      closeEditor();
      run(v === '' ? null : v === 'block' ? [] : lib.LEVEL_CAPS[v].slice());
    }
    const STEP_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
    select.addEventListener('keydown', (e) => {
      const typed = typeof e.key === 'string' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (STEP_KEYS.includes(e.key) || typed) {
        // The 'change' a step fires comes at once (in the same task); one
        // that comes later is a pick from the open list.
        stepping = true;
        clearTimeout(stepTimer);
        stepTimer = setTimeout(() => { stepping = false; }, 100);
      } else if (e.key === 'Enter' && held) {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape' && held) {
        e.preventDefault();
        e.stopPropagation(); // the drawer's Esc is the next one
        fill(); // not held any more: leaving the control now applies nothing
      }
    });
    select.addEventListener('blur', () => { if (held) commit(); });
    select.addEventListener('change', () => {
      if (stepping) {
        setHeld(true);
        return;
      }
      commit();
    });
    edit.addEventListener('click', () => openEditor(null));
    if (opts.busy) {
      busyNow = true;
      select.disabled = true;
      edit.disabled = true;
      node.setAttribute('aria-busy', 'true');
    }
    fill();
    if (opts.busy) select.disabled = true;
    if (opts.editing && !opts.removeOnly) {
      openEditor(opts.editing);
      select.value = 'custom'; // as it read when Custom… was picked
    }
    return {
      node,
      select,
      value: () => (value == null ? null : value.slice()),
      /** The open Custom… editor ({ caps, start }), or null. */
      editing: () => (editing ? { caps: editing.caps.slice(), start: editing.start.slice(), base: editing.base == null ? null : editing.base.slice() } : null),
      /** What is set is now `v`. An open Custom… editor closes, unless
       *  `keepEditing` (a change that wasn't made leaves the admin's ticks). */
      set(v, cb, keepEditing) {
        value = v == null ? null : v.slice();
        if (cb !== undefined) canBlock = !!cb;
        if (!keepEditing) closeEditor();
        fill();
      },
      /** Drawn busy (opts.busy): on again once that change is done. */
      setBusy(on) {
        busyNow = !!on;
        edit.disabled = busyNow;
        if (busyNow) node.setAttribute('aria-busy', 'true');
        else node.removeAttribute('aria-busy');
        if (opts.removeOnly) fill();
        else select.disabled = busyNow;
      },
    };
  }

  /**
   * Put `text` on the clipboard. Resolves true when it got there; otherwise
   * selects `node`'s text (so Ctrl+C / ⌘C copies it) and resolves false.
   */
  async function copyText(text, node) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      if (node && typeof document.createRange === 'function') {
        const range = document.createRange();
        range.selectNodeContents(node);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      return false;
    }
  }

  // ── Dirty tracking ────────────────────────────────────────────────────────

  function controlValue(c) {
    if (c.type === 'checkbox' || c.type === 'radio') return c.checked;
    if (c.type === 'file') return c.files ? c.files.length : 0;
    if (c.tagName === 'SELECT' && c.multiple) return Array.from(c.selectedOptions).map((o) => o.value);
    return c.value;
  }
  function snapshot(form) {
    return JSON.stringify(
      Array.from(form.elements || [])
        .filter((c) => /^(INPUT|SELECT|TEXTAREA)$/.test(c.tagName))
        .filter((c) => !/^(button|submit|reset|image)$/.test(c.type) && !c.hasAttribute('data-no-dirty'))
        .map(controlValue),
    );
  }

  /**
   * Has `form` changed since it was drawn or last reset()? Controls marked
   * data-no-dirty (ones that save the moment they change) don't count.
   *
   * A save takes a while, and the form can be changed meanwhile: take mark()
   * when the save is sent, and once it went through, saved(mark) makes what
   * was SENT the baseline — an edit made while it was at work stays unsaved
   * (the drawer asks before it is closed, and a sign-in keeps it). If the
   * form was reset since the mark (reloaded for something else), that
   * baseline stands; saved() then returns false.
   */
  function dirtyTracker(form) {
    let base = snapshot(form);
    let resets = 0;
    return {
      isDirty: () => snapshot(form) !== base,
      reset() {
        base = snapshot(form);
        resets++;
      },
      mark: () => ({ snap: snapshot(form), at: resets }),
      /** Has anything but `control` changed since the baseline? (Lets a save
       *  of one field settle without counting other edits made meanwhile as
       *  saved.) A form whose controls came or went counts as changed. */
      dirtyBesides(control) {
        const ctrls = Array.from(form.elements || [])
          .filter((c) => /^(INPUT|SELECT|TEXTAREA)$/.test(c.tagName))
          .filter((c) => !/^(button|submit|reset|image)$/.test(c.type) && !c.hasAttribute('data-no-dirty'));
        const now = JSON.parse(snapshot(form));
        const was = JSON.parse(base);
        if (now.length !== was.length) return true;
        const i = ctrls.indexOf(control);
        if (i >= 0) { now.splice(i, 1); was.splice(i, 1); }
        return JSON.stringify(now) !== JSON.stringify(was);
      },
      saved(m) {
        if (!m || m.at !== resets) return false;
        base = m.snap;
        resets++;
        return true;
      },
    };
  }

  // ── The drawer ────────────────────────────────────────────────────────────
  // Markup lives in index.html: #drawer (role=dialog) with #drawer-title,
  // #drawer-close and #drawer-body, behind #drawer-scrim.

  let drawerSeq = 0;
  let current = null; // { token, trackers, form, onClose, returnFocus, dialogs }
  let drawerBound = false;
  let discardQuestion = null; // the 'Discard changes?' that is up, if any

  function drawerEls() {
    return {
      drawer: document.getElementById('drawer'),
      title: document.getElementById('drawer-title'),
      body: document.getElementById('drawer-body'),
      scrim: document.getElementById('drawer-scrim'),
      close: document.getElementById('drawer-close'),
    };
  }

  function bindDrawer() {
    if (drawerBound) return;
    drawerBound = true;
    const d = drawerEls();
    d.close.addEventListener('click', () => drawer.requestClose());
    d.scrim.addEventListener('click', () => drawer.requestClose());
  }

  function isField(n) {
    if (!n || !n.tagName) return false;
    if (n.tagName === 'INPUT') return !/^(button|submit|reset|image)$/.test(n.type);
    return n.tagName === 'SELECT' || n.tagName === 'TEXTAREA' || n.isContentEditable === true;
  }

  const drawer = {
    /**
     * Open the drawer at once: { title, subtitle, body, onClose }. Without a
     * body it shows 'Loading…'. Returns a handle whose setBody/setTitle/close
     * do nothing once this drawer has been closed or replaced. Anything that
     * waits on the relay checks isCurrent() before it asks a question, since
     * a question belongs to whichever drawer is open when it is asked.
     */
    open(opts) {
      bindDrawer();
      const d = drawerEls();
      const a = document.activeElement;
      const returnFocus = current ? current.returnFocus : a && !d.drawer.contains(a) ? a : null;
      // A drawer replaced by this one takes its questions with it.
      if (current) for (const cancel of [...current.dialogs]) cancel(false);
      current = { token: ++drawerSeq, trackers: [], forms: [], onClose: opts.onClose || null, returnFocus, dialogs: new Set() };
      const token = current.token;
      const handle = {
        isCurrent: () => !!current && current.token === token,
        /** Close this drawer — only if it is still the one open: a reply that
         *  lands after it was closed or replaced must not close another. */
        close(reason) {
          if (handle.isCurrent()) drawer.close(reason);
        },
        /** Close as ✕ does — asking 'Discard changes?' first when a tracked
         *  form is dirty — only if this is still the drawer open. Resolves
         *  true if it closed. A drawer's own Done uses this, not close(). */
        requestClose() {
          return handle.isCurrent() ? drawer.requestClose() : Promise.resolve(false);
        },
        setTitle(title, subtitle) {
          if (!handle.isCurrent()) return;
          clear(d.title);
          d.title.appendChild(document.createTextNode(title));
          if (subtitle) d.title.appendChild(el('span', { class: 'muted mono drawer-subtitle', text: ' ' + subtitle }));
        },
        setBody(node) {
          if (!handle.isCurrent()) return;
          clear(d.body);
          d.body.appendChild(node);
        },
        /** Count `form` toward "Discard changes?". */
        track(form) {
          const t = dirtyTracker(form);
          if (handle.isCurrent()) current.trackers.push(t);
          return t;
        },
        /** Count unsaved state that isn't a form's fields toward "Discard
         *  changes?": isDirty() says whether there is any. */
        trackDirty(isDirty) {
          if (handle.isCurrent()) current.trackers.push({ isDirty });
        },
        /**
         * A form whose unsaved state "Sign in again" keeps: key names its
         * draft schema (PA.lib.DRAFT_FORMS); serialize() → its fields;
         * restore(fields) puts them back; isDirty() (optional) says whether
         * there is anything to keep. One form is kept: the one registered
         * (or registered again — on a touch) last that has anything to keep.
         */
        registerForm(key, hooks) {
          if (!handle.isCurrent()) return;
          current.forms = current.forms.filter((f) => f.key !== key);
          current.forms.push(Object.assign({ key }, hooks));
        },
      };
      handle.setTitle(opts.title || '', opts.subtitle);
      handle.setBody(opts.body || el('p', { class: 'muted loading', role: 'status', text: 'Loading…' }));
      d.drawer.classList.remove('hidden');
      d.drawer.setAttribute('aria-hidden', 'false');
      d.scrim.classList.remove('hidden');
      d.title.focus();
      return handle;
    },

    isOpen: () => !!current,

    /** Which drawer is open (a number that changes with every open), or null. */
    id: () => (current ? current.token : null),

    isDirty: () => !!current && current.trackers.some((t) => t.isDirty()),

    /** The form of the open drawer a sign-in keeps ({ key, serialize,
     *  restore, isDirty }): the last registered with unsaved changes, else
     *  the last registered; null when none is. */
    activeForm() {
      const forms = current ? current.forms : [];
      for (let i = forms.length - 1; i >= 0; i--) if (!forms[i].isDirty || forms[i].isDirty()) return forms[i];
      return forms.length ? forms[forms.length - 1] : null;
    },

    /** Close now, without asking. `reason` reaches onClose (the app tells a
     *  close it asked for from one the admin did: ✕, Esc, the scrim). */
    close(reason) {
      if (!current) return;
      const c = current;
      current = null;
      const d = drawerEls();
      d.drawer.classList.add('hidden');
      d.drawer.setAttribute('aria-hidden', 'true');
      d.scrim.classList.add('hidden');
      clear(d.body);
      // Its open questions go with it, as a Cancel.
      for (const cancel of [...c.dialogs]) cancel(false);
      // Back to what opened it; failing that, off the control it just hid
      // (a browser leaves focus there), so onClose can find a place for it.
      if (!focusFirst([c.returnFocus])) {
        const a = document.activeElement;
        if (a && a !== document.body && d.drawer.contains(a) && typeof a.blur === 'function') a.blur();
      }
      if (c.onClose) c.onClose(reason);
    },

    /** 'Discard changes?' — resolves true to discard. Asked once at a time:
     *  while it is up (Esc asked, then Back asks again), every caller gets
     *  the same answer to the one question. */
    confirmDiscard() {
      if (!discardQuestion) {
        discardQuestion = confirmDialog({
          title: 'Discard changes?',
          body: 'Something in this panel was changed and not saved.',
          confirmLabel: 'Discard changes',
          cancelLabel: 'Cancel',
          danger: true,
        }).then((v) => {
          discardQuestion = null;
          return v;
        });
      }
      return discardQuestion;
    },

    /** Close, asking 'Discard changes?' first when a tracked form is dirty.
     *  Resolves true if the drawer closed. Only the drawer that asked is
     *  closed: one closed or replaced meanwhile stays as it is. */
    async requestClose() {
      if (!current) return true;
      const asking = current;
      if (drawer.isDirty() && !(await drawer.confirmDiscard())) return false;
      if (current !== asking) return false;
      drawer.close();
      return true;
    },
  };

  // ── Session ───────────────────────────────────────────────────────────────

  let sessionBox = null; // the open "Your session ended" modal

  const SESSION_TITLES = {
    read: 'Your session ended.',
    mutation: 'Your session ended — this change was NOT saved.',
    elsewhere: 'You signed out in another tab.',
  };

  /**
   * "Your session ended", over the page, which stays exactly as it was (the
   * open drawer and its form included). { kind: 'read' | 'mutation' |
   * 'elsewhere', onSignIn }. One at a time: a later call only sharpens the
   * title (a change that was not saved outranks a read). Returns { close }.
   */
  function sessionEnded(opts) {
    const o = opts || {};
    const kind = SESSION_TITLES[o.kind] ? o.kind : 'read';
    const rank = { read: 0, elsewhere: 1, mutation: 2 };
    if (sessionBox && sessionBox.m.isOpen()) {
      if (rank[kind] > rank[sessionBox.kind]) {
        sessionBox.kind = kind;
        sessionBox.m.setTitle(SESSION_TITLES[kind]);
      }
      return sessionBox;
    }
    const signIn = el('button', { class: 'btn btn-primary', text: 'Sign in again' });
    const close = el('button', { class: 'btn', text: 'Close' });
    const m = modal({
      title: SESSION_TITLES[kind],
      body: [el('p', { text: 'Sign in again to continue. Your place and unsaved form will be kept.' })],
      actions: [close, signIn],
      role: 'alertdialog',
      initialFocus: signIn,
      onEscape: () => m.close(),
    });
    m.box.classList.add('modal-session');
    close.addEventListener('click', () => m.close());
    signIn.addEventListener('click', () => {
      signIn.disabled = true;
      signIn.textContent = 'Signing in…';
      if (o.onSignIn) o.onSignIn();
    });
    sessionBox = { kind, m, close: () => m.close() };
    return sessionBox;
  }

  /** Close the "Your session ended" modal, if it is up (signed in again).
   *  Returns whether it was. */
  function sessionResumed() {
    const was = !!sessionBox && sessionBox.m.isOpen();
    if (was) sessionBox.m.close();
    sessionBox = null;
    return was;
  }

  /**
   * The bar that says when the session ends, with one action. It is drawn in
   * two places from index.html: #session-bar under the top bar, and
   * #drawer-session-bar at the top of the drawer. The drawer covers the page
   * (on a phone, all of it), a click beside it lands on the scrim, and Tab
   * stays inside it, so while it is open only its own copy can be seen and
   * reached (styles.css hides the page's) — and the drawer is where an
   * unsaved form is. Returns { show(text, actionLabel, onAction), hide() }.
   * A bar already up keeps its button when the words change ("ends at" →
   * "ended at"), so a keyboard user on it stays there.
   */
  let barAction = null;
  function expiryBar() {
    const hosts = ['session-bar', 'drawer-session-bar'].map((id) => document.getElementById(id)).filter(Boolean);
    return {
      show(text, actionLabel, onAction) {
        barAction = onAction || null;
        for (const host of hosts) {
          let span = host.querySelector('.session-bar-text');
          let btn = host.querySelector('button');
          if (!span) {
            clear(host);
            span = host.appendChild(el('span', { class: 'session-bar-text' }));
            btn = null;
          }
          span.textContent = text;
          if (actionLabel && !btn) btn = host.appendChild(el('button', { class: 'btn btn-sm', onclick: () => barAction && barAction() }));
          if (btn && !actionLabel) {
            host.removeChild(btn);
            btn = null;
          }
          if (btn) btn.textContent = actionLabel;
          host.classList.remove('hidden');
        }
      },
      hide() {
        barAction = null;
        for (const host of hosts) {
          host.classList.add('hidden');
          clear(host);
        }
      },
    };
  }

  /**
   * In place of a guild's view when this admin can't manage it: the reason
   * (the same words whether they aren't an admin or it couldn't be checked),
   * a switcher of the guilds they do manage, and Try again. It never names the
   * guild. With no guild at all ({ none: true }): say so, with Sign out.
   *   { guilds: [{id, name}], none, onPick(gid), onRetry(), onSignOut() }
   */
  function notAdminView(o) {
    const headId = uid('not-admin');
    if (o.none) {
      return el('section', { class: 'not-admin', 'aria-labelledby': headId }, [
        el('h2', { id: headId, tabindex: '-1', text: 'You don’t manage any guild this relay serves right now.' }),
        el('p', { class: 'muted', text: 'Ask the server owner for Manage Server, or ask the relay operator to add you.' }),
        el('div', { class: 'inline' }, [el('button', { class: 'btn', text: 'Sign out', onclick: o.onSignOut })]),
      ]);
    }
    const pick = el('select', {}, [el('option', { value: '', text: 'Pick a guild…' })]
      .concat((o.guilds || []).map((g) => el('option', { value: g.id, text: g.name || g.id }))));
    pick.addEventListener('change', () => {
      if (pick.value) o.onPick(pick.value);
    });
    const retry = el('button', { class: 'btn', text: 'Try again' });
    retry.addEventListener('click', () => busy(retry, () => o.onRetry(), 'Checking…'));
    return el('section', { class: 'not-admin', 'aria-labelledby': headId }, [
      el('h2', { id: headId, tabindex: '-1', text: PA.lib.NOT_GUILD_ADMIN }),
      (o.guilds || []).length ? field({ label: 'Go to a guild you manage', control: pick }) : null,
      el('div', { class: 'inline' }, [retry]),
    ]);
  }

  // Keyboard for the modal layer and the drawer. Capture phase, so it runs
  // before anything else on the page sees the key.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' && e.key !== 'Tab') return;
      if (modals.length) {
        const top = modals[modals.length - 1];
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (top.onEscape) top.onEscape();
        } else trapTab(e, top.box);
        return;
      }
      // Esc on a toast's ✕ dismisses that message, and only that.
      const t = e.key === 'Escape' ? toastOf(document.activeElement) : null;
      if (t && dismissers.has(t)) {
        e.preventDefault();
        e.stopPropagation();
        dismissers.get(t)();
        return;
      }
      // Esc in a type-ahead whose list is open closes the list (its own
      // handler); the next Esc is the drawer's.
      const f = document.activeElement;
      if (e.key === 'Escape' && f && f.getAttribute && f.getAttribute('role') === 'combobox' && f.getAttribute('aria-expanded') === 'true') return;
      // Esc on a direct-grant control holding a keyboard step cancels the
      // step (its own handler). Taking it here would move focus off the
      // control, and leaving it applies the step: the opposite of Esc.
      if (e.key === 'Escape' && f && f.getAttribute && f.getAttribute('data-esc-own') === 'true') return;
      if (!current) return;
      const d = drawerEls();
      // The toasts sit outside the drawer (above it), but their ✕s join its Tab
      // cycle: a sticky error can be dismissed without closing the drawer.
      if (e.key === 'Tab') return trapTab(e, [d.drawer, document.getElementById('toasts')]);
      // Esc: unsaved changes → ask; a focused field → just leave the field;
      // otherwise close.
      e.preventDefault();
      e.stopPropagation();
      if (drawer.isDirty()) {
        drawer.requestClose();
        return;
      }
      const a = document.activeElement;
      if (isField(a) && d.drawer.contains(a)) {
        d.drawer.focus();
        return;
      }
      drawer.close();
    },
    true,
  );

  PA.ui = {
    el,
    clear,
    uid,
    field,
    toast,
    statusLine,
    busy,
    isBusy,
    setDisabled,
    onSubmit,
    modal,
    modalOpen,
    confirmDialog,
    levelControl,
    capsEditor,
    checkList,
    radioGroup,
    typeahead,
    levelPill,
    customStart,
    directGrantControl,
    copyText,
    dirtyTracker,
    drawer,
    sessionEnded,
    sessionResumed,
    expiryBar,
    notAdminView,
  };
})();
