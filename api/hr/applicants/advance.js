import { assertLegacyPdfFlowAbsent } from "../../../lib/hr-pdf-flow-guard.js";
// GET   /api/hr/applicants/advance?applicantId=…
//         … admin-onboard.html（?applicantId=…）が、採用条件の事前入力を
//           サーバ側から取得する。給与・勤務条件はURLへ載せない（README Stage 8）
// POST  /api/hr/applicants/advance { applicantId }
//         … 本採用の手続きを始める（README Stage 8）。承諾済み（status=accepted）
//           の応募者だけ。二重に手続きが進まないよう advance_claimed_at で
//           一時的に確保する（事前入力の中身はGETで別途取得する）
// PATCH /api/hr/applicants/advance { applicantId, action }
//         "release"  … 手続きをやめる（クレームを外す。やり直せるように）
//         "complete" … 実際に社員（gw_employees、既存のapi/employees/onboard.js
//                       で作成済み）ができたら、応募者側を確定する
//                       （employee_id・status=done。クレームも外す）
//
// ■ ここでは社員を作らない
//   本採用の実処理（アカウント作成・契約・育成計画等）は、既存の
//   api/employees/onboard.js をそのまま使う（作り直さない。db/081の設計）。
//   このAPIは「承諾済み→admin-onboardへ安全につなぐ」ことだけをする
//
// ■ Office への引き渡しの前には進めない（db/133）
//   区分つきの承諾済みオファー（育成枠を除く）は、HR が［承諾内容を確認してOfficeへ引き渡す］を済ませる
//   （正式契約が要る版は正式契約済みのあと）までは、事前入力・手続き開始・完了のどれも断る（409 handoff_required）。
//   画面のボタンを隠すだけでなく、URL・API を直接使っても進めないようにサーバで止める。
//   db/133 が無い環境・区分の無い従来の合格通知・育成枠は、これまでどおり進める（lib/hr-offer-types.js handoffPendingOf）
//
// ■ 権限と、service role を使う順番（先に確かめてから、書く）
//   社長・管理者・人事（hr）が、最初から最後まで同じ流れを実行できる（lib/gw.js canAdvanceHire）。
//   社員登録の画面（admin-onboard.html。access: "officeHr"）に入れる人と揃える。
//   以前は社長・管理者だけで、人事が登録すると事前入力が出ず、
//   応募者が「承諾済み」のまま残っていた。給与を返すかは canSeeSalary のまま（広げない）
//
//   Office の人事（会計側の管理者など）は、採用HRの DB 権限（RLS＝gw_is_recruiting）を持たないことがあり、
//   利用者の権限（userClient）のままでは応募者・オファーを読めず、社員登録の事前入力も確定もできなかった。
//   そこで認可のあとは service role（admin）で読み書きする。service role は RLS を通らないので、次の順に「先に」確かめ、
//   どれかに当たったら、何も書かずに断る：
//     ① 認可       … canAdvanceHire（Office の人事権限）。通らなければ service role は作らない・何も読まない
//     ② tenant_id  … 応募者・オファー・社員のどれも、自分のテナントの行だけ（別のテナントの ID を渡されても 404）
//     ③ 二重登録   … すでに社員登録（employee_id）が済んでいる応募者は 409 already_advanced（更新も employee_id が空のときだけ）
//     ④ 状態       … 承諾済み（status=accepted）だけ
//     ⑤ handoff_at … 引き渡し済みの版だけ（409 handoff_required。育成枠・区分なし・db/133 が無い環境は従来どおり）
//     ⑥ 正式契約   … 正式契約が必要な版は署名済み（formal_signed_at）だけ（409 formal_required）
//   そのうえで、社員登録の事前入力・手続きの確保・完了の書き込みへ進む

import { json, readJson, methodNotAllowed } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canAdvanceHire, canSeeSalary } from "../../../lib/gw.js";
import { admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { advancePrefillFromOffer, isAdvanceClaimStale } from "../../../lib/hr.js";
import { handoffPendingOf, formalPendingOf } from "../../../lib/hr-offer-types.js";
import { guardSalaryOutput } from "../../../lib/salary.js";
import { attachPay } from "../../../lib/hr-pay.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // ① 認可。通らなければ、service role は作らない（何も読まない・書かない）
  if (!canAdvanceHire(ctx)) return json(res, 403, { error: "forbidden", hint: "本採用へ進められるのは社長・管理者・人事だけです" });

  // 認可のあとだけ service role。以降の読み書きは、すべて ctx.tenantId（自分のテナント）で絞る
  const sb = admin();
  // 事前入力に給与が入る。見られる人（lib/gw.js canSeeSalary）にだけ返す
  guardSalaryOutput(res, canSeeSalary(ctx));

  if (req.method === "GET") return prefill(req, res, sb, ctx);
  if (req.method === "POST") return claim(req, res, sb, ctx, user);
  if (req.method === "PATCH") return act(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

/**
 * 社員登録へ進めてよい応募者か。②〜⑥ を、この順に確かめる（上の「service role を使う順番」）。
 * 進めてよければ { applicant, accepted }、いけなければ { deny: { status, body } }
 */
async function findAdvancing(sb, ctx, applicantId) {
  const gate = await assertLegacyPdfFlowAbsent(sb, ctx.tenantId, applicantId);
  if (!gate.ok) return { deny: { status: gate.status, body: gate.body } };
  // ② 自分のテナントの応募者だけ
  const { data: a } = await sb.from("gw_hr_applicants").select("*")
    .eq("id", applicantId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!a) return { deny: { status: 404, body: { error: "not_found" } } };
  // ③ 二重登録の防止
  if (a.employee_id) return { deny: ALREADY_ADVANCED };
  // ④ 承諾済みだけ
  if (a.status !== "accepted") {
    return { deny: { status: 409, body: { error: "invalid_state", hint: "承諾済みの応募者だけ、本採用へ進められます" } } };
  }
  const accepted = await acceptedOfferOf(sb, ctx, a.id);
  // ⑤ 引き渡し済み（handoff_at）の版だけ
  if (handoffPendingOf(accepted)) return { deny: HANDOFF_REQUIRED };
  // ⑥ 正式契約が必要な版は署名済みだけ（引き渡しの印だけで通さない）
  if (formalPendingOf(accepted)) return { deny: FORMAL_REQUIRED };
  return { applicant: a, accepted };
}

const ALREADY_ADVANCED = { status: 409, body: { error: "already_advanced", hint: "すでに本採用の手続きが完了しています" } };
const HANDOFF_REQUIRED = { status: 409, body: { error: "handoff_required",
  hint: "まだ Office へ引き渡されていません。採用HRで［承諾内容を確認してOfficeへ引き渡す］を済ませてから、社員登録へ進んでください" } };
const FORMAL_REQUIRED = { status: 409, body: { error: "formal_required",
  hint: "このオファーは正式契約（LegalSign）が必要です。採用HRで正式契約済みにしてから、社員登録へ進んでください" } };

/** 本人が承諾した版（取り消し・辞退していない最新）。読めなければ null（従来どおり応募者の値で進める） */
async function acceptedOfferOf(sb, ctx, applicantId) {
  const { data: offers } = await sb.from("gw_hr_offers").select("*")
    .eq("applicant_id", applicantId).eq("tenant_id", ctx.tenantId).order("version", { ascending: false }).limit(20);
  return (offers || []).find((o) => o.accepted_at && !o.revoked_at && !o.declined_at) || null;
}

// admin-onboard.html?applicantId=… が読む、採用条件の事前入力だけ
// （給与・勤務条件そのものはここでサーバ側から返す。URLには載せない）
async function prefill(req, res, sb, ctx) {
  const applicantId = new URL(req.url, "http://localhost").searchParams.get("applicantId");
  if (!applicantId) return json(res, 400, { error: "invalid_query", required: ["applicantId"] });

  const found = await findAdvancing(sb, ctx, applicantId);
  if (found.deny) return json(res, found.deny.status, found.deny.body);

  // 本人が承諾したオファーの版（Office へ引き渡した版）の条件を土台にする（区分つき。無ければ応募者の値）
  const accepted = found.accepted;
  // 給与の事前入力は、見られる人にだけ（見られない人の応答からは、lib/salary.js が外す）
  if (canSeeSalary(ctx)) {
    await attachPay(ctx.tenantId, found.applicant, "applicant");
    if (accepted) await attachPay(ctx.tenantId, accepted, "offer");
  }
  return json(res, 200, { applicantId: found.applicant.id, prefill: advancePrefillFromOffer(found.applicant, accepted) });
}

async function claim(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.applicantId) return json(res, 400, { error: "invalid_body", required: ["applicantId"] });

  const found = await findAdvancing(sb, ctx, body.applicantId);
  if (found.deny) return json(res, found.deny.status, found.deny.body);
  const a = found.applicant;

  // 自分（か誰か）がすでに処理中で、まだ有効なクレームなら、
  // 二重にロックし直さず、そのまま続きを渡す（同じ人のやり直しを邪魔しない）
  if (a.advance_claimed_at && !isAdvanceClaimStale(a.advance_claimed_at)) {
    return json(res, 200, { applicantId: a.id, resumed: true });
  }

  const now = new Date().toISOString();
  let q = sb.from("gw_hr_applicants").update({ advance_claimed_at: now })
    .eq("id", a.id).eq("tenant_id", ctx.tenantId);
  q = a.advance_claimed_at ? q.eq("advance_claimed_at", a.advance_claimed_at) : q.is("advance_claimed_at", null);
  const { data, error } = await q.select("id").maybeSingle();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 409, { error: "conflict", hint: "直前に手続きが始まりました。もう一度お試しください" });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_advance_claim",
    target: `hr_applicant:${a.id}`, detail: {},
  });
  return json(res, 200, { applicantId: a.id, resumed: false });
}

async function act(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.applicantId) return json(res, 400, { error: "invalid_body", required: ["applicantId"] });

  if (body.action === "release") return release(res, sb, ctx, user, body);
  if (body.action === "complete") return complete(res, sb, ctx, user, body);
  return json(res, 400, { error: "unknown_action" });
}

async function release(res, sb, ctx, user, body) {
  const { data, error } = await sb.from("gw_hr_applicants")
    .update({ advance_claimed_at: null })
    .eq("id", body.applicantId).eq("tenant_id", ctx.tenantId).eq("status", "accepted")
    .select("id").maybeSingle();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "not_found" });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_advance_release",
    target: `hr_applicant:${body.applicantId}`, detail: {},
  });
  return json(res, 200, { ok: true });
}

async function complete(res, sb, ctx, user, body) {
  if (!body?.employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });

  const { data: a } = await sb.from("gw_hr_applicants").select("id, name, employee_id")
    .eq("id", body.applicantId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!a) return json(res, 404, { error: "not_found" });
  if (a.employee_id) return json(res, ALREADY_ADVANCED.status, ALREADY_ADVANCED.body);
  // Office へ引き渡す前の版（正式契約の前の版）で、応募者を確定しない（社員を別の画面から作って結ぶ抜け道も止める）
  const accepted = await acceptedOfferOf(sb, ctx, a.id);
  if (handoffPendingOf(accepted)) return json(res, HANDOFF_REQUIRED.status, HANDOFF_REQUIRED.body);
  if (formalPendingOf(accepted)) return json(res, FORMAL_REQUIRED.status, FORMAL_REQUIRED.body);
  // 同じ会社の社員だけを結びつける（別の会社の社員 ID を渡されても結ばない）
  const { data: emp } = await sb.from("gw_employees").select("id")
    .eq("id", body.employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!emp) return json(res, 404, { error: "employee_not_found", hint: "登録した社員が見つかりません。メンバー一覧で確認してください" });

  const now = new Date().toISOString();
  const { data, error } = await sb.from("gw_hr_applicants")
    .update({ employee_id: body.employeeId, status: "done", advance_claimed_at: null, updated_at: now })
    .eq("id", a.id).eq("tenant_id", ctx.tenantId).is("employee_id", null)
    .select("id").maybeSingle();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, ALREADY_ADVANCED.status, ALREADY_ADVANCED.body);   // 同時に別の人が確定した（employee_id が空のときだけ書く）

  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: a.id, event_key: "advanced",
    label: "本採用（社員登録）完了", created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_advance_complete",
    target: `hr_applicant:${a.id}`, detail: { employeeId: body.employeeId },
  });
  return json(res, 200, { ok: true, status: "done" });
}
