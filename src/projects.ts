/**
 * dsh-rundeck — 项目清单的读取。
 *
 * 落点约定：**项目根目录下的 `.dsh/run.json`**（不是 `.vscode/`）。
 * 借 VS Code 的词汇表，但不冒充 VS Code 能读它——所以放 `.dsh/` 而不是
 * 塞进 `.vscode/tasks.json` 让真 VS Code 也去解析（两边的 `type` 支持集不同）。
 *
 * 根目录来源（按优先级）：
 *   1. 插件配置 `configPath`（单文件清单，供没有固定项目根目录时用）
 *   2. DSH `workspaceRegistry` 里的工作区路径（每个工作区就是"一个项目根目录"）
 * 两者都拿不到就报一个明确告警，而不是默默空着。
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

import { coerceEntry, deriveId, expandVariables, resolveInputs } from './config.js';
import {
  ERROR_CODES,
  type ApiError,
  type ButtonConfig,
  type InputVariable,
  type ResolvedEntry,
  type RunConfigDocument,
  type RunProject,
  type TaskEntry,
} from './types.js';

export { ERROR_CODES };
export type { ApiError } from './types.js';

/** 清单在项目里的固定相对位置。 */
export const MANIFEST_RELATIVE_PATH = ['.dsh', 'run.json'] as const;

/** manifest 文件名（告警信息里用，避免字符串漂移）。 */
export const MANIFEST_FILE = '.dsh/run.json';

/**
 * 归一化项目根目录：统一用 `/`、折叠重复分隔符、去掉末尾分隔符。
 *
 * 所有项目根目录的唯一入口（工作区列表、会话 cwd、configPath、focusCwd）
 * 都经过这里，所以"同一个目录"在插件内部永远只有一个拼法。否则 Windows 上
 * `C:\a\b` / `C:/a/b` / `C://a//b` 会算成三个项目，按钮组会重复。
 * 开头的 `//`（UNC 路径）保留。
 */
export function normalizeRoot(root: string): string {
  const trimmed = root.trim().replaceAll('\\', '/');
  const collapsed = trimmed.replace(/([^:])\/{2,}/gu, '$1/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/u, '') : collapsed;
}

function failure(code: string, message: string, hint?: string): ApiError {
  const error: ApiError = { ok: false, code, message };
  if (hint !== undefined) error.hint = hint;
  return error;
}

/** 剥掉 JSON with comments 的 `//` 与 `/* *‍/` 注释（不在字符串内时）。 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        index += 1;
      } else if (char === '\n') {
        out += char;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        out += text[index + 1] ?? '';
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** 读取并解析一个 manifest 文件；不存在返回 undefined（不是错误）。 */
async function readManifest(
  file: string,
): Promise<{ document: RunConfigDocument; warnings: string[] } | ApiError> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return failure(ERROR_CODES.notFound, `${MANIFEST_FILE} 不存在`);
    return failure(ERROR_CODES.fs, `读不了 ${MANIFEST_FILE}`, String(code ?? error));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (error) {
    return failure(ERROR_CODES.fs, `${MANIFEST_FILE} 不是合法 JSON`, String(error));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failure(ERROR_CODES.badRequest, `${MANIFEST_FILE} 顶层必须是对象`);
  }

  return coerceDocument(parsed as Record<string, unknown>);
}

/** 收敛整个文档：inputs / tasks / buttons。 */
export function coerceDocument(raw: Record<string, unknown>): {
  document: RunConfigDocument;
  warnings: string[];
} {
  const warnings: string[] = [];

  const inputs: InputVariable[] = [];
  if (Array.isArray(raw['inputs'])) {
    for (const rawInput of raw['inputs']) {
      if (rawInput === null || typeof rawInput !== 'object') continue;
      const item = rawInput as Record<string, unknown>;
      const id = typeof item['id'] === 'string' ? item['id'] : undefined;
      const options = Array.isArray(item['options'])
        ? item['options'].filter((option): option is string => typeof option === 'string')
        : [];
      if (id === undefined || options.length === 0 || item['type'] !== 'pickString') {
        warnings.push('inputs[] 里有一条不是合法的 pickString（需要 id / type / options），已忽略');
        continue;
      }
      inputs.push({
        id,
        type: 'pickString',
        options,
        ...(typeof item['default'] === 'string' ? { default: item['default'] } : {}),
      });
    }
  }

  const tasks: TaskEntry[] = [];
  if (!Array.isArray(raw['tasks'])) {
    warnings.push('manifest 里没有 tasks[] 数组');
  } else {
    for (const rawEntry of raw['tasks']) {
      const coerced = coerceEntry(rawEntry);
      if (coerced === undefined) {
        // 只在该条完全没法用时才丢；丢之前记下它长什么样，方便定位。
        const label =
          rawEntry !== null && typeof rawEntry === 'object'
            ? String((rawEntry as Record<string, unknown>)['label'] ?? '(无 label)')
            : String(rawEntry);
        warnings.push(`条目「${label}」缺 label 或 command，已忽略`);
        continue;
      }
      tasks.push(coerced.entry);
      for (const warning of coerced.warnings) warnings.push(warning);
    }
  }

  const buttons: ButtonConfig[] = [];
  if (Array.isArray(raw['buttons'])) {
    for (const rawButton of raw['buttons']) {
      if (rawButton === null || typeof rawButton !== 'object') continue;
      const item = rawButton as Record<string, unknown>;
      const entry = typeof item['entry'] === 'string' ? item['entry'] : undefined;
      if (entry === undefined) {
        warnings.push('buttons[] 里有一条没写 entry，已忽略');
        continue;
      }
      const label = typeof item['label'] === 'string' ? item['label'] : undefined;
      const icon = typeof item['icon'] === 'string' ? item['icon'] : undefined;
      const group = typeof item['group'] === 'string' ? item['group'] : undefined;
      const order = typeof item['order'] === 'number' ? item['order'] : undefined;
      const button: ButtonConfig = {
        entry,
        ...(icon !== undefined ? { icon } : {}),
        ...(group !== undefined ? { group } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(order !== undefined ? { order } : {}),
      };
      buttons.push(button);
    }
  }

  const document: RunConfigDocument = {
    ...(typeof raw['version'] === 'string' ? { version: raw['version'] } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    tasks,
    ...(buttons.length > 0 ? { buttons } : {}),
  };
  return { document, warnings };
}

/** 把 manifest 里的 tasks[] 解析成 ResolvedEntry[]（补齐 id、展开变量）。 */
export function resolveEntries(root: string, document: RunConfigDocument): ResolvedEntry[] {
  const inputs = resolveInputs(document.inputs ?? []);
  const env = process.env as Record<string, string | undefined>;
  const taken = new Set<string>();
  const resolved: ResolvedEntry[] = [];

  for (const entry of document.tasks) {
    // id 优先用配置里写的；否则从 label 派生并保证唯一（label 可重名，id 不能）。
    const id =
      entry.id !== undefined && !taken.has(entry.id)
        ? entry.id
        : entry.id !== undefined && taken.has(entry.id)
          ? deriveId(`${entry.id}`, taken)
          : deriveId(entry.label, taken);
    taken.add(id);

    const context = { workspaceFolder: root, inputs, env };
    const cwdRaw = entry.options?.cwd ?? '${workspaceFolder}';
    const expandedCwd = expandVariables(cwdRaw, context);
    // 相对 cwd 是**相对 workspaceFolder** 解析的（VS Code 同义）。这一步必须在这里做：
    // `spawnTerminal` 拿到的是原样字符串，而宿主的进程工作目录不是项目根目录——
    // 直接把 'apps/web' 递下去，跑起来的是"宿主进程旁边的 apps/web"，不是项目里的。
    const cwd = normalizeRoot(
      isAbsolute(expandedCwd) ? expandedCwd : join(root, expandedCwd),
    );

    const envResolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.options?.env ?? {})) {
      envResolved[key] = expandVariables(value, context);
    }

    resolved.push({
      id,
      // label 也走变量展开：配置里写 "Ceola · desktop (${input:mode})" 时，
      // 界面与浮动按钮该显示展开后的值，而不是把模板原样端给人。
      // （args / command / cwd 一向是展开的，label 不展开会显得不一致。）
      label: expandVariables(entry.label, context),
      type: entry.type ?? 'shell',
      command: expandVariables(entry.command, context),
      args: (entry.args ?? []).map((arg) => expandVariables(arg, context)),
      cwd,
      isBackground: entry.isBackground === true,
      ...(entry.problemMatcher !== undefined ? { problemMatcher: entry.problemMatcher } : {}),
      ...(entry.serverReadyAction !== undefined
        ? { serverReadyAction: entry.serverReadyAction }
        : {}),
      ...(entry.presentation !== undefined ? { presentation: entry.presentation } : {}),
      group: entry.group ?? 'none',
      ...(entry.onReady !== undefined ? { onReady: entry.onReady } : {}),
      // 原样保留一条：`+` 面板的「从已有条目复制」必须拿未展开的字段
      // （否则 `${workspaceFolder}` 会变成这台机器的绝对路径）。
      raw: entry,
    });
  }
  return resolved;
}

export interface LoadProjectsOptions {
  /** 额外的清单文件（插件配置指来的那份），没有项目根目录时也能用。 */
  extraManifests?: string[];
}

/** 读一个项目根目录：目录不存在 / 没有 manifest 都不算错误。 */
export async function loadProject(root: string): Promise<{ project: RunProject; error?: ApiError }> {
  const warnings: string[] = [];
  // 整个插件内部一律用 `/` 分隔路径。Windows 上 `\` 也能用，但两种混着会出现
  // "同一个目录比较不相等"的怪事——所有入口都经过这里，所以在这里归一化。
  const normalizedRoot = normalizeRoot(root);
  const file = join(normalizedRoot, ...MANIFEST_RELATIVE_PATH);

  let exists = true;
  let mtimeMs: number | undefined;
  try {
    const stats = await stat(file);
    exists = stats.isFile();
    mtimeMs = stats.mtimeMs;
  } catch {
    exists = false;
  }

  const base: RunProject = {
    root: normalizedRoot,
    name: basename(normalizedRoot) || normalizedRoot,
    entries: [],
    warnings,
  };

  if (!exists) {
    return { project: { ...base, configFile: undefined } };
  }

  const outcome = await readManifest(file);
  if ('ok' in outcome) {
    // 坏了就是坏了：把错误摊开给用户看，不要装作没有这个文件。
    warnings.push(outcome.message + (outcome.hint !== undefined ? `（${outcome.hint}）` : ''));
    return {
      project: { ...base, configFile: file, manifestMtimeMs: mtimeMs, warnings },
      error: outcome,
    };
  }

  for (const warning of outcome.warnings) warnings.push(warning);
  return {
    project: {
      ...base,
      configFile: file,
      manifestMtimeMs: mtimeMs,
      document: outcome.document,
      entries: resolveEntries(normalizedRoot, outcome.document),
      warnings,
    },
  };
}

/** 读一批项目根目录。 */
export async function loadProjects(roots: string[]): Promise<RunProject[]> {
  const seen = new Set<string>();
  const projects: RunProject[] = [];
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    const { project } = await loadProject(root);
    projects.push(project);
  }
  return projects;
}
