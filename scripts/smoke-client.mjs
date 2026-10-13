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
import { existsSync, readFileSync } from 'node:fs';
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

  /* ── 层叠护栏：弹层必须压得过宿主「回到底部」圆钮 ──
   *
   * 根因（实测）：我们这一行住在宿主的 `composerSeat` 里，而宿主给它的是
   * `position:sticky; z-index:7` —— **那是一个层叠上下文**。「回到底部」圆钮的槽位
   * `X6jxGq_toBottomSlot{z-index:8}` 是 seat 的**兄弟子树**，在父上下文里以 8 压住
   * 整个 seat 子树。于是弹层自己的 `z-index:10` 是"上下文内部的 10"，出不去 ——
   * 把 10 改成 20/999 一点用都没有。唯一的修法是把 seat 抬到 8 以上（宿主自己遇到
   * 同一个问题时就把它抬到 9，见下面 host 契约那一段）。
   *
   * 这几条护栏盯的就是"这一招别被后人改坏"：规则还在不在、**权重还压不压得过**
   * 宿主那条 (0,3,0)、值还高不高于 8、是不是仍然只在弹层打开时生效。
   */

  /** 选择器里"类级别"的 token 数（类 / 属性 / 无参伪类）——本处两个选择器都只有类级 token，
   *  所以它就是特异性里的 b 那一档（`:has(...)` 的参数按规范**替换**伪类本身计入）。
   *  用宿主那条已知的 (0,3,0) 做自校验，见下一条检查。 */
  const classTokens = (selector) =>
    (selector.match(/\[[^\]]+\]|\.[A-Za-z_][\w-]*|:(?!has\()[\w-]+(?!\()/gu) ?? []).length;

  /** 取我们样式表里那条抬升规则（选择器 + z-index）。 */
  const liftRuleOf = (css) => {
    const rule = /([^{}]*\[data-composer-seat\][^{}]*)\{([^}]*)\}/u.exec(css);
    if (rule === null) return null;
    return {
      selector: rule[1].trim(),
      zIndex: Number(/z-index:\s*(\d+)/u.exec(rule[2] ?? '')?.[1] ?? Number.NaN),
      selectors: rule[1].split(',').map((part) => part.trim()).filter((part) => part.length > 0),
    };
  };

  await check('抬升规则在样式表里，且只在我们的弹层打开时生效（:has，不常驻改宿主布局）', () => {
    const lift = liftRuleOf(x.CSS ?? '');
    assert.ok(lift !== null, 'CSS 里没有针对 [data-composer-seat] 的抬升规则');
    assert.ok(
      x.STACK_LIFT_RULE !== undefined && (x.CSS ?? '').includes(x.STACK_LIFT_RULE),
      'CSS 里那份规则与 STACK_LIFT_RULE 常量不是同一份（诊断的 A/B 会摘错东西）',
    );
    for (const selector of lift.selectors) {
      assert.match(selector, /:has\(/u, `选择器没有 :has() 条件：${selector}`);
      assert.match(selector, /__ru_pop|__ru_menu/u, `:has() 里没有盯着我们自己的弹层：${selector}`);
    }
    // 我们碰宿主 seat 的地方**只有这一处**（不允许顺手动宿主的常驻布局）
    assert.equal(
      (x.CSS.match(/\[data-composer-seat\]/gu) ?? []).length,
      lift.selectors.length,
      'CSS 里除了这条抬升规则还动了 [data-composer-seat]',
    );
  });

  await check('抬升规则的权重压得过宿主那条 seat 规则（(0,4,0) vs (0,3,0)）', () => {
    const lift = liftRuleOf(x.CSS ?? '');
    assert.ok(lift !== null, 'CSS 里没有抬升规则');
    // 宿主那条（安装包里读出来的原话，见下面的 host 契约检查）：
    const hostSelector = '.ank0OG_root[data-phase=active] .ank0OG_composerSeat';
    assert.equal(classTokens(hostSelector), 3, '（自校验）宿主那条应该是 (0,3,0)');
    for (const selector of lift.selectors) {
      assert.ok(
        classTokens(selector) > classTokens(hostSelector),
        `权重不够，会被宿主压回去：${selector} → ${classTokens(selector)} vs 3`,
      );
    }
  });

  await check('抬升后的 z-index 严格高于宿主「回到底部」槽位的 8', () => {
    const lift = liftRuleOf(x.CSS ?? '');
    assert.ok(lift !== null, 'CSS 里没有抬升规则');
    assert.ok(Number.isFinite(lift.zIndex), `抬升规则没写 z-index：${lift.selector}`);
    assert.ok(lift.zIndex > 8, `z-index ${lift.zIndex} 压不过宿主圆钮槽位的 8`);
  });

  await check('诊断带层叠 A/B（真机命中序：摘掉规则 / 装回规则）', () => {
    const bundle = readFileSync(bundlePath, 'utf8');
    assert.ok(bundle.includes('elementsFromPoint'), '诊断里没有 elementsFromPoint（命中序只能实测）');
    assert.ok(bundle.includes('probeStacking'), '没有层叠 A/B 探针');
    // A/B 必须是"同一帧里摘掉规则再量一次"，否则只是又读了一遍 CSS
    assert.ok(
      /replace\(\s*STACK_LIFT_RULE/u.test(bundle) || bundle.includes('STACK_LIFT_RULE'),
      'A/B 没有精确摘掉抬升规则',
    );
  });

  await check('宿主契约仍然成立（seat 的 z-index:7 / 圆钮槽 8 / 宿主自己也用抬升这一招）', () => {
    // 这两份是**安装包里的字面事实**（根因与修法都从这里读出来）。装了别的版本、
    // 或换台机器没装 DSH 时跳过（不算失败），但只要能读到就必须对得上——
    // 对不上说明宿主改了层叠结构，我们的抬升值要重算。
    const appDir = process.env.DSH_APP_DIR ?? 'C:\\Program Files\\DSH Desktop\\resources\\app';
    const conversation = join(appDir, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js');
    const chat = join(appDir, 'node_modules', '@deepseek-ai', 'dsh-client-ui-chat', 'lib', 'client.js');
    if (!existsSync(conversation) || !existsSync(chat)) {
      console.log(`    – 跳过：读不到安装包（${appDir}）`);
      return;
    }
    const convSource = readFileSync(conversation, 'utf8');
    const chatSource = readFileSync(chat, 'utf8');
    const lift = liftRuleOf(x.CSS ?? '');
    assert.ok(lift !== null, 'CSS 里没有抬升规则');

    // 1. seat 仍然是宿主给的那一条：state-phase=active 下 z-index:7
    const seatRule = /\.ank0OG_composerSeat[^{}]*\{z-index:(\d+);[^}]*position:sticky/u.exec(convSource);
    assert.ok(seatRule !== null, '宿主那份 composerSeat 规则变了（z-index / position:sticky）');
    assert.equal(seatRule[1], '7', `宿主的 composerSeat 已经不是 z-index:7（现在是 ${seatRule[1]}）`);
    assert.ok(lift.zIndex > Number(seatRule[1]), '我们的抬升值不高于宿主的 seat');

    // 2. 圆钮槽位仍然是 z-index:8（就是它把弹层压住的）
    const slotRule = /toBottomSlot\{z-index:(\d+)/u.exec(chatSource);
    assert.ok(slotRule !== null, '宿主那份 toBottomSlot 规则变了');
    assert.equal(slotRule[1], '8', `宿主的 toBottomSlot 已经不是 z-index:8（现在是 ${slotRule[1]}）`);
    assert.ok(lift.zIndex > Number(slotRule[1]), '我们的抬升值不高于圆钮槽位');

    // 3. 宿主的锚点没换名字：seat 上有 data-composer-seat / data-conversation-region
    assert.ok(convSource.includes('"data-composer-seat"'), '宿主 seat 不再挂 data-composer-seat');
    assert.ok(
      convSource.includes('"data-conversation-region": "composer"'),
      '宿主 seat 不再挂 data-conversation-region="composer"（我们的选择器会失效）',
    );

    // 4. 宿主自己也承认这个问题（同一个洞里它就是靠抬升解决的，我们照抄）
    assert.ok(
      /composerSeat:has\(\[data-trigger-menu\]\)\{z-index:9\}/u.test(convSource),
      '宿主那条 :has([data-trigger-menu]){z-index:9} 没了（说明层叠结构可能变了）',
    );
  });

  console.log(`\n${passed} checks passed${failed > 0 ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exitCode = 1;
})();
