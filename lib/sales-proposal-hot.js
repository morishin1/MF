// Manual signal, independent of stage, probability and automatic ranking.
export async function readHotMarks(sb, tenantId, ids) {
  const marks = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from('gw_sales_proposal_hot_marks')
      .select('proposal_id,is_hot,version').eq('tenant_id', tenantId).in('proposal_id', ids.slice(i, i + 100));
    // Additive rollout: never break the proposal list or pretend an unread marker is off.
    if (error) return { marks: new Map(), available: false, reason: ['42P01','PGRST205'].includes(error.code) ? 'setup' : 'read' };
    for (const row of data || []) marks.set(row.proposal_id, row);
  }
  return { marks, available: true };
}
export function hotFields(result, id) {
  const mark = result.marks.get(id);
  return { hotUnavailableReason: result.reason || null, hotAvailable: result.available, isHot: result.available ? mark?.is_hot === true : null,
    hotVersion: result.available ? mark?.version || 0 : null };
}
