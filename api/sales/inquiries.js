// POST /api/sales/inquiries … 無限道場の自治体向けLP（mugendojo.jp/lp）の問い合わせを、/sales の営業リードとして受け付ける。
//
// ■ サーバー間だけ。ブラウザからは呼ばせない
//   mugendojo.jp のサーバーが HMAC-SHA256 で署名して送る（lib/sales-inquiries.js の verifySalesSignature）。
//   鍵は HR リードと同じ MUGENDOJO_LEAD_SECRET（設定済み）。署名の文字列の先頭に "sales." を付けて、HR の口と分けている。
//   CORS のヘッダーは出さない。
//
// ■ 環境変数（新しく足すものはない）
//   MUGENDOJO_LEAD_SECRET … 署名の鍵。未設定なら 503
//   HR_LEAD_TENANT_ID     … 入れるテナント（HR リードと同じ会社）。リクエストからは決めない。未設定なら 503
//
// ■ 返すもの
//   200 { ok, companyId, result: "created"|"updated"|"replayed" }
//   400 invalid_body（field）/ 401 unauthorized・timestamp_out_of_range / 503 not_configured / 500
//
// ■ ログ：監査ログ・コンソールに、メール・氏名・相談内容を出さない。
import { readJson, methodNotAllowed, json } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { notify } from "../../lib/notify.js";
import { notifySlack } from "../../lib/slack.js";
import { verifySalesSignature, normalizeInquiry, intakeInquiry } from "../../lib/sales-inquiries.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const secret = process.env.MUGENDOJO_LEAD_SECRET || "";
  const tenantId = String(process.env.HR_LEAD_TENANT_ID || "").trim();
  if (!secret || !UUID_RE.test(tenantId)) return json(res, 503, { ok: false, error: "not_configured" });

  const body = await readJson(req);
  const auth = verifySalesSignature(req.headers, body, { secret });
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });

  const n = normalizeInquiry(body);
  if (n.error) return json(res, 400, { ok: false, error: n.error, field: n.field });
  const v = n.value;

  const out = await intakeInquiry(admin(), tenantId, v);
  if (out.error) {
    console.error("[sales-inquiries] intake failed:", out.error, out.detail || "");
    return json(res, out.status, { ok: false, error: out.error });
  }
  if (out.result !== "replayed") {
    const link = `sales/companies.html?id=${out.companyId}`;
    await Promise.all([
      notify(out.notifyTo.map((employeeId) => ({
        tenantId, employeeId, kind: "sales",
        title: `${out.companyName}から${v.typeLabel}がありました`,
        body: `無限道場の自治体向けLPからの問い合わせです。\n種別：${v.typeLabel}\n内容は営業履歴を確認してください。`,
        link: `/${link}`, dedupeKey: `sales_inquiry:${v.submissionId}`,
      }))).catch(() => {}),
      notifySlack({ text: `🏛 自治体向けLPから問い合わせ\n\n${out.companyName}\n${v.typeLabel}`, lines: ["", "企業詳細を見る："], link }).catch(() => {}),
      gwLog({
        tenantId, actorId: null, action: "sales.lp_inquiry", target: `sales_company:${out.companyId}`,
        detail: { result: out.result, type: v.type, source: v.source, sourceDetail: v.sourceDetail, submissionId: v.submissionId },
      }).catch(() => {}),
    ]);
  }
  return json(res, 200, { ok: true, companyId: out.companyId, result: out.result });
}
