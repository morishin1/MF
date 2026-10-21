// 採用HR：契約手続き（社労士への作成依頼 → 正式PDFの受領・照合・承認 → LegalSign の登録 → 締結の記録）。db/139。
//
// GET  /api/hr/offers/contract?applicantId=…                       … 契約手続きのカード（いま有効な版の7ステップ・状態・次の担当・主ボタン1つ・
//                                                                     受領した正式PDF・依頼の記録・版の照合）
// GET  /api/hr/offers/contract?offerId=…&draft=request[&kind=revision] … 社労士へ Slack で送る依頼文の下書き（送らない・記録しない）
// GET  /api/hr/offers/contract?docId=…&file=1                      … 正式PDFを開く（給与を見られる人だけ。SHA-256 を確かめてから返す）
// POST /api/hr/offers/contract { offerId, action, … }
//   markRequested { kind?, note?, missingLabels? } … 担当者が「依頼済みにする」を押したときだけ記録（コピーしただけでは記録しない）
//   uploadUrl     { fileName, size }              … 正式PDFの置き場所（署名つきアップロードURL）
//   attach        { path, docKind, title?, receivedOn, authorName?, fileName? } … 置いたPDFを確かめて受け取る（版・SHA-256）
//   approve       { docId, checks }               … HR の条件と照合して承認（給与を見られる人だけ・全項目に✓）
//   return        { docId, reason }               … 差し戻し（給与を見られる人だけ・理由が要る）
//   reopen        { reason? }                     … 条件を直す（本人へ案内する前だけ。受け取った版は使わなくなる）
//   legalsign     { route, url?, sameDoc? }       … LegalSign に登録した版の記録（承認した正式PDFと同じ版）／例外ルート
//   signed        { evidence, contractRef?, sameDoc } … 締結を確かめて記録（社長・管理者・人事。本人の同意の前でもよい）
//
// ■ Slack へは送らない（依頼文を作るだけ。送るのは担当者）。「Slack 送信済み」と言わない（担当者が依頼済みと記録）
// ■ 書き込みは service role（db/139 の表はログインした人からは読むだけ）。権限と状態はここで先に確かめる
// ■ 本人へ案内するのは index.js の send / issueLink（承認した正式PDFを notice_* に固定する）。引き渡しは index.js の handoff


import { json, readJson, methodNotAllowed } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit, canSeeSalary } from "../../../lib/gw.js";
import { guardSalaryOutput } from "../../../lib/salary.js";
import { userClient, admin } from "../../../lib/supabase.js";
import { activeIntakeIds } from "../../../lib/hr-office-intake.js";
// 処理の本体は lib/hr-contract-ops.js（Office の api/hr/office-intakes.js も同じ関数を呼ぶ）
import { contractCard, contractRequestDraft, contractOfficialFile, contractAct } from "../../../lib/hr-contract-ops.js";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const movedIds = (ctx, ids) => activeIntakeIds(admin(), ctx.tenantId, ids.filter(Boolean));
/** HR から見るだけのカード（Office へ引き渡し済み）：ボタン・操作の権限を外す */
function readOnlyCard(body) {
  const procedure = body.procedure ? { ...body.procedure, primary: null, secondary: [] } : body.procedure;
  return { ...body, procedure, movedToOffice: true, perms: { review: false, handoff: false, signed: false, salary: Boolean(body.perms?.salary) },
    readOnlyHint: "Office へ引き渡し済みです。契約の手続きは Office で進みます（HR では見るだけです）" };
}


export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });
  const sb = userClient(req);
  const salary = guardSalaryOutput(res, canSeeSalary(ctx));

  if (req.method === "GET") {
    const q = new URL(req.url || "/", "http://localhost").searchParams;
    if (q.get("docId")) return contractOfficialFile(res, sb, ctx, user, q.get("docId"), salary);
    if (q.get("draft") === "request") return contractRequestDraft(res, sb, ctx, q.get("offerId"), q.get("kind"), salary);
    const r = await contractCard(sb, ctx, q.get("applicantId"), salary);
    // Office へ早期引き渡し済み（db/143）の人は、HR では見るだけ（ボタンを出さない）
    if (r.status === 200 && r.body?.applicable) {
      let moved = true;   // 確かめられないときは、ボタンを出さない（見るのは同じ）
      try { moved = (await movedIds(ctx, [q.get("applicantId")])).size > 0; } catch { /* 上のとおり */ }
      if (moved) return json(res, 200, readOnlyCard(r.body));
    }
    return json(res, r.status, r.body);
  }
  if (req.method === "POST") {
    const body = await readJson(req);
    // 書き込む前に：版の応募者が Office へ引き渡し済みなら 409（契約の手続きは Office で同じ関数を使って進める）
    const { data: o } = ID_RE.test(String(body?.offerId || ""))
      ? await sb.from("gw_hr_offers").select("applicant_id").eq("id", body.offerId).eq("tenant_id", ctx.tenantId).maybeSingle()
      : { data: null };
    if (o?.applicant_id) {
      let moved;
      try { moved = (await movedIds(ctx, [o.applicant_id])).size > 0; }
      catch (e) { return json(res, 500, { error: "db_query_failed", detail: e?.message || String(e) }); }
      if (moved) return json(res, 409, { error: "moved_to_office", hint: "Office へ引き渡し済みです。契約の手続きは Office（人事・労務の「HRからの引き継ぎ」）で進めます（HR では見るだけです）" });
    }
    return contractAct(req, res, sb, ctx, user, salary, body);
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

