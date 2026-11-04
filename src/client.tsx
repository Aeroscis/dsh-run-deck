/**
 * dsh-run-deck — client half（TSX 源文件）。
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
 * 与 host 的唯一数据通道是 `fetch("/dsh-run-deck/api/*")`，见 src/routes.ts。
 */
import React from 'react';

import type {
  ApiResult,
  ButtonDensity,
  DetectedTask,
  FloatingButtonView,
  NewTaskInput,
  ResolvedEntry,
  RunDeckState,
  RunRecord,
  TaskDetection,
  TaskGroup,
} from './types.js';

const NS = 'dsh-run-deck';
const API = '/dsh-run-deck/api';

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
  output: '输出',
  outputEmpty: '这条还没说过一句话',
  outputHint: '最近 200 行 · 每 2.5 秒随轮询长出新的一批',
  pin: '钉住（拿开鼠标也不消失）',
  unpin: '拔钉（恢复悬停才出现）',
  pinStateOn: '已钉住',
  pinStateOff: '钉住',
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
  createTitle: '新建启动项',
  createHint: '填名称和一行命令就够了；工作目录、环境变量、就绪正则这些收在「更多设置」里。创建后会写进这个项目的 .dsh/run-deck/run.json，并自动钉到按钮条。',
  detectTitle: '从项目里检测',
  detectHint: '点一条就填进下面的表单（填进去之后仍然可以改）。',
  detectLoading: '正在读 package.json…',
  detectEmpty: '没有可检测的 scripts（没有 package.json，或者里面没有 scripts）；用下面的通用模板，或者直接自己填。',
  detectExists: '已在清单',
  detectTemplates: '通用模板',
  detectScripts: 'package.json 的 scripts',
  commandSplitHint: '第一个词是命令，其余是参数（含空格的参数用引号）。',
  copyTitle: '从已有条目复制',
  copyPlaceholder: '选择一条…（复制命令、目录、环境变量、就绪正则；id 不复制）',
  moreShow: '展开更多设置',
  moreHide: '收起更多设置',
  fieldName: '名称',
  fieldCommand: '命令行',
  fieldCwd: '工作目录',
  fieldCwdPlaceholder: '留空 = 项目根目录（${workspaceFolder}）',
  fieldEnv: '环境变量',
  fieldEnvPlaceholder: 'KEY=value，每行一条',
  fieldEnvInvalid: '环境变量要写成 KEY=value，这一行看不懂：',
  fieldBackground: '长驻（跑完不退出）',
  fieldGroup: '分组',
  groupNone: '无',
  groupBuild: '构建',
  groupTest: '测试',
  fieldId: 'id',
  fieldIdPlaceholder: '可选；留空由名称派生',
  fieldReady: '就绪正则',
  fieldReadyPlaceholder: '例如：(https?://\\S+)',
  fieldReadyHint: '命中即算「就绪」；填的是正则源码本身，不带两边的斜杠。',
  fieldOpenUrl: '就绪后打开地址',
  fieldUrlPattern: 'URL 正则',
  fieldUrlPatternPlaceholder: '留空 = 用上面的就绪正则',
  fieldUriFormat: '地址格式',
  fieldUriFormatPlaceholder: '可选；%s = 抓到的地址',
  fieldReveal: '跑起来时自动钉住输出卡',
  fieldOnReady: '就绪后接着跑',
  fieldOnReadyNone: '不接续',
  fieldIcon: '按钮图标',
  fieldIconPlaceholder: '可选：eye / play / hammer …',
  fieldButtonGroup: '按钮分组',
  fieldButtonGroupPlaceholder: '可选；同组按钮在条上相邻',
  fieldAppearanceHint: '图标与分组只写进本机的 layout.json，不进仓库、不影响别人。',
  createdNote: '已写进 .dsh/run-deck/run.json 并钉到按钮条。',
  createdUnpinnedNote: '已写进 .dsh/run-deck/run.json，但没能钉上按钮条。',
  pinRetryNote: '可以在 ☰「管理」面板里手动钉上。',
  manageTitle: '管理启动项',
  deleteEntry: '删除',
  deleteConfirm: '确认删除',
  deleteCancel: '取消',
  deleteHint: '从 .dsh/run-deck/run.json 里移除这条任务（和"从按钮条收起"不同）',
  addAllOnBar: '全部条目都已经在按钮条上了（run.json 的 buttons[] 已把它们声明为按钮，或清单没写 buttons[] 时默认全部上条），所以这里没有可添加的条目。想试「钉到按钮条」，先对某一行点一下「从按钮条收起」。',
  newTaskTitle: '新建启动项',
  newTaskHint: '写进这个项目的 .dsh/run-deck/run.json（和手改同一个文件），创建后自动钉到按钮条。',
  newTaskLabelPlaceholder: '名称，例如：启动开发服务器',
  newTaskCommandPlaceholder: '命令，例如：npm run dev',
  newTaskCreate: '创建并钉到按钮条',
  allHiddenNote: '全部按钮已收起 · 点 + 把要用的钉回来',
  noEntriesNote: '这个目录还没有启动项 · 点 + 新建第一条',
  noProjectNote: '还没有焦点项目 · 打开一个工作区后这里就能新建启动项',
  noManifestNote: '还没有任何启动项；用下面的表单建第一条（如果还没有 .dsh/run-deck/run.json，会自动创建）。',
  restoreAll: '全部钉回来',
  addPinned: '已在条上',
  addUnpinned: '未添加',
  addPin: '钉到按钮条',
  addHide: '从按钮条收起',
  addClose: '关闭',
  dragHint: '拖动排序',
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
  noFocus: '当前目录没有 .dsh/run-deck/run.json',
  noFocusHint: '在项目根目录放一份 .dsh/run-deck/run.json，就会出现这个工作区的启动按钮。',
};

const EN: Record<string, string> = {
  run: 'Run',
  stop: 'Stop',
  running: 'running',
  ready: 'ready',
  exited: 'exited',
  starting: 'starting',
  stopping: 'stopping',
  output: 'Output',
  outputEmpty: 'Nothing printed yet',
  outputHint: 'Last 200 lines · refreshed with each 2.5s poll',
  pin: 'Pin (stays even after you move away)',
  unpin: 'Unpin (back to hover-only)',
  pinStateOn: 'Pinned',
  pinStateOff: 'Pin',
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
  createTitle: 'New launch entry',
  createHint: 'A name and a one-line command are enough; working directory, env vars and ready patterns live under "More settings". It is written into this project’s .dsh/run-deck/run.json and pinned to the bar.',
  detectTitle: 'Detected in this project',
  detectHint: 'Click one to fill the form below (you can still change every field).',
  detectLoading: 'Reading package.json…',
  detectEmpty: 'No scripts to detect (no package.json, or it has no scripts); use a template below or fill the form yourself.',
  detectExists: 'already in manifest',
  detectTemplates: 'Templates',
  detectScripts: 'package.json scripts',
  commandSplitHint: 'First word is the command, the rest are arguments (quote arguments containing spaces).',
  copyTitle: 'Copy an existing entry',
  copyPlaceholder: 'Pick one… (copies command, cwd, env and ready patterns; not the id)',
  moreShow: 'More settings',
  moreHide: 'Hide extra settings',
  fieldName: 'Name',
  fieldCommand: 'Command',
  fieldCwd: 'Working dir',
  fieldCwdPlaceholder: 'Empty = project root (${workspaceFolder})',
  fieldEnv: 'Env vars',
  fieldEnvPlaceholder: 'KEY=value, one per line',
  fieldEnvInvalid: 'Env vars must be KEY=value; cannot parse line:',
  fieldBackground: 'Long-running (do not exit)',
  fieldGroup: 'Group',
  groupNone: 'none',
  groupBuild: 'build',
  groupTest: 'test',
  fieldId: 'id',
  fieldIdPlaceholder: 'Optional; derived from the name',
  fieldReady: 'Ready pattern',
  fieldReadyPlaceholder: 'e.g. (https?://\\S+)',
  fieldReadyHint: 'A match marks the run ready; this is the regex source itself, without slashes.',
  fieldOpenUrl: 'Open the URL once ready',
  fieldUrlPattern: 'URL pattern',
  fieldUrlPatternPlaceholder: 'Empty = reuse the ready pattern',
  fieldUriFormat: 'URI format',
  fieldUriFormatPlaceholder: 'Optional; %s = the captured address',
  fieldReveal: 'Pin the output card when it starts',
  fieldOnReady: 'Chain to',
  fieldOnReadyNone: 'nothing',
  fieldIcon: 'Button icon',
  fieldIconPlaceholder: 'Optional: eye / play / hammer …',
  fieldButtonGroup: 'Button group',
  fieldButtonGroupPlaceholder: 'Optional; same group stays adjacent',
  fieldAppearanceHint: 'Icon and group only go into this machine’s layout.json — not the repo, not other people.',
  createdNote: 'Written into .dsh/run-deck/run.json and pinned to the bar.',
  createdUnpinnedNote: 'Written into .dsh/run-deck/run.json, but pinning it to the bar failed.',
  pinRetryNote: 'You can pin it manually from the ☰ manage panel.',
  manageTitle: 'Manage launch entries',
  deleteEntry: 'Delete',
  deleteConfirm: 'Confirm delete',
  deleteCancel: 'Cancel',
  deleteHint: 'Removes the task from .dsh/run-deck/run.json (unlike "hide from bar")',
  addAllOnBar: 'Every entry is already on the bar (they are declared in run.json buttons[], or the manifest has no buttons[] so all entries default on), so there is nothing to add here. To try "Pin to bar", click "Hide from bar" on a row first.',
  newTaskTitle: 'New launch entry',
  newTaskHint: 'Writes into this project’s .dsh/run-deck/run.json (the same file you edit by hand) and pins it to the bar.',
  newTaskLabelPlaceholder: 'Name, e.g. Start dev server',
  newTaskCommandPlaceholder: 'Command, e.g. npm run dev',
  newTaskCreate: 'Create and pin',
  allHiddenNote: 'All buttons hidden · open + to pin some back',
  noEntriesNote: 'No launch entries here yet · open + to create the first one',
  noProjectNote: 'No focused project yet · open a workspace to create launch entries here',
  noManifestNote: 'No launch entries yet; create the first one below (a .dsh/run-deck/run.json will be created if missing).',
  restoreAll: 'Pin all back',
  addPinned: 'on bar',
  addUnpinned: 'not added',
  addPin: 'Pin to bar',
  addHide: 'Hide from bar',
  addClose: 'Close',
  dragHint: 'Drag to reorder',
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
  noFocus: 'No .dsh/run-deck/run.json in this directory',
  noFocusHint: 'Add one to the project root to get this workspace’s run buttons.',
};

/* ─────────────────────── 弹层高度 ─────────────────────── */

/**
 * 弹层与条之间的缝（px）。
 *
 * 这个数只有一处定义：`popupSpaceFor()` 的减法与 CSS 里两处
 * `bottom:calc(100% + ${POPUP_OFFSET}px)` 的锚点都引用它（CSS 用模板字符串插值，
 * 不写字面量），避免各改各的——差几像素，算出来的上限就会差几像素。
 */
const POPUP_OFFSET = 8;

/** 弹层顶边离裁切区上沿留的余量：不留会贴着边，圆角和阴影看起来像被切了。 */
const POPUP_TOP_MARGIN = 12;

/** 把「条上方可放弹层的高度」从 JS 传给 CSS 的自定义属性名。 */
const POPUP_SPACE_VAR = '--ru-pop-space';

/**
 * 条上方还能放下多高的弹层（px，向下取整）。
 *
 * **为什么需要这个数**：弹层锚在条的上沿、只向上长。新会话时宿主把整列
 * （标题、输入框）在会话区里垂直居中，条大概在屏幕中间——`max-height:80vh`
 * 的面板会伸到视口和滚动容器的上沿之外，顶部那一截既看不见也滚不到
 * （滚动容器的 `overflow` 只裁切，不会给"向上的溢出"留可滚动区域）。
 *
 * 算的是**实际可用的上边界**：取条顶边与最近裁切祖先顶边里更靠下的那个，
 * 再扣掉弹层与条之间的缝和顶部留白。结果可能为 0（条已经贴到上沿），
 * **不能返回负数**——负的 `max-height` 是无效值，会被当成"没设上限"。
 *
 * @param hostTop 条（`__ru_host`）顶边在视口坐标系里的 y。
 * @param clipTop 最近裁切祖先顶边在视口坐标系里的 y；没有则 0（视口上沿）。
 * @returns 弹层可用的最大高度。
 */
function popupSpaceFor(hostTop: number, clipTop = 0): number {
  return Math.max(0, Math.floor(hostTop - Math.max(0, clipTop) - POPUP_OFFSET - POPUP_TOP_MARGIN));
}

/**
 * 找条最近的一个**会裁切溢出**的祖先，返回它顶边的视口坐标。
 *
 * 宿主的会话内容住在 `[data-conversation-scroll]`（`overflow-y:auto`）里，弹层虽然
 * 绝对定位，仍然会被这个容器裁切。逐级往上找第一个 `overflow-y` 不是 `visible`
 * 的祖先就是实际边界；找不到就退回 0（视口上沿）。
 *
 * 只按视口上沿算会多算出一个 header 的高度，正好是顶部被切掉的那一截。
 */
function popupClipTop(host: HTMLElement): number {
  let node: HTMLElement | null = host.parentElement;
  while (node !== null) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY !== '' && overflowY !== 'visible') {
      return Math.max(0, node.getBoundingClientRect().top);
    }
    node = node.parentElement;
  }
  return 0;
}

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
  // 全部按钮被收起时的"说明 + 出口"：条还在，只是中间空着。
  '.__ru_emptyNote{flex:none;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px}',
  '.__ru_tail{flex:none;display:flex;align-items:center;gap:6px}',
  // 弹出面板 / 溢出菜单：锚在条的上方。
  // ⚠️ 这里的 z-index 只是**我们这条 host 上下文内部**的顺序，跨上下文（比如压过宿主的
  // 「回到底部」圆钮）靠的是 `STACK_LIFT_RULE` —— 把弹层自己的 z-index 调大是没用的。
  // 高度上限除了视口比例，还有一道 `--ru-pop-space`：FloatingBar 在每次绘制前量出
  // 「条上方到最近裁切祖先/视口上沿」的实际距离写进来。只按视口算（70vh/80vh）时，
  // 新会话输入框居中、条在屏幕中间，面板顶部会被裁在视口外（见 popupSpaceFor）。
  `.__ru_pop{position:absolute;z-index:10;bottom:calc(100% + ${POPUP_OFFSET}px);left:0;right:0;box-sizing:border-box;max-height:min(70vh,460px,var(${POPUP_SPACE_VAR},100vh));overflow:auto;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 40px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary);font-size:13px}`,
  '.__ru_popTitle{margin:0 0 4px;font-size:14px;font-weight:600}',
  // 「+」面板比别的弹层高：它有表单，展开「更多设置」后行数不少。
  // 上限除了 80vh/620px，同样要夹一道 `--ru-pop-space`——面板越高，越容易撞上"条在屏幕中间"。
  `.__ru_pop.__ru_popTall{max-height:min(80vh,620px,var(${POPUP_SPACE_VAR},100vh))}`,
  '.__ru_popHint{margin:0 0 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word}',
  // 「没有可添加的条目」这类"说清楚为什么"的提示：比普通 hint 更显眼一点。
  '.__ru_popNote{margin:0 0 10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
  '.__ru_popNoteRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  // 新建启动项：一小块表单（写进项目 run.json，和手改同一个文件）。
  '.__ru_newTask{margin:0 0 12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
  '.__ru_newTaskTitle{margin:0 0 4px;font-size:13px;font-weight:600}',
  '.__ru_newTaskRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  // 「+」面板的表单：一行一个字段（标签靠左固定宽、控件吃满剩余宽度）。
  // 基础只有两行，其余收在「更多设置」里——VS Code 的 tasks.json 也是这个分工：
  // 必填的就两个字段，其余靠 schema 补全，而不是一上来甩十几个输入框。
  '.__ru_form{display:flex;flex-direction:column;gap:8px;margin:10px 0}',
  '.__ru_field{display:flex;align-items:flex-start;gap:8px;min-width:0}',
  '.__ru_fieldLabel{flex:none;width:92px;padding-top:4px;text-align:right;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.__ru_fieldBody{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.__ru_fieldHint{margin:0;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}',
  '.__ru_textarea{box-sizing:border-box;width:100%;min-height:54px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:12px;line-height:18px;resize:vertical}',
  '.__ru_textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#d8863b)}',
  '.__ru_select{box-sizing:border-box;height:26px;max-width:100%;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:12px}',
  '.__ru_select:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#d8863b)}',
  '.__ru_check{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}',
  '.__ru_check input{accent-color:var(--dsw-alias-brand-primary,#d8863b)}',
  '.__ru_advanced{display:flex;flex-direction:column;gap:10px;margin:4px 0 10px;padding:10px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}',
  '.__ru_moreToggle{align-self:flex-start;height:24px;padding:0 9px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
  '.__ru_moreToggle:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  // 检测候选：一条一颗胶囊，点一下就填表。「已在清单」的那颗变灰（防重复添加）。
  '.__ru_panel{margin:0 0 10px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
  '.__ru_panelHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:2px}',
  '.__ru_panelTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
  '.__ru_panelHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
  '.__ru_chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
  '.__ru_chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:100px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}',
  '.__ru_chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}',
  '.__ru_chip:disabled{opacity:.55;cursor:default}',
  '.__ru_chipTag{flex:none;font-size:10px;line-height:14px;padding:0 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-tertiary)}',
  '.__ru_input{box-sizing:border-box;height:26px;min-width:0;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:12px;line-height:1}',
  '.__ru_input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#d8863b)}',
  '.__ru_inputGrow{flex:1 1 240px}',
  // 失败原因：保留原话的换行与长路径（不折损、可选中复制）
  '.__ru_errorText{margin:0 0 8px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;user-select:text}',
  // run 的最近几行输出（面板里"脚本自己为什么没起来"的唯一证据）
  '.__ru_runTail{margin:0;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-mono,monospace);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;user-select:text;max-height:240px;overflow:auto}',
  // 输出面板：把执行缝本来就攒着的最近几百行接出来摊开看。
  // 输出**一直在被收着**（尾行 800ms 一拍），之前只是没有一个口子亮出来。
  '.__ru_outView{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-mono,monospace);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;user-select:text;max-height:min(50vh,320px);overflow:auto}',
  '.__ru_outStatus{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400}',
  // ⌃ 输出悬浮卡：悬停出现、拿开消失、📌 钉住常驻。类名挂 `__ru_pop` 是借它两件事：
  // "绝对定位在条上方"与宿主 seat 的抬升规则（:has(. __ru_pop)）；下面的条目覆盖 pop 的
  // 通栏左宽——卡只 560px 宽（输出短时更矮更窄），不盖满。
  `.__ru_hover{display:flex;flex-direction:column;gap:6px;right:auto;width:min(560px,calc(100% - 16px));max-height:min(46vh,250px,var(${POPUP_SPACE_VAR},100vh));padding:10px 12px;border-radius:12px}`,
  '.__ru_hoverHead{display:flex;align-items:center;gap:6px;min-width:0}',
  // 脚本名不再吃 flex:1：状态徽章贴着名字排，剩下的空隙由弹簧吃掉，图钉落到最右。
  '.__ru_hoverLabel{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}',
  // 状态徽章：圈一圈的胶囊，颜色按状态走（就绪=绿、跑动=琥珀、停止中=红、已退出=灰）。
  // 颜色跟按钮上的状态点同一套语义变量，两处说的是同一件事。
  '.__ru_statusBadge{flex:none;display:inline-flex;align-items:center;padding:1px 8px;border-radius:100px;border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);font-size:11px;line-height:16px;white-space:nowrap}',
  '.__ru_statusBadge[data-status="running"],.__ru_statusBadge[data-status="starting"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
  '.__ru_statusBadge[data-status="stopping"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
  '.__ru_statusBadge[data-status="exited"]{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l2)}',
  '.__ru_hoverSpring{flex:1 1 auto}',
  '.__ru_hover .__ru_outView{flex:1 1 auto;min-height:0;max-height:none}',
  // 📌 钉住态必须"看得见"：钉住的卡在原边框外再描一圈品牌色（悬停卡没有这圈）。
  // "这张卡被钉住了"靠描边说话，不靠对着按钮上的图形猜。
  '.__ru_hover.__ru_hoverPinned{border-color:var(--dsw-alias-brand-primary,#d8863b);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#d8863b),0 12px 40px rgba(0,0,0,.28)}',
  // 钉住时图钉按钮跟着品牌色走（emoji 字形本身不吃 color，按钮里的状态文字会跟着变）。
  '.__ru_hoverPinned .__ru_pinBtn{color:var(--dsw-alias-brand-primary,#d8863b)}',
  '.__ru_pinBtn{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:22px;padding:0 7px;border:none;border-radius:100px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer}',
  '.__ru_pinText{white-space:nowrap}',
  '.__ru_pinBtn:hover{background:var(--dsw-alias-button-floating-hover)}',
  '.__ru_row{display:flex;align-items:center;gap:8px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin-bottom:6px;background:var(--dsw-alias-bg-layer-1)}',
  '.__ru_row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  // ── 拖动排序（指针事件，**不是** HTML5 draggable）──
  // 被拖那一行跟着指针走：抬起来的样子（阴影 + 分层底色），不再用 `opacity:.5`
  // 那种"原位置半透明 + 浏览器自己画的虚影"的旧做法。
  // 选择器写成 `.__ru_row.__ru_rowDragging`（两档），否则会输给上面的 `:hover`。
  '.__ru_row.__ru_rowDragging{position:relative;z-index:3;opacity:1;cursor:grabbing;border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);box-shadow:0 10px 26px rgba(0,0,0,.32)}',
  // 其余各行"让位"时的过渡：这就是"即时预览 + 动画"里那个动画。
  '.__ru_rowShift{transition:transform 180ms cubic-bezier(.2,0,0,1)}',
  // 松手那一下：被拖行滑进新槽位（FLIP），而不是啪地跳过去。
  '.__ru_rowSettle{transition:transform 160ms cubic-bezier(.2,0,0,1)}',
  '.__ru_handle{flex:none;width:20px;text-align:center;color:var(--dsw-alias-label-tertiary);cursor:grab;user-select:none;touch-action:none;font-size:15px;line-height:1}',
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
  '.__ru_error{margin:0 0 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-word}',
  `.__ru_menu{position:absolute;z-index:11;bottom:calc(100% + ${POPUP_OFFSET}px);left:0;min-width:180px;max-height:min(70vh,460px,var(${POPUP_SPACE_VAR},100vh));overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 40px rgba(0,0,0,.28)}`,
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
    'style[data-plugin-css="dsh-run-deck/main.css"]',
  );
  const tag = existing ?? document.createElement('style');
  if (existing === null) {
    tag.dataset.plugin = NS;
    tag.dataset.pluginCss = 'dsh-run-deck/main.css';
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
): Promise<ApiResult<RunDeckState>> {
  const params = new URLSearchParams();
  if (cwd !== null && cwd.length > 0) params.set('cwd', cwd);
  if (sessionId !== null && sessionId.length > 0) params.set('sessionId', sessionId);
  const query = params.toString();
  return call<RunDeckState>(`/state${query.length > 0 ? `?${query}` : ''}`, 'GET');
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
 * **每次都发**的上报（不做去重）。
 *
 * 给"同一件事会发生很多次"的诊断用：拖拽排序每拖一次都要留一行（"这次拖了几行、
 * 落点算成了第几位"），而 `reportKeyed` 的键是内容签名——同一段落点会被吃掉，
 * 那就正好看不见"为什么落点不对"。
 */
function reportEvery(stage: string, detail: Record<string, unknown>): void {
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
const OPENED_KEY = 'dsh-run-deck.openedUrls.v1';

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
    probe.setAttribute('data-run-deck-probe', 'stack');
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

/**
 * 新建一条启动项。**host 会把它真的写进项目的 .dsh/run-deck/run.json**（保留注释的最小
 * 文本插入），所以界面加的和手写进去的是同一条东西——不是存在本地布局里的影子。
 *
 * 传的是**人填的那一组字段**（名称、一行命令、可选的 cwd/env/就绪正则…）；
 * 拆命令、拼 `TaskEntry`、逐项校验都在 host（`src/newtask.ts`），界面不重复实现一份。
 */
async function createTask(
  projectRoot: string,
  input: NewTaskInput,
): Promise<ApiResult<{ entry: string }>> {
  return call<{ entry: string }>('/task', 'POST', { projectRoot, ...input });
}

/**
 * 检测这个项目里可以加什么（读 `package.json` 的 `scripts`）。
 *
 * 只读、不落盘：结果是**候选**，点一条才会填进表单。对应 VS Code 里
 * `Tasks: Run Task` 列出的那些 `npm: dev`——探测与创建是两件事。
 */
async function detectTasks(projectRoot: string): Promise<ApiResult<TaskDetection>> {
  return call<TaskDetection>('/detect', 'POST', { projectRoot });
}

/** 删除一条启动项（**真的从项目 run.json 的 tasks[] 里移除**，不是"从条上收起"）。 */
async function deleteTask(projectRoot: string, entryId: string): Promise<ApiResult<unknown>> {
  return call<unknown>('/task/remove', 'POST', { projectRoot, entryId });
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
  runs: RunDeckState['runs'];
  density: ButtonDensity;
  runtime: Runtime;
  busy: string | null;
  actions: BarActions;
  onCycleDensity(): void;
  /** 打开「+」面板：只负责新建任务（写进项目 run.json）。 */
  onOpenAdd(): void;
  /** 打开「☰」面板：管理成员（钉上/移除）与顺序（拖动排序）。 */
  onOpenManage(): void;
  onOpenSettings(): void;
  onOpenError(): void;
  /** 输出悬浮卡当前"钉"在哪条 entry（卡片头部的图钉按钮控制；null = 没钉，悬停才出现）。 */
  pinnedEntry: string | null;
  /** 钉住/拔钉某条条目的输出卡（悬浮卡头部的图钉按钮，条上没有第二颗钉钮）。 */
  onTogglePin(entry: string): void;
  onOpenOverflow(): void;
  openPanel: 'none' | 'add' | 'manage' | 'settings' | 'error' | 'overflow';
  onClosePanel(): void;
  entries: ResolvedEntry[];
  projectRoot: string | null;
  configFile?: string;
  warnings: string[];
  capabilities: RunDeckState['capabilities'];
  hostVersion: string;
  configSource: string;
  onReorder(order: string[]): Promise<void>;
  onPin(entry: string, pinned: boolean): Promise<void>;
  /**
   * 新建启动项（写进项目 run.json 的 tasks[]），成功后由调用方钉到按钮条。
   * `button` 是外观（图标/分组），只进本机 layout.json——run.json 里不存展示。
   * 条目写进清单后钉条若失败，结果带 `pinError` 原样回到面板（条目本身已建成）。
   */
  onCreateTask(
    input: NewTaskInput,
    button: { icon?: string; group?: string },
  ): Promise<ApiResult<{ entry: string; pinError?: string }>>;
  /** 删除启动项（真的从项目 run.json 的 tasks[] 里移除）。 */
  onDeleteTask(entryId: string): Promise<ApiResult<unknown>>;
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
    onOpenAdd, onOpenManage, onOpenSettings, onOpenError, onOpenOverflow, openPanel, onClosePanel,
    pinnedEntry, onTogglePin,
  } = props;

  /* ── 输出悬浮卡：悬停显示 / 拿开就消失 / 📌 钉住常驻 ── */
  const [hoverEntry, setHoverEntry] = React.useState<string | null>(null);
  /** 预览卡左缘缓存（px，相对 `__ru_host`）；鼠标进按钮那一刻量一次。 */
  const hoverLeft = React.useRef<Record<string, number>>({});
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const hostRef = React.useRef<HTMLDivElement | null>(null);

  const keepHover = (entry: string): void => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setHoverEntry(entry);
  };
  /** "拿开就消失" ≠ 立即消失：留 160ms，让鼠标从按钮挪进卡片那段间隙不闪断。 */
  const scheduleHide = (): void => {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      setHoverEntry(null);
    }, 160);
  };
  /**
   * 记下这颗按钮的左缘（`__ru_bar` 自己没有定位上下文 → offsetParent 就是
   * `__ru_host`），顺手把卡往里推到卡宽以内（别探出条外被裁掉半边）。
   */
  const noteChip = (entry: string, node: HTMLElement | null): void => {
    if (node === null) return;
    const width = hostRef.current?.clientWidth ?? 0;
    const card = Math.min(560, Math.max(0, width - 16));
    hoverLeft.current[entry] = Math.max(8, Math.min(node.offsetLeft, width - card - 8));
  };

  /**
   * 量一次「条上方还有多少高度」，写进 CSS 变量供所有向上弹的层使用。
   *
   * 每次渲染后都量（下面那个 `useLayoutEffect` 不带依赖）：宿主会在会话从空白变成
   * 有对话时把输入框从屏幕中间挪到底部，这种移动不伴随我们自己的状态变化，只靠
   * resize 事件抓不到；而父组件每 2.5 秒轮询一次，等于顺手校准。
   */
  const syncPopupSpace = React.useCallback((): void => {
    const host = hostRef.current;
    if (host === null) return;
    const space = popupSpaceFor(host.getBoundingClientRect().top, popupClipTop(host));
    host.style.setProperty(POPUP_SPACE_VAR, `${space}px`);
  }, []);

  React.useLayoutEffect(() => {
    syncPopupSpace();
  });

  React.useLayoutEffect(() => {
    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        syncPopupSpace();
      });
    };
    const onScroll = (event: Event): void => {
      // 面板/悬浮卡自己的滚动不改变条的位置；滚动时每帧量一次布局没有意义。
      if (event.target instanceof Element && event.target.closest('.__ru_host') !== null) return;
      schedule();
    };
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    // 条住在宿主的滚动容器里（新会话居中时尤其明显）：容器一滚，条的位置就变了。
    window.addEventListener('scroll', onScroll, true);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [syncPopupSpace]);

  /** 钉住的卡（`reveal:always` 自动钉的那张）没经过"悬停量位"，布局时找按钮量一次。 */
  React.useLayoutEffect(() => {
    if (pinnedEntry === null) return;
    // 属性选择器的值是带引号的字面量：用 JSON.stringify 转义（不依赖 CSS.escape）。
    const chip =
      hostRef.current?.querySelector<HTMLElement>(`[data-entry="${JSON.stringify(pinnedEntry).slice(1, -1)}"]`);
    if (chip !== null && chip !== undefined) noteChip(pinnedEntry, chip);
  }, [pinnedEntry]);

  /** 悬停钉住都不在 → 没有卡。钉住的优先（图钉说了算，悬停只管没钉住的）。 */
  const shownEntry = pinnedEntry ?? hoverEntry;

  /**
   * **条永远在**：插件装上了就该一直有个入口。
   *
   * 早先"没有按钮就整条不画"，于是按钮全被收起（或项目还没有清单）时，`+` 也跟着
   * 消失——用户既看不到状态，也没地方新建/钉回按钮，只能去手写配置文件。
   * 现在只把中间那条空地换成一句可操作的说明；真正的"没焦点"也照样显示，
   * 只是 `+` 会禁用（没有项目根目录可写）。
   */
  const hiddenAll = buttons.length === 0;
  const noEntries = props.entries.length === 0;

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
    <div className="__ru_host" ref={hostRef}>
      {openPanel === 'add' ? (
        <div className="__ru_pop __ru_popTall">
          <AddPanel {...props} />
        </div>
      ) : null}
      {openPanel === 'manage' ? (
        <div className="__ru_pop">
          <ManagePanel {...props} />
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

      {/* ⌃ 输出悬浮卡：悬停显示 / 拿开就消失 / 📌 可钉住（图钉说的算，悬停只管没钉的） */}
      {shownEntry !== null ? (
        <RunPreviewCard
          run={outputRunOf(runs, props.projectRoot, shownEntry)}
          runtime={runtime}
          pinned={pinnedEntry === shownEntry}
          left={hoverLeft.current[shownEntry] ?? 12}
          onTogglePin={() => onTogglePin(shownEntry)}
          onPreviewEnter={() => keepHover(shownEntry)}
          onPreviewLeave={scheduleHide}
        />
      ) : null}

      <div className="__ru_bar" data-testid="run-deck-bar" data-density={density}>
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
          {hiddenAll ? (
            <span className="__ru_emptyNote">
              {!noEntries
                ? runtime.t('allHiddenNote')
                : props.projectRoot === null
                  ? runtime.t('noProjectNote')
                  : runtime.t('noEntriesNote')}
            </span>
          ) : null}
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
                onMouseEnter={
                  active
                    ? (event) => {
                        keepHover(button.entry);
                        noteChip(button.entry, event.currentTarget);
                      }
                    : undefined
                }
                onMouseLeave={active ? scheduleHide : undefined}
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
          {/*
            ☰ 管理：排序 + 从条上移除，都在同一个面板里。

            **0 个条目也要能打开**：面板里有自己的空状态说明（「这个目录还没有启动项 ·
            点 + 新建第一条」），禁用它只会让用户分不清"是没东西可管"还是"插件坏了"。
            早先这里绑的是 `entries.length === 0`，于是那段空状态代码永远走不到。
          */}
          <button
            type="button"
            className={openPanel === 'manage' ? '__ru_btn __ru_fixed' : '__ru_btn'}
            onClick={onOpenManage}
            title={runtime.t('manageTitle')}
            aria-label={runtime.t('manageTitle')}
          >
            ☰
          </button>
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
 *
 * ## 为什么不是 HTML5 `draggable`（这是"拖起来只有一个虚影"的根因）
 *
 * 早先的写法是把手柄 `⋮⋮` 标成 `draggable`，靠 `dragstart/dragover/drop` 排序。
 * 那是**浏览器的原生拖放**，它按自己的规矩来：
 *   1. 浏览器在 `dragstart` 那一刻给**拖源元素**（我们标的是那个只有 4 个字形的
 *      `⋮⋮` 手柄）拍一张半透明快照当"拖影"，然后**由系统绘制、跟着光标走**——
 *      所以看到的是一小团虚影，而不是那行跟手；
 *   2. 真正的行留在原地（我们当时只给它 `opacity:.5` 表示"正在拖"）——
 *      于是"一行变淡 + 一团虚影"，两样都不是你要的东西；
 *   3. 顺序只在 `drop` 那一刻才改（`onDrop` 里 `move(...)`），拖动过程中
 *      列表一动不动 → 没有即时预览，也没有"别的行让开"的动画；
 *   4. 拖影的透明度/偏移/动画**都不受页面控制**（那是 OS/浏览器的实现），
 *      想让手感变成 sortable 那种，只能不用原生拖放。
 *
 * 现在改成指针事件（Pointer Events）自己实现：手柄上 `pointerdown` 抓起那一行，
 * 那一行 `translateY` 跟着指针（抬起样式 = 阴影 + 分层底色），其余各行按
 * `previewOffsets()` 算出的位移**带过渡**让位，落点由 `dropIndexFor()` 每帧算，
 * 松手时那一行再 FLIP 滑进槽位。全程没有 DOM 重排（只在落点提交时重排一次），
 * 所以不会抖。
 * ================================================================== */

/**
 * 拖拽排序用的"静止布局"——每一行的 top（**滚动内容坐标系**，第一行为 0）。
 * 只看行高与行距，不碰 DOM：DOM 只负责在启动那一刻量一次每行的高度。
 */
function restTops(heights: number[], gap: number): number[] {
  const tops: number[] = [];
  let y = 0;
  for (const height of heights) {
    tops.push(y);
    y += height + gap;
  }
  return tops;
}

/** 把 `from` 挪到 `to`（返回新数组，不改原数组）。 */
function moveInOrder<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  if (from === to || from < 0 || from >= next.length) return next;
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next; // 类型上的保险（T 含 undefined 时不动）
  next.splice(to, 0, moved);
  return next;
}

/**
 * 指针纵向位移 `dy` 之后，被拖那一行应该落到第几位。
 *
 * 判据：把**被拖行自己的槽位摘掉**，其余每一行有一个"静止中点"；被拖行的中心
 * 越过谁的中点，它就排到谁后面（数一数就是落点）。这是"即拖即预览"的核心，
 * 而且不碰 DOM —— 所以能在离线 smoke 里逐值验（含行高不一致的情况）。
 */
function dropIndexFor(heights: number[], gap: number, from: number, dy: number): number {
  if (from < 0 || from >= heights.length) return Math.max(0, from);
  const tops = restTops(heights, gap);
  const center = (tops[from] ?? 0) + (heights[from] ?? 0) / 2 + dy;
  let to = 0;
  for (let index = 0; index < heights.length; index += 1) {
    if (index === from) continue;
    if ((tops[index] ?? 0) + (heights[index] ?? 0) / 2 < center) to += 1;
  }
  return to;
}

/**
 * 预览布局：每一行（**原始下标**）该平移多少像素，才能空出/补上被拖那一行的位置。
 *
 * 用累积高度算，而不是"每行挪 `被拖行高 + 行距`"——行高不一致时（标签折行、
 * 提示行）前者仍然逐行对齐，后者会错位。被拖那一行的位移不用于渲染（它跟着
 * 指针走），调用方自行忽略。
 */
function previewOffsets(heights: number[], gap: number, from: number, to: number): number[] {
  const tops = restTops(heights, gap);
  const ids = heights.map((_, index) => index);
  const offsets = heights.map(() => 0);
  let y = tops[0] ?? 0;
  for (const id of moveInOrder(ids, from, to)) {
    offsets[id] = y - (tops[id] ?? 0);
    y += (heights[id] ?? 0) + gap;
  }
  return offsets;
}

/** 一次拖动排序的全部状态：启动那一刻量一次的行高/行距 + 每帧变的 dy/落点。 */
interface RowDrag {
  /** 被拖那一行在启动那一刻的下标。 */
  index: number;
  pointerId: number;
  /** 指针起点（滚动内容坐标系）。 */
  startY: number;
  /** 当前纵向位移（同一坐标系，已夹在列表范围内）。 */
  dy: number;
  /** 当前落点（0..n-1）。 */
  to: number;
  /** 每一行在预览布局里的平移量（按原始下标索引）。 */
  offsets: number[];
  heights: number[];
  gap: number;
  /** dy 的上下界：不让被拖那行飞出列表之外。 */
  min: number;
  max: number;
}

/* ================================================================== *
 * ＋ 添加面板（新建启动项）
 * ================================================================== */

/**
 * 把「KEY=value，每行一条」解析成对象；空行与 `#` 开头的行跳过。
 *
 * 坏行返回**原文**而不是行号：界面上直接把它贴在错误里，"错在哪一行"比"第 3 行"
 * 更不容易数错（环境变量文本框会折行）。host 也会再校验一次，这里只是先拦住。
 */
function parseEnvLines(text: string): { env: Record<string, string>; error?: string } {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) return { env: {}, error: line };
    const key = line.slice(0, equals).trim();
    if (key.length === 0) return { env: {}, error: line };
    env[key] = line.slice(equals + 1).trim();
  }
  return { env };
}

/** 复制已有条目时把 `command` + `args` 拼回一行（含空格的参数补引号）。 */
function quoteArgument(value: string): string {
  return /\s/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/**
 * `+` 面板：**只负责新建**。
 *
 * 早先它真的只有"名称 + 一行命令"两栏——而 `run.json` 支持的工作目录、环境变量、
 * 长驻、就绪正则、就绪后开浏览器、`onReady`、分组，全都只能手改文件。于是"用界面
 * 建一个 dev server 按钮"永远是个半成品：起得来，但不会自己开浏览器、不会标就绪。
 *
 * 现在的分工（与 VS Code 一致，也符合"别把简单场景做复杂"）：
 *   - 默认只有**名称 + 命令行**两栏，够建最简单的一条；
 *   - 其余字段收在「更多设置」里，展开才出现；
 *   - 顶部先给**探测候选**（`package.json` 的 scripts + 通用模板）与**复制已有条目**，
 *     点一下把字段预填进表单——预填会顺手展开「更多设置」，因为"它为什么自己长驻了"
 *     必须在界面上看得见，而不是藏在表单背后。
 *
 * 字段最终由 host 的 `buildTaskEntry` 校验并收敛成 `TaskEntry`；界面不落盘，也不把
 * 命令塞进任何接口（写进清单的仍然是 run.json 里的字面量）。外观（图标/分组）只写
 * 本机 `layout.json`，不进仓库。
 */
function AddPanel(props: BarProps): React.ReactElement {
  const { entries, runtime, projectRoot, onClosePanel, onCreateTask } = props;

  // 基础两栏
  const [label, setLabel] = React.useState('');
  const [command, setCommand] = React.useState('');
  // 「更多设置」
  const [more, setMore] = React.useState(false);
  const [cwd, setCwd] = React.useState('');
  const [envText, setEnvText] = React.useState('');
  const [background, setBackground] = React.useState(false);
  const [group, setGroup] = React.useState<TaskGroup>('none');
  const [entryId, setEntryId] = React.useState('');
  const [readyPattern, setReadyPattern] = React.useState('');
  const [openUrl, setOpenUrl] = React.useState(false);
  const [urlPattern, setUrlPattern] = React.useState('');
  const [uriFormat, setUriFormat] = React.useState('');
  const [reveal, setReveal] = React.useState(false);
  const [onReady, setOnReady] = React.useState('');
  // 只写本机 layout.json 的外观
  const [icon, setIcon] = React.useState('');
  const [buttonGroup, setButtonGroup] = React.useState('');

  const [detection, setDetection] = React.useState<TaskDetection | null>(null);
  const [detectError, setDetectError] = React.useState<string | null>(null);
  const [detecting, setDetecting] = React.useState(false);

  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<string | null>(null);
  /** 条目已建成、但把它钉上按钮条的那一步失败了（null = 正常钉上或还没创建）。 */
  const [pinError, setPinError] = React.useState<string | null>(null);

  /** 面板一打开就读一次检测：只读、不落盘，点候选才填表。 */
  const alive = React.useRef(true);
  React.useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  /** 读一次候选。建完一条之后再读一次——"已在清单"的标记不能是创建前的旧状态。 */
  const loadDetection = React.useCallback(async (): Promise<void> => {
    if (projectRoot === null) return;
    setDetecting(true);
    const result = await detectTasks(projectRoot);
    if (!alive.current) return;
    setDetecting(false);
    if (result.ok) {
      setDetection({ candidates: result.candidates, warnings: result.warnings });
      setDetectError(null);
    } else {
      setDetection(null);
      setDetectError(result.message);
    }
  }, [projectRoot]);

  React.useEffect(() => {
    void loadDetection();
  }, [loadDetection]);

  /** 点一条候选 → 填进表单（预填的字段立刻展开可见）。 */
  const applyPreset = (candidate: DetectedTask): void => {
    const preset = candidate.preset;
    setLabel(candidate.label);
    setCommand(candidate.command);
    setCwd(preset.cwd ?? '');
    setBackground(preset.isBackground === true);
    setGroup(preset.group ?? 'none');
    setReadyPattern(preset.readyPattern ?? '');
    setOpenUrl(preset.openUrl === true);
    setUrlPattern(preset.urlPattern ?? '');
    setUriFormat(preset.uriFormat ?? '');
    setMore(true);
    setCreated(null);
    setError(null);
  };

  /** 从已有条目复制：复制命令与运行参数，**id 一律不复制**（副本要自己的 id）。 */
  const copyFrom = (id: string): void => {
    const raw = entries.find((candidate) => candidate.id === id)?.raw;
    if (raw === undefined) return;
    setLabel(`${raw.label}（副本）`);
    setCommand([raw.command, ...(raw.args ?? [])].map(quoteArgument).join(' '));
    setCwd(raw.options?.cwd ?? '');
    setEnvText(
      Object.entries(raw.options?.env ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    setBackground(raw.isBackground === true);
    setGroup(raw.group ?? 'none');
    setEntryId('');
    setReadyPattern(raw.problemMatcher?.background?.endsPattern ?? '');
    setOpenUrl(raw.serverReadyAction !== undefined);
    setUrlPattern(raw.serverReadyAction?.pattern ?? '');
    setUriFormat(raw.serverReadyAction?.uriFormat ?? '');
    setReveal(raw.presentation?.reveal === 'always');
    setOnReady(raw.onReady ?? '');
    setMore(true);
    setCreated(null);
    setError(null);
  };

  /** 创建并钉上条：host 负责校验 + 写进 run.json，失败原因原样显示在面板里。 */
  const submit = async (): Promise<void> => {
    const name = label.trim();
    const line = command.trim();
    if (creating || name.length === 0 || line.length === 0) return;

    const parsedEnv = parseEnvLines(envText);
    if (parsedEnv.error !== undefined) {
      setError(`${runtime.t('fieldEnvInvalid')}${parsedEnv.error}`);
      setMore(true);
      return;
    }

    const env = parsedEnv.env;
    const input: NewTaskInput = {
      label: name,
      command: line,
      ...(cwd.trim().length > 0 ? { cwd: cwd.trim() } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(background ? { isBackground: true } : {}),
      ...(group !== 'none' ? { group } : {}),
      ...(entryId.trim().length > 0 ? { id: entryId.trim() } : {}),
      ...(readyPattern.trim().length > 0 ? { readyPattern: readyPattern.trim() } : {}),
      ...(openUrl
        ? {
            openUrl: true,
            ...(urlPattern.trim().length > 0 ? { urlPattern: urlPattern.trim() } : {}),
            ...(uriFormat.trim().length > 0 ? { uriFormat: uriFormat.trim() } : {}),
          }
        : {}),
      ...(reveal ? { reveal: 'always' as const } : {}),
      ...(onReady.length > 0 ? { onReady } : {}),
    };

    setCreating(true);
    setError(null);
    setPinError(null);
    try {
      const result = await onCreateTask(input, {
        ...(icon.trim().length > 0 ? { icon: icon.trim() } : {}),
        ...(buttonGroup.trim().length > 0 ? { group: buttonGroup.trim() } : {}),
      });
      if (!result.ok) {
        setError(result.hint !== undefined ? `${result.message}（${result.hint}）` : result.message);
        return;
      }
      // 清空表单，但保留「更多设置」的展开状态：连着建第二条时不用再展开一次。
      setLabel('');
      setCommand('');
      setCwd('');
      setEnvText('');
      setBackground(false);
      setGroup('none');
      setEntryId('');
      setReadyPattern('');
      setOpenUrl(false);
      setUrlPattern('');
      setUriFormat('');
      setReveal(false);
      setOnReady('');
      setIcon('');
      setButtonGroup('');
      setCreated(result.entry);
      setPinError(result.pinError ?? null);
      // 刚建的那条现在"已在清单"了：重读候选，别让防重复的标记停在创建之前。
      void loadDetection();
    } finally {
      setCreating(false);
    }
  };

  const scripts =
    detection?.candidates.filter((candidate) => candidate.source === 'package.json') ?? [];
  const templates =
    detection?.candidates.filter((candidate) => candidate.source === 'template') ?? [];

  const chips = (candidates: DetectedTask[]): React.ReactElement => (
    <div className="__ru_chips">
      {candidates.map((candidate) => (
        <button
          key={candidate.key}
          type="button"
          className="__ru_chip"
          disabled={candidate.exists || projectRoot === null}
          title={candidate.exists ? runtime.t('detectExists') : (candidate.hint ?? candidate.command)}
          onClick={() => applyPreset(candidate)}
        >
          <span>{candidate.label}</span>
          {candidate.exists ? (
            <span className="__ru_chipTag">{runtime.t('detectExists')}</span>
          ) : null}
        </button>
      ))}
    </div>
  );

  return (
    <div>
      <h4 className="__ru_popTitle">{runtime.t('createTitle')}</h4>
      <p className="__ru_popHint">{runtime.t('createHint')}</p>
      {error !== null ? <p className="__ru_error">❌ {error}</p> : null}
      {created !== null ? (
        pinError === null ? (
          <p className="__ru_popHint">✓ {created} · {runtime.t('createdNote')}</p>
        ) : (
          <>
            <p className="__ru_popHint">✓ {created} · {runtime.t('createdUnpinnedNote')}</p>
            <p className="__ru_error">⚠️ {pinError} · {runtime.t('pinRetryNote')}</p>
          </>
        )
      ) : null}
      {projectRoot === null ? <p className="__ru_popNote">{runtime.t('noProjectNote')}</p> : null}

      {projectRoot !== null ? (
        <div className="__ru_panel">
          <div className="__ru_panelHead">
            <span className="__ru_panelTitle">{runtime.t('detectTitle')}</span>
            <span className="__ru_panelHint">
              {detecting ? runtime.t('detectLoading') : runtime.t('detectHint')}
            </span>
          </div>
          {detectError !== null ? <p className="__ru_error">❌ {detectError}</p> : null}
          {detection !== null && scripts.length > 0 ? (
            <>
              <p className="__ru_panelHint">{runtime.t('detectScripts')}</p>
              {chips(scripts)}
            </>
          ) : null}
          {detection !== null && !detecting && scripts.length === 0 ? (
            <p className="__ru_panelHint">{runtime.t('detectEmpty')}</p>
          ) : null}
          {templates.length > 0 ? (
            <>
              <p className="__ru_panelHint" style={{ marginTop: 8 }}>
                {runtime.t('detectTemplates')}
              </p>
              {chips(templates)}
            </>
          ) : null}
          {(detection?.warnings ?? []).map((warning) => (
            <p className="__ru_panelHint" key={warning}>· {warning}</p>
          ))}
        </div>
      ) : null}

      {entries.length > 0 && projectRoot !== null ? (
        <div className="__ru_field" style={{ marginBottom: 10 }}>
          <span className="__ru_fieldLabel">{runtime.t('copyTitle')}</span>
          <div className="__ru_fieldBody">
            <select
              className="__ru_select"
              value=""
              onChange={(event) => copyFrom(event.target.value)}
              aria-label={runtime.t('copyTitle')}
            >
              <option value="">{runtime.t('copyPlaceholder')}</option>
              {entries.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      <div className="__ru_form">
        <div className="__ru_field">
          <span className="__ru_fieldLabel">{runtime.t('fieldName')}</span>
          <div className="__ru_fieldBody">
            <input
              className="__ru_input __ru_inputGrow"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={runtime.t('newTaskLabelPlaceholder')}
              aria-label={runtime.t('fieldName')}
              spellCheck={false}
              disabled={projectRoot === null}
            />
          </div>
        </div>
        <div className="__ru_field">
          <span className="__ru_fieldLabel">{runtime.t('fieldCommand')}</span>
          <div className="__ru_fieldBody">
            <input
              className="__ru_input __ru_inputGrow"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder={runtime.t('newTaskCommandPlaceholder')}
              aria-label={runtime.t('fieldCommand')}
              spellCheck={false}
              disabled={projectRoot === null}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </div>
        </div>
        <p className="__ru_fieldHint" style={{ paddingLeft: 100 }}>
          {runtime.t('commandSplitHint')}
        </p>
      </div>

      <button
        type="button"
        className="__ru_moreToggle"
        aria-expanded={more}
        onClick={() => setMore(!more)}
      >
        {more ? `▾ ${runtime.t('moreHide')}` : `▸ ${runtime.t('moreShow')}`}
      </button>

      {more ? (
        <div className="__ru_advanced" style={{ marginTop: 8 }}>
          <div className="__ru_field">
            <span className="__ru_fieldLabel">{runtime.t('fieldCwd')}</span>
            <div className="__ru_fieldBody">
              <input
                className="__ru_input __ru_inputGrow"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder={runtime.t('fieldCwdPlaceholder')}
                aria-label={runtime.t('fieldCwd')}
                spellCheck={false}
              />
            </div>
          </div>
          <div className="__ru_field">
            <span className="__ru_fieldLabel">{runtime.t('fieldEnv')}</span>
            <div className="__ru_fieldBody">
              <textarea
                className="__ru_textarea"
                value={envText}
                onChange={(event) => setEnvText(event.target.value)}
                placeholder={runtime.t('fieldEnvPlaceholder')}
                aria-label={runtime.t('fieldEnv')}
                spellCheck={false}
                rows={3}
              />
            </div>
          </div>
          <div className="__ru_field">
            <span className="__ru_fieldLabel">{runtime.t('fieldId')}</span>
            <div className="__ru_fieldBody">
              <input
                className="__ru_input __ru_inputGrow"
                value={entryId}
                onChange={(event) => setEntryId(event.target.value)}
                placeholder={runtime.t('fieldIdPlaceholder')}
                aria-label={runtime.t('fieldId')}
                spellCheck={false}
              />
            </div>
          </div>
          <div className="__ru_field">
            <span className="__ru_fieldLabel">{runtime.t('fieldGroup')}</span>
            <div className="__ru_fieldBody">
              <select
                className="__ru_select"
                value={group}
                onChange={(event) => setGroup(event.target.value as TaskGroup)}
                aria-label={runtime.t('fieldGroup')}
              >
                <option value="none">{runtime.t('groupNone')}</option>
                <option value="build">{runtime.t('groupBuild')}</option>
                <option value="test">{runtime.t('groupTest')}</option>
              </select>
              <label className="__ru_check">
                <input
                  type="checkbox"
                  checked={background}
                  onChange={(event) => setBackground(event.target.checked)}
                />
                <span>{runtime.t('fieldBackground')}</span>
              </label>
            </div>
          </div>
          <div className="__ru_field">
            <span className="__ru_fieldLabel">{runtime.t('fieldReady')}</span>
            <div className="__ru_fieldBody">
              <input
                className="__ru_input __ru_inputGrow"
                value={readyPattern}
                onChange={(event) => setReadyPattern(event.target.value)}
                placeholder={runtime.t('fieldReadyPlaceholder')}
                aria-label={runtime.t('fieldReady')}
                spellCheck={false}
              />
              <p className="__ru_fieldHint" style={{ flexBasis: '100%' }}>
                {runtime.t('fieldReadyHint')}
              </p>
            </div>
          </div>
          <div className="__ru_field">
            <span className="__ru_fieldLabel">{runtime.t('fieldOpenUrl')}</span>
            <div className="__ru_fieldBody">
              <label className="__ru_check">
                <input
                  type="checkbox"
                  checked={openUrl}
                  onChange={(event) => setOpenUrl(event.target.checked)}
                />
                <span>{runtime.t('fieldOpenUrl')}</span>
              </label>
              {openUrl ? (
                <>
                  <input
                    className="__ru_input __ru_inputGrow"
                    value={urlPattern}
                    onChange={(event) => setUrlPattern(event.target.value)}
                    placeholder={runtime.t('fieldUrlPatternPlaceholder')}
                    aria-label={runtime.t('fieldUrlPattern')}
                    spellCheck={false}
                  />
                  <input
                    className="__ru_input"
                    value={uriFormat}
                    onChange={(event) => setUriFormat(event.target.value)}
                    placeholder={runtime.t('fieldUriFormatPlaceholder')}
                    aria-label={runtime.t('fieldUriFormat')}
                    spellCheck={false}
                  />
                </>
              ) : null}
            </div>
          </div>
          <div className="__ru_field">
            <span className="__ru_fieldLabel">{runtime.t('output')}</span>
            <div className="__ru_fieldBody">
              <label className="__ru_check">
                <input
                  type="checkbox"
                  checked={reveal}
                  onChange={(event) => setReveal(event.target.checked)}
                />
                <span>{runtime.t('fieldReveal')}</span>
              </label>
            </div>
          </div>
          <div className="__ru_field">
            <span className="__ru_fieldLabel">{runtime.t('fieldOnReady')}</span>
            <div className="__ru_fieldBody">
              <select
                className="__ru_select"
                value={onReady}
                onChange={(event) => setOnReady(event.target.value)}
                aria-label={runtime.t('fieldOnReady')}
              >
                <option value="">{runtime.t('fieldOnReadyNone')}</option>
                {entries.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="__ru_field">
            <span className="__ru_fieldLabel">{runtime.t('fieldIcon')}</span>
            <div className="__ru_fieldBody">
              <input
                className="__ru_input"
                value={icon}
                onChange={(event) => setIcon(event.target.value)}
                placeholder={runtime.t('fieldIconPlaceholder')}
                aria-label={runtime.t('fieldIcon')}
                spellCheck={false}
              />
              <input
                className="__ru_input"
                value={buttonGroup}
                onChange={(event) => setButtonGroup(event.target.value)}
                placeholder={runtime.t('fieldButtonGroupPlaceholder')}
                aria-label={runtime.t('fieldButtonGroup')}
                spellCheck={false}
              />
              <p className="__ru_fieldHint" style={{ flexBasis: '100%' }}>
                {runtime.t('fieldAppearanceHint')}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="__ru_sep" />
      <div className="__ru_rowActions" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="__ru_btn __ru_fixed"
          disabled={
            creating ||
            projectRoot === null ||
            label.trim().length === 0 ||
            command.trim().length === 0
          }
          onClick={() => void submit()}
        >
          {creating ? '…' : runtime.t('newTaskCreate')}
        </button>
        <button type="button" className="__ru_btn" onClick={onClosePanel}>
          {runtime.t('addClose')}
        </button>
      </div>
    </div>
  );
}

/**
 * ☰ 管理面板：**排序 + 从条上移除 / 钉回**。
 *
 * 为什么不拆成两个按钮：这两件事都是在管"这条按钮在不在条上、排第几"，
 * 在同一个列表里拖一下、点一下最顺手，眼睛不用在两个面板之间来回换。
 * 新建任务属于另一件事，在 `+` 面板里。
 */
function ManagePanel(props: BarProps): React.ReactElement {
  const { entries, runtime, projectRoot, buttons, onPin, onReorder, onClosePanel, onDeleteTask } = props;
  const [order, setOrder] = React.useState<string[]>(() =>
    [...entries]
      .sort((left, right) => {
        const l = buttons.find((b) => b.entry === left.id)?.order ?? 999;
        const r = buttons.find((b) => b.entry === right.id)?.order ?? 999;
        return l - r;
      })
      .map((entry) => entry.id),
  );
  const [drag, setDrag] = React.useState<RowDrag | null>(null);
  /** 松手后那一行的 FLIP 落位动画（`entry` 是它，`dy` 从"松手那一刻的位置"过渡到 0）。 */
  const [settle, setSettle] = React.useState<{ entry: string; dy: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  /** 正在二次确认"删除任务"的那条（删除会改 run.json，必须多问一句）。 */
  const [confirming, setConfirming] = React.useState<string | null>(null);

  const listRef = React.useRef<HTMLDivElement | null>(null);
  /** 拖动数据放在 ref 里当**唯一真源**：`pointerup` 不依赖 React 有没有重渲染过。 */
  const dragRef = React.useRef<RowDrag | null>(null);
  /** 最后一次指针的视口 Y（自动滚动时指针不动，也要能继续算落点）。 */
  const pointerY = React.useRef(0);
  const endRef = React.useRef<(commit: boolean) => void>(() => {});

  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  /** 钉上去 / 从条上移除：管理面板里唯一会写按钮成员资格的动作。 */
  const pinEntry = async (entry: string, pinned: boolean): Promise<void> => {
    setError(null);
    try {
      await onPin(entry, pinned);
    } catch {
      setError(runtime.t('saveFailed'));
    }
  };

  /** 全部钉回来：条上一条都没有时的逃生口。 */
  const restoreAll = async (): Promise<void> => {
    for (const entry of entries) {
      if (buttons.some((button) => button.entry === entry.id)) continue;
      await pinEntry(entry.id, true);
    }
  };

  /** 删除任务：真的改项目 run.json，所以要先点一下「删除」再确认。 */
  const removeEntry = async (entry: string): Promise<void> => {
    setConfirming(null);
    setError(null);
    try {
      const result = await onDeleteTask(entry);
      if (!result.ok) setError(result.message);
    } catch {
      setError(runtime.t('saveFailed'));
    }
  };

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= order.length || to === from) return;
    const next = moveInOrder(order, from, to);
    setOrder(next);
    void onReorder(next).catch(() => setError(runtime.t('saveFailed')));
  };

  /** 滚动容器：`.__ru_pop` 就是 `overflow:auto` 的那一层（面板本身）。 */
  const scroller = (): HTMLElement | null => {
    const node = listRef.current;
    return node === null ? null : node.closest<HTMLElement>('.__ru_pop, .__ru_menu');
  };

  /**
   * 按"指针现在在哪"重算 dy / 落点 / 预览位移。
   *
   * 一切都在**滚动内容坐标系**里算（`视口Y - 容器顶 + scrollTop`），所以容器
   * 自己滚动（贴边自动滚动、滚轮）不会让那一行从指针底下跑掉。
   */
  const syncDrag = (): void => {
    const current = dragRef.current;
    if (current === null) return;
    const box = scroller();
    if (box === null) return;
    const boxRect = box.getBoundingClientRect();
    const contentY = pointerY.current - boxRect.top + box.scrollTop;
    const dy = Math.min(current.max, Math.max(current.min, contentY - current.startY));
    const to = dropIndexFor(current.heights, current.gap, current.index, dy);
    if (dy === current.dy && to === current.to) return;
    const next: RowDrag = {
      ...current,
      dy,
      to,
      offsets: previewOffsets(current.heights, current.gap, current.index, to),
    };
    dragRef.current = next;
    setDrag(next);
  };

  const startDrag = (event: React.PointerEvent<HTMLSpanElement>, index: number): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return; // 只认左键
    const list = listRef.current;
    const box = scroller();
    if (list === null || box === null) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.__ru_row'));
    if (rows.length === 0 || rows.length !== order.length) return;
    const boxRect = box.getBoundingClientRect();
    const heights = rows.map((row) => row.getBoundingClientRect().height);
    const tops = rows.map(
      (row) => row.getBoundingClientRect().top - boxRect.top + box.scrollTop,
    );
    // 行距实测（CSS 是 `margin-bottom:6px`；行数不足时按 6 兜底）
    const gap =
      rows.length > 1 ? Math.max(0, (tops[1] ?? 0) - (tops[0] ?? 0) - (heights[0] ?? 0)) : 6;
    const top = tops[index] ?? 0;
    const height = heights[index] ?? 0;
    const lastTop = tops[rows.length - 1] ?? 0;
    const lastHeight = heights[rows.length - 1] ?? 0;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 拿不到捕获也能拖（只是移出元素后收不到事件） */
    }
    pointerY.current = event.clientY;
    const next: RowDrag = {
      index,
      pointerId: event.pointerId,
      startY: event.clientY - boxRect.top + box.scrollTop,
      dy: 0,
      to: index,
      offsets: previewOffsets(heights, gap, index, index),
      heights,
      gap,
      min: -top,
      max: lastTop + lastHeight - (top + height),
    };
    dragRef.current = next;
    setSettle(null);
    setDrag(next);
    reportEvery('drag-start', {
      rows: rows.length,
      from: index,
      heights: heights.map((value) => Math.round(value)),
      gap: Math.round(gap * 100) / 100,
    });
  };

  const endDrag = (commit: boolean): void => {
    const current = dragRef.current;
    dragRef.current = null;
    if (current === null) return;
    // 落点**现算**（不信任上一次渲染的状态）：松手那一帧指针可能又动了。
    const box = scroller();
    let dy = current.dy;
    let to = current.to;
    if (commit && box !== null) {
      const boxRect = box.getBoundingClientRect();
      const contentY = pointerY.current - boxRect.top + box.scrollTop;
      dy = Math.min(current.max, Math.max(current.min, contentY - current.startY));
      to = dropIndexFor(current.heights, current.gap, current.index, dy);
    }
    setDrag(null);
    if (!commit || to === current.index) {
      // 把实测位移一起写出来：`dy` 很小 = "没跨过任何中点"（正确行为），
      // `dy` 明明跨过一格却还停在原位 = 落点算错了（这两件事必须能分开）。
      reportEvery('drag-end', {
        from: current.index,
        to: current.index,
        moved: false,
        cancelled: !commit,
        dy: Math.round(dy),
        limit: [Math.round(current.min), Math.round(current.max)],
      });
      return;
    }
    const offsets = previewOffsets(current.heights, current.gap, current.index, to);
    const entry = order[current.index];
    if (entry !== undefined) {
      // 松手时那一行还在指针底下，而它马上要落进新槽位：先把它按"松手位置 - 槽位位置"
      // 摆回去，下一帧再归零 —— 于是它是**滑**过去，不是啪地跳一下。
      setSettle({ entry, dy: dy - (offsets[current.index] ?? 0) });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() =>
          setSettle((value) => (value === null ? value : { ...value, dy: 0 })),
        );
      });
    }
    move(current.index, to);
    reportEvery('drag-end', {
      from: current.index,
      to,
      moved: true,
      settle: Math.round(dy - (offsets[current.index] ?? 0)),
      gap: Math.round(current.gap * 100) / 100,
    });
  };
  React.useEffect(() => {
    endRef.current = endDrag;
  });

  // 拖动期间的三件全局事：别选中文字、Esc 取消、指针贴边时自动滚动（长清单能拖到底）。
  React.useEffect(() => {
    if (drag === null) return;
    const body = document.body;
    const previousUserSelect = body.style.userSelect;
    body.style.userSelect = 'none';
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      endRef.current(false);
    };
    window.addEventListener('keydown', onKeyDown);
    let raf = 0;
    const step = (): void => {
      const box = scroller();
      if (box !== null) {
        const rect = box.getBoundingClientRect();
        const edge = 28;
        const speed = 12;
        if (pointerY.current < rect.top + edge) box.scrollTop -= speed;
        else if (pointerY.current > rect.bottom - edge) box.scrollTop += speed;
        syncDrag();
      }
      raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => {
      body.style.userSelect = previousUserSelect;
      window.removeEventListener('keydown', onKeyDown);
      window.cancelAnimationFrame(raf);
    };
  }, [drag === null]);

  return (
    <div ref={listRef}>
      <h4 className="__ru_popTitle">{runtime.t('manageTitle')}</h4>
      {error !== null ? <p className="__ru_error">❌ {error}</p> : null}
      {projectRoot === null ? (
        <p className="__ru_popNote">{runtime.t('noProjectNote')}</p>
      ) : entries.length === 0 ? (
        <p className="__ru_popNote">{runtime.t('noEntriesNote')}</p>
      ) : null}

      {order.map((entryId, index) => {
        const entry = byId.get(entryId);
        if (entry === undefined) return null;
        const pinned = buttons.some((b) => b.entry === entryId);
        const dragging = drag !== null && drag.index === index;
        const settling = settle !== null && settle.entry === entryId;
        // 拖动中：被拖那一行跟指针，其余各行按预览位移**带过渡**让开。
        // 落点提交后（drag=null）所有 transform 一起消失，而 DOM 顺序正好等于预览
        // 布局 —— 同一帧发生，所以不会看到任何跳动。
        const transform = dragging
          ? `translateY(${drag.dy}px)`
          : settling
            ? `translateY(${settle.dy}px)`
            : drag === null
              ? null
              : `translateY(${drag.offsets[index] ?? 0}px)`;
        const className = [
          '__ru_row',
          dragging ? '__ru_rowDragging' : '',
          drag !== null && !dragging ? '__ru_rowShift' : '',
          settling ? '__ru_rowSettle' : '',
        ]
          .filter((part) => part.length > 0)
          .join(' ');
        return (
          <div
            key={entryId}
            className={className}
            style={transform === null ? undefined : { transform }}
          >
            <span
              className="__ru_handle"
              role="button"
              tabIndex={0}
              title={runtime.t('dragHint')}
              aria-label={runtime.t('dragHint')}
              onPointerDown={(event) => startDrag(event, index)}
              onPointerMove={(event) => {
                if (dragRef.current === null || event.pointerId !== dragRef.current.pointerId) return;
                pointerY.current = event.clientY;
                syncDrag();
              }}
              onPointerUp={() => {
                if (dragRef.current !== null) endDrag(true);
              }}
              onPointerCancel={() => {
                if (dragRef.current !== null) endDrag(false);
              }}
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
                onClick={() => void pinEntry(entryId, !pinned)}
              >
                {pinned ? runtime.t('addHide') : runtime.t('addPin')}
              </button>
              {/* 删除是改 run.json 的破坏性操作：先变成「确认删除 / 取消」再动手。 */}
              {confirming === entryId ? (
                <>
                  <button
                    type="button"
                    className="__ru_btn __ru_errorBtn"
                    onClick={() => void removeEntry(entryId)}
                  >
                    {runtime.t('deleteConfirm')}
                  </button>
                  <button type="button" className="__ru_btn" onClick={() => setConfirming(null)}>
                    {runtime.t('deleteCancel')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="__ru_btn"
                  title={runtime.t('deleteHint')}
                  disabled={projectRoot === null}
                  onClick={() => setConfirming(entryId)}
                >
                  {runtime.t('deleteEntry')}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {buttons.length === 0 && entries.length > 0 ? (
        <div className="__ru_popNote __ru_popNoteRow">
          <span>{runtime.t('allHiddenNote')}</span>
          <button type="button" className="__ru_btn __ru_fixed" onClick={() => void restoreAll()}>
            {runtime.t('restoreAll')}
          </button>
        </div>
      ) : null}

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
 * 颜色码翻译器（控制台上色那一小块）
 * ================================================================== */

/** 一个带颜色的文本片段（ansiSpans 的产出）。 */
interface AnsiSpan {
  text: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  /** ANSI 前景色（对照表外的值是 undefined = 用界面自己的字色）。 */
  fg?: string;
  bg?: string;
}

/**
 * 十六色对照表：偏爱深底界面、照 xterm 的深色盘习惯，亮色档更浅。
 *
 * 注意这不是"你在 pwsh 里设的主题"——那东西只在交互式 pwsh 里出现（有提示符
 * 才谈得上主题），按钮跑的是脚本，从 VS Code 的任务输出里同样见不到它。
 * 这张表换的是"颜色的明暗"，理论上以后可以对齐到宿主界面的主题变量。
 */
const ANSI_COLORS: Record<number, string> = {
  30: '#6e7178', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b',
  34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#c8ccd4',
  90: '#9a9da4', 91: '#ff7b86', 92: '#7ee787', 93: '#ffd479',
  94: '#79c0ff', 95: '#d2a8ff', 96: '#76d7df', 97: '#ffffff',
  40: '#2c2c2e', 41: '#5c2b2f', 42: '#28402a', 43: '#3d3722',
  44: '#25384d', 45: '#3b2a44', 46: '#243c40', 47: '#3a3d44',
  100: '#3a3d44', 101: '#7a3b41', 102: '#3a563e', 103: '#5c5230',
  104: '#33526e', 105: '#543b62', 106: '#33555c', 107: '#5a5e66',
};

/**
 * 带颜色码的行 → 带样式的文本片段（纯函数，离线可验）。
 *
 * 管四件事：
 *   1. SGR（`ESC[..m`）转成 fg/bg/粗体/斜体/下划线/暗淡——颜色状态**跨行延续**
 *      （终端就是这么画的，绿了的 `✓` 不会下一行突然掉色）；
 *   2. 光标/擦除序列（`ESC[2K`、`ESC[?25h` 这类 ConPTY 重绘残渣）直接扔掉，
 *      不让它变成可见的怪字形；
 *   3. 普通字符按当前颜色拼起来。渲染端把片段铺进 `<pre>` 就得彩色控制台；
 *   4. **行与行之间补一个换行片段**。这一条是"输出全挤在一起"的根因修复：
 *      `lines` 是**行数组**，片段列表里若不写换行，铺进 `<pre>` 后所有行会首尾
 *      相接变成一行（`<pre>` 只保留"文字里真的有的"空白）。空行同样要保住——
 *      它也是脚本输出的一部分（分节、对齐）。
 */
function ansiSpans(lines: string[]): AnsiSpan[] {
  const out: AnsiSpan[] = [];
  let bold = false;
  let dim = false;
  let italic = false;
  let underline = false;
  let fg: string | undefined;
  let bg: string | undefined;
  let buffer = '';
  const flush = (): void => {
    if (buffer.length === 0) return;
    out.push({
      text: buffer,
      bold,
      dim,
      italic,
      underline,
      ...(fg !== undefined ? { fg } : {}),
      ...(bg !== undefined ? { bg } : {}),
    });
    buffer = '';
  };
  const applySgr = (codes: string | undefined): void => {
    const parts = (codes ?? '').length === 0 ? ['0'] : (codes ?? '').split(';');
    for (const part of parts) {
      const code = Number(part);
      if (!Number.isFinite(code)) continue;
      if (code === 0) {
        bold = dim = italic = underline = false;
        fg = undefined;
        bg = undefined;
      } else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 3) italic = true;
      else if (code === 4) underline = true;
      else if (code === 22) { bold = false; dim = false; }
      else if (code === 23) italic = false;
      else if (code === 24) underline = false;
      else if (code === 39) fg = undefined;
      else if (code === 49) bg = undefined;
      else if (code >= 30 && code <= 37) fg = ANSI_COLORS[code];
      else if (code >= 90 && code <= 97) fg = ANSI_COLORS[code];
      else if (code >= 40 && code <= 47) bg = ANSI_COLORS[code];
      else if (code >= 100 && code <= 107) bg = ANSI_COLORS[code];
    }
  };
  // 依次认：SGR（要处理）/ OSC 链接协议（丢）/ 其余 ESC+一字符（丢）。
  const scanner =
    /\u001B\[([0-9;?]*)([A-Za-z])|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B./u;
  for (const [index, line] of lines.entries()) {
    let rest = line;
    while (rest.length > 0) {
      const hit = scanner.exec(rest);
      if (hit === null) {
        buffer += rest;
        break;
      }
      buffer += rest.slice(0, hit.index);
      if (hit[2] === 'm') {
        // 先把当前颜色下的字刷出去，再换色——顺序不能倒。
        flush();
        applySgr(hit[1]);
      }
      rest = rest.slice(hit.index + hit[0].length);
    }
    flush();
    // 行边界：独立一个**无样式**片段，别把换行并进上/下一段的颜色里
    // （并进去的话，带背景色的行会多画出一条底色带，而换行本身不吃颜色）。
    if (index < lines.length - 1) {
      out.push({ text: '\n', bold: false, dim: false, italic: false, underline: false });
    }
  }
  flush();
  return out;
}

/* ================================================================== *
 * ⌃ 输出悬浮卡（悬停显示 / 拿开就消失 / 图钉可钉住）
 * ================================================================== */

/**
 * 给一条 run 挑"输出该显示谁"：先挑正在跑的那条，没有就挑最近一条已退出的（末跑
 * 留下的现场——构建失败/启动失败时这块就是唯一证据）。
 *
 * 对着 **entry** 而不是 runId：用户认的是按钮（条目），停止后重跑换的是 runId，
 * 面板必须跟着按钮走。`runs` 是按 startedAt 倒序排列的（listRuns 排过），
 * 所以"candidates[0]"就是最近一条。
 */
function outputRunOf(
  runs: RunRecord[],
  projectRoot: string | null,
  entryId: string | null,
): RunRecord | undefined {
  if (entryId === null) return undefined;
  const candidates = runs.filter(
    (run) =>
      run.entryId === entryId && (projectRoot === null || run.projectRoot === projectRoot),
  );
  const live = candidates.find((candidate) => candidate.status !== 'exited');
  return live ?? candidates[0];
}

/**
 * 输出悬浮卡 —— 出现的规矩照字面执行：
 *
 *   - 鼠标放到**正在跑**的按钮上 → 卡片在那颗按钮上方浮出，拿开就消失；
 *   - 卡片自己"接管"悬停：从按钮挪进卡片那段间隙不闪断（160ms 延迟窗）；
 *   - 卡上有一颗 📌：钉住后常驻，拿开也不消失；再点一次拔钉，恢复悬停规矩；
 *   - `presentation.reveal: "always"` 的条目跑起来那一刻自动钉一次（run.json 承诺的）。
 *
 * 尺寸刻意收窄：≤560px 宽、≤250px 高，盖不满条——输出短的时候卡自己就矮。
 *
 * 数据**不走新通路**：宿主 800ms 把终端新切出来的行抄进 `RunRecord.tail`
 * （留最近 200 行），界面 2.5 秒一轮的 `/state` 顺手带回（≈2.5 秒一批）。
 * 进程停了内容保留（末跑的现场就是查"为什么失败"的证据）。
 */
/** 把 ansiSpans 的片段铺成 `<pre>` 的内容（颜色跟着脚本走，没颜色的行就是默认字色）。 */
function ColoredLog(props: { lines: string[] }): React.ReactElement {
  return (
    <>
      {ansiSpans(props.lines).map((span, index) => {
        const style: React.CSSProperties = {
          ...(span.fg !== undefined ? { color: span.fg } : {}),
          ...(span.bg !== undefined ? { backgroundColor: span.bg } : {}),
          ...(span.bold ? { fontWeight: 600 } : {}),
          ...(span.dim ? { opacity: 0.65 } : {}),
          ...(span.italic ? { fontStyle: 'italic' } : {}),
          ...(span.underline ? { textDecoration: 'underline' } : {}),
        };
        return (
          <span key={index} style={style}>
            {span.text}
          </span>
        );
      })}
    </>
  );
}

interface RunPreviewCardProps {
  run: RunRecord | undefined;
  runtime: Runtime;
  pinned: boolean;
  /** 卡片左缘（px，相对 `__ru_host`；已夹在条的宽度以内）。 */
  left: number;
  onTogglePin(): void;
  onPreviewEnter(): void;
  onPreviewLeave(): void;
}

function RunPreviewCard(props: RunPreviewCardProps): React.ReactElement {
  const { run, runtime, pinned, left, onTogglePin, onPreviewEnter, onPreviewLeave } = props;
  return (
    <div
      className={pinned ? '__ru_pop __ru_hover __ru_hoverPinned' : '__ru_pop __ru_hover'}
      style={{ left }}
      onMouseEnter={onPreviewEnter}
      onMouseLeave={onPreviewLeave}
    >
      <div className="__ru_hoverHead">
        <span className="__ru_hoverLabel">{run?.label ?? '—'}</span>
        {/* 状态徽章就贴在脚本名旁边（圈一圈的胶囊）；名字右边由弹簧占位，把图钉推到最右。 */}
        {run !== undefined ? (
          <span className="__ru_statusBadge" data-status={run.status}>
            {runtime.t(run.status)}
          </span>
        ) : null}
        <span className="__ru_hoverSpring" aria-hidden="true" />
        {/* 图钉 + 状态文字：未钉 = 📌 钉住（"把这颗钉按下去"），已钉 = 📍 已钉住（钉在原地）。
            上一版两个 emoji 不带文字，谁读成"钉住了"全凭联想，看起来就像状态反了；
            现在文字把状态说死，钉住的卡另有品牌色描边（__ru_hoverPinned）兜底。
            tooltip 沿用 pin/unpin 那对长文案，把"点了会发生什么"也讲明白。 */}
        <button
          type="button"
          className="__ru_pinBtn"
          onClick={onTogglePin}
          aria-pressed={pinned}
          title={pinned ? runtime.t('unpin') : runtime.t('pin')}
          aria-label={pinned ? runtime.t('unpin') : runtime.t('pin')}
        >
          <span aria-hidden="true">{pinned ? '📍' : '📌'}</span>
          <span className="__ru_pinText">
            {pinned ? runtime.t('pinStateOn') : runtime.t('pinStateOff')}
          </span>
        </button>
      </div>
      {run?.rawTail !== undefined && run.rawTail.length > 0 ? (
        <pre className="__ru_outView">
          <ColoredLog lines={run.rawTail} />
        </pre>
      ) : run?.tail !== undefined && run.tail.length > 0 ? (
        <pre className="__ru_outView">{run.tail.join('\n')}</pre>
      ) : (
        <pre className="__ru_outView">
          {run === undefined ? runtime.t('settingsNoRuns') : runtime.t('outputEmpty')}
        </pre>
      )}
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
  const [state, setState] = React.useState<RunDeckState | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  /**
   * 最近一次"跑/停"的失败原因。界面必须把它显示出来——"点了没反应"最难受的地方
   * 就是没有任何反馈（早先 host 只登记不执行，界面却显示"运行中"）。
   */
  const [lastError, setLastError] = React.useState<string | null>(null);
  const [panel, setPanel] = React.useState<'none' | 'add' | 'manage' | 'settings' | 'error' | 'overflow'>('none');
  /** 输出悬浮卡钉在哪条 entry（null = 没钉；reveal:always 也会自动钉）。 */
  const [pinnedEntry, setPinnedEntry] = React.useState<string | null>(null);
  const [density, setDensity] = React.useState<ButtonDensity>('full');

  const pull = React.useCallback(async (): Promise<RunDeckState | null> => {
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
    // `emptyBar` 是"条上没有任何可点的东西"——条本身现在**永远会画**（`+`/⚙ 常驻），
    // 所以不再有"整条隐藏"这回事，日志里也只报"空不空"。
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
        // 条永远会画：这里只报告"有没有可点的按钮"。
        emptyBar: result.buttons.length === 0 && result.focusedEntries.length === 0,
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
      // `presentation.reveal: "always"`（VS Code 的原义：这条命令跑起来时把它的
      // 输出亮出来）。run.json 里的承诺由界面兑现：跑起来那一刻**自动钉住**这条的
      // 悬浮预览卡（小卡、一键拔钉；拔了就回到"悬停才出现"的规矩）。
      if (result.ok) {
        const entry = state.focusedEntries.find((candidate) => candidate.id === entryId);
        if (entry?.presentation?.reveal === 'always') setPinnedEntry(entryId);
      }
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
      onOpenManage={() => setPanel(panel === 'manage' ? 'none' : 'manage')}
      onOpenSettings={() => setPanel(panel === 'settings' ? 'none' : 'settings')}
      onOpenError={() => setPanel(panel === 'error' ? 'none' : 'error')}
      pinnedEntry={pinnedEntry}
      onTogglePin={(entry) => setPinnedEntry(pinnedEntry === entry ? null : entry)}
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
      onCreateTask={async (input, button) => {
        const root = state.focused?.projectRoot ?? null;
        if (root === null) {
          return { ok: false, code: 'NOT_FOUND', message: runtime.t('noFocus') };
        }
        const result = await createTask(root, input);
        if (!result.ok) return result;
        // 用户的意图是"加一个按钮"，不是"往文件里塞一条记录"：创建成功就顺手钉上条。
        // 图标/分组走本地覆盖（`/button`），不进 run.json——外观是本机的事。
        // 钉条失败**不能整条吞掉**：条目已建成，报"创建失败"会撒谎，报成功会缺按钮——
        // 原样把失败原因带回（`pinError`），由面板展示并提示到 ☰ 里手动补钉。
        const pinned = await call('/button', 'POST', {
          entry: result.entry,
          pinned: true,
          ...(button.icon !== undefined ? { icon: button.icon } : {}),
          ...(button.group !== undefined ? { group: button.group } : {}),
        });
        await pull();
        return pinned.ok ? result : { ...result, pinError: pinned.message };
      }}
      onDeleteTask={async (entryId) => {
        const root = state.focused?.projectRoot ?? null;
        if (root === null) {
          return { ok: false, code: 'NOT_FOUND', message: runtime.t('noFocus') };
        }
        const result = await deleteTask(root, entryId);
        if (result.ok) await pull();
        return result;
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
      ctx.logger?.warn?.('[dsh-run-deck] slots 服务不可用，按钮条未挂载');
      // 单独一个阶段名（report 每个阶段只发一次，复用 client-loaded 会被去重掉）。
      report('client-no-slots');
      return;
    }

    const locale = ctx.get<DshLocaleService>('locale');
    if (locale !== undefined) {
      ctx.effect(() => locale.register(NS, 'zh', ZH), 'dsh-run-deck: zh dictionary');
      ctx.effect(() => locale.register(NS, 'en', EN), 'dsh-run-deck: en dictionary');
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

    ctx.logger?.info?.('[dsh-run-deck] client half mounted');
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
    ManagePanel,
    POPUP_OFFSET,
    POPUP_SPACE_VAR,
    RunPreviewCard,
    SettingsPanel,
    STACK_LIFT_RULE,
    cwdOfSession,
    dropIndexFor,
    iconGlyph,
    injectStyles,
    labelFor,
    moveInOrder,
    ansiSpans,
    openReadyUrl,
    parseEnvLines,
    popupSpaceFor,
    previewOffsets,
    quoteArgument,
    restTops,
    truncate,
    EN,
    ZH,
  },
});
