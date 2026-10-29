'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createAttachmentService, extractDocument } = require('../services/attachments.cjs');
const { runProcess } = require('../services/cli.cjs');

async function fixture(t, name, content) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yesornot-attachment-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, name);
  await fs.writeFile(file, content);
  return file;
}

test('file selection exposes opaque metadata, never local paths or extracted content', async t => {
  const file = await fixture(t, 'private.txt', '개인 자료 본문');
  const service = createAttachmentService({ chooseFiles: async () => [file, file] });
  const selected = await service.pick();
  assert.equal(selected.length, 1);
  assert.equal(selected[0].name, 'private.txt');
  assert.equal(selected[0].chars, '개인 자료 본문'.length);
  assert.equal(selected[0].text, undefined);
  assert.equal(selected[0].path, undefined);
  assert.equal(service.resolve([selected[0].id, selected[0].id]).length, 1);
  assert.equal(service.resolve([selected[0].id])[0].text, '개인 자료 본문');
  assert.throws(() => service.resolve([file]), { code: 'INVALID_ATTACHMENTS' });
  assert.throws(() => service.resolve([selected[0].id, selected[0].id, selected[0].id, selected[0].id, selected[0].id, selected[0].id]), { code: 'INVALID_ATTACHMENTS' });
  assert.deepEqual(createAttachmentService({ chooseFiles: async () => [] }).resolve(), []);
});

test('UTF-16 and HTML are read without executing or including embedded scripts', async t => {
  const file = await fixture(t, 'report.html', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<style>hidden</style><h1>자료 &amp; 결과</h1><script>stealSecrets()</script><p>123&#37;</p>', 'utf16le')]));
  const service = createAttachmentService({ chooseFiles: async () => [file] });
  const selected = await service.pick();
  const text = service.resolve([selected[0].id])[0].text;
  assert.match(text, /자료 & 결과/);
  assert.match(text, /123%/);
  assert.doesNotMatch(text, /hidden|stealSecrets|script/);
});

test('unsupported, binary and large files fail visibly and no partial batch is retained', async t => {
  const unsupported = await fixture(t, 'image.png', 'text');
  await assert.rejects(createAttachmentService({ chooseFiles: async () => [unsupported] }).pick(), { code: 'ATTACHMENT_UNSUPPORTED' });
  const binary = await fixture(t, 'fake.txt', Buffer.from([1, 0, 2, 3]));
  await assert.rejects(createAttachmentService({ chooseFiles: async () => [binary] }).pick(), { code: 'ATTACHMENT_BINARY' });
  const large = await fixture(t, 'large.txt', Buffer.alloc(5 * 1024 * 1024 + 1, 'a'));
  await assert.rejects(createAttachmentService({ chooseFiles: async () => [large] }).pick(), { code: 'ATTACHMENT_SIZE_LIMIT' });
  await assert.rejects(createAttachmentService({ chooseFiles: async () => Array(6).fill(large) }).pick(), { code: 'ATTACHMENT_LIMIT' });
});

test('all selected documents retain an explicit share of the 36000-character budget', async t => {
  const files = [];
  for (let index = 0; index < 5; index++) files.push(await fixture(t, index + '.txt', String(index).repeat(18000)));
  const service = createAttachmentService({ chooseFiles: async () => files });
  const selected = await service.pick();
  assert.ok(selected.every(item => item.chars <= 12000 && item.truncated && item.warning));
  const resolved = service.resolve(selected.map(item => item.id));
  assert.equal(resolved.length, 5);
  assert.ok(resolved.reduce((sum, item) => sum + item.text.length, 0) <= 36000);
  assert.ok(resolved.every(item => item.text.includes('생략') && item.warning.includes('36,000')));
  assert.equal(service.metadata(selected.map(item => item.id))[0].text, undefined);
});

test('extraction failure never exposes subprocess output or environment secrets', async () => {
  await assert.rejects(extractDocument('private.pdf', { processRunner: async () => { throw Object.assign(new Error('secret command output'), { code: 'ENOENT' }); } }), error => {
    assert.equal(error.code, 'ATTACHMENT_PYTHON_REQUIRED');
    assert.doesNotMatch(error.message, /secret command output|private\.pdf/);
    return true;
  });
  await assert.rejects(extractDocument('private.pdf', { processRunner: async () => ({ exitCode: 1, stdout: JSON.stringify({ ok: false, code: 'PDF_OCR_REQUIRED' }) }) }), /OCR/);
  let observed;
  await extractDocument('private.docx', { processRunner: async (command, args, options) => {
    observed = { command, args, options };
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, text: 'extracted' }) };
  } });
  assert.equal(observed.options.timeoutMs, 30000);
  assert.ok(!observed.options.env.GEMINI_API_KEY);
  assert.equal(observed.args[0], '-I');
});

test('remember restores bounded saved document tokens without file reads or path exposure', async t => {
  const file = await fixture(t, 'saved.txt', '저장 후 재개할 의사 결정 자료');
  const original = createAttachmentService({ chooseFiles: async () => [file] });
  const selected = await original.pick();
  const full = original.resolve(selected.map(doc => doc.id));
  const restored = createAttachmentService({ chooseFiles: async () => { throw new Error('must not choose files'); } });
  await fs.unlink(file);
  const metadata = restored.remember(JSON.parse(JSON.stringify(full)));
  assert.deepEqual(metadata, selected);
  assert.deepEqual(restored.resolve(metadata.map(doc => doc.id)), full);
  assert.equal(metadata[0].text, undefined);
  assert.equal(metadata[0].path, undefined);
  assert.ok(!JSON.stringify(metadata).includes(path.dirname(file)));
  assert.deepEqual(restored.remember(full), metadata);
});

test('remember rejects forged or excessive saved documents atomically', () => {
  const { randomUUID } = require('node:crypto');
  const valid = () => ({ id: randomUUID(), name: 'evidence.txt', size: 123, text: 'public evidence', truncated: false });
  const invalidBatches = [
    null, {}, Array.from({ length: 6 }, valid),
    [{ ...valid(), id: 'arbitrary-token' }], [{ ...valid(), name: '../private.txt' }],
    [{ ...valid(), name: 'C:\\private.txt' }], [{ ...valid(), name: String.fromCharCode(0) + '.txt' }],
    [{ ...valid(), name: '..' }], [{ ...valid(), path: 'C:\\private.txt' }],
    [{ ...valid(), size: 5 * 1024 * 1024 + 1 }], [{ ...valid(), size: NaN }],
    [{ ...valid(), size: -1 }], [{ ...valid(), size: 0.5 }],
    [{ ...valid(), text: 'x'.repeat(12001) }], [{ ...valid(), text: ' ' }],
    [{ ...valid(), truncated: 'false' }], [{ ...valid(), warning: {} }],
    [{ ...valid(), warning: 'x'.repeat(701) }],
    Array.from({ length: 3 }, () => ({ ...valid(), size: 4 * 1024 * 1024 })),
    Array.from({ length: 4 }, () => ({ ...valid(), text: 'x'.repeat(10000) })),
  ];
  const duplicate = valid();
  invalidBatches.push([duplicate, duplicate]);
  for (const batch of invalidBatches) {
    const service = createAttachmentService({ chooseFiles: async () => [] });
    const first = valid();
    assert.throws(() => service.remember(Array.isArray(batch) && batch.length < 5 ? [first, ...batch] : batch), { code: 'INVALID_ATTACHMENTS' });
    assert.throws(() => service.resolve([first.id]), { code: 'INVALID_ATTACHMENTS' });
  }
  const service = createAttachmentService({ chooseFiles: async () => [] });
  const doc = valid();
  service.remember([doc]);
  assert.throws(() => service.remember([{ ...doc, text: 'changed saved evidence' }]), { code: 'INVALID_ATTACHMENTS' });
  assert.equal(service.resolve([doc.id])[0].text, doc.text);
});

test('real Python extracts DOCX and cached XLSX values, rejects image PDFs and entity XML', async t => {
  const file = await fixture(t, 'report.docx', '');
  const directory = path.dirname(file);
  const python = process.env.YESORNOT_PYTHON || 'python';
  const setup = await runProcess(python, ['-I', '-X', 'utf8', '-c', [
    'import sys, zipfile',
    'from pathlib import Path',
    'from pypdf import PdfWriter',
    'root=Path(sys.argv[1])',
    'with zipfile.ZipFile(root/"report.docx", "w") as z: z.writestr("word/document.xml", \'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Decision evidence 123</w:t></w:r></w:p></w:body></w:document>\')',
    'with zipfile.ZipFile(root/"values.xlsx", "w") as z: z.writestr("xl/worksheets/sheet1.xml", \'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>\')',
    'with zipfile.ZipFile(root/"unsafe.docx", "w") as z: z.writestr("word/document.xml", \'<!DOCTYPE foo [<!ENTITY x "secret">]><document>&x;</document>\')',
    'writer=PdfWriter(); writer.add_blank_page(width=100,height=100); writer.write(root/"image.pdf")',
    'writer=PdfWriter(); page=writer.add_blank_page(width=300,height=300)',
    'from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject',
    'font=DictionaryObject({NameObject("/Type"):NameObject("/Font"),NameObject("/Subtype"):NameObject("/Type1"),NameObject("/BaseFont"):NameObject("/Helvetica")})',
    'page[NameObject("/Resources")]=DictionaryObject({NameObject("/Font"):DictionaryObject({NameObject("/F1"):writer._add_object(font)})})',
    'stream=DecodedStreamObject(); stream.set_data(b"BT /F1 12 Tf 10 100 Td (Actual PDF evidence) Tj ET"); page[NameObject("/Contents")]=writer._add_object(stream); writer.write(root/"text.pdf")',
  ].join('\n'), directory], { timeoutMs: 30000 });
  assert.equal(setup.exitCode, 0, 'Python and pypdf are required for the real document extraction check');
  const docx = await extractDocument(file);
  assert.match(docx.text, /Decision evidence 123/);
  const xlsx = await extractDocument(path.join(directory, 'values.xlsx'));
  assert.match(xlsx.text, /A1: 2/);
  assert.match(xlsx.warning, /실행하지 않았/);
  const pdf = await extractDocument(path.join(directory, 'text.pdf'));
  assert.match(pdf.text, /Actual PDF evidence/);
  await assert.rejects(extractDocument(path.join(directory, 'image.pdf')), /OCR/);
  await assert.rejects(extractDocument(path.join(directory, 'unsafe.docx')), /압축 해제 크기 또는 구조/);
});
