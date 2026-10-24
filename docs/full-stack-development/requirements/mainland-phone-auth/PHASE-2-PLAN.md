# Phase 2 实施契约与计划

用户已批准完整Phase2本地实施。flowProfile strict-fullstack（无UI）。复用Phase1、实际Worker原始工程及私有Postgres RPC，保持应用JWT、数据库JWT和邮箱OTP行为/响应不变。不引入JWT版本声明或Supabase Auth Session；敏感授权版本仅存私有phone_auth_state/grants，变更后旧grant失效，旧JWT自身不能授权新敏感操作；持有旧JWT但再次证明当前因子所有权属于允许的重新认证，不是旧JWT自行升级。

## 数据契约（服务端专用）
5张新表：sunland_phone_identities（user_id唯一FK、phone_hash唯一、lookup_key_id、encrypted_phone文本AESGCM envelope、last4、verified_at/bound_at/updated_at）；sunland_phone_auth_state(user_id,version)；sunland_phone_auth_grants(proof_hash,user_id,session_hash,version,purpose,method,subject_fingerprint,issued_at,expires_at,consumed_by)；sunland_phone_auth_operations(operation_id,request_hash,user_id,action,result,created_at)；sunland_phone_auth_config(singleton,lookup_key_id,lookup_check)。全部RLS启用，PUBLIC/anon/authenticated无表权限，service_role专用SECURITY INVOKER RPC。

手机号先规范化E164 +86，再HMAC-SHA256索引，AES-256-GCM随机IV加密，AAD绑定user_id+phone_hash。加密密钥可保留keyring读取旧版本；lookup密钥不得在线随意轮换，数据库永久canary确保密钥/版本变更关闭；配置singleton默认未审核NULL，测试fixture显式初始化，生产初始化另审。普通客户端永远无特权表/RPC权限。

单RPC public.sunland_phone_identity(p_action text,p_data jsonb)，服务端每次附带lookup_key_id与lookup_check；缺失/不同拒绝PHONE_KEY_MISMATCH。新函数先全局功能级advisory事务锁，再锁profile→state→grant/phone。生命周期触发器不取advisory锁，避免与已持有profile的注销流程死锁。

p_action与payload：
- status: user_id；返回code OK,user_id,email,version,phone（NULL或{phone_hash,lookup_key_id,encrypted_phone,last4}）。只供服务端。
- grant: user_id,session_hash,purpose(bind/change/unbind/delete),method(email/phone),subject（规范邮箱或当前phone_hash）,proof_hash；核对当前因子归属及active，写5分钟grant，返回issued_at(Unix毫秒),expires_in=300,version。unbind只允许当前邮箱OTP grant，不能因email非空放行。
- proof: user_id,session_hash,purpose,proof_hash；检查有效/未消费/同版本/当前因子，返回issued_at/version/method。发送bind/change短信前校验但不消费，最终变更在同事务重检并消费。
- login: phone_hash,lookup_key_id,encrypted_phone,last4,candidate_id(Worker crypto.randomUUID),operation_id,request_hash；有mapping则锁原profile重查active/ban并返原id；无mapping则在同事务创建email=NULL的新profile(onboarding 0/1)+mapping，原子避免孤儿/并发重复，不自动合并。返回code OK,user_id,email,onboarding,is_new_user。ciphertext属于candidate且仅新建时写入。
- bind/change: user_id,session_hash,proof_hash,phone_hash,encrypted_phone,last4,operation_id,request_hash；核对grant purpose=action、owner/version、用户状态和唯一约束后更新mapping、消费grant、version++、审计结果。只能在Phase1短信check持久消费后调用。
- unbind: user_id,session_hash,proof_hash,operation_id,request_hash；必须当前邮箱OTP grant且仍有相同邮箱，删除mapping/version++/消费。无须重复短信验证，因为已经证明替代邮箱因子；保持Phase1内部unbind用途兼容，公网入口不依赖它。
- delete_authorize: user_id,session_hash,proof_hash,operation_id,request_hash,token_hash；核对delete grant（banned但active可注销，同既有语义），插入既有account_deletion_jobs pending+10分钟TTL并消费grant，返回既有deletion_job_id/expires_in，Worker仅一次返回随机deletion_token；后续直接走原Edge Function execute，不修改原邮箱authorize分支。

失败码：INVALID_REQUEST,PHONE_KEY_MISMATCH,ACCOUNT_NOT_ACTIVE,ACCOUNT_BANNED,PHONE_CONFLICT,PHONE_ALREADY_BOUND,PHONE_NOT_BOUND,REAUTH_INVALID,ALTERNATIVE_LOGIN_REQUIRED,OPERATION_CONFLICT,DELETION_CONFLICT。代码/HTTP映射见OpenAPI。事务失败回滚所有本次写入；同operation_id+同request_hash返回原安全result，跨用户/不同fingerprint拒绝。RPC网络未知不自动重试/重用已消费SMS，返回服务不可用并让用户查询状态或重新验证，不承诺用旧码重放成功响应。

## 生命周期
现有active→deleting→retired保持不变；deleting仅使grants失效并保留phone唯一占用，禁止login/bind。retired是不可恢复身份，90秒租约/7天恢复TTL仅为清理job续作。带phone的retired转换触发器核对OLD deleting、job/attempt/fence、当前in_progress lease与data_deleted_at，再同事务删除phone密文/索引、清grants、version++并写release审计；异常回滚retired，不提前释放。无phone用户保持既有注销语义。释放后只会创建新UUID，永远不恢复旧id。被运营商重新分配但尚绑定的手机号仍是SMS认证固有风险，不能自动识别原持有人；不自动合并、不声称解决号码回收风险，提供已验证邮箱恢复和明确脱绑/删除流程。

## Worker接入与所有权
现有真实工程 /Users/liuxize/sunland_ai_app/worker/src/index.js 比旧部署包新（email-otp.js原子RPC），禁止覆盖。xixi提供可运行的本地集成entry/build：读取该原始工程并仅在构建临时副本增加named helper exports，通过esbuild插件注入同一Worker默认对象与原helper；其余路由原样委托。既有仓库源文件、配置、Flutter和品牌并发修改不动。集成测试必须运行这个真实源码构建出的fetch，而不是只测假Worker。

主Agent负责identity.js（crypto/RPC）、service/coordinator reauth最小扩展、entry/build与真实Worker集成测试、文档整合；数据库Agent负责唯一迁移SQL、SQL测试与PGlite测试依赖；WorkerAgent负责routes.js及其Mock测试。文件不重叠，均不自行提交。QA/security只读独立复核。

## 外部端点
全部新增/v1/phone/*，既有/send-code、/verify-code、/refresh、/v1/database-token保留。send-code、verify-code、status、reauth/email、reauth/phone、bind、change、unbind、delete-authorize见OpenAPI。使用已有Authorization和Content-Type头；reauth_token/operation_id放body，不需改原CORS头。只有真实现有JWT/status中间件可产生trusted context。reauth目的允许已验JWT+active+会话摘要发起，但SMS后必须在DB重新检查号码确属该user，不能用另一账号的SMS取得grant。

## 执行及验收
TDD RED→GREEN→独立数据库/QA/security审查→focused及npm test→本地提交。不依赖Docker。安装精确PGlite开发测试依赖可在进程内执行真实Postgres WASM SQL/触发器/回滚；不等同独立服务PostgreSQL多连接并发或生产验收。全部短信/云服务网络Mock。覆盖原用户/权益、并发注册绑定、唯一性、proof版本/重放、退休释放/fence/租约/回滚、唯一登录解绑保护、原始Worker JWT验签/过期/邮箱/数据库token回归。记录无法运行的真实运行时、供应商、生产迁移验收。

HTTP端点与输入schema已保存phase-2-openapi.json。POST /verify-code返回现有{token,user:{id,email},onboarding,is_new_user}，status返回{bound,phone:masked|null,has_email}；reauth两入口返回{reauth_token,expires_in:300}；bind/change/unbind返回{ok:true}；delete-authorize返回{ok:true,deletion_job_id,deletion_token,expires_in:600}。send-code沿用Phase1成功形状。旧接口OPTIONS/CORS由原Worker处理，所有新端点用同一json helper；grant和幂等ID放body。
