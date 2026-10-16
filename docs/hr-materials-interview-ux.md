# 採用HR「資料」＋面談UX（db/136）

## 目的

面談のたびに会社案内・採用資料・無限道場・サービス資料のURLを探さず、
採用HRの「資料」タブで共通管理し、面談設定時に選び、面談カードから1クリックで開けるようにする。

## 画面

- 上部ナビ：CEO REVIEW の次に「資料」
- URL：HTTPSのみ
- PDF：private bucket `hr` の `<tenant>/materials/<uuid>.pdf`
- カテゴリ：会社案内 / 採用資料 / 無限道場 / サービス / 地方創生 / AI・DX / その他
- 無効化：物理削除せず `is_active=false`
- カジュアル面談の初期資料：`default_for_casual=true`
- 候補者向けに共有可能：URL資料だけ `share_external=true`

## 面談

面談予定フォームの順番：

1. 面談種別
2. 日時
3. 面談担当
4. 面談方法
5. 面談URL
6. 面談で使う資料
7. 面談メモ

手動のカジュアル面談は面談URLを必須とする。
TimeRex同期済み面談は引き続きTimeRexを正とする。
過去のURL未登録データは強制更新しないが、カードに警告を出し、参加ボタンは出さない。

面談タブは scheduled_at の古い順で表示する。
評価は各面談カードの中に表示し、社長面談の評価だけを面談一覧上部に重複表示しない。

## 資料と面談の紐付け

- `gw_hr_interview_materials`
- 面談設定時に選択
- 面談後も［資料を変更］から差し替え可能
- 面談カードに資料ボタンを表示
- URL資料はそのURL、PDFは毎回短時間のsigned URLを発行して開く

カジュアル面談の日程調整メール文面には、
`default_for_casual=true` かつ `share_external=true` のURL資料を自動で追記する。

## DB

`db/136_hr_materials.sql`

追加：

- `gw_hr_materials`
- `gw_hr_interview_materials`

既存の `gw_hr_documents` は応募者本人の書類なので再利用しない。

確認：

`db/check_136_hr_materials.sql`

rollback：

`db/rollback_136_hr_materials.sql`

## 本番適用順

1. db/136
2. check_136
3. PRマージ
4. /hr/materials.html で会社案内などを登録
5. 応募者の面談設定で資料が初期選択されることを確認

このPRでは本番SQLを自動実行しない。
