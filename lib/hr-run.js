// 入退社を、実際に人へ配るところ。
//
// ■ なぜ api/hr から切り出したのか
//
//   担当を決めて知らせる、という同じことを2か所からやる。
//
//     ・管理画面で「入退社を登録する」を押したとき（api/hr）
//     ・新規メンバー登録から入社準備一式ができたとき（lib/onboard.js）
//
//   片方にしか無いと、登録の画面から入れた人だけ誰にも知らされない、
//   という状態になる。入社日は入っているのに、当日まで誰も動かない。
//
// ■ ここに閉じ込めてあること
//
//   1. ロール（人事 / IT・管理 / 上長 / 経理）から実際の人を1人決める
//   2. 足りない手順を足し、担当が空の行を埋める
//   3. 担当者へ、お知らせと「やること」を1人1通で配る

import { notify } from "./notify.js";
import { notifySlack } from "./slack.js";
import { flowItems, ROLE_LABEL } from "./hr-flow.js";

// ---- 担当を決める ----------------------------------------------------------------
//
// ロール（人事 / IT・管理 / 上長 / 経理）から、実際の人を1人選ぶ。
//
// 「IT・管理の誰か」のままにしておくと、誰もやらない。
// 決まらなかったときは空のまま置いて、画面で「担当未定」と出す。
// 勝手に人事へ寄せない（寄せると、また全部が人事の仕事になる）
export async function assigneesFor(sb, tenantId, employee, people) {
  const { data: grants } = await sb.from("gw_role_grants")
    .select("employee_id, role").eq("tenant_id", tenantId).limit(500);

  const byRoleKey = new Map();
  for (const g of grants || []) {
    if (!byRoleKey.has(g.role)) byRoleKey.set(g.role, []);
    byRoleKey.get(g.role).push(g.employee_id);
  }
  const first = (...roles) => {
    for (const r of roles) {
      const ids = (byRoleKey.get(r) || []).filter((id) => people.has(id));
      if (ids.length) return ids[0];
    }
    return null;
  };

  return {
    hr: first("hr", "owner"),
    // IT・管理のロールがまだ無い会社では、人事が兼ねていることが多い。
    // ただし「兼ねている」と分かるように、画面には IT・管理 として出す
    it: first("it", "hr", "owner"),
    // 上長は、その人の上長。決まっていなければ責任者ロール
    manager: employee?.manager_id && people.has(employee.manager_id)
      ? employee.manager_id
      : first("manager", "owner"),
    finance: first("finance", "hr", "owner"),
    employee: employee?.id || null,
  };
}

/**
 * チェックリストを用意する。
 *
 * すでにある項目は触らない（チェックを消さない）。
 * 足りないものだけ足す。手順を増やしたときに、
 * 進行中の手続きにも自動で入るようにするため
 */
export async function seed(sb, ctx, proc, empRow, people) {
  const want = flowItems(proc.kind);

  const { data: had, error: readErr } = await sb.from("gw_procedure_items")
    .select("id, item_key, assignee_id").eq("procedure_id", proc.id).limit(300);
  if (readErr) return { added: 0, error: readErr.message };

  const have = new Set((had || []).map((i) => i.item_key).filter(Boolean));
  const missing = want.filter((w) => !have.has(w.key));

  const who = await assigneesFor(sb, ctx.tenantId, empRow, people);

  // 担当が空のまま置かれている行を埋める。
  //
  // 新規メンバー登録（lib/onboard-kit.js）から作られた手続きには、
  // 手順は入っているが担当が入っていない。空のままだと誰にも知らせられず、
  // 「作ったのに誰も動かない」がそのまま起きる
  const blank = (had || []).filter((i) => i.item_key && !i.assignee_id);
  for (const b of blank) {
    const def = want.find((w) => w.key === b.item_key);
    const to = def && who[def.role];
    if (!to) continue;
    await sb.from("gw_procedure_items")
      .update({ assignee_id: to, phase: def.phase }).eq("id", b.id);
  }

  if (!missing.length) return { added: 0, filled: blank.length };

  const { error } = await sb.from("gw_procedure_items").insert(missing.map((w) => ({
    tenant_id: ctx.tenantId,
    procedure_id: proc.id,
    item_key: w.key,
    title: w.title,
    category: "task",
    owner: w.role,
    phase: w.phase,
    assignee_id: who[w.role] || null,
    required: true,
    // 既定に任せない。日付を変えたときに in("status", …) で期限を動かすので、
    // ここが空だと、その行だけ古い期限のまま置いていかれる
    status: "todo",
    // 準備は入社日・退社日まで。初日ぶんは当日
    due_on: proc.target_on || null,
    sort_order: w.sortOrder,
  })));
  if (error) return { added: 0, error: error.message };
  return { added: missing.length };
}

/**
 * 担当者に知らせる。
 *
 * ■ 1人1通にまとめる
 *   担当が3件あっても、知らせは1通。
 *   件数ぶん届くと、読まれずに消される。
 *
 * ■ 「やること」にも入れる
 *   お知らせは流れていく。やることは、片づくまで消えない。
 *   通知からも、やることからも、その人の入退社画面へ直接飛べるようにする。
 *
 * ■ 同じ日付で2度は知らせない
 *   入社日を変えたときだけ、知らせ直す（notified_for）
 */
export async function tell(sb, ctx, proc, emp, people, { force = false } = {}) {
  const key = proc.target_on || "未定";
  if (!force && proc.notified_for === key) return { people: 0, skipped: "already" };

  const { data: items } = await sb.from("gw_procedure_items")
    .select("assignee_id, owner, status, title")
    .eq("procedure_id", proc.id).limit(300);

  const mine = (items || []).filter((i) =>
    i.assignee_id && i.owner !== "employee" && i.status !== "done" && i.status !== "na");

  const byWho = new Map();
  for (const i of mine) {
    const cur = byWho.get(i.assignee_id) || { n: 0, roles: new Set() };
    cur.n += 1;
    cur.roles.add(ROLE_LABEL[i.owner] || i.owner);
    byWho.set(i.assignee_id, cur);
  }
  if (!byWho.size) return { people: 0 };

  const what = proc.kind === "offboarding" ? "退社" : "入社";
  const when = proc.target_on
    ? new Date(`${proc.target_on}T00:00:00Z`)
      .toLocaleDateString("ja-JP", { month: "long", day: "numeric", timeZone: "UTC" })
    : "日付未定";
  const link = `admin-hr.html?id=${proc.id}`;

  await notify([...byWho.entries()].map(([employeeId, v]) => ({
    tenantId: ctx.tenantId,
    employeeId,
    kind: "hr_flow",
    title: `${emp.name}さんが${when}${what}予定です`,
    body: `あなたの担当タスクが ${v.n}件 あります（${[...v.roles].join("・")}）。`
        + "ここから開いて、終わったものにチェックを付けてください。",
    link,
    // 1人1通。日付を変えたら、同じ通知を新しくする
    dedupeKey: `hr_flow:${proc.id}`,
  })));

  // 「やること」にも入れる。お知らせは流れるが、こちらは片づくまで残る
  const rows = [...byWho.entries()].map(([employeeId, v]) => ({
    tenant_id: ctx.tenantId,
    title: `${emp.name}さんの${what}対応（${v.n}件）`,
    body: `${when}${what}予定。${[...v.roles].join("・")}の担当ぶんです。`,
    assignee_id: employeeId,
    due_on: proc.target_on || null,
    priority: "high",
    status: "todo",
    category: "入退社",
    link,
  }));
  try {
    // 同じ手続きの古いものは消してから入れ直す。
    // 日付を変えるたびに積み上がると、やることが同じ件で埋まる
    await sb.from("gw_tasks").delete().eq("category", "入退社")
      .eq("tenant_id", ctx.tenantId).like("link", `%${proc.id}%`);
    const { error } = await sb.from("gw_tasks").insert(rows);
    if (error) throw error;
  } catch (e) {
    // やることに入らなくても、お知らせは届いている。手続きは止めない
    console.error("[hr] やることに入れられませんでした:", e?.message || e);
  }

  await notifySlack({
    text: `【${what}】${emp.name}さん（${when}）`,
    lines: [...byWho.entries()].map(([who, v]) =>
      `${people.get(who)?.name || "（不明）"}：${v.n}件（${[...v.roles].join("・")}）`),
    link,
  }).catch(() => {});

  await sb.from("gw_procedures").update({
    notified_at: new Date().toISOString(), notified_for: key,
  }).eq("id", proc.id);

  return { people: byWho.size };
}
