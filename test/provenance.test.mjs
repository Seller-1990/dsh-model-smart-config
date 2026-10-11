import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSpec } from '../rules/match.js';
import { toModelFields } from '../rules/infer.js';

function fields(name, options = {}) {
  const result = resolveSpec(name, options);
  return toModelFields(result.spec, { normalizedName: result.normalized });
}

test('unknown model defaults are not writable model capabilities', () => {
  const result = fields('unknown-capacity-regression');
  for (const key of ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts']) {
    assert.equal(result[key], undefined, key);
    assert.equal(result.sources[key], 'unknown', key);
  }
});

test('reasoning respects per-field unknown provenance including false', () => {
  for (const reasoningEfforts of [false, { off: null, high: 'high' }]) {
    const spec = { reasoningEfforts, fieldSources: { reasoningEfforts: 'unknown' } };
    assert.equal(toModelFields(spec).reasoningEfforts, undefined);
    assert.equal(toModelFields(spec).sources.reasoningEfforts, 'unknown');
    spec.fieldSources.reasoningEfforts = 'registry';
    assert.deepEqual(toModelFields(spec).reasoningEfforts, reasoningEfforts);
  }
});

test('SenseNova unpublished capacities clear older inherited values', () => {
  for (const name of ['sensenova-6.7-flash-lite', 'sensenova-6.8-flash-lite', 'sensenova-v6.8-flash-lite']) {
    const result = fields(name);
    assert.equal(result.contextWindow, undefined, name);
    assert.equal(result.maxTokens, undefined, name);
    assert.equal(result.sources.contextWindow, 'unknown', name);
    assert.equal(result.sources.maxTokens, 'unknown', name);
    assert.deepEqual(result.input, ['text', 'image'], name);
  }
});

test('historical DeepSeek IDs never become a newer Flash model', () => {
  for (const name of ['deepseek-v3', 'deepseek-v3.1', 'deepseek-v3.1-terminus', 'deepseek-v3.2', 'deepseek-r1', 'deepseek-r1-0528', 'deepseek-coder', 'deepseek-ai/DeepSeek-V3.1-Terminus']) {
    const resolved = resolveSpec(name);
    const result = fields(name);
    assert.equal(resolved.alias, undefined, name);
    assert.ok(!/Flash/.test(resolved.spec.displayName), name);
    assert.equal(result.contextWindow, undefined, name);
    assert.equal(result.maxTokens, undefined, name);
    assert.equal(result.reasoningEfforts, undefined, name);
    assert.ok(!result.input?.includes('image'), name);
  }
});

test('known modern fields and legitimate layered inheritance remain usable', () => {
  const flash = fields('deepseek-v4.1-flash');
  assert.equal(flash.contextWindow, 1000000);
  assert.equal(flash.maxTokens, 393216);
  assert.deepEqual(flash.input, ['text', 'image']);
  const glm = fields('glm-5.3-flash');
  assert.equal(glm.contextWindow, 1048576);
  assert.equal(glm.sources.contextWindow, 'registry');
  assert.deepEqual(glm.input, ['text', 'image']);
  const sense = fields('sensenova-v6.5');
  assert.equal(sense.contextWindow, 131072);
});
