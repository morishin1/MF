// api-client.js
// SaaS 実API用のブラウザクライアント。
// Supabase Auth(REST) でログインして JWT を取得し、/api/* を Bearer 認証で呼ぶ。
// 外部JSに依存しない（fetch のみ）。window.API として公開。
//
// フロー: config() → login() → uploadAndRecognize() / listJournals() / approveJournal()

(function () {
  const LS_KEY = "kp_session";
  let cfg = null;

  // ---- 公開設定 --------------------------------------------------------
  async function config() {
    if (cfg) return cfg;
    const r = await fetch("/api/public-config", { cache: "no-store" });
    if (!r.ok) throw new Error("public-config の取得に失敗しました");
    cfg = await r.json();
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      throw new Error("Supabase の公開設定が未構成です（環境変数 SUPABASE_URL / SUPABASE_ANON_KEY）");
    }
    return cfg;
  }

  // ---- セッション保管 --------------------------------------------------
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { return null; }
  }
  function saveSession(s) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }
  function clearSession() { localStorage.removeItem(LS_KEY); }

  function storeToken(data) {
    const sess = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || (Math.floor(Date.now() / 1000) + (data.expires_in || 3600)),
      email: data.user?.email || loadSession()?.email || null,
    };
    saveSession(sess);
    return sess;
  }

  // ---- 認証 ------------------------------------------------------------
  async function login(email, password) {
    const c = await config();
    const r = await fetch(`${c.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: c.supabaseAnonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error_description || data.msg || data.error || "ログインに失敗しました");
    return storeToken({ ...data, user: { email } });
  }

  async function refresh() {
    const c = await config();
    const sess = loadSession();
    if (!sess?.refresh_token) throw new Error("セッションがありません");
    const r = await fetch(`${c.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: c.supabaseAnonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: sess.refresh_token }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { clearSession(); throw new Error("セッションの更新に失敗しました。再ログインしてください"); }
    return storeToken(data);
  }

  async function getToken() {
    let sess = loadSession();
    if (!sess) return null;
    const now = Math.floor(Date.now() / 1000);
    if (sess.expires_at && sess.expires_at - 30 <= now) {
      sess = await refresh();
    }
    return sess.access_token;
  }

  function isLoggedIn() { return !!loadSession(); }
  function currentEmail() { return loadSession()?.email || null; }
  function logout() { clearSession(); }

  // ---- API 呼び出し ----------------------------------------------------
  async function api(path, { method = "GET", body } = {}) {
    const token = await getToken();
    if (!token) throw new Error("未ログインです");
    const r = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || `APIエラー (${r.status})`);
      err.status = r.status;
      err.detail = data.detail;
      throw err;
    }
    return data;
  }

  // 拡張子から MIME を補完（ブラウザが file.type を空で返す場合の保険）
  function guessMime(file) {
    if (file.type) return file.type;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const map = {
      pdf: "application/pdf",
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xls: "application/vnd.ms-excel", csv: "text/csv",
    };
    return map[ext] || "";
  }

  // ---- 高水準API -------------------------------------------------------
  const me = () => api("/api/me");

  const listClients = () => api("/api/clients").then((d) => d.clients || []);

  const reprocessDocument = (documentId) =>
    api("/api/documents/process", { method: "POST", body: { documentId } });

  const documentPreviewUrl = (documentId) =>
    api(`/api/documents/preview?documentId=${encodeURIComponent(documentId)}`);

  const listDocuments = (clientId, { period, docType, status } = {}) => {
    const q = new URLSearchParams();
    if (clientId) q.set("clientId", clientId);
    if (period) q.set("period", period);
    if (docType) q.set("docType", docType);
    if (status) q.set("status", status);
    return api(`/api/documents?${q.toString()}`).then((d) => d.documents || []);
  };

  const listJournals = (clientId, status) => {
    const q = new URLSearchParams();
    if (clientId) q.set("clientId", clientId);
    if (status) q.set("status", status);
    return api(`/api/journals?${q.toString()}`).then((d) => d.journals || []);
  };

  const approveJournal = (journalId) =>
    api("/api/journals/approve", { method: "POST", body: { journalId } });

  // ---- MF連携 ----
  const mfStatus = (clientId) => api(`/api/mf/status?clientId=${encodeURIComponent(clientId)}`);
  const mfConnectUrl = (clientId) =>
    api(`/api/mf/oauth/start?clientId=${encodeURIComponent(clientId)}`).then((d) => d.authorizeUrl);

  // アップロード → 署名URLへPUT → AI仕訳、の一連。onStep(phase) で進捗通知。
  async function uploadAndRecognize(clientId, file, onStep = () => {}) {
    const mimeType = guessMime(file);
    if (!mimeType) throw new Error("対応していないファイル形式です");

    onStep("uploading");
    const signed = await api("/api/documents/upload-url", {
      method: "POST",
      body: { clientId, filename: file.name, mimeType, sizeBytes: file.size },
    });

    const put = await fetch(signed.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType, "x-upsert": "true" },
      body: file,
    });
    if (!put.ok) throw new Error(`アップロードに失敗しました (${put.status})`);

    onStep("recognizing");
    const rec = await api("/api/documents/recognize", {
      method: "POST",
      body: { documentId: signed.documentId },
    });
    onStep("done");
    return rec; // { document, journal }
  }

  // アップロード → 署名URLへPUT → AI種別判定(＋会計なら仕訳ドラフト)。onStep(phase) で進捗通知。
  async function uploadAndProcess(clientId, file, onStep = () => {}) {
    const mimeType = guessMime(file);
    if (!mimeType) throw new Error("対応していないファイル形式です");

    onStep("uploading");
    const signed = await api("/api/documents/upload-url", {
      method: "POST",
      body: { clientId, filename: file.name, mimeType, sizeBytes: file.size },
    });

    const put = await fetch(signed.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType, "x-upsert": "true" },
      body: file,
    });
    if (!put.ok) throw new Error(`アップロードに失敗しました (${put.status})`);

    onStep("recognizing");
    const out = await api("/api/documents/process", {
      method: "POST",
      body: { documentId: signed.documentId },
    });
    onStep("done");
    return out; // { document, journal? }
  }

  window.API = {
    config, login, logout, refresh, getToken,
    isLoggedIn, currentEmail,
    api, me, listClients, listJournals, listDocuments,
    approveJournal, uploadAndRecognize, uploadAndProcess, reprocessDocument, documentPreviewUrl,
    mfStatus, mfConnectUrl,
  };
})();
