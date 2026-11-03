/**
 * dsh-run-deck — 「+」面板提交的一条新启动项：**校验 + 收敛成 TaskEntry**。
 *
 * 单独一个文件，因为它是"界面上那堆输入框"和"清单里那一条 JSON"之间唯一的桥：
 *   - 界面上填的是**人话**（一行命令、一个目录、几行 KEY=value、一条正则）；
 *   - 清单里存的是 `TaskEntry`（`command` + `args`、`options.cwd`、`problemMatcher` …）。
 *
 * 两条原则：
 *   1. **写进文件之前就要拦住**。填错了的条目会安静地留在 run.json 里，等到点按钮才
 *      暴露（"工作目录不存在" / "正则写错了"），那时人已经忘了自己填过什么。所以这里
 *      逐项校验并把原因说清楚，宁可拒绝写入。
 *   2. **不新增执行能力**。这里产出的 TaskEntry 与手写在 run.json 里的一条完全等价，
 *      而且写入仍然走 `insertTaskIntoManifestText` 的最小文本插入。
 */
import { isAbsolute, join } from 'node:path';

import { deriveId } from './config.js';
import { splitCommandLine } from './manifest-edit.js';
import {
  ERROR_CODES,
  type ApiError,
  type ApiResult,
  type ResolvedEntry,
  type ServerReadyAction,
  type TaskEntry,
  type TaskGroup,
  type TaskPresentation,
  type NewTaskInput,
} from './types.js';

/** 换行与控制字符：命令/名称/路径里出现它们只会让清单和命令行变形。 */
const CONTROL = /[\u0000-\u001f\u007f]/u;
/** 环境变量名（POSIX 与 Windows 的交集）。 */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** 显式 id 的形态：只允许 slug 字符，避免命令行里还要转义。 */
const ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/u;

/** 校验一条新启动项需要的外部事实。 */
export interface NewTaskContext {
  /** 项目根目录（`options.cwd` 相对它解析，与清单语义一致）。 */
  root: string;
  /** 项目里已有的条目（id 冲突、onReady 指向都要对着它看）。 */
  entries: ResolvedEntry[];
  /** 一个绝对路径是不是已存在的目录（host 注入，测试里可以塞假的）。 */
  directoryExists(path: string): Promise<boolean>;
}

export interface BuiltTask {
  task: TaskEntry;
  /** 收敛后的 id（清单里显式写进 `id`）。 */
  entryId: string;
}

function bad(message: string, hint?: string): ApiError {
  const error: ApiError = { ok: false, code: ERROR_CODES.badRequest, message };
  if (hint !== undefined) error.hint = hint;
  return error;
}

/** 正则能不能编译；能编译返回 undefined，否则返回引擎给的原始原因。 */
export function patternError(pattern: string): string | undefined {
  try {
    new RegExp(pattern, 'u');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * 把界面填的东西收敛成一条 `TaskEntry`。
 *
 * 失败时返回 `ok: false` + 一句能直接显示给人看的原因（`hint` 里是"该怎么改"）。
 * 调用方拿到失败**不得落盘**。
 */
export async function buildTaskEntry(
  input: NewTaskInput,
  context: NewTaskContext,
): Promise<ApiResult<BuiltTask>> {
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  const line = typeof input.command === 'string' ? input.command.trim() : '';
  if (label.length === 0) return bad('缺条目名称');
  if (line.length === 0) return bad('缺命令');
  if (CONTROL.test(label)) return bad('名称里不能有换行或控制字符');
  if (CONTROL.test(line)) return bad('命令里不能有换行或控制字符（一条一行）');
  if (label.length > 200 || line.length > 1000) return bad('名称或命令太长');

  const split = splitCommandLine(line);
  if (!split.ok) return bad(split.message, '引号成对写，或者去掉引号。');
  const [command, ...args] = split.tokens;
  if (command === undefined) return bad('缺命令');

  // ── id：显式给了就用（要形如 slug 且不撞），否则由 label 派生 ──
  const taken = new Set(context.entries.map((entry) => entry.id));
  const explicitId = typeof input.id === 'string' ? input.id.trim() : '';
  let id: string;
  if (explicitId.length > 0) {
    if (!ID_SHAPE.test(explicitId)) {
      return bad(
        `id 只能由字母、数字、点、下划线、连字符组成（收到：${explicitId}）`,
        '留空则按名称自动派生。',
      );
    }
    if (taken.has(explicitId)) {
      return bad(`id 已被这个项目里的另一条占用：${explicitId}`, '换一个 id，或者留空让插件自动派生。');
    }
    id = explicitId;
  } else {
    id = deriveId(label, taken);
  }

  // ── 工作目录 ──
  let cwd: string | undefined;
  const cwdInput = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  if (cwdInput.length > 0) {
    if (CONTROL.test(cwdInput)) return bad('工作目录里不能有换行或控制字符');
    if (cwdInput.length > 400) return bad('工作目录太长');
    // 含变量的路径在这里求不了值（`${workspaceFolder}` 由读取方展开），原样收下。
    if (!cwdInput.includes('${')) {
      const absolute = isAbsolute(cwdInput) ? cwdInput : join(context.root, cwdInput);
      const exists = await context.directoryExists(absolute).catch(() => false);
      if (!exists) {
        return bad(`工作目录不存在：${absolute}`, '填项目里已有的目录（相对项目根），或者留空 = 项目根目录。');
      }
    }
    cwd = cwdInput;
  }

  // ── 环境变量 ──
  let env: Record<string, string> | undefined;
  if (input.env !== undefined) {
    if (typeof input.env !== 'object' || input.env === null || Array.isArray(input.env)) {
      return bad('环境变量必须是键值对象');
    }
    const pairs = Object.entries(input.env);
    if (pairs.length > 64) return bad('环境变量太多了（上限 64 条）');
    const collected: Record<string, string> = {};
    for (const [rawKey, value] of pairs) {
      const name = rawKey.trim();
      if (!ENV_KEY.test(name)) {
        return bad(`环境变量名不合法：${rawKey}`, '只能由字母、数字、下划线组成，且不以数字开头。');
      }
      if (typeof value !== 'string') return bad(`环境变量 ${name} 的值必须是字符串`);
      if (CONTROL.test(value)) return bad(`环境变量 ${name} 的值里不能有换行或控制字符`);
      if (value.length > 1000) return bad(`环境变量 ${name} 的值太长`);
      collected[name] = value;
    }
    if (Object.keys(collected).length > 0) env = collected;
  }

  // ── 分组 ──
  let group: TaskGroup | undefined;
  if (input.group !== undefined) {
    if (input.group !== 'build' && input.group !== 'test' && input.group !== 'none') {
      return bad('group 只能是 build / test / none');
    }
    if (input.group !== 'none') group = input.group;
  }

  // ── 就绪正则 / 就绪后打开地址 ──
  const readyPattern = typeof input.readyPattern === 'string' ? input.readyPattern.trim() : '';
  if (readyPattern.length > 500) return bad('就绪正则太长');
  if (readyPattern.length > 0) {
    const reason = patternError(readyPattern);
    if (reason !== undefined) {
      return bad(
        `就绪正则写错了：${reason}`,
        '这里填的是正则的源码本身（不带两边的斜杠），例如 Local:\\s+(https?://\\S+)。',
      );
    }
  }

  let serverReadyAction: ServerReadyAction | undefined;
  if (input.openUrl === true) {
    const urlPattern =
      (typeof input.urlPattern === 'string' ? input.urlPattern.trim() : '') || readyPattern;
    if (urlPattern.length === 0) {
      return bad(
        '要"就绪后打开地址"，就得给一条 URL 正则',
        '填「URL 正则」，或者先填「就绪正则」让两处共用一条。',
      );
    }
    if (urlPattern.length > 500) return bad('URL 正则太长');
    const reason = patternError(urlPattern);
    if (reason !== undefined) return bad(`URL 正则写错了：${reason}`);
    const uriFormat = typeof input.uriFormat === 'string' ? input.uriFormat.trim() : '';
    if (uriFormat.length > 0 && !uriFormat.includes('%s')) {
      return bad('地址格式里必须有 %s（抓到的地址替换在这里）', '留空 = 原样打开抓到的地址。');
    }
    serverReadyAction = {
      action: 'openExternally',
      pattern: urlPattern,
      ...(uriFormat.length > 0 ? { uriFormat } : {}),
    };
  }

  // ── presentation.reveal（唯一活着的字段：跑起来时自动钉住输出卡）──
  let presentation: TaskPresentation | undefined;
  if (input.reveal === 'always' || input.reveal === 'silent' || input.reveal === 'never') {
    presentation = { reveal: input.reveal };
  }

  // ── onReady：只接受本项目已有的 entry id ──
  let onReady: string | undefined;
  const onReadyInput = typeof input.onReady === 'string' ? input.onReady.trim() : '';
  if (onReadyInput.length > 0) {
    if (onReadyInput === id) return bad('onReady 不能指向自己', '换一条，或者先不接续。');
    if (!context.entries.some((entry) => entry.id === onReadyInput)) {
      return bad(
        `onReady 指向不存在的条目：${onReadyInput}`,
        '只接受本项目里已有的 entry id（不是命令）。',
      );
    }
    onReady = onReadyInput;
  }

  const task: TaskEntry = {
    label,
    id,
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(cwd !== undefined || env !== undefined
      ? {
          options: {
            ...(cwd !== undefined ? { cwd } : {}),
            ...(env !== undefined ? { env } : {}),
          },
        }
      : {}),
    ...(input.isBackground === true ? { isBackground: true } : {}),
    ...(readyPattern.length > 0
      ? { problemMatcher: { background: { endsPattern: readyPattern } } }
      : {}),
    ...(serverReadyAction !== undefined ? { serverReadyAction } : {}),
    ...(presentation !== undefined ? { presentation } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(onReady !== undefined ? { onReady } : {}),
  };

  return { ok: true, task, entryId: id };
}
