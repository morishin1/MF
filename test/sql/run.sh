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
#   （db/101・db/102・db/103・db/104 は、シナリオの中で流す。安全装置が止めるところ・表が無いときから確かめるため）
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
export SCEN_ROOT="$ROOT"   # 101 のシナリオが、db/101 を読むために使う
for sc in 099_owner_only 100_hr_pay 101_hr_pay_clear 102_contracts_pay_rls 103_tool_access 104_onboarding_guide check_exposure; do
  "$PGBIN/createdb" -h "$TMP" -p "$PORT" -U postgres -T kp "kp_$sc"
  OUT+="$("${PSQL[@]}" -d "kp_$sc" -f "$ROOT/test/sql/$sc.sql" 2>&1 || true)"$'\n'
done
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
