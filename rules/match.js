/**
 * rules/match.js — 有序正则匹配 + 分层覆盖合并（纯函数，无 DSH 依赖）
 *
 * 依据 docs/03-inference-rules.md §3.3。
 *
 * ⚠️ **数组顺序即优先级** —— 合并是「后者覆盖前者」，`MODEL_RULES` 必须
 * 按「从泛到具体」排列。把具体型号放在家族规则之前，它会被家族规则覆盖掉。
 */

import { BASE_RULE, MODEL_RULES, SITE_RULES } from '../data/model-rules.js';
import { normalizeModelName } from './normalize.js';

/** 参与分层合并的字段（顺序无关，都是整体替换）。 */
const MERGEABLE = [
  'displayName',
  'vendor',
  'contextWindow',
  'maxTokens',
  'input',
  'extraInputs',
  'reasoningEfforts',
  'source',
  'note',
];

/** 取所有命中的规则下标（按表内顺序）。 */
export function matchRules(normalizedName) {
  const hits = [];
  MODEL_RULES.forEach((rule, index) => {
    if (rule.match.test(normalizedName)) hits.push(index);
  });
  return hits;
}

/**
 * 三级推断的第一、二级：模型识别 + 规格取值。
 *
 * 合并顺序：`BASE_RULE ← MODEL_RULES(命中的，按表内顺序) ← SITE_RULES`。
 *
 * @param {string} rawName 用户输入 / 端点返回的原始模型名
 * @param {{baseURL?: string, api?: string}} [options] 站点级覆盖的匹配上下文
 */
export function resolveSpec(rawName, options = {}) {
  const { baseURL, api } = options;
  const { raw, normalized, alias } = normalizeModelName(rawName);

  const matchedRules = matchRules(normalized);

  /** @type {Record<string, unknown>} */
  const spec = { ...BASE_RULE, fieldSources: {}, fieldEvidence: {} };
  function applyRule(rule, origin) {
    for (const key of MERGEABLE) {
      if (rule[key] !== undefined) {
        spec[key] = rule[key];
        spec.fieldSources[key] = typeof rule.source === 'string' && rule.source.length > 0 ? 'registry' : 'unknown';
        spec.fieldEvidence[key] = { ...origin, source: rule.source };
      }
    }
    // 省略仍表示继承；明确未知则清除，避免旧世代容量冒充新型号规格。
    for (const key of rule.unknownFields ?? []) {
      if (!MERGEABLE.includes(key)) continue;
      spec[key] = undefined;
      spec.fieldSources[key] = 'unknown';
      spec.fieldEvidence[key] = { ...origin, source: rule.source, unknown: true };
    }
  }
  for (const index of matchedRules) {
    applyRule(MODEL_RULES[index], { rule: index });
  }

  const matchedSiteRules = [];
  SITE_RULES.forEach((rule, index) => {
    if (rule.baseURLMatch !== undefined && !(typeof baseURL === 'string' && rule.baseURLMatch.test(baseURL))) return;
    if (rule.apiTypeMatch !== undefined && rule.apiTypeMatch !== api) return;
    applyRule(rule, { siteRule: index });
    matchedSiteRules.push(index);
  });

  // confidence：命中至少一条「非家族兜底」规则算 exact，只命中家族兜底算 pattern
  const confidence =
    matchedRules.length === 0
      ? 'none'
      : matchedRules.some((index) => MODEL_RULES[index].generic !== true)
        ? 'exact'
        : 'pattern';

  return { raw, normalized, alias, spec, matchedRules, matchedSiteRules, confidence };
}
