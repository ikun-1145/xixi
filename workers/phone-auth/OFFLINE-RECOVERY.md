# Phone Auth 离线备份检查与恢复边界

本文只用于离线检查和隔离恢复，不授权初始化或更改生产数据库、DO、Secret、功能开关，也不授权发送短信。操作前断开恢复目标的外网，确保容器没有端口映射、定时任务关闭、`pg_net` 不连接恢复库、容器交换上限为零。任何生产数据、临时文件和日志只可写入已挂载的加密存储；核实挂载和空闲空间后才开始。不要在生产数据库执行本文件的命令。

## 必须一并保管的材料

- 加密卷中 `backup/native17-full.dump`、`backup/native17-roles2.sql`、`backup/production-database-acl.json`；原归档不包含 Storage 文件或角色密码。
- 加密卷中 `storage-independent-3e04b9e0/`：密文归档、`.source.json` 与 `inventory.json` 必须一起保留。解密密钥是本机 `~/.config/sunland-backup/encryption.key`，必须经独立安全渠道另行备份；不要复制到仓库、日志或与密文一同放入未加密存储。
- 加密卷中 `offline-recovery-tools-20261112/`：Storage 加解密和验证工具、文件校验清单。清单和数据同处一处无法防止同时被篡改；须另存经认证的清单副本。
- 加密卷中 `supabase-isolated-b642/restore-main.list` 和 `restore-events.list`：严格恢复时分别保留主体和七个事件触发器的条目顺序。`backup/authorization-check-20261112-final.json` 只是核对结果，不包含完整源端权限快照。
- 四项 Phone Auth 核心密钥均需独立安全备份；当前只找到身份加密 keyring 的本机文件和同机加密卷副本。`PHONE_AUTH_HMAC_KEY`、`PHONE_AUTH_ADMIN_TOKEN`、`PHONE_IDENTITY_LOOKUP_KEY` 的独立备份及四项与 Cloudflare 当前值的一致性仍未证明。不可根据 Key ID 或 Secret 名称推断一致，也不可重新生成替代。

## 在当前 Mac 上校验归档

下面的命令只读取受保护的文件，不输出密钥、摘要、表内容或 Storage 对象名；假定加密卷已经挂载在当时使用的位置。若恢复到另一台电脑，请先通过受控方式恢复并挂载加密卷，核对路径、权限和卷加密状态，再调整 `RECOVERY_ROOT`。本地清单及归档必须与另行保管、可信的清单核对，否则只能发现意外损坏，不能证明未被替换。

```sh
export RECOVERY_ROOT="$HOME/Library/Application Support/xixi-phone-auth/mount-ffc31773-beae-46d8-9949-98dc80ed018c"
python3 - <<'PY'
import hashlib, json, os, pathlib, plistlib, subprocess
root = pathlib.Path(os.environ['RECOVERY_ROOT']).resolve(strict=True)
images = plistlib.loads(subprocess.check_output(['hdiutil', 'info', '-plist']))['images']
assert any(i.get('image-encrypted') is True and any(
    e.get('mount-point') == str(root) for e in i.get('system-entities', [])
) for i in images), '恢复卷未挂载或未确认加密'
manifest = json.loads((root / 'offline-recovery-tools-20261112/manifest.json').read_text())
for relative, expected in manifest['files'].items():
    path = (root / relative).resolve(strict=True)
    assert root in path.parents and path.is_file()
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    assert digest.hexdigest() == expected, '备份清单校验失败'
print('加密卷与本地清单检查通过；仍须对照独立可信清单。')
PY
node "$RECOVERY_ROOT/offline-recovery-tools-20261112/aead-file.mjs" verify \
  "$HOME/.config/sunland-backup/encryption.key" \
  "$RECOVERY_ROOT/storage-independent-3e04b9e0/storage.tar.aesgcm"
```

任何错误都停止，不覆盖归档或创建新密钥。`verify` 仅验证 Storage 密文认证标签及工具生成的明文长度/摘要，不验证数据库内容或生产 Secret。

## 隔离提取 Storage 文件

验证通过后，若需检查文件恢复，可在同一加密卷创建临时目录；下面的步骤解密、逐对象校验并提取，完成后删除临时明文。若要留存恢复文件，应改用另一个确认加密、独占创建的目标，禁止指向现有目录；本步骤不上传文件到 Storage 服务。

```sh
set -eu
umask 077
RECOVERY_WORK=$(mktemp -d "$RECOVERY_ROOT/storage-offline-verify.XXXXXXXX")
trap 'rm -rf "$RECOVERY_WORK"' EXIT HUP INT TERM
node "$RECOVERY_ROOT/offline-recovery-tools-20261112/aead-file.mjs" decrypt \
  "$HOME/.config/sunland-backup/encryption.key" \
  "$RECOVERY_ROOT/storage-independent-3e04b9e0/storage.tar.aesgcm" \
  "$RECOVERY_WORK/storage.tar" >"$RECOVERY_WORK/check.log" 2>&1
python3 "$RECOVERY_ROOT/offline-recovery-tools-20261112/storage_verify.py" \
  "$RECOVERY_WORK/storage.tar" "$RECOVERY_WORK/result.json" \
  "$RECOVERY_ROOT/storage-independent-3e04b9e0/inventory.json" \
  "$RECOVERY_WORK/files" >>"$RECOVERY_WORK/check.log" 2>&1
printf '%s\n' '隔离提取与逐对象校验通过。'
```

数据库归档与 Storage 在不同时间采集，路径和大小一致不证明跨服务原子性。生产 bucket 权限、实际对象版本及托管服务配置仍需在受控环境另验。

## 数据库隔离恢复

已验证的本机副本是加密卷中的 `supabase-isolated-b642/data`，使用本机缓存的官方镜像 `supabase/postgres:17.4.1.054_arm64`；其中 phone-auth 配置曾用合成值初始化，**不能直接作为生产恢复源**。原始数据库归档未改变。需要跨机器重新构建时，必须先离线准备并验证同版本镜像、角色、扩展及安全容器环境；没有可信镜像或无法确保加密和无网络时停止。

此前验证采用空数据库、原角色定义及生产数据库级 ACL，先以事务和 `--exit-on-error` 恢复 `restore-main.list`，再以 `--use-set-session-authorization` 按原所有者恢复七个事件触发器。原归档不包含数据库级 ACL；直接以统一所有者恢复会因 Supabase 安全检查失败。恢复后还需核对并修正 51 个扩展对象所有者、ACL，比较角色继承、默认权限、有效权限、RLS、触发器和各表数据；只比较导出 SQL 或忽略错误不算通过。当前材料没有封装可移植的全自动重建脚本，不能将上述描述当成已验证的一键恢复流程。

Vault 在 2026-11-12 的生产只读计数为零；不代表未来始终为空。生产 Vault 根密钥及平台托管设置的恢复没有验证，真实 Storage 服务上传恢复也没有验证。发生故障时先确认这些独立依赖和备份时点，不得用隔离环境新生成的密钥冒充生产密钥。
