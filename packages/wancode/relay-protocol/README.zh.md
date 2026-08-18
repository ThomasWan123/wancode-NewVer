# @wancode/relay-protocol

[English](README.md)

Wan Code Cloud Relay（M2）的 fail-closed 远程控制契约。本包用短期令牌和已注册
设备授权版本化 envelope。它不打开网络监听、不保存明文 prompt，也不声明
DeepSeek Harness 插件入口。

## 保证

- 未知协议版本、损坏 envelope，以及明文 `prompt` / `credential` /
  `toolOutput` 字段会在路由前被拒绝。
- 过期令牌、已撤销设备和跨账号 actor 一律失败关闭。
- 相同消息 id 且载荷不变时幂等；载荷被改写则视为重放并拒绝。

桌面仍主动发起后续云连接。本库是这条出站路径的共享协议核心，不是入站 Host
surface。
