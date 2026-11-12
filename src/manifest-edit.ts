/**
 * dsh-run-deck — 把"界面新建的启动项"写回项目的 `.dsh/run-deck/run.json`。
 *
 * ## 为什么允许界面写清单，却仍禁止本地布局存命令
 *
 * 这两件事看起来像一件事，实际是两件事：
 *
 *   - `layout.json`（本地覆盖）**不是清单**，它只是"我怎么看这个项目"。如果允许它
 *     存 command，就会出现"同一条按钮在两台机器上跑不同的命令""删了清单文件命令
 *     还在"这类事故——执行能力必须只有一个来源。
 *   - 界面写 `run.json` 则是**编辑同一个源文件**：和手改完全等价，别人 clone 下来
 *     看到的也是同一条 task，`git diff` 里也看得见。
 *
 * 所以界面新建条目 = 真的往 `tasks[]` 里加一条，界面上的按钮只是它的展示。
 *
 * ## 为什么是文本插入而不是"解析成对象再整体重写"
 *
 * `run.json` 允许注释（本仓库自己的清单就全是注释）。先 parse 再
 * `JSON.stringify` 会把注释、缩进、字段顺序全部抹掉——用户下次打开文件会发现
 * 自己写的东西被重排了。这里只做**最小文本插入**：找到 `tasks` 数组，在末尾
 * 补一个元素，其余字节原样保留。
 *
 * 插入后一律重新解析校验（解析不过就换一个插入点重试，仍不过就报错，绝不落盘）。
 */
import { deriveId } from './config.js';
import { stripJsonComments } from './projects.js';
import type { TaskEntry } from './types.js';

/* ─────────────────────────── 命令行拆分 ─────────────────────────── */

export type CommandLineSplit =
  | { ok: true; tokens: string[] }
  | { ok: false; message: string };

/**
 * 把界面上那一行命令拆成 `command` + `args`。
 *
 * 为什么不直接把整行塞进 `command`：`renderCommandLine()` 会给"含空白的片段"
 * 加引号，`command = "npm run dev"` 会被拼成 `"npm run dev"`，交给 `sh -c`
 * 就变成"找一个名叫 npm run dev 的可执行文件"。拆开之后 `npm` + `[run, dev]`
 * 拼回去才是 `npm run dev`。
 *
 * 支持双引号、单引号、反斜杠转义（只在双引号里）。
 */
export function splitCommandLine(line: string): CommandLineSplit {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  const flush = (): void => {
    if (started) {
      tokens.push(current);
      current = '';
      started = false;
    }
  };

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (quote !== null) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === '\\' && quote === '"' && index + 1 < line.length) {
        current += line[index + 1] ?? '';
        index += 1;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      flush();
      continue;
    }
    current += char;
    started = true;
  }

  if (quote !== null) return { ok: false, message: `命令里的 ${quote} 没有闭合` };
  flush();
  return { ok: true, tokens };
}

/* ─────────────────────────── JSONC 扫描 ─────────────────────────── */

/** 跳过一段字符串（`start` 指向开头的引号），返回闭引号之后的位置。 */
function skipString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }
  return text.length;
}

/** 跳过空白与注释，返回下一个有效字符的位置。 */
function skipTrivia(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index);
      index = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close < 0 ? text.length : close + 2;
      continue;
    }
    return index;
  }
  return index;
}

function unescapeKey(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * 跳过一段容器（`open`/`close` 同类型括号），返回闭括号**之后**的位置。
 * 只数同类型括号就够了：合法 JSON 里同类型括号必然正确嵌套，而字符串里的
 * 括号已经被 `skipString` 吃掉了。
 */
function skipContainer(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    index = skipTrivia(text, index);
    if (index >= text.length) return text.length;
    const char = text[index] as string;
    if (char === '"') {
      index = skipString(text, index);
      continue;
    }
    if (char === open) {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === close) {
      depth -= 1;
      index += 1;
      if (depth === 0) return index;
      continue;
    }
    index += 1;
  }
  return text.length;
}

/** 跳过一段值（对象/数组/字符串/标量），返回它结束后的位置。 */
function skipValue(text: string, start: number): number {
  const index = skipTrivia(text, start);
  const char = text[index];
  if (char === '"') return skipString(text, index);
  if (char === '{') return skipContainer(text, index, '{', '}');
  if (char === '[') return skipContainer(text, index, '[', ']');
  let cursor = index;
  while (cursor < text.length) {
    const current = text[cursor] as string;
    if (current === ',' || current === '}' || current === ']') return cursor;
    const next = skipTrivia(text, cursor);
    if (next !== cursor) return next;
    cursor += 1;
  }
  return cursor;
}

/** 找根对象里某个 key 对应的数组，返回 `[` 与 `]` 的位置（找不到返回 null）。 */
export function findTopLevelArray(text: string, key: string): { start: number; end: number } | null {
  let index = skipTrivia(text, 0);
  if (text[index] !== '{') return null;
  index += 1;
  while (index < text.length) {
    index = skipTrivia(text, index);
    const char = text[index];
    if (char === undefined || char === '}') return null;
    if (char !== '"') {
      index += 1;
      continue;
    }
    const keyEnd = skipString(text, index);
    const name = unescapeKey(text.slice(index + 1, keyEnd - 1));
    index = skipTrivia(text, keyEnd);
    if (text[index] !== ':') {
      index += 1;
      continue;
    }
    index = skipTrivia(text, index + 1);
    if (name === key && text[index] === '[') {
      const after = skipContainer(text, index, '[', ']');
      return { start: index, end: after - 1 };
    }
    index = skipValue(text, index);
  }
  return null;
}

/* ─────────────────────────── 插入 ─────────────────────────── */

/** 解析出来的 tasks 条数；解析失败返回 -1。 */
export function countManifestTasks(text: string): number {
  try {
    const parsed = JSON.parse(stripJsonComments(text)) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return -1;
    const tasks = (parsed as Record<string, unknown>)['tasks'];
    return Array.isArray(tasks) ? tasks.length : 0;
  } catch {
    return -1;
  }
}

/** `position` 所在行的行首缩进。 */
function lineIndentOf(text: string, position: number): string {
  const lineStart = text.lastIndexOf('\n', position) + 1;
  const prefix = text.slice(lineStart, position);
  const match = /^[ \t]*/u.exec(prefix);
  return match === null ? '' : match[0];
}

/** 数组内部第一个元素所在的缩进；探不到就用两个空格。 */
function detectIndent(text: string, arrayStart: number): string {
  const newline = text.indexOf('\n', arrayStart);
  if (newline < 0) return '  ';
  const lineEnd = text.indexOf('\n', newline + 1);
  const line = text.slice(newline + 1, lineEnd < 0 ? text.length : lineEnd);
  const match = /^[ \t]+(?=\S)/u.exec(line);
  return match === null ? '  ' : match[0];
}

export type InsertTaskResult = { ok: true; text: string } | { ok: false; message: string };

/** 按清单里常见的手写风格渲染一条 task（与人手写的排版保持一致）。 */
function renderTask(task: TaskEntry, indent: string): string {
  // 字段顺序照手写习惯：身份在前，行为在后。
  const fields: string[] = [`"label": ${JSON.stringify(task.label)}`];
  if (task.id !== undefined) fields.push(`"id": ${JSON.stringify(task.id)}`);
  fields.push(`"command": ${JSON.stringify(task.command)}`);
  if (task.args !== undefined && task.args.length > 0) {
    fields.push(`"args": [${task.args.map((arg) => JSON.stringify(arg)).join(', ')}]`);
  }
  if (task.options !== undefined && (task.options.cwd !== undefined || task.options.env !== undefined)) {
    const options: Record<string, unknown> = {};
    if (task.options.cwd !== undefined) options['cwd'] = task.options.cwd;
    if (task.options.env !== undefined) options['env'] = task.options.env;
    fields.push(`"options": ${JSON.stringify(options)}`);
  }
  if (task.isBackground === true) fields.push(`"isBackground": true`);
  if (task.problemMatcher !== undefined) {
    fields.push(`"problemMatcher": ${JSON.stringify(task.problemMatcher)}`);
  }
  if (task.serverReadyAction !== undefined) {
    fields.push(`"serverReadyAction": ${JSON.stringify(task.serverReadyAction)}`);
  }
  if (task.presentation !== undefined) {
    fields.push(`"presentation": ${JSON.stringify(task.presentation)}`);
  }
  if (task.group !== undefined && task.group !== 'none') {
    fields.push(`"group": ${JSON.stringify(task.group)}`);
  }
  if (task.runOptions !== undefined) {
    fields.push(`"runOptions": ${JSON.stringify(task.runOptions)}`);
  }
  if (task.onReady !== undefined) fields.push(`"onReady": ${JSON.stringify(task.onReady)}`);

  // 只有 label/id/command/args 的条目仍然是一行——与手写的简版条目一致。
  // 一旦带上 options / 就绪正则这些"长字段"，一行会横到屏幕外，改成一字段一行。
  const oneLine = `{ ${fields.join(', ')} }`;
  if (fields.length <= 4 && oneLine.length <= 96) return oneLine;
  const inner = `${indent}  `;
  return `{\n${fields.map((field) => `${inner}${field}`).join(',\n')}\n${indent}}`;
}

/**
 * 在清单文本里追加一条 task，其余内容（注释、缩进、字段顺序）原样保留。
 *
 * 会尝试若干种插入点，取**第一个仍然能解析且 tasks 数量正好 +1** 的结果；
 * 全都不成就返回错误，调用方不得落盘。
 */
export function insertTaskIntoManifestText(text: string, task: TaskEntry): InsertTaskResult {
  const expected = countManifestTasks(text);
  if (expected < 0) return { ok: false, message: '.dsh/run-deck/run.json 现在就不是合法 JSON，先修好它' };
  const range = findTopLevelArray(text, 'tasks');
  const candidates: string[] = [];

  if (range !== null) {
    const indent = detectIndent(text, range.start);
    const closingIndent = lineIndentOf(text, range.start);
    const rendered = renderTask(task, indent);
    const inner = text.slice(range.start + 1, range.end);
    const blank = stripJsonComments(inner).trim().length === 0;

    if (blank) {
      candidates.push(
        `${text.slice(0, range.start + 1)}\n${indent}${rendered}\n${closingIndent}${text.slice(range.end)}`,
      );
    } else {
      // ① 末尾追加：`]` 前的空白先收掉，再在最后一个元素后补逗号。
      const trimmedBefore = text.slice(0, range.end).replace(/\s+$/u, '');
      candidates.push(
        `${trimmedBefore},\n${indent}${rendered}\n${closingIndent}${text.slice(range.end)}`,
      );
      // ② 末尾可能挂着行注释（收空白会把逗号卷进注释里），退到数组最前面插。
      candidates.push(
        `${text.slice(0, range.start + 1)}\n${indent}${rendered},\n${indent}${text.slice(range.start + 1)}`,
      );
    }
  } else {
    // 整份清单还没有 tasks 键：插到根对象最前面。
    const open = skipTrivia(text, 0);
    if (text[open] !== '{') return { ok: false, message: '.dsh/run-deck/run.json 顶层不是一个对象' };
    const rendered = renderTask(task, '    ');
    const rest = text.slice(open + 1);
    const emptyObject = stripJsonComments(rest).replace(/[\s}]/gu, '').length === 0;
    candidates.push(
      `${text.slice(0, open + 1)}\n  "tasks": [\n    ${rendered}\n  ]${emptyObject ? '' : ','}${rest}`,
    );
  }

  for (const candidate of candidates) {
    if (countManifestTasks(candidate) === expected + 1) return { ok: true, text: candidate };
  }
  return {
    ok: false,
    message: '没找到能安全插入的位置（清单结构比预期的复杂），请手动编辑 .dsh/run-deck/run.json',
  };
}

/* ─────────────────────────── 删除 ─────────────────────────── */

/** 数组里一个元素的文本范围（`[start, end)`，不含两侧的逗号与空白）。 */
export interface ArrayElementRange {
  start: number;
  end: number;
}

/** 把数组内部的元素按文本范围切出来（跳过字符串/注释/嵌套）。 */
export function arrayElementRanges(
  text: string,
  start: number,
  end: number,
): ArrayElementRange[] {
  const ranges: ArrayElementRange[] = [];
  let index = start + 1;
  while (index < end) {
    index = skipTrivia(text, index);
    if (index >= end) break;
    if (text[index] === ']') break;
    const elementStart = index;
    const elementEnd = skipValue(text, index);
    if (elementEnd <= elementStart) break;
    ranges.push({ start: elementStart, end: elementEnd });
    index = skipTrivia(text, elementEnd);
    if (text[index] === ',') index += 1;
  }
  return ranges;
}

/**
 * 从数组里删掉第 `index` 个元素，返回新文本。
 *
 * 逗号必须跟着一起处理，否则会留下 `[,` / `,,` 这类坏 JSON：
 *   - 只有一个元素：直接删元素本身；
 *   - 第一个：删到第二个元素的起点（把元素后面的逗号一起吃掉）；
 *   - 其余：从上一个元素末尾删到本元素末尾（把本元素前面的逗号一起吃掉）。
 */
export function removeArrayElementAt(
  text: string,
  ranges: ArrayElementRange[],
  index: number,
): string {
  const target = ranges[index];
  if (target === undefined) return text;
  if (ranges.length === 1) {
    return text.slice(0, target.start) + text.slice(target.end);
  }
  if (index === 0) {
    const next = ranges[1] as ArrayElementRange;
    return text.slice(0, target.start) + text.slice(next.start);
  }
  const previous = ranges[index - 1] as ArrayElementRange;
  return text.slice(0, previous.end) + text.slice(target.end);
}

/** 把一个元素文本解析成对象（解析不了返回 undefined）。 */
function parseElementObject(slice: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(stripJsonComments(slice)) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 在 tasks[] 的元素范围里定位"界面看到的 id"对应的那一个元素。
 *
 * 按"解析后的 id"匹配：与 resolveEntries() 的规则**逐字对齐**——
 *   有显式 id：未被占用用显式 id；被占用时从 **id 串**派生（`${entry.id}`）；
 *   没有显式 id：从 label 派生。
 * 早先这里冲突兜底走的是 label，清单里出现两条相同显式 id 时，
 * "界面看到的 id"和这里的定位就会分叉 → 删错或删不到。
 */
function locateTaskElement(
  text: string,
  taskRanges: ArrayElementRange[],
  entryId: string,
): number {
  const taken = new Set<string>();
  for (let index = 0; index < taskRanges.length; index += 1) {
    const range = taskRanges[index] as ArrayElementRange;
    const element = parseElementObject(text.slice(range.start, range.end));
    if (element === undefined) continue;
    const explicit = typeof element['id'] === 'string' && element['id'].length > 0 ? element['id'] : undefined;
    const label = typeof element['label'] === 'string' ? element['label'] : '';
    const id =
      explicit !== undefined && !taken.has(explicit)
        ? explicit
        : explicit !== undefined
          ? deriveId(explicit, taken)
          : deriveId(label || 'task', taken);
    taken.add(id);
    if (id === entryId) return index;
  }
  return -1;
}

export type RemoveTaskResult = { ok: true; text: string; entry: string } | { ok: false; message: string };

/**
 * 从清单文本里删掉一条 task（按**解析后的 id** 定位，和界面看到的条目一致）。
 *
 * 同时清掉 `buttons[]` 里指向它的那条声明——否则清单里会留下一个悬空按钮，
 * 每次刷新都报"buttons[] 指向不存在的条目"。
 *
 * 删除后重新解析校验（tasks 数量必须正好 -1），不过就报错、由调用方放弃落盘。
 */
export function removeTaskFromManifestText(text: string, entryId: string): RemoveTaskResult {
  const expected = countManifestTasks(text);
  if (expected < 0) return { ok: false, message: '.dsh/run-deck/run.json 现在就不是合法 JSON，先修好它' };

  const tasksRange = findTopLevelArray(text, 'tasks');
  if (tasksRange === null) return { ok: false, message: '清单里没有 tasks[]' };
  const taskRanges = arrayElementRanges(text, tasksRange.start, tasksRange.end);

  const target = locateTaskElement(text, taskRanges, entryId);
  if (target < 0) return { ok: false, message: `清单里找不到 id 为 ${entryId} 的任务` };

  let next = removeArrayElementAt(text, taskRanges, target);
  if (countManifestTasks(next) !== expected - 1) {
    return { ok: false, message: '删除后清单校验失败，已放弃写入' };
  }

  // 顺手清掉 buttons[] 里指向它的声明（重新定位，因为上面的删除已经改变了偏移）。
  const buttonsRange = findTopLevelArray(next, 'buttons');
  if (buttonsRange !== null) {
    const buttonRanges = arrayElementRanges(next, buttonsRange.start, buttonsRange.end);
    const dangling = buttonRanges.findIndex((range) => {
      const element = parseElementObject(next.slice(range.start, range.end));
      return element !== undefined && element['entry'] === entryId;
    });
    if (dangling >= 0) {
      const trimmed = removeArrayElementAt(next, buttonRanges, dangling);
      // buttons 清不掉也不该让整次删除失败（顶多多一条告警），但改了就必须能解析。
      if (countManifestTasks(trimmed) === expected - 1) next = trimmed;
    }
  }

  return { ok: true, text: next, entry: entryId };
}

/* ─────────────────────────── 替换（编辑） ─────────────────────────── */

export type ReplaceTaskResult = { ok: true; text: string; entry: string } | { ok: false; message: string };

/**
 * 在清单文本里**原位替换**一条 task（按解析后的 id 定位），其余内容原样保留。
 *
 * 与删除共用同一套定位（`locateTaskElement`），与插入共用同一套渲染
 * （`renderTask`）：新条目的排版和"手写一条再让界面替换"完全一致。
 *
 * 定位按**旧文本**做、渲染按**新条目**做，所以这天然也覆盖"改了 id / label"的
 * 情况——旧 id 找得到位置，新 id 写进替换后的文本。数量校验是**不变**（正好 0），
 * 不过就报错、由调用方放弃落盘。
 *
 * buttons[] 不用动：按钮声明的是 entry id，编辑不删除条目；id 真被改掉时
 * manager 层会把本机布局里的旧键搬到新键（`updateTask`），清单里的
 * `buttons[].entry` 也按同样的映射改写——这是替换之后单独的一小步。
 */
export function replaceTaskInManifestText(
  text: string,
  entryId: string,
  task: TaskEntry,
): ReplaceTaskResult {
  const expected = countManifestTasks(text);
  if (expected < 0) return { ok: false, message: '.dsh/run-deck/run.json 现在就不是合法 JSON，先修好它' };

  const tasksRange = findTopLevelArray(text, 'tasks');
  if (tasksRange === null) return { ok: false, message: '清单里没有 tasks[]' };
  const taskRanges = arrayElementRanges(text, tasksRange.start, tasksRange.end);

  const target = locateTaskElement(text, taskRanges, entryId);
  if (target < 0) return { ok: false, message: `清单里找不到 id 为 ${entryId} 的任务` };

  // 用**被替换元素自己的缩进**渲染新条目：多字段条目本来就一字段一行，
  // 行首空白照旧，替换完清单的整体排版不变。
  const range = taskRanges[target] as ArrayElementRange;
  const indent = lineIndentOf(text, range.start);
  const rendered = renderTask(task, indent);
  const next = text.slice(0, range.start) + rendered + text.slice(range.end);
  const counted = countManifestTasks(next);
  if (counted !== expected) {
    return { ok: false, message: '替换后清单校验失败，已放弃写入' };
  }
  return { ok: true, text: next, entry: task.id ?? entryId };
}

/** 把 buttons[] 里指向 `from` 的声明改指 `to`（id 被改名时用；没有就原样返回）。 */
export function retargetButtonsInManifestText(text: string, from: string, to: string): string {
  const buttonsRange = findTopLevelArray(text, 'buttons');
  if (buttonsRange === null) return text;
  const buttonRanges = arrayElementRanges(text, buttonsRange.start, buttonsRange.end);
  let next = text;
  let changed = false;
  // 从后往前替换：前面的偏移不因前面的替换而失效。
  for (let index = buttonRanges.length - 1; index >= 0; index -= 1) {
    const range = buttonRanges[index] as ArrayElementRange;
    const element = parseElementObject(next.slice(range.start, range.end));
    if (element === undefined || element['entry'] !== from) continue;
    const rendered = JSON.stringify({ ...element, entry: to });
    next = next.slice(0, range.start) + rendered + next.slice(range.end);
    changed = true;
  }
  if (!changed) return text;
  // 改完必须仍是同一份合法清单（元素数不变），否则整个退回。
  return countManifestTasks(next) === countManifestTasks(text) ? next : text;
}

