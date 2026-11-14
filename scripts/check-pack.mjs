/**
 * dsh-run-deck — 发布形态自检（`npm run check:pack`，也挂在 `prepack` 上）。
 *
 * 为什么需要它：`npm pack` 只按 package.json 的 `files` 白名单取文件——
 * 少写一条，装到你插件的人就会遇到"包能装上但运行时报模块找不到"，
 * 而这类错误在源码目录里跑 `npm run check` 是**发现不了**的（源码目录里什么都在）。
 *
 * 这里只做静态检查，不起子进程（沙箱里管道 stdio 会失败）。
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/** 某个相对路径是否被 `files` 里的某一条覆盖（条目是文件/目录名）。 */
function covered(relPath) {
  const entries = Array.isArray(pkg.files) ? pkg.files : [];
  return entries.some((entry) => {
    const clean = String(entry).replace(/^\.\//u, '').replace(/\/+$/u, '');
    return relPath === clean || relPath.startsWith(`${clean}/`);
  });
}

check('package.json 声明了 files 白名单', () => {
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'files 必须存在且非空');
});

check('运行时入口存在，且都被 files 覆盖', () => {
  const entries = [
    pkg.main, // lib/index.js
    pkg.exports?.['./client'], // client/client.js
    pkg.dsh?.bundle?.patch, // cordis.patch.yml
    pkg.exports?.['./cordis.patch.yml'],
  ].filter((value) => typeof value === 'string');

  assert.ok(entries.length >= 3, `入口声明不完整：${JSON.stringify(pkg.exports)}`);
  for (const entry of entries) {
    const rel = entry.replace(/^\.\//u, '');
    assert.ok(existsSync(join(root, rel)), `入口文件不存在：${rel}`);
    assert.ok(covered(rel), `入口未被 files 覆盖，装包后会缺失：${rel}`);
  }
});

check('lib/ 下每个编译产物都在 files 覆盖范围内', () => {
  const dir = join(root, 'lib');
  assert.ok(existsSync(dir), 'lib/ 不存在，请先 npm run build');
  const files = readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 0, 'lib/ 里没有编译产物');
  for (const name of files) {
    assert.ok(covered(`lib/${name}`), `lib/${name} 未被 files 覆盖`);
  }
});

check('client/ 下的构建产物在 files 覆盖范围内', () => {
  const dir = join(root, 'client');
  assert.ok(existsSync(dir), 'client/ 不存在，请先 npm run build:client');
  const files = readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 0, 'client/ 里没有构建产物');
  for (const name of files) {
    assert.ok(covered(`client/${name}`), `client/${name} 未被 files 覆盖`);
  }
});

check('发布物包含源码与构建脚本（别人要能复核、能重建）', () => {
  for (const required of ['src', 'scripts', 'tsconfig.json', 'tsconfig.client.json']) {
    assert.ok(
      (Array.isArray(pkg.files) ? pkg.files : []).includes(required),
      `files 缺少 ${required}`,
    );
    assert.ok(existsSync(join(root, required)), `${required} 在磁盘上不存在`);
  }
});

check('README 里链接的本地文档都在发布物里', () => {
  // 少写一条 files，装到你插件的人点 README 里的链接会 404——源码目录里看不出来。
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  // 只取 Markdown 链接的本地目标：排除 http(s)、锚点、包内协议。
  const targets = [...readme.matchAll(/\]\(([^)\s]+)\)/gu)]
    .map((match) => match[1])
    .filter((target) => !/^(https?:|mailto:|#)/u.test(target))
    .map((target) => target.split('#')[0])
    .filter((target) => target !== '');
  assert.ok(targets.length > 0, 'README 里没有本地链接，这条检查失去意义');
  for (const target of targets) {
    const rel = target.replace(/^\.\//u, '');
    assert.ok(existsSync(join(root, rel)), `README 链接的目标不存在：${rel}`);
    assert.ok(covered(rel), `README 链接的目标没有被 files 覆盖，装包后会缺失：${rel}`);
  }
});

check('插件清单（dsh 字段）完整：bundle patch + client platform', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.equal(pkg.dsh?.client?.inject, undefined, '行内图标自绘，不需要声明宿主图标包依赖');
});

check('cordis.patch.yml 真的插入本插件行', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes('insert:'), 'patch 里没有 insert 段');
  assert.ok(
    patch.includes(`name: '${pkg.name}'`) || patch.includes(`name: "${pkg.name}"`),
    `patch 里找不到 name: ${pkg.name}`,
  );
});

check('client/client.js 是用当前 package.json 的版本构建的', () => {
  const bundle = readFileSync(join(root, 'client', 'client.js'), 'utf8');
  assert.ok(
    !bundle.includes('__DSH_PLUGIN_VERSION__'),
    'client/client.js 里还留着版本占位符：npm run build:client 没有跑过',
  );
  const match = /CLIENT_VERSION\s*=\s*['"]([^'"]+)['"]/u.exec(bundle);
  assert.ok(match !== null, 'client/client.js 里找不到 CLIENT_VERSION，构建契约已变化');
  assert.equal(
    match[1],
    pkg.version,
    `client/client.js 的 CLIENT_VERSION 是 ${match[1]}，package.json 是 ${pkg.version}`,
  );
  assert.ok(bundle.includes(`id: ${JSON.stringify(pkg.name)}`), '包没有按包名注册');
});

console.log(`\n✅ 发布形态自检 ${passed} 项通过`);
