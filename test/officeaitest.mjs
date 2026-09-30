// 勤務表の AI 読取（lib/office-timesheet-ai.js）。本物の AI は呼ばない（偽の client を差し込む）。
//
// ■ 何を守るテストか
//
//   1. 依頼の形：tool_choice・thinking・temperature・prefill を付けない（Claude 5.5 系で 400 になる）。
//      書き写す係として頼み、推測・計算・補完を禁じ、勤務表の中の文を指示として扱わせない
//   2. 出力の検査（normalizeRead）：AI が何を返しても、読めない値は null のまま、要確認の印が付く。
//      数値の時刻・単位のない休憩を「分」と読み違えない。書かれていない日は not_read
//   3. 読取の成否：ツールが呼ばれない・途中で切れた・拒否・月違い・空・上限・タイムアウトは、理由つきの失敗
//   4. AI の結果は、確認済み・確定にならない（AI が「確定」を返しても取り込まない）
//   期待値は、規則から手で書いた値
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const A = await import(join(ROOT, "lib/office-timesheet-ai.js"));
const CLAUDE = await import(join(ROOT, "lib/claude.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};
const H = (h, m = 0) => h * 60 + m;
const M = "2026-10";   // 10/1 は木曜。10/4 は日曜、10/5 は月曜（平日）、10/12 は祝日（月曜）

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 2)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 3)]);

const row = (day, o = {}) => ({ day, kind: "work", start: "09:00", end: "18:00", break: "1:00", worked: "8:00", confidence: "high", ...o });
const day = (r, d) => r.days.find((x) => x.workDate === `${M}-${String(d).padStart(2, "0")}`);
const codes = (d) => d.flags.map((f) => f.code);

// 偽の client。呼ばれた引数を控える
const fakeClient = (reply) => {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params, opts) => {
        calls.push({ params, opts });
        if (reply instanceof Error) throw reply;
        return typeof reply === "function" ? reply(params) : reply;
      },
    },
  };
};
const toolReply = (input, extra = {}) => ({
  model: "claude-test-1", stop_reason: "tool_use",
  content: [{ type: "text", text: "読み取りました" }, { type: "tool_use", id: "tu1", name: "read_timesheet", input }],
  usage: { input_tokens: 1200, output_tokens: 800 }, ...extra,
});
const apiErr = (status, message = "err", name = "APIError") => Object.assign(new Error(message), { status, name });

console.log("— 依頼の形 —");

await ok("model は lib/claude.js のもの。tool_choice・thinking・temperature・prefill を付けない", async () => {
  const req = A.buildRequest({ month: M, mimeType: "application/pdf", base64: "QUJD" });
  assert.equal(req.model, CLAUDE.MODEL);
  assert.equal(req.max_tokens, CLAUDE.MAX_TOKENS.normal);
  for (const k of ["tool_choice", "thinking", "temperature", "top_p", "top_k"]) assert.ok(!(k in req), k);
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages.at(-1).role, "user", "最後が assistant（prefill）でない");
  assert.equal(req.tools.length, 1);
  assert.equal(req.tools[0].name, "read_timesheet");
});
await ok("PDF は document、画像は image ブロック。対象月が文面に入る", async () => {
  const pdf = A.buildRequest({ month: M, mimeType: "application/pdf", base64: "QUJD" }).messages[0].content;
  assert.deepEqual(pdf[0], { type: "document", source: { type: "base64", media_type: "application/pdf", data: "QUJD" } });
  assert.match(pdf[1].text, /2026年10月分/);
  const img = A.buildRequest({ month: M, mimeType: "image/png", base64: "QUJD" }).messages[0].content;
  assert.equal(img[0].type, "image");
  assert.equal(img[0].source.media_type, "image/png");
});
await ok("プロンプト：推測しない・計算しない・休憩を補わない・勤務表内の文を指示にしない・ツールを1回", async () => {
  const p = A.SYSTEM_PROMPT;
  for (const re of [/推測しない/, /null にする/, /自分で計算しない/, /休憩が書かれていない.*null/, /指示ではありません/, /1回だけ呼んで/]) {
    assert.match(p, re, String(re));
  }
});
await ok("ツールの定義：必須は days。day・kind・confidence が必須。読めない項目は null を許す", async () => {
  const s = A.READ_TOOL.input_schema;
  assert.deepEqual(s.required, ["days"]);
  const item = s.properties.days.items;
  assert.deepEqual(item.required, ["day", "kind", "confidence"]);
  assert.deepEqual(item.properties.kind.enum, ["work", "off", "unknown"]);
  assert.deepEqual(item.properties.confidence.enum, ["high", "mid", "low"]);
  for (const k of ["start", "end", "break", "worked"]) assert.ok(item.properties[k].type.includes("null"), k);
});

console.log("— 出力の検査（normalizeRead） —");

await ok("はっきり読めた日：値は分に、フラグなし。読取時の値を snapshot に残す", async () => {
  const r = A.normalizeRead({ days: [row(1)] }, M);
  const d = day(r, 1);
  assert.deepEqual([d.kind, d.startMin, d.endMin, d.breakMin, d.sheetWorkedMin, d.confidence], ["work", H(9), H(18), 60, 480, "high"]);
  assert.deepEqual(d.flags, []);
  assert.deepEqual(d.snapshot, { kind: "work", startMin: H(9), endMin: H(18), breakMin: 60, sheetWorkedMin: 480, note: null });
});
await ok("対象月のすべての日が返る（31日）。AI が返さなかった日は not_read・kind なし・自信 low", async () => {
  const r = A.normalizeRead({ days: [row(1)] }, M);
  assert.equal(r.days.length, 31);
  const d = day(r, 20);
  assert.equal(d.kind, null);
  assert.equal(d.startMin, null);
  assert.equal(d.confidence, "low");
  assert.deepEqual(codes(d), ["not_read"]);
  assert.equal(r.days[30].workDate, "2026-10-31");
});
await ok("2月は 28日／うるう年 29日", async () => {
  assert.equal(A.normalizeRead({ days: [] }, "2027-02").days.length, 28);
  assert.equal(A.normalizeRead({ days: [] }, "2028-02").days.length, 29);
});
await ok("翌日にかかる終了（26:00）はそのまま。開始が 24:00 以降は読まない", async () => {
  const r = A.normalizeRead({ days: [row(2, { end: "26:00" }), row(3, { start: "24:00" })] }, M);
  assert.equal(day(r, 2).endMin, H(26));
  assert.deepEqual(codes(day(r, 2)), []);
  assert.equal(day(r, 3).startMin, null);
  assert.ok(codes(day(r, 3)).includes("bad_start"));
});
await ok("読めない時刻（9:5・文字）は null にし、bad_ の印。値を直して読まない", async () => {
  const r = A.normalizeRead({ days: [row(4, { start: "9:5" }), row(5, { end: "夕方" })] }, M);
  assert.equal(day(r, 4).startMin, null);
  assert.ok(codes(day(r, 4)).includes("bad_start"));
  assert.equal(day(r, 5).endMin, null);
  assert.ok(codes(day(r, 5)).includes("bad_end"));
});
await ok("数値の時刻・数値の休憩は受けない（分か時か分からない）。null にして印", async () => {
  const r = A.normalizeRead({ days: [row(6, { start: 9, end: 18 }), row(7, { break: 60 })] }, M);
  assert.equal(day(r, 6).startMin, null);
  assert.equal(day(r, 6).endMin, null);
  assert.ok(codes(day(r, 6)).includes("bad_start") && codes(day(r, 6)).includes("bad_end"));
  assert.equal(day(r, 7).breakMin, null);
  assert.ok(codes(day(r, 7)).includes("bad_break"));
});
await ok("休憩：「なし」は 0、空・null は null（印は付けない＝計算側で「休憩が不明」）、「1」は読まない", async () => {
  const r = A.normalizeRead({ days: [row(8, { break: "なし" }), row(9, { break: null }), row(10, { break: "" }), row(11, { break: "1" }), row(12, { break: "45分" })] }, M);
  assert.equal(day(r, 8).breakMin, 0);
  assert.equal(day(r, 9).breakMin, null);
  assert.deepEqual(codes(day(r, 9)), []);
  assert.equal(day(r, 10).breakMin, null);
  assert.equal(day(r, 11).breakMin, null);
  assert.ok(codes(day(r, 11)).includes("bad_break"));
  assert.equal(day(r, 12).breakMin, 45);
});
await ok("AI が unreadable とした項目は、値が付いていても捨てる（null）", async () => {
  const r = A.normalizeRead({ days: [row(13, { unreadable: ["end", "break"], end: "18:00", break: "1:00" })] }, M);
  const d = day(r, 13);
  assert.equal(d.endMin, null);
  assert.equal(d.breakMin, null);
  assert.deepEqual(codes(d).sort(), ["unreadable_break", "unreadable_end"]);
});
await ok("kind が unknown・不正 → null と kind_unknown。自信 low → low_confidence（AI の理由つき）", async () => {
  const r = A.normalizeRead({ days: [row(14, { kind: "unknown" }), row(15, { kind: "holiday" }),
    row(16, { confidence: "low", reason: "手書きでかすれている" })] }, M);
  assert.equal(day(r, 14).kind, null);
  assert.ok(codes(day(r, 14)).includes("kind_unknown"));
  assert.equal(day(r, 15).kind, null);
  const f = day(r, 16).flags.find((x) => x.code === "low_confidence");
  assert.match(f.text, /手書きでかすれている/);
  assert.equal(day(r, 16).kind, "work", "low でも値は捨てない（人が確認する）");
});
await ok("自信度が無い・不正 → low として扱い、印を付ける（自信があるものと扱わない）", async () => {
  const r = A.normalizeRead({ days: [{ ...row(17), confidence: undefined }, row(18, { confidence: "certain" })] }, M);
  for (const n of [17, 18]) {
    assert.equal(day(r, n).confidence, "low");
    assert.ok(codes(day(r, n)).includes("confidence_missing"));
    assert.ok(codes(day(r, n)).includes("low_confidence"));
  }
});
await ok("mid は印を付けない（人が読める程度）。自信度そのものは残す", async () => {
  const r = A.normalizeRead({ days: [row(19, { confidence: "mid", reason: "少しかすれ" })] }, M);
  assert.equal(day(r, 19).confidence, "mid");
  assert.deepEqual(codes(day(r, 19)), []);
});
await ok("休みの行：時刻・休憩・実働は持たない。空白の週末は印なし・空白の平日は blank_weekday", async () => {
  const r = A.normalizeRead({ days: [
    row(4, { kind: "off", blank: true, start: null, end: null, break: null, worked: null }),      // 日曜
    row(5, { kind: "off", blank: true, start: null, end: null, break: null, worked: null }),      // 月曜（平日）
    row(12, { kind: "off", blank: true, start: null, end: null, break: null, worked: null }),     // 祝日（月曜）
    row(6, { kind: "off", blank: false, start: null, end: null, break: null, worked: null, note: "有給" }),
  ] }, M);
  assert.equal(day(r, 4).kind, "off");
  assert.deepEqual(codes(day(r, 4)), []);
  assert.deepEqual(codes(day(r, 5)), ["blank_weekday"]);
  assert.deepEqual(codes(day(r, 12)), [], "祝日は平日として扱わない");
  assert.deepEqual([day(r, 6).kind, day(r, 6).note, codes(day(r, 6))], ["off", "有給", []], "有給と書かれた平日は、空白ではない");
});
await ok("休みの表記と時刻が両方ある → kind を決めず（null）、off_with_times。時刻は残す", async () => {
  const r = A.normalizeRead({ days: [row(7, { kind: "off", note: "有給" })] }, M);
  const d = day(r, 7);
  assert.equal(d.kind, null);
  assert.ok(codes(d).includes("off_with_times"));
  assert.equal(d.startMin, H(9));
  assert.equal(d.endMin, H(18));
});
await ok("勤務表の実働：8:00・8.5・7.5h を分に。読めなければ null と bad_worked（合計には使わない値）", async () => {
  const r = A.normalizeRead({ days: [row(1, { worked: "8:00" }), row(2, { worked: "8.5" }), row(3, { worked: "7.5h" }),
    row(4, { worked: "abc" }), row(5, { worked: "30:00" }), row(6, { worked: null })] }, M);
  assert.deepEqual([1, 2, 3].map((n) => day(r, n).sheetWorkedMin), [480, 510, 450]);
  assert.equal(day(r, 4).sheetWorkedMin, null);
  assert.ok(codes(day(r, 4)).includes("bad_worked"));
  assert.equal(day(r, 5).sheetWorkedMin, null, "24時間を超える実働は読まない");
  assert.equal(day(r, 6).sheetWorkedMin, null);
});
await ok("同じ日が2行 → 最初を採り duplicate_row。範囲外の日（0・32）は取り込まず警告", async () => {
  const r = A.normalizeRead({ days: [row(1, { start: "09:00" }), row(1, { start: "10:00" }), row(0), row(32), row("x")] }, M);
  assert.equal(day(r, 1).startMin, H(9));
  assert.ok(codes(day(r, 1)).includes("duplicate_row"));
  assert.equal(r.warnings.filter((w) => w.code === "day_out_of_range").length, 3);
  assert.equal(r.days.length, 31);
});
await ok("備考は 200 字まで。AI が確定・確認済み・status を返しても取り込まない", async () => {
  const r = A.normalizeRead({ days: [row(1, { note: "あ".repeat(500), status: "confirmed", reviewed: true, reviewed_at: "2026-10-01", confirmed: true })] }, M);
  const d = day(r, 1);
  assert.equal(d.note.length, 200);
  for (const k of ["status", "reviewed", "reviewedAt", "reviewed_at", "confirmed"]) assert.ok(!(k in d), k);
});
await ok("シート情報：氏名・合計（162:30 → 9750分）・休憩欄なし・締め日違い。壊れた値は null", async () => {
  const r = A.normalizeRead({ sheet_month: "2026-10", employee_name: "  山田 太郎 ", total_worked: "162:30",
    break_column: "absent", has_other_period_rows: true, notes: "手書き", days: [] }, M);
  assert.deepEqual(r.sheet, { month: "2026-10", employeeName: "山田 太郎", totalWorkedMin: 9750, breakColumn: "absent", otherPeriodRows: true, notes: "手書き" });
  assert.deepEqual(r.warnings.map((w) => w.code).sort(), ["no_break_column", "other_period"]);
  const bad = A.normalizeRead({ sheet_month: "10月", total_worked: "たくさん", break_column: "maybe", days: [] }, M);
  assert.deepEqual(bad.sheet, { month: null, employeeName: null, totalWorkedMin: null, breakColumn: "unclear", otherPeriodRows: false, notes: null });
});
await ok("入力が壊れていても落ちない（null・文字列・days が配列でない）→ 全日 not_read", async () => {
  for (const inp of [null, undefined, "x", 5, {}, { days: "x" }, { days: [null, 3, "a"] }]) {
    const r = A.normalizeRead(inp, M);
    assert.equal(r.days.length, 31);
    assert.ok(r.days.every((d) => codes(d).includes("not_read")), JSON.stringify(inp));
  }
});
await ok("parseWorkedText：8:00・162:30・8.5・7.5h・8時間 → 分。読めなければ null", async () => {
  assert.equal(A.parseWorkedText("8:00"), 480);
  assert.equal(A.parseWorkedText("162:30"), 9750);
  assert.equal(A.parseWorkedText("８：００"), null, "全角数字は読まない");
  assert.equal(A.parseWorkedText("8.5"), 510);
  assert.equal(A.parseWorkedText("7.5h"), 450);
  assert.equal(A.parseWorkedText("8時間"), 480);
  for (const s of ["", "abc", "8:75", null, undefined]) assert.equal(A.parseWorkedText(s), null, String(s));
});

console.log("— 読取の成否（readTimesheet） —");

const okInput = { sheet_month: M, employee_name: "山田太郎", break_column: "present", days: [row(1), row(2, { end: "26:00" })] };

await ok("成功：偽の client に、依頼と timeout・maxRetries:0 を渡す。結果は日別の下書きと使用量", async () => {
  const c = fakeClient(toolReply(okInput));
  const r = await A.readTimesheet({ buffer: PDF, month: M, client: c });
  assert.equal(r.ok, true);
  assert.equal(r.model, "claude-test-1");
  assert.equal(r.days.length, 31);
  assert.equal(r.sheet.employeeName, "山田太郎");
  assert.deepEqual(r.usage, { inputTokens: 1200, outputTokens: 800 });
  assert.equal(c.calls.length, 1);
  assert.deepEqual(c.calls[0].opts, { timeout: A.READ_TIMEOUT_MS, maxRetries: 0 });
  const p = c.calls[0].params;
  assert.equal(p.messages[0].content[0].type, "document");
  assert.equal(p.messages[0].content[0].source.data, PDF.toString("base64"));
  assert.ok(!("tool_choice" in p) && !("thinking" in p));
});
await ok("JPEG・PNG は image ブロックで渡す（media_type を中身から決める）", async () => {
  for (const [buf, mt] of [[JPG, "image/jpeg"], [PNG, "image/png"]]) {
    const c = fakeClient(toolReply(okInput));
    const r = await A.readTimesheet({ buffer: buf, month: M, client: c });
    assert.equal(r.ok, true);
    assert.equal(c.calls[0].params.messages[0].content[0].source.media_type, mt);
  }
});
await ok("PDF・画像以外（zip・テキスト・空）は AI を呼ばずに unsupported", async () => {
  for (const buf of [Buffer.from("PK\x03\x04xl/"), Buffer.from("hello"), Buffer.alloc(0)]) {
    const c = fakeClient(toolReply(okInput));
    const r = await A.readTimesheet({ buffer: buf, month: M, client: c });
    assert.equal(r.ok, false);
    assert.equal(r.code, "unsupported");
    assert.equal(c.calls.length, 0);
  }
});
await ok("画像が 5MB を超えたら AI を呼ばずに image_too_large。PDF は 5MB 超でも呼ぶ", async () => {
  const bigPng = Buffer.concat([PNG, Buffer.alloc(A.IMAGE_MAX_BYTES)]);
  const c1 = fakeClient(toolReply(okInput));
  const r1 = await A.readTimesheet({ buffer: bigPng, month: M, client: c1 });
  assert.equal(r1.code, "image_too_large");
  assert.equal(c1.calls.length, 0);
  const bigPdf = Buffer.concat([PDF, Buffer.alloc(A.IMAGE_MAX_BYTES)]);
  const c2 = fakeClient(toolReply(okInput));
  assert.equal((await A.readTimesheet({ buffer: bigPdf, month: M, client: c2 })).ok, true);
  assert.equal(c2.calls.length, 1);
});
await ok("対象月の形が不正 → bad_month（AI を呼ばない）。client も鍵も無い → no_key", async () => {
  const c = fakeClient(toolReply(okInput));
  assert.equal((await A.readTimesheet({ buffer: PDF, month: "2026-13", client: c })).code, "bad_month");
  assert.equal(c.calls.length, 0);
  const r = await A.readTimesheet({ buffer: PDF, month: M, client: null, apiKey: "" });
  assert.equal(r.code, "no_key");
  assert.match(r.message, /手入力/);
});
await ok("ツールが呼ばれない（文章だけ）→ no_tool。別名のツール → no_tool", async () => {
  const text = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "読み取れません" }] });
  assert.equal((await A.readTimesheet({ buffer: PDF, month: M, client: text })).code, "no_tool");
  const other = fakeClient({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "x", name: "other", input: okInput }] });
  assert.equal((await A.readTimesheet({ buffer: PDF, month: M, client: other })).code, "no_tool");
  const empty = fakeClient({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "x", name: "read_timesheet", input: null }] });
  assert.equal((await A.readTimesheet({ buffer: PDF, month: M, client: empty })).code, "no_tool");
});
await ok("max_tokens で切れた → truncated（途中の結果を使わない）。refusal → refusal", async () => {
  const cut = fakeClient(toolReply(okInput, { stop_reason: "max_tokens" }));
  const r = await A.readTimesheet({ buffer: PDF, month: M, client: cut });
  assert.equal(r.code, "truncated");
  assert.ok(!("days" in r));
  const ref = fakeClient(toolReply(okInput, { stop_reason: "refusal" }));
  assert.equal((await A.readTimesheet({ buffer: PDF, month: M, client: ref })).code, "refusal");
});
await ok("勤務表の年月が対象月と違う → wrong_month（日別は取り込まない）", async () => {
  const c = fakeClient(toolReply({ ...okInput, sheet_month: "2026-09" }));
  const r = await A.readTimesheet({ buffer: PDF, month: M, client: c });
  assert.equal(r.ok, false);
  assert.equal(r.code, "wrong_month");
  assert.equal(r.sheetMonth, "2026-09");
  assert.match(r.message, /2026-09.*2026-10/);
  assert.ok(!("days" in r));
});
await ok("勤務表に年月が書かれていない（null）なら、対象月として取り込む", async () => {
  const r = await A.readTimesheet({ buffer: PDF, month: M, client: fakeClient(toolReply({ ...okInput, sheet_month: null })) });
  assert.equal(r.ok, true);
  assert.equal(r.sheet.month, null);
});
await ok("日別の行が1つも読めない（空・範囲外だけ）→ empty", async () => {
  for (const days of [[], [row(40)], "x"]) {
    const r = await A.readTimesheet({ buffer: PDF, month: M, client: fakeClient(toolReply({ ...okInput, days })) });
    assert.equal(r.code, "empty", JSON.stringify(days));
  }
});
await ok("API のエラーは理由つきの失敗にする（例外にしない）：413・400・429・500・タイムアウト・その他", async () => {
  const cases = [[apiErr(413), "rejected"], [apiErr(400, "bad request"), "rejected"], [apiErr(429), "busy"], [apiErr(529), "busy"],
    [apiErr(500), "busy"], [apiErr(undefined, "Request timed out.", "APIConnectionTimeoutError"), "timeout"],
    [Object.assign(new Error("x"), { name: "AbortError" }), "timeout"], [apiErr(401), "api_error"], [new Error("ECONNRESET"), "api_error"]];
  for (const [err, code] of cases) {
    const r = await A.readTimesheet({ buffer: PDF, month: M, client: fakeClient(err) });
    assert.equal(r.ok, false);
    assert.equal(r.code, code, `${err.name} ${err.status}`);
    assert.ok(r.message.length > 5);
  }
});
await ok("失敗の message は、手入力へ進める日本語。API のエラー文（detail）は画面用の message に混ぜない", async () => {
  for (const status of [400, 413, 429, 500, 401, undefined]) {
    const r = await A.readTimesheet({ buffer: PDF, month: M, client: fakeClient(apiErr(status, "invalid_request_error: tool_choice ... sk-ant-secret")) });
    assert.doesNotMatch(r.message, /sk-ant|tool_choice|invalid_request/, String(status));
    assert.match(r.detail, /tool_choice/, String(status));
  }
});
await ok("AI の結果は、確認済み・確定を含まない（下書きだけ）。日ごとに reviewedAt も持たない", async () => {
  const r = await A.readTimesheet({ buffer: PDF, month: M, client: fakeClient(toolReply({ ...okInput, status: "confirmed", confirmed: true })) });
  assert.equal(r.ok, true);
  assert.ok(!("status" in r) && !("confirmed" in r));
  assert.ok(r.days.every((d) => !("reviewedAt" in d) && !("reviewed" in d) && !("status" in d)));
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
