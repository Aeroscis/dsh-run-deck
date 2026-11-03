/**
 * dsh-run-deck — client bundle builder.
 *
 * `tsc -p tsconfig.client.json` 把 `src/client.tsx` 编译成标准 ESM
 * （`build/client/client.js`），但 DSH 浏览器端加载的是 **ModuleLoader 包**：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * 本脚本做且只做这一层确定性包装：
 *   1. 把源码里的版本占位符 `__DSH_PLUGIN_VERSION__` 换成 package.json 的 version
 *      （客户端半边读不到 package.json，只能在构建期定版；找不到占位符即失败）；
 *   2. 删掉 `import React from "react"`，改为工厂内 `require("react")`（react 是平台
 *      静态 seed 模块）；
 *   3. 把 `export default X` 变成 `var __plugin = X`，工厂末尾 `module.exports = __plugin`；
 *   4. 包上 ModuleLoader 头。
 *
 * **`id` 必须等于 package.json 的 `name`**（不是目录名、也不是短名）：宿主按包名查工厂，
 * 对不上就整批报 `loaded without registering "<pkg>"`。所以从 package.json 现读。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compiledFile = join(root, 'build', 'client', 'client.js');
const outFile = join(root, 'client', 'client.js');

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const PLUGIN_ID = packageJson.name;
if (typeof PLUGIN_ID !== 'string' || PLUGIN_ID.length === 0) {
  throw new Error('build-client: package.json 里没有可用的 name，无法确定 ModuleLoader 注册 id');
}

const VERSION_PLACEHOLDER = '__DSH_PLUGIN_VERSION__';
const PLUGIN_VERSION = packageJson.version;
if (typeof PLUGIN_VERSION !== 'string' || PLUGIN_VERSION.length === 0) {
  throw new Error('build-client: package.json 里没有可用的 version，无法给客户端半边定版');
}

function indent(text, pad) {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : pad + line))
    .join('\n');
}

const source = await readFile(compiledFile, 'utf8');
let body = source;

// 1) 版本占位符 → package.json 的 version（客户端半边的定版点）。
if (!body.includes(VERSION_PLACEHOLDER)) {
  throw new Error(
    `build-client: ${compiledFile} 里没有找到 ${VERSION_PLACEHOLDER}（src/client.tsx 的 CLIENT_VERSION），构建契约已变化`,
  );
}
body = body.replaceAll(VERSION_PLACEHOLDER, PLUGIN_VERSION);

// 2) react 由 ModuleLoader 工厂注入，不使用 ESM 导入。
const reactImport = /^\s*import\s+React\s*(?:,\s*\{[^}]*\})?\s+from\s+["']react["'];?\s*$/mu;
if (!reactImport.test(body)) {
  throw new Error(`build-client: ${compiledFile} 中没有找到预期的 \`import React from "react"\`，构建契约已变化`);
}
body = body.replace(reactImport, '');

// 3) 默认导出 → 局部变量。
if (!/^\s*export default\s/mu.test(body)) {
  throw new Error(`build-client: ${compiledFile} 中没有找到 \`export default\`，构建契约已变化`);
}
body = body.replace(/^\s*export default\s/mu, 'var __plugin = ');

// 4) 允许 tsc 生成的空 `export {};` 之类，其余 import/export 一律失败。
body = body.replace(/^\s*export\s*\{\s*\};?\s*$/mu, '');
const leftover = body
  .split('\n')
  .map((line, index) => ({ line: line.trim(), index: index + 1 }))
  .filter(({ line }) => /^import\s|^export\s|^import\(/u.test(line));
if (leftover.length > 0) {
  throw new Error(
    `build-client: 编译产物中仍有未处理的 ESM 语句（ModuleLoader 只接受 CJS 风格工厂）：\n` +
      leftover.map(({ line, index }) => `  ${compiledFile}:${index}: ${line}`).join('\n'),
  );
}

body = body.replace(/\n{3,}/gu, '\n\n').trim();

const banner = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PLUGIN_ID)},
  factory: (require) => {`;

const bundle = `/**
 * dsh-run-deck — client half（构建产物，请勿直接编辑）。
 *
 * 源文件：src/client.tsx；构建：npm run build:client
 * （tsc → build/client/client.js → 本脚本包装成 ModuleLoader 包）。
 *
 * 运行在 DSH Web 页面里，通过 ctx.slots / ctx.locale 与宿主通信，
 * 通过 fetch("/dsh-run-deck/api/*") 与 host half 通信。
 */
${banner}
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

${indent(body, '    ')}

    module.exports = __plugin;
    return module.exports;
  },
});
`;

// 自检：产出的包必须真的以包名注册。
if (!bundle.includes(banner)) {
  throw new Error(`build-client: 产出的包没有以 id: ${JSON.stringify(PLUGIN_ID)} 注册`);
}
// 自检 2：版本必须真的注入进去了。
if (bundle.includes(VERSION_PLACEHOLDER)) {
  throw new Error(`build-client: 产物里仍残留 ${VERSION_PLACEHOLDER}，版本注入没有生效`);
}
if (!bundle.includes(`'${PLUGIN_VERSION}'`) && !bundle.includes(`"${PLUGIN_VERSION}"`)) {
  throw new Error(
    `build-client: 产物里找不到 package.json 的版本 ${PLUGIN_VERSION}，客户端半边会与 host 报的版本对不上`,
  );
}

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, bundle, 'utf8');
console.log(`build-client: wrote ${outFile} (${bundle.length} bytes, id=${PLUGIN_ID}, version=${PLUGIN_VERSION})`);
