# 02 · 插件架构与实现方案

> 插件名：`dsh-model-smart-config`
> 形态：**UI 插件**（Host 半 + Client 半双入口），挂载点为官方 Models 页的 keyed slot。
> 交互形态：**混合**（能自动取的直接写；取不到的给候选让用户确认）—— 用户已拍板。

---

## 1. 总体架构

```dsh-ui
{"title":"插件在 DSH 中的位置","gap":14,"items":[{"type":"diagram","kind":"architecture","nodes":[{"id":"page","label":"官方 Models 页\nsettings.section(models)"},{"id":"slot","label":"keyed slot\nsettings.models.provider-card"},{"id":"card","label":"SmartConfigInline\n(本插件 Client 半，v0.3.0 行内)"},{"id":"rpc","label":"connection.rpc.call\n/api/msc/*"},{"id":"host","label":"本插件 Host 半\nTypertRemoteService"},{"id":"llm","label":"ctx.llm\nresolveModelInfo"},{"id":"probe","label":"自建 GET {baseURL}/models"},{"id":"fill","label":"填入官方行控件\n(不再直接写库)"}]},{"type":"text","content":"插件只做三件事：**探测**（拿能力）、**推断**（补思考等级）、**填入**（写进官方行控件，由官方「保存」落库）。不碰任何配置文件。"}]}
```

数据流（**识别是入口** —— 不认出模型身份，就判不出能力标签）：

1. 用户在官方 Models 页配置某 provider（填 url / key / model）。
2. 本插件在 provider 行旁渲染一张卡片（keyed slot，key = `settingsNs`）。
3. 用户点「智能配置」→ Client 半调 `discoverModels` 拿基础候选
   （`{id, name, contextWindow, maxTokens, inputModalities?}`）。
4. Client 半再调**本插件 Host 半**的 `/api/msc/infer`，把
   `{baseURL, api, apiKeyRef, models[]}` 交给宿主。
5. Host 半执行**三级推断链**（见 [`03-inference-rules.md`](03-inference-rules.md)）：

   ```
   ① 模型识别   归一化模型名 → 有序正则规则匹配 → 分层覆盖合并（BASE ← MODEL ← SITE）
   ② 规格取值   命中即取：多模态 ← 公开信息；思考等级 ← 官方文档条目（表内带 source）
   ③ 兜底       未命中 → 端点元数据补数值 → 可选实测探测 → 名称启发式给候选（不自动写）
   ```

6. 结果回到卡片，**每项标注来源**（`公开信息` / `端点返回` / `官方文档` / `实测` / `未识别`）。
   **v0.3.0 起这个动作只把值填进官方控件，不直接写库**；**v0.3.1 起写值入口收敛为
   用户点行内「智能匹配」键**（敲完 id 只识别、不写值；手改过的字段不会被回写）——
   由用户按该 API 卡片自带的「保存」触发官方 `pathOps` → `settings.mutate` 落库（见 §4 的 ⚠️）。
7. 全程不出现密钥明文，不改 `cordis.patch.yml`。

> **为什么识别是必需的前置**：官方探测链路的 `readListing(body)` 实测只产出
> `{id, name, contextWindow?, maxTokens?}` 四个字段，**根本不解析模态与推理字段**
> （`inputModalities` 在 `readListing` 里一次都没出现）。
> 数值可以从端点拿，但能力标签只能靠「这个模型是谁」来判断。

---

## 2. 包结构

```
dsh-model-smart-config/
├── package.json              # dsh.bundle.patch + dsh.client
├── cordis.patch.yml          # 插件自带的 profile 行片段
├── index.js                  # Host 半（ESM，export function apply）
├── client.js                 # Client 半（window.__ModuleLoader__.load 工厂）
├── data/
│   └── model-rules.js        # ★ 模型规格规则表（有序正则 + 分层覆盖，照 zcode 范式；整层可替换）
├── rules/
│   ├── normalize.js          # 模型名归一化（纯函数，不剥日期后缀）+ ALIASES 别名表应用
│   ├── match.js              # 有序正则匹配 + 分层覆盖合并（BASE ← MODEL ← SITE）
│   └── infer.js              # 多模态/思考等级判定 + reasoningEfforts 合法性校验
├── locale/
│   ├── zh.json               # 界面文案（中文）
│   └── en.json               # 界面文案（英文）
├── icon.svg                  # 插件图标（≤256KiB）
├── README.md
├── docs/                     # 本方案文档（01–07）
└── test/
    ├── rules.test.mjs        # 推断规则纯函数单测（无需 DSH 运行）
    ├── render.test.mjs       # 真实 react-dom/server 渲染槽位（SSR 首屏必须是孤儿锚点）
    ├── placement.test.mjs    # 行内挂载专项（jsdom）：九场景（含 ⑤b 手改保护）
    └── interaction.test.mjs  # jsdom + React 全链路：填官方控件、零写库
```

**v0.3.0 的行内化怎么落**：槽位（keyed `key='llm-pi-ai'`）内只渲染一个 0×0 锚点；
`MutationObserver` 盯住本 provider 卡片，编辑器展开后**给每一条官方模型行**建立一个容器，
再用 `createPortal` 把 `RowChip`（状态徽标 + 应用 + 测试）渲染进各自的行。
行定位靠**无构建哈希的稳定字面类名** `label.dshModelModalityToggleCompact`
（`data-plugin-css` 注入，每行恰好一个，`parentElement` 即 `div.modelRow`）；
不硬编码任何 `zGbnIq_*` / `qy-_KG_*` 这类 CSS-module 哈希类名。
因为官方行网格只有 4 条轨道、装上第 6 个格子会换行，插件用 `widenRow()` 显式重写
`rowEl.style.gridTemplateColumns`（并把原值记进 `data-msc-grid`，卸载时 `unwidenRow()` 还原）。

**为什么注册表是「规则表」而不是「名表」**：照 zcode `modelConfigRules` 的范式
（证据与原文见 [`03-inference-rules.md`](03-inference-rules.md) §2）。
`glm-5.3-flash` 这类名字要同时继承 `glm-5`（容量）、`glm-5.3`（等级档位）、
`glm-5.3-flash`（多模态）三层信息 —— **扁平名表表达不了这种增量覆盖**。

### 2.1 `package.json`

```json
{
  "name": "dsh-model-smart-config",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Smart model capability configuration for third-party API providers",
  "icon": "./icon.svg",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-settings-models"]
    }
  }
}
```

**要点**
- `dsh.bundle.patch` 指向插件自带片段；安装时由插件管理器把该片段合并进 profile，**不手写 profile**。
  （本机 `plugin_manager` 工具与 `dsh` CLI 都不可用，实际安装通道是**用户在 GUI 插件管理器粘贴本包绝对路径**，
  见 [`../README.md`](../README.md) 的「安装」小节。）
- `dsh.client.immediately: true` —— 页面加载即激活，不必等用户进设置页。
- `inject` 只列官方 Models 页包，用于排序（保证 slot 已被声明）。

### 2.2 `cordis.patch.yml`

```yaml
- insert:
    - id: model-smart-config
      name: 'dsh-model-smart-config'
      config:
        enabled: true
        autoApplyContext: true
        autoApplyModality: true
        autoApplyReasoning: true
        allowProbe: true
```

`config` 里的字段即插件 `Config` schema 的键。**用户可在自己的 profile patch 层覆盖这些值，升级后依然存活。**

### 2.3 Host 半 `index.js`

```js
import z from '@deepseek-ai/schemastery';
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  autoApplyContext: z.boolean().default(true).volatile(),
  autoApplyModality: z.boolean().default(true).volatile(),
  autoApplyReasoning: z.boolean().default(true).volatile(),
  allowProbe: z.boolean().default(true).volatile()
});

export function apply(ctx, rawConfig) {
  ctx.inject(['typert'], (tctx) => {
    try {
      tctx.typert.register(contribution());
    } catch (error) {
      if (!String(error?.message).includes('already registered')) throw error;
    }
  });
}
```

> **每个字段都必须 `.volatile()`**：Loader 把编辑提交进**运行中 fiber 的引用**而不重挂，
> 所以 `apply` 收到的是 `{ get() }` 引用，每次读都要 `unwrap`。
> 有 ≥1 个 volatile 字段的条目才会出现在 `settings.describe()` 里，因而能在插件管理页直接改。
> `RemoteError` / `TypertRemoteService` 都来自 `@deepseek-ai/dsh-typert-protocol`
> （不是 `-registry`，registry 只提供 `ctx.typert` 服务本身）。

Remote 贡献（照抄 `dsh-advisor` 已验证的形态）：

```js
function contribution() {
  return {
    package: 'dsh-model-smart-config',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      {
        id: 'dsh-model-smart-config#msc/infer',
        service: 'msc', namespace: 'msc', method: 'infer',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } }],
        result: { mode: 'src-json' }
      }
    ]
  };
}
```

服务实现：

```js
class SmartConfigService extends TypertRemoteService {
  constructor(ctx) { super(ctx, 'msc'); }
  async infer(request) { /* 三级推断，见 03-inference-rules.md */ }
}
```

**必须显式 `ctx.typert.register`**：源码标记发现依赖模块私有 WeakMap，本地 link 安装的插件
与其物理分离，不显式注册会导致 `/api/msc/*` 全部 404（`dsh-advisor` 源码注释实证）。

### 2.4 Client 半 `client.js`

```js
window.__ModuleLoader__.load({
  id: 'dsh-model-smart-config',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // ...组件定义...

    return {
      inject: ['slots', 'locale', 'connection', 'remote', 'remote.settings'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'msc: dictionaries');
        const api = createApi(ctx);

        ctx.slots.inject('settings.models.provider-card', function* () {
          yield ctx.slots.register({
            name: 'settings.models.provider-card',
            // keyed slot：key 是官方按 `row.entry.settingsNs` 派发的值，
            // 所有 pi-ai 第三方 provider 共用 "llm-pi-ai"（见下）。
            key: 'llm-pi-ai',
            locale: NS,
            inject: () => ({ api })
          }, SmartConfigCard);
        });
      }
    };
  }
});
```

**keyed slot 的 key 语义（已用源码实读验证）**

官方以 `entryKey = row.entry.settingsNs` 派发该槽的 key。pi-ai 的
`settingsNs = ctx.fiber.entry?.options.id ?? 'llm-pi-ai'`，而所有第三方 provider
都写进 `llm-pi-ai` 这一个命名空间，**所以 key 恒为 `"llm-pi-ai"`**，
一条条目即可覆盖全部第三方 provider；具体是哪个 provider 由组件 props 的
`provider.provider`（路由名）区分。

`@deepseek-ai/dsh-client-ui-slots/lib/index.js` 的 `SlotCore.register`（:163）实证：

- `:165` 只校验**槽位是否被父条目声明过**（全局 records 表，不按插件隔离），
  与「谁声明」无关 → 第三方插件可注册进官方声明过的槽；
- `:178` 同一 key 只允许一个占用者（同 priority），本插件独占该 key，无冲突；
- `:170-187` `keyed` kind 要求 `options.key !== undefined`，**不声明 `id`**（`id` 是 list kind 的字段）。

`ctx.slots.inject(name, cb)` 的实现**不在 slots 包**，而在 renderer
（`@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1343`）：它订阅该槽的
**声明寿命边界**，槽位尚未声明时挂起等待、一旦声明立即在 effect 里跑回调。
因此**加载顺序无关**，不需要在插件里预先声明槽位。


---

## 3. 卡片交互设计

```
┌─────────────────────────────────────────────────┐
│ ⚡ 智能配置                                      │
├─────────────────────────────────────────────────┤
│ 识别结果                                        │
│   deepseek-v4-pro  →  DeepSeek V4 Pro           │
│   依据规则 #62 #63      来源：内置规则表        │
│   [ 改为其他模型 ▾ ]                            │
├─────────────────────────────────────────────────┤
│ 上下文窗口   1,000,000   ← 端点返回（只读）     │
│ 最大输出       384,000   ← 端点返回（只读）     │
│ 多模态       ☑ 图像      ← 公开信息             │
│              参考：该模型公开信息还支持 PDF     │
├─────────────────────────────────────────────────┤
│ 思考等级                                        │
│   ○ 非推理模型                                  │
│   ● 支持思考  [off] [low] [medium] [high] [max] │
│     来源：官方文档                              │
│     [测试实际能力]  ← 默认不发，点了才发         │
├─────────────────────────────────────────────────┤
│                       [取消]      [应用到配置]  │
└─────────────────────────────────────────────────┘
```

**「依据规则 #62 #63」是关键设计**（借自 zcode 的 `matchedRules` 思路）：
把命中的规则索引显示出来，判定出问题时能直接定位到是哪几条规则叠加出来的，
而不是只给一个不可追问的结论。

**识别失败时**：

```
│ 识别结果                                        │
│   some-unknown-model-xyz  →  ⚠ 未识别           │
│   [ 按已知模型处理 ▾ ]   候选：无                │
│   → 多模态与思考等级留空，不写值                 │
```

**关键交互原则**

1. **识别结果必须可见可改** —— 显示 `<原始名> → <识别名>`，并提供「改为其他模型」下拉。
   识别错了用户看得见、改得动。
2. **每项标注来源**（`公开信息` / `端点返回` / `官方文档` / `实测` / `名称推断` / `未识别`）—— 让用户知道可信度。
3. **自动取到的值默认填入但可编辑** —— 用户始终有最终决定权。
4. **探测失败不阻断** —— 全部字段退化为手填，卡片仍可用。
5. **多模型时逐个列出** —— `reasoningEfforts` 是每模型能力，不能按 provider 统一设。
6. **「测试」按能力分项，不搞一次性大探测** —— 推理/等级/多模态三个探针各自触发、各自计成本；
   **上下文窗口不探测**（要发超长请求，成本不可控），只取注册表或端点值。
7. **实测结果是「建议值」，不自动落库** —— 填进当前表单并标注 `实测`，
   用户点「应用到配置」才写入；**实测值不回流内置离线表**（见 `04-risks-and-decisions.md` D17）。
8. **别名命中要留痕** —— 若走了 `ALIASES`（如 `deepseek-chat` → 按 `deepseek-v4-flash` 处理），
   在识别结果行标注「按 `<规范名>` 处理」，避免用户误以为识别错了。

---

## 4. 写入策略

> ⚠️ **本节是 v0.1.0 的方案设计，v0.3.0 起实现已变更，保留原文仅为记录设计推演。**
>
> **实际落地的写法（v0.3.0，v0.3.1 加固）**：插件**完全不调用 `settings.mutate`**。
> 原因：官方 `ProviderEditor` 把用户的编辑留在自己的 draft 里，只在用户点「保存」时才发
> `settings.mutate(ns, pathOps, expectedRevision)`（`@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`
> 的 `applyOnce()`，头注释逐字：*"Every edit travels as path ops against the STORED section"*）。
> 插件若自己在中间写一次库，`view.revision` 就会前进，官方随后保存必然撞 `settings/conflict`。
>
> 因此 v0.3.0 的做法是**把匹配值填进官方自己的受控控件**：
> - 受控 `input`：原生 value setter + `dispatchEvent(new Event('input', {bubbles: true}))`
>   （直接赋值 React 不感知）；
> - 复选框：`.click()`；
> - 官方行里**已经自带**上下文/最大输出/思考等级/图像开关四个可写字段，插件**不再画第二套输入框**；
> - 值经官方 `patch(index, …)` 进入 draft，用户按官方「保存」后才落库。
>
> **v0.3.1 的两点加固**：① 写值只在用户点行内「智能匹配」键时发生（敲完 id 只识别）；
> ② 插件自己派发的 `input` 事件在 `pluginWrites`（`WeakSet`）里打标，非插件写入即登记为
> 用户手改，`fillOfficialRow` 默认跳过受保护字段 —— 用户改完不会被自动路径回写。
>
> 下面这段 `pathOps` 代码在本插件 v0.3.0+ 中**不存在**（`writeModels()` 已从 `client.js` 删除），
> 但它是理解官方最小路径 diff 思路的正确参考，故保留。

复用官方 `pathOps` 的最小路径 diff 思路，只写变化字段：

```js
// 逐模型 diff，只写 reasoningEfforts / input / contextWindow / maxTokens 中真正变化的键
const ops = [];
models.forEach((next, i) => {
  const before = currentModels[i] ?? {};
  for (const key of ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts']) {
    if (JSON.stringify(before[key]) === JSON.stringify(next[key])) continue;
    ops.push(next[key] === undefined
      ? { op: 'unset', path: ['providers', route, 'models', i, key] }
      : { op: 'set',   path: ['providers', route, 'models', i, key], value: next[key] });
  }
});
await ctx.remote.settings.mutate('llm-pi-ai', ops, openedAt);
```

**冲突处理**：`code === 'settings/conflict'` 时提示用户刷新后重试（配置在表单打开期间被别处改动）。

**注意 `reasoningEfforts` 的合法取值**（`resolveModelReasoning` 校验，写错会导致适配器拒绝）：

| 情形 | 写法 |
|---|---|
| 模型支持思考 | `{off: null, low: "low", medium: "medium", high: "high"}` —— 至少一个非 off 等级，且非 off 值必须非空字符串 |
| 模型确定非推理 | `false` |
| 不确定，沿用内置目录 | **省略该字段**（不要写 `{off: null}`，会因「无 off 以外等级」报错） |

---

## 5. 实现顺序（最小可用优先）

| 步 | 内容 | 验收 |
|---|---|---|
| 1 | 建包骨架（package.json / patch / 空 apply / 空卡片） | 包内 10 个入口文件全部 `existsSync` 通过；`plugin_manager` 本机不可用，改为 GUI 装载 |
| 2 | 验证 keyed slot 的 key 语义 | **改由源码实读完成**（`cordis_inspect_query` 本机不存在）：`dsh-client-ui-slots/lib/index.js:165` 只校验槽被某父条目声明、`:178` 同 key 单一占用者 → 结论可行，未走降级路线 |
| 3 | 卡片渲染 + 读现有配置 | 能显示当前 provider 的模型列表 |
| 4 | 接 `discoverModels` | 点探测能拿到 context/maxTokens/模态 |
| 5 | 归一化（含 `ALIASES` 别名表）+ 有序正则匹配 + 分层合并（纯函数 + 单测） | `test/rules.test.mjs` 通过 |
| 6 | 规则表首版（覆盖主力 AI：OpenAI/Anthropic/Google/DeepSeek/Qwen/GLM/Kimi/MiniMax/Grok/Mistral/Llama） | 识别结果正确显示 |
| 7 | 多模态判定（公开信息优先） | 主流模型模态正确 |
| 8 | 思考等级判定（官方服务 → 内置表 → 实测 → 启发式，即 S2→S1→S3→S4） | 主流模型等级正确；`reasoningEfforts` 合法 |
| 9 | Host 半 + typert 端点 | `connection.rpc.call('/api','msc/infer',{args})` 有返回 |
| 10 | `settings.mutate` 写入 | **v0.3.0 已改为不落库**：值填进官方控件，由官方「保存」走 `pathOps` 落库；插件侧零 `mutate`（`test/interaction.test.mjs` 两条断言钉死） |
| 11 | locale / 主题 token / 错误态打磨 | 明暗主题均可读；无 `slot entry crashed` |
| 12 | **（v0.3.0）行内化**：控件打散进每条官方模型行 | 一个模型一行、模型列表下方不多出纵向区域（`test/placement.test.mjs` 九场景） |
| 13 | **（v0.3.0，v0.3.1 修正）**：新增模型只**识别**不自动填值；填值由用户点「智能匹配」显式触发 | 新增行出「待填 ID」+「智能匹配」键；点键才填，填后可手改且不被回写（`placement` 场景 ⑤/⑤b/⑦） |

**第 1–2 步是风险闸**：若 keyed slot 无法按 provider 分派，方案要改为
「自行注册一个 `settings.section` 整页」（官方允许第三方注册 section，但改动量更大）。

---

## 6. 不做什么（边界）

- ❌ 不改 `cordis.patch.yml`、不写 profile `package.json`、不在 `$DSH_HOME` 下建包
- ❌ 不 `require` 任何 Harness Client 包（尤其 `ui-primitives`）
- ❌ 不读/不写/不输出密钥明文；只用 `credentials.describe` 的布尔结果
- ❌ 不做 provider 级 reasoning 控件（官方已论证这是错的粒度）
- ❌ 不替换官方 Models 页；v0.3.0 起**把控件挂进官方模型行内**，但依赖的还是官方 keyed slot 这一个扩展点
- ❌ **不直接调 `settings.mutate`**（v0.3.0 起）：只填官方控件，落库交给官方「保存」
- ❌ **不在未识别时写入任何值**（v0.3.1 起 `isRecognised` 闸门守住唯一的写值入口「智能匹配」键）
- ❌ **不自动改写用户手改过的字段**（v0.3.1 起）：自动路径只识别，写入只在用户点键时发生
