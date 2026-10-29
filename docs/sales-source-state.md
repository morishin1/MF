# ENGERの削除・企業回答をSalesへ表示

既存のHMAC署名付き `POST /api/sales/proposals/intake` に `proposal.source_state` を追加。
既存の提案・営業履歴・手動アーカイブを削除・書換えない。

## 正本と契約

- ENGER `proposals.deleted_at` → `deleted`。人材・案件自体の削除と推測で混ぜない。
- ENGER `proposals.job_action_type` → `unanswered / proceed / pass / null`。
  人材側 `cand_action_type`、営業ステージ、メール開封は企業回答にしない。
- `source_state.source` は `enger.proposals.job_action_type` 固定。
- `source_state.version` は送信元DBの正のbigintを十進文字列で渡す。
- `occurred_at` は状態をDBで観測した時刻。回答者が操作した時刻とは表示しない。
- 同じ版を別内容で送ることは禁止。未回答へのリセットも新しい版が必要。

## 順序と表示

MFの `gw_sales_proposal_source_state` はテナント＋ENGER提案IDで状態を保持する。
専用のservice-role限定RPCが行ロックし、古い版を無視、同版異内容を拒否する。
提案の起票前に届いた削除も保持する。古いmatched/sent/updatedイベントは状態表に触れず、削除状態を解除できない。
復元はENGERから届く新しい版の `deleted:false` だけで行う。Salesの手動アーカイブは独立して保持する。

削除状態は一覧・絞り込み件数・KPI・今日タスク集計から外す。
詳細URLでは既存履歴を保持して表示し、ENGERゴミ箱済みと明示する。
企業名の下に実記録の企業回答を表示する。記録なし/不明は回答を創作しない。
新規の社員通知や宛先は追加しない。削除が先に届いた提案の起票通知は抑制する。

## 適用順序

1. MF `db/149_sales_proposal_source_state.sql` を正しいGW DBで適用。
2. MF受信・表示コードを本番へ反映。SQL確認後にサーバ環境 `SALES_SOURCE_STATE_ENABLED=1` を設定する（秘密値ではない）。
3. ENGERの対応outbox trigger SQLとコードを適用し、既存レコードのsnapshot送信を確認。
4. 本番で削除→非表示、復元→再表示、企業回答→表示、逆順再送→古い状態へ戻らないことを確認。

MF SQL未適用中は従来表示を維持し、同期未設定の注意を表示する。
有効化後は表の消失もエラーとし、未削除扱いに戻さない。権限・通信等の読取失敗は有効化前もエラーにする。
新イベントは503で再送対象となる。SQLを準備しただけで連携完了とは扱わない。
ソース状態の更新は既存の固定テナント設定と署名検証を通る。ブラウザ・他テナントから更新できない。
