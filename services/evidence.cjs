'use strict';
const dns = require('node:dns/promises');
const net = require('node:net');
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { extractDocument } = require('./attachments.cjs');
const blocked = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32]]) blocked.addSubnet(address, prefix, 'ipv6');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
function publicAddress(address) {
  const family = net.isIP(address);
  if (!family || (family === 6 && !globalV6.check(address, 'ipv6'))) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
function publicUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw new Error('Blocked URL');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(hostname) || (net.isIP(hostname) && !publicAddress(hostname))) throw new Error('Blocked host');
  url.hash = '';
  return url;
}
async function readPublic(raw, { signal, timeoutMs = 12000, redirects = 0, lookup = dns.lookup } = {}) {
  if (signal?.aborted) throw Object.assign(new Error('Canceled'), { code: 'ABORTED' });
  if (redirects > 4) throw new Error('Too many redirects');
  const url = publicUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let timer;
  const addresses = await Promise.race([lookup(hostname, { all: true, verbatim: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), Math.min(timeoutMs, 5000)); })]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Blocked DNS');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal, headers: { 'User-Agent': 'YESorNOT-Research/1.0', Accept: 'text/html,application/pdf,text/plain,application/json' },
      lookup: (_name, options, callback) => options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
    }, response => {
      if ([301,302,303,307,308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location) return reject(new Error('Missing redirect'));
        readPublic(new URL(response.headers.location, url).href, { signal, timeoutMs, redirects: redirects + 1, lookup }).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Source unavailable')); return; }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) response.destroy(new Error('Source too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ url: url.href, contentType: String(response.headers['content-type'] || ''), buffer: Buffer.concat(chunks) }));
    });
    const deadline = setTimeout(() => request.destroy(new Error('Source timeout')), Math.min(timeoutMs, 20000));
    request.on('error', reject);
    request.on('close', () => clearTimeout(deadline));
  });
}
function decodeSource(buffer, contentType) {
  // A BOM identifies Unicode bytes even when a server advertises a legacy charset.
  let bom;
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) bom = 'utf-8';
  else if (buffer[0] === 0xff && buffer[1] === 0xfe) bom = 'utf-16le';
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) bom = 'utf-16be';
  const charset = value => {
    const match = value.match(/\bcharset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;>"']+))/i);
    return (match?.[1] || match?.[2] || match?.[3] || '').trim();
  };
  // ASCII declarations can be inspected without first decoding the document body.
  const head = buffer.subarray(0, 4096).toString('latin1').replace(/<!--[\s\S]*?-->/g, '');
  const declarations = [...head.matchAll(/<meta\b[^>]*>/gi)].map(match => charset(match[0]));
  const candidates = bom ? [bom] : [charset(contentType), ...declarations, 'utf-8', 'euc-kr'];
  for (let encoding of [...new Set(candidates.filter(Boolean))]) {
    if (/^(?:cp-?949|ms-?949|uhc)$/i.test(encoding)) encoding = 'windows-949';
    let text;
    try {
      // Fatal decoding prevents silently accepting replacement-filled evidence.
      text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
    } catch { continue; }
    if ((text.match(/\uFFFD/g) || []).length >= 3) throw new Error('Corrupted source');
    return text;
  }
  throw new Error('Unreadable source encoding');
}
function htmlText(value) {
  const clean = value.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  // Prefer the semantic article body so font controls and surrounding menus stay out.
  const start = clean.match(/<([a-z][a-z0-9]*)\b[^>]*\bitemprop\s*=\s*(?:"articleBody"|'articleBody'|articleBody(?=\s|>))[^>]*>/i) || clean.match(/<(article|main)\b[^>]*>/i);
  let body = clean;
  if (start) {
    const tags = new RegExp('<\\/?' + start[1] + '\\b[^>]*>', 'gi');
    const offset = start.index + start[0].length;
    tags.lastIndex = offset;
    let depth = 1, tag;
    while ((tag = tags.exec(clean))) {
      if (tag[0].startsWith('</')) depth--;
      else if (!tag[0].endsWith('/>')) depth++;
      if (!depth) { body = clean.slice(offset, tag.index); break; }
    }
  }
  const entities = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…', middot: '·', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
  return body.replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/?(?:p|div|section|article|main|h[1-6]|ul|ol|li|blockquote|table|tr)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|nbsp|amp|lt|gt|quot|apos|hellip|middot|ndash|mdash|lsquo|rsquo|ldquo|rdquo);/gi, (_all, entity) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()];
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    })
    .replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function verifySources(sources, { signal, timeoutMs = 12000, read = readPublic } = {}) {
  const result = new Array(sources.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
    while (cursor < sources.length) {
      const index = cursor++, source = sources[index];
      if (signal?.aborted) throw Object.assign(new Error('자료 조사가 취소되었습니다.'), { code: 'ABORTED' });
      let directory;
      try {
        const response = await read(source.url, { signal, timeoutMs: Math.min(timeoutMs, 12000) });
        let text;
        if (/application\/pdf/i.test(response.contentType) || response.buffer.subarray(0,5).toString() === '%PDF-') {
          directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yesornot-source-'));
          const file = path.join(directory, 'source.pdf');
          await fs.writeFile(file, response.buffer);
          const document = await extractDocument(file);
          text = document.text;
        } else if (/text\/|json|xml/i.test(response.contentType)) text = htmlText(decodeSource(response.buffer, response.contentType));
        if (!text || text.length < 80 || (text.match(/\uFFFD/g) || []).length >= 3) throw new Error('Unreadable source');
        const originalExcerpt = String(source.excerpt || '').slice(0, 1600);
        result[index] = { ...source, verification: 'retrieved', retrievedAt: new Date().toISOString(), finalUrl: response.url,
          excerpt: '[직접 수집한 원문 일부 · 주장 일치 여부는 토론에서 검토]\n' + text.slice(0, 1600) + '\n[조사 모델의 요약]\n' + originalExcerpt };
      } catch (error) {
        if (signal?.aborted) throw Object.assign(new Error('자료 조사가 취소되었습니다.'), { code: 'ABORTED' });
        result[index] = { ...source, verification: source.verification === 'search-result' ? 'search-result' : 'unavailable', retrievalError: '원문에 접근하지 못했거나 읽을 수 있는 텍스트가 없습니다.' };
      } finally { if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
    }
  }));
  return result;
}
module.exports = { publicAddress, publicUrl, readPublic, verifySources, htmlText };
