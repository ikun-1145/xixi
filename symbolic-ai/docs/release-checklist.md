# Sunland Core Release Checklist

本清单用于每次 Core SDK 发布。它不授权 commit、tag、push 或部署；
这些操作需要发布负责人单独确认。

## 1. 范围与版本

- [ ] 确认发布内容不包含未批准的 AI 能力或 Core 算法变更。
- [ ] 按 [`versioning.md`](./versioning.md) 判定 `MAJOR.MINOR.PATCH`。
- [ ] 确认 `package.json`、`SUNLAND_CORE_VERSION` 和 API Surface 契约版本一致。
- [ ] 将待发布项从 `Unreleased` 移到带日期的 Changelog 版本节。

## 2. 公开契约审核

- [ ] 确认宿主仍只通过 `src/sdk.ts`/发布 Bundle 调用 Core。
- [ ] 检查 `git diff` 中是否存在公开导出、类型签名、默认值、schema、
  持久化格式或用户可见行为变化。
- [ ] 运行 `npm run test:api-surface`，不通过时不得直接改基线。
- [ ] 如果是经批准的破坏性变更，先升级版本并准备迁移文档。

## 3. 构建与验证

- [ ] 记录发布前 Web/Flutter Bundle SHA256。
- [ ] 在 `symbolic-ai` 目录执行 `npm run release:core`。
- [ ] 执行 `npm run check:core-release`。
- [ ] 确认 release report 中的 Bundle hash、字节数、运行时版本、
  API Surface 和双端一致性检查全部通过。
- [ ] 运行 Web 测试：`node --test tests/*.test.mjs`。
- [ ] 运行 Flutter 测试：`flutter test`。
- [ ] 运行 `git diff --check`。

## 4. 行为与安全

- [ ] 确认 Provider、认证、会话持久化与 UI 代码未被发布工程改动。
- [ ] 确认 Web/Flutter 使用同一 Bundle 和 manifest。
- [ ] 确认 release report 不包含用户身份、密钥或本机绝对路径。
- [ ] 对已知非阻断警告记录风险，不在发布改动中顺手重构。

## 5. 交付

- [ ] 记录测试数量、Bundle SHA256 和 release report 路径。
- [ ] 确认工作树只包含已审核的发布变更与既有未提交工作。
- [ ] 获得明确授权后才可 commit、tag、push 或部署。
