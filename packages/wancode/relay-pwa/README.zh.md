# @wancode/relay-pwa

[English](README.md)

Wan Code Cloud Relay（M3）的移动配对与会话投影。本包让 PWA 设备通过仅出站
HTTPS 注册、拨出站 WSS、列出同一账号下的桌面，并向选定桌面发送密封
follow-up、approval 与 cancel。它能 drain 重连邮箱、把流式进度折成会话快照，
并发布独立 Web App Manifest；缓存策略从不保存令牌。它不在公网接口上监听、
不声明 DeepSeek Harness 插件入口，也不保存模型凭据。模型密钥留在桌面。

本包不对 `@wancode/relay-protocol` 声明 Yarn `workspace:` 依赖。测试与源码用
相对路径引用该契约，因为当前检出所在卷无法创建 workspace 目录链接。

## 保证

- `projectRelaySessionView` 把已打开的应用载荷映射为与 UI 无关的投影。prompt
  正文会被省略，避免日志和快照泄漏。
- 模型凭据字段名（`DEEPSEEK_API_KEY`、`apiKey` 以及共用的明文 envelope 字段）
  会在配对或发送前失败关闭。PWA JSON 上的设备私钥同样失败关闭。
- `createPwaRelayController` 会注册 PWA 设备、签发短期令牌并拨 Relay。桌面可
  稍后通过 `listDesktops` / `selectDesktop` 选择。已撤销桌面不会出现。follow-up、approval 和
  cancel 按该桌面加密公钥密封。presence 帧同样密封。follow-up 正文必填且有上限，
  避免低带宽链路被撑爆。关闭后的会话在 `reconnect` 之前拒绝 send 和 drain。
  `listDesktops` 走仅出站 HTTPS，关闭后仍可用。`drain` 领取排队邮件和在线推送，只 ack 排队
  id。`reconnect` 使用新 nonce，避免握手被当成重放。`revoke` 关闭 socket 并立即
  撤销该 PWA 设备 id。返回对象不含私钥。
- `createPwaSessionBoard` 把视图折成每个会话一份快照。prompt 正文不会出现。
  `notify.*` 进度成为最新通知。`assistant.done` 与 `session.complete` 会把快照
  标为 complete。
- `createPwaWebManifest` 返回 `display: standalone` 且 `start_url` 为相对路径
  的安装记录。`decidePwaCacheAction` 只缓存 shell GET 资源；令牌查询参数和
  模型凭据失败关闭。控制面 POST 保持 network-only。
  `createPwaServiceWorkerSource` 生成对应的 worker 源码，从不监听。
  `createPwaShellFiles` 返回 `index.html`、manifest 和 `sw.js`。
  `createPwaShellIcons` 返回 192 与 512 PNG。检入的副本在 `public/`，必须与
  生成器一致。`@wancode/relay-pwa/host` 只在 127.0.0.1 上托管该 shell，公网
  绑定失败关闭，且不在默认导出中。
- 默认导出没有监听器，也没有 loopback/cloud 接收端。

这还不是公网上已交付的 iOS / Android 安装。图形界面启动保持显式。
