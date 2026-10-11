/** Actual shipped ModelListEditor + real React commits; no act/timer mocking.
 * All settings/RPC are local stubs. Run via test:host-assembly.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.MSC_HOST_MODELS_BUNDLE) throw new Error('MSC_HOST_MODELS_BUNDLE is required');
const req = createRequire(path.join(process.env.MSC_DOM_ENV || path.join(rootPath, 'node_modules'), 'noop.js'));
const { JSDOM } = req('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.fetch = () => assert.fail('network forbidden');
const React = req('react');
const ReactDOM = req('react-dom');
const { createRoot } = req('react-dom/client');
const h = React.createElement;
const t = key => key;
const noop = () => {};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await wait(5); }
  assert.fail(message);
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const Button = ({ children, variant, size, ...rest }) => h('button', rest, children);
const primitives = new Proxy({ Button }, { get: (obj, key) => obj[key] ?? (() => null) });
let loaded;
window.__ModuleLoader__ = { load: value => { loaded = value; } };
const hostSource = fs.readFileSync(process.env.MSC_HOST_MODELS_BUNDLE, 'utf8');
assert.equal(hostSource.split('exports.apply = apply;').length, 2);
new Function('window', hostSource.replace('exports.apply = apply;', 'exports.__test = { ModelListEditor }; exports.apply = apply;'))(window);
const Host = loaded.factory(name => name === 'react' ? React : name === 'react/jsx-runtime' ? req(name) : name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : name === '@deepseek-ai/dsh-client-store' ? {} : assert.fail(name)).__test;
const source = fs.readFileSync(path.join(rootPath, 'client.js'), 'utf8');
assert.equal(source.split('    exports.inject = inject;').length, 2);
new Function('window', source.replace('    exports.inject = inject;', '    exports.__test = { ModelSmartConfigInline, createApi };\n    exports.inject = inject;'))(window);
const Client = loaded.factory(name => name === 'react' ? React : name === 'react-dom' ? ReactDOM : assert.fail(name)).__test;
const spec = { confidence: 'exact', input: ['text', 'image'], sources: { input: 'registry' } };
const explicit = { models: [{ id: 'gpt-4o', input: ['text'] }] };
const operations = { discoverModels: async () => ({ kind: 'found', models: [] }) };
function mount(overrides = {}) {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  let current;
  const api = { readConfig: async () => ({ enabled: true }), readProvider: async () => ({ profile: {} }), infer: async () => spec, authoritative: async () => ({ found: true, source: 'resolved-config', inputModalities: ['text'] }), probe: () => assert.fail('probe forbidden'), ...overrides };
  function View({ route, opened = true }) {
    const [models, setModels] = React.useState(structuredClone(explicit.models)); current = models;
    const provider = React.useMemo(() => ({ provider: route, settingsNs: 'llm-pi-ai' }), [route]);
    return h('ul', null, h('li', null,
      h(Client.ModelSmartConfigInline, { provider, api, t }),
      opened && h('details', { open: true }, h(Host.ModelListEditor, { models, onChange: setModels, probe: { settingsNs: 'llm-pi-ai', provider: route }, operations, t, disabled: false, onBusyChange: noop, modelQuery: '', onModelQueryChange: noop }))));
  }
  const render = (route, opened = true) => root.render(h(View, { route, opened })); render('route-a');
  return { container, render,
    button: () => container.querySelector('[data-msc-row] button[aria-label="inlineMatch"]'),
    image: () => current?.[0].input.includes('image'),
    notes: () => container.textContent,
    close: () => { root.unmount(); container.remove(); },
  };
}
async function ready(view) { await until(() => view.button(), 'match button missing'); }
async function matchDone(view, expectedNote) {
  view.button().click();
  await until(() => view.notes().includes(expectedNote) && view.button()?.textContent === 'inlineMatch', expectedNote + ' missing').catch(error => {
    console.error(JSON.stringify({ notes: view.notes(), image: view.image(), button: view.button()?.outerHTML }));
    throw error;
  });
}
const views = [];
function track(overrides) { const view = mount(overrides); views.push(view); return view; }
try {
  await assert.rejects(Client.createApi({ remote: { settings: { describe: async () => ({ ok: false }) } }, get: () => ({}) }).readConfig(), /settings.describe failed/);
  console.log('PASS failed settings transport is not an empty successful config');

  let view = track({ readProvider: async () => ({ profile: explicit }) });
  await ready(view); await matchDone(view, 'inlineModalityOverridden'); assert.equal(view.image(), true); view.close();
  console.log('PASS explicit click applies the rules table over the saved text declaration');

  const pending = deferred();
  view = track({ readProvider: () => pending.promise });
  await ready(view); view.button().click();
  await until(() => view.notes().includes('inlineLoadingSettings'), 'waiting feedback missing');
  assert.equal(view.image(), false); assert.equal(view.container.querySelector('[aria-label="probe"]'), null);
  pending.resolve({ profile: explicit });
  await until(() => view.notes().includes('inlineModalityOverridden'), 'late declaration not respected');
  assert.equal(view.image(), true); view.close();
  console.log('PASS pending provider read waits and applies the late explicit declaration');

  let recover = false;
  view = track({ readProvider: () => recover ? Promise.resolve({ profile: {} }) : Promise.reject(new Error('stub read failure')) });
  await ready(view); await matchDone(view, 'inlineSettingsFailed'); assert.equal(view.image(), false);
  recover = true; await matchDone(view, 'inlineMatched'); assert.equal(view.image(), true); view.close();
  console.log('PASS failed provider read never writes and click retries successfully');

  const config = deferred();
  view = track({ readConfig: () => config.promise });
  await ready(view); view.button().click();
  await until(() => view.notes().includes('inlineLoadingSettings'), 'config waiting feedback missing');
  assert.equal(view.image(), false); config.resolve({ enabled: false });
  await until(() => view.notes().includes('inlineSettingsDisabled'), 'disabled configuration ignored');
  assert.equal(view.image(), false); assert.equal(view.button().disabled, true); view.close();
  console.log('PASS pending plugin configuration respects enabled=false before any fill');

  view = track({ readConfig: () => Promise.reject(new Error('stub config failure')) });
  await ready(view); await matchDone(view, 'inlineSettingsFailed'); assert.equal(view.image(), false); view.close();
  console.log('PASS rejected plugin config does not fall back to enabled defaults');

  const routeB = deferred(); let readB = false;
  view = track({ readProvider: route => route === 'route-a' ? Promise.resolve({ profile: {} }) : (readB = true, routeB.promise) });
  await ready(view); await until(() => view.container.querySelector('[aria-label="probe"]'), 'initial settings not ready');
  view.render('route-b'); await until(() => readB, 'new route not read');
  await ready(view); view.button().click();
  await until(() => view.notes().includes('inlineLoadingSettings'), 'new route reused old readiness');
  assert.equal(view.image(), false); routeB.resolve({ profile: explicit });
  await until(() => view.notes().includes('inlineModalityOverridden'), 'route-b explicit declaration lost');
  assert.equal(view.image(), true); view.close();
  console.log('PASS route change cannot reuse prior readiness or profile');

  const oldRead = deferred();
  view = track({ readProvider: route => route === 'route-a' ? oldRead.promise : Promise.resolve({ profile: {} }) });
  await ready(view); view.button().click(); await until(() => view.notes().includes('inlineLoadingSettings'), 'old route wait missing');
  view.render('route-b'); await until(() => view.button() && !view.button().disabled && view.container.querySelector('[aria-label="probe"]'), 'old busy state blocked new route');
  await matchDone(view, 'inlineMatched'); assert.equal(view.image(), true);
  oldRead.resolve({ profile: explicit }); await wait(30); assert.equal(view.image(), true); view.close();
  console.log('PASS stale route read neither blocks nor modifies the new route');
  view = mount({ readProvider: async () => ({ profile: { models: [{ id: 'gpt-4o' }] } }) }); views.push(view);
  await ready(view);
  let box = view.container.querySelector('.dshModelModalityToggleCompact input');
  box.click(); await until(() => view.image(), 'image check not committed');
  box.click(); await until(() => !view.image(), 'explicit text not committed');
  await matchDone(view, 'inlineModalityConflict');
  const details = view.container.querySelector('details'); details.open = false;
  await until(() => !view.button(), 'collapsed controls retained');
  details.open = true; await ready(view); await matchDone(view, 'inlineModalityConflict');
  assert.equal(view.image(), false); view.close();
  console.log('PASS unsaved explicit text survives collapse and reopen');

  let stored = { models: [{ id: 'gpt-4o' }] }; let reads = 0;
  view = mount({ readProvider: async () => { reads++; return { profile: structuredClone(stored) }; } }); views.push(view);
  await ready(view); await until(() => reads > 0, 'initial profile not read');
  stored = { models: [{ id: 'gpt-4o', input: ['text'] }] };
  view.render('route-a', false); await until(() => !view.button(), 'editor not closed');
  view.render('route-a', true); await ready(view); await matchDone(view, 'inlineModalityOverridden');
  assert.ok(reads >= 2, 'match must refresh after official save/re-edit');
  assert.equal(view.image(), true); view.close();
  console.log('PASS new editor session reads saved declarations instead of a stale profile');
} finally {
  for (const view of views) { if (view.container.isConnected) view.close(); }
  dom.window.close();
}
console.log('PASS readiness regression: actual shipped ModelListEditor, real React, no act/timer mocking, no network or persistence');
