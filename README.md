<p align="center">
  <img src="dsh-plugin-desktop/build/app-icon.png" width="96" height="96" alt="Wan Code">
</p>

<h1 align="center">Wan Code</h1>

<p align="center">
  <strong>Windows 优先、本地优先的 Coding Agent 桌面产品</strong><br>
  以固定版本的 DeepSeek Harness 作为 Agent 运行时，由 Wan Code 负责桌面体验、安全边界、更新与后续远程控制。
</p>

<p align="center">
  <a href="https://github.com/ThomasWan123/wancode-NewVer/actions/workflows/ci.yml"><img src="https://github.com/ThomasWan123/wancode-NewVer/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-22.19%2B%20%7C%2024.x-brightgreen.svg" alt="Node.js"></a>
</p>

<p align="center">
  <a href="README.en.md">English</a>
  ·
  <a href="docs/WANCODE_REMAKE_PLAN.md">开发计划</a>
  ·
  <a href="docs/adr/0001-product-runtime-separation.md">架构决策</a>
  ·
  <a href="UPSTREAM.md">上游策略</a>
  ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

> Wan Code 是独立社区产品，不是 DeepSeek 官方应用。DeepSeek Harness 是署名保留的上游开源运行时，不是本产品名称。

## 产品定位

Wan Code 在本机运行 Harness Host，并在沙箱 Electron 窗口中呈现官方 Web 界面。云端不能打开用户机器上的入站端口，也不能直接执行本机工具或读取模型凭据。后续远程控制只允许桌面主动发起的出站连接，敏感载荷使用设备密钥端到端加密。

```text
Wan Code Desktop ──loopback──> Harness Host ──> Cordis plugins / tools
       │
       └── outbound encrypted WSS ──> Wan Code Relay <──> Mobile PWA / Channels
```

## 当前能力

| 范围 | 状态 |
| --- | --- |
| Windows 桌面核心（M1） | **可用**：身份、隔离数据、凭据、更新、回退、崩溃恢复 |
| 本地测试安装包 | **可用**：`yarn dist:win` 生成未签名 NSIS 包 |
| 签名正式发布 | **延后**：等待代码签名证书与受信旧版安装包 |
| 云中继协议（M2） | **进行中**：fail-closed 契约、OIDC 接缝、仅出站 WSS、路由、速率限制、审计与桌面 opt-in 拨号 |
| 移动 PWA、插件市场、消息渠道 | 路线图，尚未作为可用功能发布 |

桌面 `master` 现已包含：

- 原生产品身份：应用名、窗口、安装器、快捷方式与 GitHub 更新地址
- 仅监听 `127.0.0.1` 的本地 Host；Renderer 启用 Chromium sandbox、上下文隔离，并禁止 Node 集成
- 独立的 Electron user-data 目录；首次启动可选择从 `~/.dsh` 拷贝设置、会话与凭据，源目录保持不变
- 默认关闭上游遥测；新会话默认 `read-only` 权限预设
- 模型密钥写入 Windows Credential Manager，并在安全写入成功后删除旧的明文 `.credentials.yaml`
- 从本仓库 GitHub Releases 下载更新；Windows 安装器必须通过 PE 与 Authenticode 信任校验
- Stable / Beta 通道、确认后回退，以及一次健康检查失败后的自动 Windows 恢复
- Renderer 崩溃恢复、托盘「打开诊断目录」，以及 `logs/wancode.log`

Windows 聚焦门禁覆盖 236 项桌面测试，外加完整运行时依赖闭包。尚未交付的能力会写在路线图中，不会写成已经可用。

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `deepseek-harness/` | 只读、固定版本的官方上游 Git 子模块 |
| `dsh-plugin-desktop/` | Electron、Host/Client 插件、Windows 安全与打包 |
| `packages/wancode/` | Wan Code 自有协议与云模块；当前为 relay 契约与仅出站客户端 |
| `dsh-community-fabric/` | 社区互操作规范（文档骨架，不可加载） |
| `dsh-community-market/` | 审核制插件市场契约（文档骨架，不可加载） |

自有模块只消费已发布的 Harness 接口，不修改子模块。

## 从源码验证

要求 Windows x64、Git，以及 Node.js `22.19+` 或 `24.x`。

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

正式签名发布使用 `dist:win-release`，需要代码签名证书和 `WANCODE_WINDOWS_PUBLISHER`。仓库不会提供或提交任何签名密钥。

## 路线图

1. **Windows 桌面核心** — 已作为可独立使用的本地产品交付；签名正式包待证书。
2. **Wan Code Cloud Relay** — 账号、设备注册、短期令牌、撤销、审计与端到端加密协议。
3. **移动 PWA** — 查看会话、发送后续指令、审批工具、取消任务与通知。
4. **审核制插件市场** — 签名 Manifest、权限声明、兼容性检查、原子安装与回滚。
5. **消息渠道** — 通过官方 API 接入飞书、Discord、WhatsApp，以及合规可用的微信能力。

完整里程碑与退出条件见 [`docs/WANCODE_REMAKE_PLAN.md`](docs/WANCODE_REMAKE_PLAN.md)。

## 文档

- [架构决策 ADR-0001](docs/adr/0001-product-runtime-separation.md)
- [上游固定与更新策略](UPSTREAM.md)
- [桌面包装说明](dsh-plugin-desktop/README.zh.md)
- [参与贡献](CONTRIBUTING.md)

## 许可证

Wan Code 自有代码遵循 [MIT License](LICENSE)，并保留 DeepSeek Harness、Cordis 及第三方组件的许可证与署名。问题请提交到 [GitHub Issues](https://github.com/ThomasWan123/wancode-NewVer/issues)。
