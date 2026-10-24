import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// The only mock is the database SDK: real route, HTTP helpers and HMAC verifier run.
// No credentials and no network are used.
let dbTouches = 0;
globalThis.__verificationRouteDb = { from() {
  dbTouches++;
  return { select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: null, error: null }; } };
} };
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@supabase/supabase-js") return { url: "data:text/javascript,export function createClient(){return globalThis.__verificationRouteDb}", shortCircuit: true };
  return nextResolve(specifier, context);
} });
Object.assign(process.env, { VERCEL_ENV: "production", MUGENDOJO_VERIFY_RUN_ID: "11111111-1111-4111-a111-111111111111",
  MUGENDOJO_VERIFY_OWNER_USER_ID: "22222222-2222-4222-a222-222222222222",
  HR_LEAD_TENANT_ID: "33333333-3333-4333-a333-333333333333",
  MUGENDOJO_VERIFY_RECIPIENT: "approved@example.invalid", MUGENDOJO_LEAD_SECRET: "x".repeat(40),
  SUPABASE_URL: "https://unused.invalid", SUPABASE_ANON_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test" });
const { default: handler } = await import("../api/hr/leads-verification.js");
const { signLeadRequest } = await import("../lib/hr-leads.js");
const body = { verification: true, runId: process.env.MUGENDOJO_VERIFY_RUN_ID,
  ownerUserId: process.env.MUGENDOJO_VERIFY_OWNER_USER_ID, recipient: process.env.MUGENDOJO_VERIFY_RECIPIENT };
const timestamp = String(Math.floor(Date.now() / 1000));
const signed = (data = body, ts = timestamp, key = process.env.MUGENDOJO_LEAD_SECRET) => ({
  "x-lead-timestamp": ts, "x-lead-signature": signLeadRequest(key, ts, data),
});
async function request(method, data, headers = {}) {
  const res = { statusCode: null, setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await handler({ method, body: data, headers }, res); return res;
}
assert.equal((await request("GET", body)).statusCode, 405);
assert.equal((await request("POST", body)).statusCode, 401);
assert.equal((await request("POST", body, signed(body, timestamp, "wrong"))).statusCode, 401);
assert.equal((await request("POST", { ...body, recipient: "tampered@example.invalid" }, signed())).statusCode, 401);
assert.equal((await request("POST", body, signed(body, "1000000000"))).statusCode, 401);
assert.equal(dbTouches, 0);
process.env.VERCEL_ENV = "preview";
assert.equal((await request("POST", body, signed())).statusCode, 503);
assert.equal(dbTouches, 0);
process.env.VERCEL_ENV = "production";
const validSignedNonOwner = await request("POST", body, signed());
assert.equal(validSignedNonOwner.statusCode, 403);
assert.deepEqual(validSignedNonOwner.body, { ok: false, error: "forbidden" });
assert.equal(dbTouches, 1);
console.log("7 route checks passed: method, unsigned, wrong secret, tampering, expiry, Preview and non-owner");
