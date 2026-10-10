# 04 · 风险、决策与待定项

---

## 1. 已定决策（附理由）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 做 **UI 插件**（Host + Client 双入口），不是纯 Host 插件 | 需要界面承载「确认/修改」环节；官方 skill 的 ui-plugin 模板支持双入口 |
| D2 | 挂载点选 `settings.models.provider-card` **keyed slot** | 官方唯一为第三方留的 provider 行扩展点，官方自己在三处渲染它；比自建整页改动小得多 |
| D3 | 交互形态 **混合**（自动识别 + 显式确认写入） | 用户已拍板；纯自动会在取不到时写错，纯表单则没省事。**v0.3.1 起「自动」只到识别层**：敲完 id 只更新徽标，写值必须用户点行内「智能匹配」键（用户 实测反馈） |
| D4 | ~~写配置走 `ctx.remote.settings.mutate`，**不改文件**~~ ⚠️ **v0.3.0 起已改**：插件**零写库**，把值填进官方受控控件，落库由官方「保存」触发 | 原理由成立（官方受支持路径、带 revision 冲突检测），但插件自己 mutate 会让 `view.revision` 前进，导致官方随后保存必撞 `settings/conflict` —— 见 `02-architecture.md` §4 |
| D5 | 密钥只走 `credentials.set`，配置里只留 `apiKeyEnv` 引用 | 官方 seam 的设计；配置文件出现明文密钥是安全缺陷 |
| D6 | 主动探测走**自建 typert 端点**（`/api/msc/infer`） | 官方 Remote 里没有任何通用 HTTP 探测方法；`dsh-advisor` 已验证此范式可行 |
| D7 | 注册表**独立成数据文件** | 让「内置/联网/混合」三种数据来源方案都能低成本替换 |
| D8 | 探测（测试途径）**默认关闭，需用户显式触发** | 会消耗用户 API 额度，不能擅自发起 |
| D9 | 不识别时**不写值** | 用户质量底线：不静默写错。v0.3.1 起 `isRecognised` 闸门守住的唯一写值入口就是「智能匹配」键 |
| D10 | 数据来源取 **A 内置离线表**（用户 拍板） | 不联网、随插件版本更新、工作量最小；`data/` 独立一层保留换方案余地 |
| D11 | 注册表范式**参照 zcode `modelConfigRules`**：有序正则规则 + 分层覆盖（用户要求研究其注册表） | 见 `03-inference-rules.md` §2；比扁平名表更能表达「同名族不同变体」的增量差异 |
| D12 | 归一化**不剥离**日期/变体后缀 | 与早期设想相反：zcode 正则已把「名 + 边界符 + 任意后缀」写进模式，剥离反而破坏匹配 |
| D13 | 推理等级词表**照搬 zcode 的 `values` 分布**，但映射成 DSH 的 `reasoningEfforts` 对象 | zcode 的 `values`+`map` 正好是 DSH 所需「档位键 + wire 拼写」的两半 |
| D14 | zcode 的 `supportsVideo/Audio/Pdf` **只展示不写入** | DSH 的 `input` 只接受 `text`/`image`（pi-ai `MODALITIES`），写入未知字段会被拒 |
| D15 | 首版覆盖范围**自行扩表**，不照搬 zcode 覆盖面 | zcode 表偏 GLM/智谱系（84 条里 28 条是 glm-*），缺 Gemini/Mistral/Llama |
| D16 | 加 **`ALIASES` 别名表**，在归一化之后、正则匹配之前应用 | 第三方聚合站普遍给模型加厂商前缀或改写成别名（`deepseek-chat`↔`deepseek-v4-flash`），只剥 `org/` 不够；别名只改匹配用名、不改显示名 |
| D17 | 实测探测结果**只填入当前配置表单供用户确认，不回流离线表** | 离线表是随插件版本更新的资产；混入用户实测值会引入「本地数据 vs 内置表」的分层同步问题，且 A 站的实测结论未必适用于 B 站。将来若需复用再加 `LOCAL_OVERRIDES` 层（顺序 `BASE←MODEL←SITE←LOCAL`） |

---

## 2. 技术风险与缓解

### R1 · keyed slot 的 key 语义不确定（**最高风险**）

**风险**：官方以 `{ entryKey: row.entry.settingsNs }` 派发 keyed slot，
但已知范例（`dsh-advisor`）用的是固定 `key: BUNDLE_NAME`。
若一条 keyed 条目只能占一个 key，插件就无法为「每个 provider 各渲染一张卡片」。

**缓解（已落实，风险消除）**：
- `cordis_inspect_query` 本机不存在，改为**源码实读**：
  `@deepseek-ai/dsh-client-ui-slots/lib/index.js:165` 只校验「该槽已被某个父条目声明」，
  **不区分声明方** → 第三方插件可注册进官方 `settings.models.provider-card`；
  `:178` 同 key 只允许单一占用者，本插件用固定 `key: 'llm-pi-ai'` 无冲突；
  官方三处渲染点均以 `entryKey: row.entry.settingsNs` 派发，而 pi-ai 的
  `settingsNs = ctx.fiber.entry?.options.id ?? 'llm-pi-ai'` —— **全部第三方 provider 共用该值**，
  故**一条条目即覆盖全部 provider**，不需要按 provider 各注册一条。
  具体 provider 由 ownerProps 的 `provider.provider` 区分。
- **降级路径**（未触发，保留备用）：若不可行，改为自行注册一个 `settings.section` 整页
  （官方允许第三方注册 section，`dsh-client-ui-settings` 的 `ctx.configForms.whileServed`
  可让页面只在相关 namespace 存在时出现）。改动量增加，但方案仍成立。
- 证据见 [`02-architecture.md`](02-architecture.md) §2.4 与
  [`06-implementation-evidence.md`](06-implementation-evidence.md) E3。

### R2 · `reasoningEfforts` 写错会被适配器拒绝

**风险**：`resolveModelReasoning` 有多条硬校验 ——
空对象非法、非 off 等级值必须非空字符串、**必须至少有一个非 off 等级**。

**缓解**：
- 写入前用纯函数校验（`validateReasoningEfforts()`），非法值不提交；
- 「非推理模型」写 `false` 而非 `{off: null}`（后者会触发「无 off 以外等级」错误）；
- 不确定时**省略字段**（沿用内置目录）。

### R3 · 探测请求的兼容性

**风险**：不同网关的 `/models` 返回结构差异大；官方 `readListing` 已做了容错，
插件自建探测要处理更多形态。

**缓解**：
- 复用官方容错表思路（`data` 数组 / `models` 对象；`contextWindow|context_length|max_input_tokens|limit.context` 等别名）；
- 任何解析失败都**降级**，不阻断配置流程；
- 响应体限长（官方用 `MAX_RESPONSE_BYTES = 4MiB`，插件沿用同量级）。

### R4 · 无法直接读 pi-ai 内置目录

**风险**：`@earendil-works/pi-ai` 只在宿主 asar 树，**不在 profile node_modules**，
插件包依赖图够不到 → 拿不到内置 catalog 的 `thinkingLevelMap`。

**缓解**：
- 改用 `ctx.llm.resolveModelInfo(provider, model)`（官方服务方法，对 catalog 覆盖的路由有效）；
- 对第三方路由用注册表 + 探测兜底；
- 注册表可人工摘录主流模型规格（依据官方文档）。

### R5 · `settings/conflict` 冲突

**风险**：表单打开期间配置被别处修改，`mutate` 返回冲突。

**缓解**：沿用官方做法 —— 打开表单时记 revision，写入时带上；
冲突则提示用户刷新重试，不覆盖他人改动。

### R6 · 插件热更新需重启

**风险**：替换已安装包必须重启才能载入新 JS 模块代（官方 skill 明确）。

**缓解**：开发期第一次安装即可，后续改动预期需重启；不在方案里承诺热更新。

---

## 3. 已拍板项（用户，原「待拍板」已关闭）

### Q1 · 模型公开信息的数据来源 → **选 A · 内置离线表**

用户原话：**「A 内置离线表」**。

| 选项 | 状态 |
|---|---|
| **A. 内置离线表** | ✅ **已选** |
| B. 运行时联网查询 | ❌ 未选 |
| C. 内置为主 + 联网补充 | ❌ 未选 |

→ 方案**不含联网模块**。首版 `Config` **不设**数据来源开关（Q1 已单选 A），
`registrySource` 在实现中没有任何读取点，属死旋钮，已从 `Config` 与 `cordis.patch.yml` 删除；
将来真做 B/C 方案时再连同实现一起引入配置项。

### Q2 · 探测请求是否默认允许 → **默认需手动点「测试」**

用户原话：**「允许测探测，默认需手动点『测试』」**。

→ 探测**允许存在**（Host 半保留探测能力），且**默认显示**「测试」按钮（`allowProbe: true`）。
「默认不发请求」由**结构**保证而非开关：`runProbe` 只在按钮 `onClick` 里被调用，
自动推断路径（`reload` → `msc/infer` + `msc/authoritative`）**不含**任何探测调用。

### Q3 · 注册表首版覆盖范围 → **目前的主力 AI**

用户原话：**「注册表首版覆盖范围：目前的主力AI」**。

→ 按厂商铺开：OpenAI / Anthropic / Google / DeepSeek / 阿里(Qwen) / 智谱(GLM) /
月之暗面(Kimi) / MiniMax / xAI(Grok) / Mistral / Meta(Llama)。
**不照搬 zcode 的覆盖面**（它偏 GLM 系且缺 Gemini/Mistral/Llama），只借鉴其**范式**。
清单见 `03-inference-rules.md` §3.2。

> ⚠️ **「目前的主力 AI」有两种读法，首版先按 (1) 起草，请用户圈正**：
> **(1)** 当前主流大模型家族（上表 11 家）—— 本方案默认；
> **(2)** 用户自己主力在用的模型集合 —— 若取此读法，请用户给出清单，
> 或从使用者本机现有 provider 配置推断（`cordis.patch.yml` 的 `providers.*.models` 列表）。
> **两种读法不改变方案结构**，只影响首版收录哪些条目，随时可整表增补。

### Q4 · zcode 注册表研究结论

用户原话：**「你能否从zcode项目中研究一下它的注册表？」**

→ **已完成**。证据文件：
`<安装目录>/v2/runtime/provider/<平台>/<版本>/<endpoint 哈希>/zcode-builtin.json`
的 `config.modelConfigRules`。完整分析见 `03-inference-rules.md` §2。**三条可直接搬运的机制**：

1. **有序正则规则 + 分层覆盖**（`modelRules` 84 条，按序累加，后者覆盖同名字段）；
2. **推理等级是每模型自报的词表**（`optionSpecs.reasoningLevel.values`，12 种取值组合）；
3. **wire 映射按协议分流**（`modelApiRules` 的 `apiTypeMatch` + `map` 表达式）。

**一条必须避开的坑**：zcode 的覆盖面**不等于**主力 AI 覆盖面
（84 条里 28 条是 `glm-*`，完全没有 Gemini / Mistral / Llama）。

---

## 4. 实现风险闸（先做这两步）

```
步骤 1  建最小骨架 → 确认入口文件齐全
        （plugin_manager 与 dsh CLI 本机都不可用；改为 GUI 插件管理器装载绝对路径）
步骤 2  验证 keyed slot 的 key 语义
        ├─ 可行 → 按本方案继续
        └─ 不可行 → 改「自建 settings.section 整页」路线（需重估工作量）
```

**步骤 2 的处置（已完成）**：`cordis_inspect_query` 本机不存在，改为源码实读 —
`@deepseek-ai/dsh-client-ui-slots/lib/index.js:165` 只要求槽位**已被某个父条目声明**（不区分声明方），
`:178` 同 key 只允许单一占用者，官方 Models 页确实声明了 `settings.models.provider-card` 的 children，
且本插件用 `key: 'llm-pi-ai'` 无冲突 → **判定可行，未走降级路线**（详见
[`02-architecture.md`](02-architecture.md) §2.4 与 [`06-implementation-evidence.md`](06-implementation-evidence.md) E3）。

---

## 5. 验收标准（对齐用户质量底线）

| 项 | 标准 |
|---|---|
| 主流模型 | 多模态与思考等级与真实公开规格一致（不误判） |
| 未识别模型 | 不写错误值；显示「未识别」；允许手动覆盖 |
| 识别可见 | 展示识别结果（如 `gpt-4o-2024-11-20` → `GPT-4o`），错了能改 |
| 不手改文件 | 全流程不触碰 `cordis.patch.yml` 与 profile `package.json` |
| 密钥 | 配置文件无明文；会话中不读取/输出密钥 |
| 降级 | 探测失败时卡片仍可用，不阻断配置 |
| 写入合法 | `reasoningEfforts` 通过适配器校验，不产生 `UNSUPPORTED_REASONING_EFFORT` |
| 界面 | 明暗主题均可读；控制台无 `slot entry crashed` |
