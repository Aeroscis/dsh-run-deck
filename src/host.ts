/**
 * dsh-run-deck — host half（Cordis 插件入口）。
 *
 * 组成：
 *   - RunDeckManager : 清单加载、run 登记、浮动按钮视图
 *   - exec.ts        : 执行通道探测（终端路线，见那里的边界说明）
 *   - commands       : /run-deck list|run|stop|rerun|path|help
 *   - routes         : /dsh-run-deck/api/*（client half 的唯一数据通道）
 *
 * 依赖策略：**全部使用可选服务**（`ctx.get` + 缺失即降级），不 declare inject，
 * 这样任一服务缺失时插件仍能加载，并在 UI 里如实显示能力缺失，而不是静默不工作。
 */
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

import { createRunDeckCommand } from './commands.js';
import {
  buildLegacySchema,
  configFileIn,
  normalizeConfigInput,
  readConfigFile,
  SETTINGS_NAMESPACE,
  writeJsonAtomic,
} from './host-config.js';
import { API_PREFIX, createRoutes, type RouteHost } from './routes.js';
import { messageOf, openPathInFileManager } from './sessions.js';
import { registerRunDeckTool } from './tool.js';
import { RunDeckManager } from './manager.js';
import {
  ERROR_CODES,
  type ApiResult,
  type ConfigSource,
  type RunDeckConfig,
} from './types.js';

export const name = 'dsh-run-deck';

/**
 * 版本**现读 `package.json`**，不手写常量（手写的版本号一定会漂——
 * dsh-temptask 0.4.0 只改了 host 那一处、忘了客户端字面量，发布出去两半版本不一致）。
 * 两条路径（`lib/host.js` / `src/host.ts`）都落在包根。
 */
export const version = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/** 不声明硬依赖：所有服务都按可选处理（见文件头说明）。 */
export const inject: string[] = [];

/**
 * 插件自己的 Config schema —— 动态 import schemastery 而不是静态：
 * 新宿主的加载器会把它解析到运行时自带的那份，离线冒烟测试 / 旧宿主上取不到时
 * `Config` 为 undefined，插件照常加载并退化成「行配置 + config.json」。
 */
type SchemasteryFieldLike = {
  default(value: unknown): SchemasteryFieldLike;
  description(text: string): SchemasteryFieldLike;
  volatile?(): SchemasteryFieldLike;
};
type SchemasteryLike = { object(shape: Record<string, unknown>): unknown; string(): SchemasteryFieldLike };

const schemastery = await import('@deepseek-ai/schemastery')
  .then((module) => module.default as SchemasteryLike)
  .catch(() => undefined);

export const Config =
  schemastery === undefined
    ? undefined
    : schemastery.object({
        dataDir: schemastery
          .string()
          .default('')
          .description('插件数据目录；留空 = <DSH_HOME>/plugin-data/dsh-run-deck'),
        configPath: schemastery
          .string()
          .default('')
          .description('额外的 run.json 路径（没有固定项目根目录时用；留空 = 只从 DSH 工作区读）'),
      });

/**
 * 读一个配置字段：0.2.0-rc.1 起 volatile 字段交到插件手里的是**引用**（`{ get(), … }`），
 * 0.1.x 宿主给的是普通值；两种形态都要能吃下。
 */
export function readField(value: unknown): unknown {
  return value !== null &&
    typeof value === 'object' &&
    typeof (value as { get?: unknown }).get === 'function'
    ? (value as { get(): unknown }).get()
    : value;
}

/** 把行配置拍平成普通对象；类型收敛交给 normalizeConfigInput。 */
export function rowConfigNow(raw: unknown): Partial<RunDeckConfig> | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const fields = raw as Record<string, unknown>;
  return {
    dataDir: readField(fields['dataDir']) as string | undefined,
    configPath: readField(fields['configPath']) as string | undefined,
  };
}

/**
 * @param ctx Cordis 上下文。
 * @param config 插件行配置：新宿主上是**引用对象**（volatile 字段带 `.get()`），旧宿主上是普通对象。
 */
export function apply(ctx: DshContext, config?: unknown): void {
  const rowInput = config;
  const initialRowConfig = rowConfigNow(rowInput);

  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    const logger = ctx.logger;
    if (logger === undefined) return;
    const write = logger[level] ?? logger.info;
    try {
      write?.call(logger, `[dsh-run-deck] ${message}`);
    } catch {
      /* 日志失败绝不影响业务 */
    }
  };

  /* ── 配置状态（0.2.0 起字段是活引用：值在「读」的那一刻才取） ── */
  let currentConfig: RunDeckConfig = normalizeConfigInput(initialRowConfig);
  let currentSource: ConfigSource = initialRowConfig === undefined ? 'defaults' : 'cordis-row';
  let settingsScope: DshSettingsScope | undefined;
  let settingsReady = false;
  let fileConfig: Partial<RunDeckConfig> | undefined;

  function computeConfig(): RunDeckConfig {
    const row = rowConfigNow(rowInput) ?? {};
    const host = settingsScopeValue() ?? fileConfig;
    return normalizeConfigInput(host === undefined ? row : { ...row, ...host });
  }

  /* ── 持久化与业务核心 ── */
  const mounted = { webServer: false, commands: false };

  const manager = new RunDeckManager({
    ctx,
    version,
    config: () => currentConfig,
    configSource: () => currentSource,
    log,
  });

  /** 启动流程：先解析配置，再载入清单。 */
  const ready = (async (): Promise<void> => {
    try {
      await loadSettings();
    } catch (error) {
      log('warn', `settings 初始化失败，改用 config.json：${messageOf(error)}`);
    }
    if (!settingsReady) {
      try {
        await loadLocalConfig();
      } catch (error) {
        log('warn', `读取 config.json 失败：${messageOf(error)}`);
      }
    }
    currentConfig = computeConfig();
    currentSource = resolveSource();
    // 一行服务可用性诊断：本插件把依赖全按可选处理，于是"服务根本没在本 fiber
    // 的作用域里"与"服务在、只是返回空"在日志里长得一模一样。这一行把两者分开。
    // 注意：这是**初始化那一刻的快照**，不是"点击那一刻"的结论——MISSING 不代表
    // 后来不可用（服务常在这之后才物化）。
    log(
      'info',
      `服务可用性：${['workspaceRegistry', 'sessions', 'sessionController', 'subprocess', 'webServer', 'commands', 'tools', 'configEditor', 'clientModules']
        .map((serviceName) => `${serviceName}=${ctx.get(serviceName) === undefined ? 'MISSING' : 'ok'}`)
        .join(' ')}`,
    );
    // dataDir 建不起来不该拦住插件：浮动条要的按钮来自项目里的 run.json，
    // layout.json 只是个人覆盖。目录写不了就降级成"无覆盖"，功能照常。
    try {
      await mkdir(currentConfig.dataDir, { recursive: true });
    } catch (error) {
      manager.recordWarning(`插件数据目录不可用，本地覆盖将不生效：${messageOf(error)}`);
      log('warn', `mkdir ${currentConfig.dataDir} 失败：${messageOf(error)}`);
    }
    try {
      await manager.initialize();
      const projects = manager.listProjects();
      const entries = projects.reduce((sum, project) => sum + project.entries.length, 0);
      log(
        'info',
        `v${version} 已就绪：${projects.length} 个项目根目录、${entries} 个条目，配置来源 ${currentSource}`,
      );
    } catch (error) {
      const message = `插件初始化失败：${messageOf(error)}`;
      manager.recordWarning(message);
      log('error', message);
    }
  })();

  /** 重新读一遍配置（官方设置表单改了 Config 引用就走这里）。 */
  const refreshConfig = (): void => {
    const next = computeConfig();
    const dataChanged = next.dataDir !== currentConfig.dataDir;
    currentConfig = next;
    currentSource = resolveSource();
    if (dataChanged) {
      log('warn', `dataDir 已改为 ${next.dataDir}，需要重启 DSH 才会切换记录文件位置`);
    }
  };

  ctx.effect(
    () =>
      ctx.on('loader/volatile-update', () => {
        void ready.then(refreshConfig).catch((error: unknown) => {
          log('warn', `配置热更新处理失败：${messageOf(error)}`);
        });
      }),
    'dsh-run-deck: volatile config',
  );

  /* ── /run-deck 命令 ── */
  ctx.inject(['commands'], (sctx) => {
    const commands = sctx.get<DshCommandsService>('commands');
    if (commands === undefined) return;
    const dispose = commands.register(createRunDeckCommand({ manager, ready }));
    mounted.commands = true;
    log('info', '已注册 /run-deck 命令');
    sctx.effect(() => dispose, 'dsh-run-deck: /run-deck command');
  });

  /* ── run-deck 工具（第 4 步：外部按 id 调用）──
   * 与命令调同一个 manager，不另起一套逻辑。`@deepseek-ai/dsh-tools` 是可选依赖：
   * 拿不到时只少一个入口，插件的其余部分照常工作。 */
  ctx.inject(['tools'], (sctx) => {
    const tools = sctx.get<DshToolsService>('tools');
    if (tools === undefined) return;
    void registerRunDeckTool(sctx, manager, ready, (level, message) => log(level, message)).then(
      (result) => {
        if (result.mounted) return;
        log('warn', `run-deck 工具未注册：${result.reason ?? '原因未知'}`);
      },
    );
  });

  /* ── HTTP 桥（client half 的数据通道） ── */
  const routeHost: RouteHost = {
    manager,
    ready,
    trustedHosts: () => {
      const connection = ctx.get<{ trustedHosts?: unknown }>('connection');
      const hosts = connection?.trustedHosts;
      return Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === 'string') : [];
    },
    log,
  };

  ctx.inject(['webServer'], (sctx) => {
    const webServer = sctx.get<DshWebServerService>('webServer');
    if (webServer === undefined) return;
    const routes = createRoutes(routeHost);
    const disposers = routes.map((route) =>
      webServer.register({
        kind: 'exact',
        path: route.path,
        handler: (req, res) => route.handle(req, res),
      }),
    );
    log('info', `已挂载 ${routes.length} 条 HTTP 路由（${API_PREFIX}/*）`);
    mounted.webServer = true;
    sctx.effect(
      () => () => {
        for (const dispose of disposers) dispose();
      },
      'dsh-run-deck: http routes',
    );
  });

  /* ─────────────────────── 内部实现 ─────────────────────── */

  function settingsScopeValue(): Partial<RunDeckConfig> | undefined {
    if (settingsScope === undefined) return undefined;
    const value = settingsScope.get();
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<RunDeckConfig>)
      : undefined;
  }

  function resolveSource(): ConfigSource {
    if (settingsReady) return 'settings';
    if (fileConfig !== undefined) return 'config-file';
    if (ctx.get('configEditor') !== undefined) return 'plugin-config';
    return rowConfigNow(rowInput) === undefined ? 'defaults' : 'cordis-row';
  }

  /** 0.1.x 的 settings 命名空间（0.2.0-rc.1 已移除这套 API）。 */
  async function loadSettings(): Promise<void> {
    const settings = ctx.get<DshSettingsService>('settings');
    if (settings === undefined || typeof settings.register !== 'function') return;

    let settingsNamespace: ((namespace: string) => string) | undefined;
    let z: unknown;
    try {
      const settingsModule = await import('@deepseek-ai/dsh-settings');
      settingsNamespace = settingsModule.settingsNamespace;
      const schemaModule = await import('@deepseek-ai/schemastery');
      z = schemaModule.default;
    } catch (error) {
      log('warn', `缺少 @deepseek-ai/dsh-settings / schemastery，配置走 config.json：${messageOf(error)}`);
      return;
    }
    if (settingsNamespace === undefined || z === undefined) return;

    const scope = settings.register(
      settingsNamespace(SETTINGS_NAMESPACE),
      buildLegacySchema(z as Parameters<typeof buildLegacySchema>[0]),
      { base: rowConfigNow(rowInput) ?? {} },
    );
    settingsScope = scope;
    settingsReady = true;
    currentSource = 'settings';

    scope.watch(() => {
      try {
        currentConfig = computeConfig();
        currentSource = resolveSource();
        log('info', `配置已更新（settings）：${JSON.stringify(currentConfig)}`);
      } catch (error) {
        log('warn', `settings 变更处理失败：${messageOf(error)}`);
      }
    });
    ctx.effect(
      () => () => {
        settingsScope?.dispose?.();
      },
      'dsh-run-deck: settings scope',
    );
  }

  /** 降级配置：`<pluginDataDir>/config.json`。 */
  async function loadLocalConfig(): Promise<void> {
    const patch = await readConfigFile(configFileIn(currentConfig.dataDir));
    if (patch === undefined) return;
    fileConfig = patch;
    log('info', `已读取 config.json：${JSON.stringify(patch)}`);
  }

  /**
   * 写插件配置（保留给将来的设置卡；本版不暴露写入口，只在能力层留好通道）。
   *
   * 三条路按宿主能力选，与 dsh-temptask 一致：`configEditor.edit()` →
   * settings 命名空间（拒绝并指路）→ config.json 降级通道。
   */
  async function writeConfig(patch: Partial<RunDeckConfig>): Promise<ApiResult<{ config: RunDeckConfig }>> {
    if (settingsReady) {
      return {
        ok: false,
        code: ERROR_CODES.badRequest,
        message: '当前配置由 DSH settings 命名空间管理',
        hint: '请在「设置 → 插件」中修改。',
      };
    }

    const editor = ctx.get<DshConfigEditorService>('configEditor');
    const entry = ctx.fiber?.entry;
    if (editor !== undefined && typeof editor.edit === 'function' && entry !== undefined) {
      try {
        await editor.edit(entry, (current: unknown) => ({
          ...(current !== null && typeof current === 'object' ? (current as object) : {}),
          ...patch,
        }));
        refreshConfig();
        return { ok: true, config: currentConfig };
      } catch (error) {
        return { ok: false, code: ERROR_CODES.fs, message: '写入插件配置失败', hint: messageOf(error) };
      }
    }

    try {
      const file = configFileIn(currentConfig.dataDir);
      const existing = (await readConfigFile(file)) ?? {};
      const merged: Partial<RunDeckConfig> = { ...(rowConfigNow(rowInput) ?? {}), ...existing, ...patch };
      await writeJsonAtomic(file, merged);
      fileConfig = merged;
      currentConfig = computeConfig();
      currentSource = resolveSource();
      await manager.initialize();
      return { ok: true, config: currentConfig };
    } catch (error) {
      return { ok: false, code: ERROR_CODES.fs, message: '写入 config.json 失败', hint: messageOf(error) };
    }
  }

  /**
   * 写插件配置。本版**不**在路由里暴露它：配置写入走宿主自己的通道更安全，
   * 而本插件的配置只有两个路径类字段，没有需要从 UI 改的东西。
   * 保留它是为了让 settings 命名空间 / configEditor 两条路在需要时立刻可用。
   */
  void writeConfig;

  /**
   * 打开一个项目根目录（将来给设置卡 / 面板的「打开目录」用）。
   * 现在就把宿主能力的探测结果挂到 capabilities 上，UI 据此决定显示哪一行。
   */
  const openProjectRoot = async (path: string): Promise<{ opened: boolean; reason?: string }> => {
    const result = await openPathInFileManager(ctx, path);
    return result.opened ? { opened: true } : { opened: false, reason: result.reason };
  };
  void openProjectRoot;
}
export default { name, version, inject, Config, apply };
