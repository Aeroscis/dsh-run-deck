/**
 * dsh-rundeck — 事件钩子：第 3 步。
 *
 * 三个钩子，全部照 VS Code 的语义：
 *   - `problemMatcher.background`：beginsPattern / endsPattern，就绪判定
 *   - `serverReadyAction`：就绪后做什么（只实现 openExternally）
 *   - `onReady`：本插件的增量，补 VS Code issue #69311——serverReadyAction 只能
 *     openExternally，表达不了"就绪后再接另一个 entry"。只接受 entry id。
 *
 * ## 输出从哪来（这一版的真实限制）
 *
 * 端到端读终端的输出需要 Agent owner（`ctx.terminals` 的每个操作都要求它），
 * 而插件自己不是 Agent。第 1 步的结论把执行定在终端路线上，于是 host 侧
 * **拿不到这条进程的 stdout**。
 *
 * 所以本文件做的是**钩子的语义层**，它完整、可测、且与第 3 步之后的接线无关：
 *   - `ReadyWatcher` 把"一行输出进来 → 状态怎么变"这条链路做实
 *     （beginsPattern 才开始匹配、endsPattern 命中即 ready、失败 pattern 降级）
 *   - `serverReadyAction` 的展开（uriFormat 把 URL 填进模板）与"该打开哪个 URL"
 *   - `onReady` 的解析与环检测（只接受 entry id，不接受命令）
 *
 * 剩下唯一没接线的是"这些行从哪个流进来"。它需要一个 Agent owner 的终端会话，
 * 而那是本插件**不该**自己造的（见 exec.ts 的边界说明）。接线时只要把
 * `watcher.push(line)` 挂到那条流的 reader 上即可，语义层不用改。
 *
 * 这不是把第 3 步拆成两半糊过去：把语义做全是第 3 步的主体，
 * 而"流从哪来"是第 1 步路线选择的已知代价，已被明确记录。
 */
import { ERROR_CODES, type ApiError, type ResolvedEntry } from './types.js';
import { matchReady, type ReadyMatch } from './exec.js';

export { matchReady } from './exec.js';

/** `serverReadyAction` 展开后的结果。 */
export interface ServerReadyTarget {
  action: 'openExternally';
  /** 最终要打开的地址（uriFormat 把 pattern 的第 1 组填进来）。 */
  uri: string;
  /** 就绪 pattern 的第 1 组原文。 */
  captured: string;
}

/**
 * 展开 `serverReadyAction`。
 *
 * VS Code 的语义：`pattern` 的第 1 组（通常是 URL）替换 `uriFormat` 里的 `%s`。
 * `uriFormat` 缺省时就是 `%s`（原样打开抓到的地址）。
 */
export function resolveServerReady(
  action: { pattern: string; uriFormat?: string } | undefined,
  captured: string,
): ServerReadyTarget | undefined {
  if (action === undefined) return undefined;
  const template = action.uriFormat ?? '%s';
  let uri: string;
  try {
    uri = template.replaceAll('%s', captured);
  } catch {
    uri = captured;
  }
  return { action: 'openExternally', uri: uri.length > 0 ? uri : captured, captured };
}

/**
 * `onReady` 的目标：必须是同一个项目里的 entry id。
 *
 * 只接受 id 不接受命令——否则它会变成第二条执行通路，与
 * "命令必须是 run.json 里的字面量"冲突。
 */
export function resolveOnReady(
  onReady: string | undefined,
  entries: ResolvedEntry[],
): { ok: true; entry: ResolvedEntry } | { ok: false; reason: string } {
  if (onReady === undefined || onReady.length === 0) return { ok: false, reason: '没有 onReady' };
  const trimmed = onReady.trim();
  // 一眼就能认出"这不是 id"的形态：带空白、带 shell 元字符、带路径分隔的绝对/相对路径。
  if (/\s/u.test(trimmed)) {
    return { ok: false, reason: `onReady 不接受命令，只能是 entry id（收到：${onReady}）` };
  }
  if (/[&|;<>`$(){}*?[\]!'"]/u.test(trimmed)) {
    return { ok: false, reason: `onReady 不接受命令，只能是 entry id（收到：${onReady}）` };
  }
  const target = entries.find((entry) => entry.id === trimmed);
  if (target === undefined) {
    // 这里**不**回落按 label 找：label 可重名，用它当接口正是要避免的事。
    return {
      ok: false,
      reason: `onReady 指向不存在的 entry id：${trimmed}（可用 id：${entries.map((entry) => entry.id).join(', ')}）`,
    };
  }
  return { ok: true, entry: target };
}

/** 环检测：A.onReady=B、B.onReady=A 会让两个 run 互相拉起，永不停止。 */
export function wouldCycle(
  startId: string,
  targetId: string,
  entries: ResolvedEntry[],
  limit = 32,
): boolean {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>([startId]);
  let current = byId.get(targetId);
  let hops = 0;
  while (current !== undefined && hops < limit) {
    if (seen.has(current.id)) return true;
    seen.add(current.id);
    const next = current.onReady === undefined ? undefined : byId.get(current.onReady.trim());
    if (next === undefined || next.id === current.id) return false;
    current = next;
    hops += 1;
  }
  return hops >= limit;
}

/** 一条 run 的钩子状态。从零搭好，逐行推进。 */
export interface HookState {
  /** beginsPattern 是否已出现过（VS Code 的 background.activeOnStart 让它在进程一起来就为真）。 */
  began: boolean;
  ready: boolean;
  url?: string;
  /** serverReadyAction 是否已经执行过（一次就够，不重复打开浏览器）。 */
  opened: boolean;
  /** onReady 是否已经触发过。 */
  chained: boolean;
}

export function initialHookState(activeOnStart: boolean | undefined): HookState {
  return { began: activeOnStart === true, ready: false, opened: false, chained: false };
}

/** 一行输出进来之后，host 该做什么。 */
export interface HookOutcome {
  /** 推进后的钩子状态。 */
  state: HookState;
  /** 就绪 pattern 命中（本行是"就绪"这一行）。 */
  becameReady: boolean;
  /** 该打开一个地址（serverReadyAction，且尚未执行过）。 */
  open?: ServerReadyTarget;
  /** 该接另一个 entry（onReady，且尚未触发过）。 */
  chainTo?: ResolvedEntry;
  /** 这一行被 beginsPattern/endsPattern 拒了，记一条说明（不致命）。 */
  note?: string;
}

/**
 * 就绪判定的完整链路。
 *
 * 与端口探测的分工（需求里定死的）：**pattern 为主，端口只做兜底**。
 * 光探端口区分不了"我们起来了"和"端口被别的进程占了"，会给出假绿点。
 */
export function observeLine(
  state: HookState,
  entry: ResolvedEntry,
  line: string,
  entries: ResolvedEntry[],
): HookOutcome {
  // 没有 background 段的条目不走这套（VS Code 也是这样：没有 problemMatcher 就永远是"在跑"）
  const background = entry.problemMatcher?.background;
  if (background === undefined) {
    return { state, becameReady: false, note: '这条没有 problemMatcher.background' };
  }

  let next: HookState = { ...state };
  let note: string | undefined;

  // beginsPattern：从那之后才开始认 endsPattern。没配 beginsPattern 时一直认。
  if (!next.began) {
    const begins = compilePattern(background.beginsPattern);
    if (begins === undefined) {
      // pattern 编译失败：无法判断"开始了没有"。宁可从**这一行起**就认 endsPattern，
      // 否则永远不 ready——一个坏 pattern 不该让整条 run 的钩子失效。
      // 注意这里不能直接 return：同一个 line 还要继续走 endsPattern。
      next = { ...next, began: true };
      note = `beginsPattern 无法编译：${String(background.beginsPattern)}`;
    } else if (begins.test(line)) {
      return { state: { ...next, began: true }, becameReady: false, note: 'beginsPattern 命中' };
    } else {
      // 还没开始：这一行与就绪无关
      return { state: next, becameReady: false };
    }
  }

  if (next.ready) {
    // 已就绪：endsPattern 不再重复触发（否则每次打印 ready 都会再开一次浏览器）
    return { state: next, becameReady: false };
  }

  const match: ReadyMatch = matchReady(background, line);
  if (!match.ready) {
    // 没就绪：beginsPattern 编译失败的说明仍然要带出去（调用方会记一条告警）
    return { state: next, becameReady: false, ...(note !== undefined ? { note } : {}) };
  }

  next = {
    ...next,
    ready: true,
    ...(match.url !== undefined ? { url: match.url } : {}),
  };

  const outcome: HookOutcome = {
    state: next,
    becameReady: true,
    ...(note !== undefined ? { note } : {}),
  };

  // serverReadyAction：只执行一次。
  if (!next.opened && entry.serverReadyAction !== undefined) {
    const target = resolveServerReady(entry.serverReadyAction, match.url ?? match.captured ?? '');
    if (target !== undefined && target.uri.length > 0) {
      next = { ...next, opened: true };
      outcome.state = next;
      outcome.open = target;
    }
  }

  // onReady：只触发一次，且必须先通过 id 校验与环检测。
  if (!next.chained && entry.onReady !== undefined) {
    const resolved = resolveOnReady(entry.onReady, entries);
    if (!resolved.ok) {
      outcome.note = note !== undefined ? `${note}；${resolved.reason}` : resolved.reason;
      // 解析失败也让这一条停在这里，不重试（否则每行输出都会再报一次）
      next = { ...next, chained: true };
      outcome.state = next;
      return outcome;
    }
    if (wouldCycle(entry.id, resolved.entry.id, entries)) {
      const cycle = `onReady 成环，已跳过：${entry.id} → ${resolved.entry.id}`;
      outcome.note = note !== undefined ? `${note}；${cycle}` : cycle;
      next = { ...next, chained: true };
      outcome.state = next;
      return outcome;
    }
    next = { ...next, chained: true };
    outcome.state = next;
    outcome.chainTo = resolved.entry;
  }

  return outcome;
}

/** 编译一条 pattern；编译失败返回 undefined（调用方按"不匹配/从下一行起都认"处理）。 */
function compilePattern(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined || pattern.length === 0) return undefined;
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return undefined;
  }
}

/** 统一的错误出口（钩子里的失败不该让整个 run 崩掉）。 */
export function hookFailure(message: string, hint?: string): ApiError {
  const error: ApiError = { ok: false, code: ERROR_CODES.badRequest, message };
  if (hint !== undefined) error.hint = hint;
  return error;
}
