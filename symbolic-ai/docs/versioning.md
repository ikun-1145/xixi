# Sunland Core 版本规则

## 版本格式

Sunland Core 使用 `MAJOR.MINOR.PATCH` Semantic Version。预发布版本使用
`-alpha.N`、`-beta.N` 或 `-rc.N`，例如 `0.2.0-rc.1`。

版本唯一事实来源为 `symbolic-ai/package.json`；每次发布必须同时保持：

- `package.json` 的 `version`；
- SDK 导出的 `SUNLAND_CORE_VERSION`；
- Web/Flutter manifest 的 `version`；
- API Surface 契约的 `sdkVersion`。

`release:core` 会校验上述版本与已发布 Bundle；manifest 不手工编辑。

## `0.x` 阶段政策

v0.1.0 是当前公开 SDK 基线。在 `1.0.0` 之前采用保守规则：

| 变化 | 版本要求 |
|---|---|
| 文档、发布工程、测试，且 Bundle 与行为不变 | `PATCH`，例如 `0.1.1` |
| 向后兼容的修复，不改公开 API/schema/持久化语义 | `PATCH` |
| 新增公开 SDK 导出、新能力或新 schema | `MINOR`，例如 `0.2.0` |
| 删除/重命名导出、改签名/返回格式/默认行为或不兼容 schema | `MINOR`，并必须提供迁移说明 |

即使 SemVer 允许 `0.x` 快速变化，Sunland Core 也不在 `0.1.x` 中接受
破坏性变更。

## `1.x` 及以后

- `PATCH`：向后兼容的修复，不新增公开能力。
- `MINOR`：向后兼容的新能力或公开 API 扩展。
- `MAJOR`：任何破坏性变更。

## 破坏性变更定义

以下任一情形都属于公开契约变更：

- 删除、重命名或改变 `src/sdk.ts` 的导出类型；
- 改变公开函数、Engine 或 Adapter 的必填参数、返回值或错误语义；
- 改变 Web/Flutter 已使用的 JSON、Context、Memory、Knowledge 或
  Observation 格式；
- 改变默认 Personality、持久化 key 规则或用户可见的既有行为；
- 新增宿主必须提供的运行时依赖。

schema 版本与 Core SemVer 相互独立。schema 变更必须同时提供显式迁移、
跨端兼容测试和对应的 Core 版本升级。

## API Surface 基线

`contracts/sdk-api-surface.v0.1.0.json` 冻结 v0.1 系列的运行时导出。
修改该文件不是解决测试失败的手段；只能在已批准的版本升级中新建对应
基线，同时更新迁移说明和 Changelog。

Bundle hash 是某次构建产物的完整性标识，不代替 SemVer。同一版本如果
Bundle hash 改变，必须重新执行全部发布检查并记录原因。
