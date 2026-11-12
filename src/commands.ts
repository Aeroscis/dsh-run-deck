/**
 * dsh-run-deck — `/run-deck` 命令（host 侧）。
 *
 * `/run-deck [list | run <id> | stop <runId> | rerun <runId> | path | help]`
 *
 * 定位：浮动按钮条是给人点的界面，命令是**同一个动作的另一个入口**——
 * 脚本化、跨 profile 查看、不方便点鼠标的时候。两边调的是同一个 manager，
 * 不存在"两套逻辑"（官方插件开发参考里 user-actions.md 的那条要求）。
 *
 * 里外同一条边界的体现：命令也只接受 id，不接受自由命令。
 */
import { messageOf } from './sessions.js';
import { renderCommandLine } from './exec.js';
import type { RunDeckManager } from './manager.js';
import type { ApiError, ResolvedEntry, RunRecord } from './types.js';

/** 命令的返回体（`DshCommandResult` 是 dsh.d.ts 里的全局类型，这里起个别名）。 */
type TaskResult = DshCommandResult;

/** 解析 `/run-deck` 之后的参数，支持双引号/单引号包裹。 */
export function parseArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let has = false;

  for (const char of input.trim()) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      has = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (has || current.length > 0) args.push(current);
      current = '';
      has = false;
      continue;
    }
    current += char;
  }
  if (has || current.length > 0) args.push(current);
  return args;
}

function renderError(error: ApiError): string {
  return error.hint === undefined ? `❌ ${error.message}` : `❌ ${error.message}\n   ↳ ${error.hint}`;
}

/** 一条 run 的状态标签。 */
function statusLabel(run: RunRecord): string {
  switch (run.status) {
    case 'starting':
      return '⏳ starting';
    case 'running':
      return '🔵 running';
    case 'ready':
      return '🟢 ready';
    case 'stopping':
      return '🟡 stopping';
    case 'exited':
      return '⚪ exited';
  }
}

export interface CommandDeps {
  manager: RunDeckManager;
  /** 插件启动完成（清单已载入）后才执行命令逻辑。 */
  ready: Promise<void>;
}

/** 构造 `/run-deck` 命令定义。 */
export function createRunDeckCommand(deps: CommandDeps): DshCommandDefinition {
  const { manager, ready } = deps;

  return {
    name: 'run-deck',
    description:
      'Run Configuration：列出 / 跑 / 停 / 重跑 .dsh/run-deck/run.json 里声明的条目（词汇表同 VS Code tasks.json）',
    input: { hint: '[list | run <id> | stop <runId> | rerun <runId> | path | help]' },
    async handler(invocation) {
      try {
        await ready;
        await manager.refresh();
        // owner = **调用这条命令的 Agent**：终端归发起它的会话（见 exec.ts 的 owner 说明）。
        return await handle(invocation.rawInput, invocation.agent.id);
      } catch (error) {
        return { kind: 'error', text: `❌ /run-deck 执行失败：${messageOf(error)}` };
      }
    },
  };

  async function handle(rawInput: string, sessionId: string): Promise<TaskResult> {
    const args = parseArgs(stripCommandName(rawInput));
    const sub = (args[0] ?? 'help').toLowerCase();
    const rest = args.slice(1);

    switch (sub) {
      case 'list':
      case 'ls':
        return listText();
      case 'run':
        return runText(rest.join(' '), sessionId);
      case 'stop':
        return stopText(rest.join(' '));
      case 'rerun':
        return rerunText(rest.join(' '));
      case 'path':
        return pathText();
      case 'help':
      case '--help':
      case '-h':
      default:
        return { kind: 'success', text: helpText() };
    }
  }

  function listText(): TaskResult {
    const projects = manager.listProjects();
    const runs = manager.listRuns();
    const warnings = manager.getWarnings();
    const warn = warnings.length > 0 ? `\n\n⚠️ ${warnings.join('\n⚠️ ')}` : '';

    const withEntries = projects.filter((project) => project.entries.length > 0);
    if (withEntries.length === 0) {
      return {
        kind: 'success',
        text: `📋 没有找到任何条目。\n在工作区根目录放一份 .dsh/run-deck/run.json 即可。${warn}`,
      };
    }

    const body = withEntries
      .map((project) => {
        const entries = project.entries
          .map((entry) => {
            const marker = entry.isBackground ? ' 🔁' : '';
            return `  • ${entry.label}　[id: ${entry.id}]${marker}\n      ${renderCommandLine(entry)}`;
          })
          .join('\n');
        return `📁 ${project.name}　(${project.root})\n${entries}`;
      })
      .join('\n\n');

    const runsText =
      runs.length === 0
        ? '\n\n（没有进行中的 run）'
        : `\n\n进行中的 run：\n${runs
            .map((run) => `  • ${statusLabel(run)} ${run.label}　[runId: ${run.runId}]`)
            .join('\n')}`;

    return {
      kind: 'success',
      text: `📋 Run Configuration\n\n${body}${runsText}\n\n跑：/run-deck run <id>${warn}`,
    };
  }

  function findProject(query: string): string | undefined {
    const trimmed = query.trim();
    if (trimmed.length === 0) return undefined;
    // 先按 id 精确匹配（外部按名字调用的入口就是 id，不是 label）
    for (const project of manager.listProjects()) {
      if (project.entries.some((entry) => entry.id === trimmed)) return project.root;
    }
    // 再按 label 精确匹配一次；然后才做片段匹配（多个匹配时报歧义）
    let matches: string[] = [];
    for (const project of manager.listProjects()) {
      if (project.entries.some((entry) => entry.label === trimmed)) {
        if (!matches.includes(project.root)) matches.push(project.root);
      }
    }
    if (matches.length === 1) return matches[0];
    matches = [];
    for (const project of manager.listProjects()) {
      if (
        project.entries.some(
          (entry) => entry.id.includes(trimmed) || entry.label.includes(trimmed),
        )
      ) {
        if (!matches.includes(project.root)) matches.push(project.root);
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** 定位到条目本身：先用 id，再用 label（label 可重名，因此只在唯一时接受）。 */
  function resolveEntry(projectRoot: string, query: string): ResolvedEntry | undefined {
    const project = manager.listProjects().find((candidate) => candidate.root === projectRoot);
    if (project === undefined) return undefined;
    const byId = project.entries.find((entry) => entry.id === query);
    if (byId !== undefined) return byId;
    const byLabel = project.entries.filter((entry) => entry.label === query);
    return byLabel.length === 1 ? byLabel[0] : undefined;
  }

  async function runText(query: string, sessionId: string): Promise<TaskResult> {
    if (query.trim().length === 0) {
      return { kind: 'error', text: '用法：/run-deck run <id>（先用 /run-deck list 看有哪些 id）' };
    }
    // id 里可能带 `/`（例如 `jin/web`），所以按**完整 id** 找，不再切分。
    const projectRoot = findProject(query);
    if (projectRoot === undefined) {
      return {
        kind: 'error',
        text: `❌ 找不到条目「${query}」。用 /run-deck list 查看可用的 id（含空格的标题用引号包住）。`,
      };
    }
    const entry = resolveEntry(projectRoot, query.trim());
    if (entry === undefined) {
      return { kind: 'error', text: `❌ 条目「${query}」不唯一或无法解析，请改用它的 id。` };
    }
    const result = await manager.startRun({ projectRoot, entryId: entry.id, sessionId });
    if (!result.ok) return { kind: 'error', text: renderError(result) };
    return {
      kind: 'success',
      text:
        `🚀 已开一条 PTY 跑起来：${result.label}\n` +
        `   命令：${renderCommandLine(entry)}\n` +
        `   目录：${entry.cwd}\n` +
        `   进程：${result.pid !== undefined && result.pid > 0 ? `pid ${result.pid}` : '(宿主没给 pid)'}\n` +
        `   runId：${result.runId}${entry.isBackground ? '\n   （长驻：跑完不退出，用 /run-deck stop 停）' : ''}\n` +
        `   停止：/run-deck stop ${result.runId}`,
    };
  }

  async function stopText(runId: string): Promise<TaskResult> {
    const trimmed = runId.trim();
    if (trimmed.length === 0) return { kind: 'error', text: '用法：/run-deck stop <runId>' };
    const result = await manager.stopRun(trimmed);
    if (!result.ok) return { kind: 'error', text: renderError(result) };
    return {
      kind: 'success',
      text: `⏹ 已停止 ${result.label}（${result.runId}）—— 已向前台进程组发 SIGINT，脚本自己的清理会跑`,
    };
  }

  async function rerunText(runId: string): Promise<TaskResult> {
    const trimmed = runId.trim();
    if (trimmed.length === 0) return { kind: 'error', text: '用法：/run-deck rerun <runId>' };
    const result = await manager.rerun(trimmed);
    if (!result.ok) return { kind: 'error', text: renderError(result) };
    return {
      kind: 'success',
      text: `🔁 已重跑：${result.label}（新 runId：${result.runId}）`,
    };
  }

  function pathText(): TaskResult {
    const projects = manager.listProjects();
    const lines = projects.map(
      (project) => `  • ${project.name}：${project.configFile ?? '（没有 .dsh/run-deck/run.json）'}`,
    );
    return {
      kind: 'success',
      text: `📁 清单落点\n\n${lines.join('\n')}`,
    };
  }

  function helpText(): string {
    return [
      '🗂 Run Configuration 命令',
      '',
      '  /run-deck list                    列出全部条目（id / 命令 / 目录）+ 进行中的 run',
      '  /run-deck run <id>                跑一个条目（id 用 /run-deck list 里那个）',
      '  /run-deck stop <runId>            停掉一个 run',
      '  /run-deck rerun <runId>           停掉旧的再开新的',
      '  /run-deck path                    显示各项目的 .dsh/run-deck/run.json 落点',
      '  /run-deck help                    显示本帮助',
      '',
      '条目词汇表与 VS Code tasks.json 一致（type/command/args/options.cwd/isBackground/',
      'problemMatcher/presentation/group、inputs 的 pickString+promptString、${input:id}、',
      '${workspaceFolder}、${env:X}、runOptions.runOn: "folderOpen"（宿主启动自动跑）、',
      'serverReadyAction）。id 是跨族唯一接口；label 可重名，不能当调用名。',
      '',
      '输入框上沿的浮动条显示**当前工作区**的按钮；+ 面板管排序与显隐。',
      '',
      '执行走终端（dsh-terminal），因为 job 派生的进程收不到 Ctrl+C/Ctrl+Break——',
      '进程树清理挂在那两个信号上。详见 docs/blocker-findings.md。',
    ].join('\n');
  }
}

/** 命令的 rawInput 一般已是参数部分；万一带了命令名则剥掉。 */
function stripCommandName(rawInput: string): string {
  const text = rawInput.replace(/^\s*\/?run-deck\b/u, '').trim();
  return text.length > 0 ? text : rawInput.trim();
}
