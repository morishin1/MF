// 社内AIチャット（api/ai/*.js）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. 誰でもAIに質問でき、相談（スレッド）・メッセージ・出典が保存される
//   2. ナレッジの公開範囲は scope ごとに独立：一般社員=all、人事=all+hr、
//      経理/Office=all+finance、経営者/会計側管理者=all+hr+finance+admin。
//      「人事だから経理限定・管理者限定まで見える」にはならない
//   3. 会話履歴（直近分）が askAssistant に渡り、追質問が成立する
//   4. 評価（役に立った／違っている）は本人の分だけ、押し直すと上書き
//   5. 管理部への問い合わせ：本人は自分の分だけ、管理サイド（canManageAiInquiries＝
//      canManageHr or canAccessOffice。人事だけでなく経理/Officeも拾える）は全部見える
//   6. 同じAI相談を2回エスカレーションしても、問い合わせは1本のまま
//   7. 問い合わせへの返信は、本人なら employee、管理サイドなら admin として記録される
//   8. 状態変更・担当者アサインは管理サイドのみ
//   9. ナレッジの追加・編集は管理サイドのみ
//   10. テナント分離：他テナントの相談・問い合わせ・ナレッジは触れない
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {} };
const logged = [];

function table(name) {
  const f = [];
  let order = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
      if (op === "eq") return r[k] === v;
      if (op === "in") return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
      if (op === "neq") return r[k] !== v;
      return true;
    }));
    if (order) out = [...out].sort((a, b) => (a[order] < b[order] ? 1 : -1));
    return out;
  };
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    order(col) { order = col; return q; },
    limit(n) { return { ...q, then: (fn) => Promise.resolve({ data: rows().slice(0, n).map(copy), error: null }).then(fn) }; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`,
        created_at: r.created_at || new Date().toISOString(), ...r,
      }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = {
        select: () => r2,
        single: () => Promise.resolve({ data: copy(made[0]), error: null }),
        then: (fn) => Promise.resolve({ data: made.map(copy), error: null }).then(fn),
      };
      return r2;
    },
    update(patch) {
      const r2 = {
        eq(k, v) { f.push(["eq", k, v]); return r2; },
        neq(k, v) { f.push(["neq", k, v]); return r2; },
        in(k, v) { f.push(["in", k, v]); return r2; },
        then(fn) {
          const matched = rows();
          for (const row of matched) Object.assign(row, patch);
          return Promise.resolve({ data: matched.map(copy), error: null }).then(fn);
        },
      };
      return r2;
    },
    upsert(row, opts) {
      const keys = (opts?.onConflict || "id").split(",");
      const list = db.rows[name] = db.rows[name] || [];
      const existing = list.find((r) => keys.every((k) => r[k] === row[k]));
      if (existing) Object.assign(existing, row);
      else list.push({ id: `${name}-${list.length + 1}`, created_at: new Date().toISOString(), ...row });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return q;
}
const copy = (r) => (r ? { ...r } : null);

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: whoUserId }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});
const askAssistantCalls = [];
mock.module(atRoot("lib/ai-assistant.js"), {
  namedExports: {
    aiConfigured: () => true,
    askAssistant: async ({ question, knowledgeRows, history }) => {
      askAssistantCalls.push({ question, knowledgeRows, history });
      // 「それ」で始まる追質問は、直前の会話（最後のuserメッセージ）を見て答える
      // ふりをする（本物のAIの代わりに、履歴が渡っていることをテストで確認するため）
      if (/^それ/.test(question) && history?.length) {
        const prevUser = [...history].reverse().find((m) => m.role === "user");
        return {
          answer: `（${prevUser?.content || "直前の質問"}の続き）について：詳細はrequests.htmlから`,
          category: "hr", usedKnowledgeIds: [], confident: true, model: "fake-model",
        };
      }
      return {
        answer: knowledgeRows.length ? `回答: ${knowledgeRows[0].title}` : "確認できません",
        category: knowledgeRows[0]?.category || "other",
        usedKnowledgeIds: knowledgeRows.slice(0, 1).map((k) => k.id),
        confident: knowledgeRows.length > 0,
        model: "fake-model",
      };
    },
  },
});

// ---- 人物 ------------------------------------------------------------------
const MEMBER = { tenantId: "t1", isAdmin: false, isHr: false, roles: [],
  employee: { id: "emp-member", display_name: "現場 太郎" } };
const HR = { tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"],
  employee: { id: "emp-hr", display_name: "事務 花子" } };
const FINANCE = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["finance"],
  employee: { id: "emp-finance", display_name: "経理 三郎" } };
const OWNER = { tenantId: "t1", isAdmin: false, isHr: true, roles: ["owner"],
  employee: { id: "emp-owner", display_name: "経営 一郎" } };
const ADMIN = { tenantId: "t1", isAdmin: true, isHr: true, roles: [],
  employee: { id: "emp-admin", display_name: "会計 管理" } };
const OTHER_TENANT = { tenantId: "t2", isAdmin: false, isHr: false, roles: [],
  employee: { id: "emp-other", display_name: "他社 次郎" } };

let who = MEMBER;
let whoUserId = "u-member";
// canManageHr / canAccessOffice は lib/gw.js の実際の定義どおりに（偽でも同じ形で）動かす。
// canManageAiInquiries はその合成（lib/gw.js の実装と同じ式）
const canManageHr = (c) => Boolean(c?.isAdmin || c?.isHr);
const canAccessOffice = (c) => Boolean((c?.roles || []).some((r) => ["owner", "manager", "finance"].includes(r)));
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    canManageHr,
    canAccessOffice,
    canManageAiInquiries: (c) => canManageHr(c) || canAccessOffice(c),
  },
});

const { default: ask } = await import(atRoot("api/ai/ask.js"));
const { default: threadsApi } = await import(atRoot("api/ai/threads.js"));
const { default: threadApi } = await import(atRoot("api/ai/thread.js"));
const { default: feedbackApi } = await import(atRoot("api/ai/feedback.js"));
const { default: inquiriesApi } = await import(atRoot("api/ai/inquiries.js"));
const { default: inquiryApi } = await import(atRoot("api/ai/inquiry.js"));
const { default: knowledgeApi } = await import(atRoot("api/ai/knowledge.js"));
const { default: knowledgeItemApi } = await import(atRoot("api/ai/knowledge-item.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => {
  const r = res();
  await h({ headers: { authorization: "Bearer x" }, url: req.url || "/", ...req }, r);
  return r;
};
const post = (h, url, body) => call(h, { method: "POST", url, body });
const get = (h, url) => call(h, { method: "GET", url });
const patch = (h, url, body) => call(h, { method: "PATCH", url, body });

function setup() {
  who = MEMBER; whoUserId = "u-member";
  logged.length = 0;
  askAssistantCalls.length = 0;
  db.rows = {
    gw_employees: [
      { id: "emp-member", user_id: "u-member", tenant_id: "t1", status: "active", display_name: "現場 太郎" },
      { id: "emp-hr", user_id: "u-hr", tenant_id: "t1", status: "active", display_name: "事務 花子" },
      { id: "emp-finance", user_id: "u-finance", tenant_id: "t1", status: "active", display_name: "経理 三郎" },
      { id: "emp-owner", user_id: "u-owner", tenant_id: "t1", status: "active", display_name: "経営 一郎" },
      { id: "emp-admin", user_id: "u-admin", tenant_id: "t1", status: "active", display_name: "会計 管理" },
      { id: "emp-other", user_id: "u-other", tenant_id: "t2", status: "active", display_name: "他社 次郎" },
    ],
    gw_ai_threads: [], gw_ai_messages: [], gw_ai_sources: [], gw_ai_feedback: [],
    gw_ai_inquiries: [], gw_ai_inquiry_messages: [],
    gw_ai_knowledge: [
      { id: "k-all", tenant_id: "t1", title: "有給休暇の申請方法", category: "hr",
        content: "勤怠・申請から申請してください", access_scope: "all", is_active: true,
        link_url: "requests.html", link_label: "休暇・申請を開く" },
      { id: "k-hr", tenant_id: "t1", title: "給与計算の内規", category: "hr",
        content: "人事だけに見せる内部ルール", access_scope: "hr", is_active: true },
      { id: "k-finance", tenant_id: "t1", title: "振込承認フロー", category: "accounting",
        content: "経理だけに見せる内部ルール", access_scope: "finance", is_active: true },
      { id: "k-admin", tenant_id: "t1", title: "入退社の内部手順", category: "general_affairs",
        content: "管理者だけに見せる内部ルール", access_scope: "admin", is_active: true },
      { id: "k-inactive", tenant_id: "t1", title: "廃止されたルール", category: "other",
        content: "無効化済み", access_scope: "all", is_active: false },
    ],
  };
}

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("\n=== allowedKnowledgeScopes（lib/ai-knowledge.js）単体 ===\n");
{
  const { allowedKnowledgeScopes } = await import(atRoot("lib/ai-knowledge.js"));
  const scopesFor = (ctx) => allowedKnowledgeScopes(ctx, canManageHr, canAccessOffice).sort();

  await ok("一般社員: all だけ", () => {
    assert.deepEqual(scopesFor(MEMBER), ["all"]);
  });
  await ok("人事: all + hr", () => {
    assert.deepEqual(scopesFor(HR), ["all", "hr"]);
  });
  await ok("経理/Office: all + finance", () => {
    assert.deepEqual(scopesFor(FINANCE), ["all", "finance"]);
  });
  await ok("経営者（owner）: all + hr + finance + admin", () => {
    assert.deepEqual(scopesFor(OWNER), ["admin", "all", "finance", "hr"]);
  });
  await ok("会計側管理者（isAdmin）: all + hr + admin（finance はロール未付与なので無し）", () => {
    assert.deepEqual(scopesFor(ADMIN), ["admin", "all", "hr"]);
  });
}

console.log("\n=== 質問できる・ナレッジの公開範囲で絞られる（api/ai/ask.js） ===\n");

await ok("一般社員は all のナレッジだけ参照できる", async () => {
  setup();
  const r = await post(ask, "/api/ai/ask", { question: "有給休暇はどう申請しますか" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.assistantMessage.sources[0]?.knowledge_id, "k-all");
});

await ok("一般社員には hr 限定のナレッジが渡らない", async () => {
  setup();
  const r = await post(ask, "/api/ai/ask", { question: "給与計算の内規を教えて" });
  assert.equal(r.body.assistantMessage.sources.length, 0, "hr限定ナレッジは使われない");
});

await ok("経理担当には finance のナレッジが渡る", async () => {
  setup();
  who = FINANCE; whoUserId = "u-finance";
  const r = await post(ask, "/api/ai/ask", { question: "振込承認フローを教えて" });
  assert.equal(r.body.assistantMessage.sources[0]?.knowledge_id, "k-finance");
});

// 「入退社の内部手順を教えて」のような質問は、文字2-gramの素朴な採点だと
// 許可されている別のナレッジ（例：内容に「内部」を含むもの）に偶然ヒットすることがある
// （これはスコア方式の精度の限界であって、権限の不具合ではない）。
// scopeの境界そのものは searchKnowledge が返す knowledge_id の集合で確認する
const sourceIdsOf = (r) => (r.body.assistantMessage.sources || []).map((s) => s.knowledge_id);

await ok("人事には hr のナレッジは見えるが、finance・admin 限定までは見えない", async () => {
  setup();
  who = HR; whoUserId = "u-hr";
  const r1 = await post(ask, "/api/ai/ask", { question: "給与計算の内規を教えて" });
  assert.equal(r1.body.assistantMessage.sources[0]?.knowledge_id, "k-hr", "hr scopeは見える");
  const r2 = await post(ask, "/api/ai/ask", { question: "振込承認フローを教えて" });
  assert.ok(!sourceIdsOf(r2).includes("k-finance"), "finance限定ナレッジは出典に出ない");
  const r3 = await post(ask, "/api/ai/ask", { question: "入退社の内部手順を教えて" });
  assert.ok(!sourceIdsOf(r3).includes("k-admin"), "admin限定ナレッジは出典に出ない");
});

await ok("経理担当には finance のナレッジは見えるが、hr・admin 限定までは見えない", async () => {
  setup();
  who = FINANCE; whoUserId = "u-finance";
  const r1 = await post(ask, "/api/ai/ask", { question: "給与計算の内規を教えて" });
  assert.ok(!sourceIdsOf(r1).includes("k-hr"), "hr限定ナレッジは出典に出ない");
  const r2 = await post(ask, "/api/ai/ask", { question: "入退社の内部手順を教えて" });
  assert.ok(!sourceIdsOf(r2).includes("k-admin"), "admin限定ナレッジは出典に出ない");
});

await ok("経営者（owner）には hr・finance・admin すべて見える", async () => {
  setup();
  who = OWNER; whoUserId = "u-owner";
  const r1 = await post(ask, "/api/ai/ask", { question: "給与計算の内規を教えて" });
  assert.equal(r1.body.assistantMessage.sources[0]?.knowledge_id, "k-hr");
  const r2 = await post(ask, "/api/ai/ask", { question: "振込承認フローを教えて" });
  assert.equal(r2.body.assistantMessage.sources[0]?.knowledge_id, "k-finance");
  const r3 = await post(ask, "/api/ai/ask", { question: "入退社の内部手順を教えて" });
  assert.equal(r3.body.assistantMessage.sources[0]?.knowledge_id, "k-admin");
});

await ok("会計側管理者（isAdmin）には hr・admin は見えるが、ロール未付与の finance までは見えない", async () => {
  setup();
  who = ADMIN; whoUserId = "u-admin";
  const r1 = await post(ask, "/api/ai/ask", { question: "給与計算の内規を教えて" });
  assert.equal(r1.body.assistantMessage.sources[0]?.knowledge_id, "k-hr");
  const r2 = await post(ask, "/api/ai/ask", { question: "入退社の内部手順を教えて" });
  assert.equal(r2.body.assistantMessage.sources[0]?.knowledge_id, "k-admin");
  const r3 = await post(ask, "/api/ai/ask", { question: "振込承認フローを教えて" });
  assert.equal(r3.body.assistantMessage.sources.length, 0,
    "canAccessOffice は社内権限（gw_role_grants）だけで決める方針。isAdmin単体では経理ロール扱いにしない");
});

await ok("会話履歴が渡り、追質問（指示語）が成立する", async () => {
  setup();
  const r1 = await post(ask, "/api/ai/ask", { question: "有給休暇はどう申請しますか" });
  const r2 = await post(ask, "/api/ai/ask", { question: "それはどこから申請しますか", threadId: r1.body.threadId });
  assert.ok(askAssistantCalls.length >= 2);
  const lastCall = askAssistantCalls.at(-1);
  assert.equal(lastCall.history.length, 2, "直前のuser・assistantの2件が渡る");
  assert.equal(lastCall.history[0].role, "user");
  assert.equal(lastCall.history[0].content, "有給休暇はどう申請しますか");
  assert.match(r2.body.assistantMessage.content, /有給休暇はどう申請しますか/,
    "履歴を見て、直前の質問の続きとして答えている");
});

await ok("新しい相談には会話履歴を渡さない（空）", async () => {
  setup();
  await post(ask, "/api/ai/ask", { question: "有給休暇はどう申請しますか" });
  assert.deepEqual(askAssistantCalls.at(-1).history, []);
});

await ok("会話履歴は直近8件まで（それより前は切り捨てる）", async () => {
  setup();
  let threadId;
  for (let i = 0; i < 6; i++) {
    const r = await post(ask, "/api/ai/ask", { question: `質問${i}`, threadId });
    threadId = r.body.threadId;
  }
  // ここまでで user3問+assistant3回=6件が履歴に存在するはずの7問目を送る
  const r = await post(ask, "/api/ai/ask", { question: "質問6", threadId });
  assert.ok(askAssistantCalls.at(-1).history.length <= 8, "8件を超えない");
});

await ok("無効化したナレッジは渡らない", async () => {
  setup();
  const r = await post(ask, "/api/ai/ask", { question: "廃止されたルールについて教えて" });
  assert.equal(r.body.assistantMessage.sources.length, 0);
});

await ok("続きの質問は同じ相談（threadId）に積まれる", async () => {
  setup();
  const r1 = await post(ask, "/api/ai/ask", { question: "有給休暇はどう申請しますか" });
  const r2 = await post(ask, "/api/ai/ask", { question: "承認は誰がしますか", threadId: r1.body.threadId });
  assert.equal(r1.body.threadId, r2.body.threadId);
  const msgs = db.rows.gw_ai_messages.filter((m) => m.thread_id === r1.body.threadId);
  assert.equal(msgs.length, 4, "質問2回＋回答2回で4件");
});

await ok("社員名簿に無いと使えない", async () => {
  setup();
  who = { tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: null };
  const r = await post(ask, "/api/ai/ask", { question: "テスト" });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "not_enrolled");
});

console.log("\n=== 相談の一覧・詳細（api/ai/threads.js・thread.js） ===\n");

await ok("自分の相談だけ一覧に出る", async () => {
  setup();
  await post(ask, "/api/ai/ask", { question: "有給休暇はどう申請しますか" });
  who = HR; whoUserId = "u-hr";
  await post(ask, "/api/ai/ask", { question: "給与計算の内規を教えて" });
  who = MEMBER; whoUserId = "u-member";
  const r = await get(threadsApi, "/api/ai/threads");
  assert.equal(r.body.threads.length, 1);
});

await ok("他人の相談は詳細を見られない", async () => {
  setup();
  const opened = await post(ask, "/api/ai/ask", { question: "有給休暇はどう申請しますか" });
  who = HR; whoUserId = "u-hr";
  const r = await get(threadApi, `/api/ai/thread?threadId=${opened.body.threadId}`);
  assert.equal(r.statusCode, 404);
});

await ok("他テナントの相談は見られない", async () => {
  setup();
  const opened = await post(ask, "/api/ai/ask", { question: "有給休暇はどう申請しますか" });
  who = OTHER_TENANT; whoUserId = "u-other";
  const r = await get(threadApi, `/api/ai/thread?threadId=${opened.body.threadId}`);
  assert.equal(r.statusCode, 404);
});

console.log("\n=== 評価（api/ai/feedback.js） ===\n");

await ok("役に立った／違っているを記録でき、押し直すと上書き", async () => {
  setup();
  const opened = await post(ask, "/api/ai/ask", { question: "有給休暇はどう申請しますか" });
  const messageId = opened.body.assistantMessage.id;
  await post(feedbackApi, "/api/ai/feedback", { messageId, rating: "up" });
  await post(feedbackApi, "/api/ai/feedback", { messageId, rating: "down" });
  const rows = db.rows.gw_ai_feedback.filter((f) => f.message_id === messageId && f.employee_id === "emp-member");
  assert.equal(rows.length, 1, "本人1件のまま");
  assert.equal(rows[0].rating, "down");
});

console.log("\n=== 管理部への問い合わせ（api/ai/inquiries.js・inquiry.js） ===\n");

await ok("AI相談から要約してエスカレーションできる", async () => {
  setup();
  const opened = await post(ask, "/api/ai/ask", { question: "有給休暇はどう申請しますか" });
  const r = await post(inquiriesApi, "/api/ai/inquiries", { threadId: opened.body.threadId });
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.inquiry.id);
  const sys = db.rows.gw_ai_inquiry_messages.find((m) => m.inquiry_id === r.body.inquiry.id);
  assert.equal(sys.sender_type, "system");
  assert.match(sys.content, /相談内容/);
});

await ok("同じ相談を2回エスカレーションしても問い合わせは1本のまま", async () => {
  setup();
  const opened = await post(ask, "/api/ai/ask", { question: "有給休暇はどう申請しますか" });
  const r1 = await post(inquiriesApi, "/api/ai/inquiries", { threadId: opened.body.threadId });
  const r2 = await post(inquiriesApi, "/api/ai/inquiries", { threadId: opened.body.threadId });
  assert.equal(r1.body.inquiry.id, r2.body.inquiry.id);
  assert.equal(db.rows.gw_ai_inquiries.length, 1);
});

await ok("AIを使わず直接問い合わせできる", async () => {
  setup();
  const r = await post(inquiriesApi, "/api/ai/inquiries", { note: "至急、PCを紛失しました" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.inquiry.subject.includes("PCを紛失"), true);
  assert.equal(logged.some((l) => l.action === "ai.inquiry.create"), true);
});

await ok("一般社員は自分の問い合わせだけ見える", async () => {
  setup();
  await post(inquiriesApi, "/api/ai/inquiries", { note: "相談A" });
  who = HR; whoUserId = "u-hr";
  await post(inquiriesApi, "/api/ai/inquiries", { note: "相談B" });
  who = MEMBER; whoUserId = "u-member";
  const r = await get(inquiriesApi, "/api/ai/inquiries");
  assert.equal(r.body.inquiries.length, 1);
});

await ok("管理サイド（人事）はテナント内すべての問い合わせが見える（共通受信箱）", async () => {
  setup();
  await post(inquiriesApi, "/api/ai/inquiries", { note: "相談A" });
  who = HR; whoUserId = "u-hr";
  await post(inquiriesApi, "/api/ai/inquiries", { note: "相談B" });
  const r = await get(inquiriesApi, "/api/ai/inquiries");
  assert.equal(r.body.inquiries.length, 2);
});

await ok("経理/Office（canManageHrではない）も共通受信箱を見られる・返信もadmin扱い", async () => {
  setup();
  await post(inquiriesApi, "/api/ai/inquiries", { note: "PCを紛失しました" });
  who = FINANCE; whoUserId = "u-finance";
  const list = await get(inquiriesApi, "/api/ai/inquiries");
  assert.equal(list.body.inquiries.length, 1, "人事の話題でなくても経理/Officeは共通受信箱が見える");

  const id = list.body.inquiries[0].id;
  await post(inquiryApi, "/api/ai/inquiry", { id, content: "新しいPCを手配します" });
  const msgs = db.rows.gw_ai_inquiry_messages.filter((m) => m.inquiry_id === id);
  assert.equal(msgs.at(-1).sender_type, "admin");
});

await ok("採用担当だけ・営業担当だけは共通受信箱を見られない（他人の問い合わせが見えない）", async () => {
  setup();
  db.rows.gw_employees.push({ id: "emp-recruiter", user_id: "u-recruiter", tenant_id: "t1",
    status: "active", display_name: "採用 四郎" });
  const RECRUITER = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"],
    employee: { id: "emp-recruiter", display_name: "採用 四郎" } };
  await post(inquiriesApi, "/api/ai/inquiries", { note: "現場からの相談" }); // MEMBERが出す
  who = RECRUITER; whoUserId = "u-recruiter";
  const r = await get(inquiriesApi, "/api/ai/inquiries");
  assert.equal(r.body.inquiries.length, 0, "他人の問い合わせは共通受信箱として見えない");
});

await ok("本人の返信は employee、管理サイドの返信は admin として記録される", async () => {
  setup();
  const created = await post(inquiriesApi, "/api/ai/inquiries", { note: "相談A" });
  await post(inquiryApi, "/api/ai/inquiry", { id: created.body.inquiry.id, content: "追加で質問です" });
  who = HR; whoUserId = "u-hr";
  await post(inquiryApi, "/api/ai/inquiry", { id: created.body.inquiry.id, content: "承知しました" });
  const msgs = db.rows.gw_ai_inquiry_messages.filter((m) => m.inquiry_id === created.body.inquiry.id);
  assert.deepEqual(msgs.map((m) => m.sender_type), ["system", "employee", "admin"]);
});

await ok("一般社員は他人の問い合わせに返信できない", async () => {
  setup();
  who = HR; whoUserId = "u-hr";
  const created = await post(inquiriesApi, "/api/ai/inquiries", { note: "人事の相談" });
  who = MEMBER; whoUserId = "u-member";
  const r = await post(inquiryApi, "/api/ai/inquiry", { id: created.body.inquiry.id, content: "横から失礼" });
  assert.equal(r.statusCode, 404);
});

await ok("状態変更・担当者アサインは管理サイドのみ", async () => {
  setup();
  const created = await post(inquiriesApi, "/api/ai/inquiries", { note: "相談A" });
  const denied = await patch(inquiryApi, "/api/ai/inquiry", { id: created.body.inquiry.id, status: "resolved" });
  assert.equal(denied.statusCode, 403);

  who = HR; whoUserId = "u-hr";
  const allowed = await patch(inquiryApi, "/api/ai/inquiry",
    { id: created.body.inquiry.id, status: "resolved", assignedEmployeeId: "emp-hr" });
  assert.equal(allowed.statusCode, 200);
  const row = db.rows.gw_ai_inquiries.find((i) => i.id === created.body.inquiry.id);
  assert.equal(row.status, "resolved");
  assert.equal(row.assigned_employee_id, "emp-hr");
});

await ok("他テナントの問い合わせは管理サイドでも見えない", async () => {
  setup();
  who = OTHER_TENANT; whoUserId = "u-other";
  const created = await post(inquiriesApi, "/api/ai/inquiries", { note: "他社の相談" });
  who = HR; whoUserId = "u-hr";
  const r = await get(inquiryApi, `/api/ai/inquiry?id=${created.body.inquiry.id}`);
  assert.equal(r.statusCode, 404);
});

console.log("\n=== AIナレッジの管理（api/ai/knowledge.js・knowledge-item.js） ===\n");

await ok("一般社員はナレッジ管理に入れない", async () => {
  setup();
  const r = await get(knowledgeApi, "/api/ai/knowledge");
  assert.equal(r.statusCode, 403);
});

await ok("管理サイドはナレッジを追加・編集できる", async () => {
  setup();
  who = HR; whoUserId = "u-hr";
  const created = await post(knowledgeApi, "/api/ai/knowledge", {
    title: "経費精算の締切", category: "accounting", content: "月末締め翌月払い", accessScope: "all",
  });
  assert.equal(created.statusCode, 200);
  const updated = await patch(knowledgeItemApi, `/api/ai/knowledge-item?id=${created.body.knowledge.id}`,
    { isActive: false });
  assert.equal(updated.statusCode, 200);
  const row = db.rows.gw_ai_knowledge.find((k) => k.id === created.body.knowledge.id);
  assert.equal(row.is_active, false);
});

await ok("他テナントのナレッジは編集できない", async () => {
  setup();
  db.rows.gw_ai_knowledge.push({ id: "k-other", tenant_id: "t2", title: "他社ナレッジ",
    category: "other", content: "x", access_scope: "all", is_active: true });
  who = HR; whoUserId = "u-hr";
  const r = await patch(knowledgeItemApi, "/api/ai/knowledge-item?id=k-other", { isActive: false });
  assert.equal(r.statusCode, 404);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
