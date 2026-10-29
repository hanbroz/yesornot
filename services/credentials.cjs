'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// Only the main process calls this module. Stored values never enter renderer state.
const SECRET_FILES = new Set(['jev-key.bin', 'gemini-key.bin']);
function validatedKey(value) {
  if (typeof value !== 'string' || /[\r\n\x00-\x1F\x7F]/u.test(value)) throw new Error('API 키에 줄바꿈이나 제어 문자를 포함할 수 없습니다.');
  const key = value.trim();
  if (!key || key.length > 4096 || /[^\x21-\x7E]/u.test(key)) throw new Error('API 키의 길이와 공백을 확인해 주세요.');
  return key;
}
function secretFile(userData, fileName) {
  if (!SECRET_FILES.has(fileName)) throw new Error('허용되지 않은 키 저장 경로입니다.');
  return path.join(userData, fileName);
}
async function saveSecret({ key: value, fileName, userData, safeStorage }) {
  const key = validatedKey(value);
  const file = secretFile(userData, fileName);
  if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Windows 암호화 저장을 사용할 수 없어 API 키를 저장하지 않았습니다.');
  let temporary;
  try {
    const encrypted = await safeStorage.encryptStringAsync(key);
    await fs.mkdir(userData, { recursive: true });
    temporary = file + '.' + require('node:crypto').randomUUID() + '.tmp';
    await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
    return { configured: true };
  } catch {
    throw new Error('API 키를 암호화하여 저장하지 못했습니다. 기존 키는 유지됩니다.');
  } finally {
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
  }
}
async function loadSecret({ config, env = process.env, keyName, fileName, userData, safeStorage }) {
  const file = secretFile(userData, fileName);
  const supplied = config[keyName]?.trim() || env[keyName]?.trim() || '';
  delete env[keyName];
  // A key entered in the settings UI must survive a restart even when an older
  // developer .env is still present. Import .env only without a readable saved key.
  try {
    const decrypted = await safeStorage.decryptStringAsync(await fs.readFile(file));
    const key = validatedKey(decrypted.result);
    if (decrypted.shouldReEncrypt) {
      try { await saveSecret({ key, fileName, userData, safeStorage }); }
      catch { return { key, message: keyName + ': 저장된 키로 연결했습니다. 암호화 갱신은 다음 실행에서 다시 시도합니다.' }; }
    }
    return { key, message: '' };
  } catch {}
  if (supplied) {
    try {
      const key = validatedKey(supplied);
      await saveSecret({ key, fileName, userData, safeStorage });
      return { key, message: '' };
    } catch {
      try { return { key: validatedKey(supplied), message: keyName + ': 암호화 저장을 사용할 수 없어 이번 실행에서만 사용합니다.' }; }
      catch { return { key: '', message: keyName + ': API 키 형식을 확인해 주세요.' }; }
    }
  }
  return { key: '', message: '' };
}
module.exports = { loadSecret, saveSecret };
