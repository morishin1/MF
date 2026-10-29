// メンバー一覧（admin-members.html）：短い一覧・検索と絞り込み・選択・詳細の窓・一括登録・一括の退職／削除。
// 2026-10-24 メンバー管理UIと一括登録・削除の改善。すべて架空のデータ（実メンバー・実アカウントは触らない）。
//
// ■ 守るもの
//   一覧   ：検索・基本区分・雇用区分・使える業務で絞り込み、件数を出す。退職者は既定で隠し、切り替えで出す。
//            行は短く（氏名・メール・部署・雇用区分・基本区分・使える業務の短い名前・詳細）。操作は詳細の窓
//   選択   ：行のチェックとページの選択。「検索結果すべて」はページの選択と分けて、範囲を文字で出す。
//            選んでいるあいだだけ下に操作帯（人数）。絞り込み・ページを変えて見えなくなった人数を出す
//   詳細   ：5つのボタン・基本区分・利用中のシステム・ほかの操作が窓の中にある。Esc で閉じ、詳細ボタンへ戻る
//   一括登録：プレビュー（入力エラー・登録済み・ファイル内の重複）→ 登録。既定は名簿だけ（createAccounts:false）。
//            アカウントも作るときは、対象と影響を確認してから。結果は 追加／重複／失敗／アカウントだけ失敗 を分け、
//            失敗した行だけを戻せる。アカウントだけ失敗した人は、その人だけ作り直す（名簿は増やさない）。二度押しで二重に送らない
//            読めない CSV（閉じていない引用符）はプレビューを出さない。CSV ファイル（BOM・引用符・改行）と Shift_JIS も読む
//   削除   ：先に「消せるか」を1人ずつ確かめ（まだ消さない）、消せない理由・確認できない人を分ける。人数の入力で確定。
//            一部失敗を人ごとに出し、成功した人は二度と送らない。失敗した人だけ確かめ直す
//   退職   ：自分・退職済み・（経営者でないとき）経営者は対象外。確認のチェックのあと、対象だけ PATCH
//   権限   ：名簿を編集できない人には、選択・一括登録・追加を出さない
//   スマホ ：390px で横にはみ出さない（表の枠の中だけ横スクロール）。窓は全画面
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const GW = await import("../../lib/gw.js");
const MA = await import("../../lib/member-access.js");
const OWNER_ME = { email: "own@example.com", appRole: "owner", isAdmin: false, roles: [], memberships: [],
  gw: { employee: { id: "e-own", display_name: "経営 太郎", status: "active" }, roles: ["owner"], tenantId: "t1", stage: null },
  access: GW.accessOf({ isAdmin: false, isHr: true, roles: ["owner"] }) };

const emp = (id, name, extra = {}, roles = [], apps = []) => ({
  id, display_name: name, email: `${id}@example.com`, user_id: `u-${id}`, department: "開発", position: null,
  employment_type: "正社員", status: "active", employee_kind: "proper", partner_company_id: null, joined_on: "2026-04-01",
  roles, accounts: {}, ...MA.accessForMember(roles, `u-${id}`, new Map([[`u-${id}`, false]]), apps), ...extra,
});
function EMPLOYEES() {
  const list = [
    emp("e-own", "経営 太郎", {}, ["owner"], []),
    emp("e-hr", "人事 花子", { department: "管理部", employment_type: "正社員" }, ["hr"], ["hr", "office"]),
    emp("e-new", "誤登録 一郎", { status: "invited", user_id: null, employment_type: "契約社員" }),
    emp("e-rec", "記録 二郎", { department: "営業部" }, ["sales"], ["sales"]),
    emp("e-unk", "確認 三郎", { status: "invited", user_id: null }),
    emp("e-login", "ログイン 四郎", { status: "invited" }),
    emp("e-left", "退職 五郎", { status: "left", left_on: "2026-09-30" }),
    emp("e-leaving", "退職予定 六郎", { status: "leaving", employment_type: "業務委託" }),
  ];
  for (let i = 1; i <= 57; i++) list.push(emp(`e-p${String(i).padStart(2, "0")}`, `社員 ${String(i).padStart(2, "0")}`, { department: i % 2 ? "開発" : "営業部", employment_type: i % 3 ? "正社員" : "アルバイト" }, [], i % 4 ? [] : ["sales"]));
  return list;
}

async function open({ width = 1280, canManage = true, employees = EMPLOYEES(), delay = 0 } = {}) {
  const page = await br.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  const calls = { get: 0, checks: [], deletes: [], patches: [], bulk: [], links: [] };
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "own@example.com" }));
    for (const k of ["kp_layout", "kp_me", "kp_nav_open"]) localStorage.removeItem(k);
  });
  page.on("dialog", (d) => d.accept());
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  // 削除の確認・実行の答え（架空）
  const deleteCheck = { "e-rec": { ok: false, reason: { error: "employee_has_records", hint: "有給・稟議1件が残っています。状態を「退職」に変えてください。" } },
                        "e-unk": { status: 503, body: { error: "related_lookup_failed", hint: "関連する記録（経費申請）を確認できなかったため、削除していません。" } } };
  const deleteFailOnce = new Set(["e-login"]);   // 実行時に1回だけ止まる（給与の履歴など：23503 → 409）
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (url.pathname === "/api/employees/bulk") {
      const body = JSON.parse(req.postData() || "{}");
      calls.bulk.push(body);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const added = [], skipped = [], failed = [];
      body.rows.forEach((r, i) => {
        const line = i + 1;
        if (employees.some((e) => e.display_name === r.display_name)) return skipped.push({ line, name: r.display_name, kind: "duplicate_name", reason: "同じ氏名の人が既にいます" });
        if (/サーバ失敗/.test(r.display_name)) return failed.push({ line, name: r.display_name, reason: "保存に失敗しました（架空）" });
        const id = `e-b${employees.length + 1}`;
        employees.push(emp(id, r.display_name, { email: r.email || null, status: "invited", user_id: null }));
        const a = { line, name: r.display_name, id, email: r.email || null, account: "not_requested" };
        if (body.createAccounts === true) {
          if (!r.email) a.account = "no_email";
          else if (/fail/.test(r.email)) { a.account = "failed"; a.accountError = "アカウントを作れませんでした（架空）"; }
          else if (/linked/.test(r.email)) a.account = "linked";
          else { a.account = "created"; a.password = `pw-${line}`; }
        }
        added.push(a);
      });
      return send({ added, skipped, failed, withAccounts: body.createAccounts === true });
    }
    if (url.pathname === "/api/employees/link") {
      const body = JSON.parse(req.postData() || "{}");
      calls.links.push(body);
      return send({ ok: true, employeeId: body.employeeId, userId: "u-x", createdPassword: "pw-retry" });
    }
    if (url.pathname === "/api/employees" && req.method() === "GET" && url.searchParams.get("deleteCheck")) {
      const id = url.searchParams.get("deleteCheck");
      calls.checks.push(id);
      if (!employees.some((e) => e.id === id)) return send({ error: "employee_not_found", hint: "名簿に見つかりません" }, 404);
      const c = deleteCheck[id];
      if (c?.status) return send(c.body, c.status);
      const e = employees.find((x) => x.id === id);
      return send({ id, name: e.display_name, deletable: !c, reason: c ? { status: 409, ...c.reason } : null, hasLogin: Boolean(e.user_id) });
    }
    if (url.pathname === "/api/employees" && req.method() === "DELETE") {
      const id = url.searchParams.get("id");
      calls.deletes.push(id);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (deleteFailOnce.has(id)) { deleteFailOnce.delete(id); return send({ error: "employee_has_records", blockers: [], hint: "消してはいけない記録が残っているため、名簿から消せません。" }, 409); }
      const i = employees.findIndex((e) => e.id === id);
      if (i < 0) return send({ error: "employee_not_found" }, 404);
      employees.splice(i, 1);
      return send({ ok: true, id, authUserKept: true, systems: {} });
    }
    if (url.pathname === "/api/employees" && req.method() === "PATCH") {
      const body = JSON.parse(req.postData() || "{}");
      calls.patches.push(body);
      if (body.id === "e-p02") return send({ error: "forbidden", hint: "変更できません（架空）" }, 403);
      const e = employees.find((x) => x.id === body.id);
      Object.assign(e, { status: body.status });
      return send({ employee: e, systems: e.user_id ? { lms: { ok: true, action: "停止" } } : null });
    }
    if (url.pathname === "/api/employees" && req.method() === "GET") {
      calls.get++;
      return send({ employees: JSON.parse(JSON.stringify(employees)), canManage, canGrantRoles: canManage, canGrantOwner: true, meEmployeeId: "e-own", appsState: "table", systems: {}, kindReady: true });
    }
    if (/\/api\/partners\b/.test(url.pathname)) return send({ companies: [], canManage: true });
    if (/\/api\/me\b/.test(url.pathname)) return send(OWNER_ME);
    if (/\/api\/notifications/.test(url.pathname)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url.pathname)) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}/admin-members.html`);
  await page.waitForSelector("#list table", { timeout: 10000 });
  page.calls = calls; page.errs = errs; page.employees = employees;
  return page;
}
const rows = (page) => page.locator("#list tbody tr[data-employee]");
const names = async (page) => (await rows(page).locator("td.mb-name b").allInnerTexts());
const sel = (page, id) => page.locator(`#list [data-select="${id}"]`);
const wait = (page, ms = 250) => page.waitForTimeout(ms);

console.log("— 一覧：短い行・件数・退職者・ページ —");
{
  const page = await open();
  const ths = (await page.locator("#list thead th").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  check(ths.join("|") === "氏名|部署・雇用区分|基本区分|使える業務", `列（${ths.join("|")}）`);
  check(await page.locator("#list .mb-tg").count() === 0, "一覧の行には5つのボタンを置かない（詳細の窓）");
  check(await page.locator("#list tbody input[data-role]").count() === 0, "一覧に内部の役割のチェックボックスは無い");
  check(await page.locator("#list tbody button", { hasText: "削除" }).count() === 0, "一覧の行に削除ボタンは無い");
  check(await rows(page).count() === 50, `1ページ50人（いま ${await rows(page).count()}）`);
  const cnt = await page.locator("#f-count").innerText();
  check(cnt.includes("表示 64人") && cnt.includes("名簿 65人") && cnt.includes("退職 1人は非表示"), `件数（${cnt}）`);
  check(!(await names(page)).includes("退職 五郎"), "退職者は既定で出さない");
  check((await page.locator("#mb-pager").innerText()).includes("1 / 2"), "ページ 1 / 2");
  check(await page.locator("#mb-selbar").isHidden(), "選んでいないときは操作帯を出さない");
  check(await page.locator("#bulk-btn").isVisible() && await page.locator("#add-btn").isVisible(), "上に「一括登録」と「メンバー追加」");
  check(await page.locator("#bulk-card").count() === 0, "一覧の下の「まとめて追加」は無くした（上の一括登録へ）");
  await page.screenshot({ path: shotPath("members-list-pc.png") });
  await page.locator("#mb-pager button", { hasText: "次へ" }).click();
  check(await rows(page).count() === 14 && (await page.locator("#mb-pager").innerText()).includes("2 / 2"), "次へ：残り14人");
  await page.locator("#f-left").check();
  check((await page.locator("#f-count").innerText()).includes("表示 65人"), "退職者も表示：65人");
  check(page.errs.length === 0, `画面のエラーなし（${page.errs.join(" / ")}）`);
  await page.close();
}

console.log("\n— 検索・絞り込み —");
{
  const page = await open();
  await page.locator("#f-q").fill("人事");
  await wait(page);
  check((await names(page)).join(",") === "人事 花子", "氏名で検索");
  await page.locator("#f-q").fill("E-REC@EXAMPLE");
  await wait(page);
  check((await names(page)).join(",") === "記録 二郎", "メールで検索（大文字小文字を無視）");
  await page.locator("#f-q").fill("");
  await page.locator("#f-status").selectOption("invited");
  await wait(page);
  check((await names(page)).sort().join(",") === ["誤登録 一郎", "確認 三郎", "ログイン 四郎"].sort().join(","), "基本区分：入社準備");
  await page.locator("#f-status").selectOption("left");
  await wait(page);
  check((await names(page)).join(",") === "退職 五郎", "基本区分で「退職」を選ぶと退職者が出る");
  await page.locator("#f-status").selectOption("");
  await page.locator("#f-type").selectOption("業務委託");
  await wait(page);
  check((await names(page)).join(",") === "退職予定 六郎", "雇用区分");
  await page.locator("#f-type").selectOption("");
  await page.locator("#f-app").selectOption("office");
  await wait(page);
  check((await names(page)).sort().join(",") === ["経営 太郎", "人事 花子"].sort().join(","), "使える業務：Office");
  const optText = await page.locator('#f-app option[value="sales"]').innerText();
  check(/（\d+）/.test(optText), `絞り込みの選択肢に人数（${optText}）`);
  await page.locator("#f-app").selectOption("");
  await page.locator("#f-q").fill("該当なしの名前");
  await wait(page);
  check(await page.locator('[data-role="no-match"]').isVisible() && (await page.locator("#f-count").innerText()).includes("表示 0人"), "0人：条件に合う人がいません");
  await page.close();
}

console.log("\n— 選択：ページと検索結果すべてを分ける・見えない選択を出す —");
{
  const page = await open();
  await sel(page, "e-hr").check();
  await sel(page, "e-rec").check();
  check(await page.locator("#mb-selbar").isVisible() && (await page.locator('[data-role="sel-count"]').innerText()) === "2人を選択中", "2人を選ぶと、操作帯に「2人を選択中」");
  check(await page.locator(`#list [data-select="e-rec"]`).evaluate((n) => n === document.activeElement), "選んだあとも、そのチェックにフォーカスが残る");
  await page.locator("#sel-page").check();
  check((await page.locator('[data-role="sel-count"]').innerText()) === "50人を選択中", "ページの選択：このページの50人");
  check((await page.locator('[data-role="scope-page"]').innerText()).includes("このページの50人"), "範囲を文字で出す（このページの50人）");
  await page.locator('[data-role="select-all-results"]').click();
  check((await page.locator('[data-role="sel-count"]').innerText()) === "64人を選択中", "検索結果すべて：64人");
  check((await page.locator('[data-role="scope-results"]').innerText()).includes("64人すべて"), "範囲を文字で出す（検索結果の64人すべて）");
  check((await page.locator('[data-role="sel-hidden"]').innerText()).includes("14人"), "このページに出ていない14人を、操作帯に出す");
  await page.locator("#sel-page").uncheck();
  check((await page.locator('[data-role="sel-count"]').innerText()) === "14人を選択中", "ページの選択を外すと、このページの50人だけ外れる");
  await page.locator('#mb-selbar [data-act="clear"]').click();
  check(await page.locator("#mb-selbar").isHidden(), "選択を解除すると操作帯が消える");
  // 絞り込みを変えても選択は残り、見えない人数を出す
  await sel(page, "e-hr").check();
  await sel(page, "e-rec").check();
  await page.locator("#f-q").fill("人事");
  await wait(page);
  check((await page.locator('[data-role="sel-hidden"]').innerText()).includes("1人"), "絞り込みで見えなくなった選択（1人）を出す");
  await page.locator('#mb-selbar [data-act="only-selected"]').click();
  await wait(page);
  check((await names(page)).sort().join(",") === ["人事 花子", "記録 二郎"].sort().join(","), "選択中だけ表示：検索に関係なく、選んだ2人");
  check(await page.locator('[data-role="only-selected"]').isVisible(), "「選択中だけ表示中」の印");
  await page.screenshot({ path: shotPath("members-selection-pc.png") });
  await page.close();
}

console.log("\n— 詳細の窓 —");
{
  const page = await open();
  const btn = page.locator('#list tr[data-employee="e-hr"] [data-role="open-detail"]');
  await btn.click();
  const m = page.locator('#mb-member [data-employee="e-hr"]');
  check(await m.isVisible(), "詳細の窓が開く");
  check((await m.locator(".mb-tg").allInnerTexts()).join(",") === "採用HR,Sales,Office,マーケティング,経営", "5つのボタンは窓の中");
  check(await m.locator('[data-role="office-work"] .mb-sub').count() === 3, "Office の中の3つのスイッチ");
  check(await m.locator("select").count() === 1, "基本区分のプルダウン");
  for (const t of ["編集", "ログイン", "フォルダ", "現場契約", "書類を依頼", "退職にする（利用停止）", "名簿から削除（誤登録）"]) {
    check(await m.locator("button", { hasText: t }).count() >= 1, `操作「${t}」は窓の中`);
  }
  check((await page.locator("#mb-member-title").innerText()).includes("人事 花子"), "見出しに氏名");
  await page.screenshot({ path: shotPath("members-detail-pc.png") });
  await page.keyboard.press("Escape");
  check(await page.locator("#mb-member").isHidden(), "Esc で閉じる");
  check(await btn.evaluate((n) => n === document.activeElement), "閉じたら、押した「詳細」ボタンへ戻る");
  // 窓から「編集」：先に窓を閉じて、ドロワーを開く
  await btn.click();
  await m.locator("button", { hasText: "編集" }).click();
  check(await page.locator("#mb-member").isHidden() && await page.locator("#e-drawer").isVisible(), "「編集」は窓を閉じてからドロワー");
  await page.close();
}

console.log("\n— 一括登録：プレビュー → 名簿だけ（既定）—");
{
  const page = await open({ delay: 500 });
  await page.locator("#bulk-btn").click();
  check(await page.locator("#mb-bulk").isVisible(), "一括登録の窓が開く");
  await page.locator("#bk-text").fill([
    "氏名\tメール\t部署\t役職\t雇用区分\t入社日",
    "新規 太郎\ttaro@example.com\t管理部\t\t正社員\t2026/4/1",
    "\tnobody@example.com",
    "人事 花子\tother@example.com",
    "別名\tE-REC@example.com",
    "新規 太郎\tdup@example.com",
    "形式 花子\tnot-mail",
    "サーバ失敗 次郎\tsv@example.com",
    "新規 三郎",
  ].join("\n"));
  await page.locator("#bk-preview").click();
  const st = await page.locator('[data-role="bulk-preview"] tbody tr').evaluateAll((ns) => ns.map((n) => `${n.dataset.line}:${n.dataset.status}`));
  check(st.join(",") === "2:ok,3:error,4:registered,5:registered,6:duplicate,7:error,8:ok,9:ok", `行ごとの判定（${st.join(",")}）`);
  check((await page.locator('[data-role="bulk-summary"]').innerText()).replace(/\s+/g, "").includes("登録できる3"), "登録できる3");
  check(await page.locator('input[name="bk-acc"][value="roster"]').isChecked(), "既定は「名簿に登録するだけ」");
  await page.screenshot({ path: shotPath("members-bulk-preview.png") });
  await page.locator("#bk-next").click();
  await page.locator("#bk-next").click({ force: true }).catch(() => {});    // 二度押し
  await page.waitForSelector('[data-role="bulk-result"]');
  check(page.calls.bulk.length === 1, `二度押しでも送るのは1回（いま ${page.calls.bulk.length}）`);
  check(page.calls.bulk[0].createAccounts === false, "createAccounts:false を明示して送る");
  check(page.calls.bulk[0].rows.map((r) => r.display_name).join(",") === "新規 太郎,サーバ失敗 次郎,新規 三郎", "送るのは登録できる行だけ");
  check(page.calls.bulk[0].rows[0].joined_on === "2026-04-01", "入社日は 2026-04-01 にそろえて送る");
  const k = async (key) => page.locator(`[data-role="bulk-result"] [data-k="${key}"]`).innerText();
  check(await k("added") === "2" && await k("failed") === "1" && await k("skipped") === "0", "結果：追加2・失敗1・重複0");
  check((await page.locator('[data-role="bulk-result"]').innerText()).includes("ログインアカウントは作っていません"), "アカウントは作っていない、と出す");
  check((await page.locator('[data-role="failed"]').innerText()).includes("8"), "失敗は元の行番号（8行目）で出す");
  await page.locator('[data-act="retry-failed"]').click();
  const back = await page.locator("#bk-text").inputValue();
  check(back.split("\n").length === 2 && back.includes("サーバ失敗 次郎") && !back.includes("新規 太郎"), "失敗した行だけを入力欄に戻す");
  // 同じ内容をもう一度プレビューすると、成功した人は「登録済み」
  await page.locator("#bk-text").fill("新規 太郎\ttaro@example.com");
  await page.locator("#bk-preview").click();
  check(await page.locator('[data-role="bulk-preview"] tbody tr').getAttribute("data-status") === "registered", "登録した人は、次のプレビューで登録済み（二重に送らない）");
  await page.close();
}

console.log("\n— 一括登録：アカウントも作る（確認してから）・アカウントだけ失敗した人の再試行 —");
{
  const page = await open();
  await page.locator("#bulk-btn").click();
  await page.locator("#bk-text").fill("作る 一\tmake@example.com\n紐づけ 二\tlinked@example.com\n失敗 三\tfail@example.com\nメールなし 四");
  await page.locator("#bk-preview").click();
  await page.locator('input[name="bk-acc"][value="accounts"]').check();
  await page.locator("#bk-next").click();
  check(await page.locator('[data-role="account-impact"]').isVisible(), "対象と影響の確認が出る");
  const imp = await page.locator('[data-role="account-impact"]').innerText();
  check(imp.includes("3人") && imp.includes("メールは送りません") && imp.includes("無限道場・タイムカード・会計"), "影響：3人・メールは送らない・3システムに登録");
  check((await page.locator('[data-role="account-targets"] tbody tr').count()) === 3, "対象の3人を並べる");
  check(await page.locator("#bk-submit").isDisabled(), "確認のチェックまで、登録できない");
  await page.locator("#bk-agree").check();
  await page.locator("#bk-submit").click();
  await page.waitForSelector('[data-role="bulk-result"]');
  check(page.calls.bulk[0].createAccounts === true, "createAccounts:true で送る");
  const k = async (key) => page.locator(`[data-role="bulk-result"] [data-k="${key}"]`).innerText();
  check(await k("created") === "1" && await k("linked") === "1" && await k("account-failed") === "1" && await k("no-email") === "1", "作成1・紐づけ1・作れなかった1・メールなし1");
  check((await page.locator('[data-role="passwords"]').innerText()).includes("pw-1"), "初回パスワード（1回だけ）");
  const retry = page.locator('[data-role="account-failed"] button', { hasText: "再試行" });
  await retry.click();
  await page.waitForTimeout(400);
  check(page.calls.links.length === 1 && page.calls.links[0].email === "fail@example.com", "アカウントだけを作り直す（/api/employees/link）");
  check(page.calls.bulk.length === 1, "名簿の一括登録は送り直さない");
  check((await page.locator('[data-role="account-failed"]').innerText()).includes("作成・連携しました"), "作り直した結果を出す");
  check((await page.locator('[data-role="passwords"]').innerText()).includes("pw-retry"), "作り直した人の初回パスワードも出す");
  await page.close();
}

console.log("\n— 一括登録：読めない形・CSV ファイル —");
{
  const page = await open();
  await page.locator("#bulk-btn").click();
  await page.locator("#bk-text").fill('山田,a@example.com\n"鈴木,b@example.com');
  await page.locator("#bk-preview").click();
  check((await page.locator('[data-role="bulk-error"]').innerText()).includes("閉じられていません") && await page.locator('[data-role="bulk-preview"]').count() === 0, "閉じていない引用符：プレビューを出さない（理由と行番号）");
  // BOM 付き UTF-8 の CSV（引用符・セルの中のカンマ）
  const csv = "﻿氏名,メール,部署\r\n\"山田, 太郎\",yamada@example.com,\"管理部\"\r\n鈴木 花子,suzuki@example.com,営業部\r\n";
  await page.locator("#bk-file").setInputFiles({ name: "members.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
  await page.waitForTimeout(300);
  check((await page.locator('[data-role="file-note"]').innerText()).includes("members.csv"), "ファイル名を出す");
  await page.locator("#bk-preview").click();
  const firstName = await page.locator('[data-role="bulk-preview"] tbody tr').first().locator("td").nth(2).innerText();
  check(firstName === "山田, 太郎", `引用符の中のカンマを読める（${firstName}）`);
  check((await page.locator('[data-role="bulk-summary"]').innerText()).includes("見出しあり"), "BOM 付きでも見出しとして読む");
  // Shift_JIS の CSV（Excel の既定）
  await page.locator("button", { hasText: "戻って直す" }).click();
  const sjis = Buffer.from([0x8e, 0x81, 0x96, 0xbc, 0x2c, 0x83, 0x81, 0x81, 0x5b, 0x83, 0x8b, 0x0d, 0x0a, 0x8d, 0xb2, 0x93, 0xa1, 0x2c, 0x73, 0x40, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x63, 0x6f, 0x6d, 0x0d, 0x0a]);
  await page.locator("#bk-file").setInputFiles({ name: "sjis.csv", mimeType: "text/csv", buffer: sjis });
  await page.waitForTimeout(300);
  check((await page.locator('[data-role="file-note"]').innerText()).includes("Shift_JIS"), "Shift_JIS として読んだことを出す");
  await page.locator("#bk-preview").click();
  const sName = await page.locator('[data-role="bulk-preview"] tbody tr').first().locator("td").nth(2).innerText();
  check(sName === "佐藤", `Shift_JIS の氏名（${sName}）`);
  await page.close();
}

console.log("\n— 一括削除：確かめてから・人数を入れて確定・一部失敗・確かめ直し —");
{
  const page = await open({ delay: 300 });
  // 2ページ目の人（いまの一覧に出ていない）も選ぶ
  await page.locator("#mb-pager button", { hasText: "次へ" }).click();
  const p2 = await rows(page).first().getAttribute("data-employee");
  await sel(page, p2).check();
  await page.locator("#mb-pager button", { hasText: "前へ" }).click();
  for (const id of ["e-new", "e-rec", "e-unk", "e-login"]) await sel(page, id).check();
  await page.locator('#mb-selbar [data-act="delete"]').click();
  check(await page.locator("#mb-confirm").isVisible(), "確認の窓が開く");
  await page.waitForFunction(() => !document.querySelector('#mb-confirm [data-check="checking"]'));
  const chk = await page.locator('[data-role="delete-targets"] tbody tr').evaluateAll((ns) => Object.fromEntries(ns.map((n) => [n.dataset.target, n.dataset.check])));
  check(chk["e-new"] === "ok" && chk["e-login"] === "ok" && chk[p2] === "ok" && chk["e-rec"] === "ng" && chk["e-unk"] === "unknown", `確認の結果（${JSON.stringify(chk)}）`);
  check(page.calls.deletes.length === 0, "確認だけでは何も消さない");
  check((await page.locator('[data-role="hidden-targets"]').innerText()).includes("1人"), "一覧に出ていない1人がいる、と出す");
  check((await page.locator(`[data-target="${p2}"]`).innerText()).includes("一覧に非表示"), "その人の行に「一覧に非表示」");
  check((await page.locator(`[data-target="e-rec"]`).innerText()).includes("有給・稟議"), "削除できない理由（記録）");
  check((await page.locator(`[data-target="e-unk"]`).innerText()).includes("確認できませんでした"), "確認できない人は削除しない");
  const imp = await page.locator('[data-role="delete-impact"]').innerText();
  check(imp.includes("元に戻せません") && imp.includes("アーカイブではありません") && imp.includes("ログインアカウント自体は残ります") && imp.includes("会計の権限は外します"), "起きること（元に戻せない・ログインは残る・会計の権限は外す）");
  check(await page.locator("#cf-run").isDisabled(), "人数を入れるまで押せない");
  await page.locator("#cf-typed").fill("5");
  check(await page.locator("#cf-run").isDisabled(), "違う人数では押せない");
  await page.locator("#cf-typed").fill("3");
  check(!(await page.locator("#cf-run").isDisabled()), "正しい人数（3）で押せる");
  await page.screenshot({ path: shotPath("members-delete-confirm.png") });
  await page.locator("#cf-run").click();
  await page.locator("#cf-run").click({ force: true }).catch(() => {});      // 二度押し
  await page.waitForFunction(() => document.querySelector('[data-role="delete-summary"] [data-k="deleted"]'), null, { timeout: 8000 });
  check(page.calls.deletes.length === 3 && !page.calls.deletes.includes("e-rec") && !page.calls.deletes.includes("e-unk"), `消せる3人だけ送る・二度押しで増えない（${page.calls.deletes.join(",")}）`);
  const d = await page.locator('[data-role="delete-summary"] [data-k="deleted"]').innerText();
  const f = await page.locator('[data-role="delete-summary"] [data-k="failed"]').innerText();
  check(d === "2" && f === "1", `一部失敗：削除2・失敗1（${d}/${f}）`);
  check((await page.locator(`[data-target="e-login"]`).innerText()).includes("消してはいけない記録"), "失敗の理由を人ごとに出す");
  check(!(await page.locator("#mb-confirm-x").isDisabled()), "終わったら閉じられる");
  // 確かめ直し：失敗した人と、確認できなかった人だけ
  const before = page.calls.checks.length;
  await page.locator('[data-act="recheck"]').click();
  await page.waitForFunction(() => !document.querySelector('#mb-confirm [data-check="checking"]'));
  const again = page.calls.checks.slice(before).sort();
  check(again.join(",") === ["e-login", "e-unk"].sort().join(","), `確かめ直すのは失敗した人・確認できなかった人だけ（${again.join(",")}）`);
  await page.locator("#cf-typed").fill("1");
  await page.locator("#cf-run").click();
  await page.waitForTimeout(800);
  const deletedTwice = page.calls.deletes.filter((x) => x === "e-new").length;
  check(deletedTwice === 1 && page.calls.deletes.at(-1) === "e-login", "成功した人は二度と送らない。今回は e-login だけ");
  await page.locator("button", { hasText: "閉じる" }).last().click();
  check(await page.locator("#mb-confirm").isHidden(), "閉じる");
  check(!(await page.locator("#mb-selbar").isHidden()) && (await page.locator('[data-role="sel-count"]').innerText()) === "2人を選択中", "消せなかった2人は選択に残る（消した人は外れる）");
  check(page.errs.length === 0, `画面のエラーなし（${page.errs.join(" / ")}）`);
  await page.close();
}

console.log("\n— 一括で退職にする（利用停止）—");
{
  const page = await open();
  await page.locator("#f-left").check();
  for (const id of ["e-own", "e-left", "e-p01", "e-p02", "e-p03"]) await sel(page, id).check();
  await page.locator('#mb-selbar [data-act="retire"]').click();
  const skip = await page.locator('[data-role="retire-targets"] tbody tr').evaluateAll((ns) => ns.filter((n) => n.dataset.skip).map((n) => n.dataset.target).sort());
  check(skip.join(",") === "e-left,e-own", `自分・退職済みは対象外（${skip.join(",")}）`);
  const imp = await page.locator('[data-role="retire-impact"]').innerText();
  check(imp.includes("入れなくなります") && imp.includes("残ります") && imp.includes("元に戻せます"), "起きること（入れなくなる・記録は残る・元に戻せる）");
  check(await page.locator("#cf-run").isDisabled(), "確認のチェックまで押せない");
  await page.locator("#cf-agree").check();
  await page.locator("#cf-run").click();
  await page.waitForFunction(() => document.querySelector('[data-role="retire-summary"] [data-k="retired"]'));
  check(page.calls.patches.map((p) => p.id).sort().join(",") === "e-p01,e-p02,e-p03" && page.calls.patches.every((p) => p.status === "left"), "対象の3人だけ status:left");
  check((await page.locator('[data-role="retire-summary"] [data-k="retired"]').innerText()) === "2" && (await page.locator('[data-role="retire-summary"] [data-k="failed"]').innerText()) === "1", "退職2・失敗1");
  check(page.calls.deletes.length === 0, "退職では名簿を消さない");
  await page.close();
}

console.log("\n— 名簿を編集できない人 —");
{
  const page = await open({ canManage: false });
  check(await page.locator("#list [data-select]").count() === 0 && await page.locator("#sel-page").count() === 0, "選択のチェックを出さない");
  check(await page.locator("#bulk-btn").isHidden() && await page.locator("#add-btn").isHidden(), "一括登録・メンバー追加を出さない");
  await page.locator('#list tr[data-employee="e-hr"] [data-role="open-detail"]').click();
  check(await page.locator('#mb-member [data-act="delete-one"]').count() === 0, "詳細の窓にも削除・退職を出さない");
  await page.close();
}

console.log("\n— スマホ幅（390px）—");
{
  const page = await open({ width: 390 });
  const over = async () => page.evaluate(() => {
    const w = window.innerWidth;
    const out = [...document.querySelectorAll("#roles *")].filter((n) => !n.closest(".table-scroll") && n.getBoundingClientRect().width > 0)
      .map((n) => Math.round(n.getBoundingClientRect().right - w));
    return Math.max(0, ...out);
  });
  check(await over() <= 0, `一覧の中身が画面の幅に収まる（はみ出し ${await over()}px）`);
  await sel(page, "e-hr").check();
  const bar = await page.locator("#mb-selbar").boundingBox();
  check(bar && bar.x >= 0 && bar.x + bar.width <= 390 && bar.y + bar.height <= 900, `操作帯が画面の中（${JSON.stringify(bar)}）`);
  await page.screenshot({ path: shotPath("members-list-sp.png") });
  await page.locator('#list tr[data-employee="e-hr"] [data-role="open-detail"]').click();
  const mb = await page.locator("#mb-member").boundingBox();
  check(mb && mb.x === 0 && Math.round(mb.width) === 390, `詳細の窓は全画面（${JSON.stringify(mb)}）`);
  const tg = await page.locator("#mb-member .mb-tg").evaluateAll((ns) => ns.map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), Math.round(r.right)]; }));
  check(tg.length === 5 && tg.every(([w, h, r]) => w >= 60 && h >= 32 && r <= 390), `5つのボタンが押せる大きさで、窓に収まる（${tg.map((x) => x.join("x")).join(" ")}）`);
  await page.screenshot({ path: shotPath("members-detail-sp.png") });
  await page.keyboard.press("Escape");
  await page.locator("#bulk-btn").click();
  const bk = await page.locator("#mb-bulk").boundingBox();
  check(bk && Math.round(bk.width) === 390, "一括登録の窓も全画面");
  await page.close();
}

await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
