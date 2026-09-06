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

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import {
  FIELDS, GROUPS, CONSENTS, normalizeProfile, missingFields, progressOf,
} from "../../lib/onboard-form.js";
import { syncFormItems } from "../../lib/onboard-kit.js";

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
    if (Array.isArray(body?.consents)) return saveConsents(res, user, ctx, body);
    return saveProfile(res, user, ctx, body);
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読み取り ---------------------------------------------------------------
async function read(res, user, ctx) {
  const sb = admin();
  const empId = ctx.employee.id;

  const [proc, profile, consents, contract, manager] = await Promise.all([
    sb.from("gw_procedures").select("*")
      .eq("employee_id", empId).eq("kind", "onboarding").maybeSingle(),
    sb.from("gw_onboard_profiles").select("*").eq("employee_id", empId).maybeSingle(),
    sb.from("gw_onboard_consents").select("kind, version, agreed_at").eq("employee_id", empId),
    // 会社が把握している労働条件。給与は本人にも出す（自分のことなので）
    sb.from("gw_contracts").select("*")
      .eq("employee_id", empId).eq("status", "active")
      .order("created_at", { ascending: false }).limit(1),
    ctx.employee.manager_id
      ? sb.from("gw_employees").select("display_name").eq("id", ctx.employee.manager_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  let items = [];
  if (proc.data) {
    const { data } = await sb.from("gw_procedure_items")
      .select("id, item_key, title, category, owner, required, status, due_on, note, sort_order, document_id")
      .eq("procedure_id", proc.data.id).order("sort_order").limit(200);
    items = data || [];
  }

  const c = contract.data?.[0] || null;
  const pf = profile.data || null;
  const agreed = new Set((consents.data || []).map((x) => `${x.kind}:${x.version}`));

  return json(res, 200, {
    // 画面の組み立てはサーバ側の定義から。2か所に同じものを書かない
    fields: FIELDS,
    groups: GROUPS,
    consents: CONSENTS.map((x) => ({ ...x, agreed: agreed.has(`${x.kind}:${x.version}`) })),

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

    // 本人が出す書類だけ。会社側の準備タスクは本人の画面に出さない
    // （自分が何をすればよいかだけが見えるようにする）
    myItems: items.filter((i) => i.owner === "employee"),
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
    const { data: agreed } = await sb.from("gw_onboard_consents")
      .select("kind, version").eq("employee_id", empId);
    const have = new Set((agreed || []).map((x) => `${x.kind}:${x.version}`));
    const notYet = CONSENTS.filter((c) => !have.has(`${c.kind}:${c.version}`));
    if (notYet.length) {
      return json(res, 400, {
        error: "consent_required",
        hint: `${notYet.map((c) => c.label).join("・")} の確認が残っています`,
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
// 取り消しはここでは扱わない。いつ同意したかの記録なので、消さない
async function saveConsents(res, user, ctx, body) {
  const sb = admin();
  const empId = ctx.employee.id;

  const wanted = CONSENTS.filter((c) => body.consents.includes(c.kind));
  if (!wanted.length) return json(res, 400, { error: "unknown_consent" });

  const { error } = await sb.from("gw_onboard_consents").upsert(
    wanted.map((c) => ({
      tenant_id: ctx.tenantId,
      employee_id: empId,
      user_id: user.id,
      kind: c.kind,
      version: c.version,
    })), { onConflict: "employee_id,kind,version", ignoreDuplicates: true });
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

  await reflect(sb, empId);
  return json(res, 200, { ok: true, agreed: wanted.map((c) => c.kind) });
}

/**
 * フォームの状態をチェックリストに映す。
 * 本人が出したのにチェックが付いていない、が起きないようにする
 */
async function reflect(sb, empId) {
  try {
    const [{ data: proc }, { data: pf }, { data: cs }] = await Promise.all([
      sb.from("gw_procedures").select("id")
        .eq("employee_id", empId).eq("kind", "onboarding").maybeSingle(),
      sb.from("gw_onboard_profiles").select("status").eq("employee_id", empId).maybeSingle(),
      sb.from("gw_onboard_consents").select("kind, version").eq("employee_id", empId),
    ]);
    if (!proc) return;

    const have = new Set((cs || []).map((x) => `${x.kind}:${x.version}`));
    await syncFormItems(sb, proc.id, {
      profileSubmitted: pf?.status === "submitted",
      consentDone: CONSENTS.every((c) => have.has(`${c.kind}:${c.version}`)),
    });
  } catch (e) {
    // 映せなくても保存は成立している。管理画面から手で付けられる
    console.error("[onboarding/me] チェックリストに反映できませんでした:", e.message);
  }
}
