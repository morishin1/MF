# 採用HR「資料」＋面談UX（db/136）

## 目的

採用面談で使う会社案内・採用資料・無限道場・サービス資料を HR で一元管理し、面談予定と一緒に選び、面談カードからすぐ開けるようにする。

応募者固有の履歴書・職務経歴書・スキルシートは引き続き gw_hr_documents。会社共通資料は gw_hr_materials として分ける。

## 画面

HR 上部ナビの CEO REVIEW の次に「資料」を追加する。

/hr/materials.html

- URLを登録
- PDFを登録（private bucket hr）
- カテゴリ: 会社案内 / 採用資料 / 無限道場 / サービス / 地方創生 / AI・DX / その他
- カジュアル面談の既定資料
- URLのみ「候補者へ共有可」
- 無効化（物理削除しない）
- プレビュー / 開く / 編集 / 無効化
- 390px は1列

PDF の候補者向け外部共有は今回対象外。

## 面談

応募者詳細 > 面談は scheduled_at の古い順に表示する。同日時ならカジュアルを先にする。追加確認は2件目以降のカジュアル面談として履歴を残す。

面談カード内に、その面談の評価・メモ・資料をまとめる。CEO評価の別サマリーは出さない。

手動でカジュアル面談を作成・編集する場合、面談URLは必須。過去データの空URLは、編集しない限りそのまま残す。

TimeRex連携面談は scheduled_at / meeting_url を TimeRex 正とし、HRでは変更しない。予定日時があるのに面談URLが無い場合は警告し、［面談に参加］を出さない。

面談予定フォームの順:
1. 面談種別
2. 予定日時
3. 面談担当
4. 面談方法
5. 面談URL
6. 面談で使う資料
7. 面談メモ

カジュアル面談では default_for_casual=true の資料を初期選択する。

## DB

db/136_hr_materials_interview.sql

- gw_hr_materials
- gw_hr_interview_materials

RLS は有効。採用HRは SELECT 可。書き込みは認可済み API が service role で tenant_id を絞って行う。

PDF:
- bucket: hr（既存 private bucket）
- path: <tenant>/materials/<uuid>.pdf
- 署名付きURLのみ
- 10MB以下
- PDF magic bytesをサーバで確認

## 適用順

1. db/136_hr_materials_interview.sql
2. db/check_136_hr_materials_interview.sql
3. Previewで資料登録・面談への紐付けを確認
4. PRをマージ
5. 本番確認

db/136 未適用でも既存の応募者詳細と面談表示は動く。資料選択だけを出さない。
