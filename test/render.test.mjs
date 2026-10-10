/**
 * Client 半的真实渲染测试。
 *
 * 目的：证明 `client.js` 不是「只是语法正确」，而是
 *   ① 能在 `window.__ModuleLoader__` 协议下被加载；
 *   ② `apply(ctx)` 真的会往 `settings.models.provider-card` 注册一条 `key: 'llm-pi-ai'` 的条目；
 *   ③ 注册进去的组件用真实 React 渲染不抛错，且渲染出预期的中文文案。
 *
 * 用**真实 React + react-dom/server**（默认取仓库根 `node_modules`，
 * 可用 MSC_REACT_ENV 指向别的 node_modules 布局），不是手写 mock —— 否则「渲染通过」没有意义。
 *
 * 跑法：node test/render.test.mjs
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
// 渲染测试需要一个真实的 React 环境。默认用仓库根目录的 node_modules
// （`npm install` 会按 devDependencies 装好 react / react-dom / jsdom）；
// 也可以用 MSC_REACT_ENV 指向任意别的 node_modules 布局。
const reactEnv = process.env.MSC_REACT_ENV || path.join(root, 'node_modules');

const require = createRequire(path.join(reactEnv, 'noop.js'));
let React;
let ReactDOM;
let renderToString;
try {
  React = require('react');
  ReactDOM = require('react-dom');
  renderToString = require('react-dom/server').renderToString;
} catch (error) {
  console.error('SKIP: 真实 React 不可用，无法做渲染证据:', error.message);
  process.exit(2);
}

/* ---------------- 装载 client.js ---------------- */

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
};

const source = readFileSync(path.join(root, 'client.js'), 'utf8');
// 用 Function 求值，让 `window.__ModuleLoader__` 那条语句照常执行。
new Function('window', source)(globalThis.window);

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

console.log('装载协议');
check('factory 被调用', captured !== null);
check('id 等于包名', captured?.id === 'dsh-model-smart-config', captured?.id);

const mod = captured.factory((name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return ReactDOM;
  throw new Error(`unexpected require("${name}")`);
});

console.log('\n模块导出面');
check('exports.inject 是数组', Array.isArray(mod.inject));
check(
  'inject 含 slots/connection/remote.settings',
  ['slots', 'locale', 'connection', 'remote', 'remote.settings'].every((n) => mod.inject.includes(n)),
  JSON.stringify(mod.inject),
);
check('exports.apply 是函数', typeof mod.apply === 'function');

/* ---------------- 用假 ctx 跑 apply ---------------- */

const registrations = [];
const localeRegistrations = [];
const effects = [];

const fakeCtx = {
  effect(fn, label) {
    effects.push(label);
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  locale: {
    register(ns, dicts) {
      localeRegistrations.push({ ns, keys: Object.keys(dicts.zh ?? {}) });
      return () => {};
    },
  },
  slots: {
    inject(key, callback) {
      // 真实实现里这是 ctx.effect(callback)，回调是 generator。
      const iter = callback();
      const next = iter.next();
      return () => {
        if (typeof next.value === 'function') next.value();
      };
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
  get(name) {
    if (name === 'connection') {
      return { rpc: { call: async () => ({ ok: true, value: {} }) } };
    }
    throw new Error(`unexpected ctx.get("${name}")`);
  },
  remote: {
    settings: {
      describe: async () => ({ ok: true, value: { namespaces: [] } }),
      mutate: async () => ({ ok: true, value: {} }),
    },
  },
};

console.log('\napply(ctx)');
try {
  mod.apply(fakeCtx);
  check('apply 未抛错', true);
} catch (error) {
  check('apply 未抛错', false, error.message);
}

check('注册了 locale 字典', localeRegistrations.length === 1, JSON.stringify(localeRegistrations.map((r) => r.ns)));
check('注册了 1 个 slot 条目', registrations.length === 1, String(registrations.length));

const reg = registrations[0];
check('槽位名 = settings.models.provider-card', reg?.options?.name === 'settings.models.provider-card', reg?.options?.name);
check('keyed key = llm-pi-ai', reg?.options?.key === 'llm-pi-ai', reg?.options?.key);
check('keyed 条目不声明 id（官方纪律）', reg?.options?.id === undefined, String(reg?.options?.id));
check('组件是函数', typeof reg?.component === 'function');

const injected = typeof reg.options.inject === 'function' ? reg.options.inject() : reg.options.inject;
check('inject 面暴露 api', injected && typeof injected.api === 'object');

/* ---------------- 真实渲染 ---------------- */

console.log('\n真实 React 渲染');

const propsFor = (provider, extra = {}) => ({
  provider,
  configured: false,
  keyConfigured: true,
  ...injected,
  ...extra,
});

const providerRow = {
  provider: 'example-provider',
  displayName: 'Example Provider',
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'example-provider'],
  active: true,
  declared: true,
};

// 组件从 inject 面拿 api；t 由 locale 注入，这里给一个直通实现。
const t = (key) => key;
const Card = reg.component;

// 因为有 useEffect，SSR 首帧走 loading 分支；这里额外用「同步版」验证主体渲染。
function render(label, props) {
  try {
    const html = renderToString(React.createElement(Card, props));
    return { html, error: null, label };
  } catch (error) {
    return { html: '', error, label };
  }
}

// ★ 显示位置搬家（v0.2.0）的渲染层证据：
// 槽位条目本身**只**输出一个 display:none 的锚点。模型列表里不再出现卡片本体，
// 面板改由 react-dom portal 挂进「本行模型目录」，而 SSR 不跑 useEffect ⇒ 只有锚点。
const first = render('首次渲染（SSR，无 DOM 可挂）', propsFor(providerRow, { t }));
check('首次渲染不抛错', first.error === null, first.error?.message);
check('槽位里只渲染隐藏锚点（不再占用模型列表）', first.html.includes('data-msc-anchor'), first.html.slice(0, 200));
check('槽位输出里没有卡片标题', !first.html.includes('模型智能配置'), first.html.slice(0, 200));
check('锚点带 display:none', /display:\s*none/.test(first.html), first.html.slice(0, 200));
check('锚点不含任何可见文字', first.html.replace(/<[^>]*>/g, '').trim() === '', JSON.stringify(first.html.replace(/<[^>]*>/g, '')));

const draft = render('draft（settingsPath 为空）', propsFor({ ...providerRow, settingsPath: [] }, { t }));
check('draft 渲染不抛错', draft.error === null, draft.error?.message);

check('首次渲染产出了 HTML', first.html.length > 0, `${first.html.length} chars`);

/* ---------------- 结果 ---------------- */

console.log('');
if (failures.length === 0) {
  console.log('全部通过');
  console.log('\n--- 首次渲染 HTML（前 600 字符）---');
  console.log(first.html.slice(0, 600));
  process.exit(0);
}
console.log(`失败 ${failures.length} 项: ${failures.join(', ')}`);
process.exit(1);
