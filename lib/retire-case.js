// 退職手続きを1画面で進めるための、状態の組み立て（純粋な関数。DB は呼ばない）。
//   api/employees/retire-case.js が読んだ行を渡し、画面に出す形にする。テストは test/retirecase.mjs。
//
// ■ 決めつけない
//   ・読めなかったもの（表が無い・取得に失敗）は「取得失敗」。停止済みにも利用中にもしない
//   ・自動で止まる仕組みがあるもの（グループウェア・無限道場・タイムカード・会計）だけ「自動停止予定」と書く
//     （api/cron/leave.js が、退職日を過ぎた退職手続き中の人を翌日 0:05 に退職へ確定し、止める）
//   ・自動で止められないサービス（Google Workspace・Slack・GitHub・Vercel）は、担当者の記録だけ。
//     記録が無ければ「未確認」（対象外と決めつけない）。停止済は「担当者による停止確認」であって、外部での停止の証明ではない
//   ・本人の「閲覧」は、本人が退職者ページで書類を開いた操作の記録。管理者のプレビューは数えない。受領・署名は未対応（記録なし）
//   ・案内文のコピーは送信ではない。送信の記録は、まだ無い

import { isLeftEmployee } from "./left-gate.js";
import { KINDS, liveOf, kindLabel } from "./retire.js";

export const SERVICES = [
  { key: "google",     label: "Google Workspace（Gmail・ドライブ・カレンダー）", manual: true },
  { key: "slack",      label: "Slack",            manual: true },
  { key: "groupware",  label: "グループウェア",   manual: false },
  { key: "lms",        label: "無限道場",         manual: false },
  { key: "timecard",   label: "タイムカード・日報", manual: false },
  { key: "accounting", label: "会計",             manual: false },
  { key: "github",     label: "GitHub",           manual: true },
  { key: "vercel",     label: "Vercel",           manual: true },
];
export const MANUAL_SERVICES = SERVICES.filter((s) => s.manual).map((s) => s.key);
export const MANUAL_STATES = ["active", "scheduled", "stopped", "not_applicable"];

export const ACCOUNT_STATE_LABEL = {
  active: "利用中", scheduled: "停止予定", stopped: "停止済", not_applicable: "対象外",
  unknown: "未確認", error: "取得失敗", none: "登録なし",
};

export const ASSET_KIND_LABEL = { pc: "PC", phone: "携帯", account: "アカウント（貸与品台帳）", key: "鍵", other: "その他" };

const addDay = (d) => {
  const t = Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t + 86400000).toISOString().slice(0, 10) : null;
};

/** 実在する日付か（2026-02-30 などを断る） */
export function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/**
 * 退職日・最終出勤日の変更を、保存してよいか。保存してよければ null、だめなら {status, error, hint}
 * @param {{status:string, left_on:string|null}} emp 変更前の名簿の行
 * @param {{leftOn:string|null, lastWorkOn:string|null, confirmImmediate?:boolean}} next
 * @param {string} today 日本時間の YYYY-MM-DD
 */
export function checkDates(emp, next, today) {
  if (!["leaving", "left"].includes(emp?.status)) {
    return { status: 409, error: "not_retiring", hint: "退職手続き中・退職の人だけ、ここで退職日を変えられます。先にメンバー管理で状態を「退職手続き中」にしてください" };
  }
  if (next.leftOn !== null && !isRealDate(next.leftOn)) return { status: 400, error: "invalid_date", hint: "退職日を、実在する日付で入れてください" };
  if (next.lastWorkOn !== null && !isRealDate(next.lastWorkOn)) return { status: 400, error: "invalid_date", hint: "最終出勤日を、実在する日付で入れてください" };
  if (next.leftOn === null && emp.status === "left") return { status: 400, error: "left_on_required", hint: "退職済みの人の退職日は、空にできません" };
  if (next.leftOn === null && next.lastWorkOn !== null) return { status: 400, error: "left_on_required", hint: "最終出勤日を入れるときは、退職日も入れてください" };
  if (next.leftOn && next.lastWorkOn && next.lastWorkOn > next.leftOn) {
    return { status: 400, error: "last_after_left", hint: `最終出勤日（${next.lastWorkOn}）が退職日（${next.leftOn}）より後です。最終出勤日は退職日と同じか、それより前にしてください` };
  }
  // 日付の変更だけで、止まっている人を元に戻さない（退職の取消・再入社は、メンバー管理の手順で行う）
  const wasOut = isLeftEmployee(emp, today);
  const willOut = isLeftEmployee({ ...emp, left_on: next.leftOn }, today);
  if (wasOut && !willOut) {
    return { status: 409, error: "would_reopen", hint: "退職日を今日以降に動かすと、止まっている通常業務の利用が元に戻ります。退職の取消・延長は、日付の変更ではなく、メンバー管理で状態を戻してから行ってください" };
  }
  // 日付の変更だけで、いま使っている人をすぐ止めない（過去の日付にするなら、確認を求める）
  if (!wasOut && willOut && !next.confirmImmediate) {
    return { status: 409, error: "would_stop_now", hint: "退職日が今日より前のため、保存すると、すぐに通常業務（グループウェア）へ入れなくなります。よければ確認のうえ、もう一度保存してください", needsConfirm: true };
  }
  return null;
}

/** 日付を変えたら、作り直しが要るかもしれない発行済みの書類（発行済みの版は消さない・書き換えない） */
export function reissueHint(docs, changedLeftOn) {
  if (!changedLeftOn) return [];
  return KINDS.filter((k) => liveOf(docs, k.key)?.state === "issued").map((k) => k.label);
}

/**
 * サービスごとのアカウントの状態。
 * @param {object} a
 * @param {{status:string, left_on:string|null, user_id:string|null}} a.employee
 * @param {string} a.today
 * @param {{lms?:object|{error:true}, timecard?:object|{error:true}, accounting?:object|{error:true}}} a.reads 各システムの読み取り（無い＝登録なし、error＝読めなかった）
 * @param {object[]} a.manualRows gw_retire_accounts の行（未適用なら null）
 * @param {object|null} a.lastStop 最後の停止処理の結果（gw_activity_log の detail.systems）
 * @param {Map<string,string>} a.names user id → 氏名
 */
export function accountsView({ employee, today, reads = {}, manualRows = [], lastStop = null, names = new Map() }) {
  const out = employee?.status === "left" || isLeftEmployee(employee, today);
  const autoScheduled = employee?.status === "leaving" && employee?.left_on && !out;
  const autoOn = autoScheduled ? addDay(employee.left_on) : null;
  const rows = new Map((manualRows || []).map((r) => [r.service, r]));

  return SERVICES.map((s) => {
    const base = { key: s.key, label: s.label, how: s.manual ? "manual" : "auto" };
    if (s.manual) {
      if (manualRows === null) return { ...base, state: "error", note: "記録の表がまだありません（db/123）" };
      const r = rows.get(s.key);
      if (!r) return { ...base, state: "unknown", note: "利用状況を確認して、記録してください" };
      return {
        ...base, state: r.state, scheduledOn: r.scheduled_on || null,
        stoppedAt: r.stopped_at || null, stoppedBy: r.stopped_by ? names.get(r.stopped_by) || "（不明）" : null,
        updatedAt: r.updated_at || null, note: r.note || null,
        confirmLabel: r.state === "stopped" ? "担当者による停止確認" : null,
      };
    }

    if (!employee?.user_id) return { ...base, state: "none", note: "ログインアカウントがありません" };

    if (s.key === "groupware") {
      if (out) return { ...base, state: "stopped", note: "通常業務は使えません（退職者ページだけ使えます）" };
      if (autoScheduled) return { ...base, state: "scheduled", scheduledOn: autoOn, auto: true, note: "退職日の翌日 0 時から自動で使えなくなります" };
      return { ...base, state: "active" };
    }

    const r = reads[s.key];
    const failed = lastStop?.[s.key] && lastStop[s.key].ok === false;
    if (r?.error) return { ...base, state: "error", note: "状態を読めませんでした（停止済みとは扱いません）" };
    if (!r) return { ...base, state: "none", note: s.key === "accounting" ? "会計のメンバーではありません" : "登録がありません" };
    if (r.active) {
      if (out) {
        return { ...base, state: "active", warn: true,
          note: failed ? "停止に失敗しています。もう一度止めるか、各システムで止めてください" : "退職済みなのに利用中です。止まっているか確認してください" };
      }
      if (autoScheduled) return { ...base, state: "scheduled", scheduledOn: autoOn, auto: true, note: "退職日の翌日 0:05 に自動で止まります" };
      return { ...base, state: "active" };
    }
    return { ...base, state: "stopped", stoppedAt: r.stoppedAt || null };
  });
}

/**
 * 貸与品（いま貸し出し中のもの ＋ この退職で返却を記録したもの）。台帳の行は複製しない
 * @param {object[]} assigned gw_assets（assigned_to = 本人）
 * @param {object[]} returns gw_retire_asset_returns（null＝未適用）
 */
export function assetsView(assigned, returns) {
  const byAsset = new Map((returns || []).filter((r) => r.asset_id).map((r) => [r.asset_id, r]));
  const list = (assigned || []).map((a) => {
    const r = byAsset.get(a.id);
    byAsset.delete(a.id);
    return {
      assetId: a.id, kind: a.kind, kindLabel: ASSET_KIND_LABEL[a.kind] || a.kind, name: a.name, identifier: a.identifier || null,
      assignedOn: a.assigned_on || null, inventory: a.status,
      state: r?.state === "returned" ? "returned" : r?.state === "requested" ? "requested" : "assigned",
      dueOn: r?.due_on || null, requestedAt: r?.requested_at || null, returnedAt: r?.returned_at || null,
    };
  });
  // 返却済み（台帳の貸出先は外れている・次の人へ貸し出されているかもしれない）
  for (const r of [...byAsset.values(), ...(returns || []).filter((x) => !x.asset_id)]) {
    list.push({
      assetId: r.asset_id || null, kind: r.asset_kind, kindLabel: ASSET_KIND_LABEL[r.asset_kind] || r.asset_kind,
      name: r.asset_name, identifier: r.asset_identifier || null, assignedOn: null, inventory: null,
      state: r.state, dueOn: r.due_on || null, requestedAt: r.requested_at || null, returnedAt: r.returned_at || null,
    });
  }
  return list;
}

/**
 * 次にやること（実データから作る。古いチェックリストからは作らない）。押すと target の欄へ移る
 */
export function nextActions({ employee, docs = [], accounts = [], assets = [], today }) {
  const out = [];
  if (!employee?.left_on) out.push({ key: "left_on", text: "退職日が未設定です", target: "rc-basic" });
  for (const a of assets) {
    if (a.state === "assigned") out.push({ key: `asset:${a.assetId}`, text: `${a.kindLabel}返却待ち（${a.name}）`, target: "rc-assets" });
    else if (a.state === "requested") {
      const late = a.dueOn && a.dueOn < today;
      out.push({ key: `asset:${a.assetId}`, text: `${a.kindLabel}返却待ち（${a.name}${a.dueOn ? `・${late ? "予定日を過ぎています" : `${a.dueOn} 予定`}` : ""}）`, target: "rc-assets", late });
    }
  }
  for (const k of KINDS) {
    const d = liveOf(docs, k.key);
    if (!d || d.state === "processing" || d.state === "draft") out.push({ key: `doc:${k.key}`, text: `${k.label}未発行`, target: "rc-docs" });
    else if (d.state === "issued" && !d.published) out.push({ key: `doc:${k.key}`, text: `${k.label}未公開`, target: "rc-docs" });
  }
  for (const s of accounts) {
    if (s.state === "error") out.push({ key: `acct:${s.key}`, text: `${s.label}の状態を確認できません`, target: "rc-accounts" });
    else if (s.warn) out.push({ key: `acct:${s.key}`, text: `${s.label}が退職済みなのに利用中`, target: "rc-accounts", late: true });
    else if (s.how === "manual" && s.state === "unknown") out.push({ key: `acct:${s.key}`, text: `${s.label}の利用状況が未確認`, target: "rc-accounts" });
    else if (s.how === "manual" && (s.state === "active" || s.state === "scheduled")) {
      out.push({ key: `acct:${s.key}`, text: `${s.label}の停止が未確認${s.scheduledOn ? `（${s.scheduledOn} 予定・手動対応）` : ""}`, target: "rc-accounts" });
    }
  }
  return out;
}

/** 本人の対応（案内・閲覧・受領・署名を別々に） */
export function selfView(docs, selfEvents) {
  return KINDS.map((k) => {
    const d = liveOf(docs, k.key);
    const published = Boolean(d && d.state === "issued" && d.published);
    const opened = (selfEvents || []).filter((e) => e.detail?.docId && d && e.detail.docId === d.id);
    return {
      kind: k.key, label: k.label, published, publishedAt: published ? d.published_at || null : null,
      openedAt: opened.length ? opened.map((e) => e.ts).sort().pop() : null,
      // 受領・署名は、まだ記録する仕組みが無い（未対応・完了と決めつけない）
      received: null, signed: null,
    };
  });
}

const jp = (d) => {
  const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日` : null;
};

/**
 * 本人への案内文（メール・Slack）。退職理由・社内メモ・管理者用の URL は入れない。
 * URL は既存の認証が要る本人向けのもの：退職者として扱う人は退職者ページ、退職日前の人はいつものグループウェア
 */
export function guideText({ employee, docs = [], assets = [], selfTasks = [], baseUrl, today, remind = false }) {
  const name = employee?.display_name || "";
  const out = isLeftEmployee(employee, today);
  const url = out ? `${baseUrl}/retiree/` : `${baseUrl}/`;
  const urlNote = out
    ? "退職者ページ（いつものログインで開けます）"
    : "退職日までは、いつものグループウェアをお使いください。退職日の翌日からは、同じログインで退職者ページ（書類の確認）に切り替わります";
  const published = KINDS.filter((k) => { const d = liveOf(docs, k.key); return d && d.state === "issued" && d.published; }).map((k) => k.label);
  const toReturn = assets.filter((a) => a.state === "assigned" || a.state === "requested");
  const tasks = (selfTasks || []).filter((t) => t.status !== "done" && t.status !== "na");

  const lines = [];
  if (!remind) {
    lines.push(`${name} さん`);
    lines.push("");
    lines.push(employee?.left_on ? `退職日（${jp(employee.left_on)}）に向けたお手続きのご案内です。` : "退職に向けたお手続きのご案内です。");
  } else {
    lines.push(`${name} さん`);
    lines.push("");
    lines.push("退職のお手続きで、まだお済みでないものがあります。お手数ですがご確認ください。");
  }
  if (published.length && !remind) {
    lines.push("");
    lines.push("■ ご確認いただける書類");
    for (const p of published) lines.push(`・${p}`);
  }
  if (tasks.length) {
    lines.push("");
    lines.push("■ ご本人にお願いしたいこと");
    for (const t of tasks) lines.push(`・${t.title}${t.due_on ? `（${jp(t.due_on)}まで）` : ""}`);
  }
  if (toReturn.length) {
    lines.push("");
    lines.push("■ ご返却をお願いするもの");
    for (const a of toReturn) lines.push(`・${a.kindLabel}：${a.name}${a.dueOn ? `（${jp(a.dueOn)}まで）` : ""}`);
  }
  if (remind && !tasks.length && !toReturn.length) {
    lines.push("");
    lines.push("（いま、ご本人にお願いしている未完了の項目はありません）");
  }
  lines.push("");
  lines.push(`■ ${urlNote}`);
  lines.push(url);
  lines.push("");
  lines.push("ご不明な点があれば、人事までご連絡ください。");
  const email = lines.join("\n");
  const slack = lines.filter((l, i) => !(i === 1 && l === "")).join("\n").replace(/^■ /gm, "*").replace(/^(\*.+)$/gm, "$1*");
  return { email, slack, url, urlNote, empty: remind && !tasks.length && !toReturn.length };
}

const ACT_TEXT = {
  "retire.publish": "書類を本人に公開", "retire.unpublish": "書類の公開を停止",
  "retire.register": "書類を登録", "retire.reissue": "書類を再発行", "retire.issue": "書類を発行",
  "retire.admin_view": "書類をプレビュー（管理者）", "retire.reason": "退職理由を変更", "retire.progress": "書類を手続き中に変更",
  "retire.cert_draft": "退職証明書の下書きを作成", "retire.cert_preview": "退職証明書をプレビュー（管理者）",
  "retire.view": "書類を開いた（本人）", "retire.download": "書類を保存した（本人）",
  "account.suspend": "社内システムの入口を閉じた", "account.resume": "社内システムの入口を開け直した",
  "employee.status": "在籍状態を変更",
  // 退職証明書の本人申請（db/127・lib/retire-cert-request.js）
  "retire.cert_request": "退職証明書の発行を申請（誓約済み）",
  "retire.cert_approve": "退職証明書の申請を承認して発行・本人に公開",
  "retire.cert_return": "退職証明書の申請を差し戻し",
};

/**
 * 履歴（誰が・いつ・何を）。本人・管理者・自動を分ける。
 * @param {object[]} events gw_retire_events
 * @param {object[]} logs gw_activity_log（target = employee:<id>）
 * @param {{userId:string|null}} self 本人のログイン ID
 * @param {Map<string,string>} names user id → 氏名
 */
export function historyView(events, logs, self, names = new Map()) {
  const who = (actorId, fallback) => {
    if (!actorId) return { whoKind: "system", who: "自動" };
    if (self?.userId && actorId === self.userId) return { whoKind: "self", who: "本人" };
    return { whoKind: "admin", who: fallback || names.get(actorId) || "管理者" };
  };
  const rows = [];
  for (const e of events || []) {
    const d = e.detail || {};
    let text = "";
    if (e.kind === "dates.update") {
      const parts = [];
      if (d.leftOn && d.leftOn.from !== d.leftOn.to) parts.push(`退職日 ${d.leftOn.from || "未設定"} → ${d.leftOn.to || "未設定"}`);
      if (d.lastWorkOn && d.lastWorkOn.from !== d.lastWorkOn.to) parts.push(`最終出勤日 ${d.lastWorkOn.from || "未設定"} → ${d.lastWorkOn.to || "未設定"}`);
      if (d.owner && d.owner.from !== d.owner.to) parts.push("担当者を変更");
      text = parts.length ? parts.join("・") : "基本情報を保存（変更なし）";
    } else if (e.kind === "asset.request") text = `返却を依頼：${d.name || "貸与品"}${d.dueOn ? `（${d.dueOn} 予定）` : ""}`;
    else if (e.kind === "asset.return") text = `返却を確認：${d.name || "貸与品"}`;
    else if (e.kind === "account.update") text = `${d.label || d.service}：${ACCOUNT_STATE_LABEL[d.from] || "未確認"} → ${ACCOUNT_STATE_LABEL[d.to] || d.to}${d.to === "stopped" ? "（担当者による停止確認）" : ""}`;
    rows.push({ at: e.created_at, ...who(e.actor_id, e.actor_name), text, source: "retire" });
  }
  for (const l of logs || []) {
    const base = ACT_TEXT[l.action];
    if (!base) continue;
    const d = l.detail || {};
    let text = base;
    if (d.kind) text += `：${kindLabel(d.kind)}${d.version ? `（第${d.version}版）` : ""}`;
    if (l.action === "employee.status" && d.status) text += `（${{ active: "在籍", leaving: "退職手続き中", left: "退職", invited: "入社準備" }[d.status] || d.status}${d.auto ? "・退職日の翌日に自動" : ""}）`;
    if ((l.action === "account.suspend" || (l.action === "employee.status" && d.systems)) && d.systems) {
      const bad = Object.entries(d.systems).filter(([, v]) => v && v.ok === false).map(([k]) => SERVICES.find((s) => s.key === k)?.label || k);
      if (bad.length) text += `　停止に失敗：${bad.join("・")}`;
    }
    rows.push({ at: l.ts, ...who(l.actor_id), text, source: "log" });
  }
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** 最後の停止処理の結果（account.suspend か、自動で退職にしたときの employee.status）。detail.systems */
export function lastStopOf(logs) {
  const hit = (logs || [])
    .filter((l) => (l.action === "account.suspend" || l.action === "employee.status") && l.detail?.systems)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0];
  return hit ? hit.detail.systems : null;
}
