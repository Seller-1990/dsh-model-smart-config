/**
 * 显示位置（v0.3.0「行内化」）的专项测试。
 *
 * 用户原话：虽然模型智能匹配移动到了各API的模型目录，但是他现在和原版的模型列表
 * 是上下放置的关系，很浪费空间，能否直接将智能匹配的结果还有相关按键直接放在
 * 原模型行上。
 *
 * 本文件盯死四条容易做歪的边界，全部用真实 React + jsdom 跑：
 *   ① 未展开模型目录时：槽位里只有 0×0 锚点，**不发任何 RPC**（不占位、不打扰）；
 *   ② 展开后：控件**落在每一条官方模型行内**（`div.modelRow` 的直接子节点），
 *      不再有独立的整块面板；行被显式撑成足够轨道数，保证**不换行**；
 *   ③ 原有模型**不被自动改写**（不能一打开编辑器就把用户手工调过的值冲掉），
 *      但新增的空行 / 新出现的 id **要**自动匹配并填入官方控件；
 *   ④ 点「应用」把结果填进官方控件（图像复选框 + 上下文 + 最大输出 + 思考等级），
 *      **不直接调 settings.mutate**（否则会顶掉官方 draft 的 revision）。
 *
 * 官方行形状（实读 @deepseek-ai/dsh-client-ui-settings-models/lib/client.js）：
 *   div.modelEntry > [ div.modelRow(5 个子件), div.modelAdvanced?(3 个字段) ]
 *   其中第 3 个子件是 `label.dshModelModalityToggleCompact` —— 本插件唯一的行锚点。
 *
 * 跑法：node test/placement.test.mjs
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

/* ---------------- 装载插件（真实 client.js） ---------------- */

const source = readFileSync(path.join(root, 'client.js'), 'utf8');

const failures = [];
function check(name, ok, detail) {
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
}

const loaderCalls = [];
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://127.0.0.1/',
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.__ModuleLoader__ = { load: (spec) => loaderCalls.push(spec) };
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

new Function('window', source)(dom.window);

const spec = loaderCalls[0];
const mod = spec.factory((name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return ReactDOM;
  throw new Error(`unexpected require("${name}")`);
});

/* ---------------- 假宿主 ---------------- */

/** 一张按名字作答的识别表，形状与 Host 半 `msc/infer` 的返回值一致（扁平，无 spec 包装）。 */
const INFER_TABLE = {
  'gpt-4o': {
    raw: 'gpt-4o',
    normalized: 'gpt-4o',
    confidence: 'exact',
    matchedRules: [4],
    vendor: 'openai',
    displayName: 'GPT-4o',
    contextWindow: 128000,
    maxTokens: 16384,
    input: ['text', 'image'],
    reasoningEfforts: false,
    sources: { contextWindow: 'registry', maxTokens: 'registry', input: 'registry', reasoningEfforts: 'registry' },
    notes: {},
    warnings: [],
  },
  hy3: {
    raw: 'hy3',
    normalized: 'hy3',
    confidence: 'exact',
    matchedRules: [160],
    vendor: 'tencent',
    displayName: '混元 Hy3',
    contextWindow: 262144,
    maxTokens: 131072,
    input: ['text'],
    reasoningEfforts: { off: null, low: 'low', high: 'high' },
    sources: { contextWindow: 'registry', maxTokens: 'registry', input: 'registry', reasoningEfforts: 'registry' },
    notes: {},
    warnings: [],
  },
  /**
   * 用于「获取 model → 采纳候选」那条路径：官方 `adoptPicked()` 会把新候选**带着
   * 非空 id 一次性**追加进 `models`（不像手动「添加模型」是先来一个空行）。
   * 所以这条路径不会经过 `onCardInput`，只能靠 `sync()` 发现新行。
   */
  'mimo-v2.6-pro': {
    raw: 'mimo-v2.6-pro',
    normalized: 'mimo-v2.6-pro',
    confidence: 'exact',
    matchedRules: [170],
    vendor: 'xiaomi',
    displayName: 'MiMo v2.6 Pro',
    contextWindow: 1048576,
    maxTokens: 131072,
    input: ['text', 'image'],
    // 非推理模型：官方控件表达不了字面 false，插件应把思考字段清空。
    reasoningEfforts: false,
    sources: { contextWindow: 'registry', maxTokens: 'registry', input: 'registry', reasoningEfforts: 'registry' },
    notes: {},
    warnings: [],
  },
  /** 未识别：**连 input / reasoningEfforts 两个键都不存在**（Host 半 compact 掉 undefined）。 */
  'zzz-unknown-model': {
    raw: 'zzz-unknown-model',
    normalized: 'zzz-unknown-model',
    confidence: 'none',
    matchedRules: [],
    vendor: 'unknown',
    contextWindow: 262144,
    maxTokens: 32768,
    extraInputs: [],
    sources: { contextWindow: 'registry', maxTokens: 'registry', input: 'unknown', reasoningEfforts: 'unknown' },
    notes: {},
    warnings: [],
  },
};

function makeFakeCtx() {
  const calls = { rpc: [], mutate: [] };
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    locale: { register: () => () => {} },
    slots: {
      captured: null,
      inject(_key, callback) {
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
              calls.rpc.push({ channel, method, payload });
              if (method === 'msc/infer') {
                const name = payload?.args?.request?.name;
                const hit = INFER_TABLE[name];
                if (!hit) return { ok: false, error: { message: 'UNKNOWN_MODEL' } };
                return { ok: true, value: hit };
              }
              if (method === 'msc/authoritative') {
                return { ok: true, value: { found: false, reason: 'UNKNOWN_MODEL' } };
              }
              return { ok: false, error: { message: 'UNEXPECTED' } };
            },
          },
        };
      }
      throw new Error(`unexpected ctx.get("${name}")`);
    },
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
                value: {
                  providers: {
                    rowA: {
                      displayName: 'A 网关',
                      api: 'openai-completions',
                      baseURL: 'https://a.example/v1',
                      models: [{ id: 'gpt-4o' }],
                    },
                  },
                },
              },
              { ns: 'model-smart-config', revision: 3, value: { enabled: true, allowProbe: false } },
            ],
          },
        }),
        // v0.3.0 的 Client 半**不应**直接写库；这里故意留一个会记账的实现来验证它没被调用。
        mutate: async (...args) => {
          calls.mutate.push(args);
          return { ok: true, value: { ns: 'llm-pi-ai', revision: 8 } };
        },
      },
    },
  };
  return { ctx, calls };
}

const { ctx: fakeCtx, calls } = makeFakeCtx();
mod.apply(fakeCtx);
const Card = fakeCtx.slots.captured.component;
const injected = fakeCtx.slots.captured.options.inject();
const t = (key) => key;

function providerOf(row) {
  return {
    provider: row,
    displayName: row,
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', row],
    active: true,
    declared: true,
  };
}

/* ---------------- 官方模型行的复刻 ---------------- */

/**
 * 复刻 `ModelListEditor` 的一行：
 *   div.modelEntry > [ div.modelRow(5 子件), div.modelAdvanced ]
 * 子件顺序与官方 JSX 完全一致：id input / name input / compact toggle / 展开 / 删除。
 */
function modelRowHtml(id, name) {
  return `
    <div class="zGbnIq_modelEntry">
      <div class="zGbnIq_modelRow" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto auto">
        <input class="zGbnIq_input" type="text" value="${id}" placeholder="modelId" aria-label="modelId 1">
        <input class="zGbnIq_input" type="text" value="${name}" placeholder="modelName" aria-label="modelName 1">
        <label class="dshModelModalityToggle dshModelModalityToggleCompact">
          <input type="checkbox" aria-label="modelImageInput 1">
          <span class="dshModelModalityCopy"><span class="dshModelModalityTitle">图像</span></span>
        </label>
        <button type="button" class="zGbnIq_iconButton" aria-label="modelAdvanced 1" aria-expanded="false" title="modelAdvanced"></button>
        <button type="button" class="zGbnIq_iconButton zGbnIq_iconButtonDanger" aria-label="removeModel 1" title="removeModel"></button>
      </div>
    </div>`;
}

/** 展开后的高级区（官方点展开按钮后才有）。 */
const ADVANCED_HTML = `
  <div class="zGbnIq_modelAdvanced">
    <label class="zGbnIq_modelField"><span class="zGbnIq_modelFieldLabel">上下文</span>
      <input class="zGbnIq_input" type="text" value="" placeholder="256K" aria-label="modelContextWindow 1"></label>
    <label class="zGbnIq_modelField"><span class="zGbnIq_modelFieldLabel">最大输出</span>
      <input class="zGbnIq_input" type="text" value="" placeholder="32K" aria-label="modelMaxTokens 1"></label>
    <div class="dshModelReasoningField">
      <label class="zGbnIq_modelField"><span class="zGbnIq_modelFieldLabel">思考等级</span>
        <input class="zGbnIq_input" type="text" value="" placeholder="low, high" aria-label="modelReasoningLevels 1">
        <span class="dshModelReasoningHint">逗号分隔</span></label>
    </div>
  </div>`;

/**
 * 复刻官方「展开」按钮的 React 行为：真的把高级区插进 modelEntry。
 * 假宿主里没有 React，所以用原生监听模拟官方 `toggleExpanded(index)`。
 */
function wireExpandButton(rowEl) {
  const button = rowEl.querySelector('button[aria-expanded]');
  const entry = rowEl.parentElement;
  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') === 'true';
    if (open) {
      button.setAttribute('aria-expanded', 'false');
      const advanced = entry.querySelector('.zGbnIq_modelAdvanced');
      if (advanced) advanced.remove();
      return;
    }
    button.setAttribute('aria-expanded', 'true');
    const holder = dom.window.document.createElement('div');
    holder.innerHTML = ADVANCED_HTML;
    entry.appendChild(holder.firstElementChild);
  });
}

/**
 * 复刻官方受控 input 的 React 行为：React 监听的是原生 `input` 事件，
 * 通过 el.value 直接赋值不会触发。这里挂一个监听把 DOM 值同步进「模型状态」，
 * 这样测试才能验证插件**真的**把值写进了官方控件。
 */
function wireControlledInputs(rootEl) {
  rootEl.addEventListener('input', (event) => {
    const el = event.target;
    if (el && el.tagName === 'INPUT') el.setAttribute('data-synced', el.value);
  });
}

/* ---------------- 场景搭建 ---------------- */

const doc = dom.window.document;

const editorHtml = `
  <div class="editor">
    <details class="customized">
      <summary>自定义设置</summary>
      <div class="customizedBody">
        <section class="dshModelCatalogSearch">模型目录</section>
        <div class="modelList">
          ${modelRowHtml('gpt-4o', 'GPT-4o')}
        </div>
      </div>
    </details>
  </div>`;

doc.body.innerHTML = `
  <div id="root">
    <ul id="rows">
      <li id="rowA" class="rowCard">
        <div class="rowHead">A</div>
        <div id="slotA"></div>
        ${editorHtml}
      </li>
    </ul>
  </div>`;

wireControlledInputs(doc.getElementById('rowA'));

const rootA = createRoot(doc.getElementById('slotA'));

async function flush() {
  // Checkbox verification and advanced-field expansion each use a macrotask.
  // Commit React between phases so assertions observe the completed match.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/* ---- ① 未展开：只有锚点，不发 RPC ---- */

console.log('\n场景 ① 模型目录未展开');
await act(async () => {
  rootA.render(React.createElement(Card, { provider: providerOf('rowA'), ...injected, t }));
});
await flush();

const slotA = doc.getElementById('slotA');
check('槽位里只有隐藏锚点', slotA.querySelectorAll('[data-msc-anchor]').length === 1, slotA.innerHTML.slice(0, 160));
check('未展开时没有行内容器', doc.querySelectorAll('[data-msc-row]').length === 0, String(doc.querySelectorAll('[data-msc-row]').length));
check('未展开时不发任何 RPC', calls.rpc.length === 0, JSON.stringify(calls.rpc.map((c) => c.method)));

/* ---- ② 展开后：行内容器落在官方模型行里 ---- */

console.log('\n场景 ② 展开模型目录');
const detailsA = doc.querySelector('#rowA details');
await act(async () => {
  detailsA.setAttribute('open', '');
  await Promise.resolve();
});
await flush();

const rowEl = doc.querySelector('.zGbnIq_modelRow');
const cell = rowEl.querySelector('[data-msc-row]');
check('出现了行内容器', cell !== null);
check(
  '容器是官方模型行的直接子节点（行内化，不再上下堆叠）',
  cell !== null && cell.parentElement === rowEl,
  cell === null ? '无容器' : String(cell.parentElement?.className),
);
check(
  '容器不是 `<details>` 的直接子节点（v0.2.0 的整块面板已撤掉）',
  doc.querySelector('details > [data-msc-row]') === null,
  String(doc.querySelectorAll('details > [data-msc-row]').length),
);
check('展开后开始识别（发了 infer）', calls.rpc.some((c) => c.method === 'msc/infer'), JSON.stringify(calls.rpc.map((c) => c.method)));
check('容器里渲染出了识别结果', (cell?.textContent ?? '').includes('confidenceExact'), cell?.textContent?.slice(0, 120));

/* ---- ③ 行网格被显式撑开（不换行 ⇒ 不额外占纵向空间） ---- */

console.log('\n场景 ③ 行网格轨道数（多出的格子不换行）');
const tracks = rowEl.style.gridTemplateColumns.trim().split(/\s+/);
check(
  '轨道数 ≥ 子节点数（否则多出的格子会换到第二行）',
  tracks.length >= rowEl.children.length,
  `tracks=${tracks.length} children=${rowEl.children.length} [${rowEl.style.gridTemplateColumns}]`,
);
check(
  '前两条仍是弹性轨道（保留官方两个输入框的伸缩比例）',
  tracks[0].startsWith('minmax(0,1.2fr)') && tracks[1].startsWith('minmax(0,1fr)'),
  rowEl.style.gridTemplateColumns,
);

/* ---- ④ 原有模型不被自动改写 ---- */

console.log('\n场景 ④ 原有模型不被静默改写');
check(
  '打开编辑器不会自动填入原有模型（保护用户手工配置）',
  detailsA.querySelector('input[aria-label="modelContextWindow 1"]') === null,
  '原有模型的高级区被展开了',
);
check('没有直接写库（不碰官方 draft 的 revision）', calls.mutate.length === 0, JSON.stringify(calls.mutate.length));

/* ---- ⑤ 新增模型：空行也有「智能匹配」键，且点它才填 ---- */

console.log('\n场景 ⑤ 新增模型（点「添加模型」后的空行）');
const list = doc.querySelector('#rowA .modelList');
const freshRow = doc.createElement('div');
freshRow.innerHTML = modelRowHtml('', '');
list.appendChild(freshRow.firstElementChild);
wireControlledInputs(list);

// 官方「添加模型」先给一个 id 为空的空行 —— 用户要的「有个智能匹配键」就是这一行。
await flush();
const newRow = doc.querySelectorAll('.zGbnIq_modelRow')[1];
wireExpandButton(newRow);
const freshCell = newRow.querySelector('[data-msc-row]');
check(
  '★ 空行（id 为空）也有插件控件 —— 这是 v0.3.0 缺失的按键',
  freshCell !== null,
  freshCell === null ? '无控件' : 'ok',
);
check(
  '★ 空行上挂着「智能匹配」按键（用户要的那个键）',
  (freshCell?.textContent ?? '').includes('inlineMatch'),
  freshCell?.textContent?.slice(0, 160),
);
check(
  '空行徽标显示「待填 ID」',
  (freshCell?.textContent ?? '').includes('inlineEmpty'),
  freshCell?.textContent?.slice(0, 160),
);

// 空行直接点键：必须给出原因，不能像没反应。
const rpcBeforeEmptyClick = calls.rpc.length;
const emptyButton = freshCell.querySelector('button');
await act(async () => {
  emptyButton.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await Promise.resolve();
});
await flush();
check(
  '★ 空行点键给出「先填 ID」而不是静默无反应',
  String(newRow.querySelector('[data-msc-row]')?.textContent ?? '').includes('inlineNeedId'),
  newRow.querySelector('[data-msc-row]')?.textContent?.slice(0, 160),
);
check(
  '空行点键不会发无谓的识别请求',
  calls.rpc.length === rpcBeforeEmptyClick,
  `${rpcBeforeEmptyClick} -> ${calls.rpc.length}`,
);

// 模拟用户在新行的 id 输入框里敲入 hy3（官方 onChange → React 状态）。
const idInput = newRow.querySelectorAll('input[type="text"]')[0];
await act(async () => {
  idInput.value = 'hy3';
  idInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await Promise.resolve();
});
await flush();

// 识别有 450ms 防抖。
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 600));
});
await flush();
await flush();

check(
  '新行的 id 变化触发了识别',
  calls.rpc.some((c) => c.method === 'msc/infer' && c.payload?.args?.request?.name === 'hy3'),
  JSON.stringify(calls.rpc.filter((c) => c.method === 'msc/infer').map((c) => c.payload?.args?.request?.name)),
);
check(
  '★ 光敲 id **不**自动填值（用户要先自己看、自己决定）',
  doc.querySelector('input[aria-label="modelContextWindow 1"]') === null,
  '高级区被自动展开了',
);

// ★ 用户点「智能匹配」—— 这才是唯一的填值入口。
const matchButton = newRow.querySelector('[data-msc-row] button');
await act(async () => {
  matchButton.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await Promise.resolve();
});
// 填值前官方要先展开高级区（`expandRow` 内部一次 `setTimeout(0)`），
// 必须放行真实定时器，不能只 `await Promise.resolve()`。
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
});
await flush();
await flush();

check(
  '★ 点键后上下文被填入官方字段',
  doc.querySelector('input[aria-label="modelContextWindow 1"]')?.getAttribute('data-synced') === '262144',
  String(doc.querySelector('input[aria-label="modelContextWindow 1"]')?.value),
);
check(
  '★ 点键后最大输出被填入官方字段',
  doc.querySelector('input[aria-label="modelMaxTokens 1"]')?.getAttribute('data-synced') === '131072',
  String(doc.querySelector('input[aria-label="modelMaxTokens 1"]')?.value),
);
check(
  '★ 点键后思考等级被填入（只填非 off 档）',
  doc.querySelector('input[aria-label="modelReasoningLevels 1"]')?.getAttribute('data-synced') === 'low, high',
  String(doc.querySelector('input[aria-label="modelReasoningLevels 1"]')?.value),
);
check(
  '点键后标记了「已匹配并填入」',
  String(newRow.querySelector('[data-msc-row]')?.textContent ?? '').includes('inlineMatched'),
  newRow.querySelector('[data-msc-row]')?.textContent?.slice(0, 160),
);
check('点键填值走官方控件，仍然不直接写库', calls.mutate.length === 0, JSON.stringify(calls.mutate.length));

/* ---- ⑤a′ 行内空间预算护栏（v0.3.2，永久）------------------------------------
 *
 * 用户 报障：点键后追加的提示文案，把官方 id 输入框从 97px 挤到 20px，
 * 整行前部看不见。根因是**长度不受控的文本进了行内流**（官方行最后一格是
 * `auto` 轨道，其 min-content = 内容宽度，会把两条 `…fr` 轨道压到 0）。
 *
 * jsdom 没有排版，量不了像素 —— 那就把**产生像素的那个原因**钉死：
 * 「行内不允许出现长文本，长文本只能待在绝对定位的弹层里」。
 * 这条断言比量宽度更稳：它拦的是错误本身，而不是错误在某个宽度下的表现。
 */
const budgetCell = newRow.querySelector('[data-msc-row] .dshMscCell');
const budgetPop = budgetCell?.querySelector('.dshMscDetail') ?? null;
const budgetInline = (budgetCell?.textContent ?? '').replace(budgetPop?.textContent ?? '', '').trim();
// 注意：本 jsdom 宿主给的 `t` 是恒等函数（key 原样返回），所以不能拿「字符数」
// 当判据 —— 那量到的是 key 名，不是真机上的中文。判据改为不看长度、只看**内容**：
// 用户报障的那几个状态句，一个字都不许出现在行内流里。
const SUFFIX_KEYS = [
  'inlineMatched',
  'inlineEdited',
  'inlineAutoDone',
  'inlineAutoPartial',
  'inlineApplied',
  'inlineNeedSave',
  'inlineNothing',
  'inlineNeedId',
];
check(
  '★ 空间预算：状态句 / 提示句一个字都不在行内流里（改动前它们全在行内，24 字）',
  budgetInline.length > 0 && !SUFFIX_KEYS.some((key) => budgetInline.includes(key)) && !budgetInline.includes(' · '),
  JSON.stringify(budgetInline),
);
check(
  '★ 空间预算：行内只由「徽标 + 记号 + 主键」构成（≤3 个承载文字的元素）',
  [...(budgetCell?.querySelectorAll('*') ?? [])].filter(
    (el) =>
      !el.closest('.dshMscDetail') &&
      (el.textContent ?? '').trim().length > 0 &&
      ![...el.children].some((child) => (child.textContent ?? '').trim().length > 0),
  ).length <= 3,
  String(budgetCell?.querySelectorAll('*').length),
);
check(
  '★ 空间预算：状态说明确实搬进了绝对定位的弹层（0 宽度）',
  (budgetPop?.textContent ?? '').includes('inlineMatched'),
  JSON.stringify((budgetPop?.textContent ?? '').slice(0, 60)),
);
check(
  '★ 空间预算：「已填入」用一个字宽的记号表达',
  budgetCell?.querySelector('.dshMscMark')?.textContent === '✓',
  String(budgetCell?.querySelector('.dshMscMark')?.textContent),
);
const budgetStyle = doc.querySelector('style[data-plugin-css="model-smart-config/inline"]');
check(
  '★ 空间预算：样式表里不再有「无宽度上限的行内文本」类（`.dshMscNote`）',
  budgetStyle !== null && !String(budgetStyle.textContent).includes('.dshMscNote'),
);
check(
  '★ 空间预算：徽标有硬上限 + 省略号（再长的状态词也撑不宽这一格）',
  String(budgetStyle?.textContent ?? '').includes('.dshMscBadge{') &&
    /\.dshMscBadge\{[^}]*max-width:64px[^}]*text-overflow:ellipsis/.test(String(budgetStyle?.textContent ?? '')),
);
// 「测试」键压成图标位（本宿主可能关掉了探测，故只要求：除主键外不许有文字）。
const budgetBtns = budgetCell ? [...budgetCell.querySelectorAll('button')] : [];
check(
  '★ 空间预算：除主键外，按钮只能是图标位（无文字），文案走 aria-label / title',
  budgetBtns.length >= 1 &&
    budgetBtns.slice(1).every((b) => (b.textContent ?? '') === '' && !!b.getAttribute('aria-label') && !!b.getAttribute('title')),
  JSON.stringify(budgetBtns.map((b) => ({ t: b.textContent, a: b.getAttribute('aria-label') }))),
);

/* ---- ⑤b 填完之后用户可以手改，且不会被插件覆盖 ---- */

console.log('\n场景 ⑤b 填入后手动修改不被覆盖（用户报障第二条）');
const ctxEl = doc.querySelector('input[aria-label="modelContextWindow 1"]');
const reasonEl = doc.querySelector('input[aria-label="modelReasoningLevels 1"]');
// 用户亲手改：上下文 262144 → 777K，思考等级 low, high → low。
await act(async () => {
  ctxEl.value = '777K';
  ctxEl.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  reasonEl.value = 'low';
  reasonEl.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await Promise.resolve();
});
await flush();
check('用户手改上下文生效', ctxEl.getAttribute('data-synced') === '777K', String(ctxEl.getAttribute('data-synced')));
check('用户手改思考等级生效', reasonEl.getAttribute('data-synced') === 'low', String(reasonEl.getAttribute('data-synced')));
check(
  '高级区（行的兄弟节点）的手改也能被登记，并标注「已按你的修改保留」',
  String(newRow.querySelector('[data-msc-row]')?.textContent ?? '').includes('inlineEdited'),
  newRow.querySelector('[data-msc-row]')?.textContent?.slice(0, 200),
);

// 用户接着微调 id（v0.3.0 在这里把两个手改值全抹了）。
await act(async () => {
  idInput.value = 'hy3-preview';
  idInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await Promise.resolve();
});
await flush();
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 600));
});
await flush();
await flush();

check(
  '★ 改 id 后用户手改的上下文**保持不动**（v0.3.0 会被覆盖回 262144）',
  doc.querySelector('input[aria-label="modelContextWindow 1"]')?.value === '777K',
  String(doc.querySelector('input[aria-label="modelContextWindow 1"]')?.value),
);
check(
  '★ 改 id 后用户手改的思考等级**保持不动**',
  doc.querySelector('input[aria-label="modelReasoningLevels 1"]')?.value === 'low',
  String(doc.querySelector('input[aria-label="modelReasoningLevels 1"]')?.value),
);

// 用户再显式点「智能匹配」＝ 覆盖意图；id 改回可识别的 hy3，这次应当重新填。
await act(async () => {
  idInput.value = 'hy3';
  idInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await Promise.resolve();
});
await flush();
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 600));
});
await flush();
check(
  '改回可识别 id 后，手改值**仍然**没被自动覆盖',
  doc.querySelector('input[aria-label="modelContextWindow 1"]')?.value === '777K',
  String(doc.querySelector('input[aria-label="modelContextWindow 1"]')?.value),
);

await act(async () => {
  newRow.querySelector('[data-msc-row] button').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await Promise.resolve();
});
await flush();
await flush();
check(
  '★ 再点一次「智能匹配」＝ 显式覆盖，重新填入插件值',
  doc.querySelector('input[aria-label="modelContextWindow 1"]')?.value === '262144',
  String(doc.querySelector('input[aria-label="modelContextWindow 1"]')?.value),
);
check(
  '★ 显式覆盖后思考等级也重新填回',
  doc.querySelector('input[aria-label="modelReasoningLevels 1"]')?.value === 'low, high',
  String(doc.querySelector('input[aria-label="modelReasoningLevels 1"]')?.value),
);

/* ---- ⑥ 未识别的新模型：什么都不填（不静默写错值） ---- */

console.log('\n场景 ⑥ 未识别的新模型不写任何值');
const unknownRow = doc.createElement('div');
unknownRow.innerHTML = modelRowHtml('', '');
list.appendChild(unknownRow.firstElementChild);
wireControlledInputs(list);

const unknownEl = doc.querySelectorAll('.zGbnIq_modelRow')[2];
wireExpandButton(unknownEl);
const unknownInput = unknownEl.querySelectorAll('input[type="text"]')[0];
// 先把上一个 hy3 行的自动匹配结果记下来，方便对比。
const contextBefore = doc.querySelector('input[aria-label="modelContextWindow 1"]')?.value;
await act(async () => {
  unknownInput.value = 'zzz-unknown-model';
  unknownInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await Promise.resolve();
});
await flush();
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 600));
});
await flush();

check(
  '未识别时**不**自动展开高级区（没有可写的值就不打扰）',
  unknownEl.parentElement.querySelector('.zGbnIq_modelAdvanced') === null,
  '高级区被无谓展开了',
);
check(
  '未识别时没有改动已有的值',
  doc.querySelector('input[aria-label="modelContextWindow 1"]')?.value === contextBefore,
  `${contextBefore} -> ${doc.querySelector('input[aria-label="modelContextWindow 1"]')?.value}`,
);
check(
  '未识别时徽标显示「无命中」（只识别，不写任何值）',
  (unknownEl.querySelector('[data-msc-row]')?.textContent ?? '').includes('confidenceNone'),
  unknownEl.querySelector('[data-msc-row]')?.textContent?.slice(0, 160),
);
check(
  '仍然没有直接写库',
  calls.mutate.length === 0,
  JSON.stringify(calls.mutate.length),
);

/* ---- ⑦ 新增模型（官方「获取 model → 采纳候选」路径：一次性追加带 id 的行） ---- */

/**
 * 这条路径与场景 ⑤ 不同，是**另一条官方写入通路**：
 *   `adoptPicked()` 会把勾选的候选 `byId.set(candidate.id, adopt(candidate))` 后
 *   一次性 `onChange([...byId.values()])` —— 新行**出生就带非空 id**，
 *   全程没有任何 `input` 事件，所以 `onCardInput` 永远不会被触发。
 * 只有 `sync()`（MutationObserver 发现新行）能兜住它。这条分支此前零覆盖。
 */
console.log('\n场景 ⑦ 新增模型（「获取 model」采纳路径：一次追加带 id 的行）');
const adoptHolder = doc.createElement('div');
adoptHolder.innerHTML = modelRowHtml('mimo-v2.6-pro', 'MiMo v2.6 Pro');
const adoptEl = adoptHolder.firstElementChild;
list.appendChild(adoptEl);
wireControlledInputs(list);
const adoptRow = adoptEl.querySelector('.zGbnIq_modelRow');
const adoptEntry = adoptEl;
wireExpandButton(adoptRow);

const rpcBeforeAdopt = calls.rpc.length;
// 注意：**不**派发任何 input 事件 —— 这正是与场景 ⑤ 的关键差异。
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 600));
});
await flush();
await flush();

check(
  '带 id 的新行被 sync 发现并触发识别（没靠 input 事件）',
  calls.rpc
    .slice(rpcBeforeAdopt)
    .some((c) => c.method === 'msc/infer' && c.payload?.args?.request?.name === 'mimo-v2.6-pro'),
  JSON.stringify(
    calls.rpc
      .slice(rpcBeforeAdopt)
      .filter((c) => c.method === 'msc/infer')
      .map((c) => c.payload?.args?.request?.name),
  ),
);
check(
  '带 id 的新行拿到了自己的行内容器',
  adoptRow.querySelector('[data-msc-row]') !== null,
  adoptRow.innerHTML.slice(0, 120),
);
check(
  '采纳路径同样**不**自动填值（新行只识别）',
  adoptEntry.querySelector('input[aria-label="modelContextWindow 1"]') === null,
  '高级区被自动展开了',
);

// 点键 → 填值。填值前官方要先展开高级区（`expandRow` 内部一次 `setTimeout(0)`），
// 所以这里必须放行真实定时器，不能只 `await Promise.resolve()`。
await act(async () => {
  adoptRow.querySelector('[data-msc-row] button')?.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await Promise.resolve();
});
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
});
await flush();
await flush();
check(
  '采纳路径点键后填入官方「上下文」（1048576 不整千 → 原样写）',
  adoptEntry.querySelector('input[aria-label="modelContextWindow 1"]')?.getAttribute('data-synced') === '1048576',
  String(adoptEntry.querySelector('input[aria-label="modelContextWindow 1"]')?.value),
);
check(
  '采纳路径点键后填入官方「最大输出」',
  adoptEntry.querySelector('input[aria-label="modelMaxTokens 1"]')?.getAttribute('data-synced') === '131072',
  String(adoptEntry.querySelector('input[aria-label="modelMaxTokens 1"]')?.value),
);
check(
  '非推理模型（reasoningEfforts === false）把思考等级清空，而不是乱填档位',
  adoptEntry.querySelector('input[aria-label="modelReasoningLevels 1"]')?.getAttribute('data-synced') === '',
  JSON.stringify(adoptEntry.querySelector('input[aria-label="modelReasoningLevels 1"]')?.value),
);
check(
  '采纳路径点键后打开了行内图像开关',
  adoptRow.querySelector('label.dshModelModalityToggleCompact input[type="checkbox"]')?.checked === true,
  String(adoptRow.querySelector('label.dshModelModalityToggleCompact input[type="checkbox"]')?.checked),
);
check(
  '采纳路径的行标了「已匹配并填入」',
  String(adoptRow.querySelector('[data-msc-row]')?.textContent ?? '').includes('inlineMatched'),
  adoptRow.querySelector('[data-msc-row]')?.textContent?.slice(0, 160),
);
check('采纳路径仍然没有直接写库', calls.mutate.length === 0, JSON.stringify(calls.mutate.length));

/* ---- ⑧ 收起后：卸掉行内容器 ---- */

console.log('\n场景 ⑧ 收起模型目录');
await act(async () => {
  detailsA.removeAttribute('open');
  await Promise.resolve();
});
await flush();

check('收起后行内容器被移除', doc.querySelectorAll('[data-msc-row]').length === 0, String(doc.querySelectorAll('[data-msc-row]').length));
check('收起后槽位仍只有锚点', slotA.querySelectorAll('[data-msc-anchor]').length === 1);
check('卸载不残留行内容器', rowEl.querySelectorAll('[data-msc-row]').length === 0);

/* ---------------- 结果 ---------------- */

console.log('');
if (failures.length === 0) {
  console.log('全部通过');
  process.exit(0);
}
console.log(`失败 ${failures.length} 项: ${failures.join(', ')}`);
process.exit(1);
