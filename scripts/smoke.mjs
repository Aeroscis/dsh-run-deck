/**
 * dsh-run-deck — 离线冒烟测试（host half）。
 *
 * 不起 DSH、不接浏览器，只验证四件能在进程里直接验的事：
 *   1. run.json 的读取与收敛（stripJsonComments / coerceDocument / resolveEntries）
 *   2. ${input} / ${workspaceFolder} / ${env} 的展开
 *   3. 就绪 pattern 匹配与不可编译 pattern 的降级
 *   4. 事件钩子（beginsPattern / endsPattern / serverReadyAction / onReady）的语义
 *
 * 运行：`node scripts/smoke.mjs`（与 `npm run smoke:host` 等同）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { coerceDocument, resolveEntries, stripJsonComments, loadProject } = await import(
  new URL('../lib/projects.js', import.meta.url)
);
const { expandVariables } = await import(new URL('../lib/config.js', import.meta.url));
const { matchReady, renderCommandLine } = await import(new URL('../lib/exec.js', import.meta.url));
const { resolveServerReady, resolveOnReady, wouldCycle, initialHookState, observeLine } =
  await import(new URL('../lib/hooks.js', import.meta.url));
const { dispatchToolArgs, createToolEntry, TOOL_NAME } = await import(new URL('../lib/tool.js', import.meta.url));
const { readLayout, writeLayout, effectiveButtons, coerceLayout } = await import(
  new URL('../lib/store.js', import.meta.url)
);
const { splitCommandLine, insertTaskIntoManifestText, removeTaskFromManifestText } = await import(
  new URL('../lib/manifest-edit.js', import.meta.url)
);

let passed = 0;
let failed = 0;
async function check(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log('dsh-run-deck host smoke');

/* ── stripJsonComments ── */

await check('剥掉行注释', () => {
  assert.equal(stripJsonComments('{\n // hi\n "a": 1\n}').trim(), '{\n \n "a": 1\n}'.trim());
});

await check('字符串里的 // 不动', () => {
  assert.equal(stripJsonComments('{"u": "http://x"}').trim(), '{"u": "http://x"}');
});

await check('块注释剥掉', () => {
  assert.equal(stripJsonComments('{"a":1 /* two */ }').replaceAll(' ', ''), '{"a":1}');
});

/* ── coerceDocument ── */

await check('缺 label/command 的条目被丢掉并记告警', () => {
  const { document, warnings } = coerceDocument({
    tasks: [
      { label: 'ok', command: 'python' },
      { command: 'orphan' },
      { label: 'no-command' },
      'not even an object',
    ],
  });
  assert.equal(document.tasks.length, 1);
  assert.equal(document.tasks[0]?.label, 'ok');
  // 三条坏条目各留一句告警，且都能看出是哪一条（无 label 的显式写出「(无 label)」）
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((warning) => warning.includes('(无 label)')));
  assert.ok(warnings.some((warning) => warning.includes('no-command')));
  // 一条能跑的都不许被丢
  assert.equal(document.tasks.some((entry) => entry.label === 'ok'), true);
});

await check('tasks 不是数组时告警而不是抛错', () => {
  const { document, warnings } = coerceDocument({ tasks: 'nope' });
  assert.deepEqual(document.tasks, []);
  assert.ok(warnings.some((warning) => warning.includes('tasks[]')));
});

await check('args 不是字符串数组时忽略该字段', () => {
  const { document, warnings } = coerceDocument({
    tasks: [{ label: 'a', command: 'x', args: [1, 2] }],
  });
  assert.equal(document.tasks[0]?.args, undefined);
  assert.ok(warnings.some((warning) => warning.includes('args')));
});

await check('serverReadyAction 只认 openExternally', () => {
  const bad = coerceDocument({
    tasks: [{ label: 'a', command: 'x', serverReadyAction: { action: 'debug', pattern: 'x' } }],
  });
  assert.equal(bad.document.tasks[0]?.serverReadyAction, undefined);
  assert.ok(bad.warnings.some((warning) => warning.includes('openExternally')));

  const good = coerceDocument({
    tasks: [
      { label: 'a', command: 'x', serverReadyAction: { action: 'openExternally', pattern: 'r (\\S+)' } },
    ],
  });
  assert.equal(good.document.tasks[0]?.serverReadyAction?.action, 'openExternally');
});

await check('buttons 指向不存在的 entry 时保留声明（由 manager 记告警）', () => {
  const { document } = coerceDocument({
    tasks: [{ label: 'a', id: 'a', command: 'x' }],
    buttons: [{ entry: 'a' }, { entry: 'ghost' }],
  });
  assert.equal(document.buttons?.length, 2);
});

/* ── resolveEntries ── */

await check('id 缺省时从 label 派生并唯一化', () => {
  const { document } = coerceDocument({
    tasks: [
      { label: 'Web', command: 'x' },
      { label: 'Web', command: 'y' },
    ],
  });
  const entries = resolveEntries('D:/p', document);
  assert.deepEqual(entries.map((entry) => entry.id), ['web', 'web-2']);
});

await check('显式 id 相同时追加后缀而不是互相覆盖', () => {
  const { document } = coerceDocument({
    tasks: [
      { label: 'a', id: 'same', command: 'x' },
      { label: 'b', id: 'same', command: 'y' },
    ],
  });
  const entries = resolveEntries('D:/p', document);
  assert.deepEqual(entries.map((entry) => entry.id), ['same', 'same-2']);
});

/* ── expandVariables ── */

const env = { PATH: 'C:/bin', MY_PORT: '9001' };
const ctx = { workspaceFolder: 'D:/proj', inputs: { mode: 'web', port: '5180' }, env };

await check('${input:id} 展开', () => {
  assert.equal(expandVariables('--mode ${input:mode}', ctx), '--mode web');
});

await check('未定义的 input 原样留下', () => {
  assert.equal(expandVariables('${input:missing}', ctx), '${input:missing}');
});

await check('${workspaceFolder} 展开', () => {
  assert.equal(expandVariables('${workspaceFolder}/x', ctx), 'D:/proj/x');
});

await check('${env:NAME} 展开；未定义的是空串', () => {
  assert.equal(expandVariables('${env:MY_PORT}', ctx), '9001');
  assert.equal(expandVariables('${env:NOPE}', ctx), '');
});

await check('不发明新变量：${ready.1} 原样留下', () => {
  // 上一版被否掉的特化设计：把"就绪"变成模板变量。这里必须原样留下。
  assert.equal(expandVariables('${ready.1}', ctx), '${ready.1}');
});

/* ── renderCommandLine ── */

await check('命令行渲染：带空格的参数加引号', () => {
  const { document } = coerceDocument({ tasks: [{ label: 'a', command: 'python', args: ['a b.py'] }] });
  const [entry] = resolveEntries('D:/p', document);
  assert.equal(renderCommandLine(entry), 'python "a b.py"');
});

/* ── matchReady ── */

await check('endsPattern 命中即 ready，第 1 组当 URL', () => {
  const result = matchReady(
    { endsPattern: 'gallery ready at (http://\\S+)' },
    '✓ gallery ready at http://localhost:5180/',
  );
  assert.equal(result.ready, true);
  assert.equal(result.url, 'http://localhost:5180/');
});

await check('beginsPattern 单独存在时不产生 ready', () => {
  assert.equal(matchReady({ beginsPattern: '·' }, '· starting').ready, false);
});

await check('不可编译的 pattern 按"不匹配"处理，不抛错', () => {
  const result = matchReady({ endsPattern: 'gallery (ready at' }, 'gallery ready at x');
  assert.equal(result.ready, false);
});

await check('没有 problemMatcher 时不匹配', () => {
  assert.equal(matchReady(undefined, 'anything').ready, false);
});

/* ── 本地覆盖（layout.json） ── */

await check('layout 的原子写 + 读回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-'));
  const file = join(dir, 'layout.json');
  await writeLayout(file, { buttons: { 'jin/web': { pinned: false } } });
  const read = await readLayout(file);
  assert.equal(read.buttons['jin/web']?.pinned, false);
});

await check('布局文件不存在时是空覆盖（不是错误）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-'));
  const read = await readLayout(join(dir, 'nope.json'));
  assert.deepEqual(read, { buttons: {} });
});

await check('坏 layout 文件当空覆盖，不卡启动', () => {
  assert.deepEqual(coerceLayout('not an object'), { buttons: {} });
  assert.deepEqual(coerceLayout({ buttons: 'nope' }), { buttons: {} });
  assert.deepEqual(coerceLayout({ buttons: { a: { order: 'x' } } }), { buttons: { a: {} } });
});

await check('pinned:false 的按钮从浮动层消失，其余按 order 排', () => {
  const declared = [
    { entry: 'a', order: 30 },
    { entry: 'b', order: 10 },
    { entry: 'c', order: 20 },
  ];
  const effective = effectiveButtons(declared, {
    buttons: { a: { pinned: false }, c: { order: 5 } },
  });
  assert.deepEqual(effective.map((button) => button.entry), ['c', 'b']);
  assert.equal(effective[0]?.order, 5);
});

await check('本地覆盖只影响展示，不改命令', () => {
  const declared = [{ entry: 'a', icon: 'eye' }];
  const effective = effectiveButtons(declared, { buttons: { a: { icon: 'hammer', label: 'x' } } });
  assert.equal(effective[0]?.icon, 'hammer');
  // effectiveButtons 里没有任何字段能改 command / args / cwd
  assert.deepEqual(Object.keys(effective[0] ?? {}).sort(), ['entry', 'group', 'icon', 'label', 'order']);
});

await check('pinned:true 的覆盖把没上条的条目添加上来（钉到按钮条）', () => {
  const declared = [{ entry: 'a', order: 10 }];
  const effective = effectiveButtons(
    declared,
    // b：显式 order 照常生效；c：新钉上来的默认垫底（1000 + 任务序号）；d：没钉不上条
    { buttons: { b: { pinned: true, order: 5 }, c: { pinned: true }, d: { order: 1 } } },
    [{ entry: 'a' }, { entry: 'b' }, { entry: 'c' }, { entry: 'd' }],
  );
  assert.deepEqual(effective.map((button) => button.entry), ['b', 'a', 'c']);
  assert.equal(effective[0]?.order, 5);
  assert.equal(effective[2]?.order, 1002);
  // 添加到条上的命令仍然来自 run.json 的 task：effectiveButtons 只产出展示字段
  assert.deepEqual(Object.keys(effective[2] ?? {}).sort(), ['entry', 'group', 'icon', 'order']);
});

await check('没给 entries 时 pinned:true 的覆盖拿不到条目（保持旧行为）', () => {
  const declared = [{ entry: 'a', order: 10 }];
  const effective = effectiveButtons(declared, { buttons: { b: { pinned: true } } });
  assert.deepEqual(effective.map((button) => button.entry), ['a']);
});

/* ── 界面新建启动项：写回 run.json（和手改同一个文件） ── */

await check('splitCommandLine：按引号拆成 command + args', () => {
  assert.deepEqual(splitCommandLine('npm run dev'), { ok: true, tokens: ['npm', 'run', 'dev'] });
  assert.deepEqual(splitCommandLine('node "my script.js" --x=1'), {
    ok: true,
    tokens: ['node', 'my script.js', '--x=1'],
  });
  assert.deepEqual(splitCommandLine("sh -c 'echo hi'"), {
    ok: true,
    tokens: ['sh', '-c', 'echo hi'],
  });
  assert.deepEqual(splitCommandLine('  npm   run   dev  '), { ok: true, tokens: ['npm', 'run', 'dev'] });
  assert.equal(splitCommandLine('npm "oops').ok, false, '引号不闭合要报错，不能猜');
});

await check('insertTaskIntoManifestText：追加 task 且原样保留注释与已有条目', () => {
  const text = [
    '{',
    '  // 手写的注释要留着',
    '  "version": "2.0.0",',
    '  "tasks": [',
    '    { "label": "a", "command": "node", "args": ["-v"] }',
    '  ]',
    '}',
    '',
  ].join('\n');
  const result = insertTaskIntoManifestText(text, {
    label: 'b',
    command: 'npm',
    args: ['run', 'dev'],
    id: 'b',
  });
  assert.equal(result.ok, true);
  const parsed = JSON.parse(stripJsonComments(result.text));
  assert.equal(parsed.tasks.length, 2);
  assert.deepEqual(parsed.tasks[1], { label: 'b', command: 'npm', args: ['run', 'dev'], id: 'b' });
  assert.ok(result.text.includes('// 手写的注释要留着'), '注释不能被抹掉');
  assert.ok(result.text.includes('"-v"'), '已有条目要原样保留');
});

await check('insertTaskIntoManifestText：空 tasks / 没有 tasks 键 / 坏清单', () => {
  const empty = insertTaskIntoManifestText('{\n  "tasks": []\n}', { label: 'x', command: 'node' });
  assert.equal(empty.ok, true);
  assert.equal(JSON.parse(stripJsonComments(empty.text)).tasks.length, 1);

  const noTasks = insertTaskIntoManifestText('{\n  "version": "2.0.0"\n}', {
    label: 'x',
    command: 'node',
  });
  assert.equal(noTasks.ok, true);
  const parsedNoTasks = JSON.parse(stripJsonComments(noTasks.text));
  assert.equal(parsedNoTasks.version, '2.0.0', '原有字段不能丢');
  assert.equal(parsedNoTasks.tasks.length, 1);

  // 末尾挂着行注释时（收空白会把逗号卷进注释里），要能换位置插成功
  const trailingComment = insertTaskIntoManifestText(
    '{\n  "tasks": [\n    { "label": "a", "command": "node" } // 末尾注释\n  ]\n}',
    { label: 'b', command: 'node' },
  );
  assert.equal(trailingComment.ok, true);
  assert.equal(JSON.parse(stripJsonComments(trailingComment.text)).tasks.length, 2);

  assert.equal(insertTaskIntoManifestText('{ tasks: ', { label: 'x', command: 'node' }).ok, false);
});

await check('removeTaskFromManifestText：删任务、清悬空 buttons[]、注释保留', () => {
  const text = [
    '{',
    '  // 手写注释',
    '  "tasks": [',
    '    { "label": "a", "id": "a", "command": "node" },',
    '    { "label": "b", "id": "b", "command": "node" },',
    '    { "label": "c", "id": "c", "command": "node" }',
    '  ],',
    '  "buttons": [',
    '    { "entry": "b", "icon": "eye" },',
    '    { "entry": "c", "icon": "play" }',
    '  ]',
    '}',
    '',
  ].join('\n');

  const middle = removeTaskFromManifestText(text, 'b');
  assert.equal(middle.ok, true);
  const parsedMiddle = JSON.parse(stripJsonComments(middle.text));
  assert.deepEqual(parsedMiddle.tasks.map((task) => task.id), ['a', 'c']);
  assert.deepEqual(parsedMiddle.buttons.map((button) => button.entry), ['c'], '悬空的按钮声明要一起清掉');
  assert.ok(middle.text.includes('// 手写注释'), '注释要保留');

  const last = removeTaskFromManifestText(text, 'c');
  assert.deepEqual(JSON.parse(stripJsonComments(last.text)).tasks.map((t) => t.id), ['a', 'b']);
  const first = removeTaskFromManifestText(text, 'a');
  assert.deepEqual(JSON.parse(stripJsonComments(first.text)).tasks.map((t) => t.id), ['b', 'c']);

  const single = removeTaskFromManifestText(
    '{ "tasks": [ { "label": "x", "id": "x", "command": "node" } ] }',
    'x',
  );
  assert.equal(single.ok, true);
  assert.equal(JSON.parse(stripJsonComments(single.text)).tasks.length, 0);

  assert.equal(removeTaskFromManifestText(text, 'nope').ok, false, '不存在的 id 要报错');
  assert.equal(removeTaskFromManifestText('{ broken', 'x').ok, false, '坏清单要拒绝');
});

/* ── 完整样例（需求里给的那一份） ── */

await check('需求给的完整样例能读能解析', () => {
  const document = {
    version: '2.0.0',
    inputs: [{ id: 'mode', type: 'pickString', options: ['dev', 'web', 'release'], default: 'web' }],
    tasks: [
      {
        label: 'jin · web',
        id: 'jin/web',
        type: 'shell',
        command: 'python',
        args: ['start_gallery_web.py', '--mode', '${input:mode}'],
        options: { cwd: '${workspaceFolder}' },
        isBackground: true,
        problemMatcher: {
          background: {
            activeOnStart: true,
            beginsPattern: '·',
            endsPattern: 'gallery ready at (http://\\S+)',
          },
        },
        serverReadyAction: {
          action: 'openExternally',
          pattern: 'gallery ready at (http://\\S+)',
          uriFormat: '%s',
        },
        presentation: { panel: 'dedicated', reveal: 'always', clear: true },
      },
    ],
    buttons: [{ entry: 'jin/web', icon: 'eye', pane: 'float' }],
  };
  const { document: coerced, warnings } = coerceDocument(document);
  assert.deepEqual(warnings, []);
  const entries = resolveEntries('D:/jin', coerced);
  assert.equal(entries[0]?.id, 'jin/web');
  assert.equal(entries[0]?.cwd, 'D:/jin');
  assert.deepEqual(entries[0]?.args, ['start_gallery_web.py', '--mode', 'web']);
});

/* ── 从磁盘读一个真实样例 ── */

await check('磁盘上的样例 manifest 能被读完', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(
    join(dir, '.dsh', 'run-deck', 'run.json'),
    '// comment\n' +
      JSON.stringify({
        version: '2.0.0',
        tasks: [{ label: 't', id: 't', command: 'echo', args: ['hi'], isBackground: true }],
        buttons: [{ entry: 't', icon: 'eye' }],
      }),
    'utf8',
  );
  const { project } = await loadProject(dir);
  assert.equal(project.entries.length, 1);
  assert.equal(project.entries[0]?.id, 't');
  assert.equal(project.configFile, join(dir, '.dsh', 'run-deck', 'run.json'));
  assert.deepEqual(project.warnings, []);
});

await check('清单还在旧位置 .dsh/run.json：照常读写并告警；新旧并存时以新位置为准', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-legacy-'));
  mkdirSync(join(dir, '.dsh'), { recursive: true });
  writeFileSync(
    join(dir, '.dsh', 'run.json'),
    JSON.stringify({
      version: '2.0.0',
      tasks: [{ label: 'old', id: 'old', command: 'node', args: ['old.js'] }],
    }),
    'utf8',
  );

  const legacy = await loadProject(dir);
  assert.equal(legacy.project.configFile, join(dir, '.dsh', 'run.json'), '旧位置仍是可读的清单');
  assert.deepEqual(legacy.project.entries.map((entry) => entry.id), ['old']);
  assert.ok(
    legacy.project.warnings.some((warning) => warning.includes('旧位置')),
    `要有"挪到新位置"的告警：${legacy.project.warnings.join(' | ')}`,
  );

  // 新旧并存：新位置赢，旧位置只是没人再去读的孤儿（不合并、不删除）
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(
    join(dir, '.dsh', 'run-deck', 'run.json'),
    JSON.stringify({
      version: '2.0.0',
      tasks: [{ label: 'new', id: 'new', command: 'node', args: ['new.js'] }],
    }),
    'utf8',
  );
  const both = await loadProject(dir);
  assert.equal(both.project.configFile, join(dir, '.dsh', 'run-deck', 'run.json'));
  assert.deepEqual(both.project.entries.map((entry) => entry.id), ['new']);
});

/* ================================================================== *
 * 第 3 步：事件钩子（problemMatcher.background / serverReadyAction / onReady）
 * ================================================================== */

/** 造一组测试条目：jin/web（就绪 → 接 jin/desktop）、a↔b 成环、无钩子的一条。 */
function fixture() {
  const { document } = coerceDocument({
    inputs: [{ id: 'mode', type: 'pickString', options: ['dev', 'web'], default: 'web' }],
    tasks: [
      {
        label: 'web',
        id: 'jin/web',
        command: 'python',
        args: ['start_gallery_web.py'],
        isBackground: true,
        problemMatcher: {
          background: {
            activeOnStart: true,
            beginsPattern: '·',
            endsPattern: 'gallery ready at (http://\\S+)',
          },
        },
        serverReadyAction: {
          action: 'openExternally',
          pattern: 'gallery ready at (http://\\S+)',
          uriFormat: '%s',
        },
        onReady: 'jin/desktop',
      },
      {
        label: 'desktop',
        id: 'jin/desktop',
        command: 'python',
        args: ['start_gallery_desktop.py'],
        isBackground: true,
        problemMatcher: {
          background: {
            activeOnStart: true,
            beginsPattern: '·',
            endsPattern: 'starting the desktop shell: (\\S+)',
          },
        },
      },
      {
        label: 'no hooks',
        id: 'jin/plain',
        command: 'echo',
      },
      {
        label: 'cycle a',
        id: 'cycle/a',
        command: 'echo',
        onReady: 'cycle/b',
      },
      {
        label: 'cycle b',
        id: 'cycle/b',
        command: 'echo',
        onReady: 'cycle/a',
      },
    ],
  });
  const entries = resolveEntries('D:/jin', document);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    entries,
    get: (id) => {
      const entry = byId.get(id);
      if (entry === undefined) throw new Error(`fixture 里没有 ${id}`);
      return entry;
    },
  };
}

await check('beginsPattern 未命中时，endsPattern 不生效', () => {
  const fx = fixture();
  const state = initialHookState(false); // activeOnStart: false → 要等 beginsPattern
  const outcome = observeLine(state, fx.get('jin/web'), 'gallery ready at http://x/', fx.entries);
  assert.equal(outcome.becameReady, false);
  assert.equal(outcome.state.began, false, 'beginsPattern 没出现就不该开始匹配');
  assert.equal(outcome.open, undefined);
});

await check('beginsPattern 命中后，同一句 endsPattern 就 ready', () => {
  const fx = fixture();
  let state = initialHookState(false);
  state = observeLine(state, fx.get('jin/web'), '· starting', fx.entries).state;
  const outcome = observeLine(state, fx.get('jin/web'), '✓ gallery ready at http://localhost:5180/', fx.entries);
  assert.equal(outcome.becameReady, true);
  assert.equal(outcome.state.ready, true);
  assert.equal(outcome.state.url, 'http://localhost:5180/');
});

await check('activeOnStart:true 时进程一起来就算已开始', () => {
  const fx = fixture();
  const state = initialHookState(true);
  assert.equal(state.began, true);
  const outcome = observeLine(state, fx.get('jin/web'), 'gallery ready at http://l:1/', fx.entries);
  assert.equal(outcome.becameReady, true);
});

await check('serverReadyAction 在 ready 时被触发一次，且 uriFormat 生效', () => {
  const fx = fixture();
  const state = initialHookState(true);
  const outcome = observeLine(state, fx.get('jin/web'), 'gallery ready at http://localhost:5180/', fx.entries);
  assert.deepEqual(outcome.open, {
    action: 'openExternally',
    uri: 'http://localhost:5180/',
    captured: 'http://localhost:5180/',
  });
  // 第二次同样的 ready 行：不再触发
  const again = observeLine(outcome.state, fx.get('jin/web'), 'gallery ready at http://l:1/', fx.entries);
  assert.equal(again.open, undefined);
  assert.equal(again.state.opened, true);
});

await check('uriFormat 把 URL 填进模板', () => {
  const target = resolveServerReady(
    { pattern: 'x', uriFormat: 'http://localhost:9229/json/list?url=%s' },
    'http://localhost:5180/',
  );
  assert.equal(target?.uri, 'http://localhost:9229/json/list?url=http://localhost:5180/');
});

await check('uriFormat 缺省时原样打开抓到的地址', () => {
  const target = resolveServerReady({ pattern: 'x' }, 'http://localhost:5180/');
  assert.equal(target?.uri, 'http://localhost:5180/');
});

await check('没有 serverReadyAction 时不产生 open', () => {
  const fx = fixture();
  const outcome = observeLine(initialHookState(true), fx.get('jin/desktop'), 'starting the desktop shell: D:/x.exe', fx.entries);
  assert.equal(outcome.becameReady, true);
  assert.equal(outcome.open, undefined);
});

await check('onReady 只接受 entry id，解析成功时给出目标 entry', () => {
  const fx = fixture();
  const outcome = observeLine(initialHookState(true), fx.get('jin/web'), 'gallery ready at http://l:1/', fx.entries);
  assert.equal(outcome.chainTo?.id, 'jin/desktop');
});

await check('onReady 触发一次后不再重复', () => {
  const fx = fixture();
  const state = initialHookState(true);
  const first = observeLine(state, fx.get('jin/web'), 'gallery ready at http://l:1/', fx.entries);
  const second = observeLine(first.state, fx.get('jin/web'), 'gallery ready at http://l:2/', fx.entries);
  assert.equal(second.chainTo, undefined);
  assert.equal(second.open, undefined);
});

await check('onReady 不接受命令（带空白/shell 元字符）', () => {
  const fx = fixture();
  for (const bad of ['jin/desktop --force', 'jin/desktop; rm -rf /', 'npm run dev', 'jin/desktop && echo']) {
    const result = resolveOnReady(bad, fx.entries);
    assert.equal(result.ok, false, `应当拒绝：${bad}`);
    if (!result.ok) assert.ok(result.reason.includes('只能是 entry id'), result.reason);
  }
});

await check('onReady 指向不存在的 id 时报错并列出可用 id', () => {
  const fx = fixture();
  const result = resolveOnReady('ghost', fx.entries);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reason.includes('ghost'));
    assert.ok(result.reason.includes('jin/web'));
  }
});

await check('onReady **不**回落按 label 匹配（label 可重名，不能当接口）', () => {
  const { document } = coerceDocument({ tasks: [{ label: 'web', command: 'x', onReady: 'web' }] });
  const entries = resolveEntries('D:/p', document);
  // label 'web' 派生出的 id 是 'web'，这里恰好相等；换一个 label≠id 的情形：
  const { document: d2 } = coerceDocument({ tasks: [{ label: 'Web App', id: 'w', command: 'x', onReady: 'Web App' }] });
  const entries2 = resolveEntries('D:/p', d2);
  const result = resolveOnReady('Web App', entries2);
  assert.equal(result.ok, false, '不该用 label 当接口');
});

await check('onReady 成环时跳过（A→B→A 不会互相拉起）', () => {
  const fx = fixture();
  assert.equal(wouldCycle('cycle/a', 'cycle/b', fx.entries), true);
  assert.equal(wouldCycle('jin/web', 'jin/desktop', fx.entries), false);
  // 环的条目走完整个链路：就绪了，但不该拉起对方
  const outcome = observeLine(initialHookState(true), fx.get('cycle/a'), 'anything', fx.entries);
  assert.equal(outcome.chainTo, undefined);
});

await check('onReady 指向自己时也当环处理', () => {
  const { document } = coerceDocument({ tasks: [{ label: 's', id: 's', command: 'x', onReady: 's' }] });
  const entries = resolveEntries('D:/p', document);
  assert.equal(wouldCycle('s', 's', entries), true);
});

await check('没有 problemMatcher.background 的条目不做就绪判定', () => {
  const fx = fixture();
  const outcome = observeLine(initialHookState(true), fx.get('jin/plain'), 'anything', fx.entries);
  assert.equal(outcome.becameReady, false);
  assert.equal(outcome.open, undefined);
  assert.equal(outcome.chainTo, undefined);
});

await check('beginsPattern 不可编译时从下一行起都认（否则永远不 ready）', () => {
  const { document } = coerceDocument({
    tasks: [
      {
        label: 'bad',
        id: 'bad',
        command: 'x',
        problemMatcher: { background: { beginsPattern: 'gallery (ready at', endsPattern: 'ready' } },
      },
    ],
  });
  const entries = resolveEntries('D:/p', document);
  const outcome = observeLine(initialHookState(false), entries[0], 'ready', entries);
  assert.equal(outcome.becameReady, true);
  assert.ok(outcome.note !== undefined && outcome.note.includes('无法编译'));
});

await check('endsPattern 不可编译时永远不就绪，不抛错', () => {
  const { document } = coerceDocument({
    tasks: [
      {
        label: 'bad2',
        id: 'bad2',
        command: 'x',
        problemMatcher: { background: { endsPattern: 'ready at (http://' } },
      },
    ],
  });
  const entries = resolveEntries('D:/p', document);
  const outcome = observeLine(initialHookState(true), entries[0], 'ready at http://x', entries);
  assert.equal(outcome.becameReady, false);
});

await check('真实样例 jin/web 跑完整链路：begins → ready → open + chain', () => {
  const fx = fixture();
  let state = initialHookState(false);
  state = observeLine(state, fx.get('jin/web'), '· checking prerequisites', fx.entries).state;
  assert.equal(state.began, true);
  const outcome = observeLine(state, fx.get('jin/web'), '✓ gallery ready at http://localhost:5180/', fx.entries);
  assert.equal(outcome.becameReady, true);
  assert.equal(outcome.open?.uri, 'http://localhost:5180/');
  assert.equal(outcome.chainTo?.id, 'jin/desktop');
  assert.equal(outcome.state.ready, true);
  assert.equal(outcome.state.opened, true);
  assert.equal(outcome.state.chained, true);
});


/* ================================================================== *
 * 第 4 步：外部按 id 调用（run-deck 工具的参数分发）
 * ================================================================== */

/** 测试替身：记录被调用了什么，不真的起进程（run/stop/rerun 现在是异步的）。 */
function fakeHost(entries) {
  const calls = [];
  return {
    calls,
    host: {
      listEntries: () => entries,
      run: async (projectRoot, entryId) => {
        calls.push({ kind: 'run', projectRoot, entryId });
        return { ok: true, runId: 'run-1', label: 'l', status: 'running' };
      },
      stop: async (runId) => {
        calls.push({ kind: 'stop', runId });
        return { ok: true, runId, label: 'l', status: 'exited', entryId: 'jin/web' };
      },
      rerun: async (runId) => {
        calls.push({ kind: 'rerun', runId });
        return { ok: true, runId: 'run-2', label: 'l', status: 'running', entryId: 'jin/web' };
      },
    },
  };
}

/**
 * 假宿主运行时：`ctx.subprocess`（真 PTY 的执行缝）+ 打开地址。
 *
 * 执行现在**真的会开一条 PTY**（见 src/exec.ts），所以"能跑起来"的测试必须给
 * 执行缝一个替身；同时它也是"点按钮 → 开 PTY → cmd /c 命令行 → SIGINT 停"这条
 * 链路的离线证据。
 *
 * 可选参数都只为测少数分支：spawnError（起不来）、signalError（SIGINT 投不到）、
 * readText（喂给钩子的输出）、exitCode/exitSignal（进程结算）、noShell（问不到 shell）、
 * platform（默认 windows）。
 */
function fakeRuntime(options = {}) {
  const calls = { spawn: [], write: [], signal: [], terminate: [], opened: [], activity: 0 };
  const listeners = new Set();
  const output = {
    setEncoding() {},
    on(event, listener) {
      if (event === 'data') listeners.add(listener);
      return output;
    },
    off(event, listener) {
      if (event === 'data') listeners.delete(listener);
      return output;
    },
    emit(chunk) {
      for (const listener of listeners) listener(chunk);
    },
  };
  const outcome = Promise.withResolvers();
  const handle = {
    pid: options.pid ?? 4242,
    output,
    done: outcome.promise,
    write: async (data) => {
      calls.write.push(data);
    },
    resize: async () => {},
    inspectForeground: async () => ({ processGroupId: options.pid ?? 4242, inputWaiting: false }),
    inspectActivity: async () => {
      calls.activity += 1;
      return { state: 'idle', revision: 0 };
    },
    signalForeground: async (signal) => {
      calls.signal.push(signal);
      if (options.signalError !== undefined) throw new Error(options.signalError);
      return options.pid ?? 4242;
    },
    terminate: async () => {
      calls.terminate.push(true);
      outcome.resolve({ exitCode: options.exitCode ?? null, signal: options.exitSignal ?? 'SIGTERM' });
    },
  };
  const subprocess = {
    terminalEnvironment: async () => {
      if (options.noShell === true) return { platform: options.platform ?? 'windows' };
      return {
        platform: options.platform ?? 'windows',
        defaultShell: options.platform === 'posix' ? '/bin/sh' : 'C:/Windows/system32/cmd.exe',
      };
    },
    resolveExecutable: async (command) => command,
    spawnTerminal: async (spec) => {
      calls.spawn.push(spec);
      if (options.spawnError !== undefined) throw new Error(options.spawnError);
      // 真实现是流式的；测试里由用例自己 `feed()` 喂输出。
      return handle;
    },
  };
  return {
    calls,
    handle,
    output,
    subprocess,
    /** 让这条 PTY "打出一行"。 */
    feed: (text) => output.emit(text),
    /** 让这条 PTY 的顶层进程结算（脚本自己退出）。 */
    exit: (exitCode = 0, signal = null) => outcome.resolve({ exitCode, signal }),
    ctx: { get: (name) => (name === 'subprocess' ? subprocess : undefined) },
  };
}

const ENTRIES = [
  { projectRoot: 'D:/jin', entryId: 'jin/web' },  { projectRoot: 'D:/jin', entryId: 'jin/desktop' },
  { projectRoot: 'D:/Ceola', entryId: 'ceola/desktop' },
];

await check('工具名是 run-deck', async () => {
  assert.equal(TOOL_NAME, 'run-deck');
});

await check('action=run 按 entry_id 精确定位并发起', async () => {
  const fake = fakeHost(ENTRIES);
  const result = await dispatchToolArgs({ action: 'run', entry_id: 'jin/web' }, fake.host);
  assert.equal(result.ok, true);
  assert.equal(result.entry_id, 'jin/web');
  assert.equal(result.run_id, 'run-1');
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0], { kind: 'run', projectRoot: 'D:/jin', entryId: 'jin/web' });
});

await check('action=run 缺 entry_id 时报错，不发起任何调用', async () => {
  const fake = fakeHost(ENTRIES);
  const result = await dispatchToolArgs({ action: 'run' }, fake.host);
  assert.equal(result.ok, false);
  assert.match(result.message, /entry_id/);
  assert.equal(fake.calls.length, 0);
});

await check('action=run 的未知 id 被拒绝，不发起任何调用', async () => {
  const fake = fakeHost(ENTRIES);
  const result = await dispatchToolArgs({ action: 'run', entry_id: 'ghost' }, fake.host);
  assert.equal(result.ok, false);
  assert.match(result.message, /ghost/);
  assert.equal(fake.calls.length, 0);
});

await check('工具**不接受**自由命令：entry_id 里的命令形态被当未知 id 拒绝', async () => {
  const fake = fakeHost(ENTRIES);
  for (const bad of ['python x.py', 'python x.py && echo hi', 'npm run dev', '"])']) {
    const result = await dispatchToolArgs({ action: 'run', entry_id: bad }, fake.host);
    assert.equal(result.ok, false, `应当拒绝：${bad}`);
    assert.equal(fake.calls.length, 0, `不该发起调用：${bad}`);
  }
});

await check('工具**不**回落按 label 匹配（label 可重名，不能当接口）', async () => {
  const fake = fakeHost([{ projectRoot: 'D:/jin', entryId: 'jin/web' }]);
  // label 'jin · web' 与 id 不同，不能当 entry_id 用
  const result = await dispatchToolArgs({ action: 'run', entry_id: 'jin · web' }, fake.host);
  assert.equal(result.ok, false);
  assert.equal(fake.calls.length, 0);
});

await check('action=stop 用 run_id，并发起 stop', async () => {
  const fake = fakeHost(ENTRIES);
  const result = await dispatchToolArgs({ action: 'stop', run_id: 'run-1' }, fake.host);
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls[0], { kind: 'stop', runId: 'run-1' });
});

await check('action=rerun 用 run_id，并发起 rerun', async () => {
  const fake = fakeHost(ENTRIES);
  const result = await dispatchToolArgs({ action: 'rerun', run_id: 'run-1' }, fake.host);
  assert.equal(result.ok, true);
  assert.equal(result.run_id, 'run-2', 'rerun 返回新 runId');
  assert.deepEqual(fake.calls[0], { kind: 'rerun', runId: 'run-1' });
});

await check('stop/rerun 缺 run_id 时报错，不发起任何调用', async () => {
  for (const action of ['stop', 'rerun']) {
    const fake = fakeHost(ENTRIES);
    const result = await dispatchToolArgs({ action }, fake.host);
    assert.equal(result.ok, false);
    assert.match(result.message, /run_id/);
    assert.equal(fake.calls.length, 0);
  }
});

await check('未知 action 与缺 action 都报错', async () => {
  const fake = fakeHost(ENTRIES);
  assert.equal((await dispatchToolArgs({ action: 'explode' }, fake.host)).ok, false);
  assert.equal((await dispatchToolArgs({}, fake.host)).ok, false);
  assert.equal(fake.calls.length, 0);
});

await check('action 前后的空白被裁掉', async () => {
  const fake = fakeHost(ENTRIES);
  const result = await dispatchToolArgs({ action: '  run  ', entry_id: ' jin/web ' }, fake.host);
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls[0], { kind: 'run', projectRoot: 'D:/jin', entryId: 'jin/web' });
});

await check('manager 调用失败时把原因带回，不假装成功', async () => {
  const fake = fakeHost(ENTRIES);
  fake.host.run = () => ({ ok: false, message: '已经有一个进行中的运行' });
  const result = await dispatchToolArgs({ action: 'run', entry_id: 'jin/web' }, fake.host);
  assert.equal(result.ok, false);
  assert.match(result.message, /已经有一个进行中的运行/);
});

await check('成功返回体只用下划线字段名（模型侧是 snake_case）', async () => {
  const fake = fakeHost(ENTRIES);
  const result = await dispatchToolArgs({ action: 'run', entry_id: 'jin/web' }, fake.host);
  const keys = Object.keys(result);
  for (const key of keys) assert.ok(!/[A-Z]/u.test(key), `不该出现驼峰键：${key}`);
  assert.ok(keys.includes('entry_id'));
  assert.ok(keys.includes('run_id'));
});

/* ── action=create：agent 帮用户加启动按钮的那条路（与「+」面板同一条链路） ── */

await check('action=create 落进 create 调用（label+command+project_root）', async () => {
  const fake = fakeHost(ENTRIES);
  fake.host.create = async (projectRoot, input) => {
    fake.calls.push({ kind: 'create', projectRoot, input });
    return { ok: true, entryId: 'dev-server' };
  };
  const result = await dispatchToolArgs(
    { action: 'create', label: 'dev server', command: 'npm run dev', project_root: 'D:/jin', is_background: true, ready_pattern: 'http://\\\\S+' },
    fake.host,
  );
  assert.equal(result.ok, true);
  assert.equal(result.entry_id, 'dev-server');
  assert.deepEqual(fake.calls[0], {
    kind: 'create',
    projectRoot: 'D:/jin',
    input: { label: 'dev server', command: 'npm run dev', isBackground: true, readyPattern: 'http://\\\\S+' },
  });
});

await check('action=create 缺 project_root 时用会话 cwd，再缺才报错', async () => {
  const fake = fakeHost(ENTRIES);
  fake.host.create = async (projectRoot) => {
    fake.calls.push({ kind: 'create', projectRoot });
    return { ok: true, entryId: 'x' };
  };
  fake.host.sessionCwd = () => 'D:/jin';
  const result = await dispatchToolArgs(
    { action: 'create', label: 'l', command: 'echo hi' },
    fake.host,
  );
  assert.equal(result.ok, true);
  assert.equal(fake.calls[0].projectRoot, 'D:/jin');
  // 连会话 cwd 都没有 → 明确报错，不猜
  const noCwd = fakeHost(ENTRIES);
  noCwd.host.create = async () => ({ ok: true, entryId: 'x' });
  const refused = await dispatchToolArgs({ action: 'create', label: 'l', command: 'echo hi' }, noCwd.host);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /project_root/);
});

await check('action=create 缺 label/command 时报错，不发起调用', async () => {
  const fake = fakeHost(ENTRIES);
  fake.host.create = async () => ({ ok: true, entryId: 'x' });
  const noLabel = await dispatchToolArgs({ action: 'create', command: 'echo hi' }, fake.host);
  assert.equal(noLabel.ok, false);
  assert.match(noLabel.message, /label/);
  const noCommand = await dispatchToolArgs({ action: 'create', label: 'l' }, fake.host);
  assert.equal(noCommand.ok, false);
  assert.match(noCommand.message, /command/);
  assert.equal(fake.calls.length, 0, '缺必填项时不该发起 create 调用');
});

await check('action=create 失败时把原因（含 hint）带回，不假装成功', async () => {
  const fake = fakeHost(ENTRIES);
  fake.host.create = async () => ({ ok: false, message: '工作目录不存在：D:/nope', hint: '填项目里已有的目录' });
  const result = await dispatchToolArgs(
    { action: 'create', label: 'l', command: 'echo hi', project_root: 'D:/jin' },
    fake.host,
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /工作目录不存在/);
  assert.match(result.message, /填项目里已有的目录/);
});

await check('宿主面没提供 create 时 action=create 明确拒绝（老测试替身不悄悄降级）', async () => {
  const fake = fakeHost(ENTRIES); // host.create 不存在
  const result = await dispatchToolArgs(
    { action: 'create', label: 'l', command: 'echo hi', project_root: 'D:/jin' },
    fake.host,
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /create/);
});

await check('createToolEntry：把 manager 的 `entry` 映射成 entryId 并钉条（字段名陷阱）', async () => {
  const calls = [];
  const okManager = {
    createTask: async (projectRoot, input) => {
      calls.push({ kind: 'create', projectRoot, input });
      return { ok: true, entry: 'dev-server', projectRoot };
    },
    setButtonOverride: async (entry, override) => {
      calls.push({ kind: 'pin', entry, override });
      return { ok: true, entry };
    },
  };
  const result = await createToolEntry(okManager, 'D:/jin', { label: 'dev', command: 'npm run dev' });
  assert.deepEqual(result, { ok: true, entryId: 'dev-server' });
  assert.deepEqual(calls.map((c) => c.kind), ['create', 'pin']);
  assert.deepEqual(calls[1], { kind: 'pin', entry: 'dev-server', override: { pinned: true } });
});

await check('createToolEntry：钉条失败不推翻"条目已建成"，把原因带回', async () => {
  const failPin = {
    createTask: async () => ({ ok: true, entry: 'dev-server', projectRoot: 'D:/jin' }),
    setButtonOverride: async () => ({ ok: false, code: 'FS', message: '写不了本地覆盖文件' }),
  };
  const result = await createToolEntry(failPin, 'D:/jin', { label: 'dev', command: 'npm run dev' });
  assert.equal(result.ok, true);
  assert.equal(result.entryId, 'dev-server');
  assert.match(result.message, /钉到按钮条失败/);
});

await check('createToolEntry：manager 拒绝时原样带回（不钉条）', async () => {
  let pinned = false;
  const reject = {
    createTask: async () => ({ ok: false, code: 'BAD', message: '缺命令' }),
    setButtonOverride: async () => { pinned = true; return { ok: true, entry: 'x' }; },
  };
  const result = await createToolEntry(reject, 'D:/jin', { label: 'dev', command: ' ' });
  assert.equal(result.ok, false);
  assert.match(result.message, /缺命令/);
  assert.equal(pinned, false, '没建成就不该写 layout.json');
});

await check('createToolEntry：manager 返回 ok 但没给 id 时报错（不静默变成 undefined）', async () => {
  const noId = {
    createTask: async () => ({ ok: true, projectRoot: 'D:/jin' }),
    setButtonOverride: async () => ({ ok: true }),
  };
  const result = await createToolEntry(noId, 'D:/jin', { label: 'dev', command: 'npm run dev' });
  assert.equal(result.ok, false);
  assert.match(result.message, /没拿到它的 id/);
});

/* ── configPath 的两种形态（回归：曾经把 <x>/.dsh/run-deck/run.json 读成 <x>/.dsh/.dsh/run-deck/run.json）── */

await check('configPath 指向 <x>/.dsh/run-deck/run.json 时，项目根是 <x>', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(
    join(dir, '.dsh', 'run-deck', 'run.json'),
    JSON.stringify({
      version: '2.0.0',
      tasks: [{ label: 't', id: 't', command: 'echo', args: ['hi'] }],
    }),
    'utf8',
  );
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir: '', configPath: join(dir, '.dsh', 'run-deck', 'run.json') }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  const projects = manager.listProjects();
  // 项目根必须是 dir 本身；曾经会把最后一段目录名也剥掉，得到 <dir>/.dsh。
  // 注意 normalizeRoot 会把分隔符统一成 `/`，所以比较时也要归一化。
  const want = dir.replaceAll('\\', '/');
  assert.ok(
    projects.some((project) => project.root === want),
    `项目根应当是 ${want}，实际：${projects.map((p) => p.root).join(', ')}`,
  );
  const entry = projects.find((project) => project.root === want)?.entries[0];
  assert.equal(entry?.id, 't');
});

await check('configPath 指向目录时，按普通项目根目录读它的 .dsh/run-deck/run.json', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(
    join(dir, '.dsh', 'run-deck', 'run.json'),
    JSON.stringify({ version: '2.0.0', tasks: [{ label: 'd', id: 'd', command: 'echo' }] }),
    'utf8',
  );
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir: '', configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  const want = dir.replaceAll('\\', '/');
  assert.ok(manager.listProjects().some((project) => project.root === want));
});

await check('configPath 指向一个不叫 run.json 的清单时如实告警，不假装能读', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-'));
  writeFileSync(join(dir, 'my-tasks.json'), JSON.stringify({ tasks: [] }), 'utf8');
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir: '', configPath: join(dir, 'my-tasks.json') }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  const warnings = manager.getWarnings();
  assert.ok(
    warnings.some((warning) => warning.includes('只认') && warning.includes('run.json')),
    `应当告警说明只认 .dsh/run-deck/run.json，实际告警：${warnings.join(' | ')}`,
  );
});

await check('configPath 不存在时告警并继续，不抛错', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir: '', configPath: '/no/such/path/run.json' }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  assert.ok(
    manager.getWarnings().some((warning) => warning.includes('configPath 不存在')),
    '应当有一条 configPath 不存在的告警',
  );
});

/* ── 第 5 步：浮动按钮本地覆盖只能改展示，不能改执行 ── */

await check('listButtons 合并 run.json 的 buttons[] 与本地覆盖', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-btn-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(
    join(dir, '.dsh', 'run-deck', 'run.json'),
    JSON.stringify({
      version: '2.0.0',
      tasks: [
        { label: 'web', id: 'a/web', command: 'python' },
        { label: 'desk', id: 'a/desk', command: 'python' },
      ],
      buttons: [
        { entry: 'a/web', icon: 'eye', group: 'g1', order: 20 },
        { entry: 'a/desk', icon: 'desktop', group: 'g1', order: 10 },
      ],
    }),
    'utf8',
  );
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-btndata-'));
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  const buttons = manager.listButtons();
  assert.equal(buttons.length, 2);
  // order 小的在前：a/desk(10) 在 a/web(20) 前
  assert.deepEqual(buttons.map((b) => b.entry), ['a/desk', 'a/web']);
  assert.equal(buttons[1]?.icon, 'eye');
  assert.equal(buttons[1]?.group, 'g1');
  assert.equal(buttons[1]?.entryLabel, 'web');
});

await check('本地覆盖 pinned:false 只隐藏按钮，不删条目', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-btn-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(
    join(dir, '.dsh', 'run-deck', 'run.json'),
    JSON.stringify({
      version: '2.0.0',
      tasks: [{ label: 'web', id: 'a/web', command: 'python' }],
      buttons: [{ entry: 'a/web', icon: 'eye' }],
    }),
    'utf8',
  );
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-btndata-'));
  const runtime = fakeRuntime();
  const manager = new RunDeckManager({
    ctx: runtime.ctx,
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  assert.equal(manager.listButtons().length, 1);

  const result = await manager.setButtonOverride('a/web', { pinned: false });
  assert.equal(result.ok, true);
  assert.equal(manager.listButtons().length, 0, '隐藏后浮动层不该再有它');
  // 条目本身还在，仍能被 /run-deck run 调用
  assert.equal(manager.listProjects()[0]?.entries.length, 1);
  const project = manager.listProjects()[0];
  assert.ok(project !== undefined);
  const started = await manager.startRun({ projectRoot: project.root, entryId: 'a/web', sessionId: 'session-1' });
  assert.equal(started.ok, true, '本地覆盖不该影响执行');
});

await check('「钉到按钮条」能把没进 buttons[] 的 task 添加上条，也能再收回去', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-btn-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(
    join(dir, '.dsh', 'run-deck', 'run.json'),
    JSON.stringify({
      version: '2.0.0',
      tasks: [
        { label: 'web', id: 'a/web', command: 'python' },
        { label: 'desk', id: 'a/desk', command: 'python' },
      ],
      buttons: [{ entry: 'a/web', icon: 'eye' }],
    }),
    'utf8',
  );
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-btndata-'));
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  // 起初只有声明过的一条
  assert.equal(manager.listButtons().length, 1);

  // `+` 面板的"钉到按钮条"：把 a/desk 添加上条
  const add = await manager.setButtonOverride('a/desk', { pinned: true });
  assert.equal(add.ok, true);
  const buttons = manager.listButtons();
  assert.equal(buttons.length, 2, '钉上之后浮动层应该多一颗');
  const deskButton = buttons.find((button) => button.entry === 'a/desk');
  assert.ok(deskButton, '钉上之后应该找得到 a/desk');
  assert.equal(deskButton?.entryLabel, 'desk', '命令/标题仍来自 run.json 的 task');

  // 再点一次（收起）：从浮动层消失，条目本身还在
  const hide = await manager.setButtonOverride('a/desk', { pinned: false });
  assert.equal(hide.ok, true);
  assert.equal(manager.listButtons().length, 1, '收起后浮动层剩声明过的那条');
  assert.equal(manager.listProjects()[0]?.entries.length, 2, '条目不删，仍能被 run');
});

await check('/button 走 HTTP 也认 `pinned: false`（收起不是空操作）', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const { createRoutes } = await import(new URL('../lib/routes.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-btnwire-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(
    join(dir, '.dsh', 'run-deck', 'run.json'),
    JSON.stringify({
      version: '2.0.0',
      tasks: [
        { label: 'web', id: 'a/web', command: 'python' },
        { label: 'desk', id: 'a/desk', command: 'python' },
      ],
      buttons: [{ entry: 'a/web' }],
    }),
    'utf8',
  );
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-btnwiredata-'));
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  const routes = createRoutes({
    manager,
    ready: Promise.resolve(),
    trustedHosts: () => [],
    log: () => {},
  });
  const path = '/dsh-run-deck/api/button';

  const added = await callRoute(routes, path, '', {
    method: 'POST',
    body: { entry: 'a/desk', pinned: true },
  });
  assert.equal(added.ok, true);
  assert.equal(manager.listButtons().length, 2, '钉上：浮动层多一颗');

  const hidden = await callRoute(routes, path, '', {
    method: 'POST',
    body: { entry: 'a/desk', pinned: false },
  });
  assert.equal(hidden.ok, true);
  assert.equal(manager.listButtons().length, 1, 'pinned:false 必须真的收起（早先被整段丢掉）');
  assert.equal(
    manager.getLayout().buttons['a/desk']?.pinned,
    false,
    '落盘的是显式 false，不是"没给这个字段"',
  );
});

await check('手改 layout.json 会在下次同步时生效（不用重启）', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-layoutsync-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(
    join(dir, '.dsh', 'run-deck', 'run.json'),
    JSON.stringify({
      version: '2.0.0',
      tasks: [
        { label: 'web', id: 'a/web', command: 'python' },
        { label: 'desk', id: 'a/desk', command: 'python' },
      ],
    }),
    'utf8',
  );
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-layoutsyncdata-'));
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  // 没写 buttons[] → 全部条目自动上条
  assert.equal(manager.listButtons().length, 2);

  // 外部手改：收起 a/web（显式把 mtime 拨到未来，避免同毫秒写撞车）
  const layoutFile = join(dataDir, 'layout.json');
  writeFileSync(layoutFile, JSON.stringify({ buttons: { 'a/web': { pinned: false } } }), 'utf8');
  const bumped = new Date(Date.now() + 5000);
  utimesSync(layoutFile, bumped, bumped);
  await manager.syncLayoutFromDisk();
  assert.deepEqual(
    manager.listButtons().map((button) => button.entry),
    ['a/desk'],
    '手改的收起要生效（不必重启 DSH）',
  );

  // 再改回来：全部恢复
  writeFileSync(layoutFile, JSON.stringify({ buttons: {} }), 'utf8');
  const bumpedAgain = new Date(Date.now() + 10000);
  utimesSync(layoutFile, bumpedAgain, bumpedAgain);
  await manager.syncLayoutFromDisk();
  assert.equal(manager.listButtons().length, 2, '改回来也要立刻生效');
});

await check('界面新建启动项：真的写进 run.json 的 tasks[]，条目立刻可用', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-newtask-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  const manifestPath = join(dir, '.dsh', 'run-deck', 'run.json');
  writeFileSync(
    manifestPath,
    [
      '{',
      '  // 人写的注释',
      '  "version": "2.0.0",',
      '  "tasks": [',
      '    { "label": "web", "id": "web", "command": "python" }',
      '  ]',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-newtaskdata-'));
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();

  const created = await manager.createTask(dir, { label: 'Dev server', command: 'npm run dev' });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const text = readFileSync(manifestPath, 'utf8');
  assert.ok(text.includes('// 人写的注释'), '注释要保留（手改和界面写的是同一个文件）');
  const parsed = JSON.parse(stripJsonComments(text));
  assert.equal(parsed.tasks.length, 2);
  assert.deepEqual(parsed.tasks[1], {
    label: 'Dev server',
    id: 'dev-server',
    command: 'npm',
    args: ['run', 'dev'],
  });

  // 项目被立刻重读：新条目马上出现在条目列表里，界面不用等下一轮轮询
  const project = manager.listProjects()[0];
  assert.ok(project?.entries.some((entry) => entry.id === 'dev-server'));

  // 建完就能钉上条（"加一个按钮"的完整意图）
  await manager.setButtonOverride('dev-server', { pinned: true });
  assert.ok(manager.listButtons().some((button) => button.entry === 'dev-server'));

  // 非法输入：拒绝，且**不许动文件**
  assert.equal((await manager.createTask(dir, { label: '  ', command: 'npm' })).ok, false);
  assert.equal((await manager.createTask(dir, { label: 'x', command: 'echo a\necho b' })).ok, false);
  assert.equal(
    JSON.parse(stripJsonComments(readFileSync(manifestPath, 'utf8'))).tasks.length,
    2,
    '失败的调用不能改文件',
  );

  // 同名再建一次：id 唯一化，不会互相覆盖
  const again = await manager.createTask(dir, { label: 'Dev server', command: 'node server.js' });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.notEqual(again.entry, created.entry);
});

await check('/task · /detect · /task/remove 走 HTTP：建 → 检测标"已在清单" → 删 + buttons[] 清理', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const { createRoutes } = await import(new URL('../lib/routes.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-taskhttp-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }), 'utf8');
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-taskhttpdata-'));
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  const routes = createRoutes({ manager, ready: Promise.resolve(), trustedHosts: () => [], log: () => {} });

  // 缺参必须报错：三个路由都不许"没给 projectRoot 也继续"
  const noRoot = await callRoute(routes, '/dsh-run-deck/api/task', '', { method: 'POST', body: {} });
  assert.equal(noRoot.ok, false);
  assert.match(noRoot.message, /projectRoot/);
  const noDetect = await callRoute(routes, '/dsh-run-deck/api/detect', '', { method: 'POST', body: {} });
  assert.equal(noDetect.ok, false);
  const noRemove = await callRoute(routes, '/dsh-run-deck/api/task/remove', '', {
    method: 'POST',
    body: { projectRoot: dir },
  });
  assert.equal(noRemove.ok, false);

  const taskPath = '/dsh-run-deck/api/task';

  // 字段级校验：给了但类型/取值不对的键要点名报错，不许静默当"没给"。
  // （openUrl 传字符串 "true" 曾经会落成一条不打开的默认任务——正整改的就是它。）
  const badOpenUrl = await callRoute(routes, taskPath, '', {
    method: 'POST',
    body: { projectRoot: dir, label: 'x', command: 'node', openUrl: 'true' },
  });
  assert.equal(badOpenUrl.ok, false);
  assert.match(badOpenUrl.message, /openUrl/, `要点名 openUrl：${badOpenUrl.message}`);
  const badEnv = await callRoute(routes, taskPath, '', {
    method: 'POST',
    body: { projectRoot: dir, label: 'x', command: 'node', env: { PORT: 3000 } },
  });
  assert.match(badEnv.message, /env\.PORT/, `要点名 env.PORT：${badEnv.message}`);
  const badGroup = await callRoute(routes, taskPath, '', {
    method: 'POST',
    body: { projectRoot: dir, label: 'x', command: 'node', group: 'runtime' },
  });
  assert.match(badGroup.message, /group/, `要点名 group：${badGroup.message}`);
  // 这些被拒的调用一个字节都不能落盘
  assert.equal(existsSync(join(dir, '.dsh', 'run-deck', 'run.json')), false, '坏类型请求不许建清单');

  // 显式 openUrl:false 与"没给"等价：合法形状，照常创建、不产生就绪动作
  const noOpen = await callRoute(routes, taskPath, '', {
    method: 'POST',
    body: { projectRoot: dir, label: 'NoOpen', command: 'node keep.js', openUrl: false },
  });
  assert.equal(noOpen.ok, true, `openUrl:false 应当合法：${noOpen.message ?? ''}`);

  // 检测一轮：dev 还是 package.json 里的候选，不该被标"已在清单"（作者标签与 NoOpen 无关）
  const detectPath = '/dsh-run-deck/api/detect';
  const detectBefore = await callRoute(routes, detectPath, '', {
    method: 'POST',
    body: { projectRoot: dir },
  });
  assert.equal(detectBefore.ok, true);
  if (!detectBefore.ok) return;
  assert.equal(detectBefore.packageManager ?? 'npm', 'npm');
  assert.equal(
    detectBefore.candidates.find((candidate) => candidate.key === 'package.json:dev')?.exists,
    false,
  );

  const created = await callRoute(routes, taskPath, '', {
    method: 'POST',
    body: {
      projectRoot: dir,
      label: 'API dev',
      command: 'npm run dev',
      isBackground: true,
      readyPattern: 'Local:',
      openUrl: true,
    },
  });
  assert.equal(created.ok, true, `建条失败：${created.message ?? ''}`);
  if (!created.ok) return;
  const document = JSON.parse(stripJsonComments(readFileSync(join(dir, '.dsh', 'run-deck', 'run.json'), 'utf8')));
  assert.equal(document.tasks.length, 2, 'NoOpen 与 api-dev 两条都在');
  const apiDev = document.tasks.find((task) => task.id === 'api-dev');
  assert.equal(apiDev.isBackground, true);
  const noOpenTask = document.tasks.find((task) => task.label === 'NoOpen');
  assert.equal(noOpenTask.serverReadyAction, undefined, 'openUrl:false 不产生就绪动作');

  // "已在清单"标记不再漂移：dev 现在就是清单里的命令（HTTP 一来一回都不敢断层）
  const detectMid = await callRoute(routes, detectPath, '', {
    method: 'POST',
    body: { projectRoot: dir },
  });
  assert.equal(detectMid.ok, true);
  if (!detectMid.ok) return;
  assert.equal(
    detectMid.candidates.find((candidate) => candidate.key === 'package.json:dev')?.exists,
    true,
  );

  // 先把这条收尾：no-open 这条也走 /task/remove（用创建结果里的真实 id，
  // 顺带验一遍"deriveId 会怎么拼"不再是测试里再猜一遍），
  // 为后面的"删空"断言让路
  const removedNoOpen = await callRoute(routes, '/dsh-run-deck/api/task/remove', '', {
    method: 'POST',
    body: { projectRoot: dir, entryId: noOpen.entry },
  });
  assert.equal(removedNoOpen.ok, true, `no-open 删不掉：${removedNoOpen.message ?? ''}`);

  const removePath = '/dsh-run-deck/api/task/remove';
  const removed = await callRoute(routes, removePath, '', {
    method: 'POST',
    body: { projectRoot: dir, entryId: 'api-dev' },
  });
  assert.equal(removed.ok, true, `删条失败：${removed.message ?? ''}`);
  const after = JSON.parse(stripJsonComments(readFileSync(join(dir, '.dsh', 'run-deck', 'run.json'), 'utf8')));
  assert.equal(after.tasks.length, 0, '删除要把 tasks[] 清空');
  assert.deepEqual(after.buttons ?? [], [], 'buttons[] 里不该留下悬空声明');

  // 删完再检测：dev 的"已在清单"标记要消失（读的是删除后的清单）
  const detectAfter = await callRoute(routes, detectPath, '', {
    method: 'POST',
    body: { projectRoot: dir },
  });
  assert.equal(detectAfter.ok, true);
  if (!detectAfter.ok) return;
  assert.equal(
    detectAfter.candidates.find((candidate) => candidate.key === 'package.json:dev')?.exists,
    false,
  );
});

await check('同清单两个并发 createTask 不丢改动：两条都落盘、清单可解析、id 各自唯一', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-race-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  const manifestPath = join(dir, '.dsh', 'run-deck', 'run.json');
  writeFileSync(
    manifestPath,
    '{\n  // 冲突会在这里露馅\n  "version": "2.0.0",\n  "tasks": []\n}\n',
    'utf8',
  );
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-racedata-'));
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();

  // 不加锁时这两个会同时从旧文本出发：后写者把先写者整条吞掉（lost update）；
  // 串行锁让后进者在锁里先看到前者的写入结果。
  const [first, second] = await Promise.all([
    manager.createTask(dir, { label: 'Alpha', command: 'node alpha.js' }),
    manager.createTask(dir, { label: 'Beta', command: 'node beta.js' }),
  ]);
  assert.equal(first.ok, true, `第一路失败：${first.ok ? '' : first.message}`);
  assert.equal(second.ok, true, `第二路失败：${second.ok ? '' : second.message}`);
  if (!first.ok || !second.ok) return;
  // 键的第一语义：先确认两条 id 都跟对方不同（防"两条同名互相覆盖"这一路径）
  assert.notEqual(first.entry, second.entry);

  const document = JSON.parse(stripJsonComments(readFileSync(manifestPath, 'utf8')));
  assert.equal(document.tasks.length, 2, '两条都必须活下来（谁也不许吞谁）');
  assert.ok(
    readFileSync(manifestPath, 'utf8').includes('// 冲突会在这里露馅'),
    '注释仍然保留',
  );
  const ids = document.tasks.map((task) => task.id).sort();
  assert.deepEqual(ids, [first.entry, second.entry].sort());
});

await check('重复显式 id：删除定位用的 id 派生与 resolveEntries 一致（界面看哪条就删哪条）', async () => {
  const text = [
    '{',
    '  "version": "2.0.0",',
    '  "tasks": [',
    '    { "label": "first", "id": "dup", "command": "node", "args": ["a"] },',
    '    { "label": "second", "id": "dup", "command": "node", "args": ["b"] }',
    '  ]',
    '}',
    '',
  ].join('\n');
  const root = join(tmpdir(), 'run-deck-dupid');
  const document = coerceDocument(JSON.parse(stripJsonComments(text))).document;
  const ids = resolveEntries(root, document).map((entry) => entry.id);
  // resolveEntries 的规则：第二条的显式 id 被占用 → 从 **id 串**派生出 dup-2
  assert.deepEqual(ids, ['dup', 'dup-2']);

  const removed = removeTaskFromManifestText(text, 'dup-2');
  assert.equal(removed.ok, true, `dup-2 应该能删到：${removed.ok ? '' : removed.message}`);
  if (!removed.ok) return;
  const remaining = JSON.parse(stripJsonComments(removed.text)).tasks;
  assert.equal(remaining.length, 1);
  assert.deepEqual(remaining[0].args, ['a'], '删掉的是第二条（不是界面 id 对不上的猜错那条）');
});

await check('空目录也能建第一条：没有 .dsh/run-deck/run.json 时自动创建', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-firsttask-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-firsttaskdata-'));
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  await manager.ensureProject(dir);

  // 空目录也是焦点：条一直在，只是没有按钮（不该变成"没有焦点"）
  const before = manager.state(dir);
  assert.equal(before.focused?.projectRoot, dir.replaceAll('\\', '/'));
  assert.match(before.focused?.reason ?? '', /这个目录还没有 \.dsh\/run-deck\/run\.json/);
  assert.deepEqual(before.buttons, []);
  assert.deepEqual(before.focusedEntries, []);

  // 界面上建第一条：清单文件自动创建（"不想手写配置文件"的出路）
  const created = await manager.createTask(dir, { label: 'Hello', command: 'node -e console.log(1)' });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const manifest = join(dir, '.dsh', 'run-deck', 'run.json');
  assert.ok(existsSync(manifest), '.dsh/run-deck/run.json 要自动创建出来');
  const parsed = JSON.parse(stripJsonComments(readFileSync(manifest, 'utf8')));
  assert.deepEqual(parsed.tasks[0], {
    label: 'Hello',
    id: 'hello',
    command: 'node',
    args: ['-e', 'console.log(1)'],
  });
  assert.equal(manager.state(dir).focusedEntries.length, 1, '建完立刻能出现在条目列表里');
});

await check('新增条目：工作目录 / 环境变量 / 长驻 / 就绪正则 / 打开地址 全部落进清单', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-rich-task-'));
  mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  const manifestPath = join(dir, '.dsh', 'run-deck', 'run.json');
  writeFileSync(
    manifestPath,
    ['{', '  // 人写的注释', '  "version": "2.0.0",', '  "tasks": []', '}', ''].join('\n'),
    'utf8',
  );
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-richtaskdata-'));
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();

  const created = await manager.createTask(dir, {
    label: 'Web dev',
    command: 'pnpm run dev',
    cwd: 'apps/web',
    env: { PORT: '3000', NODE_ENV: 'development' },
    isBackground: true,
    group: 'build',
    readyPattern: 'Local:\\s+(https?://\\S+)',
    openUrl: true,
    uriFormat: '%s',
    reveal: 'always',
    id: 'web-dev',
  });
  assert.equal(created.ok, true, created.ok ? '' : created.message);
  if (!created.ok) return;
  assert.equal(created.entry, 'web-dev');

  const text = readFileSync(manifestPath, 'utf8');
  assert.ok(text.includes('// 人写的注释'), '注释要保留（手改和界面写的是同一个文件）');
  const parsed = JSON.parse(stripJsonComments(text));
  assert.deepEqual(parsed.tasks[0], {
    label: 'Web dev',
    id: 'web-dev',
    command: 'pnpm',
    args: ['run', 'dev'],
    options: { cwd: 'apps/web', env: { PORT: '3000', NODE_ENV: 'development' } },
    isBackground: true,
    problemMatcher: { background: { endsPattern: 'Local:\\s+(https?://\\S+)' } },
    serverReadyAction: {
      action: 'openExternally',
      pattern: 'Local:\\s+(https?://\\S+)',
      uriFormat: '%s',
    },
    presentation: { reveal: 'always' },
    group: 'build',
  });
  // 多字段条目写成"一字段一行"：一行会横到屏幕外，但必须仍然是同一条合法 JSON
  assert.match(text, /\{\n\s+"label": "Web dev",\n\s+"id": "web-dev",/u);

  // 写进去的东西必须能被读取链路原样读回来（不是"只写进文件、界面读不到"）
  const entry = manager
    .listProjects()[0]
    ?.entries.find((candidate) => candidate.id === 'web-dev');
  assert.ok(entry !== undefined, '新条目应该能被解析出来');
  // 相对 cwd 相对项目根解析成绝对路径——spawn 拿到的是这个字符串，
  // 而 host 进程的工作目录不是项目根目录。
  assert.equal(entry?.cwd, `${dir.replaceAll('\\', '/')}/apps/web`);
  assert.equal(entry?.isBackground, true);
  assert.equal(entry?.serverReadyAction?.pattern, 'Local:\\s+(https?://\\S+)');
  assert.equal(entry?.raw?.options?.cwd, 'apps/web', 'raw 保留原样（复制时不能用展开后的绝对路径）');
});

await check('新增条目的字段校验：坏正则 / 不存在目录 / 坏变量名 / id 撞车 / onReady 都不落盘', async () => {
  const { buildTaskEntry } = await import(new URL('../lib/newtask.js', import.meta.url));
  const context = {
    root: 'D:/p',
    entries: [
      {
        id: 'web',
        label: 'web',
        type: 'shell',
        command: 'python',
        args: [],
        cwd: 'D:/p',
        isBackground: false,
        group: 'none',
      },
    ],
    directoryExists: async (path) => path.replaceAll('\\', '/') === 'D:/p/apps/web',
  };
  const base = { label: 'x', command: 'node server.js' };
  const cases = [
    [{ ...base, readyPattern: '(unclosed' }, /就绪正则写错了/u],
    [{ ...base, cwd: 'apps/nope' }, /工作目录不存在/u],
    [{ ...base, env: { '1BAD': 'x' } }, /环境变量名不合法/u],
    [{ ...base, env: { OK: 'a\nb' } }, /不能有换行/u],
    [{ ...base, id: 'web' }, /已被这个项目里的另一条占用/u],
    [{ ...base, id: 'has space' }, /只能由字母/u],
    [{ ...base, onReady: 'nope' }, /指向不存在的条目/u],
    [{ ...base, onReady: 'x' }, /不能指向自己/u],
    [{ ...base, openUrl: true }, /就得给一条 URL 正则/u],
    [{ ...base, openUrl: true, urlPattern: '(u', }, /URL 正则写错了/u],
    [{ ...base, openUrl: true, urlPattern: '(u)', uriFormat: 'http://x' }, /必须有 %s/u],
    [{ ...base, label: 'a\nb' }, /控制字符/u],
    [{ label: 'x', command: '"unclosed' }, /没有闭合/u],
  ];
  for (const [input, pattern] of cases) {
    const result = await buildTaskEntry(input, context);
    assert.equal(result.ok, false, `本该拒绝：${JSON.stringify(input)}`);
    assert.match(String(result.ok ? '' : result.message), pattern);
  }

  // 合法的一条：cwd 存在、id 自动派生、onReady 指向已有条目
  const good = await buildTaskEntry(
    {
      ...base,
      cwd: 'apps/web',
      env: { PORT: '3000' },
      isBackground: true,
      readyPattern: '(https?://\\S+)',
      openUrl: true,
      reveal: 'always',
      group: 'build',
      onReady: 'web',
    },
    context,
  );
  assert.equal(good.ok, true, good.ok ? '' : good.message);
  if (!good.ok) return;
  assert.equal(good.entryId, 'x');
  assert.deepEqual(good.task, {
    label: 'x',
    id: 'x',
    command: 'node',
    args: ['server.js'],
    options: { cwd: 'apps/web', env: { PORT: '3000' } },
    isBackground: true,
    problemMatcher: { background: { endsPattern: '(https?://\\S+)' } },
    serverReadyAction: { action: 'openExternally', pattern: '(https?://\\S+)' },
    presentation: { reveal: 'always' },
    group: 'build',
    onReady: 'web',
  });
});

await check('检测候选：读 package.json 的 scripts，猜包管理器 / 长驻 / 分组，并标出"已在清单"', async () => {
  const { detectTasks } = await import(new URL('../lib/detect.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-detect-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'demo',
      scripts: { dev: 'vite', build: 'tsc -b', 'test:unit': 'vitest', 'watch:css': 'sass --watch a:b' },
    }),
    'utf8',
  );
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '', 'utf8');
  const entries = [
    {
      id: 'dev',
      label: 'dev',
      type: 'shell',
      command: 'pnpm',
      args: ['run', 'dev'],
      cwd: dir,
      isBackground: true,
      group: 'none',
    },
  ];
  const result = await detectTasks(dir, entries);
  assert.equal(result.packageManager, 'pnpm', '锁文件说了用 pnpm');

  const byKey = new Map(result.candidates.map((candidate) => [candidate.key, candidate]));
  const dev = byKey.get('package.json:dev');
  assert.ok(dev !== undefined);
  assert.equal(dev.command, 'pnpm run dev');
  assert.equal(dev.exists, true, '清单里已有同命令的条目要标出来');
  assert.equal(dev.preset.isBackground, true, 'dev 这类脚本猜成"长驻"');
  assert.match(String(dev.preset.readyPattern), /https\?/u);
  assert.equal(byKey.get('package.json:build')?.preset.group, 'build');
  assert.equal(byKey.get('package.json:build')?.preset.isBackground, undefined);
  assert.equal(byKey.get('package.json:test:unit')?.preset.group, 'test');
  // 模板永远在：目录里什么都没有时也有东西可点
  assert.ok(result.candidates.some((candidate) => candidate.source === 'template'));

  // 没有 package.json 的目录：**不是告警**，只是没有可检测的脚本；模板仍然在。
  const empty = mkdtempSync(join(tmpdir(), 'run-deck-detect-empty-'));
  const none = await detectTasks(empty, []);
  assert.equal(none.warnings.length, 0, '没有 package.json 是正常空状态，不该进告警');
  assert.ok(none.candidates.every((candidate) => candidate.source === 'template'));

  // 文件在但读不了/不是合法 JSON：这才是告警（界面要说清"为什么没检测到"）
  writeFileSync(join(empty, 'package.json'), '{ not json', 'utf8');
  const broken = await detectTasks(empty, []);
  assert.ok(broken.warnings.some((warning) => warning.includes('不是合法 JSON')));
});

await check('界面删除条目：真的从 run.json 移除（含悬空 buttons[] 与本地覆盖）', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-deltask-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  const manifestPath = join(dir, '.dsh', 'run-deck', 'run.json');
  writeFileSync(
    manifestPath,
    [
      '{',
      '  // 手写注释',
      '  "version": "2.0.0",',
      '  "tasks": [',
      '    { "label": "web", "id": "web", "command": "python" },',
      '    { "label": "desk", "id": "desk", "command": "python" }',
      '  ],',
      '  "buttons": [',
      '    { "entry": "web", "icon": "eye" },',
      '    { "entry": "desk", "icon": "desk" }',
      '  ]',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-deltaskdata-'));
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  await manager.setButtonOverride('web', { pinned: true, order: 1 });
  assert.equal(manager.getLayout().buttons['web']?.order, 1);

  const removed = await manager.deleteTask(dir, 'web');
  assert.equal(removed.ok, true);

  const text = readFileSync(manifestPath, 'utf8');
  assert.ok(text.includes('// 手写注释'), '注释要保留');
  const parsed = JSON.parse(stripJsonComments(text));
  assert.deepEqual(parsed.tasks.map((task) => task.id), ['desk']);
  assert.deepEqual(parsed.buttons.map((button) => button.entry), ['desk'], '指向被删条目的按钮声明也要清掉');

  // 项目被重读：条目没了；本机布局里的覆盖也没了
  assert.deepEqual(manager.listProjects()[0]?.entries.map((entry) => entry.id), ['desk']);
  assert.equal(manager.getLayout().buttons['web'], undefined);

  // 删不存在的条目：报错且不动文件
  const missing = await manager.deleteTask(dir, 'nope');
  assert.equal(missing.ok, false);
  assert.equal(JSON.parse(stripJsonComments(readFileSync(manifestPath, 'utf8'))).tasks.length, 1);
});

await check('本地覆盖只改展示字段，写不进 command/args/cwd', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-btn-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(
    join(dir, '.dsh', 'run-deck', 'run.json'),
    JSON.stringify({
      version: '2.0.0',
      tasks: [{ label: 'web', id: 'a/web', command: 'python', args: ['a.py'] }],
      buttons: [{ entry: 'a/web', icon: 'eye' }],
    }),
    'utf8',
  );
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-btndata-'));
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  const before = manager.listProjects()[0]?.entries[0];
  await manager.setButtonOverride('a/web', {
    icon: 'hammer',
    group: 'zzz',
    label: 'renamed',
    order: 999,
  });
  const after = manager.listProjects()[0]?.entries[0];
  // entry 的语义字段一个都没动
  assert.equal(after?.command, before?.command);
  assert.deepEqual(after?.args, before?.args);
  assert.equal(after?.cwd, before?.cwd);
  assert.equal(after?.label, before?.label);
  // 展示字段变了
  const button = manager.listButtons()[0];
  assert.equal(button?.icon, 'hammer');
  assert.equal(button?.group, 'zzz');
  assert.equal(button?.label, 'renamed');
  assert.equal(button?.order, 999);
});

await check('buttons[] 指向不存在的条目时跳过并记告警', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-btn-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(
    join(dir, '.dsh', 'run-deck', 'run.json'),
    JSON.stringify({
      version: '2.0.0',
      tasks: [{ label: 'web', id: 'a/web', command: 'python' }],
      buttons: [{ entry: 'a/web' }, { entry: 'ghost' }],
    }),
    'utf8',
  );
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-btndata-'));
  const runtime = fakeRuntime();
  const manager = new RunDeckManager({
    ctx: runtime.ctx,
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  assert.equal(manager.listButtons().length, 1);
  assert.ok(
    manager.getWarnings().some((warning) => warning.includes('ghost')),
    '应有一条指向不存在条目的告警',
  );
});

await check('本地覆盖写的是 <dataDir>/layout.json，可以读回', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-btn-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(
    join(dir, '.dsh', 'run-deck', 'run.json'),
    JSON.stringify({
      version: '2.0.0',
      tasks: [{ label: 'web', id: 'a/web', command: 'python' }],
      buttons: [{ entry: 'a/web' }],
    }),
    'utf8',
  );
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-btndata-'));
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  await manager.setButtonOverride('a/web', { pinned: false, group: 'mine' });
  const layout = manager.getLayout();
  assert.equal(layout.buttons['a/web']?.pinned, false);
  assert.equal(layout.buttons['a/web']?.group, 'mine');
});

/* ================================================================== *
 * 第 5 步改版：焦点项目（按当前会话 cwd）+ 浮动层布局
 * ================================================================== */

/** 造一个带 manifest 的项目目录 + manager。 */
async function makeManager(manifest, runtimeOptions = {}) {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-focus-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(join(dir, '.dsh', 'run-deck', 'run.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-focusdata-'));
  const runtime = fakeRuntime(runtimeOptions);
  const manager = new RunDeckManager({
    ctx: runtime.ctx,
    version: '0.0.0',
    config: () => ({ dataDir, configPath: dir }),
    configSource: () => 'defaults',
    log:
      runtimeOptions.logs !== undefined
        ? (level, message) => runtimeOptions.logs.push(`${level}:${message}`)
        : () => {},
  });
  await manager.initialize();
  return { dir, manager, root: dir.replaceAll('\\', '/'), runtime };
}

/** 造一个 manager，但不把项目目录指进去（模拟"没扫到"）。 */
async function makeDetachedManager() {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-detached-'));
  const runtime = fakeRuntime();
  const manager = new RunDeckManager({
    ctx: runtime.ctx,
    version: '0.0.0',
    config: () => ({ dataDir, configPath: '' }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  return manager;
}

const MANIFEST_3 = {
  version: '2.0.0',
  tasks: [
    { label: 'web', id: 'web', command: 'python' },
    { label: 'desk', id: 'desk', command: 'python' },
    { label: 'build', id: 'build', command: 'python' },
  ],
  buttons: [
    { entry: 'build', order: 30 },
    { entry: 'web', order: 10 },
    { entry: 'desk', order: 20 },
  ],
};

await check('cwd 对不上任何项目时没有焦点，按钮与条目都为空', async () => {
  const { manager } = await makeManager(MANIFEST_3);
  const st = manager.state('D:/somewhere/else');
  assert.equal(st.focused.projectRoot, null);
  assert.deepEqual(st.buttons, []);
  assert.deepEqual(st.focusedEntries, []);
});

await check('state(项目根) 返回该项目的按钮，按 order 排好', async () => {
  const { dir, manager, root } = await makeManager(MANIFEST_3);
  const st = manager.state(dir);
  assert.equal(st.focused.projectRoot, root);
  assert.equal(st.buttons.length, 3);
  // order: web(10) < desk(20) < build(30)
  assert.deepEqual(st.buttons.map((b) => b.entry), ['web', 'desk', 'build']);
  // focusedEntries 是**全部**条目，不受 buttons[] 限制
  assert.equal(st.focusedEntries.length, 3);
});

await check('没有 buttons[] 时自动带出全部条目（策展不是准入）', async () => {
  const { manager, root } = await makeManager({
    version: '2.0.0',
    tasks: [
      { label: 'one', id: 'one', command: 'python' },
      { label: 'two', id: 'two', command: 'python' },
    ],
  });
  assert.deepEqual(manager.state(root).buttons.map((b) => b.entry), ['one', 'two']);
});

await check('buttons[] 指向不存在的条目时跳过并告警', async () => {
  const { manager, root } = await makeManager({
    version: '2.0.0',
    tasks: [{ label: 'one', id: 'one', command: 'python' }],
    buttons: [{ entry: 'one' }, { entry: 'ghost' }],
  });
  const st = manager.state(root);
  assert.equal(st.buttons.length, 1);
  assert.ok(st.warnings.some((w) => w.includes('ghost')));
});

await check('拖拽排序：reorderButtons 把给定顺序写成本地 order', async () => {
  const { manager, root } = await makeManager(MANIFEST_3);
  const result = await manager.reorderButtons(['build', 'desk', 'web']);
  assert.equal(result.ok, true);
  assert.deepEqual(manager.state(root).buttons.map((b) => b.entry), ['build', 'desk', 'web']);
});

await check('reorder 只写 order，不动图标/分组/标题', async () => {
  const { manager } = await makeManager(MANIFEST_3);
  await manager.setButtonOverride('web', { icon: 'hammer', group: 'mine', label: '我的' });
  await manager.reorderButtons(['build', 'desk', 'web']);
  const own = manager.getLayout().buttons['web'];
  assert.equal(own?.icon, 'hammer');
  assert.equal(own?.group, 'mine');
  assert.equal(own?.label, '我的');
  assert.equal(typeof own?.order, 'number');
});

await check('密度偏好持久化，且 state 里带回', async () => {
  const { manager, root } = await makeManager(MANIFEST_3);
  assert.equal(manager.state(root).layout.density, undefined, '缺省不该预设密度');
  await manager.setDensity('compact');
  assert.equal(manager.state(root).layout.density, 'compact');
  const { readLayout, layoutFileIn } = await import(new URL('../lib/store.js', import.meta.url));
  const file = layoutFileIn(manager.state().dataDir);
  assert.equal((await readLayout(file)).density, 'compact');
});

await check('非法密度被拒', async () => {
  const { manager } = await makeManager(MANIFEST_3);
  assert.equal((await manager.setDensity('enormous')).ok, false);
});

await check('正在跑的条目在按钮上带 active/status；停掉即消失', async () => {
  const { manager, root } = await makeManager(MANIFEST_3);
  const started = await manager.startRun({ projectRoot: root, entryId: 'web', sessionId: 'session-1' });
  assert.equal(started.ok, true);
  const web = manager.state(root).buttons.find((b) => b.entry === 'web');
  assert.equal(web?.active, true);
  assert.equal(web?.status, 'running');
  await manager.stopRun(manager.state().runs[0].runId);
  assert.equal(
    manager.state(root).buttons.find((b) => b.entry === 'web')?.active,
    undefined,
  );
});

await check('focusCwd 让任意目录成为焦点（无需注册成工作区）', async () => {
  const manager = await makeDetachedManager();
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-anydir-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(
    join(dir, '.dsh', 'run-deck', 'run.json'),
    JSON.stringify({ version: '2.0.0', tasks: [{ label: 'x', id: 'x', command: 'python' }] }),
    'utf8',
  );
  // 初始没扫到这个目录
  assert.equal(manager.state(dir).focused.projectRoot, null);
  const result = await manager.focusCwd(dir);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.focused.projectRoot, dir.replaceAll('\\', '/'));
  // 之后 state 就能看到它
  assert.equal(manager.state(dir).buttons.length, 1);
});

await check('focusCwd 对没有 manifest 的目录：仍是焦点，并说明原因', async () => {
  const manager = await makeDetachedManager();
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-empty-'));
  const result = await manager.focusCwd(dir);
  assert.equal(result.ok, true);
  if (result.ok) {
    // 条要一直在：空目录也算焦点，`+` 才有地方建第一条（而不是"没有焦点"整条消失）
    assert.equal(result.focused.projectRoot, dir.replaceAll('\\', '/'));
    assert.match(result.focused.reason ?? '', /这个目录还没有 \.dsh\/run-deck\/run\.json/);
  }
});

await check('cwd 大小写/分隔符不同也能对上同一个项目', async () => {
  const { dir, manager, root } = await makeManager(MANIFEST_3);
  const st = manager.state(dir.replaceAll('\\', '/').toUpperCase());
  assert.equal(st.focused.projectRoot, root);
  assert.equal(st.buttons.length, 3);
});

/* ────────────────────────────────────────────────────────────────────
 * 会话级插槽那条路。
 *
 * 回归背景：浮动条注册在会话级插槽 `conversation.input.overlay`，而宿主渲染它时
 * owner props 是**空对象**（ui-conversation: `renderSlot(key, {})`），会话 id 只能
 * 从注册项的 `inject(sessionId)` 拿。旧实现在组件里读 `props.sessionId`，于是：
 * 客户端恒为 undefined → 请求里既没有 cwd 也没有 sessionId → /state 返回
 * focused=null、buttons=[] → FloatingBar 返回 null → **按钮条永远不渲染**。
 * 修法：客户端把 sessionId 报上来，host 用内存会话存储的 header.cwd 解析成项目，
 * 并且**在请求时现读磁盘**（启动那一刻 workspaceRegistry/sessions 可能都是空的）。
 * ──────────────────────────────────────────────────────────────────── */

/** 假宿主 ctx：只提供 sessions 服务，形状与 live Inspect 目录一致。 */
function fakeSessionCtx(sessions) {
  return { get: (name) => (name === 'sessions' ? sessions : undefined) };
}

/**
 * 假宿主 ctx：sessions（内存存储）+ sessionController（会话目录）。
 *
 * 形状照抄本机 live 声明：`list → { items: SessionSummary[] }`、
 * `SessionSummary = { sessionId, cwd?, … }`；`inspect → { meta: SessionHeader, events }`、
 * `SessionHeader = { id, cwd?, … }`。
 */
function fakeCatalogCtx({ sessions, controller }) {
  return {
    get: (name) =>
      name === 'sessions' ? sessions : name === 'sessionController' ? controller : undefined,
  };
}

/** 假 ServerResponse：只记状态码与 body。 */
function fakeResponse() {
  return {
    status: 0,
    body: '',
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body;
    },
  };
}

/** 走一次真实的路由（method/url/headers 都是真实形状），返回解析后的 JSON。 */
async function callRoute(routes, path, query, options = {}) {
  const route = routes.find((candidate) => candidate.path === path);
  assert.ok(route !== undefined, `没有注册 ${path}`);
  const res = fakeResponse();
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  await route.handle(
    {
      method: options.method ?? 'GET',
      url: `${path}${query ?? ''}`,
      headers: { host: '127.0.0.1:43120' },
      ...(payload === null
        ? {}
        : {
            async *[Symbol.asyncIterator]() {
              yield Buffer.from(payload, 'utf8');
            },
          }),
    },
    res,
  );
  return JSON.parse(res.body);
}

await check('sessionCwd 从 host 会话存储的 header.cwd 解析出工作目录', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const manager = new RunDeckManager({
    ctx: fakeSessionCtx({
      get: (id) => (id === 's1' ? { id: 's1', header: { cwd: 'D:/Flora/ProgramProjects/jin' } } : undefined),
    }),
    version: '0.0.0',
    config: () => ({ dataDir: '', configPath: '' }),
    configSource: () => 'defaults',
    log: () => {},
  });
  assert.equal(manager.sessionCwd('s1'), 'D:/Flora/ProgramProjects/jin');
  assert.equal(manager.sessionCwd('  '), null);
  assert.equal(manager.sessionCwd('不存在'), null);
});

await check('sessions 服务缺失时 sessionCwd 返回 null，不抛错', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir: '', configPath: '' }),
    configSource: () => 'defaults',
    log: () => {},
  });
  assert.equal(manager.sessionCwd('s1'), null);
  assert.equal(await manager.sessionCwdAsync('s1'), null);
});

/* ── 会话目录兜底：这是"重启后空闲会话没有按钮"的修复 ── */

await check('空闲会话不在内存存储里时，sessionCwdAsync 退到会话目录（list）并只用对上号的那条', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const calls = { list: 0, inspect: 0 };
  const controller = {
    list: async () => {
      calls.list += 1;
      return {
        items: [
          { sessionId: 'idle-1', agentAvailable: false, cwd: 'D:/Flora/ProgramProjects/jin' },
          { sessionId: 'idle-2', agentAvailable: true, cwd: 'D:/Flora/ProgramProjects/Ceola' },
          { sessionId: 'idle-3', agentAvailable: false }, // 没有 cwd 的条目
        ],
      };
    },
    // 目录里查不到这条会话时，inspect 也**不该**编出一个 cwd 来
    inspect: async (id) => {
      calls.inspect += 1;
      return { meta: { id }, events: [] };
    },
  };
  const manager = new RunDeckManager({
    ctx: fakeCatalogCtx({ sessions: { get: () => undefined, list: () => [] }, controller }),
    version: '0.0.0',
    config: () => ({ dataDir: '', configPath: '' }),
    configSource: () => 'defaults',
    log: () => {},
  });
  assert.equal(await manager.sessionCwdAsync('idle-1'), 'D:/Flora/ProgramProjects/jin');
  assert.equal(await manager.sessionCwdAsync('idle-2'), 'D:/Flora/ProgramProjects/Ceola');
  assert.equal(calls.list, 2);
  // 同一个会话再来一次：走缓存，不再读目录
  assert.equal(await manager.sessionCwdAsync('idle-1'), 'D:/Flora/ProgramProjects/jin');
  assert.equal(calls.list, 2);
  // 目录里找不到的会话：不猜（既不编一个 cwd，也不抛错）
  assert.equal(await manager.sessionCwdAsync('idle-9'), null);
  assert.equal(calls.list, 3);
  assert.equal(calls.inspect, 1);
  // 条目在目录里但没有 cwd ⇒ 结论是"不知道"，不是"随便挑一个"
  assert.equal(await manager.sessionCwdAsync('idle-3'), null);
  assert.equal(await manager.sessionCwdAsync('  '), null);
});

await check('目录 list 里没有 cwd 时退到 inspect，且取 meta.cwd 而不是事件里的 cwd', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  let inspected = 0;
  const controller = {
    list: async () => ({ items: [{ sessionId: 's9' }] }),
    inspect: async (id) => {
      inspected += 1;
      // 事件流里也可能出现 cwd（工具调用），它**不是**这条会话的工作目录
      return { meta: { id, cwd: 'D:/Flora/ProgramProjects/tailtale' }, events: [{ cwd: 'D:/elsewhere' }] };
    },
  };
  const manager = new RunDeckManager({
    ctx: fakeCatalogCtx({ sessions: { get: () => undefined, list: () => [] }, controller }),
    version: '0.0.0',
    config: () => ({ dataDir: '', configPath: '' }),
    configSource: () => 'defaults',
    log: () => {},
  });
  assert.equal(await manager.sessionCwdAsync('s9'), 'D:/Flora/ProgramProjects/tailtale');
  assert.equal(inspected, 1);
  // 第二次从缓存拿，不再调 inspect（inspect 会把整条会话日志读进来，必须只走一次）
  assert.equal(await manager.sessionCwdAsync('s9'), 'D:/Flora/ProgramProjects/tailtale');
  assert.equal(inspected, 1);
});

await check('内存存储里有这条会话时不读会话目录；目录抛错也只记告警', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  let listed = 0;
  const live = {
    get: (id) => (id === 's1' ? { id: 's1', header: { cwd: 'D:/live' } } : undefined),
    list: () => [],
  };
  const controller = {
    list: async () => {
      listed += 1;
      throw new Error('目录服务不可用');
    },
  };
  const manager = new RunDeckManager({
    ctx: fakeCatalogCtx({ sessions: live, controller }),
    version: '0.0.0',
    config: () => ({ dataDir: '', configPath: '' }),
    configSource: () => 'defaults',
    log: () => {},
  });
  assert.equal(await manager.sessionCwdAsync('s1'), 'D:/live');
  assert.equal(listed, 0);
  // 目录抛错：返回 null（不猜），并把原因记进 warnings
  assert.equal(await manager.sessionCwdAsync('idle-1'), null);
  assert.equal(listed, 1);
  assert.ok(manager.getWarnings().some((line) => line.includes('目录服务不可用')));
});

await check('cwd 的来路与"没解析出来"各打一行日志（重启后为什么没按钮要能自查）', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const lines = [];
  const controller = {
    list: async () => ({ items: [{ sessionId: 'idle-1', cwd: 'D:/Flora/ProgramProjects/jin' }] }),
  };
  const manager = new RunDeckManager({
    ctx: fakeCatalogCtx({
      sessions: { get: (id) => (id === 's1' ? { id: 's1', header: { cwd: 'D:/live' } } : undefined), list: () => [] },
      controller,
    }),
    version: '0.0.0',
    config: () => ({ dataDir: '', configPath: '' }),
    configSource: () => 'defaults',
    log: (level, message) => lines.push(`${level}:${message}`),
  });
  assert.equal(await manager.sessionCwdAsync('s1'), 'D:/live');
  assert.ok(lines.some((line) => line.includes('内存会话存储') && line.includes('D:/live')));
  assert.equal(await manager.sessionCwdAsync('idle-1'), 'D:/Flora/ProgramProjects/jin');
  assert.ok(lines.some((line) => line.includes('会话目录 sessionController.list')));
  // 同一个会话只打一行（不会被 2.5 秒的轮询刷屏）
  const before = lines.length;
  await manager.sessionCwdAsync('s1');
  await manager.sessionCwdAsync('idle-1');
  assert.equal(lines.length, before);
  // 解析不出来时，日志里必须有一句能读的话，而不是什么都没有
  assert.equal(await manager.sessionCwdAsync('idle-9'), null);
  assert.ok(lines.some((line) => line.includes('没解析出工作目录') && line.includes('整条隐藏')));
});

await check('/state?sessionId= 端到端：会话不在内存存储里（重启后的空闲会话）也能出按钮', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const { createRoutes } = await import(new URL('../lib/routes.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-idle-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(join(dir, '.dsh', 'run-deck', 'run.json'), JSON.stringify(MANIFEST_3), 'utf8');
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-idledata-'));
  const manager = new RunDeckManager({
    ctx: fakeCatalogCtx({
      // 内存会话存储是空的 = 重启后这条会话只是被"查看"，没有被激活
      sessions: { get: () => undefined, list: () => [] },
      controller: { list: async () => ({ items: [{ sessionId: 'idle-1', cwd: dir }] }) },
    }),
    version: '0.0.0',
    config: () => ({ dataDir, configPath: '' }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  assert.equal(manager.listProjects().length, 0);

  const routes = createRoutes({
    manager,
    ready: Promise.resolve(),
    trustedHosts: () => [],
    log: () => {},
  });
  const st = await callRoute(routes, '/dsh-run-deck/api/state', '?sessionId=idle-1');
  assert.equal(st.focused.projectRoot, dir.replaceAll('\\', '/'));
  assert.equal(st.buttons.length, 3);
  // 没有会话 id 时仍然没有焦点（不是"随便猜一个项目"）
  const bare = await callRoute(routes, '/dsh-run-deck/api/state', '');
  assert.equal(bare.focused, null);
  assert.equal(bare.buttons.length, 0);
});

await check('ensureProject 把磁盘上的目录现读成项目（启动扫描为空也能用）', async () => {
  const manager = await makeDetachedManager();
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-ensure-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(join(dir, '.dsh', 'run-deck', 'run.json'), JSON.stringify(MANIFEST_3), 'utf8');
  assert.equal(manager.listProjects().length, 0);
  assert.equal(await manager.ensureProject(dir), true);
  assert.equal(manager.state(dir).buttons.length, 3);
  // 没有 manifest 的目录不追加，也不抛错
  assert.equal(await manager.ensureProject(mkdtempSync(join(tmpdir(), 'run-deck-none-'))), false);
});

await check('项目先被加载、清单后写出来：下一轮 ensureProject 就重读（不用重启）', async () => {
  const manager = await makeDetachedManager();
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-late-'));
  // 第一次进来时目录里没有清单：项目仍然算焦点（0 条），configFile 是 undefined
  const first = await manager.focusCwd(dir);
  assert.equal(first.ok, true);
  assert.deepEqual(manager.state(dir).buttons, []);

  // 之后手写清单。以前 manifestChanged 对 configFile===undefined 直接返回 false，
  // 于是要重启 DSH 才能看见按钮（QJin 加 gallery 时就是这么被绊住的）。
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(join(dir, '.dsh', 'run-deck', 'run.json'), JSON.stringify(MANIFEST_3), 'utf8');
  assert.equal(await manager.ensureProject(dir), true);
  assert.equal(manager.state(dir).buttons.length, 3);
});

await check('清单被改过时自动重读（不用重启、也不用知道 /run-deck list 会重读）', async () => {
  const logs = [];
  const { manager, dir, root } = await makeManager(MANIFEST_3, { logs });
  const manifest = join(dir, '.dsh', 'run-deck', 'run.json');
  assert.equal(manager.state(root).buttons.length, 3);

  // 改清单：换掉 buttons[]（只留一条），并把 mtime 往前推，保证与上次读到的不同
  writeFileSync(
    manifest,
    JSON.stringify({ version: '2.0.0', tasks: MANIFEST_3.tasks, buttons: [{ entry: 'desk' }] }),
    'utf8',
  );
  const later = new Date(Date.now() + 2000);
  utimesSync(manifest, later, later);

  // 走的是 /state 的那条路：先 ensureProject（它负责"现读 + 看 mtime"），再取状态
  await manager.ensureProject(root);
  const after = manager.state(root);
  assert.deepEqual(after.buttons.map((b) => b.entry), ['desk'], '改了 run.json 之后下一轮就该生效');
  assert.ok(logs.some((line) => line.includes('清单变了，已重读')));
  // 没再改就别重复读（只打一行）
  await manager.ensureProject(root);
  await manager.ensureProject(root);
  assert.equal(logs.filter((line) => line.includes('清单变了，已重读')).length, 1);
});

await check('清单被删掉时把过期的项目换掉（不再留旧按钮，但仍是焦点）', async () => {
  const { manager, dir, root } = await makeManager(MANIFEST_3);
  await manager.ensureProject(root);
  assert.equal(manager.state(root).buttons.length, 3);
  rmSync(join(dir, '.dsh', 'run-deck', 'run.json'));
  await manager.ensureProject(root);
  const after = manager.state(root);
  assert.deepEqual(after.buttons, [], '文件没了就不该还留着上一次的按钮');
  assert.equal(after.focused.projectRoot, root, '目录本身还在，条也要在（+ 可以重新建条目）');
  assert.match(after.focused.reason ?? '', /这个目录还没有 \.dsh\/run-deck\/run\.json/);
});

await check('/state?sessionId= 端到端：会话 → 项目 → 按钮（这是浮动条的主路径）', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const { createRoutes } = await import(new URL('../lib/routes.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'run-deck-wire-'));
  mkdirSync(join(dir, '.dsh', 'run-deck'), { recursive: true });
  writeFileSync(join(dir, '.dsh', 'run-deck', 'run.json'), JSON.stringify(MANIFEST_3), 'utf8');
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-wiredata-'));
  // configPath 留空 = 模拟"启动时一个项目根目录都没扫到"（日志里的 0 个项目根目录）
  const manager = new RunDeckManager({
    ctx: fakeSessionCtx({ get: (id) => (id === 's1' ? { id: 's1', header: { cwd: dir } } : undefined) }),
    version: '0.0.0',
    config: () => ({ dataDir, configPath: '' }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await manager.initialize();
  assert.equal(manager.listProjects().length, 0);

  const routes = createRoutes({
    manager,
    ready: Promise.resolve(),
    trustedHosts: () => [],
    log: () => {},
  });

  const withSession = await callRoute(routes, '/dsh-run-deck/api/state', '?sessionId=s1');
  assert.equal(withSession.focused.projectRoot, dir.replaceAll('\\', '/'));
  assert.equal(withSession.buttons.length, 3);
  assert.equal(withSession.focusedEntries.length, 3);

  // 不带任何参数 = 没有焦点，浮动层隐藏（切到没有 run.json 的目录就是这条）
  const without = await callRoute(routes, '/dsh-run-deck/api/state', '');
  assert.equal(without.focused, null);
  assert.equal(without.buttons.length, 0);

  // ?cwd= 那条路仍然有效
  const byCwd = await callRoute(
    routes,
    '/dsh-run-deck/api/state',
    `?cwd=${encodeURIComponent(dir)}`,
  );
  assert.equal(byCwd.buttons.length, 3);
});

await check('/ping 把客户端半边的诊断写进 host 日志', async () => {
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const { createRoutes } = await import(new URL('../lib/routes.js', import.meta.url));
  const lines = [];
  const manager = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir: '', configPath: '' }),
    configSource: () => 'defaults',
    log: () => {},
  });
  const routes = createRoutes({
    manager,
    ready: Promise.resolve(),
    trustedHosts: () => [],
    log: (level, message) => lines.push(`${level}:${message}`),
  });
  const ping = routes.find((candidate) => candidate.path.endsWith('/ping'));
  const res = fakeResponse();
  await ping.handle(
    {
      method: 'POST',
      url: '/dsh-run-deck/api/ping',
      headers: { host: '127.0.0.1:43120' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ stage: 'client-loaded' }), 'utf8');
      },
    },
    res,
  );
  assert.equal(JSON.parse(res.body).ok, true);
  assert.ok(lines.some((line) => line.includes('client ping: client-loaded')));
});

/* ================================================================== *
 * 执行接线：点按钮**真的起终端**（这条链路早先是断的：只登记、不起进程）
 * ================================================================== */

await check('起一条 run：真的开一条 PTY（ctx.subprocess.spawnTerminal）把命令行跑起来', async () => {
  const { manager, root, runtime } = await makeManager(MANIFEST_3);
  const result = await manager.startRun({
    projectRoot: root,
    entryId: 'web',
    sessionId: 'session-1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'running');
  assert.equal(result.pid, 4242);
  assert.equal(result.ownerSessionId, 'session-1');
  // 执行缝收到的是**完全指定**的 argv：shell + `/d /s /c` + run.json 里渲染出的命令行
  assert.equal(runtime.calls.spawn.length, 1);
  const spec = runtime.calls.spawn[0];
  assert.deepEqual(spec.argv, ['C:/Windows/system32/cmd.exe', '/d', '/s', '/c', 'python']);
  assert.equal(spec.cwd, root);
  assert.equal(spec.shellActivity, false, '执行完就退的 shell 不是交互式 shell');
  assert.equal(spec.terminalType, 'xterm-256color');
  assert.deepEqual(spec.env, { DSH_SESSION_ID: 'session-1' });
  // 同一条目重复跑仍被挡住：不再开第二条 PTY
  const again = await manager.startRun({
    projectRoot: root,
    entryId: 'web',
    sessionId: 'session-1',
  });
  assert.equal(again.ok, false);
  assert.equal(runtime.calls.spawn.length, 1);
});

await check('options.env 真的交给 PTY：与宿主环境叠加，值里的 ${env:…} 先展开', async () => {
  const { manager, root, runtime } = await makeManager({
    version: '2.0.0',
    tasks: [
      {
        label: 'web',
        id: 'web',
        command: 'python',
        options: { env: { PATH: 'C:/Qt/6.5.3/msvc2019_64/bin;${env:PATH}', PORT: '9001' } },
      },
    ],
  });
  const expectedPath = `C:/Qt/6.5.3/msvc2019_64/bin;${process.env.PATH ?? ''}`;
  assert.deepEqual(manager.state(root).focusedEntries[0].env, {
    PATH: expectedPath,
    PORT: '9001',
  });

  const result = await manager.startRun({ projectRoot: root, entryId: 'web', sessionId: 's1' });
  assert.equal(result.ok, true);
  const env = runtime.calls.spawn[0].env;
  assert.equal(env.PORT, '9001');
  assert.equal(env.PATH, expectedPath);
  assert.equal(env.DSH_SESSION_ID, 's1');
});

await check('POSIX 上是 <shell> -c；问不到默认 shell 时 Windows 退到 cmd.exe', async () => {
  const posix = await makeManager(MANIFEST_3, { platform: 'posix' });
  await posix.manager.startRun({ projectRoot: posix.root, entryId: 'web', sessionId: 's' });
  assert.deepEqual(posix.runtime.calls.spawn[0].argv, ['/bin/sh', '-c', 'python']);

  const bare = await makeManager(MANIFEST_3, { noShell: true });
  await bare.manager.startRun({ projectRoot: bare.root, entryId: 'web', sessionId: 's' });
  assert.deepEqual(bare.runtime.calls.spawn[0].argv, [
    'cmd.exe',
    '/d',
    '/s',
    '/c',
    'python',
  ]);
});

await check('没有 sessionId 也能跑（执行缝不需要 Agent owner）；缺执行缝时明确失败且不起进程', async () => {
  // sessionId 现在只是记录 + DSH_SESSION_ID，不再用来定 owner：
  // 空闲会话点按钮也能真跑起来（"点了没反应"的另一半原因就是这个）。
  const { manager, root, runtime } = await makeManager(MANIFEST_3);
  const anonymous = await manager.startRun({ projectRoot: root, entryId: 'web' });
  assert.equal(anonymous.ok, true);
  assert.equal(anonymous.ownerSessionId, undefined);
  assert.equal(runtime.calls.spawn[0].env, undefined);
  await manager.stopRun(anonymous.runId);

  // 有项目、没有 subprocess 服务（原样告诉人"缺什么"，而不是假装在跑）
  const { RunDeckManager } = await import(new URL('../lib/manager.js', import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), 'run-deck-nosub-'));
  const noSeam = new RunDeckManager({
    ctx: { get: () => undefined },
    version: '0.0.0',
    config: () => ({ dataDir, configPath: root }),
    configSource: () => 'defaults',
    log: () => {},
  });
  await noSeam.initialize();
  const failed = await noSeam.startRun({ projectRoot: root, entryId: 'web', sessionId: 'session-1' });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /subprocess/);
  assert.equal(failed.code, 'TERMINAL_UNAVAILABLE');

  // spawnTerminal 自己抛错 → 一条能读懂的失败
  const broken = await makeManager(MANIFEST_3, { spawnError: 'ConPTY 分配失败' });
  const spawnFailed = await broken.manager.startRun({
    projectRoot: broken.root,
    entryId: 'web',
    sessionId: 'session-1',
  });
  assert.equal(spawnFailed.ok, false);
  assert.match(spawnFailed.message, /ConPTY 分配失败/);
  assert.equal(spawnFailed.code, 'SPAWN_FAILED');
});

await check('停止：先给前台进程组发 SIGINT（脚本自己的清理处理器就挂在那上面）', async () => {
  const { manager, root, runtime } = await makeManager(MANIFEST_3);
  const started = await manager.startRun({
    projectRoot: root,
    entryId: 'web',
    sessionId: 'session-1',
  });
  const stopped = await manager.stopRun(started.runId);
  assert.equal(stopped.ok, true);
  assert.deepEqual(runtime.calls.signal, ['SIGINT']);
  assert.equal(runtime.calls.terminate.length, 0, 'SIGINT 投递成功时不该直接关掉 PTY');
  assert.equal(manager.state().runs.find((run) => run.runId === started.runId)?.status, 'exited');
});

await check('SIGINT 没投到时兜底 terminate 掉这条 PTY', async () => {
  const { manager, root, runtime } = await makeManager(MANIFEST_3, { signalError: '前台进程组解析不出来' });
  const started = await manager.startRun({
    projectRoot: root,
    entryId: 'web',
    sessionId: 'session-1',
  });
  await manager.stopRun(started.runId);
  assert.deepEqual(runtime.calls.signal, ['SIGINT']);
  assert.equal(runtime.calls.terminate.length, 1, 'SIGINT 未投递要落到 terminate');
});

await check('输出轮询：就绪 pattern → ready + 打开地址 + onReady 接力下一条（ANSI 要剥掉）', async () => {
  const manifest = {
    version: '2.0.0',
    tasks: [
      {
        label: 'desk',
        id: 'desk',
        command: 'python',
        isBackground: true,
        problemMatcher: {
          background: {
            activeOnStart: true,
            beginsPattern: '·',
            endsPattern: 'starting the desktop shell: (\\S+)',
          },
        },
        onReady: 'build',
      },
      {
        label: 'build',
        id: 'build',
        command: 'python',
        args: ['--build'],
        isBackground: true,
        problemMatcher: {
          background: {
            activeOnStart: true,
            beginsPattern: '·',
            endsPattern: 'built gallery served at (http\\S+)',
          },
        },
        serverReadyAction: {
          action: 'openExternally',
          pattern: 'built gallery served at (http\\S+)',
          uriFormat: '%s',
        },
      },
    ],
  };
  // 先让 desk 就绪（触发 onReady→build），再让 build 就绪（触发 openExternally）。
  // 输出里故意夹了 ANSI 颜色（ConPTY 的输出就是这个样子）。
  const logs = [];
  const { manager, root, runtime } = await makeManager(manifest, { logs });

  const started = await manager.startRun({
    projectRoot: root,
    entryId: 'desk',
    sessionId: 'session-1',
  });
  assert.equal(started.ok, true);
  runtime.feed('· 启动\r\n');
  runtime.feed('\u001B[32m✓ starting the desktop shell: app.exe\u001B[0m\r\n');
  // pollOnce 是内部方法：这里直接驱动一次，免得等 800ms 的定时器
  manager.pollOnce(started.runId);
  const desk = manager.state().runs.find((run) => run.runId === started.runId);
  assert.equal(desk.status, 'ready');
  // desk 的 endsPattern 第 1 组是 exe 路径（jin/desktop 就是这样），不是 URL
  assert.equal(desk.ready.url, 'app.exe');
  // 最近几行输出留在记录里（面板要说清"脚本自己为什么没起来"）
  assert.deepEqual(desk.tail, ['· 启动', '✓ starting the desktop shell: app.exe']);
  // 原始行带着颜色码一起留（输出悬浮卡画彩色控制台靠它）
  assert.equal(
    desk.rawTail?.[1],
    '\u001B[32m✓ starting the desktop shell: app.exe\u001B[0m',
  );
  // 轮询必须顺手让执行缝记一笔进程树（`inspectActivity()`）：它是 `terminate()`
  // 清理整棵树的唯一线索——这些脚本的中间进程会重新挂父，事后快照就找不回后代了
  // （实测泄漏的 vite preview 就是这么留下、并一直占着端口的）。
  assert.ok(runtime.calls.activity >= 1, '轮询里要调用 inspectActivity() 记进程树');

  // onReady 接力是 fire-and-forget：等一拍让它落地
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runtime.calls.spawn.length, 2, 'onReady 应当把下一条也起起来');
  assert.deepEqual(runtime.calls.spawn[1].argv.slice(0, 4), [
    'C:/Windows/system32/cmd.exe',
    '/d',
    '/s',
    '/c',
  ]);
  // 接力这件事要记进 run：界面得能说出"点这一条还顺带起了谁"
  // （否则"点一个按钮却跑起来两条"看起来就是故障）
  const deskAfter = manager.state().runs.find((run) => run.runId === started.runId);
  assert.equal(deskAfter.chainedTo, 'build');

  // 再接一步：build 的 poller 读到它的就绪行 → serverReadyAction 打开地址
  const buildRun = manager.state().runs.find((run) => run.entryId === 'build');
  assert.ok(buildRun !== undefined);
  runtime.feed('· build\r\nbuilt gallery served at http://127.0.0.1:5300/\r\n');
  manager.pollOnce(buildRun.runId);
  const buildAfter = manager.state().runs.find((run) => run.entryId === 'build');
  assert.equal(buildAfter.status, 'ready');
  assert.equal(buildAfter.ready.url, 'http://127.0.0.1:5300/');
  // 打开浏览器这件事**不在宿主侧做**：桌面版没有可用入口（实测），
  // 宿主只把地址记进 run + 留一行日志，由界面侧 window.open 交给系统浏览器。
  assert.deepEqual(runtime.calls.opened, [], '宿主不该自己去开浏览器');
  assert.ok(
    logs.some((line) => line.includes('serverReadyAction') && line.includes('http://127.0.0.1:5300/')),
    '日志里要留下"这个地址该被打开"的痕迹',
  );
});

await check('脚本自己退出（handle.done 结算）→ run 判为已退出，并带上退出码', async () => {
  const { manager, root, runtime } = await makeManager(MANIFEST_3);
  const started = await manager.startRun({
    projectRoot: root,
    entryId: 'web',
    sessionId: 'session-1',
  });
  assert.equal(started.ok, true);
  runtime.feed('done\r\n');
  runtime.exit(3, null);
  // 结算走的是 handle.done 的 then（微任务），等一拍再驱动一次轮询
  await new Promise((resolve) => setTimeout(resolve, 10));
  manager.pollOnce(started.runId);
  const run = manager.state().runs.find((candidate) => candidate.runId === started.runId);
  assert.equal(run.status, 'exited');
  assert.equal(run.exitCode, 3);
  assert.equal(run.endedAt !== undefined, true);
});

await check('tail 只留最近 200 行（输出面板要能看清"最近发生了什么"，又不无限吃内存）', async () => {
  const { manager, root, runtime } = await makeManager(MANIFEST_3);
  const started = await manager.startRun({ projectRoot: root, entryId: 'web', sessionId: 'session-1' });
  assert.equal(started.ok, true);
  for (let index = 0; index < 230; index += 1) runtime.feed(`第 ${index} 行\r\n`);
  manager.pollOnce(started.runId);
  const run = manager.state().runs.find((candidate) => candidate.runId === started.runId);
  assert.equal(run.tail.length, 200, '应恰好取最后 200 行');
  assert.equal(run.tail[0], '第 30 行', '前 30 行应被挤出尾巴');
  assert.equal(run.tail.at(-1), '第 229 行');
});

console.log(`\n${passed} checks passed${failed > 0 ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exitCode = 1;


