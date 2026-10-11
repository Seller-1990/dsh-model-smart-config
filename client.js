/**
 * dsh-model-smart-config — Client 半（行内识别 + 显式匹配 + 自定义草稿）。
 *
 * ## 槽位与身份
 *
 * 挂在官方「模型」设置页的 `settings.models.provider-card` 槽位上。
 * 该槽位是 **keyed** 槽，key 由官方按 `row.entry.settingsNs` 派发；而
 * `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` 里 `settingsNs` 取的是
 * **profile 条目 id**（`const settingsNs = ctx.fiber.entry?.options.id ?? NS;`，
 * NS = `"llm-pi-ai"`），所以**所有 pi-ai 第三方 provider 共用同一个 key**。
 * → 本插件只注册一条 `key: 'llm-pi-ai'` 的条目，它会为每个 provider 行渲染；
 *   组件从 props 里的 `provider` 知道自己正渲染哪一行。
 * 新建自定义 API 尚无 provider-card：另注册 `settings.models.footer` list 条目，
 * 仅增强该槽位所属 section 内唯一可见的 custom-panel，不观察 document/body。
 * 草稿按模型 ID 识别，不虚构已保存 provider，不读取密码，也不提供真实探测。
 *
 * ## 显示位置（v0.3.0 起：行内）
 *
 * v0.2.0 把整块面板挂进「自定义设置」`<details>` 里，结果是**面板与官方模型列表
 * 上下堆叠**，每个 API 白白多出一整块纵向区域。用户要求改成**行内**：
 * 匹配结果与按键直接落在**每条原始模型行**上。
 *
 * 官方行结构（实读 `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`）：
 *
 *   `div.<css.modelEntry>`            ← `.zGbnIq_modelEntry`，外围描边盒
 *     ├─ `div.<css.modelRow>`         ← 4 列 grid：minmax(0,1.4fr) minmax(0,1fr) auto auto
 *     │    ① input(id) ② input(name)
 *     │    ③ ModelImageInputToggle（compact）→ `label.dshModelModalityToggleCompact`
 *     │    ④ 展开按钮 `button[aria-expanded]` ⑤ 删除按钮
 *     └─ `div.<css.modelAdvanced>`    ← 仅展开后存在：上下文 / 最大输出 / 思考等级
 *
 * 于是插件这一版**不再自己画一套输入框**，只做三件事：
 *   ① 往每一行的 `div.modelRow` 末尾追加一个自己的格子；
 *   ② 把它显式撑成 `子节点数` 条轨道，这样多出来的格子**不换行**、行高不变；
 *   ③ 用 `createPortal` 把「状态徽标 + 应用 + 测试」渲染进去。
 *
 * ### 唯一稳定的行锚点
 *
 * 行容器、输入框的类名都是 **CSS-module 构建哈希**（`zGbnIq_*`，随 DSH 构建变），
 * 不能硬编码。可靠定位用的是 `data-plugin-css` 注入的**无哈希字面类名**
 * `label.dshModelModalityToggleCompact` —— 它在全文件只由 `ModelListEditor`
 * 的模型行渲染，**每行恰好一个**，且是 `div.modelRow` 的直接子节点。
 * 于是 `row = toggle.parentElement`，与语言、构建哈希都无关。
 *
 * ### 为什么不直接 `settings.mutate`（v0.2.0 的隐患）
 *
 * 官方 `ProviderEditor` 把编辑留在 **draft** 里，只在用户点「保存」时才发
 * `settings.mutate(ns, pathOps, expectedRevision)`（头注释原文：「Every edit travels
 * as path ops against the STORED section」）。插件若自己 mutate，会顶掉 revision，
 * 官方随后保存必然撞 `settings/conflict`。
 * 所以本版的「应用」**把结果填进官方自己的控件**（受控 input 走原生 value setter +
 * `input` 事件；复选框走 `.click()`），由官方 `patch(index, …)` 更新 draft，
 * 用户再按官方「保存」持久化。
 *
 * ## 新增模型自动匹配
 *
 * 「新增模型」在官方只有两条写入路径（实读）：
 *   ① `CustomProviderCard.addModel` → `setModels([...models, { id: '' }])`
 *   ② `ProviderEditor.addModel`     → `schema.setPath(draft, ['models'], [...models, { id: '' }])`
 * 外加「获取 model」采纳候选时批量追加。
 * 两条都**只 push 一个空 id 行，不做任何探测** —— 这正是可挂钩子。
 *
 * 本插件的钩子：MutationObserver 盯住 `<details>` 的 `childList`（新行出现）
 * 与 `input` 事件（用户在空行里敲完 id，450ms 防抖）：
 *   · 首次同步时已存在的 id 记入 baseline —— **不自动改写用户原有的模型**；
 *   · 之后出现的 id（新增行 / 采纳候选 / 空行敲完）→ 自动 infer 一次，仅更新识别徽标；
 *   · 只有用户点击「智能匹配」才写官方草稿；识别不到或证据不足时不填，并解释原因。
 *
 * 三条硬约束（来自官方 skill 的 practices/ui-plugin）：
 *   ① 只用主题 token `--dsw-alias-*`，不 require 任何 Harness Client 包；
 *   ② factory 无副作用，注册与样式注入放 `apply` 内用 `ctx.effect` 并返回清理；
 *   ③ 不写 `document.body`、不读别的插件的 DOM（只操作自己所在行卡片内的模型行）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-smart-config',
  factory(require) {
    'use strict';

    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var h = React.createElement;

    /**
     * `react-dom` 用来把行内控件 portal 进官方模型行。
     * 它在 web shell 的种子模块表（`staticModules`）里，正常情况下一定拿得到；
     * 这里仍然包一层 try —— 万一某个宿主没种它，插件要能降级而不是整个崩掉
     * （官方 renderer 对「slot 条目抛错」的处理是**清空该 slot 的全部条目**）。
     */
    var ReactDOM = null;
    try {
      ReactDOM = require('react-dom');
    } catch (error) {
      ReactDOM = null;
    }

    /** Client locale 命名空间。 */
    var NS = 'model-smart-config';
    /** 官方「模型」页给第三方留的 provider 卡片槽（keyed）。 */
    var PROVIDER_SLOT = 'settings.models.provider-card';
    /** pi-ai 适配器的 settings 命名空间 —— 所有第三方 provider 共用。 */
    var PI_AI_NS = 'llm-pi-ai';
    /** 本插件在 profile 里的条目 id，也就是它自己配置的 settings 命名空间。 */
    var ENTRY_ID = 'model-smart-config';

    /** 探测时可试的档位（`off` 不入列表，它是「不发推理参数」）。 */
    var PROBE_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

    /** 官方模型目录折叠区：`<details open>`。 */
    var CATALOG_DETAILS_SELECTOR = 'details';

    /**
     * **行锚点**：官方 `ModelImageInputToggle` 的 compact 形态类名。
     * 来自 `data-plugin-css` 注入，**无构建哈希**；全文件只有 `ModelListEditor`
     * 的模型行用 compact 形态，且每行恰好一个，是 `div.modelRow` 的直接子节点。
     */
    var ROW_TOGGLE_SELECTOR = 'label.dshModelModalityToggleCompact';
    /** 官方「思考等级」字段容器（同样是无哈希字面类名）—— 用来认出 `modelAdvanced`。 */
    var REASONING_SELECTOR = '.dshModelReasoningField';
    /** 用户在空行里敲完 id 后的防抖窗口。 */
    var AUTO_DEBOUNCE_MS = 450;

    /** 本插件注入的样式表 id（`data-plugin-css`）。 */
    var STYLE_ID = 'model-smart-config/inline';

    /**
     * 行内控件样式。只用主题 token，不引入任何官方私有类名。
     * `grid-column` 交给行容器的显式轨道数决定，这里只保证「不撑高、不换行」。
     */
    var CSS_TEXT = [
      /*
       * ⚠️ **这一格的横向预算是硬约束**（v0.3.2 立规，起因是用户报障：
       * 点「智能匹配」后，行内追加的状态文案把官方 id 输入框从 97px 挤到 **20px**，
       * 模型名整条看不见，同时格子自身溢出整行 16px）。
       *
       * 病根：官方行是 grid，本插件占最后一格；该格是 `auto` 轨道，其**最小尺寸
       * 等于内容的 min-content**。任何 `white-space:nowrap` 的长文案都会把
       * min-content 顶到自己的长度，于是两条 `…fr` 轨道被压成 0。
       *
       * 所以本行的四条规矩（改动前请先读这条注释）：
       *   ① **长文案一律进 `.dshMscDetail`**（绝对定位 = 0 宽度），行内只留短词；
       *   ② 每个行内元素都有 `max-width` 硬上限 + 省略号，长度不受控的文本不许上桌；
       *   ③ 状态用**记号/色调**表达（0–1 个字宽），说明文字放 tooltip；
       *   ④ 元素数量守住 3 个（徽标 + 主键 + 可选图标键），不再往回加。
       */
      '.dshMscCell{display:inline-flex;align-items:center;gap:3px;min-width:0;max-width:100%;position:relative}',
      '.dshMscBadge{display:inline-flex;align-items:center;height:24px;padding:0 6px;border-radius:var(--dsw-radius-sm,4px);',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);',
      'font-size:11px;line-height:16px;white-space:nowrap;max-width:64px;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}',
      '.dshMscBadgeSuccess{color:var(--dsw-alias-state-success-primary)}',
      '.dshMscBadgeInfo{color:var(--dsw-alias-label-secondary)}',
      '.dshMscBadgeWarn{color:var(--dsw-alias-state-warn-label)}',
      '.dshMscMark{margin-left:1px;font-size:11px;line-height:16px;white-space:nowrap}',
      '.dshMscMarkOk{color:var(--dsw-alias-state-success-primary)}',
      '.dshMscMarkEdit{color:var(--dsw-alias-label-tertiary)}',
      '.dshMscBtn{box-sizing:border-box;height:24px;padding:0 7px;border-radius:var(--dsw-radius-sm,4px);',
      'border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary);',
      'font:inherit;font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer;flex:0 0 auto}',
      '.dshMscBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshMscBtn:disabled{opacity:.45;cursor:default}',
      '.dshMscBtnPrimary{border-color:transparent;background:var(--dsw-alias-brand-primary);',
      'color:var(--dsw-alias-label-primary-foreground,#fff)}',
      // 「安静」形态：这一行当下没有可填的东西时，不必抢视觉重量
      //（一屏 6 行 × 一个实心品牌色按钮 = 噪声，反而盖过模型名）。
      '.dshMscBtnQuiet{background:0 0;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      // 图标按钮：「测试」压成 26×24 的图标位 —— 与官方行自带的展开/删除图标键同一套语法，
      // 同时把省下的 ~12px 还给官方 id 输入框。文字说明走 `title` / `aria-label`。
      '.dshMscBtnIcon{width:26px;padding:0;display:inline-flex;align-items:center;justify-content:center}',
      // 悬浮弹层：**绝对定位 = 0 宽度**，是长文案唯一的去处（①）。
      '.dshMscDetail{position:absolute;top:calc(100% + 5px);right:0;z-index:12;display:none;box-sizing:border-box;',
      'width:max-content;max-width:min(320px,72vw);padding:6px 8px;border-radius:6px;background:var(--dsw-alias-label-primary);',
      'color:var(--dsw-alias-label-primary-foreground);font-size:11px;line-height:16px;white-space:pre-line;pointer-events:none;',
      'text-align:left}',
      '.dshMscCell:hover .dshMscDetail,.dshMscCell:focus-within .dshMscDetail{display:block}',
    ].join('');

    /* ---------------------------------------------------------------- *
     * 文案
     * ---------------------------------------------------------------- */

    var zh = {
      title: '模型智能配置',
      loading: '识别中…',
      unrecognized: '未识别',
      confidenceExact: '精确命中',
      confidencePattern: '家族命中',
      confidenceNone: '未识别',
      failed: '识别失败',
      contextWindow: '上下文窗口',
      maxTokens: '最大输出',
      modality: '输入模态',
      reasoning: '思考等级',
      reasoningNone: '非推理模型',
      sourceRegistry: '内置规则表',
      sourceAuthoritative: '官方目录',
      sourceEndpoint: '端点元数据',
      sourceProbe: '实测',
      sourceHeuristic: '名称推断（仅供参考）',
      sourceUnknown: '未确定',
      notSet: '未设置',
      textOnly: '仅文本',
      withImage: '文本 + 图像',
      testing: '测试中…',
      probe: '测试',
      probeReasoningYes: '观察到思考输出',
      probeReasoningNo: '未观察到思考输出（不等于不支持）',
      probeAccepted: '接受的档位：',
      probeRejected: '拒绝的档位：',
      probeNone: '没有档位被接受',
      extraInputs: '公开信息还支持：',
      extraInputsEnd: '（仅展示，不写入）',
      suggestionPrefix: '名称提示疑似推理模型，建议档位：',
      suggestionEnd: '（需你确认，未自动写入）',
      warningPrefix: '注意：',
      inlineApply: '应用',
      inlineApplied: '已填入官方表单',
      inlineNothing: '无建议可写',
      inlineAutoDone: '新增模型已自动匹配并填入',
      inlineAutoPartial: '部分未填入：',
      inlineNoFields: '没找到官方「上下文/最大输出/思考等级」字段',
      inlineNoModality: '没找到官方图像开关',
      inlineModalityConflict: '已保留已有视觉声明；如需采用建议，请手动确认视觉开关',
      inlineModalityDisabled: '视觉开关不可编辑，未填入',
      inlineModalityRejected: '视觉开关未接受更改，未标记成功',
      inlineModalityAlready: '视觉开关已符合建议，无需改动',
      inlineModalityOverridden: '视觉开关已按规则表更新（覆盖了配置里的声明）',
      inlineModalityFromCandidate: '视觉开关按候选建议更新（规则表未给出确定结论）',
      inlineModalityCandidate: '视觉开关未改动：规则表只给出候选，需你手动确认',
      inlineModalityNoSuggestion: '视觉开关未改动：规则表没有视觉结论',
      inlineModalityConfigOff: '视觉开关未改动：自动填入视觉已关闭',
      inlineRowInactive: '该行已不在当前编辑区；请展开该提供商的「自定义」后再点智能匹配',
      inlineRowChanged: '该行在匹配过程中发生变化，未填入；请重新点击智能匹配',
      inlineFieldDisabled: '字段不可编辑，未填入',
      inlineFieldRejected: '字段未接受更改，未标记成功',
      inlineNeedSave: '填入后按官方「保存」才生效',
      inlineLoadingSettings: '正在读取配置，确认已有声明后再匹配…',
      inlineSettingsFailed: '配置读取失败，未填入；请再次点击智能匹配重试',
      inlineSettingsDisabled: '智能配置已禁用，未填入',
      inlineProbeHint: '测试会向端点发真实请求（每次约 16 token），只在点击时发生。',
      inlineMatch: '智能匹配',
      inlineMatching: '匹配中…',
      inlineMatched: '已匹配并填入，可直接修改',
      inlineEmpty: '待填 ID',
      inlineNeedId: '先填写模型 ID，再点「智能匹配」',
      inlineEdited: '已按你的修改保留，不再自动覆盖',
      inlineMatchHint: '点击后重新识别该模型并把建议填入官方字段（可再手动修改）',
    };

    var en = {
      title: 'Model Smart Config',
      loading: 'Detecting…',
      unrecognized: 'Unrecognised',
      confidenceExact: 'exact match',
      confidencePattern: 'family match',
      confidenceNone: 'no match',
      failed: 'Detection failed',
      contextWindow: 'Context window',
      maxTokens: 'Max output',
      modality: 'Input modalities',
      reasoning: 'Reasoning levels',
      reasoningNone: 'non-reasoning model',
      sourceRegistry: 'built-in rules',
      sourceAuthoritative: 'official catalog',
      sourceEndpoint: 'endpoint metadata',
      sourceProbe: 'measured',
      sourceHeuristic: 'name heuristic (informational)',
      sourceUnknown: 'unknown',
      notSet: 'not set',
      textOnly: 'text only',
      withImage: 'text + image',
      testing: 'Testing…',
      probe: 'Test',
      probeReasoningYes: 'reasoning output observed',
      probeReasoningNo: 'no reasoning output observed (not proof of absence)',
      probeAccepted: 'Accepted levels: ',
      probeRejected: 'Rejected levels: ',
      probeNone: 'no level was accepted',
      extraInputs: 'public info also declares: ',
      extraInputsEnd: ' (shown only, not written)',
      suggestionPrefix: 'The name suggests a reasoning model; candidate levels: ',
      suggestionEnd: ' (needs your confirmation, not auto-written)',
      warningPrefix: 'Note: ',
      inlineApply: 'Apply',
      inlineApplied: 'Filled into the official form',
      inlineNothing: 'Nothing to write',
      inlineAutoDone: 'New model auto-matched and filled in',
      inlineAutoPartial: 'Not filled: ',
      inlineNoFields: 'official context / max-output / reasoning fields not found',
      inlineNoModality: 'official image toggle not found',
      inlineModalityConflict: 'existing vision choice kept; confirm the vision checkbox manually to adopt the suggestion',
      inlineModalityDisabled: 'vision control is disabled; not filled',
      inlineModalityRejected: 'vision control did not accept the change; not marked successful',
      inlineModalityAlready: 'vision checkbox already matched the suggestion',
      inlineModalityOverridden: 'vision checkbox updated from the rules table (your saved declaration was overridden)',
      inlineModalityFromCandidate: 'vision checkbox updated from a candidate suggestion (no definite answer in the rules table)',
      inlineModalityCandidate: 'vision checkbox unchanged: the rules table only offers a candidate',
      inlineModalityNoSuggestion: 'vision checkbox unchanged: the rules table has no vision answer',
      inlineModalityConfigOff: 'vision checkbox unchanged: automatic vision fill is off',
      inlineRowInactive: 'this row is no longer in the editing area; expand the provider "Customized" section and match again',
      inlineRowChanged: 'this row changed while matching; nothing was filled — match again',
      inlineFieldDisabled: 'field is not editable; not filled',
      inlineFieldRejected: 'field did not accept the change; not marked successful',
      inlineNeedSave: 'press the official Save to persist',
      inlineLoadingSettings: 'Reading settings before applying suggestions…',
      inlineSettingsFailed: 'Could not read settings; nothing was filled. Press Smart match to retry.',
      inlineSettingsDisabled: 'Smart configuration is disabled; nothing was filled.',
      inlineProbeHint: 'A probe sends real requests to your endpoint (about 16 tokens each) and only runs when you click.',
      inlineMatch: 'Smart match',
      inlineMatching: 'Matching…',
      inlineMatched: 'Matched and filled — you can edit it',
      inlineEmpty: 'ID pending',
      inlineNeedId: 'enter the model ID, then press Smart match',
      inlineEdited: 'your edit is kept, no further auto-overwrite',
      inlineMatchHint: 'Click to re-detect this model and fill the official fields (still editable afterwards)',
    };

    /* ---------------------------------------------------------------- *
     * 小工具
     * ---------------------------------------------------------------- */

    /**
     * 官方容量词表：K = 1000、M = 1000000（`CAPACITY_SCALE`）。
     * 输出必须能被官方 `parseCapacity` 吃回原数：『不是整千的就不缩写成 K』，
     * 例如 1048576 直接写 `1048576`，而 128000 写 `128K`。
     */
    function formatCapacity(value) {
      if (!Number.isInteger(value) || value <= 0) return String(value);
      if (value % 1000000 === 0) return String(value / 1000000) + 'M';
      if (value % 1000 === 0) return String(value / 1000) + 'K';
      return String(value);
    }

    /**
     * 从 provider 路由派生凭据引用名。
     * 与官方 `deriveKeyRef` 同规则：大写 + 非字母数字连续段折成 `_`；
     * 引用名是 POSIX shell 标识符，不能以数字开头。
     */
    function deriveKeyRef(route) {
      var name = String(route).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
      if (/^[0-9]/.test(name)) name = '_' + name;
      return name + '_API_KEY';
    }

    function confidenceLabel(t, confidence) {
      if (confidence === 'catalog') return t('sourceAuthoritative');
      if (confidence === 'exact') return t('confidenceExact');
      if (confidence === 'pattern') return t('confidencePattern');
      return t('confidenceNone');
    }

    function confidenceTone(confidence) {
      if (confidence === 'exact' || confidence === 'catalog') return 'Success';
      if (confidence === 'pattern') return 'Info';
      return 'Warn';
    }

    function sourceLabel(t, source) {
      switch (source) {
        case 'registry':
          return t('sourceRegistry');
        case 'authoritative':
          return t('sourceAuthoritative');
        case 'endpoint':
          return t('sourceEndpoint');
        case 'probe':
          return t('sourceProbe');
        case 'heuristic':
          return t('sourceHeuristic');
        default:
          return t('sourceUnknown');
      }
    }

    /**
     * 只有「有实据」的来源才允许自动写入配置。
     *
     * ⚠️ `heuristic`（按名字猜的）**必须排除**：docs/03 §4 ③ / §7 要求名称启发式
     * 只作候选、在 UI 上让用户确认，不得静默写库。`registry`（内置表，带官方文档
     * URL）、`authoritative`（官方目录）、`endpoint`（端点自报）才是可写入的依据。
     */
    function isWritableSource(source) {
      return source === 'registry' || source === 'authoritative' || source === 'endpoint';
    }

    function modalityLabel(t, input) {
      if (!Array.isArray(input)) return t('notSet');
      return input.indexOf('image') >= 0 ? t('withImage') : t('textOnly');
    }

    /** 非 off 档位拼成 `low / high`；`false` 单独说成「非推理模型」。 */
    function reasoningText(t, efforts) {
      if (efforts === false) return t('reasoningNone');
      if (!efforts || typeof efforts !== 'object') return t('notSet');
      var levels = Object.keys(efforts).filter(function (key) {
        return key !== 'off';
      });
      return levels.length > 0 ? levels.join(' / ') : t('notSet');
    }

    /** 未识别时保持 undefined —— **不静默写错**。 */
    function pick() {
      for (var i = 0; i < arguments.length; i += 1) {
        if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
      }
      return undefined;
    }

    /** 至少有一项**有实据**（registry/authoritative/endpoint）才算「可应用」。 */
    function hasWritable(spec) {
      if (!spec) return false;
      var sources = spec.sources || {};
      return (
        (spec.contextWindow !== undefined && isWritableSource(sources.contextWindow)) ||
        (spec.maxTokens !== undefined && isWritableSource(sources.maxTokens)) ||
        (spec.input !== undefined && isWritableSource(sources.input)) ||
        (spec.reasoningEfforts !== undefined && isWritableSource(sources.reasoningEfforts))
      );
    }

    /**
     * 是否**真的认出了**这个模型（而不是只吃到兜底规则）。
     *
     * 原因：`BASE_RULE` 恒带 `contextWindow: 262144` / `maxTokens: 32768`，且
     * `toModelFields` 把这两个字段的来源一律标成 `registry` —— 于是**未识别**的模型
     * 也会 `hasWritable === true`，只是数值是兜底默认。
     *
     * 把一个猜来的容量写进用户配置，就是 docs/03 §7 明令禁止的「静默写错值」。
     */
    function isRecognised(spec) {
      return !!spec && spec.confidence !== 'none';
    }

    /**
     * 「应用」闸门 = 真的认出来了 **且** 至少一项有实据。
     *
     * 与自动填充同一个判据：未识别时按钮置灰（提示「无建议可写」），
     * 而不是替用户写一个数字。
     */
    function canApplySpec(spec) {
      return isRecognised(spec) && hasWritable(spec);
    }

    /* ---------------------------------------------------------------- *
     * 与 Host 半 / 官方 Remote 的通道
     * ---------------------------------------------------------------- */

    function createApi(ctx) {
      var remote = ctx.remote;
      var connection = ctx.get('connection');

      /** 调本插件 Host 半经 `ctx.typert.register` 发布的端点。 */
      function call(method, args) {
        return connection.rpc.call('/api', 'msc/' + method, { args: args }).then(function (response) {
          if (!response || response.ok !== true) {
            var message = response && response.error && response.error.message ? response.error.message : 'rpc failed';
            throw new Error(message);
          }
          return response.value;
        });
      }

      /** 读 `llm-pi-ai` 命名空间里这个 provider 的已存档案。 */
      function readProvider(route) {
        return remote.settings.describe().then(function (response) {
          if (!response || response.ok !== true) {
            throw new Error(response && response.error ? response.error.message : 'settings.describe failed');
          }
          var namespaces = response.value && response.value.namespaces ? response.value.namespaces : [];
          var view = null;
          for (var i = 0; i < namespaces.length; i += 1) {
            if (namespaces[i].ns === PI_AI_NS) view = namespaces[i];
          }
          var value = (view && view.value) || {};
          var providers = value.providers || {};
          var profile = providers[route] || {};
          return {
            profile: profile,
            models: Array.isArray(profile.models) ? profile.models : [],
            revision: view ? view.revision : undefined,
          };
        });
      }

      /** 读本插件自己的配置（Host 半 `Config` 的 volatile 字段）。 */
      function readConfig() {
        return remote.settings.describe().then(function (response) {
          if (!response || response.ok !== true) throw new Error('settings.describe failed');
          var namespaces = response.value && response.value.namespaces ? response.value.namespaces : [];
          for (var i = 0; i < namespaces.length; i += 1) {
            if (namespaces[i].ns === ENTRY_ID) return namespaces[i].value || {};
          }
          return {};
        });
      }

      return {
        infer: function (request) {
          return call('infer', { request: request });
        },
        authoritative: function (request) {
          return call('authoritative', { request: request });
        },
        probe: function (request) {
          return call('probe', { request: request });
        },
        readProvider: readProvider,
        readConfig: readConfig,
      };
    }

    /**
     * 按字段合并有来源的能力：可信内置模态优先；官方 catalog 补充其它字段。
     * 已保存的 resolved/user override 不是独立能力证据。
     *
     * ⚠️ **每项的 `sources` 必须逐字段透传 Host 半的判定**，不能按「有没有官方
     * 目录」一刀切：内置表里 S4 名称启发式给出的模态候选，来源是 `heuristic`
     * 而不是 `registry` —— 一刀切会把「按名字猜的」标成「内置规则表」，
     * 正是「不静默写错值」要防的误导。
     */
    function combine(registry, authoritative) {
      registry = registry || { confidence: 'none', sources: {} };
      // Resolved configuration (and legacy replies without provenance) can
      // contain defaults/user overrides, not independent capability evidence.
      var hasAuth = authoritative && authoritative.found === true && authoritative.source === 'catalog';
      var authCtx = hasAuth ? authoritative.contextWindow : undefined;
      var authMax = hasAuth ? authoritative.defaultMaxTokens : undefined;
      var authInput = hasAuth ? authoritative.inputModalities : undefined;
      var authEfforts = hasAuth ? authoritative.reasoningEfforts : undefined;
      var local = registry.confidence === 'none' ? {} : registry;
      var contextWindow = pick(authCtx, local.contextWindow);
      var maxTokens = pick(authMax, local.maxTokens);
      // Public modality rules take precedence; conflicts with explicit user
      // declarations are handled at the form write boundary, never here.
      var regSources = local.sources || {};
      var localInput = isWritableSource(regSources.input) ? local.input : undefined;
      var input = pick(localInput, authInput, local.input);
      var reasoningEfforts = pick(authEfforts, local.reasoningEfforts);
      var catalogEvidence = authCtx !== undefined || authMax !== undefined || authInput !== undefined || authEfforts !== undefined;

      return {
        vendor: registry.vendor,
        displayName: registry.displayName,
        normalized: registry.normalized,
        alias: registry.alias,
        confidence: registry.confidence === 'none' && catalogEvidence ? 'catalog' : registry.confidence,
        warnings: registry.warnings || [],
        notes: registry.notes || {},
        source: registry.source,
        contextWindow: contextWindow,
        maxTokens: maxTokens,
        input: input,
        // 「公开信息还支持的其它模态」只在注册表命中时才有依据，官方目录分支不共用。
        extraInputs: authInput !== undefined ? [] : registry.extraInputs || [],
        reasoningEfforts: reasoningEfforts,
        // S4 启发式候选：只在没有任何权威结论时才展示，仅提示不写库。
        reasoningSuggestion: authEfforts !== undefined ? undefined : registry.reasoningSuggestion,
        sources: {
          contextWindow: authCtx !== undefined ? 'authoritative' : regSources.contextWindow || 'unknown',
          maxTokens: authMax !== undefined ? 'authoritative' : regSources.maxTokens || 'unknown',
          input: localInput !== undefined ? regSources.input : authInput !== undefined ? 'authoritative' : regSources.input || 'unknown',
          reasoningEfforts: authEfforts !== undefined ? 'authoritative' : regSources.reasoningEfforts || 'unknown',
        },
      };
    }

    /* ---------------------------------------------------------------- *
     * 官方模型行的定位与写入（不依赖任何构建哈希类名）
     * ---------------------------------------------------------------- */

    /**
     * 找到「本卡片」的观察容器 —— 必须是**只包含这一个 API 的编辑器与锚点**的那一层。
     *
     * 官方在 **三处** 派发同一个槽位，DOM 形状并不一致（实读官方源码）：
     *   ① 已保存 provider 行卡：`li.rowCard`，槽位与编辑器 `<details>` 是同一 `<li>` 下的兄弟；
     *   ② 首次运行 setup 卡：`li.setupCard`，形状同上；
     *   ③ 「添加提供商」草稿卡：`div.addBlock > div.addCard > div.addPanel`，**没有 `<li>`**。
     *
     * 取法是「锚点与编辑器的最近公共祖先」：自锚点向上找**第一个内部能查到
     * `<details>` 的祖先**，同时要求该祖先内**只有一个卡片锚点**。
     * 已保存行未进入编辑态时官方根本不渲染 `ProviderEditor`，此刻整棵树里没有
     * `<details>`；这时退回本行 `<li>` 先挂上观察者，等用户点「编辑」后再由 `sync()` 发现。
     */
    function findWatchRoot(anchor) {
      var node = anchor.parentNode;
      var hops = 0;
      while (node && node.nodeType === 1 && hops < 12) {
        if (typeof node.querySelector === 'function' && node.querySelector(CATALOG_DETAILS_SELECTOR) !== null) {
          var anchors = typeof node.querySelectorAll === 'function' ? node.querySelectorAll('[data-msc-anchor]').length : 1;
          if (anchors <= 1) return node;
        }
        node = node.parentNode;
        hops += 1;
      }
      if (typeof anchor.closest === 'function') {
        var row = anchor.closest('li');
        if (row) return row;
      }
      return anchor.parentNode;
    }

    /** Footer is a real host-owned slot; never climb into document/body. */
    function findDraftSection(anchor) {
      var slot = anchor && anchor.closest('[data-slot="settings.models.footer"]');
      var section = slot && slot.parentElement;
      if (!section || section.tagName === 'BODY' || section.tagName === 'HTML') return null;
      return section;
    }

    /** Fail closed if the host shape is ambiguous or the custom mode is hidden. */
    function findCustomDraftRoot(section) {
      if (!section || !section.isConnected) return null;
      var panels = section.querySelectorAll('[id$="-custom-panel"]');
      var found = null;
      for (var i = 0; i < panels.length; i += 1) {
        var panel = panels[i];
        var addCard = panel.parentElement;
        var addBlock = addCard && addCard.parentElement;
        // Actual host: section > addBlock > addCard > custom-panel.
        if (!addBlock || addBlock.parentElement !== section || panel.closest('[hidden]')) continue;
        if (found) return null;
        found = panel;
      }
      return found;
    }

    /** Observe only our section; row work is delegated to the one live draft. */
    function CustomDraftSmartConfig(props) {
      var anchorRef = React.useRef(null);
      var state = React.useState(null);
      var current = state[0];
      var setCurrent = state[1];
      React.useEffect(function () {
        var section = findDraftSection(anchorRef.current);
        var Observer = typeof MutationObserver === 'function' ? MutationObserver : null;
        if (!section || !Observer) return undefined;
        var disposed = false;
        var generation = 0;
        function syncDraft() {
          if (disposed) return;
          var root = findCustomDraftRoot(section);
          setCurrent(function (previous) {
            if (previous && previous.root === root) return previous;
            if (!previous && !root) return previous;
            generation += 1;
            return root ? { root: root, section: section, generation: generation } : null;
          });
        }
        var observer = new Observer(syncDraft);
        observer.observe(section, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
        syncDraft();
        return function () { disposed = true; observer.disconnect(); };
      }, []);
      return h(React.Fragment, null,
        h('span', { ref: anchorRef, 'data-msc-draft-anchor': '', style: { display: 'none' } }),
        current ? h(ModelSmartConfigInline, {
          key: current.generation, api: props.api, t: props.t,
          draftRoot: current.root, draftSection: current.section,
        }) : null);
    }

    /** 行容器（`div.modelRow`）由官方行锚点反查：compact toggle 的直接父节点。 */
    function findRowElements(root) {
      if (!root || typeof root.querySelectorAll !== 'function') return [];
      var toggles = root.querySelectorAll(ROW_TOGGLE_SELECTOR);
      var rows = [];
      for (var i = 0; i < toggles.length; i += 1) {
        var row = toggles[i].parentElement;
        if (row && rows.indexOf(row) < 0) rows.push(row);
      }
      return rows;
    }

    /** 行里的 id 输入框 —— 官方 JSX 顺序里第一个 `type="text"` 就是它。 */
    function readIdInput(rowEl) {
      var inputs = rowEl.querySelectorAll('input[type="text"]');
      return inputs.length > 0 ? inputs[0] : null;
    }

    function readRowId(rowEl) {
      var input = readIdInput(rowEl);
      return input ? String(input.value || '').trim() : '';
    }

    /**
     * 行所在的「外围盒」里的高级区（上下文 / 最大输出 / 思考等级）。
     * 形状：`div.modelEntry > [div.modelRow, div.modelAdvanced?]`。
     * 用无哈希字面类名 `.dshModelReasoningField` 认出它，不靠下标。
     */
    function findAdvancedRow(rowEl) {
      var entry = rowEl.parentElement;
      if (!entry) return null;
      var kids = entry.children || [];
      for (var i = 0; i < kids.length; i += 1) {
        var kid = kids[i];
        if (kid === rowEl) continue;
        if (typeof kid.querySelector === 'function' && kid.querySelector(REASONING_SELECTOR) !== null) return kid;
      }
      return null;
    }

    /**
     * 这个控件是不是「匹配结果字段」—— 上下文 / 最大输出 / 思考等级 / 图像开关。
     *
     * 用户在这几处动手改过，就登记手改保护；id / name 框不算（改 id 触发的是
     * 重新识别，不是「对结果的手改」）。
     */
    function isResultField(rowEl, el) {
      if (!rowEl || !el) return false;
      var idInput = readIdInput(rowEl);
      if (idInput === el) return false;
      // 名称框（每行第二个文本框）不算结果字段。
      var texts = rowEl.querySelectorAll('input[type="text"]');
      if (texts.length > 1 && texts[1] === el) return false;
      // 行内图像开关。
      var toggle = rowEl.querySelector(ROW_TOGGLE_SELECTOR);
      if (toggle && toggle.querySelector('input[type="checkbox"]') === el) return true;
      // 高级区三个字段。
      var advanced = findAdvancedRow(rowEl);
      if (advanced && typeof advanced.contains === 'function' && advanced.contains(el)) return true;
      return false;
    }

    /**
     * 官方行是 4 列 grid，而它有 5 个子节点 —— 第 5 个本来就换到第二行。
     * 我们追加第 6 个格子后，把轨道数显式写成「2 条弹性 + 其余 auto」，
     * 保证**所有格子都在同一行**、插件这一格不新增任何纵向高度 ——
     * 这就是「不额外占纵向空间」的关键（实测比官方原样还矮一行）。
     *
     * 同时把原始值记在 `data-msc-grid` 上，卸载时还原，**不留下任何痕迹**。
     */
    function widenRow(rowEl) {
      var count = rowEl.children ? rowEl.children.length : 0;
      if (count < 3) return;
      var tracks = ['minmax(0,1.2fr)', 'minmax(0,1fr)'];
      for (var i = 2; i < count; i += 1) tracks.push('auto');
      if (rowEl.getAttribute('data-msc-grid') === null) {
        rowEl.setAttribute('data-msc-grid', rowEl.style.gridTemplateColumns || '');
      }
      rowEl.style.gridTemplateColumns = tracks.join(' ');
    }

    /** 还原行网格为官方原样（卸载/收起时调用）。 */
    function unwidenRow(rowEl) {
      var original = rowEl.getAttribute('data-msc-grid');
      if (original === null) return;
      rowEl.style.gridTemplateColumns = original;
      rowEl.removeAttribute('data-msc-grid');
    }

    /** 展开本行的高级区（官方展开按钮是行里唯一带 `aria-expanded` 的按钮）。 */
    function expandRow(rowEl) {
      var button = rowEl.querySelector('button[aria-expanded]');
      if (!button) return Promise.resolve(false);
      if (button.getAttribute('aria-expanded') === 'true') return Promise.resolve(true);
      button.click();
      // 官方展开是 React 状态更新，高级区在下一轮渲染才出现。
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(true);
        }, 0);
      });
    }

    /**
     * 写受控 input 的正规姿势：**原生 value setter + `input` 事件**。
     * 直接 `el.value = x` 不触发 React 的 onChange，会被下一次渲染冲掉。
     *
     * ⚠️ 每次插件自己写值时把元素记进 `pluginWrites`，好让事件委托区分
     * 「这是插件写的」与「这是用户手改的」—— 用户手改过的字段绝不再被自动覆盖。
     */
    var pluginWrites = typeof WeakSet === 'function' ? new WeakSet() : null;

    function nativeSetInput(el, text) {
      var doc = el.ownerDocument;
      var win = doc && doc.defaultView ? doc.defaultView : typeof window !== 'undefined' ? window : null;
      var proto = win && win.HTMLInputElement ? win.HTMLInputElement.prototype : null;
      var descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, text);
      else el.value = text;
      if (pluginWrites) pluginWrites.add(el);
      try {
        if (win && typeof win.Event === 'function') el.dispatchEvent(new win.Event('input', { bubbles: true }));
      } finally {
        if (pluginWrites) pluginWrites.delete(el);
      }
    }

    /** 插件自己点复选框时也要打标，避免被误当成用户手改。 */
    function clickCheckbox(box) {
      if (pluginWrites) pluginWrites.add(box);
      try {
        box.click();
      } finally {
        if (pluginWrites) pluginWrites.delete(box);
      }
    }

    /**
     * 把「填值结果」翻译成一句用户能看懂的话。
     *
     * 失败必须说出来 —— 点了键却默默什么都不发生，正是用户报的「没反应」。
     */
    /**
     * 视觉开关这次到底发生了什么 —— 无论成功还是没动，都要说出来。
     *
     * 用户报的「点了智能匹配，视觉勾选框没反应」正是这一段缺失导致的：开关
     * 已经是对的、或规则表根本没有视觉结论时，以前一个字都不提示，界面看起来
     * 和「功能坏了」完全一样。
     */
    function modalityNote(t, outcome) {
      var state = outcome.modality;
      if (state === 'already') return t('inlineModalityAlready');
      if (state === 'overridden-declared') return t('inlineModalityOverridden');
      if (state === 'applied-candidate') return t('inlineModalityFromCandidate');
      if (state === 'no-suggestion') return t('inlineModalityNoSuggestion');
      if (state === 'config-off') return t('inlineModalityConfigOff');
      if (state === 'kept-manual' || state === 'kept-declared') return '';
      if (typeof state === 'string' && state.indexOf('candidate:') === 0) return t('inlineModalityCandidate');
      return '';
    }

    function outcomeNote(t, outcome, doneKey) {
      var extra = modalityNote(t, outcome);
      function withExtra(text) { return extra ? text + ' · ' + extra : text; }
      if (outcome.problems.length > 0) return withExtra(t('inlineAutoPartial') + outcome.problems.join('；'));
      if (outcome.touched.length > 0 && outcome.applied.length === 0) return withExtra(t('inlineEdited'));
      if (outcome.touched.length > 0) {
        return withExtra(t(doneKey) + ' · ' + t('inlineEdited') + '（' + outcome.touched.join('、') + '）');
      }
      return withExtra(t(doneKey));
    }

    /**
     * 把匹配结果**填进官方自己的控件**（不直接写 settings，避免顶掉官方 draft）。
     *
     * 三处写点：
     *   ① 行内图像开关 —— 复选框，`checked !== 目标` 时 `.click()`；
     *   ② 高级区上下文 / 最大输出 —— 受控文本，走 `nativeSetInput`；
     *   ③ 高级区思考等级 —— 官方是**逗号分隔文本**，只填非 `off` 档位
     *      （官方对新档位做恒等映射，把 `off` 填进去会变成 `{off:'off'}`，
     *       被 pi-ai 判为非法；而省略 `off` 与 `{off:null}` 解析结果完全等价）。
     *
     * `reasoningEfforts === false`（非推理）时把思考字段清空 —— 官方控件表达不了
     * 字面 `false`，清空等于「继承目录能力」，这是该控件能给的最接近语义。
     *
     * 返回 `{applied, problems}`：填入成功的字段名，以及**没能填入的原因** ——
     * 失败必须说出来，不能静默当成功。
     */
    function savedModelInput(profile, id) {
      var models = profile && Array.isArray(profile.models) ? profile.models : [];
      var model = models.find(function (entry) { return entry.id === id; });
      var override = profile && profile.modelOverrides ? profile.modelOverrides[id] : undefined;
      var declaration = model || override;
      return declaration && Array.isArray(declaration.input) && declaration.input.length > 0 ? declaration.input : undefined;
    }

    function fillModality(rowEl, spec, config, t, options, outcome) {
      if (options && options.isCurrent && !options.isCurrent()) return Promise.resolve();
      if (config.autoApplyModality === false) { outcome.modality = 'config-off'; return Promise.resolve(); }
      if (!Array.isArray(spec.input)) { outcome.modality = 'no-suggestion'; return Promise.resolve(); }
      var source = (spec.sources || {}).input;
      // 显式点击「智能匹配」= 用户要求按规则表落地，此时候选来源也允许写入（会明确告知）。
      var force = options && options.force === true;
      var writable = isWritableSource(source);
      if (!writable && !force) { outcome.modality = 'candidate:' + source; return Promise.resolve(); }
      var toggle = rowEl.querySelector(ROW_TOGGLE_SELECTOR);
      var box = toggle ? toggle.querySelector('input[type="checkbox"]') : null;
      if (!box) { outcome.problems.push(t('inlineNoModality')); outcome.modality = 'no-toggle'; return Promise.resolve(); }
      var wantImage = spec.input.indexOf('image') >= 0;
      if (box.checked === wantImage) { outcome.modality = 'already'; return Promise.resolve(); }
      var touched = options && options.touched && options.touched.has(box);
      var declared = options && options.savedInput;
      var declaredDiffers = Array.isArray(declared) && (declared.indexOf('image') >= 0) !== wantImage;
      // 本次会话里用户亲手拨过这个开关 —— 那是最新的人类意图，自动填充永远不覆盖它。
      if (touched) {
        outcome.touched.push('input');
        outcome.problems.push(t('inlineModalityConflict'));
        outcome.modality = 'kept-manual';
        return Promise.resolve();
      }
      // 只有「显式点击」才允许覆盖已保存声明；后台自动匹配不会走到这里。
      if (declaredDiffers && !force) {
        outcome.touched.push('input');
        outcome.problems.push(t('inlineModalityConflict'));
        outcome.modality = 'kept-declared';
        return Promise.resolve();
      }
      if (box.disabled) { outcome.problems.push(t('inlineModalityDisabled')); outcome.modality = 'disabled'; return Promise.resolve(); }
      outcome.modality = declaredDiffers ? 'overridden-declared' : (writable ? 'applied' : 'applied-candidate');
      clickCheckbox(box);
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (!box.isConnected || (options && options.isCurrent && !options.isCurrent())) {
            outcome.modality = 'stale';
            outcome.problems.push(t('inlineModalityRejected'));
            resolve();
            return;
          }
          if (box.checked !== wantImage) {
            outcome.modality = 'rejected';
            outcome.problems.push(t('inlineModalityRejected'));
            resolve();
            return;
          }
          outcome.applied.push('input');
          resolve();
        }, 0);
      });
    }

    function fillOfficialRow(rowEl, spec, config, t, options) {
      var outcome = { applied: [], problems: [], touched: [], modality: 'unset' };
      var sources = spec.sources || {};
      /**
       * 「用户手改保护」：`options.touched` 是**本行已被用户手动编辑过的控件集合**。
       * 属于它的字段一律跳过 —— 这正是用户报「填写后不能手动修改」的根治点：
       * 插件绝不覆盖用户亲手给的值。
       *
       * 用户显式点「智能匹配」时 `options.force = true` 仅刷新数值/推理建议；
       * 视觉使用独立冲突保护，不会因这次点击清除手改或已保存声明。
       */
      var guard = options && options.force !== true && options.touched ? options.touched : null;
      function blocked(el) {
        return guard !== null && el ? guard.has(el) === true : false;
      }
      function isCurrent() { return !options || !options.isCurrent || options.isCurrent(); }
      function writeField(el, value, key) {
        if (!isCurrent()) return;
        if (el.disabled || el.readOnly) { outcome.problems.push(t('inlineFieldDisabled')); return; }
        nativeSetInput(el, value);
        if (el.value === value) outcome.applied.push(key);
        else outcome.problems.push(t('inlineFieldRejected'));
      }

      // 总开关关掉时，任何字段都不写 —— 单点闸门，覆盖自动与手动两条路径。
      if (config.enabled === false || !isCurrent()) return Promise.resolve(outcome);

      var modalityDone = fillModality(rowEl, spec, config, t, options, outcome);

      var wantContext =
        config.autoApplyContext !== false && spec.contextWindow !== undefined && isWritableSource(sources.contextWindow);
      var wantMax = config.autoApplyContext !== false && spec.maxTokens !== undefined && isWritableSource(sources.maxTokens);
      var wantReasoning =
        config.autoApplyReasoning !== false &&
        spec.reasoningEfforts !== undefined &&
        isWritableSource(sources.reasoningEfforts);

      if (!wantContext && !wantMax && !wantReasoning) return modalityDone.then(function () { return outcome; });

      return modalityDone.then(function () { return isCurrent() ? expandRow(rowEl) : false; }).then(function () {
        if (!isCurrent()) return outcome;
        var advanced = findAdvancedRow(rowEl);
        if (!advanced) {
          outcome.problems.push(t('inlineNoFields'));
          return outcome;
        }

        var reasoningInput = advanced.querySelector(REASONING_SELECTOR + ' input');
        var capacities = [];
        var inputs = advanced.querySelectorAll('input[type="text"]');
        for (var i = 0; i < inputs.length; i += 1) {
          if (inputs[i] !== reasoningInput) capacities.push(inputs[i]);
        }

        if (wantContext) {
          if (!capacities[0]) outcome.problems.push(t('inlineNoFields'));
          else if (blocked(capacities[0])) outcome.touched.push('contextWindow');
          else {
            writeField(capacities[0], formatCapacity(spec.contextWindow), 'contextWindow');
          }
        }
        if (wantMax) {
          if (!capacities[1]) outcome.problems.push(t('inlineNoFields'));
          else if (blocked(capacities[1])) outcome.touched.push('maxTokens');
          else {
            writeField(capacities[1], formatCapacity(spec.maxTokens), 'maxTokens');
          }
        }
        if (wantReasoning) {
          if (!reasoningInput) outcome.problems.push(t('inlineNoFields'));
          else if (blocked(reasoningInput)) outcome.touched.push('reasoningEfforts');
          else {
            var text =
              spec.reasoningEfforts === false
                ? ''
                : Object.keys(spec.reasoningEfforts)
                    .filter(function (level) {
                      return level !== 'off';
                    })
                    .join(', ');
            writeField(reasoningInput, text, 'reasoningEfforts');
          }
        }
        return outcome;
      });
    }

    /* ---------------------------------------------------------------- *
     * 组件
     * ---------------------------------------------------------------- */

    /** 悬浮详情：把四项建议与来源一次说清，**不占纵向空间**。 */
    function detailLines(t, spec) {
      var sources = spec.sources || {};
      var lines = [
        t('contextWindow') + '：' +
          (spec.contextWindow !== undefined ? formatCapacity(spec.contextWindow) : t('notSet')) +
          ' · ' + sourceLabel(t, sources.contextWindow),
        t('maxTokens') + '：' +
          (spec.maxTokens !== undefined ? formatCapacity(spec.maxTokens) : t('notSet')) +
          ' · ' + sourceLabel(t, sources.maxTokens),
        t('modality') + '：' + modalityLabel(t, spec.input) + ' · ' + sourceLabel(t, sources.input),
        t('reasoning') + '：' + reasoningText(t, spec.reasoningEfforts) + ' · ' + sourceLabel(t, sources.reasoningEfforts),
      ];
      if (spec.extraInputs && spec.extraInputs.length > 0) {
        lines.push(t('extraInputs') + spec.extraInputs.join(' / ') + t('extraInputsEnd'));
      }
      if (spec.reasoningSuggestion && spec.reasoningSuggestion.length > 0) {
        lines.push(t('suggestionPrefix') + spec.reasoningSuggestion.join(' / ') + t('suggestionEnd'));
      }
      if (spec.warnings && spec.warnings.length > 0) {
        lines.push(t('warningPrefix') + spec.warnings.join('；'));
      }
      return lines.join('\n');
    }

    /**
     * 单条模型行的行内控件：状态徽标 + 应用 + 测试。
     * **不画任何输入框** —— 官方行本来就有上下文 / 最大输出 / 思考等级 / 图像开关。
     */
    /**
     * 行内一格的渲染。
     *
     * ⚠️ **空间预算（v0.3.2，改动前先读 `CSS_TEXT` 上方那段注释）**
     * 本函数**不得**把任何长度不受控的文本直接放进行内流：
     *   · 置信度 → 徽标（`max-width:64px` + 省略号）；
     *   · 「已填入 / 已手改」→ 一个字的记号（`✓` / `✎`），说明走 `title`；
     *   · 明细、状态句、提示 → **只进 `.dshMscDetail` 悬浮弹层**（绝对定位 = 0 宽度）。
     * 上一版就是在这里把 `note`（「已匹配并填入，可直接修改 · 填入后按官方「保存」才生效」，
     * `max-width:190px` + `nowrap`）塞进了行内，把官方 id 输入框从 97px 挤到 20px。
     */
    function RowChip(props) {
      var t = props.t;
      var spec = props.spec;
      var id = props.id;
      var disabled = props.disabled === true;
      var allowProbe = props.allowProbe === true;
      var probing = props.probing === true;
      var matching = props.matching === true;
      var note = props.note;
      var mark = props.mark;

      var tone = 'Info';
      var label = t('loading');
      var detail = '';
      if (!id) {
        // 空行（刚点「添加模型」）也要有按键 —— 这正是用户要的「添加后有个智能匹配键」。
        tone = 'Info';
        label = t('inlineEmpty');
      } else if (spec === null) {
        tone = 'Warn';
        label = t('failed');
      } else if (spec) {
        tone = confidenceTone(spec.confidence);
        label = confidenceLabel(t, spec.confidence);
        detail = detailLines(t, spec);
      }

      var hint = !id ? t('inlineNeedId') : canApplySpec(spec) ? t('inlineMatchHint') : t('inlineNothing');
      // 徽标 tooltip：标签 + 明细 + 状态句 + 下一步提示，全都在这儿，不占行宽。
      var title = [label, detail, note, hint].filter(function (line) {
        return typeof line === 'string' && line.length > 0;
      }).join('\n');

      // 有东西可填才用实心品牌色；否则退成「安静」形态，不给一屏行做视觉噪声。
      var actionable = !!id && canApplySpec(spec);
      var primaryClass = 'dshMscBtn dshMscBtnPrimary' + (actionable ? '' : ' dshMscBtnQuiet');

      var markNode = null;
      if (mark === 'applied') {
        markNode = h(
          'span',
          { className: 'dshMscMark dshMscMarkOk', title: typeof note === 'string' && note ? note : t('inlineMatched') },
          '✓',
        );
      } else if (mark === 'edited') {
        markNode = h(
          'span',
          { className: 'dshMscMark dshMscMarkEdit', title: typeof note === 'string' && note ? note : t('inlineEdited') },
          '✎',
        );
      }

      var popover = [note, detail].filter(function (line) {
        return typeof line === 'string' && line.length > 0;
      }).join('\n\n');

      return h(
        'span',
        { className: 'dshMscCell' },
        h('span', { className: 'dshMscBadge dshMscBadge' + tone, title: title }, label),
        markNode,
        h(
          'button',
          {
            type: 'button',
            className: primaryClass,
            disabled: disabled || matching,
            title: hint,
            'aria-label': t('inlineMatch'),
            onClick: disabled ? undefined : props.onMatch,
          },
          matching ? t('inlineMatching') : t('inlineMatch'),
        ),
        allowProbe
          ? h(
              'button',
              {
                type: 'button',
                // 图标位：与官方行自带的展开/删除键同一套语法，省下的宽度还给 id 输入框。
                className: 'dshMscBtn dshMscBtnIcon',
                disabled: disabled || probing || !id,
                title: t('inlineProbeHint'),
                'aria-label': t('probe'),
                onClick: disabled || !id ? undefined : props.onProbe,
              },
              h(
                'svg',
                {
                  width: 13,
                  height: 13,
                  viewBox: '0 0 16 16',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.4,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                  'aria-hidden': 'true',
                },
                // 烧瓶 = 「实测一下」（探测端点的真实语义），比放大镜不歧义。
                h('path', { d: 'M6.2 2h3.6M7.2 2v4.1L3.9 11.6A1.3 1.3 0 0 0 5 13.6h6A1.3 1.3 0 0 0 12.1 11.6L8.8 6.1V2' }),
              ),
            )
          : null,
        popover.length > 0 ? h('span', { className: 'dshMscDetail' }, popover) : null,
      );
    }

    /**
     * 槽位条目本体：
     *   · 自身只输出一个 0×0 的隐藏锚点（不占任何视觉空间）；
     *   · 观察本卡片；`<details open>` 出现后，给其中**每一条模型行**挂一个容器；
     *   · 用 `createPortal` 把 `RowChip` 渲染进各自的容器。
     *
     * 于是「一个模型一行」，不再有上下堆叠的整块面板。
     */
    // A tab hides an existing draft root; Cancel removes it. Weak ownership
    // keeps explicit choices across temporary unmounts, not across new drafts.
    var draftTouchedFields = new WeakMap();

    function ModelSmartConfigInline(props) {
      var provider = props.provider;
      var draftRoot = props.draftRoot || null;
      var draftSection = props.draftSection || null;
      var api = props.api;
      var t =
        props.t ||
        function (key) {
          return key;
        };

      var route = provider && typeof provider.provider === 'string' ? provider.provider : '';
      var anchorRef = React.useRef(null);
      var lifetime = React.useMemo(function () { return { active: false }; }, [api, route, draftRoot]);

      React.useEffect(function () {
        lifetime.active = true;
        return function () { lifetime.active = false; };
      }, [lifetime]);

      function isActiveRow(rowEl) {
        if (!lifetime.active || !rowEl || !rowEl.isConnected) return false;
        if (draftRoot) return findCustomDraftRoot(draftSection) === draftRoot && draftRoot.contains(rowEl);
        var anchor = anchorRef.current;
        var card = anchor && findWatchRoot(anchor);
        var details = card && card.querySelector(CATALOG_DETAILS_SELECTOR + '[open]');
        return !!details && details.contains(rowEl) && !rowEl.closest('[hidden]');
      }

      var configState = React.useState({});
      var config = configState[0];
      var setConfig = configState[1];

      var profileState = React.useState({});
      var profile = profileState[0];
      var setProfile = profileState[1];

      var rowsState = React.useState([]);
      var rows = rowsState[0];
      var setRows = rowsState[1];

      var specsState = React.useState({});
      var specs = specsState[0];
      var setSpecs = specsState[1];

      var notesState = React.useState({});
      var notes = notesState[0];
      var setNotes = notesState[1];

      /**
       * 行内一格的**状态记号**：`'applied'`（匹配并已填入）/ `'edited'`（用户手改过）。
       *
       * 为什么单独存而不是从 `notes` 文本反推：「说明文字」与「状态」是两件事 ——
       * 说明要长（进弹层），状态要短（一个字）。状态必须能独立于文案存活，
       * 否则以后一改措辞就断掉（这正是 `notes` 从行内搬到弹层后需要的解耦）。
       */
      var marksState = React.useState({});
      var marks = marksState[0];
      var setMarks = marksState[1];

      var probingState = React.useState({});
      var probing = probingState[0];
      var setProbing = probingState[1];

      /** 「智能匹配」键的进行态，按模型 id 记 —— 点了要立刻有反馈，不能像没反应。 */
      var matchingState = React.useState({});
      var matching = matchingState[0];
      var setMatching = matchingState[1];
      React.useEffect(function () { setMatching({}); }, [lifetime]);

      // 观察者回调跑在 effect 闭包里，需要拿到最新值 —— 一律走 ref，避免重挂观察者。
      var configRef = React.useRef(config);
      configRef.current = config;
      var profileRef = React.useRef(profile);
      profileRef.current = profile;
      // A failed or pending read is not evidence that no explicit choice exists.
      // Bind readiness to the same lifetime as the rows, never to a prior route.
      var settingsLoad = React.useMemo(function () {
        return { status: 'idle', promise: null, config: {}, profile: {} };
      }, [lifetime]);
      var specsRef = React.useRef(specs);
      specsRef.current = specs;

      /**
       * ★ 「用户手改保护」—— 用户报「填写后不能手动修改」的根治点。
       *
       * 只要用户在**本行的结果字段**里动过手（名称不算；上下文 / 最大输出 /
       * 思考等级 / 图像开关算），该**控件**就被登记，**自动匹配永不再写它** ——
       * 用户亲手给的值就是最终答案。
       *
       * 粒度是「控件」而不是「整行」：用户在思考等级上手改过，插件仍可以继续
       * 维护上下文，不会因为一处手改就把整行冻死。
       *
       * 想重新填？用户自己点「智能匹配」键可更新数值与推理建议；
       * 视觉手改保护继续保留，能力规则不能覆盖用户明确声明。
       *
       * 用弱引用按编辑所有者保存：观察者重挂不清除，同一草稿切换标签仍保留。
       */
      var touchedFields = React.useMemo(function () {
        if (draftRoot && draftTouchedFields.has(draftRoot)) return draftTouchedFields.get(draftRoot);
        var fields = new WeakMap();
        if (draftRoot) draftTouchedFields.set(draftRoot, fields);
        return fields;
      }, [lifetime]);

      /** 登记「用户手改了本行的某个控件」。 */
      function markTouched(rowEl, el) {
        if (!rowEl) return;
        var set = touchedFields.get(rowEl);
        if (!set) {
          set = new Set();
          touchedFields.set(rowEl, set);
        }
        if (el) set.add(el);
      }

      /** 本行被用户手改过的控件集合（可能为空）。 */
      function rowTouchedFields(rowEl) {
        return touchedFields.get(rowEl) || null;
      }

      function putSpec(id, spec) {
        setSpecs(function (previous) {
          var next = Object.assign({}, previous);
          next[id] = spec;
          return next;
        });
      }

      function putNote(id, text) {
        setNotes(function (previous) {
          var next = Object.assign({}, previous);
          next[id] = text;
          return next;
        });
      }

      /** 行内状态记号，见 `marksState` 的注释。传 `undefined` 即清除。 */
      function putMark(id, value) {
        setMarks(function (previous) {
          if (previous[id] === value) return previous;
          var next = Object.assign({}, previous);
          if (value === undefined) delete next[id];
          else next[id] = value;
          return next;
        });
      }

      var detect = React.useCallback(
        function (id) {
          if (!id || !api) return Promise.resolve(null);
          var current = profileRef.current || {};
          return Promise.all([
            api
              .infer({ name: id, baseURL: current.baseURL, api: current.api })
              .catch(function () {
                return null;
              }),
            draftRoot || !route ? Promise.resolve(null) : api
              .authoritative({ provider: route, model: id })
              .catch(function () {
                return null;
              }),
          ]).then(function (pairs) {
            if (!lifetime.active || (draftRoot && findCustomDraftRoot(draftSection) !== draftRoot)) return null;
            var spec = pairs[0] ? combine(pairs[0], pairs[1]) : null;
            putSpec(id, spec);
            // 识别结论换了 → 上一次的「已填入 / 已手改」记号不再成立，清掉。
            // （不清就会看到「未识别」的徽标旁边挂着上一轮的 ✓。）
            putMark(id, undefined);
            return spec;
          });
        },
        [api, route, draftRoot, draftSection, lifetime],
      );

      /* ---- 读自己的配置与 provider 档案 ---- */

      var loadSettings = React.useCallback(function () {
        // Coalesce only pending reads. Every later match re-reads settings:
        // the provider slot outlives the host's Save / Edit form sessions.
        if (settingsLoad.promise) return settingsLoad.promise;
        settingsLoad.status = 'loading';
        settingsLoad.promise = Promise.all([
          Promise.resolve().then(function () { return api.readConfig(); }),
          route ? Promise.resolve().then(function () { return api.readProvider(route); }) : Promise.resolve(null),
        ]).then(function (values) {
          if (!lifetime.active) throw new Error('inactive settings read');
          settingsLoad.config = values[0] || {};
          settingsLoad.profile = (values[1] && values[1].profile) || {};
          settingsLoad.status = 'ready';
          settingsLoad.promise = null;
          configRef.current = settingsLoad.config;
          profileRef.current = settingsLoad.profile;
          setConfig(settingsLoad.config);
          setProfile(settingsLoad.profile);
          return settingsLoad;
        }).catch(function (error) {
          settingsLoad.status = 'error';
          settingsLoad.promise = null;
          throw error;
        });
        return settingsLoad.promise;
      }, [api, route, lifetime, settingsLoad]);

      React.useEffect(function () {
        loadSettings().catch(function () {});
      }, [loadSettings]);

      /* ---- 观察官方模型行：挂容器 + 新增模型自动匹配 ---- */

      React.useEffect(
        function () {
          if (!provider && !draftRoot) return undefined;
          var anchor = anchorRef.current;
          if (!anchor || typeof anchor.closest !== 'function') return undefined;
          var card = draftRoot || findWatchRoot(anchor);
          if (!card) return undefined;
          var doc = anchor.ownerDocument || (typeof document === 'undefined' ? null : document);
          if (!doc) return undefined;
          var Observer =
            typeof MutationObserver === 'function'
              ? MutationObserver
              : typeof window !== 'undefined'
                ? window.MutationObserver
                : undefined;
          if (typeof Observer !== 'function') return undefined;

          var attached = new Map(); // rowEl -> container

          /**
           * 首次同步时**已经存在**的模型行。
           *
           * 这是「不要动用户原有配置」的安全阀：用户原有的模型可能已经被手工调过
           * 上下文 / 思考等级，插件**绝不能**在打开编辑器时把它们悄悄改掉。
           *
           * v0.3.1 起「写值」已整条收敛到用户点「智能匹配」那一次点击里，
           * 自动路径只跑只读 `detect`，所以这个集合不再需要参与过滤；
           * 保留它只是为了让「原有行 / 新增行」的区分在代码里仍然显式可见。
           *
           * ⚠️ 判据必须是「行」而不是「模型 id」：按 id 记的话，用户新增一行、
           * 敲一个本来就在列表里的模型名（例如在两个 route 之间照抄），
           * 就会因为「这个 id 见过」而被跳过。
           */
          var baselineRows = new Set();
          var baselineDone = false;
          /** 新行 → 最近一次自动匹配用的 id，用来判断「用户改过 id，需要重匹配」。 */
          var autoDone = new Map();
          // `touchedFields` 由编辑所有者持有，不由观察者生命周期管理，
          // 这样观察者重挂、编辑器收起再展开，用户的手改保护都不会丢。
          var timers = new Map(); // rowEl -> timeoutId
          var disposed = false;

          function dropRow(rowEl) {
            var container = attached.get(rowEl);
            if (container && container.parentNode) container.parentNode.removeChild(container);
            attached.delete(rowEl);
            autoDone.delete(rowEl);
            // Weak row keys retain choices while collapsed, without retaining
            // removed DOM rows. A new route/draft uses a different owner.
            // 插件撤走 → 行网格还原成官方原样，不留痕迹。
            unwidenRow(rowEl);
            var timer = timers.get(rowEl);
            if (timer !== undefined) {
              clearTimeout(timer);
              timers.delete(rowEl);
            }
          }

          function detachAll() {
            attached.forEach(function (_container, rowEl) {
              dropRow(rowEl);
            });
            attached.clear();
            baselineRows.clear();
            baselineDone = false;
            setRows([]);
          }

          /** 兼容旧名：对外只暴露「只读识别」语义，写值已收敛到 `matchRow`。 */
          function sync() {
            if (disposed) return;
            var details = draftRoot
              ? (findCustomDraftRoot(draftSection) === draftRoot ? draftRoot : null)
              : card.querySelector(CATALOG_DETAILS_SELECTOR + '[open]');
            if (!details) {
              if (attached.size > 0) detachAll();
              return;
            }

            var found = findRowElements(details);
            var i;
            for (i = 0; i < found.length; i += 1) {
              if (!attached.has(found[i])) {
                var container = doc.createElement('div');
                container.setAttribute('data-msc-row', '');
                found[i].appendChild(container);
                attached.set(found[i], container);
              }
              // 行是 4 列 grid、官方自己就塞不下第 5 个节点；追加容器后显式撑轨道，
              // 保证所有格子仍在一行 —— 这是「不额外占纵向空间」的兑现方式。
              widenRow(found[i]);
            }
            var stale = [];
            attached.forEach(function (_container, rowEl) {
              if (found.indexOf(rowEl) < 0) stale.push(rowEl);
            });
            for (i = 0; i < stale.length; i += 1) dropRow(stale[i]);

            var next = [];
            for (i = 0; i < found.length; i += 1) {
              next.push({ el: found[i], container: attached.get(found[i]), id: readRowId(found[i]) });
            }

            if (!baselineDone) {
              // 打开编辑器时**已经存在**的模型行：只识别、只显示，绝不自动改写。
              for (i = 0; i < next.length; i += 1) baselineRows.add(next[i].el);
              baselineDone = true;
            }

            publishRows(next);
          }

          /**
           * 提交 `rows` 状态，并对**新的 (行, id) 组合**跑一次只读识别。
           *
           * `autoDone` 以「行 → 最近一次识别用的 id」记账，所以：
           *   · 新行带 id 出生（官方「获取 model → 采纳候选」路径）→ 识别一次；
           *   · 打开编辑器时**已经存在**的原有行 → 也识别（否则徽标一直停在「识别中」），
           *     但识别是**纯只读**的，不会动用户任何值；
           *   · 用户改 id → 防抖后 `onCardInput` 直接 `detect`，不依赖这里；
           *   · 反复 `sync()` / `refreshRows()` 不会重复发同一 (行, id) 的 RPC。
           *
           * ⚠️ **自动路径只识别、绝不写值**（v0.3.1 口径修正）。
           * 用户 要的是「**点击后**自动匹配和填写，且填写后能手动修改」。
           * v0.3.0 在自动路径里直接写值，会在用户还没决定时就先写了，
           * 用户手改后再动一下 id 就被静默覆盖 —— 那正是报障第二条。
           * 现在把「写值」整条收敛到用户点「智能匹配」那一次点击里。
           */
          function publishRows(next) {
            setRows(function (previous) {
              if (previous.length === next.length) {
                var same = true;
                for (var j = 0; j < next.length; j += 1) {
                  if (previous[j].el !== next[j].el || previous[j].id !== next[j].id || previous[j].container !== next[j].container) {
                    same = false;
                    break;
                  }
                }
                if (same) return previous;
              }
              return next;
            });

            for (var i = 0; i < next.length; i += 1) {
              if (!next[i].id) continue;
              if (autoDone.get(next[i].el) === next[i].id) continue;
              autoDone.set(next[i].el, next[i].id);
              detect(next[i].id);
            }
          }

          /**
           * 把 `rows` 状态与当前 DOM 对齐。
           *
           * ⚠️ 为什么需要它：用户改 id 只是改 `input.value`，**不产生任何 DOM 结构
           * 变化**，MutationObserver 不会醒 —— 于是 `rows[].id` 一直停在旧值。
           * 徽标按 `specs[旧 id]`、提示按 `notes[旧 id]` 取，用户就会看到
           * 「点了键提示词不变」/「徽标是上一个模型的」——观感上就是「没反应」。
           * 所以每次 id 或结果字段被改动，都要顺手把 id 重新读一遍。
           */
          function refreshRows() {
            if (disposed) return;
            var details = draftRoot
              ? (findCustomDraftRoot(draftSection) === draftRoot ? draftRoot : null)
              : card.querySelector(CATALOG_DETAILS_SELECTOR + '[open]');
            if (!details) return;
            var found = findRowElements(details);
            var next = [];
            for (var i = 0; i < found.length; i += 1) {
              if (attached.has(found[i])) {
                next.push({ el: found[i], container: attached.get(found[i]), id: readRowId(found[i]) });
              }
            }
            publishRows(next);
          }

          /**
           * 统一的行内 input 委托。两类事件，处理方式完全不同：
           *
           *  ① **id 框**（每行第一个文本框）→ 防抖后 `detect`（**只读**，更新徽标）。
           *     ⚠️ 这里**绝不写值** —— 用户改个 id 就把他手改的上下文/思考等级
           *     静默抹掉，正是用户报的「填写后不能手动修改」。要填值只能点按键。
           *
           *  ② **结果字段**（上下文 / 最大输出 / 思考等级 / 图像开关）→ 若这次
           *     事件不是插件自己发的（`pluginWrites` 里没有该元素），说明是用户
           *     亲手改的，登记进手改保护：自动路径以后再也别碰这个控件。
           */
          function onCardInput(event) {
            var target = event && event.target;
            if (!target || target.tagName !== 'INPUT') return;
            /**
             * ⚠️ 高级区（上下文 / 最大输出 / 思考等级）是 `div.modelRow` 的**兄弟**，
             * 不在行元素内部 —— 只判 `el.contains(target)` 会漏掉这三个字段，
             * 用户的手改就登记不上。所以行匹配要把高级区一并算进去。
             */
            function rowOwns(el) {
              if (el.contains(target)) return true;
              var advanced = findAdvancedRow(el);
              return advanced !== null && typeof advanced.contains === 'function' && advanced.contains(target);
            }
            var rowEl = null;
            attached.forEach(function (_container, el) {
              if (rowEl === null && rowOwns(el)) rowEl = el;
            });
            if (!rowEl) return;

            if (readIdInput(rowEl) === target) {
              // 立刻把新 id 反映到 `rows`：徽标与提示词都按 id 取，
              // 不刷新就会显示上一个模型的结论（观感＝「点了没反应」）。
              refreshRows();
              var timer = timers.get(rowEl);
              if (timer !== undefined) clearTimeout(timer);
              timers.set(
                rowEl,
                setTimeout(function () {
                  timers.delete(rowEl);
                  if (disposed) return;
                  var id = readRowId(rowEl);
                  if (!id) return;
                  // 只识别、只刷新徽标；**不写任何值**。
                  detect(id);
                }, AUTO_DEBOUNCE_MS),
              );
              return;
            }

            // 结果字段：插件自己写的不算手改（`pluginWrites` 打标），其余一律算。
            if (pluginWrites && pluginWrites.has(target)) return;
            if (isResultField(rowEl, target)) {
              markTouched(rowEl, target);
              refreshRows();
              var id = readRowId(rowEl);
              if (id) {
                putNote(id, t('inlineEdited'));
                putMark(id, 'edited');
              }
            }
          }

          sync();
          var observer = new Observer(sync);
          observer.observe(card, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['open'],
          });
          card.addEventListener('input', onCardInput, true);

          return function () {
            disposed = true;
            observer.disconnect();
            card.removeEventListener('input', onCardInput, true);
            attached.forEach(function (_container, rowEl) {
              dropRow(rowEl);
            });
            attached.clear();
            timers.forEach(function (id) {
              clearTimeout(id);
            });
            timers.clear();
          };
        },
        [provider, draftRoot, draftSection, detect, t],
      );

      /* ---- 探测（用户显式点击才发生） ---- */

      function runProbe(id) {
        var spec = specsRef.current[id];
        var current = profileRef.current || {};
        var keyRef =
          typeof current.apiKeyEnv === 'string' && current.apiKeyEnv.length > 0
            ? current.apiKeyEnv
            : deriveKeyRef(route);
        var levels =
          spec && spec.reasoningEfforts && typeof spec.reasoningEfforts === 'object'
            ? Object.keys(spec.reasoningEfforts).filter(function (level) {
                return level !== 'off' && PROBE_LEVELS.indexOf(level) >= 0;
              })
            : [];

        setProbing(function (previous) {
          var next = Object.assign({}, previous);
          next[id] = true;
          return next;
        });

        return api
          .probe({
            baseURL: current.baseURL,
            api: current.api,
            apiKeyRef: keyRef,
            model: id,
            levels: levels.length > 0 ? levels : ['low', 'high'],
          })
          .then(function (result) {
            var lines = [];
            lines.push(result.conclusion.reasoning ? t('probeReasoningYes') : t('probeReasoningNo'));
            if (result.conclusion.supportedLevels.length > 0) {
              lines.push(t('probeAccepted') + result.conclusion.supportedLevels.join(' / '));
            } else {
              lines.push(t('probeNone'));
            }
            if (result.conclusion.rejectedLevels.length > 0) {
              lines.push(t('probeRejected') + result.conclusion.rejectedLevels.join(' / '));
            }
            if (result.note) lines.push(result.note);
            putNote(id, lines.join('；'));
          })
          .catch(function (error) {
            putNote(id, error && error.message ? error.message : String(error));
          })
          .then(function () {
            setProbing(function (previous) {
              var next = Object.assign({}, previous);
              delete next[id];
              return next;
            });
          });
      }

      /* ---- 用户点击「智能匹配」：识别 + 填入官方控件（不直接写 settings） ---- */

      /**
       * 用户显式点「智能匹配」—— 这是**唯一**的填值入口。
       *
       * 为什么只在这里写值：用户 要的是「添加模型后有一个按键，**点击后**
       * 自动匹配和填写，且填写后能手动修改」。v0.3.0 的「敲完 id 自动填」会抢在
       * 用户前面写值，用户改完再动一下 id 就被静默覆盖 —— 那正是报障第二条。
       *
       * 与识别（badge）分工：识别随时可发生（只读，不动用户任何值）；
       * 写入只发生在这一次点击里；数值与推理建议可重新填写，视觉也按规则表落地
       * —— 显式点击允许覆盖已保存声明，但本次会话里用户亲手拨过的开关永远优先。
       */
      function matchRow(rowEl, key) {
        if (!isActiveRow(rowEl)) {
          // 点了却什么都不做是最糟的反馈：行不在当前编辑区时必须说出来。
          putNote(key, t('inlineRowInactive'));
          putMark(key, undefined);
          return Promise.resolve();
        }
        var id = readRowId(rowEl);
        if (!id) {
          // 空行点了键：必须说出原因，不能像没反应。
          putNote(key, t('inlineNeedId'));
          putMark(key, undefined);
          return Promise.resolve();
        }
        // 显式点击 = 「按规则表落地」的授权：允许覆盖已保存的视觉声明；
        // 但本次会话里用户亲手拨过的开关仍优先（见 fillModality 的 touched 分支）。
        // 手改记录要跨异步查找保留；其余字段继续 force=true，便于重新刷新建议。
        setMatching(function (previous) {
          var next = Object.assign({}, previous);
          next[key] = true;
          return next;
        });
        function settle() {
          if (!lifetime.active) return;
          setMatching(function (previous) {
            var next = Object.assign({}, previous);
            delete next[key];
            return next;
          });
        }
        if (settingsLoad.status !== 'ready') putNote(key, t('inlineLoadingSettings'));
        return loadSettings().then(function (settings) {
          if (!isActiveRow(rowEl) || readRowId(rowEl) !== id) {
            putNote(key, t('inlineRowChanged'));
            putMark(key, undefined);
            return undefined;
          }
          if (settings.config.enabled === false) {
            putNote(id, t('inlineSettingsDisabled'));
            putMark(id, undefined);
            return undefined;
          }
          return detect(id)
          .then(function (spec) {
            if (!spec) {
              putNote(id, t('failed'));
              putMark(id, undefined);
              return undefined;
            }
            if (!isRecognised(spec) || !hasWritable(spec)) {
              putNote(id, t('inlineNothing'));
              putMark(id, undefined);
              return undefined;
            }
            // 点击期间行可能被删/改了 id，填之前复核。
            if (!isActiveRow(rowEl) || readRowId(rowEl) !== id) {
              putNote(key, t('inlineRowChanged'));
              putMark(key, undefined);
              return undefined;
            }
            return fillOfficialRow(rowEl, spec, settings.config, t, {
              force: true,
              touched: rowTouchedFields(rowEl),
              savedInput: savedModelInput(settings.profile, id),
              isCurrent: function () { return isActiveRow(rowEl) && readRowId(rowEl) === id; },
            }).then(function (outcome) {
              if (!isActiveRow(rowEl) || readRowId(rowEl) !== id) return undefined;
              putNote(id, outcomeNote(t, outcome, 'inlineMatched') + ' · ' + t('inlineNeedSave'));
              // 真填进去了才挂 ✓；一个字段都没填就别装作成功。
              putMark(id, outcome.applied.length > 0 ? 'applied' : undefined);
              return undefined;
            });
          });
        })
          .catch(function (error) {
            if (!isActiveRow(rowEl) || readRowId(rowEl) !== id) return;
            putNote(id, settingsLoad.status === 'error' ? t('inlineSettingsFailed') : error && error.message ? error.message : String(error));
            putMark(id, undefined);
          })
          .then(settle, settle);
      }

      var anchor = h('span', {
        ref: anchorRef,
        'data-msc-anchor': '',
        style: { display: 'none' },
      });

      if (!provider && !draftRoot) return anchor;
      if (!ReactDOM || typeof ReactDOM.createPortal !== 'function') return anchor;

      var enabled = settingsLoad.status !== 'ready' || config.enabled !== false;
      var allowProbe = !draftRoot && settingsLoad.status === 'ready' && config.allowProbe !== false;

      var portals = [];
      for (var i = 0; i < rows.length; i += 1) {
        var entry = rows[i];
        if (!entry.container) continue;
        // ⚠️ **空行也要出控件**：用户点「添加模型」后若这里 `continue`，
        // 那一行就完全没有「智能匹配」键 —— 这正是用户报的「两项都不行」第一条。
        var rowId = entry.id;
        var rowKey = entry.id || 'msc-row-' + i;
        portals.push(
          ReactDOM.createPortal(
            h(RowChip, {
              t: t,
              id: rowId,
              spec: rowId ? specs[rowId] : undefined,
              note: notes[rowKey] !== undefined ? notes[rowKey] : rowId ? notes[rowId] : undefined,
              mark: marks[rowKey] !== undefined ? marks[rowKey] : rowId ? marks[rowId] : undefined,
              probing: rowId ? probing[rowId] === true : false,
              matching: rowId ? matching[rowId] === true : false,
              disabled: !enabled,
              allowProbe: allowProbe,
              onMatch: function (key) {
                return function () {
                  matchRow(key.el, key.key);
                };
              }({ el: entry.el, key: rowKey }),
              onProbe: function (id) {
                return function () {
                  runProbe(id);
                };
              }(rowId),
            }),
            entry.container,
            rowKey,
          ),
        );
      }

      return h(React.Fragment, null, anchor, portals);
    }

    /* ---------------------------------------------------------------- *
     * 样式注入
     * ---------------------------------------------------------------- */

    /** 幂等注入本插件的样式表，返回清理函数（`apply` 的 effect 负责回收）。 */
    function injectStyle() {
      if (typeof document === 'undefined') return function () {};
      var selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']';
      var existing = document.querySelector(selector);
      if (existing !== null) return function () {};
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-model-smart-config';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS_TEXT;
      document.head.appendChild(tag);
      return function () {
        if (tag.parentNode) tag.parentNode.removeChild(tag);
      };
    }

    var inject = ['slots', 'locale', 'connection', 'remote', 'remote.settings'];

    function apply(ctx) {
      ctx.effect(function () {
        var disposeLocale = ctx.locale.register(NS, { zh: zh, en: en });
        var disposeStyle = injectStyle();
        return function () {
          disposeStyle();
          disposeLocale();
        };
      }, 'model-smart-config: copy dictionaries + inline styles');

      var api = createApi(ctx);

      ctx.slots.inject('settings.models.footer', function* () {
        yield ctx.slots.register({
          name: 'settings.models.footer',
          id: 'model-smart-config-custom-draft',
          locale: NS,
          inject: function () { return { api: api }; },
        }, CustomDraftSmartConfig);
      });

      ctx.slots.inject(PROVIDER_SLOT, function* () {
        yield ctx.slots.register(
          {
            name: PROVIDER_SLOT,
            // keyed 槽：key 是官方按 `row.entry.settingsNs` 派发的值，
            // 而所有 pi-ai 第三方 provider 共用 "llm-pi-ai"。
            key: PI_AI_NS,
            locale: NS,
            inject: function () {
              return { api: api };
            },
          },
          ModelSmartConfigInline,
        );
      });
    }

    exports.inject = inject;
    exports.apply = apply;

    return module.exports;
  },
});
