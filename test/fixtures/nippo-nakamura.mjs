// 「本人は日報を出した・AIフィードバックも出た・なのに管理側で反映されていないように見えた」の再現材料。
//
// 本番で確認した条件（2026-10-08）をそのまま写す。氏名・メール・ID は架空（実在の人の情報は入れない）
//   ・社員名簿：active、user_id あり
//   ・auth.users.id = gw_employees.user_id = tc_nippo.user_id（同じ1つのアカウント）
//   ・今日（10/8・木）の日報あり。提出は 2026-10-07 23:59 UTC（日本時間 10/8 08:59）
//   ・AI評価 completed
//   ・直近の営業日（10/5〜10/7）も提出済み
// あわせて、管理側で「未提出」になってよい2つ（別の user_id で書いた・名簿の user_id が空）も置く。
export const TENANT = "00000000-0000-4000-8000-0000000000a1";
export const TODAY = "2026-10-08";
export const NAKAMURA = { id: "e-nk", user_id: "11111111-2222-4333-8444-555555555555", display_name: "中村 テスト" };
export const NIPPO_ID = "66666666-7777-4888-8999-000000000001";
export const EVAL_ID = "66666666-7777-4888-8999-000000000002";

export function nakamuraRows() {
  const nk = NAKAMURA.user_id;
  return {
    gw_employees: [
      { ...NAKAMURA, tenant_id: TENANT, department: "営業", employment_type: "正社員", status: "active" },
      { id: "e-ot", tenant_id: TENANT, user_id: "u-other", display_name: "別アカウント 太郎", status: "active" },
      { id: "e-nu", tenant_id: TENANT, user_id: null, display_name: "ログインなし 花子", status: "active" },
    ],
    tc_nippo: [
      ...["2026-10-05", "2026-10-06", "2026-10-07"].map((d, i) => ({
        id: `66666666-7777-4888-8999-10000000000${i}`, user_id: nk, user_name: NAKAMURA.display_name, work_date: d,
        submitted_at: `${d}T09:00:00Z`, confirmed: false, mood: "順調", work_items: [], issues: [],
      })),
      { id: NIPPO_ID, user_id: nk, user_name: NAKAMURA.display_name, work_date: TODAY,
        submitted_at: "2026-10-07T23:59:00Z", confirmed: false, mood: "順調", goal_today: "提案書を2件送る",
        work_items: [{ title: "提案書の作成", result: "2件送付" }], issues: [], no_issues: true },
      // 名簿の「別アカウント 太郎」とは違う user_id で書かれた日報（管理側では未提出のまま＝正しい）
      { id: "66666666-7777-4888-8999-000000000009", user_id: "u-second-account", user_name: "別アカウント 太郎", work_date: TODAY,
        submitted_at: "2026-10-08T01:00:00Z", confirmed: false, mood: "順調", work_items: [], issues: [] },
    ],
    gw_nippo_ai_evals: [
      { id: EVAL_ID, nippo_id: NIPPO_ID, user_id: nk, work_date: TODAY, status: "completed",
        model: "test-model", total_score: 72, scores: {}, categories: null, created_at: "2026-10-08T00:00:30Z",
        ai_comment: "提案の数が明確で良いです" },
    ],
    tc_nippo_replies: [
      { id: "r1", nippo_id: NIPPO_ID, kind: "ai", body: "AIからのフィードバック", draft_only: false, created_at: "2026-10-08T00:00:40Z" },
    ],
    tc_settings: [],
    gw_time_entries: [],
    gw_time_fixes: [],
    gw_daily_kpis: [],
    gw_blockers: [],
    gw_action_items: [],
  };
}
