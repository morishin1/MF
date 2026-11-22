import { canAccessOffice } from "./gw.js";
import { membershipFor } from "./enger-agent-role.js";
import { canAccessEightEngerDirectory } from "./sales-enger-scope.js";
import { jstDate } from "./timecard.js";

export const REVIEW_REASONS = {
  response: "返答・追客", fit: "スキル・要件", terms: "単価・条件",
  timing: "面談・稼働時期", availability: "募集終了・辞退",
  handoff: "情報不足・引継ぎ", other: "その他",
};
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const START = "2026-11-21";

export function reviewDay(value, today = jstDate()) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < START || value > today) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value ? value : null;
}

export const boundedText = (value, max) => {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length <= max ? result : null;
};

export async function reviewAccess(sb, ctx, user) {
  if (!canAccessEightEngerDirectory(ctx) || !ctx.employee || ctx.employee.status !== "active") {
    return { office: false, enger: false };
  }
  const office = canAccessOffice(ctx);
  const email = String(user.email || "").trim();
  if (!email || !user.email_confirmed_at) return { office, enger: false };
  const writer = await sb.schema("enger").from("app_users").select("id")
    .ilike("email", email.replace(/[\\%_]/g, "\\$&"))
    .eq("status", "active").in("role", ["admin", "agent"]).limit(2);
  if (writer.error) throw writer.error;
  if (writer.data?.length !== 1) return { office, enger: false };
  const memberId = writer.data[0].id;
  const members = await Promise.all([...new Set([user.id, memberId])].map(id => membershipFor(sb, id)));
  const enger = members.every(m => !m || (m.status === "active" && m.membership_type === "internal" && !m.partner_organization_id));
  return { office, enger };
}

export function reviewQueue(sb, tenantId, day, today) {
  const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
  const base = sb.from("gw_enger_office_review_queue")
    .select("id,source_id,title,company_name,sent_at,status,outcome,reason,fact,checked_on,revision,job_title,talent_initials,job_action_type,cand_action_type")
    .eq("tenant_id", tenantId).lt("sent_at", next + "T00:00:00+09:00");
  const lower = (day === today ? START : day) + "T00:00:00+09:00";
  base.gte("sent_at", lower);
  if (day === today) {
    base.or(`sent_at.gte.${day}T00:00:00+09:00,outcome.is.null,outcome.eq.discuss,checked_on.eq.${day}`);
  }
  return base.order("sent_at", { ascending: false }).order("id", { ascending: false }).limit(500);
}

export function officeCheck(body) {
  if (!["checked","discuss"].includes(body.outcome)) return null;
  const reason = typeof body.reason === "string" && Object.hasOwn(REVIEW_REASONS, body.reason) ? body.reason : null;
  const fact = boundedText(body.fact ?? "", 500);
  if (fact === null || (body.outcome === "discuss" && (!reason || !fact))) return null;
  return { outcome: body.outcome, reason, fact };
}
