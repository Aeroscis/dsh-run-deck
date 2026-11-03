/**
 * dsh-run-deck — DSH 接口的最小环境声明。
 *
 * 为什么需要这个文件：DSH 以「已打包的 JS」发布（`@deepseek-ai/dsh-*` 的 lib/*.js），
 * 包内**不携带 .d.ts**，因此插件无法直接 import 官方类型。这里只声明本插件真正
 * 用到的那些叶子契约——字段与签名逐条抄自当前 DSH 版本的 live Inspect 目录与
 * 已发布包的 `lib/types/*.d.ts`（不是猜测），也不覆盖未使用的 API。
 *
 * 本文件是全局脚本（无 import/export），因此同时给 host 与 client 提供全局符号。
 */

/* ─────────────────────────── 通用 ─────────────────────────── */

interface DshLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
  debug?(message: string): void;
}

/** Cordis fiber：本插件只读 `entry`（配置写入要拿它当身份）。 */
interface DshFiberLike {
  readonly uid?: string | null;
  readonly entry?: DshConfigEntryLike;
}

/** Cordis Context：只列出本插件使用的方法。 */
interface DshContext {
  readonly logger?: DshLogger;
  readonly fiber?: DshFiberLike;
  /** 可选服务读取：拿到 undefined 时必须自行降级。 */
  get<T = unknown>(name: string): T | undefined;
  /** 硬依赖注入：依赖出现后才执行回调，随该 fiber 卸载自动回收。 */
  inject(names: string[], callback: (ctx: DshContext) => void | (() => void)): () => void;
  on(
    event: string,
    listener: (...args: never[]) => void,
    options?: { prepend?: boolean; global?: boolean },
  ): () => void;
  effect(callback: () => void | (() => void), label?: string): () => void;
}

/* ─────────────────────── host 服务契约 ─────────────────────── */

/** `ctx.commands` — 人类命令注册表。 */
interface DshCommandResult {
  kind: 'success' | 'error';
  text?: string;
}
interface DshCommandInvocation {
  readonly agent: { readonly id: string };
  readonly rawInput: string;
}
interface DshCommandDefinition {
  name: string;
  description: string;
  input?: { hint: string; attachments?: boolean };
  recordInput?: boolean;
  handler(invocation: DshCommandInvocation): DshCommandResult | Promise<DshCommandResult>;
}
interface DshCommandsService {
  register(definition: DshCommandDefinition): () => void;
}

/** `ctx.webServer` — 浏览器 HTTP 载体。 */
interface DshWebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): void | Promise<void>;
}
interface DshWebServerService {
  register(route: DshWebRoute): () => void;
}

/**
 * `ctx.tools` — 模型可见工具注册表。
 *
 * `defineTool` 来自**可选**依赖 `@deepseek-ai/dsh-tools`（动态 import）；
 * 这里只声明本插件用到的那部分形状。字段与签名逐条抄自当前 DSH 版本里
 * 使用它的插件（dsh-tool-skill / dsh-tool-todo / dsh-tool-jobs）。
 */
interface DshToolParameterSchema {
  type: string;
  required?: boolean;
  description?: string;
  enum?: readonly unknown[];
  const?: unknown;
  items?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  additionalProperties?: boolean;
  oneOf?: readonly Record<string, unknown>[];
}

/** tool 里 `execute` 的第二个参数：调用现场。 */
interface DshToolExecContext {
  readonly agent?: {
    readonly id: string;
    readonly session: { readonly header: { readonly cwd?: string } };
    followup(message: unknown): void;
    inject(message: unknown): void;
  };
  readonly signal?: AbortSignal;
}

interface DshToolContentPart {
  type: 'text';
  text: string;
}

interface DshToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: Record<string, unknown>): DshToolContentPart[];
  };
  execute(args: Record<string, unknown>, exec: DshToolExecContext): Promise<Record<string, unknown>>;
  presentCall?(args: Record<string, unknown>): {
    card: string;
    title: string;
    kind: string;
    rawInput?: unknown;
  };
}

interface DshToolsService {
  register(definition: unknown): () => void;
  get?(name: string, agent?: unknown): unknown;
  list?(): unknown[];
}

/** `@deepseek-ai/dsh-tools` 的导出形状（只声明用到的一个）。 */
declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(definition: DshToolDefinition): unknown;
}

/**
 * `ctx.settings` — 官方配置服务（0.1.x 命名空间；0.2.0 起改为 configEditor）。
 */
interface DshSettingsScope {
  get(): unknown;
  set(key: string, value: unknown): Promise<void>;
  unset(key: string): Promise<void>;
  watch(callback: () => void): () => void;
  dispose?(): void;
}
interface DshSettingsService {
  readonly writable?: boolean;
  register?(
    namespace: string,
    schema: unknown,
    options?: { base?: unknown },
  ): DshSettingsScope;
}

/**
 * `ctx.configEditor` — 0.2.0-rc.1 起插件配置的写入口。
 * 它把配置写进 profile 的 cordis 补丁（`cordis.patch.yml`），
 * 与官方「设置 → 插件」表单改的是同一处。
 */
interface DshConfigEntryLike {
  readonly id?: string;
  readonly name?: string;
  readonly options?: { readonly id?: string; readonly name?: string };
}
interface DshConfigEditorService {
  edit(
    entry: unknown,
    change: (current: unknown, inherited: unknown) => unknown,
  ): Promise<void>;
}

/**
 * `ctx.subprocess` — `@deepseek-ai/dsh-subprocess` 的执行缝（本地实现是
 * `@deepseek-ai/dsh-subprocess-local`，底层 node-pty）。
 *
 * **为什么不是 `ctx.terminals`**：那是 `@deepseek-ai/dsh-terminal` 的 PTY 注册表，
 * 只在 `dsh-sdk-minimal` 这类组合里挂载；桌面版（`dsh-base` + `dsh-web-app`）**没有**
 * 它——实测点击报 `宿主没有 terminals 服务（dsh-terminal 未加载）`。
 * 而 `subprocess` 是 `dsh-base` 必挂的服务，DSH 自己的终端面板
 * （`@deepseek-ai/dsh-api-terminal-controller`）用的就是它：
 * `static inject = ["subprocess"]` → `spawnTerminal(...)`。
 *
 * `spawnTerminal` 给的是**真 PTY**（node-pty / ConPTY），也就是真控制台——
 * 第 1 步的探针结论要求的正是这个：Windows 上只有控制台生成 Ctrl+C 才会把
 * CTRL_C_EVENT 送进进程组，脚本挂在 SIGINT 上的清理处理器才会跑。
 * 实测 `LocalTerminalHandle.signalForeground('SIGINT')` 在 win32 上就是
 * 往 PTY 写一个 `\x03`（`subprocess-local/lib/index.js`），交付路径与真人按 Ctrl+C 一致。
 *
 * 形状抄自本机 `dsh-tool-cordis/lib/types/api-catalog.js` 里导出的声明。
 */
interface DshSubprocessOutcome {
  exitCode: number | null;
  signal: string | null;
}
interface DshSubprocessTerminalSpawnSpec {
  argv: readonly string[];
  cwd: string;
  env?: Record<string, string>;
  rows: number;
  cols: number;
  terminalType: string;
  /** 交互式 shell 才设 true；我们跑的是"执行完就退"的 `/c`，所以是 false。 */
  shellActivity?: boolean;
  graceMs: number;
  signal?: AbortSignal;
}
interface DshSubprocessTerminalForeground {
  processGroupId: number;
  inputWaiting: boolean;
}
interface DshSubprocessTerminalActivity {
  state: 'idle' | 'busy' | 'unknown';
  revision: number;
}
interface DshSubprocessTerminalHandle {
  readonly pid: number;
  /** PTY 的输出流（ConPTY 的屏幕更新流；按行切、剥 ANSI 之后再喂钩子）。 */
  readonly output: NodeJS.ReadableStream;
  readonly done: Promise<DshSubprocessOutcome>;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  inspectForeground(): Promise<DshSubprocessTerminalForeground | undefined>;
  inspectActivity(): Promise<DshSubprocessTerminalActivity>;
  signalForeground(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<number>;
  terminate(): Promise<void>;
}
interface DshSubprocessTerminalEnvironment {
  platform: 'windows' | 'posix';
  defaultShell?: string;
}
interface DshSubprocessService {
  terminalEnvironment(signal?: AbortSignal): Promise<DshSubprocessTerminalEnvironment>;
  resolveExecutable(command: string, env?: Record<string, string>, signal?: AbortSignal): Promise<string>;
  spawnTerminal(spec: DshSubprocessTerminalSpawnSpec): Promise<DshSubprocessTerminalHandle>;
}

/** `ctx.sessionController` — 宿主桌面能否打开/定位路径，以及**会话目录**。 */
interface DshSessionControllerService {
  canOpenWorkspacePath?(): boolean;
  openWorkspacePath?(
    request: { path: string; action?: 'reveal' },
    signal?: AbortSignal,
  ): Promise<{ opened: boolean }>;
  /**
   * 会话检视/列表：**不要求会话是"活的"**，这是本条接口存在的唯一理由。
   *
   * 形状抄自本机 `dsh-api-session-controller/lib/typert.host.js` 里导出的声明：
   *   - `inspect(sessionId, signal?) → SessionInspection`
   *     `SessionInspection extends SessionStorageMetadata { events }`，
   *     `SessionStorageMetadata = { meta: SessionHeader; inheritedEventCount }`，
   *     `SessionHeader.cwd?` → 也就是 `inspection.meta.cwd`。
   *     ⚠️ 它**连整条会话日志一起返回**，所以只在 list 也查不到时才走，且扫描时跳过 `events`。
   *   - `list(_request: SessionListRequest, signal) → SessionListValue`
   *     `SessionListRequest = { cursor? }`、`SessionListValue = { items: SessionSummary[] }`、
   *     `SessionSummary = { sessionId; agentAvailable; …; cwd? }` → 一条摘要就够，便宜。
   *
   * 为什么需要它：`ctx.sessions` 是**内存**存储，只有"被激活过"的会话在里面
   * （agent 活着、或被某个执行链持有）。侧边栏点开一条空闲会话时它不在内存里，
   * 于是 `session.header.cwd` 取不到 → 浮动条整条隐藏——正是"重启后某些仓库没按钮"。
   * 会话目录是持久化的，空闲会话也在里面，所以这条路能兜住。
   */
  inspect?(sessionId: string, signal?: AbortSignal): Promise<unknown>;
  list?(request: { cursor?: string }, signal?: AbortSignal): Promise<unknown>;
}

/** `ctx.workspaceRegistry` — 用来判断一个目录是否已经是 DSH 工作区。 */
interface DshWorkspaceRegistryService {
  list(): { readonly id: string; readonly path: string; readonly title: string }[];
  resolveByPath(path: string): Promise<{ readonly id: string; readonly path: string } | undefined>;
}

/**
 * `ctx.sessions` — 内存里的会话存储（host 半边）。
 *
 * 用途只有一个：把插槽交给插件的 sessionId 解析成项目根目录
 * （`session.header.cwd`，DSH 硬约束 `session.cwd === workspace.path`）。
 * 形状抄自 live Inspect 目录（get / list 两个都在）。
 */
interface DshSessionLike {
  readonly id?: string;
  readonly header?: { readonly cwd?: string };
}
interface DshSessionsService {
  get?(id: string): DshSessionLike | undefined;
  list?(): DshSessionLike[];
}

/* ─────────────────────── client 契约 ─────────────────────── */

interface DshSlotRegistrationOptions {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  label?: string | (() => string);
  locale?: string;
  /**
   * 会话级插槽的注入面：宿主用当前会话 id 调它，返回值合并进组件 props。
   * **这是会话 id 唯一的来路**——插槽的 owner props 未必带 sessionId
   * （`conversation.input.overlay` 就是 `renderSlot(key, {})`）。
   */
  inject?: (sessionId: string) => Record<string, unknown>;
  priority?: number;
}
interface DshSlotsService {
  register(
    options: DshSlotRegistrationOptions,
    component: (props: never) => unknown,
  ): () => void;
  inject(key: string, callback: () => (() => void) | void): () => void;
}

interface DshLocaleSnapshot {
  id: string;
}
interface DshLocaleService {
  register(namespace: string, locale: string, dict: Record<string, string>): () => void;
  register(namespace: string, dicts: Record<string, Record<string, string>>): () => void;
  bind(namespace: string): (key: string) => string;
  getLocale?(): DshLocaleSnapshot;
  subscribe?(callback: () => void): () => void;
}

/** 客户端 layout 服务：主面板选择。 */
interface DshLayoutService {
  selectPanel(panelId: string | null): void;
  toggleSidebar?(): void;
}

/** 0.2.0-rc.1：`ctx.configForms.get(entryId)` — 客户端侧的插件配置表单。 */
interface DshClientConfigForm {
  getSnapshot(): { status: string; value?: unknown; writable?: boolean };
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<boolean>;
  unset(field: string): Promise<boolean>;
}
interface DshConfigFormsService {
  get(entryId: string): DshClientConfigForm;
}

/** 0.1.x：`ctx.settingsScope.bind({ namespace })`。 */
interface DshSettingsScopeBinder {
  bind(options: { namespace: string }): DshClientSettingsScope;
}
interface DshClientSettingsScope {
  getSnapshot(): { status: string; value?: unknown; writable?: boolean };
  load?(): unknown;
  subscribe?(callback: () => void): () => void;
  set(key: string, value: unknown): Promise<void>;
  unset(key: string): Promise<void>;
  dispose?(): void;
}

/** 宿主桌面能否在文件管理器里打开路径（决定那一行是"打开目录"还是"复制目录"）。 */
interface DshOpenPathService {
  canOpenPath?(): boolean;
  openPath?(request: { path: string; action?: 'reveal' }): Promise<{ opened: boolean }>;
}

/* ─────────────────────── 浏览器侧全局 ─────────────────────── */

interface DshModuleLoaderRegistration {
  id: string;
  factory(require: (spec: string) => unknown): unknown;
}
interface Window {
  __ModuleLoader__: {
    load(registration: DshModuleLoaderRegistration): void;
  };
}

/* ─────────────── 可选依赖（动态 import，可能不存在） ─────────────── */

declare module '@deepseek-ai/dsh-settings' {
  export function settingsNamespace(namespace: string): string;
}

declare module '@deepseek-ai/schemastery' {
  export interface SchemasteryField {
    default(value: unknown): SchemasteryField;
    description(text: string): SchemasteryField;
    volatile?(): SchemasteryField;
  }
  export interface SchemaLike {
    object(shape: Record<string, unknown>): unknown;
    string(): SchemasteryField;
    number(): SchemasteryField;
    boolean(): SchemasteryField;
    const<T>(value: T): SchemasteryField;
    union(list: readonly unknown[]): SchemasteryField;
    array(inner: unknown): SchemasteryField;
  }
  const z: SchemaLike;
  export default z;
}
