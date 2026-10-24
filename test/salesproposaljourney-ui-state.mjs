// No-browser UI state regression: run even where Chromium cannot launch.
import vm from "node:vm";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const requests = [], elements = new Map();
const node = () => ({ innerHTML:"", attrs:{}, handlers:{}, addEventListener(k,f) { this.handlers[k]=f; }, setAttribute(k,v) { this.attrs[k]=v; }, removeAttribute(k) { delete this.attrs[k]; } });
const root = node();
root.contains = () => true;
root.querySelector = (s) => {
  if (s === ".pj-records") return null;
  if (!elements.has(s)) elements.set(s,node());
  return elements.get(s);
};
const window = {};
const context = { window, document:{ getElementById:()=>root },
  API:{ api:(url)=>new Promise((resolve,reject)=>requests.push({url,resolve,reject})) },
  Intl, Date, Number, String, Array, Math, Object, encodeURIComponent };
vm.createContext(context);
// グラフの部品を先に読む（画面と同じ順番）
vm.runInContext(readFileSync(new URL("../js/sales-analytics-charts.js",import.meta.url),"utf8"), context);
vm.runInContext(readFileSync(new URL("../js/sales-proposal-journey.js",import.meta.url),"utf8"), context);
const turn = () => new Promise((r)=>setImmediate(r));
const fixture = { since:"2026-10-01", until:"2026-10-23T11:00:00Z", counts:{sent:10,held:2,accepted:1}, rates:{heldFromSent:20}, coverage:{acceptedUnknown:9}, rows:[{id:"p1",title:'<img onerror="bad">',companyName:"A",sentAt:"2026-10-02",acceptedEvidence:"snapshot"}] };
window.SalesProposalJourney.show();
assert.equal(requests[0].url,"/api/sales/proposals/journey?days=30");
fixture.bottlenecks={awaitingHeld:4,awaitingHeldMedianDays:3,awaitingAcceptedEvidence:1,heldMedianDays:2,heldMeasured:2};
fixture.byCurrentOwner=[{ownerName:"<b>担当</b>",sent:5,held:2,heldRate:40,heldMedianDays:2,heldMeasured:2,accepted:1,acceptedUnknown:4}];
fixture.byCompany=[{companyName:"<script>企業</script>",sent:5,held:2,accepted:1,acceptedUnknown:4,lost:1,identityMissing:true,reasons:[{label:"<img>理由",count:1}],unknownReason:1,collectionCounts:{not_asked:1,no_answer:0,vague:0,specific:0,unclassified:0}}];
fixture.rows[0].closeReason="client_declined"; fixture.rows[0].closeNote="<script>補足</script>";
fixture.byCurrentOwner.push(...["e1", "e2"].map(ownerId=>({ownerId,ownerName:"同名担当",sent:1})));
fixture.byCompany.push(...["sales:x", "sales:y", "proposal:missing-one", "proposal:missing-two"].map(companyKey=>({companyKey,companyName:"同名企業",sent:1,identityMissing:companyKey.startsWith("proposal:")})));
fixture.rows.push({id:"p-e1",ownerId:"e1",ownerName:"同名担当",companyKey:"sales:x",companyName:"同名企業"},
 {id:"p-e2",ownerId:"e2",ownerName:"同名担当",companyKey:"sales:y",companyName:"同名企業"});
fixture.rows.push({id:"placeholder",lost:true,closeReason:"other",reasonCollectionStatus:"specific",reasonCategoryUnrecorded:true});
requests[0].resolve(fixture); await turn();
const output = elements.get("#pj-content");
assert.match(output.innerHTML,/&lt;img/);
assert.doesNotMatch(output.innerHTML,/<img/);
assert.match(output.innerHTML,/証拠あり・日付未確認/);
assert.match(output.innerHTML,/面談→合格：—/);
// タブを開いた時点でグラフ（7段の棒）が出る。カードの並びではない
assert.equal((output.innerHTML.match(/data-chart-key="/g) || []).length, 7, "7段の棒");
assert.match(output.innerHTML,/前の段を通った件数ではありません/);
assert.match(output.innerHTML,/段と段の割合（面談→合格率など）は出さず/);
assert.doesNotMatch(output.innerHTML,/コホート|母数/,"専門用語を使わない");
assert.match(output.innerHTML,/担当者別（期間内に送信した提案）/);
assert.match(output.innerHTML,/対象期間：.*集計対象：期間内に送信した提案 \d+件 ／ 記録不足：合格の証拠が未確認/);
assert.equal(output.attrs["data-state"],"ready");
// 棒を押すと、その段の記録がある提案だけを根拠の表に出す
const fakeTarget = (key) => ({ closest(sel){ return sel === "[data-chart-key]" ? { dataset:{ chartKey:key } } : null; } });
root.handlers.click({ target: fakeTarget("accepted") });
assert.match(output.innerHTML,/絞り込み中：<strong>ENGER合格<\/strong>の記録がある提案（1件）/);
assert.match(output.innerHTML,/ENGER合格の記録がある 1件 \/ 全4件/);
assert.match(output.innerHTML,/class="sc-row sc-on"[^>]*data-chart-key="accepted"/);
root.handlers.click({ target: { closest(sel){ return sel === "[data-pj-clear]" ? {} : null; } } });
assert.doesNotMatch(output.innerHTML,/絞り込み中/);
// 一度読めたら、タブを離れて戻っても取り直さない
window.SalesProposalJourney.show();
assert.equal(requests.length,1,"タブに戻っても再取得しない");
assert.match(output.innerHTML,/&lt;b&gt;担当&lt;\/b&gt;（参考）/);
assert.match(output.innerHTML,/実際の停滞を意味しません/);
assert.match(output.innerHTML,/実際に操作した人の成果評価ではなく/);
assert.match(output.innerHTML,/企業IDなし・名寄せ未実施/);
assert.match(output.innerHTML,/&lt;img&gt;理由/);
assert.match(output.innerHTML,/&lt;script&gt;補足&lt;\/script&gt;/);
assert.match(output.innerHTML,/連絡停止・無回答クローズを不合格に含めません/);
assert.match(output.innerHTML,/情報取得状態と失注理由は別/);
assert.match(output.innerHTML,/まだ聞いてない：1件/);
assert.match(output.innerHTML,/再確認可否の検討/);
assert.match(output.innerHTML,/情報取得状態の対象外/);
assert.match(output.innerHTML,/理由カテゴリー未記録（互換保存のその他は分類しません）/);
assert.match(output.innerHTML,/記録された見送り理由（真因未検証）/);
assert.match(output.innerHTML,/相手が説明した理由・確認できた事実・担当者の仮説を、現データでは区分できません/);
assert.match(output.innerHTML,/相手の発言の原文や事実だとは断定しません/);
assert.match(output.innerHTML,/理由未入力：1件/);
assert.doesNotMatch(output.innerHTML,/理由未確認：/);
for (const id of ["e1", "e2"]) {
  assert.ok(output.innerHTML.includes(`担当ID：${id}</small>`));
  assert.ok(output.innerHTML.includes(`現在担当ID：${id}</small>`));
}
for (const key of ["sales:x", "sales:y"]) assert.ok(output.innerHTML.includes(`企業集計キー：${key}</small>`));
for (const key of ["proposal:missing-one", "proposal:missing-two"]) assert.ok(output.innerHTML.includes(`提案別集計キー：${key}</small>`));
assert.ok(output.innerHTML.includes('提案ID：p-e1</small>'));
assert.ok(output.innerHTML.includes('提案ID：p-e2</small>'));

elements.get("#pj-days").handlers.change({target:{value:"7"}});
elements.get("#pj-days").handlers.change({target:{value:"1"}});
requests[2].resolve({...fixture,counts:{sent:3}}); await turn();
const current = output.innerHTML;
requests[1].resolve(fixture); await turn();
assert.equal(output.innerHTML,current);
assert.equal(requests[2].url,"/api/sales/proposals/journey?days=1");
elements.get("#pj-refresh").handlers.click();
requests[3].reject(new Error("<script>no</script>")); await turn();
assert.match(output.innerHTML,/0件ではありません/);
assert.doesNotMatch(output.innerHTML,/<script>/);
assert.equal(output.attrs["aria-busy"],undefined);
assert.equal(output.attrs["data-state"],"error");
assert.match(output.innerHTML,/data-pj-retry/);
// 失敗していたら、タブに戻ったときに取り直す
window.SalesProposalJourney.show();
assert.equal(requests.length,5);
const notReady = Object.assign(new Error("db/138 を適用してください"), { code:"not_ready", status:503 });
requests[4].reject(notReady); await turn();
assert.equal(output.attrs["data-state"],"not-ready");
assert.match(output.innerHTML,/未設定/);
assert.match(output.innerHTML,/0件ではありません/);
assert.doesNotMatch(output.innerHTML,/data-chart-key/);
root.handlers.click({ target: { closest(sel){ return sel === "[data-pj-retry]" ? {} : null; } } });
assert.equal(requests.length,6,"再試行で取り直す");
requests[5].resolve({ ...fixture, rows:[], counts:{ sent:0, adjusted:0, scheduled:0, held:0, accepted:0, won:0, working:0 }, coverage:{ acceptedUnknown:0 } }); await turn();
assert.equal(output.attrs["data-state"],"empty");
assert.match(output.innerHTML,/取得できました：この期間に送信した提案は0件です/);
assert.doesNotMatch(output.innerHTML,/data-chart-key/,"0件では空の棒を描かない");
console.log("PASS proposal journey UI state: chart on open, stage filter, no refetch on return, evidence, escaping, stale response, error / not-ready / empty states");
