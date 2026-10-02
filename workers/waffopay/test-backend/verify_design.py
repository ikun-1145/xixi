"""Offline draft checks only. Parses SQL; never connects to or executes a DB.

Run: python3 workers/waffopay/test-backend/verify_design.py
Requires the already-installed pglast; do not install DB/runtime dependencies.

对齐 PATCH 003：checkout 使用 authenticated + 测试用户 RLS；webhook 使用专用 GoTrue
ingest bot 的 authenticated token + ingest_principals 白名单（与 test_subjects 互斥）。
旧 waffo_test_checkout / waffo_test_ingest 角色保留但无任何 Test 对象权限。
"""
import json
import re
from pathlib import Path
from pglast import parse_sql, parse_plpgsql, parser

EXPECTED_TABLES = {
    "waffo_test.test_subjects",
    "waffo_test.payment_intents",
    "waffo_test.event_ledger",
    "waffo_test.ingest_principals",
}
# 隔离 RPC 名 + 完全限定签名；绝不覆盖生产同名函数，无 public RPC 回落。
SIGNATURES = {
    "waffo_test.jwt_uid()": "authenticated",
    "waffo_test.get_or_create_intent()": "authenticated",
    "waffo_test.record_event(text,text,text,text,text,text,text,uuid,text,text)": "authenticated",
}
# revoke/继承边界：两个 test 角色对每个对象都先从所有主体撤销默认权限。
REVOKE_FROM = "frompublic,anon,authenticated,service_role,waffo_test_checkout,waffo_test_ingest;"


def validate(sql):
    statements = parse_sql(sql)
    functions = parse_plpgsql(sql)
    tree = json.loads(parser.parse_sql_json(sql))
    code = re.sub(r"--[^\n]*", "", sql).lower()

    tables = set(re.findall(r"create table\s+([\w.]+)", code))
    assert tables == EXPECTED_TABLES, "unexpected table"
    assert set(re.findall(r"create function\s+([\w.]+)", code)) == {
        "waffo_test.jwt_uid", "waffo_test.get_or_create_intent", "waffo_test.record_event"
    }, "unexpected RPC"

    # 两个 test-only 角色必须无登录/无继承/非超级/不绕 RLS。
    assert code.count(
        "create role waffo_test_checkout nologin noinherit nosuperuser "
        "nocreatedb nocreaterole noreplication nobypassrls"
    ) == 1, "checkout role privileges relaxed"
    assert code.count(
        "create role waffo_test_ingest nologin noinherit nosuperuser "
        "nocreatedb nocreaterole noreplication nobypassrls"
    ) == 1, "ingest role privileges relaxed"

    assert "create or replace" not in code, "replacement forbidden"
    assert "security definer" not in code and code.count("security invoker") == 3
    assert code.count("set search_path = pg_catalog") == 3
    assert not re.search(
        r"\b(update|delete|truncate|drop)\s+(?:from\s+|table\s+)?[\w.]+",
        code.replace("on delete restrict", ""),
    ), "destructive/update statement"
    assert not re.search(r"\bexecute\s+(?:format|['$])", code), "dynamic SQL"
    assert "sunland_activate_pro_from_payment" not in code, "production entitlement RPC referenced"
    assert "check (status = 'pending')" in code and "check (mode = 'test')" in code
    assert "p_mode is distinct from 'test'" in code
    # test 角色无 auth schema USAGE（属 supabase_admin）：身份只能来自 PostgREST 的 request.jwt.claims。
    assert not re.search(r"\bauth\.", code), "auth schema dependency"
    assert "request.jwt.claim." not in code, "legacy per-claim GUC"
    assert "current_setting('request.jwt.claims', true)" in code
    assert "c.claims ->> 'role' = current_user::text" in code, "role claim not bound to current_user"
    assert "c.claims ->> 'sub' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'" in code, \
        "sub not validated before uuid cast"
    assert "p_user_id" not in code, "client-selected identity"
    # RPC 锁定 authenticated，且必须通过 enabled 测试用户检查。
    assert "current_user <> 'authenticated'" in code
    assert "where s.user_id = v_user and s.enabled" in code
    # ingest：authenticated + enabled bot 白名单 + 与 checkout 测试用户互斥；身份只来自 jwt_uid()。
    assert "v_uid uuid := waffo_test.jwt_uid();" in code
    assert "current_user <> 'authenticated' or v_uid is null" in code
    assert "or not exists (select 1 from waffo_test.ingest_principals as b where b.user_id = v_uid and b.enabled)" in code
    assert "or exists (select 1 from waffo_test.test_subjects as s where s.user_id = v_uid) then" in code
    assert "check (label = 'ingest_bot')" in code, "more than one ingest principal allowed"

    compact = re.sub(r"\s+", "", code)
    BOT = ("exists(select1fromwaffo_test.ingest_principalsasbwhereb.user_id=(selectwaffo_test.jwt_uid())"
           "andb.enabled)")
    assert "createfunctionwaffo_test.get_or_create_intent()" in compact
    assert "insertintowaffo_test.payment_intents(user_id)values(v_user)" in compact
    policies = {
        "createpolicysubjects_ownonwaffo_test.test_subjectsforselecttoauthenticated"
        "using(user_id=(selectwaffo_test.jwt_uid()));",
        "createpolicyintents_ownonwaffo_test.payment_intentsforselecttoauthenticated"
        "using(user_id=(selectwaffo_test.jwt_uid()));",
        "createpolicyintents_create_ownonwaffo_test.payment_intentsforinserttoauthenticated"
        "withcheck(user_id=(selectwaffo_test.jwt_uid())andexists(select1fromwaffo_test.test_subjectsas"
        "swheres.user_id=(selectwaffo_test.jwt_uid())ands.enabled));",
        "createpolicyintents_ingest_readonwaffo_test.payment_intentsforselecttoauthenticated"
        f"using({BOT});",
        "createpolicyledger_ingest_readonwaffo_test.event_ledgerforselecttoauthenticated"
        f"using({BOT});",
        "createpolicyledger_ingest_insertonwaffo_test.event_ledgerforinserttoauthenticated"
        f"withcheck({BOT});",
        "createpolicyingest_selfonwaffo_test.ingest_principalsforselecttoauthenticated"
        "using(user_id=(selectwaffo_test.jwt_uid()));",
    }
    for policy in policies:
        assert policy in compact, "policy predicate weakened"
    # 额外的 permissive policy 会与上面 OR 合并，直接放宽 RLS。
    assert code.count("create policy") == len(policies), "unexpected policy"

    for signature, role in SIGNATURES.items():
        assert f"revokeallonfunction{signature}{REVOKE_FROM}" in compact, "missing function revoke"
        assert f"grantexecuteonfunction{signature}to{role};" in compact, "missing function grant"

    grants = set(re.findall(r"grant[^;]+;", compact))
    allowed_grants = {
        "grantusageonschemawaffo_testtoauthenticated;",
        "grantselectonwaffo_test.test_subjectstoauthenticated;",
        "grantselectonwaffo_test.payment_intentstoauthenticated;",
        "grantinsert(user_id)onwaffo_test.payment_intentstoauthenticated;",
        "grantselect,insertonwaffo_test.event_ledgertoauthenticated;",
        "grantselectonwaffo_test.ingest_principalstoauthenticated;",
        # 与生产一致保留的旧成员关系；两个旧 test 角色在 waffo_test 内无任何授权。
        "grantwaffo_test_checkout,waffo_test_ingesttoauthenticator;",
        *(f"grantexecuteonfunction{sig}to{role};" for sig, role in SIGNATURES.items()),
    }
    assert grants == allowed_grants, "unexpected privilege grant"

    for table in EXPECTED_TABLES:
        assert f"alter table {table} enable row level security" in code
    # 账本只经 BOT policy 放行；anon / 旧 ingest 角色无任何授权。
    assert "grant select, insert on waffo_test.event_ledger to authenticated;" in code
    assert not re.search(r"grant[^;]*\b(?:anon|waffo_test_ingest|waffo_test_checkout)\b[^;]*;", code.replace(
        "grant waffo_test_checkout, waffo_test_ingest to authenticator;", "")), "legacy/anon grant"
    assert (
        "revoke all on all tables in schema waffo_test from public, anon, authenticated, "
        "service_role, waffo_test_checkout, waffo_test_ingest;" in code
    )
    assert "on conflict (user_id) do nothing" in code
    assert "on conflict (store_id, event_type, event_id) do nothing" in code
    assert "v_existing.reported_reference is distinct from p_reference" in code
    assert "'existing-project-test-schema-only'" in code, "test-schema acknowledgement missing"
    assert "create trigger" not in code and "create extension" not in code

    def relations(value):
        if isinstance(value, dict):
            if "RangeVar" in value:
                r = value["RangeVar"]
                assert f"{r.get('schemaname')}.{r['relname']}" in EXPECTED_TABLES, \
                    "DDL references relation outside private test schema"
            for child in value.values():
                relations(child)
        elif isinstance(value, list):
            for child in value:
                relations(child)
    relations(tree)

    # Function/DO bodies are opaque to the SQL AST: check their relation spellings too.
    # 允许 pg_catalog.*（权限自检只读系统目录），其余必须落在私有 test 表内。
    body_relations = re.findall(r"\b(?:insert into|from|join)\s+([\w]+\.[\w]+)", code)
    assert all(r in EXPECTED_TABLES or r.startswith("pg_catalog.") for r in body_relations), \
        "RPC references outside private test tables"
    return {"sql_statements": len(statements), "plpgsql_blocks": len(functions), "tables": len(tables)}


if __name__ == "__main__":
    source = Path(__file__).with_name("schema.DRAFT.sql").read_text()
    result = validate(source)
    mutations = [
        source.replace("enable row level security", "disable row level security", 1),
        source.replace("security invoker", "security definer", 1),
        source + "\ninsert into public.user_profiles (pro) values (true);",
        source.replace(
            "grant select, insert on waffo_test.event_ledger to authenticated;",
            "grant select, insert on waffo_test.event_ledger to authenticated, anon;",
        ),
        source.replace("check (mode = 'test')", "check (mode in ('test', 'prod'))"),
        source.replace("create function waffo_test.", "create or replace function waffo_test.", 1),
        source.replace("p_mode text,", "p_user_id text, p_mode text,"),
        source.replace(
            "grant waffo_test_checkout, waffo_test_ingest to authenticator;",
            "grant waffo_test_ingest to public;",
        ),
        source.replace(
            "revoke all on function waffo_test.get_or_create_intent() from public, anon, "
            "authenticated, service_role, waffo_test_checkout, waffo_test_ingest;",
            "",
        ),
        source.replace(
            "create policy intents_own on waffo_test.payment_intents for select to authenticated\n"
            "  using (user_id = (select waffo_test.jwt_uid()));",
            "create policy intents_own on waffo_test.payment_intents for select to authenticated using (true);",
        ),
        source.replace(
            "create function waffo_test.get_or_create_intent()",
            "create function waffo_test.get_or_create_intent(p_reference uuid)",
        ).replace(
            "insert into waffo_test.payment_intents (user_id) values (v_user)",
            "insert into waffo_test.payment_intents (user_id, payment_reference) values (v_user, p_reference)",
        ),
        source.replace("declare v_user uuid := waffo_test.jwt_uid();", "declare v_user uuid := auth.uid();"),
        source.replace("when c.claims ->> 'role' = current_user::text\n      and ", "when "),
        source.replace("current_setting('request.jwt.claims', true)", "current_setting('request.jwt.claim.sub', true)"),
        source.replace(
            "grant execute on function waffo_test.jwt_uid() to authenticated;",
            "grant execute on function waffo_test.jwt_uid() to waffo_test_checkout;",
        ),
        source.replace(
            "revoke all on function waffo_test.jwt_uid() from public, anon, "
            "authenticated, service_role, waffo_test_checkout, waffo_test_ingest;",
            "",
        ),
        source.replace("grant insert (user_id) on waffo_test.payment_intents to authenticated;",
                       "grant insert on waffo_test.payment_intents to authenticated;"),
        source.replace("grant insert (user_id) on waffo_test.payment_intents to authenticated;",
                       "grant insert (user_id, payment_reference) on waffo_test.payment_intents to authenticated;"),
        source.replace("where s.user_id = v_user and s.enabled", "where s.user_id = v_user"),
        source.replace("for insert to authenticated", "for insert to waffo_test_checkout", 1),
        # PATCH 003：ingest bot 白名单 / 互斥 / 授权边界。
        source.replace("  to authenticated;\n-- PUBLIC", "  to authenticated, anon;\n-- PUBLIC"),
        source.replace("\n    or not exists (select 1 from waffo_test.ingest_principals as b where b.user_id = v_uid and b.enabled)", ""),
        source.replace("\n    or exists (select 1 from waffo_test.test_subjects as s where s.user_id = v_uid) then", " then"),
        source.replace("where b.user_id = v_uid and b.enabled", "where b.user_id = v_uid"),
        source.replace("current_user <> 'authenticated' or v_uid is null", "v_uid is null"),
        source.replace("v_uid uuid := waffo_test.jwt_uid();", "v_uid uuid := p_reference;"),
        source.replace("returns table (result text)\nlanguage plpgsql security invoker",
                       "returns table (result text)\nlanguage plpgsql security definer"),
        source.replace("for insert to authenticated\n  with check (exists (select 1 from waffo_test.ingest_principals",
                       "for insert to authenticated\n  with check (true or exists (select 1 from waffo_test.ingest_principals"),
        source.replace("event_ledger for select to authenticated\n  using (exists", "event_ledger for select to authenticated\n  using (true or exists"),
        source.replace("payment_intents for select to authenticated\n  using (exists", "payment_intents for select to authenticated\n  using (true or exists"),
        source.replace("ingest_principals for select to authenticated\n  using (user_id = (select waffo_test.jwt_uid()));",
                       "ingest_principals for select to authenticated\n  using (true);"),
        source.replace("grant select on waffo_test.ingest_principals to authenticated;",
                       "grant select, insert on waffo_test.ingest_principals to authenticated;"),
        source.replace("grant select, insert on waffo_test.event_ledger to authenticated;",
                       "grant select, insert, delete on waffo_test.event_ledger to authenticated;"),
        source.replace("check (label = 'ingest_bot')", "check (label like 'ingest_%')"),
        source.replace("alter table waffo_test.ingest_principals enable row level security;\n", ""),
        source.replace("grant usage on schema waffo_test to authenticated;", "grant usage on schema waffo_test to authenticated, waffo_test_ingest;"),
        source + "\ncreate policy ledger_any on waffo_test.event_ledger for select to authenticated using (true);",
    ]
    for i, mutated in enumerate(mutations):
        assert mutated != source, f"mutation {i + 1} did not change the draft"
        try:
            validate(mutated)
        except (AssertionError, ValueError):
            continue
        raise AssertionError(f"dangerous mutation {i + 1} was not rejected")
    print(json.dumps({**result, "dangerous_mutations_rejected": len(mutations), "sql_executed": False, "network_access": False}))
