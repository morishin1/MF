import test from 'node:test';
import assert from 'node:assert/strict';
import {mailConfig,sendMail,transportEnv} from '../lib/mail/index.js';

const both={
 MAIL_PROVIDER:'smtp',MAIL_SEND_ENABLED:'1',SALES_MAIL_ENABLED:'1',
 SALES_MAIL_FROM:'ENGER <sales@example.jp>',
 SALES_SMTP_HOST:'sales.smtp.example.jp',SALES_SMTP_PORT:'465',
 SALES_SMTP_USER:'sales@example.jp',SALES_SMTP_PASS:'sales-pass',
 SMTP_HOST:'hr.smtp.example.jp',SMTP_PORT:'465',SMTP_SECURE:'1',
 SMTP_USER:'hr@example.jp',SMTP_PASS:'hr-pass',HR_ONBOARDING_FROM:'hr@example.jp',
};
test('portal mail selects Sales SMTP, never HR',async()=>{
  assert.equal(mailConfig('portal',both).configured,true);
  let called=0;
  const r=await sendMail({purpose:'portal',to:'customer@example.com',subject:'案内',text:'本文'},{
    env:both,smtpSendImpl:async(c,m)=>{
      called++;
      assert.equal(c.host,'sales.smtp.example.jp');
      assert.equal(c.user,'sales@example.jp');
      assert.equal(c.pass,'sales-pass');
      assert.equal(m.from,'ENGER <sales@example.jp>');
      return {id:'portal-1'};
    }
  });
  assert.equal(r.status,'sent');assert.equal(called,1);
});
test('missing Sales SMTP and mismatched sender block mail, no HR fallback',async()=>{
  for(const env of [
    {...both,SALES_SMTP_PASS:''},
    {...both,SALES_SMTP_USER:'different@example.jp'},
    {...both,SALES_MAIL_ENABLED:'0'},
  ]){
    assert.equal(mailConfig('portal',env).configured,false);
    let called=false;
    const r=await sendMail({purpose:'portal',to:'customer@example.com',subject:'案内',text:'本文'},{
      env,smtpSendImpl:async()=>{called=true;return {id:'x'};}
    });
    assert.equal(r.status,'skipped');assert.equal(called,false);
  }
});
test('HR mail continues to use only generic SMTP',async()=>{
  assert.equal(mailConfig('onboarding',both).configured,true);
  let called=0;
  const r=await sendMail({purpose:'onboarding',to:'worker@example.com',subject:'案内',text:'本文'},{
    env:both,smtpSendImpl:async(c,m)=>{
      called++;assert.equal(c.host,'hr.smtp.example.jp');assert.equal(c.user,'hr@example.jp');return {id:'hr-1'};
    }
  });
  assert.equal(r.status,'sent');assert.equal(called,1);
});
test('other adapter behavior untouched',()=>{
  assert.equal(transportEnv('onboarding','smtp',both),both);
  assert.equal(transportEnv('portal','resend',both),both);
  assert.equal(transportEnv('portal','smtp',both).SMTP_USER,'sales@example.jp');
});
