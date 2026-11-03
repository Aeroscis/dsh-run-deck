/**
 * dsh-run-deck — 「+」面板的候选检测（对应 VS Code 的 "检测任务"）。
 *
 * VS Code 的 `Tasks: Run Task` 里那些 `npm: dev` 不是人写出来的，是从
 * `package.json` 的 `scripts` 里探测出来的。本文件做同一件事，只是范围更窄：
 *
 *   - **只读 `package.json` 的 `scripts`**（外加两条与项目无关的通用模板）；
 *   - **只猜，不执行**：产出的是候选，用户点了才填进表单，仍然要按"创建"才落盘；
 *   - 猜出来的字段（长驻 / 就绪正则 / 分组）**在表单里是可以改的**——它们只是
 *     省掉打字的默认值，不是隐藏行为。
 *
 * 边界：这里不扫目录找可执行文件、不读 `package.json` 的 `bin`、不执行 `npm`。
 * "命令必须是 run.json 里的字面量"这条没有变——候选被采纳后同样以字面量写进清单。
 */
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

import { splitCommandLine } from './manifest-edit.js';
import type { DetectedTask, ResolvedEntry, TaskDetection, TaskGroup } from './types.js';

/** 这些脚本名通常是"跑起来不退出"的（dev server / watch）。 */
const LONG_RUNNING = /(^|[-:._])(dev|develop|start|serve|server|watch|preview|storybook)([-:._]|$)/iu;
/** 构建类脚本。 */
const BUILD_SCRIPT = /^(build|compile|bundle|dist|pack|release|bundle)\b/iu;
/** 检查类脚本。 */
const TEST_SCRIPT = /^(test|spec|lint|typecheck|type-check|check|verify)\b/iu;
/** 界面上给的默认就绪/地址正则：大多数 dev server 都会打印一个带 scheme 的地址。 */
const DEFAULT_URL_PATTERN = '(https?://\\S+)';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 读 package.json：不存在返回 undefined，读坏/解析不了返回一句告警。 */
async function readPackageJson(root: string): Promise<
  { ok: true; scripts: Record<string, string>; packageManager?: string } | { ok: false; warning?: string }
> {
  const file = join(root, 'package.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false };
    return { ok: false, warning: `读不了 package.json：${String((error as Error).message ?? error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, ''));
  } catch {
    return { ok: false, warning: 'package.json 不是合法 JSON，跳过了脚本检测' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, warning: 'package.json 顶层不是对象，跳过了脚本检测' };
  }
  const record = parsed as Record<string, unknown>;
  const scripts: Record<string, string> = {};
  const rawScripts = record['scripts'];
  if (rawScripts !== null && typeof rawScripts === 'object' && !Array.isArray(rawScripts)) {
    for (const [name, command] of Object.entries(rawScripts as Record<string, unknown>)) {
      if (typeof command === 'string') scripts[name] = command;
    }
  }
  const declared = typeof record['packageManager'] === 'string' ? record['packageManager'] : '';
  const declaredName = declared.split('@')[0]?.trim();
  return {
    ok: true,
    scripts,
    ...(declaredName !== undefined && declaredName.length > 0 ? { packageManager: declaredName } : {}),
  };
}

/**
 * 这个项目该用哪个包管理器跑脚本。
 *
 * 顺序：`package.json` 的 `packageManager` 字段（作者显式声明）→ 锁文件 → `npm`。
 * 猜错的代价只是候选里写 `npm run dev` 而项目用 pnpm——用户看得见，也能改。
 */
async function detectPackageManager(root: string, declared: string | undefined): Promise<string> {
  if (declared !== undefined && ['pnpm', 'npm', 'yarn', 'bun'].includes(declared)) return declared;
  const probes: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ];
  for (const [file, manager] of probes) {
    if (await exists(join(root, file))) return manager;
  }
  return 'npm';
}

/** 把候选的命令行与清单里已有的条目比对（"已在清单"靠这个标记）。 */
function alreadyExists(commandLine: string, entries: ResolvedEntry[]): boolean {
  const split = splitCommandLine(commandLine);
  if (!split.ok) return false;
  const [command, ...args] = split.tokens;
  if (command === undefined) return false;
  return entries.some(
    (entry) =>
      entry.command === command &&
      entry.args.length === args.length &&
      entry.args.every((arg, index) => arg === args[index]),
  );
}

function groupOf(scriptName: string): TaskGroup | undefined {
  if (BUILD_SCRIPT.test(scriptName)) return 'build';
  if (TEST_SCRIPT.test(scriptName)) return 'test';
  return undefined;
}

/**
 * 检测这个项目的候选启动项。
 *
 * 结果**不缓存**：面板打开时读一次，`package.json` 改了再打开就是新的——
 * 与清单本身"改了下一轮 `/state` 生效"的做法一致，不额外维护一份缓存。
 */
export async function detectTasks(root: string, entries: ResolvedEntry[]): Promise<TaskDetection> {
  const warnings: string[] = [];
  const candidates: DetectedTask[] = [];

  const pkg = await readPackageJson(root);
  let packageManager: string | undefined;
  if (pkg.ok) {
    packageManager = await detectPackageManager(root, pkg.packageManager);
    for (const name of Object.keys(pkg.scripts)) {
      const command = `${packageManager} run ${name}`;
      const longRunning = LONG_RUNNING.test(name);
      const group = groupOf(name);
      candidates.push({
        key: `package.json:${name}`,
        source: 'package.json',
        label: `${packageManager}: ${name}`,
        command,
        hint: `package.json 的 scripts.${name}`,
        exists: alreadyExists(command, entries),
        preset: {
          // 长驻的那类顺手给一条就绪正则（大多数 dev server 会打一个地址），
          // 用户不要就删掉——表单里它是可见的，不是藏起来的行为。
          ...(longRunning
            ? { isBackground: true, readyPattern: DEFAULT_URL_PATTERN, openUrl: true, urlPattern: DEFAULT_URL_PATTERN }
            : {}),
          ...(group !== undefined ? { group } : {}),
        },
      });
    }
  } else if (pkg.warning !== undefined) {
    // 只有"文件在、但读不了/不是合法 JSON"才值得告警。
    // "没有 package.json" / "有文件但没有 scripts" 是**正常的空状态**，由界面说
    // 一句"没有可检测的 scripts"，不往告警里塞噪音。
    warnings.push(pkg.warning);
  }

  // 通用模板：与项目文件无关，用来兜住"目录里什么都没有"的情形。
  const templates: Array<Pick<DetectedTask, 'key' | 'label' | 'command' | 'hint' | 'preset'>> = [
    {
      key: 'template:python-http',
      label: 'Python 静态服务（8000）',
      command: 'python -m http.server 8000',
      hint: '不依赖项目文件；8000 被占用就改端口',
      preset: { isBackground: true, readyPattern: 'Serving HTTP on' },
    },
    {
      key: 'template:tsc-watch',
      label: 'TypeScript 监听编译',
      command: 'npx tsc --watch',
      hint: '需要项目里有 tsconfig.json',
      preset: { isBackground: true, readyPattern: 'Watching for file changes', group: 'build' },
    },
  ];
  for (const template of templates) {
    candidates.push({
      key: template.key,
      source: 'template',
      label: template.label,
      command: template.command,
      hint: template.hint,
      exists: alreadyExists(template.command, entries),
      preset: template.preset,
    });
  }

  return { ...(packageManager !== undefined ? { packageManager } : {}), candidates, warnings };
}
