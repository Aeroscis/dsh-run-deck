/**
 * dsh-rundeck — 共享类型（host 与 client 都编译本文件）。
 *
 * 约束：本文件不得 import 任何 node 内置模块或 host 专属类型，否则 client 包会被污染。
 *
 * 词汇表：**照抄 VS Code tasks.json**，不发明新概念。字段名、语义、默认值来自
 * code.visualstudio.com/docs/reference/tasks-appendix 与 variables-reference。
 * 本插件只用三个增量（见 §增量），删掉它们配置仍然能跑：
 *   - `buttons[]`：钉到浮动层的 entry 别名 + 图标 + 分组（纯策展，不新增执行能力）
 *   - `onReady: "<entry id>"`：就绪后接另一个 entry，补 VS Code issue #69311
 *     （`serverReadyAction` 只能 `openExternally`）。只接受 entry id，不接受命令
 *   - `id`：跨族唯一标识，给外部按名字调用；`label` 可重名，不能当接口
 */

/* ─────────────────────────── 词汇表（VS Code 原文语义） ─────────────────────────── */

/** `type`：目前只实现 `shell`（VS Code 的 process 需要 argv 数组，本插件不做）。 */
export type TaskType = 'shell';

/** `${input:id}` 的取值来源。本插件实现 `pickString`（VS Code 同名单选）。 */
export interface InputVariable {
  id: string;
  type: 'pickString';
  /** 可选项。 */
  options: string[];
  /** 默认值；缺省 = 第一项。 */
  default?: string;
}

/** `options.cwd` 等选项。VS Code 里 `cwd` 相对 workspaceFolder 解析。 */
export interface TaskOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** VS Code `presentation` 的 panel / reveal / clear。 */
export interface TaskPresentation {
  panel?: 'shared' | 'dedicated' | 'new';
  reveal?: 'always' | 'silent' | 'never';
  clear?: boolean;
}

/** VS Code 的 `problemMatcher`。`background` 段只用于 `isBackground: true`。 */
export interface ProblemMatcher {
  background?: {
    /** 进程一启动就视作收集行（VS Code 同名字段）。 */
    activeOnStart?: boolean;
    /** 一句"开始匹配"的 pattern；第 0 组是捕获，附加组透传给 endsPattern/onReady。 */
    beginsPattern?: string;
    /** 就绪 pattern；第 1 组常是 URL，交给 serverReadyAction。 */
    endsPattern?: string;
  };
}

/** VS Code `serverReadyAction`：目前只实现 `openExternally`。 */
export interface ServerReadyAction {
  action: 'openExternally';
  pattern: string;
  uriFormat?: string;
}

/** VS Code `group`：`build` / `test` / `none`。只作分组标记，不改变执行方式。 */
export type TaskGroup = 'build' | 'test' | 'none';

/**
 * 一个条目（= VS Code 的一个 task）。**没有 steps/dependsOn**：
 * 编排回到 `&&`（VS Code 的做法），本插件不提供动作序列。
 */
export interface TaskEntry {
  /** 人读的标题，**可重名**。VS Code 里同名字段也叫 label。 */
  label: string;
  /** 增量 3：跨族唯一标识。缺省时按 label 派生（仍保证唯一）。 */
  id?: string;
  type?: TaskType;
  command: string;
  args?: string[];
  options?: TaskOptions;
  /** 长驻只是「跑完不退出」，用 `true` 表达；不拆文件、不加 ready/on 概念。 */
  isBackground?: boolean;
  problemMatcher?: ProblemMatcher;
  serverReadyAction?: ServerReadyAction;
  presentation?: TaskPresentation;
  group?: TaskGroup;
  /**
   * 增量 2：就绪后接另一个 entry 的 **id**（不接受命令）。
   * 补的是 VS Code issue #69311 里 serverReadyAction 表达不了的那件事。
   */
  onReady?: string;
}

/** 增量 1：钉到浮动层。只是 entry 的别名 + 图标 + 分组，不新增执行能力。 */
export interface ButtonConfig {
  /** 指向 `tasks[]` 里某一条的 id。 */
  entry: string;
  /** 图标名（eye / play / …）。不识别的名字退化成首字母。 */
  icon?: string;
  /** 分组名；同组在浮动层里相邻。 */
  group?: string;
  /** 覆盖 entry 的 label 作为按钮标题。 */
  label?: string;
  /** 排序权重，小的在前。 */
  order?: number;
}

/** `.dsh/run.json` 的顶层结构。 */
export interface RunConfigDocument {
  version?: string;
  inputs?: InputVariable[];
  tasks: TaskEntry[];
  buttons?: ButtonConfig[];
}

/* ─────────────────────────── 插件自己的运行时类型 ─────────────────────────── */

/** 插件配置（DSH settings 命名空间 `dsh-rundeck` 的字段）。 */
export interface RundeckConfig {
  /** 记录文件目录；空字符串 = `<DSH_HOME>/plugin-data/dsh-rundeck`。 */
  dataDir: string;
  /** 额外的清单文件路径（没有固定项目根目录时用；留空 = 只从工作区读）。 */
  configPath: string;
}

/** 一条 entry 的解析结果：字段收敛 + 变量展开后的最终形态。 */
export interface ResolvedEntry {
  /** 稳定 id：配置里写了 `id` 就用它，否则由 label 派生。 */
  id: string;
  label: string;
  type: TaskType;
  command: string;
  args: string[];
  cwd: string;
  isBackground: boolean;
  problemMatcher?: ProblemMatcher;
  serverReadyAction?: ServerReadyAction;
  presentation?: TaskPresentation;
  group: TaskGroup;
  onReady?: string;
}

/** 一个项目根目录（.dsh/run.json 所在处）及其清单。 */
export interface RunProject {
  /** 项目根目录绝对路径（= workspaceFolder）。 */
  root: string;
  /** 目录名，作展示用。 */
  name: string;
  /** `.dsh/run.json` 的绝对路径；没有该文件时为 undefined。 */
  configFile?: string;
  /**
   * 读这份清单时它的 mtime（毫秒）。
   *
   * 用途只有一个：`/state` 每 2.5 秒问一次焦点项目，靠它判断"清单被改过了"，
   * 改过就**自动重读**——否则用户改完 run.json 必须重启 DSH 或者手敲 `/rundeck list`
   * 才生效（实测就是这么被绊住的：改完 pattern 发现界面还是旧的）。
   */
  manifestMtimeMs?: number;
  document?: RunConfigDocument;
  /** 解析后的条目（按 label 排序，与配置顺序一致）。 */
  entries: ResolvedEntry[];
  /** 读配置时的告警（语法错误、字段类型不对……）。 */
  warnings: string[];
}

/** 一次执行（跑一条 entry）的状态。 */
export type RunStatus =
  | 'starting'
  | 'running'
  | 'ready'
  | 'stopping'
  | 'exited';

/** host 侧一条运行记录。 */
export interface RunRecord {
  runId: string;
  projectRoot: string;
  entryId: string;
  label: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  /** 就绪 pattern 抓到的内容（通常是 URL）；onReady 靠它决定是否接下一步。 */
  ready?: { url?: string; captured?: string };
  error?: string;
  /** 是否因 isBackground 而「跑完不退出」。 */
  background: boolean;
  /** 本 run 那条 PTY 的进程号（`ctx.subprocess.spawnTerminal` 给的顶层进程）。 */
  pid?: number;
  /**
   * 最近几行输出（剥过 ANSI 的纯文本）。
   *
   * 存在的理由：脚本自己起不来时（`python: can't open file ...`、端口被占、缺依赖），
   * 唯一说得清原因的就是它自己的输出；面板把这几行摆出来，"点了没反应"就不用猜。
   */
  tail?: string[];
  /**
   * 这条 run 就绪后**接力**起的下一条 entry（manifest 里的 `onReady`）。
   *
   * 记下来是为了让这件事在界面上看得见：`onReady` 是"点一个按钮，却跑起来两条"
   * ——实测使用者会把它当成故障（"点 jin · desktop，jin · web 怎么也起来了"）。
   * 它确实是 manifest 里写的行为，但界面必须说出来，而不是只躺在宿主日志里。
   */
  chainedTo?: string;
  /** 发起这次执行的会话 id：只用于记录与 `DSH_SESSION_ID`（不再用来定 owner）。 */
  ownerSessionId?: string;
}

/** 浮动层上的一个按钮（`buttons[]` 叠加本地覆盖后的形态，第 5 步用）。 */
export interface FloatingButtonView {
  /** 指向 `tasks[]` 里某一条的 id。 */
  entry: string;
  icon: string;
  group: string;
  /** 覆盖后的标题（缺省 = entry 的 label）。 */
  label?: string;
  order: number;
  projectRoot: string;
  /** 该 entry 在配置里的标题（本地没覆盖 label 时用它）。 */
  entryLabel: string;
  /** 该 entry 是否正在跑（客户端据此显示绿点 / 再点是"停"）。 */
  active?: boolean;
  status?: RunStatus;
}

/** 按钮密度（⚙ 里可持久化；宽度不够时客户端自动再降一档）。 */
export type ButtonDensity = 'full' | 'compact' | 'icon';

/** 当前"焦点项目"：客户端按当前会话 cwd 选定，host 据此只返回它的按钮。 */
export interface FocusedProject {
  /** 客户端报上来的 cwd。 */
  cwd: string;
  /** 解析出的项目根目录；null = 这个 cwd 下没有可用的清单。 */
  projectRoot: string | null;
  /** `.dsh/run.json` 的绝对路径；没有则 undefined。 */
  configFile?: string;
  /** 为什么没有项目（cwd 空 / 目录不存在 / 没有 manifest / manifest 坏了）。 */
  reason?: string;
}

/** `GET /dsh-rundeck/api/state` 的返回体。 */
export interface RundeckState {
  ok: true;
  /** host 半边的插件版本（改代码后是否生效，靠它判断）。 */
  pluginVersion: string;
  /** 插件数据目录。 */
  dataDir: string;
  /** 配置来源（项目内 run.json vs 插件机内覆盖）。 */
  configSource: ConfigSource;
  /** 全部项目根目录的清单（`+` 面板按需展开某个项目时用）。 */
  projects: RunProject[];
  runs: RunRecord[];
  /** **当前焦点项目**的浮动按钮；没有焦点项目时是空数组。 */
  buttons: FloatingButtonView[];
  /** 当前焦点项目本身；null = 没有。 */
  focused: FocusedProject | null;
  /** 焦点项目的**全部**条目（`+` 面板要列"所有"，不只是已钉的）。 */
  focusedEntries: ResolvedEntry[];
  /** 浮动层布局的个人覆盖（顺序、分组、显隐、密度），不进仓库。 */
  layout: LocalLayout;
  warnings: string[];
  capabilities: RundeckCapabilities;
  /** 服务端时间（epoch ms）。 */
  now: number;
}

/**
 * 机器本地的个人覆盖：按钮布局、分组、密度，**不进仓库**。
 * 删掉它一切照常，只是浮动层退回 run.json 的原始顺序。
 */
export interface LocalLayout {
  /** 每个按钮的覆盖（按 entry id 索引）。 */
  buttons: Record<string, ButtonOverride>;
  /** 用户偏好的密度（缺省 `full`；宽度不够时客户端仍会自动再降一档）。 */
  density?: ButtonDensity;
}

/** 单个浮动按钮的个人覆盖。 */
export interface ButtonOverride {
  /** 是否钉在浮动层；`false` = 从浮动层收起（条目本身仍可被命令/工具调用）。 */
  pinned?: boolean;
  /** 本地排序权重：覆盖 run.json 的 order。小的在前，也用作降档时的优先级。 */
  order?: number;
  group?: string;
  label?: string;
  icon?: string;
}

/** 配置的实际来源，决定 UI 去哪改。 */
export type ConfigSource =
  | 'project-files'
  | 'plugin-config'
  | 'settings'
  | 'config-file'
  | 'cordis-row'
  | 'defaults';

export interface RundeckCapabilities {
  /**
   * 宿主能否真起进程：`ctx.subprocess.spawnTerminal`（真 PTY）在不在。
   *
   * 注意这里**不是** `ctx.terminals`——那是 `dsh-terminal` 的 PTY 注册表，
   * 桌面版组合里没有它（只在 `dsh-sdk-minimal` 里有）。
   */
  subprocess: boolean;
  /** 执行缝的平台（`windows` / `posix`），来自 `terminalEnvironment()`。 */
  platform?: string;
  /** 不可用时的原因（直接显示给人看）。 */
  subprocessReason?: string;
  webServer: boolean;
  commands: boolean;
  settings: boolean;
  /** 宿主桌面能否在文件管理器里打开路径。 */
  canOpenPath: boolean;
}

/** 跑一条 entry 的请求。 */
export interface StartRunRequest {
  projectRoot: string;
  entryId: string;
  /**
   * 发起这次执行的会话 id —— 只用于记录（`RunRecord.ownerSessionId`）与给子进程
   * 一个 `DSH_SESSION_ID`。执行不再需要 owner：`ctx.subprocess` 的 PTY 不需要
   * Agent 身份，所以空闲会话点按钮也能真跑起来。
   */
  sessionId?: string;
}

/** 统一错误体（与 dsh-temptask 一致，便于两端复用习惯）。 */
export interface ApiError {
  ok: false;
  code: string;
  message: string;
  hint?: string;
}

export type ApiResult<T> = ({ ok: true } & T) | ApiError;

/** 错误码常量（host 抛出、client 判别，双端共享）。 */
export const ERROR_CODES = {
  badRequest: 'BAD_REQUEST',
  notFound: 'NOT_FOUND',
  fs: 'FS_ERROR',
  noTerminal: 'TERMINAL_UNAVAILABLE',
  spawn: 'SPAWN_FAILED',
  confirm: 'CONFIRM_REQUIRED',
  busy: 'ALREADY_RUNNING',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
