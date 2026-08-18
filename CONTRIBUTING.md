# 参与贡献

感谢你愿意参与 Wan Code。这是一个社区项目，无论你是普通用户还是开发者，都有适合你的贡献方式。

## 普通用户：使用与反馈

- 遇到问题或异常，[提 issue](https://github.com/ThomasWan123/wancode-NewVer/issues)：说明操作系统（当前以 Windows 为主）、应用版本和复现步骤。
- 有功能想法或改进建议，也欢迎提 issue 讨论。

## 开发者：贡献代码

### 开发环境

```sh
git submodule update --init --recursive
corepack yarn install --immutable
corepack yarn check   # 完整 headless gate：构建、类型检查、测试与冒烟
corepack yarn dev     # 有图形环境时启动应用
```

### 仓库边界（开始前务必了解）

- `deepseek-harness/` 是固定版本的上游子模块，**不得修改其中的任何文件**；上游内容更新走独立的 pin 提交。
- 桌面代码位于 `dsh-plugin-desktop/`；Wan Code 协议与云模块位于 `packages/wancode/`。
- `dsh-community-fabric/` 保存社区标准 Draft，`dsh-community-market/` 保存市场壳设计。两个社区 package 当前都只有文档、尚不可加载。
- 构建、类型检查、单元测试和冒烟检查必须保持 headless-safe。

### 提交与 PR

- 提交信息使用 conventional commits 风格（例如 `fix(desktop): ...`、`docs: ...`）。
- 提交前运行 `yarn check` 并保证全绿。
- 变更桌面生产依赖后，运行 `yarn workspace dsh-plugin-desktop verify:notices` 刷新第三方许可清单，并提交更新后的 `dsh-plugin-desktop/THIRD_PARTY_NOTICES.md`。
- 根 README 改动请中英同步，并更新 `README.i18n.yaml` 的双语 hash 记录。
- PR 描述说明改动内容、动机和验证方式；CI 通过后再合并。

## 行为准则

请保持友善与尊重，就事论事。完整的[参与者公约](CODE_OF_CONDUCT.md)适用于所有项目空间。
