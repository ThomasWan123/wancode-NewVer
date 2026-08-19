# @wancode/relay-pwa

[English](README.md)

Wan Code Cloud Relay（M3）的移动配对与会话投影。本包让 PWA 设备通过仅出站
HTTPS 注册、拨出站 WSS、列出同一账号下的桌面，并向选定桌面发送密封
follow-up、approval 与 cancel。它能 drain 重连邮箱，并把 `notify.*` 事件投影
为通知，不含 prompt 正文。它不在公网接口上监听、不声明 DeepSeek Harness
插件入口，也不保存模型凭据。模型密钥留在桌面。

本包不对 `@wancode/relay-protocol` 声明 Yarn `workspace:` 依赖。测试与源码用
相对路径引用该契约，因为当前检出所在卷无法创建 workspace 目录链接。

## 保证

- `projectRelaySessionView` 把已打开的应用载荷映射为与 UI 无关的投影。prompt
  正文会被省略，避免日志和快照泄漏。
- 模型凭据字段名（`DEEPSEEK_API_KEY`、`apiKey` 以及共用的明文 envelope 字段）
  会在配对或发送前失败关闭。
- `createPwaRelayController` 会注册 PWA 设备、签发短期令牌并拨 Relay。桌面可
  稍后通过 `listDesktops` / `selectDesktop` 选择。follow-up、approval 和
  cancel 按该桌面加密公钥密封。`drain` 领取排队邮件和在线推送，只 ack 排队
  id。`reconnect` 使用新 nonce，避免握手被当成重放。返回对象不含私钥。
- 默认导出没有监听器，也没有 loopback/cloud 接收端。

这还不是可安装的 iOS / Android PWA。图形界面启动不在无头配对契约范围内。
