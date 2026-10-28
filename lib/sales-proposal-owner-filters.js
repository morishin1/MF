// Read-only list filters. Never use these display identities to authorize edits.
import { createHash } from "node:crypto";
import { isUuid } from "./sales-proposals.js";

export function validOwnerFilter(value, { source = false } = {}) {
  return !value || ["all", "me", "none"].includes(value) || isUuid(value)
    || (source && /^source:[a-f0-9]{64}$/.test(value));
}

export function matchesOwnerFilter(value, id, me) {
  if (!value || value === "all") return true;
  if (value === "none") return !id;
  if (value === "me") return Boolean(me && id === me);
  return id === value;
}

/** Match the existing proposal-owner display, not the current workflow owner.
 * ENGER's fixed source owner may differ from proposal_owner_id/sales_owner_id.
 * Only a unique source email can link that person to an employee; never guess by name.
 */
export function proposalOwnerFilters(proposals, employees, members) {
  const people = new Map(employees.map((e) => [e.id, e]));
  const emailIds = new Map();
  for (const e of employees) {
    const email = String(e.email || "").trim().toLowerCase();
    if (email) emailIds.set(email, [...(emailIds.get(email) || []), e.id]);
  }
  const choices = { proposal: new Map(), closing: new Map() };
  for (const role of Object.keys(choices)) {
    for (const m of members) choices[role].set(m.id, { id: m.id, name: m.name });
  }
  const byProposal = new Map();
  for (const p of proposals) {
    let id = null;
    let name = null;
    if (p.source_system !== "enger") {
      id = p.proposal_owner_id || ((p.handoff_stage || "proposal") === "proposal" ? p.sales_owner_id : null);
      name = people.get(id)?.display_name || p.matching_owner_name || (p.source_system === "manual" ? people.get(p.sales_owner_id)?.display_name : null) || null;
    } else {
      name = p.matching_owner_name || null;
      const email = String(p.matching_owner_email || "").trim().toLowerCase();
      const matches = emailIds.get(email) || [];
      if (name && matches.length === 1) id = matches[0];
    }
    if (!id && name) {
      const email = String(p.matching_owner_email || "").trim().toLowerCase();
      const source = email ? `email:${email}` : `name:${name}`;
      id = "source:" + createHash("sha256").update(`${p.source_system}\0${source}`).digest("hex");
    }
    byProposal.set(p.id, { proposal: id, closing: p.closing_owner_id || null });
    if (id && !choices.proposal.has(id)) choices.proposal.set(id, {
      id, name: name || "退職・不明", ...(id.startsWith("source:") ? { source: true } : {}),
    });
    if (p.closing_owner_id && !choices.closing.has(p.closing_owner_id)) choices.closing.set(p.closing_owner_id, {
      id: p.closing_owner_id, name: people.get(p.closing_owner_id)?.display_name || "退職・不明",
    });
  }
  for (const values of Object.values(choices)) {
    const names = new Map();
    for (const value of values.values()) names.set(value.name, (names.get(value.name) || 0) + 1);
    for (const value of values.values()) if (names.get(value.name) > 1) value.disambiguator = value.id.slice(-8);
  }
  return { byProposal, options: Object.fromEntries(Object.entries(choices).map(([role, values]) => [role,
    [...values.values()].sort((a, b) => a.name.localeCompare(b.name, "ja") || a.id.localeCompare(b.id)),
  ])) };
}
