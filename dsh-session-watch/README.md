# @local/dsh-session-watch — 发现静默停摆的会话

一个 **DSH 插件**（Host 半 + Client 半 + 专家工具半）：扫描本机**所有**会话，找出那些在轮次中途**静默停摆**的对话，
在侧边栏给出角标，可用 `/watch` 列出详情，并可由一个**用户代理专家**（agent preset）深读任意会话的输入输出、
定位根因并按闸门续跑。

它解决的是一个具体的时间损失：并发跑很多会话时，某个会话会莫名停住，而你不会立刻发现。

## 三层结构

| 层 | 是什么 | 在哪儿 | 默认 |
|---|---|---|---|
| **1 发现** | 确定性规则判定，不调模型 | `lib/detect.js` + Host 半 | 常开 |
| **2 恢复** | 全否决闸门 + 次数上限 + 递增退避 + 持久账本 | `lib/resume.js` + `lib/plugin.js` | **关闭** |
| **3 专家** | 用户代理 preset：读全部会话、给根因、按闸门续跑 | `lib/proxy.js` + `dsh-user-proxy` bundle | 需显式选用该 preset |

## 它要解决的问题（有实测依据）

先纠正一个前提：**这些会话不是"报错死掉"的。** 解压本机 125 个真实会话日志后统计：

| 现象 | 实测结果 |
|------|----------|
| `error` / `agent/error` 事件 | **0 个** |
| 唯一的"异常"事件 | 36 条 `llm/retry`（限流/传输层，已自动重试成功） |
| 真实故障形态 | 日志**停在轮次中途**，最后一条是 `step/start` 或 `tool/call`，**没有 `turn/end`** |

也就是说：**工作内容一条都没丢，停掉的是驱动器（driver）**。这正是发一句「继续」就能恢复的原因——
而代价是你必须**注意到**它停了。并发一多就注意不过来，这就是损失所在。

因此检测不能依赖"有没有报错"，只能依赖**日志是否还在推进**。

## 判定规则（确定性，不调用模型）

判定逻辑全部在 `lib/detect.js`，**没有模型参与决策**。这是刻意的：让模型去猜"这个会话是不是在等我"，
两种错法都有害——

- 误判为停摆 → 自动给一个正在等你审批的会话发「继续」，等于替你回答了问题；
- 误判为等待 → 真正死掉的会话被放过，你又回到"看不过来"的原点。

所以判定完全基于日志里已经落盘的事件，且**所有"不要碰"的判定都排在 `stalled` 前面**：

| 判定 | 含义 | 会自动恢复吗 |
|------|------|--------------|
| `stalled` | 状态为 running 但日志不再推进，或轮次中途停止且没有 `turn/end` | **是**（唯一一种） |
| `awaiting-approval` | 停在等待审批／等待用户回答的事件上 | 否 |
| `aborted-by-user` | 用户主动中止的轮次 | 否 |
| `empty` | 只有初始化事件，从未开始任何工作（已放弃的空会话） | 否 |
| `subagent` | subagent 子会话，由父会话负责收敛 | 否 |
| `idle` | 轮次已正常结束 | 否 |
| `too-young` | 会话刚开始，还没到能判定的时间 | 否 |
| `unreadable` | 日志读不出来 | 否 |

### ⚠ 两处已修复的严重缺陷（都由真实运行暴露，不是推演出来的）

#### 缺陷一：审批闸门曾经是失效的

**发现的经过**：在写第 3 层专家工具的测试时，我用「会话停在审批事件上」造了一个 fixture，
期望判定为 `awaiting-approval` —— 结果得到 `stalled`。

**根因**：`AWAITING_TYPES` 最初的写法是照着上游**类型名**写的，里面有 `approval/request`、
`user/question`、`plan/proposal`。我随后把本机 **178 个真实日志的全部事件类型**枚举了一遍：

| 探针 | 真实命中 |
|---|---|
| `approval/request` | **0**（本机从不发出这个事件名） |
| `user/question` | **0** |
| `plan/proposal` | **0** |
| **`approval/asked`** | **10 个会话**（这才是真实的审批请求事件名） |
| `approval/decided` | 10 个会话 |
| `approval/policy` / `permission/preset` / `sandbox/mode` | 178 / 170 / 178（多数属会话初始化） |

**后果有多严重**：闸门对它最重要的场景**从未生效**过。一个停在审批上的会话会被判成 `stalled`，
而 `stalled` 是唯一可自动恢复的判定 —— 也就是说**一旦开启自动恢复，插件就会往一个正在等你批准工具的
会话里发「继续」，等于替你按了确认**。这正是这个闸门存在的唯一理由。

**为什么原有测试没抓住它**：`detect.test.mjs` 和 `resume-wiring.mjs` 里的 fixture 用的也是
`approval/request` —— 和代码错得一模一样。**测试和实现出自同一个错误假设时，测试只会证明代码自洽，
不会证明它正确。**

**修复**：`AWAITING_TYPES` 改为真实事件名 `approval/asked`（保留那三个设置类事件，因为它们**落在当前轮
尾部**时同样代表等待，而误判为等待只是"不动作"，安全方向）；并新增一类识别 ——
**未被回答的 `ask_user_question` / `exit_plan_mode` 工具调用**。这类等待没有专属事件类型，
证据是**缺失**的 `tool/result`，所以只能从调用本身识别。本机日志里 `ask_user_question` 被调用 40 次，
是真实路径而非假设。

#### 缺陷二：每一次恢复其实都在抛错

**发现的经过**：开启自动恢复后，账本立刻记下一条失败：

```json
{ "ok": false, "error": "Cannot read properties of undefined (reading 'throwIfAborted')" }
```

**根因**：`sessionController.prompt` 有**两层**，签名不同 ——

```js
// 内层（文档描述的就是这个，不需要 signal）
async prompt(request) { ... }

// 外层（插件实际调用的是这个，第一行就要用 signal）
prompt(request, signal) {
  signal.throwIfAborted();      // ← signal 为 undefined 时在这里就抛了
  return this.commands.prompt(request)
}
```

原实现只传了 `request`。**所以此前每一次自动恢复都在真正开始之前就失败了** ——
而 `plugin-smoke` / `resume-wiring` 的 stub 写成 `async prompt(request)`（跟着内层签名走），
于是 stub 欣然接受了一个真实环境会拒绝的调用。

**修复**：始终传入 `AbortSignal`，并给它一个 30 秒超时 —— 一个专门用于发现停摆的插件，
自己绝不能在恢复时挂住。

**这条也已写成断言**：两个套件的 stub 现在都**模拟真实的双层形状**
（`prompt(request, signal){ signal.throwIfAborted(); ... }`），
并断言 `typeof call.signal.throwIfAborted === 'function'`。
缺 signal 的调用在这两个套件里**不可能再通过**。

> **这两条合起来的教训**：**fixture 必须来自观测到的真实数据，而不是来自代码期望的形状。**
> 两个缺陷都是"实现和测试共享同一个错误假设"，因此测试全绿而功能全坏。

三个关键实现细节，每一个都是从**真实误判**里学到的：

1. **轮次级扫描，而不是看最后一条事件。** 长会话里有很多已闭合的轮次；早期轮次的
   `turn/end {aborted}` 绝不能用来描述**当前**这个还开着的轮次。做法是找到最新的 `turn/start`，
   再问同一轮号后面有没有 `turn/end`。
2. **闭合的轮次就是已完成的工作，无论后面跟了什么。** 真实日志会在 `turn/end` 之后追加收尾事件
   （`session/end-seed`、`model/selection`、`/compact`、`/export` 的 `command/run`+`command/done`）。
   任何"按事件名列表跳过"的写法都会误读最后落地的那个事件。
3. **截断日志时必须保留当前轮的 `turn/start`。** 一轮可能跨越上千个事件；用固定长度的尾部窗口
   会把它截掉，导致**已闭合的轮次看起来还开着**——这个 bug 曾把 13 个已完成的会话误报为停摆。

## 第 3 层：用户代理专家（agent preset）

### 它是什么

一个 **agent preset**（`user-proxy`，「用户代理」），它的身份就是「用户的常驻代理」：
盯住本机所有会话，出问题时读出那个会话的真实输入输出，给出根因，并按闸门决定是否续跑。

它由**独立的 bundle** 提供，装在 `C:\agent\dsh\plugin\dsh-user-proxy`：

```
dsh-user-proxy/
  package.json        # @local/dsh-user-proxy，dsh.bundle.patch -> ./cordis.patch.yml
  cordis.patch.yml    # 声明 preset-user-proxy
```

`cordis.patch.yml` 的 `plugins:` 列表 = **`standard` preset 的完整工具集**，**追加一行**：

```yaml
- id: session-watch-proxy
  name: '@local/dsh-session-watch/proxy'
```

### 三个工具

| 工具 | 作用 | 读写 |
|---|---|---|
| `session_roster` | 全机会话清单：判定、位置、静默时长、**以及为什么不会被恢复** | 只读 |
| `session_review` | 深读一个会话：用户消息、助手回复、工具调用与结果、重试与错误，外加确定性的停止归因 | 只读 |
| `session_resume` | 续跑一个会话 —— **本插件里唯一会改变状态的动作** | 写 |

纪律（与前两层一致）：

1. **判定仍是确定性规则。** 工具只**呈现事实**，解释留给模型。不把"是不是停摆"交给模型猜。
2. **读写分离。** 两个工具纯只读；写动作只有一个，且在名字和描述里都写明。
3. **每个动作可观测。** 专家发起的续跑与自动续跑**共用同一个账本**，所以侧边栏与 `/watch` 都能看到。
4. **策略以 Host 为准。** 专家的判定口径与恢复闸门都从 Host 快照读取，
   所以面板、`/watch`、专家三处**永远说同一套策略**（见下）。
5. **降级要说话，不能抛错。** 读不到数据时返回"读不到 + 原因 + 下一步"，
   **绝不返回空结果装作一切正常**，也绝不把异常抛给模型。

### 关于第 4 条：为什么专家不信任自己的配置

专家半挂在 **preset 的行**里，那行**没有 `config`**；而 Host 半挂在
`~/.dsh/cordis.patch.yml`，带着 `stallMs`、`resume` 等设置。两半天然各有一套值。

如果不处理，会出现两个后果——第二个是**主动误导**：

1. 专家认为"5 分钟没动静就是停摆"，Host 认为 15 分钟，**专家对自己的判定口径和面板不一致**；
2. **即使用户已经打开自动恢复，专家仍以 `disabled` 为由拒绝每次恢复**，因为它看不到那个开关。
   于是面板说"已启用"、专家说"未启用"——而 `disabled` 对专家自己那份过期副本是真的，**对部署是假的**。

所以专家的策略**每次调用时从 Host 快照现读**（Host 本来就是策略的唯一真源），
用户改配置（热更新）后专家立刻跟随。行自己的 `config` 仍然生效，只是被快照里的值覆盖。

### 关于第 5 条：读不到 ≠ 没问题

`session_roster` 是专家**第一个**调用的工具。如果它在 Host 不可达时抛错，
专家会拿到一个无法推理的不透明失败，也分不清"Host 在重启""插件坏了"还是"确实没问题"。
所以它返回明确的结构化失败，并附一句警告：**不要把空结果当成一切正常**。

一个坏掉的监视器假装健康，比没有监视器更糟——这条原则从第 1 层的面板一直贯穿到专家的工具。

### 为什么跨工作区能读到全部会话

原设想担心"专家会被限制在自己工作目录内"。实测结论：**这个担心对这条路不成立**，理由有三条 ——

1. `ctx.sessionQuery` 的 README 原文：*"**No caller authorization** — this is trusted
   context-wide infrastructure; a model tool or UI must constrain which sessions its caller may inspect."*
2. `sessionController` 的实现里**没有授权逻辑**：`list()` 返回除 `cwd` 缺失外的**全部**会话，
   请求类型不携带调用方身份（源码里那个 `authorized` 是**结果预算名，不是 ACL**）。
3. 随产品附带的那个 `session_query` **工具**（其授权确实按调用方会话）在本机构建里
   **根本没安装** —— 全 asar 搜索 0 命中。原会话里那句"它授权按调用方"的出处是自己源码里的一段**注释**，
   不是本机实际存在的工具。

所以专家读的是 **Host 侧服务**，不做工作区过滤。

### 工具是怎么只给这个专家的

**不需要任何运行时判断。** 一个 preset 行在自己的**作用域**里 `apply`，
因此它 `ctx.tools.register()` 出来的工具天然只对该 preset 组合出的 agent 可见
（`dsh-scope` 的 `ScopedLayers`：注册时所在的上下文决定可见性与生命周期）。

对照 `@deepseek-ai/dsh-experimental-tool-agent-team`（就是用户说的 "agent team" 那个）：
它的做法是 Host 插件监听 `agent/created`，再往 `agent.ctx.tools.register()` 注入。
**我们把工具行直接放进 preset，省掉了整个运行时判定。**

**权限边界**：`session_roster`/`session_review` 能读全机**所有**会话的对话正文。
这是刻意的（读不到就无法诊断），但它是真实的权限扩张，所以**只挂给 `user-proxy`，不挂给 `standard`**；
`preset-drift.mjs` 里有一条断言专门锁住这一点。

### 怎么用它

新会话创建时选择 **「User Proxy」** 这个 preset 即可。

> **重要**：preset 在会话**开第一个轮次前**锁定，之后不能改；已存在的会话保留它创建时的 preset 修订。
> 所以要看新 preset 的效果，**必须开一个新会话**。

### 两半为什么共用 `lib/ledger.js` 而不是互相 import

账本原本在 `plugin.js` 里，专家半直接 `import` 它 —— 这个耦合踩过一个很难诊断的坑：

loader 按插件名**缓存模块**。当专家半 import 了 `plugin.js` **新加的**导出时，
一个仍持有旧 `plugin.js` 的进程会让这条 import **在加载期就抛错**：

```
SyntaxError: The requested module './plugin.js' does not provide an export named 'readLedger'
```

**缺失导出是加载期错误**，所以**整个专家半**（三个工具，含两个纯只读的）全部挂载失败，
而报错信息里完全看不出"需要重启"。

所以账本抽成了 `lib/ledger.js`，两半各自引用它，**专家半不再静态依赖 Host 半**；
唯一真正需要的 `resumeSession` 改成**惰性 `import()`**，
于是即使它不可用，也只影响那一个写工具并**明确报错**，而不是把只读工具一起拖死。

三条断言锁住这一点（`proxy-apply.test.mjs`）：专家半不得静态 import Host 半、
Host 半仍须 re-export 账本 API、两半必须读**同一个**账本
（两个计数器会让会话仅仅因为"换了个人来问"就突破自己的上限）。

### 为什么是复制而不是继承

preset 的 `plugins` 是**整表替换**，Loader 从不对 `config` 做深合并 —— 没有"在 standard 基础上加一行"这种写法。
所以 `dsh-user-proxy/cordis.patch.yml` 里的列表是 `standard` 的**逐行副本**加一行。

副本会腐坏：上游改了 `standard`，这里不会跟随，专家就会悄悄少一个工具。
所以有 **`test/preset-drift.mjs`** —— 它**直接从 app.asar 里读**当前部署的 `standard.patch.yml`，
与我们的列表逐行对账，差异即失败：

```
node test/preset-drift.mjs
  PASS  每个 standard 的行都在 user-proxy 里
  PASS  user-proxy 恰好只多一行
  PASS  多出的那一行指向本包的 proxy 半
  PASS  proxy 半确实被 package.json 导出
  PASS  preset 没有把代理工具给 standard 会话
  PASS  persona 确实指示专家去用这些工具
  PASS  persona 要求先读证据再下结论
  PASS  persona 要求把"拒绝"当决定报告，而不是绕过
  PASS  persona 禁止把读不到说成"一切正常"
```

它对账的是**实际部署的** `standard`，不是仓库里的快照 —— 快照自己也会过期。

### persona 不是装饰，是被测的

`persona` 里那段话是**功能性**的，不是文案：没有它，这个 preset 只是一个
"碰巧多带三个工具、并且不知道它们存在"的 `standard` 会话。所以 `preset-drift.mjs`
把四条要求写成了断言：

1. 三个工具名都出现在 persona 里；
2. **先读证据再下结论**（"读它，再说它为什么停了"）——防止专家凭判定猜根因；
3. **把闸门的拒绝当作决定来报告，而不是绕过** ——
   一个被模型当成"障碍"的闸门，就不是闸门；
4. **禁止把读不到说成"一切正常"** —— 与第 1 层面板同一条原则。

## 界面

| 入口 | 说明 |
|------|------|
| **侧边栏「👁 会话监视」按钮** | 有停摆时变成「⏳ N 个会话静默停摆」并高亮。点一下展开面板，列出每个停摆会话的目录、`turn`/`step` 位置、最后事件、静默时长。无停摆时为中性灰色。 |
| `/watch` | 在对话框里输入，输出同样的列表。`/watch json` 输出原始快照。 |
| `GET /session-watch/api/state` | 脚本用；`POST /session-watch/api/refresh` 强制重扫。两者都要求 `x-session-watch: 1` 请求头，且只监听 loopback。 |
| `GET /session-watch/api/diagnostics` | **自检**：报告 Host 半看到的服务、proxy 半能否解析、以及它贡献哪些工具名。只读。 |

面板数据全部来自 Host 的 `/state`，Client 半不自己判断，所以界面与判定**不可能各自漂移**。

**读取失败时不会伪装成"一切正常"**：fetch 出错时按钮标题会显示错误原因，而不是显示零停摆。
一个坏掉的监视器假装自己健康，比没有监视器更糟。

## 目录与安装形态

| 位置 | 内容 |
|------|------|
| `lib/detect.js` | 纯判定逻辑：`classifySession`、`isIntentionalEnd`、`AWAITING_TYPES`、`AUTO_RESUMABLE` |
| `lib/resume.js` | 纯恢复策略：`decideResume`（全部否决闸门）、`backoffFor`、`buildNudgeText` |
| `lib/logs.js` | 读日志：zstd 多帧解压、JSONL 解析、会话发现、有界截断 |
| `lib/transcript.js` | 把原始事件转成人可读的会话转写 + 停止归因（专家读它） |
| `lib/plugin.js` | Host 半：后台扫描 + 缓存、恢复执行与账本、`/watch`、HTTP 路由（含 `/diagnostics`）、`sessionWatch` 服务 |
| `lib/proxy.js` | 专家工具半：`session_roster` / `session_review` / `session_resume` |
| `lib/shared.js` | 两半之间的快照信箱，保证面板与专家看到同一份判定 |
| `lib/client.js` | Client 半：`sidebar.footer.action` 的角标与面板（手写 `window.__ModuleLoader__` bundle，**无构建步骤**） |
| `~/.dsh/session-watch.json` | 自动恢复账本（原子写入）。**自动恢复与专家共用它** |
| `test/*.mjs` | 全部测试（无需构建、无需 GUI） |

### 安装

**Host 半**（这个包）用 junction + patch 行：

```powershell
$src = 'C:\agent\dsh\plugin\dsh-session-watch'
foreach ($dir in @("$env:USERPROFILE\.dsh\profiles\node_modules\@local",
                   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local")) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if (-not (Test-Path "$dir\dsh-session-watch")) {
    New-Item -ItemType Junction -Path "$dir\dsh-session-watch" -Target $src | Out-Null
  }
}
# 再把这一行写进 $env:USERPROFILE\.dsh\cordis.patch.yml 的 insert 列表：
#   - id: session-watch
#     name: '@local/dsh-session-watch'
# 然后重启应用（插件行的增删不会热生效）
```

**专家半**（`dsh-user-proxy` bundle）用**官方安装通道**，不需要手写任何东西，也不需要重启：

```powershell
# 用 plugin_manager 工具：
#   action: install_bundle
#   target: C:\agent\dsh\plugin\dsh-user-proxy
```

它会自己跑 pnpm、把包列进 profile 的 `dsh.profile.bundles`、并把插件行热挂进运行中的组合
（结果里的 `application: applied` 表示已生效）。**这条路比手写 junction + patch 可靠得多**——
本项目前面两次误诊都源于手写安装。

**验证装好了**：

```powershell
# Host 半自检：应当返回 200 + JSON
curl.exe -H "x-session-watch: 1" http://127.0.0.1:19387/session-watch/api/diagnostics

# 组合树里应当出现 preset-user-proxy 与 session-watch-proxy 行
# （用 --dump-config；注意 desktop profile 由应用独占，需先复制一份 profile 再 dump）
```

### 插件行必须写在你**实际运行的那个 profile** 里

这是本项目踩过的最大的坑，值得单独说明。

`$DSH_HOME/profiles/` 下可以有多个 profile（本机就有 `web` 和 `desktop` 两个）。
**profile 是启动时的 `--profile` 参数决定的**，每个 profile 有自己的 `cordis.patch.yml`。
在 A profile 里注册的插件，对 B profile 上跑着的 GUI **完全无效**。

本机 `127.0.0.1:19387` 这个 GUI 跑的是 **`web`** profile，所以插件行必须同时存在于：

```
~/.dsh/profiles/web/cordis.patch.yml        ← 19387 的 GUI 读这个
~/.dsh/profiles/desktop/cordis.patch.yml    ← 桌面窗口读这个
```

两个都写上，才不会"在某个入口好用、在另一个入口 404"。

**配置层级的读取顺序**（来自 `dsh-app-boot` 的实际实现）：

```
bundles 各自的 patch  →  profile 自己的 cordis.patch.yml  →  ~/.dsh/cordis.patch.yml  →  --patch 覆盖
```

`~/.dsh/cordis.patch.yml`（home 级）**确实会被读**，且优先级最高，所以把行放这里可以让所有 profile 共享。
但要注意：**它只在启动时读一次**。

### 增删插件行必须重启

我核对了应用内的实际代码，有两点需要纠正一个常见误解：

- **没有文件监听。** `dsh-app-boot` 里 `watch` 出现 **0 次**——`cordis.patch.yml` 是**启动时读一次**，
  之后用编辑器改它**不会**生效。
- **`patchReload` 这个字段在应用里根本不存在**（全量搜索 0 次命中）。
  `profiles/web/package.json` 里的 `"patchReload": "live"` 是一个被忽略的未知字段，
  不要指望它让新插件行立即生效。

应用内的热更新走的是 `internal/update` 事件（**通过 Loader API 写配置**时触发），
而不是"文件被改动"。所以：

| 操作 | 是否需要重启 |
|------|--------------|
| 增删 `cordis.patch.yml` 里的插件行 | **需要** |
| 通过 GUI 的设置/插件管理器改配置 | 不需要（走 `internal/update`） |
| 改动任何 `lib/*.js` | **需要**（模块按插件名缓存） |
| 改动 `lib/client.js` | **需要**，并额外刷新页面 |

卸载＝删掉相关 patch 行并重启，必要时再删 junction。


### 可配置项

在 patch 行加 `config:` 即可，无需改代码：

```yaml
- id: session-watch
  name: '@local/dsh-session-watch'
  config:
    stallMs: 300000        # 静默多久算停摆（默认 5 分钟）
    minAgeMs: 60000        # 小于此年龄的会话不判定（默认 1 分钟）
    pollMs: 30000          # 后台重扫间隔（默认 30 秒）
    maxSessions: 200       # 最多扫描多少个最近会话（默认 200）
```

`stallMs` 是最需要按实际情况调的一个：长时间模型调用加上慢工具，单步超过 5 分钟是可能的，
调太小会产生误报。

## 生效与自测

| 改了什么 | 生效方式 |
|----------|----------|
| `cordis.patch.yml` 的插件行（任何层级） | **需要重启**：该文件启动时只读一次，没有文件监听 |
| 任何 `lib/*.js`（Host 半与逻辑层） | **需要重启**：loader 按插件名缓存模块 |
| `lib/client.js`（Client 半） | **需要重启 + 刷新页面**：bundle 只在渲染 `index.html` 时注入 |
| GUI 里改的插件配置（设置页 / 插件管理器） | 立即（走 `internal/update`，不是文件改动） |
| `install_bundle` 安装**新的** bundle | **立即**（live profile 重新组合；结果里 `application: applied` 即生效） |
| 已装 bundle 里的 `lib/*.js` **代码**改动 | **需要重启**：仍受模块缓存约束 |

```powershell
cd C:\agent\dsh\plugin\dsh-session-watch
node test/run-all.mjs            # 全部套件（370 项断言 / 19 个套件）
node test/detect.test.mjs        # 判定规则（29 项）
node test/approval-gate-counterfactual.mjs # 审批闸门修复的反证（6 项）
node test/logs.test.mjs          # 日志读取与截断（17 项）
node test/transcript.test.mjs    # 会话转写与停止归因（24 项）
node test/resume.test.mjs        # 恢复策略闸门（66 项，纯逻辑）
node test/plugin-smoke.mjs       # Host 半 + 缓存回归（真实 DSH home，10 项）
node test/resume-wiring.mjs      # 恢复接线（假 Host + 临时 home，43 项）
node test/proxy.test.mjs         # 用户代理专家工具（假 Host + 临时 home，41 项）
node test/expert-diagnosis.test.mjs # 专家诊断能力（真实会话语料，只读，8 项）
node test/config-divergence.test.mjs # 两半策略一致性（12 项）
node test/handoff.test.mjs        # 第 2→3 层交接（7 项）
node test/handoff-parked.test.mjs  # 交接只在需要人时出现（5 项）
node test/snapshot-outcome.test.mjs # 快照报告结果而非意图（7 项）
node test/host-ready.test.mjs    # Host 未就绪不消耗尝试次数（5 项）
node test/shared-instance.test.mjs # 两半共享同一快照信箱（4 项，真实 profile 解析）
node test/proxy-apply.test.mjs   # 用户代理挂载 + 诊断降级（假 Cordis ctx，13 项）
node test/preset-drift.mjs       # preset 与真实 standard 对账 + persona 检查（10 项，读 asar）
node test/enable-resume-logic.test.mjs # 开启第 2 层的配置改写（7 项，不改真实配置）
node test/client-smoke.mjs       # Client 半（React stub，56 项）
node test/replay.mjs --verbose   # 真实日志回放，看判定分布（只读）
node test/survey-vocabulary.mjs  # 枚举真实事件词汇表，查审批等待形状（只读）
node test/measure-gaps.mjs       # 量真实轮次内间隔，为 stallMs 提供依据（只读）
node test/verify-live.mjs        # 实机验证整套闭环（**只读**；写探针需 --resume-probe）
node test/verify-signal-live.mjs # 对真实 controller 验证 prompt 的 signal（可指定 baseUrl）
node test/enable-resume.mjs      # 开启第 2 层（会先复核代码代次，再改配置）
node test/audit-manual-budget.mjs # 只读：看额度被自动还是手动花掉的
node test/verify-approval-gate-live.mjs  # 只读：实时确认等待审批的会话没被碰
```

**`verify-live.mjs` 是重启后应该跑的第一个命令。** 它能回答两个从工作区里看不到的问题：

1. **运行中的进程到底加载的是不是当前代码？** —— 读 `/diagnostics`。
   这个路由是和两处修复一起加的，所以它 404 就精确意味着进程还跑着修复前的模块。
   （这个项目出过一个「测试全绿但进程跑着旧代码」的问题，所以这条检查是必要的。）
2. **preset 的组合到底挂载了没有？** —— 读专家半写的挂载记录。
   声明行 `active` 不等于组合挂载成功，而这两者在进程外看起来一模一样。

它还会跑全套件、replay，并给出明确结论。

> **它是只读的。** 曾经不是：旧版本为了拿到"调用级 signal 证据"会 `POST /resume`
> 并自己挑一个会话——那**真的往两个真实会话里注入了续跑提示**，还花掉了它们的额度。
> 会话被 nudge 过无法撤销，所以验证脚本不该做写操作。
> 现在要那条证据必须**显式指定**一个可牺牲的会话：`--resume-probe <sessionId>`。
>
> **一个验证脚本如果会改动被验证的系统，它就不再是验证。**

`resume-wiring.mjs` 与 `proxy.test.mjs` 是最关键的两个：`resume.test.mjs` 只证明**策略是对的**，
它们证明**插件真的照策略执行**——只碰 `stalled`、只碰一次、失败也计数、上限后停手，
且**审批等待的会话即使被 force 也绝不动**。这两件事会分开失效：一个正确但接错会话的策略，
同样能通过策略单测却在真实环境造成伤害。两者都用**临时 `DSH_HOME`**，绝不读写你真实的账本或日志。

`preset-drift.mjs` 防止 preset 副本腐坏（见上文第 3 层）。

### 在隔离的真实宿主里验证（不必打扰你在用的那个）

有些事单测证明不了：**preset 到底挂不挂得上**、**`prompt` 真的接受这个调用吗**、
**审批闸门在真实运行时表现如何**。这些都需要一个真的宿主进程。

做法是另起一个**隔离宿主**——独立的 `DSH_HOME`、独立端口，
看不到也改不了你的会话、账本与挂载记录。完整记录与证据见
`test/artifacts/LIVE-VERIFICATION.md`，实测结论：

| 验证项 | 结果 |
|---|---|
| preset 挂载 | `proxyMounted: true`，3 个工具注册，5 个服务在场 |
| `prompt(request, signal)` | 修复后能进入 controller（拿到带 `code` 的 `RemoteError`） |
| 自动恢复 | 触发 → 退避 → 第二次 → **上限 2 后停手**，**失败也计数** |
| **审批闸门** | `approval/asked` 与未回答的 `ask_user_question` **都判成 `awaiting-approval` 且从未被触碰**；真正的停摆才被恢复 |

**关键技巧**：隔离宿主必须用 `Win32_Process.Create`（WMI）启动，不能用
`Start-Process` 或后台作业——后者派生的子进程会继承
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 作业对象，应用一退就被杀。
脚本在 `_recon/launch-isolated.ps1`（这是 `dsh-restart` 用的同一机制）。

### 两个 live 检查脚本的分工

| 脚本 | 回答什么 |
|---|---|
| `verify-live.mjs` | 「**你在用的这个宿主**现在处于什么状态？」——代码代次、专家挂载、无误报、套件全绿 |
| `verify-signal-live.mjs` | 「`prompt` 的 signal 修复是否真的生效？」——同一脚本打任意 baseUrl，**旧代码会命中 `throwIfAborted`，新代码拿到带 `code` 的错误**，一目了然 |

`survey-vocabulary.mjs` 是这次查出审批闸门失效的工具：它枚举**全部真实事件类型**并列出
未被回答的审批。**怀疑某个闸门是不是死的，先跑它** —— 事件名写错这类问题，只有真实数据能暴露。

`replay.mjs` 直接解压你真实的会话日志跑判定，输出分布与每个 `stalled` 会话的证据。
**调整 `stallMs` 或改判定规则后，应该先看它，再上自动动作。**

> ⚠ **回放的 `stalled` 数不能直接和侧边栏对比。** 回放只读文件，**不知道哪些会话此刻有活着的驱动器**，
> 所以它一律按 `running: false` 从严判定 —— 于是「**正在运行中**」的会话在这里也会计成 stalled。
> 本机实测：回放报 3，侧边栏报 0，而那 3 个正是当时有活 agent 的 3 个会话。
> **实时结论以侧边栏 / `/watch` / `GET /state` 为准**；回放用来观察语料的**形状**与检测规则的变化。
> 脚本自己会把这条说明打印出来。

`client-smoke.mjs` 用 React stub + 假 fetch 在 Node 里跑**真实的 bundle**（捕获
`window.__ModuleLoader__`、注入 `require`），能覆盖注册、宽/导轨两种宽度渲染、角标计数、
面板展开、错误态与 dispose——但**渲染不出来**（不校验样式真的好看、也不校验框架真的把按钮放进了侧边栏）。
那一层只能靠人眼看一眼侧边栏。

## 自动恢复（第 2 层，默认关闭）

**安装本插件不会改变 DSH 的任何行为**——`resume.enabled` 默认 `false`，只报告。

开启后，对被判定为 `stalled` 的会话，插件会通过 Host 的
`ctx.sessionController.prompt({ sessionId, mode: 'queue', ... })` 送去一句续跑提示。
这个接口的语义是"先恢复该 Session、再把消息作为普通后续轮次入队"，**效果等同于你自己敲一句「继续」**，
不是绕过身份/模型路由校验的底层调用。

### 唯一的规则：默认拒绝

`lib/resume.js` 里的每一个判断都是**否决**，默认答案是"别碰"。只有全部条件同时放行才会恢复。
**提示词只决定"说什么"，绝不决定"要不要恢复"**——写得再好的提示词也救不回一个错误的决定。

| 闸门 | 拒绝条件 | 为什么 |
|------|----------|--------|
| 总开关 | `resume.enabled=false` | 装上就改变行为是不可接受的 |
| 判定 | 不是 `stalled` | 给等待审批的会话发消息＝替你回答问题；给空会话发消息＝凭空造活 |
| 忙碌 | agent 正在运行 | 正在干活就不是停摆 |
| 次数上限 | 已达 `maxAttempts`（默认 2） | 一个"每次都把自己弄死"的会话会被无限催促、白烧 token |
| 退避 | 距上次不足 `baseDelayMs × 2^(n-1)`（上限 `maxDelayMs`） | 系统性故障（限流、provider 挂了）立即重试必然同样失败 |
| 冷却 | 距上次不足 `cooldownMs`（默认 5 分钟） | 恢复是异步的；judge 太早会形成催促风暴 |

**上限优先于冷却**：用满次数后报的是"已达上限"，不是"冷却中"——否则你会等一个永远不会到来的重试。

### 账本是持久化的

尝试次数写在 `~/.dsh/session-watch.json`（原子写入：临时文件 + rename）。
**必须持久化**：如果重启就清零，一个每次都失败的会话会被永远催促下去，正是次数上限要阻止的事。

失败的恢复**也计入次数**。`session/model-unavailable`（provider 路由没了）这类错误是可预期的，
插件会记录并报告，不会因此崩掉，也不会立刻重试。

### 开启方式

> **必须重启之后再开。** `config` 会热更新，但**模块代码不会**（loader 按插件名缓存模块）。
> 在跑着旧代码的进程里直接开 `enabled: true`，你会拿到旧行为——本项目就出过这个问题。

正因这两种顺序**不等价**，顺序由脚本强制，而不是靠一句提醒：

```powershell
node test/enable-resume.mjs            # 先复核代码代次，通过后才改配置
node test/enable-resume.mjs --check    # 只看，不改
```

它会先检查运行中的进程是不是当前代码（读 `/diagnostics`，这个路由是和两处修复一起加的，
所以它 404 就精确意味着进程还跑着修复前的模块）。**不是当前代码就拒绝开启**，并说明原因：

| 顺序 | 后果 |
|---|---|
| **先重启，再开启** | 新闸门生效，安全 |
| **先开启，再重启** | 中间这段时间，**旧进程带着开启的自动恢复在跑**——它的审批闸门认不出本机真实事件名，会把一个正在等你批准工具的会话判成 `stalled`，然后替你发「继续」 |

配置本身长这样（脚本改的就是 `enabled` 那一行）：

```yaml
- id: session-watch
  name: '@local/dsh-session-watch'
  config:
    # 见上文"stallMs 是量出来的"一节：15 分钟，不是默认的 5 分钟。
    stallMs: 900000
    resume:
      enabled: true            # 默认 false
      maxAttempts: 2           # 每会话上限
      baseDelayMs: 120000      # 首次退避 2 分钟，逐次翻倍
      maxDelayMs: 1800000      # 退避上限 30 分钟
      cooldownMs: 300000       # 两次恢复之间至少 5 分钟
      # promptTemplate: '继续 {turn}/{step}'   # 可选；占位符 {turn} {step} {lastType}
```

### `stallMs` 是量出来的，不是猜的

README 早先提醒过「默认 5 分钟可能偏小」。现在它有数据支撑 ——
`node test/measure-gaps.mjs` 扫描本机 178 个日志，**只看开着的轮次内部**的间隔
（轮次之间的空闲时间检测器根本看不到，算进去只会把阈值抬高到没有依据）：

| 分位 | 轮次内间隔 |
|---|---|
| p90 | 4.2s |
| p99 | 28.3s |
| p99.9 | 135.5s |
| p99.99 | 600s |
| max | 2490s |

按候选阈值统计「**曾经**出现过更长合法间隔的会话数」——每一个都是一次潜在的误报：

| stallMs | 有此风险的会话 |
|---|---|
| 3m | 16 / 168 |
| **5m（旧默认）** | **12 / 168** |
| 10m | 5 / 168 |
| **15m（现用）** | **1 / 168** |
| 60m | 0 / 168 |

5 分钟时，168 个会话里有 12 个**已经**产生过比阈值更长的合法间隔。自动恢复开着的时候，
一次误报的代价从"多看一眼"变成"往一个正常工作的会话里多发一条消息"，所以这个数字不能忽视。
15 分钟时只剩 1 个，而那一个是等审批等了 41 分钟 —— 现在由审批闸门按规则排除。

**改这个值之前，先跑 `measure-gaps.mjs` 看当前数据。**

### 先手动试一次（推荐）

不必先开自动恢复。任何会话都能手动续跑一次，用来确认机制在你的环境里可用：

```powershell
# 先看当前判定
curl.exe -H "x-session-watch: 1" http://127.0.0.1:19387/session-watch/api/state

# 手动续跑某一个会话（用返回里的 sessionId）
curl.exe -X POST -H "x-session-watch: 1" "http://127.0.0.1:19387/session-watch/api/resume?sessionId=<会话 id>"
```

**手动恢复不受准入闸门限制**：判定、`busy`、冷却都不拦你——那是你的判断，不是策略的判断。

但它**会记账**，而且**和自动恢复共用同一个额度**。这两件事都是刻意的：

- **记账**：账本是"到底对哪个会话试过什么"的唯一记录。一次不记录的动作，
  和 harness 自作主张没有区别。
- **共用额度**：上限的作用是限制"一个会话**总共**被打扰几次"。
  如果手动和自动各算一套，一个你已经手动 nudge 过两次的会话，
  还会再收到两条自动消息——那正是上限要防的循环。

因此**手动 nudge 会消耗自动恢复的额度**。如果你正打算留出自动恢复的空间，
先 `node test/audit-manual-budget.mjs` 看一眼额度是谁花的——
面板也会如实区分（它不会把两次手动说成"已自动恢复 2 次"）。

> ⚠️ `POST /resume` 是**写操作**，会真的往那个会话里发一条"继续"，**无法撤销**。
> 不要用它去试探一个你还在意的会话。

### 可观测性

侧边栏面板与 `/watch` 都会显示：自动恢复是否启用、上限次数、本轮恢复了哪些会话、
以及**每个停摆会话为什么没有被恢复**。一次你看不见的自动动作，和 harness 自作主张没有区别。

**每一次恢复尝试都带作者署名**：账本里每条记录都有 `by` 字段 —— `auto` 表示监视器自己发起的，
`user-proxy` 表示用户代理专家发起的。面板与 `/watch` 都会显示"上一次由谁发起、成功还是失败"。

这不只是好看：**"恢复了 2 次"这句话本身隐藏了关键区别** —— 是监视器自作主张动的，
还是专家替你动的。一个无法归因的自动动作，和 harness 自己乱动没法区分。

### 策略停手时会带你走下一步

三层里前两层是自动的，**第三层是判断**。所以当策略**刻意停手**时——
次数用满，或规则判定这个等待不该碰——循环并没有走完，
而是正好走到"该由人 / 专家接手"的位置。

只报一句"转为仅报告"是不够的：那会把你丢回项目要解决的原点——
手里一个停下来的会话，不知道该干什么。

所以这些会话会带一个**下一步**，并且只在专家真的挂载时才提它
（指向一个没装上的工具，比什么都不说更糟）：

```
已用满自动恢复次数。建议用用户代理专家读它的输入输出找根因（session_review），
或 POST /session-watch/api/resume?sessionId=... 手动续跑。

规则判定不该自动恢复（awaiting-approval）。用用户代理专家读一下它在等什么，
或 POST /session-watch/api/resume?sessionId=... 手动续跑。
```

两条分支的区别是有意的：前者把专家当作下一步（自动化放弃了）；
后者只说"去读它在等什么"，因为那是规则**刻意**不碰的等待——
在那儿建议你"强制续跑"，等于教你替用户按确认。

> **注意**：`resume.enabled: false` 时**不会**出现这些提示。
> 那是你自己的配置，不是策略放弃了，对每个会话都催一遍纯属噪声。

**不影响你正在跑的 GUI**：本插件只读取会话日志（只读）并通过只读的路由暴露快照。
它不写入任何会话，也不激活任何 Agent——`ctx.agents.list()` 是纯观察，
`inspect` 也刻意未用于唤醒用途。观察一个卡住的会话**不会**把它弄醒。

## 故障排查

### 侧边栏按钮出现了，但点击显示"请求失败"

按钮能渲染说明 **Client 半已加载**（它是独立 bundle，只依赖 `slots`/`locale`）。
所以问题一定在 **Host 半没有 apply**，即路由没注册。

先用同机制的 `window-pin` 做对照，一句话就能定位：

```powershell
# 对照：同机制（kind: prefix）的已工作插件，应当返回 200
curl.exe -H "x-window-pin: 1" http://127.0.0.1:19387/window-pin/api/state

# 本插件
curl.exe -H "x-session-watch: 1" http://127.0.0.1:19387/session-watch/api/state
```

| 结果 | 含义与处置 |
|------|-----------|
| 两个都 404 | 两个插件都没加载；检查 `~/.dsh/cordis.patch.yml` |
| window-pin 200、本插件 404 | 插件行在、但本插件没 apply → **重启 dsh desktop** |
| 本插件 403 | Host 半正常，只是缺 `x-session-watch` 请求头 |
| 本插件 200 但界面仍报错 | 刷新页面（Client bundle 只在渲染 `index.html` 时注入） |

> **踩过的坑（已修，见 `test/resume-wiring.mjs` 的"可选依赖"用例）**
> 我一度把 `sessionController` 写进 `inject`。Cordis 在依赖未就绪时**不会 apply 整个插件**，
> 于是一个**可选能力**把只读的检测层和路由一起阻塞了——症状正是"按钮在、请求失败"。
> 现在 `inject` 只声明观察必需的三个服务，恢复能力在**调用时**按需查表，
> 缺失时明确返回 `no-controller`，而不是让整个插件不工作。

### `/watch` 命令不存在

同样是 Host 半没 apply → 重启 dsh desktop。

### 侧边栏没有"会话监视"按钮

Client 半没加载。先确认 junction 是好的：

```powershell
Get-Item "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-session-watch" | Select-Object LinkType,Target
```

`LinkType` 应为 `Junction`，`Target` 指向本目录；再确认 patch 里有 `session-watch` 行
（**且写在正在运行的那个 profile 里**，见上文）。

### 为什么改完必须重启

| 改了什么 | 生效方式 |
|----------|----------|
| patch 里的插件行 | **必须重启**：`cordis.patch.yml` 启动时只读一次，无文件监听 |
| 任何 `lib/*.js` | **必须重启**：loader 按插件名缓存模块 |
| `lib/client.js` | **必须重启 + 刷新页面**：bundle 只在渲染 `index.html` 时注入 |

插件**无法从内部重启应用**（宿主进程是 Electron 外壳的子进程，见 `dsh-restart` 的说明），
所以这一步只能由你手动完成。

## 已知限制

- **`stallMs` 默认 5 分钟可能偏小。** 如果你的模型调用或工具单步经常超过 5 分钟，
  会产生误报；建议先用 `replay.mjs` 观测实际间隔再定。开了自动恢复后，误报的代价从"多看一条"变成"多发一条消息"。
- **自动恢复只看"日志是否停住"，无法理解会话在等什么。** 如果一个会话是在等你**在别处**提供的东西
  （外部系统、你要手动跑的命令、另一个人的回复），它会满足 `stalled` 条件并被续跑。
  续跑用的是普通的"继续"提示，agent 通常只会说明它在等什么——但这是第 2 层已知的、可接受的噪声。
  真正危险的那类等待（会话内的审批提示）已由 `awaiting-approval` 精确排除。
- **重启会保留账本，但不会保留"我刚刚恢复过"的内存状态**；冷却判断依据账本里的时间戳，所以仍然有效。
- **长轮次只扫描尾部 400 个事件**（外加 header 与当前轮 `turn/start`）。
  这足够判定轮次是否闭合，但如果未来需要更早的历史证据，需要调大 `TAIL_LIMIT`。
- **只看主会话。** subagent 子会话被明确排除（它们本来就常常长时间静默）。
- **判定依据是日志与 mtime**，不是进程内存里的实时状态；`ctx.agents.list()` 只在会话仍存活时可用，
  冷会话按"没有驱动器"处理。
- 本插件**不做**原生调用（不需要子进程），因此没有 window-pin 那类完整性标签问题。
