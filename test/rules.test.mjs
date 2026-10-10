/**
 * test/rules.test.mjs — 推断规则纯函数单测（不依赖 DSH 运行时）
 *
 * 运行：node --test test/rules.test.mjs
 * 或用真实 node："/c/Program Files/nodejs/node" --test test/rules.test.mjs
 *
 * 覆盖 docs/03-inference-rules.md §8 要求的全部用例，另加「规则表自检」
 * 防回归 —— 手写规则时最容易犯的就是 `reasoningEfforts: { off: null }`。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE_RULE, MODEL_RULES, HEURISTIC_MODALITY, m } from '../data/model-rules.js';
import { normalizeModelName } from '../rules/normalize.js';
import { matchRules, resolveSpec } from '../rules/match.js';
import {
  DSH_MODALITIES,
  THINKING_LEVELS,
  isValidReasoningEfforts,
  resolveModality,
  resolveReasoning,
  toModelFields,
} from '../rules/infer.js';

// ───────────────────────── 规则表自检（防回归） ─────────────────────────

test('规则表自检：每条规则的 reasoningEfforts 都合法', () => {
  MODEL_RULES.forEach((rule, index) => {
    assert.ok(
      isValidReasoningEfforts(rule.reasoningEfforts),
      `规则 #${index} (${rule.displayName}) 的 reasoningEfforts 非法：${JSON.stringify(rule.reasoningEfforts)}`,
    );
  });
});

test('规则表自检：input 只含 DSH 认识的模态，extraInputs 不与之重复', () => {
  for (const rule of [BASE_RULE, ...MODEL_RULES]) {
    if (rule.input !== undefined) {
      assert.ok(Array.isArray(rule.input), `${rule.displayName}: input 必须是数组`);
      for (const modality of rule.input) {
        assert.ok(
          DSH_MODALITIES.includes(modality),
          `${rule.displayName}: input 含 DSH 不认识的模态 "${modality}"`,
        );
      }
    }
    if (rule.extraInputs !== undefined) {
      for (const extra of rule.extraInputs) {
        assert.ok(
          !DSH_MODALITIES.includes(extra),
          `${rule.displayName}: extraInputs 里不该出现可写入的模态 "${extra}"`,
        );
        assert.ok(
          !(rule.input ?? []).includes(extra),
          `${rule.displayName}: extraInputs 与 input 重复 "${extra}"`,
        );
      }
    }
  }
});

test('规则表自检：上下文/最大输出都是正整数', () => {
  for (const rule of MODEL_RULES) {
    for (const field of ['contextWindow', 'maxTokens']) {
      if (rule[field] === undefined) continue;
      assert.ok(
        Number.isInteger(rule[field]) && rule[field] > 0,
        `${rule.displayName}.${field} 必须是正整数，实际 ${rule[field]}`,
      );
    }
  }
});

test('规则表自检：每条规则都能匹配一个「像样」的名字（正则不空转）', () => {
  // 从 displayName 造不出名字，所以只断言正则对自身不报错且不是万能匹配
  MODEL_RULES.forEach((rule, index) => {
    assert.ok(rule.match instanceof RegExp, `规则 #${index} 的 match 必须是正则`);
    assert.notEqual(rule.match.source, '.*', `规则 #${index} 是万能匹配，请用 BASE_RULE 兜底`);
  });
});

/**
 * ⚠️ **这条自检是修 bug 时补的，必须保留**。
 *
 * 曾经的真 bug：`m('gpt-')` 生成的正则尾部要求「名字后再跟一个分隔符」，
 * 而 `gpt-4o` 的 `-` 已被规则名自己吃掉 → 该家族规则**永不命中**。
 * 旧的「从规则反推样本」式自检拦不住它，因为样本也是从同一条规则派生的。
 *
 * 这里改成**从正则自身反向构造一个应能命中它的具体名字**：
 * 剥掉前后锚点，取交替的第一支，把 `[-.]?` 还原成 `-`，去掉非捕获组标记，
 * 得到如 `claude-3-opus`；再断言它必须能被自己命中。
 * 若规则名以分隔符结尾（如 `gpt-`），构造出的名字就会命中失败 → 立刻暴露。
 */
function representativeName(pattern) {
  const body = pattern.source
    .replace(/^\(\?:\^?\|?\[[^\]]*\]\)/, '')      // 去掉前置边界 `(?:^|[.\-:/\[\s])`
    .replace(/\(\?:\[[^\]]*\].*\)\?\$$/, '');    // 去掉尾部 `(?:[.\-:/\[].*)?$`
  return expandRep(body);
}

/**
 * 把折叠后的正则体展开成一个「应当能被它自己命中」的具体名字。
 * 早期的逐条 replace 版本只会取交替第一支、且不会展开字符类，于是
 * `step[-.]?[0-9]` / `sensenova[-.]?v?6` / `solar[-.]?(?:pro|mini)[-.]?4`
 * 这类规则会被误报成「自己命中不了自己」。这里改成递归展开：
 * 字符类取首字符（`[0-9]`→`0`）、可选量词丢弃（`v?`→`v`）、
 * 嵌套交替取第一支（`(?:pro|mini)`→`pro`）。
 */
function expandRep(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
    if (ch === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '(') depth += 1;
        else if (src[j] === ')') depth -= 1;
        j += 1;
      }
      let inner = src.slice(i + 1, j - 1);
      if (inner.startsWith('?:')) inner = inner.slice(2);
      out += expandRep(firstAlternative(inner));
      i = j;
      if (src[i] === '?' || src[i] === '*' || src[i] === '+') i += 1;
      continue;
    }
    if (ch === '[') {
      const j = src.indexOf(']', i);
      const cls = src.slice(i + 1, j).replace(/\\/g, '');
      out += cls[0] ?? '';
      i = j + 1;
      if (src[i] === '?' || src[i] === '*' || src[i] === '+') i += 1;
      continue;
    }
    if (ch === '.') {
      if (src[i + 1] === '*') { i += 2; continue; }  // `.*` 通配，略去
      out += '.';
      i += 1;
      continue;
    }
    if (ch === '|') break;                            // 顶层交替只取第一支
    if (ch === '?' || ch === '*' || ch === '+' || ch === '^' || ch === '$') { i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

/** 取顶层（括号深度 0）的第一支交替。 */
function firstAlternative(src) {
  let depth = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === '|' && depth === 0) return src.slice(0, i);
  }
  return src;
}

test('规则表自检：每条规则都能命中「由它自己反向构造的真实名字」', () => {
  const broken = [];
  MODEL_RULES.forEach((rule, index) => {
    const name = representativeName(rule.match);
    if (!rule.match.test(name)) {
      broken.push(`#${index} (${rule.displayName}) 构造名 "${name}" 未被自身正则命中`);
    }
  });
  assert.deepEqual(broken, [], `存在永不命中的规则（分隔符被名字吞掉的经典 bug）：\n${broken.join('\n')}`);
});

/**
 * 真实模型名清单 —— 覆盖 docs/03 §3.2 承诺的 11 家厂商。
 * 断言的是**用户真会输入的模型名**，而不是从规则反推的样本。
 */
const REAL_MODEL_NAMES = [
  'gpt-5', 'gpt-4o', 'gpt-4.1', 'gpt-4o-2024-11-20', 'o1', 'o3', 'o4-mini',
  'claude-3-5-sonnet-20241022', 'claude-3-7-sonnet-latest', 'claude-sonnet-4-5',
  'gemini-2.5-pro', 'gemini-2-5-flash',
  'deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro', 'deepseek-v4.1-flash',
  'qwen3-max', 'qwen-max', 'qwen-vl-plus', 'qwen3-vl-235b',
  'glm-5.3-flash', 'glm-4.6', 'glm-4.6v',
  'kimi-k2', 'kimi-k3', 'moonshot-v1-128k',  'MiniMax-M2', 'minimax-m1',
  'grok-4', 'grok-4.1-fast',
  'mistral-large-latest', 'magistral-medium', 'pixtral-12b',
  'llama-3.3-70b', 'llama-4-scout',
  // 本轮新增：Google Gemma、腾讯混元、小米 MiMo、智谱老线、Kimi K3 世代
  'gemma4:31b', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'gemma-3-27b-it', 'gemma-2-9b',
  'hy3', 'hy4-preview', 'hy4-preview-f', 'hunyuan-turbo', 'hunyuan-chat', 'hunyuan-t1',
  'mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2-flash',
  'emohaa', 'codegeex-4', 'charglm-4',
  'k3', 'k3-256k', 'kimi-k3', 'moonshotai/kimi-k3',
  // 本轮新增：用户圈正的 20 家厂商（每家的代表型号）
  'ernie-5.0', 'ernie-4.5-turbo-vl', 'ernie-x1',
  'doubao-seed-1.6', 'doubao-seed-2.1',
  'step-3.7', 'step-5', 'step-1o-turbo',
  'yi-lightning', 'yi-large',
  'baichuan4', 'baichuan3-turbo-128k',
  'spark-4.0-ultra', 'spark-x2', 'generalv3.5',
  'sensenova-6.5-flash', 'sensechat-character',
  'pangu-2.0', 'pangu-nlp-n2-reasoner-32k',
  'skywork-13b', 'skyclaw-v1',
  'minicpm-v-4-6', 'minicpm4', 'minicpm5',
  'internlm3', 'internlm2-5-7b',
  'phi-4', 'phi-4-mini', 'phi-4-reasoning-vision', 'phi-4-multimodal',
  'command-a-plus', 'command-r-plus',
  'jamba-1.5-large',
  'nova-pro', 'nova-2-lite', 'us.amazon.nova-micro-v1',
  'nemotron-3-nano', 'nemotron-3-ultra',
  'granite-4.2-30b', 'granite-vision-4.1-4b',
  'olmo-2-13b', 'olmo-3.1-32b-think',
  'solar-pro-3', 'solar-pro-4',
  'reka-flash-3.1', 'reka-edge-2603',
  // 本轮新增：各厂商最新代次（G2 官方规格扫描，2026-10-09）
  'mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed', 'mimo-v2.5-asr',
  'glm-5.3', 'glm-5.3-flashx', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'glm-4-long',
  'kimi-k3', 'kimi-k2.8-preview', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5',
  'MiniMax-M3', 'MiniMax-M3.1-Flash-Preview', 'MiniMax-M2.7',
  'hy4-preview', 'hy3', 'hunyuan-a13b', 'hy-mt2-pro',
  'ernie-5.1', 'ernie-5.0', 'ernie-4.5-turbo-32k',
  'doubao-seed-evolving', 'doubao-seed-2-1-pro-260915', 'doubao-seed-character-260628',
  'step-5-preview', 'step-3.7-flash', 'step-3.5-flash',
  // 本轮新增：其余 17 家厂商最新型号（G3 官方规格扫描，2026-10-09）
  'Baichuan-M3-235B',
  'spark-x2',
  'sensenova-6.8-flash-lite', 'sensenova-6.8-flash', 'sensenova-u1.5-lite',
  'openpangu-2.0-pro', 'pangu-nlp-n2-reasoner-32k',
  'skywork-ai/skyclaw-v1', 'skyclaw-v1-lite',
  'MiniCPM5-2B', 'minicpm-v-4.6',
  'Intern-S2-Preview', 'intern-s1',
  'Phi-4-reasoning-vision-15B',
  'command-a-plus-05-2026', 'command-a-03-2025', 'command-a',
  'jamba-large-1.7-2025-07', 'jamba-mini-2-2026-01',
  'amazon.nova-2-lite-v1:0', 'us.amazon.nova-2-sonic-v1:0', 'amazon.nova-micro-v1:0',
  'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B', 'nemotron-3.5-lightning',
  'granite-4.2-30b', 'ibm-granite/granite-4.2-30b',
  'allenai/Olmo-3.1-32B-Instruct', 'allenai/Olmo-3.1-32B-Think',
  'solar-pro4', 'solar-mini4', 'solar-open-2',
  'reka-flash-3', 'reka-edge-2603',
  // 本轮新增：8 家国外厂商最新代次（G1 官方规格扫描，2026-10-09）
  'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra',
  'gpt-realtime-2.1', 'gpt-5.4-nano', 'gpt-5.3-codex',
  'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-mythos-5-1',
  'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.1-pro-preview',
  'gemma-4-31B-it', 'gemma-4-26B-A4B', 'gemma-4-12B', 'gemma-4-e4b', 'gemma-4-e2b',
  'deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash',
  'qwen3.8-max', 'qwen3.8-flash', 'qwen3.8-omni-flash', 'qwen3-8-max',
  'grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-build-0.1',
  'mistral-large-4-0', 'mistral-medium-3-5-26-04', 'mistral-small-4-0-26-03',
  'muse-spark-1.3', 'muse-spark-1.2-contributor', 'muse-spark-1.1', 'muse-glimmer',
];

test('规则表自检：真实模型名清单逐条命中（不允许出现「能识别但漏规则」）', () => {
  const missed = [];
  for (const name of REAL_MODEL_NAMES) {
    const { matchedRules, spec, confidence } = resolveSpec(name);
    if (matchedRules.length === 0 || confidence === 'none') missed.push(name);
    if (spec.contextWindow === undefined) missed.push(name + '（无 contextWindow）');
  }
  assert.deepEqual(missed, [], `以下真实模型名未命中任何规则：\n${missed.join('\n')}`);
});

test('规则表自检：每条规则都带官方文档 source（「官方文档」途径的落点）', () => {
  const missing = [];
  MODEL_RULES.forEach((rule, index) => {
    if (typeof rule.source !== 'string' || rule.source.length === 0) {
      missing.push(`#${index} (${rule.displayName})`);
    }
  });
  assert.deepEqual(missing, [], `以下规则缺 source：\n${missing.join('\n')}`);
});

test('规则表自检：分隔符结尾的名字不会构造出坏正则（gpt- 回归护栏）', () => {
  // 直接复现当初的 bug：以分隔符结尾的规则名必须仍然命中「名字+后缀」
  assert.ok(m('gpt').test('gpt-4o'), 'gpt 家族规则必须命中 gpt-4o');
  assert.ok(m('claude').test('claude-3-5-sonnet-20241022'), 'claude 家族规则必须命中带日期后缀的名字');
  // 反面：若有人再写 `m('gpt-')`，本条会失败 —— 这正是当初那个 bug 的形态。
  assert.ok(!m('gpt-').test('gpt-4o'), '以分隔符结尾的规则名会失效，规则里不得这样写');
});

test('规则表自检：短名/前缀不得误吃无关词（假阳性护栏）', () => {
  // 这些名字**必须**保持未识别 —— 它们只是恰好含某个家族短名。
  const MUST_MISS = [
    'hyundai-llm', 'shy3', 'why4',          // 含 hy3/hy4 子串但不是混元
    'k3s', 'mk3', 'sk3',                    // 含 k3 子串但不是 kimi
    'mimosa-7b', 'kimiya', 'hunyuanx',      // 家族名加尾巴
    'gemm', 'llamas', 'o1x',                // 截断/加尾
  ];
  const wronglyHit = MUST_MISS.filter((name) => resolveSpec(name).confidence !== 'none');
  assert.deepEqual(wronglyHit, [], `以下名字被误识别：\n${wronglyHit.join('\n')}`);
});

test('规则表自检：家族兜底名（无代次）仍应命中', () => {
  // 与上一条互为反面：光秃秃的家族名必须能识别（用户可能只填 `gemma`）。
  for (const name of ['gemma', 'mimo', 'hunyuan', 'gpt', 'claude', 'qwen', 'glm']) {
    assert.notEqual(resolveSpec(name).confidence, 'none', `家族名 ${name} 应命中兜底规则`);
  }
});

// ───────────────────────── 归一化 ─────────────────────────

test('归一化：去空白、剥组织前缀、统一分隔符、保留日期后缀', () => {
  assert.equal(normalizeModelName('  gpt-4o  ').normalized, 'gpt-4o');
  assert.equal(normalizeModelName('openai/gpt-4o').normalized, 'gpt-4o');
  assert.equal(normalizeModelName('models/gemini-2.5-pro').normalized, 'gemini-2-5-pro');
  assert.equal(normalizeModelName('claude_3.5_sonnet').normalized, 'claude-3-5-sonnet');
  // 第 4 步：**不**剥离日期/变体后缀
  assert.equal(normalizeModelName('gpt-4o-2024-11-20').normalized, 'gpt-4o-2024-11-20');
  assert.equal(normalizeModelName('anthropic/claude-3-5-sonnet-20241022').normalized, 'claude-3-5-sonnet-20241022');
});

test('归一化：raw 原串保留（UI 显示用），非字符串输入不抛错', () => {
  const result = normalizeModelName(' openai/gpt-4o ');
  assert.equal(result.raw, 'openai/gpt-4o');
  assert.equal(normalizeModelName(undefined).normalized, '');
  assert.equal(normalizeModelName(null).normalized, '');
});

test('归一化：别名只改匹配用名，并留痕', () => {
  const result = normalizeModelName('deepseek-chat');
  assert.equal(result.normalized, 'deepseek-v4-flash');
  assert.deepEqual(result.alias, { from: 'deepseek-chat', to: 'deepseek-v4-flash' });
  assert.equal(result.raw, 'deepseek-chat', 'raw 不能被别名改掉');
});

test('归一化：未命中别名表不报错，别名是补充而非门槛', () => {
  const result = normalizeModelName('some-vendor/custom-model-9');
  assert.equal(result.normalized, 'custom-model-9');
  assert.equal(result.alias, undefined);
});

// ───────────────────────── 正则命中 ─────────────────────────

test('命中：厂商前缀 + 日期后缀仍能命中精确型号', () => {
  assert.ok(matchRules('gpt-4o').length > 0);
  assert.ok(matchRules('gpt-4o-2024-11-20').length > 0);
  assert.ok(matchRules('claude-3-5-sonnet-20241022').length > 0);
  assert.ok(matchRules('gemini-2-5-pro').length > 0);
});

test('命中：不因子串误命中（o3 不该被 grok-4.3 里的 3 命中）', () => {
  const hits = matchRules('grok-4-3').map((index) => MODEL_RULES[index].displayName);
  assert.ok(hits.includes('Grok 4'), `grok-4.3 应命中 Grok 4，实际 ${JSON.stringify(hits)}`);
  assert.ok(!hits.includes('OpenAI o3'), `grok-4.3 不该命中 o3，实际 ${JSON.stringify(hits)}`);
});

test('命中：未知模型命中零条规则，confidence 为 none', () => {
  const result = resolveSpec('totally-unknown-model-xyz');
  assert.equal(result.matchedRules.length, 0);
  assert.equal(result.confidence, 'none');
  assert.equal(result.spec.contextWindow, BASE_RULE.contextWindow);
  assert.equal(result.spec.reasoningEfforts, undefined);
});

// ───────────────────────── 分层覆盖 ─────────────────────────

test('分层覆盖：具体型号覆盖家族规则（顺序敏感）', () => {
  const result = resolveSpec('gpt-4o');
  // 家族规则 gpt- 给 128000/16384，gpt-4o 也是 128000/16384，改看 reasoningEfforts
  assert.equal(result.spec.displayName, 'GPT-4o');
  assert.equal(result.spec.reasoningEfforts, false, 'gpt-4o 是非推理模型');

  const o3 = resolveSpec('o3');
  assert.equal(o3.spec.displayName, 'OpenAI o3');
  assert.deepEqual(o3.spec.reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high' });
});

test('分层覆盖：zcode 式三层增量（glm-5.3-flash = 容量 + 等级 + 模态）', () => {
  const result = resolveSpec('glm-5.3-flash');
  const names = result.matchedRules.map((index) => MODEL_RULES[index].displayName);
  assert.ok(names.includes('GLM'), `应命中 GLM 家族，实际 ${JSON.stringify(names)}`);
  assert.ok(names.includes('GLM-5'), `应命中 GLM-5，实际 ${JSON.stringify(names)}`);
  assert.ok(names.includes('GLM-5.3'), `应命中 GLM-5.3，实际 ${JSON.stringify(names)}`);
  assert.ok(names.includes('GLM-5.3 Flash'), `应命中 GLM-5.3 Flash，实际 ${JSON.stringify(names)}`);

  // 容量来自 GLM-5.3（后命中覆盖 GLM-5 的 204800/131072）
  assert.equal(result.spec.contextWindow, 1048576);
  assert.equal(result.spec.maxTokens, 131072);
  // 等级来自 GLM-5.3
  assert.deepEqual(result.spec.reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' });
  // 模态来自 GLM-5.3 Flash 的增量覆盖（该规则只写 input/extraInputs，不动其它字段）
  assert.deepEqual(result.spec.input, ['text', 'image']);
  assert.deepEqual(result.spec.extraInputs, ['video', 'pdf']);
  // displayName 是最后一个写了该字段的规则 —— GLM-5.3 Flash
  assert.equal(result.spec.displayName, 'GLM-5.3 Flash');
});

test('分层覆盖：只写部分字段的规则不会清空其它字段', () => {
  // GLM-5.3 Flash 规则不含 contextWindow，容量应保留 GLM-5.3 的值
  const spec = resolveSpec('glm-5.3-flash').spec;
  assert.ok(spec.source !== undefined, 'source 不该被覆盖成 undefined');
  assert.equal(spec.vendor, 'zhipu', 'vendor 不该被覆盖');
});

test('分层覆盖：DeepSeek 两条线（推理 / 多模态）各自正确', () => {
  const pro = resolveSpec('deepseek-v4-pro').spec;
  assert.deepEqual(pro.input, ['text'], '推理线是纯文本');
  // 官方 reasoning_effort 四档（none/low/high/max），推理线同样可用 low
  assert.deepEqual(pro.reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' });

  const flash = resolveSpec('deepseek-v4.1-flash').spec;
  assert.deepEqual(flash.input, ['text', 'image'], 'flash 线支持图像');
  assert.equal(flash.contextWindow, 1000000);
  // 官方 MAX OUTPUT MAXIMUM 384K = 393216
  assert.equal(flash.maxTokens, 393216);
});

// ───────────────────────── reasoningEfforts 合法性 ─────────────────────────

test('reasoningEfforts 合法性：合法形态', () => {
  assert.ok(isValidReasoningEfforts(undefined), '省略 = 合法');
  assert.ok(isValidReasoningEfforts(false), 'false = 合法（非推理模型）');
  assert.ok(isValidReasoningEfforts({ off: null, high: 'high' }));
  assert.ok(isValidReasoningEfforts({ high: 'high' }), 'off 可以省略');
  assert.ok(isValidReasoningEfforts({ off: null, low: 'low', xhigh: 'xhigh', max: 'max' }));
});

test('reasoningEfforts 合法性：非法形态必须被拦住', () => {
  assert.ok(!isValidReasoningEfforts({ off: null }), '只有 off 一档 → 非法');
  assert.ok(!isValidReasoningEfforts({}), '空对象 → 非法');
  assert.ok(!isValidReasoningEfforts(null), 'null → 非法');
  assert.ok(!isValidReasoningEfforts([]), '数组 → 非法');
  assert.ok(!isValidReasoningEfforts({ off: null, high: null }), '非 off 档为 null → 非法');
  assert.ok(!isValidReasoningEfforts({ off: null, high: '' }), '空串 → 非法');
  assert.ok(!isValidReasoningEfforts({ off: 'off' }), 'off 的值不是 null → 非法');
  assert.ok(!isValidReasoningEfforts({ off: null, bogus: 'x' }), '未知档位 → 非法');
});

// ───────────────────────── 多模态判定 ─────────────────────────

test('多模态：注册表命中时采信注册表', () => {
  const spec = resolveSpec('gpt-4o').spec;
  const result = resolveModality(spec, { normalizedName: 'gpt-4o' });
  assert.deepEqual(result.input, ['text', 'image']);
  assert.equal(result.source, 'registry');
});

test('多模态：未命中注册表时用端点返回的 inputModalities', () => {
  const spec = resolveSpec('unknown-model').spec;
  const result = resolveModality(spec, {
    normalizedName: 'unknown-model',
    endpointModalities: ['text', 'image', 'audio'],
  });
  assert.deepEqual(result.input, ['text', 'image'], 'audio 不是 DSH 认识的模态，应被过滤');
  assert.equal(result.source, 'endpoint');
});

test('多模态：未识别时不写 input（不静默写错）', () => {
  const spec = resolveSpec('unknown-model-xyz').spec;
  const result = resolveModality(spec, { normalizedName: 'unknown-model-xyz' });
  assert.equal(result.input, undefined);
  assert.equal(result.source, 'unknown');
});

test('多模态：名称启发式只给候选', () => {
  const spec = resolveSpec('mystery-vl-9b').spec;
  const result = resolveModality(spec, { normalizedName: 'mystery-vl-9b' });
  assert.equal(result.source, 'heuristic');
  assert.deepEqual(result.input, ['text', 'image']);
});

test('多模态：启发式正则本身可用', () => {
  assert.ok(HEURISTIC_MODALITY.every((rule) => rule.match instanceof RegExp));
});

// ───────────────────────── 思考等级判定 ─────────────────────────

test('思考等级：S2 官方结论优先于内置表', () => {
  const spec = resolveSpec('gpt-4o').spec; // 内置表说 false
  const result = resolveReasoning(spec, {
    authoritative: { off: null, low: 'low', high: 'high' },
  });
  assert.equal(result.source, 'authoritative');
  assert.deepEqual(result.reasoningEfforts, { off: null, low: 'low', high: 'high' });
});

test('思考等级：S2 结论非法时不应被采信，回落到 S1', () => {
  const spec = resolveSpec('o3').spec;
  const result = resolveReasoning(spec, { authoritative: { off: null } });
  assert.equal(result.source, 'registry', '非法的 S2 结论必须被跳过');
});

test('思考等级：S1 内置表命中时采用', () => {
  const spec = resolveSpec('o3').spec;
  const result = resolveReasoning(spec, {});
  assert.equal(result.source, 'registry');
  assert.deepEqual(result.reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high' });
});

test('思考等级：非推理模型写 false（不是 {off:null}）', () => {
  const spec = resolveSpec('gpt-4o').spec;
  const result = resolveReasoning(spec, {});
  assert.equal(result.reasoningEfforts, false);
  assert.equal(result.source, 'registry');
});

test('思考等级：S3 实测探测只在 S1 拿不到结论时生效', () => {
  const unknown = resolveSpec('unknown-model-xyz').spec;
  const probed = resolveReasoning(unknown, { probed: { off: null, high: 'high' } });
  assert.equal(probed.source, 'probe');
  assert.deepEqual(probed.reasoningEfforts, { off: null, high: 'high' });
});

test('思考等级：S4 名称启发式只给候选、不自动写', () => {
  const spec = resolveSpec('some-vendor/mystery-reasoner-v2').spec;
  const result = resolveReasoning(spec, { normalizedName: 'mystery-reasoner-v2' });
  assert.equal(result.reasoningEfforts, undefined, '启发式不得自动写值');
  assert.equal(result.source, 'heuristic');
  assert.ok(result.suggestion !== undefined);
  assert.ok(result.note.includes('建议档位'));
});

test('思考等级：全都不命中时不写（不猜）', () => {
  const spec = resolveSpec('zzz-nothing-here').spec;
  const result = resolveReasoning(spec, { normalizedName: 'zzz-nothing-here' });
  assert.equal(result.reasoningEfforts, undefined);
  assert.equal(result.source, 'unknown');
});

// ───────────────────────── 组装结果 ─────────────────────────

test('组装：未识别的字段不出现在可写结果里', () => {
  const fields = toModelFields(resolveSpec('zzz-nothing-here').spec, {
    normalizedName: 'zzz-nothing-here',
  });
  assert.equal(fields.input, undefined, '未识别 → 不写 input');
  assert.equal(fields.reasoningEfforts, undefined, '未识别 → 不写 reasoningEfforts');
  assert.equal(fields.sources.input, 'unknown');
});

test('组装：识别的模型带上每项来源与展示用 note', () => {
  const fields = toModelFields(resolveSpec('glm-5.3-flash').spec, {
    normalizedName: 'glm-5-3-flash',
  });
  assert.equal(fields.contextWindow, 1048576);
  assert.equal(fields.maxTokens, 131072);
  assert.deepEqual(fields.input, ['text', 'image']);
  assert.equal(fields.sources.input, 'registry');
  assert.equal(fields.sources.reasoningEfforts, 'registry');
  assert.ok(fields.notes.input.includes('video'), '视频/PDF 应作为展示信息出现');
});

test('组装：写入的档位键都在 DSH 的 THINKING_LEVELS 里', () => {
  for (const name of ['o3', 'claude-3-7-sonnet', 'gemini-2.5-pro', 'deepseek-v4-pro', 'glm-5.3', 'kimi-k3', 'grok-4', 'minimax-m1']) {
    const fields = toModelFields(resolveSpec(name).spec, { normalizedName: name });
    const efforts = fields.reasoningEfforts;
    if (efforts === undefined || efforts === false) continue;
    for (const key of Object.keys(efforts)) {
      assert.ok(
        THINKING_LEVELS.includes(key),
        `${name}: 档位键 "${key}" 不在 THINKING_LEVELS 里`,
      );
    }
  }
});

// ───────────────────────── 顺序敏感性（硬约束） ─────────────────────────

test('顺序敏感：若把具体型号放到家族规则之前，它会被家族规则覆盖（回归护栏）', () => {
  // 直接构造：后一条规则覆盖前一条 —— 这就是 MODEL_RULES 必须「从泛到具体」的原因
  const merged = { ...BASE_RULE };
  const family = { displayName: 'family', contextWindow: 100 };
  const specific = { displayName: 'specific', contextWindow: 200 };
  for (const rule of [family, specific]) {
    for (const key of Object.keys(rule)) merged[key] = rule[key];
  }
  assert.equal(merged.contextWindow, 200, '后者覆盖前者');

  // 反过来就会被吃掉
  const merged2 = { ...BASE_RULE };
  for (const rule of [specific, family]) {
    for (const key of Object.keys(rule)) merged2[key] = rule[key];
  }
  assert.equal(merged2.contextWindow, 100, '具体型号若排在前，会被家族规则覆盖');
});

/**
 * 自动枚举「遮蔽对」：若后面的规则能命中前面规则的代表名、且带有可覆盖字段，
 * 那么前面那条的 displayName / 容量就会被反向盖掉 —— 这就是 v0.1.1 扩表时
 * 一次性踩出 15 处的坑（GLM-4 吃掉 GLM-4.6、Phi-4 吃掉 Phi-4-mini、Command A
 * 吃掉 Command A Plus……）。这条测试把它变成硬护栏：新增规则若顺序写反，立刻红。
 *
 * 允许的例外只有一种：**家族兜底（generic: true）排在最前、具体规则排在其后**，
 * 此时遮蔽方向正是设计意图（兜底先给默认值，具体规则再细化）。故只在
 * 「后者不是 generic、或前者不是 generic」时才报错。
 */
test('顺序敏感：自动枚举所有遮蔽对，只有「家族兜底在前」才是合法的', () => {
  const KEYS = ['displayName', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts'];
  const bad = [];
  MODEL_RULES.forEach((earlier, i) => {
    const name = representativeName(earlier.match);
    MODEL_RULES.slice(i + 1).forEach((later, offset) => {
      if (!later.match.test(name)) return;
      const overrides = KEYS.filter((key) => later[key] !== undefined);
      if (overrides.length === 0) return;
      // 合法：前面是家族兜底、后面是具体规则（正是分层覆盖的设计意图）
      if (earlier.generic === true && later.generic !== true) return;
      bad.push(
        `#${i} (${earlier.displayName}) 被 #${i + 1 + offset} (${later.displayName}) 反向覆盖 `
        + `via "${name}"：${overrides.join(', ')}`,
      );
    });
  });
  assert.deepEqual(bad, [], '规则表必须「从泛到具体」排列，具体型号不能被更宽的规则覆盖');
});

/*
 * 继承护栏：合并只覆盖「非 undefined」字段，所以一条规则把 input 收窄成纯文本、
 * 却不写 extraInputs 时，会从上面更宽的规则**继承**到视频/音频。
 * 真实踩过：`mimo-v2.5-pro`（官方纯文本）继承了 `mimo-v2.5`（全模态）的
 * ['video','audio']，解析出「纯文本 + 视频音频」的自相矛盾结果。
 * 修法是在具体规则里显式写 `extraInputs: []`。
 *
 * ⚠️ 判据必须看**最终生效的那条规则有没有显式声明 extraInputs**：
 * `nova-2-sonic` 是纯文本**输入**（Speech/Audio）模型，它的 extraInputs: ['audio']
 * 是官方事实、不是继承来的污染 —— 只看解析结果会把这种合法形态误判成缺陷。
 */
test('继承护栏：最终生效的规则没声明 extraInputs 时，不能凭空继承出「纯文本 + extraInputs」', () => {
  const contradicted = [];
  for (const name of REAL_MODEL_NAMES) {
    const { spec, matchedRules } = resolveSpec(name);
    const winner = matchedRules.length > 0 ? MODEL_RULES[matchedRules[matchedRules.length - 1]] : undefined;
    const declaredInput = Array.isArray(winner?.input);
    const declaredExtra = winner?.extraInputs !== undefined;
    const textOnly = Array.isArray(spec.input) && spec.input.length === 1 && spec.input[0] === 'text';
    const extra = Array.isArray(spec.extraInputs) ? spec.extraInputs : [];
    // 只有「收窄了 input、却没交代 extraInputs」才是在被动继承。
    if (declaredInput && !declaredExtra && textOnly && extra.length > 0) {
      contradicted.push(
        `${name} → 生效规则 #${matchedRules[matchedRules.length - 1]} (${winner.displayName}) input=${JSON.stringify(spec.input)} 却继承到 extraInputs=${JSON.stringify(extra)}`,
      );
    }
  }
  assert.deepEqual(
    contradicted,
    [],
    '纯文本模型被动继承出 extraInputs：具体规则里要显式写 extraInputs: [] 把继承来的值清掉',
  );
});
