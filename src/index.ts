/**
 * dsh-run-deck — 包入口（host half）。
 *
 * `package.json` 的 `main` 指向编译产物 `lib/index.js`，Cordis 从这里读取
 * `name` / `inject` / `apply` / `Config`。
 */
export { Config, default, apply, inject, name, version } from './host.js';
