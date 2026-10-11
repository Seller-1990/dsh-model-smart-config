# 03 · 模型识别与参数判定规则

> 本文件回答三件事：**怎么认出模型**、**多模态怎么判**、**思考等级怎么定**。
> 判定依据按用户指定：多模态 = 模型公开信息；思考等级 = 测试或官方文档。
> 注册表范式**参照 zcode 的 `zcode-builtin.json`**（用户要求研究其注册表），见 §2。

---

## 1. 为什么先要「模型识别」

`contextWindow` / `maxTokens` 是**数值**，官方 `/models` 端点大多能直接给。
但 `input`（多模态）和 `reasoningEfforts`（思考等级）是**能力标签**，
它们取决于**这个模型到底是谁**，而不取决于端点返回了什么。

**实测证据**：官方探测链路的 `readListing(body)` 只产出四个字段：

```js
models.push({ id, name, ...contextWindow, ...maxTokens });
```

`inputModalities` 在整个 `readListing` 里根本不出现，推理字段更不存在。
→ **不识别模型身份，就无法判定这两项。** 识别是整个判定链的入口。

---

## 2. 参照范式：zcode 的注册表长什么样

**证据文件**（同类工具安装目录下的内置注册表）：

```
<安装目录>/v2/runtime/provider/<平台>/<版本>/<endpoint 哈希>/zcode-builtin.json
```

顶层 `config` 下有两组规则：`providerConfigRules` 与 **`modelConfigRules`**。
后者就是模型规格表，且**不是扁平的「模型名 → 规格」映射，而是有序的正则规则数组**：

| 数组 | 匹配键 | 用途 |
|---|---|---|
| `modelRules`（**84 条**） | `modelMatch`（正则，匹配模型名） | 主表：上下文、输入格式、推理等级、最大输出 |
| `modelApiRules`（**72 条**） | `apiTypeMatch`（`anthropic-messages` 38 / `openai-chat-completions` 24 / `openai-responses` 10） | 按**协议**决定推理参数怎么写进 wire |
| `providerSiteRules` | `baseUrlMatch` + `apiTypeMatch` | 按**具体站点**覆盖（聚合站的特殊写法） |
| `templateModelRules` | `templateId` + `modelId` | 按模板覆盖 |
| `builtinProviderModelRules` | `providerId` + `modelId` | 按内置 provider 覆盖 |

### 2.1 单条规则的形状（实读原文）

`modelRules[0]` 是**兜底默认**（`modelMatch: ".*"`）：

```json
{"modelMatch":".*","config":{
  "enabled":true,
  "properties":{
    "requiresMfjsToolSchema":false,
    "contextWindow":200000,
    "inputFormat":{"supportsText":true,"supportsImage":false,"supportsVideo":false,
                   "supportsAudio":false,"supportsPdf":false},
    "outputFormat":{"supportsText":true},
    "supportsToolCall":true,
    "supportsJsonSchemaOutput":false,
    "supportsNativeWebSearch":false,
    "supportsMidConversationSystem":false
  },
  "optionSpecs":{
    "reasoningLevel":{"values":["disabled","enabled"],"map":"{}"},
    "maxOutputTokens":{"max":32000}
  }}}
```

**字段体系比 DSH 宽**：`inputFormat` 分 `supportsText/Image/Video/Audio/Pdf` 五项
（DSH 的 `input` 只有 `text`/`image` 两项），另有工具调用、JSON Schema 输出、
原生联网、对话中途改 system prompt 等能力位。

### 2.2 分层覆盖（关键机制，实读三例）

规则**按数组顺序累加合并**，后面的命中覆盖前面的同名字段 —— 这就是「分层覆盖」：

```json
[3] {"modelMatch":".*glm-5(?:[.\\-:/\\[].*)?",
     "config":{"properties":{"contextWindow":200000,
                             "inputFormat":{"supportsImage":false,"supportsVideo":false}},
               "optionSpecs":{"reasoningLevel":{"values":["disabled","enabled"]},
                              "maxOutputTokens":{"max":64000}}}}

[6] {"modelMatch":".*glm-5\\.3(?:-flash)?(?:[.\\-:/\\[].*)?",
     "config":{"properties":{"contextWindow":1000000,
                             "inputFormat":{"supportsImage":false,"supportsVideo":false}},
               "optionSpecs":{"reasoningLevel":{"values":["low","high","max"]},
                              "maxOutputTokens":{"max":128000}}}}

[7] {"modelMatch":".*glm-5\\.3-flash(?:[.\\-:/\\[].*)?",
     "config":{"properties":{"inputFormat":{"supportsImage":true,"supportsVideo":true,
                                            "supportsPdf":true}}}}
```

→ `glm-5.3-flash` 同时命中 [0] [3] [6] [7]：基础默认来自 [0]，容量与等级来自 [6]，
**多模态来自 [7] 的增量覆盖**（[7] 只写了 `inputFormat` 三项，其余字段不动）。
**这种「细粒度增量覆盖」正是扁平名表做不到的。**

### 2.3 正则的写法约定

统一形如 `.*<模型名>(?:[.\-:/\[].*)?` —— 模型名后可跟 `.` `-` `:` `/` `[` 等边界符再跟任意内容。
一条件则同时覆盖 `glm-5.3`、`glm-5.3-flash`、`glm-5.3:free`、`glm-5.3[1m]` 等写法。
另有 `.*\[1m\]` → `contextWindow: 1000000`（变体后缀直接提上下文）。

### 2.4 推理等级的词表（实读 84 条的取值分布）

`optionSpecs.reasoningLevel.values` 不是固定枚举，**每个模型自报自己的可用档位**：

| 出现次数 | 取值 |
|---|---|
| 27 | `disabled` \| `enabled` |
| 4 | `disabled` \| `low` \| `high` \| `max` |
| 4 | `low` \| `high` \| `max` |
| 3 | `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| 3 | `none` \| `low` \| `medium` \| `high` \| `xhigh` |
| 2 | `low` \| `medium` \| `high` \| `xhigh` |
| 1 | `disabled` \| `high` \| `max` |
| 1 | `enabled` |
| 1 | `low` \| `medium` \| `xhigh` |
| 1 | `medium` \| `high` \| `xhigh` |
| 1 | `none` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| 1 | `none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` |

**词表前缀**：`disabled` / `none` 表示关闭，`enabled` 表示「开但只有一档」，
其余是具名档位。**这正好能映射到 DSH 的 `reasoningEfforts` 键集**（见 §5.2）。

### 2.5 协议的 wire 映射（`map` 是表达式模板）

`optionSpecs.reasoningLevel.map` 是一段**按协议生成的 JS 表达式**，决定档位怎么发出去。
`modelApiRules` 里三条协议级兜底规则（`modelMatch: ".*"`，实读原文）：

```jsonc
// apiTypeMatch: "anthropic-messages"
"map": "reasoningLevel == \"disabled\"
  ? { \"thinking\": { \"type\": \"disabled\" } }
  : { \"thinking\": { \"type\": \"adaptive\" },
      \"output_config\": { \"effort\": reasoningLevel == \"enabled\" ? \"high\" : reasoningLevel } }"

// apiTypeMatch: "openai-chat-completions"
"map": "{ \"thinking\": { \"type\": reasoningLevel == \"disabled\" || reasoningLevel == \"none\" ? \"disabled\" : \"enabled\" },
          \"enable_thinking\": reasoningLevel != \"disabled\" && reasoningLevel != \"none\",
          \"reasoning_effort\": reasoningLevel == \"disabled\" ? \"none\" : reasoningLevel == \"enabled\" ? \"high\" : reasoningLevel,
          \"reasoning\": { \"effort\": reasoningLevel == \"disabled\" ? \"none\" : reasoningLevel == \"enabled\" ? \"high\" : reasoningLevel } }"

// apiTypeMatch: "openai-responses"（第三种协议，兜底条 modelMatch: ".*"）
"map": "{ \"reasoning\": { \"effort\": reasoningLevel == \"disabled\" ? \"none\" : reasoningLevel == \"enabled\" ? \"high\" : reasoningLevel } }"
// 同协议的 gpt-5.6 专用条：{ "reasoning": { "effort": reasoningLevel } }（不做 disabled/enabled 重写）
```

`modelApiRules` 共 **72 条**，按 `apiTypeMatch` 分布：`anthropic-messages` 38、`openai-chat-completions` 24、`openai-responses` 10
（早期版本只记了前两种，第三种是遗漏 —— 对应 DSH 的 `api: "openai-responses"`）。

`providerSiteRules` 再按站点收窄，例如 `glm-5.3-flash` @ `https://opencode\.ai/zen/go/v1/?`：

```json
{"modelMatch":"glm-5\\.3-flash","baseUrlMatch":"https://opencode\\.ai/zen/go/v1/?",
 "apiTypeMatch":"openai-chat-completions",
 "config":{"properties":{"contextWindow":1000000,
     "inputFormat":{"supportsText":true,"supportsImage":true,"supportsVideo":true,
                    "supportsAudio":false,"supportsPdf":true}, ...},
   "optionSpecs":{"reasoningLevel":{"values":["low","high","max"],
                                    "map":"{\"reasoning_effort\": reasoningLevel}"},
                  "maxOutputTokens":{"max":131072,"map":"{\"max_tokens\": maxOutputTokens}"}}}}
```

**对 DSH 的意义**：DSH 的 `reasoningEfforts` 是 `{等级键: wire 拼写}`
—— 键 = 选择器提供的档位，值 = 协议里实际发送的拼写。
**zcode 的 `values` + `map` 恰好就是这个信息的两半**，可以直接搬运。

### 2.6 zcode 的覆盖范围（84 条正则的模型族）

```
glm-* / codegeex-4 / charglm-4 / emohaa
gpt-5.6 / gpt-5.3-codex / gpt-6-astra / gpt-5.4(-pro/-mini/-nano)
claude-(fable|opus|sonnet|mythos)-5 / claude-haiku-4.5
grok-4.6 / grok-build-0.1 / grok-4.3
kimi-k3 / k3-256k / kimi-k2.7-code / kimi-k2.6 / kimi-k2.5
moonshot-v1-{8k,32k,128k}(-vision-preview)
MiniMax-M3 / M2.7(-highspeed) / M2.5(-highspeed) / M2.1(-highspeed) / M2
deepseek-v4-flash / deepseek-v4-pro / deepseek-flash / deepseek-v4.1-flash
qwen3.8-(max|flash) / qwen3.5-plus|flash / qwen3-max / qwen-plus|flash
qwen3-vl-plus / qwen3.7-max|plus|flash / qwen3.6-plus|flash / qwen3.8-omni-flash
mimo-v2.5(-pro) / mimo-v2-pro / mimo-v2-omni
```

> ⚠️ **这张表是 zcode 自己的覆盖范围，明显偏 GLM/智谱系**（zcode 与智谱同源）。
> 它**不覆盖** Gemini、Mistral、Llama 等。所以本插件**借鉴范式、自行扩表**，
> 不直接照搬覆盖面（见 §3.2）。

---

## 3. 本插件的注册表：同样的范式，自己的表

**用户已拍板：数据来源 = A 内置离线表。**
（不联网、随插件版本更新、工作量最小；`data/` 独立一层，将来换联网方案只改这一层。）

### 3.1 数据结构：有序规则数组 + 分层覆盖

```js
// data/model-rules.js —— 照 zcode 范式，规则按顺序累加，后者覆盖前者
export const BASE_RULE = {                 // 等价 zcode 的 modelRules[0]（.*）
  contextWindow: 262144,                   // 与 pi-ai 适配器默认一致
  maxTokens: 32768,
  input: ['text'],
  reasoningEfforts: undefined              // 未声明 → 不写该字段
};

export const MODEL_RULES = [
  { match: /(?:^|[.\-:/[])(?:gpt-4o|gpt-4\.5)(?:[.\-:/[].*)?$/i,
    displayName: 'GPT-4o', vendor: 'openai',
    contextWindow: 128000, maxTokens: 16384,
    input: ['text', 'image'],
    reasoningEfforts: false,               // 非推理模型 → 写 false
    source: 'https://platform.openai.com/docs/models/gpt-4o' },

  { match: /(?:^|[.\-:/[])(?:o3|o4-mini)(?:[.\-:/[].*)?$/i,
    displayName: 'OpenAI o 系列', vendor: 'openai',
    contextWindow: 200000, maxTokens: 100000,
    input: ['text', 'image'],
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
    source: 'https://platform.openai.com/docs/guides/reasoning' },

  { match: /(?:^|[.\-:/[])(?:claude-(?:opus|sonnet|haiku)-[\d.]+)(?:[.\-:/[].*)?$/i,
    displayName: 'Claude', vendor: 'anthropic',
    contextWindow: 200000, maxTokens: 64000,
    input: ['text', 'image'],
    // Anthropic 走 thinking budget，档位映射到 effort
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
    source: 'https://docs.anthropic.com/en/docs/about-claude/models' },

  { match: /(?:^|[.\-:/[])(?:gemini-[\d.]+-(?:pro|flash|ultra))(?:[.\-:/[].*)?$/i,
    displayName: 'Gemini', vendor: 'google',
    contextWindow: 1048576, maxTokens: 65536,
    input: ['text', 'image'],
    reasoningEfforts: { off: null, low: 'low', high: 'high' },
    source: 'https://ai.google.dev/gemini-api/docs/models' },

  { match: /(?:^|[.\-:/[])(?:deepseek-(?:v[\d.]+-)?(?:pro|reasoner)|deepseek-reasoner)(?:[.\-:/[].*)?$/i,
    displayName: 'DeepSeek 推理模型', vendor: 'deepseek',
    contextWindow: 1000000, maxTokens: 384000,
    input: ['text'],
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
    source: 'https://api-docs.deepseek.com/guides/reasoning_model' },

  // ... 其余主力族：Qwen / GLM / Kimi / MiniMax / Grok / Mistral / Llama
];
```

**与 zcode 的三处刻意差异**：

| 维度 | zcode | 本插件 | 原因 |
|---|---|---|---|
| 匹配键 | 正则字符串（JSON 内） | 正则字面量 `/.../i` | 本插件是 JS 模块，字面量可单测、可静态检查 |
| 输入模态 | 五项 `supports*` | 收敛成 DSH 的 `['text','image']`，其余项**只展示不写** | DSH 的 `input` 只接受 `text`/`image`（pi-ai `MODALITIES`） |
| 推理等级 | `values` + `map` 表达式 | 直接写 `reasoningEfforts: {键: wire值}` | DSH 要的就是这个形状，无需再求值表达式 |

### 3.2 覆盖范围

zcode 的表偏 GLM 系且缺 Google/Meta/Mistral，所以**自行扩表**，按厂商铺：

> **当前规模（v0.2.0）**：`MODEL_RULES` **201 条** / **33 家厂商**，`noSource: 0`（其中 34 条为家族兜底 `generic: true`）。
> 演进：v0.1.0 首批 11 家 → v0.1.1 增补 4 条线（Gemma / 混元 / MiMo / 智谱老线 + K3 世代）→ v0.1.2 按用户圈正再补 20 家（见 §3.2.1）→ v0.2.0 按官方规格校正 8 家国内厂商最新代次（见 §3.2.2），复核其余 17 家（见 §3.2.3），修掉 `extraInputs` 继承缺陷（见 §3.2.4），并校正 8 家国外厂商最新代次（见 §3.2.5）。

> **v0.1.0 首批 11 家厂商**（下表 10 行，Mistral 与 Meta 合占一行）—— 即用户已确认「我比较满意」的那份清单。
> 11 家 = OpenAI、Anthropic、Google、DeepSeek、阿里、智谱、月之暗面、MiniMax、xAI、Mistral、Meta。

| 厂商 | 覆盖 | 备注 |
|---|---|---|
| OpenAI | `gpt-5.x` / `gpt-4o` / `gpt-4.1` / `o1` `o3` `o4-mini` | o 系列有推理档位 |
| Anthropic | `claude-*`（opus/sonnet/haiku，含带日期后缀） | 支持图像 |
| Google | `gemini-*`（pro/flash/ultra）+ `gemma-*`（2/3/4 代） | Gemini 1M 上下文；Gemma 是开源线，与 Gemini 两条线 |
| DeepSeek | `deepseek-*`（chat/reasoner/v4 系） | 本机在用的就是这条线 |
| 阿里 | `qwen-*` / `qwen3-*`（含 `-vl-` 视觉系） | `-vl-` 必带图像 |
| 智谱 | `glm-*`（含 `-v-` / `-4.6v` 视觉系）+ 老线 `codegeex` / `charglm` / `emohaa` | 可复用 zcode 已实测的档位 |
| 月之暗面 | `kimi-*` / `moonshot-v1-*` / K3 短名 `k3` / `k3-256k` | `-vision-preview` 带图像 |
| MiniMax | `MiniMax-M*` | 档位多 |
| xAI | `grok-*` | |
| Mistral / Meta | `mistral-*` / `llama-*` | zcode 表缺，本插件补齐 |

> **v0.1.1 增补（用户 点名 + zcode 已实证）**
>
> | 厂商 | 覆盖 | 依据 |
> |---|---|---|
> | 腾讯混元 | `hy3` / `hy4-preview` / `hunyuan-*` / `hunyuan-t1` | 腾讯云 TokenHub 模型列表：Hy3 上下文 256k / 最大输出 128k；Hy4 preview 1M / 64k。**纯文本**（官方能力列无图像标签；第三方实测传图返回 HTTP 400、社区文档明确为纯文本模型 —— v0.2.0 已把依据补进 `note`），`reasoning_effort` 取 `no_think` / `low` / `high` |
> | 小米 MiMo | `mimo-v2.5` / `-pro` / `v2-pro` / `v2-omni` / `v2-flash` | zcode 表已实测：v2.5 1M 上下文且带图像/视频/音频；omni 262144 带图像/视频；flash 262144 |
>
> **注意**：zcode 表里的 `spark`（`gpt-5.3-codex-spark`）与 `nemotron`（`nemotron-3-ultra-free`）只是第三方聚合站自造的模型名，**不是独立厂商**，故不收录。

**表内每条必带 `source`**（官方文档 URL）—— 这是「官方文档」途径的落点，也让用户能核对依据。

### 3.2.1 v0.1.2 增补：按用户圈正收录的 20 家厂商

用户对下述 20 家**全部勾选收录**。它们**不在 zcode 表内**（zcode 的厂商在 v0.1.1 已被全部覆盖，缺口 0），故规格一律取自各厂商官方文档。

| 厂商 | vendor | 覆盖家族 | 关键规格依据 |
|---|---|---|---|
| 百度文心 | `baidu` | `ernie-*` / `wenxin` | `ernie-5.0` 128k / 全模态（文图音视频）/ `enable_thinking` 布尔开关 |
| 字节豆包 | `bytedance` | `doubao-*` / `doubao-seed-*` | seed 系 256k / text+image / `thinking.type` 三态 |
| 阶跃星辰 | `stepfun` | `step-*` / `stepfun` | `step-5-preview` 1M / 图+视频 / low-medium-high |
| 零一万物 | `01ai` | `yi-*` | 官方站为 SPA 取不到，数字属二手口径（已在 `note` 标注） |
| 百川智能 | `baichuan` | `baichuan[0-9]?` / `-m[0-9]` | 32k / 支持 thinking 但官方未公布档位词元 |
| 讯飞星火 | `xfyun` | `spark-*` / `generalv*` | X2 输出 128k / `thinking.type` 三态；**不用裸 `spark`**（会被聚合站自造名误吃） |
| 商汤日日新 | `sensenova` | `sensenova-*` / `sensechat-*` | V6.5 128k / `thinking` 是必传 object（仅开/关） |
| 华为盘古 | `huawei` | `openpangu` / `pangu-*` | 2.0 512k / 最大输出 128k |
| 昆仑天工 | `skywork` | `skyclaw` / `skywork-*` | 官方仅公布 1M 与图像输入 |
| 面壁 MiniCPM | `modelbest` | `minicpm*` | 5 代 131072 / `-V` 系 262144 带图+视频 |
| 上海 AI Lab | `internlm` | `internlm*` | 3 代 32768；2.5 的 1M 与 262144 两口径冲突已在 `note` 标注 |
| 微软 Phi | `microsoft` | `phi-*` | ⚠️ `phi-4` 是 16384，`phi-4-mini` 是 131072 —— 官方值，勿按「mini 更小」推断 |
| Cohere | `cohere` | `command-*` | command-a 256k / thinking = 开/关 + `token_budget` 数值 |
| AI21 | `ai21` | `jamba` | 256k / **官方明确无视觉变体** |
| 亚马逊 Nova | `amazon` | `nova-*` | id 带区域前缀（`us.`/`eu.`/`apac.`…）；Nova 2 lite 1M 且官方有 low-medium-high 三档 |
| NVIDIA Nemotron | `nvidia` | `nemotron*` | Super/Ultra/Lightning 1M；Nano 的 128K 与 1M 冲突取保守值 |
| IBM Granite | `ibm` | `granite*` | 4.2 代原生 128k（可扩展 512k） |
| AI2 OLMo | `allenai` | `olmo*` | 全系 65536；用 id 后缀 `-Think` / `-Instruct` 区分，非参数级分档 |
| Upstage Solar | `upstage` | `solar*` | pro4/mini4 512k / `reasoning_effort` 七档（none·minimal 为关） |
| Reka | `reka` | `reka-*` | flash-3 64k / edge 16k 带图+视频且不支持推理 |

**收录原则（贯穿全表）**：

1. 官方只给**开/关**布尔开关、或只用 **id 后缀变体**（`-Think`/`-Instruct`）表达思考的，`reasoningEfforts` 一律写 `undefined`，**不把布尔开关硬塞成 low/medium/high 档位**；
2. 只有官方明确列出档位词元时才写 `E(...)`；
3. 官方未公布的数值留空并在 `note` 写明冲突与出处，**不臆造**；
4. 每条必带 `source`。

**规则顺序护栏**：合并是「后者覆盖前者」，故**宽规则必须排在具体规则之前**。`test/rules.test.mjs` 已有两条程序化自检守住这一点（自动枚举遮蔽对 + 假阳性 `MUST_MISS`）。

### 3.2.2 v0.2.0 校正：8 家国内厂商按官方规格更新到最新代次

v0.1.2 的表存在两类问题：① **代次过时**（小米停在 v2.5、智谱停在 glm-5.3 而无 5.2/5.1、Kimi 停在 k3 而无 k2.6/k2.7/k2.8、MiniMax 停在 M2）；② **把「开/关」布尔开关硬塞成分档**（MiMo 全系写 `E('high')`，但官方只有 `thinking.type=enabled|disabled`）。本轮逐家回官方文档核对后重写（采集时间 **2026-10-09**）。

| 厂商 | v0.2.0 校正内容 | 官方来源 |
|---|---|---|
| 小米 MiMo | 新增 **v2.6 三款**（`v2.6-pro` / `v2.6-flash` / `v2.6-pro-ultraspeed`：1M / 128K / text+image+video+audio）；删掉全系硬塞的 `E('high')`；v2.5 系改 1048576、`-pro` 改回纯文本；v2-pro/omni/flash 标注下线日期 | `https://mimo.mi.com/docs/zh-CN/quick-start/summary/model` |
| 智谱 GLM | 新增 `glm-5.2` / `glm-5.1` / `glm-4.7` / `glm-4.5-air` / `glm-4-long`；`glm-5.3` 改 1048576 / 131072 且标注**思考不可关**（`thinking.type` 仅 enabled） | `https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md` |
| 月之暗面 | 新增 `kimi-k2.5` / `k2.6` / `k2.7` / `k2.8-preview`（末者在 `note` 标注**二手**）；`kimi-k3` 标注无 thinking 参数、`reasoning_effort` 默认 max | `https://platform.kimi.com/docs/guide/kimi-k3-quickstart.md` |
| MiniMax | 新增 `M3` / `M3.1`（1048576 / 524288 / text+image+video / 五档）；`m2` 的 maxTokens 8192 → 131072；新增 `M2.7`/`M2.5` | `https://platform.minimax.io/docs/api-reference/text-chat-openai.md` |
| 腾讯混元 | `hy3` → 262144 / **131072**；`hy4-preview` → **1048576** / 65536；新增 `hunyuan-a13b` / `turbos-vision-video` / `hy-mt2`；纯文本依据补进 `note`（官方能力列无图像标签 + 第三方实测传图 HTTP 400） | `https://www.tencentcloud.com/zh/document/product/1300/81572` |
| 百度文心 | 新增 `ernie-5.1`（text）与 `ernie-5.0`（text+image）；档位写 `E('high','max')`（官方 low/medium 会被映射为 high，实际只有两档） | `https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j` |
| 字节豆包 | 新增 `seed-2.1`（1M / 262144）/ `seed-evolving` / `seed-character` / `seed-translation`；`seed-2.0` 改 262144 / 131072 | `https://www.volcengine.com/docs/82379/1330310` |
| 阶跃星辰 | `step-5-preview` 改 1048576 / 65536；`step-3.7` 标注默认 medium | `https://platform.stepfun.com/docs/zh/guides/models/step-5-preview.md` |

**本轮踩到并已修的两个坑**：

1. **`ernie-5` 必须排在 `ernie-5.1` 之前** —— 顺序护栏报 `#91 (文心 5.1) 被 #92 (文心 5.0) 反向覆盖 via "ernie-5-1"`。家族兜底在前是硬约束。
2. **`kimi-k3` 的 maxTokens 上限是 1048576，表里取的是默认值 131072** —— 上限与默认值语义不同，取默认值并在 `note` 写明，避免把「可调到 1M」误当成「推荐输出 1M」。

### 3.2.3 v0.2.0 校正（续）：其余 17 家厂商按官方规格复核

同一轮另派一路扫描覆盖 v0.1.2 新增的其余 17 家（01ai / 百川 / 讯飞 / 商汤 / 华为 / 天工 / 面壁 / 书生 / 微软 / Cohere / AI21 / Nova / NVIDIA / IBM / AI2 / Upstage / Reka），采集时间 **2026-10-09**。发现的问题与处置：

| 厂商 | 校正内容 | 官方来源 |
|---|---|---|
| 百川 | 新增 `Baichuan-M3-235B`：ctx **40960**（HF `config.max_position_embeddings` 精确值）；思考为 chat template 关键字 `thinking_mode="on"`，**非 reasoning_effort 档位**，故不写 `reasoningEfforts` | `https://huggingface.co/baichuan-inc/Baichuan-M3-235B` |
| 商汤 | 明确 6.7 为上一代、预览 id 为 `sensenova-6.8-flash-lite`；官方**明确不公布** ctx/maxOut，故容量继承兜底值、**不臆造填数** | `https://www.sensenova.cn/models` |
| 书生 | 新增科学多模态线 `intern-s`（65536）与 `intern-s2`（262144，text+image+video+ts）；原 `internlm` 泛规则 32768 对科学线不适用 | `https://huggingface.co/InternLM/Intern-S2-Preview` |
| AI21 | **删除 maxTokens 4096**（官方无此数字）；`note` 补精确 id 映射与弃用表（`jamba-mini-1.7` 2026-02-01 下线、1.6 系 2025-08-03 已下线、Jamba 3B 无 API Endpoint） | `https://docs.ai21.com/docs/jamba-foundation-models` |
| 亚马逊 Nova | **新增 `nova-2-sonic`**：1M / 64K，输入 text+**audio**（官方 Input = Audio/Speech/Text，**无 Image/Video**）；仅 `InvokeModelWithBidirectionalStream`、仅 In-Region。**Nova Micro 补 `extraInputs: []`**（见下） | `https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-sonic.md` |
| NVIDIA | 新增 `nemotron-3-ultra`（2026-06-03）与 `nemotron-3.5-lightning`（2026-08-01），两者 README 抓取失败 → **只登记存在与来源、不填数字**；`nemotron-3-nano` 取较保守的 131072（NIM 页 128K 与 HF 卡 1M 冲突） | `https://build.nvidia.com/nvidia` |
| Upstage | Solar Pro4/Mini4 档位**收窄为 `E('low','high')`**（官方博客只举这两档；原 medium/xhigh/max 无官方依据）；补关键区别：Pro 4 默认开推理、Mini 4 默认关 | `https://console.upstage.ai/docs/models/solar-pro-4` |
| Reka | `reka-edge` maxTokens 14745 → **16384**（官方 `/v1/models` 的 `max_output_length`）；source 指向官方目录 `https://docs.reka.ai/chat/models` | `https://docs.reka.ai/chat/models` |

**未收录（官方取不到，按「不臆造」原则留白）**：01ai 全部规格仅二手可得（且一方 API 疑已关闭）；讯飞 Spark-X2.5 官方文档未更新；Cohere Command A 是否真支持 Image Inputs 官方 Capabilities 与文档冲突，**存疑未改**。

### 3.2.4 继承缺陷：`extraInputs` 会被更宽的规则污染
`rules/match.js` 的合并是「只覆盖 `!== undefined` 的字段」，因此**一条把 `input` 收窄成纯文本、却不写 `extraInputs` 的规则，会从上面更宽的规则继承到视频/音频**，解析出「纯文本 + 视频音频」的自相矛盾结果。

- 真实案例一：`mimo-v2.5-pro`（官方纯文本）继承了 `mimo-v2.5`（全模态）的 `['video','audio']`。
- 真实案例二：`us.amazon.nova-micro-v1` 继承了 `nova` 家族兜底的 `['video']`。
- **修法**：在收窄 `input` 的具体规则里**显式写 `extraInputs: []`**。

**永久护栏**（`test/rules.test.mjs`）：逐条真实模型名解析后，若**最终生效的那条规则显式声明了 `input` 却没声明 `extraInputs`**、且结果出现「纯文本 + 非空 extraInputs」，即判失败。判据必须看生效规则有没有显式声明 —— `nova-2-sonic` 是纯文本**输入**（Speech/Audio）的语音模型，它的 `extraInputs: ['audio']` 是官方事实、不是继承污染，只看解析结果会误判。

### 3.2.5 v0.2.0 校正（三）：8 家国外厂商按官方规格更新到最新代次

同一轮另派一路扫描覆盖 8 家国外厂商（OpenAI / Anthropic / Google / DeepSeek / 阿里 / xAI / Mistral / Meta），采集时间 **2026-10-09**。该路报告**刻意不做逐条 diff**（子代理侧看不到基准文件），而是给「2025 常见口径 vs 2026 官方实测」对照表，由主会话逐条落表。

| 厂商 | v0.2.0 校正内容 | 官方来源 |
|---|---|---|
| OpenAI | 新增 `gpt-6-astra`（1050000 / 128000）/ `gpt-6.1-sol` / `gpt-6-sol` / `gpt-6-luna` / `gpt-5.6-sol\|terra\|luna` / `gpt-realtime-2.1`（128000 / 32000，text+image+audio）；wire 形态标注为 `reasoning.effort`（Responses 点号路径） | `https://developers.openai.com/api/docs/models/gpt-6-astra` |
| Anthropic | 新增 `claude-fable-5-1` / `claude-opus-5-5` / `claude-sonnet-5-5` / `claude-haiku-5-5`（均 1000000 / 128000 / text,image,pdf）；wire 改为 **`output_config.effort`**（不再是 `thinking.budget_tokens`） | `https://platform.claude.com/docs/en/about-claude/models/overview` |
| Google | 新增 `gemini-3.8-flash`（1048576 / 65536）/ `gemini-3.7-flash` / `gemini-3.1-pro-preview`；wire 改为 **`thinking_level`**（low/medium/high，minimal 报错）。Gemma 4 家族按官方补齐 5 条（`gemma-4-31B-it` / `26B-A4B` / `12B` = 262144，`e4b` / `e2b` = 131072） | `https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash` |
| DeepSeek | 新增 `deepseek-flash`（V4.1-Flash，带 Vision）与 `deepseek-v4-pro`（无 Vision），均 1000000 / 393216；wire 为 `thinking.type` + `reasoning_effort` **双参数** | `https://api-docs.deepseek.com/quick_start/pricing` |
| 阿里 Qwen | 新增 `qwen3.8-max`（1000000 / 131072）/ `qwen3.8-flash` / `qwen3.8-omni-flash`（text+image+audio+video）/ `qwen3.7-*`；`qwen3.7-max` 标注**纯文本输入** | `https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max` |
| xAI | 新增 `grok-4.7`（500000）/ `4.6` / `4.5`（均 500000）/ `grok-4.3`（1000000）/ `grok-build-0.1`（256000）；note 写明官方口径是「No text output limit」而非某个数字 | `https://docs.x.ai/developers/models/grok-4.7` |
| Mistral | 新增 `mistral-large-4-0`（**1000000**，v26.10 Public Preview，多模态）/ `mistral-medium-3-5-26-04`（256k）/ `mistral-small-4-0-26-03`（256k）；wire `reasoning_effort` 只有 none/high 二值 | `https://docs.mistral.ai/models/mistral-large-4-0` |
| Meta | **新增 Muse 线**（2026 现役，Llama 开源线止于 2025-04）：`muse-spark-*`（1048576 / text+image+video+audio+pdf / `reasoning_effort` 的 `minimal…xhigh`，`max` 仅 Standard tier 可用、思考不可关）与开放权重 `muse-glimmer`（131072 / 30B dense / Apache 2.0） | `https://dev.meta.ai/docs/models` |

**Meta Muse 与 Llama 的口径冲突已核**：早期调研（G3 与首轮 zcode 对照）把 `muse-spark` 判为第三方聚合站自造名，本轮经官方域名 `dev.meta.ai` 复核（文档逐字列出 Muse Spark / Muse Image / Muse Voice Transcribe / SAM / Muse Glimmer 五个家族，且 `muse-spark-1.3` 与 `1,048,576` 均在页面内），**确认为 Meta 官方 2026 现役线**，故收录；同时保留 `llama` 家族规则并标注其止于 2025-04。

**本轮踩到并已修的两个坑**：

1. **跨厂商尾缀误吃（真 bug）**：讯飞星火规则用的 `m('spark[-.]?[0-9]|…')` 前缀类**含 `-`**，把 `muse-spark-1.3` 的尾缀 `-spark-1` 也吃了进来 → `muse-spark-*` 的 vendor 被判成 `xfyun`。因 `rules/match.js` 是**全量收集命中 + 按序覆盖**（不是首个命中即定），把 Meta 条前移**修不了**这个问题。**修法 = 把该规则的前缀边界收窄为 `(?:^|[:/\[\s])`，去掉 `-`** —— Spark 的真实 id（`spark-x2` / `generalv3.5` / `spark-4.0-ultra`）只会出现在名首或 `/` 之后。
2. **`extraInputs` 与 `input` 的模态归属**：`gpt-realtime-2.1` 官方输入含 audio 与 image，而 `image` 是 DSH 可写模态、必须进 `input`、不能在 `extraInputs` 里重复（测试 `规则表自检：input 只含 DSH 认识的模态，extraInputs 不与之重复` 抓到）。

**尾缀误吃的永久护栏**：`test/rules.test.mjs` 的 `REAL_MODEL_NAMES` 清单（现 **208 项**）逐条过真实 `resolveSpec`，跨厂商名（如 `muse-spark-1.3`）必须落到自己的厂商。

### 3.3 命中算法

```
输入：raw 模型名
① 归一化（§3.4）
② 遍历 MODEL_RULES，取所有 match 命中的规则
③ 按顺序合并：BASE_RULE ← 命中的规则（后者覆盖同名字段）
④ 产出 {displayName, vendor, contextWindow, maxTokens, input, reasoningEfforts, source,
        matchedRules: [索引...], confidence}
```

> ⚠️ **数组顺序即优先级 —— 这是硬约束，不是风格问题。**
> 因为「后者覆盖前者」，`MODEL_RULES` **必须按「从泛到具体」排列**：
>
> ```
> 兜底默认 → 厂商族（.*glm-5） → 具体型号（.*glm-5\.3） → 变体（.*glm-5\.3-flash）
> ```
>
> 与 zcode 的 `modelRules` 一致（它的 `[0]` 是 `.*` 兜底，`[3]`→`[6]`→`[7]` 逐级收窄）。
> **写规则时若把具体型号放在族规则之前，它会被族规则覆盖掉。**
> 单测必须包含「顺序敏感性」用例（见 §8）。

`confidence` 取值：

| 值 | 含义 |
|---|---|
| `exact` | 命中一条**不以 `.*` 开头**的精确名规则 |
| `pattern` | 只命中通用模式规则 |
| `none` | 未命中任何规则（只剩 `BASE_RULE`） |

**保留 `matchedRules` 索引**：UI 上可显示「依据规则 #12 + #15」，出问题时能直接定位。

### 3.4 归一化规则（在正则匹配之前做）

| 步骤 | 规则 | 示例 |
|---|---|---|
| 1 | 去首尾空白 | `" gpt-4o "` → `gpt-4o` |
| 2 | 剥离组织前缀 `org/` | `openai/gpt-4o` → `gpt-4o` |
| 3 | 统一分隔符 `.` `_` → `-` | `claude_3.5_sonnet` → `claude-3-5-sonnet` |
| 4 | **不剥离**日期/变体后缀 | `gpt-4o-2024-11-20` 保持原样 |

**第 4 步与早期版本相反，是刻意的**：zcode 的正则已经把「名 + 边界符 + 任意后缀」
写进模式（`(?:[.\-:/[].*)?`），**归一化再剥后缀反而会破坏匹配**。
`raw` 原串与 `normalized` 都保留，UI 显示用 `raw`。

#### 3.4.1 别名与前缀（第三方聚合器的必要补充）

**问题**：第三方聚合站（OpenRouter、各类中转）普遍给模型加**厂商前缀**或**改写成别名**，
同一个模型在不同站点的名字可能完全不同。只做 `org/` 剥离不足以覆盖。

```
openai/gpt-4o              → 已由第 2 步覆盖
anthropic/claude-3.5-sonnet → 已由第 2 步覆盖
deepseek/deepseek-chat      → 已由第 2 步覆盖，但 deepseek-chat 本身还需别名
moonshotai/kimi-k3          → 已由第 2 步覆盖
models/gemini-2.5-pro       → 前缀是 `models/`，第 2 步同样覆盖
```

**别名表**（`ALIASES`，在归一化之后、正则匹配之前应用）：

```js
export const ALIASES = [
  // [别名正则, 归一到的规范名]
  [/^deepseek-chat$/i,            'deepseek-v4-flash'],   // 官方 chat 端点
  // 固定历史型号（deepseek-v3 / v3.1 / r1 / coder）不映射到新世代。
  [/^gpt-4o-latest$/i,            'gpt-4o'],
  [/^claude-3-5-sonnet-latest$/i, 'claude-3-5-sonnet'],
  [/^gemini-pro$/i,               'gemini-1.5-pro'],
];
```

**设计约束**：
1. **别名只改匹配用的名字，不改显示名** —— UI 仍显示用户输入的 `raw`，
   只在旁边标注「按 `deepseek-v4-flash` 处理」。
2. **别名表命中要留痕**：`matchedAlias` 字段进结果对象，便于排查误判。
3. **别名表保持短小**：只收「确定同一模型」的等价写法；
   不确定的（如某站自造的 `-free` / `-thinking` 变体）**不加别名**，
   交给正则的 `(?:[.\-:/[].*)?` 后缀容错去命中基础型号。
4. 未命中别名表也不影响匹配 —— 别名是**补充**，不是前置门槛。

---

## 4. 多模态判定（依据：模型公开信息）

```
① 注册表命中       → 采用规则合并后的 input
② 未命中           → 端点 /models 若返回 inputModalities 则采用（第三方端点通常没有）
③ 再未命中         → 不写 input，UI 标注「未识别」，让用户勾选
```

**默认策略**：注册表命中的值直接填入（用户已指定「按模型公开信息进行判断并填写」），
但 UI 上保持可编辑，并显示来源标签 `公开信息` / `端点返回` / `未识别`。

**保守规则**：点击智能匹配时，规则建议若与已保存的逐模型 `models[].input` /
`modelOverrides[id].input` 或本次手动勾选冲突，保留用户选择并提示手动确认；
provider 的默认 `text` 不当作逐模型显式声明。其它可写字段不因此被阻塞。
禁用的复选框、点击后未保持目标状态的复选框不计为写入成功。
异步回填还需核验原行、模型 ID、可见草稿与所属模型页仍然有效。

**zcode 的额外能力位**（`supportsVideo` / `supportsAudio` / `supportsPdf`）：
DSH 的 `input` 表达不了，**只在卡片上作为参考信息展示**（例：「该模型公开信息显示还支持视频/PDF 输入」），
不写进配置，避免写入 DSH 不认识的字段。

---

## 5. 思考等级判定（依据：官方文档 / 测试）

独立目录元数据必须携带可信来源，不能把当前配置当成外部事实：

- `msc/authoritative` 保留兼容端点名和返回值，但当前 `resolveModelInfo` 结果标为
  `source: 'resolved-config'`，仅诊断，不覆盖注册表。它已混合用户配置、目录与默认值，
  无法据此判断字段究竟来自哪里；缺少来源的旧响应同样不写。
- 只有明确 `source: 'catalog'` 的独立元数据才作为优先补全；当前宿主未提供此能力证明。
- S1 内置表采用逐字段来源；S3 仍由用户主动触发；S4 名称启发式只展示候选。

```
有来源的独立 catalog 元数据（若接口明确支持）
   └─ 无该字段                   ↓
S1 内置规则表（逐字段验证来源）
   ├─ false                     → 写 reasoningEfforts: false（非推理模型）
   ├─ 对象（至少一个非 off 档）  → 写该对象
   └─ undefined（未命中）        ↓
S3 实测探测（用户点「测试」；默认不自动发）
   ├─ 能判定                    → 给探测结论
   └─ 不能判定                  ↓
S4 名称启发式（兜底候选，不自动写）
   └─ 按模型名模式给候选档位集合，UI 让用户确认
```

### 5.1 实测探测怎么做（S3 的实现）

**这一步是「测试」途径的落点，也是 Host 半存在的第二个理由。**

> **成本前提（必须让用户知道）**：探测会向用户自己配置的第三方 API 发**真实请求**，
> 消耗少量额度。所以默认 `allowProbe: false`，只有用户点卡片上的「测试」才发起。

**按能力拆分探针，每项独立、各自控制成本** —— 不做一次「大探测」：

| 探针 | 请求 | 观察 | 成本 |
|---|---|---|---|
| **推理** | `POST {baseURL}/chat/completions`，`{model, messages:[{role:user,content:"hi"}], max_tokens:1}` | 响应含 `reasoning_content` / `reasoning` 字段或块 → 支持思考 | 极小 |
| **等级** | 同上但带 `reasoning_effort: <档位>`，逐档试 | 200 且行为变化 → 支持该档；报 `unknown parameter` → 不支持 | 每档一次 |
| **多模态** | 带一张**最小图片**（1×1 PNG，几十字节）的多模态消息 | 200 → 支持图像；4xx 明确拒绝 → 不支持 | 极小 |
| **上下文** | 逐步加长的长文本 | 报 context length 错误时的临界值 | **高，首版不做** |

**上下文窗口不靠探测**：它必须发超长请求才能测出边界，成本不可控。
→ 上下文一律取「注册表值 / 端点返回的 `contextWindow`」，**探测不覆盖它**。

**探测结果一律是「建议值」，不自动落库**：
1. 结果填进**当前配置表单**，字段旁标注来源 `实测`；
2. 用户点「应用」/「保存」才经 `settings.mutate` 写入；
   > ⚠️ **v0.3.0 起这条已改**：插件**不再自己 `settings.mutate`**（会顶掉 revision，导致官方随后保存撞
   > `settings/conflict`）。现行做法 = 把值填进**官方受控控件**，由官方「保存」走它自己的
   > `pathOps` 落库；且写入只发生在用户点行内「智能匹配」键那一次（v0.3.1）。
   > 见 [`docs/02-architecture.md`](02-architecture.md) §4 的 v0.3.0 声明。
3. **实测值不回流内置离线表** —— 离线表是插件资产、随版本更新；
   把用户实测结果混进去会引入「本地数据 vs 内置表」的分层同步问题
   （用户在 A 站测出的结论未必适用于 B 站）。

> 这是刻意的取舍：**离线表是判定主来源，探测只是补空**。
> 将来若确实需要「同模型复用实测值」，再加一层 `LOCAL_OVERRIDES`，
> 覆盖顺序定义为 `BASE ← MODEL ← SITE ← LOCAL`（本地最具体，最后覆盖），
> 但首版不做。

### 5.2 zcode 词表 → DSH `reasoningEfforts` 的映射

**关键约束**（pi-ai 适配器实读校验）：`reasoningEfforts` 若只声明 `off` 一个档会被拒绝
（报 `offers no level beyond "off"`）；`off` 的值只能是 `null`；非 off 档的值不能是 `null` 或空串。

| zcode `values` | DSH `reasoningEfforts` |
|---|---|
| `["disabled","enabled"]`（27 条，最常见） | `{off: null, high: '<wire>'}` |
| `["enabled"]` | `{off: null, high: '<wire>'}` |
| `["none","low","medium","high","xhigh"]` | `{off: null, low, medium, high, xhigh}` |
| `["disabled","low","high","max"]` | `{off: null, low, high, max}` |
| `["low","high","max"]`（无关闭档） | `{off: null, low, high, max}` —— `off` 表示**不发送**推理参数，安全 |
| `["disabled","high","max"]` | `{off: null, high, max}` |
| 非推理模型（无该字段 / `map: "{}"`） | `false` |

**`<wire>` 的取值由协议决定**（对应 zcode 的 `map` 层）。
默认规则：**wire 值 = 档位键本身**（`low→'low'`、`medium→'medium'`、`high→'high'`、
`xhigh→'xhigh'`、`max→'max'`），只有站点特殊时才改 —— 这正是 zcode 的 `map` 所做的事：

| DSH `api` | 档位键 → wire 值 |
|---|---|
| `openai-completions` | 默认同名直传；部分站点只认 `reasoning_effort`（见 §5.3） |
| `anthropic-messages` | 默认同名直传（走 thinking / effort） |
| `openai-responses` | 默认同名直传（zcode 写 `{"reasoning":{"effort":<level>}}`，`disabled→"none"`、`enabled→"high"`） |

**上表只列 `low/medium/high` 是早期版本的疏漏**：DSH 的档位键集是
`off/minimal/low/medium/high/xhigh/max`（`THINKING_LEVELS`），
所以规则里出现 `xhigh` 或 `max` 时，wire 值同样取同名（`xhigh→'xhigh'`、`max→'max'`），
**不需要为它们单独造词**。zcode 的做法可佐证：它给 `glm-5.3` 的 `values` 里就有 `max`，
而 `map` 是 `{"reasoning_effort": reasoningLevel}` —— 档位键原样传出去。

> DSH 的 `api` 字段取值见 `01-research.md`：`openai-completions` / `anthropic-messages` / `openai-responses`。
> `reasoningEfforts` 的**值就是发到 wire 上的拼写**，所以协议差异在这里吸收。

### 5.3 站点级覆盖（可选，对应 zcode 的 `providerSiteRules`）

部分聚合站的推理参数写法与官方不同（zcode 就为 `opencode.ai/zen/go/v1` 单独列了规则）。
本插件首版**不做站点表**，但在注册表结构里预留 `siteRules` 数组位：

```js
export const SITE_RULES = [
  // { baseURLMatch: /opencode\.ai\/zen\/go\/v1/, apiTypeMatch: 'openai-completions',
  //   reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } }
];
```

命中顺序：`BASE_RULE ← MODEL_RULES ← SITE_RULES`（站点最具体，最后覆盖）。

### 5.4 字段证据与显式未知

`BASE_RULE` 只作内部默认，不能单独形成可写建议。合并时 `fieldSources` 与
`fieldEvidence` 逐字段记录规则索引、站点规则索引及文档 URL；另一字段的 `source`
不能为默认容量或默认文本背书。容量还必须是正的安全整数。

省略字段仍允许合法的分层继承；若已知某型号未公布容量，规则用
`unknownFields: ['contextWindow', 'maxTokens']` 显式清除继承并标为 `unknown`。
SenseNova 6.7/6.8 使用此机制。固定历史 DeepSeek 型号不套用新一代 Flash 的容量、模态和档位；
缺少已核实的专属数据时宁可保留未设置，也不把“厂商识别成功”当作“能力已知”。
**首版留空**，遇到真实不兼容的站点再补 —— 不预先编造。

### 5.4 名称启发式（S4 的规则表）

仅在 S1–S3 都失败时使用，**只给候选、不自动写**：

| 名称模式 | 候选档位 |
|---|---|
| `*-r1` / `*reasoner*` / `*thinking*` / `*-think*` | `{off, low, medium, high}` |
| `o1*` / `o3*` / `o4*` | `{off, low, medium, high}` |
| `*-vl-*` / `*-v-*` / `*vision*` | 推理不定，但**模态可推为 `['text','image']`** |
| `*flash*` / `*mini*` / `*lite*` / `*turbo*` | 保守：`{off, low, medium}` |
| 其他 | 不猜，留空 |

---

## 6. 策略配置项（插件 `Config`）

| 配置项 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 插件总开关 |
| `autoApplyContext` | `true` | 允许把上下文/最大输出填进官方行 |
| `autoApplyModality` | `true` | 允许把模态填进官方行（图像开关） |
| `autoApplyReasoning` | `true` | 允许把思考等级填进官方行（仅 ① 命中时） |
| `allowProbe` | `true` | 是否**显示**「测试」按钮 |

> ⚠️ **v0.3.1 起 `autoApply*` 的含义已收窄**：它们不再表示「敲完 id 就自动填」，
> 而是**字段级许可** —— 用户点行内「智能匹配」键时，只有对应开关非 `false`
> 且该字段来源可写（`isWritableSource`）才会被填入。自动路径（`detect`）永远只读。


> **`allowProbe` 只控制入口显隐，探测永远只在手动点击时发生** —— 这是结构性保证：
> `runProbe` 只在按钮 `onClick` 里被调用，自动推断路径（`reload` → `msc/infer` +
> `msc/authoritative`）**不含**任何探测调用。所以默认显示按钮不等于默认发请求，
> 与用户拍板的「允许探测，默认需手动点『测试』」一致。

> **首版无 `registrySource` 字段**：数据来源已按 Q1 拍板为「内置离线表」，
> 且客户端不联网，该字段在实现中**没有任何读取点**，属于死旋钮，已删除
> （`Config` 不再声明，`cordis.patch.yml` 亦不再出现）。
> 若将来真要加联网（B/C 方案），再连同实现一起引入配置项，不预留空壳。

---

## 7. 未识别时的行为（准确性底线）

用户质量底线是「不静默写错值」。未命中任何规则时：

1. **不写** `input` 与 `reasoningEfforts`；
2. 卡片显示 `⚠ 未识别：<模型名>`，并列出归一化结果与最接近的候选规则（若有）；
3. 允许用户手动指定「按哪个已知模型处理」（下拉选注册表条目）；
4. 把识别结果展示给用户（`gpt-4o-2024-11-20` → 识别为 `GPT-4o`）—— **错了看得见、改得动**。

---

## 8. 规则可测性

判定规则全部写成**纯函数**，不依赖 DSH 运行时，可直接单测：

```js
normalizeModelName('openai/gpt-4o_2024-11-20')  // → {raw:'openai/gpt-4o_2024-11-20', normalized:'gpt-4o-2024-11-20'}
matchRules('claude-3-5-sonnet-20241022')        // → [10, 12]（按表内顺序的命中下标）
resolveSpec('glm-5.3-flash')                    // → {raw, normalized, alias, spec, matchedRules, matchedSiteRules, confidence}
toModelFields(spec, {normalizedName})           // → {contextWindow, maxTokens, input, extraInputs, reasoningEfforts, sources, notes}
```

> `toModelFields` 是**唯一组装出口**：`spec.input` / `spec.reasoningEfforts` 里含
> `BASE_RULE` 的兜底值（`input: ['text']` 恒存在），直读会把未识别的模型
> 判成「支持 text」。`toModelFields` 内部经 `resolveModality` / `resolveReasoning`
> 先确认「是否真命中了带 `source` 的注册表规则」，未命中即返回 `undefined`。

→ `test/rules.test.mjs` 覆盖：归一化边界、正则命中/不命中、
分层覆盖的字段合并顺序、`reasoningEfforts` 合法性（不得只有 `off`）、
未识别降级不写值。


**额外校验**（防回归）：每条 `MODEL_RULES` 的 `reasoningEfforts` 若为对象，
必须至少含一个非 `off` 键且 `off` 的值恒为 `null` —— 单测直接断言，避免手写规则时违反 pi-ai 的校验。
