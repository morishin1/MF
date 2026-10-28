import { readPdfFlowSummaries } from "../../../lib/hr-pdf-flow-guard.js";
// GET  /api/hr/applicants          … 応募者一覧（ダッシュボード・応募者一覧・CEO REVIEWで共通利用）
//      ?category=recruitment（既定）| mugendojo | internship | other | all
//      既定は採用（＝専用の流れを持つ区分〔無限道場〕以外。インターン等は採用と同じ選考段階を使う）。
//      無限道場リード（db/118）を採用のダッシュボード・ファネルに混ぜない。
//      応募者一覧の「すべて／採用／無限道場」は all で取り、画面で分ける
// POST /api/hr/applicants { name, jobTitle, source, ... } … 応募者を追加
//
// ダッシュボード・採用ファネル・通知の元ネタは、すべてこの一覧から
// 画面側で組み立てる（別に集計テーブルは作らない。README「State Management」の方針と同じ）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit, canSeeSalary } from "../../../lib/gw.js";
import { guardSalaryOutput } from "../../../lib/salary.js";
import { attachPay, payFailed } from "../../../lib/hr-pay.js";
import { userClient, admin } from "../../../lib/supabase.js";
import {
  shapeApplicant, pickNextInterview, readOfferTypes, readFormalStates,
  withContactNext, applicantAlerts, applicantPriority, APPLICANT_SOURCES, sourceStats,
} from "../../../lib/hr.js";
import { createApplicant, applicantColumns as columns, APPLICANT_SQL as SQL } from "../../../lib/hr-applicant-create.js";
import { ymd as jstYmd } from "../../../lib/jst.js";
import { docStatusOf } from "../../../lib/hr-docs.js";
import { contactStatusOf, CONTACT_EVENT_KEYS } from "../../../lib/hr-messages.js";
import { selectWithLeadFields, LEAD_CATEGORIES } from "../../../lib/hr-leads.js";
import { DEDICATED_CATEGORIES } from "../../../lib/hr-timerex-calendars.js";
import { readContractStates } from "../../../lib/hr-contract-db.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);
  // 給与は、見られる人（lib/gw.js canSeeSalary）にだけ返す。採用担当・責任者には返さない
  const salary = guardSalaryOutput(res, canSeeSalary(ctx));

  if (req.method === "GET") return list(req, res, sb, ctx, salary);
  if (req.method === "POST") return create(req, res, sb, ctx, user, salary);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function list(req, res, sb, ctx, salary) {
  const want = new URL(req.url || "/", "http://localhost").searchParams.get("category") || "recruitment";
  if (want !== "all" && !LEAD_CATEGORIES.includes(want)) {
    return json(res, 400, { error: "invalid_query", detail: `category は all / ${LEAD_CATEGORIES.join(" / ")} のいずれかです` });
  }
  // リードの列（db/118）が無い環境では、全員が採用。区分では絞れないので、採用・すべては全員、それ以外は0人
  const query = (fields, withCategory) => {
    let q = sb.from("gw_hr_applicants").select(fields).eq("tenant_id", ctx.tenantId);
    if (withCategory && want === "recruitment") for (const c of DEDICATED_CATEGORIES) q = q.neq("lead_category", c);
    else if (withCategory && want !== "all") q = q.eq("lead_category", want);
    return q.order("created_at", { ascending: false }).limit(1000);
  };
  const first = await selectWithLeadFields(query, columns(salary));
  const { error, leadReady } = first;
  let { data } = first;
  if (!error && !leadReady && !["all", "recruitment"].includes(want)) data = [];
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { applicants: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  // 給与を見られる人にだけ、給与を足す（分けていない設定なら何もしない）。
  // 下の取得（担当・面談・書類）とは互いに待つ理由がないので、同時に出す（直列にしていたぶん、1往復待っていた）
  //   失敗はいままでどおり投げる（待つまでのあいだ「受け手の無い失敗」にしないよう、いったん値で受ける）
  const payAttached = salary
    ? attachPay(ctx.tenantId, data || [], "applicant").then(() => null, (e) => e) : Promise.resolve(null);

  const ids = (data || []).map((a) => a.id);
  // 合格後の採用区分（db/129）。状態・NEXT の言い方が区分で変わる。列がまだ無い環境では区分なしとして扱う
  const offerTypes = await readOfferTypes(sb, ctx.tenantId, ids);
  for (const a of data || []) a.offer_type = offerTypes.byId.get(a.id) ?? null;
  // 条件を承諾した人の、正式契約（LegalSign）の段階（db/132。正式契約待ち／正式契約済み）。列が無ければ数えない
  const acceptedIds = (data || []).filter((a) => a.status === "accepted").map((a) => a.id);
  if (acceptedIds.length) {
    const formal = await readFormalStates(sb, ctx.tenantId, acceptedIds);
    for (const a of data || []) Object.assign(a, formal.byId.get(a.id) || { formal_state: null });
  }
  // 社労士の正式PDFで進める人の、契約手続きの状態（社労士へ依頼待ち／依頼済み／書類受領・確認待ち…。db/139 が無ければ載せない）
  const contract = await readContractStates(sb, ctx.tenantId, data || []);
  for (const a of data || []) if (contract.has(a.id)) a.contract_state = contract.get(a.id);
  // 本人への連絡状況（判断済みの人だけ。タイムラインの判断・連絡の記録から決める。lib/hr-messages.js）
  // 無限道場リードの decision（保留・対象外。lib/hr-lead-flow.js）は採用の選考結果ではないので数えない
  const decidedIds = (data || []).filter((a) => a.decision && a.lead_category !== "mugendojo").map((a) => a.id);
  const contactEventsP = decidedIds.length
    ? Promise.resolve(sb.from("gw_hr_timeline").select("applicant_id, event_key, occurred_at")
      .in("applicant_id", decidedIds).in("event_key", CONTACT_EVENT_KEYS).limit(5000))
      .then((r) => (r.error ? [] : r.data || []), () => [])
    : Promise.resolve([]);
  const recruiterIds = [...new Set((data || []).map((a) => a.recruiter_id).filter(Boolean))];
  const [{ data: recruiters }, { data: interviewCounts }, { data: employees }, docs] = await Promise.all([
    recruiterIds.length
      ? sb.from("gw_employees").select("id, display_name").in("id", recruiterIds)
      : Promise.resolve({ data: [] }),
    ids.length
      ? sb.from("gw_hr_interviews").select("id, applicant_id, kind, scheduled_at, conducted_at, canceled_at")
        .in("applicant_id", ids).limit(5000)
      : Promise.resolve({ data: [] }),
    // 担当変更（一覧の複数選択操作）の選択肢。既存の面談担当ピッカーと同じ条件
    sb.from("gw_employees").select("id, display_name").eq("tenant_id", ctx.tenantId)
      .in("status", ["active", "invited"]).order("display_name").limit(300),
    // 書類のそろい具合（履歴書・職務経歴書）。093 未適用なら出さないだけ
    ids.length
      ? Promise.resolve(sb.from("gw_hr_documents").select("id, applicant_id, doc_type, deleted_at, created_at")
        .eq("tenant_id", ctx.tenantId).in("applicant_id", ids).limit(5000))
        .then((r) => (r.error ? null : r.data || []), () => null)
      : Promise.resolve([]),
  ]);
  const contactEvents = await contactEventsP;
  const eventsOf = new Map();
  for (const e of contactEvents) {
    if (!eventsOf.has(e.applicant_id)) eventsOf.set(e.applicant_id, []);
    eventsOf.get(e.applicant_id).push(e);
  }
  const payError = await payAttached;
  if (payError) throw payError;
  const recruiterName = new Map((recruiters || []).map((e) => [e.id, e.display_name]));
  const interviewCount = new Map();
  const interviewsOf = new Map();
  for (const i of interviewCounts || []) {
    interviewCount.set(i.applicant_id, (interviewCount.get(i.applicant_id) || 0) + 1);
    if (!interviewsOf.has(i.applicant_id)) interviewsOf.set(i.applicant_id, []);
    interviewsOf.get(i.applicant_id).push(i);
  }
  // NEXT ACTION が指す面談（詳細と同じ判定）。面談予定なのに有効な面談が無い応募者は、
  // 一覧でも「面談予定の記録を確認してください」になる（「実施済みにする」を出さない）
  const nextOf = (a) => {
    const n = pickNextInterview(a, interviewsOf.get(a.id) || []);
    return n ? { id: n.id, scheduledAt: n.scheduled_at, kind: n.kind } : null;
  };

  const pdfFlow = await readPdfFlowSummaries(admin(), ctx.tenantId, (data || []).map(a => a.id));
  const today = jstYmd();
  return json(res, 200, {
    applicants: (data || []).map((a) => {
      const s = withContactNext({
        ...shapeApplicant(a, nextOf(a)),
        // 直近の面談日時（#43：面談日時を変えたら一覧にも出る。NEXT ACTION と同じ面談）
        nextInterviewAt: nextOf(a)?.scheduledAt || null,
        recruiterName: recruiterName.get(a.recruiter_id) || null,
        interviewCount: interviewCount.get(a.id) || 0,
        docs: docs ? docStatusOf(docs.filter((d) => d.applicant_id === a.id)) : null,
        contact: contactStatusOf(a.lead_category === "mugendojo" ? null : a.decision, eventsOf.get(a.id)),
      });
      // 警告（起きてはいけない状態）と、毎日の確認順（期限超過 → 今日 → 新規 → その他。lib/hr.js）
      return { ...s, pdfFlow: pdfFlow.byApplicant.get(a.id) || null, pdfFlowEnabled: pdfFlow.enabled, pdfFlowReady: pdfFlow.ready, alerts: applicantAlerts(s), priority: applicantPriority(s, today) };
    }),
    employees: employees || [],
    // 応募媒体：固定候補と、現在の一覧（category=allなら全応募者）の件数
    sources: { options: APPLICANT_SOURCES, counts: sourceStats(data || []) },
    // 応募者を追加するとき、担当の初期値（登録する本人）
    meEmployeeId: ctx.employee?.id || null,
    // 給与の欄を出してよいか（画面の出し分け用。値そのものは、見られない人には返らない）
    salaryVisible: salary,
    // どの区分で取ったか・リードの列（db/118）があるか（無ければ画面は無限道場の欄を出さない）
    category: want, leadReady,
  });
}

async function create(req, res, sb, ctx, user, salary) {
  const body = await readJson(req);
  // 登録の中身は lib/hr-applicant-create.js（採用メール新着受付からの登録と同じ処理）
  const r = await createApplicant({ sb, ctx, user, body, salary });
  if (r.payError) return payFailed(res, r.payError, r.rollback);
  return json(res, r.status, r.body);
}
