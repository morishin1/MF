// マーケティング（Office）の部品。画面にもサーバにも依存しない純粋な関数と定数だけ。
// 方針は docs/office-marketing.md。
//
// ■ 別台帳を作らない
//   問い合わせ・注文・予約は原本（採用HRの無限道場リード・各事業のシステム）を読むだけ。
//   ここで持つのは「どの原本を、どう見せるか」と「つながっていない原本は、何が足りないか」。
//
// ■ 未連携・権限なし・取得失敗・0件を混ぜない
//   source.state は ok / not_connected / forbidden / not_ready / failed のどれか。
//   ok のときだけ件数を数える。それ以外の原本の件数は null（「0件」と書かない）。

export const BIZ = [
  { key: "mugen", label: "無限道場" },
  { key: "space", label: "スペース" },
  { key: "ec", label: "EC" },
  { key: "site", label: "自社サイト" },
];
export const BIZ_KEYS = BIZ.map((b) => b.key);
export const bizLabel = (k) => BIZ.find((b) => b.key === k)?.label || k;

export const SOURCE_STATES = {
  ok: "取得済み",
  not_connected: "未連携",
  forbidden: "権限なし",
  not_ready: "未準備",
  failed: "取得失敗",
};

// ---- 対応が必要な業務：原本の一覧 -----------------------------------------------------------
// connected: true の原本だけ API が読む。false の原本は、何が足りないかを画面に出す（リンクだけで完了にしない）
export const WORK_SOURCES = [
  {
    key: "hr_lead", biz: "mugen", kind: "inquiry", label: "無料カウンセリング・お問い合わせ",
    connected: true, via: "MF（採用HR）",
    requires: "採用HR の権限",
    original: { label: "採用HR（無限道場リード）", url: "/hr/applicants.html?category=mugendojo" },
    scope: "無限道場トップの「無料カウンセリング／お問い合わせ」フォームから採用HRへ届いたもの（無限道場リード）",
    missing: ["法人研修・自治体の相談は、いまのフォームでは区別できません（同じ無料カウンセリングとして届く）"],
  },
  {
    key: "mugen_course", biz: "mugen", kind: "inquiry", label: "講座の受講申込（個人・法人）",
    connected: true, via: "無限道場（lms.course_applications・本人の権限）",
    requires: "無限道場の講師・管理者の権限（is_lms_staff）",
    original: { label: "無限道場 管理画面（受講申込）", url: "https://mugendojo.jp/mgn/admin/applications" },
    scope: "/course のフォームから届いた受講申込。読むだけ（状態を変える既存の画面・関数が無いため）",
    missing: ["担当・期限・対応履歴は原本に項目がありません（状態と運営メモだけ）"],
  },
  {
    key: "space_inquiry", biz: "space", kind: "inquiry", label: "問い合わせ・予約",
    connected: true, via: "8sp（既存の関数・本人の権限）",
    requires: "8sp の事務権限（事務の共有アカウント、または 8sp で有効な管理者）",
    original: { label: "スペース 事務画面", url: "https://8sp.jp/member/admin.html" },
    scope: "8sp のお問い合わせ（rental_records）の未完了すべてと、60日以内に完了・キャンセルしたもの。予約は、お問い合わせから作られたもの",
    missing: ["期限は原本に項目がありません", "担当は事務ポータルの自由記述です",
      "予約媒体のメール受信箱（SQL 48・49）と予約の進み具合（SQL 50）は未適用のため、まだ含めていません"],
  },
  // EC は今回のマーケティング連携では後回し（2026-10-24 指示）。作りは残し、読まない・出さない・操作させない（保留）。
  // 再開するときは hold を外す（会社HPと同じ表なので、API が読む送信元に EC の値が入る）
  {
    key: "ec_contact", biz: "ec", kind: "inquiry", label: "問い合わせ", hold: true,
    connected: true, via: "問い合わせの表（contact_submissions・本人の権限）",
    requires: "事務の共有アカウント（zimu）でのログイン",
    original: { label: "お問い合わせ管理（8ec.jp）", url: "https://8ec.jp/admin/contact/" },
    scope: "8ec.jp の各ページのフォーム（送信元ページ top / pc / cloud / ai-dev / company / buy / general）",
    missing: ["担当・期限・対応履歴の項目がありません（状態と担当メモだけ）", "返信を送る既存の仕組みがありません"],
  },
  {
    key: "site_contact", biz: "site", kind: "inquiry", label: "会社ホームページのお問い合わせ",
    connected: true, via: "問い合わせの表（contact_submissions・本人の権限）",
    requires: "事務の共有アカウント（zimu）でのログイン",
    original: { label: "お問い合わせ管理（会社HPと共通の表）", url: "https://8ec.jp/admin/contact/" },
    scope: "8grp.co.jp のフォーム（お問い合わせ・採用・AI開発・LP。送信元 8grp_lp）だけ。EC と同じ表なので、送信元 8grp_lp の行だけを読む（EC の行は読まない）。受信メールの転送・Gmail の取り込みはしない",
    missing: ["担当・期限・対応履歴の項目がありません（状態と担当メモだけ）", "返信を送る既存の仕組みがありません"],
  },
  {
    key: "ec_order", biz: "ec", kind: "order", label: "注文・発送確認", hold: true,
    connected: false,
    original: { label: "EC 在庫・販売一覧", url: "https://8ec.jp/zaiko/" },
    need: [
      "注文の原本が楽天（受注の表）・在庫・Stripe（DBに保存なし）・旧台帳に分かれていて、1つの注文一覧がありません",
      "どの原本を「注文」とするか（楽天の受注・在庫の売却・Stripe）の決定が要ります。在庫の表は同じ DB にあり、読むこと自体は既存の権限でできます",
    ],
    missing: ["販売済みと発送済みは別です（発送は shipped_at。販売済みを発送済みとして数えない）", "配送業者・追跡番号の項目はまだありません"],
  },
];
export const workSource = (key) => WORK_SOURCES.find((s) => s.key === key) || null;
/** 保留中の原本（読まない・出さない・操作させない。件数も出さない＝0件と書かない） */
export const HOLD_NOTE = "今回のマーケティング連携では後回しにしています（保留）。読んでいないので、件数は0ではありません";
export const isHeld = (key) => Boolean(workSource(key)?.hold);

// ---- 制作予定：原本の一覧 -------------------------------------------------------------------
export const PRODUCTION_SOURCES = [
  {
    key: "site_news", biz: "site", label: "自社サイトのお知らせ・コラム", connected: true,
    original: { label: "サイトのお知らせ", url: "/admin-site-news.html" },
    scope: "下書き・公開予定・30日以内の公開済み。サイトへの反映は毎朝8時の同期のあと",
  },
  {
    key: "plan", biz: null, label: "制作予定（企画・担当・期限）", connected: true,
    original: null,
    scope: "この画面で登録した企画。本文は原本の管理画面で書きます",
  },
  {
    key: "mugen_contents", biz: "mugen", label: "コラム・SNS文案・YouTube動画", connected: false,
    original: { label: "無限道場 コンテンツ管理", url: "https://mugendojo.jp/admin/contents/social" },
    need: [
      "無限道場には、記事・SNS文案（投稿URLの記録あり）・動画の管理が既にあります（lms.mgn_*）",
      "Office から読む処理はまだありません（問い合わせの集約の次に着手。受講申込と同じく本人の権限で読めるかの確認から）",
    ],
  },
  {
    key: "site_marke", biz: "site", label: "自社サイトのメディア記事・SNS投稿", connected: false,
    original: { label: "事務ポータル マーケ", url: "https://8grp.co.jp/admin/marke/" },
    need: ["事務ポータル側のDB（marke_articles・marke_sns_posts）で、編集者ログインが必要です", "Office から読むための口と権限の承認が必要です"],
  },
  {
    key: "space_articles", biz: "space", label: "スペースのお知らせ・コラム・SNS文案", connected: false,
    original: { label: "スペース 事務画面（お知らせ）", url: "https://8sp.jp/member/admin.html?tab=settings&sub=news" },
    need: ["8sp の記事・SNS文案は事務ログインで読みます。Office から読むには、読むだけの関数と署名付きAPIが必要です"],
  },
  {
    key: "ec_sns", biz: "ec", label: "ECのSNS文案・コラム", connected: false,
    original: { label: "EC SNS投稿", url: "https://8ec.jp/zaiko/sns" },
    need: ["SNS文案は EC 側のDB（在庫の担当ログイン）にあります。コラムは GitHub のPRで足す運用です", "Office から読む口と権限の承認が必要です"],
  },
];

// ---- 制作の状態・媒体 ------------------------------------------------------------------------
export const PLAN_STATES = [
  { key: "plan", label: "企画" },
  { key: "drafting", label: "作成中" },
  { key: "review", label: "確認待ち" },
  { key: "scheduled", label: "公開予定" },
  { key: "published", label: "公開済み" },
];
export const PLAN_STATE_KEYS = PLAN_STATES.map((s) => s.key);
export const planStateLabel = (k) => PLAN_STATES.find((s) => s.key === k)?.label || k;

export const MEDIA = [
  { key: "column", label: "コラム" },
  { key: "sns", label: "SNS投稿" },
  { key: "youtube", label: "YouTube動画" },
  { key: "campaign", label: "キャンペーン" },
];
export const MEDIA_KEYS = MEDIA.map((m) => m.key);
export const mediumLabel = (k) => MEDIA.find((m) => m.key === k)?.label || k;
export const SNS_CHANNELS = [
  { key: "x", label: "X", max: 140 },
  { key: "instagram", label: "Instagram", max: 2200 },
  { key: "facebook", label: "Facebook", max: 5000 },
  { key: "note", label: "note", max: 5000 },
  { key: "line", label: "LINE", max: 500 },
  { key: "other", label: "その他", max: 5000 },
];
export const SNS_CHANNEL_KEYS = SNS_CHANNELS.map((c) => c.key);

/**
 * 原本（自社サイトのお知らせ）がある制作予定の、見せる状態。
 * 公開・下書きは原本の値が正。原本が下書きのあいだだけ、制作側の「企画／作成中／確認待ち」を使う。
 * @param {{key:string}|null} originalView lib/site-news.js viewState の結果（draft / planned / published）
 * @param {string} planState
 */
export function displayState(originalView, planState) {
  if (!originalView) return { key: planState, label: planStateLabel(planState), from: "plan" };
  if (originalView.key === "published") return { key: "published", label: "公開済み", from: "original" };
  if (originalView.key === "planned") return { key: "scheduled", label: "公開予定", from: "original" };
  const pre = ["plan", "drafting", "review"].includes(planState) ? planState : "drafting";
  const warn = ["scheduled", "published"].includes(planState) ? "原本はまだ下書きです" : null;
  return { key: pre, label: planStateLabel(pre), from: "plan", warn };
}

// ---- 入力の確かめ ---------------------------------------------------------------------------
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// 090-1234-5678 / 03-1234-5678 / 09012345678（数字10〜11桁）
const PHONE_RE = /(?:^|[^0-9])0\d{1,4}[-‐－ ]?\d{1,4}[-‐－ ]?\d{3,4}(?:[^0-9]|$)/;

/** 公開用の文案に、個人情報らしい文字列（メールアドレス・電話番号）が混ざっていないか */
export function personalDataHints(text) {
  const s = String(text || "");
  const out = [];
  if (EMAIL_RE.test(s)) out.push("メールアドレス");
  if (PHONE_RE.test(s)) out.push("電話番号");
  return out;
}

const trim = (v, max) => {
  const s = String(v ?? "").trim();
  return s.length > max ? null : s;
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 制作予定の入力を確かめる。
 * @returns {{ok:true, value:object}|{ok:false, error:string, field?:string}}
 */
export function normalizePlan(body, { partial = false } = {}) {
  const b = body || {};
  const v = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (!partial || has("biz")) {
    if (!BIZ_KEYS.includes(b.biz)) return { ok: false, error: "事業を選んでください", field: "biz" };
    v.biz = b.biz;
  }
  if (!partial || has("medium")) {
    if (!MEDIA_KEYS.includes(b.medium)) return { ok: false, error: "媒体を選んでください", field: "medium" };
    v.medium = b.medium;
  }
  if (!partial || has("title")) {
    const t = trim(b.title, 200);
    if (!t) return { ok: false, error: "タイトルを入れてください（200文字まで）", field: "title" };
    v.title = t;
  }
  if (has("summary")) {
    const s = trim(b.summary, 4000);
    if (s === null) return { ok: false, error: "企画内容・文案は4000文字までです", field: "summary" };
    const hints = personalDataHints(s);
    if (hints.length) {
      return { ok: false, error: `文案に${hints.join("・")}らしい文字列があります。公開用の文案には個人情報を入れないでください`, field: "summary" };
    }
    v.summary = s || null;
  }
  if (has("snsChannel")) {
    if (b.snsChannel == null || b.snsChannel === "") v.sns_channel = null;
    else if (!SNS_CHANNEL_KEYS.includes(b.snsChannel)) return { ok: false, error: "SNSの種類が正しくありません", field: "snsChannel" };
    else v.sns_channel = b.snsChannel;
  }
  if (has("ownerEmployeeId")) v.owner_employee_id = b.ownerEmployeeId || null;
  for (const [k, col, label] of [["dueOn", "due_on", "期限"], ["scheduledOn", "scheduled_on", "公開予定日"]]) {
    if (!has(k)) continue;
    if (b[k] == null || b[k] === "") { v[col] = null; continue; }
    if (!ISO_DATE.test(String(b[k])) || Number.isNaN(Date.parse(`${b[k]}T00:00:00Z`))) {
      return { ok: false, error: `${label}の日付が正しくありません`, field: k };
    }
    v[col] = String(b[k]);
  }
  if (has("state")) {
    if (!PLAN_STATE_KEYS.includes(b.state)) return { ok: false, error: "状態が正しくありません", field: "state" };
    v.state = b.state;
  }
  if (has("publicUrl")) {
    if (b.publicUrl == null || b.publicUrl === "") v.public_url = null;
    else {
      const u = safeHttpsUrl(b.publicUrl);
      if (!u) return { ok: false, error: "公開URLは https:// で始まるURLにしてください", field: "publicUrl" };
      v.public_url = u;
    }
  }
  // SNS の種類は SNS 投稿だけ。ほかの媒体では外す
  const medium = v.medium ?? b.medium;
  if (medium && medium !== "sns" && v.sns_channel) v.sns_channel = null;
  return { ok: true, value: v };
}

/** https の URL だけを通す（javascript: 等や空白入りは null） */
export function safeHttpsUrl(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length > 500 || /\s/.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || !u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** 公開済みにするには、公開URLか原本が要る（DB の check と同じ） */
export function publishProblem(row) {
  if (row.state !== "published") return null;
  if (row.public_url || row.source_type) return null;
  return "公開済みにするには、手で投稿したあとの公開URLを記録してください";
}

// ---- 一覧の絞り込み -------------------------------------------------------------------------
/**
 * 対応が必要な業務の絞り込み（画面とテストで同じものを使う）。
 * state: open（対応待ち・初期）/ closed / all
 */
export function filterWork(items, { biz = "", kind = "", owner = "", state = "open" } = {}) {
  return (items || []).filter((x) => {
    if (biz && x.biz !== biz) return false;
    if (kind && x.kind !== kind) return false;
    if (owner === "unset" && x.owner) return false;
    if (owner && owner !== "unset" && x.owner?.id !== owner) return false;
    if (state === "open" && !x.status?.open) return false;
    if (state === "closed" && x.status?.open) return false;
    return true;
  });
}

/** 事業ごとの件数。取得できた原本だけを数え、未連携・権限なし・失敗は null のまま */
export function countsByBiz(sources, items) {
  const out = {};
  for (const b of BIZ_KEYS) {
    const mine = (sources || []).filter((s) => s.biz === b);
    const okKeys = mine.filter((s) => s.state === "ok").map((s) => s.key);
    out[b] = okKeys.length
      ? (items || []).filter((x) => okKeys.includes(x.source) && x.status?.open).length
      : null;
  }
  return out;
}

// ---- YouTube --------------------------------------------------------------------------------
// 既存の動画を参照して埋め込むだけ。アップロード・YouTube 上の設定変更はしない。
// 保存するのは動画ID（11文字）だけ。任意の HTML・スクリプトは受け取らない。
const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com", "youtube-nocookie.com"]);
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * YouTube の URL から動画IDを取り出す。対応しない形は null。
 *   https://www.youtube.com/watch?v=ID / https://youtu.be/ID / /shorts/ID / /embed/ID / /live/ID
 */
export function parseYouTubeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length > 500 || /[\s<>"']/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;
  let id = null;
  if (host === "youtu.be") id = u.pathname.split("/")[1] || null;
  else if (u.pathname === "/watch") id = u.searchParams.get("v");
  else {
    const m = u.pathname.match(/^\/(shorts|embed|live)\/([^/?#]+)/);
    if (m) id = m[2];
  }
  if (!id || !YT_ID.test(id)) return null;
  return {
    videoId: id,
    watchUrl: `https://www.youtube.com/watch?v=${id}`,
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  };
}

/**
 * YouTube の oEmbed の応答から、埋め込めるかを判断する。
 * 200 … 公開か限定公開で、埋め込みが許可されている（限定公開かどうかは区別できない → 人が確かめる）
 * 401 … 埋め込みが許可されていない / 403・404 … 非公開・削除・存在しない / それ以外・通信失敗 … 確認できない
 */
export function interpretOEmbed(status, body) {
  if (status === 200 && body && typeof body === "object") {
    return { state: "embeddable", title: String(body.title || "").slice(0, 200), author: String(body.author_name || "").slice(0, 100) };
  }
  if (status === 401) return { state: "not_embeddable" };
  if (status === 403 || status === 404) return { state: "unavailable" };
  return { state: "unknown" };
}
export const OEMBED_LABEL = {
  embeddable: "埋め込み可（公開か限定公開。限定公開かどうかは YouTube 上で確認してください）",
  not_embeddable: "埋め込みが許可されていません（YouTube 側の設定）",
  unavailable: "非公開・削除済み、または存在しない動画です",
  unknown: "確認できませんでした（通信の失敗など）",
};

// 掲載先サイト。アダプタ（実際に載せる仕組み）が無いサイトは選べない。理由と必要な作業を出す
export const VIDEO_SITES = [
  {
    key: "mugen", label: "無限道場", supported: false, positions: ["トップ「動画で見る無限道場」", "動画一覧", "関連する記事の下"],
    reason: "無限道場には動画の管理（トップ・動画一覧・関連記事に出る）が既にありますが、Office から書き込む口がありません",
    need: ["無限道場の動画管理（/admin/contents/youtube）に登録する。Office から登録するには署名付きの書き込みAPIと承認が必要"],
    original: "https://mugendojo.jp/admin/contents/youtube",
  },
  {
    key: "site", label: "自社サイト", supported: false, positions: ["お知らせ・コラムの本文"],
    reason: "お知らせの本文は iframe を取り除き、会社サイトの CSP も YouTube の埋め込みを許可していません",
    need: ["会社サイト（8grp-site）の CSP に frame-src https://www.youtube-nocookie.com を足す", "お知らせの同期（news-sync）と本文の掃除に、動画IDだけの埋め込みブロックを足す"],
    original: "/admin-site-news.html",
  },
  {
    key: "space", label: "スペース", supported: false, positions: ["お知らせ・コラムの本文"],
    reason: "スペースの記事本文は iframe を許可していません（画面とページ生成の2か所で同じ許可リスト）",
    need: ["8sp の記事に、動画IDだけの埋め込みブロックを足す（js/space-news.js と scripts/space-news/render.py の両方）"],
    original: "https://8sp.jp/member/admin.html?tab=settings&sub=news",
  },
  {
    key: "ec", label: "EC", supported: false, positions: ["コラムのページ"],
    reason: "EC のコラムは GitHub のPRで HTML を足す運用で、掲載する仕組み（CMS）がありません",
    need: ["EC のコラムに動画IDだけの埋め込みブロックを足す（PRで反映）"],
    original: "https://8ec.jp/column/",
  },
];
export const videoSite = (k) => VIDEO_SITES.find((s) => s.key === k) || null;

/** 確認した内容の文字列（サーバでハッシュにする）。どれか1つでも変われば確認し直し */
export function placementFingerprint({ videoId, site, position, title, description }) {
  return JSON.stringify([String(videoId || ""), String(site || ""), String(position || "").trim(),
    String(title || "").trim(), String(description || "").trim()]);
}
