/** Opt-in assembly against an extracted, unmodified shipped DSH client bundle.
 * MSC_HOST_MODELS_BUNDLE=/path/to/client.js MSC_DOM_ENV=/path/to/node_modules node test/host-assembly.test.mjs
 * Only UI primitives, RPC, and persistence are mocked. No external I/O occurs.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.MSC_HOST_MODELS_BUNDLE) { console.error('MSC_HOST_MODELS_BUNDLE must name the extracted shipped settings-models client bundle'); process.exit(2); }
const req = createRequire(path.join(process.env.MSC_DOM_ENV || path.join(rootPath, 'node_modules'), 'noop.js'));
const { JSDOM } = req('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const React = req('react');
const ReactDOM = req('react-dom');
const { createRoot } = req('react-dom/client');
const { act } = React;
const h = React.createElement;
const Button = ({ children, variant, size, ...rest }) => h('button', rest, children);
const Modal = ({ open, children, footer }) => open ? h('div', { role: 'dialog' }, children, footer) : null;
const Checkbox = ({ checked, disabled, label, onChange }) => h('label', null, h('input', { type: 'checkbox', checked, disabled, onChange: e => onChange(e.target.checked) }), label);
const primitives = new Proxy({ Button, Modal, Checkbox }, { get: (obj, key) => obj[key] ?? (() => null) });
let loaded;
window.__ModuleLoader__ = { load: spec => { loaded = spec; } };
const hostSource = fs.readFileSync(process.env.MSC_HOST_MODELS_BUNDLE, 'utf8');
assert.equal(hostSource.split('exports.apply = apply;').length, 2);
new Function('window', hostSource.replace('exports.apply = apply;', 'exports.__test = { ModelsSection, ModelListEditor }; exports.apply = apply;'))(window);
const host = loaded.factory(name => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return req(name);
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  if (name === '@deepseek-ai/dsh-client-store') return {};
  throw new Error('unexpected host import: ' + name);
}).__test;
// Keep real React commits between plugin macrotasks. A long async act that
// sleeps batches checkbox verification + expansion together and is not a browser turn.
const pluginTimers = new Map();
let timerId = 0;
function schedulePluginTimer(fn, delay = 0) { const id = ++timerId; pluginTimers.set(id, { fn, delay }); return id; }
function clearPluginTimer(id) { pluginTimers.delete(id); }
new Function('window', 'setTimeout', 'clearTimeout', fs.readFileSync(path.join(rootPath, 'client.js'), 'utf8'))(window, schedulePluginTimer, clearPluginTimer);
const plugin = loaded.factory(name => name === 'react' ? React : name === 'react-dom' ? ReactDOM : assert.fail(name));
const rpcCalls = [];
const effects = [];
const registrations = new Map();
plugin.apply({
  effect(fn) { effects.push(fn()); },
  locale: { register: () => () => {} },
  slots: {
    inject: (_key, fn) => fn().next(),
    register(options, component) { registrations.set(options.name, { options, component }); return () => {}; },
  },
  remote: { settings: {
    describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'model-smart-config', value: { enabled: true } }] } }),
    mutate: async () => assert.fail('plugin cannot persist'),
  } },
  get: name => {
    assert.equal(name, 'connection');
    return { rpc: { call: async (_channel, method) => {
      rpcCalls.push(method);
      assert.equal(method, 'msc/infer', 'unsaved draft cannot request authority or probe');
      return { ok: true, value: { confidence: 'exact', vendor: 'openai', input: ['text', 'image'], contextWindow: 128000, maxTokens: 16384, reasoningEfforts: false, sources: { input: 'registry', contextWindow: 'registry', maxTokens: 'registry', reasoningEfforts: 'registry' }, warnings: [] } };
    } } };
  },
});
const t = key => key;
const discovers = [];
const writes = [];
const operations = {
  discoverModels: async (ns, params) => { discovers.push({ ns, params }); return { kind: 'found', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] }; },
  writeSettings: async (...args) => { writes.push(structuredClone(args)); return { kind: 'written' }; },
  storeCredential: async () => assert.fail('test never enters or stores a credential'),
};
const namespace = { ns: 'llm-pi-ai', revision: 1, schema: {}, value: { providers: {} } };
const snapshot = { status: 'ready', error: null, writable: true, rows: [], namespaces: new Map([['llm-pi-ai', namespace]]) };
const schema = { rehydrate: x => x, nodeAtPath: () => ({ type: 'union', list: [{ value: 'openai-completions' }] }) };
const slotCalls = [];
const renderSlot = (name, props, options) => {
  slotCalls.push({ name, options });
  const entry = registrations.get(name);
  const eligible = entry && (entry.options.key === undefined || options?.entryKey === entry.options.key);
  // Exact shipped renderer contract: SlotOutlet -> div[data-slot] display:contents.
  return h('div', { 'data-slot': name, style: { display: 'contents' } }, eligible ? h(entry.component, { ...entry.options.inject(), ...props, t }) : null);
};
const container = document.createElement('div'); document.body.append(container);
const root = createRoot(container);
async function settle(fn = () => {}) {
  await act(async () => { await fn(); });
  for (let turn = 0; turn < 8; turn++) {
    const ready = [...pluginTimers].filter(([, timer]) => timer.delay === 0);
    if (ready.length === 0) return;
    await act(async () => {
      for (const [id, timer] of ready) { pluginTimers.delete(id); timer.fn(); }
      await Promise.resolve();
    });
  }
  assert.fail('plugin did not settle within eight explicit macrotask phases');
}
function button(text, scope = container) {
  const result = [...scope.querySelectorAll('button')].find(el => el.textContent === text);
  assert.ok(result, `missing button ${text}`); return result;
}
async function type(label, value) {
  const input = container.querySelector(`[aria-label="${label}"]`); assert.ok(input, label);
  await settle(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function addCustom(route) {
  await settle(() => button('add').click());
  await type('customRoute', route);
  await type('baseUrl', 'https://review.invalid/v1');
  await settle(() => button('fetchModels').click());
  await settle(() => button('fetchAdopt').click());
  const panel = container.querySelector('[id$="-custom-panel"]');
  assert.ok(panel);
  assert.equal(panel.querySelectorAll('[data-msc-row]').length, 1, 'enhance model in the actual custom form');
  assert.equal(panel.querySelectorAll('details').length, 0);
  assert.equal(slotCalls.filter(call => call.name === 'settings.models.provider-card').length, 0);
  return panel;
}
await settle(() => root.render(h(host.ModelsSection, { controller: { load: async () => {} }, useSnapshot: fn => fn(snapshot), operations, schema, t, renderSlot })));
let panel = await addCustom('review-gateway');
assert.equal(writes.length, 0);
assert.equal(discovers[0].params.baseURL, 'https://review.invalid/v1');
await settle(() => button('inlineMatch', panel).click());
assert.equal(panel.querySelector('input[aria-label="modelContextWindow 1"]').value, '128K');
assert.equal(panel.querySelector('input[aria-label="modelMaxTokens 1"]').value, '16384');
assert.equal(panel.querySelector('input[type="checkbox"]').checked, true);
await type('modelName 1', 'User keeps editing');
assert.equal(panel.querySelector('input[aria-label="modelContextWindow 1"]').value, '128K', 'host rerender retains draft state');
assert.equal(writes.length, 0, 'matching updates draft, not persistence');
await settle(() => button('create').click());
assert.equal(writes.length, 1, 'only official create persists');
assert.equal(writes[0][0], 'llm-pi-ai');
assert.equal(writes[0][2], 1, 'official expected revision retained');
const saved = writes[0][1][0].value.models[0];
assert.equal(saved.contextWindow, 128000);
assert.equal(saved.maxTokens, 16384);
assert.ok(saved.input.includes('image'));
assert.equal(saved.name, 'User keeps editing');
assert.equal(container.querySelector('[id$="-custom-panel"]'), null);
assert.equal(container.querySelector('[data-msc-row]'), null);
console.log('PASS actual ModelsSection: new API → fetch/adopt → match → retained draft → official save');
for (let i = 0; i < 2; i++) {
  panel = await addCustom('cancelled-' + i);
  assert.equal(panel.querySelectorAll('[data-msc-row]').length, 1);
  await settle(() => button('inlineMatch', panel).click());
  await settle(() => button('cancel', panel).click());
  assert.equal(container.querySelector('[data-msc-row]'), null);
  assert.equal(writes.length, 1, 'cancel never persists draft');
}
await settle(() => button('add').click());
assert.equal(container.querySelectorAll('[data-msc-row]').length, 0, 'reopening starts an empty draft');
assert.equal(container.querySelector('input[aria-label="customRoute"]').value, '');
await settle(() => root.unmount());
for (const dispose of effects) dispose?.();
dom.window.close();
console.log('PASS actual ModelsSection: cancel / repeated reopen / no duplicate portals; all I/O stubbed');
