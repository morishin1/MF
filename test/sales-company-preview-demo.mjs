import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {meetingPreviewDemoAllowed,meetingPreviewDemoEmail,MEETING_DEMO_HOURS,newMeetingPreviewPassword} from "../lib/sales-company-demo-preview.js";
const api=readFileSync(new URL("../api/sales/company-portal.js",import.meta.url),"utf8");
const ui=readFileSync(new URL("../js/sales-company-meeting-credentials.js",import.meta.url),"utf8");

test("contactless demo login can be created ONLY in explicitly-enabled matching preview",()=>{
 const env={VERCEL_ENV:"preview",ENGER_PORTAL_DEMO_ENABLED:"true",
   ENGER_PORTAL_BASE_URL:"https://enger-lp-git-feat-business-preview-company-abc-eight-s-projects.vercel.app"};
 assert.equal(meetingPreviewDemoAllowed(env),true);
 assert.equal(meetingPreviewDemoAllowed({...env,VERCEL_ENV:"production"}),false);
 assert.equal(meetingPreviewDemoAllowed({...env,ENGER_PORTAL_DEMO_ENABLED:"false"}),false);
 assert.equal(meetingPreviewDemoAllowed({...env,ENGER_PORTAL_BASE_URL:"https://enger.jp"}),false);
 assert.equal(meetingPreviewDemoAllowed({...env,ENGER_PORTAL_BASE_URL:"https://evil.example.com"}),false);
 assert.equal(meetingPreviewDemoAllowed({...env,ENGER_PORTAL_BASE_URL:"http://enger.test.vercel.app"}),false);
});
test("demo auth email is owned by company groupware and unique to corporate uuid",()=>{
 const id="5fa673dd-2fbf-476b-bb1c-76c8117fddd6";
 assert.equal(meetingPreviewDemoEmail(id),"company-demo+5fa673dd2fbf476bbb1c76c8117fddd6@gw.8grp.co.jp");
 assert.equal(meetingPreviewDemoEmail("notuuid"),null);
 assert.equal(MEETING_DEMO_HOURS,24);
});
test("no real company member/password is rewritten, demo role never becomes real business",()=>{
 assert.match(api,/if\(rows\.data\?\.length\)/);
 assert.match(api,/meetingPreviewDemoAllowed\(\)/);
 assert.match(api,/newTemporaryPassword\(\)/);
 assert.match(api,/apps:\["business_preview"\]/);
 assert.match(api,/meeting_demo_expires_at:expiresAt/);
 assert.match(api,/member\.temp_password/);
 assert.match(api,/previewOnly:true/);
 assert.match(api,/isInternalEmail\(db,v\.value\.email\)/);
 assert.match(api,/canManageProposals\(ctx\)/);
 assert.match(api,/directory\.data\.needs_contact_review\|\|directory\.data\.directory_hidden_at/);
 assert.match(ui,/action:"ensure_meeting_account"/);
 assert.match(ui,/社内プレビュー専用/);
 assert.doesNotMatch(ui,/localStorage|sessionStorage/);
});

test("new preview passwords are 8 characters from a cryptographically selected alphabet",()=>{
 const generated=Array.from({length:40},()=>newMeetingPreviewPassword());
 assert.ok(generated.every(p=>p.length===8));
 assert.ok(generated.every(p=>/[A-Z]/.test(p)&&/[a-z]/.test(p)&&/[0-9]/.test(p)&&/[!@]/.test(p)));
 assert.ok(new Set(generated).size>35);
});
test("an existing demo may be rotated only by explicit manager action, never by opening modal",()=>{
 assert.match(api,/body\.action==="rotate_meeting_demo_password"/);
 assert.match(api,/meetingPreviewDemoAllowed\(\)/);
 assert.match(api,/body\.confirmed!==true/);
 assert.match(api,/meta\.apps\.length!==1\|\|meta\.apps\[0\]!=="business_preview"/);
 assert.match(api,/getUserById/);
 assert.match(api,/updateUserById/);
 assert.match(api,/newMeetingPreviewPassword\(\)/);
 assert.match(ui,/rotate_meeting_demo_password/);
 assert.match(ui,/if\(!confirm\("プレビュー専用アカウント/);
 assert.match(ui,/password\.length!==8/);
});
