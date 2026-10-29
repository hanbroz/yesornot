'use strict';

const SECTIONS = Object.freeze([
  ['judgment', '판단'], ['reasons', '선택 이유'], ['alternatives', '대안 비교'],
  ['plan', '실행 계획'], ['risks', '위험과 대응'], ['changeConditions', '결론 변경 조건'],
]);
const CONDITIONAL_FIELDS = ['현재 행동', '선행 조건', '충족 시', '미충족 시'];
const FINAL_REPORT_INSTRUCTIONS = [
  '당신의 결과물이 사용자가 요청한 의사결정 자체입니다. 현재 근거에서 가장 나은 선택을 끝까지 결정한 보고서를 작성하세요. 정보 나열 뒤 종합 판단이나 최종 선택을 사용자에게 떠넘기지 마세요.',
  'body는 다음 여섯 제목을 각각 별도 줄에 한 번씩, 이 순서로 포함하세요: [판단], [선택 이유], [대안 비교], [실행 계획], [위험과 대응], [결론 변경 조건]. 각 제목 뒤에 실제 내용을 쓰고 문단·줄바꿈으로 읽기 쉽게 구성하세요.',
  '[판단] 첫 문장에서 질문에 대한 현재 권고와 지금 실행할 행동을 명확히 결정하세요. [선택 이유]에는 결정적인 근거와 결론의 연결, 채택·기각한 주요 주장과 이유를 설명하세요. 여러 AI가 반복한 의견을 독립적인 사실 증거로 세지 마세요.',
  '[대안 비교]에는 가장 유력한 다른 선택과 비교해 왜 이 선택을 권하는지 설명하세요. [실행 계획]에는 우선순위가 있는 구체적인 행동과 완료 여부를 확인할 방법을 쓰세요. point는 지금 가장 먼저 할 행동 한 문장입니다.',
  '[위험과 대응]에는 핵심 실패 가능성, 대응과 중단 기준을, [결론 변경 조건]에는 어떤 확인 결과가 나오면 권고를 어떻게 바꿀지 적으세요. 막연히 상황에 따라 판단하라고 쓰지 마세요.',
  'CONDITIONAL이면 [판단]에 현재 행동:, 선행 조건:, 충족 시:, 미충족 시: 네 항목을 각각 별도 줄로 쓰세요. 현재 행동은 확인을 기다리는 동안의 권고, 선행 조건은 확인할 사실과 확인 방법, 충족 시는 실행안, 미충족 시는 실행하지 않을 때의 대안입니다. 조건부라는 이름만 붙여 선택을 미루지 마세요.',
  '검토된 자료로 뒷받침되지 않는 새 사실·금액·수익률·기간·기준값을 만들어 구체성을 꾸미지 마세요. 미확인 사실은 가정과 분리하고 확인 전의 안전한 행동까지 결정하세요. 절대 최적이나 결과 보장을 주장하지 말고 현재 근거에서 최선인 이유를 설명하세요.',
].join('\n');

// This checks report completeness and explicit delegation, not factual correctness.
function reportFailure(issues) {
  return Object.assign(new Error('최종 보고서의 판단과 실행 내용을 보완해야 합니다.'), { code: 'INCOMPLETE_REPORT', issues });
}
function withoutQuotes(text) {
  return text.replace(/“[^”]*”|‘[^’]*’|"[^"\n]*"|'[^'\n]*'/gu, '');
}
function delegatesDecision(text) {
  const request = '(?:하세요|하십시오|하라|하시오|하시기\\s*바랍니다|하셔야|해야\\s*(?:합니다|한다)|할\\s*필요가\\s*있|해\\s*(?:주세요|보세요))';
  const decision = '(?:판단|결정|선택)';
  const directed = new RegExp('(?:종합적(?:으로)?|종합하여|스스로|직접|각자|알아서|본인이|사용자가)\\s*(?:(?:검토|고려|분석)(?:하여|하고|해)\\s*)?(?:최종(?:적으로)?\\s*)?' + decision + '(?:(?:하여|하고|해)\\s*(?:최종\\s*)?' + decision + ')?\\s*' + request, 'u');
  const finalRequest = new RegExp('최종\\s*' + decision + '\\s*' + request, 'u');
  return withoutQuotes(text).split(/[.!?。\n]+/u).some(sentence => {
    return directed.test(sentence) || finalRequest.test(sentence) ||
      /최종\s*(?:판단|결정|선택).{0,12}(?:사용자|본인).{0,10}(?:(?:몫|책임)(?:입니다|이다|이며|이므로)|달려\s*있|맡깁|맡기|위임합|넘깁)/u.test(sentence) ||
      new RegExp('(?:상황|여건|개인\\s*사정)에\\s*따라.{0,20}(?:신중히\\s*)?' + decision + '\\s*' + request, 'u').test(sentence);
  });
}
function vacuous(text) {
  const compact = withoutQuotes(text).replace(/[\s\p{P}\p{S}]/gu, '');
  return !compact || /^(?:상황에따라|신중하게|신중히|종합적으로|충분히|관련자료를|여러요소를|개인상황을|전문가와|검토|확인|고려|판단|결정|해야합니다|해야한다|하세요|합니다|필요합니다|상담|하라|하시오|하십시오|후)*$/u.test(compact);
}
function validateDecisionReport(opinion) {
  const text = opinion.text.replace(/\r\n?/gu, '\n');
  const heading = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:\[(판단|선택 이유|대안 비교|실행 계획|위험과 대응|결론 변경 조건)\]|(판단|선택 이유|대안 비교|실행 계획|위험과 대응|결론 변경 조건))(?::|：)?(?:\*\*)?\s*$/gmu;
  const matches = [...text.matchAll(heading)];
  const issues = [];
  if (matches.length === SECTIONS.length && matches.some((match, index) => (match[1] || match[2]) !== SECTIONS[index][1])) issues.push('여섯 구역을 판단부터 결론 변경 조건까지 순서대로 작성하세요.');
  const sections = SECTIONS.map(([id, title]) => {
    const found = matches.filter(match => (match[1] || match[2]) === title);
    if (found.length !== 1) { issues.push(`${title}: 제목을 한 번 포함해야 합니다.`); return { id, title, text: '' }; }
    const index = matches.indexOf(found[0]);
    const body = text.slice(found[0].index + found[0][0].length, matches[index + 1]?.index ?? text.length).trim();
    if (vacuous(body)) issues.push(`${title}: 제목이나 일반론 대신 이 질문에 대한 실제 내용을 작성하세요.`);
    return { id, title, text: body };
  });
  const judgment = sections[0].text, plan = sections[3].text;
  if ([judgment, plan, opinion.point].some(delegatesDecision)) issues.push('판단·실행 계획·첫 행동에서 최종 선택을 사용자에게 위임하지 마세요.');
  if (opinion.stance === 'CONDITIONAL') {
    for (const label of CONDITIONAL_FIELDS) {
      const escaped = label.replace(/ /gu, '[ \\t]*');
      const field = new RegExp('(?:^|\\n)[ \\t]*(?:[-*][ \\t]*)?' + escaped + '[ \\t]*[:：][ \\t]*([^\\n]+)', 'u').exec(judgment);
      if (!field || vacuous(field[1]) || delegatesDecision(field[1])) issues.push(`판단: ${label}: 뒤에 구체적인 내용을 작성하세요.`);
    }
  }
  if (issues.length) throw reportFailure(issues);
  return { version: 1, sections };
}

module.exports = { FINAL_REPORT_INSTRUCTIONS, validateDecisionReport };
