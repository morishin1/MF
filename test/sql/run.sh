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
#   db/schema.sql → db/005 → db/041 → db/099 → test/sql/099_owner_only.sql
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
"${PSQL[@]}" -d kp -c "grant all on all tables in schema public to authenticated, service_role; grant execute on all functions in schema public to authenticated, service_role;" >/dev/null
run "$ROOT/db/099_owner_only.sql"
run "$ROOT/db/099_owner_only.sql"   # べき等（2回流しても同じ）

OUT="$("${PSQL[@]}" -d kp -f "$ROOT/test/sql/099_owner_only.sql" 2>&1 || true)"
echo "$OUT" | grep -E "NOTICE:  (PASS|FAIL)" | sed 's/^.*NOTICE:  //'
FAILS="$(echo "$OUT" | grep -c "NOTICE:  FAIL" || true)"
PASSES="$(echo "$OUT" | grep -c "NOTICE:  PASS" || true)"
echo "PASS ${PASSES} / FAIL ${FAILS}"
[ "$FAILS" = "0" ] && [ "$PASSES" -gt 0 ]
