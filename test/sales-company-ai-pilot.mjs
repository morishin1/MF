import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANY_AI_PILOT, pilotFor, isPublicIpv4,
  safePilotUrl, extractVisibleText, relevantOfficialLinks } from '../lib/sales-company-ai-pilot.js';

test('exactly ten fixed company IDs and no duplicates', () => {
  assert.equal(COMPANY_AI_PILOT.length, 10);
  assert.equal(new Set(COMPANY_AI_PILOT.map(x=>x.companyId)).size,10);
  assert.equal(pilotFor('25c79209-3caf-4072-b0fd-b30d77a3247c'),null);
});
test('pilot rejects non-HTTPS URLs, other domains, ports and credentials', () => {
  assert.ok(safePilotUrl('https://www.socialwire.net/', 'socialwire.net'));
  assert.equal(safePilotUrl('http://www.socialwire.net/', 'socialwire.net'),null);
  assert.equal(safePilotUrl('https://socialwire.net.evil.example/', 'socialwire.net'),null);
  assert.equal(safePilotUrl('https://socialwire.net:444/', 'socialwire.net'),null);
  assert.equal(safePilotUrl('https://alice:secret@socialwire.net/', 'socialwire.net'),null);
  assert.equal(safePilotUrl('https://127.0.0.1/', 'socialwire.net'),null);
});
test('site download prevents private and special-use IPv4 access', () => {
  for (const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254',
    '0.0.0.0','100.64.1.1','198.18.0.3','198.51.100.9','203.0.113.12','224.1.1.1']) {
    assert.equal(isPublicIpv4(ip),false,ip);
  }
  assert.equal(isPublicIpv4('8.8.8.8'),true);
  assert.equal(isPublicIpv4('1.1.1.1'),true);
  assert.equal(isPublicIpv4('::1'),false);
});
test('removes webpage scripts and hidden navigation before sending text to AI', () => {
  const text=extractVisibleText('<html><nav>非公開</nav><script>SECRET_TOKEN</script><h1>事業</h1><p>受託開発&amp;クラウド</p></html>');
  assert.equal(text.includes('SECRET_TOKEN'),false);
  assert.equal(text.includes('非公開'),false);
  assert.ok(text.includes('受託開発&クラウド'));
});
test('relevant site pages must stay on the official host', () => {
  const html='<a href="/business">事業内容</a><a href="https://evil.example/recruit">採用</a><a href="/recruit">採用案内</a>';
  assert.deepEqual(relevantOfficialLinks(html,'https://socialwire.net/','socialwire.net'),[
    'https://socialwire.net/business','https://socialwire.net/recruit'
  ]);
});
