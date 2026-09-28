// 企業一覧（サーバー側ページング）と CSV の共通部分（db/097）。
//
// ■ 取るのは「このページの100社」と、その100社ぶんの関連データだけ
//   以前は一覧を開くたびに、企業 最大5,000件・アタック 最大20,000件・面談 最大5,000件を取り、
//   ブラウザで絞っていた。いまは DB で絞って並べて100件に切り、関連データも
//   company_id in (その100社) でしか取らない。

import {
  LIST_FIELDS, EXPORT_MAX, applyListFilters, applyListSort,
  aggregateApproaches, nextFor, hasUnhandledClick, todayJst, channelLabel,
  STATUS_LABEL, NG_LABEL, HIDE_LABEL, isUuid, listSource,
} from "./sales.js";

// .in() は URL に載るので、長くなりすぎないよう分けて問い合わせる
const CHUNK = 100;
const chunks = (arr) => {
  const out = [];
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
  return out;
};

/** 指定した会社ぶんのアタック（集計用の列だけ）と面談を取る */
async function related(sb, ctx, ids, { meetings = true } = {}) {
  const approaches = [];
  const meetingRows = [];
  for (const part of chunks(ids)) {
    const [{ data: a }, m] = await Promise.all([
      sb.from("gw_sales_approaches")
        .select("id, company_id, employee_id, service, prepared_at, sent_at, first_click_at, last_click_at, click_count, channel")
        .eq("tenant_id", ctx.tenantId).in("company_id", part),
      // 面談（db/090）。表がまだ無ければ空として扱う
      meetings
        ? sb.from("gw_sales_meetings").select("id, company_id, status, scheduled_at, created_at")
          .eq("tenant_id", ctx.tenantId).in("company_id", part).in("status", ["scheduling", "scheduled"])
        : Promise.resolve({ data: [] }),
    ]);
    approaches.push(...(a || []));
    meetingRows.push(...(m?.data || []));
  }
  const meetingOf = new Map();
  for (const m of meetingRows) {
    const cur = meetingOf.get(m.company_id);
    if (!cur || String(m.created_at) > String(cur.created_at)) meetingOf.set(m.company_id, m);
  }
  return { agg: aggregateApproaches(approaches), meetingOf };
}

async function memberList(sb, ctx) {
  const { data } = await sb.from("gw_employees").select("id, display_name")
    .eq("tenant_id", ctx.tenantId).in("status", ["active", "invited"]).order("display_name").limit(300);
  return data || [];
}

/** 一覧の1行（一覧に要るものだけ） */
function shapeRow(c, g, name, meeting, today) {
  const next = nextFor(c, g, today);
  return {
    id: c.id, name: c.name, domain: c.domain || null, siteUrl: c.site_url || null,
    industry: c.industry || null, region: c.region || null, service: c.service || null,
    status: c.status || "untouched", statusLabel: STATUS_LABEL[c.status || "untouched"] || c.status,
    ngReason: c.ng_reason || null, ngLabel: c.ng_reason ? NG_LABEL[c.ng_reason] || c.ng_reason : null,
    hidden: Boolean(c.hidden_at), hiddenReason: c.hidden_reason || null,
    hiddenLabel: c.hidden_reason ? HIDE_LABEL[c.hidden_reason] || c.hidden_reason : null,
    ownerId: c.owner_id || null, ownerName: name.get(c.owner_id) || null,
    contactChannel: c.current_contact_channel || null, contactChannelLabel: channelLabel(c.current_contact_channel),
    attackCount: g?.attackCount || 0,
    // 並べ替えに使った値（写し）と、画面に出す値を同じにする
    lastSentAt: c.last_sent_at || g?.lastSentAt || null,
    lastAttackerName: name.get(g?.lastEmployeeId) || null,
    lastChannel: g?.lastChannel || null, lastChannelLabel: channelLabel(g?.lastChannel),
    clickCount: c.click_count ?? g?.clickCount ?? 0,
    lastClickAt: g?.last_click_at || null,
    unhandledClick: hasUnhandledClick(c, g),
    meetingStatus: meeting?.status || null, meetingAt: meeting?.scheduled_at || null,
    next: next.label, nextKey: next.key, nextDue: next.due, overdue: next.overdue,
    createdAt: c.created_at || null,
  };
}

/**
 * 1ページぶん。{ companies, page, limit, total, totalPages }
 * 範囲外のページ（絞り込みで件数が減った・URLを手で変えた）なら、最後のページを返す
 */
export async function listPage(sb, ctx, f) {
  const run = (page) => {
    const from = (page - 1) * f.limit;
    let q = sb.from(listSource(f)).select(LIST_FIELDS, { count: "exact" }).eq("tenant_id", ctx.tenantId);
    q = applyListSort(applyListFilters(q, f, ctx), f);
    return q.range(from, from + f.limit - 1);
  };
  let page = f.page;
  let { data, count, error } = await run(page);
  // PGRST103 = 範囲外（Requested range not satisfiable）
  if (error && error.code === "PGRST103") {
    const head = await applyListFilters(sb.from(listSource(f)).select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantId), f, ctx);
    page = Math.max(1, Math.ceil((head.count || 0) / f.limit));
    ({ data, count, error } = await run(page));
  }
  if (error) return { error };

  const rows = data || [];
  const [{ agg, meetingOf }, members] = await Promise.all([
    related(sb, ctx, rows.map((c) => c.id)),
    memberList(sb, ctx),
  ]);
  const name = new Map(members.map((e) => [e.id, e.display_name]));
  const today = todayJst();
  const total = count ?? rows.length;
  return {
    today, members, page, limit: f.limit, total, totalPages: Math.max(1, Math.ceil(total / f.limit)),
    companies: rows.map((c) => shapeRow(c, agg.get(c.id) || null, name, meetingOf.get(c.id), today)),
  };
}

/** 絞り込みの候補（業種・地域・商材）。view が無い（097 未実行）なら空 */
export async function listFacets(sb, ctx) {
  const { data, error } = await sb.from("gw_sales_company_facets").select("kind, value, n").eq("tenant_id", ctx.tenantId);
  const out = { industry: [], region: [], service: [] };
  if (error) return out;
  for (const r of data || []) if (out[r.kind]) out[r.kind].push({ value: r.value, n: r.n });
  for (const k of Object.keys(out)) out[k].sort((a, b) => String(a.value).localeCompare(String(b.value), "ja"));
  return out;
}

/**
 * CSV の対象。ids があればその企業だけ（自テナントに実在するものだけ）、無ければ条件で絞った全件。
 * 並び順は画面と同じ条件。上限を超えたら too_many
 * @returns {{rows?: {c:object, x:object}[], total?:number, error?:object, tooMany?:boolean}}
 */
export async function exportRows(sb, ctx, f, ids) {
  const found = [];
  if (ids) {
    const valid = [...new Set(ids.filter((id) => typeof id === "string" && isUuid(id)))];
    if (valid.length > EXPORT_MAX) return { tooMany: true, total: valid.length };
    // 選んだ企業も、画面と同じ並び順で書く（選べるのは表示中のページの企業なので、ふつうは1回で済む）
    for (const part of chunks(valid)) {
      const q = applyListSort(sb.from(listSource(f)).select(LIST_FIELDS)
        .eq("tenant_id", ctx.tenantId).in("id", part), f);
      const { data, error } = await q;
      if (error) return { error };
      found.push(...(data || []));
    }
  } else {
    let q = sb.from(listSource(f)).select(LIST_FIELDS, { count: "exact" }).eq("tenant_id", ctx.tenantId);
    q = applyListSort(applyListFilters(q, f, ctx), f).range(0, EXPORT_MAX - 1);
    const { data, count, error } = await q;
    if (error) return { error };
    if ((count ?? 0) > EXPORT_MAX) return { tooMany: true, total: count };
    found.push(...(data || []));
  }

  const [{ agg }, members] = await Promise.all([
    related(sb, ctx, found.map((c) => c.id), { meetings: false }),
    memberList(sb, ctx),
  ]);
  const name = new Map(members.map((e) => [e.id, e.display_name]));
  const today = todayJst();
  const rows = found.map((c) => {
    const g = agg.get(c.id) || null;
    const next = nextFor(c, g, today);
    return {
      c,
      x: {
        ownerName: name.get(c.owner_id) || "",
        lastAttackerName: name.get(g?.lastEmployeeId) || "",
        lastChannelLabel: channelLabel(g?.lastChannel) || "",
        next: next.label === "—" ? "" : next.label,
        nextDue: next.due || "",
      },
    };
  });
  return { rows, total: rows.length };
}

