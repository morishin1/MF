// 退職書類（gw_retire_docs）に「発行済みの版」を入れる共通の処理。
//
// ■ 発行済みは上書きしない
//   いま有効な行（置き換え済み以外）を「置き換え済み」にして、新しい版を足す。古い版は消さない（履歴）。
//   公開は新しい版では外れる（公開は、管理者が新しい版を見てから押す）。
//   入れるのに失敗したら、置き換え済みにした行を元に戻す（有効な行が無くなる中途半端な状態を残さない）。

import { liveOf, kindLabel, adminState } from "./retire.js";

const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

export const DOC_FIELDS = "id, tenant_id, employee_id, kind, version, state, expected_on, note, issued_no, issued_on, issued_by, "
  + "file_name, file_size, include_reason, published, published_at, revoked_at, created_at, updated_at";

/**
 * @param {object} sb admin クライアント
 * @param {{tenantId:string}} ctx
 * @param {{id:string}} user
 * @param {{id:string}} emp
 * @param {string} kind
 * @param {{path:string, sha256:string, size:number, issuedOn:string, fileName?:string|null, extra?:object}} f
 * @returns {Promise<{row:object, live:object|null}>} 失敗したら throw（置き換えた行は元に戻してある）
 */
export async function putIssued(sb, ctx, user, emp, kind, f) {
  const now = new Date().toISOString();
  const rows = await must(sb.from("gw_retire_docs").select("id, kind, version, state, published, published_at")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).eq("kind", kind));
  const maxVersion = Math.max(0, ...(rows || []).map((r) => r.version || 0));
  const live = liveOf(rows, kind);
  if (live) {
    await must(sb.from("gw_retire_docs").update({ state: "superseded", published: false, updated_at: now })
      .eq("id", live.id).eq("tenant_id", ctx.tenantId).select("id").maybeSingle());
  }
  try {
    const row = await must(sb.from("gw_retire_docs").insert({
      tenant_id: ctx.tenantId, employee_id: emp.id, kind, version: maxVersion + 1, state: "issued",
      issued_on: f.issuedOn, issued_by: user.id, storage_path: f.path,
      file_name: f.fileName ? String(f.fileName).slice(0, 120) : null, file_size: f.size, sha256: f.sha256,
      published: false, created_by: user.id, created_at: now, updated_at: now, ...(f.extra || {}),
    }).select(DOC_FIELDS).single());
    return { row, live };
  } catch (e) {
    if (live) {
      await sb.from("gw_retire_docs").update({ state: live.state, published: Boolean(live.published), updated_at: now })
        .eq("id", live.id).eq("tenant_id", ctx.tenantId).select("id").maybeSingle();
    }
    throw e;
  }
}

/** 管理側に見せる1行（保存先・ハッシュ・本文は返さない） */
export const viewDoc = (d) => ({
  id: d.id, kind: d.kind, label: kindLabel(d.kind), version: d.version, state: d.state, adminState: adminState(d),
  expectedOn: d.expected_on || null, note: d.note || null, issuedNo: d.issued_no || null, issuedOn: d.issued_on || null,
  fileName: d.file_name || null, includeReason: Boolean(d.include_reason),
  published: Boolean(d.published), publishedAt: d.published_at || null, revokedAt: d.revoked_at || null,
  createdAt: d.created_at,
});
