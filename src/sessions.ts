/**
 * dsh-run-deck — 少量共用的运行时小工具。
 */

/** 从任意 thrown 值里取一句人能读的话。 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** 宿主桌面能否在文件管理器里打开路径。 */
export function canOpenPath(ctx: DshContext): boolean {
  const controller = ctx.get<DshSessionControllerService>('sessionController');
  if (typeof controller?.canOpenWorkspacePath === 'function') {
    try {
      return controller.canOpenWorkspacePath();
    } catch {
      return false;
    }
  }
  const openPath = ctx.get<DshOpenPathService>('openPath');
  if (typeof openPath?.canOpenPath === 'function') {
    try {
      return openPath.canOpenPath();
    } catch {
      return false;
    }
  }
  return false;
}

/** 在宿主文件管理器里打开一个路径（能力不足时返回 opened:false + 原因）。 */
export async function openPathInFileManager(
  ctx: DshContext,
  path: string,
): Promise<{ opened: boolean; reason?: string }> {
  const controller = ctx.get<DshSessionControllerService>('sessionController');
  if (typeof controller?.openWorkspacePath === 'function') {
    try {
      const result = await controller.openWorkspacePath({ path });
      return { opened: result.opened };
    } catch (error) {
      return { opened: false, reason: messageOf(error) };
    }
  }
  const openPath = ctx.get<DshOpenPathService>('openPath');
  if (typeof openPath?.openPath === 'function') {
    try {
      const result = await openPath.openPath({ path });
      return { opened: result.opened };
    } catch (error) {
      return { opened: false, reason: messageOf(error) };
    }
  }
  return { opened: false, reason: '宿主没有提供打开路径的能力' };
}

/**
 * 打开一个**地址**这件事**不在宿主侧做**（原先的 `openUrlExternally` 已删）。
 *
 * 实测：桌面版组合里 `ctx.openPath` 服务不存在，`sessionController.openWorkspacePath`
 * 要的是**工作区内**的路径（`http://…` 不是它的东西），所以宿主这边没有任何可用入口。
 * 界面侧的 `window.open(url, '_blank')` 会被桌面壳的 `setWindowOpenHandler` 接住
 * （`electron-runtime` 实测 `shell.openExternal(target.href)` → 系统默认浏览器），
 * Web 版也天然成立。所以 `serverReadyAction` 的地址由 client half 打开，
 * 见 `src/client.tsx` 的 `openReadyUrl()`。
 */
