// /sales の企業の分類（共通マスター）。ここだけで定義する。
//
// 企業追加・企業編集・一覧の絞り込み・CSV取込・CSVテンプレート・APIの入力チェックが、すべてここを見る。
// 画面（sales/companies.html）は API の応答（masters）で受け取るので、画面側に同じ一覧を書かない。
// 業種・提案サービスを足すときは、この配列に足すだけでよい。
//
// ■ 地域（region）は都道府県だけ
//   市区町村以降は所在地（address）に入れる。
//   既存データの「鹿児島県鹿屋市」のような値は DB を書き換えず、一覧・絞り込み・件数では都道府県として扱う
//   （prefectureOf。DB 側の gw_sales_prefecture() と同じ判定：先頭が47都道府県のどれかで始まるか）。

export const INDUSTRIES = ["製造", "不動産", "士業", "医療", "小売", "その他"];

// 企業追加の「提案サービス」と一覧の「商材」は同じもの
export const SERVICES = ["AI / DX", "システム開発", "PCレンタル", "ホームページ改善", "地方創生", "ENGER", "その他"];

export const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県",
  "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県",
  "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

/** 画面に渡すマスター */
export const MASTERS = { industries: INDUSTRIES, services: SERVICES, prefectures: PREFECTURES };

/**
 * 保存されている地域から都道府県を取り出す（一覧・絞り込み・件数用）。
 * 先頭が47都道府県のどれかで始まるときだけ。取れなければ null（「鹿屋市」だけ、などは判定しない）
 */
export function prefectureOf(region) {
  const s = String(region ?? "").trim();
  if (!s) return null;
  return PREFECTURES.find((p) => s.startsWith(p)) || null;
}

/**
 * 入力（企業追加・CSV）の地域を都道府県にする。
 *   「鹿児島県」→ 鹿児島県 ／「鹿児島県鹿屋市」→ 鹿児島県（残り「鹿屋市」）／「鹿児島」→ 鹿児島県
 *   「東京」→ 東京都 ／「大阪市北区」→ 大阪府 は、都道府県名の「都・府・県」を省いた書き方も受ける
 *   （北海道はそのまま）。取れなければ null
 * @returns {{ prefecture: string, rest: string } | null}
 */
export function parsePrefecture(input) {
  const s = String(input ?? "").trim().replace(/\s+/g, "");
  if (!s) return null;
  const full = PREFECTURES.find((p) => s.startsWith(p));
  if (full) return { prefecture: full, rest: s.slice(full.length) };
  // 「都・府・県」を省いた書き方。長い名前から当てる（「京都」より先に「東京」を見ない、など取り違えを防ぐ）
  const short = PREFECTURES.filter((p) => p !== "北海道")
    .map((p) => [p, p.slice(0, -1)])
    .sort((a, b) => b[1].length - a[1].length)
    .find(([, name]) => s.startsWith(name));
  return short ? { prefecture: short[0], rest: s.slice(short[1].length) } : null;
}

export const isIndustry = (v) => INDUSTRIES.includes(v);
export const isService = (v) => SERVICES.includes(v);
export const isPrefecture = (v) => PREFECTURES.includes(v);
