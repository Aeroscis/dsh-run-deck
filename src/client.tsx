/**
 * dsh-rundeck — client half（TSX 源文件）。
 *
 * 构建产物：`client/client.js`（ModuleLoader 包，见 scripts/build-client.mjs）。
 *
 * ## 形态
 *
 * 一条按钮条，注册在 **`conversation.input.overlay`**——宿主的**会话级**插槽，
 * 位置在输入框卡片的上沿、与输入框同宽。
 *
 * 为什么是这个插槽（换过三次，记下结论）：
 *   1. 宿主没有"浮在 composer 上沿"的插槽，自己量 DOM 定位（旧方案）需要
 *      `data-composer-card` 之类的选择器 + ResizeObserver，脆且难调试；
 *   2. **会话级插槽会把 `sessionId` 直接交给组件**（见 dsh-client-ui-jobs 的
 *      `JobListAction({ sessionId, ... })`）。`shell.overlay` 是应用级的，
 *      拿不到会话 id，只能猜——而"跟着当前工作区变"正是靠会话 id 推 cwd；
 *   3. 插槽由宿主排版 → 输入框变宽变窄自动跟随，不需要任何几何测量。
 *
 * 宽度不够时**逐级降档**：full（图标+名字）→ compact（图标+定长截断）→
 * icon（纯图标）→ `⋯` 溢出菜单。顺序即优先级，顺序来自 `+` 面板里的拖拽。
 *
 * 与 host 的唯一数据通道是 `fetch("/dsh-rundeck/api/*")`，见 src/routes.ts。
 */
import React from 'react';

import type {
  ApiResult,
  ButtonDensity,
  FloatingButtonView,
  ResolvedEntry,
  RundeckState,
} from './types.js';

const NS = 'dsh-rundeck';
const API = '/dsh-rundeck/api';

/** 客户端上下文（只列出本插件使用的部分；服务全部按可选获取）。 */
interface ClientContext {
  readonly logger?: DshLogger;
  get<T = unknown>(name: string): T | undefined;
  effect(callback: () => void | (() => void), label?: string): unknown;
}

/**
 * 客户端半边的版本 —— **构建期注入，不要手写**。
 * `__DSH_PLUGIN_VERSION__` 是 `scripts/build-client.mjs` 的替换点。
 */
const CLIENT_VERSION = '__DSH_PLUGIN_VERSION__';

/**
 * compact 档下任务名的固定截断长度。
 *
 * 12 → 8：绝大多数标签（`全量检查`=4、`重建客户端包`=6）都够不到 12，
 * 于是"截断"这个动作永远不发生、紧凑档跟完整档长得一样。8 字让长标签真的变短，
 * 但短标签的差别仍然靠紧凑档的胶囊尺寸（见 CSS 里 `[data-density="compact"]`）。
 */
const COMPACT_MAX_CHARS = 8;

/* ─────────────────────────── 文案 ─────────────────────────── */

const ZH: Record<string, string> = {
  run: '跑',
  stop: '停',
  running: '运行中',
  ready: '就绪',
  exited: '已退出',
  starting: '启动中',
  stopping: '停止中',
  runFailed: '启动失败',
  stopFailed: '停止失败',
  saveFailed: '保存失败',
  densityFull: '完整信息',
  densityCompact: '紧凑',
  densityIcon: '仅图标',
  densityCycle: '点击切换',
  overflow: '更多按钮',
  add: '添加按钮',
  settings: '设置',
  addTitle: '启动项管理',
  addHint: '当前工作区的全部条目。按住左侧 ⋮⋮ 上下拖动调整顺序，顺序即按钮条上的排列顺序。',
  addPinned: '已在条上',
  addUnpinned: '未添加',
  addPin: '钉到按钮条',
  addHide: '从按钮条收起',
  addClose: '关闭',
  settingsTitle: 'Run Configuration',
  settingsManifest: '清单文件',
  settingsSource: '配置来源',
  settingsProject: '项目根目录',
  settingsRuns: '进行中的运行',
  settingsNoRuns: '没有进行中的运行',
  settingsWarnings: '告警',
  settingsDensity: '按钮密度',
  settingsVersion: '版本',
  settingsHost: '插件后端',
  settingsClient: '插件界面',
  settingsCapability: '宿主能力',
  settingsSubprocess: '执行通道：ctx.subprocess.spawnTerminal（真 PTY）',
  settingsSubprocessMissing: '宿主没有可用的执行通道，无法真正起进程',
  settingsClose: '关闭',
  errorTitle: '启动失败的原因',
  errorHint: '这是宿主返回的原话。想连带看清单告警就点「全部告警」。',
  errorOpenSettings: '全部告警（⚙）',
  errorClose: '知道了',
  noFocus: '当前目录没有 .dsh/run.json',
  noFocusHint: '在项目根目录放一份 .dsh/run.json，就会出现这个工作区的启动按钮。',
};

const EN: Record<string, string> = {
  run: 'Run',
  stop: 'Stop',
  running: 'running',
  ready: 'ready',
  exited: 'exited',
  starting: 'starting',
  stopping: 'stopping',
  runFailed: 'Start failed',
  stopFailed: 'Stop failed',
  saveFailed: 'Save failed',
  densityFull: 'Full labels',
  densityCompact: 'Compact',
  densityIcon: 'Icons only',
  densityCycle: 'Click to cycle',
  overflow: 'More buttons',
  add: 'Add button',
  settings: 'Settings',
  addTitle: 'Run entries',
  addHint: 'Every entry in this workspace. Drag the ⋮⋮ handle to reorder; the order is the bar order.',
  addPinned: 'on bar',
  addUnpinned: 'not added',
  addPin: 'Pin to bar',
  addHide: 'Hide from bar',
  addClose: 'Close',
  settingsTitle: 'Run Configuration',
  settingsManifest: 'Manifest',
  settingsSource: 'Config source',
  settingsProject: 'Project root',
  settingsRuns: 'Active runs',
  settingsNoRuns: 'No active runs',
  settingsWarnings: 'Warnings',
  settingsDensity: 'Button density',
  settingsVersion: 'Version',
  settingsHost: 'backend',
  settingsClient: 'UI',
  settingsCapability: 'Host capability',
  settingsSubprocess: 'execution seam: ctx.subprocess.spawnTerminal (real PTY)',
  settingsSubprocessMissing: 'This host has no usable execution seam, so processes cannot really start',
  settingsClose: 'Close',
  errorTitle: 'Why the start failed',
  errorHint: 'This is the host’s own message. Use “All warnings” to see the manifest warnings too.',
  errorOpenSettings: 'All warnings (⚙)',
  errorClose: 'Got it',
  noFocus: 'No .dsh/run.json in this directory',
  noFocusHint: 'Add one to the project root to get this workspace’s run buttons.',
};

/* ─────────────────────────── 样式 ─────────────────────────── */

/**
 * **抬升宿主 `composerSeat` 的那一条规则**（2026-10-13 修 "⚙ 面板右下角被宿主的
 * 「回到底部」圆钮盖住"）。
 *
 * ## 根因（全部是从安装包里读出来的字面事实，不是推断）
 *
 * 1. 我们这一行住在宿主的 composerSeat 里（实测祖先链：
 *    `__ru_host → ank0OG_composerStack → … → ank0OG_composerSeat`，见 geometry 日志）。
 * 2. 宿主 `@deepseek-ai/dsh-client-ui-conversation/ConversationRoot.module.css`：
 *    ```css
 *    .ank0OG_root[data-phase=active] .ank0OG_composerSeat,
 *    .ank0OG_embeddedBody[data-content-phase=active] .ank0OG_composerSeat{
 *      z-index:7; position:sticky; bottom:0; …}
 *    ```
 *    `position:sticky` + `z-index:7` = **一个层叠上下文**（特异性 (0,3,0)）。
 * 3. 宿主 `@deepseek-ai/dsh-client-ui-chat/ChatView.module.css`：
 *    `.X6jxGq_toBottomSlot{z-index:8; … position:absolute/sticky}` —— 「回到底部」
 *    圆钮的槽位是 seat 的**兄弟子树**，在**父上下文**里以 8 压住整个 seat 子树。
 * 4. 于是 `.__ru_pop{z-index:10}` 是**seat 上下文内部的 10**：层叠上下文是硬边界，
 *    后代再高的 z-index 也出不去 —— 只要 seat 自己是 7，弹层就永远被 8 压住。
 *    把弹层自己的 z-index 从 10 改成 20/999 一点用都没有（这就是"为什么之前没做"）。
 *
 * ## 修法：照抄宿主自己的做法
 *
 * 宿主遇到**同一个问题**（composer 里的 `@` 引用菜单同样被那个圆钮压住）时，
 * 用的就是这一招 —— `ConversationRoot.module.css` 里紧跟其后的一条：
 * ```css
 * .ank0OG_root[data-phase=active] .ank0OG_composerSeat:has([data-trigger-menu]){z-index:9}
 * ```
 * 即"composer 里有浮层打开时，把 seat 整体抬到 9（> 8）"。我们在自己的弹层打开
 * 期间做同一件事，只是**用我们自己的选择器**而不是冒充宿主的 `data-trigger-menu`。
 *
 * ## 两个细节是刻意的
 *
 * - 选择器写成 **(0,4,0)** 特异性：`[data-composer-seat]` + `[data-conversation-region="composer"]`
 *   （两个属性，宿主 JSX 里就写在同一层 div 上）各算一个，`:has(.__ru_host .__ru_pop)`
 *   的参数是 (0,2,0) → 合计 (0,4,0) > 宿主那条 (0,3,0)。少写一个属性就变成 (0,3,0)，
 *   与宿主打平、只剩源码顺序决胜（我们的 style 标签是插件后插的，顺序不可靠）——
 *   `scripts/smoke-client.mjs` 里有专门算特异性的护栏盯着这件事。
 * - 只在**弹层打开时**抬升（`:has`），不改宿主的常驻布局。
 *
 * 这条规则**单独拎成一个常量**：`probeStacking()` 的 A/B 要把它的文本精确摘掉
 * 再装回去，用来在同一帧里量出"有它/没它"的命中顺序差。
 */
const STACK_LIFT_RULE =
  '[data-composer-seat][data-conversation-region="composer"]:has(.__ru_host .__ru_pop),' +
  '[data-composer-seat][data-conversation-region="composer"]:has(.__ru_host .__ru_menu){z-index:9}';

const CSS = [
  // 我们挂在 `conversation.input.dock` 里——宿主由 `ank0OG_composerStack`
  // （flex column + gap 6px）把这一列排出来，每个条目就是一个 flex 子项。
  //
  // 尺寸**逐字照抄**同列「任务列表」那一条（`IJkQnq_root`）：
  //   width: 100% - 2×side-clearance - 4×dock-inset
  //   max-width: card-max-width - 4×dock-inset
  //   flex:none; margin:0 auto
  // 注意是 **4 个** dock-inset（两边各 16px），不是 2 个——抄成 2 个会让条比
  // 任务那一行宽 16px、比输入框卡片窄 16px，正好夹在两者之间（实测 936 vs 920 vs 952）。
  //
  // 与卡片之间**不加额外间距**：宿主那 6px 堆叠间距对组内每一行和"组 vs 卡片"
  // 一视同仁，加一条 margin-bottom 会把"组内 6px / 组与卡片 12px"这种不一致做出来。
  // 正常流 + 宿主排版 = 不需要任何 DOM 测量。
  '.__ru_host{box-sizing:border-box;position:relative;z-index:2;flex:none;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;min-width:0}',
  // 条自己的表面：照抄宿主给「输入框上方那一列」用的那套——
  // `--dsw-specific-menu`（半透明面）+ `backdrop-filter: --dsw-menu-backdrop-filter`
  // （磨砂）+ `--dsw-elevation-panel`（阴影，其描边取 `--dsw-elevation-stroke-color`，
  // 这里指到 `--dsw-alias-border-l1`）+ `--dsw-radius-lg` 圆角。任务列表/目标/队列
  // 都是这个组合，所以条和它们看起来是同一组。
  //
  // 为什么必须换掉 `--dsw-alias-button-floating-fill`：实测它和输入框卡片的
  // `--dsw-specific-input-major` **是同一个色**（都是 #2c2c2e），紧挨着看就是一个盒子；
  // 而 `--dsw-specific-menu` 是 #43454a73，与卡片明显不同。
  '.__ru_bar{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;min-width:0;height:34px;padding:0 8px;border-radius:var(--dsw-radius-lg);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1;overflow:hidden}',
  '.__ru_btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:none;border-radius:100px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1;cursor:pointer;white-space:nowrap;flex:none;max-width:190px}',
  '.__ru_btn:hover:not(:disabled){background:var(--dsw-alias-button-floating-hover)}',
  '.__ru_btn:disabled{opacity:.45;cursor:default}',
  '.__ru_fixed{background:var(--dsw-alias-interactive-bg-active)}',
  '.__ru_btnActive{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-success-primary)}',
  '.__ru_errorBtn{color:var(--dsw-alias-state-error-primary)}',
  '.__ru_btnLabel{min-width:0;overflow:hidden;text-overflow:ellipsis}',
  // ── 紧凑档：真的**变紧**（不是只截断文字）──
  // 早先 compact 只做"文字超过 12 字就截断"，可绝大多数标签（`全量检查`、
  // `重建客户端包`）都在 12 字以内，于是**完整档和紧凑档长得一模一样**。
  // 现在紧凑档把胶囊与间距一起收紧（22px 高、内边距 0 6px、间距 4px、字号 12px），
  // 无论标签长短都能一眼看出档位；文字截断门槛也降到 8 字，长的再补一刀。
  '.__ru_bar[data-density="compact"]{gap:4px;padding:0 6px}',
  '.__ru_bar[data-density="compact"] .__ru_btn{height:22px;padding:0 6px;gap:4px;font-size:12px}',
  '.__ru_bar[data-density="compact"] .__ru_grow,.__ru_bar[data-density="compact"] .__ru_tail{gap:4px}',
  '.__ru_dot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--dsw-alias-state-success-primary)}',
  // 状态点：就绪=绿（成功），还在跑=琥珀（警告色）+ 呼吸，停不下来=红。
  // 早先不管什么状态都是同一个绿点，"点了半天没动静"根本分不清是在跑还是已经起来。
  '.__ru_btn[data-status="running"] .__ru_dot,.__ru_btn[data-status="starting"] .__ru_dot{background:var(--dsw-alias-state-warn-primary);animation:__ru_pulse 1.4s ease-in-out infinite}',
  '.__ru_btn[data-status="stopping"] .__ru_dot{background:var(--dsw-alias-state-error-primary)}',
  '@keyframes __ru_pulse{0%,100%{opacity:1}50%{opacity:.35}}',
  '.__ru_grow{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px;overflow:hidden}',
  '.__ru_tail{flex:none;display:flex;align-items:center;gap:6px}',
  // 弹出面板 / 溢出菜单：锚在条的上方。
  // ⚠️ 这里的 z-index 只是**我们这条 host 上下文内部**的顺序，跨上下文（比如压过宿主的
  // 「回到底部」圆钮）靠的是 `STACK_LIFT_RULE` —— 把弹层自己的 z-index 调大是没用的。
  '.__ru_pop{position:absolute;z-index:10;bottom:calc(100% + 8px);left:0;right:0;box-sizing:border-box;max-height:min(70vh,460px);overflow:auto;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 40px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary);font-size:13px}',
  '.__ru_popTitle{margin:0 0 4px;font-size:14px;font-weight:600}',
  '.__ru_popHint{margin:0 0 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  // 失败原因：保留原话的换行与长路径（不折损、可选中复制）
  '.__ru_errorText{margin:0 0 8px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;user-select:text}',
  // run 的最近几行输出（面板里"脚本自己为什么没起来"的唯一证据）
  '.__ru_runTail{margin:0;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-mono,monospace);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;user-select:text}',
  '.__ru_row{display:flex;align-items:center;gap:8px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin-bottom:6px;background:var(--dsw-alias-bg-layer-1)}',
  '.__ru_row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.__ru_rowDragging{opacity:.5}',
  '.__ru_handle{flex:none;width:20px;text-align:center;color:var(--dsw-alias-label-tertiary);cursor:ns-resize;user-select:none;font-size:15px;line-height:1}',
  '.__ru_rowBody{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
  '.__ru_rowLabel{font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.__ru_rowCmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.__ru_rowActions{flex:none;display:flex;align-items:center;gap:6px}',
  '.__ru_tag{font-size:11px;line-height:16px;padding:0 6px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
  '.__ru_tagOn{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
  '.__ru_kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;line-height:18px;margin-bottom:8px}',
  '.__ru_key{color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
  '.__ru_val{color:var(--dsw-alias-label-secondary);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
  '.__ru_sep{height:1px;background:var(--dsw-alias-border-l2);margin:8px 0}',
  '.__ru_options{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px}',
  '.__ru_option{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
  '.__ru_option:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.__ru_optionOn{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-active)}',
  '.__ru_error{margin:0 0 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
  '.__ru_menu{position:absolute;z-index:11;bottom:calc(100% + 8px);left:0;min-width:180px;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 40px rgba(0,0,0,.28)}',
  // 弹层打开期间把宿主的 composerSeat 抬到「回到底部」圆钮之上（根因见 STACK_LIFT_RULE）。
  STACK_LIFT_RULE,
  '.__ru_menuItem{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}',
  '.__ru_menuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
].join('');

/**
 * 注入样式——**必须幂等刷新，不能"有就跳过"**。
 *
 * 这里踩过一个真实的坑：早先的写法是"已经存在同名 style 标签就 return"。
 * 页面里的标签是**第一次加载时**那份 CSS；此后 HMR 热替换了插件 bundle 再跑
 * `apply()`，它看到旧标签就跳过了——于是代码里明明已经是新样式，用户看到的
 * 一直是旧样式（表现为"改了半天界面没变/位置还是旧的"）。所以现在无论有没有，
 * 都把 textContent 覆写成当前 CSS。
 */
function injectStyles(): void {
  if (typeof document === 'undefined') return;
  const existing = document.querySelector<HTMLStyleElement>(
    'style[data-plugin-css="dsh-rundeck/main.css"]',
  );
  const tag = existing ?? document.createElement('style');
  if (existing === null) {
    tag.dataset.plugin = NS;
    tag.dataset.pluginCss = 'dsh-rundeck/main.css';
    document.head.appendChild(tag);
  }
  if (tag.textContent !== CSS) tag.textContent = CSS;
  injectedStyleTag = tag;
}

/** 当前页面里那份样式标签（诊断用：用来确认"看到的是不是最新 CSS"）。 */
let injectedStyleTag: HTMLStyleElement | null = null;

/* ─────────────────────────── HTTP 客户端 ─────────────────────────── */

async function call<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    if (!response.ok) {
      return { ok: false, code: 'HTTP', message: `HTTP ${response.status} ${response.statusText}` };
    }
    return (await response.json()) as ApiResult<T>;
  } catch (error) {
    return { ok: false, code: 'NETWORK', message: String((error as Error)?.message ?? error) };
  }
}

/** 拉全量状态。`sessionId` 是宿主交给插槽的当前会话；host 用它解析会话的 cwd。 */
async function pullState(
  cwd: string | null,
  sessionId: string | null,
): Promise<ApiResult<RundeckState>> {
  const params = new URLSearchParams();
  if (cwd !== null && cwd.length > 0) params.set('cwd', cwd);
  if (sessionId !== null && sessionId.length > 0) params.set('sessionId', sessionId);
  const query = params.toString();
  return call<RundeckState>(`/state${query.length > 0 ? `?${query}` : ''}`, 'GET');
}

/**
 * 一次性诊断上报。
 *
 * 存在的理由只有一个：回答"客户端半边到底被浏览器加载了没有"。
 * 这个问题的答案只可能在 host 日志里（页面控制台看不到），所以挂载与首次渲染
 * 各报一次，host 把它写进日志。每个阶段只报一次，不会因轮询刷屏。
 */
const reported = new Set<string>();

function report(stage: string, detail?: Record<string, unknown>): void {
  if (reported.has(stage)) return;
  reported.add(stage);
  void call('/ping', 'POST', detail === undefined ? { stage } : { stage, detail });
}

/**
 * 按**内容**去重的上报：同样的内容只发一次，内容变了就再发一次。
 *
 * 与 `report()` 的区别：`report()` 按**阶段名**去重（每个页面生命周期一次），
 * 所以"切到另一个会话之后条还在不在、为什么不在"在日志里是**看不见**的——
 * 那正是最难查的一类问题。这里按签名去重，于是每换一个会话、每次结果变化都会
 * 留下一行，包括"条被隐藏"的原因。
 */
function reportKeyed(key: string, stage: string, detail: Record<string, unknown>): void {
  if (reported.has(key)) return;
  reported.add(key);
  void call('/ping', 'POST', { stage, detail });
}

/**
 * 打开一个"就绪地址"（`serverReadyAction: openExternally`）。
 *
 * 为什么在界面侧做：宿主那边**没有**可用入口（桌面版没有 `openPath` 服务，
 * `sessionController.openWorkspacePath` 只认工作区内的路径），而这里的
 * `window.open` 会被桌面壳的 `setWindowOpenHandler` 接住 → `shell.openExternal`
 * → 系统默认浏览器；Web 版就是新开一个标签页。两边都对。
 *
 * 每个 `runId|url` 只开一次，去重键存在浏览器本地——否则每次刷新页面都会
 * 为那些早就就绪的 run 再弹一次浏览器。
 */
const OPENED_KEY = 'dsh-rundeck.openedUrls.v1';

function openedUrls(): Set<string> {
  try {
    const raw = window.localStorage.getItem(OPENED_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function rememberOpened(key: string): void {
  try {
    const all = [...openedUrls(), key];
    // 只留最近 100 条：这只是"别重复弹窗"的记忆，不需要永久。
    window.localStorage.setItem(OPENED_KEY, JSON.stringify(all.slice(-100)));
  } catch {
    /* 存不了就算了：最多多弹一次 */
  }
}

/**
 * 打开一个就绪地址（只接受 http/https）。@returns 是否真的交给浏览器。
 *
 * 同一个 `runId|url` 只处理一次——**跳过也要记住**：像 `jin · desktop` 那种
 * 就绪组是 exe 路径的条目，每次刷新页面都会再"决定不打开"一次，日志里就会反复
 * 出现 `open-url … opened:false`，看起来像失败。记一次就够，理由是给日志看的。
 */
function openReadyUrl(runId: string, url: string): boolean {
  const key = `${runId}|${url}`;
  if (openedUrls().has(key)) return false;
  if (!/^https?:\/\//iu.test(url)) {
    rememberOpened(key);
    reportKeyed(`open-url-skip:${key}`, 'open-url', {
      runId,
      url,
      opened: false,
      reason: '不是 http/https（这条就绪组抓到的不是地址，没什么可打开）',
    });
    return false;
  }
  rememberOpened(key);
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
    reportKeyed(`open-url:${key}`, 'open-url', { runId, url, opened: true });
    return true;
  } catch (error) {
    reportKeyed(`open-url-fail:${key}`, 'open-url', { runId, url, opened: false, reason: String(error) });
    return false;
  }
}

/** 一个元素的 rect，收成便于读日志的整数形式。 */
function rectOf(element: Element): { top: number; left: number; width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return {
    top: Math.round(rect.top),
    left: Math.round(rect.left),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** 把一个元素的关键布局事实写成一行，便于在日志里对照。 */
function describeElement(element: Element): string {
  const style = getComputedStyle(element);
  const rect = rectOf(element);
  const cls =
    typeof element.className === 'string' && element.className.length > 0
      ? (element.className.split(' ')[0] ?? element.tagName)
      : element.tagName;
  return (
    `${cls}{display:${style.display},order:${style.order},pos:${style.position}}` +
    `@${rect.top}..${rect.top + rect.height}(w${rect.width},l${rect.left})`
  );
}

/**
 * 收集一个 flex 容器的**有效行**：插槽包装是 `display:contents`（rect 恒为 0×0），
 * 所以要把它们展开，只列出真正参与排版、有尺寸的那些元素。
 *
 * 每行除了几何，还带上**表面事实**（底色 / 圆角），这样"我们的条和任务那一行
 * 是不是真的同一个表面"在日志里可以直接逐值对照，不用靠肉眼比色。
 * 注意：我们的行是"外壳 + 内层药丸"两层（外层不能 overflow:hidden，否则弹出面板
 * 会被裁掉，所以表面在内层），因此外层透明时**取第一个有底色的子元素**——
 * 这样两类行的取值方式一致，比较才有意义。
 *
 * @param container 要找行的那一列（`ank0OG_composerStack`）。
 * @returns 每行一条：名字 + 几何 + 底色 + 圆角。
 */
function effectiveRows(container: Element): Array<{
  what: string;
  top: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
  bg: string;
  radius: string;
}> {
  const out: Array<{
    what: string;
    top: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
    bg: string;
    radius: string;
  }> = [];
  /** 取"看起来是这一行表面"的那个元素：自身有底色就用自身，否则用第一个**在流内**且有底色的子元素。 */
  const surfaceOf = (element: Element): { bg: string; radius: string } => {
    const own = getComputedStyle(element);
    if (!/^rgba?\([^)]*,\s*0\)$/u.test(own.backgroundColor)) {
      return { bg: own.backgroundColor, radius: own.borderTopLeftRadius };
    }
    for (const child of Array.from(element.children)) {
      const style = getComputedStyle(child);
      // 跳过绝对/固定定位的子元素：那些是弹出面板（`.__ru_pop` 之类），
      // 不是这一行的表面——否则面板一开，"行的底色"就会被报成浮层的底色。
      if (style.position === 'absolute' || style.position === 'fixed') continue;
      if (!/^rgba?\([^)]*,\s*0\)$/u.test(style.backgroundColor)) {
        return { bg: style.backgroundColor, radius: style.borderTopLeftRadius };
      }
    }
    return { bg: own.backgroundColor, radius: own.borderTopLeftRadius };
  };
  const walk = (parent: Element, depth: number): void => {
    for (const child of Array.from(parent.children)) {
      if (getComputedStyle(child).display === 'contents') {
        if (depth < 4) walk(child, depth + 1);
        continue;
      }
      const rect = rectOf(child);
      const cls =
        typeof child.className === 'string' && child.className.length > 0
          ? (child.className.split(' ')[0] ?? child.tagName)
          : child.tagName;
      const surface = surfaceOf(child);
      out.push({
        what: cls,
        top: rect.top,
        bottom: rect.top + rect.height,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        bg: surface.bg,
        radius: surface.radius,
      });
    }
  };
  walk(container, 0);
  return out;
}

/* ────────────── 层叠诊断：我们的弹层 vs 宿主「回到底部」圆钮 ────────────── */

/** 元素的可读名字（CSS Module 的哈希前缀照抄，便于在日志里对照宿主自己的类名）。 */
function classNameOf(element: Element): string {
  if (typeof element.className === 'string' && element.className.length > 0) {
    return element.className.split(' ')[0] ?? element.tagName;
  }
  return element.tagName;
}

/**
 * 一个元素在层叠里的关键事实：`position` / `z-index`，以及**到底哪些属性真的新建了
 * 层叠上下文**。后者是关键——"谁把谁关在自己的上下文里"这件事，光看 z-index 看不出来
 * （`container-type` 的布局包含、`opacity`、`transform` 都会偷偷新建上下文）。
 */
function stackingFacts(element: Element): string {
  const style = getComputedStyle(element);
  const marks: string[] = [];
  if (style.position !== 'static' && style.zIndex !== 'auto') marks.push('positioned+z');
  if (style.opacity !== '1') marks.push(`opacity:${style.opacity}`);
  if (style.transform !== 'none') marks.push('transform');
  if (style.filter !== 'none') marks.push('filter');
  if (style.backdropFilter !== 'none') marks.push('backdrop-filter');
  if (style.isolation === 'isolate') marks.push('isolation');
  if (style.mixBlendMode !== 'normal') marks.push('blend');
  if (style.willChange !== 'auto') marks.push(`will-change:${style.willChange}`);
  if (style.contain !== 'none') marks.push(`contain:${style.contain}`);
  if (style.containerType !== 'normal') marks.push(`container-type:${style.containerType}`);
  return (
    `${classNameOf(element)}{pos:${style.position},z:${style.zIndex}` +
    `${marks.length > 0 ? `,上下文:${marks.join('+')}` : ',不新建上下文'}}`
  );
}

/**
 * 宿主那个「回到底部」圆钮。
 *
 * CSS Module 只哈希本地名前面的那段（`X6jxGq_toBottom`），本地名本身跟着
 * `ChatView.module.css` 的 key 走、跨版本稳定，所以按**后缀**找；而且限定
 * `button` —— 槽位 `..._toBottomSlot` 是个 `div`，不会被选中。
 * 这是纯诊断：找不到就返回 null，不影响任何业务。
 */
function toBottomButton(): Element | null {
  return document.querySelector('button[class*="toBottom"]');
}

/** 一次命中测试：测的点 + 该点上的命中序（上→下）。 */
interface HitStack {
  at: [number, number];
  names: string[];
}

/** `probeStacking()` 的结论（结构化，便于进日志指纹）。 */
interface StackProbeReport {
  popupOpen: boolean;
  seat: string | null;
  button: {
    what: string;
    rect: ReturnType<typeof rectOf>;
    /** 圆钮外面那个槽位（`X6jxGq_toBottomSlot`）——z-index:8 挂在它身上，不是按钮自己。 */
    slot: string | null;
  } | null;
  popup: { what: string; rect: ReturnType<typeof rectOf> } | null;
  probe: {
    rect: ReturnType<typeof rectOf>;
    withRule: { seatZ: string; hit: HitStack | null };
    withoutRule: { seatZ: string; hit: HitStack | null } | null;
  };
  realPopupHit: HitStack | null;
  verdict: string;
}

/** 在一个 rect 与另一个 rect 的**交集中心**做命中测试（`elementsFromPoint` = 真实命中序，上→下）。 */
function hitStackAt(rect: DOMRect, against: DOMRect): HitStack | null {
  const left = Math.max(rect.left, against.left);
  const right = Math.min(rect.right, against.right);
  const top = Math.max(rect.top, against.top);
  const bottom = Math.min(rect.bottom, against.bottom);
  if (right <= left || bottom <= top) return null;
  const x = Math.round((left + right) / 2);
  const y = Math.round((top + bottom) / 2);
  return { at: [x, y], names: document.elementsFromPoint(x, y).slice(0, 6).map(classNameOf) };
}

/**
 * **层叠 A/B 实测**（"弹层到底压不压得住宿主那个圆钮"）。
 *
 * 为什么要在真机上做 A/B，而不是靠读 CSS 推断：
 * 我们这一层被关在宿主的 `composerSeat`（`position:sticky; z-index:7`）这个层叠上下文里，
 * 而圆钮是**兄弟子树**里的 `z-index:8`。"谁在上面"取决于两者是不是同一个上下文、
 * 中间有没有东西偷偷新建上下文（`container-type` 的布局包含就会）——这些只能量，不能猜。
 *
 * 做法：造一个与真实弹层**同一个盒子**的探针（几何全走 inline style，所以下面
 * 摘掉抬升规则时它的位置不变），然后在同一帧里：
 *   1. 量一次命中序（抬升规则生效）；
 *   2. 把 `STACK_LIFT_RULE` 从我们的样式表里**精确摘掉**（其余样式一行不动，几何不变），
 *      强制重算样式，再量同一个点；
 *   3. 把样式表原样装回去。
 * 于是日志里同一行就同时有"没有这条规则时的命中序"（= 出问题时你看到的）
 * 与"有这条规则时的命中序"（= 修好之后）。两层都带上当时 seat 的实测 z-index。
 *
 * 探针只在**圆钮真的存在**（会话没跟随末尾 = 你滚上去了）时才插，插完立刻删掉，
 * 全程同步，用户不可能碰到它；任何异常都吞掉——诊断绝不影响业务。
 */
function probeStacking(host: Element): StackProbeReport | null {
  if (typeof document === 'undefined') return null;
  const popup = host.querySelector<HTMLElement>('.__ru_pop,.__ru_menu');
  const button = toBottomButton();
  let probe: HTMLElement | null = null;
  try {
    const seat = host.closest('[data-composer-seat]');
    const seatZ = (): string => (seat === null ? 'n/a' : getComputedStyle(seat).zIndex);
    // 圆钮不在（会话还在跟随末尾）时也照量：抬升本身的 7 → 9 与它无关，
    // 量到了就说明"规则确实作用在宿主的 seat 上"，只有"谁盖住谁"才需要圆钮在场。
    const buttonRect = button === null ? null : button.getBoundingClientRect();
    probe = document.createElement('div');
    probe.className = '__ru_pop';
    probe.setAttribute('data-rundeck-probe', 'stack');
    probe.style.cssText =
      'position:absolute;left:0;right:0;bottom:calc(100% + 8px);height:220px;' +
      'padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;' +
      'overflow:visible;pointer-events:auto';
    host.appendChild(probe);
    const probeRect = probe.getBoundingClientRect();
    const probeBox = rectOf(probe); // 必须在 remove() 之前取：detach 之后 rect 恒为 0×0
    const measure = (): HitStack | null =>
      buttonRect === null ? null : hitStackAt(probeRect, buttonRect);

    const withRule = { seatZ: seatZ(), hit: measure() };

    // 摘掉抬升规则 → 重算样式 → 同一个点再量一次。
    const tag = injectedStyleTag;
    const saved = tag?.textContent ?? null;
    let withoutRule: { seatZ: string; hit: HitStack | null } | null = null;
    if (tag !== null && saved !== null && saved.includes(STACK_LIFT_RULE)) {
      tag.textContent = saved.replace(STACK_LIFT_RULE, '');
      void probe.getBoundingClientRect(); // 强制重算样式
      withoutRule = { seatZ: seatZ(), hit: measure() };
      tag.textContent = saved;
      void probe.getBoundingClientRect();
    }

    // 真面板自己那一份（弹层打开时才量）：它和圆钮是不是真的重叠、谁在上面。
    const realHit =
      popup === null || buttonRect === null
        ? null
        : hitStackAt(popup.getBoundingClientRect(), buttonRect);

    const seatShift =
      withoutRule === null ? '?' : `${withoutRule.seatZ} → ${withRule.seatZ}`;
    return {
      popupOpen: popup !== null,
      seat: seat === null ? null : stackingFacts(seat),
      button:
        button === null
          ? null
          : {
              what: stackingFacts(button),
              rect: rectOf(button),
              slot: button.parentElement === null ? null : stackingFacts(button.parentElement),
            },
      popup: popup === null ? null : { what: stackingFacts(popup), rect: rectOf(popup) },
      probe: { rect: probeBox, withRule, withoutRule },
      realPopupHit: realHit,
      // 一句话结论：日志里不用自己去比对数组（`? → ?` = 摘规则 / 装规则时最上层是谁）
      verdict:
        buttonRect === null
          ? `页面上没有「回到底部」圆钮（会话跟随末尾）；抬升本身：seat z-index ${seatShift}`
          : withoutRule === null
            ? '没量到（样式表里没有抬升规则）'
            : withRule.hit === null
              ? `弹层与圆钮不重叠（当前布局下没有可争的位置）；seat z-index ${seatShift}`
              : withoutRule.hit === null
                ? '摘掉规则后圆钮那点已经不在弹层范围内（布局变了，不可比）'
                : `${withoutRule.hit.names[0] ?? '?'} → ${withRule.hit.names[0] ?? '?'}；seat z-index ${seatShift}`,
    };
  } catch {
    return null;
  } finally {
    // **无论如何**都不能把这个探针留在页面上：它是个 920×220、`pointer-events:auto`
    // 的透明层，留在那里会一直替我们抬着 seat、还会吃掉输入框上方那一片的点击。
    probe?.remove();
  }
}

/**
 * 上一次上报过的行布局指纹。行一变（任务/目标/队列那几行来去）就重报一次，
 * 布局稳定时不再重复——这样"最满状态"下到底排了哪几行、行距多少，日志里能连着看。
 */
let geometrySignature = '';

/**
 * 上报**真实几何 + 主题令牌**（诊断用）。
 *
 * 纯 CSS 的贴合/重叠问题在日志里原本完全看不见，只能靠截图数像素猜。这一段把
 * 「我们的 rect／输入框卡片的 rect／这一列的有效行／祖先链／相关令牌与底色的
 * 实际取值」直接送进宿主日志，于是"差几像素、谁排在哪、是不是同一个色"都变成
 * 可读的事实。
 *
 * 两个踩过的坑，写在这里免得下次再踩：
 *   1. 自定义属性要从**自己的元素**上读——`--dsh-composer-*` 声明在会话面板内部，
 *      `getComputedStyle(document.documentElement)` 上读不到（全是空串）。
 *   2. 我们的直接父元素是 `display:contents` 的插槽包装（rect 恒为 0×0），
 *      真正排版我们的是再往上那个 flex 容器，所以要沿祖先链找 display:flex。
 */
function reportGeometry(): void {
  if (typeof document === 'undefined') return;
  try {
    const root = document.querySelector('.__ru_host');
    if (root === null) return;
    const card = document.querySelector('[data-composer-card]');
    const own = getComputedStyle(root);
    const token = (name: string): string => own.getPropertyValue(name).trim();

    const ancestors: string[] = [];
    let node: Element | null = root.parentElement;
    for (let depth = 0; depth < 5 && node !== null; depth += 1) {
      ancestors.push(describeElement(node));
      node = node.parentElement;
    }

    // 真正排版我们的那个 flex 容器（composerStack），列出它的有效行。
    let container: Element | null = root.parentElement;
    while (container !== null && getComputedStyle(container).display !== 'flex') {
      container = container.parentElement;
    }
    const rows = container === null ? null : effectiveRows(container);

    // 当前档位 + 一个胶囊的**实际**尺寸：紧凑档的 CSS 有没有真的生效，
    // 只能这样看（"完整和紧凑长得一样"就是靠这个查出来的）。
    const barElement = root.querySelector('.__ru_bar');
    const chipElement = root.querySelector('.__ru_bar .__ru_btn');
    const density = {
      marker: barElement?.getAttribute('data-density') ?? null,
      chipHeight: chipElement === null ? null : getComputedStyle(chipElement).height,
      chipFont: chipElement === null ? null : getComputedStyle(chipElement).fontSize,
      chipPadding: chipElement === null ? null : getComputedStyle(chipElement).paddingLeft,
    };

    // 层叠实测：弹层 vs 宿主「回到底部」圆钮（见 probeStacking 的注释）。
    // 弹层开关也要进指纹——否则"打开面板"这件事在布局上不留痕迹，日志里就看不到它。
    const stack = probeStacking(root);

    const signature =
      (rows ?? [])
        .map((row) => `${row.what}@${row.top}-${row.bottom}w${row.width}/${row.bg}/${row.radius}`)
        .join('|') +
      `#${density.marker}/${density.chipHeight}/${density.chipFont}` +
      // 层叠那段只放**稳定的结论**进指纹：rect 会随滚动抖，塞进来只会刷屏
      `#stack:${stack === null ? 'null' : `${stack.popupOpen}/${stack.button === null ? 'noButton' : 'button'}/${stack.verdict}`}`;
    if (signature === geometrySignature) return;
    geometrySignature = signature;

    // 不走 report()：那个按阶段去重，只肯发一次；这里的去重交给上面的
    // geometrySignature（行布局变了才重发）。
    void call('/ping', 'POST', {
      stage: 'geometry',
      detail: {
        bar: rectOf(root),
        card: card === null ? null : rectOf(card),
        ancestors,
        rows,
        density,
        // 层叠实测：弹层 vs 宿主「回到底部」圆钮（A/B 命中序 + seat 的实测 z-index）
        stack,
        // 页面里到底挂了几个我们的实例（重注册 / 旧 bundle 残留都靠这条看）
        instances: document.querySelectorAll('.__ru_host').length,
        // 我们自己的关键计算值：宽度公式有没有生效、定位是不是旧的绝对定位
        own: {
          width: own.width,
          maxWidth: own.maxWidth,
          position: own.position,
          left: own.left,
          right: own.right,
          bottom: own.bottom,
          marginBottom: own.marginBottom,
          flexShrink: own.flexShrink,
          order: own.order,
        },
        // 当前生效的那份 CSS 是不是最新（HMR 之后最容易在这里骗人）
        css: {
          tagFound: injectedStyleTag !== null,
          length: injectedStyleTag?.textContent?.length ?? 0,
          hasAbsoluteOverlay: (injectedStyleTag?.textContent ?? '').includes('position:absolute'),
          hostRule:
            /\.__ru_host\{[^}]*\}/u.exec(injectedStyleTag?.textContent ?? '')?.[0] ?? null,
        },
        fill: {
          bar: getComputedStyle(root.firstElementChild ?? root).backgroundColor,
          card: card === null ? null : getComputedStyle(card).backgroundColor,
          menuToken: token('--dsw-specific-menu'),
          inputMajorToken: token('--dsw-specific-input-major'),
          floatingToken: token('--dsw-alias-button-floating-fill'),
          stackGap: token('--dsh-composer-stack-gap'),
          dockInset: token('--dsh-composer-dock-inset'),
          sideClearance: token('--dsh-composer-side-clearance'),
        },
      },
    });
  } catch {
    /* 诊断失败绝不影响业务 */
  }
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

interface Runtime {
  t(key: string): string;
}

/** 图标名 → 字形（自绘，不引宿主图标包：它的导出名在版本间改过）。 */
function iconGlyph(name: string): string {
  switch (name) {
    case 'eye':
      return '👁';
    case 'play':
      return '▶';
    case 'desktop':
      return '🖥';
    case 'hammer':
      return '🔨';
    case 'server':
      return '🗄';
    case 'terminal':
      return '▮';
    default:
      return name.trim().slice(0, 1).toUpperCase() || '•';
  }
}

/** compact 档的定长截断。 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** 一个按钮在给定密度下的可见文字；icon 档返回空。 */
function labelFor(button: FloatingButtonView, density: ButtonDensity): string {
  const full = button.label ?? button.entryLabel;
  if (density === 'icon') return '';
  if (density === 'compact') return truncate(full, COMPACT_MAX_CHARS);
  return full;
}

/** 三档密度循环的顺序（`▥▤▨` 那个固定钮每点一下走一格）。 */
const DENSITY_CYCLE: ButtonDensity[] = ['full', 'compact', 'icon'];

/** 当前档位的文案键（按钮上直接把这个词写出来，不靠字形暗示）。 */
function densityLabelKey(density: ButtonDensity): string {
  return density === 'icon' ? 'densityIcon' : density === 'compact' ? 'densityCompact' : 'densityFull';
}

/** 再点一下会到哪一档。 */
function nextDensityOf(density: ButtonDensity): ButtonDensity {
  return DENSITY_CYCLE[(DENSITY_CYCLE.indexOf(density) + 1) % DENSITY_CYCLE.length] ?? 'full';
}

/**
 * 由会话 id 取该会话的工作目录——**只是"能拿到就用"的旁路**。
 *
 * 客户端 `sessions` 服务（live 目录实测）只有 retain/using/retainInfo/
 * refreshProjections/search/fork/scope/binding，**没有 `get(id)` 也没有 `list()`**，
 * 所以 `header.cwd` 在浏览器侧根本取不到。权威路径是把这个 sessionId 交给 host：
 * host 的 `ctx.sessions.get(id).header.cwd` 就是项目的绝对路径
 * （DSH 硬约束 `session.cwd === workspace.path`）。
 *
 * 这里保留 duck typing 只是为了让宿主在将来把 `get`/`list` 加回来时自动受益；
 * 拿不到就返回 null，由 host 用 sessionId 兜底——不会再出现"因为拿不到 cwd
 * 而整条隐藏"的死路。
 */
function cwdOfSession(ctx: ClientContext, sessionId: string | undefined): string | null {
  if (sessionId === undefined || sessionId.length === 0) return null;
  const sessions = ctx.get<{
    get?: (id: string) => { header?: { cwd?: string } } | undefined;
    list?: () => Array<{ id?: string; header?: { cwd?: string } }>;
  }>('sessions');
  if (sessions === undefined) return null;
  try {
    if (typeof sessions.get === 'function') {
      const one = sessions.get(sessionId);
      const cwd = one?.header?.cwd;
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    }
    if (typeof sessions.list === 'function') {
      const found = sessions.list().find((entry) => entry.id === sessionId);
      const cwd = found?.header?.cwd;
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 跑一条 / 停一条。
 *
 * 跑的时候**必须带上当前会话 id**：host 要用它把终端 owner 定到"发起这次执行的那个
 * 会话的 Agent"上（`ctx.terminals` 的每个操作都要一个活着的 Agent 当 owner）。
 * 少传它就只会得到一条明确的错误，而不是悄悄什么也不做。
 */
async function runEntry(
  projectRoot: string,
  entryId: string,
  sessionId: string | null,
): Promise<ApiResult<unknown>> {
  return call<unknown>('/run', 'POST', {
    projectRoot,
    entryId,
    ...(sessionId !== null && sessionId.length > 0 ? { sessionId } : {}),
  });
}
async function stopRun(runId: string): Promise<ApiResult<unknown>> {
  return call<unknown>('/stop', 'POST', { runId });
}

/* ================================================================== *
 * 按钮条
 * ================================================================== */

interface BarActions {
  onRun(projectRoot: string, entryId: string): Promise<ApiResult<unknown>>;
  onStop(runId: string): Promise<ApiResult<unknown>>;
}

interface BarProps {
  buttons: FloatingButtonView[];
  runs: RundeckState['runs'];
  density: ButtonDensity;
  runtime: Runtime;
  busy: string | null;
  actions: BarActions;
  onCycleDensity(): void;
  onOpenAdd(): void;
  onOpenSettings(): void;
  onOpenError(): void;
  onOpenOverflow(): void;
  openPanel: 'none' | 'add' | 'settings' | 'error' | 'overflow';
  onClosePanel(): void;
  entries: ResolvedEntry[];
  projectRoot: string | null;
  configFile?: string;
  warnings: string[];
  capabilities: RundeckState['capabilities'];
  hostVersion: string;
  configSource: string;
  onReorder(order: string[]): Promise<void>;
  onPin(entry: string, pinned: boolean): Promise<void>;
  /** 最近一次跑/停的失败原因；非 null 时条上出现一个可点的告警标记。 */
  lastError: string | null;
}

/**
 * 按钮条本体：**纯正常流布局**，宽度由插槽给（宿主排版）。
 * 没有 DOM 测量、没有 fixed 定位——因此输入框变宽变窄天然跟随。
 */
function FloatingBar(props: BarProps): React.ReactElement | null {
  const {
    buttons, runs, density, runtime, busy, actions, onCycleDensity,
    onOpenAdd, onOpenSettings, onOpenError, onOpenOverflow, openPanel, onClosePanel,
  } = props;

  if (buttons.length === 0) return null;

  const ordered = [...buttons].sort((left, right) => left.order - right.order);
  // 逐级降档：按当前密度估算每条占用，放不下的进溢出菜单。
  // 用 CSS 的 flex + overflow 兜住视觉；这里的估算是为了让溢出菜单有内容。
  const perButton = density === 'icon' ? 34 : density === 'compact' ? 100 : 176;
  const capacity = 8; // 估算上限；真实裁剪交给 CSS
  void perButton;
  const visible = ordered.slice(0, Math.min(ordered.length, capacity));
  const overflow = ordered.slice(visible.length);

  const liveRunOf = (projectRoot: string, entryId: string): string | undefined =>
    runs.find(
      (run) =>
        run.projectRoot === projectRoot && run.entryId === entryId && run.status !== 'exited',
    )?.runId;

  /**
   * 左侧固定钮：三档密度循环。
   *
   * 原来的写法只在字形上做文章（`▥`/`▤`/`▨` 三个"方块填充度"），三个字形几乎一样，
   * 谁也看不出它在控制什么、现在在第几档。现在：
   *   - 按钮上**直接写出当前档位的名字**（完整 / 紧凑 / 图标），字形只是恒定的控件标记；
   *   - tooltip（`title`）写明"这是按钮密度、当前第几档、点一下到哪一档"。
   */
  const densityStateLabel = runtime.t(densityLabelKey(density));
  const densityNextLabel = runtime.t(densityLabelKey(nextDensityOf(density)));
  const densityHint =
    `${runtime.t('settingsDensity')}：${densityStateLabel}` +
    ` · ${runtime.t('densityCycle')} → ${densityNextLabel}`;

  return (
    <div className="__ru_host">
      {openPanel === 'add' ? (
        <div className="__ru_pop">
          <AddPanel {...props} />
        </div>
      ) : null}
      {openPanel === 'settings' ? (
        <div className="__ru_pop">
          <SettingsPanel {...props} />
        </div>
      ) : null}
      {openPanel === 'error' && props.lastError !== null ? (
        <div className="__ru_pop">
          <ErrorPanel
            runtime={runtime}
            message={props.lastError}
            onOpenSettings={onOpenSettings}
            onClosePanel={onClosePanel}
          />
        </div>
      ) : null}
      {openPanel === 'overflow' && overflow.length > 0 ? (
        <div className="__ru_menu">
          {overflow.map((button) => {
            const runId = liveRunOf(button.projectRoot, button.entry);
            return (
              <button
                type="button"
                key={button.entry}
                className="__ru_menuItem"
                onClick={() => {
                  if (runId !== undefined) void actions.onStop(runId);
                  else void actions.onRun(button.projectRoot, button.entry);
                  onClosePanel();
                }}
              >
                <span aria-hidden="true">{iconGlyph(button.icon)}</span>
                <span>{button.label ?? button.entryLabel}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="__ru_bar" data-testid="rundeck-bar" data-density={density}>
        <button
          type="button"
          className="__ru_btn __ru_fixed"
          onClick={onCycleDensity}
          title={densityHint}
          aria-label={densityHint}
        >
          {/* 字形恒定（"这是一个控件"的标记），档位靠文字说清楚 */}
          <span aria-hidden="true">▤</span>
          <span className="__ru_btnLabel">{densityStateLabel}</span>
        </button>

        <div className="__ru_grow">
          {visible.map((button) => {
            const runId = liveRunOf(button.projectRoot, button.entry);
            const active = button.active === true;
            const text = labelFor(button, density);
            const status = button.status;
            // 状态要看得出来：还在跑（构建/启动中）与已经就绪是两件事，
            // 早先两者都是同一个绿点，于是"点了半天没动静"根本分不清。
            const statusLabel =
              status === 'ready'
                ? runtime.t('ready')
                : status === 'running' || status === 'starting'
                  ? runtime.t('running')
                  : status === 'stopping'
                    ? runtime.t('stopping')
                    : runtime.t('run');
            return (
              <button
                type="button"
                key={button.entry}
                className={active ? '__ru_btn __ru_btnActive' : '__ru_btn'}
                onClick={() => {
                  if (runId !== undefined) void actions.onStop(runId);
                  else void actions.onRun(button.projectRoot, button.entry);
                }}
                disabled={busy !== null}
                data-entry={button.entry}
                data-status={active ? (status ?? 'running') : 'idle'}
                title={
                  `${button.label ?? button.entryLabel} — ${active ? runtime.t('stop') : runtime.t('run')}` +
                  (active ? `（${statusLabel}）` : '')
                }
              >
                <span aria-hidden="true">{iconGlyph(button.icon)}</span>
                {text.length > 0 ? <span className="__ru_btnLabel">{text}</span> : null}
                {active ? <span className="__ru_dot" /> : null}
              </button>
            );
          })}
          {overflow.length > 0 ? (
            <button
              type="button"
              className="__ru_btn"
              onClick={onOpenOverflow}
              title={runtime.t('overflow')}
            >
              ⋯
            </button>
          ) : null}
        </div>

        <div className="__ru_tail">
          {/*
            起不来的原因必须看得见。点它开的是**这条错误自己的面板**，不是设置面板——
            早先这里直接 `onOpenSettings`，于是"点了启动失败几个字，弹出来的是设置界面"，
            而真正的原因只藏在 tooltip 里（还得悬停才看得到）。
          */}
          {props.lastError !== null ? (
            <button
              type="button"
              className={openPanel === 'error' ? '__ru_btn __ru_errorBtn __ru_fixed' : '__ru_btn __ru_errorBtn'}
              onClick={props.onOpenError}
              title={props.lastError}
              aria-label={`${runtime.t('runFailed')}：${props.lastError}`}
            >
              <span aria-hidden="true">⚠</span>
              <span className="__ru_btnLabel">{runtime.t('runFailed')}</span>
            </button>
          ) : null}
          <button
            type="button"
            className={openPanel === 'add' ? '__ru_btn __ru_fixed' : '__ru_btn'}
            onClick={onOpenAdd}
            title={runtime.t('add')}
            aria-label={runtime.t('add')}
            disabled={props.projectRoot === null}
          >
            +
          </button>
          <button
            type="button"
            className={openPanel === 'settings' ? '__ru_btn __ru_fixed' : '__ru_btn'}
            onClick={onOpenSettings}
            title={runtime.t('settings')}
            aria-label={runtime.t('settings')}
          >
            ⚙
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================================================================== *
 * `+` 面板：当前工作区的全部条目 + burger 拖拽排序
 * ================================================================== */

/** `+` 面板——"完整管理视图"，顺序即按钮条顺序。 */
function AddPanel(props: BarProps): React.ReactElement {
  const { entries, runtime, projectRoot, buttons, onPin, onReorder, onClosePanel } = props;
  const [order, setOrder] = React.useState<string[]>(() =>
    [...entries]
      .sort((left, right) => {
        const l = buttons.find((b) => b.entry === left.id)?.order ?? 999;
        const r = buttons.find((b) => b.entry === right.id)?.order ?? 999;
        return l - r;
      })
      .map((entry) => entry.id),
  );
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= order.length || to === from) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    setOrder(next);
    void onReorder(next).catch(() => setError(runtime.t('saveFailed')));
  };

  return (
    <div>
      <h4 className="__ru_popTitle">{runtime.t('addTitle')}</h4>
      <p className="__ru_popHint">{runtime.t('addHint')}</p>
      {error !== null ? <p className="__ru_error">❌ {error}</p> : null}

      {order.map((entryId, index) => {
        const entry = byId.get(entryId);
        if (entry === undefined) return null;
        const pinned = buttons.some((b) => b.entry === entryId);
        return (
          <div
            key={entryId}
            className={dragIndex === index ? '__ru_row __ru_rowDragging' : '__ru_row'}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragIndex !== null) move(dragIndex, index);
              setDragIndex(null);
            }}
          >
            <span
              className="__ru_handle"
              title="拖拽排序"
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragEnd={() => setDragIndex(null)}
            >
              ⋮⋮
            </span>
            <span aria-hidden="true">{entryIcon(entryId, buttons)}</span>
            <div className="__ru_rowBody">
              <span className="__ru_rowLabel">{entry.label}</span>
              <span className="__ru_rowCmd">{[entry.command, ...entry.args].join(' ')}</span>
            </div>
            <div className="__ru_rowActions">
              <span className={pinned ? '__ru_tag __ru_tagOn' : '__ru_tag'}>
                {pinned ? runtime.t('addPinned') : runtime.t('addUnpinned')}
              </span>
              <button
                type="button"
                className="__ru_btn"
                disabled={projectRoot === null}
                onClick={() => {
                  void onPin(entryId, !pinned).catch(() => setError(runtime.t('saveFailed')));
                }}
              >
                {pinned ? runtime.t('addHide') : runtime.t('addPin')}
              </button>
            </div>
          </div>
        );
      })}

      <div className="__ru_sep" />
      <div className="__ru_rowActions" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="__ru_btn" onClick={onClosePanel}>
          {runtime.t('addClose')}
        </button>
      </div>
    </div>
  );
}

/** 条目在按钮条上的图标（没有就退化成 play）。 */
function entryIcon(entryId: string, buttons: FloatingButtonView[]): string {
  return iconGlyph(buttons.find((button) => button.entry === entryId)?.icon ?? 'play');
}

/* ================================================================== *
 * ⚠ 失败原因面板
 * ================================================================== */

/**
 * "点了没反应 / 起不来"时，把宿主返回的**原话**摆出来。
 *
 * 为什么单独一个面板而不是复用设置面板：早先这个标记直接 `onOpenSettings`，
 * 于是"点启动失败几个字，弹出来的是设置界面"——用户要看的是原因，不是配置。
 * 原因藏在 tooltip 里也不够（要悬停、长文本会被截）。
 */
function ErrorPanel(props: {
  runtime: Runtime;
  message: string;
  onOpenSettings(): void;
  onClosePanel(): void;
}): React.ReactElement {
  const { runtime, message, onOpenSettings, onClosePanel } = props;
  return (
    <div>
      <h4 className="__ru_popTitle">
        <span aria-hidden="true">⚠ </span>
        {runtime.t('errorTitle')}
      </h4>
      {/* 原话整段保留（换行、长路径都不折损），可以选中复制 */}
      <p className="__ru_errorText">{message}</p>
      <p className="__ru_popHint">{runtime.t('errorHint')}</p>
      <div className="__ru_rowActions" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="__ru_btn" onClick={onOpenSettings}>
          {runtime.t('errorOpenSettings')}
        </button>
        <button type="button" className="__ru_btn" onClick={onClosePanel}>
          {runtime.t('errorClose')}
        </button>
      </div>
    </div>
  );
}

/* ================================================================== *
 * ⚙ 设置面板
 * ================================================================== */

function SettingsPanel(props: BarProps): React.ReactElement {
  const { runtime, density, capabilities, hostVersion, configSource, warnings, onClosePanel } = props;
  const [saving, setSaving] = React.useState(false);

  const choose = async (next: ButtonDensity): Promise<void> => {
    setSaving(true);
    await call('/density', 'POST', { density: next });
    setSaving(false);
  };

  const options: Array<{ value: ButtonDensity; label: string }> = [
    { value: 'full', label: runtime.t('densityFull') },
    { value: 'compact', label: runtime.t('densityCompact') },
    { value: 'icon', label: runtime.t('densityIcon') },
  ];

  return (
    <div>
      <h4 className="__ru_popTitle">{runtime.t('settingsTitle')}</h4>

      <div className="__ru_kv">
        <span className="__ru_key">{runtime.t('settingsProject')}</span>
        <span className="__ru_val">{props.projectRoot ?? '—'}</span>
        {props.configFile !== undefined ? (
          <>
            <span className="__ru_key">{runtime.t('settingsManifest')}</span>
            <span className="__ru_val">{props.configFile}</span>
          </>
        ) : null}
        <span className="__ru_key">{runtime.t('settingsSource')}</span>
        <span className="__ru_val">{configSource}</span>
      </div>

      <div className="__ru_sep" />
      <div style={{ marginBottom: 6 }}>{runtime.t('settingsDensity')}</div>
      <div className="__ru_options">
        {options.map((option) => (
          <button
            type="button"
            key={option.value}
            className={density === option.value ? '__ru_option __ru_optionOn' : '__ru_option'}
            disabled={saving}
            onClick={() => void choose(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="__ru_sep" />
      <div style={{ marginBottom: 6 }}>{runtime.t('settingsRuns')}</div>
      {props.runs.length === 0 ? (
        <p className="__ru_popHint">{runtime.t('settingsNoRuns')}</p>
      ) : (
        <div className="__ru_kv">
          {props.runs.map((run) => (
            <React.Fragment key={run.runId}>
              <span className="__ru_key">{run.label}</span>
              <span className="__ru_val">
                {run.status}
                {run.pid !== undefined && run.pid > 0 ? ` · pid ${run.pid}` : ''}
                {run.exitCode !== undefined && run.exitCode !== null ? ` · exit ${run.exitCode}` : ''}
                {run.ready?.url !== undefined ? ` · ${run.ready.url}` : ''}
                {/* onReady 接力：点一个按钮却跑起来两条，界面必须说出来（manifest 里写的） */}
                {run.chainedTo !== undefined ? ` · → ${run.chainedTo}（onReady）` : ''}
              </span>
              {/* 脚本自己没起来时，唯一说得清原因的就是它自己的输出 */}
              {run.tail !== undefined && run.tail.length > 0 ? (
                <span className="__ru_key" style={{ gridColumn: '1 / -1' }}>
                  <pre className="__ru_runTail">{run.tail.join('\n')}</pre>
                </span>
              ) : null}
            </React.Fragment>
          ))}
        </div>
      )}

      {warnings.length > 0 ? (
        <>
          <div className="__ru_sep" />
          <div style={{ marginBottom: 6 }}>{runtime.t('settingsWarnings')}</div>
          {warnings.map((warning) => (
            <p className="__ru_popHint" key={warning}>
              ⚠️ {warning}
            </p>
          ))}
        </>
      ) : null}

      <div className="__ru_sep" />
      <div className="__ru_kv">
        <span className="__ru_key">{runtime.t('settingsCapability')}</span>
        <span className="__ru_val">
          {capabilities.subprocess
            ? runtime.t('settingsSubprocess')
            : `${runtime.t('settingsSubprocessMissing')}${capabilities.subprocessReason !== undefined ? `：${capabilities.subprocessReason}` : ''}`}
        </span>
        <span className="__ru_key">{runtime.t('settingsHost')}</span>
        <span className="__ru_val">v{hostVersion}</span>
        <span className="__ru_key">{runtime.t('settingsClient')}</span>
        <span className="__ru_val">v{CLIENT_VERSION}</span>
      </div>

      <div className="__ru_rowActions" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="__ru_btn" onClick={onClosePanel}>
          {runtime.t('settingsClose')}
        </button>
      </div>
    </div>
  );
}

/* ================================================================== *
 * 宿主壳：按会话 id 取 cwd，拉状态
 * ================================================================== */

interface HostProps {
  runtime: Runtime;
  ctx: ClientContext;
  /** 会话级插槽由宿主注入；拿不到就没有焦点项目（按钮条隐藏）。 */
  sessionId?: string;
}

function FloatingBarHost(props: HostProps): React.ReactElement | null {
  const { runtime, ctx, sessionId } = props;
  const [state, setState] = React.useState<RundeckState | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  /**
   * 最近一次"跑/停"的失败原因。界面必须把它显示出来——"点了没反应"最难受的地方
   * 就是没有任何反馈（早先 host 只登记不执行，界面却显示"运行中"）。
   */
  const [lastError, setLastError] = React.useState<string | null>(null);
  const [panel, setPanel] = React.useState<'none' | 'add' | 'settings' | 'error' | 'overflow'>('none');
  const [density, setDensity] = React.useState<ButtonDensity>('full');

  const pull = React.useCallback(async (): Promise<RundeckState | null> => {
    // cwd 拿得到就带上（等价于直接指定项目），拿不到就只报 sessionId，
    // 由 host 用自己的 sessions 服务把会话解析成项目根目录。
    // 注：客户端 sessions 服务的 SessionBinding.session（ISession/SessionSnapshot）
    // 里**没有** header.cwd，所以这条路只能是"将来宿主补上就用"的旁路。
    const cwd = cwdOfSession(ctx, sessionId);
    const result = await pullState(cwd, sessionId ?? null);
    if (!result.ok) return null;
    report('slot-rendered', {
      sessionId: sessionId ?? null,
      clientCwd: cwd,
      projects: result.projects.length,
      focused: result.focused?.projectRoot ?? null,
      reason: result.focused?.reason ?? null,
      buttons: result.buttons.length,
    });
    // 结果签名一变就再报一行（不同会话、不同项目、不同原因各留一行）。
    // `hidden` 是"这一帧条不会画出来"——把"没按钮"这件事变成日志里能读到的事实。
    reportKeyed(
      `state:${sessionId ?? '(no-session)'}|${cwd ?? ''}|${result.focused?.projectRoot ?? ''}|` +
        `${result.focused?.reason ?? ''}|${result.buttons.length}`,
      'state-changed',
      {
        sessionId: sessionId ?? null,
        clientCwd: cwd,
        projects: result.projects.length,
        focused: result.focused?.projectRoot ?? null,
        reason: result.focused?.reason ?? null,
        buttons: result.buttons.length,
        hidden: result.buttons.length === 0,
      },
    );
    // 客户端报的 cwd 在 host 侧没解析出项目时，让它现读一次（任意目录都能用）。
    if (cwd !== null && result.focused !== null && result.focused.projectRoot === null) {
      const focus = await call<{ focused: { projectRoot: string | null } }>('/focus', 'POST', { cwd });
      if (focus.ok && focus.focused.projectRoot !== null) {
        const again = await pullState(cwd, sessionId ?? null);
        if (again.ok) {
          setState(again);
          if (again.layout.density !== undefined) setDensity(again.layout.density);
          return again;
        }
        return null;
      }
    }
    setState(result);
    if (result.layout.density !== undefined) setDensity(result.layout.density);
    return result;
  }, [ctx, sessionId]);

  /**
   * 轮询。**拿到焦点前用快节奏**：DSH 刚启动的那一两秒里，这个会话还没进
   * host 的内存会话存储（`ctx.sessions.get(id)` 还是 undefined），于是第一次
   * `/state` 必然解析不出项目——按 2.5s 的常规节奏要等好几秒条才出现，
   * 看起来就像"又坏了"。所以先 700ms 快速重试，拿到焦点后落回 2.5s。
   */
  React.useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      const result = await pull();
      if (stopped) return;
      // 就绪地址由**界面**打开（宿主那边没有可用入口，见 openReadyUrl 的注释）。
      // 每次轮询都看一眼：run 从 running 变成 ready 的那一刻地址才出现。
      for (const run of result?.runs ?? []) {
        const url = run.ready?.url;
        if (url !== undefined && url.length > 0) openReadyUrl(run.runId, url);
      }
      const focused = result?.focused?.projectRoot ?? null;
      if (focused !== null) {
        // 第一次拿到焦点时再报一次（阶段名不同，不会被去重），
        // 这样日志能看出"重启后先空、随后恢复"的完整过程。
        report('slot-focused', { focused, buttons: result?.buttons.length ?? 0 });
        // 画完这一帧再量几何（report 内部按阶段去重，只发一次）。
        setTimeout(() => reportGeometry(), 150);
      }
      timer = setTimeout(() => void tick(), focused === null ? 700 : 2500);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [pull]);

  if (state === null) return null;

  const cycle: ButtonDensity[] = ['full', 'compact', 'icon'];
  const nextDensity = (): ButtonDensity =>
    cycle[(cycle.indexOf(density) + 1) % cycle.length] ?? 'full';

  const actions: BarActions = {
    onRun: async (projectRoot, entryId) => {
      setBusy(entryId);
      const result = await runEntry(projectRoot, entryId, sessionId ?? null);
      setBusy(null);
      // 起不来时必须说出来：早先这里把结果丢掉，于是"点了没反应"完全无从查起。
      setLastError(result.ok ? null : `${result.message}${result.hint !== undefined ? `（${result.hint}）` : ''}`);
      await pull();
      return result;
    },
    onStop: async (runId) => {
      setBusy(runId);
      const result = await stopRun(runId);
      setBusy(null);
      setLastError(result.ok ? null : `${result.message}${result.hint !== undefined ? `（${result.hint}）` : ''}`);
      await pull();
      return result;
    },
  };

  return (
    <FloatingBar
      buttons={state.buttons}
      runs={state.runs}
      density={density}
      runtime={runtime}
      busy={busy}
      actions={actions}
      openPanel={panel}
      onClosePanel={() => setPanel('none')}
      lastError={lastError}
      onOpenOverflow={() => setPanel('overflow')}
      onCycleDensity={() => setDensity(nextDensity())}
      onOpenAdd={() => setPanel(panel === 'add' ? 'none' : 'add')}
      onOpenSettings={() => setPanel(panel === 'settings' ? 'none' : 'settings')}
      onOpenError={() => setPanel(panel === 'error' ? 'none' : 'error')}
      entries={state.focusedEntries}
      projectRoot={state.focused?.projectRoot ?? null}
      configFile={state.focused?.configFile}
      warnings={state.warnings}
      capabilities={state.capabilities}
      hostVersion={state.pluginVersion}
      configSource={state.configSource}
      onReorder={async (order) => {
        await call('/reorder', 'POST', { order });
        await pull();
      }}
      onPin={async (entry, pinned) => {
        await call('/button', 'POST', { entry, pinned });
        await pull();
      }}
    />
  );
}

/* ================================================================== *
 * 插件本体
 * ================================================================== */

const plugin = {
  inject: ['slots', 'locale'],

  apply(ctx: ClientContext): void {
    injectStyles();

    // 诊断第 1 站：包被浏览器加载并执行到 apply()。host 日志里看到这一行
    // 就说明 client/client.js 确实到达了页面；看不到就说明包根本没被取到。
    report('client-loaded');

    const slots = ctx.get<DshSlotsService>('slots');
    if (slots === undefined) {
      ctx.logger?.warn?.('[dsh-rundeck] slots 服务不可用，按钮条未挂载');
      // 单独一个阶段名（report 每个阶段只发一次，复用 client-loaded 会被去重掉）。
      report('client-no-slots');
      return;
    }

    const locale = ctx.get<DshLocaleService>('locale');
    if (locale !== undefined) {
      ctx.effect(() => locale.register(NS, 'zh', ZH), 'dsh-rundeck: zh dictionary');
      ctx.effect(() => locale.register(NS, 'en', EN), 'dsh-rundeck: en dictionary');
    }

    const t = (key: string): string => {
      const bound = locale?.bind?.(NS);
      if (bound !== undefined) {
        const value = bound(key);
        if (typeof value === 'string' && value.length > 0 && value !== key) return value;
      }
      const id = locale?.getLocale?.().id ?? 'zh';
      const dict = id.toLowerCase().startsWith('zh') ? ZH : EN;
      return dict[key] ?? ZH[key] ?? key;
    };

    const runtime: Runtime = { t };

    /**
     * 注册在**会话级**插槽 `conversation.input.dock`——宿主给「输入框卡片上方整宽条目」
     * 留的那一列。它与「任务列表」（ui-conversation 的 `todo` 条目，order 0）、
     * 目标（ui-goal，order 10）、队列（ui-conversation 的 `queue` 条目，order 20）
     * **同列堆叠**：宿主按 order 排版、块间 `--dsh-composer-stack-gap: 6px`，
     * 宽度由宿主给的那套变量算，互不遮挡。order = **15**：排在任务列表(0)、
     * 目标(10)之后，队列(20)之前。
     *
     * 为什么是 15 而不是随手一个中间值：这一列里**队列那一行是"贴在输入框上"的**
     * ——它自己带 `margin:0 auto calc(0px - gap - 3px)`（负底边距，吃掉行距再往卡片
     * 上沿压 3px）、圆角只有上面两个，宿主明确把它当作卡片的一部分。所以它必须是
     * 紧邻卡片的那一行，任何别的行都不能插到它与卡片之间。我们自己则是一组
     * "针对输入框的动作"（在这个工作区里能跑什么），性质最接近队列，因此紧挨着它、
     * 排在这一列的下半段；而任务列表/目标是"智能体在做什么"的状态读出，排在更上面。
     *
     * 为什么从 `conversation.input.overlay` 迁过来：overlay 是卡片内
     * `height:0; position:absolute; inset:0 0 auto` 的锚点，条只能绝对定位浮在
     * 卡片上沿往上 34px 的那条带里——而那条带**正是 dock 各行的位置**，
     * 于是条会把「任务列表」压在下面。同类东西放在同一个堆叠里，是宿主自己的做法。
     *
     * 渲染条件：宿主只在 `{session, input}` 都在时才渲染这一列
     * （`zone !== void 0 && renderSlot("conversation.input.dock", zone)`）。
     *
     * ⚠️ 会话 id 仍然必须走注册项的 `inject(sessionId)`——**它不在组件 props 里**。
     * dock 的 owner props 是 `{session, input}`（`SessionSnapshot` 里**没有** cwd），
     * 所以会话 id 只有这一条来路。之前直接读 `raw.sessionId` 导致 sessionId 恒为
     * undefined → /state 既没 cwd 也没 sessionId → focused=null、buttons=[] →
     * 整条永远不渲染。同列的官方条目（todo/goal/queue）都是用 `inject` 拿会话的。
     */
    slots.inject('conversation.input.dock', () =>
      slots.register(
        {
          name: 'conversation.input.dock',
          id: `${NS}-bar`,
          order: 15,
          label: () => t('add'),
          inject: (sessionId) => ({ sessionId }),
        },
        (raw) =>
          React.createElement(FloatingBarHost, {
            runtime,
            ctx,
            ...(typeof (raw as { sessionId?: unknown } | undefined)?.sessionId === 'string'
              ? { sessionId: (raw as { sessionId: string }).sessionId }
              : {}),
          }),
      ),
    );

    ctx.logger?.info?.('[dsh-rundeck] client half mounted');
  },
};

export default Object.assign(plugin, {
  internals: {
    AddPanel,
    CLIENT_VERSION,
    COMPACT_MAX_CHARS,
    CSS,
    ErrorPanel,
    FloatingBar,
    FloatingBarHost,
    SettingsPanel,
    STACK_LIFT_RULE,
    cwdOfSession,
    iconGlyph,
    injectStyles,
    labelFor,
    openReadyUrl,
    truncate,
    EN,
    ZH,
  },
});
