/** Plugin-only custom-draft assembly: no provider-card, no details, no real I/O. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(process.env.MSC_DOM_ENV || path.join(root, 'node_modules'), 'noop.js'));
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const observations = [];
class TrackedObserver extends dom.window.MutationObserver {
  observe(target, options) { this.target = target; this.disposed = false; observations.push(this); super.observe(target, options); }
  disconnect() { this.disposed = true; super.disconnect(); }
}
globalThis.MutationObserver = TrackedObserver;
const React = require('react');
const ReactDOM = require('react-dom');
const { createRoot } = require('react-dom/client');
const { act } = React;
let loaded;
window.__ModuleLoader__ = { load: spec => { loaded = spec; } };
new Function('window', readFileSync(path.join(root, 'client.js'), 'utf8'))(window);
const plugin = loaded.factory(name => name === 'react' ? React : name === 'react-dom' ? ReactDOM : assert.fail(name));
const entries = new Map();
const disposers = [];
const calls = { infer: [], authoritative: 0, probe: 0, settings: 0, mutate: 0 };
let pending = null;
let deferNext = false;
const spec = { confidence: 'exact', vendor: 'openai', input: ['text', 'image'], contextWindow: 128000, maxTokens: 16384, reasoningEfforts: false, sources: { input: 'registry', contextWindow: 'registry', maxTokens: 'registry', reasoningEfforts: 'registry' }, warnings: [] };
plugin.apply({
  effect(fn) { disposers.push(fn()); },
  locale: { register: () => () => {} },
  slots: {
    inject: (_name, fn) => fn().next(),
    register(options, component) { entries.set(options.name, { options, component }); return () => {}; },
  },
  remote: { settings: {
    describe: async () => { calls.settings++; return { ok: true, value: { namespaces: [{ ns: 'model-smart-config', value: { enabled: true } }] } }; },
    mutate: async () => { calls.mutate++; assert.fail('draft must not persist'); },
  } },
  get: () => ({ rpc: { call: async (_channel, method, request) => {
    if (method === 'msc/infer') {
      calls.infer.push(request);
      if (deferNext) { deferNext = false; await new Promise(resolve => { pending = resolve; }); }
      return { ok: true, value: spec };
    }
    if (method === 'msc/authoritative') calls.authoritative++;
    if (method === 'msc/probe') calls.probe++;
    assert.fail('draft must not call ' + method);
  } } }),
});
assert.equal(entries.size, 2);
const entry = entries.get('settings.models.footer');
assert.ok(entry, 'footer registration must exist independently of provider-card');
assert.equal(entry.options.id, 'model-smart-config-custom-draft');
const h = React.createElement;
const t = key => key;
const doc = document;
function rowHtml(id = 'gpt-4o') {
  return `<div class="modelEntry"><div class="modelRow" style="grid-template-columns: 1fr 1fr auto auto">
    <input type="text" value="${id}"><input type="text" value="">
    <label class="dshModelModalityToggleCompact"><input type="checkbox"></label>
    <button aria-expanded="true"></button><button class="remove"></button></div>
    <div class="advanced"><label><input type="text" value="" placeholder="256K"></label>
    <label><input type="text" value="" placeholder="32K"></label>
    <div class="dshModelReasoningField"><input type="text" value="" placeholder="low, high"></div></div></div>`;
}
function makeDraft(section, prefix = 'new') {
  const block = doc.createElement('div');
  block.innerHTML = `<div><div id="${prefix}-custom-panel"><div class="models"></div></div></div>`;
  section.insertBefore(block, section.lastElementChild);
  return block.querySelector('[id$="-custom-panel"]');
}
function addModel(panel, id) {
  panel.querySelector('.models').insertAdjacentHTML('beforeend', rowHtml(id));
  return panel.querySelector('.modelRow:last-of-type') || panel.querySelector('.modelRow');
}
function match(panel) {
  const button = [...panel.querySelectorAll('[data-msc-row] button')].find(el => el.textContent.includes('inlineMatch'));
  assert.ok(button, 'match button must be present');
  button.click();
}
async function flush(fn = () => {}) {
  await act(async () => { fn(); await new Promise(resolve => setTimeout(resolve, 15)); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
}
const section = doc.createElement('section');
section.innerHTML = `<ul><li><details open>${rowHtml('saved-model')}</details></li></ul><div data-slot="settings.models.footer"></div>`;
doc.body.appendChild(section);
const foreign = doc.createElement('section');
foreign.innerHTML = '<div></div>';
doc.body.appendChild(foreign);
const foreignPanel = makeDraft(foreign, 'foreign');
addModel(foreignPanel, 'gpt-4o');
const app = createRoot(section.lastElementChild);
await flush(() => app.render(h(entry.component, { ...entry.options.inject(), t })));
assert.equal(calls.infer.length, 0, 'closed add form makes no inference calls');
let panel;
await flush(() => { panel = makeDraft(section); });
assert.equal(panel.querySelectorAll('[data-msc-row]').length, 0);
await flush(() => addModel(panel, 'gpt-4o'));
assert.equal(panel.querySelectorAll('[data-msc-row]').length, 1, 'new custom model is enhanced immediately without details');
assert.equal(calls.authoritative, 0);
assert.equal(calls.settings, 1, 'only own plugin config read, no invented provider profile lookup');
assert.equal(section.querySelector('li [data-msc-row]'), null, 'saved providers are outside footer ownership');
assert.equal(foreign.querySelector('[data-msc-row]'), null, 'another section is outside ownership');
assert.equal(panel.querySelector('input[type="checkbox"]').checked, false, 'read-only discovery never fills');
await flush(() => match(panel));
assert.equal(panel.querySelector('input[type="checkbox"]').checked, true);
assert.equal(panel.querySelector('.advanced input').value, '128K');
assert.equal(calls.mutate, 0);
assert.equal(calls.probe, 0);
assert.equal(panel.querySelector('button[title="probe"]'), null, 'draft never exposes probe');
console.log('PASS immediate custom model / manual fill / no premature save / no provider lookup');

await flush(() => panel.querySelector('input[type="checkbox"]').click());
assert.equal(panel.querySelector('input[type="checkbox"]').checked, false, 'explicit draft text choice');
await flush(() => { panel.hidden = true; });
assert.equal(panel.querySelectorAll('[data-msc-row]').length, 0, 'switching away unmounts row portals');
assert.equal(panel.querySelector('.modelRow').style.gridTemplateColumns, '1fr 1fr auto auto', 'unmount restores the host grid');
await flush(() => { panel.hidden = false; });
assert.equal(panel.querySelectorAll('[data-msc-row]').length, 1, 'returning mounts once');
await flush(() => match(panel));
assert.equal(panel.querySelector('input[type="checkbox"]').checked, false, 'tab return preserves explicit choice');
assert.ok(panel.textContent.includes('inlineModalityConflict'));
let ambiguous;
await flush(() => { ambiguous = makeDraft(section, 'ambiguous'); addModel(ambiguous); });
assert.equal(section.querySelectorAll('[data-msc-row]').length, 0, 'multiple live custom panels fail closed');
await flush(() => ambiguous.parentElement.parentElement.remove());
assert.equal(panel.querySelectorAll('[data-msc-row]').length, 1);
console.log('PASS mode switch / exact section ownership / ambiguous-root rejection');

// An in-flight explicit match must not affect a cancelled or replacement draft.
deferNext = true;
await flush(() => match(panel));
assert.equal(typeof pending, 'function');
const oldPanel = panel;
await flush(() => {
  oldPanel.parentElement.parentElement.remove();
  panel = makeDraft(section, 'replacement');
  addModel(panel, 'gpt-4o');
});
await flush(() => pending());
assert.equal(panel.querySelector('.advanced input').value, '', 'late match cannot fill the next draft');
assert.equal(panel.querySelector('input[type="checkbox"]').checked, false);
assert.equal(oldPanel.querySelectorAll('[data-msc-row]').length, 0, 'cancel cleanup removes detached portals too');
await flush(() => match(panel));
assert.equal(panel.querySelector('input[type="checkbox"]').checked, true, 'new draft never inherits cancelled touch protection');
for (let i = 0; i < 3; i++) {
  await flush(() => panel.parentElement.parentElement.remove());
  await flush(() => { panel = makeDraft(section, 'repeat-' + i); addModel(panel, 'gpt-4o'); });
  assert.equal(panel.querySelectorAll('[data-msc-row]').length, 1, 'reopening never duplicates buttons');
}
console.log('PASS stale async cancellation / repeated reopen');
await flush(() => app.unmount());
assert.equal(section.querySelectorAll('[data-msc-row]').length, 0);
assert.ok(observations.length > 0);
assert.ok(observations.every(observer => observer.target !== doc.body && observer.target !== doc.documentElement));
assert.ok(observations.every(observer => observer.disposed), 'every observer disconnected on unmount');
assert.equal(calls.authoritative + calls.probe + calls.mutate, 0);
for (const dispose of disposers) dispose?.();
dom.window.close();
console.log('PASS footer lifecycle regression suite; all API and configuration writes stubbed');
