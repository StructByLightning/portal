// The admin panel's client scripts (portal-admin/*.js), run in node:vm.
//
// Pins the rules every panel script follows — one IIFE assigning a single
// global (window.PA.<module>), and no HTML parsing of data — and the
// behaviour of ui.js's feedback helpers: busy() locks a button for exactly one
// request, onSubmit() ignores a second submit while the first is pending,
// errors toast stickily (and their ✕ can be reached from the keyboard while
// the drawer is open), and dirtyTracker() notices edits. lib.js (pure) is
// checked against the relay's own capability tables, and ui.levelControl and
// the persona drawer's direct-grant editor are driven as an admin would.
// app.js is booted against a fake API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { LEVEL_CAPS } from '../src/slash.js';
import { ALL_CAPS } from '../src/permissions.js';

const ADMIN = fileURLToPath(new URL('../../portal-admin/', import.meta.url));
const SCRIPTS = ['lib.js', 'ui.js', 'app.js'];
const source = (f: string) => readFileSync(join(ADMIN, f), 'utf8');

// ── A minimal DOM: enough for ui.js's helpers, and for booting app.js ──

/** Selectors as the panel uses them: comma lists of compound selectors made
 *  of tag, #id, .class, [attr], [attr="v"] and :not(…). No combinators. */
function matchesSelector(el: FakeElement, sel: string): boolean {
  return sel.split(/,(?![^(]*\))/).some((part) => matchesCompound(el, part.trim()));
}
function matchesCompound(el: FakeElement, sel: string): boolean {
  const m = /^([a-zA-Z][\w-]*)?(.*)$/.exec(sel)!;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  const tokens = m[2].match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|:not\([^)]*\)/g) ?? [];
  if (tokens.join('') !== m[2]) throw new Error('fake DOM: unsupported selector ' + JSON.stringify(sel));
  return tokens.every((t) => {
    if (t.startsWith('#')) return el.id === t.slice(1);
    if (t.startsWith('.')) return el.classList.contains(t.slice(1));
    if (t.startsWith(':not(')) return !matchesCompound(el, t.slice(5, -1));
    const a = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(t);
    if (!a) throw new Error('fake DOM: unsupported selector ' + JSON.stringify(sel));
    const v = a[1] === 'type' ? el.type || el.getAttribute('type') : el.getAttribute(a[1]);
    return a[2] === undefined ? v !== null : v === a[2];
  });
}

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  appendChild(n: FakeNode) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  removeChild(n: FakeNode) {
    const i = this.childNodes.indexOf(n);
    if (i < 0) throw new Error('not a child');
    this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '') this.appendChild(new FakeText(String(v)));
  }
}

class FakeText extends FakeNode {
  constructor(public data: string) {
    super();
  }
  override get textContent() {
    return this.data;
  }
}

class FakeElement extends FakeNode {
  attrs = new Map<string, string>();
  listeners = new Map<string, Array<(e: unknown) => void>>();
  style: Record<string, string> = {};
  value = '';
  checked = false;
  type = '';
  constructor(public tagName: string, private doc: FakeDocument) {
    super();
  }
  get children() {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }
  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }
  get disabled() {
    return this.attrs.has('disabled');
  }
  set disabled(v: boolean) {
    if (v) this.attrs.set('disabled', '');
    else this.attrs.delete('disabled');
  }
  get dataset(): Record<string, string | undefined> {
    return new Proxy({}, {
      get: (_t, k) => (typeof k === 'string' ? this.attrs.get('data-' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())) : undefined),
    });
  }
  get options() {
    return this.querySelectorAll('option');
  }
  matches(sel: string) {
    return matchesSelector(this, sel);
  }
  closest(sel: string): FakeElement | null {
    for (let n: FakeNode | null = this; n; n = n.parentNode) if (n instanceof FakeElement && n.matches(sel)) return n;
    return null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.childNodes) {
        if (!(c instanceof FakeElement)) continue;
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  contains(n: FakeNode | null) {
    for (; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  /** display:none comes from the .hidden class here, as in styles.css. */
  checkVisibility() {
    for (let n: FakeNode | null = this; n instanceof FakeElement; n = n.parentNode) if (n.classList.contains('hidden')) return false;
    return true;
  }
  get className() {
    return this.attrs.get('class') ?? '';
  }
  set className(v: string) {
    this.attrs.set('class', v);
  }
  get id() {
    return this.attrs.get('id') ?? '';
  }
  set id(v: string) {
    this.attrs.set('id', v);
  }
  get classList() {
    const get = () => this.className.split(/\s+/).filter(Boolean);
    const set = (xs: string[]) => (this.className = xs.join(' '));
    return {
      contains: (c: string) => get().includes(c),
      add: (c: string) => set([...new Set([...get(), c])]),
      remove: (c: string) => set(get().filter((x) => x !== c)),
      toggle: (c: string, on?: boolean) => {
        const want = on ?? !get().includes(c);
        set(want ? [...new Set([...get(), c])] : get().filter((x) => x !== c));
        return want;
      },
    };
  }
  setAttribute(k: string, v: string) {
    if (k === 'type') this.type = v;
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  fire(type: string, e: Record<string, unknown> = {}) {
    const ev = { type, target: this, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {}, ...e };
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    return ev;
  }
  click() {
    if (!this.disabled) this.fire('click');
  }
  focus() {
    this.doc.activeElement = this;
  }
  get isConnected(): boolean {
    let n: FakeNode | null = this;
    while (n) {
      if (n === this.doc.body) return true;
      n = n.parentNode;
    }
    return false;
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML must not be used');
  }
}

class FakeDocument {
  body: FakeElement;
  activeElement: FakeElement;
  listeners: Array<[string, unknown]> = [];
  constructor() {
    this.body = new FakeElement('BODY', this);
    this.activeElement = this.body;
  }
  createElement(tag: string) {
    return new FakeElement(tag.toUpperCase(), this);
  }
  createTextNode(s: string) {
    return new FakeText(s);
  }
  getElementById(id: string): FakeElement | null {
    const walk = (n: FakeNode): FakeElement | null => {
      if (n instanceof FakeElement && n.id === id) return n;
      for (const c of n.childNodes) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this.body);
  }
  addEventListener(type: string, fn: unknown) {
    this.listeners.push([type, fn]);
  }
  querySelector(sel: string) {
    return this.body.querySelector(sel);
  }
  querySelectorAll(sel: string) {
    return this.body.querySelectorAll(sel);
  }
  /** Dispatch a key to the document's keydown listeners (ui.js's runs first,
   *  as it is registered first, in the capture phase). */
  key(key: string, opts: { shiftKey?: boolean } = {}) {
    const ev = { key, shiftKey: !!opts.shiftKey, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {} };
    for (const [type, fn] of this.listeners) if (type === 'keydown') (fn as (e: unknown) => void)(ev);
    return ev;
  }
}

/** A sandbox with a fake document and a manual clock. */
function sandbox() {
  const doc = new FakeDocument();
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const ctx = vm.createContext({
    document: doc,
    console,
    setTimeout: (fn: () => void, ms = 0) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (id: number) => timers.delete(id),
  }) as Record<string, any>;
  ctx.window = ctx;
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return { ctx, doc, advance };
}

function load(ctx: object, files = SCRIPTS) {
  for (const f of files) vm.runInContext(source(f), ctx, { filename: f });
}

const tick = () => new Promise((r) => setImmediate(r));

// ── The rules every panel script follows ──

test('panel scripts: the only global they add is PA (window.PA.lib, .ui, .app)', () => {
  const { ctx } = sandbox();
  const before = new Set(Object.getOwnPropertyNames(ctx));
  load(ctx);
  const added = Object.getOwnPropertyNames(ctx).filter((k) => !before.has(k));
  assert.deepEqual(added, ['PA']);
  assert.deepEqual(Object.keys(ctx.PA).sort(), ['app', 'lib', 'ui']);
  assert.equal(typeof ctx.PA.ui.toast, 'function');
  assert.equal(typeof ctx.PA.app.boot, 'function');
});

test('panel scripts: no top-level let/const/class (a second load would collide)', () => {
  // Top-level lexical declarations of classic scripts share one global scope
  // without becoming properties, so the property check above can't see them;
  // loading a script twice into one realm throws if it has any.
  const { ctx } = sandbox();
  load(ctx);
  assert.doesNotThrow(() => load(ctx));
  // The instrument itself: a leaking script IS caught this way.
  const probe = sandbox().ctx;
  vm.runInContext('const leaked = 1;', probe);
  assert.throws(() => vm.runInContext('const leaked = 1;', probe), /already been declared/);
});

test('panel scripts: data never goes through an HTML parser', () => {
  for (const f of SCRIPTS) {
    const src = source(f);
    assert.doesNotMatch(src, /\.(inner|outer)HTML\s*=|insertAdjacentHTML|document\.write\s*\(/, f);
  }
});

test('index.html loads lib.js, ui.js, then app.js, deferred and versioned', () => {
  const html = source('index.html');
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(scripts.length, 3);
  assert.match(scripts[0], /src="lib\.js\?v=\d+"/);
  assert.match(scripts[1], /src="ui\.js\?v=\d+"/);
  assert.match(scripts[2], /src="app\.js\?v=\d+"/);
  for (const s of scripts) assert.match(s, /\sdefer\b/);
  assert.match(html, /id="toasts"/);
});

// ── ui.js ──

test('ui.el: a <button> defaults to type=button; "html" is just an attribute', () => {
  const { ctx } = sandbox();
  load(ctx, ['ui.js']);
  const { el } = ctx.PA.ui;
  assert.equal(el('button', { text: 'Go' }).getAttribute('type'), 'button');
  assert.equal(el('button', { type: 'submit' }).getAttribute('type'), 'submit');
  const div = el('div', { html: '<b>x</b>' }); // the setter throws if used
  assert.equal(div.getAttribute('html'), '<b>x</b>');
  assert.equal(el('p', {}, ['a', el('b', { text: 'c' }), 'd']).textContent, 'acd');
});

test('ui.busy: locks the button while the work runs, then restores it', async () => {
  const { ctx } = sandbox();
  load(ctx, ['ui.js']);
  const { el, busy, isBusy } = ctx.PA.ui;
  const b = el('button', { text: 'Mint invite' });
  let release!: (v: string) => void;
  const p = busy(b, new Promise<string>((r) => (release = r)), 'Minting…');
  assert.equal(b.disabled, true);
  assert.equal(b.getAttribute('aria-busy'), 'true');
  assert.equal(b.textContent, 'Minting…');
  assert.equal(isBusy(b), true);
  release('done');
  assert.equal(await p, 'done');
  assert.equal(b.disabled, false);
  assert.equal(b.getAttribute('aria-busy'), null);
  assert.equal(b.textContent, 'Mint invite');
  assert.equal(isBusy(b), false);

  // Default label, a failure passes through, and the button still comes back.
  const q = busy(b, () => Promise.reject(new Error('nope')));
  assert.equal(b.textContent, 'Saving…');
  await assert.rejects(q, /nope/);
  assert.equal(b.disabled, false);
  assert.equal(b.textContent, 'Mint invite');
});

test('ui.onSubmit: a second submit while the first is pending sends nothing', async () => {
  const { ctx } = sandbox();
  load(ctx, ['ui.js']);
  const { el, onSubmit } = ctx.PA.ui;
  const form = el('form');
  const button = el('button', { type: 'submit', text: 'Save' });
  form.appendChild(button);
  let calls = 0;
  let release!: () => void;
  onSubmit(form, () => {
    calls++;
    return new Promise<void>((r) => (release = r));
  }, { button });
  const first = form.fire('submit');
  form.fire('submit'); // a double click, or Enter twice
  assert.equal(first.defaultPrevented, true);
  assert.equal(calls, 1);
  assert.equal(button.textContent, 'Saving…');
  release();
  await tick();
  assert.equal(button.disabled, false);
  form.fire('submit');
  assert.equal(calls, 2, 'once settled, the form submits again');
});

test('ui.toast: errors are alerts that stay until dismissed; the rest fade after 6 s', () => {
  const { ctx, doc, advance } = sandbox();
  load(ctx, ['ui.js']);
  const { el, toast } = ctx.PA.ui;
  const host = el('div', { id: 'toasts' });
  doc.body.appendChild(host);

  toast('Gave Aria access role g1-readers.');
  const err = toast('Not saved: channel is not in this guild.', { kind: 'err' });
  assert.equal(host.children.length, 2);
  assert.equal(err.node.getAttribute('role'), 'alert');
  const x = err.node.children.find((c: FakeElement) => c.tagName === 'BUTTON');
  assert.ok(x, 'an error toast has a dismiss button');
  assert.equal(x.getAttribute('aria-label'), 'Dismiss this message');

  advance(5_900);
  assert.equal(host.children.length, 2, 'not before about 6 s');
  advance(200);
  assert.equal(host.children.length, 1, 'the success toast is gone');
  advance(60_000);
  assert.equal(host.children.length, 1, 'the error stays');
  x.click();
  assert.equal(host.children.length, 0);
});

test('ui.statusLine: the line holds the result and mirrors it as a toast; a newer result replaces the toast', () => {
  const { ctx, doc } = sandbox();
  load(ctx, ['ui.js']);
  const { el, statusLine } = ctx.PA.ui;
  const host = el('div', { id: 'toasts' });
  doc.body.appendChild(host);
  const section = el('section');
  const s = statusLine(section);
  const texts = () => host.children.map((n) => n.textContent);
  assert.ok(s.node.classList.contains('hidden'));
  s.err('Not minted: pick at least one access role.');
  assert.equal(s.node.textContent, 'Not minted: pick at least one access role.');
  assert.ok(s.node.classList.contains('status-err'));
  assert.equal(host.children.at(-1)!.getAttribute('role'), 'alert');
  // The same form then succeeds: the error toast is out of date and goes.
  s.ok(['Minted ', el('code', { text: 'inv_x' }), '.'], { toastText: 'Invite minted.' });
  assert.equal(s.node.textContent, 'Minted inv_x.');
  assert.deepEqual(texts(), ['Invite minted.'], 'the earlier error toast is gone');
  // A result shown without a toast still takes the old one down.
  s.ok('quiet', { toast: false });
  assert.deepEqual(texts(), []);
  s.err('Not minted: an invented failure.');
  assert.equal(host.children.length, 1);
  s.clear();
  assert.ok(s.node.classList.contains('hidden'));
  assert.equal(s.node.textContent, '');
  assert.deepEqual(texts(), [], 'clear() takes its toast down too');
});

test('ui.statusLine: a line takes down only its own toast', () => {
  const { ctx, doc } = sandbox();
  load(ctx, ['ui.js']);
  const { el, statusLine, toast } = ctx.PA.ui;
  const host = el('div', { id: 'toasts' });
  doc.body.appendChild(host);
  const section = el('section');
  const list = statusLine(section);
  const form = statusLine(section);
  const texts = () => host.children.map((n) => n.textContent);
  list.err('Not revoked: an invented failure.');
  form.err('Not minted: pick at least one access role.');
  toast('Not saved: something else.', { kind: 'err' });
  form.ok('Minted inv_x.', { toastText: 'Invite minted.' });
  assert.deepEqual(texts(), ['Not revoked: an invented failure.✕', 'Not saved: something else.✕', 'Invite minted.']);
  // Dismissed with its ✕ first: the newer result has nothing left to take down.
  host.children[0].querySelector('.toast-x')!.click();
  list.ok('Revoked invite guests.');
  assert.deepEqual(texts(), ['Not saved: something else.✕', 'Invite minted.', 'Revoked invite guests.']);
});

test('ui.toast: the page keeps room for the stack (--toasts-h, its height from the bottom of the screen)', () => {
  const { ctx, doc } = sandbox();
  const props: Record<string, string> = {};
  (doc as any).documentElement = { style: { setProperty: (k: string, v: string) => (props[k] = v) } };
  const observers: Array<() => void> = [];
  ctx.ResizeObserver = class {
    constructor(private fn: () => void) {}
    observe() {
      observers.push(this.fn);
    }
  };
  ctx.innerHeight = 900;
  ctx.addEventListener = () => {};
  load(ctx, ['ui.js']);
  const { el, toast } = ctx.PA.ui;
  const host = el('div', { id: 'toasts' });
  let top = 900;
  (host as any).getBoundingClientRect = () => ({ top });
  doc.body.appendChild(host);
  const t = toast('Not saved: an invented failure.', { kind: 'err' });
  assert.equal(observers.length, 1, 'the stack is watched once it is first used');
  top = 846; // 42px of toast above a 12px margin
  observers[0]();
  assert.equal(props['--toasts-h'], '54px');
  toast('Second.', { kind: 'err' });
  assert.equal(observers.length, 1);
  t.dismiss();
  host.children[0].querySelector('.toast-x')!.click();
  top = 888;
  observers[0]();
  assert.equal(props['--toasts-h'], '0px', 'no room kept once the stack is empty');
});

test('styles.css: the toast stack sits at the bottom, and the page and a narrow drawer keep room for it', () => {
  const css = source('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const stack = rules.filter((r) => /(^|\s)\.toasts$/.test(r.sel));
  assert.ok(stack.length >= 2, 'a wide and a phone rule');
  for (const r of stack) assert.doesNotMatch(r.body, /(^|[\s;])top\s*:/, r.sel + ' must not anchor to the top (it covered the toolbar and tabs)');
  assert.match(stack[0].body, /bottom\s*:/);
  for (const sel of ['.view', '.drawer-body']) {
    assert.ok(rules.some((r) => r.sel === sel && /padding(-bottom)?\s*:[^;]*var\(--toasts-h/.test(r.body)), sel + ' keeps room for the stack');
  }
});

test('ui.dirtyTracker: edits make a form dirty; reset() and data-no-dirty do not count', () => {
  const { ctx } = sandbox();
  load(ctx, ['ui.js']);
  const { el, dirtyTracker } = ctx.PA.ui;
  const text = el('input', { type: 'text' });
  const box = el('input', { type: 'checkbox' });
  const instant = el('select', { 'data-no-dirty': true });
  const submit = el('button', { type: 'submit' });
  const form = el('form');
  (form as any).elements = [text, box, instant, submit];
  const t = dirtyTracker(form);
  assert.equal(t.isDirty(), false);
  text.value = 'inv_typo';
  assert.equal(t.isDirty(), true);
  text.value = '';
  assert.equal(t.isDirty(), false, 'typing then deleting is clean again');
  box.checked = true;
  assert.equal(t.isDirty(), true);
  t.reset();
  assert.equal(t.isDirty(), false);
  instant.value = 'g1-readers';
  assert.equal(t.isDirty(), false);
});

// ── The drawer and the toast stack, from the keyboard ──

/** index.html's drawer markup and toast stack. */
function drawerDom(doc: FakeDocument, el: (...a: any[]) => FakeElement) {
  const title = el('h2', { id: 'drawer-title', tabindex: '-1' });
  const close = el('button', { id: 'drawer-close', 'aria-label': 'Close panel', text: '✕' });
  const body = el('div', { id: 'drawer-body' });
  const drawer = el('aside', { id: 'drawer', class: 'drawer hidden', role: 'dialog', tabindex: '-1' }, [el('header', {}, [title, close]), body]);
  doc.body.appendChild(el('div', { id: 'drawer-scrim', class: 'drawer-scrim hidden' }));
  doc.body.appendChild(drawer);
  const toasts = el('div', { id: 'toasts' });
  doc.body.appendChild(toasts);
  return { title, close, drawer, toasts };
}

test('ui.drawer: Tab reaches a sticky toast’s ✕ from the drawer; ✕ and Esc dismiss it and leave the drawer open', () => {
  const { ctx, doc } = sandbox();
  load(ctx, ['ui.js']);
  const { el, drawer, statusLine } = ctx.PA.ui;
  const dom = drawerDom(doc, el);
  const label = el('input', { type: 'text' });
  const submit = el('button', { type: 'submit', text: 'Mint invite' });
  const form = el('form', {}, [label, submit]);
  drawer.open({ title: 'Mint invite', body: form });
  assert.equal(doc.activeElement, dom.title);

  // No toast: the drawer's own cycle, as before.
  submit.focus();
  assert.equal(doc.key('Tab').defaultPrevented, true);
  assert.equal(doc.activeElement, dom.close, 'Tab from the last control wraps to the first');
  label.focus();
  assert.equal(doc.key('Tab').defaultPrevented, false, 'within the drawer the browser moves focus');

  const status = statusLine(form);
  status.err('Not minted: pick at least one access role.');
  const x = dom.toasts.querySelector('.toast-x')!;
  assert.ok(x, 'the error toast has a ✕');
  submit.focus();
  doc.key('Tab');
  assert.equal(doc.activeElement, x, 'Tab goes on from the drawer’s last control to the toast’s ✕');
  doc.key('Tab');
  assert.equal(doc.activeElement, dom.close, '…and from there round to the drawer');
  doc.key('Tab', { shiftKey: true });
  assert.equal(doc.activeElement, x, 'Shift+Tab from the first control reaches the ✕');
  doc.key('Tab', { shiftKey: true });
  assert.equal(doc.activeElement, submit, '…and Shift+Tab again is back in the drawer');
  dom.title.focus();
  doc.key('Tab', { shiftKey: true });
  assert.equal(doc.activeElement, x, 'Shift+Tab from the drawer title reaches the ✕ too');

  // The ✕: the message goes, focus goes back into the drawer, which stays open.
  x.click();
  assert.equal(dom.toasts.children.length, 0);
  assert.equal(doc.activeElement, dom.title);
  assert.equal(drawer.isOpen(), true);
  assert.equal(status.node.textContent, 'Not minted: pick at least one access role.', 'the status line keeps the error');

  // Esc on a ✕ dismisses that message only; focus moves to the next one.
  // (Two lines: a line's newer result would take its own older toast down.)
  status.err('First.');
  statusLine(form).err('Second.');
  const [x1, x2] = dom.toasts.querySelectorAll('.toast-x');
  x1.focus();
  assert.equal(doc.key('Escape').defaultPrevented, true);
  assert.deepEqual(dom.toasts.children.map((n) => n.textContent), ['Second.✕']);
  assert.equal(doc.activeElement, x2);
  assert.equal(drawer.isOpen(), true, 'Esc on a toast does not close the drawer');
  doc.key('Escape');
  assert.equal(dom.toasts.children.length, 0);
  assert.equal(doc.activeElement, dom.title);
  assert.equal(drawer.isOpen(), true);
  doc.key('Escape');
  assert.equal(drawer.isOpen(), false, 'Esc anywhere else in the drawer still closes it');
});

test('ui.toast: the ✕ is described by its message', () => {
  const { ctx, doc } = sandbox();
  load(ctx, ['ui.js']);
  const { el, toast } = ctx.PA.ui;
  doc.body.appendChild(el('div', { id: 'toasts' }));
  const t = toast('Not saved: channel is not in this guild.', { kind: 'err' });
  const x = t.node.querySelector('.toast-x')!;
  const msg = doc.getElementById(x.getAttribute('aria-describedby')!)!;
  assert.equal(msg.textContent, 'Not saved: channel is not in this guild.');
});

// ── app.js, booted against a fake admin API ──

const G1 = '100000000000000001'; // the preview harness's invented Guild One

/** Answers a mutation (or overrides a read): a body, or undefined for the default. */
type FakeHandler = (method: string, pathAndQuery: string, body: any) => unknown;

/** A sandbox with index.html's shell, signed in as a one-guild admin. Every
 *  request lands in `calls` as 'METHOD /path?query', and every JSON body sent
 *  in `bodies`. `routes` adds or replaces GET answers by path. */
function appSandbox(opts: { routes?: Record<string, unknown>; handle?: FakeHandler } = {}) {
  const box = sandbox();
  const { ctx, doc } = box;
  const calls: string[] = [];
  const bodies: any[] = [];
  Object.assign(ctx, {
    URLSearchParams,
    location: { search: '', pathname: '/', hash: '' },
    history: { replaceState() {} },
    fetch: async (path: string, req: { method: string; body?: string }) => {
      calls.push(req.method + ' ' + path);
      const url = new URL(path, 'http://panel.invalid');
      const route = url.pathname;
      const g = '/admin/g/' + G1;
      const routes: Record<string, unknown> = {
        '/admin/me': { user: { name: 'Gwen' }, isSuper: false, guilds: [{ id: G1, name: 'Guild One' }], csrf: 'csrf-test' },
        '/admin/guilds': { guilds: [{ id: G1, name: 'Guild One' }] },
        [g + '/roles']: { catalog: {}, discordRoles: [], canAuthor: false },
        [g + '/channels']: { channels: [] },
        [g + '/personas']: { personas: [{ id: 'aria', displayName: 'Aria', roles: [] }], total: 1, limit: 50, offset: 0 },
        [g + '/invites']: { invites: [{ code: 'inv_fixtureinvite0000000a', label: 'test', mode: 'mint', uses: 0, roles: ['g1-readers'] }], total: 1, limit: 50, offset: 0 },
        ...opts.routes,
      };
      const sent = req.body ? JSON.parse(req.body) : undefined;
      if (sent !== undefined) bodies.push(sent);
      let body = opts.handle?.(req.method, route + url.search, sent);
      if (body === undefined) body = req.method === 'DELETE' ? {} : req.method === 'GET' ? routes[route] : undefined;
      if (body === undefined) return { status: 404, ok: false, text: async () => '{"error":{"code":"NOT_FOUND"}}' };
      return { status: 200, ok: true, text: async () => JSON.stringify(body) };
    },
  });
  load(ctx);
  const { el } = ctx.PA.ui;
  const tab = (name: string, cls = 'tab') => el('button', { class: cls, 'data-tab': name, text: name });
  const tabs = { personas: tab('personas'), invites: tab('invites'), roles: tab('roles'), audit: tab('audit'), guilds: tab('guilds', 'tab tab-super hidden') };
  doc.body.appendChild(el('div', { id: 'login', class: 'hidden' }, [el('p', { id: 'login-error', class: 'hidden' })]));
  doc.body.appendChild(el('div', { id: 'app', class: 'hidden' }, [
    el('header', {}, [
      el('span', { id: 'user-name' }), el('span', { id: 'super-badge', class: 'hidden' }),
      el('select', { id: 'guild-select' }), el('span', { id: 'guild-static', class: 'hidden' }),
      el('nav', {}, Object.values(tabs)), el('button', { id: 'logout-btn', text: 'Sign out' }),
    ]),
    el('main', { id: 'view' }),
  ]));
  drawerDom(doc, el);
  return { ...box, calls, bodies, tabs };
}

async function settle() {
  for (let i = 0; i < 30; i++) await tick();
}

test('app list search: a query typed just before leaving a tab does not follow you to the next one', async () => {
  const { ctx, doc, advance, calls, tabs } = appSandbox();
  await ctx.PA.app.boot();
  await settle();
  const g = '/admin/g/' + G1;
  assert.ok(calls.includes(`GET ${g}/personas?limit=50&offset=0`), calls.join('\n'));
  const search = () => doc.getElementById('list-search')!;

  // Type on Personas, and switch to Invites inside the 250 ms debounce.
  search().value = 'zz';
  search().fire('input');
  tabs.invites.click();
  await settle();
  assert.equal(search().getAttribute('placeholder'), 'Search invites…');
  assert.equal(search().value, '');
  const mark = calls.length;
  advance(300);
  await settle();
  assert.deepEqual(calls.slice(mark), [], 'the Personas box’s timer sends nothing once Invites has replaced it');

  // The Invites list's next redraw (here after a revoke) is unfiltered, as its empty box says.
  doc.querySelectorAll('button').find((b) => b.textContent === 'Revoke')!.click();
  await settle();
  doc.querySelector('button.btn-danger-solid')!.click();
  await settle();
  assert.deepEqual(calls.slice(mark), [`DELETE ${g}/invites/inv_fixtureinvite0000000a`, `GET ${g}/invites?limit=50&offset=0`]);

  // Searching on the tab you are on still works.
  search().value = 'test';
  search().fire('input');
  advance(300);
  await settle();
  assert.equal(calls.at(-1), `GET ${g}/invites?q=test&limit=50&offset=0`);
  assert.equal(search().value, 'test');
});

// ── lib.js: pure, and in step with the relay ──

/** lib.js alone, in a sandbox with nothing in it (no window, no document). */
function libOnly() {
  const ctx = vm.createContext({}) as Record<string, any>;
  const before = new Set(Object.getOwnPropertyNames(ctx));
  vm.runInContext(source('lib.js'), ctx, { filename: 'lib.js' });
  return { lib: ctx.PA.lib, added: Object.getOwnPropertyNames(ctx).filter((k) => !before.has(k)), keys: Object.keys(ctx.PA) };
}
/** Values from the sandbox's realm, as plain data of this one. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test('lib.js runs in an empty sandbox and adds only PA.lib', () => {
  const { lib, added, keys } = libOnly();
  assert.deepEqual(added, ['PA']);
  assert.deepEqual(keys, ['lib']);
  assert.equal(typeof lib.levelOf, 'function');
});

test('lib.js: LEVEL_CAPS and ALL_CAPS are the relay’s (slash.ts, permissions.ts)', () => {
  const { lib } = libOnly();
  assert.deepEqual(plain(lib.LEVEL_CAPS), plain(LEVEL_CAPS));
  assert.deepEqual(plain(lib.ALL_CAPS), plain(ALL_CAPS));
  assert.equal(lib.ALL_CAPS.length, 14);
  assert.equal(lib.LEVEL_CAPS.write.length, 9);
  // Custom… offers every capability once, voice included.
  const grouped = lib.CAP_GROUPS.flatMap((g: { caps: string[] }) => [...g.caps]);
  assert.deepEqual([...grouped].sort(), [...ALL_CAPS].sort());
  assert.equal(new Set(grouped).size, grouped.length);
  assert.deepEqual(plain(lib.CAP_GROUPS.map((g: { label: string }) => g.label)), ['Read', 'Write', 'Moderation', 'Voice']);
  for (const c of ALL_CAPS) assert.ok(lib.CAP_LABEL[c] && lib.CAP_WORDS[c], c + ' has a label and words');
});

test('lib.levelOf: presets, supersets and sets that hold no preset', () => {
  const { lib } = libOnly();
  const lv = (caps: string[]) => plain(lib.levelOf(caps));
  assert.deepEqual(lv([]), { level: 'none', base: null, extra: [] });
  assert.deepEqual(lv(LEVEL_CAPS.read), { level: 'read', base: 'read', extra: [] });
  assert.deepEqual(lv(LEVEL_CAPS.write), { level: 'write', base: 'write', extra: [] });
  assert.deepEqual(lv([...LEVEL_CAPS.full].reverse()), { level: 'full', base: 'full', extra: [] }, 'order does not matter');
  assert.deepEqual(lv([...LEVEL_CAPS.write, 'VIEW_CHANNEL']), { level: 'write', base: 'write', extra: [] }, 'duplicates do not matter');
  assert.deepEqual(lv(['MENTION_EVERYONE', ...LEVEL_CAPS.write]), { level: 'custom', base: 'write', extra: ['MENTION_EVERYONE'] });
  assert.deepEqual(lv(['READ_HISTORY', 'VIEW_CHANNEL', 'SEND_MESSAGES']), { level: 'custom', base: 'read', extra: ['SEND_MESSAGES'] });
  assert.deepEqual(lv(['SEND_MESSAGES']), { level: 'custom', base: null, extra: ['SEND_MESSAGES'] }, 'no View: no preset');
  assert.deepEqual(lv(['SEND_MESSAGES', 'VIEW_CHANNEL']), { level: 'custom', base: null, extra: ['VIEW_CHANNEL', 'SEND_MESSAGES'] }, 'extras in ALL_CAPS order');
  assert.deepEqual(lv(['VOICE_SPEAK', 'VOICE_LISTEN', ...LEVEL_CAPS.full]), { level: 'custom', base: 'full', extra: ['VOICE_LISTEN', 'VOICE_SPEAK'] });

  assert.equal(lib.levelLabel([]), 'None');
  assert.equal(lib.levelLabel(LEVEL_CAPS.full), 'Full');
  assert.equal(lib.levelLabel([...LEVEL_CAPS.write, 'MENTION_EVERYONE']), 'Write +1');
  assert.equal(lib.levelLabel(['SEND_MESSAGES']), 'Custom');
  assert.equal(lib.capsSummary([...LEVEL_CAPS.write, 'MENTION_EVERYONE']), 'Write + mention everyone');
  assert.equal(lib.capsSummary(['SEND_MESSAGES']), 'Custom (send) — can’t see the channel');
  assert.match(lib.capsTitle([...LEVEL_CAPS.write, 'MENTION_EVERYONE']), /^Write = Read \+ send.*Also: mention everyone\.$/);
});

test('lib.isGrantableType: text, voice and forum; never a thread or a category', () => {
  const { lib } = libOnly();
  assert.deepEqual(['text', 'voice', 'forum', 'thread', 'category', 'unknown', undefined].map((t) => lib.isGrantableType(t)), [true, true, true, false, false, false, false]);
});

// Invented, public-safe fixture names (the preview harness's world).
const C = { general: '100000000000001011', lounge: '100000000000001013', research: '100000000000001021', designReview: '100000000000001022', labNotes: '100000000000001023', ideas: '100000000000001024', catResearch: '100000000000001002' };
const MODS = '100000000000003001';
const NAMES = {
  channels: {
    [C.general]: { id: C.general, name: 'general', type: 'text' },
    [C.lounge]: { id: C.lounge, name: 'lounge', type: 'voice' },
    [C.research]: { id: C.research, name: 'research', type: 'text' },
    [C.designReview]: { id: C.designReview, name: 'design-review', type: 'thread', parentId: C.research, parentName: 'research' },
    [C.ideas]: { id: C.ideas, name: 'ideas', type: 'forum' },
    [C.catResearch]: { id: C.catResearch, name: 'Research', type: 'category' },
    '100000000000009001': { id: '100000000000009001', name: null, missing: true },
    '100000000000009002': { id: '100000000000009002', name: null, unavailable: true },
  },
  discordRoles: { [MODS]: { name: 'Mods', guildId: G1 }, [G1]: { name: '@everyone', guildId: G1 } },
  guilds: { [G1]: 'Guild One' },
};

test('lib.chanText: channels by name, the way the copy guide writes them', () => {
  const { lib } = libOnly();
  const t = (id: string) => lib.chanText(id, NAMES);
  assert.equal(t(C.general), '#general');
  assert.equal(t(C.lounge), 'lounge (voice)');
  assert.equal(t(C.ideas), 'ideas (forum)');
  assert.equal(t(C.catResearch), 'Research (category)');
  assert.equal(t(C.designReview), 'design-review (thread in #research)');
  assert.equal(t('100000000000009001'), 'deleted channel');
  assert.equal(t('100000000000009002'), 'channel the relay can’t see');
  assert.equal(t('100000000000009999'), '100000000000009999', 'nothing known: the id');
  assert.equal(lib.roleText(MODS, NAMES), '@Mods');
  assert.equal(lib.roleText(G1, NAMES), '@everyone');
});

test('lib.grantSummary: roles AND grant, in words', () => {
  const { lib } = libOnly();
  const g = (inv: object) => lib.grantSummary({ guildId: G1, ...inv }, NAMES);
  // What slash /invite stores: access roles plus a channel grant.
  assert.equal(g({ roles: ['g1-chatters'], grant: { caps: LEVEL_CAPS.write, scope: { channels: [C.general] } } }), 'roles: g1-chatters · Write in #general');
  assert.equal(g({ roles: ['g1-readers', 'g1-chatters'] }), 'roles: g1-readers, g1-chatters');
  assert.equal(g({ grant: { caps: LEVEL_CAPS.read, scope: { channels: [C.general, C.research] } } }), 'Read in #general, #research');
  assert.equal(g({ grant: { caps: LEVEL_CAPS.read, scope: { channels: ['1', '2', '3', '4'] } } }), 'Read in 4 channels');
  assert.equal(g({ grant: { caps: LEVEL_CAPS.full, scope: { mirrorRole: MODS } } }), 'Full wherever @Mods can see');
  assert.equal(g({ grant: { caps: LEVEL_CAPS.read, scope: { all: true } } }), 'Read in every channel of Guild One');
  assert.equal(g({ caps: LEVEL_CAPS.read }), 'Read everywhere (old-style invite)');
  assert.equal(g({}), 'no access');
});

test('lib.roleMeaning and roleLevelText: an access role in one line', () => {
  const { lib } = libOnly();
  const chatters = { caps: LEVEL_CAPS.write, scope: { channels: [C.general, C.research] }, guildId: G1 };
  const readers = { caps: LEVEL_CAPS.read, scope: { all: true }, guildId: G1 };
  const modsMirror = { caps: LEVEL_CAPS.full, scope: { mirrorRole: MODS }, guildId: G1, mirrorCaps: true };
  const modsSee = { caps: LEVEL_CAPS.write, scope: { mirrorRole: MODS }, guildId: G1 };
  assert.equal(lib.roleMeaning(chatters, NAMES), 'Write in 2 channels');
  assert.equal(lib.roleMeaning({ ...chatters, scope: { channels: [C.general] } }, NAMES), 'Write in #general');
  assert.equal(lib.roleMeaning(readers, NAMES), 'Read in every channel of Guild One');
  assert.equal(lib.roleMeaning(modsMirror, NAMES), 'Mirrors @Mods · Full');
  assert.equal(lib.roleMeaning(modsSee, NAMES), 'Write wherever @Mods can see');
  assert.equal(lib.roleMeaning(undefined, NAMES), 'no longer defined');
  assert.equal(lib.roleLevelText(chatters, NAMES), 'Write');
  assert.equal(lib.roleLevelText(modsMirror, NAMES), 'Mirrors @Mods · Full');
  assert.equal(lib.wherePhrase(chatters.scope, NAMES, G1), 'in #general, #research');
});

test('lib.inviteSummary: uses, expiry and grants on one line', () => {
  const { lib } = libOnly();
  const now = new Date(2026, 9, 16, 9, 30).getTime(); // local time: a Friday
  const inSevenDays = new Date(2026, 9, 23, 9, 30).toISOString();
  assert.equal(lib.shortDate(inSevenDays, now), 'Fri 23 Oct');
  assert.equal(lib.shortDate(new Date(2027, 0, 4).toISOString(), now), 'Mon 4 Jan 2027');
  assert.equal(lib.inviteSummary({ roles: ['g1-readers'], maxUses: 1, expiresAt: inSevenDays }, NAMES, now), 'Single use · expires Fri 23 Oct · roles: g1-readers');
  assert.equal(lib.inviteSummary({ guildId: G1, grant: { caps: LEVEL_CAPS.write, scope: { channels: [C.general] } }, maxUses: 5 }, NAMES, now), 'Up to 5 uses · never expires · Write in #general');
  assert.equal(lib.usesText(undefined), 'Unlimited uses');
  assert.equal(lib.usedText({ uses: 1, maxUses: 5 }), '1 of 5 used');
  assert.equal(lib.usedText({ uses: 3 }), '3 used');
  assert.deepEqual(['mint', undefined, 'augment', 'both'].map((m) => lib.modeText(m)), ['A new agent', 'A new agent', 'An existing persona', 'Either']);
});

// ── ui.levelControl ──

function levelSandbox(opts: object = {}) {
  const { ctx } = sandbox();
  load(ctx, ['lib.js', 'ui.js']);
  const lc = ctx.PA.ui.levelControl(opts);
  const inputs = lc.node.querySelectorAll('input') as FakeElement[];
  const radio = (v: string) => inputs.find((i) => i.type === 'radio' && i.value === v)!;
  const box = (c: string) => inputs.find((i) => i.type === 'checkbox' && i.value === c)!;
  /** Click a radio: the browser unchecks the others in its group. */
  const pick = (v: string) => {
    for (const i of inputs) if (i.type === 'radio') i.checked = i.value === v;
    radio(v).fire('change');
  };
  const tick = (c: string, on = true) => {
    box(c).checked = on;
    box(c).fire('change');
  };
  const custom = lc.node.querySelector('.caps-groups') as FakeElement;
  const warn = lc.node.querySelector('.warn-line') as FakeElement;
  return { lc, radio, box, pick, tick, custom, warn, lib: ctx.PA.lib };
}

test('ui.levelControl: Read | Write | Full | Custom… as a radiogroup; presets give the relay’s caps', () => {
  const { lc, radio, pick, custom } = levelSandbox({ value: LEVEL_CAPS.write });
  assert.equal(lc.node.querySelector('[role="radiogroup"]') !== null, true);
  assert.equal(radio('write').checked, true);
  assert.deepEqual(plain(lc.value()), plain(LEVEL_CAPS.write));
  assert.ok(custom.classList.contains('hidden'), 'Custom… is closed');
  const seen: string[][] = [];
  lc.onChange((v: string[]) => seen.push(plain(v)));
  pick('full');
  assert.deepEqual(plain(lc.value()), plain(LEVEL_CAPS.full));
  assert.deepEqual(seen, [plain(LEVEL_CAPS.full)]);
  lc.set([]);
  assert.deepEqual(plain(lc.value()), [], 'no level picked: no caps');
  assert.equal(['read', 'write', 'full', 'custom'].some((k) => radio(k).checked), false);
  assert.equal(seen.length, 1, 'set() is not an admin change');
  lc.set([...LEVEL_CAPS.write, 'MENTION_EVERYONE']);
  assert.equal(radio('custom').checked, true, 'a superset opens Custom…');
  assert.ok(!custom.classList.contains('hidden'));
});

test('ui.levelControl: Custom… ticks View and History with any Write or Moderation capability, and warns without View', () => {
  const { lc, box, pick, tick, custom, warn } = levelSandbox({});
  pick('write');
  pick('custom');
  assert.ok(!custom.classList.contains('hidden'), 'Custom… opens');
  assert.deepEqual(plain(lc.value()), plain(LEVEL_CAPS.write), 'starting from the level picked before');
  for (const c of LEVEL_CAPS.write) tick(c, false);
  assert.deepEqual(plain(lc.value()), []);
  tick('SEND_MESSAGES');
  assert.equal(box('VIEW_CHANNEL').checked, true, 'send ticks View');
  assert.equal(box('READ_HISTORY').checked, true, 'send ticks History');
  assert.deepEqual(plain(lc.value()), ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES']);
  assert.ok(warn.classList.contains('hidden'));
  tick('VIEW_CHANNEL', false);
  assert.ok(!warn.classList.contains('hidden'), 'unticking View warns');
  assert.equal(warn.textContent, 'Without View this only works where a role already gives view.');
  assert.deepEqual(plain(lc.value()), ['READ_HISTORY', 'SEND_MESSAGES']);
  tick('MANAGE_MESSAGES');
  assert.equal(box('VIEW_CHANNEL').checked, true, 'a Moderation capability ticks View too');
  assert.ok(warn.classList.contains('hidden'));
  // Voice is not in the rule.
  for (const c of ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'MANAGE_MESSAGES']) tick(c, false);
  tick('VOICE_LISTEN');
  assert.equal(box('VIEW_CHANNEL').checked, false);
});

// ── The persona drawer's direct grants, driven as Gwen would ──

const CH = {
  welcome: '100000000000001010', catGeneral: '100000000000001001', general: '100000000000001011', random: '100000000000001012',
  lounge: '100000000000001013', catResearch: '100000000000001002', research: '100000000000001021', designReview: '100000000000001022',
  labNotes: '100000000000001023', ideas: '100000000000001024', catArchive: '100000000000001003', oldLogs: '100000000000001031',
};
const G1_CHANNELS = [
  { id: CH.welcome, name: 'welcome', type: 'text' },
  { id: CH.catGeneral, name: 'General', type: 'category' },
  { id: CH.general, name: 'general', type: 'text' },
  { id: CH.random, name: 'random', type: 'text' },
  { id: CH.lounge, name: 'lounge', type: 'voice' },
  { id: CH.catResearch, name: 'Research', type: 'category' },
  { id: CH.research, name: 'research', type: 'text' },
  { id: CH.designReview, name: 'design-review', type: 'thread', parentId: CH.research },
  { id: CH.labNotes, name: 'lab-notes', type: 'text' },
  { id: CH.ideas, name: 'ideas', type: 'forum' },
  { id: CH.catArchive, name: 'Archive', type: 'category' },
  { id: CH.oldLogs, name: 'old-logs', type: 'text' },
];
const G1_CATALOG = {
  'g1-readers': { caps: LEVEL_CAPS.read, scope: { all: true }, guildId: G1 },
  'g1-chatters': { caps: LEVEL_CAPS.write, scope: { channels: [CH.general, CH.research] }, guildId: G1 },
  // Another guild's role, as a super-admin's catalog would hold it.
  'g2-desk': { caps: LEVEL_CAPS.write, scope: { all: true }, guildId: '100000000000000002' },
};

async function ariaDrawer() {
  const g = '/admin/g/' + G1;
  const policy: { channels: Record<string, string[]>; default?: string[] } = { channels: { [CH.research]: [...LEVEL_CAPS.write] } };
  const box = appSandbox({
    routes: {
      [g + '/roles']: { catalog: G1_CATALOG, discordRoles: [], canAuthor: false },
      [g + '/channels']: { channels: G1_CHANNELS },
      [g + '/personas']: { personas: [{ id: 'aria', displayName: 'Aria', roles: ['g1-chatters'] }], total: 1, limit: 50, offset: 0 },
      [g + '/personas/aria']: { id: 'aria', displayName: 'Aria', roles: ['g1-chatters', 'g2-desk'], guildPolicy: policy, names: { channels: {} } },
    },
    handle: (method, path, body) => {
      if (method === 'PUT' && path === g + '/personas/aria/grants') {
        if (body.channelId) policy.channels[body.channelId] = body.caps;
        else policy.default = body.caps;
        return { guildPolicy: policy };
      }
      return undefined;
    },
  });
  await box.ctx.PA.app.boot();
  await settle();
  box.doc.querySelectorAll('button').find((b) => b.textContent === 'Aria')!.click();
  await settle();
  const drawer = box.doc.getElementById('drawer-body')!;
  const form = drawer.querySelector('form.grant-form')!;
  const target = form.querySelector('select')!;
  const save = form.querySelector('button[type="submit"]')!;
  const radio = (v: string) => form.querySelectorAll('input').find((i) => i.type === 'radio' && i.value === v)!;
  const choose = (v: string) => {
    target.value = v;
    target.fire('change');
  };
  return { ...box, drawer, form, target, save, radio, choose, policy };
}

test('grant editor: open at the top; targets are channels that can hold a grant, then guild-wide', async () => {
  const { drawer, target } = await ariaDrawer();
  const section = drawer.querySelector('section')!;
  const first = section.children[1];
  assert.equal(first.tagName, 'DETAILS', 'Direct grants come first in the guild section');
  assert.equal(first.hasAttribute('open'), true);
  const texts = target.options.map((o) => o.textContent);
  assert.equal(texts[0], 'Pick a channel…');
  assert.equal(texts.at(-1), 'Every channel in Guild One (guild-wide)…');
  assert.deepEqual(texts.slice(1, -1), ['#general', 'ideas (forum)', '#lab-notes', 'lounge (voice)', '#old-logs', '#random', '#research', '#welcome']);
  assert.ok(!texts.some((t) => /design-review|category/.test(t)), 'no thread, no category');
});

test('grant editor: picking a target loads its level; Save waits for a level; Write saves exactly the Write caps', async () => {
  const { form, target, save, radio, choose, calls, bodies, policy, drawer } = await ariaDrawer();
  assert.equal(save.disabled, true, 'nothing picked yet');
  choose(CH.research);
  assert.equal(radio('write').checked, true, 'its direct grant is Write');
  assert.equal(save.disabled, false);
  choose(CH.labNotes);
  assert.equal(['read', 'write', 'full', 'custom'].some((k) => radio(k).checked), false, 'no grant there: no level');
  assert.equal(save.disabled, true);
  radio('write').checked = true;
  radio('write').fire('change');
  assert.equal(save.disabled, false);
  form.fire('submit');
  await settle();
  const g = '/admin/g/' + G1;
  assert.equal(calls.at(-1), `PUT ${g}/personas/aria/grants`);
  assert.deepEqual(bodies.at(-1), { caps: [...LEVEL_CAPS.write], channelId: CH.labNotes });
  assert.deepEqual(policy.channels[CH.labNotes], [...LEVEL_CAPS.write]);
  const rows = drawer.querySelectorAll('tr').map((tr) => tr.children.map((td) => td.textContent));
  assert.ok(rows.some((r) => r[0] === '#lab-notes' && r[1] === 'Write'), JSON.stringify(rows));
  assert.equal(target.value, CH.labNotes);
  // Guild-wide carries its warning.
  const warn = form.querySelector('.warn-line')!;
  assert.ok(warn.classList.contains('hidden'));
  choose('__guild__');
  assert.ok(!warn.classList.contains('hidden'));
  assert.equal(warn.textContent, 'Applies to every channel without its own grant, including new ones.');
});

test('persona drawer: access roles are this guild’s only, with what each means', async () => {
  const { drawer } = await ariaDrawer();
  const picker = drawer.querySelectorAll('select').find((s) => (s.getAttribute('aria-label') || '').startsWith('Add an access role'))!;
  assert.deepEqual(picker.options.map((o) => o.textContent), ['+ Add access role…', 'g1-readers — Read in every channel of Guild One']);
  const chips = drawer.querySelectorAll('.tag').map((t) => t.textContent);
  assert.deepEqual(chips, ['g1-chatters— Write in 2 channels✕']);
  const note = drawer.querySelectorAll('.field-hint').find((n) => /other guilds/.test(n.textContent))!;
  assert.equal(note.textContent, '+1 role in other guilds');
});
