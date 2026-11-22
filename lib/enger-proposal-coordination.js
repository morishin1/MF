import { createHash } from "node:crypto";

const CONTACT_CATEGORIES = ["連絡記録", "当社→案件側", "案件側→当社", "当社→人材側", "人材側→当社"];
const PROPOSAL_FIELDS = "id,company,job_title,stage,proposer,owner,closer,job_action_type,cand_action_type,dx2_job_reply_due,dx2_cand_reply_due,dx2_decision_due,proposed_at";

function clip(value, max = 450) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// DX writes some contact records into both activity_logs and proposal_memos.
export function mergeEngerContacts(logs, memos) {
  function detail(raw, fallback) {
    const text = clip(raw, 2000);
    const prefix = text.match(/^\[([^\]]*?)(?:\s*\/\s*(\d{4}-\d\d-\d\d \d\d:\d\d))?\]\s*/);
    return {
      label: clip(prefix?.[1] || fallback, 80),
      occurredAt: prefix?.[2] ? prefix[2].replace(" ", "T") + ":00+09:00" : null,
      text: clip((prefix ? text.slice(prefix[0].length) : text).replace(/^（本文なし）$/, "")),
    };
  }
  const map = new Map();
  function add(raw, label, createdAt, author) {
    const item = detail(raw, label);
    if (!item.label) return;
    const key = [String(createdAt || "").slice(0, 16), clip(author, 80), item.text,
      item.text ? "" : item.label].join("|");
    map.set(key, {
      text: item.text, label: item.label, author: clip(author, 80),
      at: Number.isFinite(Date.parse(item.occurredAt)) ? item.occurredAt : createdAt,
    });
  }
  for (const log of logs) add(log.detail, (log.action || "").replace(/^コンタクト:\s*/, ""), log.created_at, log.operator);
  for (const memo of memos) add(memo.body, memo.category, memo.created_at, memo.created_by_name);
  return [...map.values()].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)
    || a.label.localeCompare(b.label) || a.text.localeCompare(b.text)).slice(0, 8);
}

export function latestLineAnswers(rows) {
  const sides = { company: null, candidate: null };
  for (const row of rows) {
    const side = row.kind === "candidate" ? "company" : row.kind === "job" ? "candidate" : null;
    if (side && !sides[side]) sides[side] = { response: clip(row.response, 60), at: row.responded_at };
  }
  return sides;
}

export async function readEngerCoordinationSource(sb, sourceId) {
  const schema = sb.schema("enger");
  const proposal = await schema.from("proposals").select(PROPOSAL_FIELDS)
    .eq("id", sourceId).is("deleted_at", null).maybeSingle();
  if (proposal.error) throw proposal.error;
  if (!proposal.data) return null;
  const [logs, memos, line] = await Promise.all([
    schema.from("activity_logs").select("action,detail,created_at,operator")
      .eq("target_type", "proposal").eq("target_id", sourceId).like("action", "コンタクト:%")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(30),
    schema.from("proposal_memos").select("category,body,created_at,created_by_name")
      .eq("proposal_id", sourceId).in("category", CONTACT_CATEGORIES)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(30),
    schema.from("share_links").select("kind,response,responded_at")
      .eq("proposal_id", sourceId).in("kind", ["job", "candidate"]).not("response", "is", null)
      .order("responded_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(40),
  ]);
  for (const result of [logs, memos, line]) if (result.error) throw result.error;
  const e = proposal.data;
  const source = {
    id: e.id, company: e.company, job: e.job_title, stage: e.stage,
    proposer: e.proposer || e.owner, closer: e.closer, proposedAt: e.proposed_at,
    companyResponse: e.job_action_type, candidateResponse: e.cand_action_type,
    companyDue: e.dx2_job_reply_due, candidateDue: e.dx2_cand_reply_due, decisionDue: e.dx2_decision_due,
    line: latestLineAnswers(line.data || []),
    contacts: mergeEngerContacts(logs.data || [], memos.data || []),
  };
  return { ...source, revision: createHash("sha256").update(JSON.stringify(source)).digest("hex") };
}
