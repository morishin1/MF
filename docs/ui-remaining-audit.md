# UI 残件表（2026-10-06 / main `33d8c9e` 時点）

調べた範囲：リポジトリ直下・`hr/`・`sales/`・`office/`・`keiei/`・`onboarding/` の全 HTML（80 ファイル）。
方法：

1. 静的に調べる（共通ヘッダーを使っているか、左サイドバー、フォント、色、asset の版）
2. 実ブラウザで開く（Chromium。経営者と一般メンバーの2通り、1280px と 390px）
   - `.topbar`・業務切替（採用HR｜Sales｜Office｜経営）・`.kp-sidebar`・横タブ・body のフォントと背景色・横はみ出し量を測った

**この調査のコード変更はありません（この文書だけ）。**

## 調べ方の限界
- API は空の応答で開いている。**実データが入ったときの崩れは測っていない**（本番 E2E で見る）
- 色の判定：`yellow` などの文字列検出は、Office 月次の状態ピル（`#fbf1d6`）などの誤検出だった。旧 Office の lime 系の復活は見つからなかった

## 判明した全体像
| 領域 | 見た目 |
|---|---|
| Office（`/office/*` と Office 領域の `admin-*` 17 画面） | 新デザイン（Zen Kaku・#f6f6f2・横タブ・共通ヘッダー） |
| 経営（`/keiei/`） | 新デザイン（#81 で完了） |
| 採用HR（`/hr/*`） | 新デザイン（Zen Kaku・#f6f6f2）。ただし**専用ヘッダーで、共通ヘッダーが無い** |
| Sales（`/sales/*`） | 新デザイン。**専用ヘッダーで、共通ヘッダーが無い** |
| メンバー向け（ホーム・タスク・日報・勤怠 ほか約 25 画面） | **旧デザイン**（Noto Sans・背景 #f5f7fb・左サイドバー） |
| 管理画面のうち経営系・設定系（11 画面） | **旧デザイン**（左サイドバー・Noto Sans・#f5f7fb） |
| 旧 KessanPilot 系（`dashboard`・`closing-check` ほか） | 共通ヘッダー無し・旧配色・390px で大きくはみ出す |

## 残件表
優先度：P0＝通常業務を妨げている／P1＝日常的に使う主要画面／P2＝管理・補助／P3＝廃止候補・古い Preview

| 業務 | URL / ファイル | 現状 | 問題 | 対応 | 優先度 |
|---|---|---|---|---|---|
| HR | `/hr/`・`hr/applicants.html`・`hr/ceo-review.html`・`hr/document.html`（`js/hr-layout.js`） | 専用ヘッダー `.hr-bar`（ロゴ・戻る・3タブ・操作）。390px で**横に約 740px はみ出す**（`.hr-nav` が縮まず、画面全体の幅が 1,120px 超になる） | スマホで主要操作ができない（計画の完成条件「390px で主要操作」を満たさない） | ヘッダーを横スクロールのタブにする（幅の修正だけ。機能は変えない）。→ 共通ヘッダー化（次行）と同じ PR | **P0** |
| HR | 同上 | 共通ヘッダー（採用HR｜Sales｜Office｜経営）が無い。「GWへ戻る」のリンク先が `admin-dashboard.html`（→ `/office/` へ転送）で、**採用HRから押すと Office に飛ぶ**。ナビは 3 つ（ダッシュボード・応募者・CEO REVIEW）。計画の「ホーム｜応募者｜面談｜CEO REVIEW｜リード｜オファー」とは差がある | HR だけ別アプリに見える。業務間の移動ができない | 共通ヘッダーを載せる（`/api/me` の access を正本）。タブ構成は、計画どおりにするか現状の画面に合わせるかを決めてから（下の確認事項） | P1 |
| Sales | `sales/*.html` 8 画面（`js/sales-layout.js`） | 専用ヘッダー `.sl-bar`。390px ははみ出さない。ナビは 5 つ（ダッシュボード・企業・アタック・リード・分析）。キャンペーン・テンプレートはナビに無く、本文中のリンクだけ | 共通ヘッダー無し（「GWへ戻る」は `home.html`）。キャンペーン・テンプレートに行く導線が弱い | 共通ヘッダーを載せる。ナビにキャンペーン・テンプレートを入れるか決める | P1 |
| Sales | `sales/*.html` 8 画面 | `css/app.css?v=20260927-sales4`（他の画面は `20261005keiei1`）。`css/app.css` は 10/2（`166bc5e`）に更新されている | **古い版のまま**。1 年 immutable のキャッシュを持つ端末は、更新前の CSS で表示する | 版を揃える（`api/health.js`・`test/asset-versions.json`・`asset-hashes` も更新） | P1 |
| メンバー | `home`・`tasks`・`nippo`・`schedule`・`timecard`・`requests`・`expenses`・`messages`・`notices`・`library`・`directory`・`career`・`mypage`・`contracts`・`menu`・`workflow`・`booking`・`doc`・`onboarding.html`・`onboarding/index`・`device-consent`・`device-setup`（.html） | 左サイドバー（`MEMBER_SIDE_NAV`）＋Noto Sans＋背景 #f5f7fb。モバイルは下タブ | 計画の共通ルール（左サイドバー無し・Zen Kaku・#f6f6f2）と違う。ただし**10/2 の「左は自分の仕事・上は担当業務」（Nav v2）でご指示いただいた構成** | **方針を決めてから**（下の確認事項 1）。決まれば `js/layout.js`・`css/layout.css` の共通部分を直すだけで全画面が変わる | P1（要判断） |
| 経営 | `admin-team.html`・`admin-tasks.html`・`admin-goals.html`・`admin-nippo.html`（`/keiei/` の「人・組織」から開く既存画面） | 左サイドバー＋旧配色。`/keiei/` の横タブとは別の見た目 | 経営の中で見た目が切り替わる | 経営の横タブ（`renderKeieiNav`）を使う。画面の中身は変えない | P1 |
| Office | Office 領域の `admin-*` 17 画面（`admin-members`・`hr`・`timecard`・`requests`・`contracts`・`esign`・`career`・`growth`・`autonomy`・`probation`・`onboard`・`expenses`・`closing`・`month-start`・`docs`・`notices`・`site-news`） | 新デザイン（Zen Kaku・横タブ・共通ヘッダー）。**390px で 13px 横にはみ出す**（全画面共通） | Office の 2 段目タブ帯（`.kp-ostab`）が 390px に収まらない | 共通 CSS 1 か所を直す（1 PR で全画面） | P2 |
| Office | `office/*.html`（index・monthly・billing・terms・timesheet） | 新デザイン。390px ははみ出さない | 問題なし（月次の状態ピルの黄色は意図した色） | なし | — |
| 設定系（社内管理） | `admin-ai`・`admin-analytics`・`admin-assets`・`admin-blocks`・`admin-bookings`・`admin-devices`・`admin-settings`（.html） | 左サイドバー＋旧配色（`SETTINGS_ITEMS`）。Office の「社内管理」タブ（お知らせ・社内文書）とは別の領域 | 同じ「社内管理」なのに見た目が 2 種類 | Office の「社内管理」の中に入れて横タブにする（画面の中身は変えない） | P2 |
| メンバー | `schedule.html` | 1280px で 7px、390px で 25px はみ出す（下タブ帯） | 軽微 | 共通のタブ帯の幅を直す（メンバー方針と同じ PR） | P2 |
| 社外向け | `advisor.html`（社労士） | 左サイドバー＋旧配色 | 社外の人専用で、使う人が限られる | 方針（メンバー）に合わせる | P3 |
| 社外向け・公開 | `hr/offer.html`・`onboarding/notice.html`・`hr/document.html`（別タブ）・`guest-home`・`guest-invite`・`billing-submit` | 公開画面・別タブ。`hr/offer.html`・`onboarding/notice.html` は Zen Kaku、`guest-*`・`billing-submit` は Noto Sans＋青系背景 | 共通ヘッダーを使わないのは意図どおり。`guest-*`・`billing-submit` だけ色とフォントが違う | `guest-*`・`billing-submit` の色・フォントを揃える（任意） | P3 |
| Sales | `sales/analytics-preview.html`（1,156 行） | Preview 専用。`test/salesassets.mjs` が存在を前提にしている。`analytics.html`（341 行）とは別内容 | 正式版（`analytics.html`）に反映済みかどうか、このスキャンでは**確認できていない** | 反映済みかを確認してから、ファイルとテストの前提を一緒に削除 / 閉鎖。PR #37（Draft）も同じ件 | P3 |
| 旧URL | `hr-applicants`・`hr-ceo-review`・`hr-dashboard`・`hr-offer`（.html）、`admin-dashboard.html` | 転送だけ（12〜19 行）。実画面は `/hr/*`・`/office/` | 二重にはなっていないが、旧ファイルが残っている | 古いリンクの利用が無いことを確認して削除（期限を決める） | P3 |
| 旧 KessanPilot | `dashboard`・`closing-check`・`journal-approval`・`report-generator`・`review`・`client-report`（.html）、`biz/*` 7 画面、`app.html`、`admin.html`（Office の「会計」リンク先） | 共通ヘッダー無し・旧配色。390px で 93〜507px はみ出す | `CLAUDE.md` で `client-report.html`・`biz/` は不要（`_archive/` へ退避予定）。他は自社経理ツールの画面 | 廃止 / `_archive/` へ（確認事項 2） | P3 |

## 確認事項（ご判断をお願いします）
1. **メンバー向け画面（約 25 画面）の左サイドバー**：計画の共通ルールでは廃止ですが、10/2 に「左は自分の仕事」と決めた構成です。廃止して上の横タブにするか、メンバー向けだけは今の構成を残して色・フォントだけ揃えるか。
2. **旧 KessanPilot 系**（会計の `admin.html`・`app.html` を含む）：廃止 / `_archive/` に移してよいか。`admin.html` は Office の「会計」から開かれているため、リンクの扱いも決めたい。
3. **HR のタブ構成**：計画の「ホーム｜応募者｜面談｜CEO REVIEW｜リード｜オファー」にするか、現在の 3 タブ（ダッシュボード・応募者・CEO REVIEW）を横タブ化するだけにするか（面談・リード・オファーは今、独立した画面ではない）。
4. **P0 の判定**：「HR が 390px で使えない」を P0 としました（スマホでの通常業務が止まるため）。本番で報告された P0（メンバーが使えない）があれば、それが先です。内容を教えてください。

## 進め方（確認後）
1. P0：HR ヘッダー（390px）＋共通ヘッダー化（HR・Sales）＋ Sales の版揃え → PR + Preview
2. P1：経営系の管理画面を横タブへ → メンバー向け（確認事項 1 の結果に従う）
3. P2：Office の 13px、設定系を社内管理へ
4. P3：Preview・旧 URL・旧 KessanPilot の整理（確認後）
5. 本番 E2E → 古い PR（#62・#57・#49・#45・#37・#24 など）の整理
