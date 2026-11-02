'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runProcess, cleanEnvironment } = require('./cli.cjs');
const { publicUrl } = require('./evidence.cjs');

// Sites named in the question are read with ego browser (a real, script-running browser),
// so pages built by JavaScript are captured the way a person sees them.
const EGO_DOWNLOAD_URL = 'https://lite.ego.app/ko';
const MAX_SITES = 5;
const MAX_PAGES_PER_SITE = 5;
const PAGE_TEXT_LIMIT = 30000;
const FILE_EXTENSIONS = /^(?:pdf|docx?|xlsx?|pptx?|hwpx?|txt|md|csv|tsv|json|xml|html?|png|jpe?g|gif|svg|webp|zip|exe|msi|js|cjs|mjs|ts|py|java|cs|css|log|bin|yml|yaml)$/i;

function egoRequired() {
  return Object.assign(new Error('질문에 웹사이트 주소가 있습니다. 사이트 내용을 직접 확인하려면 ego 브라우저가 필요합니다. 연결 설정에서 ego 브라우저를 설치한 뒤 다시 시작해 주세요.'), { code: 'EGO_REQUIRED' });
}

// Full URLs and bare domains such as devcare.co.kr. File names (report.pdf) and e-mail addresses are ignored.
function findSiteUrls(texts) {
  const found = new Map();
  const add = raw => {
    let candidate = raw.replace(/[.,;:!?)\]}'"」』>]+$/u, '');
    if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate;
    try {
      const url = publicUrl(candidate);
      url.hash = '';
      const host = url.hostname.toLowerCase();
      const tld = host.split('.').at(-1);
      if (!host.includes('.') || FILE_EXTENSIONS.test(tld) || !/[a-z]/.test(tld) || tld.length < 2) return;
      if (!found.has(url.href) && found.size < MAX_SITES) found.set(url.href, url.href);
    } catch { /* not a public web address */ }
  };
  for (const text of texts) {
    const value = String(text || '');
    for (const match of value.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) add(match[0]);
    const withoutUrls = value.replace(/https?:\/\/[^\s<>"'`]+/giu, ' ');
    for (const match of withoutUrls.matchAll(/(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s<>"'`]*)?/giu)) add(match[0]);
  }
  return [...found.values()];
}

function findEgo(env = process.env) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  if (env.USERPROFILE) dirs.push(path.join(env.USERPROFILE, '.local', 'share', 'ego', 'active_version_dir'));
  for (const dir of dirs) {
    const file = path.join(dir.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'ego-browser.exe' : 'ego-browser');
    try { if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}

async function inspectEgo({ env = process.env, run = runProcess } = {}) {
  const base = { id: 'ego', name: 'ego 브라우저', installed: false, authenticated: null, version: '' };
  const binary = findEgo(env);
  if (!binary) return { ...base, message: '질문에 사이트 주소가 있으면 ego 브라우저로 본문을 직접 확인합니다. 설치가 필요합니다.' };
  try {
    const result = await run(binary, ['skill'], { env: cleanEnvironment(env), timeoutMs: 20000 });
    const version = /usage guide v([\w.-]+)/.exec(result.stdout)?.[1] || '';
    const ready = result.exitCode === 0 && /end of guide/.test(result.stdout);
    return { ...base, installed: true, authenticated: ready, version: version ? 'v' + version : '',
      message: ready ? '질문에 들어 있는 사이트를 ego 브라우저로 열어 본문을 직접 확인합니다.' : 'ego lite 앱을 한 번 열어 첫 실행 안내를 마쳐 주세요.' };
  } catch {
    return { ...base, installed: true, authenticated: false, message: 'ego 브라우저를 실행하지 못했습니다. ego lite 앱을 열어 첫 실행 안내를 마친 뒤 다시 확인해 주세요.' };
  }
}

// The script runs inside ego browser's Node runtime. URLs are embedded as a JSON literal.
function buildScript(urls, { taskName, maxPages = MAX_PAGES_PER_SITE, textLimit = PAGE_TEXT_LIMIT } = {}) {
  return `
const urls = ${JSON.stringify(urls)};
const limit = ${Number(textLimit)}, maxPages = ${Number(maxPages)};
const important = /(pricing|price|plan|요금|가격|비용|terms|약관|policy|정책|privacy|about|회사|소개|service|서비스|범위|team|팀|faq|contact|문의|company)/i;
const task = await taskSpace(${JSON.stringify(taskName)});
const page = task.page("p1");
const sites = [];
const read = async (target) => {
  await page.goto(target);
  try { await page.waitForLoadState("load", { timeout: 20000 }); } catch {}
  await page.waitForTimeout(1500);
  return await page.evaluate((max) => ({
    url: location.href, title: document.title || "",
    text: (document.body ? document.body.innerText : "").replace(/[ \\t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").slice(0, max),
    links: [...document.querySelectorAll("a[href]")].map((a) => ({ text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 60), href: a.href }))
      .filter((l) => { try { const u = new URL(l.href); return u.origin === location.origin && u.pathname !== location.pathname; } catch { return false; } }),
  }), limit);
};
try {
  for (const start of urls) {
    const site = { start, pages: [], errors: [] };
    try {
      const first = await read(start);
      site.pages.push({ url: first.url, title: first.title, text: first.text });
      const seen = new Set([first.url.split("#")[0]]);
      const next = [];
      for (const link of first.links) {
        const href = link.href.split("#")[0];
        if (seen.has(href) || next.some((item) => item.href === href)) continue;
        if (important.test(link.text + " " + href)) next.push({ href });
      }
      for (const item of next.slice(0, maxPages - 1)) {
        try { const sub = await read(item.href); site.pages.push({ url: sub.url, title: sub.title, text: sub.text }); }
        catch (error) { site.errors.push(item.href + ": " + String(error && error.message || error).slice(0, 200)); }
      }
    } catch (error) { site.errors.push(start + ": " + String(error && error.message || error).slice(0, 200)); }
    sites.push(site);
  }
} finally { await task.finish({ keep: [] }); }
console.log("EGO_RESULT " + JSON.stringify(sites));
`;
}

async function readSites(urls, { egoPath = findEgo(), signal, timeoutMs = 300000, run = runProcess } = {}) {
  if (!egoPath) throw egoRequired();
  const script = buildScript(urls, { taskName: `yesornot-${Date.now()}` });
  // The script goes through stdin: Windows argument quoting would damage non-ASCII text.
  const result = await run(egoPath, ['nodejs'], { env: cleanEnvironment(), input: script, signal, timeoutMs, maxOutputBytes: 12 * 1024 * 1024 });
  // ego-browser prints script console output on stderr when its stdout is a pipe.
  const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).reverse().find(row => row.startsWith('EGO_RESULT '));
  if (result.exitCode !== 0 || !line) throw Object.assign(new Error('ego 브라우저로 사이트를 읽지 못했습니다. ego lite 앱이 실행 중인지 확인해 주세요.'), { code: 'EGO_FAILED' });
  const sites = JSON.parse(line.slice('EGO_RESULT '.length));
  if (!Array.isArray(sites)) throw Object.assign(new Error('ego 브라우저 결과 형식이 올바르지 않습니다.'), { code: 'EGO_FAILED' });
  return sites.map(site => ({
    start: String(site?.start || ''),
    pages: (Array.isArray(site?.pages) ? site.pages : []).filter(item => typeof item?.url === 'string' && typeof item.text === 'string')
      .map(item => ({ url: item.url.slice(0, 2048), title: String(item.title || '').slice(0, 400), text: item.text.slice(0, PAGE_TEXT_LIMIT) })),
    errors: (Array.isArray(site?.errors) ? site.errors : []).map(String).map(text => text.slice(0, 400)),
  }));
}

module.exports = { EGO_DOWNLOAD_URL, findSiteUrls, findEgo, inspectEgo, readSites, buildScript, egoRequired };
