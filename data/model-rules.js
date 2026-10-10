/**
 * data/model-rules.js — 内置离线模型规格注册表（本插件唯一的「数据层」）
 *
 * 范式来源：zcode 的 `modelConfigRules`（有序正则 + 分层覆盖），
 * 详见 docs/03-inference-rules.md §2 / §3。
 *
 * 三条硬约束：
 *   1. **数组顺序即优先级** —— 合并规则是「后者覆盖前者」，所以同一厂商内
 *      必须先放泛化规则（家族兜底），再放具体型号，最后放变体。
 *      把具体型号放在家族规则之前，它会被家族规则覆盖掉。
 *   2. **`input` 只能写 `text` / `image`** —— DSH 的 pi-ai 适配器只认这两个
 *      （`MODALITIES`）。视频 / 音频 / PDF 写在 `extraInputs` 里，只展示不写。
 *   3. **`reasoningEfforts` 的合法形态**（pi-ai 适配器实读校验）：
 *      - 支持思考：`{ off: null, <档位>: '<wire 拼写>', ... }`，至少一个非 off 档
 *      - 确定非推理：`false`
 *      - 不确定：`undefined`（省略该字段，沿用 catalog）
 *      ⚠ 写 `{ off: null }` 会被拒绝（`offers no level beyond "off"`）。
 */

/** 把字面量模型名片段转成正则安全的形式。 */
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 多个字面量名字的择一模式（各自转义后 join）。 */
export const alt = (...alternatives) => alternatives.map(escape).join('|');

/**
 * 构造一条规则的匹配正则。
 *
 * 形态 = `(?:^|[.\-:/\[\s])` + 名字模式 + `(?:[.\-:/\[].*)?$`
 * 即「前面是行首或边界符，名字之后允许跟变体后缀」，与 zcode 的
 * `.*<名>(?:[.\-:/\[].*)?` 等价，但要求名字前是边界，避免子串误命中。
 */
export function m(source) {
  // 归一化会把 `.` 与 `_` 统一成 `-`（见 rules/normalize.js），所以规则源码里
  // 写 `[.]` / `[-.]?` 的分隔符形态必须先折成 `-` / `-?`，否则永远匹配不上。
  // 这里做一次机械折算，让规则作者可以用「原样模型名」的写法。
  const folded = source
    .replace(/\[\.\]/g, '-')
    .replace(/\[-\.\]\?/g, '-?')
    .replace(/\[-\.\]/g, '-');
  // ⚠️ 源码里的 `|` 必须被包进非捕获组，否则交替的分支会各自丢掉前后锚点，
  //    例如 `a|b` 会变成 `(前缀)a` 或 `b(后缀$)` 两个独立分支。
  return new RegExp(`(?:^|[.\\-:/\\[\\s])(?:${folded})(?:[.\\-:/\\[].*)?$`, 'i');
}

/**
 * 构造 `reasoningEfforts`：wire 拼写默认与档位键同名。
 * 站点特殊时改用 SITE_RULES 覆盖（docs/03-inference-rules.md §5.3）。
 */
const E = (...levels) => {
  const efforts = { off: null };
  for (const level of levels) efforts[level] = level;
  return efforts;
};

/**
 * 兜底规则 —— 等价 zcode 的 `modelRules[0]`（`.*`）。
 * 值刻意与 pi-ai 适配器默认一致（`defaultContextWindow` 262144 / `defaultMaxTokens` 32768）。
 */
export const BASE_RULE = {
  displayName: undefined,
  vendor: 'unknown',
  contextWindow: 262144,
  maxTokens: 32768,
  input: ['text'],
  extraInputs: [],
  reasoningEfforts: undefined,
  source: undefined,
  generic: true,
};

/**
 * 主规则表。**顺序即优先级，从泛到具体。**
 *
 * 每条规则字段：
 *   match            必填，正则（用 m() 构造）
 *   displayName      识别出的规范显示名
 *   vendor           厂商 id
 *   contextWindow    上下文窗口（正整数）
 *   maxTokens        最大输出（正整数）
 *   input            DSH 可写入的模态数组，取值 text / image
 *   extraInputs      公开信息里的其它模态，仅展示不写入
 *   reasoningEfforts 见文件头约束 3
 *   source           官方文档 URL —— 「官方文档」途径的落点
 *   generic          true 表示家族兜底规则（影响 confidence 判定）
 *   note             卡片上展示的补充说明
 */
export const MODEL_RULES = [
  // ───────────────────────────── OpenAI ─────────────────────────────
  {
    match: m('gpt'),
    displayName: 'GPT 系列', vendor: 'openai',
    contextWindow: 128000, maxTokens: 16384,
    input: ['text', 'image'],
    reasoningEfforts: false,
    source: 'https://platform.openai.com/docs/models',
    generic: true,
  },
  {
    match: m('gpt-5'),
    displayName: 'GPT-5', vendor: 'openai',
    contextWindow: 400000, maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: E('minimal', 'low', 'medium', 'high'),
    source: 'https://platform.openai.com/docs/models/gpt-5',
  },
  {
    // GPT-6 旗舰线（Astra / Sol / Luna）。官方 2026 口径：ctx 1,050,000、maxOut 128,000。
    // ⚠️ 顺序：宽的 `gpt-6` 必须在 `gpt-6.1-sol` / `gpt-6-astra` 之前，否则具体型号被反向覆盖。
    match: m('gpt-6'),
    displayName: 'GPT-6', vendor: 'openai',
    contextWindow: 1050000, maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh', 'max'),
    note: '官方 reasoning.effort（Responses API 点号路径）/ reasoning_effort（Chat Completions）；gpt-6.1-sol 与 gpt-6-astra 不支持 none / minimal。',
    source: 'https://developers.openai.com/api/docs/models',
  },
  {
    match: m('gpt-6[-.]?1[-.]?sol'),
    displayName: 'GPT-6.1 Sol', vendor: 'openai',
    contextWindow: 1050000, maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh', 'max'),
    note: '官方：默认 medium，且不支持 none / minimal。',
    source: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol',
  },
  {
    match: m('gpt-6[-.]?astra'),
    displayName: 'GPT-6 Astra', vendor: 'openai',
    contextWindow: 1050000, maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh', 'max'),
    note: '官方旗舰（推荐起点）；不支持 none / minimal。',
    source: 'https://developers.openai.com/api/docs/models/gpt-6-astra',
  },
  {
    // GPT-5.6 线：Sol / Terra / Luna 均 1,050,000；cyber 变体为 400,000
    // ⚠️ 顺序：必须在宽的 `gpt-5` 之后（否则被 gpt-5 的 400000 反向覆盖）。
    match: m('gpt-5[-.]?6'),
    displayName: 'GPT-5.6', vendor: 'openai',
    contextWindow: 1050000, maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: E('minimal', 'low', 'medium', 'high', 'xhigh', 'max'),
    note: '官方默认 medium；`gpt-5.6` 别名路由到 Sol。cyber 变体上下文为 400,000。',
    source: 'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
  },
  {
    match: m('gpt-5[-.]?5'),
    displayName: 'GPT-5.5', vendor: 'openai',
    contextWindow: 1050000, maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh'),
    note: '官方：默认 medium，**无 max 档**；`-pro` 变体仅 medium / high / xhigh。',
    source: 'https://developers.openai.com/api/docs/models/gpt-5.5',
  },
  {
    match: m('gpt-5[-.]?4'),
    displayName: 'GPT-5.4', vendor: 'openai',
    contextWindow: 1050000, maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh'),
    note: '官方：默认 none（对应 off）；`-mini` / `-nano` 上下文为 400,000。',
    source: 'https://developers.openai.com/api/docs/models/gpt-5.4',
  },
  {
    // 400K 档的例外变体（官方逐字 gpt-5.6-cyber / gpt-5.4-mini / gpt-5.4-nano 均为 400,000）
    // ⚠️ 顺序：必须在宽的 `gpt-5.6` 与 `gpt-5.4` 之后覆盖。
    match: m('gpt-5[-.]?6[-.]?cyber|gpt-5[-.]?4[-.]?(?:mini|nano)'),
    displayName: 'GPT-5.x 400K 变体', vendor: 'openai',
    contextWindow: 400000, maxTokens: 128000,
    input: ['text', 'image'],
    note: '官方逐字上下文为 400,000 的变体（cyber / mini / nano）。',
    source: 'https://developers.openai.com/api/docs/models/gpt-5.6-cyber',
  },
  {
    match: m('gpt-5[-.]?3[-.]?codex|gpt-5[-.]?2'),
    displayName: 'GPT-5.3 Codex / GPT-5.2', vendor: 'openai',
    contextWindow: 400000, maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh'),
    note: '官方 400,000 / 128,000；gpt-5.3-codex 与 gpt-5.4-nano 已列入弃用表（2027-04-01 移除）。',
    source: 'https://developers.openai.com/api/docs/models/gpt-5.3-codex',
  },
  {
    // 实时语音模型：模态与前缀都不同，且必须排在宽的 `gpt` 之后
    match: m('gpt[-.]?realtime[-.]?2'),
    displayName: 'GPT Realtime 2.1', vendor: 'openai',
    contextWindow: 128000, maxTokens: 32000,
    input: ['text', 'image'],
    extraInputs: ['audio'],
    reasoningEfforts: undefined,
    note: '官方 128,000 / 32,000，输入含 audio 与 image（image 是 DSH 可写模态故进 input，audio 进 extraInputs 只展示不写）；未列 effort 行。',
    source: 'https://developers.openai.com/api/docs/models/gpt-realtime-2.1',
  },
  {
    match: m('gpt-4[.]1'),
    displayName: 'GPT-4.1', vendor: 'openai',
    contextWindow: 1047576, maxTokens: 32768,
    input: ['text', 'image'],
    reasoningEfforts: false,
    source: 'https://platform.openai.com/docs/models/gpt-4.1',
  },
  {
    match: m('gpt-4[.]5'),
    displayName: 'GPT-4.5', vendor: 'openai',
    contextWindow: 128000, maxTokens: 16384,
    input: ['text', 'image'],
    reasoningEfforts: false,
    source: 'https://platform.openai.com/docs/models/gpt-4.5',
  },
  {
    match: m('gpt-4o'),
    displayName: 'GPT-4o', vendor: 'openai',
    contextWindow: 128000, maxTokens: 16384,
    input: ['text', 'image'],
    reasoningEfforts: false,
    source: 'https://platform.openai.com/docs/models/gpt-4o',
  },
  {
    match: m('gpt-4[-.]?turbo'),
    displayName: 'GPT-4 Turbo', vendor: 'openai',
    contextWindow: 128000, maxTokens: 4096,
    input: ['text', 'image'],
    reasoningEfforts: false,
    source: 'https://platform.openai.com/docs/models/gpt-4-turbo',
  },
  {
    match: m('gpt-3[.]5[-.]?turbo'),
    displayName: 'GPT-3.5 Turbo', vendor: 'openai',
    contextWindow: 16385, maxTokens: 4096,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://platform.openai.com/docs/models/gpt-3.5-turbo',
  },
  {
    match: m('o4[-.]?mini'),
    displayName: 'OpenAI o4-mini', vendor: 'openai',
    contextWindow: 200000, maxTokens: 100000,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'medium', 'high'),
    source: 'https://platform.openai.com/docs/models/o4-mini',
  },
  {
    match: m('o3'),
    displayName: 'OpenAI o3', vendor: 'openai',
    contextWindow: 200000, maxTokens: 100000,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'medium', 'high'),
    source: 'https://platform.openai.com/docs/models/o3',
  },
  {
    match: m('o1'),
    displayName: 'OpenAI o1', vendor: 'openai',
    contextWindow: 200000, maxTokens: 100000,
    input: ['text'],
    reasoningEfforts: E('low', 'medium', 'high'),
    source: 'https://platform.openai.com/docs/models/o1',
  },

  // ──────────────────────────── Anthropic ───────────────────────────
  {
    match: m('claude'),
    displayName: 'Claude', vendor: 'anthropic',
    contextWindow: 200000, maxTokens: 64000,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'medium', 'high'),
    source: 'https://platform.claude.com/docs/en/models/overview',
    generic: true,
  },
  {
    // Claude 5 线（Fable / Mythos / Opus 5 / Sonnet 5 / Haiku 5）官方口径：
    // ctx 1,000,000、maxOut 128,000、模态含 pdf；wire 参数改为 `output_config.effort`。
    // ⚠️ 顺序：宽的 `claude[-.]?5` 必须在 `claude-fable-5.1` / `claude-opus-5.5` 等具体条之前。
    match: m('claude[-.]?(?:fable|mythos|opus|sonnet|haiku)[-.]?5'),
    displayName: 'Claude 5', vendor: 'anthropic',
    contextWindow: 1000000, maxTokens: 128000,
    input: ['text', 'image'],
    extraInputs: ['pdf'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh', 'max'),
    note: '官方 effort 档 max / xhigh / high / medium / low（wire：output_config.effort）。旧式 extended thinking（thinking.type=enabled + budget_tokens）在 Claude 5 线上**不被接受**，会报 "thinking.type.enabled" is not supported。',
    source: 'https://platform.claude.com/docs/en/build-with-claude/effort',
  },
  {
    match: m('claude[-.]?(?:fable|opus|sonnet|haiku)[-.]?5[-.]?5'),
    displayName: 'Claude 5.5', vendor: 'anthropic',
    contextWindow: 1000000, maxTokens: 128000,
    input: ['text', 'image'],
    extraInputs: ['pdf'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh', 'max'),
    note: '官方：opus-5-5 的 adaptive thinking **always on 不可关**（任何档位传 thinking.type=disabled 均 400）；fable-5-1 默认 high，opus-5-5 / haiku-5-5 默认 medium。',
    source: 'https://platform.claude.com/docs/en/models/overview',
  },
  {
    match: m('claude[-.]?fable[-.]?5[-.]?1'),
    displayName: 'Claude Fable 5.1', vendor: 'anthropic',
    contextWindow: 1000000, maxTokens: 128000,
    input: ['text', 'image'],
    extraInputs: ['pdf'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh', 'max'),
    note: '官方最新旗舰；effort 默认 high。',
    source: 'https://platform.claude.com/docs/en/models/fable-5-1/overview',
  },
  {
    // Claude 4.x 线（opus-4.x / sonnet-4.x / haiku-4-5）：仍是 200K / 64K，
    // 思考用**旧式** extended thinking（thinking.type=enabled + budget_tokens），
    // 与 Claude 5 线的 output_config.effort 不是同一套 wire 形态。
    // ⚠️ 顺序：必须在 Claude 5 各条之后；且不能写成会吃掉 4-5 的宽式（见上方注释）。
    match: m('claude[-.]?(?:opus|sonnet|haiku)[-.]?4'),
    displayName: 'Claude 4.x', vendor: 'anthropic',
    contextWindow: 200000, maxTokens: 64000,
    input: ['text', 'image'],
    extraInputs: ['pdf'],
    reasoningEfforts: E('low', 'medium', 'high'),
    note: '官方：1M 上下文与 128K maxOut 仅属 Fable/Opus 5.x/Sonnet 5.x/Haiku 5.5 等新线；Claude Sonnet 4.5 等 4.x 仍为 200K 上下文。思考参数为旧式 thinking.type=enabled + budget_tokens（在 4.6 及更晚型号上已弃用）。',
    source: 'https://platform.claude.com/docs/en/models/overview',
  },
  {
    // 3.0 世代与 3.5 世代无 extended thinking（3.7 才是首个支持者）
    match: m('claude-3[-.]?(?:opus|sonnet|haiku)'),
    displayName: 'Claude 3', vendor: 'anthropic',
    reasoningEfforts: false,
    source: 'https://docs.anthropic.com/en/docs/about-claude/models',
  },
  {
    match: m('claude-3[-.]?5[-.]?(?:sonnet|haiku)'),
    displayName: 'Claude 3.5', vendor: 'anthropic',
    reasoningEfforts: false,
    source: 'https://docs.anthropic.com/en/docs/about-claude/models',
  },

  // ───────────────────────────── Google ─────────────────────────────
  {
    match: m('gemini'),
    displayName: 'Gemini', vendor: 'google',
    contextWindow: 1048576, maxTokens: 8192,
    input: ['text', 'image'],
    reasoningEfforts: false,
    source: 'https://ai.google.dev/gemini-api/docs/models',
    generic: true,
  },
  {
    match: m('gemini-2[-.]?5[-.]?pro'),
    displayName: 'Gemini 2.5 Pro', vendor: 'google',
    contextWindow: 1048576, maxTokens: 65536,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'high'),
    source: 'https://ai.google.dev/gemini-api/docs/models#gemini-2.5-pro',
  },
  {
    match: m('gemini-2[-.]?5[-.]?flash'),
    displayName: 'Gemini 2.5 Flash', vendor: 'google',
    contextWindow: 1048576, maxTokens: 65536,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'high'),
    source: 'https://ai.google.dev/gemini-api/docs/models#gemini-2.5-flash',
  },
  {
    // Gemini 3 线（2026 主力）。官方逐字给数字的三款：
    //   gemini-3.8-flash / gemini-3.7-flash / gemini-3.1-pro-preview = 1,048,576 / 65,536
    // 思考参数由 2025 代的 `thinkingBudget` 改为 `thinking_level`（low/medium/high，minimal 报错）。
    // ⚠️ 顺序：必须在 `gemini`（generic）之后；与 2.5 / 1.5 段不重叠，位置无进一步要求。
    match: m('gemini[-.]?3'),
    displayName: 'Gemini 3', vendor: 'google',
    contextWindow: 1048576, maxTokens: 65536,
    input: ['text', 'image'],
    extraInputs: ['video', 'audio', 'pdf'],
    reasoningEfforts: E('low', 'medium', 'high'),
    note: '官方 thinking_level = low / medium / high（minimal 不支持并报错），默认 On(medium)。ctx / maxOut 为官方逐字值，取自 3.8-flash / 3.7-flash / 3.1-pro-preview 三款已公布数字。',
    source: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash',
  },
  {
    match: m('gemini[-.]?1[.]?5'),
    displayName: 'Gemini 1.5', vendor: 'google',
    contextWindow: 2097152, maxTokens: 8192,
    input: ['text', 'image'],
    reasoningEfforts: false,
    source: 'https://ai.google.dev/gemini-api/docs/models',
  },
  {
    // Gemma 是 Google 的开源线，与 Gemini 是两条线。
    // ⚠️ 名字后可直接跟代次数字（`gemma4:31b` / `gemma2-9b`），故用 `[0-9]?`
    //    吸收代次，否则「名字以数字结尾」会像历史上 gpt- 那条一样永不命中。
    match: m('gemma[0-9]?'),
    displayName: 'Gemma', vendor: 'google',
    contextWindow: 131072, maxTokens: 8192,
    input: ['text'],
    // 2/3 代确定非推理；4 代有思考但 wire 形态未定，故本层留 undefined（不臆造）
    reasoningEfforts: undefined,
    source: 'https://ai.google.dev/gemma/docs/core',
    generic: true,
  },
  {
    match: m('gemma[-.]?2'),
    displayName: 'Gemma 2', vendor: 'google',
    contextWindow: 8192, maxTokens: 8192,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://ai.google.dev/gemma/docs/core/model_card_2',
  },
  {
    // Gemma 3：4B 及以上支持图像，1B / 270M 为纯文本
    match: m('gemma[-.]?3'),
    displayName: 'Gemma 3', vendor: 'google',
    contextWindow: 131072, maxTokens: 8192,
    input: ['text', 'image'],
    reasoningEfforts: false,
    note: 'Gemma 3 的 1B / 270M 尺寸为纯文本，4B 及以上支持图像。',
    source: 'https://ai.google.dev/gemma/docs/core/model_card_3',
  },
  {
    // Gemma 4：26B A4B / 31B Dense / 12B Unified 均 256K 上下文
    match: m('gemma[-.]?4'),
    displayName: 'Gemma 4', vendor: 'google',
    contextWindow: 262144, maxTokens: 32768,
    input: ['text', 'image'],
    extraInputs: ['audio'],
    // Gemma 4 用 `<|think|>` 令牌开启思考，不是分级 effort；
    // OpenAI 兼容端点是否接受 reasoning_effort 取决于部署方 → 不臆造，交给「测试」实测。
    reasoningEfforts: undefined,
    note: 'Gemma 4 用 <|think|> 令牌控制思考，各部署端点是否接受 reasoning_effort 不一致，建议点「测试」实测。',
    source: 'https://ai.google.dev/gemma/docs/core/model_card_4',
  },
  {
    // 边缘尺寸 E2B / E4B 上下文 128K（其余 12B/26B/31B 为 256K）
    match: m('gemma[-.]?4[-.]?(?:e2b|e4b)'),
    displayName: 'Gemma 4 边缘版', vendor: 'google',
    contextWindow: 131072, maxTokens: 8192,
    input: ['text', 'image'],
    extraInputs: ['audio'],
    source: 'https://ai.google.dev/gemma/docs/core/model_card_4',
  },

  // ──────────────────────────── DeepSeek ────────────────────────────
  {
    // 官方 2026 口径（pricing 页逐字）：CONTEXT LENGTH 1M / MAX OUTPUT MAXIMUM 384K（= 393216）。
    // thinking 为双参数并存：thinking.type=enabled|disabled（默认 enabled）+ reasoning_effort=none|low|high|max（默认 high）。
    // 官方明示 minimal→low、medium/xhigh→high 的兼容映射，故只声明实际四档。
    match: m('deepseek'),
    displayName: 'DeepSeek', vendor: 'deepseek',
    contextWindow: 1000000, maxTokens: 393216,
    input: ['text'],
    reasoningEfforts: E('low', 'high', 'max'),
    note: '官方 reasoning_effort = none / low / high / max（默认 high，none 关闭思考）；minimal 映射为 low、medium 与 xhigh 映射为 high。',
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
    generic: true,
  },
  {
    // 纯文本推理线（deepseek-v4-pro 官方 FEATURES 行 Vision: Not supported）
    // 保留 high / max 起点并补 low（官方 reasoning_effort 四档均可用）
    match: m('deepseek-v4[-.]?pro|deepseek-reasoner|deepseek-r1'),
    displayName: 'DeepSeek 推理模型', vendor: 'deepseek',
    input: ['text'],
    reasoningEfforts: E('low', 'high', 'max'),
    source: 'https://api-docs.deepseek.com/api/create-chat-completion',
  },
  {
    // 多模态主力线（deepseek-flash / DeepSeek-V4.1-Flash 官方 Vision 支持 ✓）
    match: m('deepseek-flash|deepseek-v4[-.]?flash|deepseek-v4[-.]?1[-.]?flash|deepseek-chat|deepseek-v3'),
    displayName: 'DeepSeek Flash', vendor: 'deepseek',
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'high', 'max'),
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
  },

  // ────────────────────────── 阿里 Qwen ──────────────────────────
  {
    match: m('qwen'),
    displayName: 'Qwen', vendor: 'alibaba',
    contextWindow: 131072, maxTokens: 8192,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://help.aliyun.com/zh/model-studio/models',
    generic: true,
  },
  {
    match: m('qwen3'),
    displayName: 'Qwen3', vendor: 'alibaba',
    contextWindow: 131072, maxTokens: 32768,
    input: ['text'],
    reasoningEfforts: E('low', 'medium', 'high'),
    source: 'https://help.aliyun.com/zh/model-studio/models',
  },
  {
    match: m('qwen3[-.]?max'),
    displayName: 'Qwen3 Max', vendor: 'alibaba',
    contextWindow: 262144, maxTokens: 32768,
    input: ['text'],
    reasoningEfforts: E('low', 'medium', 'high'),
    source: 'https://help.aliyun.com/zh/model-studio/models',
  },
  {
    // ★ 2026 主力代次（官方 Model Studio）。逐字：Context Window 1000000 /
    //   Max Output Length 131072（思考与非思考同为 131072）/ Max CoT Length 262144。
    //   思考参数三元并存：enable_thinking(true|false，需经 extra_body 传入)、
    //   reasoning_effort、thinking_budget(≤262144)；官方「Hybrid thinking mode, enabled by default」。
    // ⚠️ 顺序：必须在 `qwen3`（generic）之后；omni 更具体，排在本条之后。
    match: m('qwen3[-.]?8'),
    displayName: 'Qwen3.8', vendor: 'alibaba',
    contextWindow: 1000000, maxTokens: 131072,
    input: ['text', 'image'],
    extraInputs: ['video'],
    reasoningEfforts: E('low', 'medium', 'high'),
    note: '官方 ctx 1000000 / maxOut 131072；混合思考默认开启（enable_thinking 经 extra_body 传入，reasoning_effort 与 thinking_budget ≤262144 可选）。',
    source: 'https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max',
  },
  {
    // Omni 全模态线的 top-level reasoning_effort 默认 xhigh，且官方给出七档词元。
    match: m('qwen3[-.]?8[-.]?omni'),
    displayName: 'Qwen3.8 Omni', vendor: 'alibaba',
    input: ['text', 'image'],
    extraInputs: ['video', 'audio'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh'),
    note: '官方 reasoning_effort 默认 xhigh（minimal 映射为 low，high/max 映射为 xhigh，none 关闭）；与 thinking_budget 不可同传。',
    source: 'https://www.alibabacloud.com/help/en/model-studio/qwen3-8-omni-flash',
  },
  {
    match: m('qwen3[-.]?7'),
    displayName: 'Qwen3.7', vendor: 'alibaba',
    contextWindow: 1000000, maxTokens: 131072,
    input: ['text', 'image'],
    extraInputs: ['video'],
    reasoningEfforts: E('low', 'medium', 'high'),
    source: 'https://www.alibabacloud.com/help/en/model-studio/qwen3-7-plus',
  },
  {
    // ⚠️ 顺序：qwen3.7-max 是纯文本输入，必须在宽的 `qwen3[-.]?7` 之后覆盖。
    match: m('qwen3[-.]?7[-.]?max'),
    displayName: 'Qwen3.7 Max', vendor: 'alibaba',
    input: ['text'],
    extraInputs: [],
    note: '官方型号页标为纯文本输入（易被误标多模态）。',
    source: 'https://www.alibabacloud.com/help/en/model-studio/qwen3-7-max',
  },
  {
    match: m('qwen[-.]?vl|qwen3[-.]?vl'),
    displayName: 'Qwen VL', vendor: 'alibaba',
    input: ['text', 'image'],
    extraInputs: ['video'],
    source: 'https://help.aliyun.com/zh/model-studio/models',
  },
  {
    match: m('qwen[-.]?max'),
    displayName: 'Qwen Max', vendor: 'alibaba',
    contextWindow: 32768, maxTokens: 8192,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://help.aliyun.com/zh/model-studio/models',
  },
  {
    match: m('qwen[-.]?plus'),
    displayName: 'Qwen Plus', vendor: 'alibaba',
    contextWindow: 131072, maxTokens: 8192,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://help.aliyun.com/zh/model-studio/models',
  },
  {
    match: m('qwen[-.]?flash|qwen[-.]?turbo'),
    displayName: 'Qwen Flash', vendor: 'alibaba',
    contextWindow: 1000000, maxTokens: 8192,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://help.aliyun.com/zh/model-studio/models',
  },

  // ────────────────────────── 智谱 GLM ──────────────────────────
  {
    match: m('glm|charglm|codegeex'),
    displayName: 'GLM', vendor: 'zhipu',
    contextWindow: 200000, maxTokens: 32000,
    input: ['text'],
    reasoningEfforts: { off: null, high: 'high' },
    source: 'https://docs.bigmodel.cn/cn/guide/models',
    generic: true,
  },
  {
    // GLM-5 / 5-turbo：204800 / 131072。⚠️ 官方 2026-10-08 已下线 glm-5 与
    // glm-5-turbo，保留匹配以免存量 provider 的配置被误判为未识别。
    match: m('glm[-.]?5'),
    displayName: 'GLM-5', vendor: 'zhipu',
    contextWindow: 204800, maxTokens: 131072,
    input: ['text'],
    reasoningEfforts: E('low', 'high', 'max'),
    source: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md',
    note: '官方 2026-10-08 下线 glm-5 / glm-5-turbo。',
  },
  {
    // GLM-5.1：204800 / 131072。
    match: m('glm[-.]?5[-.]?1'),
    displayName: 'GLM-5.1', vendor: 'zhipu',
    contextWindow: 204800, maxTokens: 131072,
    input: ['text'],
    reasoningEfforts: E('low', 'high', 'max'),
    source: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md',
  },
  {
    // GLM-5.2：1048576 / 131072。
    match: m('glm[-.]?5[-.]?2'),
    displayName: 'GLM-5.2', vendor: 'zhipu',
    contextWindow: 1048576, maxTokens: 131072,
    input: ['text'],
    reasoningEfforts: E('low', 'high', 'max'),
    source: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md',
  },
  {
    // GLM-5.3：1048576 / 131072，纯文本。官方 thinking.type 只接受 enabled
    //（思考不可关闭），reasoning_effort 取 low/high/max、默认 max。
    match: m('glm[-.]?5[-.]?3'),
    displayName: 'GLM-5.3', vendor: 'zhipu',
    contextWindow: 1048576, maxTokens: 131072,
    input: ['text'],
    reasoningEfforts: E('low', 'high', 'max'),
    note: '官方 thinking.type 仅 enabled（不可关闭思考），reasoning_effort 默认 max。',
    source: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md',
  },
  {
    // GLM-5.3 Flash / FlashX：同 5.3 规格，但原生多模态（文/图/视频/文件）。
    match: m('glm[-.]?5[-.]?3[-.]?flashx?'),
    displayName: 'GLM-5.3 Flash', vendor: 'zhipu',
    contextWindow: 1048576, maxTokens: 131072,
    input: ['text', 'image'],
    extraInputs: ['video', 'pdf'],
    reasoningEfforts: E('low', 'high', 'max'),
    source: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md',
  },
  {
    // GLM-5V Turbo：204800 / 131072，图像输入。官方标注 2026-10-30 下线。
    match: m('glm[-.]?5[-.]?v'),
    displayName: 'GLM-5V Turbo', vendor: 'zhipu',
    contextWindow: 204800, maxTokens: 131072,
    input: ['text', 'image'],
    source: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md',
    note: '官方标注 2026-10-30 下线。',
  },
  {
    // ⚠️ 宽规则（GLM-4）必须排在具体规则（GLM-4.6）**之前**：
    //    合并是「后者覆盖前者」，`glm-4` 也命中 `glm-4-6`，宽规则在后会把 4.6 反向覆盖成 128k。
    match: m('glm[-.]?4'),
    displayName: 'GLM-4', vendor: 'zhipu',
    contextWindow: 128000, maxTokens: 32000,
    input: ['text'],
    reasoningEfforts: E('low', 'high'),
    source: 'https://docs.bigmodel.cn/cn/guide/models',
  },
  {
    match: m('glm[-.]?4[-.]?6'),
    displayName: 'GLM-4.6', vendor: 'zhipu',
    contextWindow: 200000, maxTokens: 32000,
    input: ['text'],
    reasoningEfforts: E('low', 'high'),
    source: 'https://docs.bigmodel.cn/cn/guide/models',
  },
  {
    // 视觉线放在最后，只补模态
    match: m('glm[-.]?4[-.]?6[-.]?v|glm[-.]?4[-.]?5[-.]?v|glm[-.]?4[-.]?1[-.]?v|glm[-.]?v'),
    displayName: 'GLM 视觉', vendor: 'zhipu',
    input: ['text', 'image'],
    extraInputs: ['video', 'pdf'],
    source: 'https://docs.bigmodel.cn/cn/guide/models',
  },
  {
    // 智谱老代工线（CodeGeeX / CharGLM / Emohaa）—— 均非推理模型
    match: m('codegeex'),
    displayName: 'CodeGeeX', vendor: 'zhipu',
    contextWindow: 131072, maxTokens: 32768,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://docs.bigmodel.cn/cn/guide/models',
  },
  {
    match: m('charglm'),
    displayName: 'CharGLM', vendor: 'zhipu',
    contextWindow: 8192, maxTokens: 4096,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://docs.bigmodel.cn/cn/guide/models',
  },
  {
    match: m('emohaa'),
    displayName: 'Emohaa', vendor: 'zhipu',
    contextWindow: 8192, maxTokens: 4096,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://docs.bigmodel.cn/cn/guide/models',
  },

  // ──────────────────────── 小米 MiMo ────────────────────────
  {
    match: m('mimo'),
    displayName: 'MiMo', vendor: 'xiaomi',
    contextWindow: 262144, maxTokens: 65536,
    input: ['text'],
    source: 'https://mimo.mi.com/docs/zh-CN/quick-start/summary/model',
    note: '小米 MiMo 的思考开关是 thinking.type=enabled/disabled（默认 enabled），官方未给 low/medium/high 分级，故不臆造 reasoningEfforts；需要时点「测试」实测端点是否接受 reasoning_effort。',
    generic: true,
  },
  {
    // MiMo v2.5 系列（官方标注 2026-10-21 下线，保留匹配以免存量 provider 配错值）。
    // 注意 `-pro` 必须由后面的规则覆盖回纯文本，故本条的模态不能收窄。
    match: m('mimo[-.]?v[-.]?2[-.]?5'),
    displayName: 'MiMo v2.5', vendor: 'xiaomi',
    contextWindow: 1048576, maxTokens: 131072,
    input: ['text', 'image'],
    extraInputs: ['video', 'audio'],
    source: 'https://mimo.mi.com/docs/zh-CN/quick-start/summary/model',
    note: '全模态（文本/图像/视频/音频）。官方标注 2026-10-21 下线。',
  },
  {
    match: m('mimo[-.]?v[-.]?2[-.]?5[-.]?pro'),
    displayName: 'MiMo v2.5 Pro', vendor: 'xiaomi',
    contextWindow: 1048576, maxTokens: 131072,
    input: ['text'],
    // ★ 必须显式清空：合并只覆盖「非 undefined」字段，不写这行就会从上面更宽的
    //   `mimo-v2.5`（全模态）继承到 ['video','audio']，解析出「纯文本 + 视频音频」的矛盾结果。
    extraInputs: [],
    source: 'https://mimo.mi.com/docs/zh-CN/quick-start/summary/model',
    note: '纯文本——v2.5 系里唯独 -pro 不收图。官方标注 2026-10-21 下线。',
  },
  {
    // v2 原始代次（官方标注 2026-06-30 下线，保留以免存量配置被误判）。
    match: m('mimo[-.]?v[-.]?2[-.]?pro'),
    displayName: 'MiMo v2 Pro', vendor: 'xiaomi',
    contextWindow: 1000000, maxTokens: 131072,
    input: ['text'],
    source: 'https://mimo.mi.com/docs/zh-CN/quick-start/summary/model',
    note: '纯文本。官方标注 2026-06-30 下线。',
  },
  {
    match: m('mimo[-.]?v[-.]?2[-.]?omni'),
    displayName: 'MiMo v2 Omni', vendor: 'xiaomi',
    contextWindow: 262144, maxTokens: 131072,
    input: ['text', 'image'],
    extraInputs: ['video'],
    source: 'https://mimo.mi.com/docs/zh-CN/quick-start/summary/model',
    note: '官方标注 2026-06-30 下线。',
  },
  {
    match: m('mimo[-.]?v[-.]?2[-.]?flash'),
    displayName: 'MiMo v2 Flash', vendor: 'xiaomi',
    contextWindow: 262144, maxTokens: 65536,
    input: ['text'],
    source: 'https://mimo.mi.com/docs/zh-CN/quick-start/summary/model',
    note: '纯文本。官方标注 2026-06-30 下线。',
  },
  {
    // ★ 当前主力代次：MiMo v2.6（2026-09-22 发布）。三款（pro / flash / pro-ultraspeed）
    // 规格一致：1M 上下文、最大输出 128K、原生全模态（文本/图像/视频/音频）、深度思考。
    // 官方未给分档词元（只有 thinking.type 开关），故不写 reasoningEfforts。
    match: m('mimo[-.]?v[-.]?2[-.]?6'),
    displayName: 'MiMo v2.6', vendor: 'xiaomi',
    contextWindow: 1048576, maxTokens: 131072,
    input: ['text', 'image'],
    extraInputs: ['video', 'audio'],
    source: 'https://mimo.mi.com/models/zh-CN/mimo-v2.6-pro',
    note: '原生全模态（文本/图像/视频/音频），1M 上下文、最大输出 128K，深度思考默认开启（thinking.type=enabled/disabled）；官方无 low/medium/high 分级，不臆造 reasoningEfforts。',
  },
  {
    match: m('mimo[-.]?v[-.]?2[-.]?6[-.]?pro[-.]?ultraspeed'),
    displayName: 'MiMo v2.6 Pro UltraSpeed', vendor: 'xiaomi',
    contextWindow: 1048576, maxTokens: 131072,
    input: ['text', 'image'],
    extraInputs: ['video', 'audio'],
    source: 'https://mimo.mi.com/models/zh-CN/mimo-v2.6-pro-ultraspeed',
    note: 'V2.6-Pro 旗舰性能的最高 20 倍推理速度版本（定制服务）。',
  },

  // ─────────────────────── 月之暗面 Kimi / Moonshot ───────────────────────
  {
    match: m('kimi|moonshot'),
    displayName: 'Kimi', vendor: 'moonshot',
    contextWindow: 131072, maxTokens: 8192,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://platform.moonshot.cn/docs/pricing/chat',
    generic: true,
  },
  {
    match: m('moonshot-v1-8k'),
    displayName: 'Moonshot v1 8K', vendor: 'moonshot',
    contextWindow: 8192, maxTokens: 4096,
    source: 'https://platform.moonshot.cn/docs/pricing/chat',
  },
  {
    match: m('moonshot-v1-32k'),
    displayName: 'Moonshot v1 32K', vendor: 'moonshot',
    contextWindow: 32768, maxTokens: 4096,
    source: 'https://platform.moonshot.cn/docs/pricing/chat',
  },
  {
    match: m('moonshot-v1-128k'),
    displayName: 'Moonshot v1 128K', vendor: 'moonshot',
    contextWindow: 131072, maxTokens: 4096,
    source: 'https://platform.moonshot.cn/docs/pricing/chat',
  },
  {
    // ⚠️ 宽规则（K2 全系）必须排在下面的 K2.x 具体规则**之前**：
    //    合并是「后者覆盖前者」，`kimi-k2` 也命中 `kimi-k2.6`，宽规则在后会把新代次反向覆盖。
    //    官方 2026-05-25 已下线 kimi-k2 系列，保留匹配以免存量 provider 被误判。
    match: m('kimi[-.]?k2'),
    displayName: 'Kimi K2', vendor: 'moonshot',
    contextWindow: 262144, maxTokens: 8192,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://platform.kimi.com/docs/models.md',
    note: '官方 2026-05-25 下线 kimi-k2 系列。',
  },
  {
    match: m('kimi[-.]?k2[-.]?5'),
    displayName: 'Kimi K2.5', vendor: 'moonshot',
    contextWindow: 262144, maxTokens: 131072,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://platform.kimi.com/docs/models.md',
    note: '官方已下线 kimi-k2.5（2026-08-31）。',
  },
  {
    // K2.6：256K / 图像+视频；thinking.type 三态（enabled 默认 / disabled / enabled+keep:all）。
    match: m('kimi[-.]?k2[-.]?6'),
    displayName: 'Kimi K2.6', vendor: 'moonshot',
    contextWindow: 262144, maxTokens: 131072,
    input: ['text', 'image'],
    extraInputs: ['video'],
    note: '官方 thinking.type 为三态开关（enabled 默认 / disabled / enabled+keep:all），无分档词元，故不写 reasoningEfforts。',
    source: 'https://platform.kimi.com/docs/models.md',
  },
  {
    // K2.7 Code / highspeed：256K / 纯文本；只接受 thinking={"type":"enabled","keep":"all"}（思考不可关）。
    match: m('kimi[-.]?k2[-.]?7'),
    displayName: 'Kimi K2.7 Code', vendor: 'moonshot',
    contextWindow: 262144, maxTokens: 131072,
    input: ['text'],
    note: '官方仅接受 thinking={"type":"enabled","keep":"all"}（思考不可关闭），无分档词元。',
    source: 'https://platform.kimi.com/docs/models.md',
  },
  {
    // K2.8 preview：1M / 1M（二手口径，官方 models.md 未列，仅腾讯云 TokenHub 有规格）。
    match: m('kimi[-.]?k2[-.]?8'),
    displayName: 'Kimi K2.8 preview', vendor: 'moonshot',
    contextWindow: 1048576, maxTokens: 1048576,
    source: 'https://www.tencentcloud.com/zh/document/product/1300/78934',
    note: '二手口径（腾讯云 TokenHub 模型列表）；官方 models.md 未收录该 id，模态与思考形态未知。',
  },
  {
    // K3 世代（含聚合站常用的短名 `k3`）：1M 上下文、图像+视频、low/high/max 三档。
    // 官方：无 thinking 参数，思考始终开启；reasoning_effort 默认 max；最大输出可达 1048576。
    // 具体变体（`k3-256k`）必须排在后面才能覆盖本条的容量。
    match: m('kimi[-.]?k3|k3'),
    displayName: 'Kimi K3', vendor: 'moonshot',
    contextWindow: 1048576, maxTokens: 131072,
    input: ['text', 'image'],
    extraInputs: ['video'],
    reasoningEfforts: E('low', 'high', 'max'),
    note: '官方无 thinking 参数（思考始终开启），reasoning_effort 默认 max；maxTokens 默认 131072、上限 1048576，此处取默认值。',
    source: 'https://platform.kimi.com/docs/guide/kimi-k3-quickstart.md',
  },
  {
    match: m('k3[-.]?256k'),
    displayName: 'Kimi K3 256K', vendor: 'moonshot',
    contextWindow: 262144, maxTokens: 131072,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'high', 'max'),
    source: 'https://platform.kimi.com/docs/guide/kimi-k3-quickstart.md',
  },
  {
    match: m('vision-preview|kimi[-.]?vl|moonshot[-.]?vl'),
    displayName: 'Kimi 视觉', vendor: 'moonshot',
    input: ['text', 'image'],
    source: 'https://platform.kimi.com/docs/models.md',
  },

  // ──────────────────────────── MiniMax ────────────────────────────
  {
    match: m('minimax'),
    displayName: 'MiniMax', vendor: 'minimax',
    contextWindow: 204800, maxTokens: 8192,
    input: ['text'],
    reasoningEfforts: E('low', 'high'),
    source: 'https://platform.minimax.io/docs/guides/models-intro.md',
    generic: true,
  },
  {
    match: m('minimax[-.]?m1'),
    displayName: 'MiniMax M1', vendor: 'minimax',
    contextWindow: 1000000, maxTokens: 40000,
    input: ['text'],
    reasoningEfforts: E('low', 'high'),
    source: 'https://platform.minimax.io/docs/guides/models-intro.md',
  },
  {
    // ⚠️ 宽规则（M2 全系）必须排在 M2.7 / M2.5 具体规则**之前**：
    //    合并是「后者覆盖前者」，`minimax-m2` 也命中 `minimax-m2.7`，宽规则在后会反向覆盖。
    match: m('minimax[-.]?m2'),
    displayName: 'MiniMax M2', vendor: 'minimax',
    contextWindow: 204800, maxTokens: 131072,
    input: ['text'],
    reasoningEfforts: E('low', 'high'),
    note: 'thinking 官方无法关闭（传 disabled 被接收但不生效）。',
    source: 'https://platform.minimax.io/docs/guides/models-intro.md',
  },
  {
    // MiniMax M2.5 / M2.7（含 -highspeed）：200k 上下文 / 最大输出 204800（官方推荐 65536），纯文本。
    match: m('minimax[-.]?m2[-.]?[57]'),
    displayName: 'MiniMax M2.5/M2.7', vendor: 'minimax',
    contextWindow: 204800, maxTokens: 204800,
    input: ['text'],
    reasoningEfforts: E('low', 'high'),
    note: '官方推荐 maxTokens 65536、上限 204800；thinking 无法关闭。',
    source: 'https://platform.minimax.io/docs/guides/models-intro.md',
  },
  {
    // MiniMax M3：官方仅文字表述「1M context window」（未给整数值），最大输出 524288（推荐 131072），
    // 原生图+视频；thinking.type 默认 adaptive（M3 可传 disabled，M3.1 传 disabled 会 400）。
    match: m('minimax[-.]?m3'),
    displayName: 'MiniMax M3', vendor: 'minimax',
    contextWindow: 1048576, maxTokens: 524288,
    input: ['text', 'image'],
    extraInputs: ['video'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh', 'max'),
    note: '官方只写「1M context window」未给整数，此处取 1048576；thinking.type 默认 adaptive（M3.1 不接受 disabled）。',
    source: 'https://platform.minimax.io/docs/api-reference/text-chat-openai.md',
  },
  {
    match: m('minimax[-.]?m3[-.]?1'),
    displayName: 'MiniMax M3.1', vendor: 'minimax',
    contextWindow: 1048576, maxTokens: 524288,
    input: ['text', 'image'],
    extraInputs: ['video'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh', 'max'),
    note: 'thinking.type 官方仅接受 adaptive（传 disabled → HTTP 400）；reasoning_effort 默认 max。',
    source: 'https://platform.minimax.io/docs/api-reference/text-chat-openai.md',
  },
  {
    match: m('minimax[-.]?vl|minimax[-.]?v'),
    displayName: 'MiniMax 视觉', vendor: 'minimax',
    input: ['text', 'image'],
    source: 'https://platform.minimax.io/docs/guides/models-intro.md',
  },

  // ───────────────────────────── xAI Grok ─────────────────────────────
  {
    match: m('grok'),
    displayName: 'Grok', vendor: 'xai',
    contextWindow: 131072, maxTokens: 8192,
    input: ['text', 'image'],
    reasoningEfforts: false,
    source: 'https://docs.x.ai/docs/models',
    generic: true,
  },
  {
    match: m('grok[-.]?3'),
    displayName: 'Grok 3', vendor: 'xai',
    contextWindow: 131072, maxTokens: 8192,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'high'),
    source: 'https://docs.x.ai/docs/models',
  },
  {
    match: m('grok[-.]?4'),
    displayName: 'Grok 4', vendor: 'xai',
    contextWindow: 256000, maxTokens: 32768,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'medium', 'high'),
    source: 'https://docs.x.ai/docs/models',
  },
  {
    match: m('grok[-.]?4[-.]?20'),
    displayName: 'Grok 4.20', vendor: 'xai',
    contextWindow: 1000000,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh'),
    note: '多智能体变体（-multi-agent）的 reasoning_effort 控制 agent 数量（4 / 16），不是思考深度。官方 maxOut 口径为「No text output limit」，不公布数字上限。',
    source: 'https://docs.x.ai/developers/models',
  },
  {
    // ⚠️ 顺序：必须在 `grok[-.]?4` 之后（宽规则先行的合并语义）
    match: m('grok[-.]?4[-.]?3'),
    displayName: 'Grok 4.3', vendor: 'xai',
    contextWindow: 1000000,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh'),
    note: '官方 reasoning_effort = none / low / medium / high / xhigh，默认 low；none 对应这里的 off（思考仍可关）。maxOut 官方只写「No text output limit」。',
    source: 'https://docs.x.ai/developers/models/grok-4.3',
  },
  {
    match: m('grok[-.]?4[-.]?(?:5|6|7)'),
    displayName: 'Grok 4.5+', vendor: 'xai',
    contextWindow: 500000,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'medium', 'high', 'xhigh'),
    note: '官方 reasoning_effort 默认 high，**不可禁用**；xhigh 自 grok-4.6 起可用，grok-4.5 传 xhigh 会被当作 high（4.5 逐型号页与 reasoning 参考页就 xhigh 是否可用存在矛盾）。ctx 由 4.3 的 1M 降为 500K。maxOut 官方只写「No text output limit」。',
    source: 'https://docs.x.ai/developers/models/grok-4.7',
  },
  {
    match: m('grok[-.]?build'),
    displayName: 'Grok Build', vendor: 'xai',
    contextWindow: 256000,
    input: ['text', 'image'],
    reasoningEfforts: undefined,
    note: '编码向模型（别名 grok-code-fast-1 等）；官方未列 reasoning 行。',
    source: 'https://docs.x.ai/developers/models/grok-build-0.1',
  },
  {
    match: m('grok[-.]?4[-.]?1[-.]?fast'),
    displayName: 'Grok 4.1 Fast', vendor: 'xai',
    contextWindow: 2000000, maxTokens: 32768,
    input: ['text', 'image'],
    reasoningEfforts: E('low', 'medium', 'high'),
    source: 'https://docs.x.ai/docs/models',
  },

  // ──────────────────────────── Mistral ────────────────────────────
  {
    match: m('mistral|magistral|codestral|devstral|ministral|pixtral'),
    displayName: 'Mistral', vendor: 'mistral',
    contextWindow: 131072, maxTokens: 8192,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://docs.mistral.ai/getting-started/models/models_overview/',
    generic: true,
  },
  {
    match: m('magistral'),
    displayName: 'Magistral', vendor: 'mistral',
    contextWindow: 131072, maxTokens: 40000,
    input: ['text'],
    reasoningEfforts: E('low', 'medium', 'high'),
    source: 'https://docs.mistral.ai/getting-started/models/models_overview/',
  },
  {
    match: m('pixtral'),
    displayName: 'Pixtral', vendor: 'mistral',
    contextWindow: 131072, maxTokens: 8192,
    input: ['text', 'image'],
    source: 'https://docs.mistral.ai/getting-started/models/models_overview/',
  },
  {
    // ★ 2026 主力：Mistral Large 4（1M ctx，万亿参数原生多模态，Public Preview）
    //   reasoning_effort = none / high 二值（官方「No extra configuration required」）。
    //   ⚠️ 官方文档通篇未给任何型号的 maxOut 数字 → 不写 maxTokens（继承家族值），不臆造。
    match: m('mistral[-.]?large[-.]?4'),
    displayName: 'Mistral Large 4', vendor: 'mistral',
    contextWindow: 1000000,
    input: ['text', 'image'],
    reasoningEfforts: E('high'),
    note: '官方 ctx 写 1M；reasoning_effort 为 none / high 二值；全系 maxOut 官方未公布，故不写 maxTokens 数字。',
    source: 'https://docs.mistral.ai/models/mistral-large-4-0',
  },
  {
    match: m('mistral[-.]?(?:medium|small)[-.]?[34]'),
    displayName: 'Mistral Medium/Small 4', vendor: 'mistral',
    contextWindow: 262144,
    input: ['text', 'image'],
    reasoningEfforts: E('high'),
    note: '官方 ctx 写 256k；reasoning_effort 为 none / high 二值；maxOut 官方未公布。',
    source: 'https://docs.mistral.ai/models/mistral-medium-3-5-26-04',
  },

  // ──────────────────────────── Meta Llama ────────────────────────────
  {
    match: m('llama'),
    displayName: 'Llama', vendor: 'meta',
    contextWindow: 131072, maxTokens: 4096,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://www.llama.com/docs/model-cards-and-prompt-formats/',
    generic: true,
  },
  {
    match: m('llama[-.]?4'),
    displayName: 'Llama 4', vendor: 'meta',
    contextWindow: 1048576, maxTokens: 8192,
    input: ['text', 'image'],
    source: 'https://www.llama.com/docs/model-cards-and-prompt-formats/',
  },
  {
    match: m('llama[-.]?3'),
    displayName: 'Llama 3', vendor: 'meta',
    contextWindow: 131072, maxTokens: 4096,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://www.llama.com/docs/model-cards-and-prompt-formats/',
  },
  {
    // ★ Meta 2026 现役线：**Muse**（官方逐字「Meta ships five model families. Muse Spark,
    //   Muse Image, Muse Voice Transcribe, and SAM are hosted on Meta Model API…;
    //   Muse Glimmer is open-weight」）—— Llama 开源线止于 2025-04，不再更新。
    //   1.1 / 1.2 / 1.3 三代共享同一模态与上下文（官方逐字）。
    // ⚠️ 不要用 `muse` 做泛式：会误吃 Muse Image / Muse Voice Transcribe 这两条不属于 LLM 的线。
    match: m('muse[-.]?spark'),
    displayName: 'Muse Spark', vendor: 'meta',
    contextWindow: 1048576,
    input: ['text', 'image'],
    extraInputs: ['video', 'audio', 'pdf'],
    reasoningEfforts: E('minimal', 'low', 'medium', 'high', 'xhigh'),
    note: '官方 reasoning_effort = minimal / low / medium / high / xhigh / max，next 传 none 会报 400（此模型思考不可关）；`max` 档**仅 Standard tier** 可用（contributor 版不可用）。音频理解请用 1.2。maxOut 官方未公布，故不写数字。',
    source: 'https://dev.meta.ai/docs/models',
  },
  {
    // 开放权重线（30B dense，Apache 2.0，可自托管）；官方只写「128K tokens by default; longer contexts supported」。
    match: m('muse[-.]?glimmer'),
    displayName: 'Muse Glimmer', vendor: 'meta',
    contextWindow: 131072,
    input: ['text', 'image'],
    reasoningEfforts: undefined,
    note: '开放权重线（30B dense / Apache 2.0 / 可自托管）。官方口径为「128K tokens by default; longer contexts supported」，故 ctx 取 131072；reasoning 与 maxOut 官方两页均未列，不臆造。',
    source: 'https://dev.meta.ai/docs/muse-glimmer',
  },

  // ──────────────────────── 腾讯混元 Hunyuan ────────────────────────
  {
    // 家族兜底：`hy3` / `hy4-preview` 这类短名与 `hunyuan-*` 全名都收。
    // ⚠️ 混元的 `hy` 短名不带厂商前缀，故必须带代次数字，否则会误吃无关名字。
    match: m('hunyuan|hy[0-9]'),
    displayName: '混元', vendor: 'tencent',
    contextWindow: 131072, maxTokens: 8192,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://cloud.tencent.com/document/product/1729/97724',
    generic: true,
  },
  {
    // 视觉线：hunyuan-vision / hunyuan-t1-vision（放在推理线之前，被后两条覆盖不到）
    match: m('hunyuan[-.]?vision|hunyuan[-.]?t1[-.]?vision'),
    displayName: '混元视觉', vendor: 'tencent',
    input: ['text', 'image'],
    reasoningEfforts: false,
    source: 'https://cloud.tencent.com/document/product/1729/97724',
  },
  {
    // Hy3：256K 上下文 / 最大输出 128k（腾讯云 TokenHub 模型列表，官方「深度思考（保留式思考）」）。
    match: m('hy[-.]?3'),
    displayName: '混元 Hy3', vendor: 'tencent',
    contextWindow: 262144, maxTokens: 131072,
    input: ['text'],
    reasoningEfforts: E('low', 'high'),
    note: '官方思考开关为 thinking.type=enabled|disabled（默认 enabled），另在保留式思考文档给出 reasoning_effort=no_think|low|high（no_think 对应这里的 off）；两页口径不完全一致，档位以后者为准。多模态：官方能力列未给图像标签，第三方实测图像输入被拒（HTTP 400）、社区文档明确为纯文本模型，故取 text。',
    source: 'https://www.tencentcloud.com/zh/document/product/1300/81572',
  },
  {
    // Hy4 preview：1M 上下文 / 最大输出 64k（最新旗舰，最大输入 960k）。
    match: m('hy[-.]?4'),
    displayName: '混元 Hy4 preview', vendor: 'tencent',
    contextWindow: 1048576, maxTokens: 65536,
    input: ['text'],
    reasoningEfforts: E('low', 'high'),
    note: '同 Hy3：thinking.type 默认 enabled，reasoning_effort 取 no_think|low|high。模态同理：官方未给标签，按纯文本处理。',
    source: 'https://cloud.tencent.com/document/product/1300/78934',
  },
  {
    // 混元 T1 推理线（无 hy 短名的写法）
    match: m('hunyuan[-.]?t1'),
    displayName: '混元 T1', vendor: 'tencent',
    contextWindow: 262144, maxTokens: 64000,
    input: ['text'],
    reasoningEfforts: E('low', 'high'),
    source: 'https://cloud.tencent.com/document/product/1729/97724',
  },
  {
    // hunyuan-a13b：旧平台混合推理模型（80B 总参 / 13B 激活），默认慢思考。
    match: m('hunyuan[-.]?a13b|hunyuan[-.]?a[-.]?13[-.]?b'),
    displayName: '混元 A13B', vendor: 'tencent',
    contextWindow: 229376, maxTokens: 32768,
    input: ['text'],
    note: '默认慢思考，快慢思考切换为 query 前加 /no_think；官方未给推理档位词元。',
    source: 'https://cloud.tencent.com/document/product/1729/104753',
  },
  {
    // hunyuan-turbos-vision-video：旧平台视频理解线（24k / 8k）。
    match: m('hunyuan[-.]?turbos[-.]?vision[-.]?video'),
    displayName: '混元视觉视频', vendor: 'tencent',
    contextWindow: 24576, maxTokens: 8192,
    input: ['text', 'image'],
    extraInputs: ['video'],
    source: 'https://cloud.tencent.com/document/product/1729/97724',
  },
  {
    // 翻译系列 hy-mt2（8k / 4k），非推理模型。
    match: m('hy[-.]?mt[-.]?2'),
    displayName: '混元翻译 MT2', vendor: 'tencent',
    contextWindow: 8192, maxTokens: 4096,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://cloud.tencent.com/document/product/1300/78934',
  },

  // ══════════════════════════════════════════════════════════════════
  // v0.1.2 扩表：zcode 表之外的 20 家厂商（用户 全部圈正收录）
  // 顺序仍遵循「泛 → 具体」；段内家族兜底在前，具体型号在后。
  //
  // 写入原则（沿用「不静默写错值」）：
  //   官方只给「开/关」布尔开关、或只给 id 后缀变体的，reasoningEfforts 一律留
  //   undefined，**不把布尔开关硬塞成 low/medium/high 档位**；只有官方文档明确
  //   列出档位词元（如 reasoning_effort: low/medium/high）时才写 E(...)。
  //   官方未公布的数值（maxTokens 居多）留空，继承 BASE_RULE 的通用兜底并加 note。
  // ══════════════════════════════════════════════════════════════════

  // ──────────────────────── 百度文心 ERNIE ────────────────────────
  {
    // `ernie` / `wenxin` 都是百度独有前缀，不会误吃别的名字。
    match: m('ernie|wenxin'),
    displayName: '文心一言', vendor: 'baidu',
    contextWindow: 128000, maxTokens: 8192,
    input: ['text'],
    reasoningEfforts: undefined,
    source: 'https://ai.baidu.com/ai-doc/AISTUDIO/Mmhslv9lf',
    generic: true,
  },
  {
    // ERNIE 5.x：131072 上下文 / 最大输出 65536。
    // ⚠️ 宽规则（5.x 家族）必须排在 5.1 具体规则**之前**：合并是「后者覆盖前者」，
    //    `ernie-5` 也命中 `ernie-5.1`，宽规则在后会把 5.1 反向覆盖。
    match: m('ernie[-.]?5'),
    displayName: '文心 5.0', vendor: 'baidu',
    contextWindow: 131072, maxTokens: 65536,
    input: ['text', 'image'],
    reasoningEfforts: E('high', 'max'),
    note: '官方 reasoning_effort 仅 high（默认）/ max，low/medium 映射为 high、xhigh 映射为 max；视频输入未确证。',
    source: 'https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j',
  },
  {
    // ERNIE 5.1：与 5.0 同容量，但为纯文本。思考由布尔参数 `enable_thinking`
    //（默认 false）控制，并可用 `reasoning_effort=high|max`（官方仅这两档）。
    match: m('ernie[-.]?5[-.]?1'),
    displayName: '文心 5.1', vendor: 'baidu',
    contextWindow: 131072, maxTokens: 65536,
    input: ['text'],
    reasoningEfforts: E('high', 'max'),
    note: '官方 enable_thinking 布尔开关默认 false；reasoning_effort 仅 high（默认）/ max。',
    source: 'https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j',
  },
  {
    // ERNIE X1 深度思考线：65536 / 65536，官方标注即将下线。
    match: m('ernie[-.]?x1'),
    displayName: '文心 X1', vendor: 'baidu',
    contextWindow: 65536, maxTokens: 65536,
    input: ['text'],
    reasoningEfforts: E('high', 'max'),
    source: 'https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j',
    note: '官方标注即将下线。',
  },
  {
    // ERNIE 4.5 Turbo：128k / 12288，纯文本，不支持 thinking_budget。
    // ⚠️ 必须排在下面的 VL 规则**之前**：合并是「后者覆盖前者」，若宽规则在后，
    //    会把 `ernie-4.5-turbo-vl` 的规格反向覆盖。
    match: m('ernie[-.]?4[-.]?5'),
    displayName: '文心 4.5', vendor: 'baidu',
    contextWindow: 131072, maxTokens: 12288,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j',
  },
  {
    // ERNIE 4.5 视觉线（vl）：131072 / 16384，原生多模态。
    match: m('ernie[-.]?4[-.]?5[-.]?turbo[-.]?vl|ernie[-.]?[0-9][-.]?vl'),
    displayName: '文心 4.5 VL', vendor: 'baidu',
    contextWindow: 131072, maxTokens: 16384,
    input: ['text', 'image'],
    source: 'https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j',
  },

  // ──────────────────────── 字节豆包 Doubao ────────────────────────
  {
    match: m('doubao'),
    displayName: '豆包', vendor: 'bytedance',
    contextWindow: 262144, maxTokens: 16384,
    input: ['text', 'image'],
    reasoningEfforts: undefined,
    note: '官方思考开关为 thinking.type=disabled|enabled|auto（默认启用），无分档词元，故不写 reasoningEfforts；需要时点「测试」实测端点接受的 reasoning_effort。',
    source: 'https://www.volcengine.com/docs/82379/1330310',
    generic: true,
  },
  {
    // Seed 2.0：官方页未直连，容量沿用家族值。
    // ⚠️ 必须排在 Seed 2.1 **之前**：`doubao-seed-2` 也能命中 `doubao-seed-2.1`，
    //    若宽规则在后，会把 2.1 的 displayName 反向覆盖成 2.0。
    match: m('doubao[-.]?seed[-.]?2'),
    displayName: '豆包 Seed 2.0', vendor: 'bytedance',
    contextWindow: 262144, maxTokens: 131072,
    input: ['text', 'image'],
    extraInputs: ['video'],
    source: 'https://www.volcengine.com/docs/82379/1330310',
  },
  {
    // Seed 2.1：1M 或 256k 两档上下文 / 最大输出 262144；原生图+视频。
    // 官方 reasoning_effort 取 none/minimal/low/medium/high/xhigh/max、默认 high
    //（xhigh 与 max 被映射为 high），此处只保留真正生效的档位。
    match: m('doubao[-.]?seed[-.]?2[-.]?1'),
    displayName: '豆包 Seed 2.1', vendor: 'bytedance',
    contextWindow: 1048576, maxTokens: 262144,
    input: ['text', 'image'],
    extraInputs: ['video'],
    reasoningEfforts: E('minimal', 'low', 'medium', 'high'),
    note: '官方 reasoning_effort 默认 high，xhigh/max 映射为 high；260628 版为 256k 上下文，此处取 260915 版的 1M。',
    source: 'https://www.volcengine.com/docs/82379/1330310',
  },
  {
    // Seed evolving：1M / 262144，快速迭代模型（周级更新）。
    match: m('doubao[-.]?seed[-.]?evolving'),
    displayName: '豆包 Seed evolving', vendor: 'bytedance',
    contextWindow: 1048576, maxTokens: 262144,
    input: ['text', 'image'],
    extraInputs: ['video'],
    reasoningEfforts: E('minimal', 'low', 'medium', 'high'),
    source: 'https://www.volcengine.com/docs/82379/1330310',
  },
  {
    // doubao-seed-character：131072 / 32768，纯文本。
    match: m('doubao[-.]?seed[-.]?character'),
    displayName: '豆包 Seed Character', vendor: 'bytedance',
    contextWindow: 131072, maxTokens: 32768,
    input: ['text'],
    source: 'https://www.volcengine.com/docs/82379/1330310',
  },
  {
    // doubao-seed-translation：4096 / 3072，纯文本、非推理。
    match: m('doubao[-.]?seed[-.]?translation'),
    displayName: '豆包 Seed Translation', vendor: 'bytedance',
    contextWindow: 4096, maxTokens: 3072,
    input: ['text'],
    reasoningEfforts: false,
    source: 'https://www.volcengine.com/docs/82379/1330310',
  },
  {
    // Seed 1.6：256k 上下文 / 最大输出 16k（二手口径，官方页 JS 渲染取不到）。
    match: m('doubao[-.]?seed[-.]?1[-.]?6'),
    displayName: '豆包 Seed 1.6', vendor: 'bytedance',
    contextWindow: 262144, maxTokens: 16384,
    source: 'https://api-doc.vncps.com/api-reference/doubao-language-model',
  },

  // ──────────────────────── 阶跃星辰 StepFun ────────────────────────
  {
    match: m('step[-.]?[0-9]|stepfun'),
    displayName: '阶跃星辰', vendor: 'stepfun',
    contextWindow: 262144, maxTokens: 32768,
    input: ['text'],
    reasoningEfforts: undefined,
    source: 'https://platform.stepfun.com/docs/zh/guides/models/overview.md',
    generic: true,
  },
  {
    // Step 5：1048576 上下文 / 65536 输出 / 原生图+视频 / low-medium-high（官方未写默认值）。
    match: m('step[-.]?5'),
    displayName: 'Step 5', vendor: 'stepfun',
    contextWindow: 1048576, maxTokens: 65536,
    input: ['text', 'image'], extraInputs: ['video'],
    reasoningEfforts: E('low', 'medium', 'high'),
    note: '官方 Chat 用 reasoning_effort，Messages API 用 output_config.effort；三档未写默认值。',
    source: 'https://platform.stepfun.com/docs/zh/guides/models/step-5-preview.md',
  },
  {
    // Step 3.7：262144 / 原生图+视频 / low-medium-high（默认 medium）。
    match: m('step[-.]?3[-.]?7'),
    displayName: 'Step 3.7', vendor: 'stepfun',
    contextWindow: 262144,
    input: ['text', 'image'], extraInputs: ['video'],
    reasoningEfforts: E('low', 'medium', 'high'),
    note: '官方 reasoning_effort 默认 medium。',
    source: 'https://platform.stepfun.com/docs/zh/guides/models/step-3.7-flash.md',
  },
  {
    // Step 3.5：256K / 纯文本 / low-high。
    match: m('step[-.]?3[-.]?5'),
    displayName: 'Step 3.5', vendor: 'stepfun',
    contextWindow: 262144,
    input: ['text'],
    reasoningEfforts: E('low', 'high'),
    source: 'https://platform.stepfun.com/docs/zh/guides/models/step-3.5-flash.md',
  },
  {
    // Step 1o turbo vision：32K / 图+视频 / 非推理。
    match: m('step[-.]?1o|step[-.]?1[-.]?o'),
    displayName: 'Step 1o', vendor: 'stepfun',
    contextWindow: 32768,
    input: ['text', 'image'], extraInputs: ['video'],
    reasoningEfforts: false,
    source: 'https://platform.stepfun.com/docs/zh/guides/models/overview.md',
  },

  // ──────────────────────── 零一万物 Yi ────────────────────────
  {
    // ⚠️ 不用裸 `yi`：太短。要求后面跟已知型号词或数字。
    // ⚠️ 零一官方文档站是全站 SPA，取不到正文；以下容量来自阿里云百炼转售页与第三方聚合站，属二手口径。
    match: m('yi[-.]?(?:large|medium|lightning|spark|vl|vision)|yi[-.]?[0-9]'),
    displayName: '零一万物 Yi', vendor: '01ai',
    contextWindow: 32768, maxTokens: 4096,
    input: ['text'],
    reasoningEfforts: false,
    note: '官方文档站为 SPA 取不到正文，容量取自阿里云百炼转售页与第三方聚合站，属二手口径。',
    source: 'https://help.aliyun.com/zh/model-studio/yi-api',
    generic: true,
  },
  {
    // Yi-Lightning：16384 上下文 / 4096 输出（第三方三源一致）。
    match: m('yi[-.]?lightning'),
    displayName: 'Yi Lightning', vendor: '01ai',
    contextWindow: 16384, maxTokens: 4096,
    source: 'https://help.aliyun.com/zh/model-studio/yi-api',
  },
  {
    // Yi-Large / Yi-Medium：32000（该页简介另写 16K，两口径冲突已保留）。
    match: m('yi[-.]?(?:large|medium)'),
    displayName: 'Yi Large/Medium', vendor: '01ai',
    contextWindow: 32000,
    note: '阿里云百炼页表格写 32,000，同页简介文字写 16K 可自由设定，两口径冲突。',
    source: 'https://help.aliyun.com/zh/model-studio/yi-api',
  },

  // ──────────────────────── 百川智能 Baichuan ────────────────────────
  {
    // ⚠️ 必须带 `[0-9]?`：`baichuan4` / `baichuan3` 的名字后面**直接跟数字、没有分隔符**，
    //    而 `m()` 的尾锚点要求后跟 `[.\-:/[]` 或行尾，故光写 `baichuan` 会漏掉整条通用线。
    match: m('baichuan[0-9]?'),
    displayName: '百川智能', vendor: 'baichuan',
    contextWindow: 32768, maxTokens: 2048,
    input: ['text'],
    reasoningEfforts: undefined,
    note: 'Baichuan-M2/M3 支持 thinking 推理增强，但官方未公布档位词元与 wire 值，故不写 reasoningEfforts。',
    source: 'https://platform.baichuan-ai.com/prices',
    generic: true,
  },
  {
    // M 系列（医疗/推理线）：32k 上下文。
    match: m('baichuan[-.]?m[0-9]'),
    displayName: 'Baichuan M 系列', vendor: 'baichuan',
    contextWindow: 32768,
    source: 'https://platform.baichuan-ai.com/docs-v2/medical',
  },
  {
    // ★ Baichuan-M3-235B（2026-01-13）：官方 HF config.json 精确值 `max_position_embeddings: 40960`。
    match: m('baichuan[-.]?m[-.]?3'),
    displayName: 'Baichuan M3', vendor: 'baichuan',
    contextWindow: 40960,
    input: ['text'],
    note: '官方 HF config `max_position_embeddings: 40960`；thinking 的 wire 形态是 chat template 关键字 `thinking_mode="on"`（另一态 off），非 reasoning_effort 档位，故不写 reasoningEfforts。maxOut 官方未给硬上限（README 示例 32768 不是上限）。',
    source: 'https://huggingface.co/baichuan-inc/Baichuan-M3-235B',
  },
  {
    // Baichuan3-Turbo-128k：128k（该页唯一给出 128k 的通用模型）。
    match: m('baichuan[-.]?3[-.]?turbo[-.]?128k'),
    displayName: 'Baichuan3 Turbo 128k', vendor: 'baichuan',
    contextWindow: 128000, maxTokens: 2048,
    source: 'https://platform.baichuan-ai.com/prices',
  },

  // ──────────────────────── 讯飞星火 iFlytek Spark ────────────────────────
  {
    // ⚠️ 不用裸 `spark`：第三方聚合站有 `gpt-5.3-codex-spark` 这类自造名，会被误吃。
    // 故要求 `spark` 后跟数字或已知版本词，另收 `generalv*`。
    // ⚠️ 也不能直接用 m()：m() 的前缀类含 `-`，会把别的厂商名**尾部**的 `-spark-1`
    //    也吃进来（实测 `muse-spark-1.3` 被本规则抢走 vendor，把 Meta 的 Muse 条覆盖）。
    //    故前缀边界收窄为「名首或 `/ : [ 空白`」，**排除 `-`** —— Spark 的真实 id
    //    （`spark-x2` / `generalv3.5` / `spark-4.0-ultra`）只会出现在名首或 `/` 之后。
    match: /(?:^|[:/\[\s])(?:spark[-.]?[0-9]|spark[-.]?(?:x|ultra|max|pro|lite)|generalv[0-9])(?:[.\-:/\[].*)?$/i,
    displayName: '讯飞星火', vendor: 'xfyun',
    contextWindow: 32768, maxTokens: 8192,
    input: ['text'],
    reasoningEfforts: undefined,
    note: 'Spark-X2 的 thinking.type 为 enabled/disabled/auto 三态（不是 low/medium/high 分级），故不写 reasoningEfforts。',
    source: 'https://www.xfyun.cn/doc/spark/HTTP调用文档.html',
    generic: true,
  },
  {
    // Spark X / X1.5：输出 65535。
    // ⚠️ 必须排在 X2 **之前**：`spark-x` 的尾锚点会吸收 `2`，故也能命中 `spark-x2`。
    match: m('spark[-.]?x|spark[-.]?x[-.]?1'),
    displayName: '星火 X', vendor: 'xfyun',
    contextWindow: 32768, maxTokens: 65535,
    source: 'https://www.xfyun.cn/doc/spark/X1http.html',
  },
  {
    // Spark X2：输入 64K / 输出 128K（官方公告口径）。
    match: m('spark[-.]?x2|spark[-.]?x[-.]?2'),
    displayName: '星火 X2', vendor: 'xfyun',
    contextWindow: 65536, maxTokens: 131072,
    source: 'https://www.xfyun.cn/doc/spark/X1http.html',
  },
  {
    // Spark 4.0 Ultra：32K / 32768。
    match: m('spark[-.]?4[-.]?0[-.]?ultra|4[-.]?0ultra'),
    displayName: '星火 4.0 Ultra', vendor: 'xfyun',
    contextWindow: 32768, maxTokens: 32768,
    source: 'https://www.xfyun.cn/doc/spark/HTTP调用文档.html',
  },

  // ──────────────────────── 商汤日日新 SenseNova ────────────────────────
  {
    match: m('sensenova|sensechat'),
    displayName: '商汤日日新', vendor: 'sensenova',
    contextWindow: 32768, maxTokens: 4096,
    input: ['text'],
    reasoningEfforts: undefined,
    note: 'V6 系 thinking 为必传 object {enabled:boolean}，只有开/关，无 low/medium/high 分级。',
    source: 'https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/fusionllm/FusionLLMs',
    generic: true,
  },
  {
    // V6 线（Pro / Turbo / Reasoner）：32K，融合模态。
    // ⚠️ 必须排最前：`sensenova-v?6` 的尾锚点会吸收 `-5` / `-7`，故 V6.5 与 6.7/6.8 都能被它命中，
    //    宽规则若在后会把它们的 displayName 与容量反向覆盖。
    match: m('sensenova[-.]?v?6'),
    displayName: 'SenseNova V6', vendor: 'sensenova',
    contextWindow: 32768,
    input: ['text', 'image'], extraInputs: ['video'],
    source: 'https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/fusionllm/FusionLLMs',
  },
  {
    // 6.7 / 6.8 flash-lite：官方未给 ctx/maxOut 数字，只确认原生多模态。
    // ★ 官方预览 id 为 `sensenova-6.8-flash-lite`（endpoint `https://token.sensenova.cn/v1`），6.7 为上一代。
    match: m('sensenova[-.]?6[-.]?[78]'),
    displayName: 'SenseNova Flash Lite', vendor: 'sensenova',
    input: ['text', 'image'],
    note: '官方预览 id 为 `sensenova-6.8-flash-lite`（6.7 为上一代）。官方**明确不公布** ctx/maxOut 数字，故容量继承家族兜底值，不臆造填数。endpoint `https://token.sensenova.cn/v1`。',
    source: 'https://www.sensenova.cn/models',
  },
  {
    // V6.5 融合模态线：128K。
    match: m('sensenova[-.]?v?6[-.]?5'),
    displayName: 'SenseNova V6.5', vendor: 'sensenova',
    contextWindow: 131072,
    input: ['text', 'image'], extraInputs: ['video'],
    source: 'https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/fusionllm/FusionLLMs',
  },
  {
    // SenseChat-Character(-Pro)：32K / 4096。
    match: m('sensechat[-.]?character'),
    displayName: 'SenseChat Character', vendor: 'sensenova',
    contextWindow: 32768, maxTokens: 4096,
    input: ['text'],
    source: 'https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/llm/CharacterLLM',
  },

  // ──────────────────────── 华为盘古 Pangu ────────────────────────
  {
    // `openpangu` 必须写在 `pangu` 前 —— `openpangu` 中间没有分隔符，单靠 `pangu` 匹配不到。
    match: m('openpangu|pangu'),
    displayName: '盘古', vendor: 'huawei',
    contextWindow: 32768, maxTokens: 8192,
    input: ['text'],
    reasoningEfforts: undefined,
    note: '官方只给「深度思考（可开关）」定性描述，未公布参数名与档位。',
    source: 'https://support.huaweicloud.com/model-list-maas/model_list_0001.html',
    generic: true,
  },
  {
    // openPangu 2.0：512K 上下文（最大输入 500K）/ 最大输出 128K（思维链 64K）。
    // API 侧实际 model 值：pangu-nlp-n2-reasoner-32k。
    // ⚠️ 必须排在 2.0 **之前**：`pangu-reasoner` / `pangu-nlp-n2` 与 2.0 同前缀，
    //    若宽规则在后会把 512K 反向覆盖成 32K。
    match: m('pangu[-.]?nlp[-.]?n[0-9]|pangu[-.]?reasoner'),
    displayName: '盘古推理线', vendor: 'huawei',
    contextWindow: 32768,
    source: 'https://support.huaweicloud.com/api-pangulm/pangulm_05_0012.html',
  },
  {
    // openPangu 2.0：512K 上下文（最大输入 500K）/ 最大输出 128K（思维链 64K）。
    match: m('openpangu|pangu[-.]?2[-.]?0'),
    displayName: '盘古 2.0', vendor: 'huawei',
    contextWindow: 524288, maxTokens: 131072,
    source: 'https://support.huaweicloud.com/model-list-maas/model_list_0001.html',
  },

  // ──────────────────────── 昆仑天工 Skywork ────────────────────────
  {
    // ⚠️ `skywork-ai/skyclaw-v1` 归一化会剥掉组织前缀，只剩 `skyclaw-v1`，故两个名字都要收。
    match: m('skyclaw|skywork'),
    displayName: '昆仑天工', vendor: 'skywork',
    contextWindow: 1000000, maxTokens: 32768,
    input: ['text', 'image'],
    reasoningEfforts: undefined,
    note: '官方只公布 1M 上下文与图像输入，未公布最大输出与思考档位。',
    source: 'https://skyworkai.github.io/skyclaw/',
    generic: true,
  },

  // ──────────────────────── 面壁智能 MiniCPM ────────────────────────
  {
    match: m('minicpm'),
    displayName: '面壁 MiniCPM', vendor: 'modelbest',
    contextWindow: 32768, maxTokens: 4096,
    input: ['text'],
    reasoningEfforts: undefined,
    note: 'enable_thinking 为布尔开关（另支持 /think、/no_think），无 low/medium/high 分级；maxOut 官方未规定。',
    source: 'https://github.com/OpenBMB/MiniCPM',
    generic: true,
  },
  {
    // MiniCPM-V 多模态线：V 4.6 的文本上下文为 262144。
    match: m('minicpm[-.]?v'),
    displayName: 'MiniCPM-V', vendor: 'modelbest',
    contextWindow: 262144,
    input: ['text', 'image'], extraInputs: ['video'],
    source: 'https://huggingface.co/openbmb/MiniCPM-V-4_6',
  },
  {
    // MiniCPM5：131072（官方 README 规格表）。
    match: m('minicpm[-.]?5'),
    displayName: 'MiniCPM5', vendor: 'modelbest',
    contextWindow: 131072,
    source: 'https://github.com/OpenBMB/MiniCPM',
  },
  {
    // MiniCPM4：32768（YaRN 外推口径为 128K，此处取原生值）。
    // ⚠️ 必须排在 4.1 **之前**：`minicpm-4` 的尾锚点会吸收 `-1`。
    match: m('minicpm[-.]?4'),
    displayName: 'MiniCPM4', vendor: 'modelbest',
    contextWindow: 32768,
    source: 'https://github.com/OpenBMB/MiniCPM',
  },
  {
    // MiniCPM4.1：原生 65536（LongRoPE 可外推到 131072，属外推口径）。
    match: m('minicpm[-.]?4[-.]?1'),
    displayName: 'MiniCPM4.1', vendor: 'modelbest',
    contextWindow: 65536,
    note: '原生 65,536；官方称 LongRoPE 因子可外推至 131,072，此处取原生值。',
    source: 'https://github.com/OpenBMB/MiniCPM',
  },

  // ──────────────────────── 上海 AI Lab InternLM ────────────────────────
  {
    match: m('internlm'),
    displayName: '书生 InternLM', vendor: 'internlm',
    contextWindow: 32768, maxTokens: 4096,
    input: ['text'],
    reasoningEfforts: undefined,
    note: 'InternLM3 的深度思考/普通双模式由 system prompt 驱动，无 low/medium/high 分级；maxOut 官方未给。',
    source: 'https://internlm.readthedocs.io/en/latest/model_card/InternLM3.html',
    generic: true,
  },
  {
    // InternLM2.5：官方 model card 与 HF config 对 1M 变体口径冲突。
    match: m('internlm[-.]?2[-.]?5'),
    displayName: 'InternLM2.5', vendor: 'internlm',
    contextWindow: 262144,
    note: '7B-Chat-1M 变体的官方 model card 写「1M Context window」，而 HF config.json 为 262144（256K）；此处取 config 值，1M 属官方另一口径。',
    source: 'https://internlm.readthedocs.io/en/latest/model_card/InternLM2.5.html',
  },
  {
    match: m('internlm[-.]?3'),
    displayName: 'InternLM3', vendor: 'internlm',
    contextWindow: 32768,
    source: 'https://internlm.readthedocs.io/en/latest/model_card/InternLM3.html',
  },
  {
    // ★ Intern-S 科学多模态线（官方 HF config 262144）。注意与 `internlm` 文本线是两条产品线。
    // ⚠️ 顺序：宽的 `s[0-9]` 必须在具体 `s2` 之前，否则 `intern-s2` 会被自家的宽规则反向覆盖。
    match: m('intern[-.]?s[0-9]'),
    displayName: 'Intern-S 科学线', vendor: 'internlm',
    contextWindow: 65536,
    input: ['text'],
    source: 'https://huggingface.co/InternLM/Intern-S2-Preview',
  },
  {
    match: m('intern[-.]?s[-.]?2'),
    displayName: 'Intern-S2', vendor: 'internlm',
    contextWindow: 262144,
    input: ['text', 'image'], extraInputs: ['video'],
    note: '官方 HF config 262144；科学多模态线（text + image + video + 时序），与 InternLM 文本线不同族。maxTokens 官方未给。',
    source: 'https://huggingface.co/InternLM/Intern-S2-Preview',
  },

  // ──────────────────────── 微软 Phi ────────────────────────
  {
    match: m('phi'),
    displayName: 'Phi', vendor: 'microsoft',
    contextWindow: 131072, maxTokens: 4096,
    input: ['text'],
    reasoningEfforts: undefined,
    note: 'Phi-4-reasoning 系列始终输出 CoT，官方无 low/medium/high 档位参数，靠 max_new_tokens 控制。',
    source: 'https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners',
    generic: true,
  },
  {
    // ⚠️ Phi-4 的 16384 比 Phi-4-mini 的 131072 更小 —— 这是官方值，勿按「mini 更小」直觉推断。
    // ⚠️ 本段顺序是「宽 → 具体」：`phi-4` 会命中所有 phi-4-*，故必须排在它们**之前**。
    match: m('phi[-.]?4'),
    displayName: 'Phi-4', vendor: 'microsoft',
    contextWindow: 16384, maxTokens: 16384,
    source: 'https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners',
  },
  {
    // Phi-4-mini-instruct：131072 / 4096。
    match: m('phi[-.]?4[-.]?mini'),
    displayName: 'Phi-4 mini', vendor: 'microsoft',
    contextWindow: 131072, maxTokens: 4096,
    source: 'https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners',
  },
  {
    // Phi-4-mini-reasoning：128000 / 128000。
    match: m('phi[-.]?4[-.]?mini[-.]?reasoning'),
    displayName: 'Phi-4 mini reasoning', vendor: 'microsoft',
    contextWindow: 128000, maxTokens: 128000,
    source: 'https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners',
  },
  {
    // Phi-4-reasoning：32768 / 32768。
    match: m('phi[-.]?4[-.]?reasoning'),
    displayName: 'Phi-4 reasoning', vendor: 'microsoft',
    contextWindow: 32768, maxTokens: 32768,
    source: 'https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners',
  },
  {
    // Phi-4-reasoning-vision-15B：16384 / 图（maxOut 官方未给，继承上一条）。
    match: m('phi[-.]?4[-.]?reasoning[-.]?vision'),
    displayName: 'Phi-4 reasoning vision', vendor: 'microsoft',
    contextWindow: 16384,
    input: ['text', 'image'],
    note: '官方页只给模态与 16,384 上下文，未给最大输出上限。',
    source: 'https://ai.azure.com/catalog/models/Phi-4-Reasoning-Vision-15B',
  },
  {
    // ⚠️ Phi-4-multimodal：131072 / 4096，含 audio 输入。
    match: m('phi[-.]?4[-.]?multimodal'),
    displayName: 'Phi-4 multimodal', vendor: 'microsoft',
    contextWindow: 131072, maxTokens: 4096,
    input: ['text', 'image'], extraInputs: ['audio'],
    source: 'https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners',
  },

  // ──────────────────────── Cohere Command ────────────────────────
  {
    match: m('command[-.]?[ar]|cohere'),
    displayName: 'Cohere Command', vendor: 'cohere',
    contextWindow: 128000, maxTokens: 4000,
    input: ['text'],
    reasoningEfforts: undefined,
    note: 'Cohere 的 thinking 为开/关 + token_budget 数值预算，无 low/medium/high 分级。',
    source: 'https://docs.cohere.com/docs/models',
    generic: true,
  },
  {
    // Command A：256000 / 8000。
    // ⚠️ 必须排在本段**最前**：`command-a` 会命中 command-a-plus / -vision / -reasoning。
    match: m('command[-.]?a'),
    displayName: 'Command A', vendor: 'cohere',
    contextWindow: 256000, maxTokens: 8000,
    source: 'https://docs.cohere.com/docs/command-a',
  },
  {
    match: m('command[-.]?a[-.]?plus'),
    displayName: 'Command A Plus', vendor: 'cohere',
    contextWindow: 128000, maxTokens: 64000,
    input: ['text', 'image'],
    source: 'https://docs.cohere.com/docs/command-a-plus',
  },
  {
    match: m('command[-.]?a[-.]?vision'),
    displayName: 'Command A Vision', vendor: 'cohere',
    contextWindow: 128000, maxTokens: 8000,
    input: ['text', 'image'],
    source: 'https://docs.cohere.com/docs/models',
  },
  {
    match: m('command[-.]?a[-.]?reasoning'),
    displayName: 'Command A Reasoning', vendor: 'cohere',
    contextWindow: 256000, maxTokens: 32000,
    source: 'https://docs.cohere.com/docs/command-a-reasoning',
  },

  // ──────────────────────── AI21 Jamba ────────────────────────
  {
    match: m('jamba'),
    displayName: 'AI21 Jamba', vendor: 'ai21',
    contextWindow: 262144,
    input: ['text'],
    reasoningEfforts: false,
    note: '官方明确 Input/Output Modality 均为 Text，无任何视觉变体；**官方未给最大输出上限**（原表的 4096 无官方依据，已删除）。精确 id：`jamba-large-1.7-2025-07`、`jamba-mini-2-2026-01`；`jamba-mini-1.7` 官方 2026-02-01 下线、1.6 系 2025-08-03 已下线；Jamba 3B 无 API Endpoint。',
    source: 'https://docs.ai21.com/docs/jamba-foundation-models',
    generic: true,
  },

  // ──────────────────────── 亚马逊 Nova ────────────────────────
  {
    // ⚠️ Nova 的 id 带区域前缀（us. / eu. / apac. / jp. / global.），归一化后成 `us-amazon-nova-...`。
    // 规则只锚 `nova`，故所有区域变体都能命中。
    match: m('nova'),
    displayName: 'Amazon Nova', vendor: 'amazon',
    contextWindow: 300000, maxTokens: 10000,
    input: ['text', 'image'], extraInputs: ['video'],
    reasoningEfforts: false,
    source: 'https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html',
    generic: true,
  },
  {
    // Nova 2 Lite：1M / 64K / 官方三档 low-medium-high（默认 disabled）。
    match: m('nova[-.]?2[-.]?lite'),
    displayName: 'Nova 2 Lite', vendor: 'amazon',
    contextWindow: 1000000, maxTokens: 65536,
    input: ['text', 'image'], extraInputs: ['video'],
    reasoningEfforts: E('low', 'medium', 'high'),
    note: '官方 reasoningConfig.maxReasoningEffort 取 low/medium/high，默认 disabled；Nova 1 全系不支持 extended thinking。',
    source: 'https://docs.aws.amazon.com/nova/latest/nova2-userguide/extended-thinking.html',
  },
  {
    // ★ Nova 2 Sonic（2025-12-02 发布）：双向流式语音模型，1M / 64K，音频+语音+文本（**无图像/视频**）。
    //   与 Nova 2 Lite 同代但模态完全不同，故不能继承家族的 image/video。
    match: m('nova[-.]?2[-.]?sonic'),
    displayName: 'Nova 2 Sonic', vendor: 'amazon',
    contextWindow: 1000000, maxTokens: 65536,
    input: ['text'], extraInputs: ['audio'],
    reasoningEfforts: undefined,
    // ★ 必须显式清空家族继承来的 ['video']。
    note: '官方 Input 模态 = Audio / Speech / Text（无 Image、无 Video），Output = Speech / Text。**仅 `InvokeModelWithBidirectionalStream`，不支持 Invoke/Converse/Chat Completions**；仅 In-Region（Geo 与 Global 均不支持）。思考参数官方未声明。',
    source: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-sonic.md',
  },
  {
    // Nova Micro：128K / 10K，纯文本。
    match: m('nova[-.]?micro'),
    displayName: 'Nova Micro', vendor: 'amazon',
    contextWindow: 128000, maxTokens: 10000,
    input: ['text'],
    // ★ 必须显式清空：不写就会从家族兜底 `nova` 继承到 ['video']，解析出「纯文本 + 视频」的矛盾结果。
    extraInputs: [],
    source: 'https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html',
  },
  {
    // Nova Premier：1M / 10K。
    match: m('nova[-.]?premier'),
    displayName: 'Nova Premier', vendor: 'amazon',
    contextWindow: 1000000, maxTokens: 10000,
    source: 'https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html',
  },
  {
    // Nova Lite / Pro：300K / 10K。
    match: m('nova[-.]?lite|nova[-.]?pro'),
    displayName: 'Nova Lite/Pro', vendor: 'amazon',
    contextWindow: 300000, maxTokens: 10000,
    source: 'https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html',
  },

  // ──────────────────────── NVIDIA Nemotron ────────────────────────
  {
    match: m('nemotron'),
    displayName: 'NVIDIA Nemotron', vendor: 'nvidia',
    contextWindow: 1000000, maxTokens: 32768,
    input: ['text'],
    reasoningEfforts: undefined,
    note: 'NVIDIA 用 enable_thinking 开关 + low_effort / medium_effort / reasoning_budget 标志，不是统一的 low/medium/high 档位表。',
    source: 'https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b',
    generic: true,
  },
  {
    // ⚠️ 本段顺序是「宽 → 具体」：`nemotron-3` 会命中 3-nano 与 3-nano-omni，
    //    故 3 必须在前，omni 的模态覆盖放最后。
    match: m('nemotron[-.]?3'),
    displayName: 'Nemotron 3', vendor: 'nvidia',
    contextWindow: 1000000,
    source: 'https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b',
  },
  {
    // Nemotron 3 Nano：两口径冲突（NIM 页 128K vs HF 官方卡 1M），取较保守的 128K。
    match: m('nemotron[-.]?3[-.]?nano'),
    displayName: 'Nemotron 3 Nano', vendor: 'nvidia',
    contextWindow: 131072,
    note: 'NVIDIA NIM 页写 128K，而 HF 官方卡写 1M（默认配置 256k），两口径冲突，此处取较保守的 128K。',
    source: 'https://build.nvidia.com/nvidia/nemotron-3-nano-30b-a3b',
  },
  {
    // ★ Nemotron 3 Ultra（2026-06-03）：官方 README 本轮抓取失败 → 规格未知，只登记存在与来源。
    match: m('nemotron[-.]?3[-.]?ultra'),
    displayName: 'Nemotron 3 Ultra', vendor: 'nvidia',
    note: '官方 HF 仓 2026-06-03 创建，README 本轮抓取失败，ctx/maxOut 官方一手未取到，故不填数字（继承家族兜底值）。',
    source: 'https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16',
  },
  {
    // ★ Nemotron 3.5 Lightning（2026-08-01）：同上，规格未取到。
    match: m('nemotron[-.]?3[-.]?5'),
    displayName: 'Nemotron 3.5 Lightning', vendor: 'nvidia',
    note: '官方 2026-08-01 发布，READ.ME 未取到规格，故不填数字。',
    source: 'https://build.nvidia.com/nvidia',
  },
  {
    // Nemotron Omni：256k，视频/音频/图像/文本输入。
    match: m('nemotron.*omni'),
    displayName: 'Nemotron Omni', vendor: 'nvidia',
    contextWindow: 262144,
    input: ['text', 'image'], extraInputs: ['audio', 'video'],
    source: 'https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  },

  // ──────────────────────── IBM Granite ────────────────────────
  {
    match: m('granite'),
    displayName: 'IBM Granite', vendor: 'ibm',
    contextWindow: 131072, maxTokens: 8192,
    input: ['text'],
    reasoningEfforts: undefined,
    note: 'Granite 4.2 用 enable_thinking + low_effort 两个布尔量表达三档（thinking / non-thinking / low-effort），不是 low/medium/high 档位表；maxOut 官方未给硬上限。',
    source: 'https://huggingface.co/ibm-granite/granite-4.2-30b',
    generic: true,
  },
  {
    match: m('granite[-.]?vision'),
    displayName: 'Granite Vision', vendor: 'ibm',
    contextWindow: 131072,
    input: ['text', 'image'],
    source: 'https://huggingface.co/ibm-granite/granite-vision-4.1-4b',
  },
  {
    // Granite 4.2 / 4.0：原生 128K（官方称可扩展至 512K，此处取原生值）。
    match: m('granite[-.]?4'),
    displayName: 'Granite 4', vendor: 'ibm',
    contextWindow: 131072,
    source: 'https://huggingface.co/ibm-granite/granite-4.2-30b',
  },

  // ──────────────────────── AI2 OLMo ────────────────────────
  {
    match: m('olmo'),
    displayName: 'AI2 OLMo', vendor: 'allenai',
    contextWindow: 65536, maxTokens: 32768,
    input: ['text'],
    reasoningEfforts: undefined,
    note: 'OLMo 3 用模型 id 后缀区分 -Think（长链思考）与 -Instruct（直答），不是参数级档位；maxOut 官方未给硬上限。',
    source: 'https://huggingface.co/allenai/Olmo-3.1-32B-Think',
    generic: true,
  },

  // ──────────────────────── Upstage Solar ────────────────────────
  {
    match: m('solar'),
    displayName: 'Upstage Solar', vendor: 'upstage',
    contextWindow: 131072, maxTokens: 32768,
    input: ['text'],
    reasoningEfforts: undefined,
    note: '官方模型页未写明输入模态（故按纯文本兜底，实际是否支持图像未经证实）。',
    source: 'https://console.upstage.ai/docs/models/solar-pro-4',
    generic: true,
  },
  {
    // Solar Pro4 / Mini4：512K 上下文 / 128K 输出 / 官方 reasoning_effort 分档。
    match: m('solar[-.]?(?:pro|mini)[-.]?4'),
    displayName: 'Solar Pro4/Mini4', vendor: 'upstage',
    contextWindow: 524288, maxTokens: 131072,
    reasoningEfforts: E('low', 'high'),
    note: '★ 档位收窄：官方博客正文只举 `reasoning_effort` 的 **high / low 两档**（原表的 medium/xhigh/max 无官方依据，已删除）。官方另给关键区别：**Pro 4 默认开启推理，Mini 4 默认关闭**（本规则无法区分两者，故只声明档位，不改默认态）。',
    source: 'https://console.upstage.ai/docs/models/solar-pro-4',
  },
  {
    // Solar Pro3：128000；官方页未给输出上限。
    match: m('solar[-.]?pro[-.]?3'),
    displayName: 'Solar Pro3', vendor: 'upstage',
    contextWindow: 128000,
    reasoningEfforts: E('medium', 'high'),
    source: 'https://console.upstage.ai/docs/models/solar-pro-3',
  },
  {
    // Solar Pro2：65536；官方页未给输出上限。
    match: m('solar[-.]?pro[-.]?2'),
    displayName: 'Solar Pro2', vendor: 'upstage',
    contextWindow: 65536,
    reasoningEfforts: E('medium', 'high'),
    source: 'https://console.upstage.ai/docs/models/solar-pro-2',
  },

  // ──────────────────────── Reka ────────────────────────
  {
    match: m('reka'),
    displayName: 'Reka', vendor: 'reka',
    contextWindow: 65536, maxTokens: 32768,
    input: ['text'],
    reasoningEfforts: undefined,
    note: 'reka-flash-3 支持 reasoning（轨迹在 message.reasoning），reka-edge-2603 不支持；官方无档位参数。',
    source: 'https://docs.reka.ai/chat/models',
    generic: true,
  },
  {
    // Reka Flash 3：64k 上下文 / 58982 输出。
    // ⚠️ 必须排在 Flash 3.1 **之前**：`reka-flash-3` 的尾锚点会吸收 `-1`。
    match: m('reka[-.]?flash[-.]?3'),
    displayName: 'Reka Flash 3', vendor: 'reka',
    contextWindow: 65536, maxTokens: 58982,
    note: '官方目录给 64k 上下文，而 HF config.json 为 32768，此处取目录值。',
    source: 'https://developer.reka.ai/models',
  },
  {
    // Reka Flash 3.1：96K（config 98304）。
    match: m('reka[-.]?flash[-.]?3[-.]?1'),
    displayName: 'Reka Flash 3.1', vendor: 'reka',
    contextWindow: 98304,
    source: 'https://huggingface.co/RekaAI/reka-flash-3.1',
  },
  {
    // Reka Edge：16k，文本+图像+视频，非推理。
    match: m('reka[-.]?edge'),
    displayName: 'Reka Edge', vendor: 'reka',
    contextWindow: 16384, maxTokens: 16384,
    input: ['text', 'image'], extraInputs: ['video'],
    reasoningEfforts: false,
    note: '官方 `/v1/models` 给出 `context_length: 16384` 与 `max_output_length: 16384`（两者同值），`supported_features: [tools, structured_outputs, streaming]`，`is_ready: true`。',
    source: 'https://docs.reka.ai/chat/models',
  },
];

/**
 * 站点级覆盖（对应 zcode 的 `providerSiteRules`）。
 * 命中顺序：BASE ← MODEL ← SITE，站点最具体、最后覆盖。
 * 首版留空 —— 不预先编造，遇到真实不兼容的站点再补（docs/03 §5.3）。
 */
export const SITE_RULES = [
  // { baseURLMatch: /opencode\.ai\/zen\/go\/v1/, apiTypeMatch: 'openai-completions',
  //   reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
];

/**
 * 别名表：只收「确定同一模型」的等价写法。
 * 别名**只改匹配用名，不改显示名**（docs/03 §3.4.1）。
 */
export const ALIASES = [
  [/^deepseek-chat$/, 'deepseek-v4-flash'],
  [/^deepseek-v3(?:[.]\d+)?$/, 'deepseek-v4-flash'],
  [/^deepseek-coder$/, 'deepseek-v4-flash'],
  [/^gpt-4o-latest$/, 'gpt-4o'],
  [/^claude-3-5-sonnet-latest$/, 'claude-3-5-sonnet'],
  [/^gemini-pro$/, 'gemini-1.5-pro'],
];

/**
 * 名称启发式（S4）—— 仅在 S1–S3 都拿不到结论时使用，**只给候选，不自动写**。
 * 正则 → 建议的 `reasoningEfforts`。
 */
export const HEURISTIC_REASONING = [
  { match: /(?:^|[.\-:/[])(?:r1|reasoner|thinking|think)(?:[.\-:/[].*)?$/i, efforts: E('low', 'medium', 'high') },
  { match: /(?:^|[.\-:/[])(?:o1|o3|o4)(?:[.\-:/[].*)?$/i, efforts: E('low', 'medium', 'high') },
  { match: /(?:^|[.\-:/[])(?:flash|mini|lite|turbo|air|nano)(?:[.\-:/[].*)?$/i, efforts: E('low', 'medium') },
];

/** 名称启发式：从名字推断是否多模态（仅建议）。 */
export const HEURISTIC_MODALITY = [
  { match: /(?:^|[.\-:/[])(?:vl|vision|v|omni|image)(?:[.\-:/[].*)?$/i, input: ['text', 'image'] },
];
