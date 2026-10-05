// 経営ハブの「10月の目標と実績」「営業ファネル・担当者別」「停滞案件」（lib/keiei-sales.js）。
//
// ■ 何を守るテストか（2026-10 経営方針 §12 の Phase 1）
//   1. 今月の実績を、Sales の正本から決めた数え方で数える（接触・商談・提案・有料契約・受注額）。日付は日本時間
//      ファネルは会社（企業ID）で重複を除く。いまの段階（失注など）で、今月の商談・提案の実績を消さない
//   2. 有効企業・本命案件・診断・PC売上などは、0 にせず「定義未決／未計測／未接続」と理由を出す
//   3. 案件の表が無い・読めない環境では、商談・提案・契約・停滞を「取得できません」にする（会社の状態から推し量らない）
//   4. 停滞＝提案・最終調整の案件で、最後の動き（段階の記録・案件の更新・その会社の営業履歴）から7日以上。「今日の確認」にも1項目
//   5. 担当者別は社員IDで数える（氏名では数えない）。目標の人は employeeId か、表示名で1人に特定できたときだけ
//   6'. 金額は受注額（案件金額）だけ。粗利は出さない
//   6. 読み取りだけ（書き込みしない）・本文や連絡先・給与の列を選ばない
//   7. 目標の無い月は、目標の欄を出さない（実績だけ）
import assert from "node:assert/strict";
import { buildSales, readSalesFacts, stalledItem, overdueItem, STALL_DAYS } from "../lib/keiei-sales.js";
import { targetsOf, TARGETS } from "../lib/keiei-targets.js";
import { salesFacts, salesPeople, salesOct, OCT, hubOctober } from "./fixtures/keiei-hub.mjs";
const octTs = (day, hh = 3) => `2026-10-${String(day).padStart(2, "0")}T${String(hh).padStart(2, "0")}:00:00Z`;

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};
const stage = (s, key) => s.funnel.find((f) => f.key === key);

console.log("\n=== 今月の実績（全社） ===\n");

await ok("接触：主KPIは送信件数（120件）。重複を除いた企業数（100社）は補助値。送れなかったもの・先月の分は数えない", () => {
  const s = salesOct();
  assert.equal(stage(s, "contact").value, 120, "送信件数が主");
  assert.equal(stage(s, "contact").companies, 100, "企業数（重複を除く）は補助");
  assert.equal(stage(s, "contact").target, 4000); assert.equal(stage(s, "contact").unit, "件");
  assert.equal(stage(s, "contact").pct, 3, "達成率は送信件数 / 目標");
  assert.equal(stage(s, "meeting").companies, null, "補助の企業数は、接触だけが持つ");
});

await ok("提案の段階に、停滞件数（提案・最終調整のまま7日以上）を添える。読めなければ null", () => {
  assert.equal(stage(salesOct(), "proposal").stalledCount, 1);
  assert.equal(stage(salesOct(), "contact").stalledCount, undefined);
  const absent = salesOct({ ...salesFacts(), dealState: "absent", deals: null, history: null });
  assert.equal(stage(absent, "proposal").stalledCount, null);
});

await ok("商談・提案・有料契約・受注額（会社で重複を除く）", () => {
  const s = salesOct();
  assert.equal(stage(s, "meeting").value, 6, "今月案件ができた会社（cd1 の2件は1社・先月作った d2・d8 は数えない）");
  assert.equal(stage(s, "proposal").value, 4, "今月、提案以降に進んだ会社（cd3・cd4・cd5・cd10）");
  assert.equal(stage(s, "won").value, 1);
  assert.deepEqual(s.won, { companies: 1, deals: 1, amount: 480000 });
});

await ok("同じ会社に、今月2件の案件・2回の提案・2件の成約があっても、ファネルは1社", () => {
  const f = salesFacts();
  f.deals.push({ id: "d11", company_id: "cd5", owner_id: "p1", title: "2件目", stage: "won", amount: 120000, won_on: "2026-10-04", created_at: octTs(2), updated_at: octTs(4) });
  f.history.push({ id: "h11", deal_id: "d11", company_id: "cd5", stage: "proposal", changed_at: octTs(3) }, { id: "h12", deal_id: "d11", company_id: "cd5", stage: "won", changed_at: octTs(4) });
  const s = salesOct(f);
  assert.equal(stage(s, "meeting").value, 6); assert.equal(stage(s, "proposal").value, 4); assert.equal(stage(s, "won").value, 1);
  assert.deepEqual(s.won, { companies: 1, deals: 2, amount: 600000 }, "受注額は案件の金額の合計（2件）");
});

await ok("いまの段階で、今月の実績を消さない：提案のあと失注した会社も、今月の商談・提案に数える", () => {
  const f = salesFacts();
  const before = salesOct(f);
  f.deals = f.deals.map((d) => (d.id === "d3" ? { ...d, stage: "lost" } : d));
  const after = salesOct(f);
  assert.equal(stage(after, "meeting").value, stage(before, "meeting").value);
  assert.equal(stage(after, "proposal").value, stage(before, "proposal").value);
});

await ok("成約から段階を戻した案件も、今月成約した記録があれば有料契約に数える（会社で1回）", () => {
  const f = salesFacts();
  f.deals = f.deals.map((d) => (d.id === "d5" ? { ...d, stage: "negotiation", won_on: null } : d));
  assert.equal(stage(salesOct(f), "won").value, 1);
});

await ok("会社の今の状態（status）は、今月の実績に使わない（全部「成約」にしても、ファネルは変わらない）", () => {
  const f = salesFacts();
  const a = salesOct(f).funnel.map((x) => x.value);
  f.companies = f.companies.map((c) => ({ ...c, status: "won" }));
  assert.deepEqual(salesOct(f).funnel.map((x) => x.value), a);
});

await ok("日付は日本時間：10/1 0:30（日本時間）＝ 9/30 15:30（UTC）の送信は10月に数える。9/30 23:59（日本時間）は数えない", () => {
  const f = salesFacts();
  f.approaches = [
    { id: "x1", company_id: "cx1", employee_id: "p2", sent_at: "2026-09-30T15:30:00Z", failed_at: null },
    { id: "x2", company_id: "cx2", employee_id: "p2", sent_at: "2026-09-30T14:59:00Z", failed_at: null },
  ];
  assert.equal(stage(salesOct(f), "contact").value, 1);
});

await ok("今日の目安＝目標×経過日数／月の日数（10/5 は 5/31）", () => {
  const s = salesOct();
  assert.equal(s.dayNo, 5); assert.equal(s.daysInMonth, 31);
  assert.equal(stage(s, "contact").pace, Math.round((4000 * 5) / 31));
  assert.equal(stage(s, "meeting").pct, Math.round((6 / 30) * 100));
});

await ok("転換率：となりの段階が両方測れたときだけ（商談→提案 66.7%・提案→契約 25%）。計画値を並べる", () => {
  const r = Object.fromEntries(salesOct().rates.map((x) => [`${x.from}→${x.to}`, x]));
  assert.equal(r["商談→提案"].value, 66.7); assert.equal(r["商談→提案"].plan, 50);
  assert.equal(r["提案→有料契約"].value, 25); assert.equal(r["提案→有料契約"].plan, 67);
  assert.equal(r["有効企業→商談"].value, null, "有効企業は測れないので、率を作らない");
  assert.equal(r["接触→有効企業"].value, null);
});

console.log("\n=== 数えられないものを 0 にしない ===\n");

await ok("有効企業・本命案件は「定義未決」（値なし・理由あり）", () => {
  const s = salesOct();
  for (const k of ["effective", "key"]) {
    assert.equal(stage(s, k).value, null); assert.equal(stage(s, k).status, "undefined"); assert.ok(stage(s, k).reason.includes("定義未決"));
  }
});

await ok("PC/IT機器売上（1,000万円）は「未接続」。値を持たない", () => {
  const s = salesOct();
  assert.equal(s.pc.target, 10000000); assert.equal(s.pc.value, null); assert.ok(s.pc.reason.includes("未接続"));
  assert.deepEqual(s.unconnected.map((u) => u.key), ["ec", "space", "board"]);
});

await ok("案件の表が無い環境：商談・提案・契約・停滞は「取得できません」（理由つき）。接触は数える", () => {
  const f = { ...salesFacts(), dealState: "absent", deals: null, history: null };
  const s = salesOct(f);
  for (const k of ["meeting", "proposal", "won"]) {
    assert.equal(stage(s, k).value, null, k); assert.equal(stage(s, k).status, "missing"); assert.ok(stage(s, k).reason.includes("まだ使えません"), k);
  }
  assert.equal(stage(s, "contact").value, 120);
  assert.equal(s.stalled, null); assert.ok(s.stalledReason);
  assert.equal(s.won, null);
  assert.equal(stalledItem(s), null, "停滞を数えられないときは、今日の確認に出さない（0件とも言わない）");
});

await ok("案件を読めなかった（障害）：「読み込めませんでした」と出す", () => {
  const s = salesOct({ ...salesFacts(), dealState: "error", deals: null, history: null });
  assert.ok(stage(s, "meeting").reason.includes("読み込めませんでした"));
});

await ok("段階の履歴だけ読めない：提案だけ「取得できません」。商談・契約は数える", () => {
  const s = salesOct({ ...salesFacts(), history: null });
  assert.equal(stage(s, "proposal").value, null); assert.equal(stage(s, "meeting").value, 6); assert.equal(stage(s, "won").value, 1);
});

await ok("アタックを読めない：接触は「取得できません」", () => {
  const s = salesOct({ ...salesFacts(), approaches: null });
  assert.equal(stage(s, "contact").value, null); assert.equal(stage(s, "contact").status, "missing");
});

console.log("\n=== 停滞案件 ===\n");

await ok(`提案・最終調整の案件で、最後の動きから${STALL_DAYS}日以上（4日の最終調整・失注は数えない）`, () => {
  const s = salesOct();
  assert.equal(s.stalled.count, 1);
  assert.deepEqual(s.stalled.rows.map((r) => [r.id, r.idle, r.last, r.stage, r.owner, r.company]), [["d2", 10, "2026-09-25", "提案", "藤本 三郎", "テスト株式会社2"]]);
  assert.equal(s.stalled.rows[0].href, "/sales/companies.html?id=cd2");
});

await ok("最後の動きには、その会社の営業履歴（電話・返信など）も含める：案件の更新が古くても、最近の動きがあれば停滞にしない", () => {
  const f = salesFacts();
  assert.equal(salesOct(f).stalled.rows.some((r) => r.id === "d8"), false, "d8：案件の更新 9/20・営業履歴 10/2");
  f.lastEvent = f.lastEvent.filter((e) => e.company_id !== "cd8");
  const r = salesOct(f).stalled.rows.find((x) => x.id === "d8");
  assert.ok(r && r.idle === 15, "営業履歴が無ければ、案件の更新（9/20）から数える");
});

await ok("最後の動きには、段階の記録も含める（案件の更新日より新しい段階の変更があれば、そちらを使う）", () => {
  const f = salesFacts();
  f.lastStage.push({ id: "s9", deal_id: "d2", company_id: "cd2", stage: "proposal", changed_at: octTs(2) });
  assert.equal(salesOct(f).stalled.rows.some((r) => r.id === "d2"), false);
});

await ok("最後の動きの記録を読めなければ、停滞は「取得できません」（0件とは言わない）", () => {
  const s = salesOct({ ...salesFacts(), lastEvent: null });
  assert.equal(s.stalled, null); assert.ok(s.stalledReason.includes("読み込めませんでした"));
  assert.equal(stalledItem(s), null);
});

await ok("今日の確認に「提案後に止まっている案件」が1項目（重要の次・注意）。Sales へ", () => {
  const h = hubOctober();
  const i = h.attention.findIndex((x) => x.key === "sales_stalled");
  assert.ok(i > 0);
  assert.equal(h.attention[i].severity, "mid");
  assert.ok(h.attention.slice(0, i).every((x) => x.severity === "high"));
  assert.equal(h.attention[i].href, "/sales/");
  assert.equal(h.risks.some((x) => x.key === "sales_stalled"), false, "同じ事実をリスクには出さない");
});

await ok("停滞が0件なら、今日の確認に出さない", () => {
  const f = salesFacts(); f.deals = f.deals.map((d) => ({ ...d, updated_at: "2026-10-04T03:00:00Z" })); f.lastStage = []; f.lastEvent = [];
  const s = salesOct(f);
  assert.equal(s.stalled.count, 0); assert.equal(stalledItem(s), null);
});

console.log("\n=== 担当者別 ===\n");

await ok("担当者の実績：中村 接触90社・商談1社、藤本 提案2社・提案率67%（商談3社）、山内 有料化1、池永 全社の契約1・停滞1、野澤 タスク", () => {
  const p = Object.fromEntries(salesOct().perPerson.map((x) => [x.name, Object.fromEntries(x.kpis.map((k) => [k.label, k]))]));
  assert.equal(p["中村 次郎"]["接触"].value, 90); assert.equal(p["中村 次郎"]["接触"].note, "企業90社（重複を除く）"); assert.equal(p["中村 次郎"]["商談"].value, 1);
  assert.equal(p["藤本 三郎"]["提案"].value, 2); assert.equal(p["藤本 三郎"]["提案率"].value, 67); assert.equal(p["藤本 三郎"]["提案率"].note, "提案2社／商談3社");
  assert.equal(p["山内 太郎"]["有料化"].value, 1); assert.equal(p["山内 太郎"]["有料化"].done, true);
  assert.equal(p["池永 四郎"]["有料契約（全社）"].value, 1);
  assert.equal(p["池永 四郎"]["提案後7日超の停滞（全社）"].value, 1); assert.equal(p["池永 四郎"]["提案後7日超の停滞（全社）"].done, false);
  assert.equal(p["野澤 八郎"]["期限超過のタスク（全社）"].value, 1); assert.equal(p["野澤 八郎"]["担当不明のタスク（全社）"].value, 1);
});

await ok("数えられない KPI（診断・地域接点・PC売上・法人顧客 …）は値なし。短い言い方と理由がある", () => {
  for (const person of salesOct().perPerson) {
    for (const k of person.kpis.filter((x) => x.unmeasured)) {
      assert.equal(k.value, null); assert.ok(k.short && k.reason, `${person.name} ${k.label}`);
    }
  }
  const kudo = salesOct().perPerson.find((x) => x.name.startsWith("工藤")).kpis[0];
  assert.equal(kudo.short, "未接続"); assert.equal(kudo.target, 10000000);
});

await ok("名簿で1人に特定できない人（同じ姓が2人・いない）は、その人の分を数えない（全社の分は数える）", () => {
  const people = [...salesPeople(), { id: "p9", display_name: "中村 九郎", status: "active" }].filter((x) => !x.display_name.startsWith("池永"));
  const s = buildSales({ today: OCT, facts: salesFacts(), targets: targetsOf("2026-10"), people });
  const naka = s.perPerson.find((x) => x.name === "中村");
  assert.equal(naka.linked, false); assert.equal(naka.kpis[0].value, null); assert.ok(naka.kpis[0].reason.includes("特定できません"));
  const ike = s.perPerson.find((x) => x.name === "池永");
  assert.equal(ike.linked, false); assert.equal(ike.kpis[0].value, 1, "全社の有料契約は、本人を特定できなくても数える");
});

await ok("担当者別は社員IDで数える：表示名を変えても実績は同じ。目標に employeeId があれば、表示名が違っても（姓が無くても）その人", () => {
  const people = salesPeople().map((x) => (x.id === "p2" ? { ...x, display_name: "なかむら じろう" } : x));
  const t = structuredClone(targetsOf("2026-10"));
  t.people.find((x) => x.name === "中村").employeeId = "p2";
  const s = buildSales({ today: OCT, facts: salesFacts(), targets: t, people });
  const n = s.perPerson.find((x) => x.employeeId === "p2");
  assert.equal(n.linkedBy, "id"); assert.equal(n.kpis[0].value, 90);
  const byName = salesOct().perPerson.find((x) => x.name.startsWith("中村"));
  assert.equal(byName.linkedBy, "name"); assert.equal(byName.employeeId, "p2");
});

await ok("同じ姓の別人の実績を混ぜない（中村が2人いれば、どちらにも寄せない）", () => {
  const people = [...salesPeople(), { id: "p9", display_name: "中村 九郎", status: "active" }];
  const s = buildSales({ today: OCT, facts: salesFacts(), targets: targetsOf("2026-10"), people });
  assert.equal(s.perPerson.find((x) => x.name === "中村").linked, false);
});

await ok("退職した人は、担当者の特定に使わない", () => {
  const people = salesPeople().map((x) => (x.display_name.startsWith("中村") ? { ...x, status: "left" } : x));
  const s = buildSales({ today: OCT, facts: salesFacts(), targets: targetsOf("2026-10"), people });
  assert.equal(s.perPerson.find((x) => x.name === "中村").linked, false);
});

await ok("粗利は持たない・作らない（受注額＝案件金額だけ）", () => {
  const s = JSON.stringify(salesOct());
  assert.equal(/gross|margin|粗利額|粗利率/.test(s), false);
  assert.ok(salesOct().won.amount === 480000);
});

console.log("\n=== 目標の無い月・会社の今の状態 ===\n");

await ok("目標の無い月（2026-11）は目標・担当者別・PC を出さず、実績だけ数える", () => {
  const f = salesFacts();
  const s = buildSales({ today: "2026-11-05", facts: f, targets: targetsOf("2026-11"), people: salesPeople() });
  assert.equal(s.hasTargets, false); assert.equal(s.perPerson.length, 0); assert.equal(s.pc, null);
  assert.ok(s.funnel.every((x) => x.target === null));
  assert.equal(stage(s, "contact").value, 0, "11月の送信は無い（読めたうえでの0件）");
});

await ok("会社の今の状態：表示中の会社だけ（非表示は数えない）", () => {
  const f = salesFacts(); f.companies.push({ id: "hid", name: "非表示", status: "attacked", owner_id: null, hidden_at: "2026-10-01T00:00:00Z" });
  const snap = Object.fromEntries(salesOct(f).snapshot.map((x) => [x.key, x.count]));
  assert.equal(snap.attacked, 30); assert.equal(snap.clicked, 10); assert.equal(snap.meeting, 6);
});

await ok("目標は10月だけ（コード内の一時設定）。ファネルの目標は 4,000 → 100 → 30 → 15 → 10 → 3", () => {
  assert.deepEqual(Object.keys(TARGETS), ["2026-10"]);
  assert.deepEqual(TARGETS["2026-10"].funnel.map((x) => x.target), [4000, 100, 30, 15, 10, 3]);
});

console.log("\n=== 読み取りだけ・選ぶ列 ===\n");

function fakeDb({ dealsAbsent = false, fail = [] } = {}) {
  const writes = [], selects = {};
  const from = (name) => {
    const q = {
      select(cols) { (selects[name] ||= []).push(String(cols)); return q; },
      insert() { writes.push(name); return q; }, update() { writes.push(name); return q; }, delete() { writes.push(name); return q; }, upsert() { writes.push(name); return q; },
      eq() { return q; }, in() { return q; }, gte() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
      then(fn, rej) {
        const absent = dealsAbsent && name.startsWith("gw_sales_deal");
        const err = absent ? { code: "PGRST205", message: "no table" } : fail.includes(name) ? { code: "XX000", message: "boom" } : null;
        return Promise.resolve({ data: err ? null : [], error: err }).then(fn, rej);
      },
    };
    return q;
  };
  return { sb: { from }, writes, selects };
}

await ok("書き込まない。本文・連絡先・メモ・給与の列を選ばない", async () => {
  const d = fakeDb();
  const f = await readSalesFacts(d.sb, { tenantId: "t1" }, { today: OCT });
  assert.equal(d.writes.length, 0);
  assert.equal(f.dealState, "ok");
  for (const [t, cols] of Object.entries(d.selects)) {
    for (const c of cols) assert.ok(!/body|note|email|phone|contact|memo|wage|salary|unit_price|detail/.test(c), `${t}: ${c}`);
  }
  assert.ok(!Object.keys(d.selects).some((t) => /contract|compens|pay/.test(t)), Object.keys(d.selects).join());
});

await ok("案件の表が無い（db/116 未適用）：dealState absent。障害なら error", async () => {
  assert.equal((await readSalesFacts(fakeDb({ dealsAbsent: true }).sb, { tenantId: "t1" }, { today: OCT })).dealState, "absent");
  assert.equal((await readSalesFacts(fakeDb({ fail: ["gw_sales_deals"] }).sb, { tenantId: "t1" }, { today: OCT })).dealState, "error");
});

console.log("\n=== 経営UIの刷新で足した集計（遅れ／順調・次に見るもの・転換率・期限超過タスク） ===\n");

const person = (s, name) => s.perPerson.find((p) => p.name.startsWith(name));

await ok("担当者の状態：目安に届いていない項目があれば「遅れ」、すべて届いていれば「順調」、測れた項目が無ければ「未計測」", () => {
  const s = salesOct();   // 10/5（31日中5日目）
  assert.equal(person(s, "中村").state.key, "behind", "接触 90件は目安 323件（2,000×5/31）に届いていない");
  assert.equal(person(s, "山内").state.key, "ontrack", "有料化 1社は目標 1社に届いている（地域接点・診断は数えられないので比べない）");
  assert.equal(person(s, "工藤").state.key, "unmeasured", "PC売上・法人顧客・診断送客は、まだ数えられない");
  assert.equal(person(s, "今福").state.key, "unmeasured");
  assert.equal(person(s, "野澤").state.key, "behind", "期限超過のタスク 1件は目標 0件を超えている（少ないほどよい項目）");
});

await ok("KPI に今日の目安（pace）と、目安に届いているか（onPace）を持つ。%・少ないほどよい項目は目安を持たない", () => {
  const s = salesOct();
  const contact = person(s, "中村").kpis.find((k) => k.label === "接触");
  assert.equal(contact.pace, 323); assert.equal(contact.onPace, false);
  const rate = person(s, "藤本").kpis.find((k) => k.label === "提案率");
  assert.equal(rate.pace, null, "% は目安を持たず、目標そのものと比べる");
  assert.equal(rate.onPace, true, "提案率 67% は目標 50% 以上");
  const overdue = person(s, "野澤").kpis.find((k) => k.label.startsWith("期限超過"));
  assert.equal(overdue.pace, null); assert.equal(overdue.onPace, false);
  const missing = person(s, "工藤").kpis.find((k) => k.label.startsWith("PC/IT"));
  assert.equal(missing.onPace, null, "数えられない項目は、遅れとも順調とも言わない");
});

await ok("次に見るもの：遅れている項目を先に。無ければ、まだ数えられない項目（理由のことば）。どちらも無ければ null", () => {
  const s = salesOct();
  assert.equal(person(s, "中村").next.kind, "behind");
  assert.match(person(s, "中村").next.text, /接触 90件／目安 323件/);
  assert.match(person(s, "野澤").next.text, /目標 0件以下/, "少ないほどよい項目は「目標 0件以下」と出す（「目安 目標」と重ねない）");
  assert.equal(person(s, "工藤").next.kind, "unmeasured");
  assert.match(person(s, "工藤").next.text, /未接続|定義未決|記録なし/);
  assert.equal(person(s, "山内").next.kind, "unmeasured", "山内は数えられる項目（有料化）が順調で、地域接点・診断が未計測");
});

await ok("営業の流れ（接触→商談→提案→有料契約）の転換率。計画は目標どうしの比（有効企業を飛ばして比べる）", () => {
  const s = salesOct();
  assert.deepEqual(s.flow.map((r) => [r.from, r.to]), [["接触", "商談"], ["商談", "提案"], ["提案", "有料契約"]]);
  const f = Object.fromEntries(s.flow.map((r) => [r.toKey, r]));
  assert.equal(f.meeting.value, 6, "接触→商談は、同じ単位（社）どうし：商談6社 / 接触の企業100社"); assert.equal(f.meeting.plan, 0.8, "30 / 4,000 = 0.75% → 0.8%");
  assert.equal(f.proposal.value, 66.7); assert.equal(f.proposal.plan, 50);
  assert.equal(f.won.value, 25); assert.equal(f.won.plan, 66.7);
});

await ok("案件の表が無い環境：転換率は出さない（null）。推し量らない", () => {
  const s = buildSales({ today: OCT, facts: { ...salesFacts(), dealState: "absent", deals: null, history: null, lastStage: null, lastEvent: null }, targets: targetsOf("2026-10"), people: salesPeople() });
  const f = Object.fromEntries(s.flow.map((r) => [r.toKey, r]));
  assert.equal(f.meeting.value, null); assert.equal(f.proposal.value, null); assert.equal(f.won.value, null);
});

await ok("期限超過のタスク：全社の件数を持ち、「今日の確認」に1項目。読めなければ項目を出さない（0 にしない）", () => {
  const s = salesOct();
  assert.equal(s.overdueTasks, 1, "t1 だけが期限（10/1）を過ぎた未完了");
  const item = overdueItem(s);
  assert.equal(item.key, "tasks_overdue"); assert.equal(item.block, "today"); assert.equal(item.severity, "mid"); assert.equal(item.count, 1);
  assert.equal(item.href, "/admin-tasks.html");
  const none = buildSales({ today: OCT, facts: { ...salesFacts(), tasks: null }, targets: targetsOf("2026-10"), people: salesPeople() });
  assert.equal(none.overdueTasks, null); assert.equal(overdueItem(none), null);
  assert.equal(overdueItem(buildSales({ today: OCT, facts: { ...salesFacts(), tasks: [] }, targets: targetsOf("2026-10"), people: salesPeople() })), null, "0件のときは出さない");
});

await ok("ホームの「今日の確認」：重要の次に、停滞案件 → 期限超過タスクの順で入る", () => {
  const h = hubOctober();
  const keys = h.attention.map((i) => i.key);
  const stall = keys.indexOf("sales_stalled"), late = keys.indexOf("tasks_overdue");
  assert.ok(stall >= 0 && late > stall, keys.join());
  assert.ok(h.attention.slice(0, stall).every((i) => i.severity === "high"), "重要が先");
});

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
