/**
 * dsh-run-deck — 第 4 步：外部按 id 调用。
 *
 * 需求原文："外部按 id 调用（slash command 或 tool）加快捷键"。
 * 两件都做，但它们调的是**同一个** manager 方法——不存在两套逻辑
 * （官方插件开发参考 user-actions.md 的要求）。
 *
 * ## 为什么 tool 是第 4 步的主体
 *
 * slash command 已经在第 2 步做掉了（`/run-deck run <id>`）。这一步补的是
 * **agent 侧**：让模型能按 id 把一个条目跑起来，以及**停下来**。
 *
 * 安全边界与 HTTP 路由完全一致：
 *   - 参数只有 `entry_id`（和可选的 `project_root` 命中的那一条），**不接受命令**
 *   - `stop` / `rerun` 用 `run_id`，那是 host 自己发的，不是外部输入
 *
 * `@deepseek-ai/dsh-tools` 是**动态 import**（可选依赖）：
 * 宿主没装它（或装的是没有 defineTool 的旧版）时，插件照常加载，
 * 只是少一个入口——与 commands / webServer 的处理方式一致。
 */
import { renderCommandLine } from './exec.js';
import { messageOf } from './sessions.js';
import type { RunDeckManager } from './manager.js';
import type { NewTaskInput } from './types.js';

/** `@deepseek-ai/dsh-tools` 导出的 defineTool（动态 import，缺失即降级）。 */
type DshDefineTool = (definition: DshToolDefinition) => unknown;

/** tool 名（模型看到的就是这个）。 */
export const TOOL_NAME = 'run-deck';

/** 工具描述：说清"它只跑 run.json 里声明过的东西"、以及条目怎么来（可建可手改）。 */
const TOOL_DESCRIPTION = [
  'Run a configured entry from a project’s .dsh/run-deck/run.json (VS Code tasks.json vocabulary).',
  'The entry must already exist in that manifest: this tool never accepts a free-form command.',
  'Use it to start, stop, or rerun a declared launcher — for example a dev server or build script.',
  'When the user asks to add a launch button for this workspace (e.g. "帮我加一个跑 dev server 的按钮"),',
  'use action=create with label + command (one line, e.g. "npm run dev"); it validates, writes the entry',
  'into that project’s .dsh/run-deck/run.json and the button appears on the floating bar within ~3s.',
  'Editing that manifest by hand is equally valid — buttons appear automatically.',
  'Call /run-deck list first when you do not know the entry id.',
].join(' ');

/** 工具的参数 schema（JSON Schema 子集，与 dsh-tool-* 的写法一致）。 */
const PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    enum: ['run', 'stop', 'rerun', 'create'],
    description: 'Which action to take on the entry or the run.',
  },
  entry_id: {
    type: 'string',
    description: 'Entry id from the manifest (e.g. "jin/web"). Required for action=run.',
  },
  input_values: {
    type: 'object',
    description:
      'Values for ${input:id} variables the entry references (action=run). Keys are input ids, e.g. {"mode":"web"}. '
      + 'Omit to use manifest defaults; an entry referencing an input without a default fails without these values.',
  },
  run_id: {
    type: 'string',
    description: 'Run id returned by a previous action. Required for action=stop and action=rerun.',
  },
  project_root: {
    type: 'string',
    description: 'Project root for action=create. Defaults to the calling agent session’s cwd.',
  },
  label: {
    type: 'string',
    description: 'Human-readable name for the new entry. Required for action=create.',
  },
  command: {
    type: 'string',
    description:
      'One command line for the new entry, e.g. "npm run dev". Required for action=create.',
  },
  is_background: {
    type: 'boolean',
    description:
      'Mark the new entry long-running (server that stays up). Only for action=create.',
  },
  ready_pattern: {
    type: 'string',
    description:
      'Regex source (no surrounding slashes); a match marks the run ready, e.g. "(https?://\\S+)". Optional.',
  },
} as const;

/** 工具返回体的 schema。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    entry_id: { type: 'string' },
    label: { type: 'string' },
    run_id: { type: 'string' },
    status: { type: 'string' },
    command_line: { type: 'string' },
    cwd: { type: 'string' },
    message: { type: 'string' },
  },
} as const;

export interface ToolRegistration {
  /** 注册成功返回 true；宿主没有 dsh-tools 时为 false（插件照常加载）。 */
  mounted: boolean;
  reason?: string;
}

/** 把一个可能失败的调用结果摊平成工具返回体。 */
function flatten(input: {
  ok: boolean;
  entry_id?: string;
  label?: string;
  run_id?: string;
  status?: string;
  message?: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { ok: input.ok };
  if (input.entry_id !== undefined) out.entry_id = input.entry_id;
  if (input.label !== undefined) out.label = input.label;
  if (input.run_id !== undefined) out.run_id = input.run_id;
  if (input.status !== undefined) out.status = input.status;
  if (input.message !== undefined) out.message = input.message;
  return out;
}

/**
 * `action=create` 的宿主面实现：manager.createTask → 钉到按钮条。
 *
 * 单独导出是为了可测：注册过程要 `ctx.tools` + 动态 import，离线跑不了；
 * 而"返回体字段名、钉条失败怎么报"正是容易悄悄写错的地方（实测写错过一次：
 * manager 返回的是 `entry`，不是 `entryId`，类型上可选所以编译不报）。
 */
export async function createToolEntry(
  manager: Pick<RunDeckManager, 'createTask' | 'setButtonOverride'>,
  projectRoot: string,
  input: NewTaskInput,
): Promise<{ ok: boolean; message?: string; entryId?: string }> {
  const created = await manager.createTask(projectRoot, input);
  if (!created.ok) return created;
  const entryId = created.entry;
  if (typeof entryId !== 'string' || entryId.length === 0) {
    return { ok: false, message: '条目已写入清单，但没拿到它的 id（请用 /run-deck list 确认）' };
  }
  // 与「+」面板一致：建完顺手钉到按钮条（写本机 layout.json）。
  // 钉条失败不推翻"条目已建成"——条目是 run.json 里的真东西，外观才是本机的。
  const pinned = await manager.setButtonOverride(entryId, { pinned: true });
  return {
    ok: true,
    entryId,
    ...(pinned.ok ? {} : { message: `条目已建成，但钉到按钮条失败：${pinned.message}` }),
  };
}

/** 工具参数里 input_values 的收敛：只留字符串值（空串不算"给了"）。 */
function asInputValues(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' && item.length > 0) out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 工具参数 → manager 调用。
 *
 * 抽成独立函数是为了可测：注册过程要 `ctx.tools` + 动态 import，离线跑不了；
 * 而"给了什么参数、映射到哪个调用、拒绝什么"正是安全边界所在，必须自己可验证
 * （沙箱里管道 stdio 会失败，起不了宿主）。
 *
 * 约束与 HTTP 路由一致：**run/stop/rerun 只接受 id，不接受命令**。
 * `create` 是另一个动作：它写一条**新**条目进清单（与「+」面板同一条链路，
 * 校验、落盘、写的是哪个文件全在 manager 里），不是"按名字执行自由命令"的口子——
 * 所以它的 host 面是可选的：宿主面没提供 create（老版本测试替身）时明确报错，
 * 绝不悄悄降级成别的动作。
 */
export async function dispatchToolArgs(
  args: Record<string, unknown>,
  host: {
    listEntries(): Array<{ projectRoot: string; entryId: string }>;
    run(
      projectRoot: string,
      entryId: string,
      inputValues?: Record<string, string>,
    ): Promise<{ ok: boolean; message?: string; runId?: string; label?: string; status?: string }>;
    stop(runId: string): Promise<{ ok: boolean; message?: string; runId?: string; label?: string; status?: string; entryId?: string }>;
    rerun(runId: string): Promise<{ ok: boolean; message?: string; runId?: string; label?: string; status?: string; entryId?: string }>;
    /** 「+」面板同款新建（可选：不提供就拒绝 action=create）。 */
    create?(projectRoot: string, input: NewTaskInput): Promise<{ ok: boolean; message?: string; hint?: string; entryId?: string }>;
    /** 当前调用会话的 cwd（action=create 缺 project_root 时的落点；可选）。 */
    sessionCwd?(): string | undefined;
  },
): Promise<Record<string, unknown>> {
  const action = typeof args['action'] === 'string' ? args['action'].trim() : '';
  if (action === 'create') {
    if (host.create === undefined) {
      return flatten({ ok: false, message: '这个入口不支持 create' });
    }
    const label = typeof args['label'] === 'string' ? args['label'].trim() : '';
    const command = typeof args['command'] === 'string' ? args['command'].trim() : '';
    const missing: string[] = [];
    if (label.length === 0) missing.push('label');
    if (command.length === 0) missing.push('command');
    if (missing.length > 0) {
      return flatten({ ok: false, message: `action=create 需要 ${missing.join(' 和 ')}` });
    }
    let projectRoot =
      typeof args['project_root'] === 'string' ? args['project_root'].trim() : '';
    if (projectRoot.length === 0) projectRoot = host.sessionCwd?.() ?? '';
    if (projectRoot.length === 0) {
      return flatten({
        ok: false,
        message: 'action=create 需要 project_root（或一个能解析出 cwd 的调用会话）',
      });
    }
    const input: NewTaskInput = {
      label,
      command,
      ...(args['is_background'] === true ? { isBackground: true } : {}),
      ...(typeof args['ready_pattern'] === 'string' && args['ready_pattern'].trim().length > 0
        ? { readyPattern: args['ready_pattern'].trim() }
        : {}),
    };
    const result = await host.create(projectRoot, input);
    if (!result.ok) {
      return flatten({
        ok: false,
        message: result.hint !== undefined ? `${result.message}（${result.hint}）` : result.message,
      });
    }
    return flatten({
      ok: true,
      entry_id: result.entryId,
      label,
      // 宿主面可能在"条目已建成但钉条失败"时带回自己的说明，优先用它。
      message:
        result.message ??
        `已写进 ${projectRoot} 的 .dsh/run-deck/run.json，按钮条最多 3 秒内出现`,
    });
  }

  if (action === 'run') {
    const entryId = typeof args['entry_id'] === 'string' ? args['entry_id'].trim() : '';
    if (entryId.length === 0) {
      return flatten({ ok: false, message: 'action=run 需要 entry_id（用 /run-deck list 看有哪些 id）' });
    }
    // 按 id 精确定位：不按 label 找（label 可重名，不能当接口）。
    const found = host.listEntries().find((candidate) => candidate.entryId === entryId);
    if (found === undefined) {
      return flatten({ ok: false, entry_id: entryId, message: `找不到 id 为 ${entryId} 的条目` });
    }
    const result = await host.run(found.projectRoot, found.entryId, asInputValues(args['input_values']));
    if (!result.ok) return flatten({ ok: false, entry_id: entryId, message: result.message });
    return flatten({
      ok: true,
      entry_id: found.entryId,
      ...(result.label !== undefined ? { label: result.label } : {}),
      ...(result.runId !== undefined ? { run_id: result.runId } : {}),
      ...(result.status !== undefined ? { status: result.status } : {}),
    });
  }

  if (action === 'stop' || action === 'rerun') {
    const runId = typeof args['run_id'] === 'string' ? args['run_id'].trim() : '';
    if (runId.length === 0) {
      return flatten({
        ok: false,
        message: `action=${action} 需要 run_id（上一次 run 的返回值里有）`,
      });
    }
    const result = action === 'stop' ? await host.stop(runId) : await host.rerun(runId);
    if (!result.ok) return flatten({ ok: false, run_id: runId, message: result.message });
    return flatten({
      ok: true,
      ...(result.entryId !== undefined ? { entry_id: result.entryId } : {}),
      ...(result.label !== undefined ? { label: result.label } : {}),
      ...(result.runId !== undefined ? { run_id: result.runId } : {}),
      ...(result.status !== undefined ? { status: result.status } : {}),
    });
  }

  if (action.length === 0) {
    return flatten({ ok: false, message: '缺少 action（可用 run / stop / rerun / create）' });
  }
  return flatten({ ok: false, message: `未知 action：${action}（可用 run / stop / rerun / create）` });
}

/** 供 `dispatchToolArgs` 用的最小 manager 面（也便于测试替身）。 */
export interface RunDeckToolHost {
  listEntries(): Array<{ projectRoot: string; entryId: string }>;
  run(
    projectRoot: string,
    entryId: string,
    inputValues?: Record<string, string>,
  ): Promise<{ ok: boolean; message?: string; runId?: string; label?: string; status?: string }>;
  stop(runId: string): Promise<{ ok: boolean; message?: string; runId?: string; label?: string; status?: string; entryId?: string }>;
  rerun(runId: string): Promise<{ ok: boolean; message?: string; runId?: string; label?: string; status?: string; entryId?: string }>;
  /** 「+」面板同款新建（可选：不提供就拒绝 action=create）。 */
  create?(projectRoot: string, input: NewTaskInput): Promise<{ ok: boolean; message?: string; hint?: string; entryId?: string }>;
  /** 当前调用会话的 cwd（action=create 缺 project_root 时的落点；可选）。 */
  sessionCwd?(): string | undefined;
}

/**
 * 注册 `run-deck` 工具。
 *
 * @param ctx host Cordis 上下文
 * @param manager 业务核心（与 HTTP 路由、slash command 共用同一个）
 * @param ready 插件启动完成后才处理调用
 */
export async function registerRunDeckTool(
  ctx: DshContext,
  manager: RunDeckManager,
  ready: Promise<void>,
  log: (level: 'info' | 'warn', message: string) => void,
): Promise<ToolRegistration> {
  const tools = ctx.get<DshToolsService>('tools');
  if (tools === undefined || typeof tools.register !== 'function') {
    return { mounted: false, reason: '宿主没有提供 tools 服务' };
  }

  // defineTool 是可选的：动态 import，失败就少一个入口。
  let defineTool: DshDefineTool | undefined;
  try {
    const module = (await import('@deepseek-ai/dsh-tools')) as { defineTool?: DshDefineTool };
    defineTool = module.defineTool;
  } catch (error) {
    return { mounted: false, reason: `拿不到 @deepseek-ai/dsh-tools：${messageOf(error)}` };
  }
  if (defineTool === undefined) {
    return { mounted: false, reason: '@deepseek-ai/dsh-tools 没有导出 defineTool' };
  }

  /** manager → 工具参数分发的最小面。 */
  const host: RunDeckToolHost = {
    listEntries: () =>
      manager.listProjects().flatMap((project) =>
        project.entries.map((entry) => ({ projectRoot: project.root, entryId: entry.id })),
      ),
    run: (projectRoot, entryId, inputValues) =>
      manager.startRun({
        projectRoot,
        entryId,
        ...(inputValues !== undefined ? { inputValues } : {}),
      }),
    stop: (runId) => manager.stopRun(runId),
    rerun: (runId) => manager.rerun(runId),
    create: (projectRoot, input) => createToolEntry(manager, projectRoot, input),
  };

  /** 工具描述里要带的条目清单（模型先看这里就知道有哪些 id）。 */
  const entryList = (): string => {
    const lines: string[] = [];
    for (const project of manager.listProjects()) {
      if (project.entries.length === 0) continue;
      lines.push(`${project.name} (${project.root}):`);
      for (const entry of project.entries) lines.push(`  - ${entry.id}: ${entry.label}`);
    }
    return lines.length > 0 ? `\n\nDeclared entries:\n${lines.join('\n')}` : '';
  };

  const tool = defineTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION + entryList(),
    parameters: PARAMETERS as unknown as Record<string, unknown>,
    output: {
      schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok
            ? `${value.label ?? value.entry_id ?? 'run'} [${value.status ?? 'running'}]${value.command_line !== undefined ? `\n${value.command_line}` : ''}`
            : `❌ ${value.message ?? '失败'}`,
        },
      ],
    },
    async execute(args: Record<string, unknown>, exec?: DshToolExecContext) {
      await ready;
      // 每次调用都重读磁盘：另一个 profile / 用户刚编辑了 run.json 也要看得见。
      await manager.refresh();
      // owner = **调用这个工具的 Agent**：终端归发起它的会话（见 exec.ts 的 owner 说明）。
      const ownerSessionId = exec?.agent?.id;
      const callHost: RunDeckToolHost = {
        listEntries: host.listEntries,
        run: (projectRoot, entryId, inputValues) =>
          manager.startRun({
            projectRoot,
            entryId,
            ...(inputValues !== undefined ? { inputValues } : {}),
            ...(ownerSessionId !== undefined ? { sessionId: ownerSessionId } : {}),
          }),
        stop: (runId) => manager.stopRun(runId),
        rerun: (runId) => manager.rerun(runId),
        create: host.create,
        // action=create 缺 project_root 时，用**本次调用会话**的 cwd 当落点。
        sessionCwd: () => exec?.agent?.session?.header?.cwd,
      };
      const result = await dispatchToolArgs(args, callHost);
      // 成功时补上命令行和 cwd——让模型（和人）一眼看出"这一条到底跑什么"。
      const entryId = typeof result['entry_id'] === 'string' ? result['entry_id'] : '';
      if (result['ok'] === true && entryId.length > 0) {
        const entry = manager
          .listProjects()
          .flatMap((project) => project.entries)
          .find((candidate) => candidate.id === entryId);
        if (entry !== undefined) {
          result['command_line'] = renderCommandLine(entry);
          result['cwd'] = entry.cwd;
        }
      }
      return result;
    },
    presentCall: (args: Record<string, unknown>) => ({
      card: 'generic',
      title: `Run configuration · ${String(args['action'] ?? '?')}`,
      kind: args['action'] === 'stop' ? 'other' : 'read',
      rawInput: args['entry_id'] ?? args['run_id'] ?? undefined,
    }),
  });

  const dispose = tools.register(tool);
  ctx.effect(() => dispose, 'dsh-run-deck: run-deck tool');
  log('info', `已注册 ${TOOL_NAME} 工具`);
  return { mounted: true };
}

/** 供命令面板用的"跑一条"说明（与工具描述分开：命令是人看的）。 */
export function describeRun(entryId: string, manager: RunDeckManager): string {
  for (const project of manager.listProjects()) {
    const entry = project.entries.find((candidate) => candidate.id === entryId);
    if (entry !== undefined) return renderCommandLine(entry);
  }
  return '';
}
