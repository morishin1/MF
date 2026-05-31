# DriveKeiri — 法人向け「スキャンするだけ」会計AIサービス（モックデモ）

KessanPilot のエコシステム内で、**顧問先企業（法人）が使う側**のサービスです。

## コンセプト

> **書類をスキャンしてGoogle Driveに入れるだけ。**
> **あとはAIが書類を判別し、読み取り、仕訳候補を作り、税理士に送ります。**

- 会計知識ゼロの経営者・経理担当を想定
- 会計用語（仕訳・勘定科目・借方貸方など）を極力使わない
- 操作はほぼゼロ：Driveに入れる → AIが動く → 月末にレポートが届く
- KessanPilot（税理士側）と自動連動：生成された仕訳候補は税理士の承認キューへ

## 画面一覧

| ファイル | 画面 | 役割 |
|---|---|---|
| `biz/index.html` | ログイン | 左：サービス説明、右：ログインフォーム |
| `biz/home.html` | ホーム | 今月の状況、処理フロー可視化、直近書類 |
| `biz/drive.html` | Google Drive 連携 | フォルダ構成、接続状況、アップロード |
| `biz/processing.html` | 書類の処理状況 | AIが今どの段階かをステータスで表示 |
| `biz/questions.html` | AIからの質問 | 選択式で用途を確認 |
| `biz/report.html` | 月次レポート | 税理士が確認済みの経営レポート閲覧 |

## KessanPilot との連動シナリオ

```
【法人側 - DriveKeiri】
  法人が書類をGoogle Driveに保存
       ↓
  AIが判別・読取・仕訳候補作成（自動）
       ↓
  不明点があれば法人に質問（選択式）
       ↓
【会計事務所側 - KessanPilot】
  税理士の承認キューに届く
       ↓
  税理士が承認／修正 → MF会計に登録
       ↓
  月次締めチェック → 経営レポート生成
       ↓
【法人側 - DriveKeiri】
  月次レポート配信
```

## 技術構成

- 純粋な HTML + CSS + JavaScript（ビルド不要）
- `../css/style.css` を共通ベースとして利用
- `css/biz.css` に法人向け追加スタイル
- `js/biz-data.js` に法人視点のモックデータ
- `js/common.js` に法人向けサイドバー・ヘッダー

## ブランディング

- サービス名：**DriveKeiri（ドライブケイリ）**
- サブ：**by KessanPilot**
- タグライン：**スキャンするだけの経理**
- カラー：KessanPilotと同系統（紺＋アクセント）、ただし法人向けはやや明るく親しみやすく

## デモの見せ方（営業向け）

### 対法人オーナーへの訴求シナリオ（3分）

1. `biz/index.html` → 「書類を入れるだけ」のコンセプトを見せる
2. `biz/home.html` → 「今月72件の書類のうち65件はAIが自動処理」で驚かせる
3. `biz/drive.html` → 「普段使っているGoogle Driveにそのまま入れるだけ」を強調
4. `biz/processing.html` → 「いま自分の書類がどこまで進んでいるか可視化」で安心感
5. `biz/questions.html` → 「稀に来る質問も選択式だから会計知識不要」
6. `biz/report.html` → 「月末には社長が読める経営レポートが届く」

### 収益モデルとの関連

- DriveKeiri の月額課金は **会計事務所が顧問先に再販**
- 事務所仕入：1社あたり月3,000円
- 事務所販売：1社あたり月5,000〜10,000円
- 事務所粗利：1社あたり月2,000〜7,000円
- 「顧問料は据え置きで経理DXサービスを追加」という営業トークが可能

## 全ファイル構成（KessanPilot全体）

```
会計/
├── index.html              （税理士側ログイン）
├── dashboard.html          （税理士ダッシュボード）
├── closing-check.html      （① 月次締めチェック）
├── journal-approval.html   （③ 仕訳承認）
├── report-generator.html   （② レポート生成）
├── client-report.html      （顧問先閲覧用プレビュー）
├── css/style.css
├── js/
│   ├── mock-data.js
│   └── common.js
└── biz/                    ⭐NEW：法人向けシステム
    ├── index.html
    ├── home.html
    ├── drive.html
    ├── processing.html
    ├── questions.html
    ├── report.html
    ├── README.md
    ├── css/biz.css
    └── js/
        ├── biz-data.js
        └── common.js
```
