(function () {
  "use strict";
  const KEY = "eight_company_portal_session";
  const LOGIN = "/company-portal/login.html";
  const HOME = "/company-portal/index.html";
  const $ = (id) => document.getElementById(id);
  const page = document.body.dataset.page;
  let currentCompany = null;
  let currentProposal = null;
  let currentAction = null;

  function session() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); }
    catch { return null; }
  }
  function saveSession(data) {
    sessionStorage.setItem(KEY, JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    }));
  }
  function clearSession() { sessionStorage.removeItem(KEY); }
  function notice(node, content, state) {
    if (!node) return;
    node.textContent = content;
    node.className = content ? (state === "error" ? "cp-alert" : state === "ok" ? "cp-ok" : "cp-muted") : "";
  }
  async function settings() {
    const response = await fetch("/api/public-config", { cache: "no-store" });
    if (!response.ok) throw new Error("ログイン設定を取得できませんでした");
    const c = await response.json();
    if (!/^https:\/\//.test(c.supabaseUrl || "") || !c.supabaseAnonKey)
      throw new Error("ログイン設定が未構成です");
    return c;
  }
  async function signIn(email, password) {
    const c = await settings();
    const response = await fetch(c.supabaseUrl + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { apikey: c.supabaseAnonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Error("メールアドレスまたはパスワードをご確認ください");
    saveSession(data);
  }
  async function refreshToken() {
    const s = session();
    if (!s || !s.refresh_token) throw new Error("ログインが必要です");
    const c = await settings();
    const response = await fetch(c.supabaseUrl + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { apikey: c.supabaseAnonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (!response.ok) { clearSession(); throw new Error("ログインの有効期限が切れました"); }
    const data = await response.json();
    saveSession(data);
    return data.access_token;
  }
  async function api(path, method, data, retry) {
    const s = session();
    if (!s?.access_token) throw new Error("ログインが必要です");
    const token = s.expires_at < Math.floor(Date.now() / 1000) + 30 ? await refreshToken() : s.access_token;
    const response = await fetch(path, {
      method: method || "GET",
      cache: "no-store",
      headers: { Authorization: "Bearer " + token, ...(data ? { "Content-Type": "application/json" } : {}) },
      body: data ? JSON.stringify(data) : undefined,
    });
    if (response.status === 401 && !retry) {
      await refreshToken();
      return api(path, method, data, true);
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.message || (response.status === 403 ? "このページの利用権限がありません。エイト担当者にご連絡ください。" : "処理に失敗しました"));
      error.status = response.status;
      throw error;
    }
    return result;
  }
  function safeLink(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.href : null;
    } catch { return null; }
  }
  function create(tag, value, className) {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    if (className) node.className = className;
    return node;
  }
  function answerButton(label, choice, item) {
    const button = create("button", label, "cp-btn small" + (choice === "meeting" ? " primary" : ""));
    button.type = "button";
    button.addEventListener("click", () => {
      currentProposal = item;
      currentAction = choice;
      $("responseTitle").textContent = label;
      $("responseTarget").textContent = item.title;
      $("message").value = "";
      notice($("responseMessage"), "");
      $("responseDialog").showModal();
    });
    return button;
  }
  function proposalCard(item) {
    const card = create("article", undefined, "cp-card");
    const top = create("div", undefined, "cp-topline");
    top.append(create("span", "ご提案", "cp-eyebrow"), create("span", "ご案内中", "cp-pill"));
    card.append(top, create("h2", item.title));
    if (item.summary) card.append(create("p", item.summary, "cp-note"));
    const docUrl = safeLink(item.documentUrl);
    if (docUrl) {
      const link = create("a", "資料を確認する", "cp-btn small");
      link.href = docUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.append(link);
    }
    if (item.lastResponse) {
      const labels = { interested: "興味あり", details: "詳細希望", meeting: "面談希望" };
      card.append(create("p", "回答済み：" + (labels[item.lastResponse.action] || "回答"), "cp-response"));
    }
    const buttons = create("div", undefined, "cp-actions");
    buttons.append(
      answerButton("興味あり", "interested", item),
      answerButton("詳しく聞きたい", "details", item),
      answerButton("面談を希望", "meeting", item)
    );
    card.append(buttons);
    return card;
  }
  async function renderDashboard() {
    if (!session()) { location.replace(LOGIN); return; }
    notice($("appMessage"), "商談情報を確認しています…");
    try {
      const data = await api("/api/company-portal");
      currentCompany = data.company?.id || null;
      $("greeting").textContent = (data.company?.name || "企業") + " 様";
      notice($("appMessage"), "");
      if (data.needsPasswordChange) {
        $("changePasswordPanel").hidden = false;
        $("companyContent").hidden = true;
        return;
      }
      $("changePasswordPanel").hidden = true;
      $("companyContent").hidden = false;
      const proposals = data.proposals || [];
      $("proposalCount").textContent = proposals.length + "件";
      $("proposals").replaceChildren(...proposals.map(proposalCard));
      $("empty").hidden = proposals.length > 0;
      const link = $("meetingLink");
      link.hidden = true;
      if (data.meeting?.scheduled_at) {
        $("meetingTitle").textContent = "商談日程が決まりました";
        $("meetingInfo").textContent = new Intl.DateTimeFormat("ja-JP", {
          dateStyle: "long", timeStyle: "short", timeZone: "Asia/Tokyo",
        }).format(new Date(data.meeting.scheduled_at));
        const href = safeLink(data.meeting.meeting_url);
        if (href) { link.href = href; link.hidden = false; }
      } else {
        $("meetingTitle").textContent = "商談のご相談を受付中";
        $("meetingInfo").textContent = "面談をご希望の場合、下の提案から「面談を希望」を選択してください。";
      }
    } catch (error) {
      if (error.status === 401) { clearSession(); location.replace(LOGIN); return; }
      $("companyContent").hidden = true;
      notice($("appMessage"), error.message, "error");
    }
  }
  async function startLogin() {
    if (session()) {
      try { await api("/api/company-portal"); location.replace(HOME); return; }
      catch (error) { if (error.status === 403 || error.status === 401) clearSession(); }
    }
    $("loginForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      $("loginButton").disabled = true;
      notice($("loginMessage"), "確認しています…");
      try {
        await signIn($("email").value.trim(), $("password").value);
        await api("/api/company-portal");
        location.replace(HOME);
      } catch (error) {
        if (error.status === 403 || error.status === 401) clearSession();
        notice($("loginMessage"), error.message, "error");
        $("loginButton").disabled = false;
      }
    });
  }
  async function startDashboard() {
    $("logout").addEventListener("click", () => {
      const s = session();
      clearSession();
      if (s?.access_token) {
        settings().then((c) => fetch(c.supabaseUrl + "/auth/v1/logout", {
          method: "POST",
          headers: { apikey: c.supabaseAnonKey, Authorization: "Bearer " + s.access_token },
        })).catch(() => {});
      }
      location.replace(LOGIN);
    });
    $("closeDialog").addEventListener("click", () => $("responseDialog").close());
    $("responseForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!currentProposal || !currentCompany) return;
      const button = $("sendResponse");
      button.disabled = true;
      notice($("responseMessage"), "送信しています…");
      try {
        // action はAPI操作名、responseAction は企業からの回答の種別。
        const result = await api("/api/company-portal", "POST", {
          action: "feedback",
          responseAction: currentAction,
          companyId: currentCompany,
          proposalId: currentProposal.id,
          requestId: crypto.randomUUID(),
          message: $("message").value.trim(),
        });
        notice($("responseMessage"),
          result.salesSynced === false
            ? "受付しました。エイト担当者への反映を確認中です。"
            : "送信しました。エイト担当者にご希望が届きます。", "ok");
        await renderDashboard();
        setTimeout(() => $("responseDialog").close(), 1100);
      } catch (error) {
        notice($("responseMessage"), error.message, "error");
      } finally {
        button.disabled = false;
      }
    });
    $("changePasswordForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const next = $("newPassword").value;
      if (next !== $("confirmPassword").value) {
        notice($("appMessage"), "確認用パスワードが一致しません", "error");
        return;
      }
      $("changePasswordButton").disabled = true;
      try {
        await api("/api/company-portal", "POST", {
          action: "change_password", companyId: currentCompany, password: next,
        });
        await renderDashboard();
        notice($("appMessage"), "パスワードを変更しました", "ok");
      } catch (error) {
        notice($("appMessage"), error.message, "error");
      } finally {
        $("changePasswordButton").disabled = false;
      }
    });
    await renderDashboard();
  }
  if (page === "login") startLogin();
  if (page === "dashboard") startDashboard();
})();
