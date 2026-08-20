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
- 设备身份是 Ed25519 签名密钥对，外加一把 X25519 加密密钥。私钥不会出现在
  handshake、ack 或密封 ciphertext 中。安全存储可以保存含私钥的身份 blob；
  `publicDeviceIdentity` 不含私钥，公钥与私钥不匹配一律失败关闭。
- 应用层的 prompt、approval、cancel、session-event 和 presence 帧会按目的设备
  加密公钥密封。空 envelope id 会在加密前失败关闭。Relay 只保存密文盒；错误
  设备密钥和 handshake ciphertext 一律失败关闭。
- 握手必须声明 `direction: "outbound"`，并对照已注册设备公钥验签。入站声明、
  不可信签名、未知 capability 和重复 nonce 一律失败关闭。
  `createRelayHandshakeNonce` 使用 WebCrypto，因此 PWA 握手不必导入 `node:crypto`。
- 生产 Relay URL 必须使用 `wss:`。明文 `ws:` 只允许回环地址。访问令牌放在首个
  JSON 帧里，而不是查询参数。握手之后同一条 socket 可发送密封应用帧、领取本机
  邮箱并确认已拉取的密文盒。reclaim 和 ack 的设备 id 来自令牌，从不由客户端
  指定。在线目的设备会在自己的出站 socket 上收到密封推送；loopback 接收端不会
  打开密文盒。离线目的地排队同一密封盒。socket 关闭时把握手设备标为离线。
- 短期访问令牌在可替换 OIDC 身份提供方验证账号后按设备签发。JWKS 提供方只接受
  调用方提供的密钥集上的紧凑 ES256 / RS256 JWT。`fetchOidcJwks` 可通过 HTTPS
  （或回环 HTTP）加载该密钥集；重定向会再次按同一 URL 策略检查，请求从不携带
  凭据。静态提供方仍是对象形态的测试替身。过期断言、未知 kid，以及 `none` /
  HMAC 算法一律失败关闭。
- 设备注册把一把 Ed25519 公钥绑定到该账号。撤销立即生效，设备 id 不可复用。
- 路由只把密封的应用 envelope 送到同一账号下的另一台设备。不密封的 prompt
  ciphertext 和 handshake 帧不会进入路由。跨账号目的地一律失败关闭。首次接受
  会占用每设备速率配额，相同重试不占用。审计记录不含 prompt、credential、
  tool-output 或 ciphertext 字段。
- 离线目的地排队同一密封盒。重连设备会重复拉取同一邮箱，直到逐条确认。
  已撤销、过期和跨账号的 reclaim 一律失败关闭，并丢弃剩余邮件。

桌面用 `connectOutboundRelay` 主动发起云连接。握手之前，同一默认导出可通过
HTTPS（或回环 HTTP）调用 `registerOutboundRelayDevice`、
`issueOutboundRelayToken`、`listOutboundRelayDevices` 和
`revokeOutboundRelayDevice`。设备列表走 POST `/v1/devices/list`，断言放在请求
体里，从不放在查询字符串。只返回当前账号下未撤销的设备，不含私钥。重定向会
再次按同一 URL 策略检查，请求从不携带凭据，私钥一律拒绝。本包不是入站 Host surface。
`@wancode/relay-protocol/loopback` 只用于 `127.0.0.1` 测试接收端。
`@wancode/relay-protocol/cloud` 在回环地址上提供设备注册、令牌签发和同一套
出站 WebSocket 接收端；非回环绑定一律失败关闭，且不在默认导出中。桌面 Host
默认关闭 `dsh-plugin-desktop/relay`，并把该拨号器打包进桌面包，不使用 Yarn
workspace 链接。启用后，插件从 WebSocket URL 推导 HTTPS 控制面源，先通过出站
HTTP 注册、签发令牌、列出同一账号设备或撤销，再在 `connect` 时打开 socket。
`createStoredDeviceIdentity` 把 Ed25519 与 X25519 密钥对编码进安全存储。
公开视图不含私钥；被改写的公钥一律失败关闭。
