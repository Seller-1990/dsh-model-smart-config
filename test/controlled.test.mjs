/** Real React controlled drafts around unchanged client helper bodies; no DSH I/O. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(process.env.MSC_DOM_ENV || path.join(root, 'node_modules'), 'noop.js'));
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
// ReactDOM must load after the browser environment, so its onChange support is real.
const React = require('react');
const ReactDOM = require('react-dom');
const { createRoot } = require('react-dom/client');
const { act } = React;
const h = React.createElement;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const source = readFileSync(path.join(root, 'client.js'), 'utf8');
const seam = '    exports.inject = inject;';
assert.equal(source.split(seam).length, 2, 'unique test-only export seam');
const instrumented = source.replace(seam, `    exports.__test = { combine, canApplySpec, fillOfficialRow, savedModelInput };\n${seam}`);
let loader;
window.__ModuleLoader__ = { load: (value) => { loader = value; } };
new Function('window', instrumented)(window);
const api = loader.factory((id) => id === 'react' ? React : id === 'react-dom' ? ReactDOM : assert.fail(id)).__test;

const rule = {
  confidence: 'exact', input: ['text', 'image'], contextWindow: 200000, maxTokens: 64000,
  reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
  sources: { input: 'registry', contextWindow: 'registry', maxTokens: 'registry', reasoningEfforts: 'registry' },
};
const unknown = { confidence: 'none', contextWindow: 262144, maxTokens: 32768, input: ['text'], sources: { input: 'registry', contextWindow: 'registry', maxTokens: 'registry' } };
const effective = { found: true, contextWindow: 999, defaultMaxTokens: 111, inputModalities: ['text'], reasoningEfforts: false };

test('only explicit catalog provenance supplements recommendations', () => {
  for (const source of [undefined, 'resolved-config', 'provider-name-guess']) {
    const combined = api.combine(rule, { ...effective, source });
    assert.deepEqual(combined.input, ['text', 'image']);
    assert.equal(combined.contextWindow, 200000);
    assert.deepEqual(combined.reasoningEfforts, rule.reasoningEfforts);
    assert.equal(combined.sources.input, 'registry');
    assert.equal(api.canApplySpec(api.combine(unknown, { ...effective, source })), false);
  }
  const combined = api.combine(rule, { ...effective, source: 'catalog' });
  assert.equal(combined.contextWindow, 999);
  assert.deepEqual(combined.input, ['text', 'image'], 'public modality rules keep precedence');
  const supplement = api.combine(unknown, { ...effective, source: 'catalog', inputModalities: ['text', 'image'] });
  assert.equal(supplement.confidence, 'catalog');
  assert.equal(api.canApplySpec(supplement), true);
  assert.equal(supplement.sources.input, 'authoritative');
  assert.deepEqual(supplement.input, ['text', 'image']);
  const heuristic = api.combine({ confidence: 'pattern', input: ['text'], sources: { input: 'heuristic' } }, { found: true, source: 'catalog', inputModalities: ['text', 'image'] });
  assert.deepEqual(heuristic.input, ['text', 'image'], 'heuristics cannot mask catalog evidence');
  const noEvidence = api.combine(unknown, { found: true, source: 'catalog' });
  assert.equal(api.canApplySpec(noEvidence), false);
  assert.equal(noEvidence.contextWindow, undefined);
  assert.equal(noEvidence.input, undefined);
});

test('only saved per-model input declarations count as explicit intent', () => {
  assert.equal(api.savedModelInput({ defaultInput: ['text'], models: [{ id: 'm' }] }, 'm'), undefined);
  assert.deepEqual(api.savedModelInput({ models: [{ id: 'm', input: ['text'] }] }, 'm'), ['text']);
  assert.deepEqual(api.savedModelInput({ modelOverrides: { m: { input: ['text', 'image'] } } }, 'm'), ['text', 'image']);
});

async function mount(options = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const view = { container, draft: undefined, saved: undefined, changes: 0 };
  function Editor() {
    const [draft, setDraft] = React.useState({ id: 'm', ...options.initial });
    const [expanded, setExpanded] = React.useState(false);
    const [, setRevision] = React.useState(0);
    view.draft = draft;
    const patch = (field, value) => setDraft((old) => ({ ...old, [field]: value }));
    const input = (field, placeholder) => h('input', {
      type: 'text', 'aria-label': field, placeholder, value: draft[field] || '',
      disabled: options.disabledFields, readOnly: options.readOnlyFields,
      onChange: (event) => patch(field, event.target.value),
    });
    return h('div', { className: 'modelEntry' },
      h('div', { className: 'modelRow' },
        input('id', 'modelId'), input('name', 'modelName'),
        !options.missingCheckbox && h('label', { className: 'dshModelModalityToggleCompact' },
          h('input', { type: 'checkbox', checked: (draft.input || []).includes('image'), disabled: options.disabledCheckbox,
            onChange: (event) => {
              view.changes += 1;
              if (!options.rejectCheckbox) patch('input', event.target.checked ? ['text', 'image'] : ['text']);
              options.onCheckbox?.();
            },
          })),
        h('button', { 'aria-expanded': expanded, onClick: () => setExpanded(!expanded) }, 'expand')),
      expanded && h('div', { className: 'modelAdvanced' },
        input('contextWindow', '256K'), input('maxTokens', '32K'),
        h('div', { className: 'dshModelReasoningField' }, input('reasoning', 'low, high'))),
      h('button', { 'data-save': true, onClick: () => { view.saved = structuredClone(draft); } }, 'save'),
      h('button', { 'data-rerender': true, onClick: () => setRevision((old) => old + 1) }, 'rerender'));
  }
  await act(async () => root.render(h(Editor)));
  view.row = container.querySelector('.modelRow');
  view.box = container.querySelector('input[type="checkbox"]');
  view.apply = async (spec = rule, config = {}, settings = {}) => {
    let pending;
    // Separate task turns let React settle checkbox and advanced-panel state
    // before the plugin's own zero-delay re-read, just like native user events.
    act(() => { pending = api.fillOfficialRow(view.row, spec, config, (key) => key, { force: true, ...settings }); });
    await act(async () => { await tick(); });
    await act(async () => { await tick(); });
    return pending;
  };
  view.click = async (selector) => { await act(async () => container.querySelector(selector).click()); };
  view.dispose = async () => { await act(async () => root.unmount()); container.remove(); };
  return view;
}

test('image/context/reasoning changes survive real React rerender and host save', async () => {
  const view = await mount();
  try {
    const outcome = await view.apply(api.combine(rule, { ...effective, source: 'resolved-config' }));
    assert.deepEqual(outcome.problems, []);
    assert.deepEqual(new Set(outcome.applied), new Set(['input', 'contextWindow', 'maxTokens', 'reasoningEfforts']));
    assert.equal(view.changes, 1);
    assert.deepEqual(view.draft.input, ['text', 'image']);
    assert.equal(view.draft.contextWindow, '200K');
    assert.equal(view.draft.reasoning, 'low, medium, high');
    await view.click('[data-rerender]');
    assert.equal(view.box.checked, true);
    await view.click('[data-save]');
    assert.deepEqual(view.saved.input, ['text', 'image']);
    assert.equal(view.saved.maxTokens, '64K');
    assert.equal(view.saved.contextWindow, '200K');
    assert.equal(view.saved.reasoning, 'low, medium, high');
  } finally { await view.dispose(); }
});

test('explicit click applies the rules table over a saved text declaration', async () => {
  const view = await mount({ initial: { input: ['text'] } });
  try {
    const outcome = await view.apply(rule, {}, { savedInput: ['text'] });
    assert.equal(view.box.checked, true, 'explicit click overrides the saved text declaration');
    assert.ok(outcome.applied.includes('input'));
    assert.ok(!outcome.problems.includes('inlineModalityConflict'));
    assert.equal(outcome.modality, 'overridden-declared');
    assert.deepEqual(view.draft.input, ['text', 'image']);
    assert.equal(view.draft.contextWindow, '200K');
  } finally { await view.dispose(); }
});

test('a manual toggle made in this session still beats the explicit click', async () => {
  const view = await mount();
  try {
    const settings = { touched: new Set([view.box]) };
    for (let i = 0; i < 2; i += 1) {
      const outcome = await view.apply(rule, {}, settings);
      assert.equal(view.box.checked, false);
      assert.equal(view.changes, 0);
      assert.ok(outcome.problems.includes('inlineModalityConflict'));
      assert.ok(!outcome.applied.includes('input'));
      assert.equal(outcome.modality, 'kept-manual');
    }
    assert.equal(view.draft.contextWindow, '200K', 'other fields may still refresh');
    await view.click('input[type="checkbox"]');
    const outcome = await view.apply(rule, {}, settings);
    assert.equal(view.box.checked, true);
    assert.equal(outcome.modality, 'already', 'manual confirmation releases the conflict');
    assert.ok(!outcome.problems.includes('inlineModalityConflict'));
  } finally { await view.dispose(); }
});

test('explicit click also removes a saved image declaration when the rules say text-only', async () => {
  const view = await mount({ initial: { input: ['text', 'image'] } });
  try {
    const outcome = await view.apply({ ...rule, input: ['text'] }, {}, { savedInput: ['text', 'image'] });
    assert.equal(view.box.checked, false, 'explicit click follows the rules table');
    assert.ok(outcome.applied.includes('input'));
    assert.equal(outcome.modality, 'overridden-declared');
    assert.ok(!outcome.problems.includes('inlineModalityConflict'));
  } finally { await view.dispose(); }
});

test('an already-correct checkbox is reported, not claimed as applied', async () => {
  const view = await mount({ initial: { input: ['text', 'image'] } });
  try {
    const outcome = await view.apply(rule, {}, {});
    assert.equal(outcome.modality, 'already');
    assert.equal(view.box.checked, true);
    assert.equal(view.changes, 0, 'nothing to click when the box already matches');
    assert.ok(!outcome.applied.includes('input'), 'the modality is not claimed when nothing changed');
  } finally { await view.dispose(); }
});

test('a non-writable modality source lands on an explicit click and is reported', async () => {
  const view = await mount();
  try {
    const spec = { ...rule, sources: { ...rule.sources, input: 'heuristic' } };
    const outcome = await view.apply(spec, {}, {});
    assert.equal(outcome.modality, 'applied-candidate');
    assert.equal(view.box.checked, true);
    assert.ok(outcome.applied.includes('input'));
    const again = await view.apply(spec, {}, {});
    assert.equal(again.modality, 'already');
  } finally { await view.dispose(); }
});

test('a model with no modality answer says so and leaves the checkbox alone', async () => {
  const view = await mount();
  try {
    const outcome = await view.apply({ ...rule, input: undefined, sources: { ...rule.sources, input: 'unknown' } }, {}, {});
    assert.equal(outcome.modality, 'no-suggestion');
    assert.equal(view.box.checked, false);
    assert.equal(view.changes, 0);
    assert.ok(!outcome.problems.includes('inlineModalityConflict'));
  } finally { await view.dispose(); }
});

test('disabled, missing and React-rejected checkbox writes never claim success', async () => {
  for (const [options, problem] of [[{ disabledCheckbox: true }, 'inlineModalityDisabled'], [{ missingCheckbox: true }, 'inlineNoModality'], [{ rejectCheckbox: true }, 'inlineModalityRejected']]) {
    const view = await mount(options);
    try {
      const outcome = await view.apply();
      assert.ok(!outcome.applied.includes('input'));
      assert.ok(outcome.problems.includes(problem), `${problem}: ${JSON.stringify(outcome)}`);
      assert.equal((view.draft.input || []).includes('image'), false);
    } finally { await view.dispose(); }
  }
});

test('disabled/readonly fields and disabled modality permission do not count as applied', async () => {
  for (const option of ['disabledFields', 'readOnlyFields']) {
    const view = await mount({ [option]: true });
    try {
      const outcome = await view.apply(rule, { autoApplyModality: false });
      assert.deepEqual(outcome.applied, []);
      assert.equal(outcome.problems.length, 3);
      assert.ok(outcome.problems.every((item) => item === 'inlineFieldDisabled'));
      assert.equal(view.changes, 0);
    } finally { await view.dispose(); }
  }
});

test('lifetime gates prevent stale initial and post-checkbox advanced writes', async () => {
  let current = false;
  const view = await mount({ onCheckbox: () => { current = false; } });
  try {
    const first = await view.apply(rule, {}, { isCurrent: () => current });
    assert.deepEqual(first.applied, []);
    assert.equal(view.changes, 0);
    current = true;
    const second = await view.apply(rule, {}, { isCurrent: () => current });
    assert.deepEqual(second.applied, []);
    assert.equal(view.draft.contextWindow, undefined);
    assert.equal(view.container.querySelector('.modelAdvanced'), null);
  } finally { await view.dispose(); }
});

test.after(() => dom.window.close());
