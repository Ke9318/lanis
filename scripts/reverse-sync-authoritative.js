#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const input = fs.readFileSync(path.join(root, 'lanis.user.js'), 'utf8').replace(/\r\n/g, '\n');
const normalStart = input.indexOf("(function () {\n  'use strict';");
const normalEnd = input.indexOf('\n})();\n\n// ==================== 독립 개인 보스 자동화 도구', normalStart);
if (normalStart < 0 || normalEnd < 0) throw new Error('authoritative normal runtime boundaries not found');

const normal = input.slice(normalStart + '(function () {\n'.length, normalEnd);
const boundaries = [
  ['core.js', "  'use strict';"],
  ['shell-globals.js', '  // ==========================================================================\n  // 모듈 정의: 재전직 / 자동사냥 / 레어맵 / 던전 / 심층던전'],
  ['daily.js', '  Modules.daily = {'],
  ['arena.js', '  // -------------------------- 아레나 --------------------------'],
  ['preseason.js', '  // -------------------------- 가을 심층던전 아레나 --------------------------'],
  ['rejob.js', '  // -------------------------- 모듈 1: 재전직 --------------------------'],
  ['autohunt.js', '  // -------------------------- 모듈 2: 자동사냥 --------------------------'],
  ['raremap.js', '  // -------------------------- 모듈 3: 레어맵 --------------------------'],
  ['dungeon.js', '  // -------------------------- 모듈 4: 던전 --------------------------'],
  ['deepdungeon.js', '  // -------------------------- 모듈 5: 심층던전 --------------------------'],
  ['guildboss.js', '  // -------------------------- 모듈: 길드 보스 --------------------------'],
  ['shell-runtime.js', '  Core.startModule = function (moduleId, options = {}) {'],
];

const starts = boundaries.map(([name, marker]) => {
  const index = normal.indexOf(marker);
  if (index < 0) throw new Error(`boundary not found for ${name}`);
  return index;
});
for (let i = 1; i < starts.length; i += 1) {
  if (starts[i] <= starts[i - 1]) throw new Error(`out-of-order boundary: ${boundaries[i][0]}`);
}

for (let i = 0; i < boundaries.length; i += 1) {
  const end = i + 1 < boundaries.length ? starts[i + 1] : normal.length;
  const content = normal.slice(starts[i], end).replace(/\n+$/, '\n');
  fs.writeFileSync(path.join(root, 'src', 'normal', boundaries[i][0]), content, 'utf8');
}

const bossStart = normalEnd + '\n})();\n\n'.length;
fs.writeFileSync(path.join(root, 'src', 'boss', 'boss.js'), input.slice(bossStart).replace(/\n*$/, '\n'), 'utf8');
console.log('reverse-sync complete: authoritative lanis.user.js -> src/normal + src/boss');
