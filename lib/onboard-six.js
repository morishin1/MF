// 入社準備の6ステップ。既存の判定を、経営者が見る並びに「並べ替える」だけの写像。
//
//   ① 入社案内  ② 労働条件・契約  ③ 本人情報・必要書類  ④ アカウント準備  ⑤ キャリア設計  ⑥ 最終確認
//
// ■ 4つ目の判定を作らない
//
//   入社の進み具合を決める場所は、すでに2つある。
//     ・手続きの段階   lib/onboard-stage.js  computeStage（管理者の5段階。一覧・通知・採用〜育成の流れが使う）
//     ・契約とキャリア lib/career.js         careerStatus（キャリアの本人確認まで）
//   ここは、その結果と「事実の読み取り（stageFlags）」だけを見て、6ステップに並べる。
//   「署名が済んだか」「書類の残りは何件か」を、ここで数え直さない。
//   （本人の画面の6STEP lib/onboard-steps.js は、本人・社労士・管理者の3者が同じ並びで見るための別の並べ方。
//    こちらは /keiei 用。どちらも同じ段階・同じ事実から出す）
//
// ■ 写像
//
//   ① 入社案内         … 案内を作る・送る・本人が確認した、を持つ表がまだ無い → 「データ未連携」（進み具合に数えない）
//   ② 労働条件・契約    … 段階 conditions / advisor_review / signing。締結（＋誓約書の同意）が済めば完了
//   ③ 本人情報・必要書類 … 段階 intake の、本人の作業（入社情報の提出・書類・オリエンテーション）
//   ④ アカウント準備    … 段階 intake の、社内の作業（チェックリストの社内項目）。本人の作業と並行して進む
//   ⑤ キャリア設計      … careerStatus（未設定 / 本人確認待ち / 設定済み）。入社手続きとは独立した事実
//   ⑥ 最終確認         … ②〜⑤ がそろい、手続きの段階が complete のとき（導出。別に「確認した」を持たない）
//
// ■ 出さないもの
//
//   給与・時給・手当の金額と、給与入りの書面の中身は、ここに入れない（状態だけ）。
//   入力は「事実を集める側」（api/keiei）が渡す。ここは表も読まない純粋関数（test/onboardsix.mjs）
//
// ■ 決めてよい範囲
//
//   AI が日付・条件・期限を作ることはしない。ここに出す言葉は、既存の段階の blockers と件数だけ。

import { computeStage, stageFlags } from "./onboard-stage.js";
import { careerStatus } from "./career.js";

export const SIX_STEPS = [
  { key: "guide",     n: 1, label: "入社案内",           short: "案内",   icon: "campaign" },
  { key: "contract",  n: 2, label: "労働条件・契約",     short: "契約",   icon: "history_edu" },
  { key: "info_docs", n: 3, label: "本人情報・必要書類", short: "書類",   icon: "upload_file" },
  { key: "account",   n: 4, label: "アカウント準備",     short: "Account", icon: "manage_accounts" },
  { key: "career",    n: 5, label: "キャリア設計",       short: "Career", icon: "route" },
  { key: "final",     n: 6, label: "最終確認",           short: "確認",   icon: "task_alt" },
];
export const SIX_KEYS = SIX_STEPS.map((s) => s.key);

/** 誰の番か。管理者（admin）は、この画面では経営者・人事と呼ぶ */
export const SIX_ACTORS = {
  owner: "経営者", advisor: "社労士", employee: "本人", hr: "人事", manager: "上長",
};

const ACTOR_OF_STAGE = { admin: "owner", advisor: "advisor", employee: "employee" };

/** step の状態。unlinked は「データ未連携」（数えない）、todo は「まだ前が終わっていない」 */
export const SIX_STATES = ["done", "current", "todo", "unlinked"];

const step = (key, extra) => {
  const def = SIX_STEPS.find((s) => s.key === key);
  return { key, n: def.n, label: def.label, short: def.short, icon: def.icon, actor: null, actorLabel: null,
    note: "", detail: [], ...extra };
};
const actorLabel = (a) => (a ? SIX_ACTORS[a] || null : null);

/**
 * @param {object} p
 *   facts     gatherFacts / gatherFactsBulk の結果 | null（読めなかった）
 *   career    gw_employee_careers の行（active）| null
 *   careerLinked  false のとき、キャリアの表が読めなかった（「データ未連携」にする。既定は読めた）
 * @returns {{
 *   steps: object[], stage: string, current: string|null, done: number, total: number,
 *   next: { key:string|null, label:string, actor:string|null, actorLabel:string|null, tone:string },
 *   needsCompany: boolean, complete: boolean
 * }}
 */
export function mapSix(p = {}) {
  const facts = p.facts || null;
  const ks = careerStatus({ career: p.career || null });

  // 事実が読めていないときは、手続き本体の段階（stage 列）に頼らず「未連携」にする
  const x = facts ? stageFlags(facts) : null;
  const stage = facts ? computeStage(facts) : null;
  const at = stage?.key || null;
  const atIntake = at === "intake";
  const atDone = at === "complete";

  // ---- ① 入社案内（データ未連携）----
  const guide = step("guide", {
    state: "unlinked",
    note: "案内の作成・送信・本人の確認を残す仕組みは、これから追加します",
  });

  // ---- ② 労働条件・契約 ----
  let contract;
  if (!facts) {
    contract = step("contract", { state: "unlinked", note: "入社手続きの事実が読めません" });
  } else if (atIntake || atDone) {
    contract = step("contract", { state: "done", note: x.closed ? "手続きを完了にしています" : "締結済み" });
  } else {
    const actor = ACTOR_OF_STAGE[stage.nextActors?.[0]] || "owner";
    contract = step("contract", {
      state: "current", actor, actorLabel: actorLabel(actor),
      note: stage.blockers?.[0] || "",
      detail: stage.blockers || [],
      stage: at,
    });
  }
  const contractDone = contract.state === "done";

  // ---- ③ 本人情報・必要書類（本人の作業）/ ④ アカウント準備（社内の作業）----
  let infoDocs, account;
  if (!facts) {
    infoDocs = step("info_docs", { state: "unlinked", note: "入社手続きの事実が読めません" });
    account = step("account", { state: "unlinked", note: "入社手続きの事実が読めません" });
  } else if (atDone) {
    infoDocs = step("info_docs", { state: "done", note: "提出済み" });
    account = step("account", { state: "done", note: "準備済み" });
  } else if (!atIntake) {
    // 署名が済むまで、入社情報の入力には進めない（lib/onboard-gate.js）
    infoDocs = step("info_docs", { state: "todo", note: "契約の締結後に始まります" });
    account = step("account", {
      state: "todo", note: x.internalOpen ? `社内準備 ${x.internalOpen} 件（契約の締結後に確認します）` : "契約の締結後に確認します",
    });
  } else {
    const mine = [];
    if (!x.profileSubmitted) mine.push("入社情報の入力がまだです");
    if (x.employeeOpen) mine.push(`書類の提出が ${x.employeeOpen} 件残っています`);
    if (!x.orientationOk) mine.push("オリエンテーションの確認がまだです");
    infoDocs = mine.length
      ? step("info_docs", { state: "current", actor: "employee", actorLabel: actorLabel("employee"), note: mine[0], detail: mine })
      : step("info_docs", { state: "done", note: "提出済み" });
    account = x.internalOpen
      ? step("account", { state: "current", actor: "owner", actorLabel: actorLabel("owner"),
          note: `社内準備が ${x.internalOpen} 件残っています`, detail: [`社内準備が ${x.internalOpen} 件残っています`] })
      : step("account", { state: "done", note: "準備済み" });
  }

  // ---- ⑤ キャリア設計（入社手続きとは独立した事実）----
  let career;
  if (p.careerLinked === false) {
    career = step("career", { state: "unlinked", note: "キャリアの表が読めません" });
  } else if (ks.ok) {
    career = step("career", { state: "done", note: ks.label });
  } else if (ks.key === "confirming") {
    career = step("career", { state: "current", actor: "employee", actorLabel: actorLabel("employee"), note: ks.label });
  } else {
    // いまの流れでは、キャリアの設定は入社手続きが終わってから（lib/journey.js の career_setup）。
    // 手続きの途中で「上長の番」にすると、本人の書類待ちの人まで会社の要対応に数えてしまう
    career = step("career", {
      state: atDone ? "current" : "todo", actor: atDone ? "manager" : null,
      actorLabel: atDone ? actorLabel("manager") : null, note: ks.label,
    });
  }

  // ---- ⑥ 最終確認（導出）----
  const others = [contract, infoDocs, account, career];
  const allLinked = others.every((s) => s.state !== "unlinked");
  const allDone = others.every((s) => s.state === "done");
  const final = !facts || !allLinked
    ? step("final", { state: "unlinked", note: "上のステップの事実が読めないため、判定できません" })
    : allDone && atDone
      ? step("final", { state: "done", note: "入社準備は完了しました" })
      : step("final", { state: "todo", note: "②〜⑤ がそろうと完了になります" });

  const steps = [guide, contract, infoDocs, account, career, final];

  // ---- 次に何をするか（完了率より、これを優先して出す）----
  const cur = steps.find((s) => s.n >= 2 && s.n <= 5 && s.state === "current");
  const complete = final.state === "done";
  let next;
  if (complete) {
    next = { key: null, label: "入社準備完了", actor: null, actorLabel: null, tone: "green" };
  } else if (!cur) {
    next = { key: null, label: allLinked ? "前のステップの完了待ち" : "データ未連携", actor: null, actorLabel: null, tone: "gray" };
  } else {
    next = { key: cur.key, label: nextLabel(cur, at, ks), actor: cur.actor, actorLabel: cur.actorLabel,
      tone: cur.actor === "owner" || cur.actor === "hr" || cur.actor === "manager" ? "red" : "yellow" };
  }

  const counted = steps.filter((s) => s.state !== "unlinked");
  return {
    steps, stage: at, current: cur?.key || null,
    done: counted.filter((s) => s.state === "done").length, total: counted.length,
    next,
    // 経営者・人事・上長が動く番のステップがあるか（一覧の「要対応」）。本人・社労士の番と重なってよい
    needsCompany: steps.some((s) => s.state === "current" && ["owner", "hr", "manager"].includes(s.actor)),
    waitingOn: [...new Set(steps.filter((s) => s.state === "current" && s.actor).map((s) => s.actor))],
    complete,
  };
}

/** 一覧の「状態」に出す1行。誰の番かが先に分かる言い方にする */
function nextLabel(cur, at, ks) {
  if (cur.key === "contract") {
    if (at === "conditions") return "労働条件の作成依頼待ち";
    if (at === "advisor_review") return "社労士の確認待ち";
    return "契約の署名待ち";
  }
  if (cur.key === "info_docs") return "本人の入力・書類待ち";
  if (cur.key === "account") return "アカウント・社内準備中";
  if (cur.key === "career") return ks.key === "confirming" ? "キャリアの本人確認待ち" : "キャリア設定待ち";
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
