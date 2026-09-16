// 入社日が近いのに終わっていない手続きを、誰に知らせるか（純粋）。
//
// ■ いつ知らせるか
//   入社日の 7日前から毎日、入社日を過ぎても未完了なら毎日。
//   dedupe_key を人ごと・手続きごとに固定するので、ベルには1件だけ残り、
//   本文が「あと3日」「あと2日」と更新される。積み上がらない。
//
// ■ 誰に
//   本人   … 本人の番のとき（③ 締結、④ の入力・提出・オリエンテーション）
//   管理者 … 常に（入社日が近いのに終わっていない、は管理者が知るべきこと）
//   社労士 … ② で止まっているとき
//
// ■ 数字は「入社日まで何日」だけ
//   何が残っているかは blockers（段階の判定と同じ文）をそのまま使う。
//   ここで別の言い方をすると、画面と通知で違う言葉になる

import { stageOf, daysToStart } from "./onboard-stage.js";

export const DUE_WINDOW_DAYS = 7;

/**
 * @param {object} p
 *   proc     { id, employee_id, target_on, status }
 *   name     本人の氏名
 *   stage    computeStage の結果 { key, blockers, nextActors }
 *   today    YYYY-MM-DD
 *   adminIds string[]   人事・経営者の gw_employees.id
 *   advisorIds string[] 社労士の gw_employees.id
 * @returns {object[]} notify() に渡す行
 */
export function dueNotices(p) {
  const { proc, stage, today } = p;
  if (!proc || !stage || stage.key === "complete") return [];
  if (proc.status === "done" || proc.status === "cancelled") return [];
  const days = daysToStart(proc.target_on, today);
  if (days === null || days > DUE_WINDOW_DAYS) return [];

  const when = days > 0 ? `入社日まであと${days}日` : days === 0 ? "今日が入社日" : `入社日を${-days}日過ぎています`;
  const st = stageOf(stage.key);
  const what = (stage.blockers || []).join("、") || st.todo;
  const name = p.name || "入社予定の方";
  const out = [];

  if ((stage.nextActors || []).includes("employee")) {
    out.push({
      tenantId: proc.tenant_id, employeeId: proc.employee_id, kind: "blocker",
      title: `${when}：入社手続きが残っています`,
      body: what, link: "onboarding.html",
      dedupeKey: `onboard-due:${proc.id}:employee`,
    });
  }
  if ((stage.nextActors || []).includes("advisor")) {
    for (const id of p.advisorIds || []) {
      out.push({
        tenantId: proc.tenant_id, employeeId: id, kind: "blocker",
        title: `${name}さん：${when}、${st.label}が未完了`,
        body: what, link: "advisor.html",
        dedupeKey: `onboard-due:${proc.id}:advisor`,
      });
    }
  }
  for (const id of p.adminIds || []) {
    if (id === proc.employee_id) continue;
    out.push({
      tenantId: proc.tenant_id, employeeId: id, kind: "blocker",
      title: `${name}さん：${when}、${st.label}が未完了`,
      body: `${st.actorLabel}：${what}`, link: `admin-hr.html?id=${proc.id}`,
      dedupeKey: `onboard-due:${proc.id}:admin`,
    });
  }
  return out;
}
