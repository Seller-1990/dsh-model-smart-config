/** Host endpoint contract tests. No network, credentials or running DSH required. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveSpec } from '../rules/match.js';
import { isValidReasoningEfforts, toModelFields } from '../rules/infer.js';

// Execute the real class/module body with only framework dependencies replaced.
// This does not assert Cordis/typert transport behavior; it tests endpoint output.
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const stripped = source.replace(/^import .* from .*;\n/gm, '').replace(/^export /gm, '');
const schema = new Proxy(function () {}, { get: () => schema, apply: () => schema });
class RemoteError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
class Service { constructor(ctx, key) { ctx.services[key] = this; } }
const { apply, mscTypertContribution } = new Function(
  'z', 'RemoteError', 'TypertRemoteService', 'resolveSpec', 'isValidReasoningEfforts', 'toModelFields',
  `${stripped}\nreturn {apply, mscTypertContribution};`,
)(schema, RemoteError, Service, resolveSpec, isValidReasoningEfforts, toModelFields);

function fixture(llm) {
  const registered = [];
  const ctx = {
    services: {},
    inject(names, fn) {
      if (names[0] === 'llm' && llm) fn({ llm });
      if (names[0] === 'typert') fn({ typert: { register: (item) => registered.push(item) } });
      // No credentials service is injected: any accidental read must fail.
    },
  };
  apply(ctx, {});
  return { gateway: ctx.services.msc, registered };
}

const info = {
  provider: 'custom-gateway', id: 'gpt-4o', name: 'saved model',
  context: { contextWindow: 262144 }, defaultMaxTokens: 32768,
  inputModalities: ['text'],
  reasoning: { efforts: [{ id: 'off' }, { id: 'low' }], defaultEffort: 'low' },
};

test('effective configuration stays diagnostic even for a built-in provider name', async () => {
  for (const provider of ['custom-gateway', 'openai']) {
    const seen = [];
    const { gateway } = fixture({ resolveModelInfo: async (...args) => { seen.push(args); return { ...info, provider }; } });
    const result = await gateway.authoritative({ provider, model: 'gpt-4o' });
    assert.equal(result.found, true);
    assert.equal(result.source, 'resolved-config');
    assert.deepEqual(result.inputModalities, ['text']);
    assert.deepEqual(result.reasoningEfforts, { off: null, low: 'low' });
    assert.equal(result.contextWindow, 262144);
    assert.deepEqual(seen, [[provider, 'gpt-4o']]);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
});

test('missing service and failed resolution do not invent authoritative evidence', async () => {
  assert.deepEqual(await fixture().gateway.authoritative({ provider: 'p', model: 'm' }), { found: false, reason: 'llm-unavailable' });
  const { gateway } = fixture({ resolveModelInfo: async () => { throw Object.assign(new Error('model missing'), { code: 'UNKNOWN_MODEL' }); } });
  assert.deepEqual(await gateway.authoritative({ provider: 'p', model: 'm' }), { found: false, reason: 'UNKNOWN_MODEL', message: 'model missing' });
  await assert.rejects(() => gateway.authoritative({ provider: 'p' }), { code: 'msc/rejected' });
});

test('infer forwards per-field evidence and excludes unmatched fallback capabilities', () => {
  const { gateway } = fixture();
  const known = gateway.infer({ name: 'gpt-4o' });
  assert.equal(known.confidence, 'exact');
  assert.deepEqual(known.input, ['text', 'image']);
  assert.equal(known.sources.input, 'registry');
  assert.ok(known.fieldEvidence.input);
  const unknown = gateway.infer({ name: 'msc-unregistered-model-xyz' });
  assert.equal(unknown.confidence, 'none');
  for (const field of ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts']) assert.equal(unknown[field], undefined, field);
  assert.throws(() => gateway.infer({ name: '  ' }), { code: 'msc/rejected' });
});

test('legacy namespace and endpoint names remain backward-compatible', () => {
  const { registered } = fixture();
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0], mscTypertContribution());
  assert.deepEqual(registered[0].invocations.map((item) => `${item.namespace}/${item.method}`), ['msc/infer', 'msc/authoritative', 'msc/probe']);
});
