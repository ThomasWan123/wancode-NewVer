# @wancode/relay-protocol

[English](README.md)

Wan Code Cloud Relay（M2）的 fail-closed 远程控制契约和仅出站 WebSocket
客户端。本包用短期令牌和已注册设备授权版本化 envelope，只接受桌面签名的
**出站**握手来打开会话，并由桌面主动拨 Relay。它不在公网接口上监听、不保存
明文 prompt，也不声明 DeepSeek Harness 插件入口。

## 保证

- 未知协议版本、损坏 envelope，以及明文 `prompt` / `credential` /
  `toolOutput` 字段会在路由前被拒绝。
- 过期令牌、已撤销设备和跨账号 actor 一律失败关闭。
- 相同消息 id 且载荷不变时幂等；载荷被改写则视为重放并拒绝。
- 设备身份是 Ed25519 密钥对。私钥不会出现在 handshake 或 ack ciphertext 中。
- 握手必须声明 `direction: "outbound"`，并对照已注册设备公钥验签。入站声明、
  不可信签名、未知 capability 和重复 nonce 一律失败关闭。
- 生产 Relay URL 必须使用 `wss:`。明文 `ws:` 只允许回环地址。访问令牌放在首个
  JSON 帧里，而不是查询参数。
- 短期访问令牌在可替换 OIDC 身份提供方验证账号后按设备签发。静态提供方是后续
  JWKS 工厂的接缝。过期断言和令牌一律失败关闭。
- 设备注册把一把 Ed25519 公钥绑定到该账号。撤销立即生效，设备 id 不可复用。
- 路由只把已授权 envelope 送到同一账号下的另一台设备。跨账号目的地一律失败
  关闭。首次接受会占用每设备速率配额，相同重试不占用。审计记录不含 prompt、
  credential、tool-output 或 ciphertext 字段。

桌面用 `connectOutboundRelay` 主动发起云连接。本包不是入站 Host surface。
`@wancode/relay-protocol/loopback` 只用于 `127.0.0.1` 测试接收端，不在默认
导出中。桌面 Host 默认关闭 `dsh-plugin-desktop/relay`，并把该拨号器打包进
桌面包，不使用 Yarn workspace 链接。
