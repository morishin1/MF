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

// 本人の画面に出す文。ここが本文で、就業規則の写しではない。
// 就業規則に書いてあることを、読める言葉にして見せる
export const NOTICE = {
  title: "会社のパソコンで記録していること",
  takes: [
    "この端末から社内システム（このサイト）に入ったこと",
    "その端末の種類（Windows／Mac、ブラウザの名前、画面の大きさ）",
    "社内システムを開いていた時間の、1日の合計",
    "そのうち深夜・休日にあたる時間",
  ],
  never: [
    "キーボードで打った内容",
    "パスワード",
    "メールやチャットの本文",
    "画面の録画・スクリーンショット",
    "社内システム以外で見たページ",
    "パソコンに入っているソフト、USBメモリ、ファイル",
    "パソコンの電源が入っていた時間",
  ],
  // 会社のソフトを入れたパソコンでは、この3つは当てはまらなくなる。
  // 入れている人には、下の AGENT_NOTICE に置き換えて出す。
  // 「取っていません」と書いてあるものを実は取っている、が起きないようにする
  replacedByAgent: [
    "社内システム以外で見たページ",
    "パソコンに入っているソフト、USBメモリ、ファイル",
    "パソコンの電源が入っていた時間",
  ],
  why: "会社のパソコン以外から社内の情報が見られていないかを確かめるためのものです。"
     + "働きぶりを点数にしたり、評価に使ったりはしません。"
     + "深夜や休日の利用を見ているのは、働きすぎに気づくためです。",
  how: "この画面だけの場合、分かるのは画面を開いているあいだのことだけです。"
     + "ブラウザを閉じているあいだ、パソコンが何をしていたかは分かりません。",
  yours: "自分の記録は、いつでもこの画面で見られます。"
       + "管理者があなたの記録を開いたときは、それもこの画面に残ります。",
};

// 会社のソフト（エージェント）を入れたパソコンで、追加で記録すること。
// 上の NOTICE に足して読ませる。入れていない人には出さない
export const AGENT_NOTICE = {
  title: "このパソコンに入れた会社のソフトで、追加で記録していること",
  takes: [
    "パソコンの起動・終了・ログオン・ロック・スリープの時刻",
    "1日の稼働時間と、離席していた時間",
    "使ったソフトの名前と、その合計時間",
    "見たサイトの種類（業務・調べもの・SNS など）と合計時間",
    "USBメモリをつないだこと、ソフトを入れたこと",
  ],
  never: [
    "キーボードで打った内容",
    "パスワード",
    "メールやチャットの本文",
    "画面の録画・スクリーンショット",
    "開いていた画面のタイトル",
    "見たページのURL（種類だけにして送ります）",
    "ファイルの中身",
  ],
  why: "会社のパソコンから、お客様の情報が外に出ていないかを確かめるためのものです。"
     + "URLは、パソコンの中で種類に置き換えてから送ります。"
     + "アドレスそのものは会社に届きません。",
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
    notice: noticeFor(devices || []),
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
    // 使わなくなったPC。台帳からは消さず、使用終了にする。
    // 消すと「その端末から入っていた」記録まで消える
    patch.status = "retired";
    patch.retired_at = now;
    event = "forgotten";
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
  if (action === "confirm" || action === "forget") {
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
 * その人に出す告知を組み立てる。
 *
 * 会社のソフトを入れたパソコンがあるなら、基本のほうから
 * 「もう当てはまらない行」を外す。
 * 「取っていません」と書いてあるものを実は取っている、が起きてはいけない。
 */
function noticeFor(devices) {
  const hasAgent = devices.some((d) => d.source === "agent");
  if (!hasAgent) return NOTICE;
  const drop = new Set(NOTICE.replacedByAgent);
  return {
    ...NOTICE,
    never: NOTICE.never.filter((s) => !drop.has(s)),
    how: "このパソコンには会社のソフトが入っています。下の「追加で記録していること」も"
       + "あわせて読んでください。ソフトが入っていない端末では、"
       + "分かるのはこの画面を開いているあいだのことだけです。",
  };
}

function back(dateStr, n) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
}
