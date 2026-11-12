# dsh-run-deck — DSH Run Configuration

给 DeepSeek Harness 增加一条**贴着输入框上沿的浮动按钮条**：
按**当前工作区** `.dsh/run-deck/run.json` 里声明的条目一键跑 / 停。

- **词汇表照抄 VS Code tasks.json**，不发明新概念。字段名、语义、默认值全部来自
  [tasks-appendix](https://code.visualstudio.com/docs/reference/tasks-appendix) 与
  [variables-reference](https://code.visualstudio.com/docs/reference/variables-reference)
- **不拆文件，一个 `tasks` 数组**。没有调试器，launch.json 那半边整个不需要；
  长驻只是「跑完不退出」，用 `isBackground: true` 表达
- **只有三处增量，且全部可删**：`buttons[]` / `onReady` / `id`（见 §3）
- **配置是指针，不是编排**：命令指向已有脚本，逻辑留在脚本里，不搬进 JSON
- **动作序列（steps/dependsOn）明确不做**：要编排回到 `&&`（VS Code 的做法）

---

## 1. 安装

```powershell
# 默认 profile
dsh plugin add @aeroscis/dsh-run-deck

# 指定 profile
dsh plugin --profile <profile> add @aeroscis/dsh-run-deck

# 从本地源码目录安装（尚未发布到 registry 时，边改边试）
dsh plugin --profile <profile> add D:/Flora/ProgramProjects/dsh-run-deck
```

然后**重启 DSH**。输入框上沿会出现一条按钮条（见 §7）。

### desktop profile 手动安装

desktop 是 Electron 保留名，npm CLI 会拒绝针对它的插件管理请求；`dsh plugin`
在这里只是把参数转给 pnpm，装不进去。 desktop 上要么用**应用内的插件管理界面**，
要么手动装（等价于 `dsh plugin add` 做什么）：

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加一条
   `"@aeroscis/dsh-run-deck": "link:D:/Flora/ProgramProjects/dsh-run-deck"`
2. `dsh.profile.bundles` 数组里加 `"@aeroscis/dsh-run-deck"`
3. `dsh.desktopDeselectedBundles` 里**不要**出现它（那是应用里手动停用的清单）
4. 在该目录跑 `pnpm install`（会建一个 junction 指向源码目录）
5. `dsh --profile desktop --dump-config` 确认输出里有
   `- id: dsh-run-deck  name: '@aeroscis/dsh-run-deck'`，然后重启应用

自检脚本：`node _probe/run/installcheck.mjs`（逐项核对上面 5 步）。

### 支持的 DSH 版本

- **声明**：`engines.dsh` 与 `peerDependencies` 里的 `@deepseek-ai/dsh` 都是
  `^0.1.5-rc.2 || ^0.2.0-rc.1`。市场判定读的就是这个范围（「范围是否满足」，不是「版本相等」）；
  插件的版本号是它自己的迭代序号，与 DSH 版本无关。
- **依赖的宿主能力**（缺失时逐项降级，**任何一种缺失都不会让插件加载失败**）：
  `webServer` / `commands`；执行侧需要 **`subprocess`**（`@deepseek-ai/dsh-subprocess-local`，
  `dsh-base` 必挂）的 `spawnTerminal`——没有它时浮动条照常显示，
  ⚙ 面板里会明确说「起不了进程」，而不是让用户点了没反应。
  ⚠️ **不是** `ctx.terminals`：那是 `@deepseek-ai/dsh-terminal` 的 PTY 注册表，
  只在 `dsh-sdk-minimal` 那类组合里挂载，桌面版（`dsh-base` + `dsh-web-app`）里没有它。
  配置侧在 0.1.x 用 `settings` 命名空间、在 0.2.0-rc.1 起用 `configEditor`
  （两者都没有时退回 `<dataDir>/config.json`）。
- **自查**：⚙ 面板底部显示两半版本（`插件后端 v…` / `插件界面 v…`）。
  host half 只在 DSH 启动时加载（改插件要重启）， client half 刷新页面即更新；
  两半不一致说明有一半是旧的。

---

## 2. 为什么走终端而不是后台 job（第 1 步的结论）
这些项目的启动脚本是**前台交互工具**，不是守护进程：全程打印日志、期望 Ctrl+C、
失败时可能 `input("按回车键关闭…")` 挂住等按键，进程树清理只挂在
SIGINT / SIGTERM / SIGBREAK 的处理器里（新进程组 + `taskkill /T`）。

三轮探针实测（`_probe/`，python 替身装上同三个处理器）：

| 探针 | 发出的信号 | Python 退出 | 处理器是否跑 | `taskkill /T` |
|---|---|---|---|---|
| `sigterm-plain` | SIGTERM（`process.kill`） | exit 1 | **否** | **未执行** |
| `sigbreak` | SIGBREAK（`child.kill`） | SIGKILL | **否** | **未执行** |
| `sigint-test` | SIGTERM | exit 1 | **否** | **未执行** |

三个信号**一个都没让处理器跑起来**。原因是 Windows 的信号模型：只有「控制台为进程
生成 Ctrl+C / Ctrl+Break」才会把 `CTRL_C_EVENT` / `CTRL_BREAK_EVENT` 送给进程组，
而 `GenerateConsoleCtrlEvent` 隐含要求调用者自己挂着控制台。
job（`detached: true` + `stdio: 'ignore'`）派生的进程实测
`GetConsoleProcessList() == 0`——**没有控制台可挂**，信号于是到不了处理器，
进程树清理这条链的起点就断了，端口被孤儿占住。正是这些脚本用几百行要避免的失败。

所以执行路线是**真 PTY**：它有真控制台，`signalForeground('SIGINT')` 走的是同一个交付
路径（win32 上就是往 PTY 写一个 `\x03`，与真人按 Ctrl+C 一致），处理器于是能跑到
`taskkill /T`。按钮语义随之定死：

> **「给这个项目开一条 PTY 跑它的启动脚本」**
> 「跑」= 开一条 PTY 起命令；「停」= 给前台进程组发 Ctrl+C；「重跑」= 停掉再开。

具体用哪条缝：**`ctx.subprocess.spawnTerminal`**（`@deepseek-ai/dsh-subprocess-local`，
底层 node-pty / ConPTY）。早先这一版写的是 `ctx.terminals`（`@deepseek-ai/dsh-terminal`），
而**桌面版组合里根本没有那个服务**——点按钮只会得到
`宿主没有 terminals 服务（dsh-terminal 未加载）`。`subprocess` 是 `dsh-base` 必挂的，
DSH 自己的终端面板（`@deepseek-ai/dsh-api-terminal-controller`）用的也是它
（`static inject = ["subprocess"]` → `spawnTerminal`）。

另两条同批测试的结论（不改变方向，但写进插件）：

- `_owns_console()` 在 job 环境下返回 `false`（`GetConsoleProcessList() == 0`），
  `hold_console()` 不会挂住（`input()` 立刻 EOF 返回）。**console 检测合理、无害**。
- `CREATE_NEW_CONSOLE` 的孙子进程能起来也能被 taskkill 到；但本探针会话里
  `taskkill` 被 pwsh 沙箱拦了，**这一条无法在本环境内证明「停得干净」**，
  留给事件钩子那一轮验证。

完整结论与原始证据： [`docs/blocker-findings.md`](docs/blocker-findings.md)、
`_probe/out/*.jsonl`。

### 谁来跑：**不需要 Agent owner**（比早先更简单）

`ctx.terminals` 的每个操作都要求一个 owner（`isLiveOwner` 恒等校验），所以早先必须
用"那个会话当前活着的 Agent 对象"当 owner；`ctx.subprocess` 的执行缝**没有这个要求**。
于是：

| 入口 | sessionId 从哪来 | 用途 |
| --- | --- | --- |
| 浮动层按钮 | 客户端把**当前会话 id** 一起报上来 | 记进 `RunRecord.ownerSessionId` + 子进程的 `DSH_SESSION_ID` |
| `/run-deck run <id>` | 调用这条命令的 `invocation.agent` | 同上 |
| `run-deck` 工具（模型侧） | 调用工具的 `exec.agent` | 同上 |

**sessionId 现在可以缺省**（缺了照样跑，只是没有那两条记录）——空闲会话、甚至
没有任何 Agent 的场景都能点按钮，这正是"点了没反应"的另一半原因。

两条硬约束没有变：**命令只有一个来源**（`.dsh/run-deck/run.json` 里的字面量；接口只接受
`{projectRoot, entryId}` 指针 + 发起会话 id，绝不接受自由命令、也不扫目录找可执行文件）；
**进程归宿主管**——PTY 句柄登记在 `subprocess` 服务里，插件卸载 / 宿主退出时它自己
终止整棵进程树，不是 DSH 外面的一条无人监管通路。

停止走**真控制台**：`signalForeground('SIGINT')` = Ctrl+C（脚本自己的清理处理器就挂在
那上面），投递不到、或 8 秒后还没退出，才 `terminate()` 把这条 PTY 的进程树带走。

### 输出接线（第 3 步，**已接上**）

`handle.output` 是一条**流**（ConPTY 的屏幕更新流），所以插件一拿到句柄就把它读起来：
按 `\r\n` / `\n` / `\r` 切行、剥掉 ANSI 转义、丢空行，放进一个有界的行队列；host 每 800ms
把新行逐行喂给 `manager.observe(runId, line)`：beginsPattern 门控 → endsPattern 命中即
ready（并记下 URL）→ `serverReadyAction` **把地址交给界面打开** → `onReady` 接力下一条 entry。
**退出判定不靠猜**：命令是用 `cmd /d /s /c`（POSIX 上 `<shell> -c`）跑的，
shell 执行完就退，所以 `handle.done` 结算 = 这条任务结束，退出码也是任务自己的。

> 为什么不是"读终端的 scrollback"：那条路要求宿主把 PTY 的屏幕状态交出来
> （`ctx.terminals.read`），而桌面版没有那个服务；`subprocess` 给的是**原始流**，
> 反而更直接——代价是自己切行、剥 ANSI。

#### `serverReadyAction: openExternally` 由**界面**打开（不是宿主）

实测宿主侧**没有任何可用入口**：桌面版组合里没有 `ctx.openPath` 服务，
`sessionController.openWorkspacePath` 要的是**工作区内**的路径（`http://…` 不是它的东西），
所以早先那条"宿主自己开浏览器"的路只会记一句 `打不开 …（宿主没有可用入口）`，
用户看到的就是"点了 web 按钮，服务起来了，浏览器没动静"。

现在：host 只把地址记进 `RunRecord.ready.url` 并留一行日志，**client half 轮询到就打开一次**
（`openReadyUrl()`）：`window.open(url, '_blank', 'noopener,noreferrer')` —— 桌面壳的
`setWindowOpenHandler` 会接住它（`electron-runtime` 实测 `shell.openExternal(target.href)`），
也就是**系统默认浏览器**；Web 版就是新开一个标签页。每个 `runId|url` 只开一次，
去重键存在浏览器本地（`dsh-run-deck.openedUrls.v1`），否则每次刷新页面都会再弹一次。

> 顺带一个日志坑（踩过）：宿主日志会把"看起来像 URL 的整段"做规范化，
> `http://x/（说明）` 这种**挨着写**的会被整段 percent-encode 成 `http://x/%EF%BC%88…%EF%BC%89`，
> 读起来就像地址本身坏了。所以日志里地址与说明之间**留一个空格**。

---

## 3. 三处增量（删掉它们配置仍然能跑）

| 增量 | 是什么 | 补的是什么 | 删掉会怎样 |
| --- | --- | --- | --- |
| `buttons[]` | 钉到浮动层：entry 的别名 + 图标 + 分组 | ——（纯策展） | 浮动层空着，`tasks[]` 照跑 |
| `onReady: "<entry id>"` | 就绪后接另一个 entry | VS Code issue #69311：`serverReadyAction` 只能 `openExternally` | 就绪后什么都不接，`tasks[]` 照跑 |
| `id` | 跨族唯一标识 | 给外部按名字调用 | 从 label 派生 id（仍唯一），`tasks[]` 照跑 |

约束：

- `onReady` **只接受 entry id，不接受命令**——否则它会变成第二条执行通路。
- `label` **可重名，不能当接口**。要按名字调用就用 `id`。
- 哪个增量变成「没它不行」，就删掉哪个。

> `onReady` 的一个使用注意（实测被当成故障问过）：它是"**点一个按钮，却跑起来两条**"。
> jin 的样例里原来就有一行 `"onReady": "jin/web"` 做演示，结果是"点 jin · desktop，
> jin · web 怎么也起来了"。现在两处都收口了：样例里那行**去掉了**（想恢复就加回来），
> 而插件这边把接力**记进 `RunRecord.chainedTo`** 并在 ⚙ 面板里显示成
> `→ jin/web（onReady）`——manifest 里写的行为必须在界面上看得见，而不是只躺在宿主日志里。

---

## 4. 落点

- **项目里**：`.dsh/run-deck/run.json`（**不是** `.vscode/`）。借词汇表但不冒充 VS Code 能读它——
  两边的 `type` 支持集不同，混在一起只会让人困惑。
- **插件里**：另存一份**机器本地的个人覆盖**（按钮布局、分组、图标、显隐），
  在 `<pluginDataDir>/layout.json`，**不进仓库**。

两者的分工：run.json 是「这个项目有什么」，本地覆盖是「我怎么看它」。
删掉本地覆盖一切照常，浮动层退回 run.json 的原始声明。
本地覆盖**只影响展示**——它没有任何字段能改 `command` / `args` / `cwd`，
不创造新的执行能力。

---

## 5. run.json 的字段

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `version` | —— | 清单版本；不认识不报错，只告警 |
| `inputs[]` | —— | `${input:id}` 的取值来源。实现 `pickString` 与 `promptString`；没有 `default` 的 `promptString` 要求每次运行前先填值（见下） |
| `tasks[].label` | **必填** | 人读的标题，**可重名** |
| `tasks[].id` | 由 label 派生 | 跨族唯一标识；重复时自动追加后缀 |
| `tasks[].type` | `shell` | 只实现 `shell`（VS Code 的 `process` 需要 argv 数组，本插件不做） |
| `tasks[].command` | **必填** | **必须是 run.json 里的字面量**（见 §6） |
| `tasks[].args` | `[]` | 参数；**整体不是字符串数组时忽略该字段并告警** |
| `tasks[].options.cwd` | `${workspaceFolder}` | 工作目录 |
| `tasks[].options.env` | —— | 额外环境变量；与宿主环境**叠加**（同名覆盖），值里可含 `${env:NAME}` |
| `tasks[].isBackground` | `false` | 长驻只是「跑完不退出」 |
| `tasks[].problemMatcher.background` | —— | `activeOnStart` / `beginsPattern` / `endsPattern` |
| `tasks[].serverReadyAction` | —— | 只实现 `{ action: 'openExternally', pattern, uriFormat }` |
| `tasks[].presentation` | —— | `panel` / `reveal` / `clear` |
| `tasks[].group` | `none` | `build` / `test` / `none` |
| `tasks[].runOptions.runOn` | —— | 只认 `"folderOpen"`：宿主启动后自动跑这一条（不需要点按钮）。其它值忽略并告警。`problemMatcher.background` 与 `serverReadyAction` 照常生效，就绪判定不变 |
| `tasks[].onReady` | —— | 增量 2：entry id（不接受命令） |
| `buttons[]` | —— | 增量 1：`entry` + `icon` + `group` + `label` + `order` |

变量：`${input:id}` / `${workspaceFolder}` / `${env:NAME}`。**不发明新变量**——
上一版被否掉的 `${ready.1}` 就是那种东西：它把「就绪」这个运行时状态变成模板变量，
于是每条命令都要重新解释一遍执行时机。未知变量**原样留下**，让人看得出这里本该有值。

`inputs[]` 两种类型的取值顺序都是**现场给的值优先，其次 `default`**（`pickString`
没有 `default` 时取第一项）。差别在于没有默认值可取的时候：

- `promptString` **没有 `default`**：点跑时界面先弹一个填值面板（每个 input 一栏，
  `description` 是说明文字），填好才真的起进程。命令行 / `run-deck` 工具调用则必须带
  `inputValues: { "<id>": "<值>" }`，缺了会拒绝执行并说明缺哪个。
- `promptString` **有 `default`**：不弹面板，直接用默认值（调用方仍可用 `inputValues`
  覆盖）。这与 VS Code"每次都先问、只是预填"不同——这里把那一次弹框省掉。
- 带了无默认 `promptString` 的条目**不会被启动自动跑**（`runOn: "folderOpen"` 跳过它
  并在日志里说明），自动运行无法提供交互。

支持 JSON with comments（`//` 与 `/* */`，不在字符串内时）——配置文件里要写注释。

---

## 6. 安全边界

host half spawn 的进程**绕过 agent 的 pwsh 沙箱**，所以：

1. **命令必须是 run.json 里的字面量**，绝不能是扫目录发现的可执行文件。
2. **没有任何接口接受自由命令**。HTTP 路由只接受 `{ projectRoot, entryId }` 这样的**指针**；
   命令本体永远来自项目里的 run.json。这不是省略，是边界。
3. **不要让 UI 变成「无确认执行任意脚本」的通路**。破坏性操作要 confirm。
4. 路由的围栏与 DSH 自身 `/api` 一致：只接受 loopback authority、
   `sec-fetch-site: cross-site` 一律拒绝、带 Origin 的必须与 Host 同源、
   变更类接口只 POST。

`/run-deck` 命令同样只接受 id，不接受自由命令。

---

## 7. 界面：输入框上方那一列里的一条

**只有一个 UI。** 上一版的「Run Configuration 主面板 + 侧边栏入口行」已删除——
那是"全局总表"，与"跟着当前工作区变的一键入口"是两回事，而且会把复杂度翻一倍。

条住在宿主给「输入框卡片上方整宽条目」留的那一列（`conversation.input.dock`）里，
和「任务列表」、「目标」、「队列」**同列堆叠**、互不遮挡：

```
 ╔══════════════════════════════════════════════════════════════════════════╗
 ║      ┌───────────────────────────────────────────────────────────┐       ║
 ║      │ ☑ 任务列表        2 完成 · 1 进行中 · 1 待办           ⌄  │       ║ ← todo (order 0)
 ║      └───────────────────────────────────────────────────────────┘       ║
 ║      ┌───────────────────────────────────────────────────────────┐       ║
 ║      │ [▤ 完整] [👁 jin · web] [🖥 jin · desktop] [🔨 build] ⋯ [+] [⚙] │       ║ ← 本插件 (order 15)
 ║      └───────────────────────────────────────────────────────────┘       ║   34px 高
 ║      ┌───────────────────────────────────────────────────────────┐       ║
 ║      │ @ 引用   输入消息…                                        │       ║ ← 原生输入框卡片
 ║      └───────────────────────────────────────────────────────────┘       ║
 ╚══════════════════════════════════════════════════════════════════════════╝
          └──────── 整列同左边缘、同右边缘 ────────┘
```

四个设计要点（都按使用者的确认）：

| 要点 | 行为 |
| --- | --- |
| **同列对齐** | 注册进 `conversation.input.dock`（会话级 list，`id: dsh-run-deck-bar`，**order 15**）。宿主 `ank0OG_composerStack` 是 `flex column; gap:6px`，按 order 排出 `todo(0) → goal(10) → 本插件(15) → queue(20) → 输入框卡片`。尺寸**逐字照抄**「任务列表」那一条（`IJkQnq_root`）：`width: 100% - 2×side-clearance - 4×dock-inset`、`max-width: card-max-width - 4×dock-inset`、`flex:none; margin:0 auto` → 与任务列表**同宽同左边缘**（实测都是 `left 636 / width 920`），比输入框卡片（`left 620 / width 952`）两边各窄 16px。**位置与宽度全由宿主排版，条本身不做任何 DOM 测量** |
| **为什么是 15** | 这一列里**队列那一行是"贴在输入框上"的**：它自带 `margin:0 auto calc(0px - gap - 3px)`（负底边距，吃掉行距再往卡片上沿压 3px）、圆角只有上面两个（`radius-lg radius-lg 0 0`），宿主明确把它当作卡片的一部分——所以它必须是紧邻卡片的那一行，别的行不能插到它与卡片之间。我们自己是一组"针对输入框的动作"（这个工作区能跑什么），性质最接近队列 → 紧挨着它排在这一列下半段；任务列表/目标是"智能体在做什么"的状态读出 → 排在更上面 |
| **行距一致** | 组内与"组 vs 卡片"都只吃宿主那条 6px 堆叠间距，**不自己加 margin**。实测最满状态（四行同时在）：`任务 755..791 → 条 797..831 → 目标 837..873 → 队列 879..919 → 卡片 916..1044`，全是 6px。之前的写法给自己的行加了 6px `margin-bottom`，于是"组内 6px / 组与卡片 12px"不一致——那是我加的，不是宿主的结构 |
| **面板面** | 条的底色用宿主给这一列的那套：`--dsw-specific-menu`（半透明面）+ `backdrop-filter: --dsw-menu-backdrop-filter`（磨砂）+ `--dsw-elevation-panel`（阴影，描边走 `--dsw-elevation-stroke-color: --dsw-alias-border-l1`）+ 圆角 `--dsw-radius-lg`，与「任务列表」同一视觉语言。**不能**用 `--dsw-alias-button-floating-fill`：实测它和卡片底色 `--dsw-specific-input-major` 都是 `#2c2c2e`（同色），贴着看就是一个盒子；`--dsw-specific-menu` 是 `#43454a73` |
| **与原生按钮同高** | 34px，与宿主原生圆形「回到底部」按钮一致。那个按钮（`.toBottomSlot`，`!scroll.followingTail` 时才渲染）浮在**卡片**上边沿右侧，与本条不同带 |
| **三档密度** | 左侧固定钮循环切换：**完整**（图标+任务名）/ **紧凑**（图标+定长截断）/ **图标**（纯图标），偏好持久化到 `layout.json`。**紧凑档真的收紧**：胶囊 `26px→22px`、字号 `13px→12px`、内边距 `0 9px→0 6px`、间距 `6px→4px`（见 `[data-density="compact"]`），文字超过 **8** 字再截断。只做"12 字才截断"是不够的——`全量检查`（4 字）、`重建客户端包`（6 字）都在门槛内，于是完整档和紧凑档长得一模一样（被试出来的）。按钮上**直接写出当前档位的名字**（`▤` 只是恒定的"这是控件"标记），tooltip 写明「按钮密度：当前档 · 点击切换 → 下一档」 |
| **逐级降档** | 宽度不够时**按顺序**从 full 退 compact 再退 icon，仍放不下的进 `⋯` 溢出菜单。**顺序即优先级**，而顺序就是你在 `+` 面板里拖出来的 |
| **状态点分得清** | 正在跑的按钮右边一个**琥珀色呼吸点**（`--dsw-alias-state-warn-primary` + `__ru_pulse`），就绪后变**绿点**（`--dsw-alias-state-success-primary`），停止中变红点；tooltip 里也写出状态（`… — 停（运行中）`）。早先不管什么状态都是同一个绿点，于是"点了半天没动静"根本看不出是在构建、还是在跑、还是已经起来了 |

> **这一列里各行并不等宽，这是宿主自己的设计**（实测）：任务列表 `920`（4×inset，
> 受 `card-max-width` 夹住）、目标 `1567`（4×inset，不受卡片宽度夹）、队列 `936`
> （2×inset）而且队列那一条还带 `margin:0 auto calc(0px - gap - 3px)`，**故意往卡片上沿
> 里压 3px**（它本质是"贴在输入框上的排队条"）。所以我们只对齐**任务列表**那一行。

### 实测对照（`client ping: geometry`，最满状态）

同一帧里逐值量出来的（左列是宿主自己的「任务列表」行 `IJkQnq_root`，右列是本插件）：

| 量 | 任务列表 | 本插件的条 | |
| --- | --- | --- | --- |
| 左边缘 / 宽度 | `636` / `920` | `636` / `920` | ✅ 一致 |
| 圆角 | `16px`（`--dsw-radius-lg`） | `16px` | ✅ 一致 |
| 底色 | `rgba(67, 69, 74, 0.45)` | `rgba(67, 69, 74, 0.45)` | ✅ 一致 |
| 与上一行的间距 | `6px` | `6px` | ✅ 一致 |
| 与下一行的间距 | `6px` | `6px` | ✅ 一致 |
| 与输入框卡片的间距 | `6px` | `6px` | ✅ 一致（队列那一行的 `−3px` 是宿主自己的设定） |
| 高度 | `36px`（它自己的 header 高度） | `34px` | ⚠️ **有意**不同：本插件按已确认的设计与宿主原生「回到底部」按钮同高 |

> 为什么不是 `conversation.input.overlay`：那个插槽是卡片内
> `height:0; position:absolute; inset:0 0 auto` 的锚点，挂进去只能用绝对定位浮在
> 卡片上沿往上 34px 的那条带里——而那条带**正是 dock 各行的位置**，于是条会把
> 「任务列表」压在下面。同类东西放进同一个堆叠里，是宿主自己对这一列的做法。

### 右侧固定按钮们（外加两个按条件出现的）

- **`☰`** 打开**管理面板**：列出全部条目，每行左侧 `⋮⋮` 是拖拽手柄（**按住上下拖动**
  调按钮条顺序；指针事件实现：那一行跟手抬起、其余各行带过渡让位、松手滑进槽位），
  右侧是三件事：
  - **「钉到按钮条 / 从按钮条收起」**：只改这条按钮在不在条上（写本地 `layout.json`），
    条目本身保留；
  - **「编辑」**：打开**编辑面板**，预填这条任务在清单里**原样**的字段（变量不展开、
    cwd 保持相对），改完**原位替换** run.json 里那条 task（注释与排版保留，与手改
    完全等价）。校验与新建走同一份（`buildTaskEntry`），只是"自己占着自己的 id"
    不算冲突、`onReady` 排除自己。**id 可以改**：清单里 `buttons[].entry` 的声明和
    本机 `layout.json` 的外观覆盖会一起搬到新 id。
  - **「删除」**：真的把这条任务从项目的 `.dsh/run-deck/run.json` 的 `tasks[]` 里移除（连带清掉
    `buttons[]` 里指向它的声明），需要再点一次「确认删除」。
  **排序、编辑、删除都在这里**。顺序写进机器本地的 `layout.json`，覆盖 run.json 的 `order`，
  你拖完只影响你自己。
- **`+`** 打开**新建面板**。它的分工是「先把能填的填上，别让人去手改文件」：
  - **顶部先给候选**：读当前项目的 `package.json` 的 `scripts`，列成胶囊（`pnpm: dev` /
    `npm: build` …；包管理器按 `packageManager` 字段或锁文件判断），外加两条与项目
    无关的通用模板。点一条就**填进下面的表单**，并且**自动展开「更多设置」**——
    预填的长驻 / 就绪正则必须在界面上看得见，不能藏在表单背后。已经在清单里的
    同命令条目会标「已在清单」并置灰（防重复添加）。读检测结果**不落盘、不执行**。
  - **可以复制已有条目**：拿的是清单里**原样**的字段（`raw`），所以 `${workspaceFolder}`
    不会被展开成这台机器的绝对路径；`id` 不复制（副本要自己的 id）。
  - **基础只有两栏**：名称 + 一行命令行。命令行由 host 拆成 `command` + `args`
    （`npm run dev` → `npm` + `["run","dev"]`）；引号不配对由提交时的校验拦住并说明原因。
  - **标题旁一颗「?」**：面板是做什么的、怎么用，点开才展开（默认不占地方）。
  - **「更多设置」里是 `run.json` 的那 9 个字段**：工作目录（相对项目根解析成绝对路径
    再交给 PTY）、环境变量（`KEY=value` 每行一条）、显式 `id`、`group`、`isBackground`、
    就绪正则（`problemMatcher.background.endsPattern`）、就绪后打开地址
    （`serverReadyAction` + `URL 正则` + `地址格式 %s`）、跑起来自动钉住输出卡
    （`presentation.reveal`）、`onReady` 接续（下拉选另一个 entry id，只接受 id）。
    按钮图标与分组走本机 `layout.json`（外观是"我怎么看它"，不进仓库）。
  - **落盘前逐项校验**：坏正则、不存在的工作目录、非法环境变量名、撞车的 `id`、
    指向不存在条目的 `onReady`、说了要开地址却没给 URL 正则……一律**拒绝写入**并把
    原因显示在面板里（`src/newtask.ts` 的 `buildTaskEntry`）。
  - 通过校验后 host 把它**真的写进这个项目的 `.dsh/run-deck/run.json` 的 `tasks[]`**（用保留
    注释的最小文本插入，手写的注释和排版不会被重排），随后自动钉到条上；**目录里还
    没有 `.dsh/run-deck/run.json` 时会连清单一起创建**。多字段条目写成"一字段一行"（一行会横到
    屏幕外），只有 `label/id/command/args` 的简版仍是一行。
  > 为什么 UI 能写 run.json、本地 `layout.json` 却永远不存命令：前者编辑的是**项目和
  > 别人共享的同一个源文件**（手改和界面写完全等价，`git diff` 看得见），后者只是
  > "我怎么看这个项目"。执行能力只能落在 run.json 里，但写它的路可以不止一条。
  **条常驻**：插件装上后这条一直在——哪怕项目还没有清单、哪怕一个按钮都没有。
  中间会给出可操作的说明（「这个目录还没有启动项 · 点 + 新建第一条」/「全部按钮已收起 ·
  点 + 把要用的钉回来」），`+` 面板里可以直接建第一条；按钮全被收起时面板还带一个
  「全部钉回来」。早先"没有按钮就整条消失"，`+` 跟着没了，等于把自己锁死。
- **`⚙`** 打开设置面板：当前工作区、manifest 路径、配置来源、进行中的 run（状态 / `pid` /
  退出码 / 就绪 URL / **最近 200 行输出**）、清单告警、按钮密度、宿主能力（执行通道在不在）、
  两半版本。那几行输出是"脚本自己为什么没起来"（缺依赖、端口被占、路径写错）唯一的证据。
- **输出悬浮卡**（正在跑的条目上）：鼠标放到**正在跑**的按钮上，它上方浮出一张
  小卡（≤560px 宽、≤250px 高），显示这条的最近约 200 行输出，**拿开就消失**；卡头
  有一颗图钉按钮，**📌 钉住 = 未钉**（点它钉住，拿开也不消失），**📍 已钉住 = 钉住了**
  （再点拔钉），emoji 旁边直接写状态文字，钉住的卡还会描一圈品牌色边；脚本名旁边是
  圈起来的状态徽章（就绪=绿 / 运行中=琥珀 / 停止中=红 / 已退出=灰）。每 2.5 秒随 `/state`
  轮询长出新的一批，进程停了内容也保留
  （末跑的现场就是查"为什么失败"的证据）。run.json 里把 `presentation.reveal` 写成
  `"always"` 的条目，**跑起来那一刻会自动钉住**它的输出卡（一键拔钉恢复悬停规矩）；
  自动钉住的**长驻条目**（`isBackground`，例如直接跑客户端 exe）在进程结束后会自己
  收起——关掉软件、或点「停」，卡跟着消失；一次性命令（构建/检查）则保留末次输出。
  手动点图钉钉住的卡不会被自动收走。`panel` / `clear` 则没有对应物（输出本来就是
  每条 run 独立、开跑即新），收下字段但静默不生效。**颜色跟着脚本走**：脚本/vite 打出来的颜色会在卡里画出来（宿主留原始行
  + 界面里一个小翻译器上色）；`pwsh` 那类提示符主题不在——按钮跑的是脚本不是交互式
  shell，VS Code 的任务输出同样见不到它。
- **`⚠ 启动失败`**（只在最近一次跑/停失败后出现）：点它打开的是**这条失败自己的面板**
  ——宿主返回的原话整段摆出来（保留换行、可选中复制），底部一颗「全部告警（⚙）」通向
  设置面板。早先这个标记直接 `onOpenSettings`，于是"点了启动失败几个字，弹出来的是
  设置界面"，而真正的原因只藏在 tooltip 里（还得悬停才看得见）。

### 拖动排序：为什么不用原生 `draggable`（"拖动只有一个虚影"的根因）

`⋮⋮` 手柄**曾经**是 HTML5 的 `draggable` + `dragstart/dragover/drop`。那是浏览器的原生
拖放，它按自己的规矩来：

1. `dragstart` 那一刻，浏览器给**拖源元素**（我们标的是那个只有 4 个字形的 `⋮⋮` 手柄）
   拍一张**半透明快照**当拖影，之后由系统绘制、跟着光标走——所以你看到的是一小团虚影，
   而不是那**一行**跟手；
2. 真正的行留在原地，我们当时只给它 `opacity:.5` 表示"正在拖"——"一行变淡 + 一团虚影"，
   两样都不是排序该有的样子；
3. 顺序只在 `drop` 那一刻才改（`onDrop` 里才 `move(...)`），拖动过程中列表**一动不动**：
   没有即时预览，也没有"其他行让开"的动画；
4. 拖影的透明度、偏移、动画**都不受页面控制**（那是 OS/浏览器的实现），想让手感变成
   sortable 那种，只能不用原生拖放。

现在改成**指针事件**自己实现（`pointerdown` 抓起 → `setPointerCapture` → `pointermove`
跟手 → `pointerup` 落位）：

| 部分 | 做法 |
| --- | --- |
| 跟手 | 被拖那一行 `translateY(指针位移)`；位移算在**滚动内容坐标系**里（`视口Y − 容器顶 + scrollTop`），所以贴边自动滚动、滚轮、容器自己滚动都不会让它从指针底下跑掉 |
| 让位 | 其余各行按 `previewOffsets()` 平移 + `transition:transform 180ms`；位移用**累积高度**算（不是"每行挪 `被拖行高 + 行距`），所以行高不一致也不会错位 |
| 落点 | `dropIndexFor()`：把被拖行自己的槽位摘掉，其余每行有一个"静止中点"，被拖行的**中心**越过谁的中点就排到谁后面（标准的中点判据，不抖） |
| 松手 | 那一行先按"松手位置 − 槽位位置"摆回去，下一帧归零 → 它是**滑**进槽位（FLIP），不是啪地跳一下。其余各行在预览布局里本来就等于落位后的位置，不用动 —— 所以提交顺序时(DOM 重排 + transform 一起归零)**同一帧**发生，看不到任何跳动 |
| 手感细节 | 抬起样式 = 阴影 + 分层底色（不再是"原地变淡"）；拖动期间禁止选中文字；`Esc` 取消；指针贴容器上下边 28px 内自动滚动（长清单能拖到底）；`touch-action:none` 让触屏也能拖 |

**护栏**：`dropIndexFor` / `previewOffsets` / `restTops` / `moveInOrder` 都是纯函数，在
`scripts/smoke-client.mjs` 里逐值验（等行高、行高不一致、越界夹紧、落点没变就不动）。
另有一条**反向**护栏：客户端包里**不许再出现**原生拖放（按编译后的对象键 `draggable:` /
`onDragStart:` … 查，注释里的裸词不算），也不许再有 `__ru_rowDragging{opacity…}` 那种
"原地变淡"的表示法；正面的 `setPointerCapture` / `__ru_rowShift` / `__ru_rowSettle` 必须都在。
`_probe/run/bundlecheck.mjs` 里有同样三条。

每次拖动都会在宿主日志里留两行（`client ping: drag-start` / `drag-end`），带上实测的
行高、行距、起止下标、实测位移 `dy` 与位移上下界 —— "为什么落点算成了这一位"不用猜。
实测样例（真机，`heights:[52,52,52], gap:6` = 行高 52px、行距 6px，所以跨越一格要拖过
`52+6 = 58px`）：

```text
客户端第一次真机拖动（2026-10-13 22:46，加 dy/limit 之前的那一次）：
  client ping: drag-start {"rows":3,"from":2,"heights":[52,52,52],"gap":6}
  client ping: drag-end   {"from":2,"to":2,"moved":false,"cancelled":false}
```

这一次 `moved:false` 是**正确**的：`from:2` 是最后一行，它往下拖会被夹住（它已经在
最底下），而它只挪了不到"跨越一格需要的 58px"。加了 `dy` / `limit` 之后，同样一次会
写成 `…,"dy":<实测位移>,"limit":[<上界>,<下界>]` —— `dy` 明明超过 58 却还 `to:2`，
才是落点算错了。这两个数放在一起就是为了把"没跨过中点"和"落点算错"分开。

### 跟着当前工作区变


宿主**没有**"当前工作区"这个概念（`workspaceDomainState` 只有有序列表 +
`defaultWorkspaceId`，没有 `activeWorkspaceId`）。但客户端渲染哪条会话它是知道的，
而会话的 `header.cwd` 就是权威的项目根目录（DSH 硬约束 `session.cwd === workspace.path`）。
所以链路是：

```
宿主把当前会话 id 交给插槽 → 注册项的 inject(sessionId)
      ↓  GET /dsh-run-deck/api/state?sessionId=…
host 解析 cwd：ctx.sessions.get(id).header.cwd
            →（内存里没有这条会话时）sessionController.list/inspect 的会话目录
      ↓  现读这个目录的 .dsh/run-deck/run.json
浮动条整组换成这个工作区的按钮
```

**会话 id 只有 `inject(sessionId)` 这一条来路**——`conversation.input.overlay` 是
`renderSlot(key, {})` 渲染的，组件 props 里根本没有 `sessionId`；直接读
`props.sessionId` 会恒为 `undefined`，于是 `/state` 既没有 cwd 也没有 sessionId，
返回 `focused: null` + `buttons: []`，浮动条按设计整条隐藏——表现就是"插件装上了、
日志也正常，但界面上什么都没有"。同一插槽的官方占用者
（`dsh-client-ui-input-trigger` / `dsh-client-ui-commands`）都走 `inject`。

浏览器侧的 `sessions` 服务**没有** `get(id)` / `list()`（只有
`retain/using/retainInfo/refreshProjections/search/fork/scope/binding`），
所以 cwd 只能在 host 半边解析。host 侧按**可靠性**排了三级
（`RunDeckManager.sessionCwdAsync`）：

| 顺序 | 来源 | 何时命中 | 代价 |
| --- | --- | --- | --- |
| 1 | `ctx.sessions.get(id).header.cwd` | 这条会话**被激活过**（有活着的 agent / 被某条执行链持有） | 内存读，免费 |
| 2 | `sessionController.list({}).items[].cwd` | 会话目录：**空闲会话也在里面**（持久化摘要） | 一次目录读，几十字节/条 |
| 3 | `sessionController.inspect(id).meta.cwd` | 兜底：会话的持久化头部（`SessionHeader.cwd`） | ⚠️ 连整条会话日志一起返回，所以只在第 2 步也查不到时才走，且扫描时跳过 `events` |

解析成功的「会话 → cwd」会缓存（一条会话的 cwd 在创建时就定了，不会变），
所以 2.5 秒一次的 `/state` 轮询不会反复读会话目录。

**为什么必须有第 2、3 级**（真实故障）：`ctx.sessions` 是**内存**存储，
重启 DSH 之后只有"被激活过"的会话在里面。侧边栏点开一条**空闲**会话时，
第 1 级返回 null → `focused:null` → `buttons:[]` → 整条隐藏。
表现就是"这个仓库本来有按钮（那时那条会话还是活的），重启 DSH 之后没了"。
会话目录是持久化的，空闲会话也在里面，所以这两级能兜住。

`/state` 收到 cwd 后**现读磁盘**（启动那一刻 `workspaceRegistry.list()` 与
`sessions.list()` 可能都还是空的，插件自己那行日志会写"0 个项目根目录"——
这不影响浮动条）。

**改了 `.dsh/run-deck/run.json` 会在下一轮 `/state`（≤2.5 秒）自动生效**：已经加载过的项目
每次都会比一下清单的 `mtime`（`loadFocusedProject` → `manifestChanged`），变了就现读
一遍并留一行 `清单变了，已重读：…（N 条）`。不需要重启 DSH，也不需要知道
`/run-deck list` 会顺手重读——实测"改完清单发现界面还是旧的"是很容易让人以为
"插件没生效"的坑。清单被删掉/写坏时也一样会重读，结果是条隐藏 + 面板里出现告警，
而不是留着上一次的按钮。

切换到没有 `.dsh/run-deck/run.json` 的目录时**整条隐藏**（不是显示空条）。
`/api/focus` 还能让**任意目录**成为焦点——不要求它先在 DSH 里注册成工作区。

按钮点一下 = 跑；这一条正在跑时再点 = 停（`/api/run` 与 `/api/stop`）。
条目引用了没有默认值的 `promptString` 时，点跑先弹一个填值面板（§5），填好才起进程。
**它不新增任何执行能力**——与 `/run-deck run` 是同一条路径。

### 排障：怎么确认"客户端半边到底加载了没有"

历史教训：这条路以前**完全没有观测点**，所以只能猜。现在几行日志就够二分：

| 日志（host 侧） | 说明 |
| --- | --- |
| `服务可用性：workspaceRegistry=… sessions=… sessionController=… subprocess=…` | 插件启动时必打一行。`MISSING` = **那一刻**这个服务还不在本 fiber 作用域里（后续注册的服务这时当然还没出现，所以它只说明"启动那一刻的快照"，不是"点按钮时也没有"）；真要判断能不能起进程，看点击返回的错误或 `capabilities.subprocess` |
| `cwd 解析：会话 **** → <目录>（来源：…）` | 每个会话只打一行：焦点项目的 cwd 是从哪解析出来的（内存会话存储 / 会话目录 list / inspect）。解析不出来时会写 `没解析出工作目录（…）→ 浮动条整条隐藏`——"这个仓库为什么没按钮"在日志里就是一句可读的话 |
| `清单变了，已重读：<路径>（N 条）` | 改了 `.dsh/run-deck/run.json` 之后自动重读时打一行（按 `mtime` 判断，见 §7）。没有它，"我刚改的 pattern 到底生效了没"就得靠猜 |
| `onReady 接力：<label>` | manifest 里写了 `onReady` 才会出现：**点一个按钮却跑起来两条**。⚙ 面板里同样会写 `→ <id>（onReady）`，因为这件事很容易被当成故障 |
| `跑 … → PTY 已开（cmd.exe /d /s /c …）` | 起了一条 run。`pid` 那一段要留意：Windows/ConPTY 上 node-pty 实测给的是 `pid 0`，拿不到真 pid 时**不写 pid**（写个 `pid 0` 只会让人以为进程没起来） |
| `client ping: client-loaded` | 浏览器**确实执行到** client half 的 `apply()`（包到了页面） |
| `client ping: slot-rendered {…buttons:N}` | 插槽**确实渲染了**组件，并带回它看到的 `sessionId` / `focused` / `buttons` 数量 |
| `client ping: state-changed {…hidden:true/false}` | **按结果签名去重**的一行：换会话、焦点变化、按钮数变化各留一行，`hidden:true` 就是"这一帧条不会画出来"。`slot-rendered` 按阶段名去重（一个页面生命周期只发一次），所以"切到另一个会话之后条还在不在"以前在日志里看不见——这一行补上了 |
| `client ping: slot-focused {…}` | 焦点解析成功、按钮条真的出来了（重启后第一次为空、随后恢复的完整过程都能在日志里看到） |
| `client ping: geometry {…}` | **真实几何 + 主题令牌**：条的 rect、输入框卡片的 rect、祖先链、`computed` 的 width/position、生效 CSS 的指纹、几个底色的实测值，以及 `stack`（层叠实测，见下一节） |
| `client ping: drag-start {…}` / `drag-end {…}` | 每次拖动排序各一行（**不去重**）：启动那一刻实测的每行高度与行距（`drag-start`），以及起止下标、是否真的动了、**实测位移 `dy`** 与位移上下界 `limit`（`drag-end`）。最后两项是刻意加的：`dy` 很小 = "没跨过任何中点"（正确），`dy` 明明跨过了一格却还停在原位 = 落点算错了 —— 这两种情况必须能分开 |

三行的读法：没有第 1 行 = host 半边没加载；有 1 无 2 = 包没被浏览器取到；
有 2 无 3 = 注册成功但插槽没渲染；`state-changed` 里看 `sessionId` / `clientCwd` /
`reason`：`sessionId:null` = 插槽没把会话 id 交上来；`buttons:0` 且
`reason:null` = 这个目录没有 `.dsh/run-deck/run.json`（这是**正常**的隐藏）；三条解析路
都没拿到 cwd 时 `focused` 会是 `null`——那时看 warnings 里的 `sessionController.*`
报错。

纯 CSS 的贴合/重叠问题**不要靠截图数像素**——`geometry` 那行就是为它准备的。

### 两个"看得见"的问题，怎么查（别靠猜）

- **"点按钮会不会弹出一个空的 cmd 窗口？"** —— 用 `_probe/run/` 里那三个窗口探针。
  **不要**用 `Get-Process | Where MainWindowTitle`：标题为空的窗口会被漏掉，而 ConPTY
  的窗口正好没有标题（我第一次就是这么"什么都没看到"的）。
  - `windows.ps1`：所有**可见顶层窗口**（P/Invoke `EnumWindows`）；
  - `console-windows.ps1 [-Raw]`：只列控制台类窗口（`ConsoleWindowClass` /
    `PseudoConsoleWindow` / `CASCADIA_*`），带 `visible` 与 rect；
  - `watch-console-windows.ps1 -Seconds 60`：盯着变化打时间戳（配合 `ptywindow.mjs`
    或一次真实运行）。
  实测结论：插件那条 PTY 的控制台窗口是 `visible=False`、`16x16`，**不会**出现在桌面上。

- **"停了之后端口还被占着"** —— 这些启动脚本的进程树里有 `pnpm → node host → vite`
  这样的中间层，中间进程一退出，真正的服务就**重新挂父**，于是脚本自己的
  `taskkill /T`、以及"等出事之后再按树快照去杀"都会漏掉它（实测泄漏的 vite preview
  一直占着 5180，下一次点按钮只能看到"已经有一个画廊在跑"）。
  对策在插件这一侧：轮询里每 800ms 调一次 `handle.inspectActivity()`
  （`manager.ts` 的 `pollOnce`）——它会把当前后代并进 handle 自己的
  `trackedDescendants`，`terminate()` 就是靠这份**一路攒下来的**记录去杀整棵树；
  等树断了再快照就晚了。

两个已经踩过的坑（都能从 `geometry` 里一眼看出来）：

- **样式不刷新**：`injectStyles()` 早先写成"有同名 `<style>` 就 return"。
  页面第一次加载创建的那份 CSS 会一直留着，之后 HMR 换了 bundle 也照样用旧样式——
  表现为"代码改了、界面没变"。现在每次都覆写 `textContent`。从 `geometry.css.hostRule`
  能看到当前生效的那条规则到底是不是最新。
- **自定义属性读错地方**：`--dsh-composer-*` / `--dsw-specific-*` 声明在会话面板内部，
  `getComputedStyle(document.documentElement)` 上读出来全是空串；要从**自己的元素**上读。
  同理，我们的直接父元素是 `display:contents` 的插槽包装（rect 恒为 0×0），
  真正排版我们的是再往上那个 `display:flex` 的容器。

### 第三个"看得见"的问题：弹层被宿主的「回到底部」圆钮压住（**层叠上下文**，已修）

**现象**：⚙ / `+` 面板打开着，把会话往上滚让宿主的圆形「回到底部」钮浮出来，
那个钮会盖在面板的右下角上（面板自己的 `z-index:10` 一点用都没有）。

**根因**（三条字面事实，全部从安装包里读出来）：

1. 我们这一行住在宿主的 `composerSeat` 里（`geometry.ancestors` 的最后一节就是它），
   而 `ConversationRoot.module.css` 给的是
   `.ank0OG_root[data-phase=active] .ank0OG_composerSeat{z-index:7;position:sticky}`。
2. `position:sticky` + `z-index:7` = **一个层叠上下文**。真机上量到了这一条：
   `geometry.stack.seat = "ank0OG_composerSeat{pos:sticky,z:7,上下文:positioned+z}"`。
3. 圆钮住在 `ChatView.module.css` 的 `.X6jxGq_toBottomSlot{z-index:8}` 里，
   而那个槽位是 seat 的**兄弟子树**（同在 `scrollBody` 下）——所以在**父上下文**里，
   它以 8 压住整个 seat 子树（包括我们）。

**关键推论**：`.__ru_pop{z-index:10}` 是"**seat 上下文内部的** 10"。层叠上下文是硬边界，
后代再大的 z-index 也出不去 —— 所以把 10 改成 20、999 都一样没用。这不是"值不够大"，
是"钥匙开错了锁"。

**修法**：照抄宿主自己的做法。宿主在同一次冲突里（composer 里的 `@` 引用菜单同样被这个
圆钮压住）用的就是这一招，就在同一条 seat 规则的后面：

```css
.ank0OG_root[data-phase=active] .ank0OG_composerSeat:has([data-trigger-menu]){z-index:9}
```

我们在**自己的弹层打开期间**把 seat 抬到同一个层级（`STACK_LIFT_RULE`，见 `src/client.tsx`）：

```css
[data-composer-seat][data-conversation-region="composer"]:has(.__ru_host .__ru_pop),
[data-composer-seat][data-conversation-region="composer"]:has(.__ru_host .__ru_menu){z-index:9}
```

两个刻意的细节：选择器写成 **(0,4,0)** 特异性（`[data-composer-seat]` +
`[data-conversation-region="composer"]` 各算一个、`:has(.__ru_host .__ru_pop)` 的参数是
(0,2,0)），压过宿主那条 (0,3,0)——少写一个属性就打平、只剩源码顺序决胜；而且只在弹层
打开时生效（`:has`），不动宿主的常驻布局。

**证据（真机 A/B，`geometry.stack`，同一帧里"摘掉规则 / 装回规则"各量一次同一像素）**：

```json
"stack": {
  "seat": "ank0OG_composerSeat{pos:sticky,z:7,上下文:positioned+z}",
  "button": {"what":"X6jxGq_toBottom{pos:static,z:auto,不新建上下文}",
             "rect":{"top":826,"left":1463,"width":34,"height":34},
             "slot":"X6jxGq_toBottomSlot{…,z:8,…}"},
  "popupOpen": true,
  "probe":   {"rect":{"top":648,"left":577,"width":920,"height":220},
              "withRule":    {"seatZ":"9","hit":{"at":[1480,843],"names":["__ru_pop","__ru_pop","svg","X6jxGq_toBottom",…]}},
              "withoutRule": {"seatZ":"7","hit":{"at":[1480,843],"names":["svg","X6jxGq_toBottom","__ru_pop","__ru_pop",…]}}},
  "realPopupHit": {"at":[1480,843],"names":["__ru_pop","__ru_pop","svg","X6jxGq_toBottom",…]},
  "verdict": "svg → __ru_pop；seat z-index 7 → 9"
}
```

圆钮**自己**是 `pos:static, z:auto`（它不新建上下文）——压住我们的是它外面那个槽位，
安装包里 `.X6jxGq_toBottomSlot{z-index:8}`；`button.slot` 就是为它加的，滚上去时一起量。

读法：**摘掉**抬升规则时，那个像素上最上层是圆钮自己（`svg` → `X6jxGq_toBottom`，
面板 `__ru_pop` 排在它后面 = 被盖住）；**装回**规则后最上层变成我们的面板。
`realPopupHit` 是**真面板**（不是探针）在同一像素上的命中序 —— 和"装回规则"一致。
`hit.names` 是 `document.elementsFromPoint()` 的原话（上 → 下），不是推断。

**护栏**（改坏了会红）：

- `scripts/smoke-client.mjs`：规则在不在、是否只在弹层打开时生效、**:has 权重是否仍
  严格大于**宿主那条 seat 规则（自带一个 `classTokens()` 计数 + 用宿主那条 (0,3,0) 自校验）、
  抬升值是否仍 **> 8**；另外**直接读安装包**核对宿主契约（seat `z-index:7`、
  `toBottomSlot{z-index:8}`、`data-composer-seat` 还在、
  宿主那条 `:has([data-trigger-menu]){z-index:9}` 还在）——宿主改了层叠结构就会在这里炸，
  而不是悄悄又盖回去。读不到安装包（换机器）时这一条跳过。
- `_probe/run/bundlecheck.mjs`：契约与 A/B 探针是否真的进了客户端包。

> 纯"谁盖住谁"的问题**不要靠截图数像素**：`elementsFromPoint` 的命中序就是答案，
> 而 `geometry.stack` 会把"有这条规则 / 没这条规则"两种状态并排放在同一行日志里。

顺手可查的旁证：Chromium 的 HTTP 缓存里如果存在本插件的 bundle，
就说明浏览器**取到过**它（缓存目录见下），不必重启也能确认：
```powershell
$cache = "$env:APPDATA\DSH Desktop\Partitions\dsh-desktop-renderer\Cache\Cache_Data"
Select-String -Path "$cache\*" -Pattern '@aeroscis/dsh-run-deck' -List | Select-Object Path
```

客户端 bundle 的改动会被 client HMR 自动重取（无需重启）；**host 半边的改动
必须重启 DSH Desktop** 才会生效。

---

## 8. 命令

```text
/run-deck list                    列出全部条目（id / 命令 / 目录）+ 进行中的 run
/run-deck run <id>                跑一个条目（id 用 list 里那个）
/run-deck stop <runId>            停掉一个 run
/run-deck rerun <runId>           停掉旧的再开新的
/run-deck path                    显示各项目的 .dsh/run-deck/run.json 落点
/run-deck help                    帮助
```

- id 里**可以带 `/`**（例如 `jin/web`），所以按完整 id 找，不再切分
- label 只在唯一时接受；多个匹配会提示改用 id
- 含空格的标题用引号：`/run-deck run "jin · web"`

## 8b. 外部按 id 调用（第 4 步）

模型侧有一个 **`run-deck`** 工具，与面板、命令调**同一个 manager**（不存在两套逻辑）：

| action | 参数 | 说明 |
| --- | --- | --- |
| `run` | `entry_id`（+ `input_values?`） | 按 id 精确定位并发起。`input_values` 是 `${input:id}` 的本次运行取值（如 `{"mode":"web"}`）；条目引用了没有默认值的 input 而没给时拒绝执行并说明缺哪个 |
| `stop` | `run_id` | 停掉一个 run |
| `rerun` | `run_id` | 停掉旧的再开新的，返回新 runId |
| `create` | `label` + `command`（+ `project_root?` / `is_background?` / `ready_pattern?`） | 帮用户加一个启动按钮：与「+」面板同一条链路（校验 + 写进项目 run.json），按钮条 ≤3s 出现。缺 `project_root` 时用调用会话的 cwd |

工具描述里**内联当前可用的条目清单**，模型调用前就知道有哪些 id；
`action=create` 的说明也写在描述里——用户对 agent 说"帮我加个跑 XXX 的按钮"，模型
不需要任何注入的 prompt 就知道调它。直接编辑 run.json 同样合法（mtime 轮询 ≤2.5s 感知，
`buttons[]` 缺省时全部条目默认上条）。
返回体的字段名是 `entry_id` / `run_id` 这样的下划线形式（与其它 dsh-tool-* 一致）。

安全边界与 HTTP 路由一致：**执行类动作（run/stop/rerun）只接受 id，不接受命令**。
`entry_id` 里出现 `python x.py`、`npm run dev` 这类形态一律按"未知 id"拒绝，
**不回落按 label 匹配**（label 可重名，不能当接口）。

`create` 是唯一接受自由文本的动作，但它写的是**清单**而不是执行：字段由
`buildTaskEntry` 逐项校验（坏正则、不存在的目录、撞车的 id 都拒绝落盘），产出的
`TaskEntry` 与手写进 `run.json` 的一条完全等价——执行仍然只认清单里的字面量。

`@deepseek-ai/dsh-tools` 是**可选依赖**（动态 import）：宿主没装时插件照常加载，
只是少这一个入口，日志里会写清原因。

> **快捷键：没有做，因为 DSH 不提供这个能力。**
> 当前版本（0.2.0-rc 线）里没有 keybinding / hotkey / keymap 之类的服务可注册——
> 运行时包的 `lib/types/*.d.ts` 里查过，没有可用的键位注册入口。所以第 4 步的可达入口是
> **浮动条 + 命令 + 工具**，快捷键等宿主开放对应服务再补。

---

## 8c. HTTP 接口

`/dsh-run-deck/api/*`，只接受 loopback authority、`sec-fetch-site: cross-site` 一律拒绝、
变更类只 POST。**所有接口只接受 id 指针，不接受自由命令**：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/state?sessionId=…`（或 `?cwd=…`） | 全量状态：焦点项目、它的 buttons[]、全部条目、runs、告警、能力。`sessionId` 由 host 解析成 cwd（内存会话存储 → 会话目录，见 §7）；两条路都会**现读**该目录的 `.dsh/run-deck/run.json` |
| POST | `/ping` | `{stage, detail?}` 客户端半边的诊断上报，**只写 host 日志**（`client-loaded` / `slot-rendered` / `state-changed`） |
| POST | `/refresh` | 重读**全部**清单（手动全量重读；单个清单改了其实不用它，见下） |
| POST | `/run` | `{projectRoot, entryId, sessionId?, inputValues?}` 开一条 PTY 把这条 entry 跑起来（`sessionId` 只用于记录与 `DSH_SESSION_ID`，可以不给；`inputValues` 是 `${input:id}` 的本次运行取值，只有引用了它的条目会读） |
| POST | `/stop` | `{runId}` 停 |
| POST | `/rerun` | `{runId}` 停旧的再开新的 |
| POST | `/observe` | `{runId, line}` 推进钩子状态（第 3 步接线用） |
| POST | `/entry` | `{projectRoot, entryId}` 一条 entry 的声明 + 算好的命令行 |
| POST | `/task` | `{projectRoot, label, command, cwd?, env?, isBackground?, group?, id?, readyPattern?, openUrl?, urlPattern?, uriFormat?, reveal?, onReady?}` 新建一条并写进项目 `run.json`（host 逐项校验，失败不落盘） |
| POST | `/task/update` | `{projectRoot, entryId, …同 /task 字段}` 原位替换项目 `run.json` 里那条 task（校验与新建同一份；id 可改，`buttons[]` 声明与本地覆盖跟着搬到新 id） |
| POST | `/detect` | `{projectRoot}` 读该项目的 `package.json` `scripts`，返回候选（含猜出来的长驻 / 就绪正则 / 分组）；只读、不落盘、不执行 |
| POST | `/task/remove` | `{projectRoot, entryId}` 从项目 `run.json` 的 `tasks[]` 里真的删掉一条（连带 `buttons[]` 与本地覆盖） |
| POST | `/button` | `{entry, pinned?, order?, icon?, group?, label?}` 单个按钮的本地覆盖 |
| POST | `/reorder` | `{order: [entryId…]}` 整组排序（拖拽落点） |
| POST | `/density` | `{density: full\|compact\|icon}` 密度偏好 |
| POST | `/focus` | `{cwd}` 或 `{sessionId}`，让任意目录成为焦点项目 |
| POST | `/ping` | 客户端诊断上报（`client-loaded` / `slot-rendered` / `state-changed` / `geometry`），只写日志 |

---

## 9. 交付顺序（全部六步，按既定范围收口）

1. ~~三个阻塞项测试 + 路线选择~~ ✅ 见 §2 与 `docs/blocker-findings.md`
2. ~~手动动作列表：跑 / 停 / 重跑~~ ✅
3. ~~事件钩子的语义层~~ ✅ `src/hooks.ts`；**真实输出已接线**：host 每 800ms 轮询终端的
   scrollback → `manager.observe()` → ready / serverReadyAction / onReady 全部真的跑
   （`_probe/run/e2e-focus.mjs` 与 `npm run smoke:host` 里各有一条端到端证据）
4. ~~外部按 id 调用~~ ✅ `src/tool.ts` 的 `run-deck` 工具 + `/run-deck` 命令。
   快捷键没有做：DSH 不提供 keybinding 服务（见 §8b）
5. ~~`buttons[]` 浮动层~~ ✅ 输入框上沿的浮动条 + 三档密度 + 拖拽排序 + `+`/`⚙` 面板，
   `layout.json` 本地覆盖（顺序/显隐/密度），见 §7
6. **动作序列（steps/dependsOn）明确不做**——要编排回到 `&&`（VS Code 的做法）。
   需要"单独重跑中间某一步"时再议。

每一步都只是「执行一条目」这条路径的另一个入口。第 1 条是入口，不是画 UI。

---

## 10. 样例项目（`D:\Flora\ProgramProjects`）

| 项目 | 启动 | 就绪信号 |
| --- | --- | --- |
| `jin` | `start_gallery_web.py` / `start_gallery_desktop.py` | stdout `gallery ready at <url>` **或** `a gallery is already running at <url>`；desktop 侧 `starting the desktop shell: <exe>` |
| `Ceola` | `start.bat` → `scripts/start.py --mode dev/web/release` | 端口 1420（从 `src-tauri/tauri.conf.json` 的 `devUrl` 读） |
| `tailtale` | 同 Ceola，端口 5173 | 同上 |
| `open-claw-setup` | `start_ftp_server.bat` → `ftp_server.py` | 无（长驻 FTP，`serve_forever`） |
| `cteno` | **本轮排除** | `scripts/start_debug.py` 三处硬伤：按镜像名杀、`CREATE_NEW_CONSOLE` 起进程不存 handle 没有 PID、`build_frontend()` 可能几分钟而 `wait_for_ctenod` 只有 12 秒 |

就绪判定**以 stdout pattern 为主、端口探测只做兜底**：jin 的脚本会自己判断端口上
是不是我们的画廊（`is_our_gallery`），插件光探端口区分不了「我们起来了」和
「端口被别的进程占了」，会给出**假绿点**。

**一个模式要覆盖脚本的所有成功路径**（实测踩到）：jin 的 `web` 在"端口上已经有我们的
画廊"时走的是 `a gallery is already running at <url>` 并**立刻退出 0**——endsPattern 只写
`gallery ready at …` 的话，这一支既不算就绪也不开浏览器，点按钮就成了"闪一下没了"。
所以那里的 pattern 是 `(?:gallery ready|a gallery is already running) at (http://\S+)`。
写自己的 `run.json` 时值得照着检查一遍：**脚本有几种"成功"说法，pattern 就要有几种**。

---

## 11. 开发

```powershell
npm install
npm run check        # typecheck + build + check:pack + smoke + check:registration
```

结构：

```
dsh-run-deck/
├── package.json / cordis.patch.yml / tsconfig*.json
├── src/
│   ├── host.ts           # Cordis 插件入口：name / inject / Config / apply
│   ├── host-config.ts    # 插件配置的归一化与读写（三级：plugin-config / settings / config.json）
│   ├── manager.ts        # 业务核心：清单加载、焦点项目、run 登记、钩子推进、浮动按钮视图
│   ├── projects.ts       # .dsh/run-deck/run.json 的读取、注释剥离、字段收敛、变量展开、根目录归一化
│   ├── config.ts         # 单条 entry 的收敛 + ${…} 展开 + id 派生
│   ├── exec.ts           # 执行通道探测（终端路线）+ 就绪 pattern 匹配
│   ├── hooks.ts          # 第 3 步：事件钩子语义（beginsPattern/endsPattern/serverReadyAction/onReady）
│   ├── tool.ts           # 第 4 步：run-deck 工具的参数分发（只接受 id，不接受命令）
│   ├── store.ts          # layout.json（机器本地个人覆盖：顺序/显隐/密度，不进仓库）
│   ├── commands.ts       # /run-deck 命令
│   ├── routes.ts         # /dsh-run-deck/api/* HTTP 桥（同源围栏）
│   ├── types.ts          # host/client 共享类型（零运行时依赖）
│   ├── client.tsx        # 浮动条（对齐/让开/密度/降档）+ `+` 面板 + `⚙` 面板
│   ├── index.ts          # 包入口（重导出 host half）
│   └── dsh.d.ts          # DSH 接口的最小环境声明
├── lib/                  # 构建产物：host 运行时（ESM，DSH 加载的就是它）
├── client/client.js      # 构建产物：client 的 ModuleLoader 包
├── scripts/              # build-client / prepare / check-pack / check-registration / smoke*
├── docs/blocker-findings.md
└── _probe/               # 第 1 步的信号/控制台探针 + 各步的端到端/安装自检（可复用）
```

`_probe/run/` 下可直接复用/复跑：

- `sighandler.py` — 信号处理器替身（换目标项目改清理路径即可）
- `consolechild.py` — console 所有权 / `hold_console()` / `CREATE_NEW_CONSOLE` 三合一
- `killprobe.js` — 派生 + 发信号 + 收标记
- `e2e-focus.mjs` — 焦点工作区 → 按钮组 → 跑/停 → 拖拽排序的端到端
- `installcheck.mjs` — desktop profile 安装自检（§1 那 5 步逐项核对）
