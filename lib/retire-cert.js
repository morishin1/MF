// 退職証明書の本文（雛形への差し込み）。
//
// ■ 差し込み項目（admin-docs の雛形でも使える）
//   {{氏名}} {{雇用区分}} {{入社日}} {{退職日}} {{退職理由}} {{会社名}} {{会社住所}} {{代表者名}} {{発行日}} {{発行番号}}
//
// ■ 退職理由は、自動では印字しない
//   発行のたびに、管理者が「今回の証明書に含める」を選ぶ（含めないとき、{{退職理由}} の行は消える）。
//   印字するのは構造化した理由の名前（契約期間満了 など）だけ。社内向けの補足（reason_note）は印字しない。
//
// ■ 値が空の行は消す
//   {{退職理由}}・{{会社住所}}・{{代表者名}} が空のとき、その項目を含む行ごと消す（「退職の事由：」だけが残らない）。
//   ほかの項目が空のときは、そのまま空にせず {{…}} を残す（unresolved に入る。発行は、残っている間は止める）。

/** 雛形を選ばなかったときの本文（標題「退職証明書」は PDF 側で付ける） */
export const DEFAULT_TEMPLATE = `{{氏名}} 殿

下記のとおり、当社を退職したことを証明します。

氏名：{{氏名}}
雇用区分：{{雇用区分}}
入社日：{{入社日}}
退職日：{{退職日}}
退職の事由：{{退職理由}}`;

export const MERGE_KEYS = ["氏名", "雇用区分", "入社日", "退職日", "退職理由", "会社名", "会社住所", "代表者名", "発行日", "発行番号"];

/** 2026-09-30 → 2026年9月30日 */
export function dateJa(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : "";
}

/** 空でもよい項目（空なら、その項目を含む行を消す） */
const DROP_WHEN_EMPTY = new Set(["退職理由", "会社住所", "代表者名"]);

/**
 * @param {string} template
 * @param {Record<string,string>} values  キーは MERGE_KEYS
 * @returns {{text:string, unresolved:string[]}}
 */
export function mergeCertificate(template, values) {
  const unresolved = new Set();
  const out = [];
  for (const line of String(template ?? "").split("\n")) {
    let drop = false;
    const merged = line.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, key) => {
      if (!MERGE_KEYS.includes(key)) { unresolved.add(`{{${key}}}`); return whole; }
      const v = values[key];
      if (v === undefined || v === null || v === "") {
        if (DROP_WHEN_EMPTY.has(key)) { drop = true; return ""; }
        unresolved.add(`{{${key}}}`);
        return whole;
      }
      return String(v);
    });
    if (!drop) out.push(merged);
  }
  return { text: out.join("\n"), unresolved: [...unresolved] };
}

/** 差し込みに使う値（社員・退職理由・会社の情報から） */
export function certValues({ employee, reasonLabel, company, issuedOn, issuedNo, includeReason }) {
  return {
    氏名: employee?.display_name || "",
    雇用区分: employee?.employment_type || "",
    入社日: dateJa(employee?.joined_on),
    退職日: dateJa(employee?.left_on),
    退職理由: includeReason ? (reasonLabel || "") : "",
    会社名: company?.name || "",
    会社住所: company?.address || "",
    代表者名: company?.representative || "",
    発行日: dateJa(issuedOn),
    発行番号: issuedNo || "",
  };
}

/** 本文に残っている {{…}} */
export const leftoverFields = (text) => [...new Set(String(text || "").match(/\{\{[^}]+\}\}/g) || [])];

export const CERT_MAX_CHARS = 4000;
