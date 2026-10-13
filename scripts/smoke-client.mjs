/**
 * dsh-rundeck — 客户端半边的离线自测。
 *
 * 不起浏览器、不挂宿主，只验证「ModuleLoader 契约 + 纯函数行为」：
 *   1. 包的 ModuleLoader 契约（id 是包名、版本已注入）
 *   2. 组件都在（浮动条 / 宿主壳 / + 面板 / ⚙ 面板）
 *   3. 纯函数：图标映射、三档密度的文字策略、截断
 *   4. 文案字典键齐备（中英对齐）
 *
 * 运行：`node scripts/smoke-client.mjs`（与 `npm run smoke:client` 等同）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(root, 'client', 'client.js');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let passed = 0;
let failed = 0;
async function check(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 在一个假的 ModuleLoader 环境里取出插件导出。 */
function loadPlugin() {
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
  };
  const captured = [];
  const store = new Map();
  const window2 = {
    __ModuleLoader__: { load: (registration) => captured.push(registration) },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
    opened: [],
    open: (...args) => {
      window2.opened.push(args);
      return {};
    },
  };
  const source = readFileSync(bundlePath, 'utf8');
  const run = new Function('window', 'React', 'console', source);
  run(window2, react, console);
  assert.equal(captured.length, 1, '包里应该注册恰好一次');
  const registration = captured[0];
  const exported = registration.factory((spec) => {
    if (spec === 'react') return react;
    throw new Error(`离线自测不提供 ${spec}`);
  });
  return { exported, registration, react, window: window2 };
}

console.log('dsh-rundeck client smoke');

await (async () => {
  const { exported, registration, window: win } = loadPlugin();
  // 纯函数与字典挂在 default 的 internals 上（ModuleLoader 不接受 ESM export）
  const x = exported.internals ?? {};

  await check('ModuleLoader 注册 id 等于包名', () => {
    assert.equal(registration.id, pkg.name);
  });

  await check('客户端版本已注入（与 package.json 一致）', () => {
    assert.equal(x.CLIENT_VERSION, pkg.version);
  });

  await check('inject 只声明必要的两个服务', () => {
    assert.deepEqual([...exported.inject].sort(), ['locale', 'slots']);
  });

  await check('浮动条的五个组件都在（含失败原因面板）', () => {
    for (const name of ['FloatingBar', 'FloatingBarHost', 'AddPanel', 'SettingsPanel', 'ErrorPanel']) {
      assert.equal(typeof x[name], 'function', `${name} 不是函数`);
    }
  });

  /* ── 纯函数 ── */

  await check('iconGlyph 认识 run.json 里那几个图标名，认不出退化成首字母', () => {
    const glyph = x.iconGlyph;
    for (const name of ['eye', 'play', 'desktop', 'hammer', 'server', 'terminal']) {
      assert.ok(glyph(name).length > 0, `${name} 应该有字形`);
    }
    assert.equal(glyph('whatever'), 'W');
    assert.equal(glyph(''), '•');
  });

  await check('truncate 超长截断并加省略号', () => {
    assert.equal(x.truncate('abc', 10), 'abc');
    assert.equal(x.truncate('abcdefghijklmno', 12), 'abcdefghijk…');
  });

  await check('labelFor 三档密度的文字策略', () => {
    const button = { entry: 'a', icon: 'eye', group: 'g', order: 1, projectRoot: 'p', entryLabel: 'jin · web' };
    assert.equal(x.labelFor(button, 'full'), 'jin · web');
    assert.equal(x.labelFor(button, 'icon'), '');
    assert.ok(x.labelFor(button, 'compact').length <= x.COMPACT_MAX_CHARS);
  });

  await check('labelFor 优先用本地覆盖的 label', () => {
    const button = { entry: 'a', icon: 'eye', group: 'g', order: 1, projectRoot: 'p', entryLabel: '长名字', label: '短' };
    assert.equal(x.labelFor(button, 'full'), '短');
    assert.equal(x.labelFor(button, 'compact'), '短');
  });

  await check('openReadyUrl：只开一次、只认 http(s)（就绪地址由界面交给系统浏览器）', () => {
    const open = x.openReadyUrl;
    assert.equal(typeof open, 'function', 'openReadyUrl 不在 internals 上');
    // 第一次开，第二次同一条 run + 同一个地址不再开（否则每次刷新都弹浏览器）
    assert.equal(open('run-1', 'http://127.0.0.1:5180/'), true);
    assert.equal(open('run-1', 'http://127.0.0.1:5180/'), false);
    // 另一条 run 的同一个地址仍然要开（是不同的运行）
    assert.equal(open('run-2', 'http://127.0.0.1:5180/'), true);
    // 非 http(s) 一律不开，而且**跳过也记住**（否则每次刷新页面都再报一次"没打开"）
    assert.equal(open('run-3', 'file:///C:/x.html'), false);
    assert.equal(open('run-3', 'file:///C:/x.html'), false);
    assert.equal(open('run-4', 'javascript:alert(1)'), false);
    assert.deepEqual(
      win.opened.map((args) => args[0]),
      ['http://127.0.0.1:5180/', 'http://127.0.0.1:5180/'],
    );
  });

  await check('文案字典有浮动层与面板的键（中英各一份）', () => {
    const zh = Object.keys(x.ZH);
    for (const key of [
      'run', 'stop', 'densityFull', 'densityCompact', 'densityIcon', 'densityCycle',
      'overflow', 'add', 'settings', 'addTitle', 'addHint', 'addPinned', 'addUnpinned',
      'addPin', 'addHide', 'settingsTitle', 'settingsDensity', 'settingsRuns',
      'settingsWarnings', 'settingsCapability', 'noFocus',
      // 失败原因面板（点"启动失败"看到的是原因，不是设置界面）
      'errorTitle', 'errorHint', 'errorOpenSettings', 'errorClose',
    ]) {
      assert.ok(zh.includes(key), `ZH 缺 ${key}`);
      assert.ok(Object.keys(x.EN).includes(key), `EN 缺 ${key}`);
    }
  });

  console.log(`\n${passed} checks passed${failed > 0 ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exitCode = 1;
})();
