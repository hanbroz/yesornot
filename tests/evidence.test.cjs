'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicAddress, publicUrl, readPublic, verifySources, htmlText } = require('../services/evidence.cjs');

test('source requests reject local addresses, credentials, nonweb schemes and private DNS before network', async () => {
  for (const address of ['127.0.0.1','10.0.1.1','172.16.1.1','192.168.0.1','169.254.169.254','100.100.100.200','::1','fe80::1','fd00::1','::ffff:127.0.0.1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  for (const url of ['file:///c:/secret','http://localhost','http://foo.local','https://127.0.0.1','https://user:password@example.com','https://example.com:8080']) assert.throws(() => publicUrl(url));
  await assert.rejects(readPublic('https://example.com', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }), /Blocked DNS/);
});
test('source retrieval labels original text honestly and keeps provider proof when access fails', async () => {
  const rows = await verifySources([
    {url:'https://example.com/read',excerpt:'조사 모델의 요약'},
    {url:'https://example.com/proven',verification:'search-result'},
    {url:'https://example.com/invented'},
  ], {read:async url => {
    if (!url.endsWith('/read')) throw new Error('unavailable secret');
    return {url,contentType:'text/html',buffer:Buffer.from('<script>secret()</script><p>' + '공개 원문 근거 '.repeat(30) + '</p>')};
  }});
  assert.deepEqual(rows.map(row=>row.verification),['retrieved','search-result','unavailable']);
  assert.match(rows[0].excerpt,/직접 수집한 원문/);
  assert.match(rows[0].excerpt.slice(0,600),/공개 원문 근거/);
  assert.ok(rows[0].excerpt.indexOf('공개 원문 근거') < rows[0].excerpt.indexOf('조사 모델의 요약'));
  assert.equal(htmlText('<header>menu</header><main><p>article evidence</p></main><footer>privacy</footer>'),'article evidence');
  assert.doesNotMatch(JSON.stringify(rows),/secret/);
  assert.equal(htmlText('<style>bad</style>&lt;ok&gt; &amp; &#54620;'),'\u003cok\u003e & 한');
});
test('source verification honors cancellation before reading and never labels unreadable HTML retrieved', async () => {
  const controller=new AbortController();controller.abort();
  await assert.rejects(verifySources([{url:'https://example.com'}],{signal:controller.signal,read:async()=>{throw new Error('must not run');}}),{code:'ABORTED'});
  const [row]=await verifySources([{url:'https://example.com'}],{read:async()=>({contentType:'text/html',buffer:Buffer.from('blocked')})});
  assert.equal(row.verification,'unavailable');
});

// Synthetic Korean news bytes in Windows-949, shared by EUC-KR news sites.
const koreanNews = 'HD현대일렉트릭 실적 성장 뉴스';
const legacyNews = Buffer.from('4844c7f6b4ebc0cfb7bac6aeb8af20bdc7c0fb20bcbac0e520b4babdba', 'hex');
async function verifyNews(buffer, contentType = 'text/html') {
  const [row] = await verifySources([{ url: 'https://example.com/news', excerpt: '별도 조사 요약', verification: 'search-result' }], {
    read: async url => ({ url, contentType, buffer }),
  });
  return row;
}
test('Korean news respects HTTP charset, HTML declarations and undeclared legacy bytes', async () => {
  for (const [head, contentType] of [
    ['', 'text/html; charset=EUC-KR'],
    ['', 'text/html; charset="windows-949"'],
    ['', 'text/html; charset=cp949'],
    ["<meta charset='euc-kr'>", 'text/html'],
    ['<meta content="text/html; charset=ks_c_5601-1987" http-equiv="Content-Type">', 'text/html'],
    ["<meta charset='euc-kr'>", 'text/html; charset=utf-8'],
    ['', 'text/html'],
  ]) {
    const buffer = Buffer.concat([Buffer.from(head + '<article>'), ...Array(8).fill(legacyNews), Buffer.from('</article>')]);
    const row = await verifyNews(buffer, contentType);
    assert.equal(row.verification, 'retrieved', contentType + head);
    assert.ok(row.excerpt.includes(koreanNews), contentType + head);
    assert.doesNotMatch(row.excerpt, /\uFFFD/);
    assert.ok(row.excerpt.includes('별도 조사 요약'));
  }
});
test('UTF-8 and Unicode BOM news remain readable', async () => {
  const html = '<article>' + koreanNews.repeat(8) + '</article>';
  for (const [buffer, contentType] of [
    [Buffer.from(html), 'text/html; charset=utf-8'],
    [Buffer.from(html), 'text/html'],
    [Buffer.from('\uFEFF' + html), 'text/html; charset=euc-kr'],
    [Buffer.from('\uFEFF' + html, 'utf16le'), 'text/html'],
    [Buffer.from('\uFEFF' + html, 'utf16le').swap16(), 'text/html'],
  ]) {
    const row = await verifyNews(buffer, contentType);
    assert.equal(row.verification, 'retrieved');
    assert.ok(row.excerpt.includes(koreanNews));
    assert.doesNotMatch(row.excerpt, /\uFFFD/);
  }
});
test('invalid or already corrupted news bytes never become retrieved evidence', async () => {
  for (const buffer of [Buffer.alloc(120, 0xff), Buffer.from('<article>' + '\uFFFD'.repeat(100) + '</article>'), Buffer.from('<article>' + '&#65533;'.repeat(100) + '</article>')]) {
    const row = await verifyNews(buffer);
    assert.equal(row.verification, 'search-result');
    assert.equal(row.excerpt, '별도 조사 요약');
    assert.ok(row.retrievalError);
  }
});

test('HTML extraction preserves article paragraphs and readable news punctuation', () => {
  assert.equal(htmlText('<article><h1>기사 제목</h1><p>첫 문단은 26.2배입니다.</p><p>다음 문단입니다.<br>줄바꿈입니다.</p></article>'), '기사 제목\n\n첫 문단은 26.2배입니다.\n\n다음 문단입니다.\n줄바꿈입니다.');
  assert.equal(htmlText('<main>실적&hellip; 환율&middot;가치 &#xD55C;&#xAE00;</main>'), '실적… 환율·가치 한글');
  assert.equal(htmlText('<article><div>글자 크기조절</div><div itemprop="articleBody"><p>실제 본문입니다.</p><div><p>인용 문단입니다.</p></div><p>마지막 조건입니다.</p></div><p>관련 기사</p></article>'), '실제 본문입니다.\n\n인용 문단입니다.\n\n마지막 조건입니다.');
});
