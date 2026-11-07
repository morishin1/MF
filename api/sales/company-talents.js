// 商談準備（Sales の企業詳細「商談準備」タブ）
//
// GET   /api/sales/company-talents?companyId=…&tab=all|focus|new|linked&q=&skills=&remote=&prefecture=&weekDays=&start=&sort=&page=
//         ENGER の人材を検索する。企業ポータルで企業が見るのと同じ項目だけを返す（lib/enger-talent-public.js）
// GET   /api/sales/company-talents?companyId=…&id=<人材ID>
//         人材の詳細（サマリー・公開用スキルシート・この企業への紐づけ）
// POST  /api/sales/company-talents { companyId, talentIds:[…], status }   選んだ人材をこの企業IDに紐づける
// PATCH /api/sales/company-talents { companyId, talentId, status?, note? } 紐づけの状態・社内メモを変える
//
// ■ Sales に人材の氏名・連絡先・単価・スキルシートの原本を出さない（dx.enger との取り決め。docs/sales-proposals.md）
//   詳しく見るときは dx.enger の人材詳細へのリンク（dx.enger 側のログインと権限で開く）。
// ■ 紐づけは社内向け（保存候補／提案予定／提案済み／見送り）。企業ポータルには出さない。
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canSell } from "../../lib/gw.js";
import { canAccessEightEngerDirectory } from "../../lib/sales-enger-scope.js";
import { admin } from "../../lib/supabase.js";
import { isUuid } from "../../lib/sales.js";
import { PORTAL_TABLES as T, LINK_STATUSES, NOT_READY, isMissingTable, linkInput, linkPatchInput } from "../../lib/sales-company-portal.js";
import { companyInScope, logPortalEvent, readPublicCandidates } from "../../lib/sales-company-portal-db.js";
import {
  parseTalentQuery, selectTalents, pageOf, toPublicTalent, publicSkillSheet, isPublicTalent,
  NEW_TALENT_DAYS, POOL_LIMIT, PAGE_SIZE, REMOTE_KINDS, PREFECTURE_LIST,
} from "../../lib/enger-talent-public.js";

const DX_BASE = "https://dx.enger.jp";

export default async function handler(req, res) {
  const user = await requireUser(req, res); if (!user) return;
  res.setHeader?.("Cache-Control", "private, no-store");
  if (!["GET", "POST", "PATCH"].includes(req.method)) return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx) || !canAccessEightEngerDirectory(ctx)) return json(res, 403, { error: "forbidden" });
  const params = new URL(req.url || "/", "http://localhost").searchParams;
  const body = req.method === "GET" ? null : await readJson(req);
  const companyId = req.method === "GET" ? params.get("companyId") : body?.companyId;
  if (!isUuid(companyId)) return json(res, 400, { error: "invalid_company", hint: "企業IDが正しくありません。一覧を再読み込みしてください。" });
  const db = admin();
  const scope = await companyInScope(db, ctx.tenantId, companyId);
  if (!scope.ok) return json(res, scope.status, { error: scope.error, hint: "この企業は Sales の企業一覧で確認できません。" });
  try {
    if (req.method === "GET") return params.get("id") ? await detail(res, db, ctx, scope.company, params.get("id")) : await search(res, db, ctx, scope.company, params);
    if (req.method === "POST") return await link(res, db, ctx, user, scope.company, body || {});
    return await patch(res, db, ctx, user, scope.company, body || {});
  } catch {
    return json(res, 503, { error: "talents_unavailable", hint: "ENGER の人材を取得できませんでした。時間をおいて再度お試しください。" });
  }
}

async function readLinks(db, ctx, companyId) {
  const r = await db.schema("enger").from(T.links).select("candidate_id,status,note,updated_at")
    .eq("tenant_id", ctx.tenantId).eq("company_id", companyId).order("updated_at", { ascending: false }).limit(500);
  if (r.error) return { error: r.error, notReady: isMissingTable(r.error) };
  return { map: new Map((r.data || []).map((l) => [l.candidate_id, l])) };
}

const linkView = (l) => (l ? { status: l.status, statusLabel: LINK_STATUSES[l.status] || l.status, note: l.note || "", updatedAt: l.updated_at } : null);

async function search(res, db, ctx, company, params) {
  const f = parseTalentQuery(params);
  const wantLinked = params.get("tab") === "linked";
  const links = await readLinks(db, ctx, company.id);
  // 紐づけの表が未作成でも、人材の検索はできる（紐づけ・保存だけが止まる）
  const linkMap = links.map || new Map();
  if (wantLinked && links.error) return json(res, 503, links.notReady ? NOT_READY : { error: "links_unavailable" });
  const linkedIds = [...linkMap.keys()];
  const since = new Date(Date.now() - NEW_TALENT_DAYS * 86400000).toISOString();
  const pool = await readPublicCandidates(db, (q, ext) => {
    if (wantLinked) return linkedIds.length ? q.in("id", linkedIds) : null;
    if (f.tab === "focus") return ext ? q.eq("is_focus", true) : null;
    if (f.tab === "new") return q.gte("created_at", since);
    return q;
  }, POOL_LIMIT);
  if (pool.error) return json(res, 503, { error: "talents_unavailable", hint: "ENGER の人材を取得できませんでした。" });
  const { items, total } = selectTalents(pool.rows, { ...f, tab: wantLinked ? "all" : f.tab });
  const { slice, page, pages } = pageOf(items, f.page);
  const statusCount = {};
  for (const l of linkMap.values()) statusCount[l.status] = (statusCount[l.status] || 0) + 1;
  return json(res, 200, {
    rows: slice.map(({ row, talent }) => ({ id: row.id, ...talent, link: linkView(linkMap.get(row.id)) })),
    total, page, pages, pageSize: PAGE_SIZE,
    truncated: !wantLinked && pool.rows.length >= POOL_LIMIT,
    missing: pool.missing,
    linkReady: !links.error,
    linkHint: links.error ? (links.notReady ? NOT_READY.hint : "紐づけを読めませんでした。") : null,
    linkedCount: linkMap.size, statusCount,
    options: { remote: REMOTE_KINDS, prefectures: PREFECTURE_LIST, linkStatuses: LINK_STATUSES },
  });
}

async function detail(res, db, ctx, company, id) {
  if (!isUuid(id)) return json(res, 400, { error: "invalid_talent" });
  const pool = await readPublicCandidates(db, (q) => q.eq("id", id), 1);
  if (pool.error) return json(res, 503, { error: "talents_unavailable" });
  const row = pool.rows[0];
  if (!row || !isPublicTalent(row)) return json(res, 404, { error: "talent_not_public", hint: "この人材は現在、企業へ提示できる状態ではありません（クローズ・稼働中など）。" });
  const links = await readLinks(db, ctx, company.id);
  const talent = toPublicTalent(row);
  return json(res, 200, {
    talent: { id: row.id, ...talent },
    sheet: publicSkillSheet(talent),
    link: linkView(links.map?.get(row.id)),
    linkReady: !links.error,
    missing: pool.missing,
    dxUrl: `${DX_BASE}/talents/${encodeURIComponent(row.id)}`,
  });
}

async function link(res, db, ctx, user, company, body) {
  const v = linkInput(body);
  if (v.error) return json(res, 400, v);
  // 企業に提示できる人材だけを紐づける（クローズ・削除・稼働中は入れない）
  const pool = await readPublicCandidates(db, (q) => q.in("id", v.value.ids), v.value.ids.length);
  if (pool.error) return json(res, 503, { error: "talents_unavailable" });
  const ok = new Set(pool.rows.filter(isPublicTalent).map((r) => r.id));
  const skipped = v.value.ids.filter((id) => !ok.has(id));
  const ids = v.value.ids.filter((id) => ok.has(id));
  if (!ids.length) return json(res, 409, { error: "no_public_talents", hint: "選んだ人材は、いま企業へ提示できる状態ではありません。", skipped });
  const existing = await db.schema("enger").from(T.links).select("id,candidate_id").eq("tenant_id", ctx.tenantId).eq("company_id", company.id).in("candidate_id", ids);
  if (existing.error) return json(res, 503, isMissingTable(existing.error) ? NOT_READY : { error: "links_unavailable" });
  const have = new Set((existing.data || []).map((r) => r.candidate_id));
  const stamp = new Date().toISOString();
  const fresh = ids.filter((id) => !have.has(id));
  if (fresh.length) {
    const ins = await db.schema("enger").from(T.links).insert(fresh.map((candidate_id) => ({
      tenant_id: ctx.tenantId, company_id: company.id, candidate_id, status: v.value.status, created_by: user.id, updated_by: user.id,
    })));
    // 同時に押された（一意制約）ときは、既にあるものとして扱う
    if (ins.error && ins.error.code !== "23505") return json(res, 503, { error: "link_failed" });
  }
  const again = ids.filter((id) => have.has(id));
  if (again.length) {
    const up = await db.schema("enger").from(T.links).update({ status: v.value.status, updated_by: user.id, updated_at: stamp })
      .eq("tenant_id", ctx.tenantId).eq("company_id", company.id).in("candidate_id", again);
    if (up.error) return json(res, 503, { error: "link_failed" });
  }
  const audited = await logPortalEvent(db, { companyId: company.id, actorKind: "staff", actorUserId: user.id, action: "prep.link", detail: { count: ids.length, status: LINK_STATUSES[v.value.status] } });
  return json(res, 200, { ok: true, linked: ids.length, created: fresh.length, updated: again.length, skipped, status: v.value.status, audited });
}

async function patch(res, db, ctx, user, company, body) {
  if (!isUuid(body.talentId)) return json(res, 400, { error: "invalid_talent" });
  const v = linkPatchInput(body);
  if (v.error) return json(res, 400, v);
  const stamp = new Date().toISOString();
  const up = await db.schema("enger").from(T.links).update({ ...v.value, updated_by: user.id, updated_at: stamp })
    .eq("tenant_id", ctx.tenantId).eq("company_id", company.id).eq("candidate_id", body.talentId).select("candidate_id,status,note,updated_at");
  if (up.error) return json(res, 503, isMissingTable(up.error) ? NOT_READY : { error: "update_failed" });
  if (!(up.data || []).length) return json(res, 404, { error: "link_not_found", hint: "この企業に紐づいていない人材です。先に「保存」してください。" });
  const audited = await logPortalEvent(db, { companyId: company.id, actorKind: "staff", actorUserId: user.id, action: "prep.update", detail: v.value.status ? { status: LINK_STATUSES[v.value.status] } : {} });
  return json(res, 200, { ok: true, link: linkView(up.data[0]), audited });
}
