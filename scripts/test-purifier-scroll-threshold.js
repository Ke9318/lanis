const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'boss', 'boss.js'),
  'utf8'
);
const start = source.indexOf('M.getCorruptedPurifierScrollDefenseThreshold =');
const end = source.indexOf(';', start);
assert(start >= 0 && end > start, '정화자 스크롤 기준 함수를 찾지 못함');

const snippet = source.slice(start, end + 1);
const M = { getKstDayOfWeek: () => 0 };
const threshold = new Function(
  'M',
  `${snippet}\nreturn M.getCorruptedPurifierScrollDefenseThreshold;`
)(M);

assert.equal(threshold('어둠', 400, 0), 280, '일요일 어둠은 280이어야 함');
assert.equal(threshold('어둠', 400, 1), 400, '월요일 어둠은 400을 유지해야 함');
assert.equal(threshold('어둠', 400, 2), 400, '화요일 어둠은 400을 유지해야 함');
assert.equal(threshold('불', 400, 0), 400, '일요일 비어둠 속성은 400을 유지해야 함');
assert.equal(threshold('빛', 400, 6), 400, '토요일 빛은 400을 유지해야 함');
assert.equal(threshold('바람', 400, 4), 400, '목요일 바람은 400을 유지해야 함');

const sealStart = source.indexOf('M.runCorruptedPurifierSwordSealPattern =');
const sealEnd = source.indexOf('M.runCorruptedPurifierSwordDefenseBreakPattern =', sealStart);
const sealPattern = source.slice(sealStart, sealEnd);
assert(
  sealPattern.includes('defDrop >= effectiveDefenseDropThreshold'),
  '월·화·일 패턴이 계산된 기준값을 사용해야 함'
);

console.log('PASS: 일요일 어둠 정화자만 방↓280, 나머지는 방↓400');
