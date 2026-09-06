// GET  /api/onboarding/me            … 自分の入社手続き（1画面ぶん全部）
// POST /api/onboarding/me {profile}  … 途中保存
// POST /api/onboarding/me {profile, submit:true} … 提出
// POST /api/onboarding/me {consents:["pledge",...]} … 同意を記録する
//
// ■ 本人が触る口はここ1つだけ
//   個人情報・書類・同意を、別々の画面に分けない。
//   分けると「どこまで終わったか」が本人にも分からなくなる。
//
// ■ 会社が既に知っていることは、入力させない
//   氏名・メール・入社日・契約・勤務時間・担当業務は、
//   管理者が登録フォームで入れている。ここでは読み取り専用で返す。
//   違っていたら、本人が直すのではなく管理者に言ってもらう
//   （労働条件は合意して決まるもので、片方が書き換えるものではない）。
//
// ■ マイナンバーは受け取らない
//   番号法が求める安全管理措置は、列を1つ足して済む話ではない。
//   書類を出したかだけを見て、番号そのものは持たない（db/037 の冒頭）。
//
// ■ 同意は「読みました。内容に同意します」だけ
//   氏名・日付・サインの欄は無い。誰がいつ何の版に同意したかは、
//   ログインしているアカウントとシステムの時計で決まる。
//   同意した時点の全文を一緒に残す（lib/consent-docs.js）。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import {
  FIELDS, GROUPS, normalizeProfile, missingFields, progressOf,
} from "../../lib/onboard-form.js";
import { syncFormItems } from "../../lib/onboard-kit.js";
import { ensureConsentDocs, consentState, CONSENT_KEYS } from "../../lib/consent-docs.js";
import { DOCS, docOf } from "../../lib/onboard-docs.js";

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

  if (req.method === "GET") return read(res, user, ctx);
  if (req.method === "POST") {
    const body = await readJson(req);
    if (Array.isArray(body?.consents)) return saveConsents(res, user, ctx, body, req);
    return saveProfile(res, user, ctx, body);
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読み取り ---------------------------------------------------------------
async function read(res, user, ctx) {
  const sb = admin();
  const empId = ctx.employee.id;

  // 書類の版をコードから写す。無い版だけ足すので、毎回呼んでよい
  await ensureConsentDocs(sb, ctx.tenantId).catch((e) =>
    console.error("[onboarding/me] 書類の版を写せませんでした:", e.message));

  const [proc, profile, consents, contract, manager, docs] = await Promise.all([
    sb.from("gw_procedures").select("*")
      .eq("employee_id", empId).eq("kind", "onboarding").maybeSingle(),
    sb.from("gw_onboard_profiles").select("*").eq("employee_id", empId).maybeSingle(),
    // 同意の記録は全部返す（版ごと）。マイページの「自分の書類」で、
    // どの版にいつ同意したかと、そのとき読んだ全文を見られるようにする
    sb.from("gw_onboard_consents").select("kind, version, agreed_at, doc_title, body_snapshot")
      .eq("employee_id", empId).order("agreed_at", { ascending: false }),
    // 会社が把握している労働条件。給与は本人にも出す（自分のことなので）
    sb.from("gw_contracts").select("*")
      .eq("employee_id", empId).eq("status", "active")
      .order("created_at", { ascending: false }).limit(1),
    ctx.employee.manager_id
      ? sb.from("gw_employees").select("display_name").eq("id", ctx.employee.manager_id).maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from("gw_consent_docs").select("*")
      .eq("tenant_id", ctx.tenantId).eq("status", "active").order("doc_key"),
  ]);

  let items = [];
  let files = [];
  if (proc.data) {
    const [{ data: its }, { data: fls }] = await Promise.all([
      sb.from("gw_procedure_items")
        .select("id, item_key, title, category, owner, required, status, due_on, note, sort_order, document_id, submitted_at")
        .eq("procedure_id", proc.data.id).order("sort_order").limit(200),
      sb.from("gw_procedure_files")
        .select("id, item_id, filename, mime_type, size_bytes, drive_name, created_at")
        .eq("procedure_id", proc.data.id).order("created_at", { ascending: false }).limit(200),
    ]);
    items = its || [];
    files = fls || [];
  }

  const c = contract.data?.[0] || null;
  const pf = profile.data || null;

  // 本人が出す書類。定義（lib/onboard-docs.js）と、チェックリストの状態を突き合わせる
  const byKey = new Map(items.map((i) => [i.item_key, i]));
  const documents = DOCS.map((d) => {
    const it = byKey.get(d.key) || null;
    const mine = files.filter((f) => f.item_id === it?.id);
    return {
      key: d.key,
      itemId: it?.id || null,
      title: d.title,
      desc: d.desc,
      required: d.required !== false,
      sensitive: !!d.sensitive,
      template: d.template || null,
      status: it?.status || "todo",
      submittedAt: it?.submitted_at || mine[0]?.created_at || null,
      files: mine.map((f) => ({ id: f.id, filename: f.filename, driveName: f.drive_name, at: f.created_at })),
    };
  });

  return json(res, 200, {
    // 画面の組み立てはサーバ側の定義から。2か所に同じものを書かない
    fields: FIELDS,
    groups: GROUPS,
    // 同意してもらう書類。版・全文・同意の状態。
    // 全文をここで返すのは、3つとも短く、別に取りに行かせる理由が無いため
    consents: consentState(docs.data || [], consents.data || []),
    // 同意の履歴。「誓約書 Ver.1.0　2026/09/06 同意済み」を出すのに使う
    consentHistory: (consents.data || []).map((x) => ({
      key: x.kind, title: x.doc_title, version: x.version,
      agreedAt: x.agreed_at, body: x.body_snapshot,
    })),
    documents,

    procedureId: proc.data?.id || null,
    status: proc.data?.status || null,
    targetOn: proc.data?.target_on || null,

    // 会社が既に知っていること。読み取り専用で見せる
    known: {
      name: ctx.employee.display_name,
      email: ctx.employee.email,
      joinedOn: ctx.employee.joined_on,
      employmentType: ctx.employee.employment_type,
      role: c?.job_content || ctx.employee.initial_role,
      workScope: Array.isArray(c?.work_scope) ? c.work_scope : [],
      workStyle: c?.work_style || ctx.employee.work_style,
      weeklyHours: c?.weekly_hours ?? null,
      contract: c?.fixed_term
        ? `有期（${c.period_from} 〜 ${c.period_to || "—"}）`
        : c ? "無期" : null,
      probation: c?.probation_months ? `${c.probation_months}か月` : null,
      wage: c?.wage_amount
        ? `${c.wage_type || ""} ${Number(c.wage_amount).toLocaleString("ja-JP")}円`
          + (c.wage_note ? `（${c.wage_note}）` : "")
        : null,
      manager: manager.data?.display_name || null,
    },

    profile: pf,
    profileStatus: pf?.status || "draft",
    missing: missingFields(pf || {}),

    // 定義に無い、人が手で足した本人向け項目。あれば一緒に出す
    myItems: items.filter((i) => i.owner === "employee" && !docOf(i.item_key)
                          && !String(i.item_key || "").startsWith("form_")),
    // 進み具合は全体で数える。「あと何%で入社準備が終わるか」を見せる
    progress: progressOf(items),
  });
}

// ---- 個人情報の保存・提出 -----------------------------------------------------
async function saveProfile(res, user, ctx, body) {
  const sb = admin();
  const empId = ctx.employee.id;
  const values = normalizeProfile(body?.profile || {});

  // 出すときだけ、必須の埋まりを見る。途中保存は何度でもできる
  if (body?.submit) {
    const miss = missingFields(values);
    if (miss.length) {
      return json(res, 400, {
        error: "incomplete",
        missing: miss,
        hint: `${miss.map((m) => m.label).join("・")} が空です`,
      });
    }
    // 同意が全部そろっていないと出せない。
    // 出したあとで「まだ読んでいない」が残るのは、本人にとっても困る
    const [{ data: agreed }, { data: docs }] = await Promise.all([
      sb.from("gw_onboard_consents").select("kind, version, agreed_at").eq("employee_id", empId),
      sb.from("gw_consent_docs").select("*").eq("tenant_id", ctx.tenantId).eq("status", "active"),
    ]);
    const notYet = consentState(docs || [], agreed || []).filter((c) => !c.agreed);
    if (notYet.length) {
      return json(res, 400, {
        error: "consent_required",
        hint: `${notYet.map((c) => c.title).join("・")} の確認が残っています`,
      });
    }
  }

  const { data, error } = await sb.from("gw_onboard_profiles").upsert({
    ...values,
    tenant_id: ctx.tenantId,
    employee_id: empId,
    user_id: user.id,                        // 画面から来た値は使わない
    ...(body?.submit ? { status: "submitted", submitted_at: new Date().toISOString() } : {}),
    updated_at: new Date().toISOString(),
  }, { onConflict: "employee_id" }).select("*").single();
  if (error) return json(res, 500, { error: "db_upsert_failed", detail: error.message });

  await reflect(sb, empId);
  return json(res, 200, { ok: true, profile: data, submitted: data.status === "submitted" });
}

// ---- 同意 ---------------------------------------------------------------------
// 3つまとめて1回で記録する。画面のチェックは押した時点では何も送らず、
// 「すべて確認して入社手続きを完了」で一度に送る。
//
// 残すもの：誰が（user_id・氏名）、何に（書類ID・題名・版）、いつ、
//           何を読んだか（同意時点の全文）、どこから（IP・端末）。
// 取り消しはここでは扱わない。いつ同意したかの記録なので、消さない
async function saveConsents(res, user, ctx, body, req) {
  const sb = admin();
  const empId = ctx.employee.id;

  const keys = body.consents.filter((k) => CONSENT_KEYS.includes(k));
  if (!keys.length) return json(res, 400, { error: "unknown_consent" });

  const { data: docs } = await sb.from("gw_consent_docs").select("*")
    .eq("tenant_id", ctx.tenantId).eq("status", "active").in("doc_key", keys);
  if (!docs?.length) return json(res, 500, { error: "docs_missing", hint: "書類の版が用意できていません" });

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "")
    .split(",")[0].trim().slice(0, 64) || null;
  const ua = String(req.headers["user-agent"] || "").slice(0, 300) || null;
  const now = new Date().toISOString();

  const { error } = await sb.from("gw_onboard_consents").upsert(
    docs.map((d) => ({
      tenant_id: ctx.tenantId,
      employee_id: empId,
      user_id: user.id,                       // 画面から来た値は使わない
      display_name: ctx.employee.display_name,
      kind: d.doc_key,
      version: d.version,
      doc_id: d.id,
      doc_title: d.title,
      body_snapshot: d.body,                  // 同意した時点の全文
      ip, user_agent: ua,
      agreed_at: now,
    })), { onConflict: "employee_id,kind,version", ignoreDuplicates: true });
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

  await reflect(sb, empId);
  return json(res, 200, { ok: true, agreed: docs.map((d) => `${d.title} Ver.${d.version}`), at: now });
}

/**
 * フォームの状態をチェックリストに映す。
 * 本人が出したのにチェックが付いていない、が起きないようにする
 */
async function reflect(sb, empId) {
  try {
    const [{ data: proc }, { data: pf }, { data: cs }, { data: docs }] = await Promise.all([
      sb.from("gw_procedures").select("id, tenant_id")
        .eq("employee_id", empId).eq("kind", "onboarding").maybeSingle(),
      sb.from("gw_onboard_profiles").select("status").eq("employee_id", empId).maybeSingle(),
      sb.from("gw_onboard_consents").select("kind, version, agreed_at").eq("employee_id", empId),
      sb.from("gw_consent_docs").select("*").eq("status", "active"),
    ]);
    if (!proc) return;

    const mine = (docs || []).filter((d) => d.tenant_id === proc.tenant_id);
    await syncFormItems(sb, proc.id, {
      profileSubmitted: pf?.status === "submitted",
      consentDone: mine.length > 0 && consentState(mine, cs || []).every((c) => c.agreed),
    });
  } catch (e) {
    // 映せなくても保存は成立している。管理画面から手で付けられる
    console.error("[onboarding/me] チェックリストに反映できませんでした:", e.message);
  }
}
