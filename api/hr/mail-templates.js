// 採用HR：応募者へ送るメールのひな型（db/124・lib/hr-mail-template.js）。採用HRを使える人（canRecruit）だけ。
//
// GET  /api/hr/mail-templates
//        … 一覧（使用中・非表示の両方。ひな型名・用途・使用状態・既定・更新日・版）。標準のひな型がまだ無ければ1回だけ入れる
// POST /api/hr/mail-templates {action:"create", name, purpose, subject, body}
// POST /api/hr/mail-templates {action:"update", id, version, name, purpose, subject, body}
//        … version は画面が読んだときの版。違えば 409（ほかの人の変更を上書きしない）。直すと版が1つ上がる
// POST /api/hr/mail-templates {action:"duplicate", id}         … 複製（非既定・使用中・標準の印は付けない）
// POST /api/hr/mail-templates {action:"set_active", id, active} … 使用／非表示（非表示にすると既定も外れる。消さない）
// POST /api/hr/mail-templates {action:"set_default", id}        … その用途の既定にする（使用中だけ）
//
// ■ テナント
//   どの操作も、ログインした人のテナントのひな型だけ（id を渡されても、他社のものは 404）。
//   表の読み書きは service role で、テナントと権限はここで確かめる（RLS は読み取りだけ・採用HR）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canRecruit } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  PURPOSES, PURPOSE_KEYS, MAIL_FIELDS, STANDARD_TEMPLATES, NAME_MAX, SUBJECT_MAX, BODY_MAX, tagsIn, purposeLabel,
} from "../../lib/hr-mail-template.js";

const SQL = "db/124_hr_mail_templates.sql";
const FIELDS = "id, tenant_id, name, purpose, subject, body, is_active, is_default, version, seed_key, updated_at, created_at";
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });
  const sb = admin();
  try {
    if (req.method === "GET") return await list(res, sb, ctx, user);
    if (req.method === "POST") return await act(req, res, sb, ctx, user);
  } catch (e) {
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[hr/mail-templates]", e?.message || e);
    return json(res, 500, { error: "mail_templates_failed" });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

export const shapeTemplate = (t) => ({
  id: t.id, name: t.name, purpose: t.purpose, purposeLabel: purposeLabel(t.purpose),
  subject: t.subject, body: t.body, active: Boolean(t.is_active), isDefault: Boolean(t.is_default),
  version: t.version, standard: Boolean(t.seed_key), updatedAt: t.updated_at, createdAt: t.created_at,
});

/** 標準のひな型を、テナントに無ければ1回だけ入れる（seed_key の一意で、2回目以降・直した後は何もしない） */
export async function ensureStandard(sb, ctx) {
  for (const s of STANDARD_TEMPLATES) {
    const had = await must(sb.from("gw_hr_mail_templates").select("id").eq("tenant_id", ctx.tenantId).eq("seed_key", s.seedKey).limit(1));
    if (had?.length) continue;
    const anyDefault = await must(sb.from("gw_hr_mail_templates").select("id")
      .eq("tenant_id", ctx.tenantId).eq("purpose", s.purpose).eq("is_default", true).limit(1));
    const { error } = await sb.from("gw_hr_mail_templates").insert({
      tenant_id: ctx.tenantId, name: s.name, purpose: s.purpose, subject: s.subject, body: s.body,
      is_active: true, is_default: !anyDefault?.length, version: 1, seed_key: s.seedKey,
    });
    // 同時に開いた人が先に入れた（一意の索引）。それでよい
    if (error && error.code !== "23505") throw error;
  }
}

async function list(res, sb, ctx) {
  await ensureStandard(sb, ctx);
  const rows = await must(sb.from("gw_hr_mail_templates").select(FIELDS).eq("tenant_id", ctx.tenantId)
    .order("is_active", { ascending: false }).order("updated_at", { ascending: false }).limit(300));
  return json(res, 200, { templates: (rows || []).map(shapeTemplate), purposes: PURPOSES, fields: MAIL_FIELDS });
}

/** 入力の確かめ。問題があれば {status, error, hint, problems} */
function validate(b) {
  const name = String(b?.name ?? "").trim();
  const purpose = PURPOSE_KEYS.includes(b?.purpose) ? b.purpose : null;
  const subject = String(b?.subject ?? "").trim();
  const body = String(b?.body ?? "").replace(/\r\n/g, "\n");
  const problems = [];
  if (!name || name.length > NAME_MAX) problems.push(`ひな型名を${NAME_MAX}文字以内で入れてください`);
  if (!purpose) problems.push("用途を選んでください");
  if (!subject || subject.length > SUBJECT_MAX) problems.push(`件名を${SUBJECT_MAX}文字以内で入れてください`);
  if (/[\r\n]/.test(subject)) problems.push("件名に改行は使えません");
  if (!body.trim() || body.length > BODY_MAX) problems.push(`本文を${BODY_MAX}文字以内で入れてください`);
  const { unknown } = tagsIn(subject, body);
  if (unknown.length) problems.push(`使えない差し込み項目があります：${unknown.map((u) => `{{${u}}}`).join("・")}（挿入ボタンから入れてください）`);
  if (problems.length) return { bad: { status: 400, error: "invalid_template", hint: problems[0], problems } };
  return { value: { name, purpose, subject, body } };
}

async function load(sb, ctx, id) {
  if (!id) return null;
  return must(sb.from("gw_hr_mail_templates").select(FIELDS).eq("id", String(id)).eq("tenant_id", ctx.tenantId).maybeSingle());
}

async function act(req, res, sb, ctx, user) {
  const b = await readJson(req);
  const action = String(b?.action || "");
  const now = new Date().toISOString();
  const log = (what, t, detail = {}) => gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: `hr.mail_template.${what}`,
    target: `hr_mail_template:${t.id}`, detail: { name: t.name, version: t.version, ...detail } });

  if (action === "create") {
    const v = validate(b);
    if (v.bad) return json(res, v.bad.status, v.bad);
    const row = await must(sb.from("gw_hr_mail_templates").insert({
      tenant_id: ctx.tenantId, ...v.value, is_active: true, is_default: false, version: 1,
      created_by: user.id, updated_by: user.id,
    }).select(FIELDS).single());
    await log("create", row);
    return json(res, 200, { template: shapeTemplate(row) });
  }

  const t = await load(sb, ctx, b?.id);
  if (!t) return json(res, 404, { error: "not_found" });

  if (action === "update") {
    if (Number(b.version) !== t.version) {
      return json(res, 409, { error: "conflict", hint: "ほかの人が先にこのひな型を直しました。開き直してから、もう一度直してください（上書きはしていません）" });
    }
    const v = validate(b);
    if (v.bad) return json(res, v.bad.status, v.bad);
    const patch = { ...v.value, version: t.version + 1, updated_by: user.id, updated_at: now };
    if (v.value.purpose !== t.purpose) patch.is_default = false;     // 用途を変えたら、前の用途の既定は外す
    const row = await must(sb.from("gw_hr_mail_templates").update(patch)
      .eq("id", t.id).eq("tenant_id", ctx.tenantId).eq("version", t.version).select(FIELDS).maybeSingle());
    if (!row) return json(res, 409, { error: "conflict", hint: "ほかの人が先にこのひな型を直しました。開き直してください" });
    await log("update", row);
    return json(res, 200, { template: shapeTemplate(row) });
  }

  if (action === "duplicate") {
    const row = await must(sb.from("gw_hr_mail_templates").insert({
      tenant_id: ctx.tenantId, name: `${t.name}（コピー）`.slice(0, NAME_MAX), purpose: t.purpose, subject: t.subject, body: t.body,
      is_active: true, is_default: false, version: 1, created_by: user.id, updated_by: user.id,
    }).select(FIELDS).single());
    await log("duplicate", row, { from: t.id });
    return json(res, 200, { template: shapeTemplate(row) });
  }

  if (action === "set_active") {
    const active = b.active === true;
    const row = await must(sb.from("gw_hr_mail_templates")
      .update({ is_active: active, ...(active ? {} : { is_default: false }), updated_by: user.id, updated_at: now })
      .eq("id", t.id).eq("tenant_id", ctx.tenantId).select(FIELDS).single());
    await log(active ? "activate" : "deactivate", row);
    return json(res, 200, { template: shapeTemplate(row) });
  }

  if (action === "set_default") {
    if (!t.is_active) return json(res, 409, { error: "inactive", hint: "非表示のひな型は既定にできません。先に「使用」にしてください" });
    await must(sb.from("gw_hr_mail_templates").update({ is_default: false, updated_at: now })
      .eq("tenant_id", ctx.tenantId).eq("purpose", t.purpose).eq("is_default", true).select("id"));
    const row = await must(sb.from("gw_hr_mail_templates").update({ is_default: true, updated_by: user.id, updated_at: now })
      .eq("id", t.id).eq("tenant_id", ctx.tenantId).select(FIELDS).single());
    await log("set_default", row, { purpose: t.purpose });
    return json(res, 200, { template: shapeTemplate(row) });
  }

  return json(res, 400, { error: "invalid_action", detail: "create, update, duplicate, set_active, set_default" });
}
