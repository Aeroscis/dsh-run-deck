# dsh-run-deck — DSH Run Configuration

在输入框上方加一条浮动按钮条：点一下就跑 / 停当前工作区里声明的启动脚本。
配置写在各项目的 `.dsh/run-deck/run.json`，字段名和含义照抄 VS Code 的 `tasks.json`。

- 一个项目一份清单，跟着你切换会话自动换按钮
- 不发明新概念：`tasks[]` 数组、`inputs[]` 变量、`label`/`command`/`args` 都与 VS Code 一致
- 只管「跑一条命令」，不管编排。要串起来就在命令里用 `&&`

## 安装

```powershell
dsh plugin add @aeroscis/dsh-run-deck
```

指定 profile：

```powershell
dsh plugin --profile <profile> add @aeroscis/dsh-run-deck
```

从本地源码目录安装（改插件时边改边试）：

```powershell
dsh plugin --profile <profile> add D:/path/to/dsh-run-deck
```

装完重启 DSH。输入框上方会出现按钮条。即使当前目录还没有清单，这条也在，点 `+` 就能建第一条。

### desktop profile 手动安装

`desktop` 是 Electron 保留名，npm CLI 会拒绝针对它的插件管理请求。这种情况用应用内的插件管理界面，或按下面五步手装：

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加一条
   `"@aeroscis/dsh-run-deck": "link:/path/to/dsh-run-deck"`
2. 同一个文件的 `dsh.profile.bundles` 数组里加 `"@aeroscis/dsh-run-deck"`
3. `dsh.desktopDeselectedBundles` 里不要出现它（那是应用内手动停用的清单）
4. 在该目录跑 `pnpm install`
5. 重启应用

第 5 步之前可以用 `dsh --profile desktop --dump-config` 确认输出里有
`- id: dsh-run-deck  name: '@aeroscis/dsh-run-deck'`。

### 支持的 DSH 版本

`engines.dsh` 与 `peerDependencies` 里的 `@deepseek-ai/dsh` 都是 `^0.2.1-0 || ^0.2.2-0`。
插件市场判定读的就是这个范围。插件自己的版本号与 DSH 版本无关。

插件用到的宿主能力缺失时逐项降级，**任何一种缺失都不会让插件加载失败**：

- 没有执行通道（`subprocess`）时浮动条照常显示，⚙ 面板会明确写「宿主没有可用的执行通道」，
  而不是让你点了没反应
- 配置存放在 0.1.x 用 `settings`、0.2.0 起用 `configEditor`，两者都没有时退回
  `<pluginDataDir>/config.json`

⚙ 面板底部显示插件两半的版本（`插件后端 v…` / `插件界面 v…`）。两边不一致说明有一半还是旧的：
后端只在 DSH 启动时加载，**改插件要重启**；界面刷新页面即可。

## 用法

### 按钮条

按钮条在输入框上方那一列里，和「任务列表」「目标」「队列」同列堆叠。每颗按钮对应清单里的一条启动项：

- **点一下 = 跑**。这一条正在跑时再点 = 停
- **状态点**：琥珀色呼吸 = 正在跑；绿色 = 已就绪；红色 = 停止中
- **左侧固定钮**循环切换三档密度：完整（图标 + 任务名）/ 紧凑（图标 + 截断名）/ 图标。
  选哪档会记住
- 宽度不够时按顺序降档：完整 → 紧凑 → 图标，仍放不下的进右侧 `⋯` 溢出菜单
- 顺序就是你在 `+` 面板里拖出来的顺序

按钮条常驻。项目还没有清单时中间写「这个目录还没有启动项 · 点 + 新建第一条」；
按钮全被收起时写「全部按钮已收起 · 点 + 把要用的钉回来」，面板里还有「全部钉回来」。

### 改了清单会自动生效

改了 `.dsh/run-deck/run.json`，界面在 2.5 秒内自己更新，不用重启，也不用手动刷新。
清单被删掉或写坏时也一样会重读：按钮条隐藏，⚙ 面板里出现告警，而不是留着上一次的按钮。

### 面板

**`☰` 管理面板** —— 列出全部条目，每行右侧四件事：

- 拖动 `⋮⋮` 手柄上下调按钮顺序（只影响你自己，写在本机 `layout.json`）
- 「钉到按钮条 / 从按钮条收起」：只改这颗按钮在不在条上，条目本身保留
- 「编辑」：打开编辑面板，预填这条任务在清单里原样的字段（变量不展开、工作目录保持相对），
  改完原位替换 `run.json` 里那条，注释和排版保留
- 「删除」：真的从 `tasks[]` 里移除，连带清掉 `buttons[]` 里指向它的声明。需要再点一次确认

**`+` 新建面板** —— 先把能填的填上，省得去手改文件：

- 顶部列出候选：读当前项目 `package.json` 的 `scripts`（`pnpm: dev`、`npm: build` …），
  外加两条通用模板。点一条就填进表单并自动展开「更多设置」
- 已经在清单里的同命令条目会标「已在清单」并置灰
- 也可以复制已有条目（复制的是清单里原样的字段，`id` 不复制）
- 基础两栏：名称 + 一行命令行。`npm run dev` 会被拆成 `npm` + `["run","dev"]`
- 「更多设置」里是清单的其余字段：工作目录、环境变量、显式 `id`、`group`、`isBackground`、
  就绪正则、就绪后打开地址、跑起来自动钉住输出卡、`onReady` 接续
- 提交前逐项校验：坏正则、不存在的工作目录、非法环境变量名、撞车的 `id`、
  指向不存在条目的 `onReady`、说了要开地址却没给 URL 正则——一律拒绝写入并说明原因
- 该目录还没有 `.dsh/run-deck/run.json` 时，会连清单一起创建

标题旁的 `?` 展开面板说明。

**`⚙` 设置面板** —— 当前工作区、清单路径、配置来源、进行中的 run（状态 / pid / 退出码 /
就绪地址 / 最近 200 行输出）、清单告警、按钮密度、宿主能力、插件两半的版本。
那几行输出是「脚本为什么没起来」唯一的证据。

**`⚠ 启动失败`** —— 只在最近一次跑或停失败后出现。点它打开这条失败自己的面板，把宿主返回的
原话整段摆出来（保留换行、可选中复制），底部一颗「全部告警」通向设置面板。

**输出悬浮卡** —— 鼠标放到**正在跑**的按钮上，上方浮出小卡显示这条最近约 200 行输出，
拿开就消失。卡头有图钉：点它钉住，拿开也不消失。脚本名旁边是状态徽章，
脚本打出来的颜色会在卡里画出来。

卡头右侧那组 `A− / 当前字号 / A+` 调输出字号（9–18px，默认 11px，点中间的数字回默认）。
卡片的宽高按同一比例缩放，字大了窗口跟着变大；字号记在浏览器本地，刷新后仍在。

清单里把 `presentation.reveal` 写成 `"always"` 的条目，跑起来那一刻会自动钉住输出卡。
自动钉住的长驻条目（`isBackground`）在进程结束后自己收起；一次性命令（构建、检查）保留末次输出。
手动钉住的卡不会被自动收走。

## 配置

清单放在项目的 `.dsh/run-deck/run.json`。用 `.dsh/` 而不是 `.vscode/`：借了词汇表，
但不冒充 VS Code 能读它，两边支持的 `type` 不一样。旧位置 `.dsh/run.json` 仍会被读取并告警。

支持 JSON with comments（`//` 与 `/* */`，字符串内部除外）。

```jsonc
{
  "version": "0.1",
  "tasks": [
    {
      "label": "web",              // 人读的标题，可重名
      "id": "app/web",             // 跨条目唯一；不给就按 label 派生
      "command": "npm",
      "args": ["run", "dev"],
      "options": { "cwd": "${workspaceFolder}", "env": { "PORT": "5180" } },
      "isBackground": true,
      "problemMatcher": {
        "background": {
          "beginsPattern": "VITE",
          "endsPattern": "Local:\\s+(http://\\S+)"
        }
      },
      "serverReadyAction": { "action": "openExternally", "pattern": "(http://\\S+)" },
      "presentation": { "reveal": "always" }
    }
  ],
  "inputs": [
    { "id": "mode", "type": "pickString", "options": ["dev", "release"], "default": "dev" }
  ],
  "buttons": [
    { "entry": "app/web", "label": "web", "icon": "eye", "order": 1 }
  ]
}
```

### 字段

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `version` | —— | 清单版本；不认识不报错，只告警 |
| `inputs[]` | —— | `${input:id}` 的取值来源，实现 `pickString` 与 `promptString` |
| `tasks[].label` | **必填** | 人读的标题，可重名 |
| `tasks[].id` | 由 label 派生 | 跨条目唯一；重复时自动追加后缀 |
| `tasks[].type` | `shell` | 目前只实现 `shell` |
| `tasks[].command` | **必填** | 必须是清单里的字面量 |
| `tasks[].args` | `[]` | 参数；整体不是字符串数组时忽略该字段并告警 |
| `tasks[].options.cwd` | `${workspaceFolder}` | 工作目录 |
| `tasks[].options.env` | —— | 额外环境变量，与宿主环境叠加（同名覆盖），值里可含 `${env:NAME}` |
| `tasks[].isBackground` | `false` | 长驻只是「跑完不退出」 |
| `tasks[].problemMatcher.background` | —— | `activeOnStart` / `beginsPattern` / `endsPattern` |
| `tasks[].serverReadyAction` | —— | 只实现 `{ action: 'openExternally', pattern, uriFormat }` |
| `tasks[].presentation` | —— | `panel` / `reveal` / `clear`；只有 `reveal` 有对应效果 |
| `tasks[].group` | `none` | `build` / `test` / `none` |
| `tasks[].runOptions.runOn` | —— | 只认 `"folderOpen"`：宿主启动后自动跑这一条。其它值忽略并告警 |
| `tasks[].onReady` | —— | 就绪后接另一个条目的 `id`，不接受命令 |
| `buttons[]` | —— | 钉到按钮条：`entry` + `icon` + `group` + `label` + `order` |

变量只支持三个：`${input:id}`、`${workspaceFolder}`、`${env:NAME}`。未知变量原样留下，
让人看得出这里本该有值。

不写 `buttons[]` 时，清单里的全部条目默认都上条。

### 需要现场填值的条目

`promptString` 没有 `default` 时，每次点跑都会先弹一个填值面板（每个 input 一栏，
`description` 是说明文字），填好才真的起进程。命令行或 agent 调用则必须带上值，缺了会拒绝并说明缺哪个。

`promptString` 有 `default` 时直接用默认值，不弹面板。

这样的条目**不会被 `runOn: "folderOpen"` 自动跑**——自动运行给不了现场填值，插件会跳过并在日志里说明。

### 就绪判定

`endsPattern` 匹配到就认为服务起来了，可以接着执行 `serverReadyAction`（把地址交给浏览器打开）
和 `onReady`（接另一个条目）。

写 pattern 时注意：**脚本有几种"成功"说法，pattern 就要覆盖几种**。例如某个脚本在端口上已经有服务时
会打印「already running at …」并立刻退出，pattern 只写「ready at …」的话，这一支既不算就绪也不开浏览器，
表现就是点一下闪没了。

`onReady` 的效果是「点一个按钮，却跑起来两条」。⚙ 面板里会把它显示成 `→ <id>（onReady）`，
免得被当成故障。

## 命令与 agent 调用

```text
/run-deck list            列出全部条目（id / 命令 / 目录）+ 进行中的 run
/run-deck run <id>        跑一个条目
/run-deck stop <runId>    停掉一个 run
/run-deck rerun <runId>   停掉旧的再开新的
/run-deck path            显示各项目的清单落点
/run-deck help            帮助
```

`id` 里可以带 `/`（例如 `jin/web`）。`label` 只在唯一时接受，重名会提示改用 `id`。

模型侧有一个 `run-deck` 工具，与面板、命令走同一套逻辑：

| action | 参数 | 作用 |
| --- | --- | --- |
| `run` | `entry_id`（+ `input_values?`） | 按 id 发起。`input_values` 是 `${input:id}` 的本次取值 |
| `stop` | `run_id` | 停掉一个 run |
| `rerun` | `run_id` | 停掉旧的再开新的 |
| `create` | `label` + `command`（+ `project_root?` / `is_background?` / `ready_pattern?`） | 加一个启动按钮，与 `+` 面板同一条链路，按钮 3 秒内出现 |

所以你可以直接对 agent 说「帮我加一个跑 npm run dev 的按钮」，它会调用这个工具把条目写进
项目的 `run.json`。直接手改 `run.json` 同样有效。

`run` / `stop` / `rerun` 只接受 `id`，不接受命令。`entry_id` 里出现 `npm run dev` 这类命令形态
一律按「未知 id」拒绝，不会退回去按 `label` 匹配。

没有快捷键：当前 DSH 版本不提供可注册的键位服务。入口是浮动条、命令、工具三处。

## 数据存在哪

| 内容 | 位置 | 是否进仓库 |
| --- | --- | --- |
| 这个项目有哪些启动项 | 项目里的 `.dsh/run-deck/run.json` | 是，与项目一起提交 |
| 我怎么看它（顺序、显隐、图标、分组、密度） | `<pluginDataDir>/layout.json` | 否，本机私有 |

`run.json` 是「这个项目有什么」，`layout.json` 是「我怎么看它」。删掉 `layout.json` 一切照常，
按钮条退回 `run.json` 的原始声明。后者**只影响展示**，没有任何字段能改 `command` / `args` / `cwd`。

## 安全边界

插件启动的进程不受 agent 的 shell 沙箱约束，所以边界是硬性的：

1. **命令必须是 `run.json` 里的字面量**，不会是扫描目录发现的可执行文件
2. **没有任何接口接受自由命令**。HTTP 接口只接受 `{projectRoot, entryId}` 这类指针，
   命令本体永远来自项目里的清单
3. **界面不会变成「无确认执行任意脚本」的通路**。删除这类破坏性操作要在面板里再确认一次

`create` 是唯一接受自由文本的动作，但它写的是**清单**而不是执行：字段逐项校验后才写入，
产出的条目与手写进 `run.json` 的一条完全等价。执行仍然只认清单里的字面量。

## 已知限制

- **只实现 `type: shell`**。VS Code 的 `process` 类型要 argv 数组，本插件不做
- **不支持 `dependsOn` / `steps`**。需要编排就在命令里用 `&&`
- **`presentation` 里只有 `reveal` 有对应效果**。`panel`、`clear` 收下字段但不生效——
  输出本来就是每条 run 独立、开跑即新
- **没有快捷键**，因为 DSH 当前版本没有可注册的键位服务
- **没有执行通道时按钮跑不起来**。⚙ 面板会说明，而不是静默失败
- **无默认值的 `promptString` 条目不会被启动自动跑**（自动运行无法交互）
- **就绪判定依赖脚本输出**。脚本什么都不打印时只能靠进程退出判断，长驻服务会一直显示「正在跑」而不会变绿
- **输出只保留最近约 200 行**。更早的内容要看脚本自己的日志文件
- **停止后仍要确认端口是否释放**。停止时插件按一路累积的后代记录终止整棵进程树；
  中间进程若已重新挂父，可能漏杀，表现为端口仍被占用。重启 DSH 会清理它自己管的进程树

## 排错

| 现象 | 先看这里 |
| --- | --- |
| 按钮条完全不出现 | 当前目录有没有 `.dsh/run-deck/run.json`；⚙ 面板里的「当前工作区」是不是你以为的那个目录 |
| 之前有按钮，重启 DSH 后没了 | 切到该会话后等一轮轮询（2.5 秒）；还不行就看 ⚙ 里的清单路径与告警 |
| 按钮全不见了 | 是被收起了，不是丢了：`+` 面板里点「全部钉回来」 |
| 点按钮没反应 | ⚙ 面板看「执行通道」是否可用；再看有没有 `⚠ 启动失败` 标记 |
| 启动失败 | 点 `⚠ 启动失败`，那里有宿主返回的原话；再看这条的最近 200 行输出 |
| 改了 `run.json`，界面还是旧的 | 等 2.5 秒自动重读。改了插件本身则要重启 DSH（后端）或刷新页面（界面） |
| 界面和后端版本不一致 | ⚙ 面板底部两行版本；重启 DSH |
| 服务起来了但浏览器没打开 | 检查 `serverReadyAction` 的 `pattern` 是否匹配到实际输出；地址只打开一次 |
| 停了之后端口还被占 | 先看 ⚙ 里那个 run 的状态与退出码，确认它是否真的退出；仍有残留就重启 DSH 清理 |
| 输出卡里没有内容 | 悬浮卡只对**正在跑**的条目出现；已退出的一次性命令保留末次输出，长驻条目退出后自动收起 |

更多诊断细节（日志逐行的含义、几何量测、层叠问题）见
[`docs/DESIGN.md`](docs/DESIGN.md)——内部设计文档，与使用无关。

## 开发

```powershell
npm install
npm run check      # 类型检查 + 构建 + 发布形态自检 + 两半快速回归 + 挂载契约 + 兼容规则测试
npm run compat     # 比对宿主接口与 dsh-baseline.json 里记录的参照版本
```

实现细节、为什么走 PTY 而不是后台任务、被否决的方案、测试与发版流程，都在
[`docs/DESIGN.md`](docs/DESIGN.md)。版本变更见 [`CHANGELOG.md`](CHANGELOG.md)。

## 分支与发版

日常开发在 `develop` 分支进行，不直接向 `main` 提交。

- `develop`：开发分支。所有改动先提交到这里。
- `main`：发版分支。只接受从 `develop` 合并过来的提交，tag 只在 `main` 上打。
- 发版步骤：把 `develop` 合并到 `main`，在 `main` 上打 tag，然后推送 `main` 与 tag。

## 许可

MIT
