// 入社手続きの段階を計算し直して、進んでいたら次の担当者へ知らせる。
//
// ■ 呼ぶ場所
//
//   事実が変わるところ、全部。
//     作成依頼を出した／書面が届いた／発行した（api/sign/orders.js）
//     本人が署名した（api/sign/me.js）
//     本人が届出を出した（api/onboarding/me.js）
//     チェックを付けた（api/onboarding/items.js, api/hr/index.js）
//
//   どこか1か所で呼び忘れると、その経路だけ段階が止まって見える。
//   だから「事実を書いたら advance」を型にする。呼ぶ側は結果を待たない。
//
// ■ 失敗しても、元の操作は成功させる
//
//   070 をまだ流していない環境では stage 列が無い。
//   そこで落ちて「署名できませんでした」になるのは、本末転倒。
//   ここは全部 try/catch で包んで、console に出すだけ。
//
// ■ 知らせるのは「進んだとき」だけ
//
//   同じ段階のまま advance が何度走っても、通知は出ない。
//   前回の stage と比べて変わったときだけ、次の担当者に1通。

import { computeStage, stageOf } from "./onboard-stage.js";
import { consentState, CONSENT_DOCS } from "./consent-docs.js";
import { notify } from "./notify.js";

/**
 * 同意の対象になる文書。
 *
 * gw_consent_docs は、本人がはじめて画面を開いたときに
 * コード（CONSENT_DOCS）から写される。それまでは空。
 * 空のまま「同意がそろっていない」と判定すると、署名が済んでも
 * 全員が ③ で止まって見える。表が空ならコードの版で判定する
 */
function activeDocs(rows) {
  if (rows && rows.length) return rows;
  return CONSENT_DOCS.map((d) => ({ ...d, doc_key: d.key }));
}

/**
 * 事実を集める。5つの表を読む。
 * 表が無い（未適用）ときは、その事実だけ「無い」ことにして続ける
 */
export async function gatherFacts(sb, tenantId, proc) {
  const empId = proc.employee_id;
  const soft = async (p) => { try { return (await p)?.data ?? null; } catch { return null; } };

  const [orders, signs, profile, agreed, docs, items] = await Promise.all([
    soft(sb.from("gw_doc_orders").select("id, status, updated_at")
      .eq("employee_id", empId).eq("doc_kind", "employment")
      .neq("status", "cancelled").order("updated_at", { ascending: false }).limit(1)),
    soft(sb.from("gw_sign_requests").select("id, status, signed_at")
      .eq("employee_id", empId).eq("doc_kind", "employment")
      .neq("status", "cancelled").order("sent_at", { ascending: false }).limit(1)),
    soft(sb.from("gw_onboard_profiles").select("status, submitted_at")
      .eq("employee_id", empId).maybeSingle()),
    soft(sb.from("gw_onboard_consents").select("kind, version, agreed_at").eq("employee_id", empId)),
    soft(sb.from("gw_consent_docs").select("*").eq("tenant_id", tenantId).eq("status", "active")),
    soft(sb.from("gw_procedure_items").select("id, owner, required, status, title")
      .eq("procedure_id", proc.id)),
  ]);

  const consentsOk = consentState(activeDocs(docs), agreed || []).every((c) => c.agreed);

  return {
    procedure: proc,
    order: (orders || [])[0] || null,
    sign: (signs || [])[0] || null,
    profile: profile || null,
    consentsOk,
    items: items || [],
  };
}

/**
 * 段階を計算し直し、進んでいれば書いて知らせる。
 *
 * @param {object} sb        service_role のクライアント
 * @param {object} ctx       { tenantId }
 * @param {string} procId    gw_procedures.id
 * @param {object} [opts]    { people: Map<employeeId,{name}>, advisorIds: string[] }
 * @returns {Promise<{stage:string, changed:boolean}|null>}
 */
export async function advance(sb, ctx, procId, opts = {}) {
  try {
    const { data: proc } = await sb.from("gw_procedures")
      .select("id, tenant_id, employee_id, kind, status, target_on, stage")
      .eq("id", procId).maybeSingle();
    if (!proc || proc.kind !== "onboarding") return null;

    const facts = await gatherFacts(sb, ctx.tenantId, proc);
    const now = computeStage(facts);
    const changed = now.key !== proc.stage;

    if (changed) {
      const at = new Date().toISOString();
      const patch = { stage: now.key, stage_at: at, updated_at: at };
      // 全部そろったら、手続き本体も完了にする
      if (now.key === "complete" && proc.status !== "done") patch.status = "done";
      const { error } = await sb.from("gw_procedures").update(patch).eq("id", proc.id);
      if (error) {
        // 070 がまだ。段階は計算できるが書けない。知らせもしない（次に流したときに1回だけ出る）
        console.error("[onboard] stage を書けませんでした:", error.message);
        return { stage: now.key, changed: false, notReady: true };
      }
      await tellNext(sb, ctx, proc, now, opts);
    }
    return { stage: now.key, changed };
  } catch (e) {
    console.error("[onboard] advance:", e?.message || e);
    return null;
  }
}

/**
 * 次の担当者に1通。
 *
 *   管理者    … 人事ロールの人（gw_role_grants hr / owner）
 *   社労士    … labor_advisor
 *   本人      … その社員
 */
async function tellNext(sb, ctx, proc, now, opts) {
  const stage = stageOf(now.key);
  const { data: emp } = await sb.from("gw_employees")
    .select("id, display_name").eq("id", proc.employee_id).maybeSingle();
  const name = emp?.display_name || "入社予定の方";

  const targets = [];
  for (const who of now.nextActors) {
    if (who === "employee") targets.push({ id: proc.employee_id, link: "onboarding.html" });
    else if (who === "advisor") {
      for (const id of await roleIds(sb, ctx.tenantId, ["labor_advisor"])) {
        targets.push({ id, link: "advisor.html" });
      }
    } else if (who === "admin") {
      for (const id of await roleIds(sb, ctx.tenantId, ["hr", "owner"])) {
        targets.push({ id, link: `admin-hr.html?id=${proc.id}` });
      }
    }
  }
  if (now.key === "complete") {
    // 完了は、本人と管理者の両方に
    targets.push({ id: proc.employee_id, link: "onboarding.html" });
    for (const id of await roleIds(sb, ctx.tenantId, ["hr", "owner"])) {
      targets.push({ id, link: `admin-hr.html?id=${proc.id}` });
    }
  }
  if (!targets.length) return;

  const title = now.key === "complete"
    ? `${name}さんの入社手続きが完了しました`
    : `${name}さんの入社手続き：${stage.label}`;
  const body = now.key === "complete" ? "すべての手続きが終わりました。"
    : `${stage.todo}。${now.blockers[0] ? `（${now.blockers[0]}）` : ""}`;

  await notify(targets.map((t) => ({
    tenantId: ctx.tenantId,
    employeeId: t.id,
    kind: "general",
    title, body, link: t.link,
    // 段階ごとに1通。同じ段階で何度 advance が走っても増えない
    dedupeKey: `onboard:${proc.id}:${now.key}`,
  })));
}

/**
 * 社員IDから、その人の入社手続きを見つけて advance する。
 * 署名・作成依頼・届出の側は「誰の」しか知らないので、こちらを使う
 */
export async function advanceFor(sb, ctx, employeeId, opts = {}) {
  try {
    const { data: proc } = await sb.from("gw_procedures").select("id")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId)
      .eq("kind", "onboarding").maybeSingle();
    if (!proc) return null;
    return advance(sb, ctx, proc.id, opts);
  } catch (e) {
    console.error("[onboard] advanceFor:", e?.message || e);
    return null;
  }
}

/**
 * 一覧ぶんの事実を、まとめて読む。
 *
 * 1人ずつ gatherFacts を回すと 6本×人数 の問い合わせになる。
 * 一覧は毎回開くものなので、表ごとに1本で引いて、ここで振り分ける
 *
 * @returns {Map<procedureId, facts>}
 */
export async function gatherFactsBulk(sb, tenantId, procs, itemsByProc) {
  const list = (procs || []).filter((p) => p.kind === "onboarding");
  const out = new Map();
  if (!list.length) return out;
  const empIds = list.map((p) => p.employee_id);
  const soft = async (p) => { try { return (await p)?.data ?? []; } catch { return []; } };

  const [orders, signs, profiles, agreed, docs] = await Promise.all([
    soft(sb.from("gw_doc_orders").select("employee_id, status, updated_at")
      .in("employee_id", empIds).eq("doc_kind", "employment").neq("status", "cancelled")
      .order("updated_at", { ascending: false })),
    soft(sb.from("gw_sign_requests").select("employee_id, status, sent_at")
      .in("employee_id", empIds).eq("doc_kind", "employment").neq("status", "cancelled")
      .order("sent_at", { ascending: false })),
    soft(sb.from("gw_onboard_profiles").select("employee_id, status").in("employee_id", empIds)),
    soft(sb.from("gw_onboard_consents").select("employee_id, kind, version, agreed_at")
      .in("employee_id", empIds)),
    soft(sb.from("gw_consent_docs").select("*").eq("tenant_id", tenantId).eq("status", "active")),
  ]);

  // 並び順は新しい順なので、最初に見つかったものが最新
  const first = (rows) => {
    const m = new Map();
    for (const r of rows) if (!m.has(r.employee_id)) m.set(r.employee_id, r);
    return m;
  };
  const orderBy = first(orders), signBy = first(signs), profBy = first(profiles);
  const agreedBy = new Map();
  for (const a of agreed) {
    if (!agreedBy.has(a.employee_id)) agreedBy.set(a.employee_id, []);
    agreedBy.get(a.employee_id).push(a);
  }

  for (const p of list) {
    const consentsOk = consentState(activeDocs(docs), agreedBy.get(p.employee_id) || [])
      .every((c) => c.agreed);
    out.set(p.id, {
      procedure: p,
      order: orderBy.get(p.employee_id) || null,
      sign: signBy.get(p.employee_id) || null,
      profile: profBy.get(p.employee_id) || null,
      consentsOk,
      items: itemsByProc?.get(p.id) || [],
    });
  }
  return out;
}

async function roleIds(sb, tenantId, roles) {
  const { data } = await sb.from("gw_role_grants")
    .select("employee_id").eq("tenant_id", tenantId).in("role", roles);
  return [...new Set((data || []).map((g) => g.employee_id).filter(Boolean))];
}
