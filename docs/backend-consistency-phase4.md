# Phase 4：本机分支、重新生成与恢复

结论：**NO-GO**。本地数据保护修复通过自动化验证，不能替代生产门禁、旧 Worker 排空、生产 schema 等价性和真实浏览器/设备验收。

入场 main `32dadf56ba02d9f437aad279739193c5c0a6e0e9`，工作树干净。未创建 branch/worktree；未 push、部署或执行生产 migration。支付、Pro 和服务端权限规则未改。

| 问题 | 根因及本轮处理 |
|---|---|
| 多标签覆盖 | 原先共享整份 localStorage 快照，后写覆盖前写。每个 document 使用独立 UUID 持久分支与递增 revision；复制标签也不复用 writer ID。storage 通知提示其他分支，服务端仍通过原子 CAS 决定写入。没有时间戳胜者或客户端 merge 后覆盖。 |
| 重新生成丢旧回答 | 旧按钮先截断回答，再调用普通发送，重复追加用户消息。现在先落盘固定 request ID、原回答和原始 CAS 版本；仅完整非空结果形成 ready replace。失响应保留 unknown/pending，不自动重新执行模型请求。 |
| ready 刷新竞态 | 意图已持久化而快照未保存时，普通 reconcile 可能采用另一设备的新版本。现在 pending/unknown/ready 都保留原 expected；另一设备写入/删除产生冲突，保留原回答、新结果与草稿。 |
| 导出与恢复 | 版本化 JSON，SHA-256 校验 owner 与 payload 原文；验证格式、归属、消息 ID 重复和大小。确定性新会话 ID；重复文件不重复导入，原始 archive 保留。恢复ID绑定原始文件校验值与记录位置，避免Dart/JS的0.0或Unicode序列化差异；共用fixture验证相同文件的跨端ID。每个来源分支独立复制；同一文件重复导入不重复创建。恢复不复用旧 CAS base、墓碑 ID 或 Core 上下文。 |
| 账号隔离 | 相似账号ID前缀的分支仍校验实际owner，读取、导出、通知与删除不混入其他账号。回归覆盖`a`与`a_secondary`。 |
| 存储失败 | 更新先写持久快照再更新 vault 内存；失败抛出，不用空缓存替换损坏数据。待发附件和当前输入在历史保存前保留；长异步操作不清掉新输入或另一会话的附件。 |

设置页提供“导出完整本机历史”“导入历史备份”“恢复保留的本机数据”。同一可信账号确认后，恢复结果进入独立分支；重新打开聊天后通过已有 CAS 协议同步新会话。原会话和原始分支保留，409 后可以导出或复制到新会话。浏览器主动清除网站数据/卸载不能保证本机恢复，先导出文件。

格式保存原始消息 ID、顺序、Unicode、未知元数据、同步操作、重新生成原回答和已保存草稿。兼容 Flutter 相同封装；其待发图片字节保留在 recoveryOutbox 元数据中。远程附件只保留引用；未下载的云端历史不属于本机备份。恢复消息提供原始附件字节下载，恢复元数据不自动传给模型。实际下载/显示仍需设备验收，不能宣称离线恢复所有远程媒体。备份文件包含私密内容；SHA-256 是完整性校验，不能成为身份、Pro、支付或权限证明。

全量 `node --test --test-concurrency=1 tests/*.test.mjs`：**757/759**。两个既有翻译失败保持原断言：game.html 未加载附加语言目录、QQ交流群缺少新语言映射。并行 npm test 曾另出现 diagnostics 时序失败；单文件13/13及串行全套恢复，未修改该测试。新增11项 vault/恢复测试、4项 regeneration 测试；history 模块33/33；含账号删除保护的针对性套件35/35。新增脚本及 app.js/account-delete.js 的 `node --check`、`git diff --check` 通过。仓库没有独立 lint/typecheck/build 脚本。

尚未实际测试：浏览器文件选择/下载、关闭重开和页面渲染验收；两台物理设备和跨 Web/Flutter 的真实账号流；生产 RPC/权限/部署版本。原始分支不会自动清理，localStorage 满时明确停止保存；不能以删除不确定分支解决容量问题。正式上线前需验证长历史容量、导出文件可读性及恢复附件使用。

完整生产阻断与操作顺序记录在 Flutter 主仓库 `docs/full-stack-development/requirements/backend-consistency/phase4-data-protection-and-readiness.md`。旧 Q0/KV 与新 Q1/PostgreSQL 禁止混合准入；未获可信排空证据前保持 NO-GO。
