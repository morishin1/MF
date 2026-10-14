// GET    /api/sign                        … 署名依頼の一覧（人事・管理者）
// POST   /api/sign {preview:true, ...}    … 差し込んだ本文とPDFを試しに作る（保存しない）
// POST   /api/sign {templateId, employeeIds, ...} … 署名依頼を送る
// PATCH  /api/sign {id, action:"resend"|"cancel"} … 再送・取り消し
//
// ■ 送る＝そのときの文面を固める
//   雛形は後から直せる。直したあとで「あのとき何に署名したのか」を
//   雛形から復元することはできない。だから送る時点で
//     ・差し込み済みの本文（body_snapshot）
//     ・そこから作ったPDFと、そのSHA-256
//   を依頼の行に持たせる。以後、雛形を直しても消しても影響しない。
//
// ■ 会社印（任意）も、送る時点で固める
//   sealId を渡すと、有効な印鑑の画像を依頼ごとの場所
//   （hr/<tenant>/esign/<id>/seal.png|jpg）へ複製し、名前・ハッシュと一緒に
//   依頼の行へ持たせる。署名済みPDFに押すのはこの複製（api/sign/me.js）。
//   印鑑マスタを後から差し替えても、送付済み・締結済みの印影は変わらない。
//   印影は視覚的な押印であり、署名の証跡は従来どおり（046）。
//
// ■ 署名済みには触らせない
//   status が signed の行は、再送も取り消しもできない。
//   PDFも上書きしない（署名前と署名済みは別のパス）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { userClient, admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import { notifySlack } from "../../lib/slack.js";
import { gwLog } from "../../lib/gw-audit.js";
import { signEvent } from "../../lib/sign-audit.js";
import { renderContractPdf, sha256 } from "../../lib/pdf-jp.js";
import { sealLog } from "../../lib/seal.js";
import {
  DOC_KINDS, DOC_KIND_KEYS, MERGE_FIELDS, buildFields, merge, statusOf,
} from "../../lib/esign.js";

const BUCKET = "hr";
const R_FIELDS =
  "id, tenant_id, template_id, employee_id, title, doc_kind, doc_version, "
  + "status, due_on, pdf_path, pdf_sha256, signed_pdf_path, signed_pdf_sha256, "
  + "signed_at, signer_name, signer_email, signer_ip, signer_ua, agreed_text, "
  + "sent_at, resent_at, resent_count, first_viewed_at, created_at, source, file_name";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  // 個人情報を返す。対象の人は二段階認証（強制日以降）
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return list(req, res, ctx);
  if (req.method === "POST") {
    const body = await readJson(req);
    return body?.preview ? preview(res, ctx, body) : send(req, res, ctx, user, body);
  }
  if (req.method === "PATCH") return patch(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

// ---- 一覧 ---------------------------------------------------------------------
async function list(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const want = q.get("status");            // sent | signed | overdue | all

  const query = (fields) => userClient(req)
    .from("gw_sign_requests")
    .select(`${fields}, employee:gw_employees!gw_sign_requests_employee_id_fkey(id, display_name, department, email)`)
    .eq("tenant_id", ctx.tenantId)
    .order("sent_at", { ascending: false })
    .limit(400);
  // 会社印の列は 091 で足した。未適用でも一覧は今までどおり出す
  let { data, error } = await query(`${R_FIELDS}, seal_id, seal_name`);
  if (error && dbSetupHint(error, "db/091_seals.sql")) ({ data, error } = await query(R_FIELDS));
  if (error) {
    // source / file_name は 056 で足した列。未適用だと列が無いと言われる
    const hint = dbSetupHint(error, "db/056_doc_orders.sql");
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const rows = (data || []).map((r) => ({ ...r, view: statusOf(r) }));
  const counts = {
    sent: rows.filter((r) => r.view === "sent").length,
    overdue: rows.filter((r) => r.view === "overdue").length,
    signed: rows.filter((r) => r.view === "signed").length,
    cancelled: rows.filter((r) => r.view === "cancelled").length,
  };

  return json(res, 200, {
    requests: want && want !== "all" ? rows.filter((r) => r.view === want) : rows,
    counts,
    kinds: DOC_KINDS,
    mergeFields: MERGE_FIELDS,
  });
}

// ---- 差し込みの下ごしらえ -----------------------------------------------------
//
// 名簿・入社フォーム・雇用契約から、その人ぶんの値を集める。
// 契約は active のいちばん新しいものを見る
async function fieldsFor(ctx, employeeIds) {
  const sb = admin();
  const [emps, profiles, contracts, tenant] = await Promise.all([
    sb.from("gw_employees")
      .select("id, display_name, email, department, position, employment_type, joined_on, work_location, initial_role")
      .eq("tenant_id", ctx.tenantId).in("id", employeeIds),
    sb.from("gw_onboard_profiles")
      .select("employee_id, name_kana, postal_code, address, phone, birth_date")
      .in("employee_id", employeeIds),
    sb.from("gw_contracts")
      .select("employee_id, fixed_term, period_from, period_to, probation_months, work_place, "
            + "job_content, work_hours, work_days, wage_type, wage_amount, wage_note, created_at")
      .eq("tenant_id", ctx.tenantId).in("employee_id", employeeIds)
      .eq("status", "active").order("created_at", { ascending: false }),
    sb.from("tenants").select("name").eq("id", ctx.tenantId).maybeSingle(),
  ]);

  const byProfile = new Map((profiles.data || []).map((p) => [p.employee_id, p]));
  const byContract = new Map();
  for (const c of contracts.data || []) if (!byContract.has(c.employee_id)) byContract.set(c.employee_id, c);
  const companyName = tenant.data?.name || "";

  const out = new Map();
  for (const e of emps.data || []) {
    out.set(e.id, {
      employee: e,
      fields: buildFields({
        employee: e,
        profile: byProfile.get(e.id) || {},
        contract: byContract.get(e.id) || {},
        companyName,
      }),
    });
  }
  return { map: out, companyName };
}

// ---- プレビュー（保存しない） -------------------------------------------------
async function preview(res, ctx, body) {
  const employeeId = body?.employeeId;
  if (!employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });

  const tpl = await loadTemplate(ctx, body);
  if (tpl.error) return json(res, tpl.status, tpl);

  const { map, companyName } = await fieldsFor(ctx, [employeeId]);
  const one = map.get(employeeId);
  if (!one) return json(res, 404, { error: "employee_not_found" });

  const { text, missing } = merge(tpl.body, one.fields);
  let pdf = null;
  try {
    const bytes = await renderContractPdf({
      title: tpl.name, company: companyName, body: text,
      docId: "（プレビュー）", issuedOn: one.fields["今日"],
      employeeName: one.employee.display_name, version: tpl.version,
    });
    pdf = Buffer.from(bytes).toString("base64");
  } catch (e) {
    console.error("[sign] プレビューのPDFを作れませんでした:", e?.message || e);
    return json(res, 500, { error: "pdf_failed", detail: String(e?.message || e) });
  }

  return json(res, 200, {
    title: tpl.name, text, missing, fields: one.fields,
    employee: { id: one.employee.id, name: one.employee.display_name },
    pdfBase64: pdf,
  });
}

/** 雛形（保存済み）か、画面で書きかけの本文か。どちらでもプレビューできる */
async function loadTemplate(ctx, body) {
  if (body?.templateId) {
    const { data } = await admin()
      .from("gw_sign_templates").select("id, name, body, doc_kind, version, due_days")
      .eq("id", body.templateId).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!data) return { error: "template_not_found", status: 404 };
    return data;
  }
  if (typeof body?.body === "string" && body.body.trim()) {
    return {
      id: null,
      name: String(body.title || "契約書").slice(0, 120),
      body: body.body,
      doc_kind: DOC_KIND_KEYS.includes(body.docKind) ? body.docKind : "other",
      version: null,
      due_days: 7,
    };
  }
  return { error: "no_template", status: 400, hint: "雛形を選ぶか、本文を入れてください" };
}

// ---- 署名依頼を送る -----------------------------------------------------------
async function send(req, res, ctx, user, body) {
  const ids = [...new Set((Array.isArray(body?.employeeIds) ? body.employeeIds : [body?.employeeId])
    .filter(Boolean))];
  if (!ids.length) return json(res, 400, { error: "invalid_body", required: ["employeeIds"] });
  if (ids.length > 50) return json(res, 400, { error: "too_many", hint: "一度に送れるのは50人までです" });

  const tpl = await loadTemplate(ctx, body);
  if (tpl.error) return json(res, tpl.status, tpl);

  // 期限。指定が無ければ雛形の既定日数を足す
  const dueOn = body?.dueOn || addDays(tpl.due_days || 7);

  const sb = admin();

  // どの契約への署名依頼か（099）。1名あてのときだけ受け付ける（複数名に1つの契約は割り当てられない）。
  // 他人の契約IDを渡せないよう、同じテナント・同じ本人の契約かをここで検証する
  let contractId = null;
  if (body?.contractId) {
    if (ids.length !== 1) {
      return json(res, 400, {
        error: "contract_id_requires_single_employee",
        hint: "契約を紐づけられるのは1名あての送信だけです",
      });
    }
    const { data: k } = await sb.from("gw_contracts").select("id")
      .eq("id", String(body.contractId).slice(0, 40)).eq("tenant_id", ctx.tenantId)
      .eq("employee_id", ids[0]).maybeSingle();
    if (!k) return json(res, 400, { error: "contract_not_found", hint: "この社員の契約が見つかりません" });
    contractId = k.id;
  }

  // 会社印。選ばれていれば、有効なものか確かめて画像を1回だけ読む
  let seal = null;
  if (body?.sealId) {
    seal = await loadSeal(sb, ctx, body.sealId);
    if (seal.error) return json(res, seal.status, seal);
  }

  const { map, companyName } = await fieldsFor(ctx, ids);
  const out = { sent: [], failed: [] };

  // 二重送信を防ぐ。同じ雛形を同じ人に、直前（10分以内）に送っていて、まだ署名待ちなら送らない
  // （ボタンの二度押し・通信のやり直し・別タブ）。意図して送り直すときは「再通知」か、時間をおいて送る
  const recent = new Set();
  if (tpl.id && !body?.preview) {
    try {
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: dup } = await sb.from("gw_sign_requests").select("employee_id")
        .eq("tenant_id", ctx.tenantId).eq("template_id", tpl.id).eq("status", "sent")
        .in("employee_id", ids).gte("created_at", since);
      for (const d of dup || []) recent.add(d.employee_id);
    } catch (e) {
      // 確かめられなかったときは、送ることを止めない（画面のボタンも送信中は押せない）
      console.error("[sign] 直前の送信を確かめられませんでした:", e?.message || e);
    }
  }

  for (const employeeId of ids) {
    const one = map.get(employeeId);
    if (!one) { out.failed.push({ employeeId, reason: "名簿にありません" }); continue; }
    if (recent.has(employeeId)) {
      out.failed.push({ employeeId, name: one.employee.display_name, duplicate: true,
        reason: "直前に同じ書類の署名依頼を送っています（二重送信を防ぐため送りませんでした。「署名の状況」で確認できます）" });
      continue;
    }

    const { text, missing } = merge(tpl.body, one.fields);
    // 埋まらない項目があるまま送らせない。
    // 【未入力：住所】と書かれた契約書に署名させるわけにはいかない
    if (missing.length && !body?.force) {
      out.failed.push({
        employeeId, name: one.employee.display_name,
        reason: `${missing.join("・")} が未登録です`,
        missing,
      });
      continue;
    }

    try {
      const id = crypto.randomUUID();
      const bytes = await renderContractPdf({
        title: tpl.name, company: companyName, body: text,
        docId: id, issuedOn: one.fields["今日"],
        employeeName: one.employee.display_name, version: tpl.version,
      });
      const hash = sha256(bytes);
      const path = `${ctx.tenantId}/esign/${id}/document.pdf`;

      const up = await sb.storage.from(BUCKET)
        .upload(path, Buffer.from(bytes), { contentType: "application/pdf", upsert: false });
      if (up.error) throw new Error(up.error.message);

      // 印影の複製。マスタのパスは持たせない（差し替えで変わってしまう）
      let sealCols = {};
      if (seal) {
        const sealPath = `${ctx.tenantId}/esign/${id}/seal.${seal.ext}`;
        const su = await sb.storage.from(BUCKET)
          .upload(sealPath, seal.bytes, { contentType: seal.mime, upsert: false });
        if (su.error) throw new Error(`会社印を保存できませんでした: ${su.error.message}`);
        sealCols = {
          seal_id: seal.id,
          seal_name: seal.name,
          seal_type: seal.seal_type,
          seal_image_path: sealPath,
          seal_image_sha256: seal.sha256,
        };
      }

      const { error } = await sb.from("gw_sign_requests").insert({
        ...sealCols,
        id,
        tenant_id: ctx.tenantId,
        template_id: tpl.id,
        employee_id: employeeId,
        title: tpl.name,
        doc_kind: tpl.doc_kind,
        doc_version: tpl.version,
        body_snapshot: text,
        merged_fields: one.fields,
        contract_id: contractId,
        status: "sent",
        due_on: dueOn,
        pdf_path: path,
        pdf_sha256: hash,
        sent_by: user.id,
      });
      if (error) throw new Error(error.message);

      await signEvent(ctx, id, "sent", req, { id: user.id, name: ctx.employee?.display_name },
        { title: tpl.name, dueOn, hash, ...(seal ? { sealId: seal.id, sealName: seal.name } : {}) });
      if (seal) {
        await sealLog(ctx, user.id, "esign.seal_selected", seal,
          { requestId: id, title: tpl.name, sealSha256: seal.sha256 });
      }

      // 依頼は登録済み。お知らせに失敗しても、依頼そのものは「署名の状況」で追える（失敗扱いにしない）
      let notified = true;
      try {
        await notify([{
          tenantId: ctx.tenantId,
          employeeId,
          kind: "general",
          title: "署名をお願いします",
          body: `${tpl.name}（期限 ${dueOn}）`,
          link: "contracts.html",
          dedupeKey: `sign:${id}`,
        }]);
      } catch (ne) {
        notified = false;
        console.error("[sign] お知らせを送れませんでした:", ne?.message || ne);
      }

      out.sent.push({ id, employeeId, name: one.employee.display_name, notified });
    } catch (e) {
      console.error("[sign] 送れませんでした:", e?.message || e);
      out.failed.push({ employeeId, name: one.employee.display_name, reason: String(e?.message || e) });
    }
  }

  if (out.sent.length) {
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "sign.send",
      target: `sign_template:${tpl.id || "adhoc"}`,
      detail: { title: tpl.name, count: out.sent.length, dueOn,
                ...(seal ? { sealId: seal.id, sealName: seal.name } : {}) },
    });
    await notifySlack({
      text: `:memo: 署名依頼を送りました　${tpl.name}`,
      lines: [`${out.sent.length}名`, `期限 ${dueOn}`],
      link: "admin-esign.html",
    });
  }
  return json(res, 200, out);
}

// ---- 再送・取り消し -----------------------------------------------------------
async function patch(req, res, ctx, user) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

  const sb = admin();
  const { data: r } = await sb.from("gw_sign_requests")
    // resent_count を落とさないこと。下で +1 している。
    // 取り忘れると毎回 undefined → 1 になり、何度送っても「1回」のままになる
    .select("id, status, title, employee_id, due_on, resent_count")
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!r) return json(res, 404, { error: "request_not_found" });

  // 署名済みは動かさない。ここが緩むと、記録の意味が無くなる
  if (r.status === "signed") {
    return json(res, 409, { error: "already_signed", hint: "署名済みの契約書は変えられません" });
  }

  if (body.action === "cancel") {
    const { error } = await sb.from("gw_sign_requests")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", r.id);
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
    await signEvent(ctx, r.id, "cancelled", req, { id: user.id, name: ctx.employee?.display_name }, null);
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "sign.cancel",
      target: `sign_request:${r.id}`, detail: { title: r.title },
    });
    return json(res, 200, { ok: true, status: "cancelled" });
  }

  if (body.action === "resend") {
    if (r.status !== "sent") return json(res, 409, { error: "not_open", hint: "取り消した依頼は再送できません" });
    // 期限を延ばすかどうかは、押す人が決める
    const dueOn = body.dueOn || r.due_on;
    const now = new Date().toISOString();
    const { error } = await sb.from("gw_sign_requests")
      .update({ resent_at: now, resent_count: (r.resent_count || 0) + 1, due_on: dueOn, updated_at: now })
      .eq("id", r.id);
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

    await signEvent(ctx, r.id, "resent", req, { id: user.id, name: ctx.employee?.display_name }, { dueOn });
    await notify([{
      tenantId: ctx.tenantId, employeeId: r.employee_id, kind: "general",
      title: "署名がまだ済んでいません",
      body: `${r.title}（期限 ${dueOn || "未設定"}）`,
      link: "contracts.html",
      dedupeKey: `sign:${r.id}`,
    }]);
    return json(res, 200, { ok: true, dueOn });
  }

  return json(res, 400, { error: "invalid_action", detail: "resend, cancel" });
}

/**
 * 送るときに使う会社印。有効なものだけ。画像を読んでハッシュを確かめる
 * （マスタの行と画像の中身が食い違っていたら、押さずに止める）
 */
async function loadSeal(sb, ctx, sealId) {
  const { data: s, error } = await sb.from("gw_seals")
    .select("id, name, seal_type, image_path, image_mime, image_sha256, is_active")
    .eq("id", sealId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (error) {
    const hint = dbSetupHint(error, "db/091_seals.sql");
    return { error: hint ? "not_ready" : "db_query_failed", status: hint ? 503 : 500, message: hint || error.message };
  }
  if (!s || !s.is_active) {
    return { error: "seal_not_available", status: 400, hint: "選んだ印鑑は使えません（無効か、見つかりません）" };
  }
  // 証明書発行用の印鑑は、契約書には使えない（実印・契約用の印鑑と完全に分ける。db/122）
  if (s.seal_type === "certificate") {
    return { error: "seal_not_for_contract", status: 400, hint: "証明書発行用の印鑑は、契約書には使えません。別の印鑑を選んでください" };
  }
  const dl = await sb.storage.from(BUCKET).download(s.image_path);
  if (dl.error || !dl.data) {
    return { error: "seal_image_missing", status: 500, hint: "印鑑の画像を読み出せませんでした" };
  }
  const bytes = Buffer.from(await dl.data.arrayBuffer());
  const hash = sha256(bytes);
  if (s.image_sha256 && hash !== s.image_sha256) {
    return { error: "seal_hash_mismatch", status: 500, hint: "印鑑の画像が登録時と一致しません。印鑑を登録し直してください" };
  }
  const mime = s.image_mime === "image/jpeg" ? "image/jpeg" : "image/png";
  return { ...s, bytes, sha256: hash, mime, ext: mime === "image/jpeg" ? "jpg" : "png" };
}

/** 今日から n 日後（日本時間） */
function addDays(n) {
  const t = new Date(Date.now() + 9 * 3600000 + n * 86400000);
  return t.toISOString().slice(0, 10);
}
