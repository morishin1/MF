#!/usr/bin/env bash
# db/148（日報コーチ）の、二つのセッションでの同時実行の検証。test/sql/run.sh から呼ぶ。
#
#   PSQL="psql -h <sock> -p <port> -U postgres" DB=<148を入れたDB> test/sql/148_concurrency.sh
#
# ■ 何を確かめるか（合成データのみ。ローカルの一時クラスタ専用。リモートDBに向けない）
#   1. 同じレビューを二つのセッションが同時に claim → 片方だけ取れる（行ロック＋世代CAS）
#   2. 同じ人・同じ日の朝の確認を二つのセッションが同時に記録 → 行は1つ、候補の世代も1つだけ進む
#   3. 設定の行をロックしたままの長いトランザクションがあっても、日報の保存（トリガ）は待たされない
#   4. 送信箱の attempt を二つのセッションが同時に → 片方だけ（重複送信の防止）
#   5. 定時確認の実行 lease を二つの呼び出しが同時に → 片方だけ started、もう片方は busy
# 結果は「PASS …」「FAIL …」で出す。FAIL が1つでもあれば終了コード1。
set -uo pipefail
: "${PSQL:?PSQL を指定}" "${DB:?DB を指定}"
Q() { $PSQL -X -q -tA -d "$DB" -c "$1"; }
fails=0
TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
ok() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got $2 / want $3)"; fails=$((fails+1)); fi; }
T=14800000-0000-4000-8000-000000000101; E=14820000-0000-4000-8000-000000000101; U=14810000-0000-4000-8000-000000000101

Q "insert into public.tenants(id,name) values ('$T','合成T並行') on conflict do nothing;
   insert into auth.users(id,email) values ('$U','c@example.invalid') on conflict do nothing;
   insert into public.gw_employees(id,tenant_id,user_id,display_name,status) values ('$E','$T','$U','合成並行','active') on conflict do nothing;
   insert into public.gw_coach_config(tenant_id,enabled,ai_enabled,morning_enabled,delivery_enabled,owner_user_id) values ('$T',true,true,true,true,'$U')
     on conflict (tenant_id) do update set enabled=true,ai_enabled=true,morning_enabled=true,delivery_enabled=true,owner_user_id='$U';
   insert into public.gw_coach_reviews(tenant_id,employee_id,report_date) values ('$T','$E','2026-10-01') on conflict do nothing;" >/dev/null

# 1. claim の同時実行。片方が行ロックを持ったまま2秒待つ間に、もう片方が claim する
RID=$(Q "select id from public.gw_coach_reviews where tenant_id='$T' and report_date='2026-10-01'")
( Q "begin; select public.gw_coach_claim('$RID',1,'14830000-0000-4000-8000-0000000000a1'); select pg_sleep(2); commit;" > "$TMPD/c1" ) &
sleep 0.5
B=$(Q "select public.gw_coach_claim('$RID',1,'14830000-0000-4000-8000-0000000000a2')")
wait
A=$(head -1 "$TMPD/c1"); rm -f "$TMPD/c1"
ok "concurrent claim: first session wins" "$A" "t"
ok "concurrent claim: second session refused after lock wait" "$B" "f"
ok "single processing token" "$(Q "select count(*) from public.gw_coach_reviews where id='$RID' and state='processing' and claim_token='14830000-0000-4000-8000-0000000000a1'")" "1"

# 2. 朝の確認の同時記録（同じ版）
REV='{"state":"owner_review","epoch":"final:2026-10-02","draft":{"id":"d","epoch":"final:2026-10-02"}}'
for i in 1 2; do
  ( Q "select public.gw_coach_record_check('$T','$E','2026-10-05','morning','check','2026-10-02','2026-10-05','hc','{}'::jsonb,'$REV'::jsonb)->>'check'" > "$TMPD/r$i" ) &
done
wait
R="$(sort "$TMPD/r1" "$TMPD/r2" | tr '\n' ' ')"; rm -f "$TMPD/r1" "$TMPD/r2"
ok "concurrent morning record: one created, one unchanged" "$R" "created unchanged "
ok "one check row" "$(Q "select count(*) from public.gw_coach_checks where tenant_id='$T' and check_date='2026-10-05'")" "1"
ok "review generation advanced once" "$(Q "select generation from public.gw_coach_reviews where tenant_id='$T' and report_date='2026-10-02'")" "1"

# 3. 設定をロックしたままでも、日報の保存は待たされない（2秒以内に終わる）
( Q "begin; update public.gw_coach_config set ai_enabled=true where tenant_id='$T'; select pg_sleep(3); commit;" >/dev/null ) &
sleep 0.5
S=$(date +%s%N)
Q "set statement_timeout='2s'; insert into public.tc_nippo(user_id,work_date,submitted_at) values ('$U','2026-10-03',now());" >/dev/null 2>&1; RC=$?
MS=$(( ($(date +%s%N)-S)/1000000 ))
wait
ok "nippo save not blocked by locked config row" "$RC" "0"
ok "nippo save finished under 1.5s (${MS}ms)" "$([ $MS -lt 1500 ] && echo yes || echo no)" "yes"
ok "event appended" "$(Q "select count(*) from public.gw_coach_events where tenant_id='$T' and report_date='2026-10-03'")" "1"

# 4. 送信箱の attempt を同時に
OID=$(Q "select (public.gw_coach_outbox_upsert('$T','owner_report','2026-10-05','morning','合成','bh','{\"kind\":\"dm\"}'::jsonb,'th','sh'))->>'id'")
Q "select public.gw_coach_outbox_approve('$OID',1,'{\"body_hash\":\"bh\",\"target_hash\":\"th\",\"generation\":1,\"actor_user_id\":\"$U\"}'::jsonb)" >/dev/null
for i in 1 2; do
  ( Q "select public.gw_coach_outbox_attempt('$OID',1,gen_random_uuid())" > "$TMPD/o$i" ) &
done
wait
R="$(sort "$TMPD/o1" "$TMPD/o2" | tr '\n' ' ')"; rm -f "$TMPD/o1" "$TMPD/o2"
ok "concurrent attempt: exactly one" "$R" "f t "

# 5. 外部の定時呼び出しが同時に2回（P の再試行など）→ 片方だけ実行、もう片方は busy
for i in 1 2; do
  ( Q "select public.gw_coach_run_begin('$T','2026-10-05','morning','key-concurrent-$i',gen_random_uuid())->>'run'" > "$TMPD/b$i" ) &
done
wait
R="$(sort "$TMPD/b1" "$TMPD/b2" | tr '\n' ' ')"
ok "concurrent run begin: one started, one busy" "$R" "busy started "

# 後片付け（他のシナリオに影響させない）
Q "delete from public.gw_coach_runs where tenant_id='$T'; delete from public.gw_coach_outbox where tenant_id='$T'; delete from public.gw_coach_checks where tenant_id='$T';
   delete from public.gw_coach_events where tenant_id='$T'; delete from public.gw_coach_reviews where tenant_id='$T';
   update public.gw_coach_config set enabled=false,ai_enabled=false,morning_enabled=false,delivery_enabled=false where tenant_id='$T';" >/dev/null
[ "$fails" = "0" ]
