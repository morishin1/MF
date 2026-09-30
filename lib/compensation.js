// 給与の履歴（gw_compensations）の、純粋な部品。表も画面も知らない（test/compensation.mjs）。
//
// ■ 考え方（docs/keiei-pay-management.md）
//
//   給与は「いまの値を上書き」しない。適用開始日つきの行を足していく（追記だけ）。
//     ・給与を変える     … 新しい適用開始日の行を足す（kind=change。最初の1件は initial）
//     ・入力の誤りを直す … 同じ適用開始日の「次の版」を足す（kind=correction。前の版も残る）
//   どの行にも、変更前の値・変更した人・日時・理由を持たせる。消す・書き換える操作は、そもそも用意しない。
//   「いまの給与」= 適用開始日が今日以前で、いちばん新しい日付の、最新の版。
//
// ■ ここでやること・やらないこと
//   やる    … 入力の正規化と検査・履歴の並べ替え・いまの給与の決め方・変更前後の差・契約との食い違いの判定
//   やらない … 表を読み書きする（api/keiei/pay.js）／画面に出す（keiei/pay.js）。既存の表（契約・内定）には触れない
//
// ■ 金額
//   すべて円の整数。基本給は、月給なら月額・年俸なら年額・時給なら1時間・日給なら1日。
//   手当と通勤手当は、月額。月額に換算できないもの（時給・日給の基本給）は、合計を出さない（実稼働が未確定のため）。

export const WAGE_TYPES = ["月給", "年俸", "時給", "日給"];
export const KINDS = ["initial", "change", "correction"];
export const SOURCES = ["owner", "contract_import", "offer_import"];
export const KIND_LABEL = { initial: "初回", change: "変更", correction: "訂正" };
export const SOURCE_LABEL = { owner: "経営者の入力", contract_import: "契約から取り込み", offer_import: "内定から取り込み" };
export const LIMITS = { base: 100000000, allowance: 10000000, commute: 10000000, allowances: 20, name: 40, note: 200, reason: 500 };
/** 入力の候補（自由に書ける）。lib/intake.js の手当と同じ言い方にそろえる */
export const ALLOWANCE_PRESETS = ["役職手当", "資格手当", "住宅手当", "家族手当", "在宅勤務手当", "固定残業代"];

const DATE_MIN = "2000-01-01";

export const todayJst = (now = Date.now()) => new Date(now + 9 * 3600000).toISOString().slice(0, 10);
export const isDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;   // 2026-13-01 は NaN、2026-02-30 は繰り上がるので不一致
};

const clean = (v, max, multiline = false) => String(v ?? "")
  .replace(/\r\n?/g, "\n")
  .replace(multiline ? /[\u0000-\u0008\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, "")
  .trim().slice(0, max);

/** 円の整数に。"300,000"・"300000円"・300000 は通す。小数・負・数でないものは NaN */
export function toYen(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isInteger(v) ? v : NaN;
  if (typeof v !== "string") return NaN;
  const s = v.replace(/[,，\s円]/g, "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

const bad = (field, hint) => ({ error: "invalid_body", field, hint });

/**
 * 画面から来た値を、記録できる形にそろえる。
 * @returns {{ value?: object, error?: string, field?: string, hint?: string }}
 */
export function normalizeRecordInput(body, { now = Date.now() } = {}) {
  const b = body && typeof body === "object" ? body : {};

  if (!isDate(b.effectiveFrom)) return bad("effectiveFrom", "適用開始日を入れてください（いつからこの給与か）");
  if (b.effectiveFrom < DATE_MIN || b.effectiveFrom > `${Number(todayJst(now).slice(0, 4)) + 5}-12-31`) {
    return bad("effectiveFrom", "適用開始日が範囲外です（2000年〜5年先まで）");
  }
  if (!WAGE_TYPES.includes(b.wageType)) return bad("wageType", `賃金の種別を選んでください（${WAGE_TYPES.join("・")}）`);

  const base = toYen(b.baseAmount);
  if (base === null) return bad("baseAmount", "基本給を入れてください");
  if (!Number.isFinite(base) || base < 0 || base > LIMITS.base) return bad("baseAmount", "基本給は 0 円以上の整数で入れてください（小数・単位は付けない）");

  const rowsIn = b.allowances === undefined || b.allowances === null ? [] : b.allowances;
  if (!Array.isArray(rowsIn)) return bad("allowances", "手当は、名前と金額の一覧で入れてください");
  const allowances = [];
  const seen = new Set();
  for (const r of rowsIn) {
    if (!r || typeof r !== "object") return bad("allowances", "手当の形が正しくありません");
    const name = clean(r.name, LIMITS.name);
    const amountRaw = r.amount;
    const empty = !name && (amountRaw === undefined || amountRaw === null || amountRaw === "");
    if (empty) continue;                        // 画面の空行は捨てる
    if (!name) return bad("allowances", "手当の名前が空です");
    const amount = toYen(amountRaw);
    if (amount === null || !Number.isFinite(amount) || amount < 0 || amount > LIMITS.allowance) {
      return bad("allowances", `手当「${name}」の金額は、0 円以上の整数で入れてください（月額）`);
    }
    const key = name.normalize("NFKC").toLowerCase();
    if (seen.has(key)) return bad("allowances", `手当「${name}」が重複しています`);
    seen.add(key);
    allowances.push({ name, amount });
  }
  if (allowances.length > LIMITS.allowances) return bad("allowances", `手当は ${LIMITS.allowances} 件までです`);

  const commute = toYen(b.commuteAmount);
  if (commute !== null && (!Number.isFinite(commute) || commute < 0 || commute > LIMITS.commute)) {
    return bad("commuteAmount", "通勤手当は、0 円以上の整数で入れてください（月額）");
  }

  const reason = clean(b.reason, LIMITS.reason, true);
  if (!reason) return bad("reason", "変更理由（またはメモ）を入れてください。あとから監査できるように、必ず残します");

  const source = b.source === undefined ? "owner" : b.source;
  if (!SOURCES.includes(source)) return bad("source", "取り込み元が正しくありません");

  return {
    value: {
      effectiveFrom: b.effectiveFrom, wageType: b.wageType, baseAmount: base, allowances,
      commuteAmount: commute, commuteNote: clean(b.commuteNote, LIMITS.note) || null,
      reason, source, correct: b.correct === true,
    },
  };
}

// ---- 行の見せ方・月額 -----------------------------------------------------------

/** 表の行 → 画面に返す形（snake_case → camelCase）。監査に要る項目は全部持つ */
export function viewOf(row) {
  const r = row || {};
  const view = {
    id: r.id, employeeId: r.employee_id, effectiveFrom: r.effective_from, revision: r.revision, kind: r.kind, source: r.source,
    wageType: r.wage_type, baseAmount: r.base_amount == null ? null : Number(r.base_amount),
    allowances: Array.isArray(r.allowances) ? r.allowances.map((a) => ({ name: a.name, amount: Number(a.amount) })) : [],
    commuteAmount: r.commute_amount == null ? null : Number(r.commute_amount), commuteNote: r.commute_note || null,
    contract: r.contract_wage_type != null || r.contract_wage_amount != null || r.contract_id
      ? { id: r.contract_id || null, wageType: r.contract_wage_type ?? null, wageAmount: r.contract_wage_amount == null ? null : Number(r.contract_wage_amount) }
      : null,
    reason: r.reason, before: r.before || null, createdBy: r.created_by_name || null, createdAt: r.created_at || null,
  };
  view.monthly = monthlyOf(view);
  return view;
}

/**
 * 月額の見立て。基本給が月額に換算できるとき（月給・年俸）だけ、合計を出す。
 * 時給・日給は、実稼働が決まらないので合計を出さない（手当と通勤手当だけは月額なので、別に返す）
 */
export function monthlyOf(rec) {
  const allowanceTotal = (rec.allowances || []).reduce((s, a) => s + Number(a.amount || 0), 0);
  const commute = Number(rec.commuteAmount || 0);
  const base = rec.wageType === "月給" ? rec.baseAmount : rec.wageType === "年俸" ? Math.round(rec.baseAmount / 12) : null;
  return { base, allowanceTotal, commute, total: base == null ? null : base + allowanceTotal + commute };
}

/** 変更前・変更後の比較に使う、値だけの写し（版・理由・日時は含めない） */
export function snapshotOf(rec) {
  if (!rec) return null;
  return {
    effectiveFrom: rec.effectiveFrom, revision: rec.revision, wageType: rec.wageType, baseAmount: rec.baseAmount,
    allowances: (rec.allowances || []).map((a) => ({ name: a.name, amount: a.amount })),
    commuteAmount: rec.commuteAmount ?? null,
  };
}

const sortedAllowances = (list) => [...(list || [])].sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));

/** 値が同じか（版・日付・理由は見ない。手当は並び順を問わない） */
export function sameContent(a, b) {
  if (!a || !b) return false;
  return a.wageType === b.wageType && Number(a.baseAmount) === Number(b.baseAmount)
    && (a.commuteAmount ?? null) === (b.commuteAmount ?? null)
    && JSON.stringify(sortedAllowances(a.allowances)) === JSON.stringify(sortedAllowances(b.allowances));
}

// ---- 履歴・いまの給与 -----------------------------------------------------------

/** 適用開始日ごとに、最新の版だけ。新しい日付が先 */
export function latestRevisions(records) {
  const by = new Map();
  for (const r of records || []) {
    const cur = by.get(r.effectiveFrom);
    if (!cur || r.revision > cur.revision) by.set(r.effectiveFrom, r);
  }
  return [...by.values()].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0));
}

/** date 時点で有効な給与（適用開始日が date 以前でいちばん新しい日付の、最新の版）。無ければ null */
export function currentAt(records, date) {
  return latestRevisions(records).find((r) => r.effectiveFrom <= date) || null;
}

/** date より先に始まる予定（近い順） */
export function upcomingAfter(records, date) {
  return latestRevisions(records).filter((r) => r.effectiveFrom > date).reverse();
}

/** 適用開始日ごとの履歴（新しい順）。同じ日付の訂正は、版が新しい順にまとまる */
export function historyGroups(records) {
  const by = new Map();
  for (const r of records || []) {
    if (!by.has(r.effectiveFrom)) by.set(r.effectiveFrom, []);
    by.get(r.effectiveFrom).push(r);
  }
  return [...by.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([effectiveFrom, revs]) => {
      const revisions = revs.sort((a, b) => b.revision - a.revision);
      return { effectiveFrom, latest: revisions[0], revisions };
    });
}

// ---- 変更前後の差 -----------------------------------------------------------------

const LABEL = { wageType: "賃金の種別", baseAmount: "基本給", commuteAmount: "通勤手当" };

/**
 * 変更前 → 変更後の、変わった項目。手当は名前ごとに（追加・削除・金額の変更）。
 * before が null（初回）なら、すべて「追加」
 * @returns {{key:string, label:string, from:any, to:any, change:"changed"|"added"|"removed"}[]}
 */
export function diffSnapshots(before, after) {
  const out = [];
  const b = before || {};
  const a = after || {};
  const push = (key, label, from, to) => {
    if (from === to) return;
    out.push({ key, label, from, to, change: from == null ? "added" : to == null ? "removed" : "changed" });
  };
  push("wageType", LABEL.wageType, before ? b.wageType : null, a.wageType ?? null);
  push("baseAmount", LABEL.baseAmount, before ? b.baseAmount : null, a.baseAmount ?? null);
  const bm = new Map((b.allowances || []).map((x) => [x.name, x.amount]));
  const am = new Map((a.allowances || []).map((x) => [x.name, x.amount]));
  for (const name of new Set([...bm.keys(), ...am.keys()])) {
    push(`allowance:${name}`, name, bm.has(name) ? bm.get(name) : null, am.has(name) ? am.get(name) : null);
  }
  push("commuteAmount", LABEL.commuteAmount, before ? (b.commuteAmount ?? null) : null, a.commuteAmount ?? null);
  return out;
}

// ---- 記録の計画（種別・版・変更前・注意）-----------------------------------------------

/**
 * 入力を、どの種別・どの版として記録するか決める。表は読まない（records は呼び出し側が渡す）。
 * @param {object[]} records  その社員の全記録（viewOf 済み）
 * @param {object} input      normalizeRecordInput の value
 * @param {{today?:string, contract?:object|null}} [opts]
 * @returns {{ error?:string, hint?:string, plan?:{kind:string, revision:number, before:object|null, basisId:string|null, after:object, changes:object[], warnings:string[]} }}
 */
export function planRecord(records, input, { today = todayJst(), contract = null } = {}) {
  const list = records || [];
  const atDate = list.filter((r) => r.effectiveFrom === input.effectiveFrom);
  const maxRev = atDate.reduce((m, r) => Math.max(m, r.revision), 0);

  if (input.correct && !maxRev) {
    return { error: "nothing_to_correct", hint: "この適用開始日の記録がありません。訂正ではなく、新しい変更として記録してください" };
  }
  if (!input.correct && maxRev) {
    return { error: "exists_at_date", hint: "この適用開始日の記録はすでにあります。入力の誤りを直すときは「訂正」として、別の日から変えるときは適用開始日を変えて記録してください" };
  }

  const kind = input.correct ? "correction" : list.length ? "change" : "initial";
  const revision = input.correct ? maxRev + 1 : 1;
  const beforeRec = input.correct ? atDate.find((r) => r.revision === maxRev) : currentAt(list, input.effectiveFrom);
  const before = snapshotOf(beforeRec);
  const after = { effectiveFrom: input.effectiveFrom, revision, wageType: input.wageType, baseAmount: input.baseAmount,
    allowances: input.allowances, commuteAmount: input.commuteAmount };

  if (before && sameContent(before, after)) {
    return { error: "no_change", hint: "変更前と同じ内容です。変える項目があるか、確認してください" };
  }

  const warnings = [];
  if (input.correct) warnings.push("入力の誤りを直す「訂正」です。前の版は履歴に残り、訂正の前後が監査できます");
  if (input.effectiveFrom < today) warnings.push("過去の日付から適用する記録です（遡及）。すでに支払った給与とは別に、記録上の適用開始日が過去になります");
  if (input.effectiveFrom > today) warnings.push("これから適用される給与です。適用開始日までは、いまの給与が「現在」のままです");
  if (!input.correct && !beforeRec && list.length) warnings.push("これまでのどの記録より前の日付です");
  const later = latestRevisions(list).filter((r) => r.effectiveFrom > input.effectiveFrom);
  if (!input.correct && later.length) warnings.push(`この日付より後の記録があります（${later.map((r) => r.effectiveFrom).reverse().join("・")}）。そちらは、引き続き適用されます`);
  const c = contractCheck(after, contract);
  if (c.state === "type" || c.state === "amount") warnings.push("契約の賃金と食い違います。契約書を更新するか、この記録を見直すか、確認してください（契約は、ここでは変わりません）");

  // basisId … この計画が「変更前」とした記録の id。画面が見ていた記録とずれていたら（別の人が先に記録した）、記録させない
  return { plan: { kind, revision, before, basisId: beforeRec?.id ?? null, after, changes: diffSnapshots(before, after), warnings } };
}

// ---- 契約との食い違い -----------------------------------------------------------------

/**
 * 給与の記録と、契約上の賃金（契約の書面が言っていること）を比べる。
 * state: none（契約に賃金が無い）/ unsupported（契約の種別を取り込めない）/ match / type / amount
 */
export function contractCheck(rec, contract) {
  const wageType = contract?.wageType ?? contract?.wage_type ?? null;
  const wageAmount = contract?.wageAmount ?? contract?.wage_amount ?? null;
  if (!contract || wageAmount == null) return { state: "none", contract: null };
  const info = { id: contract.id || null, wageType, wageAmount: Number(wageAmount), note: contract.wageNote ?? contract.wage_note ?? null };
  if (!WAGE_TYPES.includes(wageType)) return { state: "unsupported", contract: info };
  if (!rec) return { state: "unregistered", contract: info };
  if (rec.wageType !== wageType) return { state: "type", contract: info };
  if (Number(rec.baseAmount) !== Number(wageAmount)) return { state: "amount", contract: info };
  return { state: "match", contract: info };
}

/**
 * 一覧の行の状態（複数）。
 *   unregistered … 記録が無い（契約に賃金はある／無い）
 *   future_only  … 記録はあるが、まだ適用が始まっていない
 *   upcoming     … これから変わる予定がある
 *   mismatch     … 契約の賃金と食い違う
 */
export function statusFlags(records, contract, today = todayJst()) {
  const flags = [];
  const cur = currentAt(records, today);
  if (!(records || []).length) flags.push("unregistered");
  else if (!cur) flags.push("future_only");
  if (upcomingAfter(records, today).length && cur) flags.push("upcoming");
  const c = contractCheck(cur, contract);
  if (cur && (c.state === "type" || c.state === "amount")) flags.push("mismatch");
  return flags;
}

// ---- 監査ログの見せ方 ---------------------------------------------------------------------

export const AUDIT_LABEL = {
  view_list: "一覧を開いた", view_detail: "個人の給与を開いた", view_audit: "監査ログを開いた",
  create: "給与を記録した", correct: "給与を訂正した",
};

export function auditView(row) {
  return {
    id: row.id, at: row.ts, action: row.action, label: AUDIT_LABEL[row.action] || row.action,
    actor: row.actor_name || null, employeeId: row.employee_id || null, recordId: row.record_id || null,
    detail: row.detail || null,
  };
}
