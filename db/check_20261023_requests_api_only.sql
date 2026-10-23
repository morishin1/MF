-- GWの有給・稟議 二段階承認：本番SQLの適用前・適用後チェック（読み取り専用）
-- db/20261023_requests_api_only.sql の適用に必要な状態を個人情報なしで確認。
-- 修正SQLの適用までは API 経由以外の更新が残る可能性があるため本番有効化しない。

-- 1) 基本テーブル・RLS
SELECT to_regclass('public.gw_requests') IS NOT NULL AS requests_table_exists,
       COALESCE((SELECT relrowsecurity FROM pg_class
                 WHERE oid = to_regclass('public.gw_requests')), false) AS rls_enabled;

-- 2) UPDATEポリシーを確認：SQL適用後は gw_requests_update の
--    qual と with_check がどちらも false で、直接のUPDATEを拒否する。
SELECT policyname, cmd, roles, qual, with_check
  FROM pg_policies
 WHERE schemaname='public' AND tablename='gw_requests'
 ORDER BY policyname;

-- 3) 想定の更新遮断ポリシーが1件あるか（他のUPDATE許可ポリシーも2番で必ず目視）
SELECT EXISTS(
  SELECT 1 FROM pg_policies
   WHERE schemaname='public' AND tablename='gw_requests'
     AND policyname='gw_requests_update' AND cmd='UPDATE'
     AND regexp_replace(COALESCE(qual,''), '[()[:space:]]', '', 'g') = 'false'
     AND regexp_replace(COALESCE(with_check,''), '[()[:space:]]', '', 'g') = 'false'
) AS update_policy_denies_direct_updates;

-- 4) 承認待ちの状態を保持できるか（制約名・定義のみ表示、社員データなし）
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = to_regclass('public.gw_requests')
   AND contype = 'c'
   AND pg_get_constraintdef(oid) ILIKE '%status%'
 ORDER BY conname;
