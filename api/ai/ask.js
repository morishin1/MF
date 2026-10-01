// POST /api/ai/ask … 社内AIチャットへの質問。
//
// threadId が無ければ新しい相談を始める。あれば続きの質問として同じ相談に積む。
// 毎回すべてのナレッジをAIへ渡さず（要件 §26）、関連度の高い数件だけに絞ってから
// 渡す（lib/ai-knowledge.js）。回答・出典はまとめて保存して返す。
// 同じ相談の続きでは、直近の会話履歴（最大 HISTORY_LIMIT 件）もAIへ渡す。
// 「それはどこ？」のような、今回の質問文だけでは分からない追質問に答えられるようにするため

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr, canAccessOffice } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { allowedKnowledgeScopes, searchKnowledge, CATEGORY_CODES } from "../../lib/ai-knowledge.js";
import { askAssistant } from "../../lib/ai-assistant.js";

const SQL = "db/113_ai_assistant.sql";
const MAX_QUESTION_LEN = 4000;
const HISTORY_LIMIT = 8; // 直近何件を会話履歴としてAIへ渡すか（6〜10件の範囲）

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, { error: "not_enrolled", hint: "社員名簿に登録されていません" });
  }

  const body = await readJson(req);
  const question = String(body.question || "").trim();
  if (!question) return json(res, 400, { error: "question_required" });
  if (question.length > MAX_QUESTION_LEN) {
    return json(res, 400, { error: "question_too_long", hint: `${MAX_QUESTION_LEN}字以内でお願いします` });
  }
  const category = CATEGORY_CODES.includes(body.category) ? body.category : null;

  const sb = admin();

  try {
    let thread;
    if (body.threadId) {
      const { data } = await sb.from("gw_ai_threads").select("id, tenant_id, employee_id, title, category")
        .eq("id", body.threadId).maybeSingle();
      if (!data || data.tenant_id !== ctx.tenantId || data.employee_id !== ctx.employee.id) {
        return json(res, 404, { error: "not_found" });
      }
      thread = data;
    } else {
      const { data, error } = await sb.from("gw_ai_threads").insert({
        tenant_id: ctx.tenantId, employee_id: ctx.employee.id,
        title: question.slice(0, 40), category,
      }).select("id, tenant_id, employee_id, title, category").single();
      if (error) throw error;
      thread = data;
    }

    // 「それはどこ？」「もう少し詳しく」のような追質問が成立するよう、直近の会話を渡す
    // （今回の質問を保存する前に取る＝重複させない）。トークンが膨らみすぎないよう、
    // 件数はここで絞り、1件あたり・合計の文字数は lib/ai-assistant.js 側でさらに絞る
    const { data: historyRows } = await sb.from("gw_ai_messages")
      .select("role, content, created_at").eq("thread_id", thread.id)
      .order("created_at", { ascending: false }).limit(HISTORY_LIMIT);
    const history = (historyRows || []).slice().reverse();

    const { data: userMessage, error: umErr } = await sb.from("gw_ai_messages").insert({
      tenant_id: ctx.tenantId, thread_id: thread.id, role: "user", content: question,
    }).select("id, role, content, created_at").single();
    if (umErr) throw umErr;

    // カテゴリは、このメッセージでチップを選んだときだけ絞り込みに使う。
    // 相談（スレッド）の前回のカテゴリでは絞らない（最初の質問がAIに誤分類されると、
    // 同じ相談の中で話題を変えても、ずっとその分類のナレッジしか検索されなくなるため）
    const knowledgeRows = await searchKnowledge(sb, {
      tenantId: ctx.tenantId, scopes: allowedKnowledgeScopes(ctx, canManageHr, canAccessOffice),
      query: question, category: category || undefined,
    });

    let result;
    try {
      result = await askAssistant({ question, knowledgeRows, history });
    } catch (e) {
      console.error("[ai/ask] askAssistant failed:", e?.message || e);
      result = {
        answer: "回答の作成でエラーが発生しました。時間を置いて試すか、「管理部へ問い合わせる」からご連絡ください。",
        category: thread.category || "other", usedKnowledgeIds: [], confident: false, model: null,
      };
    }

    const { data: assistantMessage, error: amErr } = await sb.from("gw_ai_messages").insert({
      tenant_id: ctx.tenantId, thread_id: thread.id, role: "assistant", content: result.answer,
    }).select("id, role, content, created_at").single();
    if (amErr) throw amErr;

    const usedRows = knowledgeRows.filter((k) => result.usedKnowledgeIds.includes(k.id));
    let sources = [];
    if (usedRows.length) {
      const { data: inserted, error: srcErr } = await sb.from("gw_ai_sources").insert(usedRows.map((k) => ({
        tenant_id: ctx.tenantId, message_id: assistantMessage.id, knowledge_id: k.id,
        title: k.title, excerpt: k.content.slice(0, 200), link_url: k.link_url, link_label: k.link_label,
      }))).select("id, knowledge_id, title, excerpt, link_url, link_label");
      if (srcErr) throw srcErr;
      sources = inserted || [];
    }

    await sb.from("gw_ai_threads").update({
      category: result.category, updated_at: new Date().toISOString(),
      title: thread.title || question.slice(0, 40),
    }).eq("id", thread.id);

    return json(res, 200, {
      threadId: thread.id,
      title: thread.title || question.slice(0, 40),
      category: result.category,
      userMessage,
      assistantMessage: { ...assistantMessage, sources, confident: result.confident },
    });
  } catch (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { notReady: true, message: hint });
    return json(res, 500, { error: "db_error", detail: error.message });
  }
}
