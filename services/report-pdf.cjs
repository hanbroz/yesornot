'use strict';

// Builds a static, script-free HTML page for printToPDF. Every value is escaped.
const CHOICES = { YES: 'YES', NO: 'NO', CONDITIONAL: '조건부 권고', HOLD: '판단 보류' };
const NAMES = { claude: 'Claude', codex: 'ChatGPT', gemini: 'Gemini' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function paragraphs(text) {
  return String(text || '').split(/\n\s*\n/u).map(part => part.trim()).filter(Boolean)
    .map(part => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('');
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function reportFileName(record) {
  const date = new Date(record?.createdAt);
  const stamp = Number.isNaN(date.valueOf()) ? 'report' : date.toISOString().slice(0, 10);
  return `YES-or-NO-${record?.evaluation?.synthesis?.status === 'withheld' ? '판단불가' : '최종보고서'}-${stamp}.pdf`;
}

function buildReportHtml(record, { fontCssUrl = '' } = {}) {
  const synthesis = record?.evaluation?.synthesis;
  if (!record || !['complete', 'withheld'].includes(synthesis?.status)) throw Object.assign(new Error('최종 보고서가 완성된 판단만 PDF로 저장할 수 있습니다.'), { code: 'NO_FINAL_REPORT' });
  // An unconfirmed result is exported as an inconclusive notice, never as a recommendation.
  const withheld = synthesis.status === 'withheld';
  const gate = record.evaluation.gate;
  const interval = record.evaluation.verdict?.interval;
  const pct = value => Number.isFinite(value) ? Math.round(value * 1000) / 10 + '%' : '—';
  const gateHtml = gate ? `<section class="gate ${gate.passed ? 'passed' : 'failed'}"><h2>확정 기준 (${escapeHtml(gate.label)}) · ${gate.passed ? '통과' : '미달'}</h2>${interval ? `<p>${escapeHtml(CHOICES[interval.choice] || interval.choice)} 확률 ${pct(interval.mean)} · 95% 신뢰구간 ${pct(interval.lower)}~${pct(interval.upper)} (${escapeHtml(interval.n)}회 독립 측정)</p>` : ''}<ul>${(gate.checks || []).map(check => {
    const unit = check.id === 'interval' ? pct : value => value + (check.id === 'readiness' ? '%' : '점');
    return `<li>${check.passed ? '✓' : '✗'} ${escapeHtml(check.label)}: ${check.value === null || check.value === undefined ? '측정 안 됨' : escapeHtml(unit(check.value))} (기준 ${escapeHtml(unit(check.target))} 이상)</li>`;
  }).join('')}</ul></section>` : '';
  const missing = synthesis.missing;
  const missingHtml = withheld ? `<section><h2>신뢰할 수 있는 결론을 내리려면 필요한 것</h2>${missing?.summary ? paragraphs(missing.summary) : ''}${missing?.userQuestions?.length ? `<h3>사용자에게 확인이 필요한 정보</h3><ul>${missing.userQuestions.map(item => `<li>${escapeHtml(item.question)}${item.why ? ` — ${escapeHtml(item.why)}` : ''}</li>`).join('')}</ul>` : ''}${missing?.researchQueries?.length ? `<h3>추가로 조사해야 할 자료</h3><ul>${missing.researchQueries.map(item => `<li>${escapeHtml(item.query)}${item.purpose ? ` — ${escapeHtml(item.purpose)}` : ''}</li>`).join('')}</ul>` : ''}</section>` : '';
  const verdict = record.evaluation.verdict || {};
  const review = synthesis.finalReview;
  const sections = withheld ? '' : synthesis.report?.version === 1 && Array.isArray(synthesis.report.sections) && synthesis.report.sections.length
    ? synthesis.report.sections.map(section => `<h3>${escapeHtml(section.title)}</h3>${paragraphs(section.text)}`).join('')
    : paragraphs(synthesis.text);
  const meta = [
    [withheld ? '확정되지 않은 기울기(결론 아님)' : '판정', (CHOICES[verdict.choice] || verdict.choice || '—') + (Number.isFinite(verdict.probabilities?.YES) && Number.isFinite(verdict.probabilities?.NO) && Object.keys(verdict.probabilities).length === 2 ? ` (YES ${Math.round(verdict.probabilities.YES * 100)}% · NO ${Math.round(verdict.probabilities.NO * 100)}%)` : '')],
    ['작성일', dateLabel(record.completedAt || record.createdAt)],
    ['답변 품질 평균', Number.isFinite(record.evaluation.qualityAverage) ? record.evaluation.qualityAverage + '/100' : '—'],
    ...(Number.isFinite(record.preparation?.readiness) ? [['인터뷰 준비도', record.preparation.readiness + '%']] : []),
    ...(review && Number.isFinite(review.score) ? [['최종 검토', `${review.score}점 · ${review.status === 'passed' ? '통과' : '미통과'}`]] : []),
  ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');

  const opinions = (record.opinions || []).filter(opinion => opinion.status === 'success').map(opinion => {
    const score = record.evaluation.opinions?.find(row => row.providerId === opinion.providerId)?.total;
    return `<tr><td>${escapeHtml(NAMES[opinion.providerId] || opinion.name || opinion.providerId)}</td><td>${escapeHtml(CHOICES[opinion.stance] || opinion.stance || '')}</td><td>${escapeHtml(opinion.title || '')}<br><span class="muted">${escapeHtml(opinion.point || '')}</span></td><td>${Number.isFinite(score) ? escapeHtml(score.toFixed(1)) : '—'}</td></tr>`;
  }).join('');

  const asked = [...(record.preparation?.answeredQuestions || []), ...(record.preparation?.questions || [])];
  const interview = asked.map(item => `<li><strong>${escapeHtml(item.question)}</strong><br>${escapeHtml(record.answers?.[item.id] || '(답변 없음)')}</li>`).join('');

  const sources = (record.research?.sources || []).filter(source => source.verification !== 'unavailable')
    .map(source => `<li><strong>[${escapeHtml(source.id)}]</strong> ${escapeHtml(source.title || source.url)} · ${escapeHtml(source.publisher || '')} · ${escapeHtml(source.date || '발행일 미확인')}<br><span class="url">${escapeHtml(source.url)}</span></li>`).join('');

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' file:; font-src file:">
<title>${withheld ? '판단 불가 보고서' : escapeHtml(synthesis.title || '최종 보고서')}</title>
${fontCssUrl ? `<link rel="stylesheet" href="${escapeHtml(fontCssUrl)}">` : ''}
<style>
  @page { size: A4; margin: 18mm 16mm; }
  :root { --ink: #16181d; --text-2: #3d4250; --muted: #6b7180; --line: #e2e5eb; --accent: #4338ca; --soft: #eef0fb; }
  * { box-sizing: border-box; }
  body { margin: 0; width: 100%; font-family: 'Noto Sans KR', 'Malgun Gothic', sans-serif; font-size: 10.5pt; line-height: 1.75; color: var(--ink); word-break: keep-all; overflow-wrap: anywhere; }
  header { border-bottom: 2px solid var(--accent); padding-bottom: 10px; margin-bottom: 14px; }
  .eyebrow { margin: 0; font-size: 8.5pt; font-weight: 700; letter-spacing: .08em; color: var(--accent); }
  h1 { margin: 4px 0 0; font-size: 17pt; line-height: 1.4; }
  .question { margin: 6px 0 0; color: var(--text-2); }
  dl { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 12px 0 0; }
  dt { font-size: 8.5pt; color: var(--muted); } dd { margin: 0; font-weight: 700; }
  h2 { margin: 22px 0 8px; padding-top: 8px; border-top: 1px solid var(--line); font-size: 12.5pt; break-after: avoid; }
  h3 { margin: 14px 0 4px; font-size: 11pt; color: var(--accent); break-after: avoid; }
  p { margin: 0 0 8px; }
  .point { margin: 12px 0; padding: 10px 12px; border-radius: 6px; background: var(--soft); font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  th, td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
  th { background: #f6f7f9; white-space: nowrap; }
  tr { break-inside: avoid; }
  ul { margin: 0; padding-left: 18px; } li { margin-bottom: 6px; break-inside: avoid; }
  .withheld-banner { margin: 0 0 14px; padding: 12px 14px; border: 2px solid #b91c1c; border-radius: 6px; color: #b91c1c; font-weight: 700; }
  .gate.failed h2 { color: #b91c1c; } .gate.passed h2 { color: #15803d; }
  .muted, .url { color: var(--muted); } .url { font-size: 8.5pt; word-break: break-all; }
  footer { margin-top: 24px; padding-top: 8px; border-top: 1px solid var(--line); font-size: 8.5pt; color: var(--muted); }
</style></head><body>
<header>
  <p class="eyebrow">YES or NO · ${withheld ? '판단 불가 보고서 (확정되지 않음)' : '최종 보고서'}</p>
  <h1>${withheld ? '판단 불가: 확정 기준을 통과한 결론을 만들지 못했습니다' : escapeHtml(synthesis.title || '최종 권고')}</h1>
  <p class="question">질문: ${escapeHtml(record.question)}</p>
  <dl>${meta}</dl>
</header>
${withheld ? '<p class="withheld-banner">이 문서는 최종 보고서가 아닙니다. 판정이 확정 기준을 통과하지 못했으므로 아래 기울기를 결론으로 사용하지 마세요.</p>' : ''}
${gateHtml}
${!withheld && synthesis.point ? `<p class="point">지금 할 일: ${escapeHtml(synthesis.point)}</p>` : ''}
${withheld ? missingHtml : `<section><h2>최종 권고</h2>${sections}</section>`}
${opinions ? `<section><h2>AI별 의견</h2><table><thead><tr><th>AI</th><th>입장</th><th>요지</th><th>품질</th></tr></thead><tbody>${opinions}</tbody></table></section>` : ''}
${interview ? `<section><h2>사전 인터뷰</h2><ul>${interview}</ul></section>` : ''}
${sources ? `<section><h2>근거 출처</h2><ul>${sources}</ul></section>` : ''}
<footer>이 보고서는 여러 AI의 조사·토론과 JEV 평가를 바탕으로 자동 작성되었습니다. 품질 점수와 판정 분포는 정답 확률이 아니며, 중요한 결정 전에는 원문 출처를 직접 확인하세요.</footer>
</body></html>`;
}

module.exports = { buildReportHtml, reportFileName, escapeHtml };
