// The admin panel's client scripts (portal-admin/*.js), run in node:vm.
//
// Pins the rules every panel script follows — one IIFE assigning a single
// global (window.PA.<module>), and no HTML parsing of data — and the
// behaviour of ui.js's feedback helpers: busy() locks a button for exactly one
// request, onSubmit() ignores a second submit while the first is pending,
// errors toast stickily (and their ✕ can be reached from the keyboard while
// the drawer is open), and dirtyTracker() notices edits. app.js is booted
// against a fake API for the list search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ADMIN = fileURLToPath(new URL('../../portal-admin/', import.meta.url));
const SCRIPTS = ['ui.js', 'app.js'];
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

test('panel scripts: the only global they add is PA (window.PA.ui, window.PA.app)', () => {
  const { ctx } = sandbox();
  const before = new Set(Object.getOwnPropertyNames(ctx));
  load(ctx);
  const added = Object.getOwnPropertyNames(ctx).filter((k) => !before.has(k));
  assert.deepEqual(added, ['PA']);
  assert.deepEqual(Object.keys(ctx.PA).sort(), ['app', 'ui']);
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

test('index.html loads ui.js then app.js, deferred and versioned', () => {
  const html = source('index.html');
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(scripts.length, 2);
  assert.match(scripts[0], /src="ui\.js\?v=\d+"/);
  assert.match(scripts[1], /src="app\.js\?v=\d+"/);
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

/** A sandbox with index.html's shell, signed in as a one-guild admin. Every
 *  request lands in `calls` as 'METHOD /path?query'. */
function appSandbox() {
  const box = sandbox();
  const { ctx, doc } = box;
  const calls: string[] = [];
  Object.assign(ctx, {
    URLSearchParams,
    location: { search: '', pathname: '/', hash: '' },
    history: { replaceState() {} },
    fetch: async (path: string, req: { method: string }) => {
      calls.push(req.method + ' ' + path);
      const route = new URL(path, 'http://panel.invalid').pathname;
      const g = '/admin/g/' + G1;
      const routes: Record<string, unknown> = {
        '/admin/me': { user: { name: 'Gwen' }, isSuper: false, guilds: [{ id: G1, name: 'Guild One' }], csrf: 'csrf-test' },
        '/admin/guilds': { guilds: [{ id: G1, name: 'Guild One' }] },
        [g + '/roles']: { catalog: {}, discordRoles: [], canAuthor: false },
        [g + '/channels']: { channels: [] },
        [g + '/personas']: { personas: [{ id: 'aria', displayName: 'Aria', roles: [] }], total: 1, limit: 50, offset: 0 },
        [g + '/invites']: { invites: [{ code: 'inv_fixtureinvite0000000a', label: 'test', mode: 'mint', uses: 0, roles: ['g1-readers'] }], total: 1, limit: 50, offset: 0 },
      };
      const body = req.method === 'DELETE' ? {} : routes[route];
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
  return { ...box, calls, tabs };
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
