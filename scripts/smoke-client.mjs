/**
 * dsh-run-deck — 客户端半边的离线自测。
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

/**
 * 在一个假的 ModuleLoader 环境里取出插件导出。
 *
 * `truthyState`：把布尔型 `useState` 的初始值换成 `true`，用来渲染"展开态"
 * （「更多设置」那段只有 `more === true` 才会画出来）。只翻**布尔**初始值——
 * 把 `detection`（对象/null）也翻成 `true` 只是假状态，不是真实渲染路径。
 * 组件函数可以这样直接调用：我们的假 React 只把 JSX 收成一棵普通对象树。
 *
 * `interactive`：给 useState 一个**真的存状态**的实现（state 槽位跨渲染保活），
 * 并交一个 `flushComponent(component, props)`——把挂起的 setter 从"重新渲染"
 * 里放出来。事件从渲染树里取 onClick/onMouseEnter 再手动触发 + flush，
 * 就能测"点删除 → 出现二次确认"这类纯靠"渲染不抛错"盖不到的状态流。
 * bundle 里的组件闭包的就是这份 react——**这不能事后注入**，所以交互检查必须
 * 用自己的这一次装载，不能复用 `x`（那次装载是静态 react）。
 */
function loadPlugin(options = {}) {
  const truthyState = options.truthyState === true;
  const interactive = options.interactive === true;
  /** interactive 模式的 state / ref 槽位：跨渲染保活（同一个组件身份）。 */
  const slots = [];
  const refs = [];
  let index = 0;
  let dirty = true;
  const react = {
    Fragment: Symbol('dsh-run-deck.smoke.fragment'),
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => {
      const slot = index++;
      if (interactive) {
        if (slots[slot] === undefined) {
          slots[slot] =
            truthyState && typeof initial === 'boolean'
              ? true
              : typeof initial === 'function'
                ? initial()
                : initial;
        }
        return [
          slots[slot],
          (value) => {
            slots[slot] = typeof value === 'function' ? value(slots[slot]) : value;
            dirty = true;
          },
        ];
      }
      return [
        truthyState && typeof initial === 'boolean'
          ? true
          : typeof initial === 'function'
            ? initial()
            : initial,
        () => {},
      ];
    },
    useRef: (value) => {
      if (!interactive) return { current: value };
      const slot = index++;
      if (refs[slot] === undefined) refs[slot] = { current: value };
      return refs[slot];
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
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
  const flushComponent = (component, props) => {
    assert.equal(typeof component, 'function', 'flushComponent 需要一个组件函数');
    let tree;
    while (true) {
      index = 0;
      tree = component(props);
      if (!dirty) break;
      dirty = false;
    }
    return tree;
  };
  return { exported, registration, react, window: window2, flushComponent };
}

/**
 * 交互级渲染引擎：装载一份**交互模式**的插件包，然后在它上面驱动 `componentName`
 * 指到的组件做事件重放。
 *
 * 组件仍是纯函数调用（不是真的 DOM 渲染）——事件从渲染树里把 onClick /
 * onMouseEnter / onMouseLeave **手动取出来触发**，触发完 flush 挂起的状态变更，
 * 拿到新的一棵树。这样就能测"点删除 → 出现二次确认 → 确认才动手"、"悬停出卡 →
 * 拿开收卡"这类纯靠"渲染不抛错"盖不到的状态流。
 *
 * 定时器（收卡的 160ms 延迟）用真 setTimeout：setter 只把 dirty 立起，画面要等
 * 下一次手动 flush 才会画出来——所以定时器到点后要再调一次 flush。
 *
 * 关键约束：bundle 里组件闭包的 React 在**装载那一刻**就定死了，不能事后注入。
 * 所以每次 mount 都重新装载一次插件包（十几 KB 的求值，成本可以忽略），
 * 组件闭包住的就是会存状态的那份 react。
 */
function mountInteractions(componentName, props) {
  const { exported, flushComponent } = loadPlugin({ interactive: true });
  const internals = exported.internals ?? {};
  const component = internals[componentName];
  assert.equal(typeof component, 'function', `${componentName} 不在 internals 上`);
  const flush = () => flushComponent(component, props);
  const walk = (node, visit) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, visit);
      return;
    }
    if (typeof node !== 'object') return;
    visit(node);
    walk(node.children, visit);
  };
  const inTree = (tree, predicate) => {
    const found = [];
    walk(tree, (node) => {
      if (predicate(node)) found.push(node);
    });
    return found;
  };
  const buttonText = (node) => {
    const out = [];
    const collect = (value) => {
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (typeof value === 'string') {
        out.push(value);
        return;
      }
      if (value !== null && typeof value === 'object') collect(value.children);
    };
    collect(node.children);
    return out.join('').trim();
  };
  return {
    /** getter：永远返回最新一次 flush 画出的树（旧引用是过期画面）。 */
    get tree() {
      return flush();
    },
    /** 手动触发树下某次已有事件后再 ask 一次 flush 用（见各检查里的调用）。 */
    flush,
    internals,
    walk,
    inTree,
    buttonsIn: (tree) => inTree(tree, (node) => node.type === 'button'),
    cardsIn: (tree, cardType) => inTree(tree, (node) => node.type === cardType),
    buttonText,
  };
}

console.log('dsh-run-deck client smoke');

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

  await check('浮动条的组件都在（含新建/管理面板、失败原因面板与输出悬浮卡）', () => {
    for (const name of ['FloatingBar', 'FloatingBarHost', 'AddPanel', 'ManagePanel', 'SettingsPanel', 'ErrorPanel', 'RunPreviewCard']) {
      assert.equal(typeof x[name], 'function', `${name} 不是函数`);
    }
  });

  await check('＋＝只负责新建、☰＝管理（排序 + 收起 + 删除）', () => {
    for (const key of ['createTitle', 'createHint', 'manageTitle', 'deleteEntry', 'deleteConfirm', 'deleteCancel']) {
      assert.ok(Object.keys(x.ZH).includes(key), `ZH 缺 ${key}`);
      assert.ok(Object.keys(x.EN).includes(key), `EN 缺 ${key}`);
    }
  });

  await check('0 个条目时 ☰ 管理仍能打开：按钮不禁用，面板给出空状态说明', () => {
    const plugin = loadPlugin();
    const internals = plugin.exported.internals;
    const runtime = { t: (key) => internals.ZH[key] ?? key };
    /** FloatingBar / ManagePanel 渲染需要的那组 props（不会被触发的回调给空实现）。 */
    const props = {
      buttons: [],
      runs: [],
      density: 'full',
      runtime,
      busy: null,
      actions: { onRun: async () => ({ ok: true }), onStop: async () => ({ ok: true }) },
      onCycleDensity: () => {},
      onOpenAdd: () => {},
      onOpenManage: () => {},
      onOpenSettings: () => {},
      onOpenError: () => {},
      onOpenOverflow: () => {},
      openPanel: 'none',
      onClosePanel: () => {},
      entries: [],
      projectRoot: 'D:/p',
      warnings: [],
      capabilities: { subprocess: true },
      hostVersion: '0.0.0',
      configSource: 'test',
      onReorder: async () => {},
      onPin: async () => {},
      onCreateTask: async () => ({ ok: true, entry: 'x' }),
      onDeleteTask: async () => ({ ok: true }),
      lastError: null,
      pinnedEntry: null,
      onTogglePin: () => {},
    };

    /** 摊平 JSX 对象树，逐节点判断（假 React 不渲染，只产出普通对象）。 */
    const walk = (node, visit) => {
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, visit);
        return;
      }
      if (typeof node !== 'object') return;
      visit(node);
      walk(node.children, visit);
    };

    // ☰ 按钮：0 个条目时不能再是 disabled（否则点了没反应，用户分不清是空还是坏了）。
    let manage = null;
    walk(internals.FloatingBar(props), (node) => {
      if (node.type === 'button' && node.props?.onClick === props.onOpenManage) manage = node;
    });
    assert.ok(manage !== null, '没有找到 ☰ 管理按钮');
    assert.notEqual(manage.props.disabled, true, '0 个条目时 ☰ 被禁用了，管理面板打不开');

    // 面板打开后不是一片空白：要说明"这个目录还没有启动项"。
    const texts = [];
    walk(internals.ManagePanel(props), (node) => {
      for (const child of node.children ?? []) {
        if (typeof child === 'string') texts.push(child);
      }
    });
    assert.ok(
      texts.includes(internals.ZH.noEntriesNote),
      `管理面板没有显示空状态说明（实际文本：${JSON.stringify(texts)}）`,
    );
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
      'overflow', 'add', 'settings', 'createTitle', 'createHint', 'manageTitle',
      'addPinned', 'addUnpinned',
      'addPin', 'addHide', 'settingsTitle', 'settingsDensity', 'settingsRuns',
      'settingsWarnings', 'settingsCapability', 'noFocus',
      // 失败原因面板（点"启动失败"看到的是原因，不是设置界面）
      'errorTitle', 'errorHint', 'errorOpenSettings', 'errorClose',
    ]) {
      assert.ok(zh.includes(key), `ZH 缺 ${key}`);
      assert.ok(Object.keys(x.EN).includes(key), `EN 缺 ${key}`);
    }
  });

  await check('输出悬浮卡：样式卡上、文案中英各一份（含图钉那一对）', () => {
    const css = String(x.CSS ?? '');
    assert.ok(css.includes('.__ru_outView'), 'CSS 缺 .__ru_outView');
    assert.ok(css.includes('.__ru_hover'), 'CSS 缺 .__ru_hover');
    assert.ok(css.includes('.__ru_pinBtn'), 'CSS 缺 .__ru_pinBtn');
    for (const key of ['output', 'outputEmpty', 'outputHint', 'pin', 'unpin', 'pinStateOn', 'pinStateOff']) {
      assert.ok(Object.keys(x.ZH).includes(key), `ZH 缺 ${key}`);
      assert.ok(Object.keys(x.EN).includes(key), `EN 缺 ${key}`);
    }
  });

  /* ── 交互级：管理面板的删除二次确认 ── */

  const zh = (key) => x.ZH[key] ?? key;
  const baseBarProps = {
    buttons: [],
    runs: [],
    density: 'full',
    runtime: { t: zh },
    busy: null,
    actions: { onRun: async () => ({ ok: true }), onStop: async () => ({ ok: true }) },
    onCycleDensity: () => {},
    onOpenAdd: () => {},
    onOpenManage: () => {},
    onOpenSettings: () => {},
    onOpenError: () => {},
    onOpenOverflow: () => {},
    openPanel: 'none',
    onClosePanel: () => {},
    entries: [],
    projectRoot: 'D:/p',
    warnings: [],
    capabilities: { subprocess: true },
    hostVersion: '0.0.0',
    configSource: 'test',
    onReorder: async () => {},
    onPin: async () => {},
    onCreateTask: async () => ({ ok: true, entry: 'x' }),
    onDeleteTask: async () => ({ ok: true }),
    lastError: null,
    pinnedEntry: null,
    onTogglePin: () => {},
  };

  await check('管理面板的删除有二次确认：直接删除不动手、取消回得来、确认只删那一条', async () => {
    const entries = [
      {
        id: 'piscellum/launch',
        label: '启动 Piscellum',
        command: 'cmd',
        args: ['/c', 'bin\\启动全套.bat'],
        cwd: 'D:/p',
      },
      {
        id: 'piscellum/client',
        label: '只启动客户端',
        command: 'piscellum.exe',
        args: [],
        cwd: 'D:/p/bin/client',
      },
    ];
    const buttons = [
      { entry: 'piscellum/launch', icon: 'play', group: '运行', order: 10, projectRoot: 'D:/p', entryLabel: '启动 Piscellum' },
      { entry: 'piscellum/client', icon: 'desktop', group: '运行', order: 20, projectRoot: 'D:/p', entryLabel: '只启动客户端' },
    ];
    const calls = { delete: [], pin: [] };
    const props = {
      ...baseBarProps,
      buttons,
      entries,
      onPin: async (entry, pinned) => {
        calls.pin.push([entry, pinned]);
        return { ok: true };
      },
      onDeleteTask: async (entry) => {
        calls.delete.push(entry);
        return { ok: true };
      },
    };
    const m = mountInteractions('ManagePanel', props);
    const confirmButtons = () => m.buttonsIn(m.tree).filter((node) => m.buttonText(node) === x.ZH.deleteConfirm);
    const deleteButtons = () => m.buttonsIn(m.tree).filter((node) => m.buttonText(node) === x.ZH.deleteEntry);
    assert.equal(deleteButtons().length, 2, '每一行一个「删除」');
    assert.equal(confirmButtons().length, 0, '初始不该出现「确认删除」');

    // 点「删除」只是进入确认态：不碰 onDeleteTask
    deleteButtons()[0].props.onClick();
    m.flush();
    assert.equal(calls.delete.length, 0, '二次确认之前不许碰 onDeleteTask');
    assert.equal(confirmButtons().length, 1, '「删除」变成了「确认删除 / 取消」');

    // 取消：退回普通行，什么都没删
    m.buttonsIn(m.tree).filter((node) => m.buttonText(node) === x.ZH.deleteCancel)[0].props.onClick();
    m.flush();
    assert.equal(confirmButtons().length, 0, '取消后确认按钮要消失');
    assert.equal(calls.delete.length, 0, '取消没有删任何任务');

    // 复进确认态、这次真的确认：只删被确认的那一条（第一行 = piscellum/launch）
    deleteButtons()[0].props.onClick();
    m.flush();
    confirmButtons()[0].props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    m.flush();
    assert.deepEqual(calls.delete, ['piscellum/launch'], `确认的删除只对那一条：${JSON.stringify(calls.delete)}`);
    assert.equal(confirmButtons().length, 0, '确认完退回普通行');

    // 行内图钉：已钉行的按钮是「从按钮条收起」，点击 → onPin(entry, false)
    const hideBtn = m.buttonsIn(m.tree).find((node) => m.buttonText(node) === x.ZH.addHide);
    assert.ok(hideBtn, '已钉行应当显示「从按钮条收起」');
    hideBtn.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls.pin[0], ['piscellum/launch', false], '点「收起」调用的是 onPin(entry, false)');
  });

  /* ── 交互级：输出悬浮卡 ── */

  await check('输出悬浮卡：未钉 = 📌 普通卡 / 已钉 = 📍 品牌色描边；空 run 给空态；图钉回调到位', () => {
    const run = {
      runId: 'r1',
      entryId: 'piscellum/launch',
      projectRoot: 'D:/p',
      label: '启动 Piscellum',
      status: 'running',
      tail: ['[启动] ready http://127.0.0.1:8800'],
    };
    const toggled = [];
    const clickPin = () => toggled.push('pin');
    const hover = () => {};
    const leave = () => {};

    // 未钉：类是普通 hover 卡；按钮文字说"钉住"、aria-pressed=false、点击回调
    const unPinned = mountInteractions('RunPreviewCard', {
      run,
      runtime: { t: zh },
      pinned: false,
      left: 12,
      onTogglePin: clickPin,
      onPreviewEnter: hover,
      onPreviewLeave: leave,
    });
    assert.equal(unPinned.tree.props.className, '__ru_pop __ru_hover', '未钉时不该有品牌色描边的类');
    const unPinBtn = unPinned.buttonsIn(unPinned.tree)[0];
    assert.ok(unPinBtn, '头部有一个图钉按钮');
    assert.equal(unPinBtn.props['aria-pressed'], false);
    assert.equal(unPinBtn.props.title, x.ZH.pin);
    unPinBtn.props.onClick();
    assert.deepEqual(toggled, ['pin'], '点图钉要触发 onTogglePin');
    // 悬浮卡上的悬停/拿开也要接到卡本身（卡内移动鼠标不该让卡闪断）
    assert.equal(typeof unPinned.tree.props.onMouseEnter, 'function', '卡缺 onMouseEnter 接线');
    assert.equal(typeof unPinned.tree.props.onMouseLeave, 'function', '卡缺 onMouseLeave 接线');
    // 输出内容走 tail 那条路
    const pre = unPinned.inTree(unPinned.tree, (node) => node.type === 'pre')[0];
    assert.match(
      unPinned.buttonText(pre) ?? '',
      /ready http:/,
      'run.tail 的输出应该出现在输出面板里',
    );

    // 已钉：卡有品牌色描边、aria-pressed=true、文案与 tooltip 都说"已钉住"
    const pinned = mountInteractions('RunPreviewCard', {
      run,
      runtime: { t: zh },
      pinned: true,
      left: 12,
      onTogglePin: () => {},
      onPreviewEnter: hover,
      onPreviewLeave: leave,
    });
    assert.equal(
      pinned.tree.props.className,
      '__ru_pop __ru_hover __ru_hoverPinned',
      '已钉卡的品牌色描边类要挂上',
    );
    const pinBtn = pinned.buttonsIn(pinned.tree)[0];
    assert.equal(pinBtn.props['aria-pressed'], true);
    assert.equal(pinBtn.props.title, x.ZH.unpin);
    assert.ok(pinned.buttonText(pinBtn).includes(x.ZH.pinStateOn), '按下去的钉要写"已钉住"');

    // 无 run：给空态文案（run 缺席走 settingsNoRuns 那句），不给状态徽章
    const empty = mountInteractions('RunPreviewCard', {
      run: undefined,
      runtime: { t: zh },
      pinned: false,
      left: 12,
      onTogglePin: () => {},
      onPreviewEnter: hover,
      onPreviewLeave: leave,
    });
    const emptyPre = empty.inTree(empty.tree, (node) => node.type === 'pre')[0];
    assert.ok(
      empty.buttonText(emptyPre).includes(x.ZH.settingsNoRuns),
      `没有 run 要显示空态说明（实际：${empty.buttonText(emptyPre)}）`,
    );
  });

  /* ── 交互级：浮动条悬停接线 ── */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  await check('浮动条悬停接线：活动按钮悬停出卡、图钉回调带上条目、拿开过了缓冲就收卡', async () => {
    const buttons = [
      { entry: 'piscellum/launch', icon: 'play', group: '运行', order: 10, projectRoot: 'D:/p', entryLabel: '启动 Piscellum', active: true, status: 'running' },
      { entry: 'piscellum/client', icon: 'desktop', group: '运行', order: 20, projectRoot: 'D:/p', entryLabel: '只启动客户端', active: true, status: 'running' },
    ];
    const runs = [
      { runId: 'r1', entryId: 'piscellum/launch', projectRoot: 'D:/p', label: '启动 Piscellum', status: 'running', tail: ['[启动] ready http://x'] },
      { runId: 'r2', entryId: 'piscellum/client', projectRoot: 'D:/p', label: '只启动客户端', status: 'running', tail: ['client up'] },
    ];
    const toggled = [];
    const props = {
      ...baseBarProps,
      buttons,
      runs,
      pinnedEntry: null,
      onTogglePin: (entry) => toggled.push(entry),
    };
    const m = mountInteractions('FloatingBar', props);
    const cards = () => m.cardsIn(m.tree, m.internals.RunPreviewCard);
    assert.equal(cards().length, 0, '没悬停时不该出卡');

    // 悬停在第一条活动按钮上：卡出现，卡里就是它的 run
    const hoverBtn = m.buttonsIn(m.tree).find((node) => typeof node.props.onMouseEnter === 'function');
    assert.ok(hoverBtn, '活动按钮应有悬停接线');
    hoverBtn.props.onMouseEnter({ currentTarget: { offsetLeft: 42 } });
    m.flush();
    assert.equal(cards().length, 1, `悬停要出卡：${cards().length}`);
    assert.equal(cards()[0].props.run.label, '启动 Piscellum', '卡里带的是这条 run');
    // 图钉动作从卡上直接可触发，回调带上条目 id
    cards()[0].props.onTogglePin();
    assert.deepEqual(toggled, ['piscellum/launch'], '图钉回调要带条目 id');

    // 拿开鼠标：卡片仍有 ~160ms 缓冲，过了缓冲再 flush 卡就收起
    hoverBtn.props.onMouseLeave();
    m.flush();
    assert.equal(cards().length, 1, '缓冲期内卡还在');
    await sleep(260);
    m.flush();
    assert.equal(cards().length, 0, '拿开且过了缓冲，卡应该收起');
  });

  await check('弹层按「条上方实际可用高度」封顶（新会话输入框居中时顶部不被裁掉）', () => {
    assert.equal(typeof x.popupSpaceFor, 'function', 'popupSpaceFor 不在 internals 上');
    assert.equal(x.POPUP_OFFSET, 8, 'JS 里的缝与 CSS 锚点的 8px 不是同一个数');
    assert.equal(x.POPUP_SPACE_VAR, '--ru-pop-space');

    // 600 - 8（缝）- 12（顶部留白）= 580
    assert.equal(x.popupSpaceFor(600), 580);
    // 最近的裁切祖先（宿主滚动容器）顶边在 76px 处：还要再扣掉 header 那一段
    assert.equal(x.popupSpaceFor(600, 76), 504);
    // 条已经贴到上沿 / 跑到视口外：给 0，不能给负数（负的 max-height 会被当成没设上限）
    assert.equal(x.popupSpaceFor(96, 76), 0);
    assert.equal(x.popupSpaceFor(20), 0);
    // 裁切祖先在视口外（整页滚动）时按视口上沿算
    assert.equal(x.popupSpaceFor(600, -40), 580);

    const css = String(x.CSS ?? '');
    assert.ok(css.includes('bottom:calc(100% + 8px)'), '弹层锚点的缝与 POPUP_OFFSET 不一致');
    assert.ok(css.includes(`var(${x.POPUP_SPACE_VAR},100vh)`), 'CSS 没有引用可用高度变量');

    const ruleOf = (selector) => {
      const start = css.indexOf(selector);
      assert.ok(start >= 0, `CSS 缺 ${selector}`);
      const end = css.indexOf('}', start);
      assert.ok(end > start, `CSS 里 ${selector} 没有闭合`);
      return css.slice(start, end + 1);
    };
    for (const selector of ['.__ru_pop{', '.__ru_pop.__ru_popTall{', '.__ru_hover{', '.__ru_menu{']) {
      assert.match(
        ruleOf(selector),
        /max-height:[^;}]*var\(--ru-pop-space/u,
        `${selector} 没有按条上方的可用高度封顶（新会话里会被裁掉顶部）`,
      );
    }

    // 变量必须真的写进去：CSS 里声明了 var() 但没人赋值，就会一直走 100vh 的兜底。
    const bundle = readFileSync(bundlePath, 'utf8');
    assert.match(bundle, /setProperty\(POPUP_SPACE_VAR/u, '没有把量到的可用高度写进 CSS 变量');
  });

  await check('条永远在：没有按钮/没有清单时也保留条与 + 入口', () => {
    const css = String(x.CSS ?? '');
    assert.ok(css.includes('.__ru_emptyNote'), 'CSS 缺 .__ru_emptyNote（条要留住，中间给说明）');
    for (const key of ['allHiddenNote', 'noEntriesNote', 'noProjectNote', 'noManifestNote', 'restoreAll']) {
      assert.ok(Object.keys(x.ZH).includes(key), `ZH 缺 ${key}`);
      assert.ok(Object.keys(x.EN).includes(key), `EN 缺 ${key}`);
    }
  });

  await check('「+」面板：字段控件、检测候选与分段结构都在包里（文案中英各一份）', () => {
    const css = String(x.CSS ?? '');
    for (const cls of ['__ru_advanced', '__ru_chip', '__ru_moreToggle', '__ru_textarea', '__ru_field', '__ru_panel']) {
      assert.ok(css.includes(`.${cls}`), `CSS 缺 .${cls}`);
    }
    for (const key of [
      'fieldName', 'fieldCommand', 'fieldCwd', 'fieldEnv', 'fieldId', 'fieldGroup',
      'fieldBackground', 'fieldReady', 'fieldOpenUrl', 'fieldUrlPattern', 'fieldUriFormat',
      'fieldReveal', 'fieldOnReady', 'fieldIcon', 'fieldButtonGroup',
      'detectTitle', 'detectHint', 'detectLoading', 'detectEmpty', 'detectExists', 'detectTemplates',
      'moreShow', 'moreHide', 'copyTitle', 'copyPlaceholder', 'commandSplitHint', 'createdNote',
    ]) {
      assert.ok(Object.keys(x.ZH).includes(key), `ZH 缺 ${key}`);
      assert.ok(Object.keys(x.EN).includes(key), `EN 缺 ${key}`);
    }
  });

  await check('「+」面板能渲染：基础两栏 / 探测区块 / 展开后的字段都不抛错', () => {
    /** 把假 React 的 JSX 对象树摊平成"类名集合 + 文本数组"。 */
    const collect = (tree) => {
      const classes = new Set();
      const texts = [];
      const walk = (node) => {
        if (node === null || node === undefined) return;
        if (typeof node === 'string') {
          texts.push(node);
          return;
        }
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        if (typeof node !== 'object') return;
        const nodeProps = node.props;
        const cls = nodeProps === null || nodeProps === undefined ? undefined : nodeProps.className;
        if (typeof cls === 'string') {
          for (const name of cls.split(/\s+/u)) classes.add(name);
        }
        walk(node.children);
      };
      walk(tree);
      return { classes, texts };
    };

    /** 面板真正用到的 props（其余字段它不读）。 */
    const harness = (plugin) => {
      const internals = plugin.exported.internals;
      return {
        internals,
        props: {
          entries: [],
          runtime: { t: (key) => internals.ZH[key] ?? key, locale: 'zh' },
          projectRoot: 'D:/p',
          onClosePanel: () => {},
          onCreateTask: async () => ({ ok: true, entry: 'x' }),
        },
      };
    };

    // 收起态：基础两栏 + 探测区块 + 「展开更多设置」
    const closed = harness(loadPlugin());
    const collapsed = collect(closed.internals.AddPanel(closed.props));
    for (const cls of ['__ru_field', '__ru_fieldLabel', '__ru_panel', '__ru_moreToggle']) {
      assert.ok(collapsed.classes.has(cls), `收起态缺 ${cls}`);
    }
    assert.equal(collapsed.classes.has('__ru_advanced'), false, '收起态不该画更多设置');
    assert.ok(collapsed.texts.includes(closed.internals.ZH.fieldName), '缺名称那一栏');
    assert.ok(collapsed.texts.includes(closed.internals.ZH.fieldCommand), '缺命令行那一栏');

    // 展开态：那些"以前只能手改文件"的字段必须真的出现在渲染树里
    const opened = harness(loadPlugin({ truthyState: true }));
    const expanded = collect(opened.internals.AddPanel(opened.props));
    for (const cls of ['__ru_advanced', '__ru_textarea', '__ru_select', '__ru_check']) {
      assert.ok(expanded.classes.has(cls), `展开态缺 ${cls}`);
    }
    for (const key of ['fieldCwd', 'fieldEnv', 'fieldReady', 'fieldOpenUrl', 'fieldOnReady', 'fieldIcon']) {
      assert.ok(
        expanded.texts.includes(opened.internals.ZH[key]),
        `展开态缺字段 ${key}（文案在字典里不等于字段画出来了）`,
      );
    }
  });

  await check('parseEnvLines：KEY=value 每行一条，坏行把原文指出来', () => {
    const ok = x.parseEnvLines('A=1\n# 注释\n\nB = two words ');
    assert.equal(ok.error, undefined);
    assert.deepEqual(ok.env, { A: '1', B: 'two words' });
    // 空值也是合法的一条（清空变量很有用）
    assert.deepEqual(x.parseEnvLines('EMPTY=').env, { EMPTY: '' });
    // 坏行：不给"第几行"，给原文（文本框会折行，数行数容易数错）
    assert.equal(x.parseEnvLines('A=1\nnope\nB=2').error, 'nope');
    assert.equal(x.parseEnvLines('=1').error, '=1');
  });

  await check('quoteArgument：复制已有条目时含空格的参数补引号', () => {
    assert.equal(x.quoteArgument('dev'), 'dev');
    assert.equal(x.quoteArgument('a b'), '"a b"');
    assert.equal(x.quoteArgument('say "hi"'), '"say \\"hi\\""');
  });
  await check('ansiSpans：颜色转样式片段；光标/擦除序列不留字形；颜色跨行延续', () => {
    const parts = x.ansiSpans([
      '\u001B[32m✓ ready\u001B[0m Plain',
      '\u001B[2K\u001B[1;34mhttp://x/\u001B[0m',
    ]);
    // 两行 → 片段序列里必须**有一个换行片段**（第 3 个）
    assert.equal(parts.length, 4, JSON.stringify(parts));
    assert.equal(parts[0].text, '✓ ready');
    assert.equal(parts[0].fg, '#98c379');
    assert.equal(parts[1].text, ' Plain');
    assert.equal(parts[1].fg, undefined, 'ESC[0m 重置后要回到字色');
    assert.equal(parts[2].text, '\n', '行与行之间必须有换行，否则整段输出会挤成一行');
    assert.equal(parts[2].fg, undefined, '换行片段不带颜色');
    assert.equal(parts[3].bold, true, '1;34m → 粗体+蓝');
    assert.equal(parts[3].fg, '#61afef');
    assert.ok(!JSON.stringify(parts).includes('2K'), '擦除序列不该变成可见字形');
    // 跨行延续：上一行没重置，下一行还是红的
    const carry = x.ansiSpans(['\u001B[31mRed', ' still red\u001B[0m']);
    assert.equal(carry.length, 3);
    assert.equal(carry[0].fg, '#e06c75');
    assert.equal(carry[2].fg, '#e06c75');
    // 空行也要保住（脚本用它分节/对齐，丢掉它同样是"换行没了"）
    const blank = x.ansiSpans(['a', '', 'b']);
    assert.equal(blank.map((part) => part.text).join(''), 'a\n\nb');
    // 总不变量：片段拼起来的文本 === 行用 \n 拼起来的文本（悬浮卡就靠这个换行）；
    // 颜色码本身要被剥掉，所以拿"剥完色的期望值"比。
    const lines = ['one', '\u001B[32mtwo\u001B[0m', '', '   indented  three'];
    assert.equal(
      x.ansiSpans(lines).map((part) => part.text).join(''),
      'one\ntwo\n\n   indented  three',
    );
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

  /* ── 拖拽排序护栏（"拖起来只有一个虚影"的根因是原生 HTML5 拖放）──
   *
   * 原生 `draggable` 的行为：浏览器给**拖源元素**（那个只有 4 个字形的 `⋮⋮` 手柄）
   * 拍一张半透明快照当拖影、由系统绘制；真正的行留在原地只变淡；顺序只在 `drop`
   * 那一刻才改（拖动中没有即时预览、没有让位动画）；拖影的透明度/动画不受页面控制。
   *
   * 现在是指针事件自己实现：下面这几个纯函数就是"即拖即预览"的全部数学，
   * 离线逐值验；"不再有原生拖放"则由下面那条包体检查盯着。
   */

  await check('moveInOrder：往上/往下各挪一次，不改原数组，from===to 原样', () => {
    const { moveInOrder } = x;
    assert.equal(typeof moveInOrder, 'function', 'moveInOrder 不在 internals 上');
    const list = ['a', 'b', 'c', 'd'];
    assert.deepEqual(moveInOrder(list, 0, 2), ['b', 'c', 'a', 'd']);
    assert.deepEqual(moveInOrder(list, 3, 1), ['a', 'd', 'b', 'c']);
    assert.deepEqual(moveInOrder(list, 1, 1), list);
    assert.deepEqual(list, ['a', 'b', 'c', 'd'], 'moveInOrder 改了原数组');
  });

  await check('restTops：行高 + 行距的累积 top', () => {
    const { restTops } = x;
    assert.deepEqual(restTops([36, 36, 36], 6), [0, 42, 84]);
    assert.deepEqual(restTops([10, 30, 20], 6), [0, 16, 52]);
    assert.deepEqual(restTops([], 6), []);
  });

  await check('dropIndexFor：落点 = 被拖行中心越过谁的"静止中点"', () => {
    const { dropIndexFor } = x;
    assert.equal(typeof dropIndexFor, 'function', 'dropIndexFor 不在 internals 上');
    const equal = [36, 36, 36];
    // 等行高 36 + 行距 6 = 步长 42；第 1 行的中点是 60，被拖行起点中心是 18。
    assert.equal(dropIndexFor(equal, 6, 0, 0), 0);
    assert.equal(dropIndexFor(equal, 6, 0, 41), 0, '还没越过中点就不该落位');
    assert.equal(dropIndexFor(equal, 6, 0, 43), 1, '越过第 1 行中点 → 落到第 1 位');
    assert.equal(dropIndexFor(equal, 6, 0, 85), 2);
    assert.equal(dropIndexFor(equal, 6, 0, 9999), 2, '拖到列表外应该夹在最后一位');
    assert.equal(dropIndexFor(equal, 6, 2, -9999), 0, '往上拖到列表外应该夹在第 0 位');
    assert.equal(dropIndexFor(equal, 6, 1, 0), 1);
    // 行高不一致时按各自的中点算（不是按"步长"）：[10,30,20] 的中点 31 与 62
    const mixed = [10, 30, 20];
    assert.equal(dropIndexFor(mixed, 6, 0, 30), 1);
    assert.equal(dropIndexFor(mixed, 6, 0, 60), 2);
    assert.equal(dropIndexFor(mixed, 6, 2, -32), 1);
    assert.equal(dropIndexFor(mixed, 6, 2, -60), 0);
  });

  await check('previewOffsets：让位的位移用累积高度算（行高不一致也对齐）', () => {
    const { previewOffsets } = x;
    assert.equal(typeof previewOffsets, 'function', 'previewOffsets 不在 internals 上');
    // 等行高：往下挪一位 → 只有被让的那一行上移一个步长
    assert.deepEqual(previewOffsets([36, 36, 36], 6, 0, 1), [42, -42, 0]);
    assert.deepEqual(previewOffsets([36, 36, 36], 6, 2, 0), [42, 42, -84]);
    // 行高不一致：被拖行高 10 + 行距 6 = 16，让位的两行各上移 16
    assert.deepEqual(previewOffsets([10, 30, 20], 6, 0, 2), [62, -16, -16]);
    assert.deepEqual(previewOffsets([10, 30, 20], 6, 2, 0), [26, 26, -52]);
    // 落点没变就没有位移（不然"点一下"也会动）
    assert.deepEqual(previewOffsets([36, 36, 36], 6, 1, 1), [0, 0, 0]);
  });

  await check('拖拽排序不再用原生 HTML5 拖放（虚影的根因），改指针事件 + 过渡', () => {
    const bundle = readFileSync(bundlePath, 'utf8');
    // 注意：不能按裸词查——上面那段解释"为什么不用原生拖放"的注释里就写着 draggable。
    // JSX 属性在编译产物里是对象键（`draggable: true`），所以按 `名字:` 查。
    for (const dead of ['draggable', 'onDragStart', 'onDragOver', 'onDrop', 'onDragEnd']) {
      assert.ok(
        !new RegExp(`\\b${dead}\\s*:`, 'u').test(bundle),
        `包里还有原生拖放的 ${dead}（浏览器会自己画半透明拖影）`,
      );
    }
    assert.ok(!bundle.includes('dataTransfer'), '包里还有原生拖放的 dataTransfer');
    assert.ok(!/__ru_rowDragging\{opacity/u.test(bundle), '还在用"原位置变淡"表示正在拖');
    // 正面要求：指针捕获（移出元素还能拖）、让位过渡、落位过渡
    assert.ok(bundle.includes('setPointerCapture'), '没有 setPointerCapture：移出元素就断');
    assert.ok(bundle.includes('onPointerMove'), '没有 pointermove 处理');
    assert.ok(bundle.includes('__ru_rowShift'), '没有"其余各行让位"的过渡类');
    assert.ok(bundle.includes('__ru_rowSettle'), '没有"松手滑进槽位"的过渡类');
    // 诊断：每次拖动都要在宿主日志里留一行（读不到就没法查"为什么落点不对"）
    assert.ok(bundle.includes('drag-start') && bundle.includes('drag-end'), '拖拽没有诊断上报');
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
