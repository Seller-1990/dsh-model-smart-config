# 01 · 调研结论与证据链

> 本文件记录「官方能力边界」的实测结论，每条都附可复查的证据位置。
> 结论决定方案形态，不是推测。

---

## 1. 需求与官方能力的真实缺口

用户要的「智能配置」包含四项：**上下文窗口**、**思考等级**、**是否多模态**、以及填完 url/key/model 后的自动化。

官方 `discoverModels` 的返回**取决于走哪条路径**，这一点必须先分清：

| 路径 | 触发条件 | 返回字段 |
|---|---|---|
| **P1 · 内置目录** | `request.provider` 在 pi-ai 内置 catalog 里有模型 | `{id, name, contextWindow, maxTokens, inputModalities}` —— **5 项** |
| **P2 · 网络探测** | 走 `GET {baseURL}/models` 的 `readListing(body)` | `{id, name, contextWindow?, maxTokens?}` —— **4 项，无模态** |

**证据 P1**：`@deepseek-ai/dsh-llm-pi-ai/lib/index.js:2313-2319` ——
`if (installed.size > 0) return [...installed.values()].map((model) => ({ id, name, contextWindow, maxTokens, inputModalities: [...model.input] }))`

**证据 P2**：同文件 `readListing(body)` @ `lib/index.js:2257-2286` —— 循环体只 push
`{id, name, ...contextWindow, ...maxTokens}`，**`inputModalities` 在整个 `readListing` 中一次都不出现**。

→ **对第三方 provider（无内置 catalog，必须走网络探测），官方实际只能带回 4 项。**
→ **输入模态与思考等级都拿不到。** 这才是缺口的准确边界。

> ⚠️ 早期版本的本文件曾笼统写成「官方已能带回 inputModalities」，那是把 P1 的能力
> 误记成通用能力。**对第三方 API 场景，以 P2 为准。**
>
> 注：这里的 P1/P2 指**探测路径**，与 `04-risks-and-decisions.md` §3 Q1 的
> 「数据来源 A/B/C 选项」（离线表 vs 联网）是两件不同的事，不要混读。

官方源码对此有明确注释（`dsh-client-ui-settings-models/lib/client.js` 的 provider 编辑器）：

> provider 编辑器**故意不提供** reasoning effort —— 它是**每模型**能力，同一 provider 下各模型不一致，
> provider 级控件只能设成某些模型会拒绝的值；`cordis.patch.yml` 才保留该 profile 字段。

即：官方把这个字段**留给用户手改配置文件**。这正是用户抱怨的痛点。

---

## 2. 现成插件调研：无可用实现

| 范围 | 数量 | 结论 |
|---|---|---|
| 已装社区插件（`.generations/live`） | 14 个代际目录 | 无一是第三方模型参数智能配置 |
| profile bundles（`package.json` 的 `dsh.profile.bundles`） | 18 个 | 同上 |
| asar 内官方包 | 628 个 | 无独立「模型参数推断」包 |

已装插件的具体清单不在此列出（属于使用者本机的插件组合，不入公开文档）；逐一核对其 `dsh` manifest
与加载面后，没有任何一个承担「第三方模型的上下文窗口 / 模态 / 思考等级推断」职责。

→ **必须自建插件。**

---

## 3. 四条关键通道：全部对第三方插件开放

### 3.1 探测通道 —— `ctx.remote.llm.discoverModels`

浏览器侧签名（`@deepseek-ai/dsh-api-settings-controller/lib/typert.remote-client.js`）：

```
ctx.remote.llm.discoverModels(settingsNs: string, request: {provider?, baseURL?, api?, apiKey?})
  → {kind:"found", models} | {kind:"refused", message}
```

宿主侧由 `dsh-llm-pi-ai` 的 `apply()` 注册：

```js
const settingsNs = ctx.fiber.entry?.options.id ?? NS;   // NS = "llm-pi-ai"
ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discoverModels({...request, ...}, () => storedDiscoveryProfile(request.provider)));
```

`listingUrl(baseURL, api)` 把 baseURL 当**前缀**拼接（不做 URL resolve），所以
`https://gateway.example/openai/v1` 会保留全部路径段。

### 3.2 写入通道 —— `ctx.remote.settings.mutate`

```
ctx.remote.settings.mutate(ns, ops, expectedRevision)
  → {kind:"written", view} | 冲突时 code === "settings/conflict" → {kind:"conflict"} | 其余 {kind:"refused"}
```

官方新建 provider 的实际写法（同一份 client.js）：

```js
writeSettings(NS$1, [{ op:"set", path:["providers", route], value: profile }], openedAt)
```

`NS$1 = "llm-pi-ai"` —— **settings namespace 就是 profile 条目 id**。
`pathOps(base, before, after)` 逐键 diff 生成最小路径操作，相同 JSON 的键跳过。

> ⚠️ **v0.3.0 起本插件不再走这条通道**。这条通道仍由**官方**使用：官方 `ProviderEditor`
> 只把编辑留在自己的 draft，用户点「保存」时才 `writeSettings(ns, pathOps(settingsPath, committedOriginal, next), expectedRevision)`。
> 插件若在中间自己写一次，revision 前进后官方保存必然撞 `settings/conflict`。
> 因此插件改为**把值填进官方受控控件**，让官方自己的 `patch(index, …)` 更新 draft
> （实现见 [`02-architecture.md`](02-architecture.md) §4 的 ⚠️ 与 [`06-implementation-evidence.md`](06-implementation-evidence.md) §E9）。
> 本节记录的是**当时调研到的官方通道**，仍然准确。

→ **完全不需要手改 `cordis.patch.yml`。**

### 3.3 凭据通道 —— `ctx.remote.credentials`

```
ctx.remote.credentials.describe([ref])  → 永不返回值，只返回 {configured, source, writable}
ctx.remote.credentials.set(ref, value)  → 只写
ctx.remote.credentials.unset(ref)
```

`apiKeyEnv` 只是**引用**，密钥实体存在 `$DSH_HOME\.credentials.yaml`，
经 `credentialRef()` / `credentialKey()` 管理。**配置文件里永远没有密钥明文。**

### 3.4 UI 挂载点 —— `settings.models.provider-card`（keyed slot）

官方 Models 页在 `apply(ctx)` 中声明并三处渲染：

```js
renderSlot("settings.models.provider-card",
  { provider: row.entry, configured: row.configured, keyConfigured: keyConfiguredOf(row) },
  { entryKey: row.entry.settingsNs })          // ← keyed slot 的 key
```

三处渲染点：① `needsSetup` 的 setup 卡；② 已配置 provider 行；③ 新增 provider 的草稿行。

`row.entry` 形如 `{provider, displayName, settingsNs, settingsPath, active, declared?, error?}`，
由 `joinProviderDirectory()` 合成，排序为 deepseek-account → deepseek-official → 其余保持原序。

→ **第三方插件可以把卡片插到每个 provider 行旁。**

---

## 4. 插件自建浏览器↔宿主通道：可行

这是「主动探测」能否进 v1 的决定性问题。**结论：能。**

`ctx.typert.register(contribution)` 是官方受支持路径。`dsh-advisor` 的实测范式：

```js
{ package: 'dsh-advisor', face: 'host', schemas: [], model: {services:[],events:[],objects:[]},
  invocations: [
    { id: 'dsh-advisor#advisor/get', service:'advisor', namespace:'advisor', method:'get',
      invocation:{kind:'direct'}, parameters:[], result:{mode:'src-json'} },
    { id: 'dsh-advisor#advisor/set', service:'advisor', namespace:'advisor', method:'set',
      invocation:{kind:'direct'},
      parameters:[{name:'patch', wire:'patch', source:'json', codec:{mode:'src-json'}}],
      result:{mode:'src-json'} } ] }
```

浏览器侧调用：`await connection.rpc.call('/api', 'advisor/get', { args: {} })` → `{ok:true, value}` 或 `{ok:false, error}`。

宿主侧基类：`class X extends TypertRemoteService`，构造 `super(ctx, 'advisor')`。
注册时 catch 消息含 `'has been registered'` 的重复错误（多 fiber 去重）。

**为什么必须显式注册**（advisor 源码注释原文要点）：SRC 标记发现读的是
`@deepseek-ai/dsh-typert-protocol` 里一个**模块私有 WeakMap**；本地 link 安装的插件其 peer
从真实目录解析，与宿主树物理分离，永远无法共享该表 —— 症状是**零 endpoint 被 claim、
`/api/<ns>/*` 全部 404**。显式注册把 invocation 描述符写进 `ctx.typert.local`，
gateway 的 `claimsEndpoint` **先查 `ctx.typert.local`**，因此 claim + dispatch 与模块身份无关。

---

## 5. 思考等级：数据从哪来（本方案的核心难点）

> **结论已定（用户拍板）**：数据来源取 **内置离线表**（不联网），注册表范式参照 zcode。
> 本节 5.1 说明为什么必须自建表（权威来源够不到）；5.2 列出四条**技术来源**及各自角色；
> 5.3 是写入语义（`reasoningEfforts` 的合法形态）。

### 5.1 权威来源存在，但插件够不到

pi-ai 的内置目录是**静态 JSON**，带完整的推理元数据：

**证据**：`node_modules/@earendil-works/pi-ai/dist/providers/data/deepseek.json`

```json
{"openai-completions":{"deepseek-flash":{"id":"deepseek-flash","name":"DeepSeek V4.1 Flash",
  "reasoning":true,
  "thinkingLevelMap":{"minimal":null,"low":"low","medium":null,"high":"high","max":"max"},
  "input":["text","image"],"contextWindow":1000000,"maxTokens":384000, ...}}}
```

`dsh-llm-pi-ai` 的 `getSupportedThinkingLevels(model)` 就是读这个：

```js
getSupportedThinkingLevels(model) {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== void 0;
    return true;
  });
}
```

`THINKING_LEVELS = [off, minimal, low, medium, high, xhigh, max]`。

**但是**：`@earendil-works/pi-ai` **不在 profile 的 node_modules 里**
（实测 `profiles/web/node_modules` 顶层无 `@earendil-works`），它只存在于宿主 asar 树。
插件包的依赖图够不到它 → **不能直接 require 读 catalog**。

### 5.2 四条可选来源及其在本方案中的角色

> 注：这里的「来源」是**技术路径**，与 §3 的「通道」不是一回事，
> 也与 `04-risks-and-decisions.md` §3 Q1 的「数据来源 A/B/C 选项」不同
> —— 后者问的是**离线表还是联网**，已拍板选**内置离线表**。

| 来源 | 对第三方路由是否有效 | 本方案角色 |
|---|---|---|
| **S1 · 自建有序规则表** | ✅ 任意模型名都能匹配 | ✅ **主路径**（用户拍板：内置离线表） |
| S2 · 官方 `resolveModelInfo` | ❌ 仅 pi-ai catalog 已知路由 | 补强：命中时优先采信（数据比手写表权威） |
| S3 · 插件自建探测 | ✅ 能发请求就有效 | 可选：仅用户点「测试」时触发 |
| S4 · 名称启发式 | ✅ 总是可用 | 兜底：只给候选，不自动写 |

**S1 —— 自建有序规则表（主路径）**

即 [`03-inference-rules.md`](03-inference-rules.md) §3 的 `MODEL_RULES`：
照 zcode 范式写成**有序正则规则 + 分层覆盖**，每条带 `source`（官方文档 URL）作为依据。
这是用户拍板的数据来源，也是唯一**不依赖网络、不依赖 catalog** 的路径。

**S2 —— 官方 `resolveModelInfo`（补强）**

`ctx.llm.resolveModelInfo(provider, model, signal)` 返回
`{..., reasoning:{efforts:[{id,name}], defaultEffort?}, defaultMaxTokens?}`。
对 pi-ai catalog 覆盖的路由（如 `deepseek` + `deepseek-v4-pro`），它能直接给出正确等级。
**对任意第三方 baseURL + 任意模型名无效** —— 那种路由没有 catalog 条目。
→ 命中时采信它，未命中时落回 S1。

**S3 —— 插件自建探测（可选，默认不发）**

官方 `readListing` **丢弃**了 listing 响应里的富字段。插件宿主半**自己发一次 `GET {baseURL}/models`**，
读官方扔掉的东西：

| 富字段 | 来源 | 用途 |
|---|---|---|
| `reasoning` / `capabilities.reasoning` | OpenRouter 风格网关 | 布尔推理能力 |
| `supported_parameters[]` | OpenRouter 风格网关 | 含 `reasoning` / `include_reasoning` → 支持思考 |
| `architecture.input_modalities[]` | OpenRouter 风格网关 | 多模态判定 |
| `top_provider.max_completion_tokens` | OpenRouter 风格网关 | maxTokens |
| `context_length` / `limit.context` | 通用 | contextWindow |

用户已拍板：**允许存在，但默认需手动点「测试」** —— 靠结构保证：探测只在
按钮 `onClick` 里发起，自动推断路径不含探测。（`allowProbe` 只控制按钮显隐，默认显示。）

**S4 —— 名称启发式（兜底）**

当 S1–S3 都取不到时，按模型名模式匹配给出**候选等级集合**，让用户在表单里确认。
规则表见 [`03-inference-rules.md`](03-inference-rules.md) §5.4。

**优先级**（实现时）：S2（权威）→ S1（离线表）→ S3（用户点了测试）→ S4（候选）。

### 5.3 写入的字段语义（必须写对）

`reasoningEfforts` 的校验规则（`dsh-llm-pi-ai/lib/index.js` 的 `resolveModelReasoning`）：

```js
const efforts = entry.reasoningEfforts;
if (efforts === void 0) return { reasoning: base?.reasoning ?? false };  // 省略 = 沿用 catalog
if (efforts === false)  return { reasoning: false };                     // 显式非推理
if (efforts === null || Object.keys(efforts).length === 0) invalid(...); // 空对象非法
// 每个 level：off 可为 null；其余必须是非空字符串
// 必须至少提供一个非 off 的等级
```

合法的写入形态（与 profile 现有写法一致）：

```yaml
reasoningEfforts:
  off: null
  low: low
  medium: medium
  high: high
```

**注意**：若某模型确实非推理，应写 `reasoningEfforts: false`，
而**不要**写 `{off: null}`（会因「未提供 off 以外的等级」被判非法）。

---

## 6. 关键约束（实现时不可违背）

1. **不得手写** profile 的 `package.json` / `cordis.patch.yml`，不得在 `$DSH_HOME` 下建包，
   不得在 profile 目录跑 pnpm —— 合并 profile 行这件事只能交给插件管理器的安装流程
   （官方 `cordis-plugin-development` skill 的硬规则）。
   **本机实测补充**：`plugin_manager` 工具与 `dsh` CLI 都不可用，
   因此实际通道是**用户在 GUI 插件管理器里粘贴本包绝对路径**（`parseInstallSpec` 只接受
   绝对路径 / `file:` / `link:`，相对路径一律拒绝）。
2. 插件 UI **不得** `require` 任何 Harness Client 包（尤其 `@deepseek-ai/dsh-client-ui-primitives`），
   样式只用主题 token `--dsw-alias-*`。
3. **密钥绝不进配置文件**，会话中不得读取或输出密钥明文。
4. 探测请求失败要**可降级**：取不到就退到表单，绝不能因探测失败阻断配置流程。

---

## 7. 环境实测记录

| 项 | 值 |
|---|---|
| `DSH_HOME` | `%DSH_HOME%`（Windows 桌面版默认为 `%APPDATA%\dsh-desktop\harness`） |
| 当前 profile | `$DSH_HOME/profiles/<profile>` |
| 程序目录 | `%LOCALAPPDATA%\Programs\DSH Desktop\resources\`（内含 `app.asar`） |
| 工作目录 | 任意本地目录（本插件代码与 harness 目录**物理分离**） |
| asar 提取工具 | 自写脚本（`-Mode list\|cat\|grep\|dump`） |
| asar 文件索引 | 脚本导出的 CSV（本机实测 21221 行） |
| asar 导出目录 | 自选临时目录 |
| `node` 命令 | **被 Electron 劫持**（报 `node:electron/js2c/node_init`），脚本用 pwsh 解析 |
