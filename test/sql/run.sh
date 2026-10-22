#!/usr/bin/env bash
# DB の RLS・トリガの検証。実際の PostgreSQL（16 で確認）が要る。
#
#   test/sql/run.sh            … 一時クラスタを立てて、db/ の SQL と test/sql/ のシナリオを流す
#
# ■ 前提
#   ・PostgreSQL のサーバ（initdb / pg_ctl / psql）が入っていること
#   ・root ではないこと（PostgreSQL は root では起動しない）
#   ・Supabase 固有の部品（auth.uid() など）は test/sql/000_supabase_stub.sql の最小の代用品
#
# ■ 流す順番
#   db/schema.sql → db/005 → db/041 → db/081 → db/099 → db/100 → test/sql/*.sql のシナリオ
#   （db/101・db/102・db/103・db/104・db/105・db/110・db/123・db/124・db/125・db/088→094→119→120→130（Sales の権限）・db/088→094→096→119→120→130→138（Sales の提案管理）・…→138→140（提案管理の起点をマッチング確定に）・→138→140→141（CS/クロージング引継ぎ）は、シナリオの中で流す。安全装置が止めるところ・表が無いときから確かめるため）
#   最後に、緊急復旧の手順（docs/keiei-owner-recovery.md）の SQL を、文書のまま流して確かめる（owner_recovery.sql）
#   新しい migration を足したら、ここに足して、対応するシナリオも test/sql/ に置く。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "PostgreSQL のサーバが見つかりません（PGBIN を指定してください）"; exit 2; }
if [ "$(id -u)" = "0" ]; then echo "root では動きません。一般ユーザーで実行してください"; exit 2; fi

TMP="$(mktemp -d)"
trap '"$PGBIN/pg_ctl" -D "$TMP/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
PORT="${PGPORT:-54329}"

"$PGBIN/initdb" -D "$TMP/data" -A trust -U postgres >/dev/null
"$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=" -l "$TMP/log" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$TMP" -p "$PORT" -U postgres -q)
"$PGBIN/createdb" -h "$TMP" -p "$PORT" -U postgres kp

run() { "${PSQL[@]}" -v ON_ERROR_STOP=1 -d kp -f "$1" >/dev/null 2>"$TMP/err" || { echo "失敗: $1"; cat "$TMP/err"; exit 1; }; }
run "$ROOT/test/sql/000_supabase_stub.sql"
run "$ROOT/db/schema.sql"
run "$ROOT/db/005_groupware_core.sql"
run "$ROOT/db/041_admin_is_hr.sql"
run "$ROOT/db/081_hr_recruiting.sql"
run "$ROOT/db/099_owner_only.sql"
run "$ROOT/db/099_owner_only.sql"   # べき等（2回流しても同じ）
run "$ROOT/db/100_hr_pay.sql"
run "$ROOT/db/100_hr_pay.sql"       # べき等（2回流しても、行が増えない）
# Supabase は、新しい表に authenticated / service_role の権限を自動で付ける。その代わり（RLS は別に効く）
"${PSQL[@]}" -d kp -c "grant all on all tables in schema public to authenticated, service_role; grant execute on all functions in schema public to authenticated, service_role;" >/dev/null

# シナリオは、それぞれ別の DB の上で流す（お互いの行に影響されない）
OUT=""
# 採用HR（db/129 → db/132：条件通知書・電子承諾記録・正式契約 → db/133：Office への引き渡し → db/139：契約手続き）。ほかの PR が直す下の一覧の行とは分けて置く
for sc in 132_hr_offer_documents 133_hr_offer_handoff 139_hr_contract_procedure; do
  "$PGBIN/createdb" -h "$TMP" -p "$PORT" -U postgres -T kp "kp_$sc"
  OUT+="$(SCEN_ROOT="$ROOT" "${PSQL[@]}" -d "kp_$sc" -f "$ROOT/test/sql/$sc.sql" 2>&1 || true)"$'\n'
done
export SCEN_ROOT="$ROOT"   # 101 のシナリオが、db/101 を読むために使う
for sc in 099_owner_only 100_hr_pay 101_hr_pay_clear 102_contracts_pay_rls 103_tool_access 104_onboarding_guide 105_compensation 110_labor_notices 123_retire_case 124_hr_mail_templates 125_office_recurring 126_grant_rules 127_retire_cert_requests 130_sales_access 138_sales_proposals 140_sales_proposal_matching 141_sales_cs_closing_handoff 142_sales_team_proposals_bulk 147_slack_ai_secretary check_pay_reconcile check_exposure; do
  "$PGBIN/createdb" -h "$TMP" -p "$PORT" -U postgres -T kp "kp_$sc"
  OUT+="$("${PSQL[@]}" -d "kp_$sc" -f "$ROOT/test/sql/$sc.sql" 2>&1 || true)"$'\n'
done
# db/147: 2つのセッションが同じキュー行・同じ承認を同時に取りに行っても、取れるのは1つだけ（CAS + 行ロック）
"$PGBIN/createdb" -h "$TMP" -p "$PORT" -U postgres -T kp kp_147_concurrency
"${PSQL[@]}" -d kp_147_concurrency -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; end $$;
SQL
run_c() { PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d kp_147_concurrency -v ON_ERROR_STOP=1 -At "$@"; }
run_c -f "$ROOT/db/147_slack_ai_secretary.sql" >/dev/null
run_c >/dev/null <<'SQL'
insert into public.tenants(id,name) values ('a1479999-0000-0000-0000-000000000001','T');
insert into public.gw_employees(id,tenant_id,display_name,email,status) values ('c1479999-0000-0000-0000-000000000001','a1479999-0000-0000-0000-000000000001','E','e@x','active');
insert into public.gw_slack_ai_events(event_id,slack_team_id,event_payload) values ('EvC','T1','{}');
insert into public.gw_slack_ai_escalations(id,tenant_id,employee_id,requester_slack_user_id,requester_channel,requester_thread_ts,question,status,approved_answer,approval_ts,approved_at,approval_hash)
  values ('d1479999-0000-0000-0000-000000000001','a1479999-0000-0000-0000-000000000001','c1479999-0000-0000-0000-000000000001','U1','D1','1','q','approved_pending_delivery','a','2',now(),'h');
SQL
CLAIM_EV="update public.gw_slack_ai_events set state='processing' where event_id='EvC' and state='queued' returning 'WON'"
CLAIM_ESC="update public.gw_slack_ai_escalations set status='delivery_attempted' where id='d1479999-0000-0000-0000-000000000001' and status='approved_pending_delivery' and approval_hash='h' returning 'WON'"
run_c -c "begin" -c "$CLAIM_EV" -c "$CLAIM_ESC" -c "select pg_sleep(2)" -c "commit" > "$TMP/c147a" 2>&1 &
APID=$!
sleep 0.5
run_c -c "$CLAIM_EV" -c "$CLAIM_ESC" > "$TMP/c147b" 2>&1
wait "$APID"
WINS_A="$(grep -c '^WON$' "$TMP/c147a" || true)"
WINS_B="$(grep -c '^WON$' "$TMP/c147b" || true)"
if [ "$WINS_A" = "2" ] && [ "$WINS_B" = "0" ]; then
  OUT+="NOTICE:  PASS 147 concurrent workers: session A claims event+delivery, blocked session B gets neither"$'\n'
else
  OUT+="NOTICE:  FAIL 147 concurrent workers: A=$WINS_A B=$WINS_B $(tr '\n' ' ' < "$TMP/c147b")"$'\n'
fi
# 緊急復旧の手順（docs/keiei-owner-recovery.md）の SQL を、文書のまま流して確かめる
export SCEN_BLOCKS="$TMP/recovery_blocks.sql"
python3 "$ROOT/test/sql/doc_sql.py" "$ROOT/docs/keiei-owner-recovery.md" > "$SCEN_BLOCKS"
"$PGBIN/createdb" -h "$TMP" -p "$PORT" -U postgres -T kp kp_owner_recovery
OUT+="$("${PSQL[@]}" -d kp_owner_recovery -f "$ROOT/test/sql/owner_recovery.sql" 2>&1 || true)"$'\n'
echo "$OUT" | grep -E "NOTICE:  (PASS|FAIL)" | sed 's/^.*NOTICE:  //'
# シナリオの途中で SQL がエラーになったら（PASS / FAIL の行が出ないまま止まるので）、それも失敗にする
ERRORS="$(echo "$OUT" | grep -c "ERROR:" || true)"
[ "$ERRORS" = "0" ] || { echo "$OUT" | grep -B1 -A3 "ERROR:" | head -30; echo "シナリオの途中でエラー: ${ERRORS} 件"; exit 1; }
FAILS="$(echo "$OUT" | grep -c "NOTICE:  FAIL" || true)"
PASSES="$(echo "$OUT" | grep -c "NOTICE:  PASS" || true)"
echo "PASS ${PASSES} / FAIL ${FAILS}"
[ "$FAILS" = "0" ] && [ "$PASSES" -gt 0 ]
