// プロパー／BP の印。純粋関数だけ。
//
// ■ ここが正
//
//   「BPには所属先が要る」「プロパーには持たせない」という決まりは、
//   DB の制約（db/075）と、この1ファイルの両方に書く。
//   画面・API・DB のどこか1つだけが正しくても、
//   食い違えば結局どちらかにバグが出る。二重に守ることに意味がある。

export const EMPLOYEE_KINDS = [
  { key: "proper", label: "プロパー", hint: "自社雇用（従来どおり）" },
  { key: "bp", label: "BP", hint: "パートナー企業に所属する外部要員" },
];
export const EMPLOYEE_KIND_KEYS = EMPLOYEE_KINDS.map((k) => k.key);
export const kindLabel = (key) => EMPLOYEE_KINDS.find((k) => k.key === key)?.label || key;

/**
 * employee_kind と partner_company_id の組み合わせが正しいか。
 * @returns {{ok:true,value:{employee_kind,partner_company_id}}|{ok:false,hint:string}}
 */
export function normalizeKind(kind, partnerCompanyId) {
  const k = kind || "proper";
  if (!EMPLOYEE_KIND_KEYS.includes(k)) {
    return { ok: false, hint: "区分（プロパー／BP）を選んでください" };
  }
  if (k === "bp") {
    if (!partnerCompanyId) return { ok: false, hint: "BPの場合は、所属先（BP企業）を選んでください" };
    return { ok: true, value: { employee_kind: "bp", partner_company_id: partnerCompanyId } };
  }
  // プロパーは所属先を持たない。送られてきても無視する（DBの制約と同じ判断）
  return { ok: true, value: { employee_kind: "proper", partner_company_id: null } };
}

/** 一覧・詳細に出す表示名。BPは会社名まで見えないと、誰が誰だか分からない */
export function kindDisplay(employee, companiesById) {
  if (employee?.employee_kind !== "bp") return kindLabel("proper");
  const c = companiesById?.get?.(employee.partner_company_id);
  return c ? `BP（${c.company_name}）` : "BP";
}
