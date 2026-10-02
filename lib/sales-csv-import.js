// /sales 企業の CSV 取込：1行ずつの判定（登録できる・重複・要修正）
//
// ■ 入力チェックは企業追加と同じ（lib/sales.js normalizeCompany・テナントの共通マスター db/108）
//   業種・提案サービスはマスターの表示中の値だけ。知らない値を勝手に別の分類へ変えない（要修正にする）。
//   都道府県は「鹿児島県鹿屋市」のように市区町村まで入っていても都道府県にする。所在地が空なら元の文字列を所在地へ。
// ■ 重複は企業追加と同じ：ドメインで判定。既存の会社（非表示を含む）とも、CSVの前の行とも比べる。上書きはしない

import { normalizeCompany, safeUrl, domainOf, parseEmails } from "./sales.js";
import { DEFAULT_INDUSTRIES, DEFAULT_SERVICES, parsePrefecture } from "./sales-master.js";

// CSV の列（テンプレートの見出し）。画面のテンプレート・読込もこの順・この名前
export const CSV_IMPORT_COLUMNS = [
  { key: "name", label: "企業名", required: true },
  { key: "siteUrl", label: "企業サイトURL" },
  { key: "formUrl", label: "問い合わせフォームURL" },
  { key: "industry", label: "業種" },
  { key: "region", label: "都道府県" },
  { key: "address", label: "所在地" },
  { key: "service", label: "提案サービス" },
  { key: "phone", label: "電話番号" },
  // 複数はカンマ区切り（「info@example.jp,sales@example.jp」）。企業追加と同じ正規化・チェック
  { key: "emails", label: "メールアドレス" },
  { key: "size", label: "企業規模" },
  { key: "note", label: "メモ" },
];

export const CSV_PREVIEW_MAX = 5000;   // 1ファイルで読む最大行数
export const CSV_COMMIT_MAX = 100;     // 登録は1回にこの行数まで（画面は50行ずつ送る）

const text = (v) => (v === null || v === undefined ? "" : String(v).trim());

/**
 * 1行を判定する（DB は見ない。重複は呼ぶ側で）
 * @returns {{ row:number, status:"ok"|"error", reasons:string[], value?:object, show:object }}
 */
export function checkImportRow(input, rowNo, masters = null) {
  const industries = masters?.industries || DEFAULT_INDUSTRIES;
  const services = masters?.services || DEFAULT_SERVICES;
  const reasons = [];
  const r = Object.fromEntries(CSV_IMPORT_COLUMNS.map(({ key }) => [key, text(input?.[key])]));
  const show = { name: r.name, siteUrl: r.siteUrl, industry: r.industry, region: r.region, service: r.service, domain: null };

  if (!r.name) reasons.push("企業名がありません");
  if (r.siteUrl && safeUrl(r.siteUrl) === false) reasons.push("企業サイトURLが正しくありません");
  if (r.formUrl && safeUrl(r.formUrl) === false) reasons.push("問い合わせフォームURLが正しくありません");
  if (r.industry && !industries.includes(r.industry)) reasons.push(`業種「${r.industry}」はマスターにありません（${industries.join("・")}）`);
  if (r.service && !services.includes(r.service)) reasons.push(`提案サービス「${r.service}」はマスターにありません（${services.join("・")}）`);
  const emails = parseEmails(r.emails);
  if (emails.error) reasons.push(emails.hint);
  let region = null;
  let address = r.address || null;
  if (r.region) {
    const p = parsePrefecture(r.region);
    if (!p) reasons.push(`都道府県「${r.region}」を判定できません`);
    else {
      region = p.prefecture;
      if (p.rest && !address) address = r.region;   // 市区町村まで入っていたら、所在地が空のときだけ元の文字列を所在地へ
      show.region = region;
    }
  }
  if (reasons.length) return { row: rowNo, status: "error", reasons, show };

  const n = normalizeCompany({
    name: r.name, siteUrl: r.siteUrl || null, formUrl: r.formUrl || null, industry: r.industry || null,
    region, address, service: r.service || null, phone: r.phone || null, size: r.size || null, note: r.note || null,
    emails: emails.emails,
  }, { masters: { industries, services } });
  if (n.error) return { row: rowNo, status: "error", reasons: [n.hint || n.error], show };
  show.domain = n.value.domain || (r.siteUrl ? domainOf(safeUrl(r.siteUrl)) : null);
  return { row: rowNo, status: "ok", reasons: [], value: n.value, show };
}

/**
 * まとめて判定する。existing … 既存の会社（ドメイン → 企業名）
 * CSV の中で同じドメインが2回目以降に出たら「重複」。既存と同じドメインも「重複（登録済みのためスキップ）」
 */
export function checkImportRows(rows, existing, masters = null) {
  const firstRowOf = new Map();
  return rows.map((input, i) => {
    const rowNo = Number.isInteger(input?.row) ? input.row : i + 2;   // 1行目は見出し
    const res = checkImportRow(input, rowNo, masters);
    if (res.status !== "ok" || !res.value.domain) return res;
    const d = res.value.domain;
    if (existing.has(d)) return { ...res, status: "duplicate", reasons: [`登録済みのためスキップ（${existing.get(d)}）`] };
    if (firstRowOf.has(d)) return { ...res, status: "duplicate", reasons: [`CSV内で重複（${firstRowOf.get(d)}行目と同じサイト）`] };
    firstRowOf.set(d, rowNo);
    return res;
  });
}

export function countResults(results) {
  const c = { read: results.length, ok: 0, duplicate: 0, error: 0 };
  for (const r of results) c[r.status === "ok" ? "ok" : r.status] += 1;
  return c;
}
