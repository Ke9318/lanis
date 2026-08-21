#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const shared = fs.readFileSync(path.join(root, 'dist', 'lanis-shared-core.js'), 'utf8');
const userscript = fs.readFileSync(path.join(root, 'lanis.user.js'), 'utf8');
if (!userscript.includes(shared)) throw new Error('userscript does not embed the exact Shared Core artifact');
if (!userscript.endsWith("window.__lanisSharedCoreBootstrap({ mode: 'manual' });\n")) throw new Error('thin manual wrapper missing');
new vm.Script(shared, { filename: 'dist/lanis-shared-core.js' });
new vm.Script(userscript, { filename: 'lanis.user.js' });
for (const required of ['__lanisSharedCoreAdapter', 'EXECUTION_LEASE_KEY', 'RanisHydraClientState', 'Core.startDaily', 'Core.stopDaily']) {
  if (!shared.includes(required)) throw new Error(`Shared Core lost required behavior marker: ${required}`);
}
const payloadStart = shared.indexOf('(function () {', shared.indexOf('global.__lanisSharedCoreBootstrap'));
const payloadEnd = shared.lastIndexOf('    return global.__lanisSharedCoreAdapter');
const packagingOnly = shared.slice(0, payloadStart) + shared.slice(payloadEnd);
for (const forbidden of ['fetch(', 'XMLHttpRequest(', 'new WebSocket(']) {
  if (packagingOnly.includes(forbidden)) throw new Error(`bootstrap added network primitive: ${forbidden}`);
}
console.log('build parity PASS: exact artifact embedding, syntax, preserved behavior markers, network-free bootstrap');
