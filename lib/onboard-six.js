// 入社準備の6ステップ。既存の判定を、決めた6つの並びに「並べ替える」だけの写像。
//
//   ① 入社案内確認  ② 雇用契約  ③ 入社情報入力  ④ 必要書類提出  ⑤ 会社確認  ⑥ 入社準備完了
//
// 経営者の一覧（/keiei 入社準備）と、本人の画面（/onboarding/）が、この1つの関数を使う。
// 見せる言い方（audience）だけが違い、どのステップが済んでいて、いまどこで止まっているかは同じ。
//
// ■ 4つ目の判定を作らない
//
//   入社の進み具合を決める場所は、すでにある。
//     ・手続きの段階   lib/onboard-stage.js  computeStage（一覧・通知・採用〜育成の流れが使う）
//     ・キャリア       lib/career.js         careerStatus（入社が終わったあとの次の一手）
//   ここは、その結果と「事実の読み取り（stageFlags）」だけを見て、6ステップに並べる。
//   「署名が済んだか」「書類の残りは何件か」を、ここで数え直さない。
//   （lib/onboard-steps.js の6STEPは、本人・社労士・管理者が同じ並びで見る既存の画面 onboarding.html の並べ方。
//    どちらも同じ段階・同じ事実から出す）
//
// ■ 写像
//
//   ① 入社案内確認 … 経営者が発行した入社案内（gw_onboarding_guides）を、本人が確認したか。
//                     案内が発行されていなければ「対象外」（数えない・ほかを止めない）。
//                     この事実は、既存の判定には無かったので、表を1つ足した（db/104）
//   ② 雇用契約     … 段階 conditions / advisor_review / signing。締結（＋誓約書の同意）が済めば完了
//   ③ 入社情報入力 … 段階 intake の、入社情報の提出
//   ④ 必要書類提出 … 段階 intake の、必須書類とオリエンテーションの確認
//   ⑤ 会社確認     … 段階 intake の、社内の準備（チェックリストの社内項目）。本人の作業と並行して進む
//   ⑥ 入社準備完了 … 手続きの段階が complete で、案内が発行されていれば確認済みのとき（導出）
//
//   キャリア設計は、ステップには入れない。入社準備が終わったあとの「次の一手」（after）として添える。
//
// ■ 出さないもの
//
//   給与・時給・手当の金額と、給与入りの書面の中身は、ここに入れない（状態だけ）。
//   入力は「事実を集める側」が渡す。ここは表も読まない純粋関数（test/onboardsix.mjs）
//
// ■ 決めてよい範囲
//
//   AI が日付・条件・期限を作ることはしない。ここに出す言葉は、既存の段階の blockers と件数だけ。

import { computeStage, stageFlags } from "./onboard-stage.js";
import { careerStatus } from "./career.js";

export const SIX_STEPS = [
  { key: "guide",    n: 1, label: "入社案内確認", short: "案内", icon: "campaign" },
  { key: "contract", n: 2, label: "雇用契約",     short: "契約", icon: "history_edu" },
  { key: "info",     n: 3, label: "入社情報入力", short: "情報", icon: "edit_note" },
  { key: "docs",     n: 4, label: "必要書類提出", short: "書類", icon: "upload_file" },
  { key: "company",  n: 5, label: "会社確認",     short: "会社", icon: "domain_verification" },
  { key: "complete", n: 6, label: "入社準備完了", short: "完了", icon: "task_alt" },
];
export const SIX_KEYS = SIX_STEPS.map((s) => s.key);

/** 誰の番か。管理者（admin）は、この画面では経営者と呼ぶ。本人には、会社側をまとめて「会社」と呼ぶ */
export const SIX_ACTORS = { owner: "経営者", advisor: "社労士", employee: "本人", hr: "人事", manager: "上長" };
const SELF_ACTORS = { owner: "会社", advisor: "社労士", employee: "あなた", hr: "会社", manager: "会社" };

const ACTOR_OF_STAGE = { admin: "owner", advisor: "advisor", employee: "employee" };

/**
 * step の状態
 *   done      済み
 *   current   いま動く番（actor が誰か）
 *   todo      まだ前が終わっていない
 *   na        対象外（案内が発行されていない）。数えない・ほかを止めない
 *   unlinked  「データ未連携」（表が読めない）。数えない
 */
export const SIX_STATES = ["done", "current", "todo", "na", "unlinked"];

const step = (key, extra) => {
  const def = SIX_STEPS.find((s) => s.key === key);
  return { key, n: def.n, label: def.label, short: def.short, icon: def.icon, actor: null, actorLabel: null,
    note: "", detail: [], ...extra };
};

const slash = (d) => (d ? String(d).slice(0, 10).replace(/-/g, "/") : "");

/**
 * @param {object} p
 *   facts        gatherFacts / gatherFactsBulk の結果 | null（読めなかった）
 *   guide        入社案内の状態 | null（案内が無い）
 *                { status: "draft"|"issued", version:number, confirmedVersion:number|null, confirmedAt:string|null }
 *   guideLinked  false のとき、案内の表が読めなかった（「データ未連携」）。既定は読めた
 *   career       gw_employee_careers の行（active）| null
 *   careerLinked false のとき、キャリアの表が読めなかった。既定は読めた
 *   audience     "company"（経営者の一覧。既定）| "self"（本人の画面）。言い方だけが変わる
 * @returns {{
 *   steps: object[], stage: string|null, current: string|null, done: number, total: number,
 *   next: { key:string|null, label:string, detail:string, actor:string|null, actorLabel:string|null, tone:string },
 *   needsCompany: boolean, waitingOn: string[], complete: boolean,
 *   after: { key:string, label:string, actor:string|null, actorLabel:string|null, state:string }|null
 * }}
 */
export function mapSix(p = {}) {
  const self = p.audience === "self";
  const who = self ? SELF_ACTORS : SIX_ACTORS;
  const actorLabel = (a) => (a ? who[a] || null : null);
  const facts = p.facts || null;

  // 事実が読めていないときは、手続き本体の段階（stage 列）に頼らず「データ未連携」にする
  const x = facts ? stageFlags(facts) : null;
  const stage = facts ? computeStage(facts) : null;
  const at = stage?.key || null;
  const atIntake = at === "intake";
  const atDone = at === "complete";
  const cantRead = "入社手続きの事実が読めません";

  // ---- ① 入社案内確認 ----
  const g = p.guide || null;
  const issued = Boolean(g && g.status === "issued");
  const confirmed = Boolean(issued && g.confirmedVersion != null && g.confirmedVersion >= g.version);
  let guide;
  if (p.guideLinked === false) {
    guide = step("guide", { state: "unlinked", note: "入社案内の表が読めません" });
  } else if (!issued) {
    guide = step("guide", { state: "na", note: g
      ? (self ? "入社案内は準備中です" : "下書きです（まだ発行していません）")
      : (self ? "入社案内はまだ届いていません" : "案内は未作成です") });
  } else if (confirmed) {
    guide = step("guide", { state: "done", note: `確認済み（${slash(g.confirmedAt) || "日付なし"}）` });
  } else {
    guide = step("guide", { state: "current", actor: "employee", actorLabel: actorLabel("employee"),
      note: self ? "入社案内を確認してください" : "本人の確認待ちです" });
  }

  // ---- ② 雇用契約 ----
  let contract;
  if (!facts) {
    contract = step("contract", { state: "unlinked", note: cantRead });
  } else if (atIntake || atDone) {
    contract = step("contract", { state: "done", note: x.closed ? "手続きを完了にしています" : "締結済み" });
  } else {
    const actor = ACTOR_OF_STAGE[stage.nextActors?.[0]] || "owner";
    const own = {
      conditions: "会社が労働条件通知書を準備しています",
      advisor_review: "社労士が労働条件通知書を確認しています",
      signing: "労働条件通知書と誓約書を確認して、締結してください",
    };
    contract = step("contract", {
      state: "current", actor, actorLabel: actorLabel(actor),
      note: self ? (own[at] || "") : (stage.blockers?.[0] || ""),
      detail: self ? [] : (stage.blockers || []),
      stage: at,
    });
  }

  // ---- ③ 入社情報入力 / ④ 必要書類提出 / ⑤ 会社確認 ----
  let info, docs, company;
  if (!facts) {
    info = step("info", { state: "unlinked", note: cantRead });
    docs = step("docs", { state: "unlinked", note: cantRead });
    company = step("company", { state: "unlinked", note: cantRead });
  } else if (atDone) {
    info = step("info", { state: "done", note: "提出済み" });
    docs = step("docs", { state: "done", note: "提出済み" });
    company = step("company", { state: "done", note: "準備済み" });
  } else if (!atIntake) {
    // 署名が済むまで、入社情報の入力には進めない（lib/onboard-gate.js）
    const after = "契約の締結後に始まります";
    info = step("info", { state: "todo", note: after });
    docs = step("docs", { state: "todo", note: after });
    company = step("company", { state: "todo", note: self ? after
      : x.internalOpen ? `社内準備 ${x.internalOpen} 件（契約の締結後に確認します）` : after });
  } else {
    info = x.profileSubmitted
      ? step("info", { state: "done", note: "提出済み" })
      : step("info", { state: "current", actor: "employee", actorLabel: actorLabel("employee"),
          note: "入社情報の入力がまだです", detail: ["入社情報の入力がまだです"] });

    const open = [];
    if (x.employeeOpen) open.push(`書類の提出が ${x.employeeOpen} 件残っています`);
    if (!x.orientationOk) open.push("オリエンテーションの確認がまだです");
    docs = open.length
      ? step("docs", { state: "current", actor: "employee", actorLabel: actorLabel("employee"), note: open[0], detail: open })
      : step("docs", { state: "done", note: "提出済み" });

    // 本人には、社内準備の内訳（PC・アカウントなど）を出さない。「会社が確認しています」だけ
    company = x.internalOpen
      ? step("company", { state: "current", actor: "owner", actorLabel: actorLabel("owner"),
          note: self ? "会社が準備・確認しています" : `社内準備が ${x.internalOpen} 件残っています`,
          detail: self ? [] : [`社内準備が ${x.internalOpen} 件残っています`] })
      : step("company", { state: "done", note: "準備済み" });
  }

  // ---- ⑥ 入社準備完了（導出）----
  const others = [guide, contract, info, docs, company];
  const readable = others.every((s) => s.state !== "unlinked" || s.key === "guide");
  // 案内は「対象外」「データ未連携」なら止めない。発行されていれば、確認が済むまで完了にしない
  const guideOk = guide.state !== "current";
  const doneAll = facts && readable && atDone && guideOk;
  const complete = step("complete", doneAll
    ? { state: "done", note: self ? "入社準備は完了しました" : "入社準備は完了しました" }
    : !facts || !readable
      ? { state: "unlinked", note: "上のステップの事実が読めないため、判定できません" }
      : { state: "todo", note: self ? "①〜⑤ が終わると完了になります" : "①〜⑤ がそろうと完了になります" });

  const steps = [guide, contract, info, docs, company, complete];

  // ---- 次に何をするか（完了率より、これを優先して出す）----
  const currents = steps.filter((s) => s.n <= 5 && s.state === "current");
  // 本人の画面では、本人の番を先に。経営者の一覧では、並びの先頭
  const cur = (self ? currents.find((s) => s.actor === "employee") : null) || currents[0] || null;
  const isDone = complete.state === "done";
  let next;
  if (isDone) {
    next = { key: null, label: "入社準備完了", detail: "すべての準備が終わりました", actor: null, actorLabel: null, tone: "green" };
  } else if (!cur) {
    const label = !readable ? "データ未連携" : "前のステップの完了待ち";
    next = { key: null, label, detail: "", actor: null, actorLabel: null, tone: "gray" };
  } else {
    next = { key: cur.key, label: nextLabel(cur, at, self), detail: cur.note, actor: cur.actor, actorLabel: cur.actorLabel,
      tone: ["owner", "hr", "manager"].includes(cur.actor) ? "red" : "yellow" };
  }

  // ---- 入社準備が終わったあとの次の一手（キャリア。ステップには入れない）----
  let after = null;
  if (isDone && p.careerLinked !== false) {
    const ks = careerStatus({ career: p.career || null });
    if (!ks.ok) {
      const confirming = ks.key === "confirming";
      after = { key: "career", label: confirming ? "キャリアの本人確認待ち" : "キャリア設定待ち",
        actor: confirming ? "employee" : "manager", actorLabel: actorLabel(confirming ? "employee" : "manager"), state: ks.key };
    } else {
      after = { key: "career", label: ks.label, actor: null, actorLabel: null, state: ks.key };
    }
  }

  const counted = steps.filter((s) => !["unlinked", "na"].includes(s.state));
  return {
    steps, stage: at, current: cur?.key || null,
    done: counted.filter((s) => s.state === "done").length, total: counted.length,
    next,
    // 経営者・人事・上長が動く番のステップがあるか（一覧の「要対応」）。本人・社労士の番と重なってよい
    needsCompany: currents.some((s) => ["owner", "hr", "manager"].includes(s.actor))
      || Boolean(after && ["manager"].includes(after.actor)),
    waitingOn: [...new Set(currents.filter((s) => s.actor).map((s) => s.actor))],
    complete: isDone,
    after,
  };
}

/** 一覧・本人の「状態」に出す1行。誰の番かが先に分かる言い方にする */
function nextLabel(cur, at, self) {
  if (cur.key === "guide") return self ? "入社案内の確認" : "入社案内の確認待ち（本人）";
  if (cur.key === "contract") {
    if (at === "conditions") return self ? "会社が労働条件を準備中" : "労働条件の作成依頼待ち";
    if (at === "advisor_review") return self ? "社労士が確認中" : "社労士の確認待ち";
    return self ? "労働条件通知書の締結" : "契約の署名待ち";
  }
  if (cur.key === "info") return self ? "入社情報の入力" : "本人の入力待ち";
  if (cur.key === "docs") return self ? "必要書類の提出" : "本人の書類待ち";
  if (cur.key === "company") return self ? "会社が確認中" : "社内準備中";
  return cur.note || "";
}

/**
 * 一覧の上に出す数。「いま誰の番のステップがあるか」で数える。
 * 本人の番と会社の番が同時にある人（本人の書類待ち＋社内準備）は、両方に入る
 * （足すと人数になる数ではない。lib/onboard-stage.js kpiOf と同じ考え方）
 */
export function summarizeSix(rows) {
  const list = (rows || []).filter((r) => r.six);
  const has = (r, a) => r.six.waitingOn.includes(a);
  return {
    total: list.length,
    inProgress: list.filter((r) => !r.six.complete).length,
    company: list.filter((r) => !r.six.complete && r.six.needsCompany).length,
    employee: list.filter((r) => !r.six.complete && has(r, "employee")).length,
    advisor: list.filter((r) => !r.six.complete && has(r, "advisor")).length,
    complete: list.filter((r) => r.six.complete).length,
  };
}
