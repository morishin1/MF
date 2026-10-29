# Marketing PR：画像原本の非公開保存（DB 適用が必要）

2026-10-29。引継ぎパッチ（local/marketing-pr-media、base 2a5cc00）の画像保存部分を最新 main に組み直したもの。
自由セクション・本文への写真の割り当て（DB 変更なし）は先行 PR に分けてある。この PR はその上に重ねる。

**この PR は SQL を流してからマージする。** 先にマージすると、画像を選んだ下書き保存が「画像保存先が未準備」で失敗し、
画像付きの原稿は本登録もできなくなる（いまはファイル名・説明だけで保存・本登録できる）。

## できること・できないこと

- 下書き保存のときに、選んだ JPEG/PNG（各2MB以下）を非公開の保存先へ送る。サーバで実際にデコードし（sharp）、
  向きを直して PNG（長辺2400px以内）に作り直してから保存する。SVG・壊れたファイル・8000px 超は受け付けない
- 下書きに入るのは画像原本の ID だけ。画像の URL・本体は入れない。表示は、本人の保存済み下書きに載っている画像だけ、
  60秒の署名付き URL で返す
- 本登録には、すべての画像の原本が保存済みであることが要る（`image_upload_required`）
- **自社サイトへの公開に画像は出さない**（公開本文は文字だけ。画像説明は文字で入る）。公開サイトへの画像配信は別作業
- 原本は消さない（上限：会社2,000件・1人500件・1原稿100件・1人1時間20件）。上限に達したら保管状況を運用責任者が確認する

## 適用順

| 順 | 作業 | 確認 |
|---|---|---|
| 0 | 前提：`db/proposal_marketing_pr_drafts.sql` が適用済み | `select to_regclass('public.gw_marketing_pr_drafts');` が null でない |
| 1 | 先行 PR（自由セクション・本文の写真）をマージ | 本番の PR 作成で、追加セクションが保存・再表示できる |
| 2 | `db/proposal_marketing_pr_images.sql` を承認のうえ SQL エディタで1回流す（1トランザクション。再実行は policy 作成で止まる） | ― |
| 3 | `db/check_marketing_pr_images.sql`（読むだけ）を流す | 下の「期待する結果」 |
| 4 | この PR の Preview で、架空の原稿・架空の画像で確認（下の手順） | ― |
| 5 | この PR をマージ → 本番で同じ確認を1回 | ― |

### 3 の期待する結果

- `storage.buckets`：`marketing-pr-images` が `public=false`・`file_size_limit=2097152`・`allowed_mime_types={image/png}`
- `pg_class.relrowsecurity`：`true`
- 権限：`anon_read=false`・`authenticated_read=false`・`authenticated_write=false`・`server_read=true`
- `pg_policies`：`marketing_pr_images_no_direct` が `RESTRICTIVE`・roles `{anon,authenticated}`（ほかの bucket の policy は変わらない）
- `pg_proc`：`gw_marketing_pr_image_reserve`・`gw_marketing_pr_image_finish` の `prosecdef=false`、実行権限は service_role（と所有者）だけ

### 4・5 の確認（実データを壊さない）

1. マーケティング権限のある確認用アカウントで、PR 作成に**架空の**タイトル（例「確認用・架空」）と小さな架空 PNG を入れて下書き保存
2. 画面を再読み込み → 保存済み下書きを開く → 画像が出る（`/api/marketing/pr-images?draftId=…&imageId=…` が `expiresIn:60` の URL を返す）
3. 返った URL を60秒後に開くと見られない。ログインしていないブラウザ・別アカウントでは同じ API が 403/404
4. 画像を「原稿から外す」→ 保存 → 同じ imageId の API が 404
5. 自社サイトへ公開しない（公開処理は押さない）。PR TIMES・SNS・メールは未接続のまま

**注意：** 下書きの削除機能は無いため、確認用の架空原稿と画像の記録は本番 DB に残る。名前で「確認用・架空」と分かるようにし、
実績として数えない。確認自体を本番で行うかは、DB 適用と同じく承認を取る。

## 依存の追加

- `sharp 0.34.5`（`package.json`・`package-lock.json`）。Vercel の Preview ビルドで、`api/marketing/pr-images.js` が
  sharp を読み込めること（関数のサイズ・Linux 用バイナリ）を確かめてからマージする

## 取り消し

`db/proposal_rollback_marketing_pr_images.sql`（提案）。記録・原本が1件でもあれば止まる。bucket と policy は
空を確かめて管理画面で bucket を消してから policy を消す（順番を逆にしない）。コードは revert で戻す（DB を先に戻すと保存が 503 になる）。
