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
#   （db/101・db/102・db/103・db/104・db/105・db/110・db/123・db/124・db/125・db/088→094→119→120→130（Sales の権限）・db/131（AI営業）は、シナリオの中で流す。安全装置が止めるところ・表が無いときから確かめるため）
#   最後に、緊急復旧の手順（docs/keiei-owner-recovery.md）の SQL を、文書のまま流して確かめる（owner_recovery.sql）
#   db/131 の予算の予約は、psql を同時に 20 本走らせて上限を超えないことも確かめる（131 並列）
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
export SCEN_ROOT="$ROOT"   # 101 のシナリオが、db/101 を読むために使う
for sc in 099_owner_only 100_hr_pay 101_hr_pay_clear 102_contracts_pay_rls 103_tool_access 104_onboarding_guide 105_compensation 110_labor_notices 123_retire_case 124_hr_mail_templates 125_office_recurring 126_grant_rules 127_retire_cert_requests 130_sales_access 131_sales_ai check_pay_reconcile check_exposure; do
  "$PGBIN/createdb" -h "$TMP" -p "$PORT" -U postgres -T kp "kp_$sc"
  OUT+="$("${PSQL[@]}" -d "kp_$sc" -f "$ROOT/test/sql/$sc.sql" 2>&1 || true)"$'\n'
done
# 131 並列：AI の予算の予約を同時に 20 本（1本 0.10 ドル）走らせても、月の上限（1.00 ドル）を超えない。
#   予約は設定行をロック（for update）してから合計を見る。対照として、ロックを外した版では上限を超えることも確かめる
#   （同時に走っていなければ、ロックが無くても超えないので、試験そのものが効いていないことになる）
conc() {  # $1 = DB 名, $2 = 131 の SQL ファイル → 予約できた数と合計を「件数|合計」で返す
  "$PGBIN/createdb" -h "$TMP" -p "$PORT" -U postgres -T kp "$1"
  for f in db/088_sales.sql db/094_recruit_sales_roles.sql db/119_app_grants.sql db/120_left_gate.sql db/130_sales_access_align.sql; do
    "${PSQL[@]}" -v ON_ERROR_STOP=1 -d "$1" -f "$ROOT/$f" >/dev/null 2>"$TMP/err" || { echo "失敗: $f" >&2; cat "$TMP/err" >&2; return 1; }
  done
  "${PSQL[@]}" -v ON_ERROR_STOP=1 -d "$1" -f "$2" >/dev/null 2>"$TMP/err" || { echo "失敗: $2" >&2; cat "$TMP/err" >&2; return 1; }
  "${PSQL[@]}" -v ON_ERROR_STOP=1 -d "$1" -f "$ROOT/test/sql/131_concurrency_setup.sql" >/dev/null 2>"$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  local pids=() i
  for i in $(seq 20); do
    "${PSQL[@]}" -d "$1" -c "begin; select * from public.gw_sales_ai_reserve('88888888-8888-8888-8888-888888888888', 0.10, 'draft', 'm', null, null); select pg_sleep(0.5); commit;" >/dev/null 2>&1 &
    pids+=($!)
  done
  wait "${pids[@]}"
  "${PSQL[@]}" -At -d "$1" -c "select count(*) || '|' || coalesce(sum(reserved_usd), 0)::numeric(10,2) from public.gw_sales_ai_usage where status = 'reserved'"
}
GOT="$(conc kp_131c "$ROOT/db/131_sales_ai.sql")"
[ "$GOT" = "10|1.00" ] && OUT+="NOTICE:  PASS 131並列 同時に20本予約しても上限 1.00 ドルを超えない : $GOT"$'\n' \
                       || OUT+="NOTICE:  FAIL 131並列 同時に20本予約しても上限 1.00 ドルを超えない : got $GOT / want 10|1.00"$'\n'
sed 's/ for update;/;/' "$ROOT/db/131_sales_ai.sql" > "$TMP/131_nolock.sql"
GOT="$(conc kp_131n "$TMP/131_nolock.sql")"
[ "${GOT%%|*}" -gt 10 ] && OUT+="NOTICE:  PASS 131並列（対照）ロックを外すと上限を超える＝本当に同時に走っている : $GOT"$'\n' \
                        || OUT+="NOTICE:  FAIL 131並列（対照）ロックを外すと上限を超える＝本当に同時に走っている : got $GOT"$'\n'
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
