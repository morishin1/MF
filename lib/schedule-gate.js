// 日報の前提条件：本人が次の営業日に業務予定を最低1件登録していること。
// 認証済みAPIから呼び出す。RLS迂回クライアントを使う場合も必ずtenant/employeeで絞る。
import { nextFocusDate } from "./focus.js";

const dayAfter = s => {
  const [y,m,d] = s.split("-").map(Number);
  const utc = new Date(Date.UTC(y,m-1,d+1));
  return utc.toISOString().slice(0,10);
};

export async function checkNextWorkSchedule(sb, ctx, reportDate) {
  const targetDate = nextFocusDate(reportDate);
  if (!targetDate || !ctx?.tenantId || !ctx?.employee?.id) {
    return { ready:false, targetDate:targetDate||null, count:0, error:"invalid_context" };
  }
  const from = targetDate+"T00:00:00+09:00";
  const to = dayAfter(targetDate)+"T00:00:00+09:00";
  const {data, error} = await sb.from("gw_calendar_events")
    .select("id, title, starts_at, ends_at, category, all_day")
    .eq("tenant_id",ctx.tenantId)
    .eq("employee_id",ctx.employee.id)
    .eq("source","self")
    .neq("category","private")
    .gte("starts_at",from).lt("starts_at",to)
    .order("starts_at")
    .limit(500);
  if (error) return { ready:false, targetDate, count:0, error:"schedule_query_failed" };
  // 終了時刻を持つ有効な業務予定だけを数える。旧 private visibility は業務カテゴリーなら有効。
  const count=(data||[]).filter(e=>e.title?.trim() &&
    (e.all_day || (e.ends_at && new Date(e.ends_at)>new Date(e.starts_at)))).length;
  return { ready:count>0, targetDate, count, error:null };
}
