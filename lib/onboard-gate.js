// 「契約を結ぶ前に、入社手続き（入社情報の入力・書類の提出）へ進ませない」をサーバで守る。
//
// 画面（onboarding.html）も締結が済むまで入力欄を出さないが、それは見た目だけ。
// API を直接叩けば入れられてしまうので、書き込みの入口でも同じ判定をする。
//
// ■ 判定は入社手続きの段階（lib/onboard-stage.js computeStage）そのもの
//   ① 作成依頼 ② 社労士確認 ③ 締結 のあいだは閉じる。④ 情報入力・提出 から開く。
//   段階の計算を別に書くと、一覧・通知・ここで答えがずれる。
//
// ■ 手続きが無い人（以前からの社員・手続きを作らなかった人）は止めない
// ■ 表が読めない（未適用の環境）ときも止めない。画面側の表示で十分に案内できる

import { computeStage } from "./onboard-stage.js";
import { gatherFacts } from "./onboard-advance.js";

export const INTAKE_CLOSED_STAGES = ["conditions", "advisor_review", "signing"];
export const INTAKE_CLOSED_HINT =
  "労働条件通知書の署名（本人契約）が済んでから、入社情報の入力・書類の提出ができます";

/** @returns {Promise<{ok:boolean, stage?:string, hint?:string}>} */
export async function intakeGate(sb, tenantId, employeeId) {
  try {
    const { data: procs } = await sb.from("gw_procedures")
      .select("id, tenant_id, employee_id, kind, status, target_on, stage")
      .eq("tenant_id", tenantId).eq("employee_id", employeeId).eq("kind", "onboarding")
      .order("created_at", { ascending: false }).limit(1);
    const proc = procs?.[0];
    if (!proc || proc.status === "cancelled") return { ok: true };
    const st = computeStage(await gatherFacts(sb, tenantId, proc));
    if (INTAKE_CLOSED_STAGES.includes(st.key)) return { ok: false, stage: st.key, hint: INTAKE_CLOSED_HINT };
    return { ok: true, stage: st.key };
  } catch {
    return { ok: true };
  }
}
