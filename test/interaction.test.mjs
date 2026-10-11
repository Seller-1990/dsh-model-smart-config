/**
 * Client 半的真实交互测试（jsdom + 真实 React 18）—— v0.3.0「行内化」口径。
 *
 * 目的：证明行内控件不只是「能渲染」，而是**主链路真的能跑通**：
 *   挂载 → readProvider → infer/authoritative → 行内显示识别结果 →
 *   点「应用」→ **把结果填进官方自己的控件**（上下文 / 最大输出 / 思考等级 / 图像开关）。
 *
 * ★ v0.3.0 的关键口径变更：
 *   插件**不再**自己调 `settings.mutate`。官方 `ProviderEditor` 把编辑留在 draft 里，
 *   只在用户点「保存」时才发 path ops；插件若自己写库会顶掉 revision，导致官方保存
 *   必然撞 `settings/conflict`。所以本测试专门断言 `remote.settings.mutate` **零调用**，
 *   并用「官方受控 input 的 value + 展开状态」证明值确实落进了官方控件。
 *
 * 需要一份真实的 React + react-dom + jsdom（默认取仓库根 `node_modules`，
 * 可用 MSC_DOM_ENV 指向别的 node_modules 布局）。
 *
 * 跑法：node test/interaction.test.mjs
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const env = process.env.MSC_DOM_ENV || path.join(root, 'node_modules');

const require = createRequire(path.join(env, 'noop.js'));

let JSDOM, React, ReactDOM, createRoot, act;
try {
  ({ JSDOM } = require('jsdom'));
  React = require('react');
  ReactDOM = require('react-dom');
  ({ createRoot } = require('react-dom/client'));
  ({ act } = require('react-dom/test-utils'));
} catch (error) {
  console.error('SKIP: jsdom/React 环境不可用:', error.message);
  process.exit(2);
}

/* ---------------- 官方模型行的复刻 ---------------- */

/**
 * 复刻 `ModelListEditor` 的一行（官方 JSX 顺序）：
 *   div.modelEntry > [ div.modelRow(id, name, toggle, 展开, 删除), div.modelAdvanced? ]
 */
function modelRowHtml(position, id) {
  return `
    <div class="zGbnIq_modelEntry">
      <div class="zGbnIq_modelRow" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto auto">
        <input class="zGbnIq_input" type="text" value="${id}" placeholder="modelId" aria-label="modelId ${position}">
        <input class="zGbnIq_input" type="text" value="" placeholder="modelName" aria-label="modelName ${position}">
        <label class="dshModelModalityToggle dshModelModalityToggleCompact">
          <input type="checkbox" aria-label="modelImageInput ${position}">
          <span class="dshModelModalityCopy"><span class="dshModelModalityTitle">图像</span></span>
        </label>
        <button type="button" class="zGbnIq_iconButton" aria-label="modelAdvanced ${position}" aria-expanded="false" title="modelAdvanced"></button>
        <button type="button" class="zGbnIq_iconButton zGbnIq_iconButtonDanger" aria-label="removeModel ${position}" title="removeModel"></button>
      </div>
    </div>`;
}

function advancedHtml(position) {
  return `
    <div class="zGbnIq_modelAdvanced">
      <label class="zGbnIq_modelField"><span class="zGbnIq_modelFieldLabel">上下文</span>
        <input class="zGbnIq_input" type="text" value="" placeholder="256K" aria-label="modelContextWindow ${position}"></label>
      <label class="zGbnIq_modelField"><span class="zGbnIq_modelFieldLabel">最大输出</span>
        <input class="zGbnIq_input" type="text" value="" placeholder="32K" aria-label="modelMaxTokens ${position}"></label>
      <div class="dshModelReasoningField">
        <label class="zGbnIq_modelField"><span class="zGbnIq_modelFieldLabel">思考等级</span>
          <input class="zGbnIq_input" type="text" value="" placeholder="low, high" aria-label="modelReasoningLevels ${position}">
          <span class="dshModelReasoningHint">逗号分隔</span></label>
      </div>
    </div>`;
}

/* ---------------- 搭 DOM 环境 ---------------- */

const dom = new JSDOM(
  `<!doctype html><html><body>
    <div id="root">
      <ul id="rows">
        <li id="row">
          <div class="rowHead">测试网关</div>
          <div id="slot"></div>
          <div class="editor">
            <details class="customized" open>
              <summary>自定义设置</summary>
              <div class="customizedBody">
                <section class="dshModelCatalogSearch">模型目录</section>
                <div class="modelList">
                  ${modelRowHtml(1, 'anthropic/claude-sonnet-4-5')}
                  ${modelRowHtml(2, 'zzz-unknown-model')}
                </div>
              </div>
            </details>
          </div>
        </li>
      </ul>
    </div>
  </body></html>`,
  {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1/',
  },
);

const doc = dom.window.document;

globalThis.window = dom.window;
globalThis.document = doc;
// node 24 给 globalThis.navigator 装的是只读 getter，必须 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

/** 官方「展开」按钮的 React 行为：把高级区插进 modelEntry。 */
function wireExpandButton(rowEl) {
  const button = rowEl.querySelector('button[aria-expanded]');
  const entry = rowEl.parentElement;
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-expanded') === 'true') {
      button.setAttribute('aria-expanded', 'false');
      const advanced = entry.querySelector('.zGbnIq_modelAdvanced');
      if (advanced) advanced.remove();
      return;
    }
    button.setAttribute('aria-expanded', 'true');
    const holder = doc.createElement('div');
    holder.innerHTML = advancedHtml(entry.querySelector('input[type="text"]').getAttribute('aria-label').split(' ').pop());
    entry.appendChild(holder.firstElementChild);
  });
}

/**
 * 官方受控 input 的 React 行为：React 监听原生 `input` 事件，
 * 直接 `el.value = x` 不会触发 onChange。这里挂监听把值同步进 `data-synced`，
 * 以证明插件走的是「原生 value setter + input 事件」这条正确通道。
 */
doc.querySelectorAll('.zGbnIq_modelRow').forEach(wireExpandButton);
doc.getElementById('row').addEventListener('input', (event) => {
  const el = event.target;
  if (el && el.tagName === 'INPUT') el.setAttribute('data-synced', el.value);
});

/* ---------------- 装载 client.js ---------------- */

const loaderCalls = [];
dom.window.__ModuleLoader__ = {
  load(spec) {
    loaderCalls.push(spec);
  },
};

const source = readFileSync(path.join(root, 'client.js'), 'utf8');
new Function('window', source)(dom.window);

const failures = [];
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

const spec = loaderCalls[0];
const mod = spec.factory((name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return ReactDOM;
  throw new Error(`unexpected require("${name}")`);
});

/* ---------------- 假宿主 ----------------
 * 记录 Client 半实际发出的每一个请求，用于断言。
 */

const calls = {
  rpc: [],
  mutate: [],
};

const PROVIDER_PROFILE = {
  displayName: '测试网关',
  apiKeyEnv: 'TESTGW_API_KEY',
  api: 'openai-completions',
  baseURL: 'https://gw.example/v1',
  models: [{ id: 'anthropic/claude-sonnet-4-5' }, { id: 'zzz-unknown-model' }],
};

/**
 * 形状与 Host 半 `msc/infer` 的返回值一致（**扁平，无 spec 包装**）。
 * `sources` 逐字段带上 —— Client 半的可写性判定读的就是它。
 */
const REGISTRY_ANSWERS = {
  'anthropic/claude-sonnet-4-5': {
    raw: 'anthropic/claude-sonnet-4-5',
    normalized: 'claude-sonnet-4-5',
    confidence: 'exact',
    matchedRules: [30, 31],
    matchedSiteRules: [],
    vendor: 'anthropic',
    displayName: 'Claude Sonnet 4.5',
    contextWindow: 200000,
    maxTokens: 64000,
    input: ['text', 'image'],
    extraInputs: [],
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
    sources: {
      contextWindow: 'registry',
      maxTokens: 'registry',
      input: 'registry',
      reasoningEfforts: 'registry',
    },
    source: 'https://docs.anthropic.com/',
    notes: {},
    warnings: [],
  },
  /** 未识别：**连 input / reasoningEfforts 两个键都不存在**（Host 半 compact 掉 undefined）。 */
  'zzz-unknown-model': {
    raw: 'zzz-unknown-model',
    normalized: 'zzz-unknown-model',
    confidence: 'none',
    matchedRules: [],
    matchedSiteRules: [],
    vendor: 'unknown',
    contextWindow: 262144,
    maxTokens: 32768,
    extraInputs: [],
    sources: {
      contextWindow: 'registry',
      maxTokens: 'registry',
      input: 'unknown',
      reasoningEfforts: 'unknown',
    },
    notes: {},
    warnings: ['rules #0'],
  },
};

const fakeCtx = {
  remote: {
    settings: {
      describe: async () => ({
        ok: true,
        value: {
          writable: true,
          hasDocument: true,
          namespaces: [
            {
              ns: 'llm-pi-ai',
              revision: 7,
              value: { providers: { testgw: PROVIDER_PROFILE } },
            },
            {
              ns: 'model-smart-config',
              revision: 3,
              value: { enabled: true, allowProbe: true },
            },
          ],
        },
      }),
      // v0.3.0 的 Client 半**不应**直接写库；记账用来断言「零调用」。
      mutate: async (ns, ops, revision) => {
        calls.mutate.push({ ns, ops, revision });
        return { ok: true, value: { ns, revision: revision + 1 } };
      },
    },
  },
  effect(fn) {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  locale: {
    register() {
      return () => {};
    },
  },
  slots: {
    captured: null,
    inject(key, callback) {
      const iter = callback();
      iter.next();
      return () => {};
    },
    register(options, component) {
      this.captured = { options, component };
      return () => {};
    },
  },
  get(name) {
    if (name === 'connection') {
      return {
        rpc: {
          call: async (channel, method, payload) => {
            calls.rpc.push({ channel, method, args: payload && payload.args });
            if (method === 'msc/infer') {
              const answer = REGISTRY_ANSWERS[payload.args.request.name];
              if (!answer) return { ok: false, error: { message: 'unknown' } };
              return { ok: true, value: answer };
            }
            if (method === 'msc/authoritative') {
              // Resolved configuration can contain text defaults; it is not catalog evidence.
              if (payload.args.request.model === 'anthropic/claude-sonnet-4-5') {
                return {
                  ok: true,
                  value: {
                    found: true,
                    source: 'resolved-config',
                    name: 'Claude Sonnet 4.5 (effective config)',
                    contextWindow: 1000000,
                    inputModalities: ['text'],
                    reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
                  },
                };
              }
              return { ok: true, value: { found: false, reason: 'UNKNOWN_MODEL' } };
            }
            if (method === 'msc/probe') {
              return {
                ok: true,
                value: {
                  url: 'https://gw.example/v1/chat/completions',
                  api: 'openai-completions',
                  baseline: { ok: true, status: 200 },
                  attempts: [],
                  conclusion: {
                    reasoning: true,
                    reasoningEvidence: ['reasoning_content'],
                    supportedLevels: ['low', 'high'],
                    rejectedLevels: [],
                  },
                  note: 'probe note',
                },
              };
            }
            return { ok: false, error: { message: `unhandled ${method}` } };
          },
        },
      };
    }
    throw new Error(`unexpected ctx.get("${name}")`);
  },
};

mod.apply(fakeCtx);
const registration = fakeCtx.slots.captured;
const Card = registration.component;
const injected = registration.options.inject();
const t = (key) => key;

/* ---------------- 挂载 ---------------- */

const container = doc.getElementById('root');
const slotNode = doc.getElementById('slot');
const rootApi = createRoot(slotNode);

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

console.log('挂载与主链路');
await act(async () => {
  rootApi.render(
    React.createElement(Card, {
      provider: {
        provider: 'testgw',
        displayName: '测试网关',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'testgw'],
        active: true,
        declared: true,
      },
      configured: true,
      keyConfigured: true,
      ...injected,
      t,
    }),
  );
});
await flush();

const rows = Array.from(doc.querySelectorAll('.zGbnIq_modelRow'));
const cells = Array.from(doc.querySelectorAll('[data-msc-row]'));

/* ---- 行内化：控件落在每条官方模型行上 ---- */

console.log('\n行内化（v0.3.0 行内位）');
const anchor = slotNode.querySelector('[data-msc-anchor]');
check('槽位里渲染了锚点', Boolean(anchor), slotNode.innerHTML.slice(0, 200));
check('锚点不可见、0 尺寸（不再占用模型列表）', anchor?.getAttribute('style')?.includes('display: none'), anchor?.getAttribute('style'));
check('卡片本体不在槽位里', !slotNode.textContent.includes('confidence'), slotNode.textContent.slice(0, 200));
check('每条官方模型行各挂了一个行内容器', cells.length === 2, String(cells.length));
check(
  '所有容器都是官方模型行的直接子节点（一个模型一行）',
  cells.length === 2 && cells.every((cell) => cell.parentElement.classList.contains('zGbnIq_modelRow')),
  cells.map((c) => c.parentElement?.className).join(' | '),
);
check(
  '没有任何容器挂在 `<details>` 下（v0.2.0 的整块面板已撤掉）',
  doc.querySelector('details > [data-msc-row]') === null,
  doc.querySelectorAll('details > [data-msc-row]').length,
);
check(
  '每行的网格轨道数 ≥ 子节点数（多出的格子不换行）',
  rows.every((row) => row.style.gridTemplateColumns.trim().split(/\s+/).length >= row.children.length),
  rows.map((r) => `${r.style.gridTemplateColumns.trim().split(/\s+/).length}/${r.children.length}`).join(' '),
);

/* ---- 主链路：识别 ---- */

console.log('\n识别链路');
check('两个模型都发起了 infer', calls.rpc.filter((c) => c.method === 'msc/infer').length === 2, String(calls.rpc.filter((c) => c.method === 'msc/infer').length));
check('每个模型都发起了 authoritative', calls.rpc.filter((c) => c.method === 'msc/authoritative').length === 2, String(calls.rpc.filter((c) => c.method === 'msc/authoritative').length));
check('rpc 走 /api 通道', calls.rpc.every((c) => c.channel === '/api'));
check('带上了模型名', calls.rpc.some((c) => c.method === 'msc/infer' && c.args?.request?.name === 'anthropic/claude-sonnet-4-5'));
check(
  '第一行标了精确命中',
  (cells[0]?.textContent ?? '').includes('confidenceExact'),
  cells[0]?.textContent?.slice(0, 200),
);
check(
  '第二行标了未识别',
  (cells[1]?.textContent ?? '').includes('confidenceNone'),
  cells[1]?.textContent?.slice(0, 200),
);
check('每行都有「智能匹配」按键', cells.every((cell) => cell.textContent.includes('inlineMatch')), cells.map((c) => c.textContent.includes('inlineMatch')).join(','));

/* ---- 原有模型不被自动改写 ---- */

console.log('\n原有模型不被静默改写');
check(
  '打开编辑器不会自动展开/填入原有模型（保护用户手工配置）',
  doc.querySelector('.zGbnIq_modelAdvanced') === null,
  '原有模型的高级区被展开了',
);
check('没有直接写库', calls.mutate.length === 0, String(calls.mutate.length));

/* ---- 点「智能匹配」：填进官方控件，而不是写库 ---- */
const applyButtons = cells.map((cell) => cell.querySelector('button.dshMscBtnPrimary'));
check('每行都拿到了匹配按钮', applyButtons.every(Boolean), String(applyButtons.length));

await act(async () => {
  applyButtons[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
// fillOfficialRow 会先点官方的展开按钮（下一轮渲染才出高级区），等一个宏任务。
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});
await flush();

const claudeRow = rows[0];
const unknownRow = rows[1];
/**
 * ⚠️ 高级区（上下文 / 最大输出 / 思考等级）是 `div.modelRow` 的**兄弟节点**，
 * 挂在 `div.modelEntry` 下（官方 JSX：`modelEntry > [modelRow, modelAdvanced?]`）。
 * 因此这些字段必须从 `modelEntry` 上查，从 `modelRow` 上查永远是 `undefined`。
 */
const claudeEntry = claudeRow.parentElement;
const unknownEntry = unknownRow.parentElement;

check(
  '第一行（claude）推动了官方的展开按钮',
  claudeRow.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'true',
  claudeRow.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'),
);
check(
  '第一行上下文来自规则表的 200000，而非已解析配置的 1000000',
  claudeEntry.querySelector('input[aria-label^="modelContextWindow"]')?.getAttribute('data-synced') === '200K',
  String(claudeEntry.querySelector('input[aria-label^="modelContextWindow"]')?.getAttribute('data-synced')),
);
check(
  '第一行最大输出字段被填入',
  claudeEntry.querySelector('input[aria-label^="modelMaxTokens"]')?.getAttribute('data-synced') === '64K',
  String(claudeEntry.querySelector('input[aria-label^="modelMaxTokens"]')?.getAttribute('data-synced')),
);
check(
  '第一行思考等级来自规则表（low, medium, high）',
  claudeEntry.querySelector('input[aria-label^="modelReasoningLevels"]')?.getAttribute('data-synced') === 'low, medium, high',
  String(claudeEntry.querySelector('input[aria-label^="modelReasoningLevels"]')?.getAttribute('data-synced')),
);
check(
  '第一行按公开 image 规则开启图像，不受配置默认 text 覆盖',
  claudeRow.querySelector('label.dshModelModalityToggleCompact input')?.checked === true,
  String(claudeRow.querySelector('label.dshModelModalityToggleCompact input')?.checked),
);
check(
  '思考等级写入里没有 off（官方对未知档位做恒等映射，填 off 会得到非法形态）',
  !String(claudeRow.querySelector('input[aria-label^="modelReasoningLevels"]')?.value).includes('off'),
  String(claudeRow.querySelector('input[aria-label^="modelReasoningLevels"]')?.value),
);
check(
  '第一行提示按官方「保存」才生效',
  (cells[0]?.textContent ?? '').includes('inlineNeedSave') || (cells[0]?.textContent ?? '').includes('inlineApplied'),
  cells[0]?.textContent?.slice(0, 200),
);

/* ---- 逐个应用不影响其他行 ---- */

console.log('\n逐个应用不影响其他模型');
check(
  '第二行没有被展开',
  unknownEntry.querySelector('.zGbnIq_modelAdvanced') === null,
  '未识别模型被无谓展开',
);
check(
  '第二行的图像开关没有被改动',
  unknownRow.querySelector('label.dshModelModalityToggleCompact input')?.checked === false,
  String(unknownRow.querySelector('label.dshModelModalityToggleCompact input')?.checked),
);

/* ---- 全程不直接写库 ---- */

console.log('\n全程不直接写库（交给官方「保存」）');
check('没有发出任何 settings.mutate', calls.mutate.length === 0, JSON.stringify(calls.mutate.length));

/* ---- 未识别模型点「智能匹配」也不写错值 ---- */

console.log('\n未识别模型点「智能匹配」');
check(
  '未识别模型的匹配键**不**置灰（点了要给反馈，不能像没反应）',
  applyButtons[1].disabled === false,
  String(applyButtons[1].disabled),
);
await act(async () => {
  applyButtons[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});
await flush();

/**
 * 未识别模型的匹配键点下去后：不写任何值，但**必须给出「无建议可写」的说明**
 * （静默无反应正是用户报的故障）。断言写成「元素不存在 **或** 没有 data-synced」，
 * 免得把「元素压根没渲染」误判成失败（`querySelector` 返回 `null` 时
 * 可选链给出的是 `undefined`，不等于 `null`）。
 */
const unknownContext = unknownEntry.querySelector('input[aria-label^="modelContextWindow"]');
const unknownReasoning = unknownEntry.querySelector('input[aria-label^="modelReasoningLevels"]');

check(
  '未识别模型不会被填入上下文（兜底默认值不算「认出来」）',
  unknownContext === null || unknownContext?.getAttribute('data-synced') === null,
  String(unknownContext?.getAttribute('data-synced')),
);
check(
  '未识别模型不会被填入思考等级',
  unknownReasoning === null || unknownReasoning?.getAttribute('data-synced') === null,
  String(unknownReasoning?.getAttribute('data-synced')),
);
check(
  '★ 未识别的行点键后明说「无建议可写」，而不是静默无反应',
  (cells[1]?.textContent ?? '').includes('inlineNothing'),
  cells[1]?.textContent?.slice(0, 200),
);
check('未识别模型也不写库', calls.mutate.length === 0, JSON.stringify(calls.mutate.length));

/* ---- 折叠后卸掉行内容器 ---- */

console.log('\n收起模型目录');
await act(async () => {
  doc.querySelector('details').removeAttribute('open');
  await Promise.resolve();
});
await flush();

check('收起后行内容器被移除', doc.querySelectorAll('[data-msc-row]').length === 0, String(doc.querySelectorAll('[data-msc-row]').length));
check('收起后槽位仍只有锚点', slotNode.querySelectorAll('[data-msc-anchor]').length === 1);
check('每行的网格轨道恢复为官方原始 4 列', rows.every((row) => row.style.gridTemplateColumns.trim().split(/\s+/).length === 4), rows.map((r) => r.style.gridTemplateColumns.trim().split(/\s+/).length).join(','));

/* ---------------- 结果 ---------------- */

console.log('');
if (failures.length === 0) {
  console.log('全部通过');
  process.exit(0);
}
console.log(`失败 ${failures.length} 项: ${failures.join(', ')}`);
process.exit(1);
