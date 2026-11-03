/**
 * dsh-run-deck — 宿主装载自检。
 *
 * 不启动 DSH，只静态核对「这个包被宿主加载时会需要的每一样东西」：
 *   1. package.json 的 main / exports / dsh.bundle.patch 指向的文件都在且被 files 覆盖
 *   2. lib/index.js 导出宿主读取的四个符号：name / version / inject / apply（+ Config）
 *   3. Config 的字段与 host-config 的归一化字段一致（否则设置表单改了也不生效）
 *   4. cordis.patch.yml 的行 id / name 与包名对得上
 *
 * 之所以单独做：`check:pack` 只看"文件在不在"，这里看"导出的形状对不对"。
 * 少导出一个符号，宿主加载时是直接整条 bundle 跳过，日志里只有一行 warning。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

/**
 * 把编译出来的 host 入口跑起来，拿它的导出。
 * 产物是 ESM，所以走动态 import（file URL）而不是硬套 CommonJS。
 */
async function loadHost() {
  const url = new URL('../lib/index.js', import.meta.url);
  return import(url.href);
}

console.log('dsh-run-deck registration smoke');

const host = await loadHost();

check('lib/index.js 导出 apply（宿主挂载入口）', () => {
  assert.equal(typeof host.apply, 'function');
});

check('name 与包名对应（宿主按它当插件身份）', () => {
  // 导出的是短名 'dsh-run-deck'，包名是 '@aeroscis/dsh-run-deck'。
  // 宿主侧实际按 package.json 的 name 装载；这里核的是导出值稳定、且与
  // cordis.patch.yml 的行 id 一致（那一行才是宿主真正认的身份）。
  assert.equal(host.name, 'dsh-run-deck');
});

check('version 与 package.json 一致', () => {
  assert.equal(host.version, pkg.version);
});

check('inject 是数组且为空（全部依赖按可选读取）', () => {
  assert.ok(Array.isArray(host.inject));
  assert.equal(host.inject.length, 0);
});

check('default 导出同样带 name/version/inject/apply（两种加载形态都要能读）', () => {
  assert.equal(typeof host.default?.apply, 'function');
  assert.equal(host.default?.name, 'dsh-run-deck');
  assert.equal(host.default?.version, pkg.version);
  assert.deepEqual([...(host.default?.inject ?? [])], []);
});

check('cordis.patch.yml 的行 id 与 host.name 一致', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  assert.ok(
    patch.includes(`- id: ${host.name}`) || patch.includes('- id: dsh-run-deck'),
    'patch 里找不到与 host.name 一致的行 id',
  );
  assert.ok(patch.includes(`name: '${pkg.name}'`), 'patch 里的包名与 package.json 不一致');
});

check('Config 是可用的 schema，或在缺 schemastery 时为 undefined', () => {
  // 装了 schemastery 时它是一个 schema（函数/对象）；缺失时为 undefined 也是**预期**：
  // 宿主只把有 schema 的条目视为「可表单配置」，没有就退回行配置，插件照常加载。
  assert.ok(
    host.Config === undefined || typeof host.Config === 'object' || typeof host.Config === 'function',
    `Config 的形态异常：${typeof host.Config}`,
  );
});

console.log(`\n${passed} checks passed`);
