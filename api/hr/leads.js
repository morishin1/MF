// POST /api/hr/leads … 外部LP（いまは無限道場 mugendojo.jp）のリードを採用HRへ受け付ける。
//
// ■ サーバー間だけ。ブラウザからは呼ばせない
//   mugendojo.jp のサーバーが HMAC-SHA256 で署名して送る（lib/hr-leads.js の verifyLeadSignature）。
//   ブラウザには秘密鍵が無いので、LP から直接このURLを叩いても 401 になる。
//   CORS のヘッダーも出さない。
//
// ■ 環境変数
//   MUGENDOJO_LEAD_SECRET   署名の鍵（lms 側にも同じ値）。未設定なら 503（常に拒否）
//   HR_LEAD_TENANT_ID       リードを入れるテナント。リクエストからは決めない（固定）。未設定なら 503
//   TIMEREX_MUGENDOJO_CASUAL_URL  無限道場のカジュアル面談の予約ページ（任意）。
//                           あれば、応募者IDを付けた予約URLを返す（LP の完了画面から進ませる）
//   TIMEREX_CASUAL_INTERVIEW_URL  採用のカジュアル面談の予約ページ（既存）。講師・メンター応募
//                           （lead_type = mugendojo_instructor）の予約URLに使う
//
// ■ リードの種類（lib/hr-leads.js の LEAD_TYPES）
//   lead_type で入れ先が決まる。無い・知らない値は無料カウンセリング（lead_category = mugendojo。従来どおり）。
//   mugendojo_instructor は採用（recruitment）の応募者・募集職種「無限道場 講師・メンター」として入る。
//
// ■ 返すもの
//   200 { ok, applicantId, result: "created"|"updated"|"replayed", schedulingUrl }
//   400 invalid_body（field に項目名）/ 401 unauthorized・timestamp_out_of_range
//   429 rate_limited / 503 not_configured・not_ready（db/118 未実行）
//
// ■ ログ
//   監査ログ（gw_activity_log）・コンソールに、メールアドレス・氏名・本文を出さない。

import { readJson, methodNotAllowed, json } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { schedulingUrlFor } from "../../lib/hr.js";
import { verifyLeadSignature, normalizeLeadPayload, intakeLead, leadTypeOf } from "../../lib/hr-leads.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const secret = process.env.MUGENDOJO_LEAD_SECRET || "";
  const tenantId = String(process.env.HR_LEAD_TENANT_ID || "").trim();
  // 設定が揃っていないときは、受け付けない（どのテナントへ入れるかを推測しない）
  if (!secret || !UUID_RE.test(tenantId)) return json(res, 503, { ok: false, error: "not_configured" });

  const body = await readJson(req);
  const auth = verifyLeadSignature(req.headers, body, { secret });
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });

  const lead = normalizeLeadPayload(body);
  if (lead.error) return json(res, 400, { ok: false, error: lead.error, field: lead.field, detail: lead.detail });

  const kind = leadTypeOf(lead.value.leadType);
  const out = await intakeLead(admin(), tenantId, lead.value);
  if (out.error) {
    if (out.status >= 500) console.error("[hr-leads] intake failed:", out.error, out.detail || out.message || "");
    return json(res, out.status, { ok: false, error: out.error, message: out.message });
  }

  if (out.result !== "replayed") {
    await gwLog({
      tenantId, actorId: null, action: "hr.lead_intake",
      target: `hr_applicant:${out.applicantId}`,
      detail: {
        category: kind.category, leadType: lead.value.leadType, result: out.result, submissionId: lead.value.submissionId,
        utmSource: lead.value.touch.utm_source || null, utmMedium: lead.value.touch.utm_medium || null,
      },
    });
  }

  return json(res, 200, {
    ok: true, applicantId: out.applicantId, result: out.result,
    schedulingUrl: schedulingUrlFor(process.env[kind.schedulingEnv], out.applicantId),
  });
}
