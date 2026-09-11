// GET  /api/sign/me            … 自分あての契約書の一覧
// GET  /api/sign/me?id=…       … 1件の中身（本文）。開いた記録も残す
// POST /api/sign/me {id, signerName, agreed:true} … 署名して提出
//
// ■ 本人ができるのは「読む」と「署名する」だけ
//   本文も期限も状態も、本人からは書き換えられない。
//   RLS では列を絞れないので、書き込みはこの API（service_role）だけにしてある。
//
// ■ 署名は1回きり
//   一度 signed になった行は、この API も更新しない。
//   同じ人がもう一度押しても、409 を返して既存の記録を守る。
//
// ■ 何を根拠に「本人が同意した」と言うのか
//   ログイン中のアカウント（メール＋パスワード）＝ その人、として扱う。
//   そのうえで、署名の瞬間に
//     ・本人が入力した氏名
//     ・登録メール、社員ID
//     ・日時、IPアドレス、ブラウザ
//     ・画面に出した同意の文言そのもの
//     ・署名前PDFのSHA-256
//   を残す。PDFの最終ページにも同じ内容を印字する（lib/pdf-jp.js）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { notify, clearNotification } from "../../lib/notify.js";
import { notifySlack } from "../../lib/slack.js";
import { appendSignaturePage, sha256 } from "../../lib/pdf-jp.js";
import { AGREE_TEXT, statusOf, kindLabel } from "../../lib/esign.js";
import { signEvent, ipOf, uaOf } from "../../lib/sign-audit.js";

const BUCKET = "hr";

const MINE =
  "id, title, doc_kind, doc_version, status, due_on, body_snapshot, "
  + "pdf_sha256, signed_pdf_sha256, signed_at, signer_name, agreed_text, "
  + "sent_at, resent_at, first_viewed_at, source, file_name";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, { error: "not_enrolled", hint: "社員名簿に登録されていません。管理者に登録を依頼してください" });
  }

  if (req.method === "GET") return read(req, res, ctx, user);
  if (req.method === "POST") return sign(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読む ---------------------------------------------------------------------
async function read(req, res, ctx, user) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  const sb = admin();

  if (!id) {
    const { data, error } = await sb.from("gw_sign_requests")
      .select("id, title, doc_kind, status, due_on, sent_at, signed_at, signed_pdf_sha256, source")
      .eq("tenant_id", ctx.tenantId)
      .eq("employee_id", ctx.employee.id)
      .neq("status", "cancelled")            // 取り消したものは本人に出さない
      .order("status")                        // sent が先。署名済みは下へ
      .order("due_on", { ascending: true, nullsFirst: false })
      .limit(200);
    if (error) {
      // source は 056 で足した列。未適用だと「列が無い」と言われる
      const hint = dbSetupHint(error, "db/056_doc_orders.sql");
      if (hint) return json(res, 503, { error: "not_ready", message: hint });
      return json(res, 500, { error: "db_query_failed", detail: error.message });
    }

    return json(res, 200, {
      contracts: (data || []).map((r) => ({
        id: r.id, title: r.title,
        kind: r.doc_kind, kindLabel: kindLabel(r.doc_kind),
        view: statusOf(r),
        source: r.source || "generated",
        sentAt: r.sent_at, dueOn: r.due_on, signedAt: r.signed_at,
      })),
      agreeText: AGREE_TEXT,
      me: { name: ctx.employee.display_name, email: ctx.employee.email },
    });
  }

  const { data: r, error: e1 } = await sb.from("gw_sign_requests").select(MINE)
    .eq("id", id).eq("tenant_id", ctx.tenantId)
    .eq("employee_id", ctx.employee.id).maybeSingle();
  if (e1) {
    // 「見つからない」と「列が無い」を混ぜない。
    // 混ぜると、本人には取り下げられたように見えてしまう
    const hint = dbSetupHint(e1, "db/056_doc_orders.sql");
    if (hint) return json(res, 503, { error: "not_ready", message: hint, hint });
    return json(res, 500, { error: "db_query_failed", detail: e1.message });
  }
  if (!r) return json(res, 404, { error: "not_found" });
  if (r.status === "cancelled") return json(res, 404, { error: "cancelled", hint: "この契約書は取り下げられました" });

  // 初めて開いた時刻だけ残す。2回目以降は上書きしない
  // （「いつ本人の目に触れたか」を知りたいので、最初の1回でよい）
  if (!r.first_viewed_at) {
    await sb.from("gw_sign_requests")
      .update({ first_viewed_at: new Date().toISOString() }).eq("id", r.id);
  }
  await signEvent(ctx, r.id, "viewed", req, { id: user.id, name: ctx.employee.display_name }, null);

  return json(res, 200, {
    contract: {
      id: r.id, title: r.title,
      kind: r.doc_kind, kindLabel: kindLabel(r.doc_kind),
      version: r.doc_version,
      body: r.body_snapshot,
      // uploaded … 社労士などが作ったPDFがそのまま届いている。
      // 本文ではなくPDFを読んでもらう
      source: r.source || "generated",
      fileName: r.file_name || null,
      view: statusOf(r),
      sentAt: r.sent_at, dueOn: r.due_on,
      signedAt: r.signed_at, signerName: r.signer_name, agreedText: r.agreed_text,
      hash: r.pdf_sha256, signedHash: r.signed_pdf_sha256,
    },
    agreeText: AGREE_TEXT,
    me: { name: ctx.employee.display_name, email: ctx.employee.email },
  });
}

// ---- 署名する -----------------------------------------------------------------
async function sign(req, res, ctx, user) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
  if (body.agreed !== true) {
    return json(res, 400, { error: "not_agreed", hint: "「内容を確認し、同意します」にチェックを入れてください" });
  }
  const signerName = String(body.signerName ?? "").trim().slice(0, 80);
  if (!signerName) return json(res, 400, { error: "no_name", hint: "お名前を入力してください" });

  const sb = admin();
  const { data: r } = await sb.from("gw_sign_requests")
    .select("id, title, status, due_on, body_snapshot, pdf_path, pdf_sha256, employee_id, doc_version")
    .eq("id", body.id).eq("tenant_id", ctx.tenantId)
    .eq("employee_id", ctx.employee.id).maybeSingle();
  if (!r) return json(res, 404, { error: "not_found" });

  if (r.status === "signed") {
    return json(res, 409, { error: "already_signed", hint: "この契約書はすでに署名済みです" });
  }
  if (r.status === "cancelled") {
    return json(res, 409, { error: "cancelled", hint: "この契約書は取り下げられました" });
  }
  // 期限切れでも署名は受け付ける。
  // 遅れたことは記録に残るが、受け付けないと本人は何もできなくなり、
  // 会社に連絡して送り直してもらうところからやり直しになる

  // 署名前のPDFを取り出す。無ければ署名させない（何に署名したのか言えなくなる）
  const dl = await sb.storage.from(BUCKET).download(r.pdf_path);
  if (dl.error || !dl.data) {
    return json(res, 500, { error: "pdf_missing", hint: "契約書のPDFを取り出せませんでした。管理者にご連絡ください" });
  }
  const basePdf = Buffer.from(await dl.data.arrayBuffer());

  // 保存してあるハッシュと突き合わせる。
  // 合わなければ、送ったあとに中身が変わっている。署名させてはいけない
  const baseHash = sha256(basePdf);
  if (r.pdf_sha256 && baseHash !== r.pdf_sha256) {
    console.error("[sign] ハッシュ不一致:", r.id, baseHash, r.pdf_sha256);
    return json(res, 500, {
      error: "hash_mismatch",
      hint: "契約書の内容が送信時と一致しません。署名を中止しました。管理者にご連絡ください",
    });
  }

  const now = new Date();
  const ip = ipOf(req);
  const ua = uaOf(req);
  const signedAtJp = now.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }) + "（日本時間）";

  let signedBytes;
  try {
    signedBytes = await appendSignaturePage(basePdf, {
      signerName,
      signerEmail: ctx.employee.email || null,
      employeeCode: ctx.employee.id,
      signedAt: signedAtJp,
      docId: r.id,
      docHash: baseHash,
      title: r.title,
      agreedText: AGREE_TEXT,
      ip, userAgent: ua,
    });
  } catch (e) {
    console.error("[sign] 署名済みPDFを作れませんでした:", e?.message || e);
    return json(res, 500, { error: "pdf_failed", detail: String(e?.message || e) });
  }

  const signedPath = `${ctx.tenantId}/esign/${r.id}/signed.pdf`;
  const up = await sb.storage.from(BUCKET)
    .upload(signedPath, Buffer.from(signedBytes), { contentType: "application/pdf", upsert: false });
  // upsert:false なので、2回目は必ず失敗する。それでよい（上書きさせない）
  if (up.error) {
    console.error("[sign] 署名済みPDFを置けませんでした:", up.error.message);
    return json(res, 500, { error: "upload_failed", detail: up.error.message });
  }

  // status を条件に入れて更新する。
  // 二重送信で2回目が通ると、署名日時だけ後の時刻に書き換わる
  const { data: saved, error } = await sb.from("gw_sign_requests")
    .update({
      status: "signed",
      signed_at: now.toISOString(),
      signer_name: signerName,
      signer_email: ctx.employee.email || null,
      signer_ip: ip,
      signer_ua: ua,
      agreed_text: AGREE_TEXT,
      signed_pdf_path: signedPath,
      signed_pdf_sha256: sha256(signedBytes),
      updated_at: now.toISOString(),
    })
    .eq("id", r.id).eq("status", "sent")
    .select("id, signed_at, signed_pdf_sha256").maybeSingle();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (!saved) return json(res, 409, { error: "already_signed", hint: "この契約書はすでに署名済みです" });

  await signEvent(ctx, r.id, "signed", req, { id: user.id, name: signerName },
    { hash: baseHash, signedHash: saved.signed_pdf_sha256 });

  // 作成依頼から出したものなら、その依頼も締結ずみにする。
  // ここが失敗しても署名は済んでいる。止めない（056 未適用でも動くように）
  try {
    await sb.from("gw_doc_orders")
      .update({ status: "signed", updated_at: now.toISOString() })
      .eq("sign_request_id", r.id).eq("tenant_id", ctx.tenantId);
  } catch (e) {
    console.error("[sign] 作成依頼の状態を直せませんでした:", e?.message || e);
  }

  // 本人のベルからは、署名のお願いを下ろす
  await clearNotification(ctx.employee.id, `sign:${r.id}`);

  // 人事に届ける。誰が署名したかは、待っている側がいちばん知りたい
  const { data: hrs } = await sb.from("gw_role_grants")
    .select("employee_id").eq("tenant_id", ctx.tenantId).in("role", ["hr", "owner"]);
  if (hrs?.length) {
    await notify([...new Set(hrs.map((h) => h.employee_id))].map((employeeId) => ({
      tenantId: ctx.tenantId, employeeId, kind: "general",
      title: `${ctx.employee.display_name}さんが署名しました`,
      body: r.title,
      link: "admin-esign.html",
      dedupeKey: `sign-done:${r.id}`,
    })));
  }
  await notifySlack({
    text: `:lower_left_ballpoint_pen: 署名されました　${r.title}`,
    lines: [ctx.employee.display_name],
    link: "admin-esign.html",
  });

  return json(res, 200, {
    ok: true,
    signedAt: saved.signed_at,
    hash: baseHash,
    signedHash: saved.signed_pdf_sha256,
  });
}
