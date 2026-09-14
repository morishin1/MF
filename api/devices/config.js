// GET /api/devices/config
//   エージェントが起動時と6時間ごとに読む。
//
// ■ 本人が告知を読むまで collect:false
//   notified_at が null のあいだ、エージェントは何も送らない。
//   就業規則への明記と本人への周知が済んでいない状態で入れても、
//   データは溜まらない。これは建前ではなく、仕組みでそうしてある。
//
// ■ カテゴリ表はここから配る
//   URL→カテゴリの変換は端末の中でやる。サーバに送ってから落とすと、
//   送信経路とログに一度は全文が乗る。だから表のほうを配る。
//
// ■ 消せという命令も、ここから渡す
//   管理者が「端末を削除」を押すと、資格情報はその場で失効する。
//   失効した端末が使える口は、この config と /api/devices/wiped だけ。
//   ここで uninstall:true を返し、エージェントが自分を消す。
//   オフラインのPCは、次につながったときにこれを受け取る。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { requireDevice } from "../../lib/device-auth.js";
import { DEFAULT_SITES } from "../../lib/devices.js";

const SQL = "db/054_device_agent.sql";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  // 失効した端末も通す。ここは、そのPCが自分を消すための口でもある
  const dev = await requireDevice(req, res, { allowRevoked: true });
  if (!dev) return;

  const sb = admin();

  // 削除の指示が出ている。ほかの何より先に返す。
  //
  // ここでは会社の設定（カテゴリ表・勤務時間）を一切返さない。
  // 手元に無いPC（紛失）でも、この口だけは開いているため。
  // 渡してよいのは「消せ」という一言だけ
  if (dev.wipe_requested_at && !dev.wipe_done_at) {
    return json(res, 200, {
      collect: false, reason: "wipe", uninstall: true,
      message: "このパソコンの登録は解除されました。EIGHT Agent を削除します",
      recheckSec: 600,
    });
  }

  // 失効しているが、消せとは言われていない（紛失として止めた）。
  // 記録は受け取らない。命令が出たら次に取りにきたときに渡る
  if (dev.revoked_at) {
    return json(res, 200, {
      collect: false, reason: "revoked",
      message: "このパソコンの資格情報は失効しています",
      recheckSec: 3600,
    });
  }

  // 止まっている理由まで返す。エージェントのログを読む人が分かるように。
  // 「本人がまだ確認していない」と「管理者が止めた」は別のこと
  if (dev.status === "suspended") {
    return json(res, 200, {
      collect: false, reason: "suspended",
      message: "このパソコンは管理者が停止しています",
      recheckSec: 3600,
    });
  }
  if (!dev.notified_at) {
    return json(res, 200, {
      collect: false, reason: "not_notified",
      message: "使う方が告知を確認するまで、記録は取りません",
      recheckSec: 3600,
    });
  }

  const { data: p } = await sb
    .from("gw_device_policies")
    .select("blocked_software, site_categories, night_from, night_to, idle_after_min, "
          + "send_interval_sec, usb_alert, night_alert")
    .eq("tenant_id", dev.tenant_id)
    .maybeSingle();

  // ポリシーの行がまだ無くても動く。既定値で回す
  return json(res, 200, {
    collect: true,
    sendIntervalSec: p?.send_interval_sec ?? 300,
    idleAfterMin: p?.idle_after_min ?? 5,
    nightFrom: p?.night_from ?? "22:00",
    nightTo: p?.night_to ?? "05:00",
    // 端末側で URL をこれに当てて、カテゴリだけ送る
    siteCategories: { ...DEFAULT_SITES, ...(p?.site_categories || {}) },
    // 判定はサーバでやる。端末に渡すのは、送るものを決めるためだけ
    watchInstalls: true,
    watchUsb: p?.usb_alert !== false,
    // 取ってはいけないもの。エージェント側の実装でも二重に止める
    never: ["keystrokes", "clipboard", "screenshots", "window_titles", "full_urls", "file_contents"],
    recheckSec: 6 * 3600,
  });
}
