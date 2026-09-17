// GET  /api/onboarding/me            … 自分の入社手続き（1画面ぶん全部）
// POST /api/onboarding/me {profile}  … 途中保存
// POST /api/onboarding/me {profile, submit:true} … 提出
// POST /api/onboarding/me {consents:["pledge",...]} … 同意を記録する
//
// ■ 本人が触る口はここ1つだけ
//   個人情報・書類・同意を、別々の画面に分けない。
//   分けると「どこまで終わったか」が本人にも分からなくなる。
//
// ■ 会社が既に知っていることは、入力させない
//   氏名・メール・入社日・契約・勤務時間・担当業務は、
//   管理者が登録フォームで入れている。ここでは読み取り専用で返す。
//   違っていたら、本人が直すのではなく管理者に言ってもらう
//   （労働条件は合意して決まるもので、片方が書き換えるものではない）。
//
// ■ マイナンバーは受け取らない
//   番号法が求める安全管理措置は、列を1つ足して済む話ではない。
//   書類を出したかだけを見て、番号そのものは持たない（db/037 の冒頭）。
//
// ■ 同意は「読みました。内容に同意します」だけ
//   氏名・日付・サインの欄は無い。誰がいつ何の版に同意したかは、
//   ログインしているアカウントとシステムの時計で決まる。
//   同意した時点の全文を一緒に残す（lib/consent-docs.js）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import {
  FIELDS, GROUPS, DEPENDENT_FIELDS, MAX_DEPENDENTS,
  normalizeProfile, normalizeDependents, missingFields, progressOf,
} from "../../lib/onboard-form.js";
import { syncFormItems, ensureDocItems, findProcedure } from "../../lib/onboard-kit.js";
import { ensureConsentDocs, consentState, CONSENT_KEYS } from "../../lib/consent-docs.js";
import { DOCS, COMPANY_DOCS, docOf, docByTitle, folderKeyOf } from "../../lib/onboard-docs.js";
import { hrConfigured } from "../../lib/gdrive.js";
import { onboardingDone } from "../../lib/stages.js";
import { linkOf, shareEmployeeFolders } from "../../lib/hr-drive.js";
import { advanceFor } from "../../lib/onboard-advance.js";
import { computeSteps } from "../../lib/onboard-steps.js";
import { orientationState } from "../../lib/orientation.js";
import { statusOf } from "../../lib/esign.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, {
      error: "no_employee",
      hint: "社員名簿にあなたの行がありません。管理者に登録を依頼してください。",
    });
  }

  if (req.method === "GET") return read(res, user, ctx);
  if (req.method === "POST") {
    const body = await readJson(req);
    if (Array.isArray(body?.consents)) return saveConsents(res, user, ctx, body, req);
    return saveProfile(res, user, ctx, body);
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読み取り ---------------------------------------------------------------
async function read(res, user, ctx) {
  const sb = admin();
  const empId = ctx.employee.id;

  // 書類の版をコードから写す。無い版だけ足すので、毎回呼んでよい
  await ensureConsentDocs(sb, ctx.tenantId).catch((e) =>
    console.error("[onboarding/me] 書類の版を写せませんでした:", e.message));

  const [proc, profile, consents, contract, manager, docs] = await Promise.all([
    // maybeSingle では引かない。
    // 手続きの行が2つできると maybeSingle はエラーを返して data を null にし、
    // 「手続きが無い人」として扱われる。そうなると6つの書類ぜんぶが
    // 「いまのチェックリストに結び付いていません」になって、
    // 出す口が1つも出なくなる（lib/onboard-kit.js の findProcedure）
    findProcedure(sb, empId, "onboarding"),
    sb.from("gw_onboard_profiles").select("*").eq("employee_id", empId).maybeSingle(),
    // 同意の記録は全部返す（版ごと）。マイページの「自分の書類」で、
    // どの版にいつ同意したかと、そのとき読んだ全文を見られるようにする
    sb.from("gw_onboard_consents").select("kind, version, agreed_at, doc_title, body_snapshot")
      .eq("employee_id", empId).order("agreed_at", { ascending: false }),
    // 会社が把握している労働条件。給与は本人にも出す（自分のことなので）
    sb.from("gw_contracts").select("*")
      .eq("employee_id", empId).eq("status", "active")
      .order("created_at", { ascending: false }).limit(1),
    ctx.employee.manager_id
      ? sb.from("gw_employees").select("display_name").eq("id", ctx.employee.manager_id).maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from("gw_consent_docs").select("*")
      .eq("tenant_id", ctx.tenantId).eq("status", "active").order("doc_key"),
  ]);

  // STEP 1（契約書）と STEP 2（オリエンテーション）の事実。
  // 表が無くても（071 未適用）この画面は出す。読めなければ空
  // 関数で渡す。問い合わせの組み立てで落ちても（古い環境・偽の表）、この画面は出す
  const soft = async (fn) => { try { const r = await fn(); return r?.error ? [] : (r?.data || []); } catch { return []; } };
  const [signRows, oriItems, oriChecks] = await Promise.all([
    soft(() => sb.from("gw_sign_requests")
      .select("id, title, doc_kind, status, due_on, signed_at, sent_at")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", empId).neq("status", "cancelled")
      .order("sent_at", { ascending: false }).limit(50)),
    soft(() => sb.from("gw_orientation_items")
      .select("id, title, kind, url, body, description, required, sort_order, created_at")
      .eq("tenant_id", ctx.tenantId).eq("active", true).limit(200)),
    soft(() => sb.from("gw_orientation_checks").select("item_id, confirmed_at").eq("employee_id", empId)),
  ]);
  const contracts = signRows.map((r) => ({
    id: r.id, title: r.title, kind: r.doc_kind, status: r.status, view: statusOf(r),
    dueOn: r.due_on, signedAt: r.signed_at, sentAt: r.sent_at,
  }));
  const orientation = orientationState(oriItems, oriChecks);

  // 手続きが読めなかった。黙って「まだ何も無い人」にしない。
  // 黙ると、画面には出す口が1つも出ないまま、理由がどこにも出ない
  if (proc.error) {
    console.error("[onboarding/me] 手続きを読めません:", proc.error.message);
    return json(res, 500, { error: "db_read_failed", detail: proc.error.message });
  }

  let items = [];
  let files = [];
  let fixed = null;
  if (proc.row) {
    // 古い手続きを、いまの定義につなぎ直してから読む。
    // 鍵の無い項目はアップロード先が決まらず、ボタンを押しても何も起きない。
    // 同じ書類が2行あるのも、ここで片付く（lib/onboard-kit.js）
    fixed = await ensureDocItems(sb, ctx.tenantId, proc.row.id, ctx.employee.employment_type)
      .catch((e) => ({ error: `チェックリストを直せませんでした: ${e.message}` }));
    if (fixed?.error) console.error("[onboarding/me]", fixed.error);

    const [itemsRes, filesRes] = await Promise.all([
      sb.from("gw_procedure_items")
        .select("id, item_key, title, category, owner, required, status, due_on, note, sort_order, document_id, submitted_at")
        .eq("procedure_id", proc.row.id).order("sort_order").limit(200),
      sb.from("gw_procedure_files")
        .select("id, item_id, filename, mime_type, size_bytes, drive_name, created_at")
        .eq("procedure_id", proc.row.id).order("created_at", { ascending: false }).limit(200),
    ]);

    // 読めなかったときに黙って空にしない。
    //
    // ここを `data` だけ取って捨てていたせいで、item_key の列が無いだけで
    // 「書類が1件も無い」ことになり、画面には
    // 「この書類は、いまのチェックリストに結び付いていません」とだけ出ていた。
    // 出す口が1つも出ないのに、何を直せばよいのかどこにも書かれていなかった
    if (itemsRes.error) {
      const hint = dbSetupHint(itemsRes.error, "db/037_onboard_form.sql");
      if (hint) return json(res, 503, { error: "not_ready", message: hint });
      console.error("[onboarding/me] 書類の一覧を読めません:", itemsRes.error.message);
      return json(res, 500, { error: "db_read_failed", detail: itemsRes.error.message });
    }
    if (filesRes.error) {
      console.error("[onboarding/me] 出したファイルを読めません:", filesRes.error.message);
    }

    items = itemsRes.data || [];
    files = filesRes.data || [];
  }

  const c = contract.data?.[0] || null;
  const pf = profile.data || null;

  // 本人の Google ドライブのフォルダ。開ける状態なら、書類ごとに直リンクを返す
  const drive = await employeeDrive(sb, ctx, proc.row).catch((e) => {
    console.error("[onboarding/me] Driveの共有に失敗:", e.message);
    return { ready: false, note: null, folders: null, sensitiveId: null };
  });

  // 本人が出す書類。定義（lib/onboard-docs.js）と、チェックリストの状態を突き合わせる。
  //
  // ■ 鍵が無いものは、題名で引き直す
  //
  //   item_key を付ける前に作られたチェックリストの項目には、鍵が入っていない。
  //   鍵だけで引くと、その項目は
  //     ・documents では見つからない（itemId が null になる）
  //     ・myItems からも外れる（題名が定義と一致するので、定義側の扱いになる）
  //   のどちらにも入らず、画面から消える。
  //
  //   実際に「この書類は、いまのチェックリストに結び付いていません」と出て、
  //   出す口（アップロード）が1つも出なくなっていた。
  //   myItems 側は初めから題名で見ているので、こちらも合わせる
  const byKey = new Map();
  for (const i of items) {
    if (i.item_key && !byKey.has(i.item_key)) byKey.set(i.item_key, i);
  }
  {
    const used = new Set(items.filter((i) => i.item_key).map((i) => i.id));
    for (const i of items) {
      if (i.item_key && docOf(i.item_key)) continue;   // 鍵で引けている
      const d = docByTitle(i.title);
      if (!d || byKey.has(d.key) || used.has(i.id)) continue;
      byKey.set(d.key, i);
      used.add(i.id);
    }
  }
  const documents = DOCS.map((d) => {
    const it = byKey.get(d.key) || null;
    const mine = files.filter((f) => f.item_id === it?.id);
    // 置き場所は書類ごとに決まっている。本人にフォルダを選ばせない。
    // マイナンバーだけは別の場所へ。
    // 管理者がURLを貼った運用では、通常の書類はぜんぶ同じフォルダ。
    // マイナンバー用のURLが貼られていなければ、その書類は
    // ドライブに置かせず mf からのアップロードだけにする（人事しか見ない場所へ）
    const folderId = d.sensitive
      ? drive.sensitiveId
      : (drive.manual ? drive.mainId : drive.folders?.[folderKeyOf(d)]);
    return {
      key: d.key,
      itemId: it?.id || null,
      title: d.title,
      desc: d.desc,
      required: d.required !== false,
      sensitive: !!d.sensitive,
      template: d.template || null,
      driveLink: drive.ready && folderId ? linkOf(folderId) : null,
      status: it?.status || "todo",
      submittedAt: it?.submitted_at || mine[0]?.created_at || null,
      files: mine.map((f) => ({ id: f.id, filename: f.filename, driveName: f.drive_name, at: f.created_at })),
    };
  });

  // 1つも結び付かなかったときだけ、理由を返す。
  //
  // 画面には「この書類は、いまのチェックリストに結び付いていません」としか
  // 出ていなかった。出す口が1つも無いのに、何が起きているのかは
  // 本人にも管理者にも分からず、サーバのログにも残らなかった。
  //
  // 端末の設定が止まったときと同じで、止まった場所が言えないと
  // 誰も直せない。ここで「なぜ空なのか」を1つに絞って返す
  const docsProblem = documents.length && documents.every((d) => !d.itemId)
    ? {
      reason: !proc.row ? "no_procedure"
        : fixed?.error ? "checklist_error"
          : !items.length ? "empty_checklist"
            : "no_match",
      detail: !proc.row
        ? "この方の入社手続きが作られていません（管理画面の「入退社」で作成します）"
        : fixed?.error
          ? fixed.error
          : !items.length
            ? "手続きはありますが、チェックリストが1件もありません"
            : `チェックリストは ${items.length} 件ありますが、`
              + `どれも書類の定義と結び付きません`
              + `（鍵: ${items.map((i) => i.item_key || "（なし）").slice(0, 12).join(", ")}）`,
      procedureId: proc.row?.id || null,
      items: items.length,
    }
    : null;
  if (docsProblem) {
    console.error("[onboarding/me] 書類を出す口が1つも出ません:",
      docsProblem.reason, docsProblem.detail);
  }

  // 会社が用意して、本人に渡す書類（雇用契約書など）。
  //
  // 置き場所は 02_労働条件・契約 で、そこは本人にドライブ共有していない。
  // 代わりに mf から本人だけが開ける（gw_procedure_files の RLS）。
  // 本人はここへあげられない。あげるのは会社側
  const companyDocuments = COMPANY_DOCS
    .map((d) => ({ d, it: byKey.get(d.key) }))
    .filter(({ it }) => it)                   // その人の手続きに無い契約書は出さない
    .map(({ d, it }) => ({
      key: d.key,
      title: d.title,
      status: it.status,
      receivedAt: it.submitted_at || null,
      files: files.filter((f) => f.item_id === it.id)
        .map((f) => ({ id: f.id, filename: f.filename, driveName: f.drive_name, at: f.created_at })),
    }));

  return json(res, 200, {
    // 画面の組み立てはサーバ側の定義から。2か所に同じものを書かない
    fields: FIELDS,
    groups: GROUPS,
    dependentFields: DEPENDENT_FIELDS,
    maxDependents: MAX_DEPENDENTS,
    companyDocuments,
    // 同意してもらう書類。版・全文・同意の状態。
    // 全文をここで返すのは、3つとも短く、別に取りに行かせる理由が無いため
    consents: consentState(docs.data || [], consents.data || []),
    // 同意の履歴。「誓約書 Ver.1.0　2026/09/06 同意済み」を出すのに使う
    consentHistory: (consents.data || []).map((x) => ({
      key: x.kind, title: x.doc_title, version: x.version,
      agreedAt: x.agreed_at, body: x.body_snapshot,
    })),
    documents,
    // 出す口が1つも出ないときの理由。ふつうは null
    docsProblem,
    // Googleドライブに直接あげられるか。だめなときは理由（画面の出し分けに使う）
    drive: { ready: drive.ready, manual: drive.manual, note: drive.note },

    // 本人がやることが全部そろったか。
    // そろうと、次にログインしたときに通常の画面が開く（lib/stages.js）
    allDone: onboardingDone(items),

    procedureId: proc.row?.id || null,
    status: proc.row?.status || null,
    targetOn: proc.row?.target_on || null,

    // 会社が既に知っていること。読み取り専用で見せる
    known: {
      name: ctx.employee.display_name,
      email: ctx.employee.email,
      joinedOn: ctx.employee.joined_on,
      role: c?.job_content || ctx.employee.initial_role,
      workScope: Array.isArray(c?.work_scope) ? c.work_scope : [],
      workStyle: c?.work_style || ctx.employee.work_style,
      weeklyHours: c?.weekly_hours ?? null,
      contract: c?.fixed_term
        ? `有期（${c.period_from} 〜 ${c.period_to || "—"}）`
        : c ? "無期" : null,
      probation: c?.probation_months ? `${c.probation_months}か月` : null,
      wage: c?.wage_amount
        ? `${c.wage_type || ""} ${Number(c.wage_amount).toLocaleString("ja-JP")}円`
          + (c.wage_note ? `（${c.wage_note}）` : "")
        : null,
      manager: manager.data?.display_name || null,
    },

    profile: pf,
    profileStatus: pf?.status || "draft",
    missing: missingFields(pf || {}),

    // 定義に無い、人が手で足した本人向け項目。あれば一緒に出す。
    // 題名でも突き合わせるのは、つなぎ直しに失敗した行を
    // 「ご提出いただく書類」と二重に並べないため
    myItems: items
      .filter((i) => i.owner === "employee"
                  && !docOf(i.item_key) && !docByTitle(i.title)
                  && !String(i.item_key || "").startsWith("form_"))
      // 定義に無いものの置き場所は 05_その他
      .map((i) => ({
        ...i,
        driveLink: !drive.ready ? null
          : drive.manual ? linkOf(drive.mainId)
            : drive.folders?.["05"] ? linkOf(drive.folders["05"]) : null,
      })),
    // 進み具合は全体で数える。「あと何%で入社準備が終わるか」を見せる
    progress: progressOf(items),

    // ---- STEP（3者共通の6段階） ----
    contracts,
    orientation,
    stage: proc.row?.stage || null,
    steps: computeSteps({
      contracts,
      consents: consentState(docs.data || [], consents.data || []),
      orientation,
      profileStatus: pf?.status || "draft",
      missing: missingFields(pf || {}),
      documents: documents.map((d) => ({
        key: d.key, title: d.title, required: d.required, status: d.status,
        collect: d.sensitive ? false : true,
      })),
      // 会社側準備（STEP5）。書類ではない・人事が持つ項目だけ。
      // 本人には内訳を出さない設計（本人の画面には見せない）が、
      // 「会社確認が残っているか」だけは判定に使ってよい
      internalItems: items
        .filter((i) => i.owner === "hr" && i.category !== "document")
        .map((i) => ({ id: i.id, title: i.title, required: i.required !== false, status: i.status })),
      stage: proc.row?.stage || null,
      procedureStatus: proc.row?.status || null,
    }),
  });
}

// ---- 本人のドライブフォルダ ---------------------------------------------------
//
// ■ なぜ「mfに上げる」ではなく「ドライブを開く」なのか
//   何枚も撮った写真をその場で放り込むのは、Googleドライブのほうが速い。
//   スマホで撮って、そのまま自分のフォルダへ入れて終わりにできる。
//
// ■ それでも、どのフォルダに入るかは会社が決める
//   書類ごとに開くフォルダを分けて渡す。本人にフォルダを選ばせない。
//   選ばせると、社労士に渡す 04 に入っていない、が起きる。
//   マイナンバーだけは個人フォルダの外（機微情報）を開く。
//
// ■ 共有は1回だけ
//   済んだ相手を drive_folders の中に控えておく。
//   列を1つ足すためだけにマイグレーションを増やしたくないので、
//   フォルダの対応表と同じ jsonb に "_sharedWith" として持つ。
//   この鍵は 01〜05 とぶつからない
async function employeeDrive(sb, ctx, proc) {
  const out = { ready: false, manual: false, note: null, folders: null, mainId: null, sensitiveId: null };
  if (!proc) return out;

  const folders = proc.drive_folders || null;

  // 管理者がURLを貼ったフォルダ。こちらが優先。
  // 共有はドライブの画面で管理者が済ませているので、ここでは何もしない。
  // サービスアカウントの設定が無くても使える
  if (!folders && proc.drive_folder_id) {
    return {
      ...out,
      ready: true,
      manual: true,
      mainId: proc.drive_folder_id,
      sensitiveId: proc.drive_sensitive_folder_id || null,
    };
  }

  if (!hrConfigured()) return out;
  if (!folders) {
    out.note = "保管フォルダがまだ用意されていません。管理者にお知らせください。";
    return out;
  }
  out.folders = folders;
  out.sensitiveId = proc.drive_sensitive_folder_id || null;

  const email = ctx.employee.email || null;
  const done = Array.isArray(folders._sharedWith) ? folders._sharedWith : [];

  if (email && done.includes(email)) { out.ready = true; return out; }

  const r = await shareEmployeeFolders(
    { folders, sensitiveFolderId: out.sensitiveId }, email);

  if (r.shared?.length) {
    out.ready = true;
    await sb.from("gw_procedures")
      .update({ drive_folders: { ...folders, _sharedWith: [...done, email] } })
      .eq("id", proc.id);
    return out;
  }

  out.note = r.skipped === "domain_not_allowed"
    ? "会社のメールアドレス以外には、フォルダを自動で渡していません。"
      + "ドライブを使いたい場合は管理者にお知らせください。"
    : r.skipped === "no_email"
      ? "メールアドレスが登録されていないため、フォルダをお渡しできません。"
      : null;
  return out;
}

// ---- 個人情報の保存・提出 -----------------------------------------------------
async function saveProfile(res, user, ctx, body) {
  const sb = admin();
  const empId = ctx.employee.id;
  const values = normalizeProfile(body?.profile || {});
  // 扶養家族は配列なので、他の欄とは別にそろえる。
  // 「扶養する家族はいません」に変えたら、前に入れた家族は消す
  values.dependents = values.has_dependents
    ? normalizeDependents(body?.profile?.dependents)
    : [];

  // 出すときだけ、必須の埋まりを見る。途中保存は何度でもできる
  if (body?.submit) {
    const miss = missingFields(values);
    if (miss.length) {
      return json(res, 400, {
        error: "incomplete",
        missing: miss,
        hint: `${miss.map((m) => m.label).join("・")} が空です`,
      });
    }
    // 同意が全部そろっていないと出せない。
    // 出したあとで「まだ読んでいない」が残るのは、本人にとっても困る
    const [{ data: agreed }, { data: docs }] = await Promise.all([
      sb.from("gw_onboard_consents").select("kind, version, agreed_at").eq("employee_id", empId),
      sb.from("gw_consent_docs").select("*").eq("tenant_id", ctx.tenantId).eq("status", "active"),
    ]);
    const notYet = consentState(docs || [], agreed || []).filter((c) => !c.agreed);
    if (notYet.length) {
      return json(res, 400, {
        error: "consent_required",
        hint: `${notYet.map((c) => c.title).join("・")} の確認が残っています`,
      });
    }
  }

  const { data, error } = await sb.from("gw_onboard_profiles").upsert({
    ...values,
    tenant_id: ctx.tenantId,
    employee_id: empId,
    user_id: user.id,                        // 画面から来た値は使わない
    ...(body?.submit ? { status: "submitted", submitted_at: new Date().toISOString() } : {}),
    updated_at: new Date().toISOString(),
  }, { onConflict: "employee_id" }).select("*").single();
  if (error) return json(res, 500, { error: "db_upsert_failed", detail: error.message });

  await reflect(sb, empId);
  if (body?.submit) await advanceFor(sb, ctx, empId);
  return json(res, 200, { ok: true, profile: data, submitted: data.status === "submitted" });
}

// ---- 同意 ---------------------------------------------------------------------
// 3つまとめて1回で記録する。画面のチェックは押した時点では何も送らず、
// 「すべて確認して入社手続きを完了」で一度に送る。
//
// 残すもの：誰が（user_id・氏名）、何に（書類ID・題名・版）、いつ、
//           何を読んだか（同意時点の全文）、どこから（IP・端末）。
// 取り消しはここでは扱わない。いつ同意したかの記録なので、消さない
async function saveConsents(res, user, ctx, body, req) {
  const sb = admin();
  const empId = ctx.employee.id;

  const keys = body.consents.filter((k) => CONSENT_KEYS.includes(k));
  if (!keys.length) return json(res, 400, { error: "unknown_consent" });

  const { data: docs } = await sb.from("gw_consent_docs").select("*")
    .eq("tenant_id", ctx.tenantId).eq("status", "active").in("doc_key", keys);
  if (!docs?.length) return json(res, 500, { error: "docs_missing", hint: "書類の版が用意できていません" });

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "")
    .split(",")[0].trim().slice(0, 64) || null;
  const ua = String(req.headers["user-agent"] || "").slice(0, 300) || null;
  const now = new Date().toISOString();

  const { error } = await sb.from("gw_onboard_consents").upsert(
    docs.map((d) => ({
      tenant_id: ctx.tenantId,
      employee_id: empId,
      user_id: user.id,                       // 画面から来た値は使わない
      display_name: ctx.employee.display_name,
      kind: d.doc_key,
      version: d.version,
      doc_id: d.id,
      doc_title: d.title,
      body_snapshot: d.body,                  // 同意した時点の全文
      ip, user_agent: ua,
      agreed_at: now,
    })), { onConflict: "employee_id,kind,version", ignoreDuplicates: true });
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

  await reflect(sb, empId);
  return json(res, 200, { ok: true, agreed: docs.map((d) => `${d.title} Ver.${d.version}`), at: now });
}

/**
 * フォームの状態をチェックリストに映す。
 * 本人が出したのにチェックが付いていない、が起きないようにする
 */
async function reflect(sb, empId) {
  try {
    const [{ row: proc }, { data: pf }, { data: cs }, { data: docs }] = await Promise.all([
      findProcedure(sb, empId, "onboarding", "id, tenant_id"),
      sb.from("gw_onboard_profiles").select("status").eq("employee_id", empId).maybeSingle(),
      sb.from("gw_onboard_consents").select("kind, version, agreed_at").eq("employee_id", empId),
      sb.from("gw_consent_docs").select("*").eq("status", "active"),
    ]);
    if (!proc) return;

    const mine = (docs || []).filter((d) => d.tenant_id === proc.tenant_id);
    await syncFormItems(sb, proc.id, {
      profileSubmitted: pf?.status === "submitted",
      consentDone: mine.length > 0 && consentState(mine, cs || []).every((c) => c.agreed),
    });
  } catch (e) {
    // 映せなくても保存は成立している。管理画面から手で付けられる
    console.error("[onboarding/me] チェックリストに反映できませんでした:", e.message);
  }
}
