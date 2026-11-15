# dsh-run-deck 设计文档

内部文档：实现细节、为什么这样设计、逐条核对过哪些宿主行为、被否决的方案、测试与发版流程。
使用者要看的安装与用法在 [README](../README.md)。

## 1. 一句话与边界

按当前工作区 `.dsh/run-deck/run.json` 里声明的条目跑 / 停 / 重跑，词汇表照抄 VS Code
tasks.json。**配置是指针，不是编排**：命令指向已有脚本，逻辑留在脚本里。

明确不做：动作序列（`steps` / `dependsOn`）。要编排回到 `&&`，这是 VS Code 自己的做法。

增量只有三处，且全部可删：

| 增量 | 是什么 | 补的是什么 | 删掉会怎样 |
| --- | --- | --- | --- |
| `buttons[]` | 钉到浮动层：entry 的别名 + 图标 + 分组 | 纯策展 | 浮动层空着，`tasks[]` 照跑 |
| `onReady: "<entry id>"` | 就绪后接另一个 entry | VS Code issue #69311：`serverReadyAction` 只能 `openExternally` | 就绪后什么都不接 |
| `id` | 跨族唯一标识 | 给外部按名字调用 | 从 label 派生 id（仍唯一） |

约束：`onReady` 只接受 entry id，不接受命令（否则它是第二条执行通路）；`label` 可重名，
不能当接口；哪个增量变成"没它不行"，就删掉哪个。**新增 `TaskEntry` 字段时必须同步
`src/manifest-edit.ts` 的 `renderTask` 固定字段清单**，否则编辑面板会静默丢掉该字段。

## 2. 为什么走终端而不是后台 job

这些项目的启动脚本是**前台交互工具**，不是守护进程：全程打印日志、期望 Ctrl+C、
失败时可能 `input("按回车键关闭…")` 挂住等按键，进程树清理只挂在 SIGINT / SIGTERM /
SIGBREAK 的处理器里（新进程组 + `taskkill /T`）。

三轮探针实测（`_probe/`，python 替身装上同三个处理器）：

| 探针 | 发出的信号 | Python 退出 | 处理器是否跑 | `taskkill /T` |
| --- | --- | --- | --- | --- |
| `sigterm-plain` | SIGTERM（`process.kill`） | exit 1 | **否** | **未执行** |
| `sigbreak` | SIGBREAK（`child.kill`） | SIGKILL | **否** | **未执行** |
| `sigint-test` | SIGTERM | exit 1 | **否** | **未执行** |

三个信号**一个都没让处理器跑起来**。原因是 Windows 的信号模型：只有「控制台为进程
生成 Ctrl+C / Ctrl+Break」才会把 `CTRL_C_EVENT` / `CTRL_BREAK_EVENT` 送给进程组，
而 `GenerateConsoleCtrlEvent` 隐含要求调用者自己挂着控制台。job（`detached: true` +
`stdio: 'ignore'`）派生的进程实测 `GetConsoleProcessList() == 0`——没有控制台可挂，
信号到不了处理器，进程树清理这条链的起点就断了，端口被孤儿占住。

所以执行路线是**真 PTY**：它有真控制台，`signalForeground('SIGINT')` 走同一个交付路径
（win32 上就是往 PTY 写一个 `\x03`，与真人按 Ctrl+C 一致）。

具体用哪条缝：**`ctx.subprocess.spawnTerminal`**（`@deepseek-ai/dsh-subprocess-local`，
底层 node-pty / ConPTY）。**不是** `ctx.terminals`：那是 `@deepseek-ai/dsh-terminal` 的
PTY 注册表，只在 `dsh-sdk-minimal` 那类组合里挂载，桌面版（`dsh-base` + `dsh-web-app`）
里没有它。

两条同批结论：

- `_owns_console()` 在 job 环境下返回 `false`，`hold_console()` 不会挂住（`input()` 立刻 EOF）。console 检测合理、无害。
- `CREATE_NEW_CONSOLE` 的孙子进程能起来也能被 taskkill 到；但探针会话里 `taskkill` 被 pwsh 沙箱拦了，这一条当时无法证明。

完整结论与原始证据：[`docs/blocker-findings.md`](blocker-findings.md)、`_probe/out/*.jsonl`。

### 谁来跑：不需要 Agent owner

`ctx.terminals` 的每个操作都要求一个 owner，所以早先必须用"那个会话当前活着的 Agent 对象"；
`ctx.subprocess` 的执行缝没有这个要求。于是：

| 入口 | sessionId 从哪来 | 用途 |
| --- | --- | --- |
| 浮动层按钮 | 客户端把当前会话 id 报上来 | 记进 `RunRecord.ownerSessionId` + 子进程的 `DSH_SESSION_ID` |
| `/run-deck run <id>` | 命令的 `invocation.agent` | 同上 |
| `run-deck` 工具 | 工具的 `exec.agent` | 同上 |

**sessionId 可以不给**（缺了照样跑，只是没有那两条记录）。

## 3. 读取输出并推进就绪判定

`handle.output` 是一条流（ConPTY 的屏幕更新流）：按 `\r\n` / `\n` / `\r` 切行、剥掉
ANSI 转义、丢空行，放进有界行队列；host 每 800ms 把新行逐行喂给 `manager.observe()`：
beginsPattern 门控 → endsPattern 匹配到即 ready（记下 URL）→ `serverReadyAction` 打开地址 →
`onReady` 接力。

**退出判定不靠猜**：命令用 `cmd /d /s /c`（POSIX 上 `<shell> -c`）跑，shell 执行完就退，
所以 `handle.done` 结算 = 任务结束，退出码也是任务自己的。

### `serverReadyAction: openExternally` 由界面打开

实测宿主侧没有可用入口：桌面版没有 `ctx.openPath`，`sessionController.openWorkspacePath`
只接受工作区内路径。所以 host 只把地址记进 `RunRecord.ready.url`，**client half 轮询到就
打开一次**：`window.open(url, '_blank', 'noopener,noreferrer')`——桌面壳的
`setWindowOpenHandler` 会接住（实测 `shell.openExternal`），也就是系统默认浏览器。
去重键存在浏览器本地（`dsh-run-deck.openedUrls.v1`），否则每次刷新都会再弹一次。

> 日志坑：宿主日志会把"看起来像 URL 的整段"规范化，`http://x/（说明）` 挨着写会被整段
> percent-encode。所以日志里地址与说明之间**留一个空格**。

## 4. 落点

- 项目里：`.dsh/run-deck/run.json`（**不是** `.vscode/`）。旧位置 `.dsh/run.json` 仍兼容读并告警。
- 插件里：机器本地的个人覆盖（按钮布局、分组、图标、显隐、密度）在
  `<pluginDataDir>/layout.json`，**不进仓库**。

分工：run.json 是「这个项目有什么」，本地覆盖是「我怎么看它」。本地覆盖**只影响展示**，
没有任何字段能改 `command` / `args` / `cwd`，不创造新的执行能力。

## 5. UI 布局与视觉

### 为什么在 `conversation.input.dock`，而不是 `conversation.input.overlay`

`overlay` 是卡片内 `height:0; position:absolute; inset:0 0 auto` 的锚点，挂进去只能用
绝对定位浮在卡片上沿往上 34px 那条带里——而那条带**正是 dock 各行的位置**，会把「任务列表」
压在下面。同类东西放进同一个堆叠里，是宿主自己对这一列的做法。

### 同列对齐（逐值照抄「任务列表」）

注册进 `conversation.input.dock`（会话级 list，`id: dsh-run-deck-bar`，**order 15**）。
宿主 `ank0OG_composerStack` 是 `flex column; gap:6px`，按 order 排出
`todo(0) → goal(10) → 本插件(15) → queue(20) → 输入框卡片`。

尺寸逐字照抄任务列表那一条（`IJkQnq_root`）：`width: 100% - 2×side-clearance - 4×dock-inset`、
`max-width: card-max-width - 4×dock-inset`、`flex:none; margin:0 auto`。**不做 DOM 测量**。

为什么是 15：队列那一行是"贴在输入框上"的（负底边距 + 只有上面两个圆角），必须紧邻卡片；
我们是一组"针对输入框的动作"，性质最接近队列，排在它旁边；任务列表/目标是状态读出，排更上。

实测对照（`client ping: geometry`，最满状态）：

| 量 | 任务列表 | 本插件的条 | |
| --- | --- | --- | --- |
| 左边缘 / 宽度 | `636` / `920` | `636` / `920` | ✅ |
| 圆角 | `16px` | `16px` | ✅ |
| 底色 | `rgba(67, 69, 74, 0.45)` | 同 | ✅ |
| 高度 | `36px` | `34px` | ⚠️ 有意：与宿主原生「回到底部」按钮同高 |

面板面用 `--dsw-specific-menu`（半透明）+ 磨砂 + `--dsw-elevation-panel`。
**不能**用 `--dsw-alias-button-floating-fill`：它与卡片底色 `--dsw-specific-input-major`
都是 `#2c2c2e`，贴着看就是一个盒子。

> 这一列里各行并不等宽（任务列表 920 / 目标 1567 / 队列 936），这是宿主自己的设计。
> 我们只对齐任务列表那一行。

### 弹层被「回到底部」圆钮压住（层叠上下文，已修）

根因三条字面事实：我们住在 `composerSeat` 里，宿主给 `[data-phase=active] .composerSeat`
的样式是 `position:sticky; z-index:7`——**sticky + z-index 是一个层叠上下文**；圆钮住在
`ChatView.module.css` 的 `.toBottomSlot{z-index:8}`，是 seat 的兄弟子树，在父上下文里以 8
压住整个 seat 子树。所以 `.__ru_pop{z-index:10}` 是"seat 上下文内部的 10"，改成 999 也没用。

修法照抄宿主自己的做法（宿主在同一次冲突里给 `@` 引用菜单用的就是这一招）：弹层打开期间
把 seat 抬到 9，选择器写成 (0,4,0) 特异性压过宿主那条 (0,3,0)，且只在弹层打开时生效（`:has`）。

护栏（改坏了会红）：`scripts/smoke-client.mjs` 规则在不在、是否只在弹层打开时生效、
`:has` 权重是否仍严格大于宿主、抬升值是否仍 **> 8**；并**直接读安装包**核对宿主契约
（seat `z-index:7`、`toBottomSlot{z-index:8}`、`data-composer-seat` 还在）。读不到安装包时跳过。

### 拖动排序：为什么不用原生 `draggable`

原生 HTML5 拖放：浏览器给**拖源元素**（那个 4 个字形的手柄）拍半透明快照当拖影，系统绘制；
真正的行留在原地只标 `opacity:.5`；顺序只在 `drop` 那刻改，拖动过程中列表一动不动；
拖影的透明度/偏移/动画都不受页面控制。所以改成**指针事件**自己实现：

| 部分 | 做法 |
| --- | --- |
| 跟手 | 被拖行 `translateY(指针位移)`，位移算在滚动内容坐标系里，贴边自动滚动不跑掉 |
| 让位 | 其余各行按 `previewOffsets()` 平移 + `transition:transform 180ms`，位移用**累积高度**算 |
| 落点 | `dropIndexFor()`：摘掉被拖行自己的槽位，中心越过谁的静止中点就排到谁后面 |
| 松手 | 摆回"松手位置 − 槽位位置"，下一帧归零 → 滑进槽位（FLIP） |

护栏：`dropIndexFor` / `previewOffsets` / `restTops` / `moveInOrder` 都是纯函数，在 smoke-client
里逐值验；另有一条**反向**护栏——客户端包里不许再出现原生拖放（按编译后的对象键查）。

### 显示偏好放在哪，以及为什么密度会被轮询盖掉

两种偏好，两条通道，不能混：

| 偏好 | 存哪 | 谁改 | 为什么 |
| --- | --- | --- | --- |
| 按钮密度（完整 / 紧凑 / 仅图标） | `layout.json`（宿主持有） | 界面点钮 → `POST /density` | 它是"我怎么看这个项目"，宿主本来就持有布局 |
| 输出卡字号（9–18px） | 浏览器本地 `dsh-run-deck.outputFont.v1` | 界面直接改，不发请求 | 纯界面偏好，宿主侧没有这个字段；为它加路由要重启 DSH |

密度的同步有个实测过的坑：条左侧那颗循环钮早先**只改本地 state**、没写回宿主，而每 2.5 秒
一轮的 `/state` 都会带回旧档位并直接 `setDensity(它)`。结果是"从仅图标切到完整信息，过几秒
自己变回仅图标"，看着像全自动。现在点钮先改本地、同时写回 `/density`，并且**在宿主确认之前
不让轮询覆盖本地**（`densityFromPoll`）：只有本地没有待确认的档位，或宿主带回的值与本地一致时
才采纳轮询值。写回失败时本地档位保持到刷新页面为止。

`⚙` 面板里选密度走同一条路，所以点下去立刻高亮，不再等下一轮轮询。

字号走 CSS 自定义属性：卡根节点写 `--ru-out-font` 与 `--ru-out-scale`，输出区的
`font-size`/`line-height`、卡的 `width`/`max-height` 全部由它们算。**缩放比而不是写死尺寸**是
刻意的：只放大字会让同样大的窗口只能显示更少的行，等于把输出挤出去。

## 6. 焦点工作区怎么解析

宿主**没有**"当前工作区"概念（`workspaceDomainState` 只有有序列表 + `defaultWorkspaceId`）。
但客户端知道渲染哪条会话，而会话的 `header.cwd` 就是权威项目根目录（DSH 硬约束
`session.cwd === workspace.path`）。链路：

```
宿主把当前会话 id 交给插槽 → 注册项的 inject(sessionId)
      ↓  GET /dsh-run-deck/api/state?sessionId=…
host 解析 cwd：ctx.sessions.get(id).header.cwd
            →（内存里没有这条会话时）sessionController.list/inspect 的会话目录
      ↓  现读这个目录的 .dsh/run-deck/run.json
浮动条整组换成这个工作区的按钮
```

**会话 id 只有 `inject(sessionId)` 这一条来路**——`renderSlot` 渲染的组件 props 里没有
`sessionId`，直接读 `props.sessionId` 恒为 `undefined`，于是 `/state` 返回 `focused: null`，
整条隐藏。同一插槽的官方占用者都走 `inject`。

浏览器侧的 `sessions` 服务**没有** `get(id)` / `list()`，所以 cwd 只能在 host 半边解析。
host 侧按可靠性排了三级：

| 顺序 | 来源 | 什么时候能用上 | 代价 |
| --- | --- | --- | --- |
| 1 | `ctx.sessions.get(id).header.cwd` | 会话被激活过 | 内存读，免费 |
| 2 | `sessionController.list({}).items[].cwd` | 空闲会话也在里面（持久化摘要） | 一次目录读 |
| 3 | `sessionController.inspect(id).meta.cwd` | 兜底 | ⚠️ 连整条会话日志一起返回 |

**为什么必须有第 2、3 级**（真实故障）：`ctx.sessions` 是**内存**存储，重启 DSH 之后只有
"被激活过"的会话在里面。点开一条空闲会话时第 1 级返回 null → 整条隐藏。表现就是
"重启 DSH 之后按钮没了"。会话目录是持久化的，这两级能兜住。解析结果会缓存。

## 7. 排障：日志对照表

| 日志（host 侧） | 说明 |
| --- | --- |
| `服务可用性：workspaceRegistry=… sessions=… sessionController=… subprocess=…` | 插件启动时必打一行。`MISSING` = **那一刻**这个服务还不在作用域里，不是"点按钮时也没有" |
| `cwd 解析：会话 … → <目录>（来源：…）` | 每会话一行。解析不出来会写 `没解析出工作目录（…）→ 浮动条整条隐藏` |
| `清单变了，已重读：<路径>（N 条）` | 按 `mtime` 判断，改了 run.json 之后自动重读 |
| `onReady 接力：<label>` | 写了 `onReady` 才有：点一个按钮却跑起来两条 |
| `跑 … → PTY 已开（cmd.exe /d /s /c …）` | 起了一条 run。ConPTY 上拿不到真 pid 时**不写 pid** |
| `client ping: client-loaded` | 浏览器确实执行到 client half 的 `apply()` |
| `client ping: slot-rendered {…}` | 插槽确实渲染了组件，带回 `sessionId` / `buttons` 数量 |
| `client ping: state-changed {…}` | 按结果签名去重：换会话、焦点变化、按钮数变化各一行 |
| `client ping: geometry {…}` | 真实几何 + 主题令牌 + 层叠实测 |
| `client ping: drag-start / drag-end` | 拖动排序的实测行高、位移 `dy`、上下界 |

三行的读法：没有第 1 行 = host 半边没加载；有 1 无 2 = 包没被浏览器取到；有 2 无 3 =
注册成功但插槽没渲染。

两个 "看得见" 的问题不要靠猜：

- **"点按钮会不会弹出空 cmd 窗口？"** —— 用 `_probe/run/` 的窗口探针，**不要**用
  `Get-Process | Where MainWindowTitle`：标题为空的窗口会被漏掉，而 ConPTY 的窗口正好没有标题。
  实测结论：那条 PTY 的控制台窗口 `visible=False`、`16x16`，不会出现在桌面上。
- **"停了之后端口还被占着"** —— 进程树里有 `pnpm → node host → vite` 这样的中间层，中间进程
  一退出真正的服务就**重新挂父**，事后再按树快照去杀会漏。对策：每 800ms 调
  `handle.inspectActivity()`，把后代并进 `trackedDescendants`，`terminate()` 靠这份**一路攒下来**的记录。

两个已踩过的坑（都能从 `geometry` 一眼看出）：`injectStyles()` 早先"有同名 style 就 return"，
于是 HMR 换了 bundle 还用旧样式（现在每次覆写 `textContent`）；`--dsh-composer-*` 声明在会话面板
内部，从 `documentElement` 上读全是空串，要从自己的元素上读。

## 8. 安全边界

host half spawn 的进程**绕过 agent 的 pwsh 沙箱**，所以：

1. **命令必须是 run.json 里的字面量**，绝不是扫目录发现的可执行文件。
2. **没有任何接口接受自由命令**。HTTP 路由只接受 `{projectRoot, entryId}` 这样的指针；
   `/run-deck` 命令与 `run-deck` 工具的 run/stop/rerun 同理。`entry_id` 里出现命令形态
   一律按"未知 id"拒绝，**不回落按 label 匹配**。
3. **不要让 UI 变成"无确认执行任意脚本"的通路**。破坏性操作要 confirm。
4. 路由围栏与 DSH 自身 `/api` 一致：只接受 loopback authority、`sec-fetch-site: cross-site`
   一律拒绝、带 Origin 的必须与 Host 同源、变更类只 POST。

`run-deck` 工具的 `action=create` 是唯一接受自由文本的动作，但它写的是**清单**而不是执行，
字段由 `buildTaskEntry` 逐项校验，产出与手写进 run.json 的一条完全等价。

工具描述里**内联当前可用条目清单**，`action=create` 的说明也写在描述里——用户对 agent 说
"帮我加个跑 XXX 的按钮"，模型不需要任何注入的 prompt 就知道调它。返回体用下划线字段名
（`entry_id` / `run_id`），与其它 `dsh-tool-*` 一致。`@deepseek-ai/dsh-tools` 是可选依赖
（动态 import），宿主没装时插件照常加载，只少这一个入口。

> **快捷键没有做**：DSH 0.2.0-rc 线里没有 keybinding / keymap 服务可注册（运行时包的
> `lib/types/*.d.ts` 查过）。可达入口是浮动条 + 命令 + 工具。

## 9. HTTP 接口

`/dsh-run-deck/api/*`，围栏见 §8。**所有接口只接受 id 指针**：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/state?sessionId=…`（或 `?cwd=…`） | 全量状态：焦点项目、buttons[]、全部条目、runs、告警、能力 |
| POST | `/run` | `{projectRoot, entryId, sessionId?, inputValues?}` 开一条 PTY |
| POST | `/stop` / `/rerun` | `{runId}` |
| POST | `/observe` | `{runId, line}` 推进就绪判定的状态 |
| POST | `/entry` | `{projectRoot, entryId}` 一条 entry 的声明 + 算好的命令行 |
| POST | `/refresh` | 重读全部清单（手动全量重读） |
| POST | `/task` | 新建一条并写进 run.json（host 逐项校验，校验不通过不写入文件） |
| POST | `/task/update` | 原位替换 run.json 里那条 task（id 可改，声明与本地覆盖跟着搬） |
| POST | `/task/remove` | 真的从 `tasks[]` 删掉一条 |
| POST | `/detect` | 读 `package.json` 的 `scripts`，只读，不写文件，不执行 |
| POST | `/button` / `/reorder` / `/density` | 单个按钮覆盖 / 整组排序 / 密度 |
| POST | `/focus` | `{cwd}` 或 `{sessionId}` 让任意目录成为焦点 |
| POST | `/ping` | 客户端诊断上报，只写日志 |

`/task` 与 `/task/update` 共用同一份校验代码（`src/newtask.ts` 的 `buildTaskEntry`），
写盘走 `src/manifest-edit.ts` 的保留注释最小文本编辑。

## 10. 被否掉的方案

- **`${ready.1}` 这类模板变量**：它把「就绪」这个运行时状态变成模板变量，于是每条命令都要
  重新解释一遍执行时机。未知变量**原样留下**，让人看得出这里本该有值。
- **"Run Configuration 主面板 + 侧边栏入口行"**：那是"全局总表"，与"跟着当前工作区变的一键
  入口"是两回事，复杂度翻倍。只保留一个 UI。
- **读终端的 scrollback**：要求宿主交出 PTY 屏幕状态（`ctx.terminals.read`），桌面版没有那个服务。
- **`ctx.terminals` 当执行缝**：桌面版组合里根本没挂载，点按钮只会得到"宿主没有 terminals 服务"。

## 11. 就绪判定的一个实地教训

**一个 pattern 要覆盖脚本的所有成功路径。** 实测：jin 的 `web` 在"端口上已经有我们的画廊"时
走的是 `a gallery is already running at <url>` 并**立刻退出 0**——pattern 只写
`gallery ready at …` 的话，这一支既不算就绪也不开浏览器，点按钮就成了"闪一下没了"。
所以那里的 pattern 是 `(?:gallery ready|a gallery is already running) at (http://\S+)`。

同理，**就绪判定以 stdout pattern 为主、端口探测只做兜底**：光探端口区分不了「我们起来了」与
「端口被别的进程占了」，会给出**假绿点**。

## 12. 测试与发版

```powershell
npm install
npm run check      # typecheck + build + check:pack + smoke + check:registration + compat 规则测试
npm run compat     # 比对宿主接口表面与 dsh-baseline.json
```

| 脚本 | 守的是什么 |
| --- | --- |
| `scripts/smoke.mjs` | host 半边：清单元数据、变量展开、就绪判定推进、执行通道、新建/编辑校验 |
| `scripts/smoke-client.mjs` | client 半边：用假 React 渲染真组件，验交互与包内容（含上面的层叠护栏） |
| `scripts/check-pack.mjs` | 发布形态：构建产物齐、`files[]` 对、不能有本地路径垃圾 |
| `scripts/check-registration.mjs` | 宿主挂载契约：`name` 与包名对应、`cordis.patch.yml` 的行 id 一致 |
| `scripts/compat-probe.mjs` | 宿主升级后接口表面是否还在（见 `dsh-plugin-compat` 技能） |

compat 探针的已知盲点：它按 `node_modules/@deepseek-ai/<pkg>/lib/*.js` 路径扫包，宿主的桌面版
把客户端包编进内联模块加载器的单文件里，那一份**没被扫**；服务半边判定靠
`isClient === wantClientEntry`，`slots` 当前成立是因为 `dsh-client-ui-renderer/lib/index.js`
里碰巧也有同名声明兜底。两处都只影响探针覆盖度，不影响运行时。

发版顺序：改 `package.json` 的 `version` → 写 CHANGELOG → `npm run check` 全绿 →
`npm publish`（`prepack` 会现场构建）→ 打 annotated tag `v<version>` 并推送。
发布前用 `npm view @aeroscis/dsh-run-deck@<version> version` 确认 registry 上没有该版本。

### 持续集成

`.github/workflows/` 下有两个 workflow：

| 文件 | 触发 | 做什么 |
| --- | --- | --- |
| `check.yml` | push 到 main、pull request | `npm ci` + `npm run check`，全部离线 |
| `publish.yml` | push `v*` 标签、手动触发 | 核对标签与 `package.json` 版本一致 → `npm run check` → `npm stage publish` |

`publish.yml` 用 OIDC 受信任发布（`id-token: write`），**只把版本送进 stage 队列**，
真正上线要维护者用 2FA 批准（`npm stage approve <stage-id>`，或在 npm 网页上点）。
受信任发布者要在 npmjs.com 上配置一次：包 → Settings → Trusted publishers → GitHub Actions，
仓库 `Aeroscis/dsh-run-deck`、workflow 文件名 `publish.yml`。没配这一步，送审会失败。

`npm publish` 走的是另一条路：它是立即发布，同样要 2FA 一次性密码。账号开着 2FA 时
它会在浏览器里要求认证；`npm stage publish` 则把认证推到批准那一步，适合交给 CI 送审。

**`setup-node` 不能带 `registry-url`**。带了它会生成一份 `.npmrc`，内容是
`//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`；仓库没有这个变量时 npm 把它展开成空串，
于是先拿空 token 去认证并报 `E401`，**轮不到 OIDC**。实测过一次：
`dsh-temptask` 的首次送审就是这样失败的，去掉 `registry-url` 后同一次运行链路即通过。
`publish.yml` 里另加了一步自检：`ACTIONS_ID_TOKEN_REQUEST_URL` 为空就失败（说明 job 少了
`id-token: write`），仓库里若残留带 `_authToken` 的 `.npmrc` 会先删掉那一行。

## 13. 复用的探针

`_probe/run/` 下可直接复用（本地 scratch，**不进仓库、不进 npm 包**）：

| 文件 | 用途 |
| --- | --- |
| `sighandler.py` | 信号处理器替身（换目标项目的清理路径即可） |
| `consolechild.py` | console 所有权 / `hold_console()` / `CREATE_NEW_CONSOLE` 三合一 |
| `killprobe.js` | 派生 + 发信号 + 收标记 |
| `e2e-focus.mjs` | 焦点工作区 → 按钮组 → 跑/停 → 拖拽排序的端到端 |
| `installcheck.mjs` | desktop profile 安装自检（README §1 那 5 步逐项核对） |
| `bundlecheck.mjs` | 契约与 A/B 探针是否真的进了客户端包 |
| `windows.ps1` / `console-windows.ps1` / `watch-console-windows.ps1` | 枚举可见顶层窗口 / 只列控制台窗口 / 盯变化，查"会不会弹空 cmd 窗口" |

## 14. 源码结构

```
src/
├── host.ts           # Cordis 插件入口：name / inject / Config / apply
├── host-config.ts    # 插件配置归一化（plugin-config / settings / config.json 三级）
├── manager.ts        # 业务核心：清单加载、焦点项目、run 登记、就绪判定推进、浮动条视图
├── projects.ts       # run.json 读取、注释剥离、字段收敛、变量展开、根目录归一化
├── config.ts         # 单条 entry 的收敛 + ${…} 展开 + id 派生
├── exec.ts           # 执行通道探测（终端路线）+ 就绪 pattern 匹配
├── hooks.ts          # 就绪判定与接续（begins/endsPattern、serverReadyAction、onReady）
├── detect.ts         # 从 package.json 的 scripts 猜候选
├── newtask.ts        # 新建条目的字段校验（buildTaskEntry，与编辑共用）
├── manifest-edit.ts  # 保留注释的 run.json 最小文本编辑（新增/原位替换/删除）
├── tool.ts           # run-deck 工具的参数分发
├── commands.ts       # /run-deck 命令
├── routes.ts         # /dsh-run-deck/api/* HTTP 桥（同源围栏）
├── sessions.ts       # 会话 → cwd 的三级解析
├── store.ts          # layout.json（机器本地个人覆盖）
├── types.ts          # host/client 共享类型（零运行时依赖）
├── client.tsx        # 浮动条 + `+` 面板 + `⚙` 面板 + 诊断
├── index.ts          # 包入口（重导出 host half）
└── dsh.d.ts          # DSH 接口的最小环境声明
```

`lib/`（host 运行时 ESM）与 `client/client.js`（ModuleLoader 包）都是构建产物，不进仓库。
