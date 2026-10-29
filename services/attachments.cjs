'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { runProcess, cleanEnvironment } = require('./cli.cjs');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_CHARS = 12000;
const MAX_TOTAL_CHARS = 36000;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.html', '.htm', '.xml', '.tsv', '.log']);
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx']);
const TRUNCATION = '\n[첨부 자료 길이 제한으로 이후 내용이 생략되었습니다.]';

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function bounded(text, limit) { return text.length > limit ? text.slice(0, Math.max(0, limit - TRUNCATION.length)) + TRUNCATION : text; }

function decodeText(buffer) {
  let bytes = buffer;
  let encoding = 'utf-8';
  if (buffer[0] === 0xff && buffer[1] === 0xfe) { bytes = buffer.subarray(2); encoding = 'utf-16le'; }
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) { bytes = buffer.subarray(2); encoding = 'utf-16be'; }
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw failure('ATTACHMENT_ENCODING', '텍스트 파일을 읽을 수 없습니다. UTF-8 또는 UTF-16 형식으로 저장해 주세요.'); }
  const controls = (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || []).length;
  if (text.includes('\0') || controls > Math.max(2, text.length * 0.01)) throw failure('ATTACHMENT_BINARY', '텍스트로 읽을 수 없는 파일입니다. 지원하는 문서 형식으로 첨부해 주세요.');
  return text;
}

function markupText(text) {
  return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, value) => {
      const number = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : ' ';
    }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_match, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name]);
}

async function extractDocument(file, { processRunner = runProcess, pythonCommand = process.env.YESORNOT_PYTHON || 'python' } = {}) {
  let result;
  try {
    result = await processRunner(pythonCommand, ['-I', '-X', 'utf8', path.join(__dirname, 'extract_document.py'), file], {
      env: { ...cleanEnvironment(), PYTHONIOENCODING: 'utf-8' }, timeoutMs: 30000, maxOutputBytes: 200000,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') throw failure('ATTACHMENT_PYTHON_REQUIRED', 'PDF·Word·Excel 자료를 읽으려면 로컬 Python이 필요합니다. Python을 설치하거나 내용을 텍스트로 첨부해 주세요.');
    throw failure('ATTACHMENT_EXTRACTION_FAILED', '문서 읽기에 실패했거나 제한 시간을 초과했습니다. 텍스트 파일로 변환해 다시 첨부해 주세요.');
  }
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw failure('ATTACHMENT_EXTRACTION_FAILED', '문서의 텍스트를 읽을 수 없습니다. 텍스트 파일로 변환해 다시 첨부해 주세요.'); }
  if (result.exitCode !== 0 || !value?.ok) {
    const messages = {
      PDF_LIBRARY_REQUIRED: 'PDF 읽기에 필요한 Python pypdf가 없습니다. pypdf를 설치하거나 내용을 텍스트로 첨부해 주세요.',
      PDF_OCR_REQUIRED: '이 PDF에서 읽을 수 있는 텍스트가 없습니다. 이미지 PDF는 OCR 처리 후 첨부해 주세요.',
      PDF_ENCRYPTED: '암호로 보호된 PDF입니다. 암호를 해제한 사본을 첨부해 주세요.',
      DOCUMENT_UNSAFE: '문서의 압축 해제 크기 또는 구조가 허용 범위를 초과합니다. 필요한 내용을 텍스트로 첨부해 주세요.',
    };
    throw failure('ATTACHMENT_EXTRACTION_FAILED', messages[value?.code] || '문서의 텍스트를 읽을 수 없습니다. 문서 형식을 확인하거나 텍스트로 첨부해 주세요.');
  }
  if (typeof value.text !== 'string' || value.text.length > 20000) throw failure('ATTACHMENT_EXTRACTION_FAILED', '문서 추출 응답 형식이 올바르지 않습니다.');
  return { text: value.text, truncated: value.truncated === true, warning: typeof value.warning === 'string' ? value.warning.slice(0, 700) : undefined };
}

function createAttachmentService({ chooseFiles, extract = extractDocument } = {}) {
  if (typeof chooseFiles !== 'function') throw new TypeError('chooseFiles is required');
  const documents = new Map();
  function validateIds(ids) {
    if (!Array.isArray(ids) || ids.length > 5 || ids.some(id => typeof id !== 'string' || !documents.has(id))) throw failure('INVALID_ATTACHMENTS', '첨부 자료를 다시 선택해 주세요. 한 번에 최대 5개를 사용할 수 있습니다.');
    return [...new Set(ids)];
  }
  const metadata = doc => ({ id: doc.id, name: doc.name, size: doc.size, chars: doc.text.length, truncated: doc.truncated, ...(doc.warning ? { warning: doc.warning } : {}) });
  return {
    async pick() {
      const files = await chooseFiles();
      if (!Array.isArray(files) || files.length > 5) throw failure('ATTACHMENT_LIMIT', '첨부 자료는 최대 5개까지 선택할 수 있습니다.');
      const unique = [...new Set(files)];
      if (!unique.length) return [];
      let totalBytes = 0;
      const selected = [];
      for (const file of unique) {
        if (typeof file !== 'string' || !path.isAbsolute(file)) throw failure('INVALID_ATTACHMENTS', '선택한 파일을 확인할 수 없습니다. 다시 선택해 주세요.');
        const extension = path.extname(file).toLowerCase();
        if (!TEXT_EXTENSIONS.has(extension) && !DOCUMENT_EXTENSIONS.has(extension)) throw failure('ATTACHMENT_UNSUPPORTED', '지원 형식은 TXT, MD, CSV, JSON, HTML, XML, TSV, LOG, PDF, DOCX, XLSX입니다.');
        let handle;
        let data;
        let size;
        try {
          handle = await fs.open(file, 'r');
          const stat = await handle.stat();
          if (!stat.isFile()) throw failure('INVALID_ATTACHMENTS', '일반 파일만 첨부할 수 있습니다.');
          size = stat.size;
          totalBytes += size;
          if (size > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) throw failure('ATTACHMENT_SIZE_LIMIT', '파일은 각각 5MB, 한 번에 총 10MB까지 첨부할 수 있습니다.');
          if (TEXT_EXTENSIONS.has(extension)) {
            data = Buffer.alloc(size + 1);
            let bytesRead = 0;
            while (bytesRead < data.length) {
              const chunk = await handle.read(data, bytesRead, data.length - bytesRead, bytesRead);
              if (!chunk.bytesRead) break;
              bytesRead += chunk.bytesRead;
            }
            if (bytesRead !== size) throw failure('ATTACHMENT_CHANGED', '읽는 중 파일이 변경되었습니다. 저장한 후 다시 첨부해 주세요.');
            data = data.subarray(0, bytesRead);
          }
        } catch (error) {
          if (error?.code?.startsWith('ATTACHMENT') || error?.code === 'INVALID_ATTACHMENTS') throw error;
          throw failure('ATTACHMENT_READ_FAILED', '선택한 파일을 읽을 수 없습니다. 파일 접근 권한을 확인해 주세요.');
        } finally { await handle?.close(); }
        const extracted = TEXT_EXTENSIONS.has(extension)
          ? { text: ['.html', '.htm', '.xml'].includes(extension) ? markupText(decodeText(data)) : decodeText(data) }
          : await extract(file);
        if (typeof extracted?.text !== 'string' || !extracted.text.trim()) throw failure('ATTACHMENT_EMPTY', '첨부한 문서에 읽을 수 있는 텍스트가 없습니다. 이미지 문서는 OCR 처리 후 첨부해 주세요.');
        const truncated = extracted.truncated === true || extracted.text.length > MAX_CHARS;
        const warning = [extracted.warning, truncated ? '파일당 최대 12,000자까지만 분석합니다. 생략된 내용은 판단 근거에 포함되지 않습니다.' : ''].filter(Boolean).join(' ');
        selected.push({ id: randomUUID(), name: path.basename(file).replace(/[\u0000-\u001f]/g, '').slice(0, 240), size, text: bounded(extracted.text.trim(), MAX_CHARS), truncated, ...(warning ? { warning } : {}) });
      }
      if (documents.size + selected.length > 100) throw failure('ATTACHMENT_LIMIT', '이 실행에서 첨부한 파일이 너무 많습니다. 앱을 다시 실행한 후 필요한 파일을 선택해 주세요.');
      for (const doc of selected) documents.set(doc.id, doc);
      return selected.map(metadata);
    },
    remember(savedDocuments) {
      const invalid = () => failure('INVALID_ATTACHMENTS', '저장된 첨부 자료 형식이 올바르지 않습니다. 파일을 다시 첨부해 주세요.');
      if (!Array.isArray(savedDocuments) || savedDocuments.length > 5) throw invalid();
      const restored = [];
      const seen = new Set();
      const allowedKeys = new Set(['id', 'name', 'size', 'text', 'truncated', 'warning']);
      let totalBytes = 0;
      let totalChars = 0;
      for (const doc of savedDocuments) {
        if (!doc || typeof doc !== 'object' || Array.isArray(doc) || Object.keys(doc).some(key => !allowedKeys.has(key)) ||
          typeof doc.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(doc.id) || seen.has(doc.id) ||
          typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 240 || /[\\/\u0000-\u001f]/.test(doc.name) || ['.', '..'].includes(doc.name) ||
          !Number.isSafeInteger(doc.size) || doc.size < 0 || doc.size > MAX_FILE_BYTES ||
          typeof doc.text !== 'string' || !doc.text.trim() || doc.text.length > MAX_CHARS || typeof doc.truncated !== 'boolean' ||
          (doc.warning !== undefined && (typeof doc.warning !== 'string' || doc.warning.length > 700))) throw invalid();
        totalBytes += doc.size;
        totalChars += doc.text.length;
        if (totalBytes > MAX_TOTAL_BYTES || totalChars > MAX_TOTAL_CHARS) throw invalid();
        const existing = documents.get(doc.id);
        if (existing && ['name', 'size', 'text', 'truncated', 'warning'].some(key => existing[key] !== doc[key])) throw invalid();
        seen.add(doc.id);
        restored.push({ id: doc.id, name: doc.name, size: doc.size, text: doc.text, truncated: doc.truncated,
          ...(doc.warning ? { warning: doc.warning } : {}) });
      }
      if (documents.size + restored.filter(doc => !documents.has(doc.id)).length > 100) throw invalid();
      for (const doc of restored) documents.set(doc.id, doc);
      return restored.map(metadata);
    },
    resolve(ids = []) {
      const selected = validateIds(ids).map(id => documents.get(id));
      if (selected.reduce((sum, doc) => sum + doc.size, 0) > MAX_TOTAL_BYTES) throw failure('ATTACHMENT_SIZE_LIMIT', '첨부 자료의 총 크기는 10MB까지 사용할 수 있습니다.');
      // Divide the total budget fairly so no selected document silently disappears.
      const budget = selected.length ? Math.min(MAX_CHARS, Math.floor(MAX_TOTAL_CHARS / selected.length)) : MAX_CHARS;
      return selected.map(doc => {
        if (doc.text.length <= budget) return { ...doc };
        return { ...doc, text: bounded(doc.text, budget), truncated: true, warning: [doc.warning, '첨부 전체 36,000자 제한에 맞추어 일부 내용이 추가 생략되었습니다.'].filter(Boolean).join(' ') };
      });
    },
    metadata(ids = []) { return this.resolve(ids).map(metadata); },
  };
}

module.exports = { createAttachmentService, extractDocument };
