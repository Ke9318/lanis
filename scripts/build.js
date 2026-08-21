#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'build-config.json'), 'utf8'));
const version = process.argv[2] || config.userscriptVersion;
const coreVersion = process.argv[3] || config.sharedCoreVersion;
if (!version || !coreVersion) throw new Error('build-config.json requires userscriptVersion and sharedCoreVersion');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const normalFiles = [
  'src/normal/core.js', 'src/normal/shell-globals.js', 'src/normal/daily.js',
  'src/normal/arena.js', 'src/normal/preseason.js', 'src/normal/rejob.js',
  'src/normal/autohunt.js', 'src/normal/raremap.js', 'src/normal/dungeon.js',
  'src/normal/deepdungeon.js', 'src/normal/guildboss.js', 'src/normal/shell-runtime.js',
];
const normal = normalFiles.map((file, index) => read(file) + (index < normalFiles.length - 1 ? (index < 2 ? '\n\n' : '\n') : '')).join('');
const boss = read('src/boss/boss.js');
const shared = `// Ranis Shared Core ${coreVersion}\n` +
`// Generated deterministically from src/normal and src/boss.\n` +
`(function (global) {\n  'use strict';\n  if (global.__lanisSharedCoreBootstrap) return;\n` +
`  global.__lanisSharedCoreBootstrap = function (options = {}) {\n` +
`    if (global.__lanisSharedCoreAdapter) {\n` +
`      if (options.mode !== 'headless') {\n` +
`        global.__lanisSharedCoreOptions = Object.freeze({ mode: 'manual', version: '${coreVersion}' });\n` +
`        global.__mountLanisUnifiedPanel?.();\n` +
`        global.__mountLanisBossTool?.();\n` +
`      }\n` +
`      return global.__lanisSharedCoreAdapter;\n` +
`    }\n` +
`    global.__lanisSharedCoreOptions = Object.freeze({ mode: options.mode === 'headless' ? 'headless' : 'manual', version: '${coreVersion}' });\n` +
`(function () {\n${normal}})();\n\n${boss}\n` +
`    return global.__lanisSharedCoreAdapter || null;\n  };\n})(window);\n`;
const header = `// ==UserScript==\n// @name         lanis\n// @namespace    lanis\n// @version      ${version}\n// @description  재전직 / 자동사냥 / 레어맵 / 던전 / 아레나 / 심층던전 / 개인 보스 / 일일 연속 자동화를 하나의 패널에서 제공하며 각 모듈의 실행 로직은 독립적으로 격리.\n// @match        https://lanis.me/*\n// @run-at       document-idle\n// @grant        none\n// @updateURL    https://raw.githubusercontent.com/Ke9318/lanis/main/lanis.user.js\n// @downloadURL  https://raw.githubusercontent.com/Ke9318/lanis/main/lanis.user.js\n// ==/UserScript==\n\n`;
const wrapper = `${header}${shared}\nwindow.__lanisSharedCoreBootstrap({ mode: 'manual' });\n`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'lanis-shared-core.js'), shared, 'utf8');
fs.writeFileSync(path.join(root, 'lanis.user.js'), wrapper, 'utf8');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
fs.writeFileSync(path.join(root, 'dist', 'manifest.json'), JSON.stringify({
  schema: 'ranis-shared-core-release-v1', coreVersion,
  artifacts: {
    'lanis-shared-core.js': { sha256: digest(shared), bytes: Buffer.byteLength(shared) },
    'lanis.user.js': { sha256: digest(wrapper), bytes: Buffer.byteLength(wrapper) },
  },
}, null, 2) + '\n');
console.log(`built userscript=${version} core=${coreVersion} coreSha256=${digest(shared)}`);
