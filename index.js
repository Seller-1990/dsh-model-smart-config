/**
 * dsh-model-smart-config — Host 半。
 *
 * 存在的两个理由（缺一不可）：
 *   ① 规则表是 Host 侧的 ESM 模块（`data/model-rules.js`），Client 半是
 *      `window.__ModuleLoader__` 的 CJS 风格工厂，**读不到** Host 的 ESM 导出；
 *   ② 官方 `llm` Remote 只暴露 `discoverModels` / `listProviders` /
 *      `listConfigurableProviders` 三个端点，`ctx.llm.resolveModelInfo`
 *      （S2 权威推理元数据）与「实测探测」（S3，要发真实 HTTP 请求）
 *      都**没有** Remote 形态。
 *
 * 因此本文件注册一个 `msc` 服务并经 `ctx.typert.register` 显式发布三个端点：
 *   - `msc/infer`          纯规则推断（模型识别 + 规格取值）
 *   - `msc/authoritative`  S2：包一层 `ctx.llm.resolveModelInfo`
 *   - `msc/probe`          S3：手动触发的实测探测（默认不自动调用）
 *
 * ⚠️ 为什么必须显式 `ctx.typert.register` 而不能靠源码标记发现：
 * 标记表是 `@deepseek-ai/dsh-typert-protocol` 的**模块私有 WeakMap**，本地
 * 安装的插件其 peer 从真实目录解析、与宿主树物理分离，永远无法共享该表，
 * 症状是「零 endpoint 被 claim、/api/msc/* 全 404」。显式注册把描述符写进
 * `ctx.typert.local`，而 gateway 的 `claimsEndpoint` **先查它**。
 * （`dsh-advisor/lib/gateway.js` 的源码注释实证，同一范式。）
 */

import z from '@deepseek-ai/schemastery';
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

import { resolveSpec } from './rules/match.js';
import { isValidReasoningEfforts, toModelFields } from './rules/infer.js';

/** Cordis 服务键 = typert 端点 namespace。 */
const SERVICE_KEY = 'msc';

/** typert 贡献的包标识（只要求非空且不含 `#`）。 */
const PACKAGE = 'dsh-model-smart-config';

/** 探测请求的默认超时（毫秒）。探测是用户手动触发的，宁可慢一点也要有结论。 */
const PROBE_TIMEOUT_MS = 20_000;

/** 探测时单次请求的输出上限 —— 探测只关心「能不能跑通」，不需要长回答。 */
const PROBE_MAX_TOKENS = 16;

/**
 * Anthropic 的「档位 → 思考预算」换算表。
 *
 * Anthropic 的 Messages API **没有** `reasoning_effort` 这种具名档位，思考深度
 * 只由 `thinking.budget_tokens` 的数值表达。所以对 anthropic-messages 协议，
 * 「试某一档」必须翻译成「用该档的预算发一次请求」，否则每次请求体完全相同，
 * 各档位的结果不可区分（档位探测就失去意义）。
 *
 * 两条硬约束（都来自 Anthropic 的 Messages API）：
 *   1. `max_tokens` 必须**严格大于** `thinking.budget_tokens`，否则 400：
 *      `max_tokens: N must be greater than thinking.budget_tokens: M`。
 *      因此带 thinking 的请求要把 max_tokens 抬到预算之上（见 `probe`）。
 *   2. `budget_tokens` 下限 1024。
 *
 * 数值与 pi-ai 的 `thinkingBudgets`（minimal/low/medium/high）同量级；
 * 超出模型能力的档位会由端点自己回绝，正好落进 `rejectedLevels`。
 */
const ANTHROPIC_THINKING_BUDGETS = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536,
};

/** 未在表内的档位用的兜底预算（不小于 API 下限 1024）。 */
const ANTHROPIC_THINKING_BUDGET_FALLBACK = 1024;

/**
 * 插件配置。
 *
 * 全部字段 `.volatile()`：Loader 把编辑提交进**运行中 fiber 的引用**而不重挂，
 * 所以 `apply` 收到的是 `{ get() }` 引用，每次读都要 `unwrap`（见 `unwrap`）。
 * 有 ≥1 个 volatile 字段的条目会自动出现在 `settings.describe()`，
 * 因此在插件管理页里可直接改，无需重启。
 */
export const Config = z.object({
  /** 插件总开关。false 时卡片不渲染任何建议（但也不隐藏官方界面）。 */
  enabled: z.boolean().default(true).volatile(),
  /** 上下文窗口 / 最大输出是否允许「应用建议」直接写。 */
  autoApplyContext: z.boolean().default(true).volatile(),
  /** 输入模态是否允许「应用建议」直接写。 */
  autoApplyModality: z.boolean().default(true).volatile(),
  /** 思考等级是否允许「应用建议」直接写。 */
  autoApplyReasoning: z.boolean().default(true).volatile(),
  /** 是否显示「测试」按钮。**探测永远只在手动点击时发生**，本开关只控制入口显隐。 */
  allowProbe: z.boolean().default(true).volatile(),
});

/** Host 半不需要别的服务即可激活；`llm` / `credentials` 用条件子级按需取用。 */
export const inject = [];

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 读取 volatile 引用（同时容忍普通值，便于测试直接传对象）。 */
function unwrap(value, fallback) {
  if (value === undefined) return fallback;
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const inner = value.get();
    return inner === undefined ? fallback : inner;
  }
  return value;
}

/**
 * 递归剔除 `undefined`。
 *
 * typert 的 `src-json` 结果校验**拒绝 undefined**（wire 是 JSON，没有 undefined），
 * 而本插件的语义恰恰大量使用 `undefined` 表示「未识别、不写值」。
 * 所以在离开 Host 之前统一压平：缺席即 `undefined`，而不是 `null`。
 */
function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] = compact(item);
  }
  return out;
}

/**
 * 拼出某个协议的**聊天请求** URL。
 *
 * `baseURL` 由用户自己填，网关文档对同一个根同时公布两种拼法（带 / 不带尾部
 * `/v1`），pi-ai 的 `listingUrl` 就为此显式归一化掉一个尾部 `/v1` 段
 * （见 `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:2188-2203` 的注释与实现）。
 * 本函数沿用同一套归一化规则，避免用户填 `https://api.anthropic.com/v1`
 * 时拼出 `/v1/v1/messages` 这种必然 404 的地址。
 *
 * 注意：只对 anthropic-messages 做这个归一化 —— 它的路径自带 `/v1`；
 * OpenAI 形态的两条路径（`/chat/completions`、`/responses`）里没有版本段，
 * 用户填的 `/v1` 是**根的一部分**，必须原样保留。
 */
function requestUrl(baseURL, api) {
  const base = String(baseURL).replace(/\/+$/, '');
  if (api !== 'anthropic-messages') return `${base}${protocolProfile(api).path}`;
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base;
  return `${root}${protocolProfile(api).path}`;
}

/** 判定一个协议走哪条请求路径与哪套鉴权头。 */
function protocolProfile(api) {
  switch (api) {
    case 'anthropic-messages':
      return {
        path: '/v1/messages',
        headers: (key) => ({
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        }),
      };
    case 'openai-responses':
      return {
        path: '/responses',
        headers: (key) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` }),
      };
    case 'openai-completions':
    default:
      return {
        path: '/chat/completions',
        headers: (key) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` }),
      };
  }
}

/**
 * 从响应体里挖出「这次回答有没有思考过程」的证据。
 *
 * 覆盖两条协议的**真实**响应形状 —— 早期只认 OpenAI 形状，会把 Anthropic 的
 * 思考回答误报成「未观察到」：
 *   - OpenAI 形态（`openai-completions` / `openai-responses`）：
 *     `choices[0].message.reasoning_content` / `.reasoning`，或
 *     `choices[0].message.content[]` 里的 `type === 'thinking'` 块，
 *     以及 `usage.completion_tokens_details.reasoning_tokens`。
 *   - Anthropic 形态（`anthropic-messages`）：思考块在**顶层** `content[]` 里
 *     （`{type:'thinking', thinking:'…'}`），不在 `choices` 下 —— 见
 *     https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking 。
 *     另可用 `usage.output_tokens_details.thinking_tokens` 佐证。
 */
function reasoningEvidence(payload) {
  const fields = [];

  // —— OpenAI 形态 ——
  const message = payload?.choices?.[0]?.message;
  const messageBlocks = Array.isArray(message?.content) ? message.content : [];
  const messageTypes = messageBlocks.map((block) => block?.type).filter((type) => typeof type === 'string');
  const details = payload?.usage?.completion_tokens_details;

  if (typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0) {
    fields.push('choices[0].message.reasoning_content');
  }
  if (typeof message?.reasoning === 'string' && message.reasoning.length > 0) {
    fields.push('choices[0].message.reasoning');
  }
  if (messageTypes.includes('thinking')) fields.push('choices[0].message.content[].type=thinking');
  if (typeof details?.reasoning_tokens === 'number' && details.reasoning_tokens > 0) {
    fields.push('usage.completion_tokens_details.reasoning_tokens');
  }

  // —— Anthropic 形态（顶层 content[]）——
  const topBlocks = Array.isArray(payload?.content) ? payload.content : [];
  const topTypes = topBlocks.map((block) => block?.type).filter((type) => typeof type === 'string');
  if (topTypes.includes('thinking') || topTypes.includes('redacted_thinking')) {
    fields.push('content[].type=thinking');
  }
  const thinkingTokens = payload?.usage?.output_tokens_details?.thinking_tokens;
  if (typeof thinkingTokens === 'number' && thinkingTokens > 0) {
    fields.push('usage.output_tokens_details.thinking_tokens');
  }

  return fields;
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

class ModelSmartConfigGateway extends TypertRemoteService {
  /** @type {object|undefined} 组合中存在 `llm` 服务时才有（S2 数据源）。 */
  llm;

  /** @type {object|undefined} 组合中存在 `credentials` 服务时才有（探测取密钥）。 */
  credentials;

  constructor(ctx, config) {
    super(ctx, SERVICE_KEY);
    this.config = config;

    // 可选服务一律用条件子级捕获 + disposer 收回，缺服务时插件照常激活，
    // 对应端点干净地报「不可用」，而不是让整个插件加载失败。
    ctx.inject(['llm'], (sctx) => {
      this.llm = sctx.llm;
      return () => {
        this.llm = undefined;
      };
    });
    ctx.inject(['credentials'], (sctx) => {
      this.credentials = sctx.credentials;
      return () => {
        this.credentials = undefined;
      };
    });
  }

  /* -------------------------------------------------------------- *
   * msc/infer —— 纯规则推断（无网络、无 IO）
   * -------------------------------------------------------------- */

  /**
   * 识别模型名并给出规格建议。
   *
   * 全部字段经 `toModelFields` 这一**唯一组装出口**取值 —— 绝不直读
   * `spec.input` / `spec.reasoningEfforts`。`BASE_RULE.input = ['text']` 恒存在，
   * 直读会让**未识别**的模型也被宣称「支持 text」并写进配置，违反 docs/03 §7
   * 的「不静默写错值」。判定层未命中时返回 `undefined`，由 `compact` 压平。
   *
   * @param {{name?: string, baseURL?: string, api?: string}} request
   * @returns 可直接展示与写库的规格快照（`undefined` 字段已在 wire 上压平）。
   */
  infer(request) {
    const name = typeof request?.name === 'string' ? request.name : '';
    if (name.trim().length === 0) {
      throw new RemoteError('msc/rejected', 'msc: infer requires a non-empty model name', {});
    }

    const { raw, normalized, alias, spec, matchedRules, matchedSiteRules, confidence } = resolveSpec(name, {
      baseURL: request?.baseURL,
      api: request?.api,
    });

    const fields = toModelFields(spec, { normalizedName: normalized });
    const legal = isValidReasoningEfforts(spec.reasoningEfforts);

    return compact({
      raw,
      normalized,
      alias,
      confidence,
      matchedRules,
      matchedSiteRules,
      vendor: spec.vendor,
      displayName: spec.displayName,
      contextWindow: fields.contextWindow,
      maxTokens: fields.maxTokens,
      input: fields.input,
      extraInputs: fields.extraInputs,
      reasoningEfforts: fields.reasoningEfforts,
      reasoningSuggestion: fields.reasoningSuggestion,
      // 每项来源分别标注 —— UI 不能把「启发式候选」冒充成「内置规则表」。
      sources: fields.sources,
      notes: fields.notes,
      // 官方文档 URL（「官方文档」途径的落点），便于用户核对依据。
      source: spec.source,
      // 规则表自己写错了（形态非法）时必须显式报出来，不静默降级 ——
      // 否则用户会看到一个来源标注为「内置规则表」却是错的结论。
      warnings: legal
        ? []
        : [`内置规则表第 ${matchedRules.join('、')} 条规则的 reasoningEfforts 形态非法，已忽略该字段`],
    });
  }

  /* -------------------------------------------------------------- *
   * msc/authoritative —— S2：官方权威推理元数据
   * -------------------------------------------------------------- */

  /**
   * 问 `ctx.llm.resolveModelInfo` 要权威结论。
   *
   * 对 pi-ai 内置 catalog 已知的路由最权威（数据来自 pi-ai 的静态目录 JSON，
   * 含 `thinkingLevelMap`）；第三方自定义路由没有 catalog 条目，会以
   * `UNKNOWN_MODEL` 之类失败 —— 这是预期路径，不是错误，所以**不抛异常**，
   * 而是返回 `{found:false, reason}` 让 Client 半回退到内置规则表。
   *
   * @param {{provider?: string, model?: string}} request
   */
  async authoritative(request) {
    const provider = request?.provider;
    const model = request?.model;
    if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
      throw new RemoteError('msc/rejected', 'msc: authoritative requires both provider and model', {});
    }
    if (this.llm === undefined) return { found: false, reason: 'llm-unavailable' };

    try {
      const info = await this.llm.resolveModelInfo(provider, model);
      const efforts = info?.reasoning?.efforts;
      return compact({
        found: true,
        provider: info.provider,
        id: info.id,
        name: info.name,
        contextWindow: info.context?.contextWindow,
        defaultMaxTokens: info.defaultMaxTokens,
        inputModalities: info.inputModalities,
        // 官方返回的是 `[{id, name}]` 列表，本插件要的是 `{档位: wire拼写}`，
        // 这里做唯一一次形状转换：wire 拼写取 id（pi-ai 的档位键即 wire 值）。
        reasoningEfforts:
          Array.isArray(efforts) && efforts.length > 0
            ? Object.fromEntries([
                ['off', null],
                ...efforts.filter((effort) => effort?.id && effort.id !== 'off').map((effort) => [effort.id, effort.id]),
              ])
            : undefined,
        defaultEffort: info?.reasoning?.defaultEffort,
      });
    } catch (error) {
      return compact({
        found: false,
        reason: typeof error?.code === 'string' ? error.code : 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /* -------------------------------------------------------------- *
   * msc/probe —— S3：实测探测（**只由用户点击触发**）
   * -------------------------------------------------------------- */

  /**
   * 向用户自己配置的第三方端点发**真实请求**，观察它对推理参数的反应。
   *
   * 成本与边界（刻意保守）：
   *   - 只测「是否支持思考」与「哪些档位被接受」，**不测上下文窗口**
   *     （那要发超长请求，成本不可控）；
   *   - 不测多模态（用户已拍板「按模型公开信息判断」，无需花额度）；
   *   - 每档位一次请求，`max_tokens` 压到 16；
   *   - 结论一律是**建议值**，不自动落库。
   *
   * 密钥来源：请求只带 `apiKeyRef`（引用名），Host 半经凭据 seam 解析 —— 
   * **密钥永远不跨 wire**。
   *
   * @param {{baseURL?: string, api?: string, apiKeyRef?: string, model?: string, levels?: string[]}} request
   */
  async probe(request) {
    const baseURL = request?.baseURL;
    const model = request?.model;
    if (typeof baseURL !== 'string' || baseURL.length === 0) {
      throw new RemoteError('msc/rejected', 'msc: probe requires a baseURL', {});
    }
    if (typeof model !== 'string' || model.length === 0) {
      throw new RemoteError('msc/rejected', 'msc: probe requires a model', {});
    }
    if (this.credentials === undefined) {
      throw new RemoteError('msc/unavailable', 'msc: the credentials service is not composed — cannot resolve the API key', {});
    }

    const apiKeyRef = request?.apiKeyRef;
    if (typeof apiKeyRef !== 'string' || apiKeyRef.length === 0) {
      throw new RemoteError('msc/rejected', 'msc: probe requires the credential reference name (apiKeyRef)', {});
    }
    const key = (await this.credentials.resolve(apiKeyRef))?.value;
    if (typeof key !== 'string' || key.length === 0) {
      throw new RemoteError('msc/unavailable', `msc: credential "${apiKeyRef}" is not configured`, {});
    }

    const api = request?.api ?? 'openai-completions';
    const profile = protocolProfile(api);
    const url = requestUrl(baseURL, api);
    const headers = profile.headers(key);

    /**
     * 发一次聊天请求，返回 `{ok, status, detail, evidence}`（网络异常也不抛）。
     *
     * 输出上限字段名要自适应：OpenAI 的推理模型（o1/o3/o4 系）**拒绝**
     * `max_tokens`，报 `Unsupported parameter: 'max_tokens' is not supported
     * with this model. Use 'max_completion_tokens' instead.`；老模型则相反。
     * pi-ai 同样带一张两名的字段表来兼容（`MAX_TOKENS_FIELDS`
     * = { max_completion_tokens, max_tokens }，见
     * `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:319-322`）。
     * 所以第一次被明确点名拒绝时，换名重发一次 —— 否则推理模型的探测会
     * 全军覆没，而错因只是字段名。
     */
    const attempt = async (body, maxTokens = PROBE_MAX_TOKENS) => {
      const send = async (tokenField) => {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model, [tokenField]: maxTokens, ...body }),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          const text = await response.text().catch(() => '');
          let payload;
          try {
            payload = JSON.parse(text);
          } catch {
            payload = undefined;
          }
          return { response, payload, text };
        } catch (error) {
          return { error };
        }
      };

      let outcome = await send('max_tokens');
      if (outcome.error === undefined && !outcome.response.ok) {
        const detail = outcome.payload?.error?.message ?? outcome.payload?.message ?? outcome.text?.slice(0, 300) ?? '';
        if (typeof detail === 'string' && /max_completion_tokens/i.test(detail) && /max_tokens/i.test(detail)) {
          outcome = await send('max_completion_tokens');
        }
      }

      if (outcome.error !== undefined) {
        const error = outcome.error;
        const timedOut = error?.name === 'TimeoutError';
        return {
          ok: false,
          status: 0,
          detail: timedOut ? `请求超时（${PROBE_TIMEOUT_MS / 1000}s）` : `无法连接 ${url}：${error?.message ?? error}`,
          evidence: [],
        };
      }

      const { response, payload, text } = outcome;
      if (!response.ok) {
        const detail = payload?.error?.message ?? payload?.message ?? String(text ?? '').slice(0, 300);
        return { ok: false, status: response.status, detail: `${url} 返回 ${response.status}：${detail}`, evidence: [] };
      }
      return { ok: true, status: response.status, detail: '', evidence: reasoningEvidence(payload) };
    };

    // ① 基线：不带任何推理参数，看回答里有没有思考痕迹。
    const baseline = await attempt({ messages: [{ role: 'user', content: 'hi' }] });

    // ② 逐档位试：被接受的档位进候选；报「未知参数」的档位判为不支持。
    const levels = Array.isArray(request?.levels) ? request.levels.filter((level) => typeof level === 'string') : [];
    const levelField = api === 'anthropic-messages' ? 'thinking' : 'reasoning_effort';
    const attempts = [];
    for (const level of levels) {
      let body;
      let maxTokens = PROBE_MAX_TOKENS;
      if (api === 'anthropic-messages') {
        // Anthropic 没有具名档位，只能把档位翻译成**不同的思考预算**，
        // 否则每次请求体一模一样，各档结果不可区分（档位探测就没意义）。
        const budget = ANTHROPIC_THINKING_BUDGETS[level] ?? ANTHROPIC_THINKING_BUDGET_FALLBACK;
        body = { messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled', budget_tokens: budget } };
        // 硬约束：`max_tokens` 必须**严格大于** `thinking.budget_tokens`，
        // 否则一律 400（`max_tokens: N must be greater than thinking.budget_tokens: M`）。
        maxTokens = budget + PROBE_MAX_TOKENS;
      } else {
        body = { messages: [{ role: 'user', content: 'hi' }], [levelField]: level };
      }
      const result = await attempt(body, maxTokens);
      attempts.push(
        compact({
          level,
          accepted: result.ok,
          status: result.status,
          // 400/422 且正文点名了该参数，才是「这个档位不被支持」的确证；
          // 其他失败（配额、鉴权、模型不存在）不能拿来否定档位。
          //
          // 另需排除 Anthropic 的预算类抱怨：`max_tokens: … must be greater
          // than thinking.budget_tokens: …` 里同样含 "thinking" 字样，若不加
          // 这条排除，会把「请求参数配错」误判成「该档位不支持」。
          rejectsParameter:
            !result.ok &&
            (result.status === 400 || result.status === 422) &&
            result.detail.includes(levelField) &&
            !/budget_tokens|must be greater than/i.test(result.detail),
          detail: result.detail,
        }),
      );
    }

    const supportedLevels = attempts.filter((item) => item.accepted === true).map((item) => item.level);
    const rejectedLevels = attempts.filter((item) => item.rejectsParameter === true).map((item) => item.level);

    return compact({
      url,
      api,
      baseline,
      attempts,
      conclusion: {
        // 「支持思考」的判据：基线回答里出现了思考字段。这是**正向证据**，
        // 没有它就只说「未观察到」，绝不断言「不支持」。
        reasoning: baseline.evidence.length > 0,
        reasoningEvidence: baseline.evidence,
        supportedLevels,
        rejectedLevels,
      },
      note:
        baseline.ok === false
          ? '基线请求未成功，本次探测没有有效结论 —— 请检查密钥、baseURL 与模型名'
          : supportedLevels.length === 0
            ? '未观察到任何档位被接受；这不等于模型不支持思考，可能只是该端点不认这些参数名'
            : '',
    });
  }
}

/* ------------------------------------------------------------------ *
 * typert 贡献
 * ------------------------------------------------------------------ */

/**
 * 显式端点描述符。三个端点参数都只有一份 JSON，所以形状完全一致；
 * 参数多时依次追加 `{name, wire, source:'json', codec:{mode:'src-json'}}`。
 */
export function mscTypertContribution() {
  const endpoint = (method) => ({
    id: `${PACKAGE}#msc/${method}`,
    service: SERVICE_KEY,
    namespace: SERVICE_KEY,
    method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } }],
    result: { mode: 'src-json' },
  });

  return {
    package: PACKAGE,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [endpoint('infer'), endpoint('authoritative'), endpoint('probe')],
  };
}

/* ------------------------------------------------------------------ *
 * 装配
 * ------------------------------------------------------------------ */

export function apply(ctx, rawConfig) {
  const config = {
    enabled: unwrap(rawConfig?.enabled, true),
    autoApplyContext: unwrap(rawConfig?.autoApplyContext, true),
    autoApplyModality: unwrap(rawConfig?.autoApplyModality, true),
    autoApplyReasoning: unwrap(rawConfig?.autoApplyReasoning, true),
    allowProbe: unwrap(rawConfig?.allowProbe, true),
  };

  // 多 fiber 去重：同一 bundle 可能被多个 fiber 加载，Cordis 的 Service 键
  // 重复注册会响亮失败。让第一个 fiber 拥有服务键，后续 fiber 静默跳过。
  let gateway;
  try {
    gateway = new ModelSmartConfigGateway(ctx, config);
  } catch (error) {
    if (!String(error?.message).includes('has been registered')) throw error;
  }

  ctx.inject(['typert'], (tctx) => {
    try {
      tctx.typert.register(mscTypertContribution());
    } catch (error) {
      if (!String(error?.message).includes('already registered')) throw error;
    }
  });

  if (gateway !== undefined) ctx.logger?.debug?.('msc: host half ready (service "%s")', SERVICE_KEY);
}
