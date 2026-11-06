/**
 * dsh-run-deck — 业务核心：清单加载 + run 登记 + 浮动按钮视图。
 *
 * 约定：**公开方法一律返回 ApiResult，不抛错**，这样 routes.ts / commands.ts
 * 都能直接把结果序列化给调用方。
 *
 * 与 dsh-temptask 的分工差异：这个插件**不**建会话、不建工作区。
 * 它只回答三件事——"有哪些条目"、"这一条怎么跑"、"浮动层该怎么摆"。
 * 执行真进程的那一段在 exec.ts，而它只提供不需要 Agent owner 的能力
 * （见那里的边界说明）；就绪钩子的语义在 hooks.ts。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { probeSubprocess, renderCommandLine, resolveRunRoute, signalRunTerminal, killRunTerminal, spawnRunTerminal, tapRunTerminal, transition, type TerminalTap } from './exec.js';
import { initialHookState, observeLine, type HookOutcome, type HookState } from './hooks.js';
import { detectTasks as detectProjectTasks } from './detect.js';
import { insertTaskIntoManifestText, removeTaskFromManifestText } from './manifest-edit.js';
import { buildTaskEntry } from './newtask.js';
import {
  LEGACY_MANIFEST_RELATIVE_PATH,
  loadProject,
  loadProjects,
  MANIFEST_RELATIVE_PATH,
  normalizeRoot,
} from './projects.js';
import { messageOf } from './sessions.js';
import { effectiveButtons, emptyLayout, layoutFileIn, readLayout, writeLayout } from './store.js';
import {
  ERROR_CODES,
  type ApiError,
  type ApiResult,
  type ButtonDensity,
  type ButtonOverride,
  type ConfigSource,
  type FloatingButtonView,
  type FocusedProject,
  type LocalLayout,
  type NewTaskInput,
  type ResolvedEntry,
  type RunDeckCapabilities,
  type RunDeckConfig,
  type RunDeckState,
  type RunProject,
  type RunRecord,
  type StartRunRequest,
  type TaskDetection,
} from './types.js';

export { initialHookState, observeLine } from './hooks.js';
export type { HookOutcome, HookState } from './hooks.js';

/* ── 小工具：把可缺省字段收成"要么整键要么无键"，免得 undefined 污染下游 ── */

function pickIcon(icon: string | undefined): { icon: string } {
  return { icon: icon ?? 'play' };
}
function pickGroup(group: string | undefined): { group: string } {
  return { group: group ?? 'default' };
}
function pickLabel(label: string | undefined): { label?: string } {
  return label !== undefined ? { label } : {};
}
function pickOrder(order: number | undefined): { order: number } {
  return { order: order ?? 100 };
}
function pickDensity(density: ButtonDensity | undefined): { density?: ButtonDensity } {
  return density !== undefined ? { density } : {};
}

/** Windows 路径比较：大小写不敏感、`\` 与 `/` 等价。 */
function samePath(left: string, right: string): boolean {
  return normalizeForCompare(left) === normalizeForCompare(right);
}

function normalizeForCompare(path: string): string {
  const trimmed = path.trim().replaceAll('\\', '/');
  const withoutTrailing = trimmed.length > 1 ? trimmed.replace(/\/+$/u, '') : trimmed;
  return withoutTrailing.toLowerCase();
}

/** 这个路径是不是一个真实存在的目录（用来拒绝"过期的会话 cwd"）。 */
async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 这个路径是不是一份真实存在的文件（用来发现"清单刚刚被写出来"）。 */
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/* ── 会话目录 → cwd 的兜底扫描 ──
 *
 * 只在"内存会话存储里没有这条会话"时才走到这里，所以要点是**老实不猜**：
 *   - 深度与节点数都有上限（这是别人服务的返回值，不能假设它一定浅）；
 *   - 目录条目必须按 sessionId **对上号**才敢用它的 cwd，绝不"看到第一个 cwd 就用"；
 *   - 单条检视（inspect）返回的是整条会话，扫描时绕开 `events`：里面可能带着
 *     别的目录（工具调用的 cwd），而且可能非常大。
 */

/** 一条候选记录自报的 id（会话摘要用 `sessionId`，会话头用 `id`）。 */
function recordId(record: Record<string, unknown>): string | null {
  for (const key of ['sessionId', 'id', 'key']) {
    const raw = record[key];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return null;
}

/** 一条候选记录自报的 cwd。 */
function recordCwd(record: Record<string, unknown>): string | null {
  const raw = record['cwd'];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

const CWD_SCAN_MAX_DEPTH = 6;
const CWD_SCAN_MAX_NODES = 4096;

/**
 * 会话目录"这一轮没查到"之后的静默时间。
 *
 * `/state` 是 2.5 秒一轮的；一条头部里本来就没有 cwd 的会话会让每一轮都去扫
 * 一次会话目录（那是一次持久化读）。压到 5 秒只是防止把轮询变成磁盘扫描，
 * 不影响正确性：真被解析出来时是**内存路径先命中**（那条在缓存之前）。
 */
const CATALOG_RETRY_MS = 5000;

/** 每条 run 在 `RunRecord.tail` 里留几行输出（输出面板 / ⚙ 面板展示用）。 */
const TAIL_LINES = 200;

/** 子树里是否有自报 id 等于 `sessionId` 的节点（含自己）。 */
function subtreeHasId(value: unknown, sessionId: string, depth: number): boolean {
  if (depth > CWD_SCAN_MAX_DEPTH || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => subtreeHasId(item, sessionId, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (recordId(record) === sessionId) return true;
  return Object.values(record).some((child) => subtreeHasId(child, sessionId, depth + 1));
}

/**
 * 在**会话目录**的返回值里按 sessionId 找 cwd。
 *
 * 认的是"带 cwd 的那个节点，它自己或它的子树里带着目标 sessionId"——这样
 * `{ sessionId, cwd }`、`{ sessionId, header: { cwd } }`、`{ id, cwd }` 三种
 * 摆放方式都能认出来，同时又不会把**别的**会话（或别的字段）的 cwd 捡走。
 */
function findCwdInCatalog(value: unknown, sessionId: string): string | null {
  let visited = 0;

  const walk = (node: unknown, depth: number): string | null => {
    if (depth > CWD_SCAN_MAX_DEPTH || visited > CWD_SCAN_MAX_NODES) return null;
    if (node === null || typeof node !== 'object') return null;
    visited += 1;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item, depth + 1);
        if (hit !== null) return hit;
      }
      return null;
    }
    const record = node as Record<string, unknown>;
    const cwd = recordCwd(record);
    if (cwd !== null && subtreeHasId(record, sessionId, depth)) return cwd;
    for (const child of Object.values(record)) {
      const hit = walk(child, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };

  return walk(value, 0);
}

/**
 * 在**单条会话检视**（`SessionInspection`）的返回值里找 cwd。
 *
 * 权威位置是 `inspection.meta.cwd`（`SessionStorageMetadata.meta: SessionHeader`），
 * 先直接取它；形状万一变了就做一次浅扫描兜底，**跳过 `events`**。
 */
function findCwdInInspection(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const meta = (value as Record<string, unknown>)['meta'];
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    const direct = recordCwd(meta as Record<string, unknown>);
    if (direct !== null) return direct;
  }
  let visited = 0;
  const walk = (node: unknown, depth: number): string | null => {
    if (depth > 2 || visited > 64) return null;
    if (node === null || typeof node !== 'object') return null;
    visited += 1;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item, depth + 1);
        if (hit !== null) return hit;
      }
      return null;
    }
    const record = node as Record<string, unknown>;
    const cwd = recordCwd(record);
    if (cwd !== null) return cwd;
    for (const [key, child] of Object.entries(record)) {
      if (key === 'events') continue;
      const hit = walk(child, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(value, 0);
}

export interface ManagerDeps {
  ctx: DshContext;
  /** host 半边的版本，写进 /state 供 UI 显示。 */
  version: string;
  config: () => RunDeckConfig;
  configSource: () => ConfigSource;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

function failure(code: string, message: string, hint?: string): ApiError {
  const error: ApiError = { ok: false, code, message };
  if (hint !== undefined) error.hint = hint;
  return error;
}

export class RunDeckManager {
  private readonly warnings: string[] = [];

  /** 内存里的 run 记录；只在本进程有效（没有 run.json 那种需要跨进程共享的状态）。 */
  private readonly runs = new Map<string, RunRecord>();

  /**
   * 每条 run 的钩子状态（beginsPattern 见过没、ready 没、URL 抓到了没、
   * serverReadyAction 执行过没、onReady 触发过没）。随 run 建、随 run 停而清。
   */
  private readonly hooks = new Map<string, HookState>();

  /** 每条 run 的输出轮询定时器（就绪判定与退出判定都靠它）。 */
  private readonly pollers = new Map<string, ReturnType<typeof setInterval>>();

  /** 每条 run 的 PTY 输出抓手（按行切好、剥过 ANSI；退出判定看它的 settled）。 */
  private readonly taps = new Map<string, TerminalTap>();
  /** 解析成功的"会话 id → 工作目录"（会话目录只在内存查不到时才读，见 sessionCwdAsync）。 */
  private readonly cwdCache = new Map<string, string>();

  /** 会话目录"没查到"之后的静默截止时间（避免轮询变成磁盘扫描）。 */
  private catalogRetryAfter = 0;

  /** 已经为它打过一行"cwd 解析"日志的会话（一次性诊断，免得轮询刷屏）。 */
  private readonly cwdReported = new Set<string>();

  private projects: RunProject[] = [];

  private layout: LocalLayout = emptyLayout();

  private layoutFile: string;

  /** 上次读到/写下 `layout.json` 时的 mtime；用来发现"文件被外部改过"。 */
  private layoutMtimeMs: number | undefined;

  private refreshing: Promise<RunProject[]> | undefined;

  /**
   * 清单写入的串行锁：按清单路径排队 Promise 链。
   *
   * "读 → 改写 → rename"绝不接受交错——同一个清单上两个请求（界面新建 × 2、
   * 一个建一个删）都从旧文本出发各自插入，后写者会把先写者整条吞掉。
   * 把整个读改写过程排进同一把锁后，后进者**先看到前者的写入结果**再动手。
   */
  private readonly manifestLocks = new Map<string, Promise<unknown>>();

  /** 一个请求独占某份清单的读改写；前一个失败不应断掉排在自己后面的队列。 */
  private withManifestLock<T>(manifestPath: string, work: () => Promise<T>): Promise<T> {
    const key = normalizeForCompare(manifestPath);
    const queued = this.manifestLocks.get(key) ?? Promise.resolve();
    const run = queued.then(work, work);
    // 后来的排队者要接在 run 的**吞错尾巴**上——rejection 不许传给下一次 then。
    const tail = run.catch(() => undefined);
    this.manifestLocks.set(key, tail);
    // 落定时若“队尾还是自己”，把 key 摘掉；有后继者会先覆盖，比对就不成立。
    void tail.then(() => {
      if (this.manifestLocks.get(key) === tail) this.manifestLocks.delete(key);
    });
    return run;
  }

  /** 清单的原子写：唯一临时文件 + rename。临时文件名唯一，两个并发写不踩同一个。 */
  private async writeManifestAtomically(manifestPath: string, text: string): Promise<void> {
    // 新清单可能要连 `.dsh/` 一起建出来。
    await mkdir(dirname(manifestPath), { recursive: true });
    // 固定 `.tmp` 名在两个并发写时会被互相覆盖（甚至交叉写坏）；带随机尾巴，
    // 这里的调用都被 withManifestLock 串行化了，随机尾巴只是防外部进程同写。
    const temp = `${manifestPath}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, text, 'utf8');
      await rename(temp, manifestPath);
    } catch (error) {
      // rename 没到、临时文件一定会留残渣（清理失败也只算垃圾文件，不该盖错误）。
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  constructor(private readonly deps: ManagerDeps) {
    this.layoutFile = layoutFileIn(deps.config().dataDir);
  }

  /* ─────────────────────────── 启动 ─────────────────────────── */

  async initialize(): Promise<void> {
    this.warnings.length = 0;
    const config = this.deps.config();
    this.layoutFile = layoutFileIn(config.dataDir);
    try {
      await mkdir(config.dataDir, { recursive: true });
    } catch (error) {
      this.recordWarning(`插件数据目录不可用：${String(error)}`);
    }
    this.layout = await readLayout(this.layoutFile);
    try {
      this.layoutMtimeMs = (await stat(this.layoutFile)).mtimeMs;
    } catch {
      this.layoutMtimeMs = undefined;
    }
    await this.refresh();
  }

  /**
   * 布局文件被外部改过就重读。
   *
   * `layout.json` 是这台机器上的私有状态，用户完全可能直接编辑它；也出现过
   * "四个按钮全被收起 → 条整条消失 → 改文件也不生效"这种需要手改救回来的情形。
   * 之前只在 `initialize()` 读一次，手改必须重启才看见——现在每次 `/state` 前
   * 比对一次 mtime（一次 stat，很便宜），改完最迟下一轮轮询就生效。
   */
  async syncLayoutFromDisk(): Promise<void> {
    try {
      const stats = await stat(this.layoutFile);
      if (this.layoutMtimeMs !== undefined && stats.mtimeMs === this.layoutMtimeMs) return;
      this.layout = await readLayout(this.layoutFile);
      this.layoutMtimeMs = stats.mtimeMs;
    } catch {
      // 文件不存在 / 读不到：保持内存里那份（等同"没改过"），不要因此把覆盖清空。
    }
  }

  recordWarning(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  /* ─────────────────────────── 清单 ─────────────────────────── */

  /**
   * 重读全部清单。
   *
   * 并发调用合并成一次：UI 轮询 /state 时可能连点几下，
   * 每次都去读盘会把几十个 manifest 读好几遍。
   */
  async refresh(): Promise<RunProject[]> {
    if (this.refreshing === undefined) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<RunProject[]> {
    // 顺序要紧：先清空，再解析根目录（这一步可能记 configPath 的告警），
    // 最后才把清单读出来的告警追加进去。反过来会让 configPath 的告警被清掉。
    this.warnings.length = 0;
    // `/refresh` 的语义是"重读磁盘"：清单和本地布局一起重读，手改任何一份都不用重启。
    await this.syncLayoutFromDisk();
    const roots = await this.projectRoots();
    const projects = await loadProjects(roots);
    this.projects = projects;

    // 一行诊断：扫描到几个根目录、其中几个真带清单。
    // "装上了但什么都不显示"最难查的地方就是这里——是没扫到目录，还是扫到了没清单。
    this.deps.log(
      'info',
      `清单扫描：${roots.length} 个项目根目录，其中 ${projects.filter((p) => p.entries.length > 0).length} 个有可用条目` +
        (roots.length > 0 ? `（${roots.map((r) => r.split('/').pop() ?? r).join(', ')}）` : ''),
    );

    for (const project of projects) {
      for (const warning of project.warnings) {
        this.recordWarning(`${project.name}：${warning}`);
      }
    }
    if (roots.length === 0) {
      this.recordWarning(
        '没有找到任何项目根目录：当前 DSH 没有工作区，且插件配置里也没有 configPath。' +
          '（这不影响按钮条——它跟着当前会话的工作目录走。）',
      );
    }
    return projects;
  }

  /**
   * 项目根目录 = DSH 工作区 ∪ `configPath` 显式指的那一个。
   *
   * `configPath` 的两种合法形态（按磁盘事实分派，不猜）：
   *   - 指向**目录**：按普通项目根目录处理，读 `<dir>/.dsh/run-deck/run.json`
   *   - 指向**文件**：它是一个清单文件本身，所在目录就是项目根目录
   *      （例如没有固定工作区时，把某处一份 run.json 直接指过来）
   *
   * 早先的版本假设它一定是"清单所在目录"并把最后一段当文件名去掉——那样
   * 一个真实存在的 `<x>/.dsh/run-deck/run.json` 会被读成 `<x>/.dsh/.dsh/run-deck/run.json`，
   * 永远找不到。现在按 isFile() 分派。
   */
  private async projectRoots(): Promise<string[]> {
    const roots: string[] = [];

    const registry = this.deps.ctx.get<DshWorkspaceRegistryService>('workspaceRegistry');
    if (registry !== undefined) {
      try {
        for (const workspace of registry.list()) roots.push(workspace.path);
      } catch (error) {
        this.recordWarning(`读工作区列表失败：${String(error)}`);
      }
    }

    // 会话的 cwd 也是项目来源，而且比工作区注册表更可靠：
    // 桌面版实测 `workspaceRegistry.list()` 返回空（扫描到 0 个根目录），
    // 但每个会话的 `header.cwd` 就是它所在项目的绝对路径（DSH 硬约束
    // `session.cwd === workspace.path`）。这样"你实际在做的项目"一定被发现，
    // 不依赖客户端报 cwd，也不要求目录先被注册成工作区。
    const sessions = this.deps.ctx.get<{
      list?: () => Array<{ header?: { cwd?: string } }>;
    }>('sessions');
    if (sessions !== undefined && typeof sessions.list === 'function') {
      try {
        for (const session of sessions.list()) {
          const cwd = session?.header?.cwd;
          if (typeof cwd === 'string' && cwd.length > 0) roots.push(cwd);
        }
      } catch (error) {
        this.recordWarning(`读会话列表失败：${String(error)}`);
      }
    }

    const configPath = this.deps.config().configPath.trim();
    if (configPath.length > 0) {
      // 整个插件内部一律用 `/`（Windows 上 `\` 也能用，但两种混着会出现
      // "同一个目录比较不相等"的怪事——DshWorkspaceEntity.path 也是归一化过的）。
      const normalized = configPath.replaceAll('\\', '/');
      let stats: import('node:fs').Stats | undefined;
      try {
        stats = await stat(configPath);
      } catch {
        stats = undefined;
      }
      if (stats === undefined) {
        this.recordWarning(
          `插件配置的 configPath 不存在：${configPath}（已忽略，仍从工作区读清单）`,
        );
      } else if (stats.isDirectory()) {
        roots.push(normalized);
      } else {
        // 是一个文件：它所在的目录就是项目根目录。但**只有**当它带着本插件清单
        // 的固定落点结尾时才直接用它——否则它可能是仓库里另一个名字的清单，那时
        // 项目根目录是它的祖父目录，读 `<grandparent>` 下的清单仍然是错的。
        // 所以这里分两种情况，都用磁盘事实说话：
        //   a) `<x>/.dsh/run-deck/run.json`  → 项目根 = `<x>`（现行落点）
        //   a') `<x>/.dsh/run.json`          → 项目根 = `<x>`（旧落点，读盘兼容）
        //   b) `<x>/my-tasks.json`           → 项目根 = `<x>`，但清单名不对，
        //      本插件只认 `.dsh/run-deck/run.json`，于是如实记一条告警并跳过它。
        const segments = dirname(normalized).split('/');
        const lastTwo = segments.slice(-2);
        const isUnderDsh = lastTwo[lastTwo.length - 1] === '.dsh';
        const isCurrentManifest =
          lastTwo[lastTwo.length - 1] === 'run-deck' && lastTwo[0] === '.dsh';
        if (isUnderDsh || isCurrentManifest) {
          // 旧落点是 `.dsh/x` 的父级；新落点是 `.dsh/run-deck/x` 的祖父级。
          const rootDepth = isUnderDsh ? 1 : 2;
          const rootSegments = segments.slice(0, -rootDepth);
          roots.push(rootSegments.length > 1 ? rootSegments.join('/') : rootSegments[0] ?? '');
        } else {
          this.recordWarning(
            `configPath 指向 ${configPath}，但本插件只认项目根目录下的 .dsh/run-deck/run.json；` +
              '请把它改成项目根目录（或指向 <项目根>/.dsh/run-deck/run.json）。',
          );
        }
      }
    }

    // 不再把 `process.cwd()` 当项目根目录：对 host 进程来说那是 DSH 的安装目录，
    // 不是用户的项目。它以前混进来会让 `listButtons()` 扫到插件仓库自己的清单
    // （于是"无参调用"的结果依赖启动目录），也会把安装目录当成一个项目去读。
    // 用户实际在做的项目通过两条路进来：工作区注册表，以及客户端按当前会话 cwd
    // 调的 `/focus`（那条路对任意目录都成立，不要求先注册成工作区）。
    return roots;
  }

  listProjects(): RunProject[] {
    return this.projects;
  }

  /**
   * 由会话 id 解析它的工作目录（`session.header.cwd`）——**同步的"快"路径**。
   *
   * 会话级插槽只把 sessionId 交给插件，而浏览器侧的 `sessions` 服务没有
   * `get`/`list`（只有 retain/scope/binding/…），所以 cwd 只能在 host 这边取。
   * 这一条走内存会话存储：会话活着时最准，也是绝大多数情况。
   */
  sessionCwd(sessionId: string): string | null {
    const trimmed = sessionId.trim();
    if (trimmed.length === 0) return null;
    const sessions = this.deps.ctx.get<DshSessionsService>('sessions');
    if (sessions === undefined) return null;
    try {
      const one = sessions.get?.(trimmed);
      const cwd = one?.header?.cwd;
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
      for (const session of sessions.list?.() ?? []) {
        if (session?.id !== trimmed) continue;
        const candidate = session?.header?.cwd;
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
      }
    } catch (error) {
      this.recordWarning(`读会话工作目录失败：${String(error)}`);
    }
    return null;
  }

  /**
   * 会话 → 工作目录（**完整**解析：内存会话存储 → 缓存 → 会话目录）。
   *
   * 为什么不能只有内存存储那一条路：`ctx.sessions` 是**内存**存储，里面只有
   * **attached** 的会话（agent 活着、或被某条执行链持有）。`/state` 每 2.5 秒轮询一次，
   * 而侧边栏点开的**空闲**会话不在内存里时，`session.header.cwd` 永远是 undefined
   * → `focused:null` → `buttons:[]` → 浮动条整条隐藏。
   * 症状就是"这个仓库本来有按钮（那时这条会话还是活的），重启 DSH 之后没了"。
   *
   * 会话目录正好补这个洞——`sessionController` 的原文注释就是
   * "read every visible **attached and persisted** Session **without activating an Agent**"：
   * 它还专门为"没有 attached 的冷会话"另起一条 `summarizeCold(header)`，
   * 摘要里就带 `cwd`（`listFields(header)` → `{ cwd: header.cwd }`）。
   *
   * 顺序：内存（免费、最准）→ 缓存 → 会话目录。解析成功就**缓存**——一条会话的
   * cwd 在创建时就定了，不会变，所以 2.5 秒一次的轮询不会反复读会话目录。
   */
  async sessionCwdAsync(sessionId: string): Promise<string | null> {
    const trimmed = sessionId.trim();
    if (trimmed.length === 0) return null;

    // 先内存：会话刚被激活（用户开始用它）时，这里立刻就能命中，
    // 连缓存都不用等（缓存可能是"那时还没查到的"旧结论，所以放在它前面）。
    const fast = this.sessionCwd(trimmed);
    if (fast !== null) {
      this.rememberCwd(trimmed, fast);
      this.reportCwdResolution(trimmed, fast, '内存会话存储 header.cwd');
      return fast;
    }

    const cached = this.cwdCache.get(trimmed);
    if (cached !== undefined) return cached;

    // 查不到的会话（头部本来就没有 cwd、或目录服务不可用）不缓存，
    // 但也不能让每一轮 2.5 秒的轮询都去扫一遍会话目录。
    if (Date.now() < this.catalogRetryAfter) return null;

    const controller = this.deps.ctx.get<DshSessionControllerService>('sessionController');
    if (controller === undefined) {
      this.reportCwdResolution(
        trimmed,
        null,
        'sessionController=MISSING：宿主没把这个服务交给本 fiber 的作用域',
      );
      return null;
    }

    // 先 list：一次调用覆盖 attached + persisted 两种会话。
    if (typeof controller.list === 'function') {
      try {
        const items = await controller.list({}, undefined);
        const found = findCwdInCatalog(items, trimmed);
        if (found !== null) {
          this.rememberCwd(trimmed, found);
          this.reportCwdResolution(trimmed, found, '会话目录 sessionController.list（含冷会话摘要）');
          return found;
        }
      } catch (error) {
        this.recordWarning(`sessionController.list 解析会话目录失败：${messageOf(error)}`);
      }
    }

    // 再 inspect：它**连整条会话日志一起返回**（`SessionInspection.events`），
    // 所以只在 list 也查不到时走，并且扫描时绕开 events。
    if (typeof controller.inspect === 'function') {
      try {
        const inspection = await controller.inspect(trimmed, undefined);
        const found = findCwdInInspection(inspection);
        if (found !== null) {
          this.rememberCwd(trimmed, found);
          this.reportCwdResolution(trimmed, found, '会话目录 sessionController.inspect（持久化头部）');
          return found;
        }
      } catch (error) {
        this.recordWarning(`sessionController.inspect 解析会话工作目录失败：${messageOf(error)}`);
      }
    }
    // 这一轮什么也没查到：压住节奏，别让 2.5 秒一次的轮询反复去扫会话目录。
    this.catalogRetryAfter = Date.now() + CATALOG_RETRY_MS;
    this.reportCwdResolution(
      trimmed,
      null,
      `sessionController=ok 但目录里没有带 cwd 的这条会话（list=${
        typeof controller.list === 'function' ? 'ok' : 'MISSING'
      }，inspect=${typeof controller.inspect === 'function' ? 'ok' : 'MISSING'}）`,
    );
    return null;
  }

  /**
   * 每个会话只打一行"cwd 是从哪解析出来的"。
   *
   * 存在的理由：这条链路一断，界面表现是**整条隐藏**（什么都没有），
   * 而日志里原本不留任何痕迹，只能靠猜。有了这一行，
   * "重启之后这个仓库为什么没按钮"在日志里就是一句可读的话。
   * 会话 id 由宿主日志自己打码（实测显示为 `****`）。
   */
  private reportCwdResolution(sessionId: string, cwd: string | null, source: string): void {
    if (this.cwdReported.has(sessionId)) return;
    if (this.cwdReported.size >= 512) this.cwdReported.clear();
    this.cwdReported.add(sessionId);
    this.deps.log(
      'info',
      cwd === null
        ? `cwd 解析：会话 ${sessionId} 没解析出工作目录（${source}）→ 浮动条整条隐藏`
        : `cwd 解析：会话 ${sessionId} → ${cwd}（来源：${source}）`,
    );
  }

  /** 记住一条"会话 → cwd"的解析结果（只在成功时记）。 */
  private rememberCwd(sessionId: string, cwd: string): void {
    // 极端情况下（用户逛了几百条会话）不至于无限增长。
    if (this.cwdCache.size >= 512) this.cwdCache.clear();
    this.cwdCache.set(sessionId, cwd);
  }

  /**
   * 让一个目录进入已加载项目集合（`/state` 现读磁盘时调它）。
   *
   * 启动那一刻 `workspaceRegistry.list()` 与 `sessions.list()` 都可能还是空的
   * （服务尚未物化 / 还没有会话），所以"当前会话的项目"必须在请求时现读，
   * 而不是指望启动扫描。@returns 是否真的读到了条目。
   */
  async ensureProject(root: string): Promise<boolean> {
    const trimmed = root.trim();
    if (trimmed.length === 0) return false;
    const project = await this.loadFocusedProject(trimmed);
    return project !== undefined && project.entries.length > 0;
  }

  /** 找一个条目（按 projectRoot + entryId）。 */
  findEntry(projectRoot: string, entryId: string): ResolvedEntry | undefined {
    const project = this.projects.find((entry) => entry.root === projectRoot);
    return project?.entries.find((entry) => entry.id === entryId);
  }

  /* ─────────────────────────── run 登记 ─────────────────────────── */

  listRuns(): RunRecord[] {
    return [...this.runs.values()].sort((left, right) => right.startedAt - left.startedAt);
  }

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  /**
   * 起一条 run：**真的开一条 PTY 跑起来**（不是只登记）。
   *
   * 流程：解析执行缝与 shell（缺任何一样都给一条能读懂的原因）→ `spawnTerminal`
   * → 登记 run → 起输出轮询（就绪判定、退出判定、onReady 都在那）。
   *
   * 早先这里是"只登记不执行"，于是点了按钮界面上多了个"运行中"、实际什么都没跑——
   * 那正是使用者报的"点击启动不了对应脚本"。
   */
  async startRun(request: StartRunRequest): Promise<ApiResult<RunRecord>> {
    const entry = this.findEntry(request.projectRoot, request.entryId);
    if (entry === undefined) {
      return failure(
        ERROR_CODES.notFound,
        '找不到这个条目',
        `项目 ${request.projectRoot} 里没有 id 为 ${request.entryId} 的 task`,
      );
    }

    // 同一条目重复跑：提示而不是静默开第二个——长驻服务（isBackground）尤其如此。
    const existing = [...this.runs.values()].find(
      (run) =>
        run.projectRoot === request.projectRoot &&
        run.entryId === request.entryId &&
        run.status !== 'exited',
    );
    if (existing !== undefined) {
      return failure(
        ERROR_CODES.busy,
        `「${entry.label}」已经有一个进行中的运行`,
        '先停止它，或用「重跑」停掉旧的再开新的。',
      );
    }

    const route = await resolveRunRoute(this.deps.ctx);
    if (route.ok === false) {
      this.recordWarning(route.message);
      this.deps.log('warn', `起「${entry.label}」失败：${route.message}`);
      return failure(route.code, route.message, route.hint);
    }

    const commandLine = renderCommandLine(entry);
    let handle: DshSubprocessTerminalHandle;
    try {
      handle = await spawnRunTerminal(route.route, entry, commandLine, request.sessionId);
    } catch (error) {
      const message = `起终端失败：${messageOf(error)}`;
      this.recordWarning(message);
      this.deps.log('error', `${message}（${entry.label}）`);
      return failure(ERROR_CODES.spawn, message, '宿主没能分配 PTY；看宿主日志里的 subprocess-local 报错。');
    }

    const now = Date.now();
    const runId = `run-${now.toString(36)}-${randomBytes(4).toString('hex')}`;
    const record: RunRecord = {
      runId,
      projectRoot: request.projectRoot,
      entryId: entry.id,
      label: entry.label,
      status: 'running',
      startedAt: now,
      background: entry.isBackground,
      // node-pty 在 Windows/ConPTY 上实测会给出 `pid = 0`（拿不到真 pid），
      // 那就**不记**——面板里显示 "pid 0" 只会让人以为进程没起来。
      ...(handle.pid > 0 ? { pid: handle.pid } : {}),
      ...(request.sessionId !== undefined ? { ownerSessionId: request.sessionId } : {}),
    };
    this.runs.set(runId, record);
    // 钩子状态随 run 一起建：activeOnStart 决定"进程一起来是否就算已开始"。
    this.hooks.set(runId, initialHookState(entry.problemMatcher?.background?.activeOnStart));
    // 输出从这一刻起就被消费（不读会把 PTY 背压住）；轮询只是来取切好的行。
    const tap = tapRunTerminal(handle);
    this.taps.set(runId, tap);
    // 进程自己退出时把 run 判成已退出（轮询是 800ms 的，这里顺手兜住"很短的命令"）。
    void tap.settled.then((outcome) => this.settleRun(runId, outcome));
    this.deps.log(
      'info',
      `跑 ${runId}：${entry.label} → ${handle.pid > 0 ? `pid ${handle.pid}` : 'PTY 已开'}（${route.route.shell} ${route.route.shellArgs.join(' ')} ${commandLine}）`,
    );
    this.startPolling(runId);
    return { ok: true, ...record };
  }

  /**
   * 一条 run 的进程结算：写退出码/信号，状态转 exited，收掉定时器与钩子。
   *
   * 只结算一次（`status === 'exited'` 时直接返回），因为 `stopRun` 会先把状态置成
   * exited，之后进程真的退出时这里不能把"用户停的"改写成"自己退的"。
   */
  private settleRun(runId: string, outcome: { exitCode: number | null; signal: string | null }): void {
    const record = this.runs.get(runId);
    this.stopPolling(runId);
    this.taps.delete(runId);
    if (record === undefined) return;
    if (record.status === 'exited') {
      this.deps.log(
        'info',
        `run ${runId} 的进程随后也退出了（exit=${outcome.exitCode ?? 'null'}，signal=${outcome.signal ?? 'null'}）`,
      );
      return;
    }
    this.runs.set(
      runId,
      transition(record, {
        status: 'exited',
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        now: Date.now(),
      }),
    );
    this.hooks.delete(runId);
    this.deps.log(
      'info',
      `run ${runId} 结束：${record.label}（exit=${outcome.exitCode ?? 'null'}，signal=${outcome.signal ?? 'null'}）`,
    );
  }

  /* ─────────────────────────── 事件钩子（第 3 步） ─────────────────────────── */

  /**
   * 一行输出进来后推进一条 run 的钩子状态。
   *
   * 返回值是**给调用方执行的动作清单**：该打开哪个 URL、该接哪个 entry。
   * 本方法只改状态、不执行动作——因为它不该自己决定"打开浏览器"
   * 或者"拉起另一个 run"（那需要调用方有对应权限，也可能是宿主自己的入口）。
   *
   * 未接线时（本版）：host 侧拿不到终端的 stdout，所以没人调它；
   * 语义层本身已经完整且有测试覆盖（见 scripts/smoke.mjs 的 hooks 一节）。
   */
  observe(
    runId: string,
    line: string,
  ): ApiResult<{ run: RunRecord; outcome: HookOutcome; entry: ResolvedEntry }> {
    const record = this.runs.get(runId);
    if (record === undefined) {
      return failure(ERROR_CODES.notFound, '找不到这条 run', `没有 id 为 ${runId} 的运行`);
    }
    const project = this.projects.find((candidate) => candidate.root === record.projectRoot);
    const entry = project?.entries.find((candidate) => candidate.id === record.entryId);
    if (project === undefined || entry === undefined) {
      return failure(ERROR_CODES.notFound, '找不到这条 run 对应的条目', `${record.projectRoot} / ${record.entryId}`);
    }

    const before = this.hooks.get(runId) ?? initialHookState(entry.problemMatcher?.background?.activeOnStart);
    const outcome = observeLine(before, entry, line, project.entries);
    this.hooks.set(runId, outcome.state);

    const updated = transition(record, {
      ...(outcome.becameReady ? { status: 'ready' as const } : {}),
      ...(outcome.state.url !== undefined ? { ready: { url: outcome.state.url } } : {}),
      now: Date.now(),
    });
    this.runs.set(runId, updated);

    if (outcome.note !== undefined) {
      this.deps.log('warn', `run ${runId} 钩子：${outcome.note}`);
    }
    return { ok: true, run: updated, outcome, entry };
  }

  /* ─────────────── 输出轮询：钩子、就绪、退出判定都靠它 ─────────────── */

  /**
   * 每 800ms 把这条 run 的 PTY 输出**新切出来的行**逐行喂给 `observe()`（钩子语义层）。
   *
   * 为什么还要轮询：输出抓手是**事件驱动**的（`handle.output` 一到就读），但"喂给钩子"
   * 需要一个节拍——800ms 足够让 begins/ends pattern 认到行，也不会刷爆日志。
   * 退出判定不靠轮询猜（进程没了/终端消失了那种猜法），而是 `settleRun` 听
   * `handle.done`：`cmd /d /s /c` 执行完就退，所以 done 结算 = 任务结束。
   */
  private startPolling(runId: string): void {
    if (this.pollers.has(runId)) return;
    const timer = setInterval(() => {
      this.pollOnce(runId);
    }, 800);
    (timer as { unref?: () => void }).unref?.();
    this.pollers.set(runId, timer);
  }

  private stopPolling(runId: string): void {
    const timer = this.pollers.get(runId);
    if (timer !== undefined) clearInterval(timer);
    this.pollers.delete(runId);
  }

  private pollOnce(runId: string): void {
    const record = this.runs.get(runId);
    if (record === undefined || record.status === 'exited') {
      this.stopPolling(runId);
      return;
    }
    const tap = this.taps.get(runId);
    if (tap === undefined) {
      this.stopPolling(runId);
      return;
    }
    // 顺手让执行缝"记一笔"这条 PTY 的进程树：`inspectActivity()` 内部会把当前
    // 后代并进 handle 自己的 trackedDescendants，而 `terminate()` 就是靠那份记录
    // 去杀整棵树的。**这一步不能省**——这些启动脚本的树里，中间进程（pnpm → node
    // host）会重新挂父，一旦挂断，事后再快照就找不回那些后代了。实测泄漏的
    // vite preview 就是这么留下来的：脚本自己退出了、树还活着、端口一直被占，
    // 下一次点按钮只会看到"已经有一个画廊在跑"。
    void tap.handle.inspectActivity().catch(() => {
      /* 记不上就算了：这只是清理时的线索，不影响这次运行 */
    });
    const fresh = tap.take();
    for (const line of fresh) {
      const advanced = this.observe(runId, line);
      if (!advanced.ok) continue;
      this.dispatchHook(runId, advanced.outcome);
    }
    if (fresh.length > 0) {
      // 面板要能说清"脚本自己为什么没起来"，所以留最近几行（剥过 ANSI 的纯文本）；
      // rawTail 是同一段的原样版（颜色码原样），输出悬浮卡画彩色控制台用。
      const current = this.runs.get(runId);
      if (current !== undefined) {
        this.runs.set(runId, {
          ...current,
          tail: tap.tail().slice(-TAIL_LINES),
          ...(tap.rawTail().length > 0 ? { rawTail: tap.rawTail().slice(-TAIL_LINES) } : {}),
        });
      }
    }
    // 进程已经结算：settleRun 会收尾（这里只保证"最后几行"先喂完）。
    if (tap.finished) this.settleRun(runId, tap.outcome ?? { exitCode: null, signal: null });
  }

  /**
   * 把钩子给出的动作执行掉：**把就绪地址交给界面打开**（`serverReadyAction`）、
   * 接下一个 entry（`onReady`）。
   *
   * 为什么打开浏览器这件事交给界面（client half）：宿主这一侧**没有**可用的入口。
   * `ctx.openPath` 服务在桌面版组合里不存在，`sessionController.openWorkspacePath`
   * 要的是**工作区内**的路径（一个 `http://…` 不是它的东西），实测返回打不开。
   * 而界面侧 `window.open(url, '_blank')` 会被桌面壳的 `setWindowOpenHandler`
   * 接住（实测 `electron-runtime` 里 `shell.openExternal(target.href)`），
   * 也就是**系统默认浏览器**——这正是 `openExternally` 要的效果，而且 Web 版同样成立。
   *
   * 所以这里只把地址记进 run（`ready.url`）并留一行日志，由 `FloatingBarHost`
   * 在轮询到它时打开一次（每个 run 只开一次，去重键存在浏览器本地）。
   */
  private dispatchHook(runId: string, outcome: HookOutcome): void {
    if (outcome.open !== undefined) {
      // 注意 URL 与后面的说明之间要有空格：宿主日志会把"看起来像 URL 的整段"
      // 做规范化（实测 `http://x/（说明）` 被整段 percent-encode 成
      // `http://x/%EF%BC%88…%EF%BC%89`），挨着写会把说明也吞进地址里。
      this.deps.log(
        'info',
        `serverReadyAction：就绪地址 ${outcome.open.uri} 交给界面打开`,
      );
    }
    if (outcome.chainTo !== undefined) {
      const target = outcome.chainTo;
      const owner = this.runs.get(runId)?.ownerSessionId;
      // 先记进 run：界面要能说出"这一条点了之后还接力起了谁"。
      // 否则"点一个按钮却跑起来两条"看起来就是故障（实测被当成故障问过：
      // "点 jin · desktop，jin · web 怎么也起来了"——其实是 manifest 里的 onReady）。
      const current = this.runs.get(runId);
      if (current !== undefined) this.runs.set(runId, { ...current, chainedTo: target.id });
      this.deps.log('info', `onReady 接力：${target.label}`);
      void this.startRun({
        projectRoot: this.runs.get(runId)?.projectRoot ?? target.cwd,
        entryId: target.id,
        ...(owner !== undefined ? { sessionId: owner } : {}),
      }).then((result) => {
        if (!result.ok) this.deps.log('warn', `onReady 接力失败：${result.message}`);
      });
    }
  }

  /**
   * 停一条 run：**先给前台进程组发 SIGINT**（Ctrl+C——脚本自己的清理处理器就是挂
   * 在它上面的，Windows 上也只有真控制台能把 CTRL_C_EVENT 送进进程组），投递不了
   * 或者过一会还没退出，就 `terminate()` 把这条 PTY 的进程树带走。
   */
  async stopRun(runId: string): Promise<ApiResult<RunRecord>> {
    const record = this.runs.get(runId);
    if (record === undefined) {
      return failure(ERROR_CODES.notFound, '找不到这条 run', `没有 id 为 ${runId} 的运行`);
    }
    if (record.status === 'exited') {
      return failure(ERROR_CODES.busy, '这条 run 已经结束了');
    }

    const tap = this.taps.get(runId);
    if (tap !== undefined && !tap.finished) {
      const sent = await signalRunTerminal(tap.handle, 'SIGINT');
      if (!sent.delivered) {
        this.deps.log('warn', `run ${runId} 的 SIGINT 未投递（${sent.reason ?? '未知原因'}），改为关掉这条 PTY`);
        try {
          await killRunTerminal(tap.handle);
        } catch (error) {
          this.deps.log('error', `run ${runId} 关闭 PTY 也失败：${messageOf(error)}`);
        }
      } else {
        // 脚本收到 Ctrl+C 后应当自己收尾退出；给它一点时间，超时再关掉这条 PTY。
        const timer = setTimeout(() => {
          void this.forceCloseIfAlive(runId);
        }, 8000);
        (timer as { unref?: () => void }).unref?.();
      }
    }

    const now = Date.now();
    const updated: RunRecord = { ...record, status: 'exited', endedAt: now, signal: 'SIGINT' };
    this.runs.set(runId, updated);
    this.stopPolling(runId);
    this.hooks.delete(runId);
    this.deps.log('info', `停止 run ${runId}：${record.label}（已发 SIGINT）`);
    return { ok: true, ...updated };
  }

  /** 收到 Ctrl+C 后仍没退出的兜底：关掉这条 PTY（宿主会等进程树停稳）。 */
  private async forceCloseIfAlive(runId: string): Promise<void> {
    const tap = this.taps.get(runId);
    if (tap === undefined || tap.finished) return;
    try {
      await killRunTerminal(tap.handle);
      this.deps.log('warn', `run ${runId} 收到 SIGINT 后仍未退出，已关掉这条 PTY`);
    } catch (error) {
      this.deps.log('warn', `run ${runId} 兜底关闭 PTY 失败：${messageOf(error)}`);
    }
  }

  /** 重跑 = 停掉旧的 + 再起一条（owner 沿用旧那条的会话）。 */
  async rerun(runId: string): Promise<ApiResult<RunRecord>> {
    const record = this.runs.get(runId);
    if (record === undefined) {
      return failure(ERROR_CODES.notFound, '找不到这条 run', `没有 id 为 ${runId} 的运行`);
    }
    if (record.status !== 'exited') {
      const stopped = await this.stopRun(runId);
      if (!stopped.ok) return stopped;
    }
    return this.startRun({
      projectRoot: record.projectRoot,
      entryId: record.entryId,
      ...(record.ownerSessionId !== undefined ? { sessionId: record.ownerSessionId } : {}),
    });
  }

  /* ─────────────────────────── 浮动按钮视图 ─────────────────────────── */

  /**
   * 当前焦点项目：客户端按当前会话的 cwd 报上来，host 据此解析。
   *
   * 为什么由客户端报而不是 host 猜：宿主**没有**"当前工作区"这个概念
   * （`workspaceDomainState` 只有有序列表 + defaultWorkspaceId，没有 activeWorkspaceId）。
   * 而客户端渲染哪条会话它是知道的，会话的 `header.cwd` 就是权威的项目根目录
   * （DSH 的硬约束：`session.cwd === workspace.path`）。
   */
  focusProject(cwd: string): FocusedProject {
    const trimmed = cwd.trim();
    if (trimmed.length === 0) {
      return { cwd: trimmed, projectRoot: null, reason: '当前会话没有工作目录' };
    }
    const known = this.projects.find((project) => samePath(project.root, trimmed));
    if (known !== undefined) {
      return {
        cwd: trimmed,
        projectRoot: known.root,
        ...(known.configFile !== undefined ? { configFile: known.configFile } : {}),
        // 没有清单 / 清单里 0 条时**仍然是焦点**：条要一直在，`+` 才有地方建第一条。
        // reason 只是给界面一句说明，不再意味着"整条隐藏"。
        ...(known.entries.length === 0
          ? {
              reason:
                known.configFile === undefined
                  ? '这个目录还没有 .dsh/run-deck/run.json'
                  : '这个目录下没有可用条目',
            }
          : {}),
      };
    }
    return { cwd: trimmed, projectRoot: null, reason: '未在已加载的项目里找到这个目录' };
  }

  /**
   * 浮动层要显示的按钮：**只看焦点项目**，按 run.json 的 buttons[] 叠加本地覆盖排序。
   *
   * - 没有声明过 buttons[] 时**自动带上该项目的全部条目**——否则用户必须先编辑
   *   run.json 才能用浮动层，第 5 步就不是"策展"而是"准入"了。
   * - 声明过 buttons[] 时，`+` 面板的"钉到按钮条"靠**本地覆盖 pinned:true** 把
   *   没上条的 task 添加上来（命令仍来自 run.json），所以要把全部条目一并提供给
   *   effectiveButtons。
   */
  listButtons(projectRoot?: string): FloatingButtonView[] {
    const scope =
      projectRoot === undefined
        ? this.projects
        : this.projects.filter((project) => samePath(project.root, projectRoot));
    const runs = this.listRuns();

    const out: FloatingButtonView[] = [];
    for (const project of scope) {
      const declared = (project.document?.buttons ?? []).map((button) => ({
        entry: button.entry,
        ...pickIcon(button.icon),
        ...pickGroup(button.group),
        ...pickLabel(button.label),
        ...pickOrder(button.order),
      }));
      // 没有 buttons[] 就退化成"全部条目"，顺序即 tasks[] 的顺序。
      const source =
        declared.length > 0
          ? declared
          : project.entries.map((entry, index) => ({
              entry: entry.id,
              ...pickIcon(undefined),
              ...pickGroup(undefined),
              ...pickLabel(undefined),
              ...pickOrder(index),
            }));

      const effective = effectiveButtons(
        source,
        this.layout,
        project.entries.map((entry) => ({ entry: entry.id })),
      );
      for (const button of effective) {
        const entry = project.entries.find((candidate) => candidate.id === button.entry);
        if (entry === undefined) {
          this.recordWarning(
            `${project.name}：buttons[] 指向不存在的条目「${button.entry}」，已跳过`,
          );
          continue;
        }
        const run = runs.find(
          (candidate) =>
            candidate.projectRoot === project.root &&
            candidate.entryId === entry.id &&
            candidate.status !== 'exited',
        );
        out.push({
          entry: button.entry,
          icon: button.icon,
          group: button.group,
          ...(button.label !== undefined ? { label: button.label } : {}),
          order: button.order,
          projectRoot: project.root,
          entryLabel: entry.label,
          ...(run !== undefined ? { active: true, status: run.status } : {}),
        });
      }
    }
    return out;
  }

  /** 焦点项目的**全部**条目（`+` 面板要列"所有"，不只是已钉的）。 */
  focusedEntries(projectRoot: string | null): ResolvedEntry[] {
    if (projectRoot === null) return [];
    const project = this.projects.find((candidate) => samePath(candidate.root, projectRoot));
    return project?.entries ?? [];
  }

  /**
   * 把磁盘上一个未被扫到的目录现读成项目（"任意目录都能用"），
   * 并在**清单被改过**时自动重读已经加载过的项目。
   *
   * 两条规则：
   *   - **只有真的读到条目才追加进 this.projects**：一个没有 manifest 的目录不该
   *     被记成"已加载项目"，否则下次刷新又会把它算进去、还可能在 warnings 里重复出现。
   *   - 已经加载过的项目要**看一眼 mtime**：改了 `.dsh/run-deck/run.json`（改 pattern、加按钮）
   *     之后下一轮 `/state`（≤2.5s）就生效，不需要重启 DSH，也不需要知道
   *     `/run-deck list` 会顺手重读。**清单是后来才写出来的**也算"改过"（读盘时它
   *     还不存在），否则新建清单要重启才看得见。实测这条是刚需——改完清单发现界面还是旧的，
   *     人只会以为"插件没生效"。
   */
  private async loadFocusedProject(root: string): Promise<RunProject | undefined> {
    const known = this.projects.find((candidate) => samePath(candidate.root, root));
    if (known !== undefined) {
      if (!(await this.manifestChanged(known))) return known;
      const { project } = await loadProject(root);
      this.projects = [...this.projects.filter((c) => !samePath(c.root, root)), project];
      this.deps.log(
        'info',
        `清单变了，已重读：${project.configFile ?? root}（${project.entries.length} 条）`,
      );
      // 读到 0 条（文件被删 / 写坏了）也**替换掉旧的**，并且仍然当作焦点项目：
      // 面板里会出现告警，条本身照旧在——用户可以点 `+` 重新建条目。
      return project;
    }
    const { project } = await loadProject(root);
    // 目录都不存在（cwd 是过期的会话路径）就别登记成一个"项目"。
    if (!(await directoryExists(root))) return undefined;
    // **没有清单 / 0 条也登记**：这样"一个空目录"也能成为焦点，条上的 `+`
    // 才有地方落笔（第一条启动项就是从那里建出来的）。
    this.projects = [...this.projects, project];
    return project;
  }

  /** 这份清单在磁盘上是否已经和读它的时候不一样了（文件没了也算"变了"）。 */
  private async manifestChanged(project: RunProject): Promise<boolean> {
    if (project.configFile === undefined) {
      // 读这个项目时还没有清单：之后**新建**清单也算"变了"，否则要重启 DSH 才能
      // 看到按钮——而"改完清单下一轮就生效"正是这条轮询要保证的。两个落点都看一眼，
      // 与 loadProject 的读盘兜底保持一致（旧落点 `.dsh/run.json` 仍兼容）。
      return (
        (await fileExists(join(project.root, ...MANIFEST_RELATIVE_PATH))) ||
        (await fileExists(join(project.root, ...LEGACY_MANIFEST_RELATIVE_PATH)))
      );
    }
    try {
      const stats = await stat(project.configFile);
      return project.manifestMtimeMs === undefined || stats.mtimeMs !== project.manifestMtimeMs;
    } catch {
      return true;
    }
  }

  /**
   * 界面新建一条启动项：**真的写进项目的 `.dsh/run-deck/run.json`**（不是本地覆盖）。
   *
   * 这是"手改和界面都能加"的那半边。两条路写的是**同一个文件**，因此：
   *   - 界面创建的条目和手写进去的完全等价（可见、可 diff、能被别人 clone）；
   *   - 命令本体依旧只存在于清单里，`layout.json` 还是只存"怎么看它"。
   *
   * 字段的校验与收敛在 `newtask.ts`（`buildTaskEntry`）：界面上填的是"一行命令 /
   * 一个目录 / 几行 KEY=value / 一条正则"，落盘的是 `TaskEntry`。校验失败时**不落盘**。
   *
   * 写入用最小文本插入（保留注释与排版），插完立刻重新解析校验；随后重读项目，
   * 以重新解析的结果为准（id 唯一化、变量展开、告警都由那条既有链路产生）。
   */
  async createTask(
    projectRoot: string,
    input: NewTaskInput,
  ): Promise<ApiResult<{ entry: string; projectRoot: string }>> {
    const root = normalizeRoot(projectRoot);
    // 锁键取"标准位置的清单路径"：configFile 还不存在时也是同一个落点，
    // 于是「建第一条」与「已有清单上建第二条」排的是同一把锁。
    const manifestPath = join(root, ...MANIFEST_RELATIVE_PATH);
    // 整个读改写（含 id 撞车校验所依据的 entries）都在锁里，两个并发新建不会
    // 从同一份旧文本出发各插一条：后进者在锁里先看到前者的写入结果。
    return this.withManifestLock(manifestPath, async () => {
      // 项目可能还没登记（比如会话 cwd 现读出来的空目录）：这里自己兜一次。
      let project = this.projects.find((candidate) => samePath(candidate.root, root));
      if (project === undefined) {
        if (!(await directoryExists(root))) {
          return failure(ERROR_CODES.notFound, '这个目录不存在', root);
        }
        project = (await loadProject(root)).project;
        this.projects = [...this.projects.filter((c) => !samePath(c.root, root)), project];
      }

      const built = await buildTaskEntry(input, {
        root: project.root,
        entries: project.entries,
        directoryExists,
      });
      if (!built.ok) return built;
      const task = built.task;
      const id = built.entryId;

      // 还没有清单时**顺手把清单建出来**：这是"不想手写配置文件"的唯一出路，
      // 否则第一条启动项永远没有落笔的地方。
      const target = project.configFile ?? manifestPath;
      const creatingManifest = project.configFile === undefined;
      let text: string;
      if (creatingManifest) {
        text = '{\n  "version": "2.0.0"\n}\n';
      } else {
        try {
          text = await readFile(target, 'utf8');
        } catch (error) {
          return failure(ERROR_CODES.fs, '读不了 .dsh/run-deck/run.json', String(error));
        }
      }
      const inserted = insertTaskIntoManifestText(text, task);
      if (!inserted.ok) return failure(ERROR_CODES.fs, inserted.message);

      try {
        await this.writeManifestAtomically(target, inserted.text);
      } catch (error) {
        return failure(ERROR_CODES.fs, '写不了 .dsh/run-deck/run.json', String(error));
      }

      const { project: reloaded } = await loadProject(project.root);
      this.projects = [
        ...this.projects.filter((candidate) => !samePath(candidate.root, project.root)),
        reloaded,
      ];
      this.deps.log(
        'info',
        `界面新建条目：${project.root} → ${id}（${task.label}）${creatingManifest ? '（新建了 .dsh/run-deck/run.json）' : ''}`,
      );
      return { ok: true, entry: id, projectRoot: project.root };
    });
  }

  /**
   * 「+」面板的候选检测：读这个项目的 `package.json` 的 `scripts`。
   *
   * 只读、不落盘、不执行任何东西——结果只用来**预填表单**。这也是"检测"与
   * "创建"分开的原因：VS Code 里探测出来的任务同样要先被选中、再写成一条配置。
   */
  async detectTasks(projectRoot: string): Promise<ApiResult<TaskDetection>> {
    const root = normalizeRoot(projectRoot);
    let project = this.projects.find((candidate) => samePath(candidate.root, root));
    if (project === undefined) {
      if (!(await directoryExists(root))) {
        return failure(ERROR_CODES.notFound, '这个目录不存在', root);
      }
      project = (await loadProject(root)).project;
      this.projects = [...this.projects.filter((c) => !samePath(c.root, root)), project];
    }
    const detection = await detectProjectTasks(project.root, project.entries);
    return { ok: true, ...detection };
  }

  /**
   * 界面删除一条启动项：**真的从项目的 `.dsh/run-deck/run.json` 的 `tasks[]` 里移除**，
   * 连带清掉 `buttons[]` 里指向它的声明、以及本机布局里对它的覆盖。
   *
   * 这是 `createTask` 的对称操作——两条路编辑的仍是同一个源文件，所以"界面删掉"
   * 和"手改删掉"完全等价（git diff 看得见）。只想把它从条上收起来的话是另一个
   * 动作（`setButtonOverride` 的 `pinned: false`），那份 task 仍然保留。
   */
  async deleteTask(
    projectRoot: string,
    entryId: string,
  ): Promise<ApiResult<{ entry: string; projectRoot: string }>> {
    const root = normalizeRoot(projectRoot);
    return this.withManifestLock(join(root, ...MANIFEST_RELATIVE_PATH), async () => {
      const project = this.projects.find((candidate) => samePath(candidate.root, root));
      if (project === undefined || project.configFile === undefined) {
        return failure(ERROR_CODES.notFound, '这个项目还没有可编辑的 .dsh/run-deck/run.json');
      }
      const manifestPath = project.configFile;

      let text: string;
      try {
        text = await readFile(manifestPath, 'utf8');
      } catch (error) {
        return failure(ERROR_CODES.fs, '读不了 .dsh/run-deck/run.json', String(error));
      }
      const removed = removeTaskFromManifestText(text, entryId);
      if (!removed.ok) return failure(ERROR_CODES.badRequest, removed.message);

      try {
        await this.writeManifestAtomically(manifestPath, removed.text);
      } catch (error) {
        return failure(ERROR_CODES.fs, '写不了 .dsh/run-deck/run.json', String(error));
      }

      // 本机布局里对它的覆盖也清掉，免得留一个指向已删条目的孤儿键。
      if (this.layout.buttons[entryId] !== undefined) {
        const buttons = { ...this.layout.buttons };
        delete buttons[entryId];
        const next: LocalLayout = { buttons, ...pickDensity(this.layout.density) };
        try {
          await writeLayout(this.layoutFile, next);
          this.layout = next;
          this.layoutMtimeMs = undefined;
        } catch (error) {
          this.recordWarning(`条目已删除，但清不掉本地布局里的覆盖：${String(error)}`);
        }
      }

      const { project: reloaded } = await loadProject(project.root);
      this.projects = [
        ...this.projects.filter((candidate) => !samePath(candidate.root, project.root)),
        reloaded,
      ];
      this.deps.log('info', `界面删除条目：${project.root} ← ${entryId}`);
      return { ok: true, entry: entryId, projectRoot: project.root };
    });
  }

  /** 写单个按钮的本地覆盖（顺序 / 显隐 / 图标 / 分组 / 标题）。 */
  async setButtonOverride(
    entry: string,
    override: ButtonOverride,
  ): Promise<ApiResult<{ entry: string }>> {
    const previous = this.layout.buttons[entry];
    const merged: ButtonOverride = { ...(previous ?? {}), ...override };
    const buttons: Record<string, ButtonOverride> = { ...this.layout.buttons, [entry]: merged };
    const next: LocalLayout = { buttons, ...pickDensity(this.layout.density) };
    try {
      await writeLayout(this.layoutFile, next);
      this.layout = next;
      // 自己刚写过：下次比对时强制重读一次（顺带校验落盘内容）。
      this.layoutMtimeMs = undefined;
      return { ok: true, entry };
    } catch (error) {
      return failure(ERROR_CODES.fs, '写不了本地覆盖文件', String(error));
    }
  }

  /** 整组重排：把给定顺序写成本地 order（拖拽排序的落点）。 */
  async reorderButtons(order: string[]): Promise<ApiResult<{ order: string[] }>> {
    const buttons: Record<string, ButtonOverride> = { ...this.layout.buttons };
    order.forEach((entry, index) => {
      // 只写这一个字段，不动用户已经调过的图标/分组/标题。
      buttons[entry] = { ...(buttons[entry] ?? {}), order: index };
    });
    const next: LocalLayout = { buttons, ...pickDensity(this.layout.density) };
    try {
      await writeLayout(this.layoutFile, next);
      this.layout = next;
      // 自己刚写过：下次比对时强制重读一次（顺带校验落盘内容）。
      this.layoutMtimeMs = undefined;
      return { ok: true, order };
    } catch (error) {
      return failure(ERROR_CODES.fs, '写不了本地覆盖文件', String(error));
    }
  }

  /** 设置按钮密度偏好（⚙ 里改，持久化到 layout.json）。 */
  async setDensity(density: ButtonDensity): Promise<ApiResult<{ density: ButtonDensity }>> {
    // 在这里也挡一次：调用方不止 HTTP 路由（命令、工具都可能进来）。
    if (density !== 'full' && density !== 'compact' && density !== 'icon') {
      return failure(ERROR_CODES.badRequest, 'density 只能是 full / compact / icon');
    }
    const next: LocalLayout = { buttons: { ...this.layout.buttons }, density };
    try {
      await writeLayout(this.layoutFile, next);
      this.layout = next;
      // 自己刚写过：下次比对时强制重读一次（顺带校验落盘内容）。
      this.layoutMtimeMs = undefined;
      return { ok: true, density };
    } catch (error) {
      return failure(ERROR_CODES.fs, '写不了本地覆盖文件', String(error));
    }
  }

  getLayout(): LocalLayout {
    return this.layout;
  }

  /* ─────────────────────────── 状态 ─────────────────────────── */

  capabilities(): RunDeckCapabilities {
    const subprocess = probeSubprocess(this.deps.ctx);
    const controller = this.deps.ctx.get<DshSessionControllerService>('sessionController');
    const openPath = this.deps.ctx.get<DshOpenPathService>('openPath');
    return {
      subprocess: subprocess.available,
      ...(subprocess.reason !== undefined ? { subprocessReason: subprocess.reason } : {}),
      webServer: this.deps.ctx.get<DshWebServerService>('webServer') !== undefined,
      commands: this.deps.ctx.get<DshCommandsService>('commands') !== undefined,
      settings: this.deps.ctx.get<DshConfigEditorService>('configEditor') !== undefined,
      canOpenPath:
        controller?.canOpenWorkspacePath?.() === true ||
        (openPath?.canOpenPath?.() ?? false),
    };
  }

  /**
   * 全量状态。
   *
   * @param cwd 客户端报上来的当前会话工作目录；缺省 = 没有焦点项目，
   *            `buttons` / `focusedEntries` 都为空（浮动层整条隐藏）。
   */
  state(cwd?: string): RunDeckState {
    const projects = this.listProjects();
    const focused = cwd === undefined ? null : this.focusProject(cwd);
    const projectRoot = focused?.projectRoot ?? null;
    const buttons = projectRoot === null ? [] : this.listButtons(projectRoot);
    return {
      ok: true,
      pluginVersion: this.deps.version,
      dataDir: this.deps.config().dataDir,
      configSource: this.deps.configSource(),
      projects,
      runs: this.listRuns(),
      buttons,
      focused,
      focusedEntries: this.focusedEntries(projectRoot),
      layout: { buttons: { ...this.layout.buttons }, ...pickDensity(this.layout.density) },
      warnings: this.getWarnings(),
      capabilities: this.capabilities(),
      now: Date.now(),
    };
  }

  /**
   * 让一个**磁盘上存在但没被扫到**的目录变成焦点项目。
   *
   * 这样"任意目录都能用"：不要求它先在 DSH 里被注册成工作区，也不要求重启。
   * 已加载过的直接复用；没加载过的现读一次并追加进 this.projects。
   */
  async focusCwd(cwd: string): Promise<ApiResult<{ focused: FocusedProject }>> {
    const trimmed = cwd.trim();
    if (trimmed.length === 0) {
      return failure(ERROR_CODES.badRequest, 'cwd 不能为空');
    }
    const project = await this.loadFocusedProject(trimmed);
    if (project === undefined) {
      return {
        ok: true,
        focused: {
          cwd: trimmed,
          projectRoot: null,
          reason: '这个目录不存在',
        },
      };
    }
    // 0 条目也**返回 projectRoot**：条要一直在，`+` 才有地方建第一条。
    return {
      ok: true,
      focused: {
        cwd: trimmed,
        projectRoot: project.root,
        ...(project.configFile !== undefined ? { configFile: project.configFile } : {}),
        ...(project.entries.length === 0
          ? {
              reason:
                project.configFile === undefined
                  ? '这个目录还没有 .dsh/run-deck/run.json'
                  : '这个目录下没有可用条目',
            }
          : {}),
      },
    };
  }
}
