/**
 * dsh-run-deck — 执行通道：**真 PTY**（"点按钮真的跑起来"就在这个文件里）。
 *
 * ## 为什么是 PTY，不是后台 job
 *
 * 第 1 步的探针结论。这些项目的启动脚本把进程树清理挂在 SIGINT / SIGTERM /
 * SIGBREAK 的 Python 处理器上，而 Windows 只有「控制台为进程生成 Ctrl+C /
 * Ctrl+Break」才会把 CTRL_C_EVENT / CTRL_BREAK_EVENT 送给进程组。
 * job（detached + stdio:ignore）派生的进程 `GetConsoleProcessList() == 0`——
 * 没有控制台可挂，信号于是到不了处理器，taskkill /T 也就不会执行，端口被孤儿占住。
 * 三轮探针（SIGTERM ×2、SIGBREAK ×1）实测：处理器一次都没跑。
 *
 * ## 为什么是 `ctx.subprocess.spawnTerminal`，不是 `ctx.terminals`
 *
 * `ctx.terminals` 是 `@deepseek-ai/dsh-terminal` 的 PTY 注册表，**只在
 * `dsh-sdk-minimal` 那类组合里挂载**；桌面版组合（`dsh-base` + `dsh-web-app`）
 * 里没有它——点按钮会报 `宿主没有 terminals 服务（dsh-terminal 未加载）`。
 * 而 `ctx.subprocess` 是 `dsh-base` 必挂的服务（`@deepseek-ai/dsh-subprocess-local`，
 * 底层 node-pty / ConPTY），DSH 自己的终端面板（`@deepseek-ai/dsh-api-terminal-controller`）
 * 走的就是它：`static inject = ["subprocess"]` → `spawnTerminal(...)`。
 *
 * `spawnTerminal` 给的是**真控制台**，所以第 1 步的要求仍然满足：
 * `signalForeground('SIGINT')` 在 win32 上就是往 PTY 写一个 `\x03`
 * （`subprocess-local/lib/index.js` 实测），交付路径与真人按 Ctrl+C 完全一致；
 * POSIX 上走 `signalGroup(前台 pgid, SIGINT)`。
 *
 * 这条路线还顺手去掉了两个包袱：
 *   1. **不再需要 Agent 当 owner**。`ctx.terminals` 的每个操作都要一个活着的 Agent
 *      （`isLiveOwner` 恒等校验），而 `subprocess` 的执行缝不需要——空闲会话点按钮
 *      也能真跑起来（这正是"点了没反应"的另一半原因）。
 *   2. **不再需要 `dsh-terminal` 这个包**。桌面版没有它。
 *
 * 两条硬约束没有变：
 *   1. **命令只有一个来源**：`.dsh/run-deck/run.json` 里的字面量。接口只接受
 *      `{projectRoot, entryId}` 指针（+ 发起会话的 sessionId，只用于记录与 `DSH_SESSION_ID`），
 *      任何接口都不接受自由命令，也绝不扫目录去发现可执行文件。
 *   2. **进程归宿主管**：PTY 由 `subprocess` 服务持有，插件卸载 / 宿主退出时它自己
 *      会终止（`spawnTerminal` 的 handle 在服务里登记）；我们额外在停止时先发 SIGINT，
 *      让脚本自己的清理处理器先跑。
 */
import { ERROR_CODES, type ResolvedEntry, type RunRecord, type RunStatus } from './types.js';

export interface ExecCapability {
  available: boolean;
  platform?: string;
  reason?: string;
}

/**
 * 探测执行缝（`ctx.subprocess.spawnTerminal`）。
 *
 * 同步、只问"服务在不在、有没有那个方法"——真正的 shell 解析是异步的
 * （`terminalEnvironment()`），放在 `resolveRunRoute()` 里。
 */
export function probeSubprocess(ctx: DshContext): ExecCapability {
  const subprocess = ctx.get<DshSubprocessService>('subprocess');
  if (subprocess === undefined) {
    return {
      available: false,
      reason: '宿主没有 subprocess 服务（@deepseek-ai/dsh-subprocess-local 未加载）',
    };
  }
  if (typeof subprocess.spawnTerminal !== 'function') {
    return { available: false, reason: 'subprocess 服务没有 spawnTerminal（不是本地实现？）' };
  }
  return { available: true };
}

/** 把一条 entry 渲染成**给人看的**命令行（也是交给 shell 执行的那个字符串）。 */
export function renderCommandLine(entry: ResolvedEntry): string {
  const parts = [entry.command, ...entry.args];
  return parts
    .map((part) => (/\s/u.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part))
    .join(' ');
}

/* ─────────────────────────── PTY 路线：真的起进程 ─────────────────────────── */

/** 一次执行需要的宿主资源：执行缝 + 解析出来的 shell + 怎么把命令行交给它。 */
export interface RunRoute {
  subprocess: DshSubprocessService;
  platform: string;
  shell: string;
  /** `argv` 里命令行**之前**的那几段（`cmd /d /s /c` 或 `sh -c`）。 */
  shellArgs: string[];
}

/** 路由解析失败时的形状（跟 ApiError 同形，调用方直接返回给 UI）。 */
export interface RunRouteFailure {
  ok: false;
  code: string;
  message: string;
  hint?: string;
}

/**
 * 解析这次执行要用的执行缝与 shell。
 *
 * **不抛错**：每种缺失都给一条能直接显示给人看的原因
 * （"为什么点了没反应"必须说得出话）。
 *
 * 命令怎么交给 shell：
 *   - Windows：`<ComSpec> /d /s /c "<命令行>"`——`/c` 让 shell **执行完就退**，
 *     于是 `handle.done` 结算的那一刻就是"这条任务跑完了"（长驻服务除外），
 *     退出码也是任务自己的退出码；`/d` 跳过 AutoRun，`/s` 让 `/c` 后面的整串
 *     按原样交给命令（`cmd` 自己的引号规则）。
 *   - POSIX：`<shell> -c "<命令行>"`。用 `terminalEnvironment().defaultShell`
 *     （没有就退到 `/bin/sh`）。
 *
 * 为什么不自己 `argv: [command, ...args]` 直接起进程：`npm` 这类命令在 Windows 上
 * 是 `npm.cmd`，CreateProcess 不能直接执行 `.cmd`；而且 run.json 的 `type: shell`
 * 语义本来就允许 shell 语法（`&&`、管道、引号）。走 shell 与 VS Code 的 tasks 一致。
 */
export async function resolveRunRoute(ctx: DshContext): Promise<
  { ok: true; route: RunRoute } | RunRouteFailure
> {
  const probe = probeSubprocess(ctx);
  const subprocess = ctx.get<DshSubprocessService>('subprocess');
  if (!probe.available || subprocess === undefined) {
    return {
      ok: false,
      code: ERROR_CODES.noTerminal,
      message: probe.reason ?? '宿主没有可用的执行通道，按钮点了也跑不起来',
      hint: '这个宿主不允许插件直接开终端进程，长驻的脚本就收不到 Ctrl+C。需要宿主提供 spawnTerminal 能力（详见 README 的"为什么走 PTY"）。',
    };
  }

  let environment: DshSubprocessTerminalEnvironment;
  try {
    environment = await subprocess.terminalEnvironment();
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.noTerminal,
      message: `问不到宿主的终端环境：${String(error)}`,
      hint: '执行缝在，但 terminalEnvironment() 失败——看宿主日志里 subprocess-local 的报错。',
    };
  }

  const windows = environment.platform === 'windows';
  // 宿主声明的默认 shell 优先（Windows 上是 ComSpec）。没有它就用执行缝自己的
  // `resolveExecutable()` 把裸名字解析成绝对路径——那是这个服务对"可执行文件在哪"
  // 的权威回答（PATHEXT / PATH 都是它的事），解析不出来才退回裸名字让 CreateProcess 自己找。
  const declared = (environment.defaultShell ?? '').trim();
  const fallbackName = windows ? 'cmd.exe' : '/bin/sh';
  const shell = declared.length > 0 ? declared : await resolveShellFallback(subprocess, fallbackName);
  if (windows) {
    return {
      ok: true,
      route: {
        subprocess,
        platform: environment.platform,
        shell,
        shellArgs: ['/d', '/s', '/c'],
      },
    };
  }
  return {
    ok: true,
    route: {
      subprocess,
      platform: environment.platform,
      shell,
      shellArgs: ['-c'],
    },
  };
}

/** 宿主没声明默认 shell 时，用执行缝自己的可执行文件解析；失败就退回裸名字。 */
async function resolveShellFallback(
  subprocess: DshSubprocessService,
  name: string,
): Promise<string> {
  if (typeof subprocess.resolveExecutable !== 'function') return name;
  try {
    return await subprocess.resolveExecutable(name);
  } catch {
    return name;
  }
}

/** PTY 的尺寸。只影响 ConPTY 的换行与重绘，取一个够宽的默认值。 */
const PTY_COLS = 120;
const PTY_ROWS = 30;

/** `terminate()` 的 TERM→KILL 宽限（毫秒）；停止时的第一手信号是 SIGINT，不靠它。 */
const TERMINATE_GRACE_MS = 3000;

/**
 * 开一条 PTY 把这条 entry 跑起来。
 *
 * @returns 宿主的终端句柄（停止 / 读输出 / 退出判定都按它来）。
 */
export async function spawnRunTerminal(
  route: RunRoute,
  entry: ResolvedEntry,
  commandLine: string,
  sessionId: string | undefined,
): Promise<DshSubprocessTerminalHandle> {
  return route.subprocess.spawnTerminal({
    argv: [route.shell, ...route.shellArgs, commandLine],
    cwd: entry.cwd,
    cols: PTY_COLS,
    rows: PTY_ROWS,
    terminalType: 'xterm-256color',
    // 交互式 shell 才设 true。我们是"执行完就退"，于是 handle.done 结算 =
    // 任务结束，宿主也会顺手把这条 handle 从它的登记表里收掉。
    shellActivity: false,
    graceMs: TERMINATE_GRACE_MS,
    ...(sessionId !== undefined && sessionId.length > 0
      ? { env: { DSH_SESSION_ID: sessionId } }
      : {}),
  });
}

/** 给前台进程组投一个信号（停止的首选：让脚本自己的清理处理器跑）。 */
export async function signalRunTerminal(
  handle: DshSubprocessTerminalHandle,
  signal: 'SIGINT' | 'SIGTERM',
): Promise<{ delivered: boolean; processGroupId?: number; reason?: string }> {
  try {
    const processGroupId = await handle.signalForeground(signal);
    return { delivered: true, processGroupId };
  } catch (error) {
    return { delivered: false, reason: String(error) };
  }
}

/** 关掉这条 PTY 并等进程树停稳（信号没投到、或脚本不理会 Ctrl+C 时的兜底）。 */
export async function killRunTerminal(handle: DshSubprocessTerminalHandle): Promise<void> {
  await handle.terminate();
}

/* ─────────────────────────── 输出：一条流 + 行缓冲 ─────────────────────────── */

/**
 * ConPTY 的输出里带 ANSI 转义（颜色、光标、清行）。就绪 pattern 是按**文本**写的
 * （`gallery ready at (http://\S+)`），不剥掉转义就会因为中间的 `\x1b[…m` 匹配不上。
 */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]|(?:[0-9A-Za-z][^\u0007\u001B]*)?(?:\u0007|\u001B\\))/gu;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * 一条 PTY 的输出抓手：把流按行切好放进队列，等轮询来取。
 *
 * 为什么要有它：`handle.output` 是一条**流**（不读会把 PTY 背压住），而钩子层是
 * "一行一行喂"的。这里做三件事：
 *   1. 立刻消费流，按 `\r\n` / `\n` / `\r` 切行（ConPTY 重绘会带 `\r`）；
 *   2. 剥 ANSI，去掉空行；
 *   3. 留一个**有界**的尾巴（`tail`）给 ⚙ 面板与日志用，不无限吃内存。
 */
export interface TerminalTap {
  /** 这条 PTY 的句柄（停止、信号、terminate 都要它）。 */
  readonly handle: DshSubprocessTerminalHandle;
  /** 还没被取走的行（按顺序）。 */
  take(): string[];
  /** 最近若干行（面板展示用）。 */
  tail(): string[];
  /**
   * 最近若干行的**原始版**（ANSI 颜色码原样留着）——输出悬浮卡画彩色控制台靠它；
   * ⚙ 面板与就绪判定继续只认剥过色的 `tail()`。
   */
  rawTail(): string[];
  /** 进程是否已经结算（`done` 落定）。 */
  readonly finished: boolean;
  /** 结算结果（`finished` 之后才有意义）。 */
  readonly outcome: DshSubprocessOutcome | undefined;
  /** 结算的 promise（失败也 resolve，绝不抛给轮询）。 */
  readonly settled: Promise<DshSubprocessOutcome>;
}

export function tapRunTerminal(
  handle: DshSubprocessTerminalHandle,
  maxTail = 400,
): TerminalTap {
  const pending: string[] = [];
  const tail: string[] = [];
  /** 原始行（ANSI 颜色码原样）——输出悬浮卡画彩色控制台用。 */
  const raw: string[] = [];
  let buffer = '';
  let finished = false;
  let outcome: DshSubprocessOutcome | undefined;

  const push = (line: string): void => {
    const clean = stripAnsi(line).replace(/\s+$/u, '');
    if (clean.trim().length === 0) return;
    pending.push(clean);
    tail.push(clean);
    while (tail.length > maxTail) tail.shift();
    // 同一步收两条账：tail 是剥过色的纯文本（⚙ 面板/就绪判定用），raw 是原样
    // （界面画颜色用）。门 仍然按"剥完色还有字"判断——纯颜色码的行没有信息。
    raw.push(line.replace(/\s+$/u, ''));
    while (raw.length > maxTail) raw.shift();
  };

  const consume = (chunk: string): void => {
    buffer += chunk;
    // `\r\n` / `\n` / 单独 `\r`（进度行重绘）都算一次换行。
    let index = buffer.search(/[\r\n]/u);
    while (index >= 0) {
      const line = buffer.slice(0, index);
      // 吃掉 `\r\n` 这一对
      const skip = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(index + skip);
      push(line);
      index = buffer.search(/[\r\n]/u);
    }
  };

  handle.output.setEncoding?.('utf8');
  handle.output.on('data', (chunk: unknown) => {
    consume(typeof chunk === 'string' ? chunk : String(chunk));
  });

  const settled = handle.done.then(
    (result) => {
      finished = true;
      outcome = result;
      // 最后一段没有换行结尾的输出也要交出去（脚本可能不换行就打印了就绪地址）。
      if (buffer.length > 0) {
        push(buffer);
        buffer = '';
      }
      return result;
    },
    (error: unknown) => {
      finished = true;
      outcome = { exitCode: null, signal: null };
      push(`(终端结算失败：${String(error)})`);
      return outcome;
    },
  );

  return {
    handle,
    take() {
      return pending.splice(0, pending.length);
    },
    tail() {
      return [...tail];
    },
    rawTail() {
      return [...raw];
    },
    get finished() {
      return finished;
    },
    get outcome() {
      return outcome;
    },
    settled,
  };
}

/**
 * 就绪判定：`problemMatcher.background.endsPattern` 命中即 ready。
 *
 * 与端口探测的分工：**pattern 为主，端口只做兜底**。原因（需求里定死的）：
 * 光探端口区分不了"我们起来了"和"端口被别的进程占了"，会给出假绿点。
 * 脚本自己会判断端口上是不是我们的服务（jin 的 is_our_gallery），
 * 所以它打出来的 stdout 才是权威信号。
 */
export interface ReadyMatch {
  ready: boolean;
  url?: string;
  captured?: string;
}

/** 用两条 pattern（beginsPattern / endsPattern）匹配一行输出。 */
export function matchReady(
  patterns: { beginsPattern?: string; endsPattern?: string } | undefined,
  line: string,
): ReadyMatch {
  if (patterns === undefined || patterns.endsPattern === undefined) return { ready: false };
  const ends = compilePattern(patterns.endsPattern);
  if (ends === undefined) return { ready: false };
  const match = ends.exec(line);
  if (match === null) return { ready: false };
  // 第 1 组约定是 URL（VS Code 的 serverReadyAction 也是这样用它）
  const url = match[1];
  const captured = match[0];
  return url !== undefined && url.length > 0 && captured !== undefined
    ? { ready: true, url, captured }
    : captured !== undefined
      ? { ready: true, captured }
      : { ready: true };
}

/** 编译一条 pattern；编译失败返回 undefined（调用方按"不匹配"处理并记告警）。 */
function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return undefined;
  }
}

/**
 * 一条 run 的推进：状态变更的统一入口，保证时间戳不留空。
 *
 * 留给第 3 步（事件钩子）用：那时 host 会收到终端的就绪/退出事件，
 * 需要一个「只改该改的、其余保持」的入口，而不是每个调用方手拼对象。
 */
export function transition(
  record: RunRecord,
  next: {
    status?: RunStatus;
    exitCode?: number | null;
    signal?: string | null;
    ready?: { url?: string; captured?: string };
    error?: string;
    now: number;
  },
): RunRecord {
  const updated: RunRecord = { ...record };
  if (next.status !== undefined) updated.status = next.status;
  if (next.exitCode !== undefined) updated.exitCode = next.exitCode;
  if (next.signal !== undefined) updated.signal = next.signal;
  if (next.ready !== undefined) updated.ready = next.ready;
  if (next.error !== undefined) updated.error = next.error;
  if (next.status === 'exited' && updated.endedAt === undefined) updated.endedAt = next.now;
  return updated;
}
