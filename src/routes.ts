/**
 * dsh-run-deck — host ↔ client 的 HTTP 桥。
 *
 * 为什么用 HTTP 路由而不是 Remote 服务：与 dsh-temptask 同一套既有做法——
 * `ctx.webServer.register()` + 浏览器 `fetch()`。它只用公开 API，不需要 typert 生成物，
 * 也不会往全局注册任何新服务。
 *
 * 安全模型（逐条照抄 dsh-temptask/src/routes.ts，因为它是同一个问题的同一份答案）：
 *   - 只接受 loopback authority（127.0.0.1 / localhost / [::1]），或宿主 `connection`
 *     服务声明的 trustedHosts；
 *   - `sec-fetch-site: cross-site` 一律拒绝（防 DNS rebinding）；
 *   - 带 Origin 的请求必须与 Host 同源；
 *   - 变更类接口只接受 POST，且破坏性操作要求显式 confirm。
 *
 * 额外一条本插件特有的收紧：**没有任何接口接受自由命令**。
 * host half 真要 spawn 进程时绕过的是 agent 的 pwsh 沙箱，所以这里只接受
 * `{ projectRoot, entryId }` 这样的**指针**，命令本体永远来自项目里的 run.json。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { renderCommandLine } from './exec.js';
import type { RunDeckManager } from './manager.js';
import {
  ERROR_CODES,
  type ApiError,
  type ApiResult,
  type ButtonOverride,
  type NewTaskInput,
} from './types.js';

/** 路由前缀。 */
export const API_PREFIX = '/dsh-run-deck/api';

/** 请求体上限（这些接口的载荷都很小）。 */
const MAX_BODY_BYTES = 16 * 1024;

export interface RouteHost {
  manager: RunDeckManager;
  /** 启动流程完成前不处理请求。 */
  ready: Promise<void>;
  /** 宿主声明的额外可信 authority。 */
  trustedHosts(): string[];
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface RunDeckRoute {
  path: string;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

/* ─────────────────────────── HTTP 工具 ─────────────────────────── */

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * `/task` 请求体的**字段级**校验：只揪"给了但类型/取值不对"的键，没给的键不算——
 * 缺字段是业务校验（在 `newtask.ts` 里做，给的是"缺 label"那种业务话术），
 * 这里管的是 JSON 形状接错了契约：必须点名报错，不能静默当"没给"
 * （否则 `openUrl` 传字符串 `"true"` 会变成一条不打开的默认任务，调用方毫无感知）。
 * 没在清单里的多余字段仍然忽略（向后兼容，加新字段不破坏旧调用方）。
 */
interface FieldIssue {
  field: string;
  expected: string;
}

function collectFieldIssues(body: Record<string, unknown>): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const field of ['label', 'command', 'cwd', 'id', 'readyPattern', 'urlPattern', 'uriFormat', 'onReady']) {
    if (body[field] !== undefined && typeof body[field] !== 'string') {
      issues.push({ field, expected: '字符串' });
    }
  }
  for (const field of ['isBackground', 'openUrl']) {
    if (body[field] !== undefined && typeof body[field] !== 'boolean') {
      issues.push({ field, expected: '布尔（true / false）' });
    }
  }
  const envRaw = body['env'];
  if (envRaw !== undefined) {
    if (envRaw === null || typeof envRaw !== 'object' || Array.isArray(envRaw)) {
      issues.push({ field: 'env', expected: '对象（"KEY": "值"）' });
    } else {
      for (const [key, value] of Object.entries(envRaw as Record<string, unknown>)) {
        if (typeof value !== 'string') issues.push({ field: `env.${key}`, expected: '字符串' });
      }
    }
  }
  const group = body['group'];
  if (group !== undefined && group !== 'build' && group !== 'test' && group !== 'none') {
    issues.push({ field: 'group', expected: 'build / test / none 之一' });
  }
  const reveal = body['reveal'];
  if (reveal !== undefined && reveal !== 'always' && reveal !== 'silent' && reveal !== 'never') {
    issues.push({ field: 'reveal', expected: 'always / silent / never 之一' });
  }
  return issues;
}

/**
 * 把 `/task` 的请求体收成 `NewTaskInput`。
 *
 * 只挑**已知字段**；"给的值不对"已经在 `collectFieldIssues` 里点名报错，
 * 这里只负责收敛合法形状，不让多余字段混进去。注意仍然没有任何"自由命令"字段：
 * 写进清单的 `command` 由 `splitCommandLine` 拆一条人填的命令行得到。
 */
function newTaskInputFromBody(body: Record<string, unknown>): NewTaskInput {
  const envRaw = body['env'];
  const env: Record<string, string> = {};
  if (envRaw !== null && typeof envRaw === 'object' && !Array.isArray(envRaw)) {
    for (const [key, value] of Object.entries(envRaw as Record<string, unknown>)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  const group = body['group'];
  const reveal = body['reveal'];
  const cwd = asString(body['cwd']).trim();
  const id = asString(body['id']).trim();
  const readyPattern = asString(body['readyPattern']).trim();
  const urlPattern = asString(body['urlPattern']).trim();
  const uriFormat = asString(body['uriFormat']).trim();
  const onReady = asString(body['onReady']).trim();
  return {
    label: asString(body['label']),
    command: asString(body['command']),
    ...(cwd.length > 0 ? { cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(body['isBackground'] === true ? { isBackground: true } : {}),
    ...(group === 'build' || group === 'test' || group === 'none' ? { group } : {}),
    ...(id.length > 0 ? { id } : {}),
    ...(readyPattern.length > 0 ? { readyPattern } : {}),
    ...(body['openUrl'] === true ? { openUrl: true } : {}),
    ...(urlPattern.length > 0 ? { urlPattern } : {}),
    ...(uriFormat.length > 0 ? { uriFormat } : {}),
    ...(reveal === 'always' || reveal === 'silent' || reveal === 'never' ? { reveal } : {}),
    ...(onReady.length > 0 ? { onReady } : {}),
  };
}

/** 判断 Host 是否是 loopback authority。 */
function isLoopbackAuthority(host: string): boolean {
  const lower = host.toLowerCase();
  const name = lower.startsWith('[')
    ? lower.slice(0, lower.indexOf(']') + 1)
    : (lower.split(':')[0] ?? '');
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/** 请求是否可信（同源 + 非跨站 + loopback/已声明 authority）。 */
function isTrustedRequest(req: IncomingMessage, trustedHosts: string[]): boolean {
  const host = req.headers.host;
  if (typeof host === 'string' && host.length > 0) {
    const trusted =
      isLoopbackAuthority(host) ||
      trustedHosts.some((entry) => entry.toLowerCase() === host.toLowerCase());
    if (!trusted) return false;
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;

  const origin = req.headers.origin;
  // 浏览器一定会带 Origin；缺失说明请求不是页面发出的。
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function messageOfError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/* ─────────────────────────── 路由构造 ─────────────────────────── */

export function createRoutes(host: RouteHost): RunDeckRoute[] {
  const { manager } = host;

  /**
   * 统一的处理器包装：方法检查 + 同源检查 + 启动等待 + JSON 响应。
   */
  function route(
    path: string,
    method: 'GET' | 'POST',
    impl: (body: Record<string, unknown>, req: IncomingMessage) => Promise<unknown>,
  ): RunDeckRoute {
    return {
      path,
      async handle(req, res) {
        try {
          if ((req.method ?? 'GET').toUpperCase() !== method) {
            res.setHeader('allow', method);
            sendJson(res, 405, {
              ok: false,
              code: ERROR_CODES.badRequest,
              message: `本接口只接受 ${method}`,
            } satisfies ApiError);
            return;
          }
          if (!isTrustedRequest(req, host.trustedHosts())) {
            sendJson(res, 403, {
              ok: false,
              code: ERROR_CODES.badRequest,
              message: 'untrusted origin：请求来源不是本机回环或已声明的 authority',
            } satisfies ApiError);
            return;
          }

          const body = method === 'POST' ? asObject(await readJsonBody(req)) : {};
          await host.ready;
          const result = await impl(body, req);
          sendJson(res, 200, result);
        } catch (error) {
          host.log('warn', `${path} 处理失败：${messageOfError(error)}`);
          sendJson(res, 200, {
            ok: false,
            code: ERROR_CODES.badRequest,
            message: messageOfError(error),
          } satisfies ApiError);
        }
      },
    };
  }

  /** 取 query 参数。 */
  function queryParams(req: IncomingMessage): URLSearchParams {
    const url = req.url ?? '';
    const query = url.indexOf('?');
    return query < 0 ? new URLSearchParams() : new URLSearchParams(url.slice(query + 1));
  }

  /**
   * 解析这一次请求的"焦点项目根目录"。
   *
   * 两条路，按可靠性排序：
   *   1. `?cwd=`：客户端自己就知道会话的工作目录时直接给；
   *   2. `?sessionId=`：**主路径**——客户端 `sessions` 服务没有 get/list，
   *      浏览器侧拿不到 cwd，于是把插槽交给它的 sessionId 报上来，
   *      host 先用内存会话存储的 `session.header.cwd` 解析；那条会话只是
   *      "被查看"而没被激活时（重启后最常见）内存里没有它，就退到**会话目录**
   *      （见 `sessionCwdAsync`）。这一步是异步的，因为会话目录是异步服务。
   *
   * 解析出目录后**先现读一遍磁盘**：不要求它先被注册成工作区，也不要求启动时的
   * 扫描扫到它（启动那一刻 `workspaceRegistry` / `sessions` 可能都是空的）。
   */
  async function focusTargetFromQuery(req: IncomingMessage): Promise<string | null> {
    const params = queryParams(req);
    const rawCwd = (params.get('cwd') ?? '').trim();
    const cwd =
      rawCwd.length > 0
        ? rawCwd
        : await manager.sessionCwdAsync((params.get('sessionId') ?? '').trim());
    if (cwd === null || cwd.trim().length === 0) return null;
    await manager.ensureProject(cwd);
    return cwd;
  }

  /** 从 body 里取一条指针；缺任何一个都返回错误。 */
  function pointer(body: Record<string, unknown>): ApiResult<{ projectRoot: string; entryId: string }> {
    const projectRoot = asString(body.projectRoot).trim();
    const entryId = asString(body.entryId).trim();
    if (projectRoot.length === 0 || entryId.length === 0) {
      return {
        ok: false,
        code: ERROR_CODES.badRequest,
        message: '需要 projectRoot 与 entryId',
        hint: '命令本体来自 .dsh/run-deck/run.json，本接口不接受自由命令。',
      };
    }
    return { ok: true, projectRoot, entryId };
  }

  return [
    // 客户端半边的诊断上报：**只写日志**，用来回答"包到底被浏览器加载了没有、
    // 插槽到底渲染了没有"。之前这条链路完全没有观测点，只能靠猜。
    route(`${API_PREFIX}/ping`, 'POST', async (body) => {
      const stage = asString(body.stage).trim() || '(未命名)';
      const detail = body.detail === undefined ? '' : ` ${JSON.stringify(body.detail)}`;
      host.log('info', `client ping: ${stage}${detail}`);
      return { ok: true, stage, at: Date.now() };
    }),

    // 全量状态。`?cwd=` / `?sessionId=` 决定焦点项目；
    // 两者都没有 = 没有焦点项目（浮动层整条隐藏）。
    // 先对一次 `layout.json` 的 mtime：手改（或别的进程改）最迟在这一轮生效。
    route(`${API_PREFIX}/state`, 'GET', async (_body, req) => {
      await manager.syncLayoutFromDisk();
      return manager.state((await focusTargetFromQuery(req)) ?? undefined);
    }),

    // 重读磁盘上的清单（改了 .dsh/run-deck/run.json 之后不必重启 DSH）。
    route(`${API_PREFIX}/refresh`, 'POST', async () => {
      const projects = await manager.refresh();
      return { ok: true, projects };
    }),

    // 跑一条 run：**真的开一条 PTY 把命令跑起来**（见 src/exec.ts）。
    // body 里只有指针（projectRoot + entryId）+ 发起会话的 sessionId，
    // **没有任何字段能塞进一条命令**——这是安全边界，不是省略。
    route(`${API_PREFIX}/run`, 'POST', async (body) => {
      const target = pointer(body);
      if (!target.ok) return target;
      const sessionId = asString(body.sessionId).trim();
      return manager.startRun({
        projectRoot: target.projectRoot,
        entryId: target.entryId,
        ...(sessionId.length > 0 ? { sessionId } : {}),
      });
    }),

    route(`${API_PREFIX}/stop`, 'POST', async (body) => {
      const runId = asString(body.runId).trim();
      if (runId.length === 0) {
        return { ok: false, code: ERROR_CODES.badRequest, message: '缺少 runId' } satisfies ApiError;
      }
      return manager.stopRun(runId);
    }),

    route(`${API_PREFIX}/rerun`, 'POST', async (body) => {
      const runId = asString(body.runId).trim();
      if (runId.length === 0) {
        return { ok: false, code: ERROR_CODES.badRequest, message: '缺少 runId' } satisfies ApiError;
      }
      return manager.rerun(runId);
    }),

    // 一行输出进来后推进钩子状态。返回**动作清单**（该打开哪个 URL、该接哪个 entry），
    // host 不在这里执行它们——打开浏览器、拉起另一个 run 都需要调用方自己的权限。
    // 本版 host 侧拿不到终端的 stdout，所以这个接口是给将来的流的 reader 用的；
    // 语义层本身已经有完整测试覆盖。
    route(`${API_PREFIX}/observe`, 'POST', async (body) => {
      const runId = asString(body.runId).trim();
      const line = asString(body.line);
      if (runId.length === 0) {
        return { ok: false, code: ERROR_CODES.badRequest, message: '缺少 runId' } satisfies ApiError;
      }
      return manager.observe(runId, line);
    }),

    // 一条 entry 的详情：声明 + host 侧算出的命令行。
    // 存在的理由是让面板能说清"点了会跑什么"，而不是让用户点一个黑箱。
    route(`${API_PREFIX}/entry`, 'POST', async (body) => {
      const target = pointer(body);
      if (!target.ok) return target;
      const entry = manager.findEntry(target.projectRoot, target.entryId);
      if (entry === undefined) {
        return {
          ok: false,
          code: ERROR_CODES.notFound,
          message: '找不到这个条目',
          hint: `${target.projectRoot} 里没有 id 为 ${target.entryId} 的 task`,
        } satisfies ApiError;
      }
      return { ok: true, entry, commandLine: renderCommandLine(entry) };
    }),

    // 浮动按钮的本地覆盖（布局类，不进仓库）。
    // 只接受布局字段：entry / icon / group / label / order / pinned。
    // 没有命令、没有 cwd、没有 args——本地覆盖不能变成第二条执行通路。
    route(`${API_PREFIX}/button`, 'POST', async (body) => {
      const entry = asString(body.entry).trim();
      if (entry.length === 0) {
        return { ok: false, code: ERROR_CODES.badRequest, message: '缺少 entry id' } satisfies ApiError;
      }
      const override: ButtonOverride = {
        // ⚠️ 这里必须认 `false`。早先写的是 `...(asBoolean(body.pinned) ? {...} : {})`，
        // 于是 `pinned: false`（界面上的「从按钮条收起」）和"根本没给这个字段"长得
        // 一模一样，被整段丢掉——收起成了空操作，用户因此永远看不到能重新钉上来的
        // 条目，看起来就像"添加按钮这个功能没做"。
        ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
        ...(typeof body.order === 'number' && Number.isFinite(body.order)
          ? { order: body.order }
          : {}),
        ...(asString(body.group).length > 0 ? { group: asString(body.group) } : {}),
        ...(asString(body.label).length > 0 ? { label: asString(body.label) } : {}),
        ...(asString(body.icon).length > 0 ? { icon: asString(body.icon) } : {}),
      };
      return manager.setButtonOverride(entry, override);
    }),

    // 界面新建启动项：**真的写进项目的 .dsh/run-deck/run.json 的 tasks[]**。
    //
    // 这和"本地覆盖不能存命令"并不冲突——两者编辑的不是同一件东西：
    //   - `layout.json` 回答"我怎么看这个项目"，永远只影响展示；
    //   - `run.json` 回答"这个项目有哪些启动项"，界面这里写的就是它本身。
    // 手改和界面改写同一个文件，所以只有一条执行通路，但两条编辑通路都在。
    route(`${API_PREFIX}/task`, 'POST', async (body) => {
      const projectRoot = asString(body.projectRoot).trim();
      if (projectRoot.length === 0) {
        return {
          ok: false,
          code: ERROR_CODES.badRequest,
          message: '缺少 projectRoot',
        } satisfies ApiError;
      }
      const issues = collectFieldIssues(body);
      if (issues.length > 0) {
        return {
          ok: false,
          code: ERROR_CODES.badRequest,
          message: `字段类型/取值不对：${issues.map((issue) => `${issue.field}（需 ${issue.expected}）`).join('；')}`,
        } satisfies ApiError;
      }
      return manager.createTask(projectRoot, newTaskInputFromBody(body));
    }),

    // 界面编辑启动项：原位替换项目 run.json 里那条 task（字段校验与新建同一份，
    // 只是"自己占着自己的 id"不再算冲突）。只想改钉/序/图标的话走 /button——
    // 那是本机 layout.json 的事，不进仓库。
    route(`${API_PREFIX}/task/update`, 'POST', async (body) => {
      const projectRoot = asString(body.projectRoot).trim();
      const entryId = asString(body.entryId).trim();
      if (projectRoot.length === 0 || entryId.length === 0) {
        return {
          ok: false,
          code: ERROR_CODES.badRequest,
          message: '需要 projectRoot 与 entryId',
        } satisfies ApiError;
      }
      const issues = collectFieldIssues(body);
      if (issues.length > 0) {
        return {
          ok: false,
          code: ERROR_CODES.badRequest,
          message: `字段类型/取值不对：${issues.map((issue) => `${issue.field}（需 ${issue.expected}）`).join('；')}`,
        } satisfies ApiError;
      }
      return manager.updateTask(projectRoot, entryId, newTaskInputFromBody(body));
    }),

    // 「+」面板的候选检测：读这个项目的 package.json scripts。
    // 只读、不落盘、不执行——结果只用来预填表单（"检测"与"创建"是两件事）。
    route(`${API_PREFIX}/detect`, 'POST', async (body) => {
      const projectRoot = asString(body.projectRoot).trim();
      if (projectRoot.length === 0) {
        return {
          ok: false,
          code: ERROR_CODES.badRequest,
          message: '缺少 projectRoot',
        } satisfies ApiError;
      }
      return manager.detectTasks(projectRoot);
    }),

    // 界面删除启动项：真的从项目的 .dsh/run-deck/run.json 的 tasks[] 里移除（连带 buttons[]）。
    // 只想从条上收起来的话走 /button 的 `pinned: false`——那条 task 仍然保留。
    route(`${API_PREFIX}/task/remove`, 'POST', async (body) => {
      const projectRoot = asString(body.projectRoot).trim();
      const entryId = asString(body.entryId).trim();
      if (projectRoot.length === 0 || entryId.length === 0) {
        return {
          ok: false,
          code: ERROR_CODES.badRequest,
          message: '需要 projectRoot 与 entryId',
        } satisfies ApiError;
      }
      return manager.deleteTask(projectRoot, entryId);
    }),

    // 让一个磁盘上存在但没被扫到的目录成为焦点项目（"任意目录都能用"）。
    // 接受 cwd，也接受 sessionId（由 host 的会话存储/会话目录解析出 cwd）。
    route(`${API_PREFIX}/focus`, 'POST', async (body) => {
      const rawCwd = asString(body.cwd).trim();
      const cwd =
        (rawCwd.length > 0
          ? rawCwd
          : await manager.sessionCwdAsync(asString(body.sessionId).trim())) ?? '';
      if (cwd.length === 0) {
        return {
          ok: false,
          code: ERROR_CODES.badRequest,
          message: '缺少 cwd（或能解析出 cwd 的 sessionId）',
        } satisfies ApiError;
      }
      return manager.focusCwd(cwd);
    }),

    // 拖拽排序：整组顺序写进本地覆盖。只接受 id 数组，不接受命令。
    route(`${API_PREFIX}/reorder`, 'POST', async (body) => {
      const order = Array.isArray(body.order)
        ? body.order.filter((value): value is string => typeof value === 'string' && value.length > 0)
        : [];
      if (order.length === 0) {
        return { ok: false, code: ERROR_CODES.badRequest, message: '缺少 order（entry id 数组）' } satisfies ApiError;
      }
      return manager.reorderButtons(order);
    }),

    // 按钮密度偏好（full / compact / icon），持久化到 layout.json。
    route(`${API_PREFIX}/density`, 'POST', async (body) => {
      const density = asString(body.density).trim();
      if (density !== 'full' && density !== 'compact' && density !== 'icon') {
        return {
          ok: false,
          code: ERROR_CODES.badRequest,
          message: 'density 只能是 full / compact / icon',
        } satisfies ApiError;
      }
      return manager.setDensity(density);
    }),
  ];
}
