# 交接：dsh-run-deck 插件「装了但界面不显示」

## 一句话

DSH 插件 `@aeroscis/dsh-run-deck` 的**功能代码已全部完成并通过 103 项离线检查**，但**插件的 UI 从未在桌面上出现过**。需要你定位"挂不上"的原因。请不要重新讨论已定死的设计（见 §3）。

---

## 1. 环境事实

| 项 | 值 |
| --- | --- |
| DSH Desktop | 2.0.17，host `dsh` 0.2.0-rc.2，node v24.18.1 |
| `DSH_HOME` | `C:\Users\Aeroscis\.dsh` |
| profile | `desktop`（Electron 保留名，`dsh plugin --profile desktop` 会被拒；npm CLI 只是转给 pnpm） |
| 插件源码 | `D:\Flora\ProgramProjects\dsh-run-deck`（包名 `@aeroscis/dsh-run-deck`） |
| 参考插件 | `D:\Flora\ProgramProjects\dsh-temptask`（同作者、已装好、可对照） |
| GUI | `http://127.0.0.1:43120` |
| 宿主日志 | `%APPDATA%\DSH Desktop\logs\host\dsh-YYYY-MM-DD.log` ← **最有用** |
| 应用日志 | `%APPDATA%\DSH Desktop\logs\dsh-YYYY-MM-DD.log` |
| 诊断包 | `%APPDATA%\DSH Desktop\diagnostics\*.zip` |
| DSH 运行时 | `C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\` |

**探不到宿主 API**：直接 `Invoke-WebRequest http://127.0.0.1:43120/dsh-run-deck/api/state` 会被宿主自己的网关拦成 `403 text/plain forbidden`（**不是**本插件的围栏——本插件返回 JSON）。要读运行期状态就走日志。

## 2. 安装方式（已装好）

`~/.dsh/profiles/desktop/package.json`：

```json
"dependencies": { "@aeroscis/dsh-run-deck": "link:D:/Flora/ProgramProjects/dsh-run-deck" },
"dsh": { "profile": { "bundles": [ ..., "@aeroscis/dsh-run-deck" ], "patchReload": "live" },
         "desktopDeselectedBundles": [] }
```

然后在该目录 `pnpm install`（建一个 junction 指向源码），**重启应用**。自检：`node _probe/run/installcheck.mjs`（11 项，全过）。

⚠️ 两个坑：
- 插件管理器会**反复改写** profile 的 `package.json`，把插件挪进 `desktopDeselectedBundles`。发现插件"消失"先查这里。
- junction 指向源码目录，所以**改完源码必须重新构建**（见 §6 的构建陷阱）。

## 3. 已定死的设计（**不要重新讨论**）

1. **词汇表照抄 VS Code tasks.json**，不发明概念。已有字段：`type/command/args/options.cwd/isBackground/problemMatcher(background.beginsPattern/endsPattern)/presentation/group/${input:id}/${workspaceFolder}/${env:X}/平台段/serverReadyAction`。**不许**新造 `ready`/`on`/`${ready.1}` 这类东西（上一版被否）。
2. **不拆文件，一个 `tasks` 数组**。没有调试器，launch.json 那半边整个不需要。长驻只是"跑完不退出"，用 `isBackground: true`。
3. **只有三处增量，且全部可删**（删了配置仍能跑）：`buttons[]`（浮动层策展，只是 entry 别名+图标+分组）、`onReady: "<entry id>"`（就绪后接另一个 entry，补 VS Code issue #69311；**只接受 entry id，不接受命令**）、`id`（跨族唯一标识，给外部按名字调用；`label` 可重名不能当接口）。
4. **配置是指针，不是编排**。命令指向已有脚本，逻辑留在脚本里。项目里现成的几百行 `start_common.py` 一行都不用改。
5. **落点**：项目里放 `.dsh/run-deck/run.json`（**不是** `.vscode/`）；插件里另存机器本地的个人覆盖（按钮顺序/显隐/图标/密度），**不进仓库**。
6. **执行走终端，不走后台 job**。第 1 步三轮探针实测：job 派生的进程 `GetConsoleProcessList()==0`，没有控制台可挂，Python 的 SIGINT/SIGTERM/SIGBREAK 处理器**一次都没跑**，`taskkill /T` 没执行，孙进程被孤立 → 端口被占。结论见 `docs/blocker-findings.md`，探针在 `_probe/`。
7. **安全**：host half spawn 的进程绕过 agent 的 pwsh 沙箱 → 命令必须是 run.json 里的**字面量**，绝不能是扫目录发现的可执行文件；**任何接口都不接受自由命令**，只接受 `{projectRoot, entryId}` 指针。
8. **动作序列（steps/dependsOn）明确不做**——要编排回到 `&&`。
9. **UI 形态**（使用者已确认，字符画在 README §7）：输入框上沿一条按钮条；**与输入框同左边缘**；高度与宿主原生「回到底部」按钮一致（34px）；三档密度（full 图标+名字 / compact 图标+定长截断 / icon 纯图标）由左侧固定钮循环切换，宽度不够时**逐级降档**、挤不掉进 `⋯` 溢出菜单；右侧两个固定钮 `+`（完整管理面板，列出当前工作区**全部**条目，`⋮⋮` hamburger 按住拖拽排序）与 `⚙`（设置：manifest/来源/运行中 run/告警/密度/能力/版本）；**跟着当前会话的工作区变**；切到没有 `.dsh/run-deck/run.json` 的目录时**整条隐藏**。
10. 已删除：上一版的「侧边栏入口行 + 主面板」（使用者明确要求删）。

## 4. 交付顺序与状态

| 步 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 三个阻塞项探针 + 路线选择 | ✅ 结论见 `docs/blocker-findings.md` |
| 2 | 手动动作列表（跑/停/重跑，零 schema 增量） | ✅ |
| 3 | 事件钩子语义（beginsPattern/endsPattern/serverReadyAction/onReady） | ✅ 语义层完整；**真实 stdout 接线未做**（见 §7 已知缺口） |
| 4 | 外部按 id 调用（`run-deck` 工具 + `/run-deck` 命令） | ✅；快捷键没做（DSH 无 keybinding 服务） |
| 5 | `buttons[]` 浮动层（三档密度/拖拽排序/`+`/`⚙`） | ✅ 代码完成，**但从未渲染出来** ← 你要解决的问题 |
| 6 | steps/dependsOn | ❌ 按设计不做 |

## 5. 现在的症状与**决定性证据**

宿主半边**完全正常**，日志每次启动都有：

```
[dsh-run-deck] 已注册 /run-deck 命令
[dsh-run-deck] 已注册 run-deck 工具
[dsh-run-deck] 已挂载 11 条 HTTP 路由（/dsh-run-deck/api/*）
```

**但界面里什么都没有。** 最新一次重启（21:49，已加载本轮新代码）的日志：

```
[dsh-run-deck] 清单扫描：0 个项目根目录，其中 0 个有可用条目
[dsh-run-deck] v0.1.0 已就绪：0 个项目根目录、0 个条目，配置来源 plugin-config
```

### 关键推论

`清单扫描：0 个项目根目录` 这一行是我本轮加的诊断，它说明**两个服务都取不到东西**：

```ts
ctx.get('workspaceRegistry')?.list()   // → 空
ctx.get('sessions')?.list()            // → 空（这条是本轮才加的，同样空）
```

而已知磁盘上确实有 12 个工作区（含 jin / Ceola / tailtale），且 `~/.dsh/storages/workspace.json` 里 `workspaceIds` 有 12 条。同一份代码**离线跑（喂假 ctx）时两种来源都能正确解析出项目**。

### 最可能的根因（首要假设）

`src/host.ts` 里：

```ts
export const inject: string[] = [];   // 全部依赖按可选处理
```

**插件不声明任何依赖**，所以那些服务可能根本不在本 fiber 的服务作用域里，`ctx.get(name)` 恒为 `undefined`。请优先验证这一点——加一行把可用服务名打出来，或试 `ctx.inject(['workspaceRegistry','sessions'], ...)`。

参考：`dsh-temptask` 也是 `inject: []`，但它用到的 `sessionController` / `workspaceRegistry` 是否真的可用，**本轮没验证过**——可以拿它当对照组读日志。

### 第二假设：客户端半边从未挂载

完全没有证据表明浏览器加载了 `client/client.js`。注册用的是：

```ts
slots.inject('conversation.input.overlay', () =>
  slots.register({ name: 'conversation.input.overlay', id: 'dsh-run-deck-bar', order: 50, ... },
    (raw) => React.createElement(FloatingBarHost, { runtime, ctx, sessionId: raw?.sessionId })))
```

选这个插槽的理由：它是**会话级**（`kind:"list", scope:"session"`），宿主会把 `sessionId` 交给组件（对照 `dsh-client-ui-jobs` 的 `JobListAction({ sessionId, ... })`），而且位置在输入框卡片上沿、由宿主排版。**但没验证过它真的会渲染我的组件。**

## 6. 怎么继续查（建议顺序）

**先做二分定位**——这三步能把问题切到唯一一环，每步都能只看日志：

1. **客户端半边加载了吗？** 在 `apply()` 里（不是组件里）加一次 `POST /dsh-run-deck/api/ping {stage:'client-loaded'}`，host 路由把它写进日志。有日志 = 包被加载；没日志 = 包没被 renderer 取到。
2. **插槽渲染了吗？** 再在组件函数体里 `POST {stage:'slot-rendered'}`。这一步区分"注册成功但不渲染" vs "渲染了"。
3. **按钮数据有吗？** 组件里把 `/state` 的 `buttons.length` 与 `focused` 一起报上来。

同时加一条 host 诊断：

```ts
// 列出本 fiber 真正能 get 到的服务名
for (const n of ['workspaceRegistry','sessions','terminals','webServer','commands','tools']) {
  log('info', `service ${n}: ${ctx.get(n) === undefined ? 'MISSING' : 'ok'}`);
}
```

### 构建陷阱（务必注意）

我因为这坑白让使用者重启了两次：**`tsc --noEmit` 只做类型检查、不产出文件**。改完 `src/client.tsx` 必须：

```powershell
cd D:\Flora\ProgramProjects\dsh-run-deck
npm run build:client          # 或 npm run build（host+client）
# 或者一步到位：npm run check（含 typecheck + build + pack + smoke + registration）
```

改完 `src/*.ts`（host）要 `npx tsc -p tsconfig.json`（**不带** `--noEmit`）。验证 junction 同步：

```powershell
# 比对源码目录与 profile junction 里同名文件的字节数
```

## 7. 已完成且可复用的验证手段

```powershell
cd D:\Flora\ProgramProjects\dsh-run-deck
npm run check                        # 103 项：79 host + 9 client + 8 pack + 7 registration
node _probe\run\installcheck.mjs     # desktop profile 安装自检 11 项
node _probe\run\e2e-focus.mjs        # 焦点工作区→按钮组→跑/停→拖拽排序 端到端
node _probe\run\bundlecheck.mjs      # client 包契约（id=包名、版本已注入、无残留 ESM）
node _probe\run\slotcheck.mjs        # 宿主有哪些 shell.* 插槽
```

离线喂假 ctx 时，业务逻辑全部正确——例如：

```
focusCwd(D:/Flora/ProgramProjects/jin) → buttons=3（jin·web | jin·desktop | jin·web (build)）
```

## 8. 已知缺口（不是本轮要解决的，但别当它不存在）

- **第 3 步真实 stdout 未接线**：`ctx.terminals` 的每个操作都要求**已注册的 Agent** 当 owner（`spawn`/`startSend`/`signal`/`kill`/`read` 全部如此），插件自己不是 Agent，也不该冒用身份造不受监管的长驻进程。语义层（`src/hooks.ts`）完整且有 18 个测试覆盖，接线时只需把 `manager.observe(runId, line)` 挂到那条流的 reader 上。
- **快捷键没做**：DSH 当前版本没有 keybinding/hotkey/keymap 服务（查过运行时包的 `.d.ts`）。
- **另一个插件一直在崩（与本插件无关）**：`@local/dsh-taskoutsource` 反复报 `defaultDispatcher missing required value` + typert codec 错误。使用者说不用管。

## 9. 源码结构

```
dsh-run-deck/
├── package.json            # exports: "." → lib/index.js, "./client" → client/client.js
│                           # dsh: { bundle.patch: ./cordis.patch.yml, client.platform: web }
├── cordis.patch.yml        # bundle 补丁层：insert 一行 dsh-run-deck
├── src/
│   ├── host.ts             # Cordis 入口：name/inject/Config/apply；装配各部件
│   ├── host-config.ts      # 配置归一化（dataDir 空串 → <DSH_HOME>/plugin-data/dsh-run-deck）
│   ├── manager.ts          # 业务核心：清单加载、焦点项目、run 登记、钩子推进、按钮视图
│   ├── projects.ts         # .dsh/run-deck/run.json 读取、注释剥离、字段收敛、变量展开、根目录归一化
│   ├── config.ts           # 单条 entry 收敛 + ${…} 展开 + id 派生
│   ├── exec.ts             # 终端路线探测 + 就绪 pattern 匹配
│   ├── hooks.ts            # 第 3 步：钩子语义（beginsPattern/endsPattern/serverReadyAction/onReady）
│   ├── tool.ts             # 第 4 步：run-deck 工具参数分发（只接受 id）
│   ├── store.ts            # layout.json（本地覆盖：顺序/显隐/密度）
│   ├── commands.ts         # /run-deck list|run|stop|rerun|path|help
│   ├── routes.ts           # /dsh-run-deck/api/*（state/run/stop/rerun/observe/entry/button/reorder/density/focus/refresh）
│   ├── types.ts            # host/client 共享类型
│   ├── client.tsx          # 按钮条 + `+` 面板 + `⚙` 面板
│   ├── index.ts            # 包入口
│   └── dsh.d.ts            # DSH 接口最小环境声明
├── lib/                    # host 构建产物（ESM，DSH 加载的就是它）
├── client/client.js        # client 构建产物（ModuleLoader 包）
├── scripts/                # build-client / prepare / check-pack / check-registration / smoke*
├── docs/blocker-findings.md
├── _probe/                 # 探针 + 端到端 + 安装自检
└── README.md               # 完整设计说明（含字符画、字段表、API 表）
```

## 10. 开始前请先读

1. `README.md`（设计、字段表、UI 字符画、API 表）
2. `docs/blocker-findings.md`（为什么走终端）
3. `src/client.tsx` 的 `apply()`（插槽注册）与 `src/host.ts` 的 `apply()`（服务获取）
4. **宿主日志**：`%APPDATA%\DSH Desktop\logs\host\dsh-2026-10-11.log`

## 11. 一句话交代给使用者的验收标准

重启 DSH Desktop 后，在 `D:\Flora\ProgramProjects\dsh-run-deck`（或 jin / Ceola / tailtale）的会话里，**输入框上沿**应出现一条按钮条；点按钮能跑对应条目，点 `+` 能拖拽排序，切到没有 `.dsh/run-deck/run.json` 的目录这条会消失。
