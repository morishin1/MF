# Sales 商談日時・URL → Googleカレンダー（2026-11-08）

## 操作（既存3ステップ画面の第3段階）
「マッチング・提案」画面の企業ログイン情報の下に「商談日時・Googleカレンダー」を配置。
1. **商談日時（日本時間）**・**所要時間（30/45/60/90分）**・**オンライン商談URL（任意）**を入力する。
2. **Googleカレンダーに追加**を押す。Sales の既存商談DB `gw_sales_meetings` に保存して、Googleカレンダーの予定作成画面を開く。
3. Google側で内容を確認し、**「保存」**を押す。Sales とGoogleは現時点では双方向同期しない。
4. Googleに追加せずSalesだけを更新するときは「日時・URLをSalesへ保存」。

## Google予定の内容
- 件名：「【エイト商談】企業名」
- 開始・終了：入力日時＋所要時間。UTC化して `dates` に指定、`stz` と `etz` は `Asia/Tokyo`
- 詳細：エイトとの商談、オンライン会議URL、企業向け商談ページ（ログイン必須）。
- 営業社内メモ・人材の非公開情報・パスワードは入れない。
- 招待先の自動設定／メール送信はしない。カレンダー側の保存操作が必要。

## 認可とDB
- `/api/sales/company-meeting-calendar`: GETは既存商談、POSTは手動で確定した予定を保存。
- 社内GWのBearer JWTとSales権限、会社IDのテナント照合、ENGER→Sales会社の明示リンクの唯一性が必須。
- Sales企業が営業禁止・非表示・終了済みの場合、スケジュールの書き込みを拒否。
- TimeRexで確定済みなら、その日時やURLを手入力で上書きしない。Google登録のみ可能。
- 再送信で日程・URL・長さが同一なら新規更新しない（履歴重複防止）。
- DB変更は不要：既存 `gw_sales_meetings` の `scheduled_at`, `meeting_url`, `duration_min` を使う。
- Google カレンダー追加は公式テンプレートリンクを使う。Google OAuth接続不要。

## 注意
- カレンダー追加URLは**入力済みの予定作成画面**であり、Google保存成功をSalesで検知できない。
- 変更・キャンセル時に既存Google予定は自動で変更されない。
- 将来の双方向同期には各社員のGoogle OAuth認可、calendar_event_idの保存、更新・重複処理が必要。

## 検証
- `node --test test/sales-company-calendar.mjs` のURL/日時/入力検証
- 企業連携の存在、不正な企業ID、RLS境界、TimeRex既存予約の上書き拒否
- スマホ画面と企業詳細3ステップのレイアウト、Sales予定の再表示
- Vercel previewでのログイン済みテストが終わるまで本番マージしない