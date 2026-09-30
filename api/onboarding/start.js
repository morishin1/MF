// GET  /api/onboarding/start[?t=<案内URLのトークン>]   … 本人の入社準備（6ステップ・入社案内）
// POST /api/onboarding/start {action:"confirm_guide", version}  … 入社案内を確認した、を記録する
//
// ■ 本人の画面（/onboarding/）の入口
//   6ステップ（入社案内確認 / 雇用契約 / 入社情報入力 / 必要書類提出 / 会社確認 / 入社準備完了）は、
//   lib/onboard-six.js が、既存の判定（段階 computeStage・キャリア careerStatus）から並べる。
//   ここで新しく判定しない。ログインしている本人の、自分の分だけを返す（employee_id は ctx から）。
//
// ■ 出さないもの
//   給与・手当などの金額は、この画面に一切出さない（労働条件通知書は、契約の画面で本人が確認する）。
//   社内準備の内訳（PC・アカウントの項目）も出さず、「会社が確認しています」だけ。
//
// ■ 入力・提出・署名は、これまでの画面で
//   契約は /contracts.html、入社情報・必要書類・誓約書・オリエンテーションは /onboarding.html。
//   作り直さない。ここは「いまどこか・次に何をするか」と、入社案内の確認だけ。
//
// ■ 案内URL（t）
//   ログイン後に t が付いていれば、そのURLが本人のものか確かめる（別の人のアカウントで開いていたら断る）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { findProcedure } from "../../lib/onboard-kit.js";
import { gatherFacts } from "../../lib/onboard-advance.js";
import { stageFlags } from "../../lib/onboard-stage.js";
import { mapSix } from "../../lib/onboard-six.js";
import { guideView, guideFact, GUIDE_FIELDS } from "../../lib/onboard-guide.js";
import { sha256, TOKEN_RE } from "../../lib/hr.js";

const SQL = "db/104_onboarding_guide.sql";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  res.setHeader?.("Cache-Control", "no-store");

  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, { error: "no_employee", hint: "社員名簿にあなたの行がありません。管理者に登録を依頼してください。" });
  }
  const sb = admin();

  try {
    if (req.method === "POST") {
      const body = (await readJson(req)) || {};
      if (body.action !== "confirm_guide") return json(res, 400, { error: "invalid_action", actions: ["confirm_guide"] });
      return await confirmGuide(res, sb, ctx, user, body);
    }
    const t = new URL(req.url, "http://localhost").searchParams.get("t");
    if (t) {
      const bad = await checkInvite(sb, ctx, String(t));
      if (bad) return json(res, bad.status, bad.body);
    }
    return json(res, 200, await read(sb, ctx));
  } catch (e) {
    console.error("[onboarding/start]", e?.message || e);
    return json(res, 500, { error: "start_failed", detail: String(e?.message || e) });
  }
}

/** 案内URLが、ログインしている本人のものか。別の人のURLなら断る（何も返さない） */
async function checkInvite(sb, ctx, token) {
  if (!TOKEN_RE.test(token)) return null;       // 形式が違うURLは、ここでは何もしない（ログイン後は自分の分が出る）
  const { data } = await sb.from("gw_onboarding_invites").select("employee_id, tenant_id")
    .eq("token_hash", sha256(token)).maybeSingle();
  if (data && (data.employee_id !== ctx.employee.id || data.tenant_id !== ctx.tenantId)) {
    return { status: 403, body: { error: "wrong_account", hint: "このURLは、別の方あてです。ログインしているアカウントをご確認ください。" } };
  }
  return null;
}

async function loadGuide(sb, ctx) {
  const { data, error } = await sb.from("gw_onboarding_guides")
    .select("id, version, confirmed_version, confirmed_at")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", ctx.employee.id).maybeSingle();
  if (error) return { row: null, linked: !dbSetupHint(error, SQL), error };
  return { row: data || null, linked: true, error: null };
}

/** 6ステップの、本人向けの「押す先」（入力・署名は、これまでの画面で行う） */
function ctaOf(step, x, six) {
  if (step.state !== "current" || step.actor !== "employee") return null;
  if (step.key === "guide") return { label: "入社案内を確認する", action: "guide" };
  if (step.key === "contract") {
    return x && !x.signed
      ? { label: "労働条件通知書を確認して署名する", href: "/contracts.html" }
      : { label: "誓約書などを確認する", href: "/onboarding.html#consents-card" };
  }
  if (step.key === "info") return { label: "入社情報を入力する", href: "/onboarding.html#step-3" };
  if (step.key === "docs") return { label: "必要書類を提出する", href: "/onboarding.html#step-4" };
  return null;
}

async function read(sb, ctx) {
  const e = ctx.employee;
  const proc = await findProcedure(sb, e.id, "onboarding").catch(() => ({ row: null }));
  const procedure = proc?.row && proc.row.status !== "cancelled" ? proc.row : null;
  let facts = null;
  if (procedure) { try { facts = await gatherFacts(sb, ctx.tenantId, procedure); } catch { facts = null; } }

  const g = await loadGuide(sb, ctx);
  let issue = null;
  if (g.row?.version > 0) {
    const { data } = await sb.from("gw_onboarding_guide_issues").select("snapshot, version")
      .eq("guide_id", g.row.id).eq("version", g.row.version).maybeSingle();
    issue = data || null;
  }
  const { data: careers } = await sb.from("gw_employee_careers").select("*")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", e.id).eq("is_active", true).limit(1);
  const { data: tenant } = await sb.from("tenants").select("name").eq("id", ctx.tenantId).maybeSingle();

  const six = mapSix({ facts, career: (careers || [])[0] || null, guide: guideFact(g.row), guideLinked: g.linked, audience: "self" });
  const x = facts ? stageFlags(facts) : null;
  for (const s of six.steps) s.cta = ctaOf(s, x, six);
  if (six.after) six.after.cta = six.after.actor === "employee" ? { label: "キャリアプランを確認する", href: "/career.html#confirm" } : null;
  six.next.cta = (six.steps.find((s) => s.key === six.next.key) || {}).cta || null;

  return {
    companyName: tenant?.name || null,
    employee: { name: e.display_name, department: e.department || null, position: e.position || null,
      joinOn: procedure?.target_on || e.joined_on || null },
    hasProcedure: Boolean(procedure),
    six,
    guide: {
      issued: Boolean(issue),
      version: g.row?.version || 0,
      confirmed: Boolean(issue) && g.row.confirmed_version != null && g.row.confirmed_version >= g.row.version,
      confirmedAt: g.row?.confirmed_at || null,
      view: issue ? guideView(issue.snapshot) : null,
      fields: GUIDE_FIELDS.map((f) => ({ key: f.key, label: f.label })),
    },
    // 入力・署名・提出は、これまでの画面で
    links: { contracts: "/contracts.html", form: "/onboarding.html" },
  };
}

async function confirmGuide(res, sb, ctx, user, body) {
  const g = await loadGuide(sb, ctx);
  if (!g.linked) return json(res, 503, { error: "not_ready", message: `この機能に必要なテーブルがまだ作られていません。管理者に ${SQL} の実行を依頼してください` });
  if (!g.row || !(g.row.version > 0)) return json(res, 409, { error: "guide_not_issued", hint: "入社案内はまだ届いていません" });
  const version = Number(body.version);
  if (!Number.isInteger(version) || version !== g.row.version) {
    // 読んでいるあいだに、会社が案内を出し直した。新しい版を読み直してもらう
    return json(res, 409, { error: "version_changed", hint: "入社案内が更新されました。もう一度、内容をご確認ください" });
  }
  // すでに、この版を確認している（二重に押した）: 最初の確認日時を残したまま、成功として返す
  if (!(g.row.confirmed_version != null && g.row.confirmed_version >= version)) {
    const now = new Date().toISOString();
    const { error } = await sb.from("gw_onboarding_guides").update({ confirmed_version: version, confirmed_at: now })
      .eq("id", g.row.id).eq("tenant_id", ctx.tenantId).eq("employee_id", ctx.employee.id);
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "onboarding.guide_confirm",
      target: `employee:${ctx.employee.id}`, detail: { version } });
  }
  return json(res, 200, await read(sb, ctx));
}
