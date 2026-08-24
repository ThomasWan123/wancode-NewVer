# WanCodeNewVer 桌面包

[English](README.md) | 中文

`dsh-plugin-desktop` 在 Electron 中运行固定版本的 Harness Runtime，同时仍参与普通 Cordis 组合。安装后的产品名称是 **WanCodeNewVer**。`dsh-plugin-desktop` 与 `dsh-desktop` 作为面向运行时的技术兼容标识保留，不代表产品品牌。

## 架构

Electron 可执行文件只包含最小启动代码。它获取单实例锁、解析当前选中的 DSH profile、提供原生运行时能力，并在 Electron main 进程中启动 Host Cordis 根。`desktop-shell` Host 插件通过 Cordis effect 拥有 `BrowserWindow`、导航策略、settings namespace，以及关闭与退出生命周期。原生 runtime 拥有实体托盘，包括 **Open Diagnostics Folder**；`desktop-shell`、`desktop-profiles`、`desktop-terminal`、`desktop-updates` 与 `desktop-relay` 则通过有序 item registry 提供额外的 effect-scoped 命令。`desktop-relay` 默认关闭，从不监听，只有在显式 connect 之后才会拨出站 WSS。启用后，它从该 URL 推导 HTTPS 控制面源，设备注册、令牌签发、设备列表、一次性配对码签发和撤销都走仅出站 HTTP。`connect` 之后签发配对码可用会话令牌代替 OIDC assertion。存在 `desktopRuntime` 时，apply 会注册 effect-scoped 的 **Connect Relay** 与 **Copy Pairing Code** 托盘命令。Connect Relay 在回环上免 OIDC 注册并拨号，接着应用排队的 PWA 邮件。之后签发配对码可用会话令牌。Copy Pairing Code 复制显示格式，通知不含配对码。公网主机失败关闭。没有 runtime 则保持空闲；`inject` 仍为空。本机设备身份只生成一次并写入 Windows Credential Manager；注册与握手只使用公钥。密封的 PWA follow-up 通过 `openSealed` 打开，私钥不会出现在身份对象上。进度事件用 `sealTo` 密封给 PWA。`sealDesktopRelaySessionEvent` 只允许紧凑进度类型，从不密封 prompt 正文。空的接收方加密公钥失败关闭。`sendDesktopRelaySessionEvent` 经出站 socket 推送该密文盒。`connect` 之后 `sendProgress` 走同一路径，未连接则拒绝发送。`sendPresence` 同样密封 online/offline 帧。`drainDesktopRelayMail` 领取排队密文盒、打开它们，并只 ack 排队 id。`processDesktopRelayMail` 先把 follow-up 交给本机提交口，成功后再 ack 排队 id。`createDesktopRelayFollowUpSink` 拒绝不存在的会话 id。会话 id `queue` 会通过 `sessions.create()` 新建 Host 会话再 `prompt(..., 'queue')`，不注入 Host 服务；没有 `create` 仍失败关闭。approval 与 cancel 提交口拒绝不存在的请求 id。`createDesktopRelayApplySinks` 把这三处查找绑在一起。`createDesktopRelayHostApplySinks` 通过 Host `prompt([{ type: 'text', text }], 'queue')` 排队 follow-up，并把 approval 映射为 Host `respond('allowed-once' | 'rejected')`，且不注入 Host 服务。`prepareDesktopRelay` 可带上这些提交口，以便 `processMail` 在 connect 之后直接应用 follow-up。`lookupDesktopRelayHostApplySinks` 探测 `ctx.get('sessions')`，且不增加必填 inject。Host 的 `prompt` / `respond` 与 Client 的 `submit` / `decide` 均可使用。`bindDesktopRelay` 返回该句柄，以便 apply 之后仍可 connect 和 processMail，并由 Host effect 释放。`openDesktopRelaySession` 用已存身份注册、签发令牌并拨号，不暴露私钥。缺少握手 nonce 时用 WebCrypto 生成。`openDesktopRelayMailbox` 接着应用排队的 PWA 邮件。`processMail` 会再次探测，晚到的 Host 会话仍可应用 follow-up。`applyDesktopRelayPayloads` 把 follow-up 交给本机会话提交口，模型凭据留在桌面。approval 与 cancel 帧必须有对应提交口，不会被丢掉。

两种呈现模式都复用现有 loopback Web carrier。profile 挂载普通 `dsh-base` 与 `dsh-web-app` bundle；Host 把 HTTP 与 WebSocket surface 绑定到 `127.0.0.1` 的临时端口；Electron 在沙箱 renderer 中加载该同源页面。Electron 不维护自有插件 roster，不使用 preload bridge，renderer 也不会获得原始 Electron API。

desktop package 拥有普通 Host 与 Web Client 两个 face。它的 Client face 会在两种模式下校验 Host 提供的模式与平台 marker。兼容模式随后只把上游鲸标、空会话英雄标，以及可见的 DeepSeek 产品文案重绘为 WanCodeNewVer，不注册 service、slot 或 layout 呈现；高级模式则安装下文所述的 desktop layout service 与 root 呈现。API 主机名、包名与小写 model id 保持不变。两种模式下，第三方 Web client 都继续使用普通 DSH 模块图。

托盘中的 profile 选择器会列出现有 profile，以及可延迟创建的 `desktop` 与 `web` 默认项。可选 profile 必须直接按顺序组合 `dsh-base` 与 `dsh-web-app`；headless、损坏或已经内嵌 desktop bundle 的 profile 仍会显示，但不可选择。只有 `desktop` 是 Launcher 管理的 profile：它会修复安装方拥有的前缀，同时保留第三方 bundle 的相对顺序。其他被选 profile 的 manifest、用户 patch 与依赖均保持不变。Launcher 只会为当前 generation 在 `dsh-web-app` 后插入自有 desktop layer，不会把该 layer 持久化到被选 bundle 列表。

Profile 选择保存在 Electron user data 下的 desktop 自有状态中，而不是被选 profile 内的另一个字段。切换会先记为 pending，再通过有序重启生效。只有 Cordis 树与原生窗口成功挂载后，新 profile 才会成为 last-known-good；托盘会在 Web surface 加载后才创建，而且该状态提交会在托盘命令能够运行前同步完成。Pending generation 启动失败时会回滚并自动重启一次。官方 profile 默认共用同一个 DSH home 中的 sessions、settings 与 storage，因此切换不会复制或迁移记录；自定义 profile patch 仍可主动重定向其中某个持久化根。

隔离的 WanCodeNewVer home 首次启动且为空时，可以在原生确认后导入现有 `~/.dsh`。拷贝会保留设置、会话、凭据与 profile manifest，跳过插件 `node_modules`，不改动原安装，并拒绝逃出源目录的符号链接。选择「全新开始」会使用私有目录并记住该决定。显式 `DSH_HOME` 仍视为共享 home，不会被这次导入改写。

Launcher 会在 Loader entry 挂载前注册作用于当前 generation 的 `ctx.desktopProfiles` service。其不可变 `current` 值包含激活 profile 的 `name` 与绝对 `dir`；`list()` 只读执行发现，`select(name)` 会串行化“先持久化、再重启”的切换，而不会就地改变当前 generation。该 service 是 Desktop Host capability，不是 renderer bridge，也不是当前上游 DSH 已提供的 active-profile API。

Cordis 的裸插件导入从持久化 profile 解析。一个范围受限的 Node resolve hook 只处理由 `@deepseek-ai/cordis-plugin-loader` 发起的导入，因此即使打包后的 Electron 不暴露 Node 内部 ESM Loader，profile 本地第三方包与修复后的 launcher fallback 仍使用同一条解析路径。

在 profile 准备与 Cordis boot 之前，Launcher 会把只包含固定版本内置 `pnpm` 命令的私有命令目录前置到当前 Electron main 进程的 `PATH`。因此 Host 与第三方插件从启动开始即可发现该 package manager，也可以通过普通 DSH subprocess provider 使用它，而无需系统安装 Node.js。该 ambient path 是兼容 surface，不是正式的插件管理 contract。

`desktop-pnpm` Host row 会提供 `ctx.desktopPnpm`，用于针对不可变激活 profile 执行受管 package operation。`run(args, signal?)` 会在激活 profile 目录中直接执行内置 pnpm；它是低层 operation，不承诺 DSH profile 初始化、调用方相对 source 锚定或 bundle reconcile。`runPlugin(args, invokingDir, signal?)` 则会从调用方绝对目录启动内置的 `dsh plugin --profile <active>`。插件安装、卸载、更新与依赖修复必须使用 `runPlugin()`，使上游 CLI 继续拥有相对 `file:` 与 `link:` spec、pnpm profile working directory、首次初始化，以及成功后 `dsh.profile.bundles` reconcile 的权威语义。

两个方法都会返回实时 stdout 与 stderr stream、在完整 process tree 退出后才 settle 的 `done` promise，以及 `cancel()`。每个 generation 同时最多运行一个 operation。Service 使用普通 DSH subprocess provider、准确的已打包 JavaScript entry、无 shell argv，以及只属于 child 的 DSH home、Electron-backed Node、CI 与 native-module ABI 值。公开 runtime path 仍不会暴露 `node` 或 `dsh`；其中私有 helper、`ELECTRON_RUN_AS_NODE` 与 npm ABI 变量只存在于 package-manager subprocess tree 内。Launcher 不会修改系统 `PATH`、shell 启动文件、profile 配置或 `.env` 文档。

插件作者应遵循 [Desktop 插件 service 架构](docs/plugin-services.zh.md)中记录的受支持 contract import、生命周期规则与适配模式。

## 模式设置与重启边界

DSH home `settings.yaml` 文档中的 `dsh-desktop.mode` 字段是单一事实源：

```yaml
dsh-desktop:
  mode: compatibility # 或 advanced
  updateChannel: stable # 或 beta
```

Launcher 会在组合一个 generation 之前，读取当前 `@deepseek-ai/dsh-settings-file` row 解析到的同一份文件。Host 通过标准 settings service 注册 `dsh-desktop` namespace。呈现模式和更新通道都会在一次有序重启后生效。

用户可以从托盘选择另一种模式，也可以手工编辑 DSH home 中的 `settings.yaml` 文档。托盘会更新已注册的 `dsh-desktop` settings namespace，手工编辑则修改 settings provider 观察的同一文件。修改提交后会请求一次有序重启：先 dispose 当前 Cordis 树，仅当零退出码的 shutdown 成功时才让 Electron relaunch。应用绝不会在存活的 renderer generation 中热切换 root slot、原生窗口材质或 Loader row。

Linux 只支持兼容模式。其托盘模式命令会被禁用，advanced 值会被拒绝，而不会静默降级。

## 兼容模式

`dsh-desktop.mode` 默认为 `compatibility`。该模式创建带有操作系统原生边框的普通窗口，并加载当前 DSH profile 中的官方 Web surface。macOS 会隐藏可见的页面标题。Windows 保留原生标题栏图标并显示 `WanCodeNewVer`，但会移除窗口菜单栏。

desktop Client module 会校验模式与平台 marker，随后把上游鲸标、空会话英雄标，以及可见的 DeepSeek 产品文案重绘为带方框 W 的 WanCodeNewVer 品牌。它不提供或替换 `layout` service，不注册 `root` 或 `sidebar` occupant，也不改动 conversation surface 的组合。兼容模式会保留被选 profile 自身的 layout、sidebar 与 conversation row；普通 `desktop` 与 `web` profile 因而会原样保留官方 Loader row。

Cordis row 会在 profile 激活期间登记原生窗口参数。Launcher 只在 `app-boot` 完成并审计整个 profile 后创建窗口，因此首个 renderer manifest 会包含所有已激活的官方、desktop 与第三方 client plugin，同时插件自身不会在 Loader entry 内等待整棵 Loader tree。

在 Windows 上，Launcher 会固定使用现有 browse 目录选择 backend 与 client surface，而不使用自适应 native chooser。因此 workspace 选择始终在 Web UI 内完成，也不会在 Electron main 进程中加载原生 N-API 对话框 worker。macOS 与 Linux 仍使用上游自适应 chooser。

新的桌面会话默认使用 `read-only` 权限预设：沙箱模式为 `read-only`，审批策略为 `ask`。将 `DSH_PERMISSION_MODE` 设为 `workspace-write` 或 `danger-full-access`，或在 Permissions 选择器中改选其他预设，可以放宽后续会话。未知的 `DSH_PERMISSION_MODE` 会在 profile 组合阶段失败。

在两种呈现模式下，Windows PowerShell 都会保留上游 `pwsh-sandbox` 行为与 Windows ACL confinement。Launcher generation 只会把该 Host provider 替换为同一 package 中的 `dsh-plugin-desktop/windows-pwsh-sandbox` 子路径。对于与上游 ACL runner 完全匹配的 argv，adapter 会让打包后的 Electron executable 通过私有 trampoline 以 Node 模式启动，在创建受限 PowerShell 进程前移除 Node-mode 环境变量，然后把全部 policy 与失败处理重新委托给上游 runner。Desktop deploy root 还会固定一个 Yarn patch，在两条原生受限进程路径上把 `STARTF_USESHOWWINDOW`、现有的 `STARTF_USESTDHANDLES` 与 `SW_HIDE` 组合起来。这会保留已捕获的 stdio 而不抑制 console 分配，并在 Windows 为 GUI Host 启动的 PowerShell 进程创建首个 console 窗口时，请求使用隐藏的初始显示状态。它不会使用与上游实现不兼容的 `CREATE_NO_WINDOW` 或 `CREATE_NEW_CONSOLE` flag。直接使用 `danger-full-access` 的 PowerShell、macOS 与 Linux 执行路径保持不变；Windows confinement 失败时不会自动回退到不受限执行。

## 高级模式

高级模式是为 macOS 与 Windows 显式组合的 desktop 呈现。Launcher 会在读取全部用户 patch 后禁用官方 `ui-layout` Loader row，保持官方 `ui-sidebar` 与 `ui-conversation` row 启用，并把所选模式应用到 `desktop-shell`。

desktop Client 随后在自身 Cordis fiber 生命期内提供 `layout` service，并且只注册 `root` slot occupant。其 root 为不变的上游 sidebar、conversation、details 与 overlay contribution 声明 seat。官方 sidebar 继续作为 `sidebar` occupant，并继续声明 workspace browser、settings shell 与纯新增 footer action seat。这样会保留其组件行为、收起动画与第三方扩展点，而 desktop package 只拥有 frame 几何与原生材质。

高级 theme presenter 会把当前上游 theme snapshot 投影到 document，包括 color scheme、解析后的 token 值、深色模式 marker 与 theme-color metadata。它订阅普通 theme 变化，generation dispose 时只移除由自身投影的状态。

对于高级 generation，Electron adapter 还会在 Host boot 完成后读取已注册的 `ui-theme.preference`，并在创建窗口前把内置 `light`、`dark` 或 `system` 值同步到 Electron 原生外观。窗口存续期间提交的 preference 变化会更新原生材质，dispose 则恢复此前的 Electron 外观。仅存在于 Client 的第三方 theme id 不会改变该 Host preference。

desktop sidebar surface 会把上游 sidebar-fill token 局部设为透明，因此官方 sidebar 与 session 列表渐隐可以透出原生材质，而无需改变其组件样式。

在 macOS 上，高级窗口使用透明 hidden-inset 标题栏、定位后的红黄绿按钮与原生 `sidebar` vibrancy。其 90 CSS 像素收起列会把官方 56 像素 rail 居中放在 desktop 自有的红绿灯顶部 inset 下方。Sidebar surface 本身不可拖动；红绿灯右侧由 desktop 自有的透明 32 CSS 像素条提供窗口拖动目标。Conversation 与 details 完整 surface 上方的 caption row 会保留 20 CSS 像素视觉间距，同时提供另一块透明的 32 CSS 像素拖动命中区域。按钮、链接、输入框、对话框与显式声明 `app-region: no-drag` 的 contribution 仍可交互；放在顶部 32 像素内的自定义 pointer target 也必须声明同一排除规则。在 Windows 上，官方 sidebar 保持兼容模式几何：收起 56 像素、默认展开 280 像素，并沿用相同的上游过渡行为；透明 surface 会透出 Mica。窗口使用带原生控件的隐藏标题栏、透明 overlay、Mica 背景材质、阴影、圆角与粗可调整边框。Electron 仅在 Windows 11 22H2 及以上版本提供由系统绘制的 Mica 材质。Desktop 自有的 32 CSS 像素 caption row 会横跨 Windows 的 conversation 与 details 两列；完整的上游 slot surface 从该行下方开始，因此官方与第三方 Header contribution 会保持原有相对布局，无需针对具体元素设置 caption offset。Linux 会拒绝高级模式，而不会静默降级到与持久化设置不同的呈现。

## 开发

该包由仓库根目录的 Yarn workspace 管理。相邻的 `deepseek-harness/` checkout 仍是独立的上游 pnpm 项目，不属于 Yarn workspace。请从仓库根目录安装并验证 Wancode：

```sh
yarn install
yarn check
```

该检查会验证生产依赖图中的每个必需第一方 peer 都由 desktop deploy root 声明。Headless Loader smoke 会激活 launcher 拥有的 desktop row 与 profile 本地第三方 row，然后启动已发布 Web profile 并检查其 loopback 根页面与 client manifest。单元和类型测试覆盖两种 profile 组合、重启栅栏、client environment 校验、desktop layout 状态与各平台原生窗口选项。

有图形会话时，显式启动桌面应用：

```sh
yarn dev
```

`dev` 会在启动前自动构建，不需要另行手动构建。

以下 headless-safe 启动器入口不会导入或启动 Electron：

```sh
node lib/bin.js --help
node lib/bin.js --version
```

## 插件工作流

使用普通 DSH 命令管理任意 profile：

```sh
dsh plugin --profile desktop add third-party-plugin
dsh plugin --profile desktop remove third-party-plugin
dsh plugin --profile desktop update
```

应用默认使用 `desktop`。可以在托盘的 **Profile** 子菜单中选择其他 Web-capable profile；切换时应用会重启。生成的 DSH 终端会让裸命令默认作用于当前激活 profile，因此以下短命令可以直接修改它：

```sh
dsh plugin add third-party-plugin
dsh plugin remove third-party-plugin
dsh plugin update
```

显式 `--profile <name>` 始终具有更高优先级，可用于在切换前准备其他 profile。

`dshmarket@1.2.3` 尚未预装，也不是 DSH Desktop 的 dependency。该版本仍从 config/argv 解析 profile，并通过私有 child-process 代码启动 `dsh plugin`；它既不读取 `desktopProfiles`，也不使用 `desktopPnpm`，package exports 也没有 runner injection seam。后续兼容版本必须动态探测 Desktop service，同时在普通 DSH 中保留现有 CLI fallback。此外，`1.2.3` 的源码仓库与 npm tarball 均未包含完整 MIT 许可文本或版权通知，因此该版本尚未通过内置再分发 gate。用户主动安装第三方 package 与 Desktop 将其嵌入 application archive 或 installer 是两个独立边界。

Required injection、可选 Desktop 适配、TypeScript 示例、cancellation 与 fallback 指南详见[面向插件作者的 service 文档](docs/plugin-services.zh.md)。

随后可以通过 npm 启动该包：

```sh
npx dsh-plugin-desktop
```

## 命令行启动

该包安装两个等价命令 `dsh-desktop` 与 `dsh-plugin-desktop`。无参数调用时，两者都会启动打包的 Electron launcher（`lib/main.js`）。

- **全局安装** —— `npm install -g dsh-plugin-desktop` 会自动安装 `electron` peer，之后直接执行 `dsh-desktop` 即可基于默认 DSH home 启动应用：
  ```sh
  dsh-desktop
  ```
- **在 profile 内** —— `dsh plugin --profile <name> add dsh-plugin-desktop` 后，命令位于该 profile 的 `node_modules/.bin`。pnpm 不会自动安装 `electron` peer；需要命令行启动时，请手动添加：
  ```sh
  dsh plugin --profile <name> add electron
  ```
  原生构建许可（node-pty、koffi、electron 等）遵循 pnpm 常规的 `allowBuilds` 规则。
- **缺少 electron** —— 命令会打印简短的安装指引，而不是抛出模块错误。

如果用普通 `dsh` 命令直接启动一个组合了桌面壳的 profile（缺少 launcher 的 `desktopRuntime` service），会打印提示，告诉你用 `dsh-desktop` 或打包版应用启动；此时桌面壳不会注册任何功能。

第三方 Host 插件只需提供普通 `dsh.bundle` patch。包含浏览器 UI 的插件还要发布普通 `dsh.client` 元数据，将 `platform` 设为 `"web"`，并导出 `./client` 产物。上游 Web 客户端模块图会在两种模式下发现它；Electron 不要求单独的客户端构建，也不引入 desktop 专用注册 API。高级模式 contribution 必须面向该显式组合中存在的 service 与 slot，不能假设官方 layout 或 sidebar occupant 拥有它们。

## 桌面操作

打包后的 macOS 与 Windows 应用会从 GitHub 的 `ThomasWan123/wancode-NewVer` 查询所选 stable 或 beta 更新流。只有与 GitHub Release 元数据一致的规范 `v<semver>` tag 会被接受；后台网络、HTTP、超时、无效响应、相同版本和旧版本结果保持静默。开发运行、未打包启动与 Linux 不会下载安装包。

选择 **Download** 后，Wancode 会先持久化回滚转换，再请求该 GitHub Release 中名称固定的安装包，并把不超过 1 GiB 的文件流式写入私有版本目录。Windows 安装器必须通过 PE 和 Authenticode 信任校验后才允许打开。目标版本必须在 30 秒内报告 Host 与 Renderer 的终态健康结果；启动失败或超时会触发一次防循环的 Windows 自动恢复：旧安装包会重新下载、重新校验，并在不再次弹出确认框的情况下启动。健康启动后仍保留需确认的托盘回退；自动下载失败也可从托盘手动重试，旧版本成功启动后会清除转换记录。**Restart and Install** 会在退出前请求 Cordis 有序 teardown。

Release operator 必须先上传名称完全匹配的 Wancode 产物，再发布 GitHub Release。缺少对应产物的 Release 会在下载阶段安全失败。

在 macOS 与 Windows 上，**Open Wancode Terminal** 会打开以当前激活 profile 为工作目录的系统终端。欢迎信息显示 Wancode 版本、当前 profile、profile 目录与 Harness home。私有 `dsh`、`pnpm` 与 `node` 兼容 shim 只作用于该终端，不修改系统 `PATH`。

## 原生生命周期

关闭窗口会隐藏窗口，Host Cordis 树继续运行。托盘可以重新打开窗口、打开诊断目录、选择激活 profile、打开隔离的 DSH 终端、检查 stable release、通过标准 settings namespace 更改模式，或请求显式退出。Renderer 崩溃时会提供重新加载、打开诊断或重启，而不会先拆掉 Host。Profile 与模式切换都会先 dispose 当前 Cordis 树，再让 Electron relaunch。原生退出、`SIGINT` 与 `SIGTERM` 也会在退出前请求 dispose；超过五秒或收到重复请求时会强制完成最终退出。导航与重定向被限制在确切的 loopback origin；外部 HTTP、HTTPS 与邮件链接由操作系统打开；renderer 启用 `contextIsolation` 与 Chromium sandbox，并关闭 Node integration。打包启动还会把 stdout 与 stderr 镜像到 Electron user data 下的 `logs/wancode.log`，因此 GUI 进程仍然保有本地诊断文件。

## 打包

`yarn package:dir` 为当前宿主平台创建未封装目录。如果应用归档缺少 desktop 更新与终端模块、DSH CLI bootstrap、内置 pnpm 入口或物理 deployment package，packaged-runtime gate 会拒绝该产物。Electron Builder 会把根 manifest、desktop runtime 与完整依赖树输出到 `app.asar.unpacked`；Host profile boot 与 CLI bootstrap 都会使用这棵物理树，因此 DSH profile fallback 的符号链接不会指向虚拟 ASAR 目录。`build/app-icon.svg` 是方框 W 标志。构建过程会把它栅格化为 Windows 与 Linux 使用的 `build/app-icon.png`，再运行 `scripts/generate-mac-app-icon.mjs`，把该图缩放为 824 × 824 像素并居中放入透明的 1024 × 1024 画布；macOS 打包与运行中的 Dock 都使用生成的 `build/app-icon-mac.png`。`build/tray-icon.svg` 是同一套品牌蓝方框 W：构建过程会派生由 macOS 系统自动着色的模板图，以及固定品牌蓝的 Windows 与 Linux 托盘图。高级侧栏会把上游鲸标替换为方框 W 和 WanCodeNewVer 名称。

### Windows x64 本地安装包

请使用原生 Windows x64 电脑，并安装 Git 与 x64 Node `22.23.2`（与 CI 使用的版本相同）。打包命令接受官方发行版仍包含所需 Corepack 命令的 Node `22.19+` 与 Node `24.x`。在一个最新的 `v2` checkout 中打开 PowerShell，然后执行：

```powershell
git submodule update --init --recursive
corepack.cmd yarn install --immutable
corepack.cmd yarn dist:win
```

该流程不要求 Python 或 Visual Studio C++ Build Tools。Windows 命令会直接使用 `node-pty` 内置的 x64 Node-API 二进制，而不会让 Electron Builder 从源码重新编译；如果安装包 staging tree 缺少这些二进制，packaged-runtime gate 会直接拒绝产物。

`dist:win` 会拒绝非 Windows 或非 x64 宿主，执行 Windows 聚焦 gate 与 runtime-closure verifier，再构建 NSIS 测试安装包。版本 `2.0.1` 输出到 `dsh-plugin-desktop\dist\WanCodeNewVer-2.0.1-x64-Setup.exe`；未封装程序位于 `dsh-plugin-desktop\dist\win-unpacked\WanCodeNewVer.exe`。

该本地命令会主动移除 Windows 证书变量。正式发布使用 `dist:win-release`，要求提供代码签名证书和 `WANCODE_WINDOWS_PUBLISHER`，并验证应用与 NSIS 安装器由同一受信证书签名。

签名发布门禁必须运行在一次性的 Windows runner 上，因为安装过程会修改注册表状态。设置 `WANCODE_WINDOWS_LIFECYCLE_DISPOSABLE=1`、`WANCODE_PREVIOUS_WINDOWS_INSTALLER` 和 `WANCODE_PREVIOUS_WINDOWS_VERSION`，指向一个更旧且受信的版本。`WANCODE_WINDOWS_TRUSTED_THUMBPRINTS` 必须列出允许的 SHA-1 证书指纹；有计划地轮换证书时可用逗号同时列出新旧证书。门禁会按允许的证书集合验证旧安装器、新安装器、已安装应用和卸载器，并依次执行安装、升级、回滚、恢复当前版本和卸载；任一转换失败都会关闭发布并尝试清理，同时拒绝残留的安装目录、卸载注册表值和标准快捷方式。

### macOS DMG 冒烟构建

`yarn dist:mac-smoke` 会在原生 macOS 宿主机上构建一个未签名的 universal DMG，同一个安装包可以在 Intel 和 Apple Silicon Mac 上原生运行。该命令拒绝非 macOS 宿主，先执行一组 macOS 可运行的 gate（build、全部 TypeScript compiler face、打包与 macOS 聚焦测试、runtime-closure verifier），再在不接触任何签名材料的情况下打包。它会挂载 DMG，检查属性列表、主程序执行权限、`x86_64` 与 `arm64` 两个架构切片，以及 `app.asar`。该命令与 `dist:win` 的密钥纪律一致：剥离 Electron Builder 能识别的全部 macOS 签名与公证变量、设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`、关闭 notarization，且从不发布。产物没有 Developer ID 签名，因此 Gatekeeper 会在其他机器上拦截它；它的存在是为了让打包回归在人工发布之前就在 CI 中失败。签名并公证的 universal 正式发布仍是在持有凭证的 macOS 机器上执行 `yarn dist:mac`，产物写入 `dsh-plugin-desktop/dist/mac-release/`。

## 模型体验

无。desktop package 只改变应用组合与原生呈现，不增加任何模型可见的指令、工具、事件或请求字段。

#### KV Cache 影响

无。模型请求仍由同一套 DSH Host 与 client feature plugin 组装。

## 已知限制与暂缓事项

- 添加或删除 profile bundle 后必须重启 DSH Desktop；Launcher 不监听 profile manifest。从托盘选择其他 profile 时会自动完成该重启。
- 切换 compatibility/advanced 模式按设计必然重启应用；存活的 generation 不会热切换 Loader row、slot 所有权或原生材质。
- Linux 不支持高级模式。Linux 继续使用兼容呈现。
- macOS 与 Windows 托盘终端会提供私有 `dsh`、`pnpm` 与 `node` shim。除此之外，Host runtime 会在当前 Electron 进程的 `PATH` 中公开内置 `pnpm` 命令作为 ambient compatibility，并提供受管 `desktopPnpm` service；这些命令都不会加入系统 `PATH`，Linux 目前也没有 desktop 终端命令。
- 在 Windows 上，ambient `pnpm` 命令与 lifecycle Node helper 是 `.cmd` shim。`desktopPnpm.run()` 与 `runPlugin()` 会启动准确的已打包 entry，从而避免 manager process 的 shell lookup；上游 `dsh plugin`、PowerShell 与命令提示符则可通过 command interpreter 解析 ambient shim。第三方插件直接调用 Node `spawn('pnpm', { shell: false })`，或 lifecycle script 直接以 `shell: false` 执行其 `.cmd` `npm_node_execpath`，仍属于不可移植行为，应改用受管 service 或 shell-aware 启动路径。
- `dshmarket@1.2.3` 仍是用户可选安装的第三方 package，而不是内置 marketplace。只有重新审计的版本同时消费可选 Desktop service、保留普通 DSH fallback，并包含再分发所需的完整 license notice 后，才会重新评估预装。
- Windows 更新交接会验证 PE 与 Authenticode 信任；发布门禁负责校验预期 publisher 与证书一致性。运行时 publisher 固定与 SmartScreen 信誉仍在推进。
- 共享 carrier 使用 loopback HTTP 与 WebSocket，而不是 Electron IPC。替换它需要上游 DSH 提供 transport 扩展点，不属于该独立包的范围。
- 该项目目前固定使用已发布的 DSH `0.1.0-rc.6` family，而相邻的 `deepseek-harness/` 源码 checkout 早于该版本。因此，测试验证的是已发布包接口，而非上游未发布源码。
- `package:dir` 是用于 smoke 的未封装产物。`dist:win` 会额外生成未签名的 NSIS 测试安装包，但不会建立 Authenticode 身份或 SmartScreen 信誉。安装与升级行为、原生通知与终端、Windows ACL sandbox，以及每台目标机器上的原生材质外观仍属于目标平台验证边界。
