// 偽の Supabase（メモリ上の表）。/api/office/* の書き込みまで通すためのもの。
//
// ■ 実DBの何を真似しているか
//   ・select / insert / update / upsert / delete と、eq・neq・in・lt・lte・gt・gte・is・order・limit・single・maybeSingle
//   ・一意制約（23505）・NOT NULL（23502）・CHECK（23514）：表ごとに、SQL と同じ条件を書いて渡す
//   ・date 列の比較に、実在しない日付（2026-09-31）を渡したら 22008 で落とす（test/_pgdate.mjs）
//   ・表が無い（PGRST205）／列が無い（42703）状態の再現（missing）
//   ・RLS：userClient は、表ごとの読み取り可否（rls）を通す。書き込みは、ポリシーが無いので、すべて拒否（42501）
//     → API が、書き込みに userClient を使ったら、テストが落ちる（本物の DB でも落ちる）
//   ・Storage：置く・読む・消す・署名付きURL。state.storageFail を立てると、消すのが失敗する
//   ・外部キー（on delete cascade／set null）：createMemDb({ fks }) で、親の表ごとに渡す。親の行を消すと、子も（再帰で）消える／外れる

import crypto from "node:crypto";
import { pgDateError } from "./_pgdate.mjs";

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export function createMemDb({ schema = {}, rls = () => true, missing = null, fks = {} } = {}) {
  const rows = {};                       // 表名 → 行の配列
  const state = { missing, log: [], storageFail: null };    // log … 書いた操作（表・種類・行数）／storageFail … Storage の削除を失敗させる（メッセージ）
  const storageFiles = new Map();        // "bucket/path" → Buffer
  const uploadUrls = [];
  const removed = [];
  const signed = [];

  const tableRows = (name) => (rows[name] ||= []);
  // 親の行を消したときの、子の行の扱い（外部キー）。fks = { 親の表: [{ table, col, action: "cascade" | "setnull" }] }
  function removeRows(name, hits) {
    if (!hits.length) return;
    rows[name] = tableRows(name).filter((r) => !hits.includes(r));
    const ids = new Set(hits.map((r) => r.id));
    for (const fk of fks[name] || []) {
      const kids = tableRows(fk.table).filter((k) => ids.has(k[fk.col]));
      if (!kids.length) continue;
      if (fk.action === "cascade") { removeRows(fk.table, kids); state.log.push({ table: fk.table, op: "cascade", n: kids.length }); }
      else for (const k of kids) k[fk.col] = null;
    }
  }
  const sc = (name) => schema[name] || {};

  function makeClient({ asUser, who }) {
    function from(name) {
      const f = [];
      let cols = null, head = false, wantCount = false, order = null, lim = null;
      let op = "select";
      let payload = null, upsertOn = null, returning = false, one = null;

      const dbErr = () => {
        if (state.missing && (state.missing === name || state.missing.table === name)) {
          const m = state.missing;
          if (m.column) return { code: "42703", message: `column ${name}.${m.column} does not exist` };
          return { code: "PGRST205", message: `Could not find the table '${name}' in the schema cache` };
        }
        return pgDateError(f);
      };
      const match = (r) => f.every(([o, k, v]) => {
        const x = r[k];
        if (o === "eq") return x === v;
        if (o === "neq") return x !== v;
        if (o === "in") return v.includes(x);
        if (o === "lt") return x < v;
        if (o === "lte") return x <= v;
        if (o === "gt") return x > v;
        if (o === "gte") return x >= v;
        if (o === "is") return v === null ? (x === null || x === undefined) : x === v;
        return true;
      });
      const project = (r) => (cols ? Object.fromEntries(cols.map((c) => [c, clone(r[c]) ?? null])) : clone(r));

      const finish = (out) => {
        if (one === "single") {
          if (out.error) return out;
          const a = out.data || [];
          if (a.length !== 1) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
          return { data: a[0], error: null };
        }
        if (one === "maybe") {
          if (out.error) return out;
          const a = out.data || [];
          if (a.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows returned" } };
          return { data: a[0] ?? null, error: null };
        }
        return out;
      };

      const checkRow = (r) => {
        const s = sc(name);
        for (const c of s.required || []) if (r[c] === null || r[c] === undefined) return { code: "23502", message: `null value in column "${c}" of relation "${name}" violates not-null constraint` };
        const bad = s.check ? s.check(r) : null;
        if (bad) return { code: "23514", message: `new row for relation "${name}" violates check constraint: ${bad}` };
        return null;
      };
      const uniqueClash = (r, ignore) => {
        for (const cols2 of sc(name).unique || []) {
          const hit = tableRows(name).find((x) => x !== ignore && cols2.every((c) => x[c] === r[c] && r[c] !== null && r[c] !== undefined));
          if (hit) return { code: "23505", message: `duplicate key value violates unique constraint on (${cols2.join(",")})`, hit };
        }
        return null;
      };
      const withDefaults = (r) => {
        const d = sc(name).defaults ? sc(name).defaults() : {};
        const out = { ...d, ...r };
        if (out.id === undefined && !sc(name).noId) out.id = crypto.randomUUID();
        return out;
      };

      const run = () => {
        const e = dbErr();
        if (e) return { data: null, error: e };
        if (op !== "select") {
          if (asUser) return { data: null, error: { code: "42501", message: `new row violates row-level security policy for table "${name}"` } };
        } else if (asUser && !rls(name, who)) {
          return { data: head ? null : [], error: null, count: wantCount ? 0 : undefined };
        }

        if (op === "select") {
          let out = tableRows(name).filter(match);
          if (order) out = [...out].sort((a, b) => (a[order.col] < b[order.col] ? -1 : a[order.col] > b[order.col] ? 1 : 0) * (order.asc ? 1 : -1));
          if (lim) out = out.slice(0, lim);
          const res = { data: head ? null : out.map(project), error: null };
          if (wantCount) res.count = out.length;
          return res;
        }

        if (op === "insert" || op === "upsert") {
          const list = (Array.isArray(payload) ? payload : [payload]).map((r) => withDefaults(clone(r)));
          const inserted = [];
          const staged = [];
          for (const r of list) {
            const ce = checkRow(r);
            if (ce) return { data: null, error: ce };
            const clash = uniqueClash(r, null);
            if (clash && op === "insert") return { data: null, error: { code: clash.code, message: clash.message } };
            if (clash && op === "upsert") {
              const onCols = String(upsertOn || "").split(",").map((s) => s.trim()).filter(Boolean);
              const hit = clash.hit;
              if (!onCols.length || !onCols.every((c) => hit[c] === r[c])) return { data: null, error: { code: clash.code, message: clash.message } };
              staged.push({ update: hit, r });
            } else staged.push({ insert: r });
          }
          for (const s of staged) {
            if (s.insert) { tableRows(name).push(s.insert); inserted.push(s.insert); }
            else { const keepId = s.update.id; Object.assign(s.update, s.r, { id: keepId }); inserted.push(s.update); }
          }
          state.log.push({ table: name, op, n: list.length });
          return { data: returning ? inserted.map(project) : null, error: null };
        }

        if (op === "update") {
          const hits = tableRows(name).filter(match);
          const next = [];
          for (const r of hits) {
            const merged = { ...r, ...clone(payload) };
            const ce = checkRow(merged);
            if (ce) return { data: null, error: ce };
            const clash = uniqueClash(merged, r);
            if (clash) return { data: null, error: { code: clash.code, message: clash.message } };
            next.push([r, merged]);
          }
          for (const [r, m] of next) Object.assign(r, m);
          state.log.push({ table: name, op, n: hits.length });
          return { data: returning ? hits.map(project) : null, error: null };
        }

        if (op === "delete") {
          const hits = tableRows(name).filter(match);
          removeRows(name, hits);
          state.log.push({ table: name, op, n: hits.length });
          return { data: returning ? hits.map(project) : null, error: null };
        }
        return { data: null, error: { message: "unsupported" } };
      };

      const q = {
        select(c, opts) {
          if (op === "select") {
            cols = c === "*" || !c ? null : c.split(",").map((s) => s.trim());
            head = !!opts?.head; wantCount = opts?.count === "exact";
          } else { returning = true; cols = c === "*" || !c ? null : c.split(",").map((s) => s.trim()); }
          return q;
        },
        insert(p) { op = "insert"; payload = p; return q; },
        upsert(p, o) { op = "upsert"; payload = p; upsertOn = o?.onConflict; return q; },
        update(p) { op = "update"; payload = p; return q; },
        delete() { op = "delete"; return q; },
        eq(k, v) { f.push(["eq", k, v]); return q; },
        neq(k, v) { f.push(["neq", k, v]); return q; },
        in(k, v) { f.push(["in", k, v]); return q; },
        lt(k, v) { f.push(["lt", k, v]); return q; },
        lte(k, v) { f.push(["lte", k, v]); return q; },
        gt(k, v) { f.push(["gt", k, v]); return q; },
        gte(k, v) { f.push(["gte", k, v]); return q; },
        is(k, v) { f.push(["is", k, v]); return q; },
        order(col, o) { order = { col, asc: o?.ascending !== false }; return q; },
        limit(n) { lim = n; return q; },
        single() { one = "single"; return q; },
        maybeSingle() { one = "maybe"; return q; },
        then: (fn, rej) => Promise.resolve(finish(run())).then(fn, rej),
      };
      return q;
    }
    return { from, storage: storageApi() };
  }

  function storageApi() {
    return {
      from: (bucket) => ({
        createSignedUploadUrl: async (path) => {
          uploadUrls.push({ bucket, path });
          return { data: { signedUrl: `https://storage.example/upload/${bucket}/${path}?t=1`, token: "tok" }, error: null };
        },
        createSignedUrl: async (path, ttl) => {
          signed.push({ bucket, path, ttl });
          if (!storageFiles.has(`${bucket}/${path}`)) return { data: null, error: { message: "Object not found" } };
          return { data: { signedUrl: `https://storage.example/${bucket}/${path}?token=t` }, error: null };
        },
        download: async (path) => {
          const b = storageFiles.get(`${bucket}/${path}`);
          if (!b) return { data: null, error: { message: "Object not found" } };
          return { data: { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }, error: null };
        },
        remove: async (paths) => {
          if (state.onStorageRemove) state.onStorageRemove(paths);     // 消す時点の DB の様子を見るための口（順番の検査用）
          if (state.storageFail) return { data: null, error: { message: state.storageFail } };
          for (const p of paths) { storageFiles.delete(`${bucket}/${p}`); removed.push({ bucket, path: p }); }
          return { data: paths, error: null };
        },
      }),
    };
  }

  return {
    rows, state, storageFiles, uploadUrls, removed, signed,
    admin: () => makeClient({ asUser: false, who: null }),
    userClient: (who) => makeClient({ asUser: true, who }),
    put: (bucket, path, buf) => storageFiles.set(`${bucket}/${path}`, Buffer.from(buf)),
    reset() { for (const k of Object.keys(rows)) delete rows[k]; storageFiles.clear(); uploadUrls.length = 0; removed.length = 0; signed.length = 0; state.log.length = 0; state.missing = null; state.storageFail = null; state.onStorageRemove = null; },
  };
}
