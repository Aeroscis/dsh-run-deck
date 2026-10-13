/**
 * dsh-rundeck — 机器本地的个人覆盖（不进仓库）。
 *
 * 存什么：浮动按钮的**布局**——钉不钉、排序、分组、图标、标题。
 * 与 run.json 的分工：run.json 是"这个项目有什么"，本地覆盖是"我怎么看它"。
 * 删掉本地覆盖文件，一切照常，只是浮动层退回 run.json 的原始声明。
 *
 * 为什么不做成"完整的 run.json 副本"：那样两份清单会漂——改一个字段要在两处同步，
 * 而本地那份迟早过期。只覆盖展示层，配置层永远只有项目里那一份真相。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ButtonDensity, ButtonOverride, LocalLayout } from './types.js';

/** 覆盖文件：`<pluginDataDir>/layout.json`。 */
export const LAYOUT_FILE_NAME = 'layout.json';

export function layoutFileIn(dataDir: string): string {
  const trimmed = dataDir.trim();
  const base = trimmed.length > 0 ? trimmed : '.';
  return `${base}/${LAYOUT_FILE_NAME}`;
}

export function emptyLayout(): LocalLayout {
  return { buttons: {} };
}

/** 收敛读到的 JSON：任何形状问题都当"没有覆盖"处理，绝不让坏文件卡住启动。 */
export function coerceLayout(raw: unknown): LocalLayout {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { buttons: {} };
  const record = raw as Record<string, unknown>;
  const density = pickDensityText(record['density']);
  const buttonsRaw = record['buttons'];
  if (buttonsRaw === null || typeof buttonsRaw !== 'object' || Array.isArray(buttonsRaw)) {
    return { buttons: {}, ...(density !== undefined ? { density } : {}) };
  }
  const buttons: Record<string, ButtonOverride> = {};
  for (const [key, value] of Object.entries(buttonsRaw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    buttons[key] = {
      ...(typeof item['pinned'] === 'boolean' ? { pinned: item['pinned'] } : {}),
      ...(typeof item['order'] === 'number' ? { order: item['order'] } : {}),
      ...(typeof item['group'] === 'string' ? { group: item['group'] } : {}),
      ...(typeof item['label'] === 'string' ? { label: item['label'] } : {}),
      ...(typeof item['icon'] === 'string' ? { icon: item['icon'] } : {}),
    };
  }
  return { buttons, ...(density !== undefined ? { density } : {}) };
}

/** 只认三个合法密度值；别的一律当没写（坏文件不让它影响行为）。 */
function pickDensityText(value: unknown): ButtonDensity | undefined {
  return value === 'full' || value === 'compact' || value === 'icon' ? value : undefined;
}

/** 读覆盖文件；不存在 = 空覆盖（正常情况，不是错误）。 */

/** 读覆盖文件；不存在 = 空覆盖（正常情况，不是错误）。 */
export async function readLayout(file: string): Promise<LocalLayout> {
  try {
    const text = await readFile(file, 'utf8');
    return coerceLayout(JSON.parse(text));
  } catch {
    return emptyLayout();
  }
}

/** 原子写覆盖文件（先写 .tmp 再 rename，避免半截文件）。 */
export async function writeLayout(file: string, layout: LocalLayout): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(layout, null, 2)}\n`, 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(temp, file);
}

/**
 * 合并 run.json 的 buttons[] 与本地覆盖。
 *
 * 规则：**本地覆盖只影响展示，不创造新的执行能力**。
 * 一个 entry 无论本地怎么覆盖，它对应的命令永远来自 run.json 的那一条；
 * 因此 `pinned: false` 只是"我不看它"，不是一个新的东西。
 */
export function effectiveButtons(
  declared: Array<{ entry: string; icon?: string; group?: string; label?: string; order?: number }>,
  layout: LocalLayout,
): Array<{ entry: string; icon: string; group: string; label?: string; order: number }> {
  const out: Array<{ entry: string; icon: string; group: string; label?: string; order: number }> =
    [];
  for (const button of declared) {
    const override = layout.buttons[button.entry] ?? {};
    if (override.pinned === false) continue;
    out.push({
      entry: button.entry,
      icon: override.icon ?? button.icon ?? 'play',
      group: override.group ?? button.group ?? 'default',
      ...(override.label ?? button.label !== undefined ? { label: override.label ?? button.label } : {}),
      order: override.order ?? button.order ?? 100,
    });
  }
  return out.sort((left, right) => left.order - right.order);
}
