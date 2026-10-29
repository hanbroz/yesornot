'use strict';

const fs = require('node:fs/promises');
const { exportQuestionnaire, parseQuestionnaire, decodeQuestionnaire, MAX_FILE_BYTES } = require('./questionnaire.cjs');

function createQuestionnaireFiles({ getActive, chooseSaveFile, chooseOpenFile }) {
  let pending = false;
  function active(runId) {
    const record = getActive();
    if (!record || record.id !== runId || record.status !== 'awaiting_input') throw new Error('현재 답변 대기 중인 질문지를 선택해 주세요.');
    return record;
  }
  function unchanged(record) {
    const current = active(record.id);
    if (exportQuestionnaire(current) !== exportQuestionnaire(record)) throw new Error('질문지가 변경되었습니다. 현재 질문지를 다시 다운로드해 주세요.');
    return current;
  }
  async function run(action) {
    if (pending) throw new Error('열려 있는 질문지 파일 창을 먼저 완료해 주세요.');
    pending = true;
    try { return await action(); }
    catch (error) {
      if (typeof error?.code === 'string') throw new Error('질문지 파일을 읽거나 저장하지 못했습니다. 파일이 열려 있는지와 저장 위치의 권한을 확인해 주세요.');
      throw error;
    } finally { pending = false; }
  }
  return {
    download({ runId, answers = {} } = {}) {
      return run(async () => {
        const record = active(runId);
        const text = exportQuestionnaire(record, answers);
        const file = await chooseSaveFile(`YES-NOT-질문지-${record.id.slice(0, 8)}.txt`);
        if (!file) return { canceled: true };
        unchanged(record);
        await fs.writeFile(file, text, 'utf8');
        return { canceled: false, questionCount: record.preparation.questions.length };
      });
    },
    upload({ runId } = {}) {
      return run(async () => {
        const record = active(runId);
        const file = await chooseOpenFile();
        if (!file) return { canceled: true };
        unchanged(record);
        const handle = await fs.open(file, 'r');
        const chunks = [];
        let size = 0;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('질문지는 256KB 이하의 텍스트 파일이어야 합니다.');
          while (size <= MAX_FILE_BYTES) {
            const buffer = Buffer.alloc(Math.min(65536, MAX_FILE_BYTES + 1 - size));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            chunks.push(buffer.subarray(0, bytesRead));
            size += bytesRead;
          }
        } finally { await handle.close(); }
        const text = decodeQuestionnaire(Buffer.concat(chunks, size));
        const answers = parseQuestionnaire(unchanged(record), text);
        return { canceled: false, answers, answerCount: Object.keys(answers).length };
      });
    },
  };
}

module.exports = { createQuestionnaireFiles };
