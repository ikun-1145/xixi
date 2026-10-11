# Phase 6C Web：本地兼容候选

2026-10-11，入场main `f889c775f02078d760d03f5d887ea6fd67f07634`，工作树干净；唯一writer、本地修改，无branch/worktree/push/deploy/生产访问，支付/Pro协议未改。

Worker候选启用可信配置AI_REQUIRE_REQUEST_ID=true，缺ID在quota/model前428拒绝。此前新Web标题辅助apiFetch和Verify模型阶段缺ID，会误伤正常功能；最小补齐：apiFetch序列化边界缺ID生成一次、已有主聊天/regen ID保留；实际authenticatedFetch 401递归复用原init/body，Verify不同逻辑阶段各用UUID。不能把请求有ID当客户端版本、完整跨刷新持久AI intent或全入口屏障。

新增辅助ID/实际401相同payload及ID/Verify不同阶段ID三用例，先确认旧代码失败再修复。完整serial 763/763、相关50/50、语法与diff-check通过。Phase6A两个旧翻译失败已修复并继续通过。本轮首轮759/760（i18n子进程1.5s watchdog），独立复验及随后完整760/760、修改后763/763通过；没有改超时、删除或弱化测试。

浏览器仅localhost隔离Verify fixture，CSP connect-src=self、假token/假模型结果和合成文本；模拟no_claims显示通过。夹具原相对logo/旗帜/首页路径在tests子目录错位，增加base=/后复验可见资源，未改产品UI。静态站无build脚本；DOM/模拟浏览器不能替代真实聊天、多标签/设备、媒体和生产验收。

完整证据映射、migration/兼容/排空、测试及未来runbook在主仓库 `docs/full-stack-development/requirements/backend-consistency/phase6c-{evidence-and-schema,migration-and-readiness,release-runbook}.md`。production expected/来源/迁移履历、全部旧Q0及DBJWT阻断/权威终止、可信pending和正式版本/设备仍BLOCKED。保持NO-GO，仅本地候选，不发布。
