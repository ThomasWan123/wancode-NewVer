# Wan Code

Wan Code 是面向 Windows 的本地优先 Coding Agent 桌面产品。它以固定版本的
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 作为底层
Agent 运行时，并由 Wan Code 自己负责桌面体验、安全边界、更新、远程控制和
插件生态。

> Wan Code 是独立社区产品，不是 DeepSeek 官方应用。DeepSeek Harness 是
> Wan Code 使用并保留署名的上游开源运行时，不是本产品名称。

[English](README.en.md) · [开发计划](docs/WANCODE_REMAKE_PLAN.md) ·
[架构决策](docs/adr/0001-product-runtime-separation.md) ·
[上游策略](UPSTREAM.md)

## 当前状态

项目正在按 Windows-first 路线开发。当前 `master` 已具备：

- **Wan Code 原生身份**：应用名、窗口、安装器、快捷方式和 GitHub 更新地址
  正在统一迁移到 Wan Code。
- **本地 Harness Host**：Host 仅监听 `127.0.0.1`，Electron Renderer 启用
  Chromium sandbox、上下文隔离，并禁止 Node 集成。
- **数据隔离**：默认数据目录位于 Wan Code 的 Electron user-data 下，不会与
  用户现有的 `~/.dsh` 自动混用。
- **隐私默认值**：上游遥测默认关闭，用户显式配置仍然优先。
- **Windows 安全凭据**：模型密钥写入 Windows Credential Manager；首次启动
  可迁移并删除旧的明文 `.credentials.yaml`。
- **安全更新**：从
  [`ThomasWan123/wancode-NewVer`](https://github.com/ThomasWan123/wancode-NewVer/releases)
  获取版本和安装包，Windows 安装器必须通过 PE 与 Authenticode 信任校验。
- **Stable / Beta 通道**：在桌面设置中选择更新流；切换后有序重启，并保留
  已提示版本记录。
- **版本回退**：启动更新安装器前持久化版本转换；新版本启动后可从托盘确认
  回退，旧版本安装包会重新下载并再次执行平台校验。
- **签名发布门禁**：正式 Windows 构建要求证书和预期发布者，并验证应用与
  NSIS 安装器由同一证书签名。
- **插件化桌面能力**：窗口、托盘、Profile、终端和更新仍通过 Cordis/DSH
  插件组合，不修改固定的 Harness 子模块。

Windows 聚焦门禁当前覆盖 133 项测试和完整运行时依赖闭包。尚未发布的功能会
明确标注为路线图，不会伪装成已经可用。

## 产品路线

1. **Windows 桌面核心**：安装、首次运行、模型配置、任务执行、会话恢复、
   签名更新、回滚和卸载。
2. **Wan Code Cloud Relay**：账号、设备注册、短期令牌、撤销、审计和端到端
   加密远程协议。
3. **移动 PWA**：查看会话、发送后续指令、审批工具、取消任务和接收通知。
4. **审核制插件市场**：签名 Manifest、权限声明、兼容性检查、原子安装与回滚。
5. **消息渠道**：通过官方 API 接入飞书、Discord、WhatsApp，以及合规可用的
   微信能力。

完整里程碑、退出条件与风险控制见
[`docs/WANCODE_REMAKE_PLAN.md`](docs/WANCODE_REMAKE_PLAN.md)。

## 架构边界

```text
Wan Code Desktop ──loopback──> Harness Host ──> Cordis plugins / tools
       │
       └── outbound encrypted WSS ──> Wan Code Relay <──> Mobile PWA / Channels
```

- `deepseek-harness/`：只读、固定版本的官方上游 Git 子模块。
- `dsh-plugin-desktop/`：Wan Code Electron、Host/Client 插件、Windows 安全与
  打包代码。
- `dsh-community-fabric/`：社区互操作规范。
- `dsh-community-market/`：审核制插件市场的文档与契约骨架。
- 后续 Wan Code 协议、Relay 和 PWA 模块位于 `packages/wancode/` 或 `apps/`。

云端不能直接执行本机工具，也不能读取本机模型凭据。远程请求必须指向明确的
用户、设备和会话，并保持幂等；敏感载荷使用设备密钥端到端加密。

## 从源码验证

要求 Windows x64、Git，以及 Node.js `22.19+` 或 `24.x`：

```powershell
git clone --recurse-submodules https://github.com/ThomasWan123/wancode-NewVer.git
cd wancode-NewVer
corepack yarn install --immutable
corepack yarn check:layout
corepack yarn workspace dsh-plugin-desktop check:win-package
```

显式启动图形应用：

```powershell
corepack yarn dev
```

构建未签名的本地测试安装包：

```powershell
corepack yarn dist:win
```

正式签名发布使用 `dist:win-release`，并要求代码签名证书以及
`WANCODE_WINDOWS_PUBLISHER`。仓库不会提供或提交任何签名密钥。发布门禁还要求
一个更旧且受信的安装包，并在明确标记为一次性的 Windows runner 上完成安装、
升级、回滚、恢复和卸载验证。

## 上游与许可证

Wan Code 保留 DeepSeek Harness、Cordis 及所有第三方组件的许可证与署名。
Wan Code 自有代码和仓库内容遵循 [MIT License](LICENSE)。上游来源、固定策略和
更新流程见 [`UPSTREAM.md`](UPSTREAM.md)。

问题与建议请提交到
[GitHub Issues](https://github.com/ThomasWan123/wancode-NewVer/issues)。
