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
  //
  // ■ 画面を開くたびに取りにいかない
  //
  //   中身は環境変数そのままで、人によって変わらないし、
  //   デプロイしないと変わらない。なのに no-store で毎回取りにいっていた。
  //   1画面ぶんで1往復。回線が細いほど、そのまま「読み込み中…」が伸びる。
  //
  //   覚えておいて、すぐ返す。正しいかどうかは裏で確かめる。
  //   古いまま動き続けないよう、覚えておくのは短いあいだだけにする。
  const CFG_KEY = "kp_cfg";
  const CFG_HOURS = 6;
  // 覚えているものが、これより新しければ裏でも取り直さない。
  // 毎画面で裏の1往復（/api/public-config）が出ていた。中身はデプロイしないと変わらない
  const CFG_RECHECK_MIN = 30;

  function applyCfg(c) {
    // 拡張のIDは、画面から拡張へ話しかけるのに要る（js/device.js）。
    // 設定を読んだ時点で1回だけ置く
    if (c?.extensionId) window.KP_EXT_ID = c.extensionId;
    return c;
  }

  async function fetchCfg() {
    const r = await fetch("/api/public-config");
    if (!r.ok) throw new Error("public-config の取得に失敗しました");
    const c = await r.json();
    if (!c.supabaseUrl || !c.supabaseAnonKey) {
      throw new Error("Supabase の公開設定が未構成です（環境変数 SUPABASE_URL / SUPABASE_ANON_KEY）");
    }
    cfg = applyCfg(c);
    try { localStorage.setItem(CFG_KEY, JSON.stringify({ at: Date.now(), v: c })); }
    catch { /* 保存できなくても動く */ }
    return cfg;
  }

  async function config() {
    if (cfg) return cfg;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(CFG_KEY) || "null"); } catch { /* 無視 */ }
    if (saved?.v?.supabaseUrl && Date.now() - (saved.at || 0) < CFG_HOURS * 3600000) {
      cfg = applyCfg(saved.v);
      // 待たない。次に開くときには新しいほうが入っている。
      // 30分以内に確かめたものは、取り直さない（画面を移るたびに裏で1往復しない）
      if (Date.now() - (saved.at || 0) >= CFG_RECHECK_MIN * 60000) {
        fetchCfg().catch(() => { /* 取れなくても、覚えているぶんで動く */ });
      }
      return cfg;
    }
    return fetchCfg();
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
    // 前にこのタブを使っていた人の画面データ・身元を残さない
    forgetUser();
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

  // ---- 二段階認証（TOTP）---------------------------------------------------
  //
  // Supabase Auth の MFA をそのまま使う。秘密は自前で持たない。
  //   登録: enroll → QR を認証アプリで読む → verify（6桁）
  //   ログイン: パスワードで aal1 → verify で aal2 のトークンに変わる
  //
  // ■ Supabase を画面から直接叩かない
  //   登録・解除・リセット・再登録は、記録に残す必要がある（gw_activity_log）。
  //   画面から直接だと、外したことがどこにも残らない。だから /api/mfa を通す
  //   （確認の6桁も、サーバで突き合わせる）
  const mfaStatus = () => api("/api/mfa");
  /** 登録済みの要素。verified のものだけが有効 */
  const mfaFactors = async () => {
    const st = await api("/api/mfa");
    return st.factors || [];
  };
  /** 登録を始める。QR（データURL）と秘密の文字列が返る */
  const mfaEnroll = () => api("/api/mfa", { method: "POST", body: { action: "enroll" } });
  /** 6桁を確かめる。通るとトークンが aal2 に変わるので、覚え直す */
  const mfaVerify = async (factorId, code) => {
    const r = await api("/api/mfa", {
      method: "POST", body: { action: "verify", factorId, code: String(code).trim() },
    });
    if (r.session?.access_token) storeToken(r.session);
    return r;
  };
  const mfaUnenroll = (factorId) =>
    api("/api/mfa", { method: "POST", body: { action: "unenroll", factorId } });
  /** 管理者が外す。本人は登録し直す */
  const mfaReset = (employeeId, note) =>
    api("/api/mfa", { method: "POST", body: { action: "reset", employeeId, note } });

  // サーバが db_query_failed のような技術的なコードだけを返し、hint/messageを
  // 付け忘れたときのための最後の砦。detail（生のPostgresエラー文言）を
  // そのまま画面に出さない（採用HR Stage 10：エラー表示の整理）
  const FRIENDLY_FALLBACK = "処理に失敗しました。時間をおいてもう一度お試しください。";
  const isRawTechnicalCode = (code) => typeof code === "string" && /^db_/.test(code);

  function isLoggedIn() { return !!loadSession(); }
  function currentEmail() { return loadSession()?.email || null; }
  // ログアウトでは、このタブ・この端末に覚えている「その人のもの」を全部消す。
  // 画面データ（sessionStorage の kp_swr:*）・身元（kp_me）・メニューの枠（kp_layout）。
  // どのログアウトボタン（GW・HR・Sales・Office・経営）から出ても、ここを通る
  function logout() { clearSession(); forgetUser(); }
  function forgetUser() {
    swrClear();
    try { localStorage.removeItem(ME_KEY); localStorage.removeItem("kp_layout"); } catch { /* 使えない */ }
  }

  // ---- 身元（/api/me）を覚えておく -------------------------------------------------
  //
  // 前回の /api/me の答えを覚えておき、次の画面では待たずに枠を描く（確かめるのは裏で）。
  // GW（js/layout.js）のほか、HR・Sales・Office・経営の専用ヘッダーも同じものを使う。
  // それらは毎回 /api/me を待ってからヘッダーと本文を出していたので、2回目でも1往復遅れていた。
  //
  // ■ 覚えておくのは短いあいだだけ（12時間）。毎回かならず裏で確かめる
  // ■ 誰のぶんかを必ず見る。覚えていた人と、いま入っている人が違えば使わない
  //   （ログアウトのときは消しているが、前の人のセッションが切れたところへ
  //     別の人がそのまま入ると、消さずに入れ替わる道がある）
  const ME_KEY = "kp_me";
  const ME_HOURS = 12;
  function rememberedMe() {
    try {
      const v = JSON.parse(localStorage.getItem(ME_KEY) || "null");
      if (!v?.me || Date.now() - (v.at || 0) > ME_HOURS * 3600000) return null;
      if (v.email && v.email !== currentEmail()) return null;
      return v.me;
    } catch { return null; }
  }
  function rememberMe(me) {
    try { localStorage.setItem(ME_KEY, JSON.stringify({ at: Date.now(), email: currentEmail(), me })); }
    catch { /* 保存できなくても動く */ }
  }
  /**
   * 専用ヘッダー（HR・Sales・Office・経営）の入口。
   * 覚えている身元で入れるなら、それで先に描いて返し、確かめるのは裏で（違えば送り返す）。
   * 覚えていない・覚えている身元では入れないときは、/api/me を待ってから決める（これまでどおり）。
   * @param {(me:object) => boolean} canEnter その画面に入れるか（覚えている身元・確かめた身元の両方で使う）
   * @param {{leave:(me:object)=>void, lost:()=>void}} go
   *   leave … 確かめた身元では入れなかった（ホームなどへ送る）
   *   lost  … ログインが切れていた（ログイン画面へ送る）
   * @returns {Promise<{me:object, remembered:boolean}|null>}
   */
  async function enterWithMe(canEnter, { leave, lost, verify = false }) {
    // verify … 覚えている身元では入らない（短い時間で見られる URL を発行するような画面。確かめてから）
    const cached = verify ? null : rememberedMe();
    const check = me().then((m) => { rememberMe(m); return m; });
    if (cached && canEnter(cached)) {
      check.then((m) => { if (!canEnter(m)) leave(m); }).catch((e) => {
        // 裏の確認がたまたま通らなかっただけ（回線）なら、見ている画面から追い出さない。
        // ログインが切れていたときだけ、ログイン画面へ
        if (e?.status === 401 || !isLoggedIn()) lost();
      });
      perfMark("init");
      return { me: cached, remembered: true };
    }
    let fresh;
    try { fresh = await check; } catch { lost(); return null; }
    if (!canEnter(fresh)) { leave(fresh); return null; }
    perfMark("init");
    return { me: fresh, remembered: false };
  }

  // ---- ログイン前でも呼べる口（招待URLを開いた時点では、まだセッションが無い） ----
  async function publicApi(path, { method = "GET", body } = {}) {
    const r = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.hint || data.message || data.error || `APIエラー (${r.status})`);
      err.status = r.status; err.code = data.error || null;
      err.hint = data.hint || data.message || (isRawTechnicalCode(err.code) ? FRIENDLY_FALLBACK : null);
      err.detail = data.detail;
      throw err;
    }
    return data;
  }
  const guestInvitePreview = (token) =>
    publicApi(`/api/guests/accept?token=${encodeURIComponent(token)}`);
  const guestRegister = (token, password) =>
    publicApi("/api/guests/accept", { method: "POST", body: { token, password } });

  // ---- API 呼び出し ----------------------------------------------------
  //
  // ■ 更新したら、覚えている画面データを捨てる（下の「画面データの短期キャッシュ」）
  //   GET 以外（POST・PATCH・PUT・DELETE）が終わったら、成功しても失敗しても全部捨てる。
  //   どの更新がどの一覧に効くかを画面ごとに書き分けると、書き忘れた所で古い数字が残る。
  //   捨てすぎても、次に開いたときに1往復待つだけで、間違った数字は出ない。
  //   invalidates を渡したものだけは、その鍵だけ捨てる（通知の既読・端末の合図のように、
  //   画面のデータを変えない更新）。[] なら何も捨てない
  async function api(path, { method = "GET", body, invalidates } = {}) {
    if (method === "GET") return request(path, { method, body });
    try {
      return await request(path, { method, body });
    } finally {
      if (Array.isArray(invalidates)) for (const k of invalidates) swrDrop(k);
      else swrClear();
    }
  }

  async function request(path, { method = "GET", body } = {}) {
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
      // hint は「人が読んで直せる説明」、detail は原因の生の文言。
      // 画面はどこも `e.hint || e.detail || e.message` の順で出しているのに、
      // ここで hint を写していなかったため、どの画面でも
      // 「onboard_failed」のようなコード名しか出ていなかった。
      //
      // ■ message も同じことになっていた
      //
      //   表がまだ無いときは、サーバは
      //     { error: "not_ready", message: "…db/066_hr_flow.sql の実行を…" }
      //   と、やることまで書いて返している（32か所ある）。
      //   その説明が入っているのは message のほうなのに、ここで写していなかった。
      //   結果、画面には「not_ready」とだけ出て、何をすればよいか分からなかった。
      //
      //   コード名は code に分けて残す。機械が見たいのはこちらで、
      //   人が読むのは hint（＝ hint か message）のほう
      const err = new Error(data.hint || data.message || data.error || `APIエラー (${r.status})`);
      err.status = r.status;
      err.code = data.error || null;
      err.hint = data.hint || data.message || (isRawTechnicalCode(err.code) ? FRIENDLY_FALLBACK : null);
      err.detail = data.detail;
      err.body = data;
      // 二段階認証が要るのに済んでいない。どの画面で起きても、登録の場所へ送る。
      // マイページの中では送らない（そこが登録の場所なので、回り続ける）
      //
      // 絶対パスで送る。相対（mypage.html#mfa）だと、/hr/ や /sales/ や /office/ の画面からは
      // /hr/mypage.html のような存在しない場所へ飛び、登録できないまま行き止まりになる
      if (err.code === "mfa_required" && !/mypage\.html/.test(location.pathname)) {
        location.href = "/mypage.html#mfa";   // 絶対パス。/keiei/ など、サブディレクトリの画面から呼ばれても届く
      }
      throw err;
    }
    return data;
  }

  // ---- 画面データの短期キャッシュ（stale-while-revalidate） -------------------
  //
  // ■ まず見せて、裏で最新にする
  //   画面を開くたびに一覧・ダッシュボードの取得を待っていたので、2回目でも「読み込み中…」が出ていた。
  //   同じタブで少し前に取ったものがあれば、それをすぐ描き、裏で取り直して、違っていたときだけ描き直す。
  //     API.swr(鍵, 取りにいく関数, 描く関数, { ttl })
  //   ・覚えていない／ttl（秒）を過ぎた → いつもどおり取って描く（待つ）
  //   ・覚えている → すぐ描く → 裏で取り直す → 中身が変わっていたときだけ、もう一度描く
  //   ・裏の取り直しに失敗 → 前の表示は消さない。画面の隅に「最新情報を取得できませんでした」
  //
  // ■ 人のあいだで混ざらない
  //   置き場所は sessionStorage（タブを閉じれば消える）。鍵には「誰のものか」（ログインのID）を入れる。
  //   ログアウト・ログインのときは、誰のものかに関わらず全部消す。
  //   契約・給与・人事・応募者・営業先の中身が、次にそのタブを使う人に残らないようにする。
  //
  // ■ 更新したら捨てる
  //   GET 以外が終わったら全部捨てる（api() の中）。捨てた時点で取りにいっていたものは、
  //   返ってきても覚えない（更新の前の中身を、更新のあとで覚え直さない）。
  const SWR_PREFIX = "kp_swr:";
  const SWR_MAX_CHARS = 1500000;   // これより大きい応答は覚えない（sessionStorage の上限に当てない）
  let swrGen = 0;                  // 捨てるたびに増やす。取りにいった時点の値と違えば、覚えない
  const swrInflight = new Map();   // 鍵 → 取りにいっている最中の Promise（同じものを2本出さない）
  const swrSeq = new Map();        // 鍵 → いちばん新しい呼び出しの番号（古い呼び出しの描き直しを捨てる）
  const swrWarmed = new Set();     // warm で取ったが、まだ描いていない鍵（描くときは取り直さない。もう最新）

  /** ログインしている人の印。トークンの sub（ユーザーID）、読めなければメール */
  function swrWho() {
    const sess = loadSession();
    if (!sess) return null;
    try {
      const part = String(sess.access_token || "").split(".")[1];
      if (part) {
        const sub = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))).sub;
        if (sub) return String(sub);
      }
    } catch { /* JWT でなければメールで分ける */ }
    return sess.email || null;
  }
  const swrStoreKey = (key) => { const who = swrWho(); return who ? `${SWR_PREFIX}${who}:${key}` : null; };

  function swrRead(key, ttlSec) {
    const sk = swrStoreKey(key);
    if (!sk) return null;
    try {
      const raw = sessionStorage.getItem(sk);
      if (!raw) return null;
      const i = raw.indexOf("|");
      const at = Number(raw.slice(0, i));
      if (!(Date.now() - at < ttlSec * 1000)) { sessionStorage.removeItem(sk); return null; }
      const body = raw.slice(i + 1);
      return { at, body, value: JSON.parse(body) };
    } catch { return null; }
  }
  function swrWrite(key, body) {
    const sk = swrStoreKey(key);
    if (!sk || body.length > SWR_MAX_CHARS) return;
    try { sessionStorage.setItem(sk, `${Date.now()}|${body}`); }
    catch { /* いっぱい・使えない。覚えずに動く */ }
  }
  /** 鍵1つだけ捨てる（いまログインしている人のぶん） */
  function swrDrop(key) {
    swrGen++;
    swrInflight.delete(key);
    swrWarmed.delete(key);
    const sk = swrStoreKey(key);
    try { if (sk) sessionStorage.removeItem(sk); } catch { /* 無視 */ }
  }
  /** 全部捨てる（誰のものかに関わらず） */
  function swrClear() {
    swrGen++;
    swrInflight.clear();
    swrWarmed.clear();
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(SWR_PREFIX)) sessionStorage.removeItem(k);
      }
    } catch { /* 使えない */ }
  }

  /** 取りにいく（同じ鍵が取りにいっている最中なら、それを待つ）。取れたら覚える */
  function swrFetch(key, fetcher) {
    const going = swrInflight.get(key);
    if (going) return going;
    const gen = swrGen;
    const p = Promise.resolve().then(fetcher).then((v) => {
      // 取りにいっているあいだに更新・ログアウトがあれば、覚えない（古い中身を覚え直さない）
      if (gen === swrGen && v && typeof v === "object") swrWrite(key, JSON.stringify(v));
      return v;
    }).finally(() => { if (swrInflight.get(key) === p) swrInflight.delete(key); });
    swrInflight.set(key, p);
    return p;
  }

  /**
   * 画面のデータを、覚えているぶんで先に描き、裏で最新にする。
   * @param {string} key 鍵（画面＋条件。例 "sales:dashboard"・"office:2026-09"）
   * @param {() => Promise<object>} fetcher 取りにいく関数（API.xxx を呼ぶだけ）
   * @param {(data:object, meta:{cached:boolean, updated?:boolean}) => any} render 描く関数（2回呼ばれることがある）
   * @param {{ttl?:number, fresh?:number, quiet?:boolean, onError?:(e:Error)=>void}} [opts]
   *   ttl   … 覚えているぶんを使う長さ（秒。既定120）。過ぎたら、覚えていないのと同じ
   *   fresh … これより新しければ、裏で取り直さない（秒。既定0＝毎回取り直す）
   *   quiet … 画面の隅の「更新中…」を出さない（通知・バッジなど）
   * @returns {Promise<object>} 最初に描いたデータ（覚えていなければ、取ったもの）
   */
  async function swr(key, fetcher, render, { ttl = 120, fresh = 0, quiet = false, onError } = {}) {
    const my = (swrSeq.get(key) || 0) + 1;
    swrSeq.set(key, my);
    const latest = () => swrSeq.get(key) === my;
    const hit = swrRead(key, ttl);
    if (!hit) {
      const v = await swrFetch(key, fetcher);
      if (latest()) { await render(v, { cached: false }); if (!quiet) perfMark("first"); }
      return v;
    }
    await render(hit.value, { cached: true, at: hit.at });
    if (!quiet) perfMark("first");
    // この画面を開いたときに先に取りにいったもの（warm）が、描く前に届いていたなら、それがもう最新
    const warmed = swrWarmed.delete(key);
    if (warmed || Date.now() - hit.at < fresh * 1000) return hit.value;
    const done = quiet ? () => {} : busyStart();
    swrFetch(key, fetcher).then(async (v) => {
      done(true);
      // 中身が同じなら描き直さない（点滅させない）。違っていれば、いちばん新しい呼び出しだけ描く
      if (latest() && JSON.stringify(v) !== hit.body) await render(v, { cached: false, updated: true });
    }).catch((e) => {
      done(false);
      if (onError) onError(e);
    });
    return hit.value;
  }

  /**
   * 画面の枠（権限の確認）を待たずに、その画面のデータを取りにいき始める。
   * あとで同じ鍵で swr() を呼べば、取りにいっている最中のものを待つ（2本出さない）。
   *
   * ■ 入れると分かっている人のときだけ
   *   覚えている身元（いまログインしている本人のもの）があり、その身元でこの画面に入れるときだけ先に出す。
   *   覚えていない・入れない人のためには、その画面の API を1本も呼ばない（これまでどおり、確かめてから）。
   * @param {(me:object) => boolean} [canEnter] 覚えている身元で、この画面に入れるか（省略時は、ログインしていれば入れる画面）
   */
  function warm(key, fetcher, canEnter = () => true) {
    const remembered = rememberedMe();
    if (!remembered || !canEnter(remembered)) return;
    const gen = swrGen;
    swrFetch(key, fetcher).then(() => { if (gen === swrGen) swrWarmed.add(key); }, () => { /* swr() の側で扱う */ });
  }

  // 「更新中…」「最新情報を取得できませんでした」。画面の隅に小さく1つだけ。
  // 画面全体を「読み込み中」にしない（前の表示はそのまま）
  let busyCount = 0;
  let busyTimer = null;
  function chip() {
    if (typeof document === "undefined") return null;
    let c = document.getElementById("kp-swr-chip");
    if (!c && document.body) {
      c = document.createElement("div");
      c.id = "kp-swr-chip";
      c.setAttribute("role", "status");
      c.setAttribute("aria-live", "polite");
      c.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:9999;padding:6px 12px;border-radius:999px;"
        + "font-size:12px;line-height:1.4;background:rgba(27,36,64,.86);color:#fff;pointer-events:none;"
        + "box-shadow:0 2px 8px rgba(0,0,0,.15);display:none;max-width:80vw;";
      document.body.appendChild(c);
    }
    return c;
  }
  function showChip(text, warn) {
    const c = chip();
    if (!c) return;
    c.textContent = text;
    c.style.background = warn ? "rgba(179,38,30,.92)" : "rgba(27,36,64,.86)";
    c.style.display = "block";
  }
  function hideChip() {
    const c = typeof document === "undefined" ? null : document.getElementById("kp-swr-chip");
    if (c) c.style.display = "none";
  }
  function busyStart() {
    busyCount++;
    // すぐ返ってくるときは出さない（一瞬だけ出て消えるのは、かえって気になる）
    if (!busyTimer) busyTimer = setTimeout(() => { busyTimer = null; if (busyCount > 0) showChip("更新中…"); }, 250);
    let ended = false;
    return (ok) => {
      if (ended) return;
      ended = true;
      busyCount = Math.max(0, busyCount - 1);
      if (!ok) {
        showChip("最新情報を取得できませんでした（前回の内容を表示しています）", true);
        setTimeout(() => { if (busyCount === 0) hideChip(); }, 6000);
        return;
      }
      if (busyCount === 0) {
        if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
        const c = chip();
        if (c && !/取得できません/.test(c.textContent)) hideChip();
      }
    };
  }

  /**
   * 描き直すとき、要素を全部作り直さず、変わったところだけ変える。
   * 入力中の欄・開いている details・スクロール位置がそのまま残り、点滅しない。
   * 中身がまだ無い（はじめて描く）ときは innerHTML と同じ。
   * 描いたあとに addEventListener を付ける画面では使わない（残った要素に二重に付く）。onclick="…" の画面向け
   */
  function morph(node, html) {
    if (!node) return;
    if (!node.firstChild) { node.innerHTML = html; return; }
    const next = node.cloneNode(false);
    next.innerHTML = html;
    morphChildren(node, next);
  }
  const sameNode = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName
    && (a.nodeType !== 1 || ((a.id || "") === (b.id || "") && (a.dataset?.id || "") === (b.dataset?.id || "")));
  function morphChildren(from, to) {
    let cur = from.firstChild;
    for (const nb of [...to.childNodes]) {
      if (cur && sameNode(cur, nb)) {
        if (nb.nodeType === 1) morphEl(cur, nb);
        else if (cur.nodeValue !== nb.nodeValue) cur.nodeValue = nb.nodeValue;
        cur = cur.nextSibling;
      } else {
        from.insertBefore(nb, cur);
      }
    }
    while (cur) { const n = cur.nextSibling; from.removeChild(cur); cur = n; }
  }
  function morphEl(a, b) {
    for (const { name } of [...a.attributes]) {
      // 開いている details は、描き直しで閉じない（人が開けたもの）
      if (!b.hasAttribute(name) && !(name === "open" && a.tagName === "DETAILS")) a.removeAttribute(name);
    }
    for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
    // 入力中の欄は触らない
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && document.activeElement === a) return;
    if (a.tagName === "INPUT") { a.value = b.value; a.checked = b.checked; }
    morphChildren(a, b);
    if (a.tagName === "TEXTAREA") a.value = b.value;
    if (a.tagName === "SELECT") a.value = b.value;
  }

  // ---- 表示速度の計測（KPPerf） --------------------------------------------------
  //
  // どの画面でも URL に ?perf=1 を付けると、このタブのあいだ、開いた画面ごとに
  // コンソールへ次の時刻（ページを開いた時点からのミリ秒）を出す。?perf=0 でやめる。
  //   HTML（DOMContentLoaded）・枠（init）・/api/me・/api/public-config・その画面のAPI・本文が出た（first）
  // 推測で速くしない。本番で測って、改善の前後を比べるための道具（scripts/perf/measure.mjs と同じ項目）
  const PERF_ON = (() => {
    try {
      if (/[?&]perf=1\b/.test(location.search)) sessionStorage.setItem("kp_perf", "1");
      if (/[?&]perf=0\b/.test(location.search)) sessionStorage.removeItem("kp_perf");
      return sessionStorage.getItem("kp_perf") === "1";
    } catch { return false; }
  })();
  let perfTimer = null;
  function perfMark(name) {
    try {
      if (typeof performance === "undefined" || !performance.mark) return;
      if (performance.getEntriesByName(`kp:${name}`).length) return;   // 最初の1回だけ
      performance.mark(`kp:${name}`);
    } catch { return; }
    if (PERF_ON && name === "first" && !perfTimer) perfTimer = setTimeout(perfReport, 2000);
  }
  function perfReport() {
    try {
      const nav = performance.getEntriesByType("navigation")[0];
      const mark = (n) => { const e = performance.getEntriesByName(`kp:${n}`)[0]; return e ? Math.round(e.startTime) : null; };
      const apis = performance.getEntriesByType("resource").filter((e) => /\/api\//.test(e.name));
      const end = (re) => { const h = apis.filter((e) => re.test(new URL(e.name).pathname)); return h.length ? Math.round(h[0].responseEnd) : null; };
      const first = mark("first");
      console.log(`[KPPerf] ${location.pathname}`);
      console.table({
        "HTML（DOMContentLoaded）": nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        "枠（init）": mark("init"),
        "/api/me": end(/^\/api\/me$/),
        "/api/public-config": end(/^\/api\/public-config$/),
        "本文が出た（first）": first,
      });
      console.table(apis.map((e) => ({ api: new URL(e.name).pathname + new URL(e.name).search,
        開始: Math.round(e.startTime), 完了: Math.round(e.responseEnd), 所要: Math.round(e.duration),
        KB: Math.round((e.decodedBodySize || 0) / 102.4) / 10, 本文の前: first !== null && e.responseEnd <= first })));
    } catch { /* 測れない環境 */ }
  }

  // ---- 画面の先読み（prefetch） --------------------------------------------------
  //
  // ヘッダー・左メニュー・画面上のタブのリンクに、マウスが乗った・フォーカスが来た・
  // 指が触れた時点で、その先の HTML だけを先に取っておく（押したときには手元にある）。
  // 触れたリンクだけ。一斉に先読みはしない。API（データ）は先読みしない。
  // JS・CSS は ?v= 付きで1年キャッシュされるので、2回目以降はもともと手元にある
  const PREFETCH_SCOPE = ".topbar, .kp-sidebar, .kp-tabbar, .kp-subnav, .kp-bell-panel, "
    + ".hr-bar, .sl-bar, .of-bar, .kei-bar, .kei-side, [data-prefetch]";
  const prefetched = new Set();
  function prefetchFrom(e) {
    const a = e.target?.closest?.("a[href]");
    if (!a || !a.closest(PREFETCH_SCOPE) || a.hasAttribute("download")) return;
    let u;
    try { u = new URL(a.getAttribute("href"), location.href); } catch { return; }
    if (u.origin !== location.origin || !/^https?:$/.test(u.protocol)) return;
    if (u.pathname === location.pathname) return;
    // 画面（.html か、/hr/ のような入口）だけ。API・ファイルは先読みしない
    if (!/(\.html|\/|\/(hr|sales|office|keiei|onboarding)(\/[a-z-]+)?)$/.test(u.pathname) || /^\/api\//.test(u.pathname)) return;
    const href = u.pathname + u.search;
    if (prefetched.has(href)) return;
    if (navigator.connection?.saveData) return;   // データを節約する設定の人には、先読みしない
    prefetched.add(href);
    const l = document.createElement("link");
    l.rel = "prefetch";
    l.as = "document";
    l.href = href;
    document.head.appendChild(l);
  }
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("mouseover", prefetchFrom, { passive: true });
    document.addEventListener("focusin", prefetchFrom);
    document.addEventListener("touchstart", prefetchFrom, { passive: true });
  }

  // 拡張子から MIME を補完（ブラウザが file.type を空で返す場合の保険）
  function guessMime(file) {
    if (file.type) return file.type;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const map = {
      pdf: "application/pdf",
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic",
      heif: "image/heic",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xls: "application/vnd.ms-excel", csv: "text/csv",
      // 記入して出す書類は Word のことがある。サーバ側は前から受けていたのに、
      // ここに無いせいで「対応していないファイル形式です」で止まっていた
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      doc: "application/msword",
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

  // ---- BP企業（パートナー企業） ----
  const listPartners = () => api("/api/partners");
  const createPartner = (body) => api("/api/partners", { method: "POST", body });
  const updatePartner = (body) => api("/api/partners", { method: "PATCH", body });
  const deletePartner = (id) => api(`/api/partners?id=${encodeURIComponent(id)}`, { method: "DELETE" });

  // ---- SES現場契約（社員/BP → 現場契約） ----
  const listSiteContracts = (employeeId) =>
    api(`/api/site-contracts${employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : ""}`);
  const createSiteContract = (body) => api("/api/site-contracts", { method: "POST", body });
  const updateSiteContract = (body) => api("/api/site-contracts", { method: "PATCH", body });
  const deleteSiteContract = (id) => api(`/api/site-contracts?id=${encodeURIComponent(id)}`, { method: "DELETE" });

  // ---- 月次請求進捗（勤務表受領→稼働確認→Board作成→送付→BP請求書受領） ----
  const listBillingProgress = (month, opts = {}) => {
    const q = new URLSearchParams({ month });
    if (opts.employeeId) q.set("employeeId", opts.employeeId);
    if (opts.siteContractId) q.set("siteContractId", opts.siteContractId);
    return api(`/api/billing-progress?${q.toString()}`);
  };
  const ensureBillingProgress = (body) => api("/api/billing-progress", { method: "POST", body });
  const updateBillingProgress = (body) => api("/api/billing-progress", { method: "PATCH", body });

  // ---- 月初業務D1：外部提出フォーム（勤務表・請求書） ----
  const listBillingSubmissions = (month) =>
    api(`/api/billing-submission?month=${encodeURIComponent(month)}`);
  const issueSubmissionLink = (employeeId) =>
    api("/api/billing-submission", { method: "POST", body: { employeeId } });
  const revokeSubmissionLink = (employeeId) =>
    api(`/api/billing-submission?employeeId=${encodeURIComponent(employeeId)}`, { method: "DELETE" });
  const submissionFileUrl = (id) =>
    api(`/api/billing-submission/file?id=${encodeURIComponent(id)}`);
  // 以下2つは未ログインでも使う（外部会社・BP向け）
  const submissionPreview = (token) =>
    publicApi(`/api/billing-submission/public?token=${encodeURIComponent(token)}`);
  const submitBilling = (body) =>
    publicApi("/api/billing-submission/public", { method: "POST", body });

  // ---- 採用HR（/hr） ----
  const listHrApplicants = () => api("/api/hr/applicants");
  const createHrApplicant = (body) => api("/api/hr/applicants", { method: "POST", body });
  const getHrApplicant = (id) => api(`/api/hr/applicants/detail?id=${encodeURIComponent(id)}`);
  // 応募書類（履歴書・職務経歴書・その他）。個人情報なので URL は数分だけ有効（private バケット）
  const hrDocuments = (applicantId) => api(`/api/hr/documents?applicantId=${encodeURIComponent(applicantId)}`);
  // applicantId を渡すと、その応募者の書類でなければ 404（プレビューのURLの取り違え防止）
  const hrDocumentUrl = (id, download, applicantId) =>
    api(`/api/hr/documents?id=${encodeURIComponent(id)}${download ? "&download=1" : ""}`
      + `${applicantId ? `&applicantId=${encodeURIComponent(applicantId)}` : ""}`);
  const deleteHrDocument = (id) => api(`/api/hr/documents?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  // 置き場所をもらう → PUT → 中身を確かめて登録（差し替えも同じ。前の版は残る）
  async function uploadHrDocument(applicantId, docType, file) {
    const sign = await api("/api/hr/documents", { method: "POST", body: {
      action: "upload", applicantId, docType, mimeType: file.type, sizeBytes: file.size } });
    const put = await fetch(sign.uploadUrl, {
      method: "PUT", headers: { "Content-Type": file.type, "x-upsert": "false" }, body: file,
    });
    if (!put.ok) throw new Error(`アップロードに失敗しました (${put.status})`);
    return api("/api/hr/documents", { method: "POST", body: {
      action: "attach", applicantId, docType, path: sign.path, filename: file.name } });
  }
  const updateHrApplicant = (body) => api("/api/hr/applicants/detail", { method: "PATCH", body });
  // ---- 採用HR：応募者一覧の複数選択操作 ----
  const bulkHrApplicants = (body) => api("/api/hr/applicants/bulk", { method: "POST", body });
  const deleteHrApplicants = (ids) => bulkHrApplicants({ ids, action: "delete" });
  const setHrApplicantsStatus = (ids, status) => bulkHrApplicants({ ids, action: "setStatus", status });
  const setHrApplicantsRecruiter = (ids, recruiterId) => bulkHrApplicants({ ids, action: "setRecruiter", recruiterId });

  // ---- 採用HR：面談・評価（Stage 3） ----
  const scheduleHrInterview = (body) => api("/api/hr/interviews", { method: "POST", body });
  const hrInterviewAct = (body) => api("/api/hr/interviews", { method: "PATCH", body });
  const conductHrInterview = (id, conductedAt) => hrInterviewAct({ id, action: "conduct", conductedAt });
  const evaluateHrInterview = (body) => hrInterviewAct({ ...body, action: "evaluate" });
  const updateHrInterview = (body) => hrInterviewAct({ ...body, action: "update" });
  const cancelHrInterview = (id) => hrInterviewAct({ id, action: "cancel" });
  const todayHrInterviews = () => api("/api/hr/interviews/today");
  const ceoReview = () => api("/api/hr/ceo-review");

  // ---- 採用HR：合格通知作成（Stage 5） ----
  const createHrOffer = (body) => api("/api/hr/offers", { method: "POST", body });
  const hrOfferAct = (body) => api("/api/hr/offers", { method: "PATCH", body });
  const updateHrOffer = (body) => hrOfferAct({ ...body, action: "update" });
  const confirmHrOffer = (id) => hrOfferAct({ id, action: "confirm" });

  // ---- 採用HR：本人専用URLの発行・送付・閲覧確認（Stage 6） ----
  const issueHrOfferLink = (id) => hrOfferAct({ id, action: "issueLink" });
  const markHrOfferSent = (id) => hrOfferAct({ id, action: "markSent" });
  // 候補者向け公開ページ（未ログイン）
  const hrOfferPublic = (token) => publicApi(`/api/hr/offers/public?token=${encodeURIComponent(token)}`);
  const hrOfferRespond = (token, action, declineReason) =>
    publicApi("/api/hr/offers/public", { method: "POST", body: { token, action, declineReason } });

  // ---- 採用HR：本採用へ進める（Stage 8） ----
  const getHrAdvancePrefill = (applicantId) =>
    api(`/api/hr/applicants/advance?applicantId=${encodeURIComponent(applicantId)}`);
  const claimHrAdvance = (applicantId) => api("/api/hr/applicants/advance", { method: "POST", body: { applicantId } });
  const hrAdvanceAct = (body) => api("/api/hr/applicants/advance", { method: "PATCH", body });
  const releaseHrAdvance = (applicantId) => hrAdvanceAct({ applicantId, action: "release" });
  const completeHrAdvance = (applicantId, employeeId) => hrAdvanceAct({ applicantId, action: "complete", employeeId });

  // ---- 営業アタック管理（/sales） ----
  // visibility: "shown"（既定・表示中だけ）／"hidden"（非表示だけ）／"all"
  // 企業一覧（サーバー側ページング。100件ずつ）。params は page・sort・order・q・status・owner・
  // service・industry・region・channel・visibility・facets。空の値は送らない
  const qs = (params) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") u.set(k, v);
    const s = u.toString();
    return s ? `?${s}` : "";
  };
  const listSalesCompanyPage = (params) => api(`/api/sales/companies${qs({ page: 1, ...params })}`);
  // CSV（サーバーで条件を実行し直して作る）。ids があればその企業だけ。{ blob, filename } を返す
  async function exportSalesCompanies(params, ids) {
    const token = await getToken();
    if (!token) throw new Error("未ログインです");
    const r = await fetch(`/api/sales/companies/export${ids ? "" : qs(params)}`, {
      method: ids ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(ids ? { "Content-Type": "application/json" } : {}) },
      body: ids ? JSON.stringify({ ids, sort: params?.sort, order: params?.order }) : undefined,
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      const err = new Error(data.hint || data.message || data.error || `APIエラー (${r.status})`);
      err.status = r.status; err.code = data.error || null; err.hint = data.hint || data.message || null; err.body = data;
      throw err;
    }
    const cd = r.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename\*=UTF-8''([^;]+)/) || cd.match(/filename="([^"]+)"/);
    return { blob: await r.blob(), filename: m ? decodeURIComponent(m[1]) : "sales_companies.csv" };
  }
  const listSalesCompanies = (visibility) =>
    api(`/api/sales/companies${visibility && visibility !== "shown" ? `?visibility=${encodeURIComponent(visibility)}` : ""}`);
  const createSalesCompany = (body) => api("/api/sales/companies", { method: "POST", body });
  const importSalesCompanies = (companies) => api("/api/sales/companies", { method: "POST", body: { companies } });
  // CSV 取込。commit=false で確認（プレビュー）、true で登録（画面は50行ずつ送る）
  const importSalesCsv = (body) => api("/api/sales/companies/import", { method: "POST", body });
  // 業種・提案サービスの選択肢（db/108）。追加・名前変更・非表示・再表示
  const getSalesMasters = () => api("/api/sales/masters");
  const addSalesMaster = (kind, label) => api("/api/sales/masters", { method: "POST", body: { kind, label } });
  const updateSalesMaster = (body) => api("/api/sales/masters", { method: "PATCH", body });
  const getSalesCompany = (id) => api(`/api/sales/companies/detail?id=${encodeURIComponent(id)}`);
  const updateSalesCompany = (body) => api("/api/sales/companies/detail", { method: "PATCH", body });
  const markSalesFollowed = (id) => updateSalesCompany({ id, action: "followed" });
  // 企業の一括操作（change_status / change_owner / change_service / change_campaign / set_ng / delete）
  const bulkSalesCompanies = (body) => api("/api/sales/companies/bulk", { method: "POST", body });
  const addSalesEvent = (body) => api("/api/sales/companies/detail", { method: "POST", body });
  const listSalesApproaches = (days, limit) => api(`/api/sales/approaches${qs({ days: days || undefined, limit: limit || undefined })}`);
  // ダッシュボード（/sales/）の4段。件数と各段の上位だけ（全件は送らない）
  const salesDashboard = () => api("/api/sales/companies?view=dashboard");
  const prepareSalesAttack = (body) => api("/api/sales/approaches", { method: "POST", body });
  const salesAttackAct = (body) => api("/api/sales/approaches", { method: "PATCH", body });
  const markSalesAttackSent = (body) => salesAttackAct({ ...body, action: "sent" });
  const discardSalesAttack = (id) => salesAttackAct({ id, action: "discard" });
  // 送信できなかった（理由必須）
  const markSalesAttackFailed = (body) => salesAttackAct({ ...body, action: "failed" });
  // 返信・やり取りを記録（返信元・いまの連絡手段・連絡先・メモ・NEXT）
  const addSalesContact = (body) => api("/api/sales/companies/detail", { method: "POST", body: { ...body, action: "contact" } });
  const listSalesTemplates = () => api("/api/sales/templates");
  const createSalesTemplate = (body) => api("/api/sales/templates", { method: "POST", body });
  const updateSalesTemplate = (body) => api("/api/sales/templates", { method: "PATCH", body });
  const listSalesCampaigns = () => api("/api/sales/campaigns");
  const createSalesCampaign = (body) => api("/api/sales/campaigns", { method: "POST", body });
  const updateSalesCampaign = (body) => api("/api/sales/campaigns", { method: "PATCH", body });
  const lookupSalesUrl = (url) => api(`/api/sales/lookup?url=${encodeURIComponent(url)}`);
  const listSalesMeetings = (companyId) => api(`/api/sales/meetings?companyId=${encodeURIComponent(companyId)}`);
  const issueSalesMeeting = (body) => api("/api/sales/meetings", { method: "POST", body });
  const salesMeetingAct = (body) => api("/api/sales/meetings", { method: "PATCH", body });
  // 営業の案件（db/116）。companyId なしならテナントの案件すべて（分析用）
  const listSalesDeals = (companyId) => api(`/api/sales/deals${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ""}`);
  const createSalesDeal = (body) => api("/api/sales/deals", { method: "POST", body });
  const updateSalesDeal = (body) => api("/api/sales/deals", { method: "PATCH", body });

  // ---- 外部メンバー（ゲスト）招待 ----
  const listGuests = () => api("/api/guests");
  const createGuest = (body) => api("/api/guests", { method: "POST", body });
  const guestOptions = () => api("/api/guests/options");
  const guestDetail = (id) => api(`/api/guests/detail?id=${encodeURIComponent(id)}`);
  const guestReissue = (id) => api("/api/guests/detail", { method: "POST", body: { id, action: "reissue" } });
  const guestDisable = (id) => api("/api/guests/detail", { method: "POST", body: { id, action: "disable" } });
  const guestUpdateGrants = (id, grants) =>
    api("/api/guests/detail", { method: "POST", body: { id, action: "updateGrants", grants } });
  // 登録済みの外部メンバー本人が、自分の許可範囲を見る
  const guestMy = () => api("/api/guests/my");

  const setEmployeeRole = (employeeId, role, grant) =>
    api("/api/employees/roles", { method: "POST", body: { employeeId, role, grant } });

  // アプリ利用権限（採用HR・Sales・Office・経営の4つのボタン）。app = hr / sales / office / keiei
  const setEmployeeApp = (employeeId, app, grant) =>
    api("/api/employees/apps", { method: "POST", body: { employeeId, app, grant } });

  // opts.create=true でアカウントが無ければ作る（招待）。
  // password を省くと自動生成され、その1回だけ応答に含まれる。
  const linkEmployeeAccount = (employeeId, email, clientId, opts = {}) =>
    api("/api/employees/link", { method: "POST", body: { employeeId, email, clientId, ...opts } });

  // ---- 通知 ----
  const listNotifications = () => api("/api/notifications");
  // 既読は、通知とバッジだけ取り直せばよい（ほかの画面のデータは変わらない）
  const markNotificationRead = (id) =>
    api("/api/notifications", { method: "PATCH", body: { id }, invalidates: ["notifications", "badges"] });
  const markAllNotificationsRead = () =>
    api("/api/notifications", { method: "PATCH", body: { all: true }, invalidates: ["notifications", "badges"] });

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
  // 同僚の予定。本人が「見せる」と選んだ分だけが返る。
  // 「時間だけ」の予定には title が入っていない（サーバで落としてある）
  const teamSchedule = (from, to) =>
    api(`/api/schedule/team?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

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
  // 朝。結果を見る前に、今日の成功した状態を描く。
  // 終業時の入力を出したあとは、サーバ側で書き換えを止めている
  const submitMorning = (m) =>
    api("/api/nippo", { method: "POST", body: { kind: "morning", ...m } });
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
  // サイドメニューに出す「対応が要る件数」。1回で全部返る
  const badges = () => api("/api/badges");

  const actionItem = (action, body = {}) =>
    api("/api/dashboard", { method: "POST", body: { kind: "action", action, ...body } });
  // 並べ替え・ピン留め・AI提案の採否。どれも同じ入口を通す
  const pinAction = (id, on) => actionItem(on ? "pin" : "unpin", { id });
  const reorderActions = (ids) => actionItem("reorder", { ids });
  const recalcActions = () => actionItem("recalc");
  const adoptProposals = (ids, patch = {}) => actionItem("adopt", { ids, ...patch });
  const rejectProposals = (ids) => actionItem("reject", { ids });

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

  // ---- 新規メンバー登録 ----
  // 通常はフォーム。押した瞬間にアカウントができるので、
  // 先にプレビュー（onboardPreview）を出してから登録する
  const onboardOptions = () => api("/api/employees/onboard");
  // 「働き方 × 担当業務」を掛け合わせた初期値。組み立てはサーバ側にだけ置く
  const onboardCombine = (mode, job) =>
    api(`/api/employees/onboard?mode=${encodeURIComponent(mode)}&job=${encodeURIComponent(job)}`);
  const onboardPreview = (form) =>
    api("/api/employees/onboard", { method: "POST", body: { form } });
  const onboardCreate = (form) =>
    api("/api/employees/onboard", { method: "POST", body: { form, create: true } });

  // ---- みんなの日報 ----
  // 出るのはAIが作った共有サマリーだけ（今日やったこと・成果・学び・明日やること）。
  // 点数・未達理由・相談事項は、そもそも別の表に入っていない
  const nippoFeed = (date) =>
    api(`/api/nippo/feed${date ? `?date=${encodeURIComponent(date)}` : ""}`);
  const nippoReact = (shareId) =>
    api("/api/nippo/feed", { method: "POST", body: { shareId, action: "react" } });
  const nippoComment = (shareId, body) =>
    api("/api/nippo/feed", { method: "POST", body: { shareId, action: "comment", body } });
  const nippoShareVisible = (shareId, visible) =>
    api("/api/nippo/feed", { method: "POST", body: { shareId, action: "visible", visible } });

  // 複数人をまとめて登録するときだけ使う補助。
  // こちらも2段構えで、検証（intakeCheck）→ 登録（intakeApply）
  const intakeInfo = () => api("/api/employees/intake");
  const intakeCheck = (body) => api("/api/employees/intake", { method: "POST", body });
  const intakeApply = (batchId) =>
    api("/api/employees/intake", { method: "POST", body: { commit: batchId } });

  // ---- 3か月育成計画（労働条件通知書 → 3か月KGI → 月間KGI/KPI → 今日のKPI） ----
  // AIが作るのは案まで。確定は人が押す
  const growthPlans = (employeeId) =>
    api(`/api/growth${employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : ""}`);
  const myGrowthPlan = () => api("/api/growth?scope=mine");
  const growthAct = (action, body = {}) =>
    api("/api/growth", { method: "POST", body: { action, ...body } });

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
  // ---- 自社サイトのお知らせ（8grp.co.jp/news/） ----
  // 保存先は事務ポータルと同じ表。毎朝8時の同期がサイトへ反映する
  const siteNews = (status) =>
    api(`/api/site-news${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  const createSiteNews = (a) =>
    api("/api/site-news", { method: "POST", body: a });
  const updateSiteNews = (a) =>
    api("/api/site-news", { method: "PATCH", body: a });
  const deleteSiteNews = (id) =>
    api(`/api/site-news?id=${encodeURIComponent(id)}`, { method: "DELETE" });

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

  // ---- タイムカード ----
  // 本人。時刻はサーバの時計で打つので、こちらからは送らない
  const myTimecard = (month) =>
    api(`/api/timecard/me${month ? `?month=${encodeURIComponent(month)}` : ""}`);
  const stamp = (action) => api("/api/timecard/me", { method: "POST", body: { action } });
  const requestTimeFix = (p) => api("/api/timecard/me", { method: "POST", body: { ...p, fix: true } });

  // 管理側
  const timecards = (month, employeeId) => {
    const q = new URLSearchParams();
    if (month) q.set("month", month);
    if (employeeId) q.set("employeeId", employeeId);
    return api(`/api/timecard?${q.toString()}`);
  };
  const patchTimecard = (p) => api("/api/timecard", { method: "PATCH", body: p });
  // CSVは認証ヘッダで取る。<a download> ではヘッダが付かないので Blob にして渡す
  async function downloadTimecardCsv(month) {
    const token = await getToken();
    if (!token) throw new Error("未ログインです");
    const q = new URLSearchParams({ csv: "1" });
    if (month) q.set("month", month);
    const r = await fetch(`/api/timecard?${q.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`CSVを取得できませんでした (${r.status})`);
    return r.blob();
  }

  // ---- 月次締め ----
  // 勤怠・休暇・経費を1か所で確認して、その月を締める
  const closing = (month) =>
    api(`/api/closing${month ? `?month=${encodeURIComponent(month)}` : ""}`);
  const patchClosing = (body) => api("/api/closing", { method: "PATCH", body });
  // CSVは認証ヘッダで取る。<a download> ではヘッダが付かない
  async function downloadClosingCsv(month) {
    const token = await getToken();
    if (!token) throw new Error("未ログインです");
    const q = new URLSearchParams({ csv: "1" });
    if (month) q.set("month", month);
    const r = await fetch(`/api/closing?${q.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`CSVを取得できませんでした (${r.status})`);
    return r.blob();
  }

  // ---- 入退社 ----
  // 誰が・いつまでに・何をやるかを進めるための口。
  // 画面は admin-hr.html 1つ。細かい手続き画面は増やさない
  const hrList = () => api("/api/hr");
  const hrOne = (id) => api(`/api/hr?id=${encodeURIComponent(id)}`);
  const hrSoon = () => api("/api/hr?soon=1");
  const hrStart = (body) => api("/api/hr", { method: "POST", body });
  const hrCheck = (body) => api("/api/hr", { method: "PATCH", body });
  const hrUpdate = (body) => api("/api/hr", { method: "PATCH", body });

  // ---- タスク一覧と、右の引き出し ----
  //
  // 一覧は「探す場所」（list）、引き出しは「処理する場所」（detail）。
  // 画面はこの2つだけを使う
  const taskList = (p = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
    return api(`/api/tasks/list${q.toString() ? `?${q}` : ""}`);
  };
  const taskDetail = (id) => api(`/api/tasks/detail?id=${encodeURIComponent(id)}`);
  const taskAct = (body) => api("/api/tasks/detail", { method: "POST", body });

  // ---- 毎日の実行管理（重要タスク3件） ----
  //
  // 明日の3件を決める → AIが見る → 人が確定 → 日報 → 翌朝の「今日やる3つ」→ 完了。
  // 画面はこの口だけを使う（決める側も、終わらせる側も同じ状態を見る）
  const focus = (p = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
    return api(`/api/tasks/focus${q.toString() ? `?${q}` : ""}`);
  };
  const focusAct = (body) => api("/api/tasks/focus", { method: "POST", body });
  const focusAdd = (body) => focusAct({ action: "add", ...body });
  const focusSelect = (body) => focusAct({ action: "select", ...body });
  const focusUpdate = (body) => focusAct({ action: "update", ...body });
  const focusCoach = (body) => focusAct({ action: "coach", ...body });
  const focusRemove = (id, employeeId) => focusAct({ action: "remove", id, employeeId });
  const focusCheck = (date, employeeId) => focusAct({ action: "check", date, employeeId });
  const focusConfirm = (date, employeeId) => focusAct({ action: "confirm", date, employeeId });
  const focusComplete = (id, result) => focusAct({ action: "complete", id, result });
  const focusReopen = (id) => focusAct({ action: "reopen", id });
  const focusCarryPlan = (date, employeeId) => focusAct({ action: "carryPlan", date, employeeId });
  const focusCarry = (body) => focusAct({ action: "carry", ...body });
  // 管理者の一覧。誰が止まっているか
  const taskBoard = (p = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
    return api(`/api/tasks/board${q.toString() ? `?${q}` : ""}`);
  };

  // ---- とりあえずメモ ----
  //
  // 期日・担当なしで1行だけ置く。退勤時にAIが見て、人が
  // 正式タスク化／自分で対応／他の人へ依頼／不要 のどれかに決める
  const memos = (employeeId) => api(`/api/tasks/memo${employeeId ? `?employeeId=${employeeId}` : ""}`);
  const memoAdd = (body) => api("/api/tasks/memo", { method: "POST", body: { action: "add", body } });
  const memoRemove = (id) => api("/api/tasks/memo", { method: "POST", body: { action: "remove", id } });
  const memoReview = (employeeId) =>
    api("/api/tasks/memo", { method: "POST", body: { action: "review", employeeId } });
  const memoDecide = (body) => api("/api/tasks/memo", { method: "POST", body: { action: "decide", ...body } });

  // ---- 端末管理 ----
  // 管理側
  const devices = (p = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
    return api(`/api/devices${q.toString() ? `?${q}` : ""}`);
  };
  const patchDevice = (body) => api("/api/devices", { method: "PATCH", body });
  // 登録コードの発行・使用の履歴（監査）
  const deviceEnrollments = () => api("/api/devices?enrollments=1");

  // 社員ごとの様子。管理者が普段見るのはこちらで、台帳は必要なときだけ開く。
  // 端末を1行ずつ並べると、同じ人のPCとブラウザが離れて並び、
  // 「この行とこの行が同じ人」を管理者が頭の中でつなぐことになる
  const devicePeople = (date) =>
    api(`/api/devices/people${date ? `?date=${encodeURIComponent(date)}` : ""}`);

  // WEB利用。その人を開いたときだけ呼ぶ（一覧では呼ばない）。
  // 呼ぶと「見た」記録が本人の画面に残る
  const deviceWeb = (p = {}) => {
    const q = new URLSearchParams();
    for (const k of ["employeeId", "range", "date", "category", "scope"]) {
      if (p[k]) q.set(k, p[k]);
    }
    return api(`/api/devices/web?${q.toString()}`);
  };
  // 自分のぶん。本人が「何を見られているか」を確かめるため
  const myWeb = (p = {}) => deviceWeb({ ...p, employeeId: undefined });

  // 組み立て（EIGHT-Agent-Setup.exe が開く画面から）
  const pairInfo = (token) =>
    api(`/api/devices/pair?token=${encodeURIComponent(token)}`);
  // 設定が終わらなかったとき、どこで止まったのかを聞く。
  // 前は「ソフトが起動していない可能性」としか出せず、
  // サーバ側で詰まっていても PC を疑うことになっていた
  const pairDiag = (token) =>
    api(`/api/devices/pair?token=${encodeURIComponent(token)}&diag=1`);
  // employeeId … 管理者が代わりに設定するときだけ。
  // 省くと、押した本人のパソコンとして登録される
  const claimPair = (token, deviceUid, employeeId) =>
    api("/api/devices/pair", {
      method: "POST", body: { token, claim: true, deviceUid, employeeId },
    });
  const deviceAlerts = (status) =>
    api(`/api/devices/alerts${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  const patchDeviceAlert = (body) => api("/api/devices/alerts", { method: "PATCH", body });
  // 端末登録。本人がマイページから始める（管理者のコード発行は廃止）
  const startDeviceSetup = () => api("/api/devices/setup", { method: "POST", body: {} });
  const deviceSetupState = (token) =>
    api(`/api/devices/setup?token=${encodeURIComponent(token)}`);
  // 誰がインストーラを実行するか（既定は管理者・IT担当）
  const deviceSetupPolicy = () => api("/api/devices/setup?policy=1");

  // 私物PC利用の事前承認
  const deviceExceptions = () => api("/api/devices/exceptions");
  const approveDeviceException = (body) =>
    api("/api/devices/exceptions", { method: "POST", body });
  const revokeDeviceException = (id, note) =>
    api("/api/devices/exceptions", { method: "PATCH", body: { action: "revoke", id, note } });
  const devicePolicy = () => api("/api/devices/policy");
  const saveDevicePolicy = (body) => api("/api/devices/policy", { method: "PATCH", body });
  async function downloadDeviceCsv(from, to) {
    const token = await getToken();
    if (!token) throw new Error("未ログインです");
    const q = new URLSearchParams({ csv: "1" });
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    const r = await fetch(`/api/devices?${q.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`CSVを取得できませんでした (${r.status})`);
    return r.blob();
  }
  // 本人向け。自分の端末・自分の記録・自分を見た履歴
  // ブラウザ拡張をつなぐための、1回きりの合言葉。
  // 社員のログインは拡張へ渡さない（渡せない）。合言葉だけを渡す
  const browserCode = (body) =>
    api("/api/devices/browser", { method: "POST", body: { action: "code", ...body }, invalidates: [] });

  const myDevices = () => api("/api/devices/me");
  // 画面を開いているあいだの合図。js/device.js から5分ごとに呼ばれる
  // 画面のデータは変えない（5分ごとの合図で、覚えている画面データを捨てない）
  const deviceBeat = (body) =>
    api("/api/devices/me", { method: "POST", body: { action: "beat", ...body }, invalidates: [] });
  // ブラウザの行は deviceUid、エージェントの行は deviceId で指す
  const confirmDevice = (target) =>
    api("/api/devices/me", { method: "POST", body: { action: "confirm", ...idOf(target) } });
  const linkAgent = (linkCode, deviceUid) =>
    api("/api/devices/me", { method: "POST", body: { action: "link", linkCode, deviceUid } });
  const idOf = (t) => (typeof t === "object" && t ? t
    : /^[0-9a-f-]{36}$/i.test(String(t)) ? { deviceId: t } : { deviceUid: t });
  const markDeviceInstalled = (deviceUid) =>
    api("/api/devices/me", { method: "POST", body: { action: "installed", deviceUid } });
  const renameMyDevice = (deviceUid, label) =>
    api("/api/devices/me", { method: "POST", body: { action: "rename", deviceUid, label } });
  const forgetMyDevice = (target) =>
    api("/api/devices/me", { method: "POST", body: { action: "forget", ...idOf(target) } });

  // ---- 契約・電子署名 ----
  // 管理側
  const signTemplates = () => api("/api/sign/templates");
  const addSignTemplate = (t) =>
    api("/api/sign/templates", { method: "POST", body: t }).then((d) => d.template);
  const updateSignTemplate = (t) =>
    api("/api/sign/templates", { method: "PATCH", body: t }).then((d) => d.template);
  const removeSignTemplate = (id) =>
    api(`/api/sign/templates?id=${encodeURIComponent(id)}`, { method: "DELETE" });

  const signRequests = (status) =>
    api(`/api/sign${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  // 保存しない。差し込んだ本文と、PDFを base64 で返す
  const previewSign = (p) => api("/api/sign", { method: "POST", body: { ...p, preview: true } });
  const sendSign = (p) => api("/api/sign", { method: "POST", body: p });
  const patchSign = (p) => api("/api/sign", { method: "PATCH", body: p });

  // 本人側。id を付けると1件の中身が返る
  const myContracts = (id) =>
    api(`/api/sign/me${id ? `?id=${encodeURIComponent(id)}` : ""}`);
  const signContract = (p) => api("/api/sign/me", { method: "POST", body: p });

  // PDFの閲覧用URL（5分だけ有効）。kind: "signed"（既定）| "original"
  // download を true にすると、開かずに保存になるURLが返る
  const signPdfUrl = (id, kind, download) =>
    api(`/api/sign/file?id=${encodeURIComponent(id)}${kind ? `&kind=${kind}` : ""}`
      + `${download ? "&download=1" : ""}`);

  // ---- 書類の作成依頼（社労士に頼む → 届いた書面にそのまま署名依頼） ----
  const docOrders = (employeeId) =>
    api(`/api/sign/orders${employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : ""}`);
  const docOrderAct = (body) => api("/api/sign/orders", { method: "POST", body });
  const docOrderFileUrl = (id) =>
    api(`/api/sign/orders?file=${encodeURIComponent(id)}`);
  // 採用承諾条件との突き合わせ・事前入力（採用HR Stage 9）
  const checkHrOfferMatch = (employeeId) =>
    api(`/api/sign/orders?employeeId=${encodeURIComponent(employeeId)}&reconcile=1`);

  // 届いた書面を取り込む。置いてから、その場で中身を確かめて結びつける
  async function uploadDocOrderFile(id, file) {
    const sign = await docOrderAct({
      action: "upload", id,
      mimeType: file.type || "application/pdf", sizeBytes: file.size,
    });
    const put = await fetch(sign.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf", "x-upsert": "false" },
      body: file,
    });
    if (!put.ok) throw new Error(`アップロードに失敗しました (${put.status})`);
    return docOrderAct({ action: "attach", id, path: sign.path, filename: file.name });
  }

  // ---- 評価・キャリア ----
  // 管理側（管理者・経営者・人事・マネージャー）
  const careerList = () => api("/api/career");
  const careerDetail = (employeeId) => api(`/api/career?employeeId=${encodeURIComponent(employeeId)}`);
  const careerEvidence = (employeeId, from, to) => api(`/api/career?evidence=${encodeURIComponent(employeeId)}`
    + `${from ? `&from=${encodeURIComponent(from)}` : ""}${to ? `&to=${encodeURIComponent(to)}` : ""}`);
  const careerMaster = () => api("/api/career?master=1");
  const careerHistory = () => api("/api/career?history=1");
  const careerAct = (body) => api("/api/career", { method: "POST", body });
  // 本人（自分の確定済みのキャリアだけ）
  const careerJourney = () => api("/api/career?journey=1");
  const careerApplicant = (id) => api(`/api/career?applicant=${encodeURIComponent(id)}`);
  const careerPreview = (employeeId) => api(`/api/career?preview=${encodeURIComponent(employeeId)}`);
  const myCareer = () => api("/api/career/me");
  const myCareerSummary = () => api("/api/career/me?summary=1");
  const myCareerAct = (body) => api("/api/career/me", { method: "POST", body });

  // ---- 会社の印鑑（印影画像） ----
  // 一覧の imageUrl は数分だけ有効な signed URL（非公開のバケット）
  const seals = () => api("/api/sign/seals");
  const sealAct = (body) => api("/api/sign/seals", { method: "POST", body });

  // 画像を置いてから、登録（create）か差し替え（update）。
  // file は PNG か JPEG（WebP は画面側で PNG にしてから渡す）
  async function uploadSealImage(file) {
    const mimeType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
    const sign = await sealAct({ action: "upload", mimeType, sizeBytes: file.size });
    const put = await fetch(sign.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType, "x-upsert": "false" },
      body: file,
    });
    if (!put.ok) throw new Error(`アップロードに失敗しました (${put.status})`);
    return sign.path;
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
  // before を渡すと、その時刻より前の50件（さかのぼって読む）
  const getThread = (threadId, before) =>
    api(`/api/messages/thread?threadId=${encodeURIComponent(threadId)}`
      + (before ? `&before=${encodeURIComponent(before)}` : ""));
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
  // グループの参加者を出し入れする。action: add / remove / leave / rename / owner
  const threadMembers = (body) =>
    api("/api/messages/members", { method: "POST", body });

  const markThreadRead = (threadId) =>
    api("/api/messages/thread", { method: "PATCH", body: { threadId } });

  // ［管理サイドへ連絡］。相手は選ばない。本人専用の窓口を開く（無ければ作る）
  const openAdminContact = () =>
    api("/api/messages/admin-contact", { method: "POST" });

  // ---- 社内AI ----
  // threadId を渡すと同じ相談の続き。省略すると新しい相談を始める
  const askAssistant = (question, threadId, category) =>
    api("/api/ai/ask", { method: "POST", body: { question, threadId, category } });
  const listAiThreads = () => api("/api/ai/threads");
  const getAiThread = (threadId) =>
    api(`/api/ai/thread?threadId=${encodeURIComponent(threadId)}`);
  const rateAiMessage = (messageId, rating, comment) =>
    api("/api/ai/feedback", { method: "POST", body: { messageId, rating, comment } });

  // 管理部への問い合わせ。threadId があればそのAI相談を要約して引き継ぐ
  const listAiInquiries = () => api("/api/ai/inquiries");
  const createAiInquiry = (threadId, note, category) =>
    api("/api/ai/inquiries", { method: "POST", body: { threadId, note, category } });
  const getAiInquiry = (id) => api(`/api/ai/inquiry?id=${encodeURIComponent(id)}`);
  const replyAiInquiry = (id, content) =>
    api("/api/ai/inquiry", { method: "POST", body: { id, content } });
  const updateAiInquiry = (id, patch) =>
    api("/api/ai/inquiry", { method: "PATCH", body: { id, ...patch } });

  // 管理画面: AIナレッジ
  const listAiKnowledge = () => api("/api/ai/knowledge").then((d) => d.knowledge || []);
  const createAiKnowledge = (k) =>
    api("/api/ai/knowledge", { method: "POST", body: k }).then((d) => d.knowledge);
  const updateAiKnowledge = (id, patch) =>
    api(`/api/ai/knowledge-item?id=${encodeURIComponent(id)}`, { method: "PATCH", body: patch });

  // ---- やること（タスク・予定） ----
  // scope='mine' で自分の担当分だけ
  const listTasks = (scope) =>
    api(`/api/tasks${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`);
  // 管理者ダッシュボード：人ごとの今日3つ・完了数・期限超過・契約更新待ち
  const dashboardTeam = () => api("/api/dashboard/team");
  const createTask = (task) =>
    api("/api/tasks", { method: "POST", body: task }).then((d) => d.task);
  const updateTask = (task) =>
    api("/api/tasks", { method: "PATCH", body: task }).then((d) => d.task);
  const deleteTask = (id) =>
    api(`/api/tasks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  // 頼まれた仕事を引き受ける。dueOn を渡すと、そこで期限を引き直す
  const acceptTask = (id, dueOn) =>
    api("/api/tasks", { method: "PATCH",
                        body: { id, action: "accept", ...(dueOn !== undefined ? { dueOn } : {}) } });

  // ---- 入社・退職手続き（古い口。社労士の画面と書類の保管先で使う） ----
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

  // ---- 入社手続きの共通ページ（本人・管理者・社労士で共有） ----
  // 進み具合の骨組みだけ。中身の読み書きは今までどおり別の口を使う
  const onboardingStatus = (employeeId) =>
    api(`/api/onboarding/status${employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : ""}`);

  // ---- 入社フォーム（本人が使う唯一の口） ----
  // 個人情報・書類・同意を1画面で終わらせる。
  // 会社が既に知っていること（労働条件・担当業務）は読み取り専用で返る
  const myOnboarding = () => api("/api/onboarding/me");
  const saveMyOnboarding = (body) =>
    api("/api/onboarding/me", { method: "POST", body });
  const myOnboardingConsent = (consents) =>
    api("/api/onboarding/me", { method: "POST", body: { consents } });
  // 社労士連絡用のテキストと Slack投稿文（人事だけ）
  const onboardBrief = (employeeId) =>
    api(`/api/onboarding/brief?employeeId=${encodeURIComponent(employeeId)}`);

  // ---- オリエンテーション ----
  // 本人は「確認しました」、人事は登録・修正
  const orientation = () => api("/api/onboarding/orientation");
  const orientationConfirm = (id) =>
    api("/api/onboarding/orientation", { method: "POST", body: { confirm: id } });
  const orientationSave = (body) =>
    api("/api/onboarding/orientation", { method: body.id ? "PATCH" : "POST", body });

  // ---- 保存期限と削除 ----
  const retention = () => api("/api/hr/retention");
  const retentionRule = (body) => api("/api/hr/retention", { method: "PATCH", body });
  const retentionDelete = (employeeId, kind, dueOn) =>
    api("/api/hr/retention", { method: "POST",
                               body: { action: "delete", employeeId, kind, dueOn, confirm: true } });

  // ---- MF給与の取込CSV ----
  // ファイルとして落とす。画面に中身を出さない（出すと、閉じるまで残る）
  async function payrollCsv(employeeIds) {
    const token = await getToken();
    if (!token) throw new Error("未ログインです");
    const r = await fetch(`/api/hr/payroll?ids=${encodeURIComponent((employeeIds || []).join(","))}`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      const err = new Error(data.hint || data.message || data.error || `CSVを作れませんでした (${r.status})`);
      err.code = data.error || null;
      err.hint = data.hint || data.message || null;
      throw err;
    }
    const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") || "")?.[1]
      || "mf_payroll.csv";
    return { blob: await r.blob(), filename: name };
  }

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

  // ---- 共有フォルダ（Googleドライブのリンク） ----
  // 管理者がURLを貼り、本人がマイページから開く。
  // ここに貼っても権限は増えない。共有はドライブ側で行う
  const driveLinks = (all) => api(`/api/drive-links${all ? "?all=1" : ""}`);
  const addDriveLink = (link) => api("/api/drive-links", { method: "POST", body: link });
  const updateDriveLink = (link) => api("/api/drive-links", { method: "PATCH", body: link });
  const removeDriveLink = (id) =>
    api(`/api/drive-links?id=${encodeURIComponent(id)}`, { method: "DELETE" });

  // ---- 週のゴールと、その日の行動案 ----
  // 管理者が週のゴールを決め、AIが日ごとの行動に割る。
  // メンバーは案を見て「今日を始める」を押すだけ
  const weekGoals = (weekStart) =>
    api(`/api/week-goals${weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : ""}`);
  const draftWeekGoal = (employeeId, weekStart) =>
    api("/api/week-goals", { method: "POST", body: { employeeId, weekStart, ai: "draft" } });
  const saveWeekGoal = (goal) =>
    api("/api/week-goals", { method: "POST", body: goal });
  const splitWeekGoal = (employeeId, weekStart) =>
    api("/api/week-goals", { method: "POST", body: { employeeId, weekStart, split: true } });

  const dayPlan = (date) =>
    api(`/api/nippo/plan${date ? `?date=${encodeURIComponent(date)}` : ""}`);
  const startDay = (body) => api("/api/nippo/plan", { method: "POST", body });
  const rebuildNextPlan = (date) =>
    api("/api/nippo/plan", { method: "POST", body: { date, next: true } });

  // ---- メンバーのログイン情報・使えるシステム（人事権限） ----
  // 4システムは同じ auth.users を使うので、メールとパスワードは全部に効く
  const updateEmployeeAccount = (body) =>
    api("/api/employees/account", { method: "PATCH", body });

  // ---- デスクトップ通知（1日3回の声かけ） ----
  const pushConfig = () => api("/api/push");
  const pushSubscribe = (sub) => api("/api/push", { method: "POST", body: sub, invalidates: [] });
  const pushUnsubscribe = (endpoint) =>
    api(`/api/push?endpoint=${encodeURIComponent(endpoint)}`, { method: "DELETE", invalidates: [] });
  const pushRemoveDevice = (id) =>
    api(`/api/push?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  const pushPrefs = (prefs) => api("/api/push", { method: "PATCH", body: prefs });
  const pushTest = () => api("/api/push", { method: "POST", body: { test: 1 } });

  // ---- Google Drive 連携 ----
  const driveStatus = (clientId) => api(`/api/drive/status?clientId=${encodeURIComponent(clientId)}`);
  const driveSync = (clientId, limit) => api("/api/drive/sync", { method: "POST", body: { clientId, limit } });
  // 人事フォルダの設定確認（人事・管理者だけ）。
  // フォルダIDを入れただけでは動かないので、どこで止まっているかを返す
  const hrDriveCheck = () => api("/api/drive/hr-check");

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
    // 画面データの短期キャッシュ・身元の記憶・描き直し・計測（表示速度）
    swr, warm, morph, perfMark, rememberedMe, rememberMe, enterWithMe,
    mfaStatus, mfaFactors, mfaEnroll, mfaVerify, mfaUnenroll, mfaReset,
    isLoggedIn, currentEmail,
    api, me, listClients, createClient, listJournals, listDocuments,
    approveJournal, uploadAndRecognize, uploadAndProcess, reprocessDocument, documentPreviewUrl,
    deleteDocument,
    mfStatus, mfConnectUrl, trialBalance, trialBalanceAdvice,
    driveStatus, driveSync, hrDriveCheck,
    updateEmployeeAccount,
    driveLinks, addDriveLink, updateDriveLink, removeDriveLink,
    weekGoals, draftWeekGoal, saveWeekGoal, splitWeekGoal,
    dayPlan, startDay, rebuildNextPlan,
    pushConfig, pushSubscribe, pushUnsubscribe, pushRemoveDevice, pushPrefs, pushTest,
    listNotices, createNotice, updateNotice, deleteNotice, markNoticeRead,
    listEmployees, createEmployee, updateEmployee, deleteEmployee, bulkCreateEmployees,
    listPartners, createPartner, updatePartner, deletePartner,
    listSiteContracts, createSiteContract, updateSiteContract, deleteSiteContract,
    listBillingProgress, ensureBillingProgress, updateBillingProgress,
    listBillingSubmissions, issueSubmissionLink, revokeSubmissionLink, submissionFileUrl,
    submissionPreview, submitBilling,
    listHrApplicants, createHrApplicant, getHrApplicant, updateHrApplicant,
    hrDocuments, hrDocumentUrl, deleteHrDocument, uploadHrDocument,
    bulkHrApplicants, deleteHrApplicants, setHrApplicantsStatus, setHrApplicantsRecruiter,
    scheduleHrInterview, hrInterviewAct, conductHrInterview, evaluateHrInterview, updateHrInterview,
    cancelHrInterview, todayHrInterviews,
    ceoReview,
    createHrOffer, hrOfferAct, updateHrOffer, confirmHrOffer,
    issueHrOfferLink, markHrOfferSent, hrOfferPublic, hrOfferRespond,
    getHrAdvancePrefill, claimHrAdvance, hrAdvanceAct, releaseHrAdvance, completeHrAdvance,
    listSalesCompanies, listSalesCompanyPage, salesDashboard, exportSalesCompanies, createSalesCompany, importSalesCompanies, importSalesCsv, getSalesMasters, addSalesMaster, updateSalesMaster, getSalesCompany, updateSalesCompany,
    markSalesFollowed, addSalesEvent, listSalesApproaches, prepareSalesAttack, salesAttackAct,
    markSalesAttackSent, discardSalesAttack, markSalesAttackFailed, addSalesContact, listSalesTemplates, createSalesTemplate, updateSalesTemplate,
    listSalesCampaigns, createSalesCampaign, updateSalesCampaign, lookupSalesUrl, bulkSalesCompanies,
    listSalesMeetings, issueSalesMeeting, salesMeetingAct, listSalesDeals, createSalesDeal, updateSalesDeal,
    listGuests, createGuest, guestOptions, guestDetail, guestReissue, guestDisable,
    guestUpdateGrants, guestMy, guestInvitePreview, guestRegister,
    setEmployeeRole, setEmployeeApp, linkEmployeeAccount,
    settings, updateSettings,
    listNotifications, markNotificationRead, markAllNotificationsRead,
    listAssets, createAsset, updateAsset, deleteAsset,
    listSpaces, createSpace, updateSpace, deleteSpace,
    listBookings, createBooking, decideBooking, deleteBooking,
    schedule, teamSchedule, createEvent, updateEvent, deleteEvent, syncEventToGoogle,
    googleLink, googleUnlink,
    analytics, syncAnalytics, addAnalyticsSite, updateAnalyticsSite, deleteAnalyticsSite,
    nippo, submitNippo, submitMorning, saveWeeklyReview, nippoAdmin, nippoAdminAct, evaluateNippo,
    dashboard, saveKpiActuals, saveKpiTargets, actionItem, badges,
    pinAction, reorderActions, recalcActions, adoptProposals, rejectProposals,
    listBlockers, raiseBlocker, blockerAct, autonomy, setAutonomy,
    growthPlans, myGrowthPlan, growthAct,
    onboardOptions, onboardCombine, onboardPreview, onboardCreate,
    nippoFeed, nippoReact, nippoComment, nippoShareVisible,
    intakeInfo, intakeCheck, intakeApply,
    nippoWeekly, nippoWeeklyAct, nippoMonthly, nippoMonthlyAct,
    probation, probationAct,
    contracts, contractsAct, uploadContract,
    listBlocks, createBlock, updateBlock, deleteBlock,
    siteNews, createSiteNews, updateSiteNews, deleteSiteNews,
    listLibrary, createLibraryDoc, updateLibraryDoc, deleteLibraryDoc,
    libraryFileUrl, uploadLibraryFile,
    listRequests, createRequest, decideRequest, deleteRequest,
    leaveGrants, saveLeaveGrant,
    listExpenses, createExpense, decideExpense, deleteExpense,
    updateWorkflowSettings, uploadReceipt, receiptUrl, downloadExpenseCsv,
    listTemplates, createTemplate, updateTemplate, deleteTemplate,
    listTasks, createTask, updateTask, deleteTask, acceptTask, dashboardTeam,

    myTimecard, stamp, requestTimeFix, timecards, patchTimecard, downloadTimecardCsv,
    closing, patchClosing, downloadClosingCsv,
    taskList, taskDetail, taskAct,
    focus, focusAct, focusAdd, focusSelect, focusUpdate, focusCoach, focusRemove, focusCheck, focusConfirm,
    focusComplete, focusReopen, focusCarryPlan, focusCarry, taskBoard,
    memos, memoAdd, memoRemove, memoReview, memoDecide,
    hrList, hrOne, hrSoon, hrStart, hrCheck, hrUpdate,
    browserCode,
    devices, devicePeople, patchDevice, deviceEnrollments, deviceAlerts, patchDeviceAlert,
    deviceExceptions, approveDeviceException, revokeDeviceException,
    startDeviceSetup, deviceSetupState, deviceSetupPolicy,
    devicePolicy, saveDevicePolicy, downloadDeviceCsv,
    deviceWeb, myWeb, pairInfo, pairDiag, claimPair,
    myDevices, deviceBeat, confirmDevice, linkAgent, markDeviceInstalled,
    renameMyDevice, forgetMyDevice,

    signTemplates, addSignTemplate, updateSignTemplate, removeSignTemplate,
    signRequests, previewSign, sendSign, patchSign,
    seals, sealAct, uploadSealImage,
    careerList, careerDetail, careerEvidence, careerMaster, careerHistory, careerAct, careerJourney, careerApplicant, careerPreview, myCareer, myCareerSummary, myCareerAct,
    myContracts, signContract, signPdfUrl,
    docOrders, docOrderAct, docOrderFileUrl, uploadDocOrderFile, checkHrOfferMatch,
    listThreads, createThread, getThread, sendMessage, markThreadRead, threadMembers,
    openAdminContact,
    uploadMessageFile, messageFileUrl,
    askAssistant, listAiThreads, getAiThread, rateAiMessage,
    listAiInquiries, createAiInquiry, getAiInquiry, replyAiInquiry, updateAiInquiry,
    listAiKnowledge, createAiKnowledge, updateAiKnowledge,
    listProcedures, createProcedure, updateProcedure, deleteProcedure,
    addProcedureItem, updateProcedureItem, deleteProcedureItem, submitProcedureItem,
    onboardingStatus,
    myOnboarding, saveMyOnboarding, myOnboardingConsent, onboardBrief,
    orientation, orientationConfirm, orientationSave,
    retention, retentionRule, retentionDelete, payrollCsv,
    uploadProcedureFile, procedureFileUrl,
  };
})();
