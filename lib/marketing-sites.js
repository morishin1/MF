// 動画を各サイトへ実際に載せる仕組み（アダプタ）。いまは1つも接続していない。
//
// アダプタの形：{ publish({ tenantId, videoId, position, title, description }) → Promise<{ ok, url?, error? }> }
// 接続するときは、そのサイトの承認（書き込みの口・鍵・CSP 等）を得てから、ここへ足す。
// 足していないサイトは api/marketing が「未対応」と返し、記録（gw_marketing_video_placements）も作らない。
export const SITE_ADAPTERS = Object.freeze({});

export function adapterFor(site) {
  return Object.prototype.hasOwnProperty.call(SITE_ADAPTERS, site) ? SITE_ADAPTERS[site] : null;
}
