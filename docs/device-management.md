# 端末管理（EIGHT PC Agent）設計

会社が貸与した Windows PC の **業務利用状況を可視化し、情報漏えいを防ぐ**ための仕組み。
mf.8grp.co.jp（グループウェア）の一機能として作る。

---

## 0. 先に決めておくこと（実装より前）

この機能は、**技術より先に手続きが要る。** ここを飛ばすと、集めたデータ自体が使えなくなる。

### 0-1. 就業規則への明記が先

会社が業務PCの利用状況を継続的に記録する場合、**就業規則（または情報セキュリティ規程）への明記と、本人への周知**が要る。
根拠は個人情報保護法（利用目的の特定・通知）と、労働契約法上の合理性。

書くべきこと。

| 項目 | 書く内容 |
|---|---|
| 目的 | 情報漏えい防止・貸与端末の適正管理・セキュリティ事故の検知 |
| 取得する項目 | 起動終了 / 稼働時間 / 起動中のアプリ名 / 閲覧サイトのカテゴリ / USB接続 / ソフトのインストール |
| **取得しないもの** | キー入力・パスワード・メール本文・チャット本文・画面録画・ウィンドウのタイトル・URLの全文 |
| 保存期間 | 個別記録90日 / 日別の集計13か月 |
| 見られる人 | 人事・経営者と、**本人** |
| 私用端末 | 対象外（会社貸与PCのみ） |

**「監視」ではなく「端末管理」**として書く。実装もそう作る（後述の 1-2）。

### 0-2. 本人が承認するまで収集しない

エージェントを入れただけでは何も送らない。
本人が mf で告知文を読んで「確認しました」を押すまで、
サーバは `collect: false` を返し、エージェントは収集を止めたままにする。

これは建前ではなく、**設計上そうなっている**（`gw_devices.notified_at`）。
規程が間に合っていない状態で入れても、データは溜まらない。

### 0-3. Intune / Defender との役割分担

重ねない。同じことを2つでやると、どちらが正なのか分からなくなる。

| | 担当 |
|---|---|
| **Intune** | 端末の構成管理・ポリシー配布・リモートワイプ・BitLocker・OS更新 |
| **Defender for Endpoint** | マルウェア検知・EDR・脅威ハンティング |
| **EIGHT PC Agent** | **業務利用状況の可視化**（稼働・アプリ・サイトカテゴリ）と、**社内ルール**に対する逸脱（未承認ソフト・USB・深夜休日）の検知 |

つまり EIGHT 側は「**セキュリティ製品が見ない、会社独自のルール**」を見る。
マルウェアや端末の乗っ取りは Defender の仕事で、こちらでは追わない。

---

## 1. 何を取り、何を取らないか

### 1-1. 取るもの

| 分類 | 中身 | 粒度 |
|---|---|---|
| セッション | 起動 / シャットダウン / ログオン / ログオフ / ロック / 解除 / スリープ / 復帰 | イベント1件ずつ |
| 稼働 | 稼働時間・離席時間（入力が5分以上ない＝離席） | 日別の合計 |
| アプリ | 実行ファイル名と製品名（`EXCEL.EXE` / Microsoft Excel） | 日別 × アプリ の合計分数 |
| Web | **カテゴリ**（業務 / 調べもの / SNS / 動画 / ショッピング / その他） | 日別 × カテゴリ の合計分数 |
| USB | 接続・取り外し、機器の種類とベンダ/製品ID | イベント1件ずつ |
| ソフト | インストール・アンインストール（名前とバージョン） | イベント1件ずつ |
| 時間帯 | 深夜（22:00〜5:00）・休日の稼働分数 | 日別の合計 |

### 1-2. 取らないもの（実装で禁じる）

- **キー入力**（キーロガー）
- **パスワード・認証情報**
- **メール本文・件名、チャット本文**
- **画面録画・定期スクリーンショット**
- **ウィンドウのタイトル** … 「〇〇様_見積書.xlsx」「△△さんとのDM」が入る。取らない
- **URLの全文** … `https://example.com/orders/12345` は個人の行動そのもの。
  エージェント側で**ホスト名だけに落とし、さらにカテゴリへ変換してから送る**。
  ホスト名もサーバへは送らない（カテゴリだけ）

> URLをホスト名に落とすのは**端末の中**でやる。サーバに送ってから落とすと、
> 送信経路とログに一度は全文が乗る。そこが漏れたら、落とした意味がない。

### 1-3. 本人も自分の記録を見られる

マイページに「自分のPCの記録」を置く。**管理者が見ているものと同じもの**が見える。

見せないと「何を見られているか分からない」状態になり、それは監視になる。
見せれば、本人が「離席が多い日は会議が続いた日だ」と説明できる。

---

## 2. 画面構成

### 2-1. 管理者：`admin-devices.html`

サイドメニューは **システム管理 → 端末管理**（`js/layout.js` の `g-system`）。

```
┌─ 端末管理 ─────────────────────────────────┐
│ 管理PC  12台   正常 9  要確認 2  重大 1     │  ← 上に状態だけ。数字を押すと絞り込む
│ 最終受信が1時間以上ないPC  1台               │
└────────────────────────────────────────┘

┌─ 対応が必要なこと（3件）───────────────────┐
│ 🔴 重大  今福 太郎 / EIGHT-PC-04             │
│    未承認ソフト「AnyDesk」がインストールされました │
│    9月10日 14:22        [確認した] [対応した]  │
│ 🟡 要確認 鈴木 花子 / EIGHT-PC-07             │
│    USBメモリが接続されました（SanDisk 32GB）   │
└────────────────────────────────────────┘

[ 端末 ] [ 社員別 ] [ アラート ] [ 設定 ]      ← タブ

── 端末 ────────────────────────────────
 状態  ホスト名        使う人      稼働(今日)  最終受信
  ●   EIGHT-PC-01   今福 太郎   6:12      3分前
  ●   EIGHT-PC-04   鈴木 花子   0:00      2日前 ⚠
     ↑ 押すと下に開く（既存のタイムカード画面と同じ作り）

  └─ 9月10日のタイムライン ──────────────
     08:52 起動          ▓▓▓▓▓▓▓▓▓░░▓▓▓▓▓▓▓▓
     09:01 ログオン       8時 ─────────── 18時
     12:04 ロック（離席 58分）
     18:30 シャットダウン
     
     アプリ   Excel 2:40 / Chrome 2:10 / Slack 0:50 / Teams 0:30
     サイト   業務 2:05 / 調べもの 0:35 / SNS 0:12
     深夜 0分   休日 0分
```

### 2-2. 管理者：設定タブ

- 未承認ソフトの一覧（名前の部分一致）
- サイトのカテゴリ定義（ホスト名 → カテゴリ）
- 深夜・休日の定義
- 登録用トークンの発行（PC1台につき1枚、7日で失効）
- エージェントの配布と現在のバージョン

### 2-3. メンバー：`mypage.html` に1枚追加

```
┌─ 自分のPCの記録 ─────────────────────────┐
│ EIGHT-PC-01   最終受信 3分前                │
│ 今日  稼働 6:12 / 離席 0:58                 │
│ アプリ Excel 2:40 / Chrome 2:10 …          │
│                                            │
│ この記録は、人事と経営者が見られます。         │
│ キー入力・メール・チャットの中身・画面は        │
│ 記録していません。 [取っているものを見る]      │
└────────────────────────────────────────┘
```

### 2-4. 初回の告知画面：`device-consent.html`

エージェントが未告知の端末を検知すると、既定のブラウザでここを開く。
読んで「確認しました」を押すまで、収集は始まらない。

---

## 3. DB設計（`db/050_devices.sql`）

既存の規約に合わせる。`public` スキーマ、`gw_` 接頭辞、全表に `tenant_id` と RLS。

### 3-1. 端末台帳

```sql
create table public.gw_devices (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  -- 端末が初回インストール時に作り、レジストリに残すID。
  -- ホスト名は変わるが、これは変わらない。再インストールしても同じ端末として続く
  device_uid  text not null,

  -- 貸与品台帳（gw_assets）のPCと紐づける。
  -- 台帳と端末管理が別物になると、「誰に貸したPCか」が2か所で食い違う
  asset_id    uuid references public.gw_assets(id) on delete set null,
  employee_id uuid references public.gw_employees(id) on delete set null,

  hostname      text not null,
  os_version    text,
  serial        text,
  agent_version text,

  -- 端末シークレットの sha256。平文は保存しない（漏れても端末になりすませない）
  secret_hash   text not null,
  secret_set_at timestamptz not null default now(),

  status text not null default 'active'
         check (status in ('active', 'suspended', 'retired')),

  -- 本人が告知を読んだ時刻。ここが null のあいだは収集しない。
  -- 「規程が間に合っていないのにデータが溜まる」を、仕組みで止める
  notified_at timestamptz,

  last_seen_at timestamptz,
  -- 端末側の最後の連番。ここより古いものは捨てる（二重投入の防止）
  last_seq     bigint not null default 0,

  note        text,
  enrolled_by uuid references auth.users(id) on delete set null,
  enrolled_at timestamptz not null default now(),
  retired_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint gw_devices_uid unique (device_uid)
);
```

### 3-2. 登録トークン（1回だけ使える）

```sql
create table public.gw_device_enrollments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  token_hash  text not null,                    -- 平文は発行時に1度だけ画面に出す
  employee_id uuid references public.gw_employees(id) on delete set null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     uuid references public.gw_devices(id) on delete set null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
```

### 3-3. イベント（点の記録・追記のみ）

```sql
create table public.gw_device_events (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  device_id uuid not null references public.gw_devices(id) on delete cascade,

  -- JSTの日付。日別に引くのに毎回タイムゾーン変換をしないため持つ
  work_date date not null,
  at        timestamptz not null,

  kind text not null check (kind in (
    'boot','shutdown','logon','logoff','lock','unlock','sleep','wake',
    'usb_attach','usb_detach','app_install','app_uninstall',
    'agent_start','agent_update','agent_error')),

  -- 種類ごとの中身。USBならベンダ/製品ID、ソフトなら名前とバージョン。
  -- ここに個人が特定できる中身（ファイル名・URL・タイトル）は入れない
  detail jsonb not null default '{}'::jsonb,

  -- 端末側の連番。同じものを2回受けても1行にする
  seq bigint not null,

  created_at timestamptz not null default now(),
  constraint gw_device_events_once unique (device_id, seq)
);

create index on public.gw_device_events (tenant_id, work_date desc);
create index on public.gw_device_events (device_id, work_date desc);
```

### 3-4. 日別の集計

```sql
-- 稼働・離席・深夜・休日
create table public.gw_device_usage (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  device_id   uuid not null references public.gw_devices(id) on delete cascade,
  employee_id uuid references public.gw_employees(id) on delete set null,
  work_date   date not null,

  active_min  integer not null default 0,   -- 入力があった時間
  idle_min    integer not null default 0,   -- 起動しているが5分以上入力なし
  locked_min  integer not null default 0,
  night_min   integer not null default 0,   -- 22:00〜5:00
  holiday_min integer not null default 0,   -- 土日祝

  first_at    timestamptz,
  last_at     timestamptz,
  updated_at  timestamptz not null default now(),
  constraint gw_device_usage_day unique (device_id, work_date)
);

-- アプリごと
create table public.gw_device_app_usage (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  device_id uuid not null references public.gw_devices(id) on delete cascade,
  work_date date not null,
  exe_name  text not null,                 -- EXCEL.EXE
  product   text,                          -- Microsoft Excel
  minutes   integer not null default 0,
  constraint gw_device_app_day unique (device_id, work_date, exe_name)
);

-- サイトのカテゴリごと。ホスト名もURLも保存しない
create table public.gw_device_web_usage (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  device_id uuid not null references public.gw_devices(id) on delete cascade,
  work_date date not null,
  category  text not null check (category in
            ('work','research','sns','video','shopping','other')),
  minutes   integer not null default 0,
  constraint gw_device_web_day unique (device_id, work_date, category)
);
```

### 3-5. アラート（対応の状態を持つ）

イベントは消せない記録。アラートは**人が対応するもの**なので、状態を持たせて分ける。

```sql
create table public.gw_device_alerts (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  device_id uuid not null references public.gw_devices(id) on delete cascade,
  event_id  uuid references public.gw_device_events(id) on delete set null,

  severity text not null check (severity in ('info','warn','critical')),
  rule     text not null,          -- 'unapproved_software' / 'usb_attach' / 'night_work' / 'no_heartbeat'
  title    text not null,
  detail   jsonb not null default '{}'::jsonb,

  status      text not null default 'open'
              check (status in ('open','ack','resolved','ignored')),
  decided_by  uuid references auth.users(id) on delete set null,
  decided_at  timestamptz,
  decided_note text,

  occurred_at timestamptz not null,
  created_at  timestamptz not null default now()
);
```

### 3-6. ポリシー

```sql
create table public.gw_device_policies (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,

  -- 未承認ソフト。名前の部分一致（["AnyDesk", "TeamViewer", "uTorrent"]）
  blocked_software jsonb not null default '[]'::jsonb,
  -- ホスト名 → カテゴリ（{"github.com":"work","x.com":"sns"}）
  site_categories  jsonb not null default '{}'::jsonb,

  night_from time not null default '22:00',
  night_to   time not null default '05:00',
  idle_after_min integer not null default 5,

  usb_alert  boolean not null default true,
  night_alert boolean not null default true,

  -- 送信の間隔と保存期間
  send_interval_sec integer not null default 300,
  keep_events_days  integer not null default 90,
  keep_daily_months integer not null default 13,

  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
```

### 3-7. 管理者の閲覧履歴

**「見た側の記録も残す」** ——これが無いと、この機能は片側だけが透明な仕組みになる。

```sql
create table public.gw_device_views (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  viewer_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.gw_devices(id) on delete set null,
  employee_id uuid references public.gw_employees(id) on delete set null,
  scope     text not null,          -- 'list' / 'detail' / 'timeline' / 'export'
  work_date date,
  at        timestamptz not null default now()
);
create index on public.gw_device_views (tenant_id, at desc);
```

本人のマイページに「**自分の記録を、いつ誰が見たか**」も出す。

### 3-8. RLS

読み取りだけ許す。書き込みは API（service_role）からのみ。

```sql
-- 本人は自分の端末ぶん、人事・経営者は全件
create policy gw_devices_read on public.gw_devices
  for select to authenticated
  using (public.gw_is_hr(tenant_id)
         or employee_id = public.gw_employee_id(tenant_id));
```
`gw_device_usage` / `gw_device_app_usage` / `gw_device_web_usage` / `gw_device_events` も同じ形。
`gw_device_views` は **本人と人事**が読める（自分を見た人が誰かを、本人が知れる）。

---

## 4. API設計

### 4-1. エージェント向け（Supabase の JWT は使わない）

社員のアカウントをPCに置くと、PCが盗まれたら社員として全部できてしまう。
**端末専用の資格情報**にし、権限は「自分の分を送る」だけにする。

```
Authorization: Device <deviceId>:<secret>
```
サーバは `sha256(secret)` を `gw_devices.secret_hash` と比べる。平文は持たない。

| メソッド | パス | 中身 |
|---|---|---|
| POST | `/api/devices/enroll` | `{enrollToken, deviceUid, hostname, os, serial, agentVersion}` → `{deviceId, secret}`。トークンは1回で失効 |
| GET | `/api/devices/config` | 収集の可否・間隔・カテゴリ表・未承認ソフト一覧を返す。**`notified_at` が null なら `{collect:false}`** |
| POST | `/api/devices/ingest` | まとめて送る（下記） |
| POST | `/api/devices/rotate` | シークレットの入れ替え（90日ごと） |
| GET | `/api/devices/manifest` | 最新版のバージョン・URL・SHA256 |

**ingest の本体**

```jsonc
{
  "sentAt": "2026-09-10T09:00:00+09:00",
  "agentVersion": "1.2.0",
  "events": [
    { "seq": 10231, "at": "...", "kind": "usb_attach",
      "detail": { "vid": "0781", "pid": "5583", "class": "mass_storage" } }
  ],
  "usage": [
    { "workDate": "2026-09-10", "activeMin": 372, "idleMin": 58,
      "lockedMin": 12, "nightMin": 0, "holidayMin": 0,
      "firstAt": "...", "lastAt": "..." }
  ],
  "apps": [
    { "workDate": "2026-09-10", "exeName": "EXCEL.EXE",
      "product": "Microsoft Excel", "minutes": 160 }
  ],
  "web": [
    { "workDate": "2026-09-10", "category": "work", "minutes": 125 }
  ]
}
```

サーバ側の扱い。

- `events` は `seq` で重複を落とす（`unique (device_id, seq)` に任せて `upsert ... on conflict do nothing`）
- `usage` / `apps` / `web` は**その日の値で上書き**（端末が持っている合計が正）
- 受け取ったら `last_seen_at` と `agent_version` を更新
- **ポリシー判定はサーバでやる。** 端末側でアラートを決めさせない
  （端末は改ざんできる。何をアラートにするかは会社が決める）

### 4-2. 管理者向け（既存と同じ Supabase JWT + `gw_is_hr`）

| メソッド | パス | 中身 |
|---|---|---|
| GET | `/api/devices` | 一覧とサマリ。`?deviceId=&date=` で1台の日別 |
| PATCH | `/api/devices` | `{action}`: `issue_token` / `assign` / `suspend` / `resume` / `retire` / `note` |
| GET | `/api/devices/alerts` | アラート一覧（`?status=open`） |
| PATCH | `/api/devices/alerts` | `{id, action: ack|resolve|ignore, note}` |
| GET/PATCH | `/api/devices/policy` | ポリシーの取得・更新 |
| GET | `/api/devices?csv=1` | CSV書き出し（**書き出しも閲覧履歴に残す**） |

**GET のたびに `gw_device_views` に1行入れる。** これを忘れると片側だけ透明になる。

### 4-3. 本人向け

| メソッド | パス | 中身 |
|---|---|---|
| GET | `/api/devices/me` | 自分の端末・自分の記録・自分を見た履歴 |
| POST | `/api/devices/me` | `{action:"acknowledge", deviceId}` 告知を読んだ記録（`notified_at`） |

---

## 5. Windows Agent の構成

### 5-1. 言語

**Go（`golang.org/x/sys/windows`）**を推す。

| | 理由 |
|---|---|
| 単一バイナリ | .NET ランタイムの配布が要らない。更新が exe の差し替えだけで済む |
| 軽い | 常駐で 20〜30MB 程度 |
| 自動更新が楽 | 依存が無いので、落として置き換えて再起動するだけ |

.NET 8 でも書ける（WMI とイベントログは .NET のほうが楽）。
ただし self-contained で 60MB 超になり、更新のたびに配る量が増える。

### 5-2. なぜ2プロセスに分けるのか

Windows は **Session 0 Isolation** により、
サービス（SYSTEM）から**対話セッションのフォアグラウンドウィンドウが取れない**。
「いま何のアプリを使っているか」はサービスからは分からない。

```
┌── eight-agent-svc.exe（Windowsサービス / SYSTEM）────────┐
│  ・起動/終了/ログオン/ロック（WTS セッション通知）           │
│  ・USB 接続（WM_DEVICECHANGE / SetupAPI）                  │
│  ・ソフトのインストール（レジストリ Uninstall キーの差分）    │
│  ・SQLite のキュー管理と、サーバへの送信                     │
│  ・自動更新                                               │
└──────────────┬────────────────────────────┘
               │ 名前付きパイプ  \\.\pipe\eight-agent
               │ （ACL: SYSTEM と Users のみ）
┌──────────────┴────────────────────────────┐
│ eight-agent-ui.exe（ログオン時に起動 / ユーザー権限）        │
│  ・前面のアプリ（GetForegroundWindow → プロセス名）         │
│  ・離席の判定（GetLastInputInfo）                          │
│  ・ブラウザのURL → ホスト名 → カテゴリ に**ここで**落とす    │
│  ・タスクトレイに常駐（「記録中」が見える状態にする）          │
└────────────────────────────────────────────┘
```

> **タスクトレイに出すのは意図的。**
> 動いていることが本人に見えない常駐は、その時点で監視になる。
> アイコンから「いま何を記録しているか」を開けるようにする。

### 5-3. データの流れ

```
1. 収集     UIプロセスが1秒ごとに前面アプリを見る
              ↓ 5分ぶんをメモリで合算（1秒ごとに送らない）
2. 集約     5分バケット {exe, minutes} をパイプでサービスへ
              ↓
3. 保存     SQLite（%ProgramData%\EIGHT\agent.db）へ追記
              ↓ 通信できなくても、ここに溜まり続ける
4. 送信     5分ごとに未送信ぶんを ingest へ POST
              ↓ 成功したら sent=1。失敗したら次回に持ち越す
5. 掃除     送信済みで7日を過ぎた行を消す
```

**オフライン時**：SQLite に溜め続ける。上限は 30日ぶん（約20MB）。
超えたら**古いイベントから**捨てる（新しいほうが対応に要る）。

**復帰後**：溜まった順に送る。1回のPOSTは 500件まで。
`seq` は端末が単調に増やすので、**同じものが2回届いても1行にしかならない**。

### 5-4. インストールと自動起動

- 配布は **MSI**（WiX）。Intune から配布できる形にしておく
- サービスは `SERVICE_AUTO_START` + 失敗時の再起動（1回目5秒・2回目30秒・以降1分）
- UIプロセスは `HKLM\...\Run` ではなく**タスクスケジューラの「ログオン時」**
  （Run キーはユーザーが消せる。タスクなら管理者権限が要る）
- インストール時に `device_uid` を生成して `HKLM\SOFTWARE\EIGHT\DeviceUid` に保存

### 5-5. 自動更新

```
1. 6時間ごとに GET /api/devices/manifest
2. version が今より新しければ、url から .exe を落とす
3. SHA256 を照合  ← 一致しなければ捨てる
4. Authenticode の署名を検証  ← 会社の証明書でないものは捨てる
5. 新しい exe を置き、サービスを再起動
6. agent_update イベントを送る
```

**署名の検証は省かない。** 更新の口は、そのまま「全PCで任意のコードを動かせる口」になる。

### 5-6. 端末シークレットの守り方

- `%ProgramData%\EIGHT\secret.dat` に **DPAPI（マシンスコープ）** で暗号化して置く
- ACL は SYSTEM と Administrators のみ。一般ユーザーは読めない
- 90日ごとに `/api/devices/rotate` で入れ替える
- 端末を廃棄するときは管理画面から `retire` → そのシークレットは即座に無効

---

## 6. アラートの判定（サーバ側）

| ルール | 重さ | 条件 |
|---|---|---|
| `unapproved_software` | 重大 | `blocked_software` に部分一致するソフトがインストールされた |
| `usb_attach` | 要確認 | USB大容量記憶装置が接続された（`usb_alert` が有効なとき） |
| `night_work` | 要確認 | 深夜の稼働が60分を超えた |
| `holiday_work` | 要確認 | 休日の稼働が120分を超えた |
| `no_heartbeat` | 要確認 | 24時間以上受信がない（`status='active'` のみ） |
| `agent_error` | 要確認 | エージェントが同じエラーを3回以上報告 |

判定は **`api/cron/devices.js`（15分ごと）** で回す。既存の `api/cron/` と同じ作り。
重大が出たら `lib/notify.js` で人事・経営者へ通知する。

> **深夜・休日を「アラート」にするのは、働かせすぎを見つけるため**であって、
> サボりを見つけるためではない。画面の文言もそう書く。
> ここを取り違えると、この機能は社内で嫌われて終わる。

---

## 7. 保存期間と削除

| データ | 期間 | 消し方 |
|---|---|---|
| `gw_device_events` | 90日 | cron で日次削除 |
| 日別の集計3表 | 13か月 | cron で月次削除 |
| `gw_device_alerts` | 3年 | 対応の記録として残す |
| `gw_device_views` | 3年 | 監査のため残す |
| 退職者の端末 | 退職日+90日 | `retire` 後、cron で本体ごと削除 |

---

## 8. 作る順番

| 段階 | 中身 | 目安 |
|---|---|---|
| **0** | **就業規則・情報セキュリティ規程の改定と周知** | 実装より前 |
| 1 | `db/050_devices.sql` ／ `lib/devices.js`（集計・判定・カテゴリ変換） | |
| 2 | エージェント向けAPI（enroll / config / ingest）＋ 単体テスト | |
| 3 | Go エージェント（サービス側だけ：起動終了・USB・送信・オフライン待避） | |
| 4 | `admin-devices.html`（一覧・タイムライン・アラート） | |
| 5 | UIプロセス（アプリ・離席・サイトカテゴリ）とタスクトレイ | |
| 6 | `device-consent.html` と マイページの「自分のPCの記録」 | |
| 7 | ポリシー画面・CSV・cron（アラート判定と保存期間の掃除） | |
| 8 | MSI・自動更新・署名 | |
| 9 | 1台で2週間の試験運用 → 全台展開 | |

---

## 9. 決めていただきたいこと

1. **就業規則の改定はいつ行うか。** ここが決まらないと、1〜8を作っても動かせない
2. **エージェントは Go でよいか**（.NET が社内標準なら合わせる）
3. **アプリ名をどこまで見せるか。** 実行ファイル名だけにするか、製品名まで出すか
4. **深夜・休日のアラートを、本人にも通知するか**（働かせすぎの是正が目的なら、本人にも出すのが筋）
5. **対象は会社貸与PCのみでよいか**（BYODが混ざる場合、設計を分ける必要がある）
