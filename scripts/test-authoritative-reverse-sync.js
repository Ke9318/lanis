#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const files = [
  'src/normal/core.js', 'src/normal/shell-globals.js', 'src/normal/daily.js',
  'src/normal/arena.js', 'src/normal/preseason.js', 'src/normal/rejob.js',
  'src/normal/autohunt.js', 'src/normal/raremap.js', 'src/normal/dungeon.js',
  'src/normal/deepdungeon.js', 'src/normal/guildboss.js', 'src/normal/shell-runtime.js',
];
let normal = files.map((file, index) => read(file) + (index < files.length - 1 ? (index < 2 ? '\n\n' : '\n') : '')).join('');
normal = normal.replace("\n  window.__mountLanisUnifiedPanel = buildPanel;\n\n", '\n');
normal = normal.replace(
  "    const headless = window.__lanisSharedCoreOptions?.mode === 'headless';\n    if (!headless && document.getElementById('lrm-panel')) return;\n    if (!headless) {\n      buildPanel();\n      Core.log('core', '통합 매크로 패널 로드 완료 (재전직 / 자동사냥 / 레어맵 / 던전 / 아레나 / 심층던전 / 보스 / 일일)');\n    }",
  "    if (document.getElementById('lrm-panel')) return;\n    buildPanel();\n    Core.log('core', '통합 매크로 패널 로드 완료 (재전직 / 자동사냥 / 레어맵 / 던전 / 아레나 / 심층던전 / 보스 / 일일)');"
);
let boss = read('src/boss/boss.js').replace(
  "  if (window.__lanisSharedCoreOptions?.mode !== 'headless') buildPanel();",
  '  buildPanel();'
);
const header = `// ==UserScript==\n// @name         lanis\n// @namespace    lanis\n// @version      1.14.27-stable\n// @description  재전직 / 자동사냥 / 레어맵 / 던전 / 아레나 / 심층던전 / 개인 보스 / 일일 연속 자동화를 하나의 패널에서 제공하며 각 모듈의 실행 로직은 독립적으로 격리.\n// @match        https://lanis.me/*\n// @run-at       document-idle\n// @grant        none\n// @updateURL    https://raw.githubusercontent.com/Ke9318/lanis/main/lanis.user.js\n// @downloadURL  https://raw.githubusercontent.com/Ke9318/lanis/main/lanis.user.js\n// ==/UserScript==\n\n`;
const reconstructed = `${header}(function () {\n${normal}})();\n\n${boss}`;
const hash = crypto.createHash('sha256').update(reconstructed).digest('hex');
const expected = '4945f707cd09496e0a132b173744df5c576dc66d2eed226225efedca24d184af';
if (hash !== expected) {
  fs.writeFileSync(path.join(root, 'reverse-sync-reconstructed.js'), reconstructed);
  throw new Error(`reverse-sync parity failed: ${hash} != ${expected}`);
}
console.log(`authoritative reverse-sync parity PASS: sha256=${hash}`);
