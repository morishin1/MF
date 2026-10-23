// Office内の読み取り専用表示。状態変更は原本画面だけで行う。
(function (root) {
  'use strict';
  const open = (t) => !t.is_template && (t.status === 'todo' || t.status === 'doing');
  function build({ requests = [], tasks = [], today, selfName = '自分' }) {
    const rows = [];
    for (const r of requests || []) {
      if (!r.id || !['pending', 'pending_owner'].includes(r.status)) continue;
      const waiting = r.status === 'pending_owner';
      rows.push({ key: 'request:' + r.id, type: 'request', state: waiting ? 'waiting' : 'decision', pri: waiting ? 3 : 0,
        area: '申請', label: (r.applicant?.display_name || '申請者') + '・' + (r.kind === 'leave' ? '休暇申請' : '稟議申請'),
        owner: waiting ? 'KEIEI（役割）' : 'Office人事・労務（役割）', due: null,
        hint: waiting ? 'KEIEIの判断待ち。Officeの承認対象ではありません' : '内容を確認して承認・却下を判断',
        cta: '申請一覧で確認', href: '/admin-requests.html', count: 1 });
    }
    const seen = new Set();
    for (const t of tasks || []) {
      if (!t.id || !open(t) || seen.has(t.id)) continue;
      seen.add(t.id);
      rows.push({ key: 'task:' + t.id, type: 'task', state: t.needsAccept ? 'decision' : 'action',
        pri: t.due_on && t.due_on < today ? 1 : t.needsAccept ? 0 : t.due_on === today ? 2 : 3,
        area: '自分のタスク', label: t.title,
        owner: t.assignee?.display_name || selfName, due: t.due_on || null,
        hint: t.needsAccept ? '期限・完了条件を確認して引き受ける' : 'タスクの完了条件を確認して進める',
        cta: 'タスク一覧で確認', href: '/tasks.html', count: 1 });
    }
    return unique(rows);
  }
  function unique(rows) {
    const seen = new Set();
    return rows.filter((r) => { if (!r.key) return true; if (seen.has(r.key)) return false; seen.add(r.key); return true; });
  }
  function filter(rows, type, state) { return rows.filter((r) => (!type || r.type === type) && (!state || r.state === state)); }
  root.OfficeActions = { build, unique, filter };
})(typeof window === 'undefined' ? globalThis : window);
