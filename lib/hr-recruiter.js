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
