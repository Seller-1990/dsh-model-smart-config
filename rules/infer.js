/**
 * rules/infer.js — 多模态 / 思考等级判定 + `reasoningEfforts` 合法性校验
 * （纯函数，无 DSH 依赖）
 *
 * 依据 docs/03-inference-rules.md §4 / §5 / §7。
 *
 * **本文件是「不静默写错值」这条质量底线的执行者**：
 * 拿不到结论时返回 `undefined`，由 UI 显示「未识别」让用户决定，绝不猜。
 */

import { HEURISTIC_MODALITY, HEURISTIC_REASONING } from '../data/model-rules.js';

/** DSH 的档位键全集（pi-ai `THINKING_LEVELS`，按升级顺序）。 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** DSH 的 `input` 只接受这两个值（pi-ai `MODALITIES`）。 */
export const DSH_MODALITIES = ['text', 'image'];

/**
 * `reasoningEfforts` 合法性校验 —— 与 pi-ai 适配器 `resolveModelReasoning` 对齐。
 *
 * 合法形态：
 *   - `undefined`            省略该字段，沿用 catalog
 *   - `false`                确定非推理模型
 *   - `{ off: null, ... }`   支持思考；`off` 的值只能是 `null`（或整个省略 `off`）；
 *                            **至少一个非 off 档**，其值必须是非空字符串
 *
 * 非法形态（必须拦住，否则写入会被适配器拒绝）：
 *   - `{ off: null }`        只声明了 off → `offers no level beyond "off"`
 *   - `{ off: null, high: null }` 非 off 档值为 null → `needs the wire value dispatch should send`
 *   - `{ off: null, high: '' }`   空串 → `must not be an empty string`
 *   - `{}` / `null` / 数组
 */
export function isValidReasoningEfforts(value) {
  if (value === undefined || value === false) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  const keys = Object.keys(value);
  if (keys.length === 0) return false;

  // off 可以省略；一旦声明，值必须是 null
  if (Object.prototype.hasOwnProperty.call(value, 'off') && value.off !== null) return false;

  const levels = keys.filter((key) => key !== 'off');
  if (levels.length === 0) return false;

  return levels.every(
    (key) =>
      THINKING_LEVELS.includes(key) &&
      typeof value[key] === 'string' &&
      value[key].length > 0,
  );
}

/**
 * 判定输入模态。
 *
 * 优先级（docs/03 §4）：
 *   ① 注册表命中 → 采用规则合并后的 input
 *   ② 端点 `/models` 返回 inputModalities → 采用
 *   ③ 名称启发式 → 只作**候选**，`fromHeuristic: true`
 *   ④ 都没有 → `undefined`（不写 `input`）
 *
 * @param {{input?: string[], extraInputs?: string[]}} spec
 * @param {{endpointModalities?: string[], normalizedName?: string}} [context]
 */
export function resolveModality(spec, context = {}) {
  const { endpointModalities, normalizedName } = context;
  const declared = Array.isArray(spec?.input) ? spec.input.filter((m) => DSH_MODALITIES.includes(m)) : [];

  // ① 注册表命中：只要命中了非兜底规则，spec.input 就是权威的
  if (declared.length > 0 && spec?.source !== undefined) {
    return { input: declared, source: 'registry', extraInputs: spec.extraInputs ?? [] };
  }

  // ② 端点返回
  if (Array.isArray(endpointModalities)) {
    const usable = endpointModalities.filter((m) => DSH_MODALITIES.includes(m));
    if (usable.length > 0) return { input: usable, source: 'endpoint', extraInputs: [] };
  }

  // ③ 名称启发式（只给候选）
  if (typeof normalizedName === 'string') {
    for (const rule of HEURISTIC_MODALITY) {
      if (rule.match.test(normalizedName)) {
        return { input: [...rule.input], source: 'heuristic', extraInputs: [] };
      }
    }
  }

  // ④ 未识别 —— 不写
  return { input: undefined, source: 'unknown', extraInputs: [] };
}

/**
 * 判定思考等级（有序回退 S2 → S1 → S3 → S4）。
 *
 * S2（官方 `resolveModelInfo`）与 S3（实测探测）由 Host 半在运行时补齐后
 * 传入 `context.authoritative` / `context.probed`，本纯函数只负责排序与兜底。
 *
 * @param {{reasoningEfforts?: unknown}} spec
 * @param {{authoritative?: unknown, probed?: unknown, normalizedName?: string}} [context]
 * @returns {{reasoningEfforts: unknown, source: 'authoritative'|'registry'|'probe'|'heuristic'|'unknown', note?: string}}
 */
export function resolveReasoning(spec, context = {}) {
  const { authoritative, probed, normalizedName } = context;

  // S2 官方 resolveModelInfo —— 对 catalog 已知路由最权威
  if (authoritative !== undefined && isValidReasoningEfforts(authoritative)) {
    return { reasoningEfforts: authoritative, source: 'authoritative' };
  }

  // S1 内置规则表
  const declared = spec?.reasoningEfforts;
  if (declared !== undefined) {
    if (isValidReasoningEfforts(declared)) return { reasoningEfforts: declared, source: 'registry' };
    // 规则表写错了：不静默降级成别的值，报出来
    return {
      reasoningEfforts: undefined,
      source: 'unknown',
      note: '内置规则表的 reasoningEfforts 形态非法，已忽略该字段（见 test/rules.test.mjs 的规则自检）',
    };
  }

  // S3 实测探测（用户点「测试」才有）
  if (probed !== undefined && isValidReasoningEfforts(probed)) {
    return { reasoningEfforts: probed, source: 'probe' };
  }

  // S4 名称启发式 —— 只给候选，不自动写
  if (typeof normalizedName === 'string') {
    for (const rule of HEURISTIC_REASONING) {
      if (rule.match.test(normalizedName)) {
        return {
          reasoningEfforts: undefined,
          source: 'heuristic',
          note: `名称提示可能是推理模型，建议档位：${Object.keys(rule.efforts).filter((k) => k !== 'off').join(' / ')}`,
          suggestion: { ...rule.efforts },
        };
      }
    }
  }

  // 未识别 —— 不写
  return { reasoningEfforts: undefined, source: 'unknown' };
}

/**
 * 把判定结果组装成可直接写进 profile 的模型字段。
 * **未识别的字段一律不出现在结果里**（`undefined` → 不写）。
 *
 * ⚠️ **这是唯一的组装出口**。任何调用方（Host 半的 `msc/infer`、单测）都必须
 * 经此函数取值，**不得**直接读 `spec.input` / `spec.reasoningEfforts`：
 * `BASE_RULE.input = ['text']` 恒存在，直读会让**未识别**的模型也被宣称
 * 「支持 text」并写入配置 —— 正是 docs/03 §7 禁止的「静默写错值」。
 * 判定层会先确认「是否真命中了带 `source` 的注册表规则」，未命中即返回
 * `undefined`，由调用方压平掉。
 *
 * @param {{contextWindow?: number, maxTokens?: number, input?: string[], extraInputs?: string[], reasoningEfforts?: unknown, source?: string}} spec
 * @param {{endpointModalities?: string[], normalizedName?: string, authoritative?: unknown, probed?: unknown}} [context]
 */
export function toModelFields(spec, context = {}) {
  const modality = resolveModality(spec, context);
  const reasoning = resolveReasoning(spec, context);

  return {
    contextWindow: spec?.contextWindow,
    maxTokens: spec?.maxTokens,
    input: modality.input,
    // 只有「注册表命中」才谈得上「公开信息还支持 X」——启发式/端点分支没有这份依据。
    extraInputs: modality.source === 'registry' ? [...modality.extraInputs] : [],
    reasoningEfforts: reasoning.reasoningEfforts,
    // S4 启发式只给候选，UI 拿它提示用户，**不**当结论写。
    reasoningSuggestion: reasoning.suggestion,
    sources: {
      contextWindow: 'registry',
      maxTokens: 'registry',
      input: modality.source,
      reasoningEfforts: reasoning.source,
    },
    notes: {
      input: modality.extraInputs.length > 0
        ? `公开信息还显示支持 ${modality.extraInputs.join(' / ')} 输入（DSH 只写 text/image，此项仅展示）`
        : undefined,
      reasoningEfforts: reasoning.note,
    },
  };
}
