/**
 * dsh-run-deck — run.json 的读取与词法收敛。
 *
 * 本文件只有两件事：
 *   1. **读** `.dsh/run-deck/run.json`（JSON with comments 由调用方先剥掉，见 parseDocument）
 *   2. **收敛** 字段到明确类型，不发明新字段、不提供默认行为之外的东西
 *
 * 收敛策略：**宽容读、严格用**。类型不对的字段被忽略并记一条告警，
 * 而不是让整个清单不可用——一个项目里几十条 entry，不该被一条笔误全拖下水。
 * 但 `command` 这种缺了就完全没法跑的字段，缺了就丢掉该条并记告警。
 */
import type {
  ApiError,
  ProblemMatcher,
  ServerReadyAction,
  TaskEntry,
  TaskGroup,
  TaskOptions,
  TaskPresentation,
} from './types.js';

export type { ApiError, TaskEntry } from './types.js';

/** `version` 字段不认识时不报错，只告警（向后兼容旧版清单）。 */
export const KNOWN_VERSION = '2.0.0';

function failure(code: string, message: string, hint?: string): ApiError {
  const error: ApiError = { ok: false, code, message };
  if (hint !== undefined) error.hint = hint;
  return error;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // 有任何一个元素不是字符串就算"这个字段用不了"——返回 undefined 而不是过滤后的数组，
  // 否则 `args: [1, 2]` 会被静默收敛成空数组，看起来像"这条目没有参数"，
  // 而作者的本意被丢掉了。宁可用默认值 + 一条告警。
  if (!value.every((entry) => typeof entry === 'string')) return undefined;
  return value as string[];
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/* ─────────────────────────── ${…} 变量展开 ─────────────────────────── */

/**
 * 展开 `${input:id}` / `${workspaceFolder}` / `${env:NAME}`。
 *
 * **只做 VS Code variables-reference 里有的三种**，不发明新变量——
 * 上一版被否掉的 `${ready.1}` 就是那种东西：它把"就绪"这个运行时状态
 * 变成模板变量，于是每条命令都要重新解释一遍执行时机。
 *
 * 未知变量**原样留下**（VS Code 对未定义 input 的行为也是给空串，但原样留下
 * 更容易在日志里看出"这里本该有值"）。
 */
export function expandVariables(
  text: string,
  context: {
    workspaceFolder: string;
    inputs: Record<string, string>;
    env: Record<string, string | undefined>;
  },
): string {
  return text.replace(/\$\{([^}]+)\}/gu, (whole, expression: string) => {
    const colon = expression.indexOf(':');
    const kind = colon === -1 ? expression.trim() : expression.slice(0, colon).trim();
    const name = colon === -1 ? '' : expression.slice(colon + 1).trim();

    if (kind === 'input') {
      const value = context.inputs[name];
      return value !== undefined ? value : whole;
    }
    if (kind === 'env') {
      const value = context.env[name];
      return value !== undefined ? value : '';
    }
    if (kind === 'workspaceFolder') return context.workspaceFolder;
    // ${workspaceFolder:basename} / ${relativeFile} 这些本插件用不到，
    // 原样留下，让配置里的人自己看见它是没被支持的。
    return whole;
  });
}

/** 默认 input 值：配置里写了 default 用它，否则取第一项。 */
export function resolveInputs(
  inputs: Array<{ id: string; options: string[]; default?: string }>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const input of inputs) {
    const first = input.options[0];
    const chosen = input.default ?? first;
    if (chosen !== undefined) resolved[input.id] = chosen;
  }
  return resolved;
}

/* ─────────────────────────── 单条 entry 的收敛 ─────────────────────────── */

export interface CoercedEntry {
  entry: TaskEntry;
  warnings: string[];
}

/**
 * 把 JSON 里的一条对象收敛成 TaskEntry。
 *
 * 顺序要紧：先看 command（缺了就整个不能用），再逐个可选项。
 * 每一条告警都带上 label/id，让人能定位到是哪一行。
 */
export function coerceEntry(raw: unknown): CoercedEntry | undefined {
  if (!isRecord(raw)) return undefined;

  const label = str(raw['label']);
  const command = str(raw['command']);
  if (label === undefined || command === undefined) {
    // label 和 command 是 VS Code 里也必填的两个；缺任何一个就没法跑也没法显示。
    return undefined;
  }

  const warnings: string[] = [];
  const args = strArray(raw['args']);
  if (raw['args'] !== undefined && args === undefined) {
    warnings.push(`条目「${label}」的 args 不是字符串数组，已忽略`);
  }

  const optionsRaw = raw['options'];
  let options: TaskOptions | undefined;
  if (optionsRaw !== undefined) {
    if (!isRecord(optionsRaw)) {
      warnings.push(`条目「${label}」的 options 不是对象，已忽略`);
    } else {
      const cwd = str(optionsRaw['cwd']);
      const envRaw = optionsRaw['env'];
      let env: Record<string, string> | undefined;
      if (envRaw !== undefined) {
        if (!isRecord(envRaw)) {
          warnings.push(`条目「${label}」的 options.env 不是对象，已忽略`);
        } else {
          env = {};
          for (const [key, value] of Object.entries(envRaw)) {
            if (typeof value === 'string') env[key] = value;
          }
        }
      }
      options = {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(env !== undefined ? { env } : {}),
      };
    }
  }

  const problemMatcherRaw = raw['problemMatcher'];
  let problemMatcher: ProblemMatcher | undefined;
  if (problemMatcherRaw !== undefined) {
    if (!isRecord(problemMatcherRaw)) {
      warnings.push(`条目「${label}」的 problemMatcher 不是对象，已忽略`);
    } else {
      const backgroundRaw = problemMatcherRaw['background'];
      if (backgroundRaw !== undefined) {
        if (!isRecord(backgroundRaw)) {
          warnings.push(`条目「${label}」的 problemMatcher.background 不是对象，已忽略`);
        } else {
          const beginsPattern = str(backgroundRaw['beginsPattern']);
          const endsPattern = str(backgroundRaw['endsPattern']);
          const activeOnStart = bool(backgroundRaw['activeOnStart']);
          problemMatcher = {
            background: {
              activeOnStart: activeOnStart ?? false,
              ...(beginsPattern !== undefined ? { beginsPattern } : {}),
              ...(endsPattern !== undefined ? { endsPattern } : {}),
            },
          };
        }
      }
    }
  }

  const readyRaw = raw['serverReadyAction'];
  let serverReadyAction: ServerReadyAction | undefined;
  if (readyRaw !== undefined) {
    if (!isRecord(readyRaw)) {
      warnings.push(`条目「${label}」的 serverReadyAction 不是对象，已忽略`);
    } else if (readyRaw['action'] !== 'openExternally') {
      warnings.push(`条目「${label}」的 serverReadyAction.action 不是 openExternally，已忽略`);
    } else {
      const pattern = str(readyRaw['pattern']);
      if (pattern === undefined) {
        warnings.push(`条目「${label}」的 serverReadyAction 缺 pattern，已忽略`);
      } else {
        serverReadyAction = {
          action: 'openExternally',
          pattern,
          ...(str(readyRaw['uriFormat']) !== undefined
            ? { uriFormat: str(readyRaw['uriFormat']) }
            : {}),
        };
      }
    }
  }

  const presentationRaw = raw['presentation'];
  let presentation: TaskPresentation | undefined;
  if (presentationRaw !== undefined && isRecord(presentationRaw)) {
    const panel = presentationRaw['panel'];
    const reveal = presentationRaw['reveal'];
    const clear = bool(presentationRaw['clear']);
    presentation = {
      ...(panel === 'shared' || panel === 'dedicated' || panel === 'new' ? { panel } : {}),
      ...(reveal === 'always' || reveal === 'silent' || reveal === 'never' ? { reveal } : {}),
      ...(clear !== undefined ? { clear } : {}),
    };
  }

  const groupRaw = raw['group'];
  const group: TaskGroup =
    groupRaw === 'build' || groupRaw === 'test' || groupRaw === 'none' ? groupRaw : 'none';

  const entry: TaskEntry = {
    label,
    command,
    ...(str(raw['id']) !== undefined ? { id: str(raw['id']) } : {}),
    ...(raw['type'] === 'shell' ? { type: 'shell' as const } : {}),
    ...(args !== undefined && args.length > 0 ? { args } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(bool(raw['isBackground']) === true ? { isBackground: true } : {}),
    ...(problemMatcher !== undefined ? { problemMatcher } : {}),
    ...(serverReadyAction !== undefined ? { serverReadyAction } : {}),
    ...(presentation !== undefined ? { presentation } : {}),
    ...(group !== 'none' ? { group } : {}),
    ...(str(raw['onReady']) !== undefined ? { onReady: str(raw['onReady']) } : {}),
  };
  return { entry, warnings };
}

/** 从 label 派生一个稳定 id：小写、非字母数字转 `-`。重复时追加序号。 */
export function deriveId(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'task';
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export { failure, str, strArray, bool, finiteNumber };
