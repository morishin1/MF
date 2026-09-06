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

  // 自分のパスワードを変える。Supabase Auth を直接呼ぶ（本人のトークンで実行）
  async function changePassword(password) {
    const c = await config();
    const token = await getToken();
    if (!token) throw new Error("未ログインです");
    const r = await fetch(`${c.supabaseUrl}/auth/v1/user`, {
      method: "PUT",
      headers: {
        apikey: c.supabaseAnonKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(data.msg || data.error_description || data.message || "パスワードを変更できませんでした");
    }
    return data;
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
  const createClient = (name, useMf) => api("/api/clients", { method: "POST", body: { name, useMf } }).then((d) => d.client);

  const trialBalance = (clientId, period) =>
    api(`/api/reports/trial-balance?clientId=${encodeURIComponent(clientId)}&period=${encodeURIComponent(period || "")}`);
  const trialBalanceAdvice = (clientId, period) =>
    api("/api/reports/advice", { method: "POST", body: { clientId, period } });

  const reprocessDocument = (documentId) =>
    api("/api/documents/process", { method: "POST", body: { documentId } });

  const documentPreviewUrl = (documentId) =>
    api(`/api/documents/preview?documentId=${encodeURIComponent(documentId)}`);

  // 誤アップロードの取り消し。DB行・Storage実体・Drive上のコピーをまとめて片付ける。
  const deleteDocument = (documentId) =>
    api(`/api/documents?documentId=${encodeURIComponent(documentId)}`, { method: "DELETE" });

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

  // ---- 社内お知らせ ----
  // scope='admin' で下書き・期限切れも含む全件（管理者のみ）
  const listNotices = (scope) =>
    api(`/api/notices${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`);
  const createNotice = (notice) =>
    api("/api/notices", { method: "POST", body: notice }).then((d) => d.notice);
  const updateNotice = (notice) =>
    api("/api/notices", { method: "PATCH", body: notice }).then((d) => d.notice);
  const deleteNotice = (id) =>
    api(`/api/notices?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  const markNoticeRead = (noticeId) =>
    api("/api/notices/read", { method: "POST", body: { noticeId } });

  // ---- 社員名簿 ----
  const listEmployees = () => api("/api/employees");
  // email を渡すとログインアカウントまで作られる。その結果は d.account に入る
  // （初回パスワードはこの応答にしか出てこない）ので、丸ごと返す
  const createEmployee = (employee) =>
    api("/api/employees", { method: "POST", body: employee });
  // 在籍状態を変えると他システムの入口も開け閉めされる。
  // 何が起きたかを画面に出せるよう、d.systems ごと返す
  const updateEmployee = (employee) =>
    api("/api/employees", { method: "PATCH", body: employee });
  const deleteEmployee = (id) =>
    api(`/api/employees?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  // 表計算から貼った複数行をまとめて追加する。行ごとの成否が返る
  const bulkCreateEmployees = (rows, createAccounts = true) =>
    api("/api/employees/bulk", { method: "POST", body: { rows, createAccounts } });

  const setEmployeeRole = (employeeId, role, grant) =>
    api("/api/employees/roles", { method: "POST", body: { employeeId, role, grant } });

  // opts.create=true でアカウントが無ければ作る（招待）。
  // password を省くと自動生成され、その1回だけ応答に含まれる。
  const linkEmployeeAccount = (employeeId, email, clientId, opts = {}) =>
    api("/api/employees/link", { method: "POST", body: { employeeId, email, clientId, ...opts } });

  // ---- 通知 ----
  const listNotifications = () => api("/api/notifications");
  const markNotificationRead = (id) =>
    api("/api/notifications", { method: "PATCH", body: { id } });
  const markAllNotificationsRead = () =>
    api("/api/notifications", { method: "PATCH", body: { all: true } });

  // ---- 管理設定 ----
  const settings = () => api("/api/settings");
  const updateSettings = (patch) =>
    api("/api/settings", { method: "PATCH", body: patch }).then((d) => d.tenant);

  // ---- 貸与品・アカウント台帳 ----
  const listAssets = () => api("/api/assets");
  const createAsset = (asset) =>
    api("/api/assets", { method: "POST", body: asset }).then((d) => d.asset);
  const updateAsset = (asset) =>
    api("/api/assets", { method: "PATCH", body: asset }).then((d) => d.asset);
  const deleteAsset = (id) =>
    api(`/api/assets?id=${encodeURIComponent(id)}`, { method: "DELETE" });

  // ---- スペース（設備）と予約 ----
  const listSpaces = () => api("/api/spaces");
  const createSpace = (s) =>
    api("/api/spaces", { method: "POST", body: s }).then((d) => d.space);
  const updateSpace = (s) =>
    api("/api/spaces", { method: "PATCH", body: s }).then((d) => d.space);
  const deleteSpace = (id) =>
    api(`/api/spaces?id=${encodeURIComponent(id)}`, { method: "DELETE" });

  // scope: "mine" | "pending" | "all"、from/to は ISO 文字列
  const listBookings = (scope = "all", opts = {}) => {
    const q = new URLSearchParams({ scope });
    for (const k of ["from", "to", "spaceId"]) if (opts[k]) q.set(k, opts[k]);
    return api(`/api/bookings?${q.toString()}`);
  };
  const createBooking = (b) => api("/api/bookings", { method: "POST", body: b });
  // action: "approve" | "reject" | "cancel"
  const decideBooking = (id, action, note) =>
    api("/api/bookings", { method: "PATCH", body: { id, action, note } });
  const deleteBooking = (id) =>
    api(`/api/bookings?id=${encodeURIComponent(id)}`, { method: "DELETE" });

  // ---- 自分の予定 ----
  // from/to は ISO 文字列。1画面ぶん（週や月）をまとめて取る
  const schedule = (from, to) =>
    api(`/api/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  // pushToGoogle:true を添えると、保存と同時に本人の Google カレンダーへ入る。
  // 書き出しの結果は d.google に入るので、丸ごと返す
  const createEvent = (ev) => api("/api/schedule", { method: "POST", body: ev });
  const updateEvent = (ev) => api("/api/schedule", { method: "PATCH", body: ev });
  // action: "push"（入れる／直す）| "unpush"（Google側から取り消す）
  const syncEventToGoogle = (id, action = "push") =>
    api("/api/schedule", { method: "POST", body: { action, id } });
  const deleteEvent = (id) =>
    api(`/api/schedule?id=${encodeURIComponent(id)}`, { method: "DELETE" });

  // 自分の Google カレンダーとの連携。トークンは画面には返ってこない
  const googleLink = () => api("/api/google/connect");
  const googleUnlink = () => api("/api/google/connect", { method: "DELETE" });

  // ---- アクセス分析 ----
  const analytics = (opts = {}) => {
    const q = new URLSearchParams({ days: String(opts.days || 7) });
    if (opts.projectId) q.set("projectId", opts.projectId);
    return api(`/api/analytics?${q.toString()}`);
  };
  const syncAnalytics = () => api("/api/analytics/sync", { method: "POST", body: {} });
  const addAnalyticsSite = (site) =>
    api("/api/analytics", { method: "POST", body: site }).then((d) => d.project);
  const updateAnalyticsSite = (site) =>
    api("/api/analytics", { method: "PATCH", body: site }).then((d) => d.project);
  const deleteAnalyticsSite = (id) =>
    api(`/api/analytics?id=${encodeURIComponent(id)}`, { method: "DELETE" });

  // ---- 日報 ----
  const nippo = (date) =>
    api(`/api/nippo${date ? `?date=${encodeURIComponent(date)}` : ""}`);
  const submitNippo = (n) => api("/api/nippo", { method: "POST", body: n });
  const saveWeeklyReview = (w) =>
    api("/api/nippo", { method: "POST", body: { kind: "weekly", ...w } }).then((d) => d.weekly);

  const nippoAdmin = (date, days) => {
    const q = new URLSearchParams();
    if (date) q.set("date", date);
    if (days) q.set("days", String(days));
    return api(`/api/nippo/admin${q.toString() ? `?${q}` : ""}`);
  };
  const nippoAdminAct = (body) => api("/api/nippo/admin", { method: "POST", body });

  // 提出直後にこれを1回叩くと、AIが評価して返す。
  // force:true は管理者だけ（もう一度評価し直す）
  const evaluateNippo = (nippoId, opts = {}) =>
    api("/api/nippo/evaluate", { method: "POST", body: { nippoId, ...opts } });

  // ---- 個人ダッシュボード（今日の最優先・KPI・次にやること） ----
  const dashboard = (opts = {}) => {
    const q = new URLSearchParams();
    if (opts.date) q.set("date", opts.date);
    if (opts.userId) q.set("userId", opts.userId);
    return api(`/api/dashboard${q.toString() ? `?${q}` : ""}`);
  };
  // 本人が入れるのは実績だけ。目標は事前に決めたものを使う
  const saveKpiActuals = (date, actuals) =>
    api("/api/dashboard", { method: "POST", body: { kind: "kpi", action: "actual", date, actuals } });
  const saveKpiTargets = (body) =>
    api("/api/dashboard", { method: "POST", body: { kind: "kpi", action: "target", ...body } });
  const actionItem = (action, body = {}) =>
    api("/api/dashboard", { method: "POST", body: { kind: "action", action, ...body } });

  // ---- 止まっていること（Blocker） ----
  // 外すのは管理職に限らない。手が空いている人が外せるほうが早い
  const listBlockers = (scope, status) => {
    const q = new URLSearchParams();
    if (scope) q.set("scope", scope);
    if (status) q.set("status", status);
    return api(`/api/blockers${q.toString() ? `?${q}` : ""}`);
  };
  const raiseBlocker = (body) =>
    api("/api/blockers", { method: "POST", body: { action: "raise", ...body } });
  const blockerAct = (action, body = {}) =>
    api("/api/blockers", { method: "POST", body: { action, ...body } });

  // ---- 自走レベル ----
  // 上げ下げは人が押す。AIは決めない
  const autonomy = (userId) =>
    api(`/api/autonomy${userId ? `?userId=${encodeURIComponent(userId)}` : ""}`);
  const setAutonomy = (body) =>
    api("/api/autonomy", { method: "POST", body: { action: "set", ...body } });

  // ---- 雇用契約書 ----
  const contracts = (employeeId) =>
    api(`/api/contracts${employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : ""}`);
  const contractsAct = (body) => api("/api/contracts", { method: "POST", body });

  // 契約書を上げて、そのままAIに読ませる。読み取りは draft なので、
  // 人が確認して confirm するまで予定は作られない
  async function uploadContract(employeeId, file) {
    const sign = await contractsAct({
      action: "upload", employeeId,
      filename: file.name, mimeType: file.type || "application/pdf", sizeBytes: file.size,
    });
    const put = await fetch(sign.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream", "x-upsert": "false" },
      body: file,
    });
    if (!put.ok) throw new Error(`アップロードに失敗しました (${put.status})`);
    return contractsAct({
      action: "read", employeeId, path: sign.path,
      filename: file.name, mimeType: file.type || "application/pdf",
    });
  }

  // 試用期間。employeeId を省くと一覧、渡すとその人の各区切り
  const probation = (employeeId) =>
    api(`/api/probation${employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : ""}`);
  // action: compute（集計）/ summarize（AIの所見）/ decide（人が決定）/ settings
  const probationAct = (body) => api("/api/probation", { method: "POST", body });

  // 週次（成果40/行動30/成長20/チーム10 ＝ 100点）。action: evaluate / save / submit
  const nippoWeekly = (userId, weekStart) =>
    api(`/api/nippo/weekly?userId=${encodeURIComponent(userId)}&weekStart=${encodeURIComponent(weekStart)}`);
  const nippoWeeklyAct = (body) => api("/api/nippo/weekly", { method: "POST", body });

  // 月次（成長確認）。userId を省くと自分の分
  const nippoMonthly = (month, userId) => {
    const q = new URLSearchParams({ month });
    if (userId) q.set("userId", userId);
    return api(`/api/nippo/monthly?${q}`);
  };
  const nippoMonthlyAct = (body) => api("/api/nippo/monthly", { method: "POST", body });

  // ---- 口コミサイト流入ブロック（8grp.co.jp） ----
  const listBlocks = () => api("/api/blocks");
  const createBlock = (b) => api("/api/blocks", { method: "POST", body: b }).then((d) => d.referrer);
  const updateBlock = (b) => api("/api/blocks", { method: "PATCH", body: b }).then((d) => d.referrer);
  const deleteBlock = (id) => api(`/api/blocks?id=${encodeURIComponent(id)}`, { method: "DELETE" });

  // ---- 社内文書（マニュアル・規定・様式） ----
  const listLibrary = () => api("/api/library");
  const createLibraryDoc = (d) =>
    api("/api/library", { method: "POST", body: d }).then((r) => r.document);
  const updateLibraryDoc = (d) =>
    api("/api/library", { method: "PATCH", body: d }).then((r) => r.document);
  const deleteLibraryDoc = (id) =>
    api(`/api/library?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  const libraryFileUrl = (path) =>
    api(`/api/library?path=${encodeURIComponent(path)}`);

  async function uploadLibraryFile(file) {
    const sign = await api("/api/library?sign=1", {
      method: "POST",
      body: { filename: file.name, sizeBytes: file.size },
    });
    const put = await fetch(sign.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream", "x-upsert": "false" },
      body: file,
    });
    if (!put.ok) throw new Error(`アップロードに失敗しました (${put.status})`);
    return { path: sign.path, name: file.name, mimeType: file.type, sizeBytes: file.size };
  }

  // ---- 有給・稟議の申請 ----
  // scope: "mine" | "pending" | "all"、kind: "leave" | "ringi"
  const listRequests = (scope, opts = {}) => {
    const q = new URLSearchParams();
    if (scope) q.set("scope", scope);
    for (const k of ["kind", "year"]) if (opts[k]) q.set(k, opts[k]);
    return api(`/api/requests?${q.toString()}`);
  };
  const createRequest = (r) => api("/api/requests", { method: "POST", body: r });
  // action: "approve" | "reject" | "cancel"
  const decideRequest = (id, action, note) =>
    api("/api/requests/decide", { method: "POST", body: { id, action, note } });
  const deleteRequest = (id) =>
    api(`/api/requests?id=${encodeURIComponent(id)}`, { method: "DELETE" });

  const leaveGrants = (year) =>
    api(`/api/requests/grants${year ? `?year=${encodeURIComponent(year)}` : ""}`);
  const saveLeaveGrant = (grant) =>
    api("/api/requests/grants", { method: "PUT", body: grant });

  // ---- 経費精算 ----
  // scope: "mine" | "pending" | "all"
  const listExpenses = (scope, opts = {}) => {
    const q = new URLSearchParams();
    if (scope) q.set("scope", scope);
    for (const k of ["period", "status"]) if (opts[k]) q.set(k, opts[k]);
    return api(`/api/expenses?${q.toString()}`);
  };
  const createExpense = (report) => api("/api/expenses", { method: "POST", body: report });
  // action: "approve" | "reject" | "cancel" | "pay"
  const decideExpense = (id, action, note) =>
    api("/api/expenses/decide", { method: "POST", body: { id, action, note } });
  const deleteExpense = (id) =>
    api(`/api/expenses?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  const updateWorkflowSettings = (patch) =>
    api("/api/expenses/settings", { method: "PATCH", body: patch }).then((d) => d.settings);

  // 領収書。申請を作る前に上げて、返ってきた path を明細に付ける
  async function uploadReceipt(file) {
    const sign = await api("/api/expenses/upload", {
      method: "POST",
      body: { filename: file.name, mimeType: file.type, sizeBytes: file.size },
    });
    const put = await fetch(sign.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type, "x-upsert": "false" },
      body: file,
    });
    if (!put.ok) throw new Error(`アップロードに失敗しました (${put.status})`);
    return { path: sign.path, name: file.name };
  }
  const receiptUrl = (path) =>
    api(`/api/expenses/upload?path=${encodeURIComponent(path)}`);

  // CSVは署名付きURLではなく認証ヘッダで取るので、Blob にしてから保存する
  async function downloadExpenseCsv(opts = {}) {
    const q = new URLSearchParams({ format: "csv", scope: "all" });
    for (const k of ["period", "status"]) if (opts[k]) q.set(k, opts[k]);
    const token = await getToken();
    if (!token) throw new Error("未ログインです");
    const r = await fetch(`/api/expenses?${q.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error("CSVを取得できませんでした");
    return r.blob();
  }

  // ---- 書類の雛形 ----
  const listTemplates = () => api("/api/templates");
  const createTemplate = (t) =>
    api("/api/templates", { method: "POST", body: t }).then((d) => d.template);
  const updateTemplate = (t) =>
    api("/api/templates", { method: "PATCH", body: t }).then((d) => d.template);
  const deleteTemplate = (id) =>
    api(`/api/templates?id=${encodeURIComponent(id)}`, { method: "DELETE" });

  // ---- メッセージ ----
  const listThreads = () => api("/api/messages");
  const createThread = (kind, memberIds, title) =>
    api("/api/messages", { method: "POST", body: { kind, memberIds, title } });
  const getThread = (threadId) =>
    api(`/api/messages/thread?threadId=${encodeURIComponent(threadId)}`);
  const sendMessage = (threadId, body, fileId) =>
    api("/api/messages/thread", { method: "POST", body: { threadId, body, fileId } }).then((d) => d.message);

  const messageFileUrl = (fileId) =>
    api(`/api/messages/upload?fileId=${encodeURIComponent(fileId)}`);

  // 添付を先に預けて fileId を得る。そのあと sendMessage に渡すと本文に付く
  async function uploadMessageFile(threadId, file) {
    const mimeType = guessMime(file);
    if (!mimeType) throw new Error("対応していないファイル形式です");

    const signed = await api("/api/messages/upload", {
      method: "POST",
      body: { threadId, filename: file.name, mimeType, sizeBytes: file.size },
    });
    const put = await fetch(signed.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType, "x-upsert": "true" },
      body: file,
    });
    if (!put.ok) throw new Error(`アップロードに失敗しました (${put.status})`);
    return signed.fileId;
  }
  const markThreadRead = (threadId) =>
    api("/api/messages/thread", { method: "PATCH", body: { threadId } });

  // ---- やること（タスク・予定） ----
  // scope='mine' で自分の担当分だけ
  const listTasks = (scope) =>
    api(`/api/tasks${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`);
  const createTask = (task) =>
    api("/api/tasks", { method: "POST", body: task }).then((d) => d.task);
  const updateTask = (task) =>
    api("/api/tasks", { method: "PATCH", body: task }).then((d) => d.task);
  const deleteTask = (id) =>
    api(`/api/tasks?id=${encodeURIComponent(id)}`, { method: "DELETE" });

  // ---- 入社・退職手続き ----
  const listProcedures = () => api("/api/onboarding");
  const createProcedure = (p) =>
    api("/api/onboarding", { method: "POST", body: p }).then((d) => d.procedure);
  const updateProcedure = (p) =>
    api("/api/onboarding", { method: "PATCH", body: p }).then((d) => d.procedure);
  const deleteProcedure = (id) =>
    api(`/api/onboarding?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  const addProcedureItem = (item) =>
    api("/api/onboarding/items", { method: "POST", body: item }).then((d) => d.item);
  const updateProcedureItem = (item) =>
    api("/api/onboarding/items", { method: "PATCH", body: item }).then((d) => d.item);
  const deleteProcedureItem = (id) =>
    api(`/api/onboarding/items?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  // 本人が「提出しました」を付ける。undo:true で取り消し
  const submitProcedureItem = (itemId, opts = {}) =>
    api("/api/onboarding/submit", { method: "POST", body: { itemId, ...opts } });

  // 提出ファイルの閲覧用URL（短時間だけ有効）
  const procedureFileUrl = (fileId) =>
    api(`/api/onboarding/upload?fileId=${encodeURIComponent(fileId)}`);

  // 提出ファイルのアップロード。署名URLへ直接PUTしたあと確定させる。
  // 証憑（documents）とは別のバケットに入るので、会計側の仕訳は動かない。
  async function uploadProcedureFile(itemId, file, onStep = () => {}) {
    const mimeType = guessMime(file);
    if (!mimeType) throw new Error("対応していないファイル形式です");

    onStep("uploading");
    const signed = await api("/api/onboarding/upload", {
      method: "POST",
      body: { itemId, filename: file.name, mimeType, sizeBytes: file.size },
    });

    const put = await fetch(signed.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType, "x-upsert": "true" },
      body: file,
    });
    if (!put.ok) throw new Error(`アップロードに失敗しました (${put.status})`);

    onStep("saving");
    const out = await api("/api/onboarding/upload", {
      method: "PATCH",
      body: { fileId: signed.fileId },
    });
    onStep("done");
    return out;
  }

  // ---- Google Drive 連携 ----
  const driveStatus = (clientId) => api(`/api/drive/status?clientId=${encodeURIComponent(clientId)}`);
  const driveSync = (clientId, limit) => api("/api/drive/sync", { method: "POST", body: { clientId, limit } });

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
    config, login, logout, refresh, getToken, changePassword,
    isLoggedIn, currentEmail,
    api, me, listClients, createClient, listJournals, listDocuments,
    approveJournal, uploadAndRecognize, uploadAndProcess, reprocessDocument, documentPreviewUrl,
    deleteDocument,
    mfStatus, mfConnectUrl, trialBalance, trialBalanceAdvice,
    driveStatus, driveSync,
    listNotices, createNotice, updateNotice, deleteNotice, markNoticeRead,
    listEmployees, createEmployee, updateEmployee, deleteEmployee, bulkCreateEmployees,
    setEmployeeRole, linkEmployeeAccount,
    settings, updateSettings,
    listNotifications, markNotificationRead, markAllNotificationsRead,
    listAssets, createAsset, updateAsset, deleteAsset,
    listSpaces, createSpace, updateSpace, deleteSpace,
    listBookings, createBooking, decideBooking, deleteBooking,
    schedule, createEvent, updateEvent, deleteEvent, syncEventToGoogle, googleLink, googleUnlink,
    analytics, syncAnalytics, addAnalyticsSite, updateAnalyticsSite, deleteAnalyticsSite,
    nippo, submitNippo, saveWeeklyReview, nippoAdmin, nippoAdminAct, evaluateNippo,
    dashboard, saveKpiActuals, saveKpiTargets, actionItem,
    listBlockers, raiseBlocker, blockerAct, autonomy, setAutonomy,
    nippoWeekly, nippoWeeklyAct, nippoMonthly, nippoMonthlyAct,
    probation, probationAct,
    contracts, contractsAct, uploadContract,
    listBlocks, createBlock, updateBlock, deleteBlock,
    listLibrary, createLibraryDoc, updateLibraryDoc, deleteLibraryDoc,
    libraryFileUrl, uploadLibraryFile,
    listRequests, createRequest, decideRequest, deleteRequest,
    leaveGrants, saveLeaveGrant,
    listExpenses, createExpense, decideExpense, deleteExpense,
    updateWorkflowSettings, uploadReceipt, receiptUrl, downloadExpenseCsv,
    listTemplates, createTemplate, updateTemplate, deleteTemplate,
    listTasks, createTask, updateTask, deleteTask,
    listThreads, createThread, getThread, sendMessage, markThreadRead,
    uploadMessageFile, messageFileUrl,
    listProcedures, createProcedure, updateProcedure, deleteProcedure,
    addProcedureItem, updateProcedureItem, deleteProcedureItem, submitProcedureItem,
    uploadProcedureFile, procedureFileUrl,
  };
})();
