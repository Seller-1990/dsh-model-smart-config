/**
 * rules/normalize.js — 模型名归一化（纯函数，无 DSH 依赖）
 *
 * 依据 docs/03-inference-rules.md §3.4 与 §3.4.1。
 *
 * 设计要点：
 *   - **不剥离日期/变体后缀** —— 规则正则里的 `(?:[.\-:/[].*)?$` 已经能吃下
 *     后缀，归一化再剥反而会破坏匹配。
 *   - **`raw` 原串与 `normalized` 都保留** —— UI 显示用 `raw`，匹配用 `normalized`。
 *   - **别名只改匹配用名，不改显示名** —— `alias` 字段留痕，便于排查误判。
 */

import { ALIASES } from '../data/model-rules.js';

/**
 * @param {unknown} raw 用户输入或端点返回的模型名
 * @returns {{raw: string, normalized: string, alias: {from: string, to: string} | undefined}}
 */
export function normalizeModelName(raw) {
  if (typeof raw !== 'string') return { raw: '', normalized: '', alias: undefined };

  // 1. 去首尾空白
  const raw2 = raw.trim();

  // 2. 剥离组织前缀 —— 取最后一个 `/` 之后的部分
  //    openai/gpt-4o → gpt-4o；models/gemini-2.5-pro → gemini-2.5-pro
  const slash = raw2.lastIndexOf('/');
  let name = slash === -1 ? raw2 : raw2.slice(slash + 1);

  // 3. 统一分隔符：`.` 与 `_` → `-`（`data/model-rules.js` 的 m() 同步折算）
  name = name.replace(/[._]/g, '-');

  // 4. 折叠连续分隔符
  name = name.replace(/-{2,}/g, '-').replace(/^-|-$/g, '');

  // 5. 别名表（在归一化之后、正则匹配之前）
  let alias;
  for (const [pattern, target] of ALIASES) {
    if (pattern.test(name)) {
      alias = { from: name, to: target };
      name = target;
      break;
    }
  }

  return { raw: raw2, normalized: name, alias };
}
