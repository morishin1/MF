import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canSell } from "../../lib/gw.js";
import { admin, userClient } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { isUuid, todayJst } from "../../lib/sales.js";
import { canAccessEightEngerDirectory } from "../../lib/sales-enger-scope.js";
import { companyInScope } from "../../lib/sales-company-portal-db.js";
import { ensureSalesCompany } from "../../lib/sales-enger-company.js";
import { DEAL_FIELDS, OPEN_DEAL_STAGES, expectedOf } from "../../lib/sales-deals.js";
import { loadPeople } from "../../lib/sales-proposals-db.js";
import { readSourceStates, sourceStateFor } from "../../lib/sales-proposal-source-state.js";
import { PROGRESS_FIELDS, shapeEngerProgress, progressMetrics, validDay } from "../../lib/sales-enger-progress.js";

import { readEngerOffers, readEngerOffer } from "../../lib/sales-enger-offers.js";

const PROPOSALS = "id,company_id,company_name,source_system,source_proposal_id,source_company_id,job_title,title,sent_at,status,close_reason,sales_owner_id,cs_owner_id,closing_owner_id";
const MIGRATION = "db/184_sales_enger_progress.sql";
const LINKS = "gw_sales_enger_deal_links";

function checked(result) {
  if (result.error) throw result.error;
  return result.data;
}

async function allRows(query, sortKey = "id") {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const batch = checked(await query().order(sortKey).range(offset, offset + 499));
    rows.push(...batch);
    if (batch.length < 500) return rows;
  }
}

async function byIds(ids, query, sortKey) {
  const rows = [];
  const keys = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < keys.length; i += 100) {
    rows.push(...await allRows(() => query(keys.slice(i, i + 100)), sortKey));
  }
  return rows;
}

const firstBy = (rows, key, time) => {
  const result = new Map();
  for (const row of rows) {
    const previous = result.get(row[key]);
    if (!previous || row[time] < previous[time]) result.set(row[key], row);
  }
  return result;
};

async function loadList(req, res, { tenantId, sb, db, offerAccess }) {
  const query = new URL(req.url, "http://localhost").searchParams;
  const today = todayJst();
  const until = query.get("until") || today;
  const since = query.get("since") || today.slice(0, 7) + "-01";
  const asOf = query.get("asOf") || today;
  const focusId = query.get("id");
  const focusKind = query.get("kind");
  if (!validDay(since) || !validDay(until) || !validDay(asOf) || since > until || until > asOf || asOf > today
    || Date.parse(until) - Date.parse(since) > 366 * 86400000
    || (focusId && (!isUuid(focusId) || !["proposal", "offer"].includes(focusKind)))) {
    return json(res, 400, { error: "invalid_period", hint: "今日までの1年以内で期間を選んでください。" });
  }

  const start = since + "T00:00:00+09:00";
  const end = until + "T23:59:59.999999+09:00";
  const proposalsQuery = () => sb.from("gw_sales_proposals").select(PROPOSALS).eq("tenant_id", tenantId)
    .eq("source_system", "enger").is("archived_at", null);
  const month = today.slice(0, 7) + "-01";
  const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const [loadedProposals, offers, focus, people, monthlyDeals] = await Promise.all([
    allRows(() => proposalsQuery().gte("sent_at", start).lte("sent_at", end)),
    offerAccess ? readEngerOffers(db, tenantId, {since:start, until:end}) : [],
    focusId && (focusKind === "proposal" || offerAccess)
      ? (focusKind === "proposal" ? proposalsQuery().eq("id", focusId).maybeSingle().then(checked)
        : readEngerOffer(db, tenantId, focusId)) : null,
    loadPeople(tenantId),
    allRows(() => sb.from("gw_sales_deals").select("id,stage,amount,probability,won_on,expected_close_on").eq("tenant_id", tenantId)
      .or(`and(won_on.gte.${month},won_on.lt.${monthEnd}),and(expected_close_on.gte.${month},expected_close_on.lt.${monthEnd})`)),
  ]);
  if (focus) {
    const sources = focusKind === "proposal" ? loadedProposals : offers;
    if (!sources.some(row => row.id === focus.id)) sources.push(focus);
  }
  const state = await readSourceStates(sb, tenantId, loadedProposals);
  if (state.error) throw state.error;
  const proposals = loadedProposals.filter(row => !sourceStateFor(row, state.states)?.deleted);

  const [companies, proposalLinks, offerLinks, companyLinks, meetings, tasks, jobs, candidates] = await Promise.all([
    byIds(offers.map(o => o.company_id), ids => db.schema("enger").from("dx2_sales_company_directory_for_tenant")
      .select("id,name").eq("tenant_id", tenantId).in("id", ids)),
    byIds(proposals.map(p => p.id), ids => db.from(LINKS).select("source_id,deal_id").eq("tenant_id", tenantId)
      .eq("source_kind", "proposal").in("source_id", ids), "source_id"),
    byIds(offers.map(o => o.id), ids => db.from(LINKS).select("source_id,deal_id").eq("tenant_id", tenantId)
      .eq("source_kind", "offer").in("source_id", ids), "source_id"),
    byIds([...offers.map(o => o.company_id), ...proposals.map(p => p.source_company_id)], ids => db.from("gw_sales_company_links")
      .select("source_company_id,company_id").eq("tenant_id", tenantId).eq("source_system", "enger").in("source_company_id", ids), "source_company_id"),
    byIds(proposals.map(p => p.id), ids => sb.from("gw_sales_proposal_activities").select("id,proposal_id,occurred_at")
      .eq("tenant_id", tenantId).eq("kind", "meeting").eq("result", "done").in("proposal_id", ids)),
    byIds(proposals.map(p => p.id), ids => sb.from("gw_sales_proposal_tasks").select("id,proposal_id,title,due_at")
      .eq("tenant_id", tenantId).eq("status", "open").in("proposal_id", ids)),
    byIds(offers.map(o => o.job_id), ids => db.schema("enger").from("jobs").select("id,role_label").in("id", ids)),
    byIds(offers.map(o => o.candidate_id), ids => db.schema("enger").from("candidates").select("id,title").in("id", ids)),
  ]);
  const companyNames = new Map(companies.map(c => [c.id, c.name]));
  const permittedOffers = offers.filter(o => companyNames.has(o.company_id));
  const availableOfferIds = new Set(permittedOffers.map(o => o.id));
  const linksByOffer = new Map(offerLinks.filter(l => availableOfferIds.has(l.source_id)).map(l => [l.source_id, l.deal_id]));
  const linksByProposal = new Map(proposalLinks.map(l => [l.source_id, l.deal_id]));
  const dealIds = [...linksByOffer.values(), ...linksByProposal.values()];
  const [deals, offerHistory] = await Promise.all([
    byIds(dealIds, ids => sb.from("gw_sales_deals").select(DEAL_FIELDS + "," + PROGRESS_FIELDS)
      .eq("tenant_id", tenantId).in("id", ids)),
    offerAccess ? byIds([...linksByProposal.values()], ids => db.from(LINKS).select("source_id,deal_id")
      .eq("tenant_id", tenantId).eq("source_kind", "offer").in("deal_id", ids), "source_id") : [],
  ]);
  const historicalOffers = [];
  const receiptIds = [...new Set(offerHistory.map(l => l.source_id))];
  for (let i=0;i<receiptIds.length;i+=100)historicalOffers.push(...await readEngerOffers(db,tenantId,{ids:receiptIds.slice(i,i+100)}));
  const offerScope = await byIds(historicalOffers.map(o => o.company_id), ids => db.schema("enger")
    .from("dx2_sales_company_directory_for_tenant").select("id").eq("tenant_id", tenantId).in("id", ids));
  const scopedIds = new Set(offerScope.map(r => r.id));
  const offerDates = new Map(historicalOffers.filter(o => scopedIds.has(o.company_id)).map(o => [o.id, o.created_at]));
  const earliestOffer = firstBy(offerHistory.filter(l => offerDates.has(l.source_id)).map(l => ({
    dealId: l.deal_id, date: offerDates.get(l.source_id),
  })), "dealId", "date");
  const dealById = new Map(deals.map(d => [d.id, d]));
  const workingCompany = new Map(companyLinks.map(c => [c.source_company_id, c.company_id]));
  const jobTitles = new Map(jobs.map(j => [j.id, j.role_label]));
  const candidateTitles = new Map(candidates.map(c => [c.id, c.title]));
  const meetingByProposal = firstBy(meetings, "proposal_id", "occurred_at");
  const taskByProposal = firstBy(tasks, "proposal_id", "due_at");
  const employeeNames = new Map(people.employees.map(e => [e.id, e.display_name]));
  const rows = [
    ...proposals.map(source => {
      const deal = dealById.get(linksByProposal.get(source.id));
      return shapeEngerProgress({ kind: "proposal", source, deal,
        companyId: deal?.company_id || source.company_id || workingCompany.get(source.source_company_id) || null,
        meetingAt: meetingByProposal.get(source.id)?.occurred_at, offerAt: earliestOffer.get(deal?.id)?.date,
        task: taskByProposal.get(source.id), people: employeeNames, today });
    }),
    ...permittedOffers.map(offer => {
      const deal = dealById.get(linksByOffer.get(offer.id));
      return shapeEngerProgress({ kind: "offer", source: { ...offer, company_name: companyNames.get(offer.company_id),
        title: offer.title || jobTitles.get(offer.job_id) || candidateTitles.get(offer.candidate_id) },
        deal, companyId: deal?.company_id || workingCompany.get(offer.company_id) || null, people: employeeNames, today });
    }),
  ];
  const metrics = progressMetrics(rows, since, until, asOf);
  if (query.get("summary") === "1") return json(res, 200, { metrics });
  return json(res, 200, {
    rows, metrics, today, offerAccess,
    employees: people.employees.filter(e => e.status === "active" || rows.some(r => r.ownerId === e.id))
      .map(e => ({ id: e.id, name: e.display_name })),
    won: monthlyDeals.filter(d => d.stage === "won" && d.won_on?.startsWith(month.slice(0, 7)))
      .reduce((sum, d) => sum + Number(d.amount), 0),
    forecast: monthlyDeals.filter(d => OPEN_DEAL_STAGES.includes(d.stage) && d.expected_close_on?.startsWith(month.slice(0, 7)))
      .reduce((sum, d) => sum + expectedOf(d), 0),
  });
}

async function link(req, res, { tenantId, sb, db, offerAccess, ctx, user }) {
  const { kind, id, dealId, prepare = false } = await readJson(req);
  if (!["proposal", "offer"].includes(kind) || !isUuid(id) || (dealId != null && !isUuid(dealId)) || typeof prepare !== "boolean") {
    return json(res, 400, { error: "invalid_source", hint: "元の提案またはオファーを選んでください。" });
  }
  if (kind === "offer" && !offerAccess) return json(res, 403, { error: "forbidden" });
  const proposal = kind === "proposal";
  const source = proposal ? checked(await sb.from("gw_sales_proposals").select(PROPOSALS)
    .eq("tenant_id", tenantId).eq("source_system", "enger").is("archived_at", null).eq("id",id).maybeSingle())
    : await readEngerOffer(db, tenantId, id);
  if (!source) return json(res, 404, { error: "source_not_found", hint: "対象の記録が見つかりません。" });
  if (proposal) {
    const state = await readSourceStates(sb, tenantId, [source]);
    if (state.error) throw state.error;
    if (sourceStateFor(source, state.states)?.deleted) return json(res, 404, { error: "source_not_found", hint: "対象の記録は削除されています。" });
  }
  let companyId = proposal ? source.company_id : null;
  const engerCompanyId = proposal ? source.source_company_id : source.company_id;
  if (!proposal || (!companyId && offerAccess && isUuid(engerCompanyId))) {
    const scope = await companyInScope(db, tenantId, engerCompanyId);
    if (!scope.ok) return json(res, scope.status, { error: scope.error, hint: "ENGERの企業情報を確認できません。" });
    const company = checked(await db.schema("enger").from("companies")
      .select("id,name,website,contact_form_url,phone,contact_email,industry,prefecture,address,note")
      .eq("id", engerCompanyId).is("deleted_at", null).maybeSingle());
    if (company) companyId = (await ensureSalesCompany(db, ctx, user, company)).id;
  }
  if (!companyId) return json(res, 409, { error: "company_required", hint: "先に提案管理でSales企業を紐づけてください。" });
  const working = checked(await sb.from("gw_sales_companies").select("id,owner_id,ng_reason,hidden_at,status")
    .eq("tenant_id", tenantId).eq("id", companyId).maybeSingle());
  if (!working) return json(res, 404, { error: "company_not_found" });
  if (prepare) return json(res, 200, { companyId });
  if (!dealId && (working.ng_reason || working.hidden_at || working.status === "excluded")) {
    return json(res, 409, { error: "company_excluded", hint: "対象の企業は営業対象外です。企業詳細を確認してください。" });
  }
  const title = proposal ? source.job_title || source.title : source.item_type === "job" ? "ENGER 案件オファー" : "ENGER 人材オファー";
  const owner = (proposal && (source.closing_owner_id || source.cs_owner_id || source.sales_owner_id)) || working.owner_id || ctx.employee?.id || null;
  // The new company-offer RPC already created a Sales proposal. Attach both
  // receipt and proposal to one deal; retries reuse each unique source link.
  let canonicalDealId=dealId||null;
  if(!proposal&&source.salesProposalId){
    const savedProposal=checked(await sb.from("gw_sales_proposals").select("id,company_id,source_company_id")
      .eq("tenant_id",tenantId).eq("id",source.salesProposalId).is("archived_at",null).maybeSingle());
    if(!savedProposal||savedProposal.company_id!==companyId||savedProposal.source_company_id!==engerCompanyId||source.salesCompanyId!==companyId)
      return json(res,409,{error:"offer_proposal_mismatch",hint:"オファーと既存提案の企業を照合できません。"});
    canonicalDealId=checked(await db.rpc("gw_link_enger_deal",{
      p_tenant:tenantId,p_kind:"proposal",p_source:source.salesProposalId,p_company:companyId,
      p_deal:canonicalDealId,p_title:String(source.title||title).slice(0,200),p_owner:owner,p_actor:user.id,
    }));
  }
  const linkedId = checked(await db.rpc("gw_link_enger_deal", {
    p_tenant: tenantId, p_kind: kind, p_source: id, p_company: companyId,
    p_deal: canonicalDealId, p_title: String(title || "ENGER 提案").trim().slice(0, 200) || "ENGER 提案",
    p_owner: owner, p_actor: user.id,
  }));
  await gwLog({ tenantId, actorId: user.id, action: "sales.enger_deal_link", target: `sales_deal:${linkedId}`, detail: { kind, id } });
  return json(res, 200, { dealId: linkedId });
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx)) return json(res, 403, { error: "forbidden" });
  res.setHeader("Cache-Control", "private, no-store");
  const args = { tenantId: ctx.tenantId, sb: userClient(req), db: admin(), offerAccess: canAccessEightEngerDirectory(ctx), ctx, user };
  try {
    if (req.method === "GET") return await loadList(req, res, args);
    if (req.method === "POST") return await link(req, res, args);
    return methodNotAllowed(res, ["GET", "POST"]);
  } catch (error) {
    if (dbSetupHint(error, MIGRATION)) return json(res, 503, { error: "not_ready", hint: "ENGER進捗のデータベース設定が必要です。" });
    if (["23505", "23503"].includes(error.code)) {
      return json(res, 409, { error: "link_conflict", hint: "同じ企業の案件を選んでください。紐づけ済みの場合は画面を更新してください。" });
    }
    console.error("[sales/enger-progress]", error.code || error.message);
    return json(res, 503, { error: "unavailable", hint: "ENGERの進捗を取得・更新できませんでした。もう一度お試しください。" });
  }
}
