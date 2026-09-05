// GET  /api/nippo?date=YYYY-MM-DD … 自分の日報・日次の行動確認・週次レビュー・今日の提出状況
// POST /api/nippo                  … 自分の日報を出す（同じ日は上書き）
// POST /api/nippo {kind:"weekly"}  … 今週の振り返り4問を保存する
//
// 8grp.co.jp/8/dr/ にあった日報を、このグループウェアへ移したもの。
// 表（tc_nippo など）は元のまま使っている。理由は lib/nippo.js の頭に書いた。
//
// tc_* の RLS は anon にも開いている（タイムカードが簡易ログインで動いているため）。
// そのぶん「自分の日報しか書けない」はこの API が担保する。
// user_id には必ずログイン中の auth ユーザーの id を入れ、画面から来た値は使わない。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import {
  jstDate, weekStart, isDate, normalizeNippo, hasContent, requestAiReply,
  evaluateDaily, CRITERIA, IMPROVE_TAGS,
} from "../../lib/nippo.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, {
      error: "no_employee",
      hint: "社員名簿にあなたの行がありません。管理者に登録を依頼してください。",
    });
  }

  if (req.method === "GET") return read(req, res, user, ctx);
  if (req.method === "POST") {
    const body = await readJson(req);
    return body?.kind === "weekly" ? saveWeekly(res, user, body) : submit(res, user, ctx, body);
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読み取り ---------------------------------------------------------------
async function read(req, res, user, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const date = isDate(q.get("date")) ? q.get("date") : jstDate();
  const sb = admin();

  // 名簿。その日の提出状況と、未提出者の一覧を作るのに使う
  const { data: roster } = await sb
    .from("gw_employees")
    .select("id, user_id, display_name, department, employment_type")
    .eq("tenant_id", ctx.tenantId)
    .in("status", ["active", "leaving"])
    .order("display_name")
    .limit(300);

  const [mine, today, thanks, weekly] = await Promise.all([
    // 自分の直近30件。過去を振り返れる範囲があればよく、全件は要らない
    sb.from("tc_nippo").select("*").eq("user_id", user.id)
      .order("work_date", { ascending: false }).limit(30),
    // その日の提出状況。日報は社内公開の運用なので、誰が出したかは全員に見せる
    sb.from("tc_nippo").select("id, user_id, user_name, work_date, mood, submitted_at, confirmed")
      .eq("work_date", date).limit(300),
    sb.from("tc_thanks").select("*").eq("to_user_id", user.id)
      .order("created_at", { ascending: false }).limit(30),
    sb.from("tc_weekly_review").select("*").eq("user_id", user.id)
      .eq("week_start", weekStart(date)).maybeSingle(),
  ]);

  const rows = mine.data || [];
  const ids = rows.map((r) => r.id);
  let replies = [];
  if (ids.length) {
    const { data } = await sb.from("tc_nippo_replies").select("*")
      .in("nippo_id", ids).in("kind", ["ai", "admin"])
      .order("created_at", { ascending: true });
    // 下書きは本人には見せない。管理者が送るまでは存在しないものとして扱う
    replies = (data || []).filter((r) => !(r.kind === "admin" && r.draft_only));
  }

  return json(res, 200, {
    date,
    weekStart: weekStart(date),
    me: {
      userId: user.id,
      name: ctx.employee.display_name,
      employType: ctx.employee.employment_type || null,
    },
    today: rows.find((r) => r.work_date === date) || null,
    recent: rows,
    replies,
    thanks: thanks.data || [],
    weekly: weekly.data || null,
    // 画面に出す選択肢と基準はサーバから渡す。定義を2か所に置かないため
    improveTags: IMPROVE_TAGS,
    criteria: CRITERIA,
    team: (today.data || []).sort((a, b) => (a.user_name || "").localeCompare(b.user_name || "", "ja")),
    notSubmitted: (roster || [])
      .filter((e) => e.user_id && !(today.data || []).some((n) => n.user_id === e.user_id))
      .map((e) => e.display_name),
  });
}

// ---- 提出 -------------------------------------------------------------------
async function submit(res, user, ctx, body) {
  const date = isDate(body?.date) ? body.date : jstDate();

  // 未来の日付は書けない。書けてしまうと「まだ起きていないこと」が実績になる
  if (date > jstDate()) return json(res, 400, { error: "future_date", hint: "未来の日付では出せません" });
  // 遡れるのは30日まで。それ以上前を直したいときは管理者に相談してもらう
  if (date < jstDate(-30)) return json(res, 400, { error: "too_old", hint: "30日より前の日報は編集できません" });

  const fields = normalizeNippo(body);
  if (!hasContent(fields)) {
    return json(res, 400, {
      error: "empty",
      hint: "① 今日のKGI、② やったこと・成果、⑥ 明日の最優先 のどれかは書いてください",
    });
  }

  const sb = admin();
  // 「今日確認できた行動」は保存時に決める。あとから基準を変えても
  // 過去の日報の表示が勝手に変わらないようにするため
  const row = {
    ...fields,
    daily_flags: evaluateDaily(fields),
    user_id: user.id,                                   // 画面から来た値は使わない
    user_name: ctx.employee.display_name,
    employ_type: ctx.employee.employment_type || null,
    work_date: date,
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await sb
    .from("tc_nippo").select("id").eq("user_id", user.id).eq("work_date", date).maybeSingle();

  let nippoId;
  if (existing) {
    const { error } = await sb.from("tc_nippo").update(row).eq("id", existing.id);
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
    nippoId = existing.id;
  } else {
    const { data, error } = await sb.from("tc_nippo").insert(row).select("id").single();
    if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });
    nippoId = data.id;
  }

  // AI の自動返信。落ちていても日報の保存はもう済んでいるので、
  // 結果は「出せたかどうか」だけ返して画面の表示に使う
  const ai = await requestAiReply(nippoId);

  return json(res, 200, { ok: true, id: nippoId, ai, dailyFlags: row.daily_flags });
}

// ⑧「今日の感謝」は、要件の見直しで ⑤「顧客・チームのためにしたこと」に
// 統合した（項目が多すぎて毎日書けない、というのが元の問題だったため）。
// 過去に送られた感謝は tc_thanks に残っていて、本人の画面には出し続ける。
// 新しく送る口はここには無い。

// ---- 週次レビュー（本人の振り返り4問） ---------------------------------------
async function saveWeekly(res, user, body) {
  const ws = isDate(body?.weekStart) ? body.weekStart : weekStart(jstDate());
  if (weekStart(ws) !== ws) return json(res, 400, { error: "invalid_week", hint: "週の開始日は月曜です" });

  const sb = admin();
  const { data: emp } = await sb
    .from("gw_employees").select("display_name").eq("user_id", user.id).maybeSingle();

  const cut = (v) => String(v ?? "").trim().slice(0, 4000) || null;
  const { data, error } = await sb.from("tc_weekly_review").upsert({
    user_id: user.id,
    user_name: emp?.display_name || null,
    week_start: ws,
    q1: cut(body?.q1), q2: cut(body?.q2), q3: cut(body?.q3), q4: cut(body?.q4),
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,week_start" }).select("*").single();

  if (error) return json(res, 500, { error: "db_upsert_failed", detail: error.message });
  return json(res, 200, { weekly: data });
}
