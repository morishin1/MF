// GET /api/cron/tasks
// 繰り返しタスクの「元」から、これから来る回を作る。
//
// ■ なぜ自動で作るのか
//
//   月次の締め・支払・提出は、覚えている人が覚えているうちは回る。
//   その人が休んだ日に止まる。しかも止まったことに誰も気づかない
//   （出ていないものは、一覧に出ない）。
//   「元」を1つ置いておけば、その日になれば必ず並ぶ。
//
// ■ 何度走っても増えない
//
//   occ_key（template_id|YYYY-MM-DD）に一意制約がある（db/068）。
//   cron が重なっても、手で叩いても、同じ回は1件しかできない。
//
// ■ 先まで作りすぎない
//
//   旧タスク管理は12か月先まで作っていた。すると月1件の繰り返しでも
//   担当者の画面に「未確認の依頼」が12件並び、片付けても減らない
//   ＝終わらない、という見え方になっていた。
//   いまは当月＋翌月だけ（lib/task-flow.js の HORIZON_MONTHS）。
//
// ■ 消した回は、作り直さない
//
//   「今月のぶんは要らない」と消したのに翌日また出てくると、
//   消すこと自体をやめて、一覧が信用されなくなる。
//   行は消さずに status='cancelled' にしてあるので、occ_key が残る。
//
// 認証: CRON_SECRET があれば Authorization: Bearer <secret> を要求する。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { pendingOccurrences, HORIZON_MONTHS } from "../../lib/task-flow.js";
import { jstDate } from "../../lib/devices.js";

const SQL = "db/068_task_flow.sql";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = req.headers.authorization || "";
    if (given !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });
  }

  const sb = admin();
  const today = jstDate();
  const out = { today, horizonMonths: HORIZON_MONTHS, templates: 0, made: 0, skipped: 0 };

  // 繰り返しの「元」。全事業者ぶんまとめて引く（自社1社運用だが、分けない理由も無い）
  const { data: tpls, error } = await sb.from("gw_tasks")
    .select("id, tenant_id, title, body, assignee_id, escalate_to, priority, category, "
          + "recur, done_condition, created_by")
    .eq("is_template", true)
    .limit(500);

  if (error) {
    // 068 をまだ流していない環境。cron は落とさない（毎日エラー通知が出るだけ）
    return json(res, 200, { ...out, notReady: true, message: `${SQL} をまだ流していません` });
  }

  const list = (tpls || []).filter((t) => t.recur?.type);
  out.templates = list.length;
  if (!list.length) return json(res, 200, out);

  // すでに作ってある回。消した回（cancelled）もここに入るので、作り直さない
  const { data: made } = await sb.from("gw_tasks")
    .select("occ_key")
    .in("template_id", list.map((t) => t.id))
    .limit(20000);
  const have = new Set((made || []).map((m) => m.occ_key).filter(Boolean));

  const rows = [];
  for (const t of list) {
    for (const o of pendingOccurrences(t, { today, have })) {
      rows.push({
        tenant_id: t.tenant_id,
        title: t.title,
        body: t.body,
        assignee_id: t.assignee_id,
        escalate_to: t.escalate_to,
        due_on: o.date,
        priority: t.priority || "normal",
        status: "todo",
        category: t.category,
        done_condition: t.done_condition,
        // 繰り返しで出てくるものは、毎回「受けますか」と聞かない。
        // 決まってやる仕事なので、依頼の受諾とは別ものとして扱う
        accepted_at: new Date().toISOString(),
        created_by: t.created_by,
        template_id: t.id,
        occ_key: o.key,
        is_template: false,
      });
      have.add(o.key);
    }
  }

  if (!rows.length) return json(res, 200, out);

  // 一意制約に任せる。重なって走っても、片方が弾かれるだけ。
  // 200件ずつに割るのは、毎日の繰り返しがあると1回の送信が大きくなるため
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error: e2, count } = await sb.from("gw_tasks")
      .upsert(chunk, { onConflict: "occ_key", ignoreDuplicates: true, count: "exact" });
    if (e2) {
      console.error("[cron/tasks] insert", e2.message);
      out.skipped += chunk.length;
      continue;
    }
    out.made += count ?? chunk.length;
  }

  return json(res, 200, out);
}
