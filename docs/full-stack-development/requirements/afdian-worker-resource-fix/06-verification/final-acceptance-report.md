# 本地修复验收

需求、数据/API契约、安全不变量、状态图、修改与性能证据见 [完整审查报告](../../../../afdianpay-cpu-reconciliation-audit.md)。当前阶段为可审查候选，不包含生产验收。

本任务无UI改动。Worker dry-run打包、全量回归、PGlite真实SQL隔离检查、Docker独立多连接竞争实验及限定文件差异审查构成验收证据。技能指定的 lifecycle/completion MCP 工具未出现在本次工具目录中，未宣称该工具门禁通过；遵循用户已明确授权的debug-fix范围执行本地验证。

生产部署前仍需核验活跃RPC目录和ACL、批准迁移及Worker发布，并调查Cron记录异常与实际CPU上限。最终命令和数量记录在完整报告中。
