# 交接：dsh-rundeck（2026-10-13 · 浮动条已在桌面上正常工作）

> 这份取代 `docs/handoff-prompt.md`（那份是"UI 从未显示"阶段的）。这次交接的是**当前可用状态 + 接下来要接新需求**。

## 0. 一句话

插件 `@aeroscis/dsh-rundeck`（DSH Desktop 的"把项目里的启动项变成输入框上方一排按钮"）**已经在桌面上正常工作**：浮动条渲染、点按钮真的开 PTY 跑起来、再点=停、就绪后浏览器自动打开、清单改动自动生效、失败原因看得见。工作目录就是本仓库 `D:\Flora\ProgramProjects\dsh-rundeck`。**接下来是新需求**，请先读 §3（现在能用的行为）和 §5（已知的坑），不要重新讨论已定死的设计（§4）。

## 0.5 提交状态（2026-10-13）

| 仓库 | 状态 |
| --- | --- |
| 插件 `D:\Flora\ProgramProjects\dsh-rundeck` | **本地首次提交**（此前这个目录没有 `.git`；`package.json` 里声明的远端 `https://github.com/Aeroscis/dsh-rundeck.git` 在本机不可达）。`.gitignore` 补了 `lib/`、`client/client.js`（构建产物）、`debug.log`、`.workbuddy/`；`_probe/` 仍按原有的 `_*/` 规则排除。要与远端历史对齐：`git remote add origin …` → `git fetch origin` → `git reset --soft origin/main` → 重新提交。 |
| 使用者仓库 `D:\Flora\ProgramProjects\jin` | 提交了 `start_gallery_web.py` / `start_gallery_desktop.py` 两个文件（`fix(gallery): 启动脚本不再经过 pnpm 跑 vite`）。**他本人的其他未提交改动没有动**。 |

## 1. 环境事实

| 项 | 值 |
| --- | --- |
| DSH Desktop | 2.0.17；host `dsh` 0.2.0-rc.2；Electron 44；node v24 |
| `DSH_HOME` | `C:\Users\Aeroscis\.dsh`；profile = `desktop` |
| 插件源码 | `D:\Flora\ProgramProjects\dsh-rundeck`（`@aeroscis/dsh-rundeck` v0.1.0） |
| 安装方式 | profile 的 `package.json` 里 `"link:D:/Flora/ProgramProjects/dsh-rundeck"` → **junction 指向源码**，改完源码要 `npm run build` |
| GUI | `http://127.0.0.1:43120` |
| 宿主日志 | `%APPDATA%\DSH Desktop\logs\host\dsh-YYYY-MM-DD.log` ← **最有用** |
| DSH 运行时源码 | `C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\` ← 查服务契约就看这里 |
| 真实项目（使用者会拿去试） | `D:\Flora\ProgramProjects\{jin,Ceola,tailtale,open-claw-setup}`（各自的 `.dsh/run.json`） |

**探不到宿主运行期状态**：直接 `Invoke-WebRequest http://127.0.0.1:43120/dsh-rundeck/api/state` 会被宿主网关拦成 `403`（不是本插件的围栏）。**要读状态就走日志**（插件自己往日志写诊断，见 §3.7）。

## 2. 两半的加载方式（很重要）

- **host half**：只在 DSH 启动时加载 —— 改 `src/*.ts`（除 client.tsx）后**必须重启 DSH**。
- **client half**：`client/client.js` 改完 `npm run build:client` 后**自动热更新**（页面不用刷、DSH 不用重启）。日志里会看到 `client ping: client-loaded`。
- 构建：`npm run build`（host `tsc` → `lib/`，client `tsc` + 打包 → `client/client.js`）。
- 自检：`npm run check`（= typecheck + build + check:pack + smoke:host 98 项 + smoke:client 10 项 + check:registration 7 项）。另有 `_probe/run/bundlecheck.mjs`（34 项客户端包契约护栏）。

## 3. 现在能用的行为（都已实测）

1. **浮动条**：注册在 `conversation.input.dock`（会话级 list 插槽，`id: dsh-rundeck-bar`，**order 15**），排在 `todo(0) → goal(10) → 本插件(15) → queue(20) → 输入框卡片`。宽度**逐字照抄**同列「任务列表」那条（4× `--dsh-composer-dock-inset`，实测 `left 636 / width 920`），高度 34px，与原生「回到底部」按钮同高。切到没有 `.dsh/run.json` 的目录时**整条隐藏**。
2. **会话 id 只有一条来路**：注册项的 `inject: (sessionId) => ({ sessionId })`（插槽的 owner props 是空的）。少了它 → `/state` 收不到 sessionId → 条永远不渲染。
3. **cwd 三级解析**（`RundeckManager.sessionCwdAsync`）：内存会话存储 `ctx.sessions.get(id).header.cwd` → **会话目录** `sessionController.list({}).items[].cwd`（含**冷会话**摘要）→ `sessionController.inspect(id).meta.cwd`。解析成功的缓存；查不到的 5 秒内不重扫。**为什么必须有第 2、3 级**：`ctx.sessions` 只有"被激活过"的会话，侧边栏点开一条空闲会话时它不在内存里 → 条整条隐藏（这就是当初"重启后某个仓库没按钮"的根因）。
4. **执行 = 真 PTY**：`ctx.subprocess.spawnTerminal`（`@deepseek-ai/dsh-subprocess-local`，底层 node-pty / ConPTY）。
   - **不要用 `ctx.terminals`**：那是 `@deepseek-ai/dsh-terminal` 的注册表，**桌面版组合里没有它**（只在 `dsh-sdk-minimal` 里），点按钮只会得到 `宿主没有 terminals 服务`。
   - 命令组装：`cmd.exe /d /s /c "<run.json 里渲染出的命令行>"`（POSIX 是 `<shell> -c`），`cwd` = 条目的 `options.cwd`，env = 宿主环境（洗掉凭据类名字与 `DSH_*`）+ `TERM=xterm-256color` + `DSH_SESSION_ID`。
   - **执行缝不需要 Agent owner**：sessionId 只用于记录与 `DSH_SESSION_ID`，空闲会话也能点。
   - 退出判定**不靠猜**：`cmd /c` 执行完就退 → `handle.done` 结算 = 任务结束（带退出码）。
5. **停止**：`signalForeground('SIGINT')`（win32 上就是往 PTY 写 `\x03` = 真人 Ctrl+C）→ 脚本自己的清理处理器跑 → 8 秒不退才 `terminate()` 收整棵树。
6. **就绪 → 打开浏览器**：`problemMatcher.background.endsPattern` 命中即 ready；`serverReadyAction: openExternally` 的地址**由界面打开**（`window.open` → 桌面壳 `setWindowOpenHandler` → `shell.openExternal` → 系统浏览器）。**宿主侧没有可用入口**（没有 `ctx.openPath` 服务，`openWorkspaceURL` 只认工作区内的路径）——不要再去宿主侧试。每个 `runId|url` 只开一次（去重键在浏览器 localStorage）。
7. **诊断通道**（查问题全靠它）：client 通过 `POST /dsh-rundeck/api/ping` 上报，host 写日志：
   - `client ping: client-loaded` / `slot-rendered` / `state-changed`（**按结果签名去重**，含 `focused/reason/buttons/hidden`）/ `slot-focused` / `geometry`（真实 rect + 主题令牌实测值）/ `open-url`；
   - host 侧：`跑 … → PTY 已开（…）`、`run … 结束：…（exit=…）`、`cwd 解析：会话 **** → …（来源：…）`、`清单变了，已重读：…`、`onReady 接力：…`、`起「…」失败：…`。
8. **面板**：`+`（当前工作区**全部**条目 + `⋮⋮` 拖拽排序，写 `layout.json`）、`⚙`（manifest/来源/进行中的 run（status·pid·exit·就绪URL·**最近 6 行输出**）/告警/密度/能力/两半版本）、`⚠ 启动失败`（**打开的是这条失败自己的面板**，宿主原话整段可复制，不是设置面板）。
9. **状态点**：运行中=琥珀呼吸点、就绪=绿点、停止中=红点；tooltip 写状态。
10. **清单改动自动生效**：`loadFocusedProject` 每次比 `.dsh/run.json` 的 mtime，变了就重读（≤2.5 秒），并留一行日志。清单被删/写坏也重读（条隐藏 + 告警，而不是留着旧按钮）。
11. **弹层压得住宿主那个「回到底部」圆钮**（2026-10-13 第二轮加的）：⚙ / `+` 面板打开时把会话往上滚，宿主的圆形「回到底部」钮会浮出来盖住面板右下角。根因是**层叠上下文**——我们住在宿主的 `composerSeat`（`position:sticky; z-index:7`，真机实测 `上下文:positioned+z`）里，而圆钮槽位 `.X6jxGq_toBottomSlot{z-index:8}` 是 seat 的**兄弟子树**，在父上下文里压住整个 seat 子树；所以弹层自己的 `z-index:10` 是"上下文内部的 10"，改成 20/999 一样没用。修法照抄宿主自己（它对 `@` 引用菜单就是这么干的，`composerSeat:has([data-trigger-menu]){z-index:9}`）：弹层打开期间把 seat 抬到 9（`STACK_LIFT_RULE`，特异性 (0,4,0) 压过宿主那条 (0,3,0)）。**证据在 `geometry.stack`**——同一帧里把抬升规则从样式表里精确摘掉再装回，各量一次 `document.elementsFromPoint()`：摘掉时 `["svg","X6jxGq_toBottom","__ru_pop",…]`（圆钮在面板之上 = 故障），装回时 `["__ru_pop","__ru_pop","svg","X6jxGq_toBottom",…]`，seat `z-index 7 → 9`；`realPopupHit` 是真面板自己的命中序，与"装回"一致。

## 4. 已定死的设计（**不要重新讨论**）

- 词汇表照抄 VS Code `tasks.json`；**三处增量且全部可删**：`buttons[]` / `onReady: "<entry id>"` / `id`。不许新造 `ready`/`${ready.1}` 这类东西。
- 命令只有一个来源：**`.dsh/run.json` 里的字面量**；接口只接受 `{projectRoot, entryId}` 指针（+ 发起会话的 sessionId），**任何接口都不接受自由命令**，也绝不扫目录发现可执行文件。安全边界在 `src/routes.ts`。
- 配置是指针不是编排；落点是项目里的 `.dsh/run.json`（不是 `.vscode/`）。
- 执行走真 PTY 不走后台 job（第 1 步三轮探针的结论：job 派生的进程没有控制台，SIGINT 到不了脚本的清理处理器）。证据在 `docs/blocker-findings.md`。
- 动作序列（steps/dependsOn）明确不做。
- **`onReady` 的注意点**：它是"点一个按钮却跑起来两条"，实测会被当成故障。现在 ⚙ 面板里会写 `→ <id>（onReady）`；jin 样例里那行已删。

## 5. 已知的坑 / 待办（诚实清单）

1. **`lib/` 与 `client/` 是构建产物，但 `.gitignore` 没排除它们** → 首次提交把它们也带进去了。要不要忽略，由你定（改了之后 `git rm -r --cached lib client`）。
2. `_probe/` 被 `.gitignore` 的 `_*/` 规则排除（作者原意是 scratch）。README 引用的窗口探针 `_probe/run/*.ps1` 因此在 git 之外。
3. Windows/ConPTY 上 node-pty 实测给 `pid = 0`（拿不到真 pid）→ `RunRecord.pid` 只在 `> 0` 时记录，界面不显示 `pid 0`。
4. **泄漏兜底**：启动脚本的进程树里有 `pnpm → GUI node host → cmd /c vite` 这类中间层，中间进程退出后真正的服务会**重新挂父**，脚本自己的 `taskkill /T` 会漏掉它。插件的对策是轮询里每 800ms 调一次 `handle.inspectActivity()`（把当前后代攒进 handle 的 `trackedDescendants`），`terminate()` 时靠这份记录杀整棵树 —— **别删这一步**（有护栏测试）。
5. **"空 cmd 窗口"的根因（已查清）**：Windows 上"没有控制台的进程"去起控制台程序时，系统会**新分配一个控制台**，Windows 11 用 Windows Terminal 打开它 → 桌面上出现一个标题为 `C:\WINDOWS\system32\cmd.exe`、内容空白的窗口。实测链条：`python → cmd(pnpm.cmd) → DSH Desktop.exe（GUI 二进制当 node 跑 pnpm.mjs）→ cmd /c vite preview`，**控制台就是在 pnpm 那一层被分配的**。所以：**agent 自己（无控制台环境）跑命令也会造出这个窗口**；被调用项目的脚本如果要起本地服务，最好**直接调 `node_modules/.bin/<tool>`，不要经过 pnpm**（jin 的 `start_gallery_web.py` 已经这么改了）。
6. 未做：完整输出面板（现在只有最近 6 行）、密度 segmented control（现在是循环切换）、步骤序列编排。
6b. **弹层抬升借用的是宿主的内部事实**（`data-composer-seat` / `data-conversation-region="composer"` 两个属性 + 宿主 seat 是 `z-index:7`、圆钮槽 `z-index:8` + 宿主那条规则的特异性 (0,3,0)）。这些**不是公开契约**，所以 `scripts/smoke-client.mjs` 里有一条护栏**直接读安装包**核对它们（seat 7 / 圆钮槽 8 / 两个 data 属性还在 / 宿主自己那条 `:has([data-trigger-menu]){z-index:9}` 还在）；宿主哪天改了层叠结构，`npm run check` 会先炸，而不是界面悄悄又被盖回去。`DSH_APP_DIR` 可以指到别的安装目录，读不到就跳过那一条。
7. 使用者仓库 `jin` 里我改过两个脚本（`start_gallery_web.py` / `start_gallery_desktop.py`：去掉多余的 `"--"`、`except SystemExit` 收尾、`CREATE_NO_WINDOW`、`vite_command()` 直调本地 vite）——那是**他的仓库**，不是插件的一部分。

## 6. 验证手段（照着用，别靠猜）

```powershell
npm run check                              # 98 host + 10 client + 7 registration
node _probe/run/bundlecheck.mjs            # 34 项客户端包契约护栏
node _probe/run/installcheck.mjs           # 11 项 profile 安装自检（junction/bundles/可 import）
node _probe/run/e2e-focus.mjs              # 离线端到端：焦点→按钮→跑/停→拖拽（打印真实 argv）
node _probe/run/barcheck.mjs               # 从最新宿主日志读几何
pwsh -File _probe/run/windows.ps1          # 所有可见顶层窗口（P/Invoke EnumWindows）
pwsh -File _probe/run/console-windows.ps1  # 控制台类窗口 + pid/visible/rect/title
pwsh -File _probe/run/watch-console-windows.ps1 -Seconds 60 -IntervalMs 25   # 盯窗口变化
```

⚠️ **不要**用 `Get-Process | Where MainWindowTitle` 找窗口：标题为空的窗口会被漏掉，而 ConPTY/新分配控制台的窗口正好没有标题（我第一次就是这么"什么都没看到"的）。

## 7. 使用者偏好（很重要）

- **中文**回复；要**根因**，不要"可能是…"；结论必须有**实测证据**（日志行、进程链、窗口枚举、几何数据）。
- 他会问"是你自己没注意吗"——**该承认就承认**（我这一路踩过：`inject` 去重、样式不刷新、`--` 被转发、`pid 0`、把 `ctx.terminals` 当成桌面版有的服务、自己造出空 cmd 窗口）。
- 改动要带**护栏测试**（smoke/bundlecheck），改完跑 `npm run check`。
- 尽量少让他手动操作（别动不动让他重启；客户端半边是热更新的）。
- 他会在真实项目里验收（jin / Ceola / tailtale / open-claw-setup），所以"样例 manifest 写得对不对"也算交付质量的一部分。

## 8. 接下来

新需求直接说。改之前建议先读：`README.md`（§2 执行路线、§7 界面与排障、§8c HTTP 接口）、`src/manager.ts`（状态/清单/cwd）、`src/exec.ts`（PTY 路线）、`src/client.tsx`（浮动条与三个面板）。
