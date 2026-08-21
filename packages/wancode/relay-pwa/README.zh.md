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
  正文会被省略，避免日志和快照泄漏。进度详情有上限，避免低带宽链路被撑爆。
  空 session id 失败关闭，避免快照把无关事件折到一起。空 approval / cancel
  request id 同样失败关闭。
- 模型凭据字段名（`DEEPSEEK_API_KEY`、`apiKey` 以及共用的明文 envelope 字段）
  会在配对或发送前失败关闭。PWA JSON 上的设备私钥同样失败关闭。
- `createPwaRelayController` 会注册 PWA 设备、签发短期令牌并拨 Relay。省略 `url`
  时从 `httpUrl` 推导。HTTP 与 WebSocket origin 不一致则失败关闭。
  `openPwaRelayFromOrigin` 记住 origin、加载 IndexedDB 身份，然后注册并拨号。
  `openPwaRelayFromPairingCode` 兑换桌面签发的一次性配对码，不发送 OIDC assertion。
  `rememberPwaSelectedDesktop` 只保存公开的桌面 id 与加密公钥。
  配对若提供 `sessionStorage`，`selectDesktop` 会写入该槽。
  `forgetPwaSelectedDesktop` 清除该槽，不动 IndexedDB 身份。
  `forgetPwaPairingOrigin` 清除 origin 槽。`unpairPwaRelay` 立即撤销 PWA 设备
  并忘掉所选桌面和 origin。配对码会话用兑换得到的访问令牌列出并撤销设备；该令牌
  只能撤销自身。
  公网 HTTP origin 会在注册前失败关闭。桌面可
  稍后通过 `listDesktops` / `selectDesktop` 选择。`openPwaRelayFromOrigin` 在未
  传入也未记住桌面时，会选中唯一列出的那一台。`selectSolePwaDesktop` 在只
  有一台列出桌面时选中它；0 台或多台失败关闭。选择本机 PWA、空桌面 id
  或非 X25519 加密公钥一律失败关闭。`listDesktops` 也会省略这些设备。已撤销桌面不会出现。follow-up、approval 和
  cancel 按该桌面加密公钥密封。presence 帧同样密封。presence 状态只能是 online 或
  offline。follow-up 正文必填且有上限，
  避免低带宽链路被撑爆。握手 nonce 来自 WebCrypto，而不是 `node:crypto`。设备身份可用
  `createWebCryptoDeviceIdentity` 生成。`loadPwaRelayIdentity` 只在调用方提供的
  存储里生成一次并回读；`peekPwaRelayPublicIdentity` 从不返回私钥。
  `resolvePwaRelayIdentity` 只接受该存储、IndexedDB 或现成身份，不能多于一个来源。
  `createPwaRelayController` 可用 `identityStorage` 或 `indexedDB` 注册。
  `bindPwaRelayIdentityStorage` 拒绝 `sessionStorage`、origin 键和凭据风格
  键名。`bindPwaRelayAsyncIdentityStorage` 绑定 IndexedDB 风格的异步存储。
  `openPwaRelayIdentityIndexedDb` 打开该存储；缺少 IndexedDB 失败关闭。
  `enrollPwaPairingShell` 把合法 origin 记入 `sessionStorage`，并在 IndexedDB
  中生成或回读身份；私钥从不占用 origin 键。
  握手签名走 `createWebCryptoSignedHandshakeEnvelope`。follow-up 密封走 `createWebCryptoSealedRelayEnvelope`。drain 用 `openWebCryptoSealedRelayPayload` 打开密文盒。关闭后的会话在 `reconnect` 之前拒绝 send 和 drain。
  `listDesktops` 走仅出站 HTTPS，关闭后仍可用。`drain` 领取排队邮件和在线推送，只 ack 排队
  id。`reconnect` 使用新 nonce，避免握手被当成重放。`revoke` 关闭 socket 并立即
  撤销该 PWA 设备 id。返回对象不含私钥。
- `createPwaSessionBoard` 把视图折成每个会话一份快照。prompt 正文不会出现。
  `notify.*` 进度成为最新通知。拒绝的 approval 会保留 request id。
  `assistant.done` 与 `session.complete` 会把快照
  标为 complete。
- `createPwaWebManifest` 返回 `display: standalone` 且 `start_url` 为相对路径
  的安装记录。安装 `id` 保持相对路径，且 `prefer_related_applications` 为 false，
  便于加到手机主屏。`decidePwaCacheAction` 只缓存 shell GET 资源；令牌查询参数和
  模型凭据失败关闭。控制面 POST 保持 network-only。
  `decidePwaCacheRetention` 只保留当前 shell 缓存名。
  `createPwaServiceWorkerSource` 生成对应的 worker 源码；activate 时删除过期
  缓存并接管客户端，从不监听。
  `createPwaShellFiles` 返回 `index.html`、manifest、`sw.js` 和 `pair.js`。
  首页没有内联脚本。`PWA_SHELL_CSP` 禁止 `unsafe-inline`、嵌套框架和插件。
  回环响应还发送 `X-Content-Type-Options: nosniff`。
  `createPwaShellIcons` 返回 192 与 512 PNG。检入的副本在 `public/`，必须与
  生成器一致。`createPwaDeployFiles` 附带 PNG 图标，静态 HTTPS 源可托管可安装
  shell，而本包自己不监听。  首页表单只收集 Relay origin，从不命名 token 字段。
  合法 origin 只可写入 `sessionStorage`；hash fragment 失败关闭，避免粘贴
  `#access_token=`。提交时 pairing 脚本把 WebCrypto 身份写入 IndexedDB，并显示
  `sessionStorage` 里记住的公开桌面 id；被投毒的桌面槽会被清掉。
  可选的配对码字段不是 JWT，也从不写入存储。合法配对码会 POST `/v1/pairing/redeem`
  兑换；只记住公开桌面 id 与加密公钥，返回的访问令牌只用于拨出站 `/v1`，不落盘。
  握手之后配对页可向正在进行的桌面 session id 发送密封 follow-up。
  会话栏留空则发送 `queue`，桌面可因此新建 Host 会话。
  Forget pairing 只清除 origin 与桌面槽，不动 IndexedDB，也不调用 revoke。
  首页包含 Apple 与 Android 主屏安装 meta。
  `assertPwaShellOrigin` 要求 HTTPS 或回环 HTTP，带凭据的 URL（含 hash
  fragment）失败关闭。
  `@wancode/relay-pwa/host` 只在 127.0.0.1 上托管该 shell，公网
  绑定和非回环 Host / Origin / Referer 头失败关闭。回环响应发送
  `Referrer-Policy: no-referrer`，并关闭摄像头、麦克风和定位。
  编码路径或 `..` 失败关闭。该 host 不在默认导出中。
- 默认导出没有监听器，也没有 loopback/cloud 接收端。

这还不是公网上已交付的 iOS / Android 安装。图形界面启动保持显式。
