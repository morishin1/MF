// ENGER の人材（enger.candidates）を「企業に見せてよい形」にする決まり。
//
// Sales の企業詳細「商談準備」は、企業ポータル（enger.jp/business）で企業が見るのと同じ形で人材を見る。
// 企業ポータル側の同じ決まりは enger-lp の src/lib/public-talent.mjs。**片方だけ変えない**
// （項目を足すときは両方と、両方のテストを直す。docs/sales-company-portal.md「公開項目」）。
//
// ■ 許可リスト方式
//   返す項目は toPublicTalent の中で1つずつ組み立てる（...row で丸ごと返さない）。
//   読む列も PUBLIC_TALENT_COLUMNS に限る。氏名（name）は読まない。表示名はイニシャル、無ければ人材番号。
//
// ■ 返さないもの（指示書 6.2「非公開情報の遮断」）
//   氏名・メール・電話・所属会社（company / source_company / affiliation / partner_organization_id）・
//   希望単価（rate / salary_min / salary_max / rate_num＝ENGER にとっての仕入れ）・商流（flow_depth）・
//   メモ（note / detail / detail_note）・スキルシートの原本（skill_sheet_*）・流入元（signup_source / source_*）。
//   企業へ提示できる単価の列は ENGER に無いため、単価は出さない（担当営業が提示する）。
//
// ■ 自由記述は短く切って、連絡先らしいものを伏せる
//   経験年数・稼働開始・稼働日数・最寄り駅は自由入力の列。メール・URL・電話番号の形は「［非公開］」にする。

export const PUBLIC_TALENT_COLUMNS_BASE = "id,candidate_no,initials,title,skills,exp,avail,status,created_at,is_closed,deleted_at";
// 後から足された列。無い環境では BASE に落として、落とした項目を missing で返す
export const PUBLIC_TALENT_COLUMNS_EXT = PUBLIC_TALENT_COLUMNS_BASE
  + ",is_focus,focused_at,remote_pref,location,nearest_station,week_days,age_band,nationality,role_labels";
export const EXT_LABELS = ["注力", "リモート希望", "居住地", "最寄り駅", "稼働日数", "年代", "国籍", "職種"];

// dx.enger の src/lib/candidate-status.ts NON_PROPOSABLE_STATUSES と同じ（提案できない人材は企業にも見せない）
export const NON_PROPOSABLE_STATUSES = [
  "稼働中", "就業中", "アサイン済", "アサイン済み", "利用停止", "停止", "一時停止", "休止", "対象外",
  "稼働終了", "退会", "退職", "辞退", "NG", "ng", "クローズ", "closed", "稼働不可", "提案不可",
  "連絡不可", "連絡禁止", "音信不通",
];

// 新着＝登録から14日以内（dx.enger の人材一覧 NEW_TALENT_DAYS と同じ）
export const NEW_TALENT_DAYS = 14;
export const PAGE_SIZE = 30;
// 絞り込み・並べ替えの母集団の上限（新しい順）。超えたら truncated を返して画面に出す
export const POOL_LIMIT = 2000;

export const TABS = ["all", "focus", "new", "saved"];
export const SORTS = ["relevance", "new"];
export const REMOTE_KINDS = { full: "フルリモート希望", partial: "一部リモート希望", onsite: "出社・常駐可" };

const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県",
  "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県",
  "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県",
  "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県",
  "宮崎県", "鹿児島県", "沖縄県",
];
export const PREFECTURE_LIST = PREFECTURES;

const norm = (v) => String(v ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const lower = (v) => norm(v).toLowerCase();

/** Field values originating from emails may contain prices or company names.
 * Never promote such values to a public API response without human review.
 */
const PRIVATE_CANDIDATE_CONTENT =
  /(?:株式会社|有限会社|合同会社|（株）|\(株\)|㈱|所属(?:元|先|企業|会社)|会社名|企業名|社名|発注元|取引先|客先|エンド(?:企業|ユーザー|ユーザ)?|元請|下請|商流|単価|単金|金額|報酬|年収|月収|給与|時給|日給|月額|日額|見積|請求|仕入|精算|マージン|粗利|利益|支払|[¥￥$＄€£]|\d[\d,.]*\s*(?:億円|万円|千円|円|ドル|万)|\b(?:JPY|USD|EUR)\b)/i;
export const containsPrivateCandidateContent = value => PRIVATE_CANDIDATE_CONTENT.test(norm(value));

/** 自由記述を短く切って、メール・URL・電話番号の形を伏せる */
export function redact(value, max = 40) {
  let s = norm(value);
  if (!s || containsPrivateCandidateContent(s)) return null;
  s = s
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "［非公開］")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "［非公開］")
    .replace(/(?:\+81[\s-]?|0)\d{1,4}[\s-]?\d{1,4}[\s-]?\d{3,4}/g, "［非公開］");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** 人材番号の表示形（P-000123）。dx.enger の talentNo と同じ */
export function talentNo(no) {
  const n = Number(no);
  return Number.isSafeInteger(n) && n > 0 ? `P-${String(n).padStart(6, "0")}` : null;
}

/** 表示名：イニシャル、無ければ人材番号（氏名は読まないし返さない） */
export function displayNameOf(row) {
  const ini = norm(row?.initials).replace(/[^A-Za-z.\s]/g, "").trim();
  if (ini && ini.length <= 8) return ini;
  return talentNo(row?.candidate_no) || "人材";
}

export function remoteKind(value) {
  const s = lower(value);
  if (!s) return null;
  if (/full_remote|フルリモート|完全リモート|フル在宅/.test(s)) return "full";
  if (/partial_remote|一部|併用|ハイブリッド|週\d.*(出社|リモート)/.test(s)) return "partial";
  if (/onsite|常駐|出社|オンサイト/.test(s)) return "onsite";
  if (/remote|リモート|在宅/.test(s)) return "full";
  return null;
}

export function prefectureOf(value) {
  const s = norm(value);
  if (!s) return null;
  for (const p of PREFECTURES) if (s.includes(p)) return p;
  for (const p of PREFECTURES) {
    const short = p === "北海道" ? p : p.replace(/[都府県]$/, "");
    if (short.length >= 2 && s.startsWith(short)) return p;
  }
  return null;
}

/** 企業に見せてよい人材か（削除・クローズ・提案できない状態は出さない） */
export function isPublicTalent(row) {
  if (!row || !row.id) return false;
  if (row.deleted_at) return false;
  if (row.is_closed === true) return false;
  const st = norm(row.status);
  if (st && NON_PROPOSABLE_STATUSES.includes(st)) return false;
  return true;
}

export function isNewTalent(row, now = Date.now()) {
  const t = Date.parse(row?.created_at || "");
  return Number.isFinite(t) && now - t <= NEW_TALENT_DAYS * 86400000 && t <= now + 60000;
}

const strList = (v, max, len) => (Array.isArray(v) ? v : [])
  .map((x) => redact(x, len)).filter(Boolean)
  .filter((x, i, a) => a.indexOf(x) === i).slice(0, max);

/**
 * 企業に見せる形。**ここに無い項目は企業に出ない。**
 * id（人材の UUID）は Sales の画面だけが使う。企業ポータルは人材番号（no）で指す。
 */
export function toPublicTalent(row, { now = Date.now() } = {}) {
  const no = Number.isSafeInteger(Number(row?.candidate_no)) && Number(row.candidate_no) > 0 ? Number(row.candidate_no) : null;
  const remote = remoteKind(row?.remote_pref);
  return {
    no,
    talentNo: talentNo(no),
    displayName: displayNameOf(row),
    title: redact(row?.title, 40),
    roles: strList(row?.role_labels, 3, 30),
    skills: strList(row?.skills, 20, 40),
    experience: redact(row?.exp, 20),
    availability: redact(row?.avail, 24),
    weekDays: redact(row?.week_days, 16),
    remote,
    remoteLabel: remote ? REMOTE_KINDS[remote] : null,
    prefecture: prefectureOf(row?.location),
    nearestStation: redact(row?.nearest_station, 20),
    ageBand: redact(String(row?.age_band ?? "").replace(/[（(].*?[）)]/g, ""), 12),
    nationality: redact(row?.nationality, 16),
    isFocus: row?.is_focus === true,
    isNew: isNewTalent(row, now),
  };
}

/** Anonymized meeting summary using only the allow-listed candidate projection.
 * Mail bodies, source PDFs, notes and financial data never enter this function.
 */
export function publicTalentSummary(t) {
  const title = redact(t?.title, 60) || "IT人材";
  const exp = redact(t?.experience, 24);
  const available = redact(t?.availability, 30);
  const work = redact(t?.remoteLabel, 30);
  const skills = strList(t?.skills, 6, 40);
  const lines = [
    ["職種", title], ["経験年数", exp], ["主なスキル", skills.join(" / ") || null],
    ["稼働開始", available], ["働き方", work],
  ].filter(([, value]) => Boolean(value));
  return {
    title: "公開用人材サマリー",
    text: lines.map(([label, value]) => label + "：" + value).join("。") + "。",
    note: "登録された公開項目のみで作成。メール本文や原本からの転載ではありません。",
  };
}

/** 公開用スキルシート（要約版）。上の許可項目だけで作る。原本のスキルシートは使わない */
export function publicSkillSheet(t) {
  const rows = [
    ["人材番号", t.talentNo],
    ["表示名", t.displayName],
    ["職種", [redact(t.title, 40), ...strList(t.roles, 3, 30)].filter(Boolean).join(" / ") || null],
    ["経験年数", redact(t.experience, 20)],
    ["稼働開始", redact(t.availability, 24)],
    ["稼働日数", redact(t.weekDays, 16)],
    ["働き方の希望", redact(t.remoteLabel, 30)],
    ["居住地（都道府県）", t.prefecture],
    ["年代", redact(t.ageBand, 12)],
  ].filter(([, v]) => v);
  return {
    title: "ENGER 公開用スキルシート（要約版）",
    rows,
    skills: strList(t.skills, 20, 40),
    note: "氏名・連絡先・所属会社・単価・経歴の原文は含みません。詳しい経歴は担当営業がマスキングのうえご案内します。",
  };
}

/** 絞り込みの入力を整える（知らない値は捨てる） */
export function parseTalentQuery(params) {
  const get = (k) => (typeof params?.get === "function" ? params.get(k) : params?.[k]);
  const tab = TABS.includes(get("tab")) ? get("tab") : "all";
  const q = norm(get("q")).slice(0, 100);
  const skills = norm(get("skills")).split(/[,、，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  const remote = Object.keys(REMOTE_KINDS).includes(get("remote")) ? get("remote") : null;
  const prefecture = PREFECTURES.includes(get("prefecture")) ? get("prefecture") : null;
  const weekDaysRaw = Number(get("weekDays"));
  const weekDays = Number.isInteger(weekDaysRaw) && weekDaysRaw >= 1 && weekDaysRaw <= 5 ? weekDaysRaw : null;
  const start = get("start") === "immediate" ? "immediate" : null;
  const sort = SORTS.includes(get("sort")) ? get("sort") : (q || skills.length ? "relevance" : "new");
  const pageRaw = Number(get("page"));
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 && pageRaw <= 500 ? pageRaw : 1;
  return { tab, q, skills, remote, prefecture, weekDays, start, sort, page };
}

const firstDigit = (s) => { const m = norm(s).match(/[1-7]/); return m ? Number(m[0]) : null; };

function matchesFilters(t, f) {
  const hay = lower([t.displayName, t.talentNo, t.title, ...(t.roles || []), ...(t.skills || [])].join(" "));
  if (f.q && !lower(f.q).split(" ").filter(Boolean).every((w) => hay.includes(w))) return false;
  if (f.skills.length) {
    const own = (t.skills || []).map(lower);
    if (!f.skills.every((s) => own.some((o) => o === lower(s) || o.includes(lower(s))))) return false;
  }
  if (f.remote && t.remote !== f.remote) return false;
  if (f.prefecture && t.prefecture !== f.prefecture) return false;
  if (f.weekDays) { const d = firstDigit(t.weekDays); if (d == null || d < f.weekDays) return false; }
  if (f.start === "immediate" && !/即|すぐ|随時|今月|相談/.test(norm(t.availability))) return false;
  return true;
}

/** 関連度：指定スキルの一致を最も重く、職種・スキルのキーワード一致、注力・新着を少し足す */
export function relevance(t, f) {
  let score = 0;
  const skills = (t.skills || []).map(lower);
  for (const s of f.skills) if (skills.some((o) => o === lower(s))) score += 3; else if (skills.some((o) => o.includes(lower(s)))) score += 2;
  for (const w of lower(f.q).split(" ").filter(Boolean)) {
    if (lower([t.title, ...(t.roles || [])].join(" ")).includes(w)) score += 2;
    if (skills.some((o) => o === w)) score += 2; else if (skills.some((o) => o.includes(w))) score += 1;
  }
  if (t.isFocus) score += 0.5;
  if (t.isNew) score += 0.3;
  return score;
}

/**
 * 母集団（DB の行）→ 企業に見せる行の並び。
 * @returns {{ items: {row, talent}[], total: number }}
 */
export function selectTalents(rows, f, { now = Date.now() } = {}) {
  const items = [];
  for (const row of rows || []) {
    if (!isPublicTalent(row)) continue;
    const talent = toPublicTalent(row, { now });
    if (f.tab === "focus" && !talent.isFocus) continue;
    if (f.tab === "new" && !talent.isNew) continue;
    if (!matchesFilters(talent, f)) continue;
    items.push({ row, talent, score: f.sort === "relevance" ? relevance(talent, f) : 0 });
  }
  const created = (x) => Date.parse(x.row.created_at || "") || 0;
  items.sort((a, b) => (b.score - a.score) || (created(b) - created(a)) || ((b.talent.no || 0) - (a.talent.no || 0)));
  return { items, total: items.length };
}

export function pageOf(items, page, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, page), pages);
  return { slice: items.slice((p - 1) * size, p * size), page: p, pages };
}
