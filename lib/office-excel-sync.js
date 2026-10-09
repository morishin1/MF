// Office 定例業務：Excel 年間予定表を「Excel 由来の定例業務の最新版（正本）」として同期する（db/128）。純粋な関数（表は読まない）。
//
// ■ 何をするか
//   Excel（classifyExcel で「毎月」「毎年」に分けた行）と、DB の Excel 由来のマスター（source='excel'）を比べて、
//   新規／更新／変更なし／停止／再有効化／要確認 を決める。手動で作ったマスター（source='manual'）は比べない（触らない）。
//   単発（1回だけ）の行は同期の対象外（数だけ出す）。
//
// ■ Excel が決める項目と、システムが決める項目
//   Excel   … 業務名・カテゴリ・繰り返し（毎月／毎年）・基準日（日・月）・土日祝の移動
//   システム … 担当・担当部署・優先度・説明・備考・URL・期限・開始日／終了日（同期で空欄に戻さない。比べもしない）
//
// ■ どのマスターと同じ業務とみなすか（上から順に）
//   1. source_key が完全に同じ（xl:列|文言。文言は空白・末尾のかっこ書きを除いて比べる）→ そのマスター
//      （基準日だけ変わった・かっこ書きだけ変わった は、ここで「更新」になる）
//   2. まだ組になっていないもののうち、カテゴリ・繰り返し・基準日（毎月の日／毎年の月日）が同じで、
//      業務名がほぼ同じ（「の」・句読点・空白を除くと同じ、または文字の重なりが 0.8 以上）。互いに1対1のときだけ → 「更新」
//      （業務名だけ少し直した、を新規＋停止にしない）
//   3. 業務名が似ている（重なり 0.5 以上）が、基準日やカテゴリも違う → 「要確認」。人が「同じ業務として更新」か
//      「別の業務（新規登録・前のものは停止）」を選ぶまで同期できない
//   どれにも当たらない Excel の行 → 新規。どの行とも組にならない有効なマスター → 停止（削除はしない）
//
// ■ 権限
//   行のカテゴリ（更新・再有効化はいまのカテゴリと Excel のカテゴリの両方）を直せない人の行は「権限不足」として、
//   同期しない（停止もしない）。見られないカテゴリの行は、業務名を伏せる。

import { describeRule, categoryLabel, canEditCategory, canViewCategory, TITLE_MAX } from "./office-recurring.js";
import { createHash } from "node:crypto";

export const SYNC_FIELDS = [
  { key: "title", label: "業務名" },
  { key: "category", label: "カテゴリ" },
  { key: "recurrence_type", label: "繰り返し" },
  { key: "recurrence_rule", label: "基準日" },
];
export const ACTIONS = {
  new: "新規", update: "更新", unchanged: "変更なし", stop: "停止予定", reactivate: "再有効化", review: "要確認",
};
const AUTO_SIMILARITY = 0.8;
const REVIEW_SIMILARITY = 0.5;

// ---- 比べるための形 ------------------------------------------------------------------------
/** 中身が同じなら同じ文字列（キーの順を揃える） */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
/** 業務名を比べる形（空白・句読点・助詞「の」・かっこ・記号を除く） */
export function titleCore(s) {
  return String(s || "").normalize("NFKC").toLowerCase()
    .replace(/[\s　・、。,.．，:：;；!！?？\-－ー〜~\/／()（）[\]【】「」『』"'”’＆&]+/g, "")
    .replace(/の/g, "");
}
/** 文字の重なり（2文字ずつの組の Dice 係数。0〜1） */
export function similarity(a, b) {
  const x = titleCore(a), y = titleCore(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const gx = grams(x), gy = grams(y);
  let both = 0, nx = 0, ny = 0;
  for (const v of gx.values()) nx += v;
  for (const v of gy.values()) ny += v;
  for (const [g, v] of gx) both += Math.min(v, gy.get(g) || 0);
  return nx + ny ? (2 * both) / (nx + ny) : 0;
}
/** 基準日（繰り返しの種類＋日・月）。土日祝の移動は含めない */
export function anchorOf(type, rule = {}) {
  const day = rule.type ? String(rule.type) + (rule.n != null ? `:${rule.n}` : "") : `d${Number(rule.day) || 0}`;
  return type === "yearly" ? `y${Number(rule.month) || 0}|${day}` : `${type}|${day}`;
}

/** Excel の行（classifyExcel の recurring）を、マスターの列の形にする */
export function excelValue(r) {
  return {
    title: String(r.title || r.text || "").trim().slice(0, TITLE_MAX),
    category: r.category,
    recurrence_type: r.recurrenceType,
    recurrence_rule: r.recurrenceRule || {},
  };
}
const masterValue = (m) => ({ title: m.title, category: m.category, recurrence_type: m.recurrence_type, recurrence_rule: m.recurrence_rule || {} });
const ruleText = (v) => describeRule(v.recurrence_type, v.recurrence_rule || {});

/** 何が変わるか（Excel が決める項目だけ） */
export function diffFields(cur, next) {
  const out = [];
  for (const f of SYNC_FIELDS) {
    const a = cur[f.key], b = next[f.key];
    if (canonical(a) === canonical(b)) continue;
    const show = (v, val) => f.key === "category" ? categoryLabel(v) : f.key === "recurrence_rule" || f.key === "recurrence_type" ? ruleText(val) : v;
    out.push({ field: f.key, label: f.label, before: a ?? null, after: b ?? null, beforeText: show(a, cur), afterText: show(b, next) });
  }
  // 繰り返しと基準日の両方が変わったら、ことばは1行にまとめる（画面で同じ文が2回出ないように）
  if (out.some((c) => c.field === "recurrence_type") && out.some((c) => c.field === "recurrence_rule")) {
    return out.filter((c) => c.field !== "recurrence_type");
  }
  return out;
}

/**
 * 同期の計画
 * @param {object} p
 * @param {object[]} p.excelRows  classifyExcel の rows（kind=recurring だけ使う）
 * @param {object[]} p.masters    DB の source='excel' のマスター（有効・停止の両方。このテナントだけ）
 * @param {object}   p.perms      lib/office-recurring.js の permsOf
 * @param {Record<string,"link"|"separate">} [p.decisions]  要確認の行（Excel のキー）ごとの人の判断
 * @returns {{rows:object[], summary:object, singles:number, ops:object}}
 */
export function planSync({ excelRows, masters, perms, decisions = {} }) {
  const rec = (excelRows || []).filter((r) => r.kind === "recurring");
  const singles = (excelRows || []).filter((r) => r.kind !== "recurring").length;
  const ms = (masters || []).filter((m) => m.source === "excel");
  const byKey = new Map(ms.filter((m) => m.source_key).map((m) => [m.source_key, m]));
  const pairs = new Map();            // Excel のキー → { master, how }
  const usedMaster = new Set();

  // 1. source_key が完全に同じ
  for (const r of rec) {
    const m = byKey.get(r.key);
    if (m && !usedMaster.has(m.id)) { pairs.set(r.key, { master: m, how: "key" }); usedMaster.add(m.id); }
  }
  const restRows = () => rec.filter((r) => !pairs.has(r.key));
  const restMasters = () => ms.filter((m) => !usedMaster.has(m.id));

  // 2. カテゴリ・繰り返し・基準日が同じで、業務名がほぼ同じ（互いに1対1）
  const cand = [];
  for (const r of restRows()) {
    const v = excelValue(r);
    for (const m of restMasters()) {
      if (m.category !== v.category || m.recurrence_type !== v.recurrence_type) continue;
      if (anchorOf(m.recurrence_type, m.recurrence_rule) !== anchorOf(v.recurrence_type, v.recurrence_rule)) continue;
      const s = similarity(m.title, v.title);
      if (s >= AUTO_SIMILARITY) cand.push({ r, m, s });
    }
  }
  const countR = new Map(), countM = new Map();
  for (const c of cand) { countR.set(c.r.key, (countR.get(c.r.key) || 0) + 1); countM.set(c.m.id, (countM.get(c.m.id) || 0) + 1); }
  for (const c of cand) {
    if (countR.get(c.r.key) === 1 && countM.get(c.m.id) === 1) { pairs.set(c.r.key, { master: c.m, how: "similar", similarity: c.s }); usedMaster.add(c.m.id); }
  }

  // 3. 業務名が似ている → 要確認（似ている順に1対1で組む）
  const loose = [];
  for (const r of restRows()) {
    const v = excelValue(r);
    for (const m of restMasters()) {
      const s = similarity(m.title, v.title);
      if (s >= REVIEW_SIMILARITY) loose.push({ r, m, s });
    }
  }
  loose.sort((a, b) => b.s - a.s);
  const reviewPairs = new Map();
  const reviewMasters = new Set();
  for (const c of loose) {
    if (reviewPairs.has(c.r.key) || reviewMasters.has(c.m.id)) continue;
    reviewPairs.set(c.r.key, c); reviewMasters.add(c.m.id);
  }

  const rows = [];
  const ops = { inserts: [], updates: [], stops: [] };
  const can = (cat) => canEditCategory(perms, cat);
  const view = (cat) => canViewCategory(perms, cat);
  const masked = (title, ...cats) => (cats.every((c) => !c || view(c)) ? title : "（見る権限のないカテゴリの業務）");

  const linkRow = (r, m, how, extra = {}) => {
    const next = excelValue(r), cur = masterValue(m);
    const changes = diffFields(cur, next);
    const keyChanged = m.source_key !== r.key;
    const action = !m.is_active ? "reactivate" : changes.length ? "update" : "unchanged";
    const forbidden = action !== "unchanged" && !(can(m.category) && can(next.category));
    const row = {
      action, key: r.key, id: m.id, how, title: masked(next.title, next.category, m.category),
      category: next.category, categoryLabel: categoryLabel(next.category),
      current: { title: masked(m.title, m.category), category: m.category, categoryLabel: categoryLabel(m.category), ruleText: ruleText(cur), active: Boolean(m.is_active) },
      next: { title: masked(next.title, next.category), category: next.category, categoryLabel: categoryLabel(next.category), ruleText: ruleText(next),
        recurrenceType: next.recurrence_type, recurrenceRule: next.recurrence_rule },
      changes, forbidden, ...extra,
    };
    rows.push(row);
    if (forbidden || (action === "unchanged" && !keyChanged)) return;
    ops.updates.push({ id: m.id, category: m.category, set: { ...next, source_key: r.key, is_active: true }, reactivate: !m.is_active, changed: action !== "unchanged" });
  };
  const newRow = (r, extra = {}) => {
    const next = excelValue(r);
    const forbidden = !can(next.category);
    rows.push({
      action: "new", key: r.key, id: null, title: masked(next.title, next.category), category: next.category, categoryLabel: categoryLabel(next.category),
      current: null,
      next: { title: masked(next.title, next.category), category: next.category, categoryLabel: categoryLabel(next.category), ruleText: ruleText(next),
        recurrenceType: next.recurrence_type, recurrenceRule: next.recurrence_rule },
      changes: [], forbidden, reason: r.reason || null, ...extra,
    });
    if (!forbidden) ops.inserts.push({ key: r.key, value: next });
  };
  const stopRow = (m, extra = {}) => {
    const forbidden = !can(m.category);
    rows.push({
      action: "stop", key: m.source_key, id: m.id, title: masked(m.title, m.category), category: m.category, categoryLabel: categoryLabel(m.category),
      current: { title: masked(m.title, m.category), category: m.category, categoryLabel: categoryLabel(m.category), ruleText: ruleText(masterValue(m)), active: true },
      next: null, changes: [], forbidden,
      reason: "前回の Excel にはありましたが、今回の Excel にはありません。同期すると今後の予定の作成を停止します。過去の履歴は残ります。", ...extra,
    });
    if (!forbidden) ops.stops.push({ id: m.id, category: m.category });
  };

  for (const r of rec) {
    const p = pairs.get(r.key);
    if (p) { linkRow(r, p.master, p.how, p.similarity ? { similarity: Math.round(p.similarity * 100) / 100 } : {}); continue; }
    const rv = reviewPairs.get(r.key);
    if (!rv) { newRow(r); continue; }
    const choice = decisions[r.key];
    const cand = { id: rv.m.id, title: masked(rv.m.title, rv.m.category), categoryLabel: categoryLabel(rv.m.category), ruleText: ruleText(masterValue(rv.m)), active: Boolean(rv.m.is_active) };
    if (choice === "link") { usedMaster.add(rv.m.id); linkRow(r, rv.m, "review", { decided: "link", candidate: cand, similarity: Math.round(rv.s * 100) / 100 }); continue; }
    if (choice === "separate") { newRow(r, { decided: "separate", candidate: cand }); continue; }
    const next = excelValue(r);
    rows.push({
      action: "review", key: r.key, id: null, title: masked(next.title, next.category), category: next.category, categoryLabel: categoryLabel(next.category),
      current: { title: cand.title, category: rv.m.category, categoryLabel: cand.categoryLabel, ruleText: cand.ruleText, active: cand.active },
      next: { title: masked(next.title, next.category), category: next.category, categoryLabel: categoryLabel(next.category), ruleText: ruleText(next),
        recurrenceType: next.recurrence_type, recurrenceRule: next.recurrence_rule },
      changes: diffFields(masterValue(rv.m), next), candidate: cand, similarity: Math.round(rv.s * 100) / 100,
      forbidden: !(can(rv.m.category) && can(next.category)),
      reason: "前の業務と名前が似ています。同じ業務として更新するか、別の業務として登録するかを選んでください。",
    });
  }
  // 組にならなかった有効なマスター → 停止（要確認で「別の業務」を選んだときの前のものも、ここで停止）
  for (const m of ms) {
    if (usedMaster.has(m.id) || !m.is_active) continue;
    const rv = [...reviewPairs.values()].find((c) => c.m.id === m.id);
    if (rv && !decisions[rv.r.key]) continue;      // まだ決まっていない要確認の相手は、停止にしない
    stopRow(m, rv ? { decided: "separate" } : {});
  }

  const order = { review: 0, new: 1, update: 2, reactivate: 3, stop: 4, unchanged: 5 };
  rows.sort((a, b) => order[a.action] - order[b.action] || String(a.category).localeCompare(String(b.category)) || String(a.title).localeCompare(String(b.title), "ja"));
  const count = (a) => rows.filter((r) => r.action === a).length;
  const summary = {
    new: count("new"), update: count("update"), unchanged: count("unchanged"), stop: count("stop"),
    reactivate: count("reactivate"), review: count("review"), forbidden: rows.filter((r) => r.forbidden && r.action !== "unchanged").length,
    total: rec.length,
  };
  return { rows, summary, singles, ops };
}

/** プレビューと確定で、同じ Excel・同じ DB の状態かを確かめる印 */
export function syncToken({ periodStart, excelRows, masters }) {
  const h = createHash("sha256");
  h.update(String(periodStart));
  for (const r of (excelRows || []).filter((x) => x.kind === "recurring")) h.update(`|${r.key}|${canonical(excelValue(r))}`);
  for (const m of [...(masters || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    h.update(`#${m.id}|${m.source}|${m.source_key}|${m.is_active}|${m.updated_at}|${canonical(masterValue(m))}`);
  }
  return h.digest("hex").slice(0, 32);
}

/** シートの名前（例：202609月）から期の始まり（YYYY-MM）を出す。無ければ null */
export function periodFromSheets(names) {
  const ym = (names || []).map((n) => String(n).match(/^(\d{4})(\d{2})月$/)).filter(Boolean).map((m) => `${m[1]}-${m[2]}`).sort();
  return ym[0] || null;
}
/** 期の表示（2026-09 → 2026年9月〜2027年8月） */
export function periodLabel(periodStart) {
  const m = String(periodStart || "").match(/^(\d{4})-(\d{2})$/);
  if (!m) return "";
  const y = Number(m[1]), mo = Number(m[2]);
  const ey = mo === 1 ? y : y + 1, em = mo === 1 ? 12 : mo - 1;
  return `${y}年${mo}月〜${ey}年${em}月`;
}
/** 期の外のシート（例：期の始まりが 2026-09 なのに 202509月 がある） */
export function sheetsOutOfPeriod(names, periodStart) {
  const m = String(periodStart || "").match(/^(\d{4})-(\d{2})$/);
  if (!m) return [];
  const start = Number(m[1]) * 12 + Number(m[2]) - 1;
  return (names || []).filter((n) => {
    const a = String(n).match(/^(\d{4})(\d{2})月$/);
    if (!a) return false;
    const v = Number(a[1]) * 12 + Number(a[2]) - 1;
    return v < start || v > start + 11;
  });
}
