// POST /api/sales/companies/bulk { ids: [...], action, ... }
//
// 企業一覧の複数選択 → 画面下のバー → 中央モーダルからの一括操作（/sales UI改修要件 §6〜§9）。
// ブラウザで1社ずつループせず、ここでまとめて処理する。
//
//   action: "change_status"   { status }              … ステータス変更
//           "change_owner"    { ownerId | null }       … 担当変更（null＝未定）
//           "change_service"  { service | null }       … 提案サービス変更
//           "change_campaign" { campaignId | null }    … キャンペーン変更
//           "hide"            { reason, note? }        … 非表示にする（リンク切れ・閉業など。db/096）
//           "unhide"          {}                       … 再表示する
//           "set_ng"          { ngReason, ngNote? }    … 営業禁止にする
//           "delete"          { dryRun?, ignoreApproachId? } … 削除（dryRun なら消さずに可否だけ返す）
//                             ignoreApproachId … フォームアタック画面から1社を消すとき、その画面で準備した
//                             未送信のアタック1件だけは履歴に数えない（送った・失敗・クリックありは数える）
//
// ■ 選んだ企業だけが対象
//   ids は画面で明示的に選んだものだけ。絞り込み条件は受け取らない（意図せず全件にしない）。
//   自テナントに実在する企業だけを処理し、知らないID・他テナントのIDは「見つからない」に数える。
//
// ■ 1社ずつの変更と同じ結果にする
//   ステータス・営業禁止の変更は、企業詳細から1社ずつ変えたとき（companies/detail.js PATCH）と同じく
//   営業履歴に残し、返信あり・商談へ進めたときは NEXT を自動で入れる。すでにその値の企業は触らない。
//
// ■ 非表示と削除は別（チャネル管理要件 §1・§16）
//   非表示はデータを残し、通常の一覧・ダッシュボード・アタック対象から外すだけ。いつでも再表示できる。
//   ドメインも残るので、同じ会社を取り込み直しても重複として止まる（また一覧に出てこない）。
//
// ■ 削除は、履歴の無い企業だけ（要件 §8）
//   アタック・クリック・営業履歴・商談は企業を消すと一緒に消える（on delete cascade）。
//   だから、それらが1件でもある企業・成約・営業禁止の企業は消さずに「消せない理由」を返す。
//   営業禁止の企業を消すと、次に同じ会社を取り込んだときにまた営業してしまうので残す。
//   消せないものは「対象外」「営業禁止」などのステータスで扱う。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { isUuid, autoNext, STATUS_KEYS, STATUS_LABEL, NG_KEYS, HIDE_KEYS, HIDE_LABEL } from "../../../lib/sales.js";
import { loadMasters } from "../../../lib/sales-master.js";

const SQL = "db/088_sales.sql・db/096_sales_channels.sql";
export const BULK_MAX = 500;
// .in() は URL に載るので、長くなりすぎないよう分けて問い合わせる
const CHUNK = 100;

export const DELETE_BLOCK_LABEL = {
  approach: "アタック履歴あり",
  click: "クリック履歴あり",
  event: "営業履歴あり",
  meeting: "商談あり",
  deal: "案件あり",
  won: "成約済み",
  ng: "営業禁止",
};

const chunks = (arr) => {
  const out = [];
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
  return out;
};

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });

  const body = await readJson(req);
  const raw = Array.isArray(body?.ids) ? body.ids : [];
  const ids = [...new Set(raw.filter((id) => typeof id === "string" && isUuid(id)))];
  const invalid = new Set(raw.filter((id) => !(typeof id === "string" && isUuid(id)))).size;
  if (!ids.length) return json(res, 400, { error: "invalid_body", required: ["ids"], hint: "企業を選んでください" });
  if (ids.length > BULK_MAX) {
    return json(res, 400, { error: "too_many", hint: `一度に操作できるのは${BULK_MAX}社までです` });
  }

  const sb = userClient(req);
  // 自テナントに実在する企業だけに絞る
  const found = [];
  for (const part of chunks(ids)) {
    const { data, error } = await sb.from("gw_sales_companies")
      .select("id, name, status, ng_reason, next_action, next_action_on, hidden_at")
      .eq("tenant_id", ctx.tenantId).in("id", part);
    if (error) return dbFail(res, error);
    found.push(...(data || []));
  }
  const notFound = ids.length - found.length + invalid;
  if (!found.length) return json(res, 404, { error: "not_found", hint: "選んだ企業が見つかりません" });

  const run = ACTIONS[body.action];
  if (!run) return json(res, 400, { error: "unknown_action", allowed: Object.keys(ACTIONS) });
  return run({ res, sb, ctx, user, body, rows: found, notFound });
}

function dbFail(res, error) {
  const hint = dbSetupHint(error, SQL);
  if (hint) return json(res, 503, { error: "not_ready", message: hint });
  return json(res, error.code === "42501" ? 403 : 500, { error: "db_failed", detail: error.message });
}

/** 企業をまとめて更新する。成功・失敗の件数を返す */
async function updateMany(sb, ctx, ids, patch) {
  let updated = 0, failed = 0, lastError = null;
  for (const part of chunks(ids)) {
    const { data, error } = await sb.from("gw_sales_companies").update(patch)
      .eq("tenant_id", ctx.tenantId).in("id", part).select("id");
    if (error) { failed += part.length; lastError = error; continue; }
    updated += (data || []).length;
    failed += part.length - (data || []).length;
  }
  return { updated, failed, lastError };
}

async function addEvents(sb, ctx, user, rows) {
  if (!rows.length) return;
  for (const part of chunks(rows)) {
    await sb.from("gw_sales_events").insert(part.map((r) => ({
      ...r, tenant_id: ctx.tenantId, employee_id: ctx.employee?.id || null, created_by: user.id,
    })));
  }
}

async function audit(ctx, user, action, ids, detail) {
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action,
    target: `sales_company:${ids.slice(0, 50).join(",")}${ids.length > 50 ? ",…" : ""}`,
    detail: { count: ids.length, ...detail },
  });
}

function result(res, { updated = 0, skipped = 0, failed = 0, notFound = 0, lastError = null, extra = {} }) {
  if (!updated && failed && lastError) {
    return json(res, lastError.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: lastError.message });
  }
  return json(res, 200, { updated, skipped, failed, notFound, ...extra });
}

const now = () => new Date().toISOString();

const ACTIONS = {
  async change_status({ res, sb, ctx, user, body, rows, notFound }) {
    const status = body.status;
    if (!STATUS_KEYS.includes(status)) return json(res, 400, { error: "bad_status", hint: "ステータスを選んでください" });
    const targets = rows.filter((r) => r.status !== status);
    const skipped = rows.length - targets.length;
    if (!targets.length) return result(res, { skipped, notFound });

    // 1社ずつの変更と同じ：返信あり・商談へ進めたら NEXT を自動で入れる
    const patch = { status, updated_at: now() };
    if (status === "replied") Object.assign(patch, autoNext("reply"));
    if (status === "meeting") Object.assign(patch, autoNext("meeting"));
    const ids = targets.map((r) => r.id);
    const r = await updateMany(sb, ctx, ids, patch);
    if (r.updated) {
      await addEvents(sb, ctx, user, targets.map((t) => ({
        company_id: t.id, event_key: "status", label: `ステータス：${STATUS_LABEL[status]}`,
        detail: `${STATUS_LABEL[t.status] || t.status} → ${STATUS_LABEL[status]}（一括変更）`,
      })));
      await audit(ctx, user, "sales.company_bulk_status", ids, { status });
    }
    return result(res, { ...r, skipped, notFound });
  },

  async change_owner({ res, sb, ctx, user, body, rows, notFound }) {
    const ownerId = body.ownerId || null;
    if (ownerId) {
      if (!isUuid(ownerId)) return json(res, 400, { error: "bad_owner" });
      const { data: emp } = await sb.from("gw_employees").select("id")
        .eq("tenant_id", ctx.tenantId).eq("id", ownerId).maybeSingle();
      if (!emp) return json(res, 400, { error: "bad_owner", hint: "担当者が見つかりません" });
    }
    const ids = rows.map((r) => r.id);
    const r = await updateMany(sb, ctx, ids, { owner_id: ownerId, updated_at: now() });
    if (r.updated) await audit(ctx, user, "sales.company_bulk_owner", ids, { ownerId });
    return result(res, { ...r, notFound });
  },

  async change_service({ res, sb, ctx, user, body, rows, notFound }) {
    const service = typeof body.service === "string" ? body.service.trim().slice(0, 100) || null : null;
    // 共通マスター（テナントの表示中の選択肢。db/108）の値だけ。空（null）は「未設定に戻す」
    const { services } = await loadMasters(sb, ctx.tenantId);
    if (service && !services.includes(service)) {
      return json(res, 400, { error: "bad_service", hint: `提案サービスは「${services.join("・")}」から選んでください` });
    }
    const ids = rows.map((r) => r.id);
    const r = await updateMany(sb, ctx, ids, { service, updated_at: now() });
    if (r.updated) await audit(ctx, user, "sales.company_bulk_service", ids, { service });
    return result(res, { ...r, notFound });
  },

  async change_campaign({ res, sb, ctx, user, body, rows, notFound }) {
    const campaignId = body.campaignId || null;
    if (campaignId) {
      if (!isUuid(campaignId)) return json(res, 400, { error: "bad_campaign" });
      const { data: camp } = await sb.from("gw_sales_campaigns").select("id")
        .eq("tenant_id", ctx.tenantId).eq("id", campaignId).maybeSingle();
      if (!camp) return json(res, 400, { error: "bad_campaign", hint: "キャンペーンが見つかりません" });
    }
    const ids = rows.map((r) => r.id);
    const r = await updateMany(sb, ctx, ids, { campaign_id: campaignId, updated_at: now() });
    if (r.updated) await audit(ctx, user, "sales.company_bulk_campaign", ids, { campaignId });
    return result(res, { ...r, notFound });
  },

  async hide({ res, sb, ctx, user, body, rows, notFound }) {
    if (!HIDE_KEYS.includes(body.reason)) return json(res, 400, { error: "bad_hide_reason", hint: "非表示にする理由を選んでください" });
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;
    // すでに非表示の企業は、理由を上書きしない
    const targets = rows.filter((r) => !r.hidden_at);
    const skipped = rows.length - targets.length;
    if (!targets.length) return result(res, { skipped, notFound });
    const ids = targets.map((r) => r.id);
    const r = await updateMany(sb, ctx, ids, {
      hidden_at: now(), hidden_by: user.id, hidden_reason: body.reason, hidden_note: note, updated_at: now(),
    });
    if (r.updated) {
      await addEvents(sb, ctx, user, targets.map((t) => ({
        company_id: t.id, event_key: "hide", label: `非表示：${HIDE_LABEL[body.reason]}`, detail: note,
      })));
      await audit(ctx, user, "sales.company_bulk_hide", ids, { reason: body.reason });
    }
    return result(res, { ...r, skipped, notFound });
  },

  async unhide({ res, sb, ctx, user, rows, notFound }) {
    const targets = rows.filter((r) => r.hidden_at);
    const skipped = rows.length - targets.length;
    if (!targets.length) return result(res, { skipped, notFound });
    const ids = targets.map((r) => r.id);
    const r = await updateMany(sb, ctx, ids, {
      hidden_at: null, hidden_by: null, hidden_reason: null, hidden_note: null, updated_at: now(),
    });
    if (r.updated) {
      await addEvents(sb, ctx, user, targets.map((t) => ({
        company_id: t.id, event_key: "hide", label: "再表示", detail: null,
      })));
      await audit(ctx, user, "sales.company_bulk_unhide", ids, {});
    }
    return result(res, { ...r, skipped, notFound });
  },

  async set_ng({ res, sb, ctx, user, body, rows, notFound }) {
    if (!NG_KEYS.includes(body.ngReason)) return json(res, 400, { error: "bad_ng_reason", hint: "理由を選んでください" });
    const ngNote = typeof body.ngNote === "string" ? body.ngNote.trim().slice(0, 500) || null : null;
    // すでに営業禁止の企業は、理由を上書きしない
    const targets = rows.filter((r) => !r.ng_reason);
    const skipped = rows.length - targets.length;
    if (!targets.length) return result(res, { skipped, notFound });
    const ids = targets.map((r) => r.id);
    const r = await updateMany(sb, ctx, ids, { ng_reason: body.ngReason, ng_note: ngNote, updated_at: now() });
    if (r.updated) {
      await addEvents(sb, ctx, user, targets.map((t) => ({
        company_id: t.id, event_key: "status", label: "営業禁止に設定", detail: ngNote,
      })));
      await audit(ctx, user, "sales.company_bulk_ng", ids, { ngReason: body.ngReason });
    }
    return result(res, { ...r, skipped, notFound });
  },

  async delete({ res, sb, ctx, user, body, rows, notFound }) {
    const ids = rows.map((r) => r.id);
    const reasons = new Map(rows.map((r) => [r.id, []]));
    for (const r of rows) {
      if (r.status === "won") reasons.get(r.id).push("won");
      if (r.ng_reason) reasons.get(r.id).push("ng");
    }
    // 履歴があるかを表ごとに見る（1件でもあれば消さない）
    const related = [
      ["gw_sales_approaches", "approach", true],
      ["gw_sales_click_events", "click", true],
      ["gw_sales_events", "event", true],
      ["gw_sales_meetings", "meeting", false],   // db/090 が未実行なら、無いものとして扱う
      ["gw_sales_deals", "deal", false],         // db/116 が未実行なら、無いものとして扱う
    ];
    // フォームアタック画面から1社を消すとき：画面を開いた時点で作られた「まだ送っていない準備だけのアタック」
    // （ignoreApproachId）は、営業の履歴として数えない。開いただけで、どの企業も消せなくなるのを防ぐ。
    // 数えないのは、その1件が 未送信・送信失敗でない・クリック0 のときだけ。送った・失敗した・クリックされたものは履歴
    const ignoreApproach = rows.length === 1 && isUuid(body.ignoreApproachId) ? body.ignoreApproachId : null;
    const isPreparedOnly = (x) => ignoreApproach && x.id === ignoreApproach && !x.sent_at && !x.failed_at && !(x.click_count > 0);
    for (const [tbl, key, required] of related) {
      for (const part of chunks(ids)) {
        const cols = key === "event" ? "company_id, event_key"
          : key === "approach" && ignoreApproach ? "id, company_id, sent_at, failed_at, click_count" : "company_id";
        const { data, error } = await sb.from(tbl).select(cols)
          .eq("tenant_id", ctx.tenantId).in("company_id", part).limit(10000);
        if (error) {
          if (!required && dbSetupHint(error, "")) continue;
          // 確かめられないなら消さない
          return json(res, 500, { error: "check_failed", hint: "関連する履歴を確認できませんでした", detail: error.message });
        }
        // 非表示・再表示の記録だけなら、営業の履歴ではないので削除を止めない（テスト企業を隠してから消せるように）
        const hits = (data || []).filter((x) => !(key === "event" && x.event_key === "hide")
          && !(key === "approach" && isPreparedOnly(x)));
        for (const cid of new Set(hits.map((x) => x.company_id))) {
          const list = reasons.get(cid);
          if (list && !list.includes(key)) list.push(key);
        }
      }
    }
    const nameOf = new Map(rows.map((r) => [r.id, r.name]));
    const blocked = [...reasons.entries()].filter(([, r]) => r.length)
      .map(([id, r]) => ({ id, name: nameOf.get(id), reasons: r.map((k) => DELETE_BLOCK_LABEL[k]) }));
    const deletable = ids.filter((id) => !reasons.get(id).length);

    if (body.dryRun) {
      return json(res, 200, {
        dryRun: true, notFound,
        deletable: deletable.map((id) => ({ id, name: nameOf.get(id) })), blocked,
      });
    }

    let deleted = 0, failed = 0, lastError = null;
    for (const part of chunks(deletable)) {
      const { data, error } = await sb.from("gw_sales_companies").delete()
        .eq("tenant_id", ctx.tenantId).in("id", part).select("id");
      if (error) { failed += part.length; lastError = error; continue; }
      deleted += (data || []).length;
      failed += part.length - (data || []).length;
    }
    if (!deleted && failed && lastError) {
      return json(res, lastError.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: lastError.message });
    }
    if (deleted) {
      await audit(ctx, user, "sales.company_bulk_delete", deletable, {
        deleted, names: deletable.slice(0, 50).map((id) => nameOf.get(id)),
      });
    }
    return json(res, 200, { deleted, failed, notFound, blocked });
  },
};
