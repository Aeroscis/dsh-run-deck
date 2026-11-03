/**
 * dsh-run-deck — 插件配置。
 *
 * 与其它字段一样按宿主能力分层：0.2.0-rc.1 起是插件自己的 Config schema
 * （官方「设置 → 插件」表单），0.1.x 是 settings 命名空间，都没有就退回
 * `<pluginDataDir>/config.json`。三层写的是同一处，读的时候以最高层为准。
 *
 * `RunDeckConfig` 的类型定义在 types.ts（host/client 共享）；本文件只管它的
 * 归一化与读写。这样 client 也能引用同一个 shape，不会出现两份漂移的定义。
 */
import { join } from 'node:path';

import type { RunDeckConfig } from './types.js';

export type { RunDeckConfig };

export const DEFAULTS: RunDeckConfig = {
  dataDir: '',
  configPath: '',
};

/**
 * 把任意输入收敛成配置；认不出来的字段一律回默认值。
 *
 * `dataDir` 在这里就解析成**真实路径**（而不是留着 `''` 让各处判空）——
 * 下游的 `mkdir` / `layout.json` / `/state` 因此永远拿到能用的值。
 */
export function normalizeConfigInput(raw: unknown): RunDeckConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { dataDir: defaultDataDir(), configPath: '' };
  }
  const record = raw as Record<string, unknown>;
  const dataDir = typeof record['dataDir'] === 'string' ? record['dataDir'] : '';
  const configPath = typeof record['configPath'] === 'string' ? record['configPath'] : '';
  return { dataDir: resolveDataDir(dataDir), configPath };
}

/**
 * `dataDir` 的默认落点：`<DSH_HOME>/plugin-data/dsh-run-deck`。
 *
 * **不能是 `''`，也不能是 `.`**：`''` 会让 `mkdir('')` 抛 ENOENT（插件整个初始化失败），
 * 而 `.` 是 host 进程的 CWD——那是 DSH 的安装目录，往里面写个人覆盖文件是错的。
 * 空字符串在配置里的语义是"用默认值"，所以这里负责把它变成真路径。
 */
export function resolveDataDir(dataDir: string): string {
  const trimmed = dataDir.trim();
  if (trimmed.length > 0) return trimmed;
  return defaultDataDir();
}

/** `<DSH_HOME>/plugin-data/dsh-run-deck`；拿不到 HOME 时退回进程 CWD 下的子目录。 */
export function defaultDataDir(): string {
  // `DSH_HOME` 本身就是那个 home 目录（本机是 <user>\.dsh），**不要再拼一层 .dsh**；
  // 拼了就变成 .dsh\.dsh\plugin-data\...。
  const home = firstEnv('DSH_HOME') ?? firstEnv('DSH_PROFILE_DIR');
  if (home !== undefined) return join(home, 'plugin-data', 'dsh-run-deck');
  // 没有 HOME 线索时才退回用户目录下的 .dsh，最后才是 CWD。
  const user = firstEnv('USERPROFILE') ?? firstEnv('HOME');
  if (user !== undefined) return join(user, '.dsh', 'plugin-data', 'dsh-run-deck');
  return join(process.cwd(), 'plugin-data', 'dsh-run-deck');
}

/** 取第一个非空环境变量；`''` 与纯空白都当没设（`''` 会把 join 变成空路径）。 */
function firstEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** 记录文件的落点。 */
export function dataFileIn(dataDir: string): string {
  return join(resolveDataDir(dataDir), 'layout.json');
}

/** settings namespace（0.1.x）。 */
export const SETTINGS_NAMESPACE = 'dsh-run-deck';

/**
 * schemastery 的最小可用面。
 *
 * 之所以自己声明而不用 `import type`：schemastery 在 dsh.d.ts 里也声明了一份,
 * 但那份是给 `declare module` 用的运行时形状；这里只需要**编译期**能调链式方法。
 */
export interface SchemasteryFieldLike {
  default(value: unknown): SchemasteryFieldLike;
  description(text: string): SchemasteryFieldLike;
  volatile?(): SchemasteryFieldLike;
}
export interface SchemasteryLike {
  object(shape: Record<string, unknown>): unknown;
  string(): SchemasteryFieldLike;
}

/** 插件自己的 Config schema 字段（0.2.0-rc.1 起的设置表单按它渲染）。 */
export function buildPluginConfigFields(z: SchemasteryLike): Record<string, unknown> {
  return {
    dataDir: z
      .string()
      .default('')
      .description('插件数据目录；留空 = <DSH_HOME>/plugin-data/dsh-run-deck'),
    configPath: z
      .string()
      .default('')
      .description('额外的 run.json 路径（没有固定项目根目录时用；留空 = 只从 DSH 工作区读）'),
  };
}

/** 0.1.x 的 settings 命名空间 schema（同样的两个字段）。 */
export function buildLegacySchema(z: SchemasteryLike): unknown {
  return z.object(buildPluginConfigFields(z));
}

/** 原子写 JSON（先 .tmp 再 rename）。 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const { mkdir, rename, writeFile } = await import('node:fs/promises');
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(`${file}.tmp`, file);
}

/** 读 config.json 补丁；不存在 / 坏了都是 undefined。 */
export async function readConfigFile(file: string): Promise<Partial<RunDeckConfig> | undefined> {
  try {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(text);
    return normalizeConfigInput(parsed) as Partial<RunDeckConfig>;
  } catch {
    return undefined;
  }
}

export function configFileIn(dataDir: string): string {
  return join(dataDir.trim().length > 0 ? dataDir : '.', 'config.json');
}
