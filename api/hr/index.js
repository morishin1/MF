// GET   /api/hr                 … 入退社の一覧（入社予定 / 退社予定 / 完了）
// GET   /api/hr?id=…            … 1人ぶん（チェックリスト付き）
// GET   /api/hr?soon=1          … ホームに出す「今日対応する入退社」
// POST  /api/hr {employeeId, kind, targetOn}  … 登録して、担当者に配る
// PATCH /api/hr {id, itemId, done}            … チェックを付ける・外す
// PATCH /api/hr {id, targetOn}                … 日付を変える（知らせ直す）
// PATCH /api/hr {id, itemId, assigneeId}      … 担当者を変える
//
// ■ この画面は「登録するところ」ではない
//
//   誰が・いつまでに・何をやるかを、漏れなく進めるための画面。
//   だから、登録した時点で
//     ・担当ごとのチェックリストを作る
//     ・ロールから実際の担当者を1人ずつ決める
//     ・その人の「やること」に入れる
//     ・お知らせを送る
//   までを、1回で終わらせる。
//
//   「作ったので、あとは各自で見てください」にすると、見られない。
//
// ■ 段階と進み具合は、サーバで決める
//
//   画面ごとに数え方を書くと、一覧と詳細とホームで数字が違う、が起きる。
//   数え方は lib/hr-flow.js に1つだけ置く。

import { manualCheckBlock } from "../../lib/retire-cert-request-db.js";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr, canSeeSalary } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstDate } from "../../lib/devices.js";
import { seed, tell } from "../../lib/hr-run.js";
import { advance, gatherFactsBulk } from "../../lib/onboard-advance.js";
import { onboardFlow } from "../../lib/onboard-flow.js";
import { computeStage, stageOf, progressPct, daysToStart, kpiOf, stuckLine }
  from "../../lib/onboard-stage.js";
import { MYNUMBER_KEYS, mynumberLabel } from "../../lib/mynumber.js";
import { requireMfa } from "../../lib/mfa.js";
import { isAdvanceClaimStale } from "../../lib/hr.js";
import { hireFlowOf } from "../../lib/hire-flow.js";
import { readHandoffOffers, handoffFactsOf, handoffActorNames } from "../../lib/hire-handoff.js";
import {
  ROLES, ROLE_LABEL, TABS, flowOf, phaseOf, phaseLabel,
  progressOf, nextUp, byRole, dueLabel, urgency, daysUntil,
} from "../../lib/hr-flow.js";

const SQL = "db/008_onboarding.sql → 066_hr_flow.sql";

const P_FIELDS = "id, tenant_id, employee_id, kind, status, target_on, note, phase, "
  + "notified_at, notified_for, created_at, "
  // 書類の保管先。詳細の下に畳んで出す。
  // 入退社の本筋ではないが、ここ以外に置き場所が無い
  + "drive_link, drive_folders, advisor_shared_to, advisor_shared_at";
const I_FIELDS = "id, procedure_id, item_key, title, category, owner, phase, assignee_id, "
  + "required, status, due_on, note, sort_order, completed_at, completed_by";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  // 社労士が触れるのは、マイナンバーの進み具合だけ。
  // それ以外（チェック・担当・日付）は管理者・人事
  const body = req.method === "PATCH" ? await readJson(req) : null;
  const advisorOnly = !canManageHr(ctx) && ctx.isAdvisor && body?.mynumber !== undefined;
  if (!canManageHr(ctx) && !advisorOnly) return json(res, 403, { error: "forbidden" });

  // 入社手続きは個人情報を扱う。対象の人は二段階認証（強制日以降）
  if (!(await requireMfa(req, res, ctx, user))) return;

  if (req.method === "GET") return read(req, res, ctx);
  if (req.method === "POST") return create(req, res, ctx, user);
  if (req.method === "PATCH") return patch(req, res, ctx, user, body, advisorOnly);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

// ---- 見る -----------------------------------------------------------------------
async function read(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const sb = admin();
  const today = jstDate();

  // 氏名は埋め込み（employee:gw_employees(...)）では取らない。
  // 埋め込みは、権限や RLS の都合で黙って null になることがある。
  // そうなると一覧が「（不明）」で埋まって、誰の手続きか分からなくなる。
  // 名簿はどのみち下で引くので、そちらから引き当てる
  const { data: procs, error } = await sb.from("gw_procedures")
    .select(P_FIELDS)
    .eq("tenant_id", ctx.tenantId)
    .order("target_on", { ascending: true, nullsFirst: false })
    .limit(300);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const list = procs || [];
  const items = list.length ? await itemsOf(sb, list.map((p) => p.id)) : new Map();
  const people = await employees(sb, ctx.tenantId);

  // 入社の段階（①作成依頼 → ②社労士確認 → ③締結 → ④情報入力・提出 → ⑤完了）。
  // 5つの表の事実から出す。表ごとに1本で引く（1人ずつ回さない）
  const facts = await gatherFactsBulk(sb, ctx.tenantId, list, items);

  // マイナンバーの進み具合（070）。無い環境でも一覧は出す
  const mn = new Map();
  try {
    const { data } = await sb.from("gw_procedures").select("id, mynumber_status")
      .eq("tenant_id", ctx.tenantId).limit(300);
    for (const r of data || []) mn.set(r.id, r.mynumber_status || "not_submitted");
  } catch { /* 070 がまだ */ }
  for (const p of list) p.mynumber_status = mn.get(p.id) || "not_submitted";

  // 採用HRから引き渡された人（HR が承諾内容を確認して Office へ引き渡した版。応募者と社員が結ばれている人）。
  // 入社の人には、Office の入社の流れ（入社書類 → アカウント・端末 → オリエンテーション → 入社完了）を添える
  const hires = await hireLinks(sb, ctx.tenantId, [...new Set(list.filter((p) => p.kind === "onboarding" && p.employee_id).map((p) => p.employee_id))]);

  const rows = list.map((p) => row(p, items.get(p.id) || [], people, today, facts.get(p.id), hires.get(p.employee_id) || null));

  // 1人ぶん
  const id = q.get("id");
  if (id) {
    const one = rows.find((r) => r.id === id);
    if (!one) return json(res, 404, { error: "not_found" });
    const its = items.get(id) || [];
    const raw = list.find((p) => p.id === id);
    // 入社：6つの段階と次にすること（既存の段階の判定を並べ替えるだけ。lib/onboard-flow.js）
    let flow = null;
    if (raw?.kind === "onboarding") {
      const soft = async (q2) => { try { const { data } = await q2; return data ?? null; } catch { return null; } };
      const [signRow, assetRows] = await Promise.all([
        soft(sb.from("gw_sign_requests").select("status, source, first_viewed_at, due_on, sent_at, signed_at")
          .eq("tenant_id", ctx.tenantId).eq("employee_id", raw.employee_id).eq("doc_kind", "employment")
          .neq("status", "cancelled").order("sent_at", { ascending: false }).limit(1).maybeSingle()),
        soft(sb.from("gw_assets").select("id").eq("tenant_id", ctx.tenantId).eq("assigned_to", raw.employee_id).limit(100)),
      ]);
      const person = people.get(raw.employee_id);
      flow = onboardFlow({
        facts: facts.get(id) || { procedure: raw, items: its }, sign: signRow,
        employee: { user_id: person?.userId || null }, targetOn: raw.target_on, items: its,
        assets: (assetRows || []).length, today,
      });
    }
    // 入社：Office の入社の流れ（4つ）と、HR から引き渡された人には「HRから引き渡された情報」（承諾の事実・HR で終えた正式契約・引き渡した人と日時）
    const handoff = raw?.kind === "onboarding" ? hires.get(raw.employee_id) || null : null;
    const hire = raw?.kind === "onboarding"
      ? { fromHr: Boolean(handoff), handoff, salaryVisible: canSeeSalary(ctx), ...hireFlowOf({ handoff, facts: facts.get(id) || { procedure: raw, items: its } }) }
      : null;
    return json(res, 200, {
      procedure: {
        ...one,
        flow,
        hire,
        groups: byRole(its).map((g) => ({
          ...g,
          items: g.items.map((i) => item(i, people)),
        })),
        // 書類の保管先。ふつうは触らないので、画面では畳んでおく
        drive: {
          link: raw?.drive_link || null,
          ready: Boolean(raw?.drive_folders),
          advisor: raw?.advisor_shared_to || null,
          advisorAt: raw?.advisor_shared_at || null,
        },
      },
      roles: ROLES,
      people: [...people.values()],
    });
  }

  // ホームに出すぶん。手を付けるべきものだけ、少しだけ
  if (q.get("soon") === "1") {
    const soon = rows
      .filter((r) => r.phase !== "done")
      .filter((r) => r.days == null || r.days <= 7)
      .sort((a, b) => (a.days ?? 999) - (b.days ?? 999))
      .slice(0, 5)
      .map((r) => ({
        ...r,
        // ホームでは、残っているものを3件だけ出す。
        // 全部出すと、ホームがチェックリストになってしまう
        open: (items.get(r.id) || [])
          .filter((i) => i.status !== "done" && i.status !== "na" && i.owner !== "employee")
          .slice(0, 3)
          .map((i) => ({ title: i.title, role: ROLE_LABEL[i.owner] || i.owner })),
        recentDone: (items.get(r.id) || [])
          .filter((i) => i.status === "done" || i.status === "na")
          .slice(-1)
          .map((i) => i.title)[0] || null,
      }));
    return json(res, 200, { soon, today, kpi: kpiOf(rows) });
  }

  // 3つのタブ。完了は入社・退社をまとめて出す
  const finished = (r) => (r.kind === "onboarding" ? r.stage === "complete" : r.phase === "done");
  return json(res, 200, {
    // 採用HRから引き渡された人（db/133。まだ社員登録していない人だけ）。「入社予定」の上に出す
    handoffs: await handoffQueue(sb, ctx.tenantId),
    tabs: TABS,
    onboarding: rows.filter((r) => r.kind === "onboarding" && !finished(r)),
    offboarding: rows.filter((r) => r.kind === "offboarding" && !finished(r)),
    done: rows.filter(finished),
    // 上に出す5つの数（入社予定／社労士確認待ち／本人対応待ち／社内準備未完了／完了）
    kpi: kpiOf(rows),
    people: [...people.values()],
    roles: ROLES,
    today,
  });
}

/**
 * 採用HRから引き渡された人（Office の入社準備キュー。db/133）。HR が本人の承諾内容を確認して
 * ［承諾内容を確認してOfficeへ引き渡す］を押した版（handoff_at が入っている）のうち、まだ社員登録（gw_employees）していない人。
 * 承諾しただけの人は載らない。育成枠は引き渡さない（DB の CHECK でも入らない）。
 * 給与・承諾の IP・LegalSign の URL などは出さない。メール・電話は入社準備のため認可済み Office 人事へ引き継ぐ。
 * db/133 が未適用なら ready=false（画面は何も出さない）
 */
async function handoffQueue(sb, tenantId) {
  try {
    const { ready, offers } = await readHandoffOffers(sb, tenantId);
    if (!ready) return { ready: false, rows: [] };
    const ids = [...new Set(offers.map((o) => o.applicant_id))];
    if (!ids.length) return { ready: true, rows: [] };
    const apps = [];
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await sb.from("gw_hr_applicants")
        .select("id, name, email, phone, status, employee_id, advance_claimed_at, job_title, employment_type")
        .eq("tenant_id", tenantId).in("id", ids.slice(i, i + 100));
      apps.push(...(data || []));
    }
    const byId = new Map(apps.map((a) => [a.id, a]));
    const names = await handoffActorNames(sb, tenantId, offers.map((o) => o.handoff_by));
    const rows = [];
    for (const o of offers) {
      const a = byId.get(o.applicant_id);
      if (!a || a.employee_id || a.status !== "accepted" || rows.some((r) => r.applicantId === a.id)) continue;
      const f = handoffFactsOf(o, a, { byName: names.get(o.handoff_by) || null });
      const flow = hireFlowOf({ handoff: f });
      rows.push({
        ...f,
        // 誰かが社員登録の画面で入力中（1時間で外れる。採用HR の「本採用へ進める」と同じ確保）
        claimed: Boolean(a.advance_claimed_at && !isAdvanceClaimStale(a.advance_claimed_at)),
        // 入社の流れ（4つ）。引き渡された人は、HR で正式契約まで終わっているので、すぐ社員登録（入社書類の依頼）へ進める
        // （api/hr/applicants/advance.js は、引き渡し前・正式契約前の人を止める）
        hire: { hr: flow.hr, steps: flow.steps, next: flow.next },
      });
    }
    return { ready: true, rows };
  } catch { return { ready: false, rows: [] }; }
}

/**
 * 入社手続きのある人のうち、採用HRから引き渡された人（応募者の employee_id が結ばれていて、handoff_at の版がある人）の
 * 「引き渡された情報」。employeeId → facts。採用HRの表が読めなくても、入退社の一覧は出す（空で返す）
 */
async function hireLinks(sb, tenantId, employeeIds) {
  const out = new Map();
  if (!employeeIds.length) return out;
  try {
    const apps = [];
    for (let i = 0; i < employeeIds.length; i += 100) {
      const { data } = await sb.from("gw_hr_applicants").select("id, name, email, phone, employee_id, job_title, employment_type")
        .eq("tenant_id", tenantId).in("employee_id", employeeIds.slice(i, i + 100));
      apps.push(...(data || []));
    }
    if (!apps.length) return out;
    const { ready, offers } = await readHandoffOffers(sb, tenantId, { applicantIds: apps.map((a) => a.id) });
    if (!ready) return out;
    const names = await handoffActorNames(sb, tenantId, offers.map((o) => o.handoff_by));
    const byApp = new Map();
    for (const o of offers) if (!byApp.has(o.applicant_id)) byApp.set(o.applicant_id, o);   // 新しい引き渡しが先
    for (const a of apps) {
      const o = byApp.get(a.id);
      if (o) out.set(a.employee_id, handoffFactsOf(o, a, { byName: names.get(o.handoff_by) || null }));
    }
  } catch { /* 採用HRの表が無い・読めない：引き渡しの印は付けない */ }
  return out;
}

/** 一覧の1行。余計なものは出さない */
function row(p, its, people, today, facts, handoff = null) {
  const prog = progressOf(its);

  // 入社だけ、5段階を持つ。退社はこれまでどおり phase で見る
  let stage = null;
  if (p.kind === "onboarding") {
    const st = computeStage(facts || { procedure: p, items: its });
    const def = stageOf(st.key);
    const internalOpen = its.filter((i) => i.owner !== "employee"
      && i.status !== "done" && i.status !== "na").length;
    stage = {
      stage: st.key, stageN: def.n, stageLabel: def.label,
      nextActors: st.nextActors,
      nextActorLabel: st.nextActors.length
        ? st.nextActors.map((a) => ({ admin: "管理者", advisor: "社労士", employee: "本人" }[a] || a)).join("・")
        : "—",
      blockers: st.blockers,
      stuck: stuckLine({ stage: st.key, blockers: st.blockers }),
      pct: progressPct(st.key, its),
      internalOpen,
      daysLeft: daysToStart(p.target_on, today),
      cancelled: Boolean(st.cancelled),
    };
  }
  const phase = p.phase && p.phase === "done" && prog.done === prog.total
    ? "done"
    : phaseOf(p.kind, p.target_on, its, today);
  const next = nextUp(its);
  // Office の NEXT ACTION は、入社書類 → アカウント・端末 → オリエンテーション → 入社完了 の4つの言い方にそろえる
  // （既存の段階の事実を並べ直すだけ。lib/hire-flow.js）。HR から引き渡された人には印を付ける
  let hire = null;
  if (p.kind === "onboarding") {
    const f = hireFlowOf({ handoff, facts: facts || { procedure: p, items: its } });
    hire = { fromHr: Boolean(handoff), hirePhase: f.next.phase, hireKey: f.next.key, hireNext: f.next.label, hireActor: f.next.actorLabel, hireDone: f.complete };
  }
  return {
    id: p.id,
    kind: p.kind,
    employeeId: p.employee_id,
    name: people.get(p.employee_id)?.name || "（不明）",
    department: people.get(p.employee_id)?.department || null,
    targetOn: p.target_on,
    days: daysUntil(p.target_on, today),
    due: dueLabel(p.kind, p.target_on, today),
    phase,
    phaseLabel: phaseLabel(p.kind, phase),
    progress: prog,
    urgency: urgency(p.kind, p.target_on, its, today),
    next: next
      ? {
        title: next.title,
        role: ROLE_LABEL[next.owner] || next.owner,
        who: next.assignee_id ? people.get(next.assignee_id)?.name || null : null,
      }
      : null,
    notifiedAt: p.notified_at,
    employmentType: people.get(p.employee_id)?.employmentType || null,
    // 番号は持たない。進み具合だけ
    mynumber: p.mynumber_status || "not_submitted",
    mynumberLabel: mynumberLabel(p.mynumber_status),
    ...(stage || {}),
    ...(hire || {}),
  };
}

const nameOfUser = (people, userId) => [...people.values()].find((p) => p.userId === userId)?.name || null;

function item(i, people) {
  const def = flowOf(i.item_key) || {};
  return {
    id: i.id,
    key: i.item_key,
    title: i.title,
    owner: i.owner,
    ownerLabel: ROLE_LABEL[i.owner] || i.owner,
    phase: i.phase,
    done: i.status === "done" || i.status === "na",
    completedAt: i.completed_at,
    // チェックした人（証跡）。ログインアカウントから名簿の名前を引く。名簿に無ければ名前は出さない
    completedByName: i.completed_by ? nameOfUser(people, i.completed_by) : null,
    assignee: i.assignee_id
      ? { id: i.assignee_id, name: people.get(i.assignee_id)?.name || "（不明）" }
      : null,
    // 行かないと終わらない作業には、行き先を書いてある
    href: def.href || null,
  };
}

async function itemsOf(sb, ids) {
  const { data } = await sb.from("gw_procedure_items")
    .select(I_FIELDS).in("procedure_id", ids).order("sort_order").limit(4000);
  const out = new Map();
  for (const i of data || []) {
    if (!out.has(i.procedure_id)) out.set(i.procedure_id, []);
    out.get(i.procedure_id).push(i);
  }
  return out;
}

async function employees(sb, tenantId) {
  const { data } = await sb.from("gw_employees")
    .select("id, display_name, department, manager_id, user_id, employment_type")
    .eq("tenant_id", tenantId).order("display_name").limit(500);
  return new Map((data || []).map((e) => [e.id, {
    id: e.id, name: e.display_name, department: e.department,
    managerId: e.manager_id, userId: e.user_id, employmentType: e.employment_type,
  }]));
}


// ---- 登録する --------------------------------------------------------------------
async function create(req, res, ctx, user) {
  const body = await readJson(req);
  const employeeId = body?.employeeId;
  const kind = body?.kind === "offboarding" ? "offboarding" : "onboarding";
  const targetOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.targetOn || "")) ? body.targetOn : null;
  if (!employeeId) return json(res, 400, { error: "bad_request", hint: "対象の方を選んでください" });

  const sb = admin();
  const people = await employees(sb, ctx.tenantId);
  const emp = people.get(employeeId);
  if (!emp) return json(res, 404, { error: "employee_not_found" });

  const { data: empRow } = await sb.from("gw_employees")
    .select("id, display_name, manager_id, employment_type")
    .eq("id", employeeId).eq("tenant_id", ctx.tenantId).limit(1).maybeSingle();

  // 同じ人・同じ種別は1つだけ（008 の unique）。あれば、それを使う
  const { data: had } = await sb.from("gw_procedures").select(P_FIELDS)
    .eq("employee_id", employeeId).eq("kind", kind).limit(1).maybeSingle();

  let proc = had;
  if (!proc) {
    const { data, error } = await sb.from("gw_procedures").insert({
      tenant_id: ctx.tenantId, employee_id: employeeId, kind,
      status: "in_progress", target_on: targetOn, phase: "planned",
      created_by: user.id,
    }).select(P_FIELDS).single();
    if (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 503, { error: "not_ready", message: hint });
      return json(res, 500, { error: "db_insert_failed", detail: error.message });
    }
    proc = data;
  } else if (targetOn && targetOn !== proc.target_on) {
    await sb.from("gw_procedures").update({ target_on: targetOn, updated_at: new Date().toISOString() })
      .eq("id", proc.id);
    proc.target_on = targetOn;
  }

  const seeded = await seed(sb, ctx, proc, empRow, people);
  if (seeded.error) return json(res, 500, { error: "seed_failed", detail: seeded.error });

  const told = await tell(sb, ctx, proc, emp, people, { force: true });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id,
    action: `hr.${kind}.start`, target: proc.id,
    detail: { name: emp.name, targetOn: proc.target_on, items: seeded.added, told: told.people },
  });

  return json(res, 200, { ok: true, id: proc.id, added: seeded.added, told: told.people });
}



// ---- 変える ----------------------------------------------------------------------
async function patch(req, res, ctx, user, body, advisorOnly = false) {
  const id = body?.id;
  if (!id) return json(res, 400, { error: "bad_request" });

  const sb = admin();
  const { data: proc } = await sb.from("gw_procedures").select(P_FIELDS)
    .eq("id", id).eq("tenant_id", ctx.tenantId).limit(1).maybeSingle();
  if (!proc) return json(res, 404, { error: "not_found" });

  const people = await employees(sb, ctx.tenantId);
  const emp = people.get(proc.employee_id) || { name: "（不明）" };
  const now = new Date().toISOString();

  // マイナンバーの進み具合。番号は持たない。社労士と管理者が進める
  if (body.mynumber !== undefined) {
    const to = String(body.mynumber);
    if (!MYNUMBER_KEYS.includes(to)) return json(res, 400, { error: "bad_request" });
    const { error } = await sb.from("gw_procedures")
      .update({ mynumber_status: to, mynumber_status_at: now, mynumber_status_by: user.id,
                updated_at: now })
      .eq("id", id);
    if (error) {
      const hint = /mynumber_status/.test(error.message) ? "db/070_onboarding_stage.sql をまだ流していません" : null;
      return json(res, hint ? 503 : 500,
        { error: hint ? "not_ready" : "db_update_failed", message: hint, detail: error.message });
    }
    // 番号は書かない。誰が・誰のを・どこまで進めたか、だけ
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.mynumber",
                  target: id, detail: { name: emp.name, to, label: mynumberLabel(to) } });
    return json(res, 200, { ok: true, mynumber: to, mynumberLabel: mynumberLabel(to) });
  }
  if (advisorOnly) return json(res, 403, { error: "forbidden" });

  // チェックを付ける・外す
  if (body.itemId && body.done !== undefined) {
    const done = Boolean(body.done);
    // 退職証明書の交付：本人の申請があるあいだは、手で完了にしない（承認して発行が正本。lib/retire-cert-request-db.js）
    const { data: target } = await sb.from("gw_procedure_items").select("item_key").eq("id", body.itemId).eq("procedure_id", id).maybeSingle();
    if (target?.item_key === "off_hr_cert") {
      const block = await manualCheckBlock(sb, ctx.tenantId, proc.employee_id, done);
      if (block) return json(res, block.status, block.body);
    }
    const { error } = await sb.from("gw_procedure_items").update({
      status: done ? "done" : "todo",
      completed_at: done ? now : null,
      completed_by: done ? user.id : null,
      updated_at: now,
    }).eq("id", body.itemId).eq("procedure_id", id);
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

    const after = await refresh(sb, proc);
    // 入社なら、社内準備が全部済んだ時点で ⑤ に進む（本人の側も済んでいれば）
    if (proc.kind === "onboarding") await advance(sb, ctx, proc.id);
    return json(res, 200, { ok: true, ...after });
  }

  // 担当者を変える
  if (body.itemId && body.assigneeId !== undefined) {
    const to = body.assigneeId || null;
    if (to && !people.has(to)) return json(res, 400, { error: "bad_employee" });
    const { error } = await sb.from("gw_procedure_items")
      .update({ assignee_id: to, updated_at: now })
      .eq("id", body.itemId).eq("procedure_id", id);
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id,
                  action: "hr.assign", target: id,
                  detail: { name: emp.name, to: to ? people.get(to)?.name : null } });
    return json(res, 200, { ok: true });
  }

  // 日付を変える。変えたら、担当者にもう一度知らせる
  if (body.targetOn !== undefined) {
    const targetOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.targetOn || "")) ? body.targetOn : null;
    const { error } = await sb.from("gw_procedures")
      .update({ target_on: targetOn, updated_at: now }).eq("id", id);
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
    // 期限も合わせる。入社日が動いたのに期限だけ前のまま、が起きないように
    await sb.from("gw_procedure_items").update({ due_on: targetOn })
      .eq("procedure_id", id).in("status", ["todo", "submitted"]);

    const told = await tell(sb, ctx, { ...proc, target_on: targetOn }, emp, people, { force: true });
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id,
                  action: "hr.reschedule", target: id,
                  detail: { name: emp.name, from: proc.target_on, to: targetOn } });
    return json(res, 200, { ok: true, told: told.people });
  }

  // もう一度知らせる（押し忘れ・追加の担当者向け）
  if (body.remind) {
    const told = await tell(sb, ctx, proc, emp, people, { force: true });
    return json(res, 200, { ok: true, told: told.people });
  }

  return json(res, 400, { error: "bad_request" });
}

/**
 * 段階を書き直す。
 * 全部終われば done。一覧では、ここに書いた値を使う
 */
async function refresh(sb, proc) {
  const today = jstDate();
  const { data: items } = await sb.from("gw_procedure_items")
    .select("owner, status, phase, sort_order, title")
    .eq("procedure_id", proc.id).limit(300);
  const prog = progressOf(items || []);
  const phase = phaseOf(proc.kind, proc.target_on, items || [], today);
  // 入社の「完了」は5段階（lib/onboard-stage.js）が決める。
  // 社内準備が済んだだけで done にすると、本人が署名も届出もしていないのに
  // 完了に見える。退社はこれまでどおり phase で決める
  const upd = { phase, updated_at: new Date().toISOString() };
  if (proc.kind !== "onboarding") upd.status = phase === "done" ? "done" : "in_progress";
  await sb.from("gw_procedures").update(upd).eq("id", proc.id);
  const next = nextUp(items || []);
  return { progress: prog, phase, phaseLabel: phaseLabel(proc.kind, phase),
           next: next ? { title: next.title, role: ROLE_LABEL[next.owner] } : null };
}
