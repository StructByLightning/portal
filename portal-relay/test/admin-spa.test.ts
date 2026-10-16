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
  /** A click; on a link to '#…' that nothing prevented, the browser goes
   *  there (a new history entry, then popstate and hashchange). */
  click() {
    if (this.disabled) return;
    const ev = this.fire('click');
    const href = this.tagName === 'A' ? this.getAttribute('href') : null;
    if (href && href.startsWith('#') && !ev.defaultPrevented) this.doc.nav?.go(href);
  }
  /** A form's controls, in document order (dirtyTracker snapshots these);
   *  a test may set its own list. */
  private ownElements?: FakeElement[];
  get elements(): FakeElement[] | undefined {
    return this.ownElements ?? (this.tagName === 'FORM' ? this.querySelectorAll('input, select, textarea, button') : undefined);
  }
  set elements(v: FakeElement[] | undefined) {
    this.ownElements = v;
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
  nav: FakeNav | null = null;
  visibilityState = 'visible';
  title = '';
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

/**
 * The address bar and the history: entries of path+search+hash, Back and
 * Forward, and the window events they fire (popstate, then hashchange, after
 * the current task — as a browser does). pushState/replaceState fire nothing.
 */
class FakeNav {
  entries: string[];
  i = 0;
  listeners = new Map<string, Array<(e: unknown) => void>>();
  assigned: string[] = [];
  reloads = 0;
  constructor(start = '/') {
    this.entries = [start];
  }
  private url() {
    return new URL(this.entries[this.i], 'http://panel.invalid');
  }
  private resolve(u: string) {
    const r = new URL(u, this.url());
    return r.pathname + r.search + r.hash;
  }
  private fireNav() {
    setImmediate(() => {
      for (const t of ['popstate', 'hashchange']) for (const fn of this.listeners.get(t) ?? []) fn({ type: t });
    });
  }
  get current() {
    return this.entries[this.i];
  }
  /** The window's own addEventListener (popstate, hashchange, beforeunload). */
  addEventListener = (type: string, fn: (e: unknown) => void) => {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  };
  dispatch(type: string, e: Record<string, unknown> = {}) {
    const ev = { type, defaultPrevented: false, returnValue: undefined as unknown, preventDefault() { ev.defaultPrevented = true; }, ...e };
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    return ev;
  }
  location = (() => {
    const nav = this;
    return {
      get hash() {
        const h = nav.url().hash;
        return h === '#' ? '' : h;
      },
      get pathname() {
        return nav.url().pathname;
      },
      get search() {
        return nav.url().search;
      },
      assign(u: string) {
        nav.assigned.push(u);
      },
      reload() {
        nav.reloads++;
      },
    };
  })();
  history = (() => {
    const nav = this;
    return {
      get length() {
        return nav.entries.length;
      },
      pushState(_s: unknown, _t: string, u: string) {
        nav.entries.splice(nav.i + 1);
        nav.entries.push(nav.resolve(u));
        nav.i++;
      },
      replaceState(_s: unknown, _t: string, u: string) {
        nav.entries[nav.i] = nav.resolve(u);
      },
      back() {
        if (nav.i > 0) {
          nav.i--;
          nav.fireNav();
        }
      },
      forward() {
        if (nav.i < nav.entries.length - 1) {
          nav.i++;
          nav.fireNav();
        }
      },
    };
  })();
  /** A link click, or an address typed into the bar: a new entry and the events. */
  go(href: string) {
    const to = this.resolve(href);
    if (to === this.entries[this.i]) return;
    this.entries.splice(this.i + 1);
    this.entries.push(to);
    this.i++;
    this.fireNav();
  }
  back() {
    this.history.back();
  }
}

/** sessionStorage / localStorage, as a Map. */
function fakeStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    map: m,
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
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

test('panel scripts: the only global they add is PA (window.PA.lib, .ui, .app, .CLIENT_API)', () => {
  const { ctx } = sandbox();
  const before = new Set(Object.getOwnPropertyNames(ctx));
  load(ctx);
  const added = Object.getOwnPropertyNames(ctx).filter((k) => !before.has(k));
  assert.deepEqual(added, ['PA']);
  assert.deepEqual(Object.keys(ctx.PA).sort(), ['CLIENT_API', 'app', 'lib', 'ui']);
  assert.equal(ctx.PA.CLIENT_API, 2);
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

test('index.html: the session bar has a copy inside the drawer, between its header and its body', () => {
  // The drawer covers the page and keeps Tab inside itself, so the copy that
  // can be seen and reached while it is open must be in it (and the
  // fixture's drawerDom must match).
  const html = source('index.html');
  const drawer = /<aside id="drawer"[^>]*>([\s\S]*?)<\/aside>/.exec(html);
  assert.ok(drawer, 'index.html has the drawer');
  assert.match(drawer[1], /<\/header>\s*(<!--[\s\S]*?-->\s*)?<div id="drawer-session-bar" class="session-bar hidden" role="status"><\/div>\s*<div id="drawer-body"/);
  assert.match(html, /<div id="session-bar" class="session-bar hidden" role="status"><\/div>/);
  const css = source('styles.css');
  assert.match(css, /body:has\(#drawer:not\(\.hidden\)\) #session-bar \{ visibility: hidden; \}/, 'the page’s copy is not shown behind the drawer');
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

/** index.html's drawer markup (with its copy of the session bar) and toast stack. */
function drawerDom(doc: FakeDocument, el: (...a: any[]) => FakeElement) {
  const title = el('h2', { id: 'drawer-title', tabindex: '-1' });
  const close = el('button', { id: 'drawer-close', 'aria-label': 'Close panel', text: '✕' });
  const bar = el('div', { id: 'drawer-session-bar', class: 'session-bar hidden', role: 'status' });
  const body = el('div', { id: 'drawer-body' });
  const drawer = el('aside', { id: 'drawer', class: 'drawer hidden', role: 'dialog', tabindex: '-1' }, [el('header', {}, [title, close]), bar, body]);
  doc.body.appendChild(el('div', { id: 'drawer-scrim', class: 'drawer-scrim hidden' }));
  doc.body.appendChild(drawer);
  const toasts = el('div', { id: 'toasts' });
  doc.body.appendChild(toasts);
  return { title, close, bar, drawer, toasts };
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

/** Answers a mutation (or overrides a read): a body, a refuse(), or undefined for the default. */
type FakeHandler = (method: string, pathAndQuery: string, body: any, headers: Record<string, string>) => unknown;

class Refusal {
  constructor(public status: number, public error: Record<string, unknown>) {}
}
/** The relay's refusal: {error: {code, message, …extra}} with an HTTP status. */
const refuse = (status: number, code: string, message = code, extra: Record<string, unknown> = {}) => new Refusal(status, { code, message, ...extra });

/** A sandbox with index.html's shell, signed in as a one-guild admin. Every
 *  request lands in `calls` as 'METHOD /path?query', and every JSON body sent
 *  in `bodies`. `routes` adds or replaces GET answers by path. */
function appSandbox(opts: { routes?: Record<string, unknown>; handle?: FakeHandler; url?: string; session?: Record<string, string>; local?: Record<string, string> } = {}) {
  const box = sandbox();
  const { ctx, doc } = box;
  const calls: string[] = [];
  const bodies: any[] = [];
  const nav = new FakeNav(opts.url ?? '/');
  doc.nav = nav;
  const sessionStore = fakeStorage(opts.session);
  const localStore = fakeStorage(opts.local);
  Object.assign(ctx, {
    URLSearchParams,
    location: nav.location,
    history: nav.history,
    addEventListener: nav.addEventListener,
    sessionStorage: sessionStore,
    localStorage: localStore,
    fetch: async (path: string, req: { method: string; body?: string; headers?: Record<string, string> }) => {
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
      let body = opts.handle?.(req.method, route + url.search, sent, req.headers ?? {});
      if (body === undefined) body = req.method === 'DELETE' ? {} : req.method === 'GET' ? routes[route] : undefined;
      if (body === undefined) return { status: 404, ok: false, text: async () => '{"error":{"code":"NOT_FOUND"}}' };
      // refuse(status, code, message, extra) answers as the relay refuses.
      if (body instanceof Refusal) return { status: body.status, ok: false, text: async () => JSON.stringify({ error: body.error }) };
      return { status: 200, ok: true, text: async () => JSON.stringify(body) };
    },
  });
  load(ctx);
  const { el } = ctx.PA.ui;
  // As index.html has them: links, whose addresses the app keeps up to date.
  const tab = (name: string, cls = 'tab') => el('a', { class: cls, 'data-tab': name, href: '#/', text: name });
  const tabs = { personas: tab('personas'), invites: tab('invites'), roles: tab('roles'), audit: tab('audit'), guilds: tab('guilds', 'tab tab-super hidden') };
  doc.body.appendChild(el('div', { id: 'login', class: 'hidden' }, [
    el('a', { id: 'login-btn', href: '/admin/login', text: 'Sign in with Discord' }), el('div', { id: 'login-error', class: 'hidden' }),
  ]));
  doc.body.appendChild(el('div', { id: 'app', class: 'hidden' }, [
    el('header', {}, [
      el('span', { id: 'user-name' }), el('span', { id: 'super-badge', class: 'hidden' }),
      el('div', { id: 'scope' }, [el('select', { id: 'guild-select' }), el('span', { id: 'guild-static', class: 'hidden' })]),
      el('nav', {}, Object.values(tabs)), el('button', { id: 'logout-btn', text: 'Sign out' }),
    ]),
    el('div', { id: 'session-bar', class: 'hidden' }),
    el('main', { id: 'view' }),
  ]));
  drawerDom(doc, el);
  doc.body.appendChild(el('div', { id: 'modals' }));
  return { ...box, calls, bodies, tabs, nav, sessionStore, localStore };
}

/** The link or button that reads `text`. */
function clickable(doc: FakeDocument, text: string, root: FakeElement = doc.body) {
  const hit = root.querySelectorAll('a, button').find((b) => b.textContent === text);
  if (!hit) throw new Error('nothing to click reads ' + JSON.stringify(text));
  return hit;
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

async function ariaDrawer(opts: { policy?: { channels: Record<string, string[]>; default?: string[] }; refusePut?: (body: any) => unknown } = {}) {
  const g = '/admin/g/' + G1;
  const policy: { channels: Record<string, string[]>; default?: string[] } = opts.policy ?? { channels: { [CH.research]: [...LEVEL_CAPS.write] } };
  const box = appSandbox({
    routes: {
      [g + '/roles']: { catalog: G1_CATALOG, discordRoles: [], canAuthor: false },
      [g + '/channels']: { channels: G1_CHANNELS },
      [g + '/personas']: { personas: [{ id: 'aria', displayName: 'Aria', roles: ['g1-chatters'] }], total: 1, limit: 50, offset: 0 },
      [g + '/personas/aria']: { id: 'aria', displayName: 'Aria', roles: ['g1-chatters', 'g2-desk'], guildPolicy: policy, names: { channels: {} } },
    },
    handle: (method, path, body) => {
      // As the relay does: one target, one operation.
      if (method === 'PUT' && path === g + '/personas/aria/grants') {
        if (opts.refusePut) return opts.refusePut(body);
        const caps = body.level ? [...(LEVEL_CAPS as Record<string, string[]>)[body.level]] : body.deny ? [] : body.caps;
        if (body.channelId) policy.channels[body.channelId] = caps;
        else if (body.guildDefault === true) policy.default = caps;
        else return refuse(400, 'TARGET_REQUIRED');
        return { guildPolicy: policy };
      }
      if (method === 'DELETE' && path.startsWith(g + '/personas/aria/grants?')) {
        const q = new URL(path, 'http://panel.invalid').searchParams;
        if (q.get('guildDefault') === 'deny') policy.default = [];
        else if (q.get('guildDefault') === 'unset') delete policy.default;
        else if (q.get('channelId')) delete policy.channels[q.get('channelId')!];
        else return refuse(400, 'TARGET_REQUIRED');
        return { guildPolicy: policy };
      }
      return undefined;
    },
  });
  await box.ctx.PA.app.boot();
  await settle();
  clickable(box.doc, 'Aria').click();
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
  assert.deepEqual(bodies.at(-1), { channelId: CH.labNotes, level: 'write' }, 'a preset goes by its name');
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

// ── The access-role drawer, driven as a super-admin would ──

const G2 = '100000000000000002'; // the preview harness's invented Guild Two
const G2_LOBBY = '100000000000002011'; // #lobby in Guild Two

/** The Access roles tab as a super-admin, against a role catalog the fake
 *  relay keeps (POST /admin/roles replaces a name, as the relay does). With
 *  ?names=1 it names what a super-admin's catalog references, as the relay
 *  does: every role's guild it knows, and their channels. */
async function rolesTab() {
  const g = '/admin/g/' + G1;
  const catalog: Record<string, any> = { 'g1-readers': G1_CATALOG['g1-readers'] };
  const known: Record<string, string> = { [G1]: 'Guild One', [G2]: 'Guild Two' };
  const net: { down: boolean; beforePost?: (body: any) => void } = { down: false };
  const box = appSandbox({
    routes: {
      '/admin/me': { user: { name: 'Op' }, isSuper: true, guilds: [{ id: G1, name: 'Guild One' }], csrf: 'csrf-test' },
      [g + '/channels']: { channels: G1_CHANNELS },
    },
    handle: (method, path, body) => {
      if (net.down) throw new Error('offline');
      if (method === 'GET' && path.startsWith(g + '/roles')) {
        if (!new URL(path, 'http://panel.invalid').searchParams.has('names')) return { catalog, discordRoles: [], canAuthor: true };
        const guilds: Record<string, string> = {};
        for (const r of Object.values(catalog)) if (known[r.guildId]) guilds[r.guildId] = known[r.guildId];
        const names = { channels: { [G2_LOBBY]: { id: G2_LOBBY, name: 'lobby', type: 'text' } }, discordRoles: {}, guilds };
        return { catalog, discordRoles: [], canAuthor: true, names };
      }
      if (method === 'POST' && path === '/admin/roles') {
        net.beforePost?.(body); // someone else, just before this request lands
        // As the relay does: a name in use only with replace, in its own guild.
        const cur = Object.hasOwn(catalog, body.name) ? catalog[body.name] : undefined;
        if (cur && body.replace !== true) return refuse(409, 'EXISTS', 'exists', { existing: { guildId: cur.guildId } });
        if (cur && (body.expectedGuildId !== cur.guildId || body.role.guildId !== cur.guildId)) return refuse(409, 'GUILD_MISMATCH', 'mismatch');
        catalog[body.name] = body.role;
        return { ok: true, catalog };
      }
      if (method === 'DELETE' && path.startsWith('/admin/roles/')) {
        delete catalog[decodeURIComponent(path.slice('/admin/roles/'.length))];
        return { ok: true };
      }
      return undefined;
    },
  });
  await box.ctx.PA.app.boot();
  await settle();
  box.tabs.roles.click();
  await settle();
  const button = (text: string) => box.doc.querySelectorAll('a, button').find((b) => b.textContent === text);
  const confirm = () => box.doc.querySelector('.modal');
  /** '+ Define access role', a name, a level, then Create (`beforeCreate`
   *  runs just before Create is pressed). */
  async function define(name: string, level: string, beforeCreate?: () => void) {
    button('+ Define access role')!.click();
    await settle();
    const form = box.doc.getElementById('drawer-body')!.querySelector('form')!;
    const input = form.querySelector('input[name="name"]')!;
    input.value = name;
    input.fire('input');
    const where = form.querySelector('select[name="where"]')!;
    where.value = 'all'; // the fake <select> has no default option
    where.fire('change');
    const radio = form.querySelectorAll('input').find((i) => i.type === 'radio' && i.value === level)!;
    radio.checked = true;
    radio.fire('change');
    assert.equal(form.querySelector('button[type="submit"]')!.disabled, false);
    beforeCreate?.();
    form.fire('submit');
    await settle();
  }
  const rows = () => box.doc.getElementById('view')!.querySelectorAll('tr').map((tr) => tr.children.map((td) => td.textContent));
  return { ...box, catalog, net, button, confirm, define, rows };
}

test('role drawer: asks before replacing a role that exists now, not only one the tab was drawn with', async () => {
  const { define, confirm, catalog, rows, bodies } = await rolesTab();

  // A new name is created without asking.
  await define('g1-test', 'read');
  assert.equal(confirm(), null);
  assert.deepEqual(catalog['g1-test'].caps, [...LEVEL_CAPS.read]);
  assert.ok(rows().some((r) => r[0] === 'g1-test' && r[1] === 'Read'), JSON.stringify(rows()));

  // The same name again, in the same visit: the relay would replace it, so ask.
  const posts = bodies.length;
  await define('g1-test', 'write');
  const dialog = confirm()!;
  assert.ok(dialog, 'a role made during this visit is asked about');
  assert.equal(dialog.querySelector('h2')!.textContent, 'A role named g1-test already exists — edit it instead?');
  assert.equal(
    dialog.querySelector('p')!.textContent,
    'It is Guild One’s access role g1-test (Read in every channel of Guild One). ' +
      'Editing it to this definition gives every persona that holds it Write in every channel of Guild One instead. ' +
      'This can’t be undone; to go back, define it again as it was.',
  );
  assert.equal(dialog.querySelector('button.btn-danger-solid')!.textContent, 'Edit access role');
  dialog.querySelectorAll('button').find((b) => b.textContent === 'Cancel')!.click();
  await settle();
  assert.equal(bodies.length, posts, 'Cancel sends nothing');
  assert.deepEqual(catalog['g1-test'].caps, [...LEVEL_CAPS.read], 'and leaves the role as it was');
});

test('role drawer: a role deleted (or made elsewhere) since the tab was drawn is judged as it is now', async () => {
  const { define, confirm, catalog, net, button, rows, doc, bodies } = await rolesTab();

  // Deleted during this visit: creating the name again is a plain create.
  button('Delete')!.click();
  await settle();
  confirm()!.querySelector('button.btn-danger-solid')!.click();
  await settle();
  assert.equal(catalog['g1-readers'], undefined);
  await define('g1-readers', 'write');
  assert.equal(confirm(), null, 'nothing to replace');
  assert.deepEqual(catalog['g1-readers'].caps, [...LEVEL_CAPS.write]);

  // Made by someone else after the tab was drawn: still asked about.
  catalog['g1-elsewhere'] = { caps: [...LEVEL_CAPS.full], scope: { all: true }, guildId: G1 };
  assert.ok(!rows().some((r) => r[0] === 'g1-elsewhere'), 'the tab has not seen it');
  await define('g1-elsewhere', 'read');
  assert.equal(confirm()!.querySelector('h2')!.textContent, 'A role named g1-elsewhere already exists — edit it instead?');
  confirm()!.querySelector('button.btn-danger-solid')!.click();
  await settle();
  assert.deepEqual(catalog['g1-elsewhere'].caps, [...LEVEL_CAPS.read], 'Edit replaces it');
  assert.deepEqual(bodies.at(-1), { name: 'g1-elsewhere', role: catalog['g1-elsewhere'], replace: true, expectedGuildId: G1 }, 'saying which guild’s role it replaces');

  // A name that only an object's prototype has is not an existing role.
  await define('constructor', 'read');
  assert.equal(confirm(), null);
  assert.ok(catalog.constructor && Object.hasOwn(catalog, 'constructor'));

  // When the relay can't be asked, nothing is created and the drawer says so.
  // (The drawer loads this guild's channels as it opens; the relay goes away
  // after that, just before Create.)
  const posts = bodies.length;
  await define('g1-offline', 'read', () => (net.down = true));
  assert.equal(bodies.length, posts);
  assert.equal(catalog['g1-offline'], undefined);
  const form = doc.getElementById('drawer-body')!.querySelector('form')!;
  assert.match(form.textContent, /Couldn’t reach the relay\. Nothing was changed\. Try again\./);
});

test('role drawer: another guild’s role is named by its guild and not replaced from here', async () => {
  const { define, confirm, catalog, calls, bodies, doc } = await rolesTab();
  const g2desk = { caps: [...LEVEL_CAPS.write], scope: { all: true }, guildId: G2 };
  const g2lobby = { caps: [...LEVEL_CAPS.read], scope: { channels: [G2_LOBBY] }, guildId: G2 };
  catalog['g2-desk'] = g2desk;
  catalog['g2-lobby'] = g2lobby;
  const status = () => doc.getElementById('drawer-body')!.querySelector('.status-line')!.textContent;
  const posts = bodies.length;

  // Guild One's drawer, a name Guild Two's role holds: refused, in names.
  await define('g2-desk', 'read');
  assert.ok(calls.includes(`GET /admin/g/${G1}/roles?names=1`), 'the check asks for names');
  assert.equal(confirm(), null, 'no Replace is offered');
  assert.equal(
    status(),
    'Not created: Guild Two already has an access role named g2-desk (Write in every channel of Guild Two), ' +
      'and access role names are shared by every guild. Pick another name, or switch to Guild Two to change it there.',
  );
  assert.ok(!status().includes(G2), 'no raw guild id');
  assert.equal(doc.activeElement, doc.getElementById('drawer-body')!.querySelector('input[name="name"]'), 'back on the name');

  // Its channels are named too.
  await define('g2-lobby', 'write');
  assert.equal(confirm(), null);
  assert.match(status(), /^Not created: Guild Two already has an access role named g2-lobby \(Read in #lobby\),/);

  assert.equal(bodies.length, posts, 'nothing was sent');
  assert.deepEqual(catalog['g2-desk'], g2desk, 'Guild Two’s roles are as they were');
  assert.deepEqual(catalog['g2-lobby'], g2lobby);

  // Another name in the same drawer: the refusal goes, this guild's role asks.
  const form = doc.getElementById('drawer-body')!.querySelector('form')!;
  const input = form.querySelector('input[name="name"]')!;
  input.value = 'g1-readers';
  input.fire('input');
  form.fire('submit');
  await settle();
  assert.equal(confirm()!.querySelector('h2')!.textContent, 'A role named g1-readers already exists — edit it instead?');
  assert.equal(status(), '', 'the line about g2-desk is gone');
});

test('lib.roleNameTaken: this guild’s role asks; another guild’s refuses, by name', () => {
  const { lib } = libOnly();
  const names = { ...NAMES, guilds: { [G1]: 'Guild One', [G2]: 'Guild Two' } };
  const read = { caps: LEVEL_CAPS.read, scope: { all: true }, guildId: G1 };
  const chatters = { caps: LEVEL_CAPS.write, scope: { channels: [C.general] }, guildId: G1 };

  const same = plain(lib.roleNameTaken('g1-chatters', chatters, read, G1, names));
  assert.deepEqual(same, {
    title: 'A role named g1-chatters already exists — edit it instead?',
    body: 'It is Guild One’s access role g1-chatters (Write in #general). ' +
      'Editing it to this definition gives every persona that holds it Read in every channel of Guild One instead. ' +
      'This can’t be undone; to go back, define it again as it was.',
    confirmLabel: 'Edit access role',
  });

  const desk = { caps: LEVEL_CAPS.write, scope: { all: true }, guildId: G2 };
  assert.deepEqual(plain(lib.roleNameTaken('g2-desk', desk, read, G1, names)), {
    refuse: 'Not created: Guild Two already has an access role named g2-desk (Write in every channel of Guild Two), ' +
      'and access role names are shared by every guild. Pick another name, or switch to Guild Two to change it there.',
  });

  // A guild nobody can name: 'another guild', and its id only as a pointer.
  const G9 = '100000000000000009';
  const lost = lib.roleNameTaken('g9-desk', { ...desk, guildId: G9 }, read, G1, names).refuse;
  assert.equal(lost, 'Not created: another guild already has an access role named g9-desk (Write in every channel of that guild), ' +
    'and access role names are shared by every guild. Pick another name, or switch to that guild (id ' + G9 + ') to change it there.');
  assert.equal(names.guilds[G9 as keyof typeof names.guilds], undefined, 'the caller’s names are not changed');
  // A role with no guild at all (the relay refuses those at load).
  assert.match(lib.roleNameTaken('old', { caps: LEVEL_CAPS.read, scope: { all: true } }, read, G1, names).refuse, /^Not created: another guild already has an access role named old \(Read in every channel of its guild\), .* Pick another name\.$/);
});

// ── P3: the relay's model, its refusals in words, explicit guild-wide ──

test('lib.adoptModel: the relay’s levels and capabilities replace the copy; anything malformed is ignored', () => {
  const { lib } = libOnly();
  const caps = [...ALL_CAPS, 'PIN_MESSAGES'];
  const levels = { read: ['VIEW_CHANNEL'], write: [...LEVEL_CAPS.write], full: [...LEVEL_CAPS.full, 'PIN_MESSAGES'] };
  for (const bad of [
    [null, caps], [levels, null], [levels, []], [{ ...levels, read: [] }, caps], [{ read: ['VIEW_CHANNEL'], write: LEVEL_CAPS.write }, caps],
    [levels, ALL_CAPS], // full names a capability the list lacks
    [levels, [...caps, 'VIEW_CHANNEL']], // repeats
    [levels, ['view channel']], [{ ...levels, read: ['<b>'] }, caps],
    [{ read: ['SEND_MESSAGES'], write: ['SEND_MESSAGES'], full: ['SEND_MESSAGES'] }, ['SEND_MESSAGES']], // no View
  ]) {
    assert.equal(lib.adoptModel(bad[0], bad[1]), false, JSON.stringify(bad));
  }
  assert.deepEqual(plain(lib.LEVEL_CAPS), plain(LEVEL_CAPS), 'still the copy');
  assert.equal(lib.levelOf(['VIEW_CHANNEL']).level, 'custom');

  assert.equal(lib.adoptModel(levels, caps), true);
  assert.deepEqual(plain(lib.LEVEL_CAPS), levels);
  assert.deepEqual(plain(lib.ALL_CAPS), caps);
  assert.equal(lib.levelOf(['VIEW_CHANNEL']).level, 'read', 'the relay’s Read');
  assert.equal(lib.levelLabel([...LEVEL_CAPS.full, 'PIN_MESSAGES']), 'Full');
  assert.deepEqual(plain(lib.CAP_GROUPS.at(-1)), { key: 'other', label: 'Other', caps: ['PIN_MESSAGES'] }, 'one it has no label for is still offered');
  assert.equal(lib.capsWords(['PIN_MESSAGES']), 'pin messages');
});

test('ui.levelControl: level() says which preset is picked, so a preset can be sent by name', () => {
  const { lc, pick } = levelSandbox({ value: LEVEL_CAPS.read });
  assert.equal(lc.level(), 'read');
  pick('custom');
  assert.equal(lc.level(), 'custom');
  lc.set([]);
  assert.equal(lc.level(), null);
});

test('ui.levelControl: a capability the relay added gets a box under Other', () => {
  const { ctx } = sandbox();
  load(ctx, ['lib.js', 'ui.js']);
  ctx.PA.lib.adoptModel({ ...plain(LEVEL_CAPS) }, [...ALL_CAPS, 'PIN_MESSAGES']);
  const lc = ctx.PA.ui.levelControl({ value: [...LEVEL_CAPS.write, 'PIN_MESSAGES'] });
  const box = (lc.node.querySelectorAll('input') as FakeElement[]).find((i) => i.type === 'checkbox' && i.value === 'PIN_MESSAGES')!;
  assert.ok(box, 'offered');
  assert.equal(box.checked, true);
  assert.equal(lc.level(), 'custom');
  assert.deepEqual(plain(lc.value()), [...LEVEL_CAPS.write, 'PIN_MESSAGES']);
});

test('lib.errorText: the relay’s refusal codes in the copy guide’s words', () => {
  const { lib } = libOnly();
  const t = (e: object, prefix?: string, ctx?: object) => lib.errorText(e, prefix, ctx);
  const at = (cid: string) => ({ channelId: cid, names: NAMES });
  assert.equal(t({ code: 'THREAD_TARGET', status: 400, parentId: C.research }, 'Not saved', at(C.designReview)),
    'Not saved: design-review is a thread. Threads use #research’s access — give access there.');
  assert.equal(t({ code: 'THREAD_TARGET', status: 400 }, 'Not saved', at(C.designReview)),
    'Not saved: design-review is a thread. Threads use #research’s access — give access there.', 'the parent from the names when the relay doesn’t say');
  assert.equal(t({ code: 'CATEGORY_TARGET', status: 400 }, 'Not saved', at(C.catResearch)), 'Not saved: Research is a category. Pick its channels instead.');
  assert.equal(t({ code: 'NOT_GRANTABLE', status: 400 }, 'Not saved', at(C.general)), 'Not saved: #general can’t hold access. Pick a text, voice or forum channel.');
  assert.equal(t({ code: 'EMPTY_CAPS', status: 400 }), 'Not saved: pick a level, or use Remove.');
  assert.equal(t({ code: 'TARGET_REQUIRED', status: 400 }), 'Not saved: this page is out of date. Reload the page and try again.');
  assert.equal(t({ code: 'EXISTS', status: 409 }, 'Not created', { roleName: 'g1-chatters' }), 'A role named g1-chatters already exists — edit it instead?');
  assert.equal(t({ code: 'RATE_LIMITED', status: 429 }), 'Paused for a few seconds (rate limit).');
  assert.equal(t({ code: 'NETWORK', status: 0 }), 'Couldn’t reach the relay. Nothing was changed. Try again.');
  assert.equal(t({ code: 'FORBIDDEN', status: 403, reason: 'NOT_GUILD_ADMIN', message: 'not an admin of this guild' }),
    'You’re not an admin of this guild, or we couldn’t verify your Discord permissions right now.');
  assert.equal(t({ code: 'FORBIDDEN', status: 403, message: 'channel is not in this guild' }), 'Not saved: channel is not in this guild.', 'a route’s own refusal says what it is');
  assert.equal(t({ code: 'INVALID', status: 400, message: 'level must be read, write or full.' }, 'Not denied'), 'Not denied: level must be read, write or full.');
});

test('app: a relay newer than the panel asks for a reload', async () => {
  for (const [apiVersion, shown] of [[3, true], [2, false], [undefined, false]] as const) {
    const { ctx, doc } = appSandbox({ routes: { '/admin/me': { user: { name: 'Gwen' }, isSuper: false, guilds: [{ id: G1, name: 'Guild One' }], csrf: 'c', apiVersion } } });
    await ctx.PA.app.boot();
    await settle();
    const banner = doc.getElementById('update-banner');
    assert.equal(!!banner, shown, String(apiVersion));
    if (banner) {
      assert.equal(banner.textContent, 'The panel was updated — Reload');
      assert.equal(banner.querySelector('button')!.textContent, 'Reload');
    }
  }
});

test('app: levels come from /admin/me when the relay sends them', async () => {
  const levels = { read: ['VIEW_CHANNEL'], write: [...LEVEL_CAPS.write], full: [...LEVEL_CAPS.full] };
  const { ctx } = appSandbox({ routes: { '/admin/me': { user: { name: 'Gwen' }, isSuper: false, guilds: [{ id: G1, name: 'Guild One' }], csrf: 'c', levels, caps: [...ALL_CAPS] } } });
  await ctx.PA.app.boot();
  await settle();
  assert.deepEqual(plain(ctx.PA.lib.LEVEL_CAPS.read), ['VIEW_CHANNEL']);
});

test('grant editor: Custom… is sent as caps, guild-wide as {guildDefault: true}', async () => {
  const { form, radio, choose, bodies, policy } = await ariaDrawer();
  choose(CH.general);
  radio('custom').checked = true;
  radio('custom').fire('change');
  const box = (c: string) => form.querySelectorAll('input').find((i) => i.type === 'checkbox' && i.value === c)!;
  box('MENTION_EVERYONE').checked = true;
  box('MENTION_EVERYONE').fire('change');
  form.fire('submit');
  await settle();
  assert.deepEqual(bodies.at(-1), { channelId: CH.general, caps: ['VIEW_CHANNEL', 'READ_HISTORY', 'MENTION_EVERYONE'] });
  choose('__guild__');
  radio('read').checked = true;
  radio('read').fire('change');
  form.fire('submit');
  await settle();
  assert.deepEqual(bodies.at(-1), { guildDefault: true, level: 'read' });
  assert.deepEqual(policy.default, [...LEVEL_CAPS.read]);
});

test('grant editor: guild-wide is set, denied or not set — with Unset and Deny guild-wide', async () => {
  const policy = { channels: {} as Record<string, string[]>, default: [...LEVEL_CAPS.read] };
  const { drawer, doc, calls } = await ariaDrawer({ policy });
  const g = '/admin/g/' + G1 + '/personas/aria/grants';
  const row = () => drawer.querySelectorAll('tr').find((tr) => tr.children[0]?.textContent === 'Every channel (guild-wide)')!;
  const buttons = () => row().querySelectorAll('button').map((b) => b.textContent);
  const status = () => drawer.querySelector('form.grant-form')!.querySelector('.status-line')!.textContent;
  assert.equal(row().children[1].textContent, 'Read');
  assert.deepEqual(buttons(), ['Unset', 'Deny guild-wide']);

  // Unset: asked, then DELETE ?guildDefault=unset.
  row().querySelectorAll('button').find((b) => b.textContent === 'Unset')!.click();
  await settle();
  const dialog = doc.querySelector('.modal')!;
  assert.equal(dialog.querySelector('h2')!.textContent, 'Unset Aria’s guild-wide level in Guild One?');
  assert.match(dialog.textContent, /fall back to Aria’s persona default/);
  dialog.querySelectorAll('button').find((b) => b.textContent === 'Unset guild-wide')!.click();
  await settle();
  assert.equal(calls.at(-1), `DELETE ${g}?guildDefault=unset`);
  assert.equal(status(), 'Unset Aria’s guild-wide level in Guild One: channels without their own grant fall back to the persona default.');
  assert.equal(row().children[1].textContent, 'Not set');
  assert.deepEqual(buttons(), ['Deny guild-wide'], 'nothing to unset; a deny can still be set');

  // Deny: asked, then DELETE ?guildDefault=deny.
  row().querySelectorAll('button')[0].click();
  await settle();
  assert.match(doc.querySelector('.modal')!.textContent, /the deny blocks its persona default here/);
  doc.querySelector('.modal')!.querySelector('button.btn-danger-solid')!.click();
  await settle();
  assert.equal(calls.at(-1), `DELETE ${g}?guildDefault=deny`);
  assert.equal(row().children[1].textContent, 'Denied');
  assert.deepEqual(buttons(), ['Unset']);
});

test('grant editor: the relay’s refusal is put in words in the section’s line', async () => {
  const { form, radio, choose, drawer } = await ariaDrawer({
    refusePut: (body) => (body.channelId === CH.labNotes ? refuse(400, 'THREAD_TARGET', 'thread', { parentId: CH.research }) : refuse(400, 'CATEGORY_TARGET')),
  });
  choose(CH.labNotes);
  radio('write').checked = true;
  radio('write').fire('change');
  form.fire('submit');
  await settle();
  const line = drawer.querySelector('form.grant-form')!.querySelector('.status-line')!;
  assert.equal(line.textContent, 'Not saved: lab-notes is a thread. Threads use #research’s access — give access there.');
  assert.ok(line.classList.contains('status-err'));
});

test('persona rows: direct grants that give something, a guild-wide deny, or nothing', async () => {
  const g = '/admin/g/' + G1;
  const { ctx, doc } = appSandbox({
    routes: {
      [g + '/personas']: {
        personas: [
          { id: 'aria', displayName: 'Aria', roles: [], directGrants: 'grants', hasOverride: true },
          { id: 'quill', displayName: 'Quill', roles: [], directGrants: 'denied', hasOverride: false },
          { id: 'nyx', displayName: 'Nyx', roles: [], directGrants: 'none', hasOverride: false },
        ],
        total: 3, limit: 50, offset: 0,
      },
    },
  });
  await ctx.PA.app.boot();
  await settle();
  const cells = doc.getElementById('view')!.querySelectorAll('tr').slice(1).map((tr) => tr.children.at(-1)!.textContent);
  assert.deepEqual(cells, ['direct grants', 'denied guild-wide', '—']);
});

test('invites list: each invite’s status; a spent one is deleted, an active one revoked', async () => {
  const g = '/admin/g/' + G1;
  const { ctx, doc, calls } = appSandbox({
    routes: {
      [g + '/invites']: {
        invites: [
          { code: 'inv_fixtureinvite000000new', label: 'newest', uses: 0, maxUses: 1, roles: ['g1-readers'], status: 'active' },
          { code: 'inv_fixtureinvite000000use', label: 'used-up', uses: 1, maxUses: 1, roles: ['g1-readers'], status: 'used' },
          { code: 'inv_fixtureinvite000000old', label: 'expired', uses: 0, roles: ['g1-readers'], expiresAt: '2026-01-01T00:00:00Z', status: 'expired' },
        ],
        total: 3, limit: 50, offset: 0,
      },
    },
  });
  await ctx.PA.app.boot();
  await settle();
  clickable(doc, 'invites').click();
  await settle();
  const rows = doc.getElementById('view')!.querySelectorAll('tr').map((tr) => tr.children.map((td) => td.textContent));
  assert.deepEqual(rows[0].slice(0, 3), ['Code', 'Label', 'Status']);
  assert.deepEqual(rows.slice(1).map((r) => [r[1], r[2], r.at(-1)]), [['newest', 'Active', 'Revoke'], ['used-up', 'Used up', 'Delete'], ['expired', 'Expired', 'Delete']]);
  doc.querySelectorAll('button').find((b) => b.textContent === 'Delete')!.click();
  await settle();
  assert.equal(doc.querySelector('.modal')!.querySelector('h2')!.textContent, 'Delete invite “used-up”?');
  doc.querySelector('.modal')!.querySelector('button.btn-danger-solid')!.click();
  await settle();
  assert.ok(calls.includes(`DELETE ${g}/invites/inv_fixtureinvite000000use`));
});

test('persona drawer: Upload is offered only when the relay keeps uploaded pictures', async () => {
  for (const avatarUploads of [false, true]) {
    const g = '/admin/g/' + G1;
    const { ctx, doc } = appSandbox({
      routes: {
        '/admin/me': { user: { name: 'Op' }, isSuper: true, guilds: [{ id: G1, name: 'Guild One' }], csrf: 'c', features: { invites: true, avatarUploads, allowlistEditable: true } },
        [g + '/personas/aria']: { id: 'aria', displayName: 'Aria', roles: [], guildPolicy: null, names: { channels: {} } },
        '/admin/personas/aria': { id: 'aria', displayName: 'Aria', avatar: '', avatarUrl: '', roles: [], policy: null, guilds: [], names: {} },
      },
    });
    await ctx.PA.app.boot();
    await settle();
    clickable(doc, 'Aria').click();
    await settle();
    const drawer = doc.getElementById('drawer-body')!;
    assert.ok(drawer.querySelectorAll('button').some((b) => b.textContent === 'Save'), 'the URL form is there');
    assert.equal(drawer.querySelectorAll('button').some((b) => b.textContent === 'Upload image…'), avatarUploads, `avatarUploads: ${avatarUploads}`);
  }
});

test('role drawer: a role made between the look and the save is asked about, then edited in its own guild', async () => {
  const { define, confirm, catalog, net, bodies } = await rolesTab();
  // Someone defines g1-race in Guild One just after this drawer looked.
  let raced = false;
  net.beforePost = (body) => {
    if (raced || body.replace) return;
    raced = true;
    catalog['g1-race'] = { caps: [...LEVEL_CAPS.full], scope: { all: true }, guildId: G1 };
  };
  await define('g1-race', 'read');
  const dialog = confirm();
  assert.ok(dialog, 'the 409 leads to a fresh look, and the question');
  assert.equal(dialog!.querySelector('h2')!.textContent, 'A role named g1-race already exists — edit it instead?');
  dialog!.querySelector('button.btn-danger-solid')!.click();
  await settle();
  assert.deepEqual(bodies.at(-1), { name: 'g1-race', role: { caps: [...LEVEL_CAPS.read], scope: { all: true }, guildId: G1 }, replace: true, expectedGuildId: G1 });
  assert.deepEqual(catalog['g1-race'].caps, [...LEVEL_CAPS.read]);
});

test('role drawer: a new name must be one the relay accepts', async () => {
  const { button, doc } = await rolesTab();
  button('+ Define access role')!.click();
  await settle();
  const form = doc.getElementById('drawer-body')!.querySelector('form')!;
  const input = form.querySelector('input[name="name"]')!;
  input.value = 'Chatters Two';
  input.fire('input');
  const submit = form.querySelector('button[type="submit"]')!;
  assert.equal(submit.disabled, true);
  assert.match(form.textContent, /Use lower-case letters, digits, dots, dashes or underscores in the name \(up to 64\) to create it\./);
});

// ── Addresses: the router grammar (lib.js) ──

const GA = '100000000000000001'; // Guild One
const GB = '100000000000000002'; // Guild Two

test('lib.parseRoute / formatRoute: every address round-trips', () => {
  const { lib } = libOnly();
  const g = '#/g/' + GA;
  const table = [
    '#/',
    '#/guilds',
    g + '/channels',
    g + '/channels?q=res&show=agents&cat=' + CH.catResearch,
    g + '/channels/c/' + CH.research,
    g + '/personas',
    g + '/personas?q=ar%20ia',
    g + '/personas/p/aria',
    g + '/personas/p/aria-1a2b3c',
    g + '/personas/p/sol.6d7e8f:x_y',
    g + '/personas/add',
    g + '/give',
    g + '/give?p=aria,sol&c=' + CH.general + ',' + CH.research + '&lvl=write',
    g + '/invites',
    g + '/invites?status=spent&q=guests',
    g + '/invites/new',
    g + '/invites/new?c=' + CH.general + '&lvl=read&r=g1-readers,g1-chatters',
    g + '/invites/i/0123456789abcdef01234567',
    g + '/roles',
    g + '/roles?q=g1',
    g + '/roles/r/g1-readers',
    g + '/roles/r/Old%20Name%2C%20kept',
    g + '/roles/new',
    g + '/audit',
    g + '/audit?q=mint&actor=200000000000000002&persona=aria&channel=' + CH.general + '&action=invites&reads=1',
    '#/all/personas',
    '#/all/personas?q=sol',
    '#/all/personas/p/sol',
    '#/all/audit',
    '#/all/audit?guild=' + GB + '&action=roles',
  ];
  for (const h of table) {
    const r = lib.parseRoute(h);
    assert.ok(r, 'parses: ' + h);
    assert.equal(lib.formatRoute(r), h, 'formats back: ' + h);
    assert.deepEqual(plain(lib.parseRoute(lib.formatRoute(r))), plain(r), 'and parses the same: ' + h);
    assert.equal(lib.isSafeReturnTo(h), true, 'a place to return to: ' + h);
  }
  // What a route holds.
  assert.deepEqual(plain(lib.parseRoute(g + '/personas/p/aria')), { area: 'g', gid: GA, view: 'personas', drawer: { kind: 'persona', id: 'aria' }, query: {} });
  assert.deepEqual(plain(lib.parseRoute(g + '/invites/new?c=' + CH.general + '&lvl=read&r=g1-readers,a%2Cb')!.query), { c: CH.general, lvl: 'read', r: ['g1-readers', 'a,b'] });
  assert.equal(lib.parseRoute('')!.area, 'home');
  // Anything else is written back the one way: unknown keys and empty values go.
  assert.equal(lib.formatRoute(lib.parseRoute(g + '/personas?zz=1&q=')), g + '/personas');
  assert.equal(lib.formatRoute(lib.parseRoute(g + '/personas?q=a&q=b')), g + '/personas?q=a', 'the first one counts');
  assert.equal(lib.formatRoute(lib.parseRoute(g + '/personas?utm=x&q=a+b')), g + '/personas?q=a%20b');
  assert.equal(lib.formatRoute(lib.parseRoute(g + '/personas/')), g + '/personas');
  // Characters encodeURIComponent leaves alone are escaped too.
  assert.equal(lib.formatRoute({ area: 'g', gid: GA, view: 'personas', drawer: null, query: { q: "it's (x)!" } }), g + '/personas?q=it%27s%20%28x%29%21');
});

test('lib.parseRoute: a bad id, value or shape is no route at all', () => {
  const { lib } = libOnly();
  const g = '#/g/' + GA;
  const bad = [
    '#/g/abc/zzz', '#/g/1234/personas', '#/g/' + '1'.repeat(26) + '/personas', '#/g//personas', '#/g/' + GA,
    g + '/zzz', g + '/personas/p', g + '/personas/p/a/b', g + '/personas/p/' + encodeURIComponent('a/b'),
    g + '/personas/p/..', g + '/personas/p/' + 'x'.repeat(101), g + '/personas/p/a%20b', g + '/personas/x/aria',
    g + '/channels/c/general', g + '/channels?show=some', g + '/channels?cat=12',
    g + '/invites/i/0123456789ABCDEF01234567', g + '/invites/i/0123', g + '/invites?status=used',
    g + '/invites/new?lvl=admin', g + '/invites/new?r=a%2Fb',
    g + '/roles/r/' + 'r'.repeat(65), g + '/roles/r/a%2Fb', g + '/roles/r/%E0%A4%A',
    g + '/give?p=' + Array.from({ length: 21 }, (_, i) => 'p' + i).join(','), g + '/give?c=' + CH.general + ',x', g + '/give?lvl=Write',
    g + '/audit?actor=gwen', g + '/audit?action=everything', g + '/audit?reads=yes',
    '#/all', '#/all/roles', '#/all/personas/p/a/b', '#/guilds/x', '#/x', '#g/' + GA + '/personas', 'javascript:alert(1)', '/#/guilds',
    g + '/../' + GB + '/personas', '#/g/1/../x',
  ];
  for (const h of bad) assert.equal(lib.parseRoute(h), null, h);
  // And nothing it can't write is written.
  assert.equal(lib.formatRoute({ area: 'g', gid: 'abc', view: 'personas', drawer: null, query: {} }), null);
  assert.equal(lib.formatRoute({ area: 'g', gid: GA, view: 'personas', drawer: { kind: 'persona', id: 'a/b' }, query: {} }), null);
  assert.equal(lib.formatRoute({ area: 'g', gid: GA, view: 'zzz', drawer: null, query: {} }), null);
});

test('lib.isSafeReturnTo: only a panel address, in a narrow character set', () => {
  const { lib } = libOnly();
  for (const s of [
    'javascript:alert(1)', 'javascript://%0aalert(1)', '#/g/1/../x', '#/g/' + GA + '/../x', 'https://example.invalid/#/g/' + GA + '/personas',
    '//example.invalid', '/admin/login', '#/g/' + GA + '/personas?q=' + 'a'.repeat(600), '#/' + 'g'.repeat(600),
    '#/g/' + GA + '/zzz', '#/g/' + GA + '/channels/x', '#/nowhere', '#/g/' + GA + '/personas?q=<b>', '#/g/' + GA + '/personas?q=a b',
    '', null, undefined, 42, { toString: () => '#/guilds' },
  ]) assert.equal(lib.isSafeReturnTo(s as any), false, String(s));
  for (const s of ['#/', '#/guilds', '#/g/' + GA + '/invites/new', '#/g/' + GA + '/personas?q=ar%20ia']) assert.equal(lib.isSafeReturnTo(s), true, s);
});

test('lib drafts: only whitelisted fields are kept, only for the same admin, for 30 minutes', () => {
  const { lib } = libOnly();
  const route = '#/g/' + GA + '/invites/new';
  const fields = {
    label: 'x', kind: 'roles', roles: ['g1-readers'], caps: ['VIEW_CHANNEL'], uses: '5', expires: '7', mode: 'mint',
    // Never kept: a code, a token, a picture, a reveal, anything unlisted or malformed.
    code: 'inv_secret', token: 'tok', avatar: 'data:image/png;base64,AAAA', reveal: 'inv_x', password: 'p',
    channels: ['not-an-id'], usesOther: '1e9',
  };
  const d = lib.makeDraft({ userId: '200000000000000001', route, form: 'mint', fields, at: 1000 })!;
  assert.deepEqual(plain(d), {
    v: 1, userId: '200000000000000001', route, form: 'mint', at: 1000,
    fields: { label: 'x', kind: 'roles', roles: ['g1-readers'], caps: ['VIEW_CHANNEL'], uses: '5', expires: '7', mode: 'mint' },
  });
  assert.deepEqual(plain(lib.draftFields('grant', { target: '__guild__', caps: ['VIEW_CHANNEL'], code: 'inv_x' })), { target: '__guild__', caps: ['VIEW_CHANNEL'] });
  assert.deepEqual(plain(lib.draftFields('role', { name: 'g1-x', where: 'all', token: 't' })), { name: 'g1-x', where: 'all' });
  // Forms without a schema (the invite claim takes a code) keep nothing.
  assert.equal(lib.makeDraft({ userId: 'u', route, form: 'claim', fields: { code: 'inv_x' }, at: 1 }), null);
  assert.equal(lib.makeDraft({ userId: 'u', route: 'javascript:x', form: 'mint', fields: {}, at: 1 }), null);
  assert.equal(lib.makeDraft({ userId: '', route, form: 'mint', fields: {}, at: 1 }), null);

  const json = JSON.stringify(d);
  assert.deepEqual(plain(lib.readDraft(json, { userId: '200000000000000001', now: 1000 + 29 * 60_000 })), plain(d));
  assert.equal(lib.readDraft(json, { userId: '200000000000000002', now: 2000 }), null, 'another admin');
  assert.equal(lib.readDraft(json, { userId: '200000000000000001', now: 1000 + 31 * 60_000 }), null, 'too old');
  assert.equal(lib.readDraft(json, { userId: '200000000000000001', now: 500 }), null, 'from the future');
  assert.equal(lib.readDraft(JSON.stringify({ ...d, v: 2 }), { userId: '200000000000000001', now: 1000 }), null);
  assert.equal(lib.readDraft('{nope', { userId: '200000000000000001', now: 1000 }), null);
  assert.equal(lib.readDraft(null, { userId: '200000000000000001', now: 1000 }), null);
  // A stored draft is checked again on the way back in.
  const tampered = JSON.stringify({ ...d, fields: { ...d.fields, code: 'inv_secret' } });
  assert.equal('code' in lib.readDraft(tampered, { userId: '200000000000000001', now: 1000 })!.fields, false);
});

test('lib.loginErrorText: the fixed table; anything else is a generic line', () => {
  const { lib } = libOnly();
  assert.equal(lib.loginErrorText('cancelled'), 'Sign-in was cancelled in Discord.');
  assert.equal(lib.loginErrorText('expired'), 'That sign-in took too long or the relay restarted. Try again.');
  assert.equal(lib.loginErrorText('mismatch'), 'Sign-in was started in another tab. Try again here.');
  assert.equal(lib.loginErrorText('discord_error'), 'Discord didn’t respond. Try again in a minute.');
  assert.equal(lib.loginErrorText('rate_limited'), 'Too many sign-in attempts. Wait a minute and try again.');
  assert.match(lib.loginErrorText('not_admin'), /^You don’t manage any guild this relay serves\./);
  assert.equal(lib.loginErrorText('<script>'), 'Sign-in didn’t finish. Try again.');
  assert.equal(lib.loginErrorText(null), null);
});

// ── Addresses in the app: reload, Back, links ──

const ME_OP = { user: { id: '200000000000000001', name: 'Op' }, isSuper: true, guilds: [], csrf: 'csrf-1' };
const ME_GWEN = { user: { id: '200000000000000002', name: 'Gwen' }, isSuper: false, guilds: [{ id: GA, name: 'Guild One' }], csrf: 'csrf-1' };

/** The panel signed in as `me`, at `url`, over Guild One's fixture. */
async function panelAt(url: string, opts: { me?: unknown; guilds?: unknown[]; handle?: FakeHandler; routes?: Record<string, unknown>; session?: Record<string, string>; local?: Record<string, string> } = {}) {
  const g = '/admin/g/' + GA;
  const box = appSandbox({
    url,
    session: opts.session,
    local: opts.local,
    routes: {
      '/admin/me': opts.me ?? ME_GWEN,
      '/admin/guilds': { guilds: opts.guilds ?? [{ id: GA, name: 'Guild One' }] },
      [g + '/roles']: { catalog: G1_CATALOG, discordRoles: [], canAuthor: false },
      [g + '/channels']: { channels: G1_CHANNELS },
      [g + '/personas/aria']: { id: 'aria', displayName: 'Aria', roles: ['g1-chatters'], guildPolicy: { channels: {} }, names: { channels: {} } },
      [g + '/audit']: { records: [] },
      ...opts.routes,
    },
    handle: opts.handle,
  });
  await box.ctx.PA.app.boot();
  await settle();
  const here = () => box.nav.location.hash;
  const drawerOpen = () => !box.doc.getElementById('drawer')!.classList.contains('hidden');
  return { ...box, here, drawerOpen };
}

test('app routes: reload keeps the guild and tab; a persona is an address; Back closes it, then goes back a tab', async () => {
  const g = '#/g/' + GA;
  const { nav, here, calls, tabs, drawerOpen, doc } = await panelAt('/' + g + '/invites');
  assert.equal(here(), g + '/invites');
  assert.ok(calls.includes(`GET /admin/g/${GA}/invites?limit=50&offset=0`), 'Invites is drawn');
  assert.equal(tabs.invites.getAttribute('aria-current'), 'page');
  assert.equal(tabs.personas.getAttribute('href'), g + '/personas', 'tabs are links');
  assert.equal(doc.title, 'Portal admin — Invites — Guild One');

  tabs.personas.click();
  await settle();
  assert.equal(here(), g + '/personas');
  const aria = clickable(doc, 'Aria');
  assert.equal(aria.tagName, 'A');
  assert.equal(aria.getAttribute('href'), g + '/personas/p/aria');
  aria.click();
  await settle();
  assert.equal(here(), g + '/personas/p/aria');
  assert.ok(drawerOpen());

  nav.back();
  await settle();
  assert.equal(here(), g + '/personas');
  assert.equal(drawerOpen(), false, 'Back closes the drawer');
  nav.back();
  await settle();
  assert.equal(here(), g + '/invites', 'and Back again is Invites');
  assert.equal(tabs.invites.getAttribute('aria-current'), 'page');
});

test('app routes: a deep link opens its drawer; closing it puts its list in its place', async () => {
  const g = '#/g/' + GA;
  const { nav, here, drawerOpen, doc } = await panelAt('/' + g + '/personas/p/aria');
  assert.ok(drawerOpen());
  assert.equal(doc.getElementById('drawer-title')!.textContent, 'Aria aria');
  const before = nav.entries.length;
  doc.getElementById('drawer-close')!.click();
  await settle();
  assert.equal(here(), g + '/personas');
  assert.equal(nav.entries.length, before, 'replaced, not a new entry');
  assert.equal(drawerOpen(), false);
});

test('app routes: Esc closes the drawer and gives focus back to the link that opened it', async () => {
  const g = '#/g/' + GA;
  const { here, doc, drawerOpen } = await panelAt('/' + g + '/personas');
  const aria = clickable(doc, 'Aria');
  aria.focus();
  aria.click();
  await settle();
  assert.ok(drawerOpen());
  assert.equal(doc.activeElement, doc.getElementById('drawer-title'), 'focus moves to the title');
  doc.key('Escape');
  await settle();
  assert.equal(drawerOpen(), false);
  assert.equal(doc.activeElement, aria);
  assert.equal(here(), g + '/personas');
});

test('app routes: a link that isn’t valid goes to the last guild and tab, and says so', async () => {
  const local = { ['pa.lastGuild:' + ME_GWEN.user.id]: GA, ['pa.lastTab:' + ME_GWEN.user.id]: 'roles' };
  const { here, doc, nav } = await panelAt('/#/g/abc/zzz', { local });
  assert.equal(here(), '#/g/' + GA + '/roles');
  assert.equal(nav.entries.length, 1, 'in place (replaceState)');
  assert.ok(doc.getElementById('toasts')!.textContent.includes('That link wasn’t valid.'));
});

test('app routes: home is the last guild and tab; the place is remembered as you go', async () => {
  const { here, localStore, tabs } = await panelAt('/');
  assert.equal(here(), '#/g/' + GA + '/personas', 'a first visit lands on Personas');
  tabs.audit.click();
  await settle();
  assert.equal(localStore.getItem('pa.lastTab:' + ME_GWEN.user.id), 'audit');
  assert.equal(localStore.getItem('pa.lastGuild:' + ME_GWEN.user.id), GA);
});

test('app routes: a page a later version adds says so and shows the nearest one', async () => {
  const { here, doc } = await panelAt('/#/g/' + GA + '/channels/c/' + CH.research);
  assert.equal(here(), '#/g/' + GA + '/personas');
  assert.ok(doc.getElementById('toasts')!.textContent.includes('That page isn’t available yet — showing Personas instead.'));
});

test('app routes: the search box keeps ?q= in place — Back never steps through keystrokes', async () => {
  const g = '#/g/' + GA;
  const { here, nav, doc, advance, calls } = await panelAt('/' + g + '/personas');
  const before = nav.entries.length;
  const search = doc.getElementById('list-search')!;
  for (const v of ['a', 'ar', 'ari']) {
    search.value = v;
    search.fire('input');
    advance(300);
    await settle();
  }
  assert.equal(here(), g + '/personas?q=ari');
  assert.equal(nav.entries.length, before);
  assert.equal(calls.at(-1), `GET /admin/g/${GA}/personas?q=ari&limit=50&offset=0`);
  // A reload of that address comes back with the search in the box.
  const again = await panelAt('/' + g + '/personas?q=ari');
  assert.equal(again.doc.getElementById('list-search')!.value, 'ari');
  assert.ok(again.calls.includes(`GET /admin/g/${GA}/personas?q=ari&limit=50&offset=0`));
});

test('app routes: a link into a guild this admin can’t manage shows why, never that guild’s data or name', async () => {
  const { here, doc, calls } = await panelAt('/#/g/' + GB + '/personas', {
    routes: { ['/admin/g/' + GB + '/personas']: { personas: [{ id: 'sol', displayName: 'Sol' }], total: 1, limit: 50, offset: 0 } },
  });
  assert.equal(here(), '#/g/' + GB + '/personas', 'the address stays');
  const view = doc.getElementById('view')!;
  assert.equal(view.querySelector('h2')!.textContent, 'You’re not an admin of this guild, or we couldn’t verify your Discord permissions right now.');
  assert.ok(!calls.some((c) => c.includes('/admin/g/' + GB)), 'nothing is asked of that guild');
  assert.doesNotMatch(doc.body.textContent, /Guild Two|Sol/);
  assert.equal(doc.title, 'Portal admin');
  // The guild switcher, inline: picking a guild goes there.
  const pick = view.querySelector('select')!;
  pick.value = GA;
  pick.fire('change');
  await settle();
  assert.equal(here(), '#/g/' + GA + '/personas');
  assert.ok(doc.getElementById('view')!.textContent.includes('Aria'));
});

test('app routes: the relay’s own “not an admin of this guild” shows the same view, and Try again asks again', async () => {
  let allowed = false;
  const { doc, calls } = await panelAt('/#/g/' + GA + '/invites', {
    handle: (method, path) => (!allowed && path.startsWith('/admin/g/') ? refuse(403, 'FORBIDDEN', 'not an admin of this guild', { reason: 'NOT_GUILD_ADMIN' }) : undefined),
  });
  const view = doc.getElementById('view')!;
  assert.equal(view.querySelector('h2')!.textContent, 'You’re not an admin of this guild, or we couldn’t verify your Discord permissions right now.');
  allowed = true;
  clickable(doc, 'Try again', view).click();
  await settle();
  assert.ok(calls.filter((c) => c === 'GET /admin/guilds').length >= 2, 'the guild list is asked for again');
  assert.ok(doc.getElementById('view')!.textContent.includes('inv_fixtureinvite0000000a'), 'and the page is shown');
});

test('app routes: a super-admin’s page, for anyone else, goes home', async () => {
  const { here } = await panelAt('/#/guilds');
  assert.equal(here(), '#/g/' + GA + '/personas');
});

// ── A session that ends mid-task ──

/** Mint drawer: label and access role picked, as an admin would. */
function fillMint(doc: FakeDocument, label: string, role: string) {
  const drawer = doc.getElementById('drawer-body')!;
  const input = drawer.querySelector('input[name="label"]')!;
  input.value = label;
  input.fire('input');
  const box = drawer.querySelectorAll('input').find((i) => i.type === 'checkbox' && i.value === role)!;
  box.checked = true;
  box.fire('change');
  return drawer.querySelector('form')!;
}

test('session: a change refused with 401 says it was NOT saved, over the page; Sign in again keeps the place and the form', async () => {
  const g = '#/g/' + GA;
  let down = false;
  const box = await panelAt('/' + g + '/invites/new', {
    me: ME_OP, guilds: [{ id: GA, name: 'Guild One' }],
    handle: (method, path) => (down ? refuse(401, 'UNAUTHENTICATED', 'login required') : undefined),
  });
  const { doc, nav, sessionStore, drawerOpen } = box;
  const form = fillMint(doc, 'x', 'g1-readers');
  down = true;
  form.fire('submit');
  await settle();
  const modal = doc.querySelector('.modal')!;
  assert.equal(modal.getAttribute('role'), 'alertdialog');
  assert.equal(modal.querySelector('h2')!.textContent, 'Your session ended — this change was NOT saved.');
  assert.ok(drawerOpen(), 'the drawer stays');
  assert.equal(doc.getElementById('drawer-body')!.querySelector('input[name="label"]')!.value, 'x', 'and so does the form');
  assert.ok(doc.getElementById('login')!.classList.contains('hidden'), 'not the sign-in card');
  assert.ok(!doc.getElementById('app')!.classList.contains('hidden'));

  clickable(doc, 'Sign in again', modal).click();
  assert.deepEqual(nav.assigned, ['/admin/login']);
  assert.equal(sessionStore.getItem('pa.returnTo'), g + '/invites/new');
  const draft = JSON.parse(sessionStore.getItem('pa.draft')!);
  assert.equal(draft.v, 1);
  assert.equal(draft.userId, ME_OP.user.id);
  assert.equal(draft.route, g + '/invites/new');
  assert.equal(draft.form, 'mint');
  assert.equal(draft.fields.label, 'x');
  assert.deepEqual(draft.fields.roles, ['g1-readers']);
  assert.equal(JSON.stringify(draft).includes('inv_'), false);
  // Going to sign in asks no "Leave site?" question.
  assert.equal(nav.dispatch('beforeunload').defaultPrevented, false);

  // Back from Discord: the relay lands on '/', the panel on the kept place,
  // the form filled in again. Nothing is sent.
  const back = await panelAt('/', {
    me: ME_OP, guilds: [{ id: GA, name: 'Guild One' }],
    session: { 'pa.returnTo': sessionStore.getItem('pa.returnTo')!, 'pa.draft': sessionStore.getItem('pa.draft')! },
  });
  assert.equal(back.here(), g + '/invites/new');
  const body = back.doc.getElementById('drawer-body')!;
  assert.equal(body.querySelector('input[name="label"]')!.value, 'x');
  assert.equal(body.querySelectorAll('input').find((i) => i.type === 'checkbox' && i.value === 'g1-readers')!.checked, true);
  assert.ok(body.textContent.includes('Restored your unsaved change — review and save. Nothing was submitted.'));
  assert.ok(!back.calls.some((c) => c.startsWith('POST')), 'nothing was submitted');
  assert.equal(back.sessionStore.getItem('pa.draft'), null, 'the draft is used once');
  assert.equal(back.sessionStore.getItem('pa.returnTo'), null);
});

test('session: a draft is put back only for the same admin, at the same place', async () => {
  const g = '#/g/' + GA;
  const draft = (userId: string, route: string) => JSON.stringify({ v: 1, userId, route, form: 'mint', fields: { label: 'kept' }, at: Date.now() });
  for (const [d, want] of [
    [draft(ME_OP.user.id, g + '/invites/new'), 'kept'],
    [draft('200000000000000009', g + '/invites/new'), ''],
    [draft(ME_OP.user.id, g + '/invites'), ''],
  ] as const) {
    const box = await panelAt('/' + g + '/invites/new', { me: ME_OP, guilds: [{ id: GA, name: 'Guild One' }], session: { 'pa.draft': d } });
    assert.equal(box.doc.getElementById('drawer-body')!.querySelector('input[name="label"]')!.value, want);
  }
});

test('session: a read that finds the session over says so over the page; the sign-in card is for boot only', async () => {
  let down = false;
  const { doc, tabs } = await panelAt('/#/g/' + GA + '/personas', {
    handle: (method) => (down && method === 'GET' ? refuse(401, 'UNAUTHENTICATED', 'login required') : undefined),
  });
  down = true;
  tabs.invites.click();
  await settle();
  assert.equal(doc.querySelector('.modal')!.querySelector('h2')!.textContent, 'Your session ended.');
  assert.ok(doc.getElementById('login')!.classList.contains('hidden'));
  assert.equal(doc.querySelectorAll('.modal').length, 1, 'one at a time');
});

test('session: a stale CSRF token (another tab signed in again) is fetched anew and the change sent once more', async () => {
  let token = 'csrf-new';
  const sent: string[] = [];
  const me = () => ({ ...ME_GWEN, csrf: token });
  const box = await panelAt('/#/g/' + GA + '/personas/p/aria', {
    handle: (method, path, body, headers) => {
      if (path === '/admin/me') return me();
      if (method === 'PUT') {
        sent.push(headers['X-CSRF-Token']);
        return headers['X-CSRF-Token'] === token ? { guildPolicy: { channels: { [CH.general]: [...LEVEL_CAPS.write] } } } : refuse(403, 'CSRF', 'missing or invalid CSRF token');
      }
      return undefined;
    },
  });
  token = 'csrf-newer'; // tab B signed in again
  const form = box.doc.getElementById('drawer-body')!.querySelector('form.grant-form')!;
  const target = form.querySelector('select')!;
  target.value = CH.general;
  target.fire('change');
  const write = form.querySelectorAll('input').find((i) => i.type === 'radio' && i.value === 'write')!;
  write.checked = true;
  write.fire('change');
  form.fire('submit');
  await settle();
  assert.deepEqual(sent, ['csrf-new', 'csrf-newer'], 'refused once, then sent with the new token');
  assert.match(form.textContent, /Aria → Write in #general\./);
  assert.equal(box.doc.querySelector('.modal'), null);
});

test('session: a stale CSRF token that now belongs to another admin reloads the tab', async () => {
  let who = ME_GWEN;
  const box = await panelAt('/#/g/' + GA + '/personas/p/aria', {
    handle: (method, path) => {
      if (path === '/admin/me') return who;
      if (method === 'DELETE') return refuse(403, 'CSRF', 'missing or invalid CSRF token');
      return undefined;
    },
  });
  who = { ...ME_GWEN, user: { id: '200000000000000003', name: 'Dee' } };
  clickable(box.doc, 'Deny guild-wide').click();
  await settle();
  box.doc.querySelector('.modal')!.querySelector('button.btn-danger-solid')!.click();
  await settle();
  assert.equal(box.nav.reloads, 1);
  assert.equal(box.sessionStore.getItem('pa.notice'), 'other-user');
  assert.equal(box.calls.filter((c) => c.startsWith('DELETE')).length, 1, 'not sent again as someone else');
});

test('session: the sign-in card says why the last sign-in came back, and the code leaves the address', async () => {
  const box = appSandbox({ url: '/?login_error=expired#/g/' + GA + '/invites', handle: (_m, path) => (path === '/admin/me' ? refuse(401, 'UNAUTHENTICATED') : undefined) });
  await box.ctx.PA.app.boot();
  await settle();
  const err = box.doc.getElementById('login-error')!;
  assert.ok(!box.doc.getElementById('login')!.classList.contains('hidden'));
  assert.equal(err.querySelector('p')!.textContent, 'That sign-in took too long or the relay restarted. Try again.');
  assert.equal(clickable(box.doc, 'Try again', err).getAttribute('href'), '/admin/login');
  assert.equal(box.nav.current, '/#/g/' + GA + '/invites', 'the code is gone; the place stays');
  // Signing in from here comes back here.
  box.doc.getElementById('login-btn')!.click();
  assert.equal(box.sessionStore.getItem('pa.returnTo'), '#/g/' + GA + '/invites');
});

test('session: unsaved changes ask before the page is left', async () => {
  const box = await panelAt('/#/g/' + GA + '/invites/new', { me: ME_OP, guilds: [{ id: GA, name: 'Guild One' }] });
  assert.equal(box.nav.dispatch('beforeunload').defaultPrevented, false, 'nothing typed yet');
  fillMint(box.doc, 'x', 'g1-readers');
  assert.equal(box.nav.dispatch('beforeunload').defaultPrevented, true);
});

test('session: Back out of a drawer with unsaved changes asks first; Cancel stays', async () => {
  const g = '#/g/' + GA;
  const box = await panelAt('/' + g + '/invites', { me: ME_OP, guilds: [{ id: GA, name: 'Guild One' }] });
  clickable(box.doc, '+ Mint invite').click();
  await settle();
  assert.equal(box.here(), g + '/invites/new');
  fillMint(box.doc, 'x', 'g1-readers');
  box.nav.back();
  await settle();
  const ask = box.doc.querySelector('.modal')!;
  assert.equal(ask.querySelector('h2')!.textContent, 'Discard changes?');
  assert.equal(box.here(), g + '/invites/new', 'the address is put back while it asks');
  clickable(box.doc, 'Cancel', ask).click();
  await settle();
  assert.ok(box.drawerOpen());
  assert.equal(box.doc.getElementById('drawer-body')!.querySelector('input[name="label"]')!.value, 'x');
  box.nav.back();
  await settle();
  clickable(box.doc, 'Discard changes', box.doc.querySelector('.modal')!).click();
  await settle();
  assert.equal(box.drawerOpen(), false);
  assert.equal(box.here(), g + '/invites');
  assert.equal(box.nav.i, 0, 'Back to the entry it was going to, not a copy of it');
});

test('session: tabs tell each other about sign-in and sign-out; coming back to the tab checks the session', async () => {
  const channels: Array<{ name: string; posted: unknown[]; onmessage: ((e: { data: unknown }) => void) | null }> = [];
  class FakeChannel {
    posted: unknown[] = [];
    onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor(public name: string) {
      channels.push(this);
    }
    postMessage(m: unknown) {
      this.posted.push(m);
    }
  }
  let token = 'csrf-1';
  const sentWith: string[] = [];
  const box = appSandbox({
    url: '/#/g/' + GA + '/personas',
    routes: { '/admin/guilds': { guilds: [{ id: GA, name: 'Guild One' }] } },
    handle: (method, path, _b, headers) => {
      if (path === '/admin/me') return { ...ME_GWEN, csrf: token, session: { expiresAt: Date.now() + 60_000 } };
      if (method === 'POST' && path === '/admin/logout') {
        sentWith.push(headers['X-CSRF-Token']);
        return { ok: true };
      }
      return undefined;
    },
  });
  box.ctx.BroadcastChannel = FakeChannel;
  await box.ctx.PA.app.boot();
  await settle();
  const ch = channels[0];
  assert.equal(ch.name, 'portal-admin');
  assert.deepEqual(plain(ch.posted), [{ type: 'signed-in' }], 'this tab signed in: the others hear of it');
  // Within two minutes of the end: the bar says when, with Sign in again.
  const bar = box.doc.getElementById('session-bar')!;
  assert.ok(!bar.classList.contains('hidden'));
  assert.match(bar.textContent, /^Your session ends at .+\.Sign in again$/);

  // Another tab signed in again: this one takes the new token.
  token = 'csrf-2';
  const before = box.calls.length;
  ch.onmessage!({ data: { type: 'signed-in' } });
  await settle();
  assert.deepEqual(box.calls.slice(before), ['GET /admin/me']);

  // Back to this tab: is the session still good?
  for (const [type, fn] of box.doc.listeners) if (type === 'visibilitychange') (fn as () => void)();
  await settle();
  assert.equal(box.calls.at(-1), 'GET /admin/me');

  // Another tab signed out.
  ch.onmessage!({ data: { type: 'signed-out' } });
  await settle();
  assert.equal(box.doc.querySelector('.modal')!.querySelector('h2')!.textContent, 'You signed out in another tab.');
  assert.match(bar.textContent, /^You signed out in another tab\./);

  // Sign out here: with the token taken from the other tab's sign-in; the
  // others hear of it, and this admin's conveniences are forgotten.
  box.localStore.setItem('pa.lastTab:' + ME_GWEN.user.id, 'audit');
  box.doc.getElementById('logout-btn')!.click();
  await settle();
  assert.deepEqual(sentWith, ['csrf-2']);
  assert.deepEqual(plain(ch.posted.at(-1)), { type: 'signed-out' });
  assert.equal(box.localStore.getItem('pa.lastTab:' + ME_GWEN.user.id), null);
  assert.ok(!box.doc.getElementById('login')!.classList.contains('hidden'));
});

test('session: with a drawer open the bar is in the drawer, in its Tab cycle; its Sign in again keeps the form', async () => {
  const g = '#/g/' + GA;
  let down = false;
  const box = await panelAt('/' + g + '/invites/new', {
    me: { ...ME_OP, session: { expiresAt: Date.now() + 60_000 } },
    guilds: [{ id: GA, name: 'Guild One' }],
    handle: () => (down ? refuse(401, 'UNAUTHENTICATED', 'login required') : undefined),
  });
  const { doc, nav, sessionStore, drawerOpen } = box;
  assert.ok(drawerOpen());
  const pageBar = doc.getElementById('session-bar')!;
  const bar = doc.getElementById('drawer-session-bar')!;
  // Within two minutes of the end: both copies say when (styles.css shows
  // the drawer's while it is open).
  assert.ok(!bar.classList.contains('hidden'));
  assert.match(bar.textContent, /^Your session ends at .+\.Sign in again$/);
  assert.equal(pageBar.textContent, bar.textContent);
  const signIn = clickable(doc, 'Sign in again', bar);

  // The bar's button is inside the drawer, so Tab reaches it: from ✕ the
  // browser moves on to it, and from it into the form (a control outside the
  // drawer would be pulled back to ✕).
  assert.ok(doc.getElementById('drawer')!.contains(signIn));
  doc.getElementById('drawer-close')!.focus();
  assert.equal(doc.key('Tab').defaultPrevented, false);
  signIn.focus();
  assert.equal(doc.key('Tab').defaultPrevented, false);
  assert.equal(doc.activeElement, signIn);
  assert.equal(doc.key('Tab', { shiftKey: true }).defaultPrevented, false);
  const label = doc.getElementById('drawer-body')!.querySelector('input[name="label"]')!;

  // The session ends while the admin is on the button: the words change, the
  // button (and the focus on it) stays.
  fillMint(doc, 'x', 'g1-readers');
  signIn.focus();
  down = true;
  doc.getElementById('drawer-body')!.querySelector('form')!.fire('submit');
  await settle();
  const modal = doc.querySelector('.modal')!;
  assert.equal(modal.querySelector('h2')!.textContent, 'Your session ended — this change was NOT saved.');
  clickable(doc, 'Close', modal).click();
  await settle();
  assert.equal(doc.querySelector('.modal'), null);
  assert.ok(drawerOpen(), 'the drawer and its form stay');
  assert.equal(label.value, 'x');
  // Closed the modal: the drawer still offers Sign in again, at its top.
  assert.match(bar.textContent, /^Your session ended\.Sign in again$/);
  assert.equal(clickable(doc, 'Sign in again', bar), signIn, 'the same button, so focus on it is not lost');

  // And it keeps the form, as the modal's does — no "Discard changes?".
  signIn.click();
  assert.equal(doc.querySelector('.modal'), null, 'nothing asks to discard the form');
  assert.deepEqual(nav.assigned, ['/admin/login']);
  assert.equal(sessionStore.getItem('pa.returnTo'), g + '/invites/new');
  const draft = JSON.parse(sessionStore.getItem('pa.draft')!);
  assert.equal(draft.form, 'mint');
  assert.equal(draft.fields.label, 'x');
  assert.deepEqual(draft.fields.roles, ['g1-readers']);
  assert.equal(nav.dispatch('beforeunload').defaultPrevented, false);
});

test('ui.expiryBar: shown in both places, words updated in place, hidden in both', () => {
  const { ctx, doc } = sandbox();
  load(ctx, ['ui.js']);
  const { el, expiryBar } = ctx.PA.ui;
  const page = el('div', { id: 'session-bar', class: 'session-bar hidden' });
  doc.body.appendChild(page);
  const dom = drawerDom(doc, el);
  let clicks = 0;
  expiryBar().show('Your session ends at 3:13 PM.', 'Sign in again', () => clicks++);
  for (const host of [page, dom.bar]) {
    assert.ok(!host.classList.contains('hidden'));
    assert.equal(host.textContent, 'Your session ends at 3:13 PM.Sign in again');
  }
  const btn = dom.bar.querySelector('button')!;
  expiryBar().show('Your session ended at 3:13 PM.', 'Sign in again', () => (clicks += 10));
  assert.equal(dom.bar.querySelector('button'), btn, 'the button is kept');
  assert.equal(dom.bar.textContent, 'Your session ended at 3:13 PM.Sign in again');
  btn.click();
  assert.equal(clicks, 10, 'and does what the latest show() asked');
  expiryBar().hide();
  for (const host of [page, dom.bar]) {
    assert.ok(host.classList.contains('hidden'));
    assert.equal(host.textContent, '');
  }
});
