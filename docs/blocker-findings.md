# 阻塞项测试结论（第 1 步）

日期：2026-10-10
方法：`_probe/run/` 下的三个探针（node 侧 runner + python 侧替身），
python 替身与 `start_gallery_web.py` / `scripts/start_common.py` 装上同三个
处理器（`SIGINT` / `SIGTERM` / `SIGBREAK`），清理路径就是 `taskkill /F /T`。
探针替身 Spawn 完毕后每步都写 JSONL 到 `_probe/out/*.jsonl`,「处理器到底
有没有跑」以标记文件为准，不靠观察。

## 结论 1：信号到不了处理器（job 路线否決）

| 探针 | 发出的信号 | Python 退出 | `handler` 事件 | `taskkill /T` | 孙进程 |
|---|---|---|---|---|---|
| `sigterm-plain` | SIGTERM（node `process.kill`） | exit 1，约 2ms | **未运行** | **未执行** | 被孤立（已消） |
| `sigbreak` | SIGBREAK（node `child.kill('SIGBREAK')`） | SIGKILL，约 3ms | **未运行** | **未执行** | — |
| `sigint-test` | SIGTERM | exit 1，约 3ms | **未运行** | **未执行** | 被孤立（已消） |

三个信号**没有一个**让 Python 的处理器跑起来，也就没有一个触发
`taskkill /T`。Windows 上只有「控制台为进程生成 Ctrl+C / Ctrl+Break」
才会把 `CTRL_C_EVENT` / `CTRL_BREAK_EVENT` 送给处理器；`GenerateConsoleCtrlEvent`
的一个隐含前提是**调用者自己挂了控制台**。而 job（`detached: true` + `stdio:'ignore'`）
的背景进程 `GetConsoleProcessList() == 0`——`console_process_count: 0`
这一条实测数据就是证据：它没有控制台可挂。所以
`process.kill(pid, SIGTERM)` / `child.kill('SIGBREAK')` 在这种进程上只等于
`TerminateProcess`，**不是**上面说的那个信号模型。

> 附带影响：`start_common.py` 用 `CREATE_NEW_PROCESS_GROUP` + `taskkill /T`
> 清理孙进程树，前提就是信号能到。job 路线把这条链的起点掐了，正是这些脚本
> 用几百行要避免的失败。

判定：**信号到不了 → 不走 job。**

## 结论 2：`_owns_console()` 合理，`hold_console()` 不会挂住

| 场景 | `console_process_count` | `_owns_console()` | `stdin.isatty()` | `hold_console()` |
|---|---|---|---|---|
| node job 派生（`stdio:'ignore'`） | **0** | **False** | True（管道/tty 混合） | 立即返回，`EOFError` |
| pwsh job 派生（管道） | 2 | False | False | 立即返回，`EOFError` |

`hold_console()` 没有让进程挂住：两种派生方式下 `input()` 都是立刻
`EOFError` 返回，没有一次进入 3 秒超时前的阻塞（`blocked: false`，
`elapsed` 只走到记录点）。这与 `_owns_console()` 的注释一致：宁可不暂停，
也不要在没人看的终端里挂住。

判定：console 检测与 `hold_console()` 在 job 环境下**行为正确且无害**。
唯一的损耗是"双击启动那种一闪而过的报错"这个便利——job 本来就没有窗口要留。

## 结论 3：`CREATE_NEW_CONSOLE` 仍可用，但需另建停止通道

`probe_new_console_child()` 实测（parent 自身 `console_process_count == 0`）：

- 用 `CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP`（flags = 528）起来孙子进程
  **成功**（`spawned: true`）、**存活**（`alive_after_wait: true`）；
- 它拿到的是**自己的**控制台，父进程有没有控制台不影响它；
- `taskkill /T /PID` 这次是 `returncode: 1` + "拒绝访问",而同样的 python 在
  三次复测里都是要么干净退出、要么被杀掉——本探针会话里的 taskkill 结果
  不可信（pwsh 沙箱把 `taskkill` 当受管进程拦了，`node spawn taskkill` 则 EPERM）。

所以这一条只能确定"起来没问题"，**不能**在本环境内证明"停得干净"。
把这条留给第 3 步（事件钩子）验证，不停在第 1 步。

cteno 被排除的第三条硬伤（`start_debug.py` 的 `CREATE_NEW_CONSOLE` 起进程且
不保存 handle、没有 PID）跟这里的结论一致：**没有 PID 就没有停止**，
与其猜，本轮先排除。

## 路线选择：走终端

三条里第一条是决定性的（信号到不了 = 进程树清理这条链断了），
另两条只描述环境、不改变方向。选定：

**插件 spawn 的进程一律包在 DSH 终端里（`dsh-terminal` / node-pty，真控制台、
真 Ctrl+C），由终端把 `CTRL_C_EVENT` / `CTRL_BREAK_EVENT` 送到进程组，
处理器于是能跑到 `taskkill /T`。**

按钮语义随之定死：**「给这个项目开一个终端标签跑它的启动脚本」**。
「跑」= 在终端里起命令；「停」= 关掉这个终端标签；「重跑」= 停掉再开。

分工：

- 终端负责"能不能干净停下"（本步结论）；
- 就绪判定仍然以 `stdout` pattern 为主（`problemMatcher.background` +
  `serverReadyAction`），端口探测只做兜底——理由见下方限制。

## 需要写进插件的两条限制

1. **不扫目录发现可执行文件**。host half spawn 的进程绕过 agent 的 pwsh 沙箱，
   所以 `command` / `args` 必须是 `run.json` 里的字面量。
2. **按钮 = 策展视图 + 入口，不是执行通路**。UI 不得变成"无确认执行任意脚本"
   的通路；破坏性操作要 confirm。

## 复用探针

- `_probe/run/sighandler.py` — 信号处理器替身（换目标项目可直接复用）
- `_probe/run/consolechild.py` — console/hold_console/CREATE_NEW_CONSOLE 三合一
- `_probe/run/killprobe.js` — 派生 + 发信号 + 收标记
- `_probe/out/*.jsonl` — 原始证据
