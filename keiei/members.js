// 経営（/keiei）の「メンバー実行状況」（#members）。誰が何をやっていて、誰が止まっているかを、毎日すぐ判断する画面。
//
// ■ ここでしないこと
//   日報の編集・タスクの編集・勤怠の修正はしない（見る → 気付く → フォローする まで）。
//   詳しく見る・処理するのは、日報・勤怠（/admin-nippo.html）・全員のタスク（/admin-tasks.html）・チーム状況（/admin-team.html）。
//   状態（要対応・注意・良好）や数字はサーバ（lib/member-exec.js）が決めたものをそのまま出す。ここで判定し直さない。
//
// index.html（/keiei）から window.KeieiMembers.open(mainElement, isStale) で呼ばれる。
(function () {
  const esc = window.KeieiLayout ? window.KeieiLayout.esc
    : (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CSS = `
    .km-tiles { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; margin:0 0 16px; }
    .km-tile { background:#fff; border:1px solid var(--k-line,#e2e2dc); border-radius:10px; padding:10px 12px; }
    .km-tile .lb { font-size:12px; color:var(--k-mute,#6b7080); }
    .km-tile .val { font-size:22px; font-weight:700; color:var(--k-ink,#1b2440); font-variant-numeric:tabular-nums; margin-top:2px; }
    .km-tile .val small { font-size:12px; font-weight:500; color:var(--k-mute,#6b7080); margin-left:2px; }
    .km-tile.bad { border-left:3px solid var(--k-red,#b3261e); }
    .km-tile.bad .val { color:var(--k-red,#b3261e); }
    .km-tile .val.miss { font-size:13px; color:var(--k-faint,#9aa0b4); font-weight:500; }
    .km-follow { display:grid; gap:8px; margin:0 0 16px; }
    .km-frow { display:flex; align-items:center; gap:10px; background:#fff; border:1px solid var(--k-line,#e2e2dc); border-left:3px solid var(--k-red,#b3261e);
      border-radius:10px; padding:10px 12px; }
    .km-frow b { font-size:14px; color:var(--k-ink,#1b2440); }
    .km-frow span { font-size:12.5px; color:var(--k-sub,#4a5068); }
    .km-frow .km-go { margin-left:auto; }
    .km-tools { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:0 0 10px; }
    .km-tools select, .km-tools input { margin:0; width:auto; font-size:12.5px; padding:5px 8px; max-width:100%; }
    .km-st { display:inline-block; border-radius:999px; padding:2px 10px; font-size:11.5px; font-weight:700; white-space:nowrap; }
    .km-st.danger { background:var(--k-red-bg,#fdecea); color:var(--k-red,#b3261e); }
    .km-st.warn { background:var(--k-amber-bg,#fbf1d6); color:var(--k-amber,#7d5a00); }
    .km-st.good { background:var(--k-green-bg,#e5f1e2); color:var(--k-green,#2f6f3a); }
    table.km-t { border-collapse:collapse; width:100%; font-size:13px; background:#fff; }
    table.km-t th { text-align:left; font-size:11.5px; color:var(--k-mute,#6b7080); font-weight:500; padding:7px 8px; border-bottom:1px solid var(--k-line,#e2e2dc); white-space:nowrap; background:#f6f6f2; }
    table.km-t td { padding:8px; border-bottom:1px solid #f0f0ea; vertical-align:top; }
    table.km-t td.n { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
    table.km-t tr.km-row { cursor:pointer; }
    table.km-t tr.km-row:hover td { background:#fafaf6; }
    .km-why { font-size:11.5px; color:var(--k-mute,#6b7080); line-height:1.5; }
    .km-bad { color:var(--k-red,#b3261e); font-weight:700; }
    .km-cards { display:none; }
    .km-card { background:#fff; border:1px solid var(--k-line,#e2e2dc); border-radius:10px; padding:12px; margin:0 0 8px; }
    .km-card .h { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:0 0 8px; }
    .km-card .h b { font-size:15px; color:var(--k-ink,#1b2440); }
    .km-card dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:0 0 10px; font-size:13px; }
    .km-card dt { color:var(--k-mute,#6b7080); }
    .km-card dd { margin:0; text-align:right; }
    .km-card .kei-btn { width:100%; text-align:center; box-sizing:border-box; }
    .km-dr-bg { position:fixed; inset:0; background:rgba(20,24,40,.35); z-index:80; }
    .km-dr { position:fixed; top:0; right:0; bottom:0; width:min(560px,100%); background:#fafaf7; z-index:81; overflow-y:auto; box-shadow:-8px 0 24px rgba(0,0,0,.12); }
    .km-dr-in { padding:18px 18px 48px; }
    .km-dr-h { display:flex; align-items:center; gap:10px; margin:0 0 12px; }
    .km-dr-h h2 { margin:0; font-size:18px; color:var(--k-ink,#1b2440); }
    .km-dr-h button { margin-left:auto; }
    .km-box { background:#fff; border:1px solid var(--k-line,#e2e2dc); border-radius:10px; padding:12px 14px; margin:0 0 10px; }
    .km-box h3 { font-size:13.5px; margin:0 0 8px; color:var(--k-ink,#1b2440); }
    .km-box ul { margin:0; padding-left:18px; font-size:13px; line-height:1.7; }
    .km-box p { margin:4px 0; font-size:13px; line-height:1.7; }
    .km-task { border-top:1px solid #f0f0ea; padding:6px 0; font-size:13px; }
    .km-task:first-of-type { border-top:0; }
    .km-task .m { font-size:11.5px; color:var(--k-mute,#6b7080); line-height:1.6; }
    .km-links { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0 0; }
    @media (max-width: 760px) {
      .km-table-wrap { display:none; }
      .km-cards { display:block; }
      .km-dr { top:auto; left:0; width:100%; max-height:88vh; border-radius:14px 14px 0 0; }
      .km-tiles { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .km-frow { flex-wrap:wrap; }
      .km-frow .km-go { margin-left:0; }
    }`;
  function style() {
    if (document.getElementById("km-style")) return;
    const s = document.createElement("style"); s.id = "km-style"; s.textContent = CSS; document.head.appendChild(s);
  }

  let main = null, D = null, F = { dep: "", status: "", nippo: "", focus: "", overdue: false, tomorrow: false, q: "" }, date = null;

  const num = (v, suffix = "", bad = false) => v == null
    ? `<div class="val miss">読めませんでした</div>`
    : `<div class="val">${esc(String(v))}<small>${esc(suffix)}</small></div>`;
  const tile = (key, label, v, suffix, bad) => `<div class="km-tile${bad && v ? " bad" : ""}" data-sum="${key}"><div class="lb">${esc(label)}</div>${num(v, suffix)}</div>`;

  const nippoCell = (m) => m.nippo.submitted == null ? `<span class="km-why">—</span>`
    : m.nippo.submitted ? "提出" : `<span class="km-bad">${D.isToday ? "まだ" : "未提出"}</span>`;
  const todayCell = (m) => !m.today ? "—" : m.today.total ? `${m.today.done}/${m.today.total}` : `<span class="km-bad">未登録</span>`;
  const tomorrowCell = (m) => !m.tomorrow ? "—" : !m.tomorrow.count ? `<span class="km-bad">未登録</span>` : m.tomorrow.confirmed ? "確定" : esc(m.tomorrow.label);
  const overdueCell = (m) => m.overdue == null ? "—" : m.overdue ? `<span class="km-bad">${m.overdue}</span>` : "0";

  function filtered() {
    return D.members.filter((m) => (!F.dep || m.department === F.dep)
      && (!F.status || m.status === F.status)
      && (!F.nippo || (F.nippo === "yes" ? m.nippo.submitted === true : m.nippo.submitted === false))
      && (!F.focus || (F.focus === "done" ? m.today?.allDone : m.today && !m.today.allDone))
      && (!F.overdue || (m.overdue || 0) > 0)
      && (!F.tomorrow || (m.tomorrow && !m.tomorrow.count))
      && (!F.q || String(m.name).includes(F.q)));
  }

  function render() {
    const s = D.summary;
    const people = s.people;
    const tiles = [
      tile("nippo", "日報提出", s.nippoSubmitted == null ? null : `${s.nippoSubmitted} / ${people}`, "人"),
      tile("focus", "今日の3つ完了", s.focusDone == null ? null : `${s.focusDone} / ${people}`, "人"),
      tile("follow", "要フォロー", s.followRequired, "人", true),
      tile("overdue", "期限超過", s.overdue, "件", true),
      tile("tomorrow", "明日の3つ未登録", s.tomorrowMissing, "人", true),
      tile("consult", "相談・ブロッカーあり", s.consultOrBlocker, "人", true),
    ].join("");
    const follow = D.follow.length ? `<div class="km-follow" data-role="follow">${D.follow.map((f) => `<div class="km-frow" data-emp="${esc(f.employeeId)}">
        <div><b>${esc(f.name)}</b><br><span>${esc(f.reasons.join(" / "))}</span></div>
        <button class="kei-btn sec km-go" onclick="KeieiMembers.openMember('${esc(f.employeeId)}')">確認する →</button></div>`).join("")}</div>`
      : `<div class="kei-none" data-role="follow-none">今日、要対応の人はいません。</div>`;
    const deps = D.departments.map((d) => `<option value="${esc(d)}" ${F.dep === d ? "selected" : ""}>${esc(d)}</option>`).join("");
    const opt = (k, v, l) => `<option value="${v}" ${F[k] === v ? "selected" : ""}>${l}</option>`;
    const rows = filtered();
    const table = rows.map((m) => `<tr class="km-row" data-emp="${esc(m.employeeId)}" data-status="${m.status}" onclick="KeieiMembers.openMember('${esc(m.employeeId)}')">
        <td><b>${esc(m.name)}</b>${m.department ? `<div class="km-why">${esc(m.department)}</div>` : ""}</td>
        <td>${nippoCell(m)}</td><td class="n">${todayCell(m)}</td>
        <td class="n">${overdueCell(m)}</td><td>${tomorrowCell(m)}</td>
        <td><span class="km-st ${m.status}">${esc(m.statusLabel)}</span>${m.reasons.length ? `<div class="km-why">${esc(m.reasons.slice(0, 2).map((r) => r.label).join("・"))}</div>` : ""}</td></tr>`).join("");
    const cards = rows.map((m) => `<div class="km-card" data-emp="${esc(m.employeeId)}" data-status="${m.status}">
        <div class="h"><b>${esc(m.name)}</b><span class="km-st ${m.status}">${esc(m.statusLabel)}</span></div>
        <dl><dt>日報</dt><dd>${nippoCell(m)}</dd><dt>今日の3つ</dt><dd>${todayCell(m)}</dd>
          <dt>期限超過</dt><dd>${m.overdue == null ? "—" : `${overdueCell(m)}件`}</dd><dt>明日の3つ</dt><dd>${tomorrowCell(m)}</dd></dl>
        <button class="kei-btn sec" onclick="KeieiMembers.openMember('${esc(m.employeeId)}')">確認する</button></div>`).join("");
    const dt = D.date.replace(/-/g, "/");
    main.innerHTML = `<h1 class="kei-title">メンバー実行状況</h1>
      <p class="kei-sub">${esc(dt)}${D.isToday ? "（今日）" : ""}。日報・今日の3つ・明日の3つ・期限超過を、問題のある人から並べています。詳しい処理は、日報・勤怠／全員のタスクで行います。</p>
      ${D.unreadable.length ? `<div data-role="unreadable"><div class="kei-banner warn">一部を読み込めませんでした：${esc(D.unreadable.join("・"))}。その欄は「読めませんでした」「—」と出しています（問題がないという意味ではありません）。</div></div>` : ""}
      <section class="kei-sec" data-block="summary"><h2 class="kei-sec-h"><span class="t">今日の状況</span></h2><div class="km-tiles">${tiles}</div></section>
      <section class="kei-sec" data-block="follow"><h2 class="kei-sec-h"><span class="t">今日の要フォロー</span><span class="kei-count">${D.follow.length}人</span></h2>${follow}</section>
      <section class="kei-sec" data-block="list"><h2 class="kei-sec-h"><span class="t">メンバー</span><span class="kei-count" data-role="count">${rows.length}人</span></h2>
        <div class="km-tools">
          <input type="date" id="km-date" value="${esc(D.date)}" max="${esc(D.today)}" aria-label="日付" onchange="KeieiMembers.setDate(this.value)">
          ${D.departments.length ? `<select id="km-dep" aria-label="部署" onchange="KeieiMembers.filter('dep',this.value)"><option value="">部署：すべて</option>${deps}</select>` : ""}
          <select id="km-status" aria-label="状態" onchange="KeieiMembers.filter('status',this.value)">${opt("status", "", "状態：すべて")}${opt("status", "danger", "要対応")}${opt("status", "warn", "注意")}${opt("status", "good", "良好")}</select>
          <select id="km-nippo" aria-label="日報" onchange="KeieiMembers.filter('nippo',this.value)">${opt("nippo", "", "日報：すべて")}${opt("nippo", "yes", "提出")}${opt("nippo", "no", "未提出")}</select>
          <select id="km-focus" aria-label="今日の3つ" onchange="KeieiMembers.filter('focus',this.value)">${opt("focus", "", "今日の3つ：すべて")}${opt("focus", "done", "完了")}${opt("focus", "open", "未完了")}</select>
          <label class="km-why"><input type="checkbox" ${F.overdue ? "checked" : ""} onchange="KeieiMembers.filter('overdue',this.checked)"> 期限超過あり</label>
          <label class="km-why"><input type="checkbox" ${F.tomorrow ? "checked" : ""} onchange="KeieiMembers.filter('tomorrow',this.checked)"> 明日の3つ未登録</label>
          <input type="search" id="km-q" placeholder="担当者で探す" value="${esc(F.q)}" oninput="KeieiMembers.filter('q',this.value)">
        </div>
        ${D.members.length ? `<div class="km-table-wrap kei-panel" style="padding:0;"><table class="km-t"><thead><tr><th>メンバー</th><th>今日の日報</th><th class="n">今日の3つ</th><th class="n">期限超過</th><th>明日の3つ</th><th>状態</th></tr></thead>
          <tbody>${table || `<tr><td colspan="6" class="km-why">条件に合うメンバーはいません</td></tr>`}</tbody></table></div>
          <div class="km-cards">${cards || `<div class="kei-none">条件に合うメンバーはいません</div>`}</div>`
          : `<div class="kei-none" data-role="empty">対象のメンバーがいません（在籍・退職予定で、ログインできる人が対象です）。</div>`}
        <div class="km-links"><a class="kei-btn sec" href="/admin-nippo.html">日報・勤怠を開く</a><a class="kei-btn sec" href="/admin-tasks.html">全員のタスクを開く</a><a class="kei-btn sec" href="/admin-team.html">チーム状況を開く</a></div>
      </section>`;
  }

  async function load(isStale) {
    main.innerHTML = `<div class="kei-empty">読み込み中…</div>`;
    try {
      const d = await API.api(`/api/keiei?view=members${date ? `&date=${encodeURIComponent(date)}` : ""}`);
      if (isStale && isStale()) return;
      D = d; render();
    } catch (e) {
      if (isStale && isStale()) return;
      if (e.status === 403) { location.replace("/home.html"); return; }
      main.innerHTML = `<h1 class="kei-title">読み込めませんでした</h1><div class="kei-banner err">${esc(e.hint || e.detail || e.message || "エラーが起きました")}</div>`;
    }
  }

  // ---- 1人の詳細（右から。スマホは下から） ----
  const list = (arr, fn, none) => arr == null ? `<p class="km-why">読めませんでした</p>` : arr.length ? `<ul>${arr.map(fn).join("")}</ul>` : `<p class="km-why">${none}</p>`;
  function drawerHtml(x) {
    const m = x.member, n = x.nippo, st = x.stuck, w = x.week;
    const nippo = n == null ? `<p class="km-why">読めませんでした</p>` : !n.submitted ? `<p><span class="km-bad">${D.isToday ? "まだ提出していません" : "未提出"}</span></p>` : `
      ${n.topPriority ? `<p><b>今日の最優先：</b>${esc(n.topPriority)}</p>` : ""}
      ${n.workItems.length ? `<p><b>今日やったこと</b></p><ul>${n.workItems.map((i) => `<li>${esc(i.task)}${i.result ? `：${esc(i.result)}` : i.undone ? `（未完了：${esc(i.undone)}）` : ""}</li>`).join("")}</ul>` : ""}
      ${n.issues.length ? `<p><b>困っていること：</b>${esc(n.issues.join(" / "))}</p>` : ""}
      ${n.consult ? `<p><b>相談：</b>${esc(n.consult)}</p>` : ""}
      ${n.improved ? `<p><b>振り返り：</b>${esc(n.improved)}</p>` : ""}
      ${n.kpi ? `<p><b>KPI：</b>${esc(n.kpi.name || "")} ${n.kpi.target != null ? `目標 ${esc(String(n.kpi.target))}` : ""}${n.kpi.actual != null ? `・実績 ${esc(String(n.kpi.actual))}` : ""}${n.kpi.achieved === true ? "（達成）" : n.kpi.achieved === false ? "（未達）" : ""}</p>` : ""}
      <p class="km-why">日報への返信：${n.replies == null ? "—" : n.replies.admin ? `管理者 ${n.replies.admin}件` : "管理者の返信はまだ"}${n.replies?.ai ? `・AI ${n.replies.ai}件` : ""}</p>`;
    const today = x.today == null ? `<p class="km-why">読めませんでした</p>` : !x.today.length ? `<p class="km-bad">今日の3つが未登録です</p>`
      : x.today.map((t) => `<div class="km-task" data-task="${esc(t.id)}"><b>${t.done ? "✓ " : "○ "}${esc(t.title)}</b>
          <div class="m">${t.done ? "完了" : "未完了"}${t.dueOn ? `・期限 ${esc(t.dueOn.replace(/-/g, "/"))}` : ""}${t.priority ? `・優先度 ${esc(t.priority)}` : ""}${t.carryCount ? `・持ち越し ${t.carryCount}回` : ""}${t.kpi || t.service ? `・${esc([t.kpi, t.service].filter(Boolean).join("／"))}` : ""}<br>
          ${t.purpose ? `目的：${esc(t.purpose)}<br>` : ""}${t.doneCondition ? `完了条件：${esc(t.doneCondition)}` : `<span class="km-bad">完了条件が未入力</span>`}</div></div>`).join("");
    const tm = x.tomorrow;
    const tomorrow = tm == null ? `<p class="km-why">読めませんでした</p>` : `<p>${tm.count ? `${tm.count}件登録・${esc(tm.label)}` : `<span class="km-bad">未登録</span>`}</p>
      <p class="km-why">3件そろっている：${tm.complete ? "はい" : "いいえ"}　AI確認：${tm.aiChecked ? "済み" : "まだ"}　人が確定：${tm.confirmed ? "済み" : "まだ"}</p>
      ${tm.tasks.length ? `<ul>${tm.tasks.map((t) => `<li>${esc(t.title)}</li>`).join("")}</ul>` : ""}`;
    return `<div class="km-dr-in">
      <div class="km-dr-h"><h2>${esc(m.name)}</h2><span class="km-st ${m.status}">${esc(m.statusLabel)}</span><button class="kei-btn sec" onclick="KeieiMembers.close()" aria-label="閉じる">閉じる</button></div>
      ${m.reasons.length ? `<div class="km-box" data-sec="reasons"><h3>気になること</h3><ul>${m.reasons.map((r) => `<li>${esc(r.label)}</li>`).join("")}</ul></div>` : ""}
      <div class="km-box" data-sec="nippo"><h3>① 今日の日報</h3>${nippo}
        <div class="km-links"><a class="kei-btn sec" href="/admin-nippo.html${n?.submitted && D.isToday && x.nippoId ? `#dr-${esc(x.nippoId)}` : ""}">日報を詳しく見る →</a></div></div>
      <div class="km-box" data-sec="today"><h3>② 今日やる3つ</h3>${today}
        <div class="km-links"><a class="kei-btn sec" href="/admin-tasks.html">全員のタスクで見る →</a></div></div>
      <div class="km-box" data-sec="stuck"><h3>③ 止まっているもの</h3>
        <p><b>期限超過</b></p>${list(st.overdue, (t) => `<li>${esc(t.title)}（期限 ${esc(String(t.dueOn).replace(/-/g, "/"))}）</li>`, "ありません")}
        <p><b>ブロッカー</b></p>${list(st.blockers, (b) => `<li>${esc(b.title)}（${esc(String(b.since || "").replace(/-/g, "/"))}から）</li>`, "ありません")}
        <p><b>持ち越し</b></p>${list(st.carried, (t) => `<li>${esc(t.title)}（${t.carryCount}回）</li>`, "ありません")}
        <p><b>完了条件が未入力</b></p>${list(st.noCondition, (t) => `<li>${esc(t.title)}</li>`, "ありません")}
        ${st.aiPending ? `<p class="km-bad">AIの指摘が付いたまま、明日の3つが未確定です</p>` : ""}</div>
      <div class="km-box" data-sec="tomorrow"><h3>④ 明日の3つ</h3>${tomorrow}</div>
      <div class="km-box" data-sec="week"><h3>⑤ 今週の状況</h3>
        <p>日報提出：${w.nippo ? `${w.nippo.submitted}日／未提出 ${w.nippo.missing}日（今日より前の営業日 ${w.nippo.expected}日）` : "読めませんでした"}</p>
        <p>今日の3つの完了率（今週）：${w.focus ? `${w.focus.pct}%（${w.focus.label}）` : "読めませんでした"}</p>
        <p>期限超過：${w.overdue == null ? "読めませんでした" : `${w.overdue}件`}</p></div>
    </div>`;
  }

  async function openMember(id) {
    close();
    const root = document.createElement("div");
    root.id = "km-drawer";
    root.innerHTML = `<div class="km-dr-bg" onclick="KeieiMembers.close()"></div><aside class="km-dr" role="dialog" aria-modal="true" aria-label="メンバーの詳細"><div class="km-dr-in"><div class="kei-empty">読み込み中…</div></div></aside>`;
    document.body.appendChild(root);
    try {
      const r = await API.api(`/api/keiei?view=members&employeeId=${encodeURIComponent(id)}${date ? `&date=${encodeURIComponent(date)}` : ""}`);
      if (!document.getElementById("km-drawer")) return;
      root.querySelector(".km-dr").innerHTML = drawerHtml({ ...r.detail, nippoId: r.detail?.nippoId });
    } catch (e) {
      root.querySelector(".km-dr").innerHTML = `<div class="km-dr-in"><div class="kei-banner err">${esc(e.hint || e.detail || e.message || "読み込めませんでした")}</div>
        <button class="kei-btn sec" onclick="KeieiMembers.close()">閉じる</button></div>`;
    }
  }
  function close() { document.getElementById("km-drawer")?.remove(); }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  window.KeieiMembers = {
    async open(el, isStale) { style(); main = el; await load(isStale); },
    openMember, close,
    filter(k, v) { F[k] = v; if (D) render(); },
    setDate(v) { date = v || null; load(); },
  };
})();
