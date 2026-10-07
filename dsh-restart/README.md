# @local/dsh-restart

`/restart` —— 退出并重新启动 dsh 桌面应用。

> **状态：`/restart` 命令链路已端到端验证通过（2026-10-06 15:27:36，真机）。**
> 真实插件 handler → 真实 worker → `status=restarted`、`raised=true`、新外壳带窗口起来、
> 会话自行恢复。在此之前还有两次真机重启（14:51:34、15:23:14）。哪些证明了、哪些没有，
> 全部写在《验证状态》一节。
>
> **当前运行中的宿主加载的是早一版 `index.js`。** 要拿到最新代码，需完全退出 dsh 再打开
> （原因见《安装位置》）。脚本改动无需重启，每次调用都从磁盘读取。

## 它做什么

在任意会话里输入 `/restart`：

1. 插件启动外部脚本，脚本**立刻**转交给一个逃离了宿主进程组的后台 worker，然后马上返回；
2. worker 等 2.5 秒（让命令结果先渲染出来），只终止**外壳进程**；
3. 宿主发现与外壳的 IPC 断开后，**自己优雅退出**（有 5 秒上限）；
4. worker 等整个进程组消失、再等端口 19387 释放；
5. 通过 `explorer.exe` 重新启动应用，并把窗口提到前台。

## 设计：脚本在外，插件在内

```
┌─ Electron 外壳（窗口 / 托盘）      ← 只有这里能重启整个应用
│   └─ dsh 宿主 ← 插件跑在这里，发不出重启
└─ ◀ 外部脚本从这里驱动整个应用（不在 app.asar 内，升级不会覆盖）
```

**为什么插件自己做不到。** 外壳这样启动宿主：

```js
spawn(node, ['--expose-internals', '.../dsh-desktop-host/lib/index.js', ...], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],   // ← 这条 ipc 通道
})
```

`app.relaunch()` 只出现在三个地方（`lib/main.js`）：崩溃恢复对话框（`:10984`）、
`development ? [...] : []` 里的菜单项（`:11909`，正式版不存在）、以及更新安装路径。
端口 19387 由外壳写死。**插件无法重建这条通道，也无法让外壳重启**。

**为什么脚本放外面。** 安装走 `nightly` 通道，更新整体替换 121 MB 的 `app.asar`，没有保留用户
修改的机制；且 asar 被运行中的进程锁定。脚本在应用外面，升级不会覆盖它。

## 关键机制一：Windows 作业对象（本项目最核心的发现）

**每个 dsh 进程都在一个带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Windows 作业对象里。**
用正常方式（`Start-Process`、`child_process.spawn`）派生的子进程会**继承**这个作业，于是在应用
退出的同一瞬间被一起杀掉 —— 它永远来不及重启任何东西。

这解释了此前"怎么改都没效果"：旧实现的自我转交用的是 `Start-Process`，**结构上不可能成功**。

**受控对照实验**（假外壳先被放进 kill-on-close 作业，再派生三个 worker，然后关闭作业句柄）：

| worker 启动方式 | 心跳数 | 最后一次心跳 | 结果 |
|---|---|---|---|
| `Start-Process` | 19 | 作业关闭**前** 0.031 秒 | **被杀** |
| `Win32_Process.Create`（WMI） | 50 | 作业关闭**后** 13 秒 | 存活 |
| `explorer.exe` + `.cmd` | 50 | 作业关闭**后** 13 秒 | 存活 |

⇒ **worker 必须通过 WMI 转交**（`Invoke-CimMethod Win32_Process Create`），失败时退回
`explorer.exe`。这是必需条件，不是优化。

补充实测：WMI 创建出来的进程落在 **session 1**（`UserInteractive=True`，与 `explorer.exe` 同
session），尽管 `WmiPrvSE.exe` 本身在 session 0 —— 所以它**能**显示窗口。

## 关键机制二：为什么只杀外壳、不杀宿主

宿主这样观察外壳的死亡（`dsh-desktop-host/lib/index.js:320`）：

```js
process.once("disconnect", () => { stop(); });
```

`stop()` 会 `await (await application.catch(() => void 0))?.shutdown.shutdown(0)` —— 即使启动
过程已经失败也会继续退出。而 `shutdown` 是有上限的（`dsh/lib/profile-boot-*.js`）：

```js
const PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3;
timeout = setTimeout(() => { forceExitOnce(code); }, timeoutMs);   // forceExit = process.exit
```

所以外壳死后，宿主**必定在 5 秒内消失**，端口必定释放。

**反过来不行**：直接杀宿主会让外壳走 `child.once("close")` → `fail()` 分支，弹出致命错误恢复
对话框（`lib/main.js:3722-3727`）。所以脚本只终止**根外壳进程**，其余进程随之自行退出。

## 关键机制三：单实例锁要求"先等 pid 消失，再等端口，最后才启动"

`claimDesktopSingleInstance` → `requestSingleInstanceLock()`：第二个实例会**静默地**把已有窗口
提到前台然后自己退出（`lib/main.js:6870-6877`）。所以 worker 的等待顺序是：

1. 旧外壳 pid 消失；
2. 端口 19387 不再监听；
3. 才启动新实例。

只等端口是不够的（端口先释放，锁可能还持有）。

## 安全设计

| 机制 | 行为 |
|---|---|
| **默认不强杀** | 超时后不杀任何东西，报告 `quit-timeout`。要强杀必须显式 `-AllowForce` |
| **只作用于目标应用** | 终止集 = 映像路径等于 `-AppPath` 的进程；显式路径若不存在 → `app-not-found`，绝不回退到自动探测 |
| **绝不动宿主** | 只杀根外壳；宿主靠 IPC 断开自行退出 |
| **单 worker 互斥** | 具名互斥体防止两个重启互相踩踏；第二个报告 `already-running` |
| **诚实的结果** | 无法确认的中间态（`launched`）映射为 **error** 而非成功；未知状态也绝不报成功 |
| **`/restart` 不接受参数** | 任何参数都被拒绝，避免通过命令行使能危险开关 |

## 脚本用法

```powershell
pwsh -File script\dsh-restart.ps1                    # 退出并重启
pwsh -File script\dsh-restart.ps1 -DryRun            # 只报告会做什么（不终止、不启动、不转交）
pwsh -File script\dsh-restart.ps1 -QuitOnly          # 只退出，不重启
pwsh -File script\dsh-restart.ps1 -AllowForce        # 超时后允许强杀（可能丢失未落盘状态）
pwsh -File script\dsh-restart.ps1 -Json -ResultPath out.json
```

| 状态 | 退出码 | 含义 |
|---|---|---|
| `launched` | 0 | 已转交后台 worker（中间态，**不是**成功确认） |
| `restarted` | 0 | 已退出且新窗口已出现 |
| `started` | 0 | 之前没在运行，现在已启动 |
| `not-running` | 0 | 没有在运行，无需重启 |
| `would-restart` | 0 | `-DryRun`：只报告计划 |
| `quit-only` | 0 | `-QuitOnly`：已退出，未重启 |
| `quit-timeout` | 3 | 超时后仍有进程存活；未强杀 |
| `app-not-found` | 4 | 找不到可执行文件 |
| `start-failed` | 5 | 已退出但新窗口没出现 |
| `already-running` | 6 | 另一个重启正在进行，本次什么都没做 |

## 安装位置

- 插件本体：`C:\agent\dsh\plugin\dsh-restart`
- junction：`%USERPROFILE%\.dsh\profiles\node_modules\@local\dsh-restart`
- 注册行：`%USERPROFILE%\.dsh\cordis.patch.yml` 的 `id: restart`

> **改动 `index.js` 后必须完全退出 dsh 再打开才生效。** 部署版没有开模块热加载
> （`dsh-base/cordis.patch.yml` 的 `hmr.config.root: []`），而且插件的 junction 路径含
> `/node_modules/`，即使开了也被 `dsh-hmr` 的 `isExcluded` 排除；补丁文件监听只重放配置行
> （`reconcileProfilePatches`），不会重新 import 模块。
> **改动 `script/dsh-restart.ps1` 则立即生效** —— 每次调用都从磁盘读取。

## 测试

```sh
node test/plugin-check.mjs
```

覆盖：导出契约、**注册进真实命令注册表**（从 `app.asar` 解压后加载真实 `dsh-commands`）、参数
校验、状态映射（失败与中间态绝不报成功）、两个解释器下的解析、`-DryRun` 不终止任何进程、
两阶段转交、UTF-8 无 BOM、以及 worker 确实不在 kill-on-close 作业里。

安全约定：测试**只**用 `-DryRun`，以及指向不存在 `-AppPath` 的转交；每次调用前后都断言 DSH
进程集合未变。

## 验证状态

### ★ `/restart` 命令链路已端到端验证通过（2026-10-06 15:27:36，真机）

Lead 用一个最小驱动补上了此前唯一的缺口：导入**真实** `index.js` → 真实 `apply()` 注册 →
调用**真实 handler** → 真实 spawn PowerShell worker。**没有任何环节被打桩或替换**
（此前的套件 A7 是**拦截** spawn 的，只证明了 argv 契约）。驱动经 WMI 启动，因此能活过自己
触发的那次重启并把结果写下来。

```
=== invoking the REAL handler (this will really restart dsh) ===
[plugin info ] restart: dsh 已重启：应用已退出，新的窗口已经出现。

=== handler returned after 11341 ms ===
{ "kind": "success",
  "text": "dsh 已重启：应用已退出，新的窗口已经出现。\nThe app is back: new shell pid 34848, port 19387." }

=== WORKER TERMINAL STATUS (the durable truth) ===
{ "status": "restarted", "code": 0, "newShellPid": 34848, "port": 19387, "raised": true,
  "durationMs": 9487,
  "notes": [ "worker job state: NOT in any job object (escaped)",
             "root shell: pid 40244 terminated; the host now shuts itself down on IPC disconnect",
             "port 19387 is free",
             "launch requested through explorer.exe",
             "window raised to the foreground" ] }
```

复核（在进程树里直接查的）：新外壳 **34848** 存活、`MainWindowHandle` 非 0、标题正确；
旧外壳 **40244** 与旧宿主 **30648** 均消失；19387 由新宿主持有；GUI 返回 401（存活）；
**本会话跨越该次重启继续运行，无需手动"继续"**。
证据存档：`_recon/evidence/handler-e2e-report.json`、`handler-e2e-stdout.txt`。

**顺带证实了一条安全设计**：驱动进程经 `cmd.exe` 启动，于是 `resolveAppPath()` 拿到的是
`cmd.exe`。插件的 `NON_SHELL_IMAGES` 守卫**正确地丢弃了它**、改为不传 `-AppPath`，
让脚本走自己更窄的自动探测 —— 而不是把 `cmd.exe` 当作终止集。

### 那次 14:51:34 的真实重启 —— 它不是 `/restart` 触发的

**现象（已核实）**：旧外壳 **36080**（13:50:14 启动）消失；新外壳 **40032** 于 **14:51:34** 启动，
父进程是 **explorer.exe (12124)**；窗口恢复（`MainWindowHandle != 0`）；端口 19387 由新宿主 36956
监听；**本会话日志跨越重启持续增长**（无 `.tmp`/`.lock`/迁移残留）。

**这条证据说明了什么、不说明什么**：

| 结论 | 状态 |
|---|---|
| "退出外壳 → 宿主自行优雅退出 → 重新启动 → 窗口恢复"这套机制在真机上**可行** | ✅ 已证实 |
| 重启**不会**让运行中的会话变成"暂停、需手动继续" | ✅ 已证实（日志跨重启连续增长） |
| `/restart` 命令能触发它 | ❌ **未证实**（那次是脚本被直接调用触发的） |
| 触发时走的正是设计中的 WMI worker 路径 | ❌ **未证实**（见下） |

**关于触发链的诚实说明**：那次重启发生在测试脚本的过程中，而不是通过 `/restart`。当时至少存在两个
缺陷：`-AppPath` 因参数名大小写冲突而**静默失效**（worker 会回退到自动探测，从而重启**真实**应用），
以及开关被引号包住导致参数绑定失败。script-dev 复核认为前者是那次的直接原因；**我无法从留存的产物
把它完全复现**（当时的命令行已不存在），所以记为**最可能的解释，而非已证实的事实**。
可以确定的是：**"WMI + 正确 `-AppPath`" 这条路径在修复前从未被真正跑通过。**

两个缺陷都已永久修复：参数改名（`resolvedAppPath`/`resolvedExeName`）+ **fail-closed 守卫**
（worker 未拿到 `-AppPath` 就拒绝，什么都不终止，绝不自动探测）。

### 已实测的单元/集成证据（可复现）

- 两个解释器（Windows PowerShell 5.1 与 PowerShell 7）都能解析脚本；
- **P0 回归验证**：通过 WMI 启动 worker（与 phase 1 同形）并指向不存在的 `-AppPath`，worker
  **确实运行**、约 1 秒内写出终态 `app-not-found`，并自报
  `worker job state: NOT in any job object (escaped)` —— 即它真的逃出了 kill-on-close 作业。
  **修复前这里什么都不会产生（旧写法直接绑定失败）；这就是回归判据。**
- fail-closed 守卫：worker 未给 `-AppPath` → `app-not-found` + `Nothing was terminated.`；
- `-DryRun -Json` → `would-restart`，且**核心进程 ID 集合前后完全一致**（不终止任何进程）；
- 两阶段转交：启动器 **328 ms** 返回，终态随后落到 `-ResultPath`（修复前永远停在 `launched`）；
- 结果文件 UTF-8 **无 BOM**；
- 缺失 `-AppPath` → `app-not-found`，不终止任何进程，不回退自动探测；
- 单 worker 互斥体：两个并发 worker，一个 `already-running`、另一个正常继续；
- 插件行在运行中的宿主里为 **`fiberPhase: "active"`**（真的加载了，不只是写进配置）。

### 仍未验证 / 已知边界

- **没有在 GUI 输入框里手敲 `/restart`。** 15:27:36 那次走的是**同一个 handler、同一段代码
  路径、同样的 argv**，只是由驱动进程调用而非输入框。触发后当前对话会断开，属正常。
- **`already-running` / `-AllowForce` / `quit-timeout` 分支未经真机验证**（互斥体那一支只在隔离
  场景中走过）。
- **explorer `.cmd` 回退未被证明能逃出作业** —— 只有 WMI 路径被证明；回退仅在 WMI 失败时启用。
- **会话落盘有一个 5 秒窗口。** 宿主退出时会 drain（`session-persistence-jsonl` 的
  `session/flush`、`session/disposed`、fiber 释放时关闭句柄），但该 drain 跑在 5 秒强制退出预算
  **之内**：缓冲积压很大或 fsync 很慢时，`process.exit` 可能截断最后一批。三次真实重启
  （14:51:34 / 15:23:14 / 15:27:36）后都没有观察到损坏的会话尾，本会话每次都完整存活，但
  **没有**逐一比对当时所有打开的会话。
- **窗口前台提升**：15:23:14 与 15:27:36 两次都报告 `raised: true`，窗口句柄与标题均已核实；
  但"用户肉眼看到它弹到最前"这一条依赖当时的焦点状态，未做逐帧观测。
- 现在有了 fail-closed 守卫，指向不存在路径**不会**再误伤真实应用；代价是不能借它演练真实重启。

## 已修复的高危缺陷（P0）：等端口那一步在成功路径上必然抛异常（Lead 修复）

**这个缺陷比"没反应"严重得多：它让应用被关掉后永远不会再打开。**

修复前的等端口判断（当时在第 870 行；加入说明注释后现位于 **第 886 行**）：

```powershell
while ((Get-PortListenerPids -PortNumber $Port).Count -gt 0) {
```

`Get-PortListenerPids` 在端口空闲时走 `catch` 分支 `return @()`；PowerShell 会把**函数返回的空数组
塌缩成 `$null`**，而脚本开了 `Set-StrictMode -Version 2.0`，于是 `$null.Count` 抛
`PropertyNotFoundException`。

**它命中的正是成功路径**：外壳被杀 → 端口随之释放 → 返回空 → 抛异常 → 脚本转到自己的 phase
错误处理 → 报 `start-failed` 并退出，**不重新启动应用**。

用**脚本自己的函数**、对着**真实空闲端口**实测（`_tool/probe-portcount.ps1`）：

```
=== A. FREE port 45997 (this is the SUCCESS path: the app just exited) ===
  returned      : NULL
  @() wrapped   : 0
  bare .Count   : THROWS PropertyNotFoundException: 在此对象上找不到属性"Count"。
  --- the EXACT line-870 while-condition ---
  RESULT: THROWS ...
```

**修复**：

```powershell
while (@(Get-PortListenerPids -PortNumber $Port).Count -gt 0) {
```

`@(...)` 在这里是**必需**的，不是风格问题。第 872 行本来就有 `@(...)`，只有这一行漏了。

逐版本实测：StrictMode **1.0 通过；2.0 / 3.0 / Latest 全部抛出** —— 所以把 StrictMode 从
`Latest` 降到 `2.0` 并不能绕过它。全文件 18 处 `.Count` 已逐行审过，只有这一处是**内联函数调用**；
其余都作用在 `@(...)` 赋值过的变量上，不受影响。

**这个缺陷正是本 README 里那条 `FAIL B8` 的真实成因**（"Unexpected error during the 'start'
phase: 在此对象上找不到属性"Count""）—— 它与当时挂着的替身无关。

**修复前后在同一条真实路径上的对比**：

| | 修复前 | 修复后 |
|---|---|---|
| 脚本走到 | `start-failed`（抛 `PropertyNotFoundException`） | `port 19387 is free` → 启动 → `restarted` |
| 应用 | 被杀后**不再打开** | 新外壳起来、窗口回到前台 |

> ⚠ **回归防线**：这一行的 `@(...)` 不可省。若日后再动这段代码，请保留
> `_tool/probe-portcount.ps1` 的判据（用真实空闲端口调用真实函数）。

## 已修复的高危缺陷（P0）：`-AppPath` 被静默忽略，可能终止/重启**错误的**目标

这是本项目最严重的一个缺陷，比"没反应"危险得多。

**缺陷 1（安全）**：PowerShell 参数名**大小写不敏感**。脚本里有
`$script:appPath = ''`，它与 `param([string] $AppPath)` **是同一个名字**，于是这行初始化把调用方
传来的 `-AppPath` 参数**抹成了空串**。结果：

- 显式指定的 `-AppPath` 被完全忽略；
- 脚本转而**自动探测**，并作用于探测到的真实应用。

所以一次本意指向"不存在的路径"的安全测试，实际重启了用户正在使用的 dsh。**修复**：状态变量改名
为 `resolvedAppPath` / `resolvedExeName`。

**缺陷 2（fail-closed 守卫，新加）**：worker 若**没有**拿到 `-AppPath`，现在直接
`Complete-Run -Status 'app-not-found'`，明细写明 `Refusing to act: ... Nothing was terminated.`
—— 绝不回退到自动探测。这让"路径没传进来"从**静默误伤**变成**明确拒绝**。

**缺陷 3（开关被引号包住）**：phase 1 用 `Win32_Process.Create` 拼 worker 命令行时，开关被写成
单引号形式（`'-Json'`）。`powershell -File` 会把单引号 token 当**字符串字面量**而非开关，参数绑定
直接失败，worker 一行都没执行。调用方此时已返回 `launched`，于是终态永远等不到。

实测矩阵（每次都用 WMI + `cmd /c` 重定向启动，与真实转交同形）：

| 情况 | 脚本形态 | 开关写法 | 结果 |
|---|---|---|---|
| A | 无 `[CmdletBinding()]` | `'-Json'` | 能绑定，但 **`Json=False`**（静默失效） |
| B | 无 `[CmdletBinding()]` | `-Json` | 绑定，`Json=True` ✅ |
| C | 无 `[CmdletBinding()]` | `"-Json"` | 绑定，`Json=True` ✅ |
| D | **有 `[CmdletBinding()]`** | **`'-Json'`** | **参数绑定报错，脚本从未运行** ❌ |
| E | 有 `[CmdletBinding()]` | `-Json` | 绑定，`Json=True` ✅ |
| F | 有 `[CmdletBinding()]` | `"-Json"` | 绑定，`Json=True` ✅ |

**修复**：开关一律**不加引号**（`-Json`、`-QuitOnly`、`-AllowForce`、`-SkipWorkerGuard`），只对
`-File` / `-ResultPath` / `-AppPath` 的**值**加引号。**不能**靠删掉 `[CmdletBinding()]` 绕过 ——
那会落到 A/F，开关能绑定但恒为 false，调用方静默拿不到 JSON。

**回归判据**：用与 phase 1 同形的 WMI 命令启动 worker 并指向不存在的 `-AppPath`，**必须**在约
1 秒内产出终态 `app-not-found`（修复前此文件永不出现）。

## 其它已修复缺陷

| 缺陷 | 修复 |
|---|---|
| 旧实现的自我转交用 `Start-Process` | 子进程会继承 kill-on-close 作业，应用一退出就被杀；改为 WMI 转交（失败退 `explorer.exe`） |
| `-AppPath` 不影响"关哪个进程"（旧脚本读硬编码进程名） | 终止集改为按映像路径匹配；显式路径不存在时不回退到自动探测 |
| `detached: true` 是静默空操作 | 移除；改由脚本自己转交 |
| 中文输出变 GBK 乱码 | 脚本强制 UTF-8，结果文件无 BOM，有回归测试 |
| 两个重启并发互相踩踏 | 具名互斥体；第二个报告 `already-running`（退出码 6） |
| 后台启动的应用拿不到前台权 | 由 `explorer.exe` 启动 + `SetForegroundWindow`/`SW_RESTORE` |

## 环境注意

- 运行的是 **0.2.0-rc.2**，安装目录 **`C:\agent\dsh_desktop`**
  （`C:\agent\新建文件夹` 是指向它的 junction）。
- **不要编辑 `app.asar`**：`nightly` 通道的更新会整体替换它。
- `C:\agent\deepseek-harness-dsh-v0.1.2-rc.1`（旧参考 checkout）已不存在；
  `$DSH_HOME\profiles\node_modules\@deepseek-ai\**` 下大量 junction 因此失效。部署版从
  `app.asar` 加载，不影响运行，但不要从那里解析依赖。
