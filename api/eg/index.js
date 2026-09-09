// GET  /api/eg?date=YYYY-MM-DD[&ai=1]   … ログイン中のメンバーの「今日の営業」
// POST /api/eg {action:"contact"|"deal"|"lead"|"analyze"|"email", …}
//
// ■ この画面の役割
//   mf はメンバーが毎日開くコックピット。出すのは「今日誰に当たるか」
//   「何件やったか」「次に何をするか」だけにする。
//   一覧・分析・全体管理は growth.8grp.co.jp/admin に置く。ここには作らない。
//
// ■ データは growth の Supabase にしか無い
//   mf 側には営業テーブルを作らない。二重管理を避けるため。
//   growth を service_role で読むのはこのサーバだけで、
//   本人のメールアドレスで絞ってから返す（lib/eg.js）。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import {
  egConfigured, todayJst, todayFor, suggestActions,
  logActivity, createDeal, updateLead, analyzeCompany, draftEmail, aiConfigured,
} from "../../lib/eg.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  // 未設定でも画面は開けるようにする。「繋がっていない」と出すため
  if (!egConfigured()) {
    return json(res, 200, {
      configured: false,
      hint: "GROWTH_SUPABASE_URL / GROWTH_SUPABASE_SERVICE_ROLE_KEY を Vercel の環境変数に設定してください",
    });
  }

  const email = (user.email || "").toLowerCase();
  if (!email) return json(res, 403, { error: "no_email" });

  try {
    if (req.method === "GET") return await read(req, res, email);
    if (req.method === "POST") return await write(req, res, email);
    return methodNotAllowed(res, ["GET", "POST"]);
  } catch (e) {
    return json(res, 500, { error: "eg_failed", message: e.message });
  }
}

async function read(req, res, email) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get("date") || "") ? q.get("date") : todayJst();

  const today = await todayFor(email, date);
  // 毎回AIを呼ぶと、朝いちの表示が遅くなるし費用もかかる。
  // 既定はルールで出し、ai=1 のときだけAIに並べ替えさせる。
  const next = await suggestActions(today, { useAi: q.get("ai") === "1" });

  return json(res, 200, { configured: true, aiAvailable: aiConfigured(), ...today, next });
}

async function write(req, res, email) {
  const body = await readJson(req);
  switch (body.action) {
    case "contact":
      return json(res, 200, { ok: true, activity: await logActivity(email, body) });
    case "deal":
      return json(res, 200, { ok: true, deal: await createDeal(email, body) });
    case "lead":
      return json(res, 200, { ok: true, lead: await updateLead(email, body) });
    case "analyze":
      return json(res, 200, { ok: true, brief: await analyzeCompany(body) });
    case "email":
      return json(res, 200, { ok: true, mail: await draftEmail(body) });
    default:
      return json(res, 400, {
        error: "invalid_action",
        allowed: ["contact", "deal", "lead", "analyze", "email"],
      });
  }
}
