// GET /api/schedule/team?from=&to=   … 社員全員の業務予定（本人を含む）
//
// ■ 何を返すか
//   visibility が private でない行だけ。既定は private なので、
//   本人が「見せる」と選んだ予定しか出てこない。
//
//   busy   … 時間だけ。件名も場所も種類も返さない（「予定あり」とだけ出す）
//   shared … 件名と場所まで
//
//   メモ（body）はどちらでも返さない。
//   持ち物や相手の連絡先を書く欄なので、公開範囲を上げただけで
//   そこまで出ると、本人の想定を超える。
//
// ■ 削るのはここの仕事
//   RLS は行しか絞れない。「この行は見せてよいが、この列は見せない」は
//   ポリシーでは書けないので、service_role で読んでから手で落とす。
//   userClient で読んで select を絞る手もあるが、それだと将来
//   select に列を足したときに黙って漏れる。ここで明示的に組み立てる。

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";

// 週を送るたびに叩かれる。1週間ぶんとして十分な上限
const LIMIT = 600;

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // 名簿に載っている人だけ。顧問先ロールのユーザーには誰の予定も見せない
  if (!ctx.employee) {
    return json(res, 403, { error: "not_enrolled", hint: "社員名簿に登録されていません。管理者に登録を依頼してください" });
  }

  const q = new URL(req.url, "http://localhost").searchParams;
  const from = q.get("from");
  const to = q.get("to");
  if (!from || !to) return json(res, 400, { error: "invalid_query", required: ["from", "to"] });

  const sb = admin();

  const { data, error } = await sb
    .from("gw_calendar_events")
    .select("id, employee_id, title, location, category, all_day, starts_at, ends_at, visibility")
    .eq("tenant_id", ctx.tenantId)
    .neq("visibility", "private")
    .eq("source", "self")                   // 休暇・予約の自動生成は会社の業務予定に含めない
    .neq("category", "private")             // 過去の私用も公開しない
    .gte("starts_at", from).lt("starts_at", to)
    .order("starts_at")
    .limit(LIMIT);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  const rows = data || [];

  // 全員の予定表として使うため、予定の無い在籍社員も返す（未入力を判別する）。
  // 認証・tenant・社員名簿チェックは上で済ませている。
  const { data: emps, error: empError } = await sb
    .from("gw_employees")
    .select("id, display_name, department, status")
    .eq("tenant_id", ctx.tenantId)
    .in("status", ["active", "invited"])
    .order("display_name")
    .limit(300);
  if (empError) return json(res, 500, { error: "employees_query_failed", detail: empError.message });
  const people = new Map();
  for (const e of emps || []) {
    people.set(e.id, { id: e.id, name: e.display_name, department: e.department || null });
  }

  const events = rows
    .filter((r) => people.has(r.employee_id))
    .map((r) => strip(r, people.get(r.employee_id)));

  return json(res, 200, { events, people: [...people.values()] });
}

/** 公開範囲に合わせて、返す項目そのものを組み立て直す */
function strip(r, person) {
  const base = {
    id: r.id,
    employeeId: r.employee_id,
    name: person.name,
    department: person.department,
    allDay: r.all_day,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    visibility: r.visibility,
  };
  if (r.visibility !== "shared") return base;   // busy は時間だけ
  return { ...base, title: r.title, location: r.location || null, category: r.category };
}
