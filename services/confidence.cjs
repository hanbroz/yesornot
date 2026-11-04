'use strict';

// A final report is confirmed only when every condition of the chosen level holds.
// The interval measures how stable JEV's lean is across independent judgments;
// it is not a guarantee that the conclusion is correct.
const GATE_LEVELS = Object.freeze({
  strict: Object.freeze({ id: 'strict', label: '엄격', lowerBound: 0.70, minQuality: 75, avgQuality: 80, review: 90, readiness: 90 }),
  recommended: Object.freeze({ id: 'recommended', label: '권장', lowerBound: 0.60, minQuality: 70, avgQuality: 75, review: 90, readiness: 90 }),
  relaxed: Object.freeze({ id: 'relaxed', label: '완화', lowerBound: 0.55, minQuality: 65, avgQuality: 70, review: 90, readiness: 90 }),
});
const DEFAULT_GATE_LEVEL = 'strict';
const VERDICT_SAMPLES = 5;
// Two-sided 95% Student t critical values by degrees of freedom.
const T_975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262];

function gateLevel(id) { return GATE_LEVELS[id] || GATE_LEVELS[DEFAULT_GATE_LEVEL]; }

// samples: P(YES) from independent JEV judgments. Returns the leaning side and the
// 95% confidence interval of that side's probability.
function verdictInterval(samples) {
  const values = samples.filter(Number.isFinite);
  if (!values.length) return null;
  const meanYes = values.reduce((sum, value) => sum + value, 0) / values.length;
  const choice = meanYes >= 0.5 ? 'YES' : 'NO';
  const side = values.map(value => choice === 'YES' ? value : 1 - value);
  const mean = side.reduce((sum, value) => sum + value, 0) / side.length;
  const n = side.length;
  const sd = n > 1 ? Math.sqrt(side.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : 0;
  const half = n > 1 ? (T_975[n - 1] || 1.96) * sd / Math.sqrt(n) : 0;
  const round = value => Math.round(value * 1000) / 1000;
  // The gate compares the unrounded bound; rounded values are for display only.
  return { choice, mean: round(mean), sd: round(sd), n, lower: round(Math.max(0, mean - half)), upper: round(Math.min(1, mean + half)), rawLower: Math.max(0, mean - half) };
}

// Every check is reported, passed or not, so the screen can say exactly what fell short.
function evaluateGate({ level, interval, opinionScores = [], reviewScore, reviewPassed, readiness }) {
  const rules = gateLevel(level);
  const scores = opinionScores.filter(row => Number.isFinite(row?.total));
  const average = scores.length ? Math.round(scores.reduce((sum, row) => sum + row.total, 0) / scores.length * 100) / 100 : null;
  const checks = [
    { id: 'interval', label: '판정 95% 신뢰구간 아래쪽 끝', value: interval?.lower ?? null, target: rules.lowerBound, passed: !!interval && interval.n >= 2 && (interval.rawLower ?? interval.lower) >= rules.lowerBound },
    { id: 'minQuality', label: '가장 낮은 답변 품질', value: scores.length ? Math.min(...scores.map(row => row.total)) : null, target: rules.minQuality, passed: scores.length > 0 && scores.every(row => row.total >= rules.minQuality) },
    { id: 'avgQuality', label: '답변 품질 평균', value: average, target: rules.avgQuality, passed: average !== null && average >= rules.avgQuality },
    { id: 'review', label: '최종 보고서 적합성 검토', value: Number.isFinite(reviewScore) ? reviewScore : null, target: rules.review, passed: Number.isFinite(reviewScore) && reviewScore >= rules.review && reviewPassed !== false },
    { id: 'readiness', label: '인터뷰 준비도', value: Number.isFinite(readiness) ? readiness : null, target: rules.readiness, passed: readiness === undefined || (Number.isFinite(readiness) && readiness >= rules.readiness) },
  ];
  return { level: rules.id, label: rules.label, passed: checks.every(check => check.passed), checks };
}

module.exports = { GATE_LEVELS, DEFAULT_GATE_LEVEL, VERDICT_SAMPLES, gateLevel, verdictInterval, evaluateGate };
