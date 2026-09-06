// 社内システムのアカウントを、1人ぶんまとめて扱う。
//
// ■ どういう作りになっているか
//   エイトの4システムは、同じ Supabase プロジェクトの同じ auth.users を使っている。
//
//       auth.users.id ──┬─ gw_employees.user_id   グループウェア（★人事の正）
//                       ├─ profiles.id            無限道場（LMS）
//                       ├─ tc_profiles.id         タイムカード・日報
//                       └─ memberships.user_id    会計
//
//   紐づけ表は作らない。auth.users.id が既に共通のキーになっているので、
//   別に「社員マスタ」を立てると、正が2つになって必ず食い違う。
//   氏名・入社・退職は gw_employees を正とし、他はそこにぶら下がる形にする。
//
// ■ ここが書き込むもの
//   「入口を開けるか閉めるか」だけ。
//   受講状況・時給・LMSのロールといった各システムの中身には触らない。
//   それぞれのシステムが決めることで、こちらが上書きしてよいものではない。
//
// ■ 落とさない
//   どれか1つの表が無い環境（マイグレーション未適用など）でも、
//   社員の追加そのものは成功させる。結果は report に集めて画面へ返す。

const LMS_TABLE = "profiles";          // 無限道場。id = auth.users.id
const TC_TABLE = "tc_profiles";        // タイムカード・日報。id = auth.users.id

export const SYSTEMS = [
  { key: "groupware",  label: "グループウェア" },
  { key: "lms",        label: "無限道場" },
  { key: "timecard",   label: "タイムカード・日報" },
  { key: "accounting", label: "会計" },
];

// 雇用区分の呼び方が2つの表で少し違う。タイムカード側の言い方に寄せる
const TC_EMPLOY_TYPE = { アルバイト: "バイト", パート: "バイト" };
const tcEmployType = (v) => (v ? TC_EMPLOY_TYPE[v] || v : null);

/**
 * 複数人ぶんの「どのシステムに登録されていて、入れる状態か」を一度に読む。
 * 名簿の一覧に添えるためのもの。読めない表は黙って飛ばす。
 * @returns {Promise<Map<string, object>>} userId → 状態
 */
export async function readAccounts(sb, userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  for (const id of ids) out.set(id, {});

  const [lms, tc, ms] = await Promise.all([
    sb.from(LMS_TABLE).select("id, name, role, approval_status, suspended_at").in("id", ids),
    sb.from(TC_TABLE).select("id, name, employ_type, status").in("id", ids),
    sb.from("memberships").select("user_id, role").in("user_id", ids),
  ]);

  for (const r of lms.data || []) {
    out.get(r.id).lms = {
      exists: true,
      role: r.role,
      // 無限道場が入口を閉める手段は2つ。rejected は却下・削除、suspended_at は停止
      active: r.approval_status !== "rejected" && !r.suspended_at,
    };
  }
  for (const r of tc.data || []) {
    out.get(r.id).timecard = { exists: true, active: r.status === "active", employType: r.employ_type };
  }
  for (const r of ms.data || []) {
    const cur = out.get(r.user_id);
    // 管理者・担当者のほうを表に出す（顧問先ロールと両方持つことがある）
    if (!cur.accounting || r.role !== "client") cur.accounting = { exists: true, active: true, role: r.role };
  }
  return out;
}

/**
 * 入社したときに、各システムの入口を開ける。
 * auth.users は先に作られている前提（作るのは api/employees/link.js）。
 *
 * 無限道場の profiles 行は auth.users への insert トリガー（handle_new_user）が
 * 自動で作る。つまりアカウントを作った時点で受講者としては登録済みになる。
 * ここでは氏名を名簿と合わせ、止まっていたら開け直すだけにする。
 * LMSのロール（student / instructor / admin）は触らない。あちらが決めること。
 */
export async function provisionAccounts(sb, { userId, name, employmentType }) {
  const report = {};

  // --- 無限道場 --------------------------------------------------------------
  report.lms = await guard(async () => {
    const patch = { name, approval_status: "approved", suspended_at: null };
    const { data, error } = await sb.from(LMS_TABLE).update(patch).eq("id", userId).select("id").maybeSingle();
    if (error) throw error;
    if (data) return "更新";
    // トリガーが動かない環境。role は既定（student）に任せる
    const { error: ie } = await sb.from(LMS_TABLE).insert({ id: userId, ...patch });
    if (ie) throw ie;
    return "作成";
  });

  // --- タイムカード・日報 ----------------------------------------------------
  // pw（簡易ログインのパスワード）はここでは入れない。
  // 入れると、その人が旧画面へ入れる合鍵をこちらが勝手に作ることになる。
  report.timecard = await guard(async () => {
    const patch = { name, employ_type: tcEmployType(employmentType), status: "active" };
    const { data, error } = await sb.from(TC_TABLE).update(patch).eq("id", userId).select("id").maybeSingle();
    if (error) throw error;
    if (data) return "更新";
    const { error: ie } = await sb.from(TC_TABLE).insert({ id: userId, ...patch });
    if (ie) throw ie;
    return "作成";
  });

  return report;
}

/**
 * 退職したときに入口を閉じる／在籍に戻したときに開け直す。
 *
 * ログインアカウント（auth.users）は消さない。
 * 経費・申請・日報・受講の記録がぶら下がっていて、消すと一緒に消えるため。
 * 「入れなくする」ことと「無かったことにする」ことは別。
 */
export async function setAccountsActive(sb, userId, active) {
  const report = {};

  report.lms = await guard(async () => {
    // rejected は「却下・削除」の意味なので退職には使わない。suspended_at で止める
    const { error } = await sb.from(LMS_TABLE)
      .update({ suspended_at: active ? null : new Date().toISOString() })
      .eq("id", userId);
    if (error) throw error;
    return active ? "再開" : "停止";
  });

  report.timecard = await guard(async () => {
    const { error } = await sb.from(TC_TABLE)
      .update({ status: active ? "active" : "disabled" })
      .eq("id", userId);
    if (error) throw error;
    return active ? "再開" : "停止";
  });

  return report;
}

/**
 * 退職時に会計のメンバーシップを外す。
 * こちらは「入れなくする」ではなく本当に外す。会計は顧問先ごとの書類が見える
 * 仕組みなので、止まっているだけの行を残すと、あとで戻したときに気づけない。
 */
export async function removeAccountingAccess(sb, tenantId, userId) {
  return guard(async () => {
    const { error } = await sb.from("memberships")
      .delete().eq("tenant_id", tenantId).eq("user_id", userId);
    if (error) throw error;
    return "解除";
  });
}

// 1システムの失敗で他を巻き込まない。理由は画面に出せる形で返す
async function guard(fn) {
  try {
    return { ok: true, action: await fn() };
  } catch (e) {
    return { ok: false, detail: e?.message || String(e) };
  }
}

// -----------------------------------------------------------------------------
// ログインアカウント（auth.users）の用意
// -----------------------------------------------------------------------------

/** 初回パスワード。読み上げや転記で困らないよう、紛らわしい文字を外す */
export function randomPassword(len = 12) {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export async function findUserByEmail(sb, email) {
  const want = String(email || "").trim().toLowerCase();
  if (!want) return null;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error("listUsers: " + error.message);
    const hit = (data?.users || []).find((u) => (u.email || "").toLowerCase() === want);
    if (hit) return hit.id;
    if (!data?.users?.length || data.users.length < 200) break;
  }
  return null;
}

/**
 * 会計側のメンバーシップ。既にあれば触らない（管理者を降格させないため）。
 */
export async function ensureMembership(sb, tenantId, userId, clientId) {
  const { data: existing } = await sb
    .from("memberships").select("id, role")
    .eq("tenant_id", tenantId).eq("user_id", userId).limit(1).maybeSingle();
  if (existing) return { created: false, role: existing.role };

  let targetClient = clientId;
  if (!targetClient) {
    const { data: client } = await sb
      .from("clients").select("id").eq("tenant_id", tenantId)
      .order("name", { ascending: true }).limit(1).maybeSingle();
    targetClient = client?.id || null;
  }
  if (!targetClient) return { created: false, role: null, note: "取引先が未登録のためメンバーシップは作りませんでした" };

  const { error } = await sb.from("memberships")
    .insert({ tenant_id: tenantId, user_id: userId, role: "client", client_id: targetClient });
  if (error) return { created: false, role: null, note: error.message };
  return { created: true, role: "client" };
}

/**
 * システムを1つだけ、使える／使えないにする。
 *
 * ■ グループウェアはここでは切れない
 *   名簿に行があること自体がグループウェアの利用。
 *   切りたい場合は在籍の状態（退職）で閉じる。
 *
 * ■ 止めるときも、アカウントは消さない
 *   日報・受講・経費の記録がぶら下がっている。
 *   「入れなくする」ことと「無かったことにする」ことは別。
 *   会計だけは例外で、本当に外す（顧問先の書類が見える仕組みのため、
 *   止まっているだけの行を残すと、あとで戻したときに気づけない）。
 *
 * @param {{tenantId:string, userId:string, system:string, on:boolean,
 *          name?:string, employmentType?:string, clientId?:string}} p
 */
export async function setSystemAccess(sb, { tenantId, userId, system, on, name, employmentType, clientId }) {
  if (!userId) return { ok: false, detail: "ログインアカウントがありません" };

  if (system === "lms") {
    return guard(async () => {
      if (!on) {
        const { error } = await sb.from(LMS_TABLE)
          .update({ suspended_at: new Date().toISOString() }).eq("id", userId);
        if (error) throw error;
        return "停止";
      }
      const patch = { name, approval_status: "approved", suspended_at: null };
      const { data, error } = await sb.from(LMS_TABLE)
        .update(patch).eq("id", userId).select("id").maybeSingle();
      if (error) throw error;
      if (data) return "開放";
      const { error: ie } = await sb.from(LMS_TABLE).insert({ id: userId, ...patch });
      if (ie) throw ie;
      return "作成";
    });
  }

  if (system === "timecard") {
    return guard(async () => {
      if (!on) {
        const { error } = await sb.from(TC_TABLE).update({ status: "disabled" }).eq("id", userId);
        if (error) throw error;
        return "停止";
      }
      const patch = { name, employ_type: tcEmployType(employmentType), status: "active" };
      const { data, error } = await sb.from(TC_TABLE)
        .update(patch).eq("id", userId).select("id").maybeSingle();
      if (error) throw error;
      if (data) return "開放";
      const { error: ie } = await sb.from(TC_TABLE).insert({ id: userId, ...patch });
      if (ie) throw ie;
      return "作成";
    });
  }

  if (system === "accounting") {
    if (!on) return removeAccountingAccess(sb, tenantId, userId);
    return guard(async () => {
      const r = await ensureMembership(sb, tenantId, userId, clientId);
      if (r.note) throw new Error(r.note);
      return r.created ? "開放" : "すでに使えます";
    });
  }

  return { ok: false, detail: `${system} は個別に切り替えられません` };
}

/**
 * 社員名簿の1行に、ログインアカウントを結び付ける。無ければ作る。
 * ここまでやって初めて、その人は全システムに入れる。
 *
 * 手順を1本にまとめてあるのは、以前これが
 *   名簿に追加 → アカウントを作る → 紐づける → 各システムに登録
 * と4手に分かれていて、途中で止まった人が「名簿にはいるがどこにも入れない」
 * 状態で残っていたため。
 *
 * @returns {Promise<{ok:boolean, error?:string, hint?:string, status?:number, ...}>}
 */
export async function attachAccount(sb, { tenantId, employee, email, password, create = true, clientId }) {
  const addr = String(email || "").trim().toLowerCase();
  if (!addr) return { ok: false, status: 400, error: "invalid_email", hint: "メールアドレスを入れてください" };
  if (employee.user_id) return { ok: false, status: 409, error: "already_linked" };

  let userId;
  try {
    userId = await findUserByEmail(sb, addr);
  } catch (e) {
    return { ok: false, status: 500, error: "list_users_failed", detail: e.message };
  }

  let createdPassword = null;
  // 新しく作ったのか、既にあったものに紐づけたのか。
  // 画面の書き分けに使う（初回パスワードが出ないのは、
  // 「既存に紐づけた」ときと「管理者がパスワードを決めた」ときで意味が違う）
  let madeNew = false;
  if (!userId) {
    if (!create) {
      return {
        ok: false, status: 404, error: "auth_user_not_found",
        hint: "そのメールアドレスのログインアカウントがありません。「アカウントを作る」を押すとこの場で作成できます",
      };
    }
    const pw = String(password || "").trim() || randomPassword();
    if (pw.length < 8) return { ok: false, status: 400, error: "weak_password", hint: "パスワードは8文字以上にしてください" };

    // name を添えるのは無限道場のため。auth.users への insert トリガー
    // （handle_new_user）が profiles を作るとき、name が無いとメールの
    // @ より前（"taro"）が氏名として入ってしまう。
    const { data: created, error } = await sb.auth.admin.createUser({
      email: addr, password: pw, email_confirm: true,
      user_metadata: { name: employee.display_name },
    });
    if (error) return { ok: false, status: 500, error: "create_user_failed", detail: error.message };
    userId = created.user.id;
    // 自動生成のときだけ返す。管理者が決めたものは、その人が知っているので返さない
    createdPassword = password ? null : pw;
    madeNew = true;
  }

  // 1つのアカウントを2人の社員に割り当てない
  const { data: taken } = await sb
    .from("gw_employees").select("id, display_name")
    .eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle();
  if (taken && taken.id !== employee.id) {
    return { ok: false, status: 409, error: "user_already_assigned", detail: `${taken.display_name} さんに割り当て済みです` };
  }

  const { error: ue } = await sb
    .from("gw_employees").update({ user_id: userId, updated_at: new Date().toISOString() })
    .eq("id", employee.id);
  if (ue) return { ok: false, status: 500, error: "db_update_failed", detail: ue.message };

  // 社労士は社外の人。会計の権限は与えず、他システムにも登録しない
  const { data: grants } = await sb.from("gw_role_grants").select("role").eq("employee_id", employee.id);
  if ((grants || []).some((g) => g.role === "labor_advisor")) {
    return {
      ok: true, userId, createdPassword, madeNew,
      membership: { created: false, role: null, note: "社労士のため会計の権限は付与していません" },
      systems: { note: "社外の方のため、無限道場・タイムカードには登録していません" },
    };
  }

  const systems = await provisionAccounts(sb, {
    userId,
    name: employee.display_name,
    employmentType: employee.employment_type,
  });
  const membership = await ensureMembership(sb, tenantId, userId, clientId);

  return { ok: true, userId, createdPassword, madeNew, membership, systems };
}
