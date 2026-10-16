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
 *   modal              the shared modal layer (focus trap, Esc)
 *   dirtyTracker       has this form changed since it was drawn or saved?
 *   drawer             the right-side drawer: focus, Esc, scrim, "Discard changes?"
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
   * role=alert and sticky with a ✕; the rest hide after about 6 s unless
   * sticky is set. While the drawer is open, Tab reaches the ✕ after the
   * drawer's last control, and Esc on a toast dismisses it. Returns
   * { node, dismiss }.
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
   * reported something newer (say, the same form then succeeded).
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
      if (!o || o.toast !== false) mirror = toast((o && o.toastText) || toText(msg), { kind });
    }
    return {
      node,
      ok: (msg, o) => set('ok', msg, o),
      err: (msg, o) => set('err', msg, o),
      info: (msg, o) => set('info', msg, Object.assign({ toast: false }, o)),
      clear() {
        unmirror();
        node.className = 'status-line hidden';
        clear(node);
      },
    };
  }

  // ── One request per click ─────────────────────────────────────────────────

  const busyButtons = new WeakSet();

  /**
   * Lock `button` while `work` (a promise, or a function returning one) runs:
   * disabled, aria-busy, relabelled ('Saving…' unless `label` is given).
   * Restores it when the work settles. Returns the work's promise.
   */
  function busy(button, work, label) {
    const prev = { text: button.textContent, disabled: button.disabled };
    // Disabling a focused button drops focus to <body>; hand it back after.
    const hadFocus = document.activeElement === button;
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
      button.disabled = prev.disabled;
      button.removeAttribute('aria-busy');
      button.textContent = prev.text;
      const a = document.activeElement;
      if (hadFocus && button.isConnected && !button.disabled && (!a || a === document.body)) button.focus();
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
      const p = button ? busy(button, work, o.busyLabel) : Promise.resolve().then(work);
      p.catch((err) => console.error('[portal-admin]', err)).then(() => {
        pending = false;
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
   * was. Returns { box, close }.
   */
  function modal(opts) {
    const titleId = uid('modal-title');
    const box = el('div', { class: 'modal', role: opts.role || 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
      el('h2', { id: titleId, text: opts.title }),
      ...[].concat(opts.body || []),
      el('div', { class: 'modal-actions' }, opts.actions || []),
    ]);
    const backdrop = el('div', { class: 'modal-backdrop' }, [box]);
    const opener = document.activeElement;
    const entry = { box, onEscape: opts.onEscape };
    document.body.appendChild(backdrop);
    modals.push(entry);
    (opts.initialFocus || box).focus();
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      const i = modals.indexOf(entry);
      if (i >= 0) modals.splice(i, 1);
      const back = [opts.returnFocus, opener].find((n) => n && n !== document.body && n.isConnected && typeof n.focus === 'function');
      if (back) back.focus();
    }
    return { box, close };
  }

  function modalOpen() {
    return modals.length > 0;
  }

  /**
   * Ask before acting: { title, body, confirmLabel, cancelLabel, danger }.
   * Resolves true for the confirm button, false for Cancel or Esc. A danger
   * confirm starts on Cancel, so Enter doesn't destroy anything by itself.
   */
  function confirmDialog(opts) {
    return new Promise((resolve) => {
      let m = null;
      const finish = (v) => {
        if (m) m.close();
        resolve(v);
      };
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

  /** Has `form` changed since it was drawn or last reset()? Controls marked
   *  data-no-dirty (ones that save the moment they change) don't count. */
  function dirtyTracker(form) {
    let base = snapshot(form);
    return {
      isDirty: () => snapshot(form) !== base,
      reset() {
        base = snapshot(form);
      },
    };
  }

  // ── The drawer ────────────────────────────────────────────────────────────
  // Markup lives in index.html: #drawer (role=dialog) with #drawer-title,
  // #drawer-close and #drawer-body, behind #drawer-scrim.

  let drawerSeq = 0;
  let current = null; // { token, trackers, onClose, returnFocus }
  let drawerBound = false;

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
     * body it shows 'Loading…'. Returns a handle whose setBody/setTitle do
     * nothing once this drawer has been closed or replaced.
     */
    open(opts) {
      bindDrawer();
      const d = drawerEls();
      const returnFocus = current ? current.returnFocus : document.activeElement;
      current = { token: ++drawerSeq, trackers: [], onClose: opts.onClose || null, returnFocus };
      const token = current.token;
      const handle = {
        isCurrent: () => !!current && current.token === token,
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

    isDirty: () => !!current && current.trackers.some((t) => t.isDirty()),

    /** Close now, without asking. */
    close() {
      if (!current) return;
      const c = current;
      current = null;
      const d = drawerEls();
      d.drawer.classList.add('hidden');
      d.drawer.setAttribute('aria-hidden', 'true');
      d.scrim.classList.add('hidden');
      clear(d.body);
      if (c.returnFocus && c.returnFocus.isConnected && typeof c.returnFocus.focus === 'function') c.returnFocus.focus();
      if (c.onClose) c.onClose();
    },

    /** Close, asking 'Discard changes?' first when a tracked form is dirty.
     *  Resolves true if the drawer closed. */
    async requestClose() {
      if (!current) return true;
      if (drawer.isDirty()) {
        const discard = await confirmDialog({
          title: 'Discard changes?',
          body: 'Something in this panel was changed and not saved.',
          confirmLabel: 'Discard changes',
          cancelLabel: 'Cancel',
          danger: true,
        });
        if (!discard) return false;
      }
      drawer.close();
      return true;
    },
  };

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
    onSubmit,
    modal,
    modalOpen,
    confirmDialog,
    dirtyTracker,
    drawer,
  };
})();
