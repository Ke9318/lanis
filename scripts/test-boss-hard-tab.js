const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'boss', 'boss.js'),
  'utf8'
);

const helperStart = source.indexOf('M.ensureBossDifficultyTab = async');
const helperEnd = source.indexOf('\n  };', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart, '난이도 탭 보장 함수를 찾지 못함');
const helperSource = source.slice(helperStart, helperEnd + '\n  };'.length);

function buildHarness({ selected = false } = {}) {
  let pressed = selected;
  let cardReady = selected;
  let clicks = 0;
  const card = { id: 'hard-boss-card' };
  const tab = {
    textContent: 'HARD',
    getAttribute(name) {
      if (name === 'aria-pressed') return pressed ? 'true' : 'false';
      return null;
    },
    click() {
      clicks++;
      pressed = true;
      cardReady = true;
    },
  };
  const M = {
    throwIfStopped() {},
    isVisible() { return true; },
    queryAll(selector) { return selector === 'button' ? [tab] : []; },
    findBossCardActionButton(label) {
      return label === '타락한 정화자' && cardReady ? card : null;
    },
    async waitFor(check) { return check(); },
  };
  const helper = new Function('M', `${helperSource}\nreturn M.ensureBossDifficultyTab;`)(M);
  return { helper, card, getClicks: () => clicks };
}

(async () => {
  const hard = buildHarness();
  const hardCard = await hard.helper('타락한 정화자', { hard: true });
  assert.equal(hardCard, hard.card, 'HARD 카드가 렌더링된 뒤 반환돼야 함');
  assert.equal(hard.getClicks(), 1, '일반 탭에서는 HARD 탭을 한 번 눌러야 함');

  const alreadyHard = buildHarness({ selected: true });
  await alreadyHard.helper('타락한 정화자', { hard: true });
  assert.equal(alreadyHard.getClicks(), 0, '이미 HARD 탭이면 다시 누르지 않아야 함');

  const driveStart = source.indexOf('M.driveToBossAndRun = async');
  const driveEnd = source.indexOf('\n  M.startBossRun = async', driveStart);
  const driveSource = source.slice(driveStart, driveEnd);
  assert(
    driveSource.indexOf('await M.ensureBossDifficultyTab(entry.label') <
      driveSource.indexOf('await M.ensureElementForBoss(entry.label'),
    '속성 확인 전에 난이도 탭을 먼저 보장해야 함'
  );

  const dailyStart = source.indexOf('M.runDailySelectedBosses = async');
  const dailyEnd = source.indexOf('\n  M.startBossQueue = async', dailyStart);
  const dailySource = source.slice(dailyStart, dailyEnd);
  assert(
    dailySource.includes('for (const key of selected)'),
    '일일 보스 상태 확인은 탭 충돌을 막기 위해 순차 실행해야 함'
  );
  assert(
    dailySource.indexOf('await M.ensureBossDifficultyTab(entry.label') <
      dailySource.indexOf('alreadyCleared: M.isBossAlreadyCleared(entry.label)'),
    '오늘 처치 여부를 읽기 전에 해당 보스 난이도 탭을 열어야 함'
  );

  console.log('PASS: HARD 보스 탭 전환 및 판정 순서 회귀 테스트');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
