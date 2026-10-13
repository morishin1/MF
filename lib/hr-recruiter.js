// 採用HRの「担当」（gw_hr_applicants.recruiter_id）。
//
// ■ 担当に選べるのは、同じ会社の社員（在籍・入社準備）だけ
//   一覧・詳細・一括変更の選択肢（gw_employees の active / invited）と同じ条件。
//   API を直接叩いて、別の会社の人や退職者を担当にできないようにする。
//
// ■ 応募者を登録したとき、担当を選ばなければ登録した本人を担当にする
//   「担当：未定」のまま NEXT ACTION が誰にも届かない状態を作らない。

/** 空（担当を外す）はそのまま通す。値があれば同じ会社の在籍者か確かめる */
export async function checkRecruiter(sb, tenantId, recruiterId) {
  if (!recruiterId) return { ok: true, value: null };
  const { data } = await sb.from("gw_employees").select("id, status")
    .eq("id", recruiterId).eq("tenant_id", tenantId).maybeSingle();
  if (!data || !["active", "invited"].includes(data.status)) {
    return { ok: false, error: "invalid_recruiter", hint: "担当は、この会社の在籍者から選んでください" };
  }
  return { ok: true, value: data.id };
}

/**
 * 「担当になった」通知（HRフロー仕様 §16）。自分で自分を担当にしたときは送らない。
 * 応募者×担当ごとに1件（同じ人へ同じ応募者を付け直しても増やさない）。
 * @param {Function} notify lib/notify.js の notify（呼び出し側から渡す。ここは DB に依存しない）
 * @param {{tenantId:string, recruiterId:string|null, actorEmployeeId:string|null, applicants:{id:string,name:string}[]}} p
 */
export async function notifyAssigned(notify, { tenantId, recruiterId, actorEmployeeId, applicants }) {
  if (!recruiterId || recruiterId === actorEmployeeId) return { created: 0 };
  const list = applicants || [];
  if (!list.length) return { created: 0 };
  const many = list.length > 1;
  return notify([{
    tenantId, employeeId: recruiterId, kind: "hr",
    title: many ? `${list.length}名の応募者の担当になりました` : "新しい応募者の担当になりました",
    body: list.slice(0, 5).map((a) => a.name).join("\n") + (list.length > 5 ? `\nほか${list.length - 5}名` : ""),
    link: many ? "/hr/applicants.html" : `/hr/applicants.html?id=${list[0].id}`,
    dedupeKey: many ? `hr_assigned_bulk:${recruiterId}:${list.map((a) => a.id).sort().join(",").slice(0, 180)}` : `hr_assigned:${list[0].id}:${recruiterId}`,
  }]);
}
