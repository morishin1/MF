// GET  /api/devices/me   … 自分の端末・自分の記録・自分を見た履歴
// POST /api/devices/me   … { action, deviceUid, ... }
//        beat      画面を開いているあいだ、5分ごとに届く合図
//        confirm   告知を読んで「このパソコンです」と押した（notified_at）
//        installed アプリとして入れた
//        rename    端末の名前を変える
//        forget    自分の端末から外す（使わなくなったPC）
//
// ■ 本人が確認するまで、利用時間は数えない
//   notified_at が null のあいだ、beat は端末の「最終利用」だけ更新して、
//   日別の集計には1分も入れない。
//   入ったこと自体は残す。これはログインの記録であって、働き方の記録ではない。
//
// ■ 端末の行は、beat が来た時点で自動でできる
//   「見慣れない端末から社内システムに入られた」を拾うには、
//   登録した端末しか記録しないのでは間に合わない。
//   来た端末は全部台帳に載せて、本人に確認してもらう。
//
// ■ 自分を見た履歴を、本人が読める
//   これが無いと、この機能は片側だけが透明な仕組みになる。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  isDate, jstDate, clock, sinceLabel, deviceState, cleanUid, newDeviceUid,
  describeDevice, applyBeat, unknownDeviceAlert, timeAlerts, EVENT_LABEL, BEAT_MIN,
  sha256,
} from "../../lib/devices.js";

// 053 → 054 → 055 の順で流す。列が足りないときも同じ案内を出す
const SQL = "db/053_devices.sql → 054_device_agent.sql → 055_device_admin.sql";

// 本人の画面に出す文。
//
// ■ これは同意を取る文ではない
//
//   会社貸与PCの端末管理は、会社ルールとして行う。
//   「監視してよいですか」と許可を求める作りにはしない。
//   事前に周知し、本人が内容を確認した日時を残す。それがここ。
//
// ■ 何をしているかは隠さない。判定のしかたは出さない
//
//   記録していることと、その大分類は出す。
//   しきい値・検知条件・判定ロジックは出さない。
//   出せば、避ける方法を配ることになる。
//
//   細かい仕様は管理者・開発者向けに別に書いてある
//   （docs/device-management.md / docs/device-web-history.md）。
//   社員向けの表示と、内部の仕様書を混ぜない。
export const NOTICE = {
  title: "会社貸与パソコンの端末管理について",

  // 会社として何をしているか。ここが本文
  lead: "会社貸与PCでは、情報セキュリティ・業務管理・労務管理のため、"
      + "端末・アプリケーション・WEB・外部機器等の利用状況を記録します。"
      + "業務管理上必要のない個人情報を取得することを目的とはしていません。"
      + "詳細な取得方法・検知条件・セキュリティ判定基準については、"
      + "情報セキュリティ上の理由から公開していません。",

  // 記録する範囲。大分類だけ。
  //
  // ■ ここに書いてよいのは「実際に取っているもの」だけ
  //
  //   以前は、外部機器の接続・ソフトウェアの変更まで書いてあった。
  //   それはパソコンに入れる常駐ソフト（EXE）でしか取れないもので、
  //   いまの基本の形（グループウェア＋ブラウザ拡張）では取っていない。
  //
  //   取っていないものを「記録します」と伝えるのは、
  //   多く取るのと同じくらい良くない。信用がそこで終わる。
  //   EXE を入れた人にだけ、下の AGENT_NOTICE で足して伝える。
  //
  //   同じ理由で、WEB利用もここから外した（下の WEB_AREA）。
  //   あれはブラウザ拡張をつないだ端末でしか取れない。
  //   つないでいない人に「見たサイトを記録します」と読ませると、
  //   取っていないものを取ると言ったことになる。
  areas: [
    "グループウェアの利用状況（ログイン・最終アクセス・操作中／離席）",
    "勤怠・日報・タスクの記録",
    "セキュリティ上必要な端末情報（OS・ブラウザ・端末の識別子）",
  ],

  // 私物PCの扱い。ここは禁止事項なので、はっきり書く
  rule: "会社の業務、社内システムへのアクセス、会社データの閲覧・保存・編集は、"
      + "原則として会社貸与PCを使用してください。私物PCでの業務利用は禁止します。"
      + "やむを得ず私物PCを使う必要があるときは、事前に管理者の承認を受けてください。",

  purpose: "情報セキュリティ、業務管理、労務管理のために行うものです。"
         + "働きぶりを点数にしたり、評価に直接使ったりするためのものではありません。",

  yours: "自分の端末情報は、いつでもマイページから確認できます。"
       + "管理者があなたの端末情報を開いたときは、その記録もあなたの画面に残ります。",

  // 押す前に、これが何の操作なのかを書く。
  // 「同意しました」ではなく「周知を受けて確認しました」
  ack: "これは会社ルールの周知です。同意を求めるものではありません。"
     + "内容を確認したことと、その日時を記録します。",
};

// WEB利用は、ブラウザ拡張をつないだ端末でしか取れない。
//
// ■ つないだ端末にだけ足す
//
//   拡張を入れていない人の画面では、ここは1件も動いていない。
//   それでも「記録します」と読ませると、読んだ人は
//   見たサイトが会社に渡っていると思って毎日を過ごすことになる。
//   実際には渡っていない。取りすぎと同じくらい、これも嘘になる。
//
//   拡張をつなぐときには、つなぐ本人が押す画面（mypage.html）で
//   この中身を読んでから押す。だから、つないだあとにここへ出しても
//   「聞いていない」にはならない。
export const WEB_AREA = "WEBの利用状況（見たサイトの種類・ドメイン・見ていた時間）";

// 会社のソフト（エージェント）を入れたパソコンで、追加で伝えること。
//
// ■ これは「高度な端末管理」を選んだ会社・端末だけのもの
//
//   基本の形は、グループウェアとブラウザ拡張だけ。EXE は要らない。
//   EXE を入れると、取れるものが増える。増えるぶんは、
//   入れた人にだけ、ここで足して伝える。
//
//   違うのは範囲だけではない。「ブラウザを開いているあいだ」ではなく
//   「そのパソコンを使っているあいだ」が対象になる。
//   そこは人の受け取り方が変わるので、はっきり書く
export const AGENT_NOTICE = {
  title: "このパソコンには、会社の端末管理ソフトが入っています",
  lead: "ブラウザを開いているあいだだけでなく、"
      + "このパソコンを使っているあいだの利用状況を記録します。"
      + "上に書いたものに加えて、次のものが記録されます。",
  // EXE を入れたパソコンでだけ取れるもの。
  // 入れていない人には、この一覧そのものを出さない
  areas: [
    "アプリケーションの利用状況",
    "外部機器（USBメモリ等）の接続状況",
    "ソフトウェアの追加・削除",
    "パソコンの起動・終了・ロック",
  ],
  scope: "業務や働き方を見るために使うのは、原則として勤務時間内のぶんです。"
       + "外部機器の接続やソフトウェアの変更など、"
       + "会社貸与PCの安全管理に関わる記録は、時間外も対象です。",
  yours: "自分の端末情報は、いつでもマイページから確認できます。"
       + "管理者があなたのWEB利用を開いたときは、その記録もあなたの画面に残ります。",
};

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !ctx.employee) return json(res, 403, { error: "no_membership" });

  if (req.method === "GET") return read(req, res, ctx);
  if (req.method === "POST") return act(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読む -------------------------------------------------------------------
async function read(req, res, ctx) {
  const sb = admin();
  const q = new URL(req.url, "http://localhost").searchParams;

  const { data: devices, error } = await sb.from("gw_devices")
    .select("id, device_uid, label, source, hostname, os, os_version, browser, model, screen, "
          + "status, notified_at, installed_at, first_seen_at, last_seen_at, "
          + "linked_device_id, agent_version")
    .eq("tenant_id", ctx.tenantId)
    .eq("employee_id", ctx.employee.id)
    .neq("status", "retired")
    .order("last_seen_at", { ascending: false, nullsFirst: false });

  if (error) {
    const hint = dbSetupHint(error, SQL);
    // 本人の画面では、SQLを流せとは言わない。管理者に出す話
    if (hint) return json(res, 200, { devices: [], notice: NOTICE, notReady: true });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const ids = (devices || []).map((d) => d.id);
  const to = isDate(q.get("to")) ? q.get("to") : jstDate();
  const from = isDate(q.get("from")) ? q.get("from") : back(to, 13);

  let usage = [], events = [];
  if (ids.length) {
    const [u, e] = await Promise.all([
      sb.from("gw_device_usage")
        .select("work_date, active_min, night_min, holiday_min, beats, first_at, last_at")
        .in("device_id", ids).gte("work_date", from).lte("work_date", to)
        .order("work_date", { ascending: false }).limit(60),
      sb.from("gw_device_events").select("at, kind, detail")
        .in("device_id", ids)
        .order("at", { ascending: false }).limit(30),
    ]);
    usage = u.data || []; events = e.data || [];
  }

  // 同じ日に複数の端末を使っていれば、日ごとにまとめる
  const byDay = new Map();
  for (const u of usage) {
    const cur = byDay.get(u.work_date)
      || { date: u.work_date, activeMin: 0, nightMin: 0, holidayMin: 0, firstAt: null, lastAt: null };
    cur.activeMin += u.active_min;
    cur.nightMin += u.night_min;
    cur.holidayMin += u.holiday_min;
    if (u.first_at && (!cur.firstAt || u.first_at < cur.firstAt)) cur.firstAt = u.first_at;
    if (u.last_at && (!cur.lastAt || u.last_at > cur.lastAt)) cur.lastAt = u.last_at;
    byDay.set(u.work_date, cur);
  }

  // この人の端末で、ブラウザ拡張が実際につながっているか。
  // つながっていなければ WEB利用は1件も取れていないので、告知にも出さない。
  // 表がまだ無いときは false のまま（取れていない側に倒す）
  let hasExt = false;
  if (ids.length) {
    const { data: brs } = await sb.from("gw_device_browsers")
      .select("device_id").in("device_id", ids).eq("linked", true).limit(1);
    hasExt = Boolean(brs && brs.length);
  }

  // 誰が自分の記録を見たか
  const { data: views } = await sb.from("gw_device_views")
    .select("at, viewer_name, scope, work_date")
    .eq("employee_id", ctx.employee.id)
    .order("at", { ascending: false })
    .limit(30);

  return json(res, 200, {
    range: { from, to },
    beatSec: BEAT_MIN * 60,
    // エージェントを入れているなら、追加で記録することも読ませる。
    // 同時に、基本のほうから「もう当てはまらない行」を外す
    notice: noticeFor(devices || [], hasExt),
    agentNotice: (devices || []).some((d) => d.source === "agent") ? AGENT_NOTICE : null,
    devices: (devices || []).map((d) => ({
      id: d.id, uid: d.device_uid, label: d.label,
      source: d.source,
      hostname: d.hostname,
      os: d.os_version ? `${d.os} ${d.os_version}` : d.os,
      browser: d.browser, model: d.model, screen: d.screen,
      agentVersion: d.agent_version,
      status: d.status,
      confirmed: Boolean(d.notified_at), notifiedAt: d.notified_at,
      installed: Boolean(d.installed_at),
      linkedTo: d.linked_device_id,
      firstSeenAt: d.first_seen_at,
      lastSeen: sinceLabel(d.last_seen_at, Date.now(),
        d.source === "agent" ? "未受信" : "利用なし"),
      state: deviceState(d, {}),
    })),
    usage: [...byDay.values()].map((u) => ({ ...u, active: clock(u.activeMin) })),
    events: events.map((e) => ({
      at: e.at, kind: e.kind, label: EVENT_LABEL[e.kind] || e.kind, detail: e.detail,
    })),
    views: (views || []).map((v) => ({
      at: v.at, who: v.viewer_name || "管理者",
      what: v.scope === "csv" ? "書き出し" : v.scope === "device" ? "端末の記録" : "一覧",
    })),
  });
}

// ---- 変える -----------------------------------------------------------------
async function act(req, res, ctx, user) {
  const body = await readJson(req);
  const action = String(body.action || "");
  const sb = admin();

  if (action === "beat") return beat(req, res, ctx, sb, body);
  if (action === "link") return link(req, res, ctx, user, sb, body);

  // ブラウザの行は device_uid で、エージェントの行は id で来る。
  // エージェントの印はレジストリの中にあって、ブラウザからは見えない
  const uid = cleanUid(body.deviceUid);
  const byId = String(body.deviceId || "").trim();
  if (!uid && !byId) return json(res, 400, { error: "bad_request" });

  let q = sb.from("gw_devices")
    .select("id, tenant_id, employee_id, label, hostname, source, status, notified_at");
  q = uid ? q.eq("device_uid", uid) : q.eq("id", byId);
  const { data: dev } = await q.maybeSingle();

  // 自分の端末しか触れない。他人のぶんを確認済みにはできない
  if (!dev || dev.tenant_id !== ctx.tenantId || dev.employee_id !== ctx.employee.id) {
    return json(res, 404, { error: "not_found" });
  }

  const now = new Date().toISOString();
  const patch = { updated_at: now };
  let event = null;

  if (action === "confirm") {
    if (dev.notified_at) return json(res, 200, { ok: true, notifiedAt: dev.notified_at });
    patch.notified_at = now;
    // 確認して、はじめて台帳の「使っている端末」になる
    if (dev.status === "unconfirmed") patch.status = "active";
    event = "confirmed";
  } else if (action === "installed") {
    patch.installed_at = now;
    event = "installed";
  } else if (action === "rename") {
    const label = String(body.label || "").trim().slice(0, 60);
    if (!label) return json(res, 400, { error: "bad_request" });
    patch.label = label;
    event = "renamed";
  } else if (action === "forget") {
    // 本人が端末を台帳から外すことはできない。
    //
    // 端末管理は会社ルールとして行うもので、拒否して解除する仕組みは作らない。
    // 自分で外せると、私物や未登録のパソコンで入ったあと
    // 行を消して見えなくする、という道ができてしまう。
    //
    // 使わなくなったパソコンは、返却のときに管理者が外す
    return json(res, 403, {
      error: "not_allowed",
      hint: "端末は管理者が台帳から外します。使わなくなったパソコンは管理部にご連絡ください",
    });
  } else {
    return json(res, 400, { error: "bad_action" });
  }

  const { error } = await sb.from("gw_devices").update(patch).eq("id", dev.id);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  if (event) {
    await sb.from("gw_device_events").insert({
      tenant_id: ctx.tenantId, device_id: dev.id,
      work_date: jstDate(), at: now, kind: event,
      detail: event === "renamed" ? { name: patch.label } : {},
    });
  }
  if (action === "confirm") {
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id,
                  action: `device.${action}`, target: dev.id,
                  detail: { label: patch.label || dev.label, source: dev.source } });
  }
  return json(res, 200, { ok: true, notifiedAt: patch.notified_at || dev.notified_at });
}

// ---- つなぐ -----------------------------------------------------------------
/**
 * エージェントを入れたパソコンと、いま開いているブラウザをつなぐ。
 *
 * エージェントは登録のあと、既定のブラウザで
 *   /device-consent.html?link=<合言葉>
 * を開く。本人がログインした状態でそこを開けば、
 *   ・そのパソコンは「この人のパソコン」になる
 *   ・そのブラウザの行から、そのパソコンを指せる
 * つまり、人事が名簿から割り当てなくても、本人が入れた時点で持ち主が決まる。
 *
 * ■ 合言葉は1回きり
 *   使ったら消す。エージェントのログに残っていても、2回目は通らない。
 *
 * ■ つないだだけでは収集は始まらない
 *   このあと本人が「このパソコンです」を押して notified_at が入る。
 *   押させる画面へ誘導するために、ここでは何を記録するかを返す。
 */
async function link(req, res, ctx, user, sb, body) {
  const code = String(body.linkCode || "").trim();
  if (!code) return json(res, 400, { error: "bad_request" });

  const { data: agent } = await sb.from("gw_devices")
    .select("id, tenant_id, employee_id, hostname, label, status, notified_at, link_expires_at")
    .eq("link_code_hash", sha256(code))
    .eq("source", "agent")
    .maybeSingle();

  // 「無い」「期限切れ」を言い分けない
  const dead = !agent || agent.tenant_id !== ctx.tenantId
    || (agent.link_expires_at && Date.parse(agent.link_expires_at) < Date.now());
  if (dead) {
    return json(res, 400, { error: "invalid_link", message: "この案内は使えません" });
  }

  const now = new Date().toISOString();

  // このパソコンは、いまログインしている人のものになる。
  // 合言葉は使い切る
  await sb.from("gw_devices").update({
    employee_id: ctx.employee.id,
    link_code_hash: null,
    link_expires_at: null,
    updated_at: now,
  }).eq("id", agent.id);

  // いま開いているブラウザの行から、このパソコンを指す
  const uid = cleanUid(body.deviceUid);
  if (uid) {
    await sb.from("gw_devices")
      .update({ linked_device_id: agent.id, updated_at: now })
      .eq("device_uid", uid)
      .eq("tenant_id", ctx.tenantId)
      .eq("employee_id", ctx.employee.id);
  }

  await sb.from("gw_device_events").insert({
    tenant_id: ctx.tenantId, device_id: agent.id,
    work_date: jstDate(), at: now, kind: "linked",
    detail: { name: agent.hostname || agent.label },
  });

  await gwLog({ tenantId: ctx.tenantId, actorId: user.id,
                action: "device.linked", target: agent.id,
                detail: { hostname: agent.hostname } });

  return json(res, 200, {
    ok: true,
    device: {
      id: agent.id,
      hostname: agent.hostname || agent.label,
      confirmed: Boolean(agent.notified_at),
    },
  });
}

// ---- 合図 -------------------------------------------------------------------
/**
 * 画面を開いているあいだ、5分ごとに届く。
 *
 * ここが端末の入口でもある。はじめての端末なら、この時点で台帳に載る。
 */
async function beat(req, res, ctx, sb, body) {
  const uid = cleanUid(body.deviceUid) || newDeviceUid();
  const now = new Date();
  const nowIso = now.toISOString();
  const info = describeDevice({ ...(body.hints || {}), userAgent: req.headers["user-agent"] });

  const { data: found, error } = await sb.from("gw_devices")
    .select("id, tenant_id, employee_id, label, status, notified_at, last_seen_at")
    .eq("device_uid", uid).maybeSingle();

  if (error) {
    const hint = dbSetupHint(error, SQL);
    // 表がまだ無くても、画面は動かす。合図は捨ててよい
    if (hint) return json(res, 200, { ok: false, notReady: true });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  let dev = found;
  let first = false;

  if (!dev) {
    const { data, error: e2 } = await sb.from("gw_devices").insert({
      tenant_id: ctx.tenantId,
      device_uid: uid,
      employee_id: ctx.employee.id,
      label: info.label,
      os: info.os, os_version: info.osVersion, browser: info.browser,
      model: info.model, screen: info.screen, user_agent: info.userAgent,
      status: "unconfirmed",
      first_seen_at: nowIso, last_seen_at: nowIso,
    }).select("id, employee_id, label, status, notified_at").single();
    if (e2) {
      console.error("[devices/me] beat insert", e2);
      return json(res, 500, { error: "server_error" });
    }
    dev = { ...data, tenant_id: ctx.tenantId };
    first = true;

    await sb.from("gw_device_events").insert({
      tenant_id: ctx.tenantId, device_id: dev.id,
      work_date: jstDate(now), at: nowIso, kind: "first_seen",
      detail: { os: info.os, browser: info.browser },
    });

    // 見慣れない端末。その人が既に別の端末を使っていたときだけ
    const { count } = await sb.from("gw_devices")
      .select("id", { count: "exact", head: true })
      .eq("employee_id", ctx.employee.id).neq("id", dev.id);
    const alert = unknownDeviceAlert({ ...dev, device_uid: uid, ...info },
      { known: count || 0, policy: await policyOf(sb, ctx.tenantId), at: now });
    if (alert) await raise(sb, ctx.tenantId, dev.id, [alert]);
  } else if (dev.employee_id !== ctx.employee.id) {
    // 同じブラウザで別の人がログインした。共用PCではよくある。
    // 端末を付け替えず、その人の端末として別に作る……のではなく、
    // 端末は端末として持ち、いま使っている人に付け替える。
    // 「誰の端末か」は最後に使った人で足りる
    await sb.from("gw_devices")
      .update({ employee_id: ctx.employee.id, notified_at: null, status: "unconfirmed",
                last_seen_at: nowIso, updated_at: nowIso })
      .eq("id", dev.id);
    return json(res, 200, { ok: true, deviceUid: uid, confirmed: false, changedHands: true });
  }

  if (dev.status === "retired" || dev.status === "suspended") {
    return json(res, 200, { ok: true, deviceUid: uid, confirmed: false, status: dev.status });
  }

  await sb.from("gw_devices")
    .update({ last_seen_at: nowIso, updated_at: nowIso }).eq("id", dev.id);

  // この合図は「そのブラウザを使っている」という意味でもある。
  // 拡張が入っているはずなのに、拡張からだけ届かないなら、そこを記録しておく
  await markExtGap(sb, dev, nowIso);

  // ここが要。本人が確認するまで、利用時間は1分も数えない
  if (!dev.notified_at) {
    return json(res, 200, { ok: true, deviceUid: uid, confirmed: false, first });
  }

  const policy = await policyOf(sb, ctx.tenantId);
  const workDate = jstDate(now);
  const { data: prev } = await sb.from("gw_device_usage")
    .select("active_min, night_min, holiday_min, beats, first_at, last_at")
    .eq("device_id", dev.id).eq("work_date", workDate).maybeSingle();

  const u = applyBeat(prev, now, policy);
  await sb.from("gw_device_usage").upsert({
    tenant_id: ctx.tenantId, device_id: dev.id, employee_id: ctx.employee.id,
    work_date: u.workDate,
    active_min: u.activeMin, night_min: u.nightMin, holiday_min: u.holidayMin,
    beats: u.beats, first_at: u.firstAt, last_at: u.lastAt, updated_at: nowIso,
  }, { onConflict: "device_id,work_date" });

  // 深夜・休日。閾値をまたいだところで1件だけ作られる（dedupe_key に任せる）
  const alerts = timeAlerts(u, { policy, label: dev.label });
  if (alerts.length) await raise(sb, ctx.tenantId, dev.id, alerts);

  return json(res, 200, {
    ok: true, deviceUid: uid, confirmed: true,
    today: { activeMin: u.activeMin, active: clock(u.activeMin) },
  });
}

// ---- 拡張が外れていないか ----------------------------------------------------
/** 拡張から最近届いていると見なす時間（分）。拡張は1分ごとに送る */
const EXT_FRESH_MIN = 10;

/**
 * 「グループウェアは使っているのに、拡張からは届かない」を、続いた時間で見る。
 *
 * ■ その場の一瞬で判断すると、誤検知する
 *
 *   合図は来ているのに拡張からは届かない、という状態は、
 *   外していなくても普通に起きる。
 *
 *     ・ブラウザを立ち上げ直した直後（拡張がまだ1回も送っていない）
 *     ・拡張の自動更新中
 *     ・拡張が落ちて、すぐ上がった
 *
 *   その瞬間を見て × にすると、毎日どこかの誰かが赤くなる。
 *   赤が日常になると、本当に外した人が埋もれる。
 *
 * ■ だから「いつから続いているか」だけを置く
 *
 *   合図が来るたびに（画面から5分おき）
 *     拡張から最近届いている → 消す
 *     しばらく届いていない   → 空なら立てる（立っていれば、そのまま触らない）
 *
 *   × にするかどうかは、ここでは決めない。見る側（lib/watch.js）が決める。
 *   立ち上げ直しや更新なら、次の合図までに拡張が送ってきて消える。
 *
 * ■ ここで落ちても、合図そのものは通す
 *
 *   067 をまだ流していない環境で、画面の心臓が止まるほうが困る
 */
async function markExtGap(sb, dev, nowIso) {
  try {
    const { data: row, error } = await sb.from("gw_devices")
      .select("installed_at, ext_missing_since").eq("id", dev.id).maybeSingle();
    if (error || !row) return;

    // 一度も登録していないブラウザは、そもそも外れようがない。
    // ここを「未接続（△）」と混ぜない
    if (!row.installed_at) {
      if (row.ext_missing_since) {
        await sb.from("gw_devices").update({ ext_missing_since: null }).eq("id", dev.id);
      }
      return;
    }

    const { data: brs } = await sb.from("gw_device_browsers")
      .select("last_seen_at").eq("device_id", dev.id).limit(10);
    const last = (brs || []).map((b) => b.last_seen_at).filter(Boolean).sort().pop();
    const fresh = last
      && (Date.parse(nowIso) - Date.parse(last)) <= EXT_FRESH_MIN * 60000;

    if (fresh) {
      // 届いている。立っていたら下ろす
      if (row.ext_missing_since) {
        await sb.from("gw_devices").update({ ext_missing_since: null }).eq("id", dev.id);
      }
      return;
    }

    // 合図そのものが途切れていたなら、ブラウザを閉じていた。
    // 開き直した直後は、拡張がまだ1回も送っていないのが普通なので、
    // 前に立てた時刻をそのまま引き継ぐと、開いた瞬間に × になる。
    // 閉じていたぶんは数えない ＝ ここで時計を引き直す
    const gap = !dev.last_seen_at
      || (Date.parse(nowIso) - Date.parse(dev.last_seen_at)) > EXT_FRESH_MIN * 60000;

    // 届いていない。すでに立っているなら「いつから」を上書きしない
    if (!row.ext_missing_since || gap) {
      await sb.from("gw_devices").update({ ext_missing_since: nowIso }).eq("id", dev.id);
    }
  } catch (e) {
    console.error("[devices/me] extGap", e?.message || e);
  }
}

// ---- 小物 -------------------------------------------------------------------
async function policyOf(sb, tenantId) {
  const { data } = await sb.from("gw_device_policies")
    .select("night_from, night_to, unknown_alert, night_alert, "
          + "night_min_minutes, holiday_min_minutes, stale_days")
    .eq("tenant_id", tenantId).maybeSingle();
  return data || {};
}

/** アラートを立てる。ここで落ちても、合図そのものは成功にする */
async function raise(sb, tenantId, deviceId, alerts) {
  try {
    await sb.from("gw_device_alerts").upsert(
      alerts.map((a) => ({
        tenant_id: tenantId, device_id: deviceId,
        severity: a.severity, rule: a.rule, title: a.title,
        detail: a.detail || {}, occurred_at: a.occurredAt, dedupe_key: a.dedupeKey,
      })),
      { onConflict: "device_id,dedupe_key", ignoreDuplicates: true },
    );
  } catch (e) {
    console.error("[devices/me] alert", e?.message || e);
  }
}

/**
 * その人に出す文を組み立てる。
 *
 * 大分類は、ソフトが入っていても入っていなくても同じ。
 * 違うのは「どこまでが対象か」だけなので、そこだけ足す。
 *
 * 行を出し分けて「取っていません」と書いたものを実は取っている、
 * という作りにはしない。だから引き算をやめて、範囲の一文だけを変える
 */
function noticeFor(devices, hasExt) {
  const hasAgent = devices.some((d) => d.source === "agent");
  return {
    ...NOTICE,
    // 取れている端末にだけ足す。取れていない端末には出さない。
    //
    // 見ているのは拡張がつながっているかどうかだけで、EXE の有無では変えない。
    // WEB利用を送っているのは拡張であって EXE ではないからで、
    // EXE を入れたパソコンにも拡張は入る（入れば、ここも自然に出る）。
    // EXE で増えるぶんは、混ぜずに AGENT_NOTICE で別に伝える
    areas: hasExt ? [...NOTICE.areas, WEB_AREA] : [...NOTICE.areas],
    scope: hasAgent
      ? "このパソコンには会社の端末管理ソフトが入っています。"
        + "ブラウザを開いているあいだだけでなく、このパソコンを使っているあいだが対象です。"
      : "この画面だけの場合、対象は社内システムを開いているあいだです。",
  };
}

function back(dateStr, n) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
}
