  Modules.daily = {
    id: 'daily',
    running: false,
    stopRequested: false,
    config: {
      dungeon: true,
      arena: true,
      boss: true,
      autohunt: true,
      deepdungeon: true,
    },
  };

  // -------------------------- 일일 연속 실행 --------------------------
  const DAILY_STATE_KEY = 'lrm-daily-sequence-state';
  const DAILY_AUTH_SCHEMA = 'daily-explicit-v2';
  // localStorage의 오래된 running 값만으로 작업을 자동 시작하지 않는다.
  // 사용자가 이 탭에서 직접 시작했을 때만 sessionStorage 허가가 생기며,
  // 정지/탭 종료 시 사라진다.
  const DAILY_AUTH_KEY = 'lrm-daily-explicit-run-auth';
  const DAILY_CONFIG_KEYS = ['dungeon', 'arena', 'preseason', 'boss', 'autohunt', 'deepdungeon'];
  // ⚠ 사용자 요청(2026-08): 심층던전/아레나 주간 보상은 그 매크로를 돌리지
  // 않아도 "일일" 실행 시 최우선으로 받아야 하고, 일주일에 한 번만 확인하면
  // 된다. Core.getKstMondayWeekId()가 반환하는 값(매주 월요일 00:00 KST마다
  // 바뀜)을 여기에 저장해, 이미 확인한 주라면 API 호출조차 다시 하지 않는다.
  const DD_REWARD_WEEK_KEY = 'lrm-deepdungeon-reward-week-done';
  const ARENA_REWARD_WEEK_KEY = 'lrm-arena-reward-week-done';
  const GUILD_BOSS_REWARD_DAY_KEY = 'lrm-guildboss-reward-day-done';
  const DAILY_STEP_LABELS = {
    weeklyRewards: '주간 보상(심층던전+아레나)',
    dailyQuests: '일간+주간 퀘스트',
    attendance: '출석체크',
    dungeon: '던전',
    arena: '아레나',
    preseason: '프리시즌',
    boss: '보스',
    autohunt: '자동사냥',
    deepdungeon: '심층던전',
  };

  Modules.daily.loadState = function () {
    try {
      const value = JSON.parse(localStorage.getItem(DAILY_STATE_KEY) || 'null');
      return value && value.running ? value : null;
    } catch (e) {
      return null;
    }
  };

  Modules.daily.saveState = function (state) {
    localStorage.setItem(DAILY_STATE_KEY, JSON.stringify(state));
  };

  Modules.daily.findVisibleMenuItem = function (text) {
    return Core.gameElements('[role="menuitem"]').find((item) =>
      item.textContent.trim() === text &&
      Core.isElementVisible(item)
    ) || null;
  };

  Modules.daily.goToMonthlyAttendance = async function () {
    const shouldCancel = () => this.stopRequested || !Core.dailyActive;
    if (location.pathname.replace(/\/$/, '') !== '/event/pass') {
      let eventItem = this.findVisibleMenuItem('이벤트');
      if (!eventItem) {
        const findProfileButton = () => {
          const header = document.querySelector('header, [role="banner"]');
          if (!header) return null;
          const buttons = [...header.querySelectorAll('button')]
            .filter((button) => !button.closest('#lrm-panel, #lrm-banner'));
          return buttons.length > 0 ? buttons[buttons.length - 1] : null;
        };
        const opened = await Core.safeClick(findProfileButton, {
          beforeMin: 550,
          beforeMax: 950,
          afterMin: 250,
          afterMax: 450,
          shouldCancel,
        });
        if (!opened) throw new Error('맨 오른쪽 사용자 메뉴 버튼을 누르지 못했습니다.');
        eventItem = await Core.waitFor(
          () => this.findVisibleMenuItem('이벤트'),
          6000,
          150,
          shouldCancel
        );
      }
      if (!eventItem) throw new Error('사용자 메뉴의 "이벤트" 항목을 찾지 못했습니다.');
      const clickedEvent = await Core.safeClick(
        () => this.findVisibleMenuItem('이벤트'),
        {
          beforeMin: 550,
          beforeMax: 950,
          afterMin: 350,
          afterMax: 650,
          shouldCancel,
        }
      );
      if (!clickedEvent) throw new Error('사용자 메뉴의 "이벤트"를 누르지 못했습니다.');
    }

    const eventPage = await Core.waitFor(
      () =>
        location.pathname.replace(/\/$/, '') === '/event/pass' &&
        Core.gameElements('[role="tab"]').some((tab) =>
          tab.textContent.trim() === '월간 출석체크'
        ),
      15000,
      250,
      shouldCancel
    );
    if (!eventPage) throw new Error('이벤트 화면 진입을 확인하지 못했습니다.');

    const findMonthlyTab = () => Core.gameElements('[role="tab"]').find(
      (tab) => tab.textContent.trim() === '월간 출석체크'
    ) || null;
    const monthlyTab = findMonthlyTab();
    if (!monthlyTab) throw new Error('"월간 출석체크" 탭을 찾지 못했습니다.');
    if (monthlyTab.getAttribute('aria-selected') !== 'true') {
      const clickedTab = await Core.safeClick(findMonthlyTab, {
        beforeMin: 500,
        beforeMax: 900,
        afterMin: 350,
        afterMax: 650,
        shouldCancel,
      });
      if (!clickedTab) throw new Error('"월간 출석체크" 탭을 누르지 못했습니다.');
    }

    const attendanceReady = await Core.waitFor(
      () => {
        const tab = findMonthlyTab();
        if (!tab || tab.getAttribute('aria-selected') !== 'true') return null;
        const text = Core.bodyText();
        return text.includes('출석일수:') && text.includes('다음 출석체크 가능 시간:')
          ? true
          : null;
      },
      10000,
      200,
      shouldCancel
    );
    if (!attendanceReady) throw new Error('월간 출석체크 화면의 상태를 읽지 못했습니다.');
  };

  Modules.daily.runAttendance = async function () {
    const shouldCancel = () => this.stopRequested || !Core.dailyActive;
    await this.goToMonthlyAttendance();
    if (shouldCancel()) throw new Error('사용자가 일일 실행을 정지했습니다.');

    const findClaimButton = () => Core.gameElements('button').find((button) =>
      button.textContent.trim() === '월간 출석체크하기' &&
      !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true'
    ) || null;
    const claimButton = findClaimButton();
    if (!claimButton) {
      const alreadyDone = Core.gameElements('button').some((button) =>
        button.textContent.trim() === '오늘 월간 출석체크 완료' && button.disabled
      );
      return alreadyDone
        ? '오늘 월간 출석체크 이미 완료 - 건너뜀'
        : '현재 받을 수 있는 월간 출석 보상 없음 - 건너뜀';
    }

    const beforeText = Core.bodyText();
    const beforeMatch = beforeText.match(/출석일수:\s*(\d+)일/);
    const beforeDays = beforeMatch ? parseInt(beforeMatch[1], 10) : null;
    const clicked = await Core.safeClick(findClaimButton, {
      beforeMin: 650,
      beforeMax: 1100,
      afterMin: 300,
      afterMax: 550,
      shouldCancel,
    });
    if (!clicked) throw new Error('월간 출석체크 수령 버튼 클릭에 실패했습니다.');

    const completed = await Core.waitFor(
      () => {
        const doneButton = Core.gameElements('button').find((button) =>
          button.textContent.trim() === '오늘 월간 출석체크 완료' && button.disabled
        );
        if (!doneButton) return null;
        const match = Core.bodyText().match(/출석일수:\s*(\d+)일/);
        const afterDays = match ? parseInt(match[1], 10) : null;
        return beforeDays === null || afterDays === null || afterDays > beforeDays
          ? { afterDays }
          : null;
      },
      12000,
      200,
      shouldCancel
    );
    if (!completed) throw new Error('월간 출석체크 보상 수령 완료 상태를 확인하지 못했습니다.');

    const closeButton = Core.gameElements('[role="alert"] button').find((button) =>
      ['Close', '닫기', '확인'].includes(button.textContent.trim()) ||
      ['Close', '닫기'].includes(button.getAttribute('aria-label') || '')
    );
    if (closeButton) {
      await Core.safeClick(() => closeButton.isConnected ? closeButton : null, {
        beforeMin: 250,
        beforeMax: 450,
        shouldCancel,
      });
    }
    return completed.afterDays
      ? `월간 출석체크 ${completed.afterDays}일차 보상 수령 완료`
      : '월간 출석체크 보상 수령 완료';
  };

  Modules.daily.verifyDungeon = async function () {
    const shouldCancel = () => this.stopRequested || !Core.dailyActive;
    const arrived = await Modules.dungeon.goToDungeonSelect(shouldCancel);
    if (shouldCancel()) throw new Error('사용자가 일일 실행을 정지했습니다.');
    if (!arrived) throw new Error('던전 선택 화면 진입을 확인하지 못함');
    const remaining = Modules.dungeon.scanEligibleDungeons();
    if (remaining.length > 0) {
      throw new Error(`아직 입장 가능한 던전이 남아 있음: ${remaining.map((d) => d.label).join(', ')}`);
    }
    return '입장 가능한 모든 던전 완료 또는 입장권 소진 확인';
  };

  Modules.daily.verifyAutohunt = async function () {
    const shouldCancel = () => this.stopRequested || !Core.dailyActive;
    const mod = Modules.autohunt;
    const onGround = await mod.ensureOnGround(
      mod.config.groundSuffix,
      mod.config.floor,
      shouldCancel
    );
    if (shouldCancel()) throw new Error('사용자가 일일 실행을 정지했습니다.');
    if (!onGround) throw new Error('사냥 종료 후 사냥터 화면을 확인하지 못함');
    const energy = mod.readEnergy();
    if (energy === null) throw new Error('사냥 종료 후 행동력을 읽지 못함');
    if (energy >= mod.config.minEnergy) {
      throw new Error(`행동력이 제한 이상으로 남음: ${energy}/2000 (기준 ${mod.config.minEnergy})`);
    }
    return `행동력 제한 도달 확인: ${energy}/2000`;
  };

  Modules.daily.verifyDeepDungeon = async function () {
    const shouldCancel = () => this.stopRequested || !Core.dailyActive;
    const mod = Modules.deepdungeon;
    const arrived = await mod.goToDeepDungeon(shouldCancel);
    if (shouldCancel()) throw new Error('사용자가 일일 실행을 정지했습니다.');
    if (!arrived) throw new Error('심층던전 화면 진입을 확인하지 못함');
    const damage = await mod.readWeeklyCumulativeDamage(shouldCancel);
    if (shouldCancel()) throw new Error('사용자가 일일 실행을 정지했습니다.');
    if (damage === null) throw new Error('심층던전 주간 누적 데미지를 읽지 못함');
    if (damage < 1000000) throw new Error(`주간 누적 데미지가 아직 100만 미만: ${damage.toLocaleString()}`);
    return `주간 누적 데미지 ${damage.toLocaleString()} 확인`;
  };

  Modules.daily.runCoreModule = async function (moduleId) {
    Core.moduleResults[moduleId] = { ok: null, message: '일일 작업에서 시작', at: Date.now() };
    const promise = Core.startModule(moduleId, { fromDaily: true });
    if (!promise) throw new Error(`${DAILY_STEP_LABELS[moduleId]} 시작이 차단됨`);
    await promise;
    const result = Core.moduleResults[moduleId];
    if (result && result.ok === false) throw new Error(result.message);
  };

  // ⚠ 사용자 요청(2026-08): 일일 퀘스트 "장인 정신"(아이템 조합 1회)을 위해
  // 마을 > 대장간 > 조합소 > 상자 카테고리에서 금 → 은 → 동 순서로 시도해
  // 1개 조합한다. 실전 확인: 목록의 "선택"/"확인" 버튼 텍스트는 재료 보유
  // 여부와 무관하다(둘 다 재료가 충분해도 라벨이 다르게 나옴) — 반드시
  // 클릭해서 확인 다이얼로그를 열고 "최대 N개 조합 가능" 문구로 실제
  // 조합 가능 여부를 판단해야 한다. 상자 셋 다 실패하면 가죽 카테고리로
  // 넘어간다(세부 우선순위는 추후 확정 - 지금은 상자만 구현).
  // ⚠ 사용자 요청(2026-08): 이 퀘스트는 "1회 조합"이면 완료되므로, 절대
  // 중복으로 조합하면 안 된다. 대장간에 가기 전에 먼저 퀘스트 화면에서
  // "장인 정신" 진행도(N/M)를 확인해서, 이미 완료(N>=M)면 대장간에 아예
  // 가지 않고 스킵한다. 이렇게 하면 "일일"을 하루에 여러 번 돌려도 두 번째
  // 부터는 조합 자체를 시도하지 않는다.
  Modules.daily.completeCraftQuestIfNeeded = async function () {
    await Core.clickNavMenuExact('캐릭', '퀘스트');
    const onQuestPage = await Core.waitFor(() => location.pathname.startsWith('/quests'), 15000, 300);
    if (!onQuestPage) {
      Core.log('daily', '⚠ 퀘스트 화면 진입을 확인하지 못해 아이템 조합 퀘스트를 건너뜁니다.');
      return false;
    }
    await Core.humanDelay(500, 900);

    const questText = Core.bodyText();
    const match = questText.match(/장인\s*정신\s*(\d+)\s*\/\s*(\d+)/);
    if (match && parseInt(match[1], 10) >= parseInt(match[2], 10)) {
      Core.log('daily', '"장인 정신" 퀘스트 이미 완료됨 - 조합 생략');
      return true;
    }

    return await Modules.daily.craftBoxQuestItem();
  };

  // ⚠ 사용자 요청(2026-08): 주간 퀘스트 "꾸준한 수행"(수행 5회)을 위해
  // 캐릭 > 수행 화면에서 "수행하기"를 눌러 나오는 "여러 번 수행하기"
  // 다이얼로그의 수량을 채운다. 기본값이 100(최대치)으로 잡혀 있어 그대로
  // 두면 안 되고, 실제로 필요한 횟수만 입력해야 한다 — 이미 몇 회 했는지도
  // 감안해 남은 횟수(목표-현재)만 정확히 채운다(실전 확인: 5회 실행 시
  // 숙련도 정확히 1,800×5 소모, 퀘스트 진행도 5/5로 정확히 반영됨).
  Modules.daily.completeCultivationQuestIfNeeded = async function () {
    await Core.clickNavMenuExact('캐릭', '퀘스트');
    const onQuestPage = await Core.waitFor(() => location.pathname.startsWith('/quests'), 15000, 300);
    if (!onQuestPage) {
      Core.log('daily', '⚠ 퀘스트 화면 진입을 확인하지 못해 수행 퀘스트를 건너뜁니다.');
      return false;
    }
    await Core.humanDelay(500, 900);

    const weeklyTab = await Core.retryStep('"주간" 탭 찾기', () => Core.findButtonByText('주간'));
    if (!weeklyTab) {
      Core.log('daily', '⚠ "주간" 탭을 찾지 못해 수행 퀘스트를 건너뜁니다.');
      return false;
    }
    if (!(await Core.safeClick(() => Core.findButtonByText('주간'), { beforeMin: 400, beforeMax: 700, afterMin: 700, afterMax: 1100 }))) {
      Core.log('daily', '⚠ "주간" 탭 클릭에 실패해 수행 퀘스트를 건너뜁니다.');
      return false;
    }

    const match = Core.bodyText().match(/꾸준한\s*수행\s*(\d+)\s*\/\s*(\d+)/);
    if (!match) {
      Core.log('daily', '⚠ "꾸준한 수행" 퀘스트 항목을 찾지 못했습니다.');
      return false;
    }
    const current = parseInt(match[1], 10);
    const target = parseInt(match[2], 10);
    if (current >= target) {
      Core.log('daily', '"꾸준한 수행" 퀘스트 이미 완료됨 - 생략');
      return true;
    }
    const remaining = target - current;

    await Core.clickNavMenuExact('캐릭', '수행');
    const onTrainingPage = await Core.waitFor(() => location.pathname.startsWith('/training'), 15000, 300);
    if (!onTrainingPage) {
      Core.log('daily', '⚠ 수행 화면 진입을 확인하지 못했습니다.');
      return false;
    }
    await Core.humanDelay(500, 900);

    const trainBtn = await Core.retryStep('"수행하기" 버튼 찾기', () => Core.findButtonByText('수행하기'));
    if (!trainBtn) {
      Core.log('daily', '⚠ "수행하기" 버튼을 찾지 못했습니다.');
      return false;
    }
    if (!(await Core.safeClick(() => Core.findButtonByText('수행하기'), { beforeMin: 500, beforeMax: 900, afterMin: 700, afterMax: 1100 }))) {
      Core.log('daily', '⚠ "수행하기" 버튼 클릭에 실패했습니다.');
      return false;
    }

    const dialog = await Core.waitFor(
      () => Core.gameElements('[role="dialog"]').find((d) => Core.isElementVisible(d) && d.textContent.includes('여러 번 수행하기')) || null,
      8000,
      250
    );
    if (!dialog) {
      Core.log('daily', '⚠ 수행 횟수 입력창을 찾지 못했습니다.');
      return false;
    }
    const input = dialog.querySelector('input');
    if (!input) {
      Core.log('daily', '⚠ 수행 횟수 입력칸을 찾지 못했습니다.');
      return false;
    }
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, String(remaining));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Core.humanDelay(400, 700);

    const confirmBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '수행하기');
    if (!confirmBtn) {
      Core.log('daily', '⚠ 수행 확인 버튼을 찾지 못했습니다.');
      return false;
    }
    confirmBtn.click();
    await Core.humanDelay(1200, 1800);
    Core.log('daily', `"꾸준한 수행" 퀘스트용 수행 ${remaining}회 완료`);
    return true;
  };

  // ⚠ 사용자 요청(2026-08): 일간 퀘스트 "대장간 이용"(대장간 수리 1회)을
  // 위해 마을 > 대장간 화면에서 활성화된 "수리" 버튼을 하나 누른다.
  // Core.repairAllEquipment는 내구도가 심각하게 낮을 때만 호출되는 함수라,
  // "그냥 아무거나 한 번 수리하면 되는" 이 퀘스트의 낮은 기준과 맞지 않아
  // 자연스러운 부산물로 채워지지 않았다(실전 확인: 자동사냥을 오래 돌려도
  // 내구도가 그 정도로까지 안 떨어지면 이 퀘스트만 항상 미완료로 남음).
  Modules.daily.completeRepairQuestIfNeeded = async function () {
    await Core.clickNavMenuExact('캐릭', '퀘스트');
    const onQuestPage = await Core.waitFor(() => location.pathname.startsWith('/quests'), 15000, 300);
    if (!onQuestPage) {
      Core.log('daily', '⚠ 퀘스트 화면 진입을 확인하지 못해 대장간 수리 퀘스트를 건너뜁니다.');
      return false;
    }
    await Core.humanDelay(500, 900);

    const match = Core.bodyText().match(/대장간\s*이용\s*(\d+)\s*\/\s*(\d+)/);
    if (!match) {
      Core.log('daily', '⚠ "대장간 이용" 퀘스트 항목을 찾지 못했습니다.');
      return false;
    }
    if (parseInt(match[1], 10) >= parseInt(match[2], 10)) {
      Core.log('daily', '"대장간 이용" 퀘스트 이미 완료됨 - 생략');
      return true;
    }

    await Core.clickNavMenuExact('마을', '대장간');
    const onBlacksmithPage = await Core.waitFor(() => location.pathname.startsWith('/blacksmith'), 15000, 300);
    if (!onBlacksmithPage) {
      Core.log('daily', '⚠ 대장간 화면 진입을 확인하지 못했습니다.');
      return false;
    }
    await Core.humanDelay(500, 900);

    const repairBtn = Core.gameElements('button').find(
      (b) => Core.isElementVisible(b) && /수리/.test(b.textContent) && !b.disabled
    );
    if (!repairBtn) {
      Core.log('daily', '수리 가능한 장비가 없습니다(전부 내구도 최대) - 대장간 이용 퀘스트를 이번엔 채우지 못함');
      return true;
    }
    if (!(await Core.safeClick(() => repairBtn, { beforeMin: 500, beforeMax: 900, afterMin: 700, afterMax: 1100 }))) {
      Core.log('daily', '⚠ 수리 버튼 클릭에 실패했습니다.');
      return false;
    }
    Core.log('daily', '일일 퀘스트용 장비 수리 완료');
    return true;
  };

  // ⚠ 사용자 요청(2026-08): 일간/주간 퀘스트 "보상 받기" 버튼도 자동으로
  // 누른다. 실전 확인: 확인창 없이 클릭 한 번으로 즉시 처리되고, 이미
  // 받았으면 버튼이 "수령 완료"로 바뀌며 disabled 상태가 된다. 7개 미만
  // 완료 상태면 "보상 받기 (N/7)"로 표시되지만 이때도 disabled라, 두
  // 경우 다 disabled 여부 하나로 정확히 "지금 받을 수 있는지"를 판별할
  // 수 있다(텍스트를 따로 안 봐도 됨).
  Modules.daily.claimQuestRewardIfReady = async function (tabLabel) {
    await Core.clickNavMenuExact('캐릭', '퀘스트');
    const onQuestPage = await Core.waitFor(() => location.pathname.startsWith('/quests'), 15000, 300);
    if (!onQuestPage) {
      Core.log('daily', `⚠ 퀘스트 화면 진입을 확인하지 못해 ${tabLabel} 퀘스트 보상 수령을 건너뜁니다.`);
      return false;
    }
    await Core.humanDelay(500, 900);

    if (tabLabel === '주간') {
      const weeklyTab = await Core.retryStep('"주간" 탭 찾기', () => Core.findButtonByText('주간'));
      if (!weeklyTab) {
        Core.log('daily', '⚠ "주간" 탭을 찾지 못해 주간 퀘스트 보상 수령을 건너뜁니다.');
        return false;
      }
      if (!(await Core.safeClick(() => Core.findButtonByText('주간'), { beforeMin: 400, beforeMax: 700, afterMin: 700, afterMax: 1100 }))) {
        Core.log('daily', '⚠ "주간" 탭 클릭에 실패해 주간 퀘스트 보상 수령을 건너뜁니다.');
        return false;
      }
    }

    const rewardBtn = Core.gameElements('button').find(
      (b) => Core.isElementVisible(b) && b.textContent.trim().startsWith('보상 받기') && !b.disabled
    );
    if (!rewardBtn) {
      Core.log('daily', `${tabLabel} 퀘스트 보상: 받을 것 없음(조건 미달이거나 이미 수령함)`);
      return true;
    }
    rewardBtn.click();
    await Core.humanDelay(1000, 1500);
    Core.log('daily', `${tabLabel} 퀘스트 보상 수령 완료`);
    return true;
  };

  // 일간/주간 퀘스트까지 처리한 뒤 캐릭 메뉴에 레드닷이 남아 있으면 업적을
  // 확인한다. 업적 카테고리의 작은 빨간 점이 있는 탭만 열고, disabled가
  // 아닌 "보상 수령" 버튼만 누른다. 한 번 수령한 뒤 다음 단계 보상이 바로
  // 활성화될 수 있으므로 같은 카테고리에서 받을 것이 없어질 때까지 반복한다.
  Modules.daily.claimAchievementRewardsIfIndicated = async function () {
    const shouldCancel = () => this.stopRequested || !Core.dailyActive;
    const hasRedDot = (root) => {
      if (!root) return false;
      if (root.querySelector('.MuiBadge-dot')) return true;
      return [...root.querySelectorAll('span, div')].some((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.width > 12 || rect.height > 12) return false;
        const color = getComputedStyle(el).backgroundColor;
        return color === 'rgb(244, 67, 54)' || color === 'rgb(239, 68, 68)' || color === 'rgb(255, 0, 0)';
      });
    };
    const characterButton = Core.allButtons().find(
      (button) => button.textContent.trim() === '캐릭' && Core.isElementVisible(button)
    );
    if (!hasRedDot(characterButton)) {
      Core.log('daily', '업적: 캐릭 레드닷 없음 - 확인 생략');
      return '캐릭 레드닷 없음';
    }

    Core.log('daily', '업적: 캐릭 레드닷 확인 - 활성 보상 확인 시작');
    await Core.clickNavMenuExact('캐릭', '업적', shouldCancel);
    const onAchievementPage = await Core.waitFor(
      () => location.pathname.startsWith('/achievements'),
      15000,
      300,
      shouldCancel
    );
    if (!onAchievementPage) throw new Error('업적 화면 진입을 확인하지 못했습니다.');
    await Core.humanDelay(500, 900);

    const topTabs = new Set(['업적', '칭호', '프로필']);
    const findRedCategoryTabs = () => Core.gameElements('button[role="tab"]').filter(
      (tab) => Core.isElementVisible(tab) && !topTabs.has(tab.textContent.trim()) && hasRedDot(tab)
    );
    const findClaimButton = () => Core.gameElements('button').find(
      (button) => Core.isElementVisible(button) && button.textContent.trim() === '보상 수령' && !button.disabled
    ) || null;

    let claimed = 0;
    let visitedTabs = 0;
    // 비정상 DOM 갱신으로 무한 반복하지 않도록 충분히 큰 상한을 둔다.
    for (let guard = 0; guard < 100 && !shouldCancel(); guard += 1) {
      const claimButton = findClaimButton();
      if (claimButton) {
        if (!(await Core.safeClick(findClaimButton, {
          beforeMin: 350,
          beforeMax: 650,
          afterMin: 700,
          afterMax: 1100,
          shouldCancel,
        }))) throw new Error('활성 업적 보상 버튼이 클릭 직전에 사라졌습니다.');
        claimed += 1;
        continue;
      }

      const redTabs = findRedCategoryTabs();
      if (redTabs.length === 0) break;
      const selectedRedTab = redTabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
      const targetTab = redTabs.find((tab) => tab !== selectedRedTab) || selectedRedTab;
      // 선택된 빨간 탭인데 받을 버튼이 없다면 다른 알림이거나 갱신 대기 상태다.
      // 같은 탭을 계속 누르지 않고 종료해 다음 일일 실행에서 다시 확인한다.
      if (!targetTab || targetTab === selectedRedTab) break;
      const targetLabel = targetTab.textContent.trim();
      if (!(await Core.safeClick(() => findRedCategoryTabs().find(
        (tab) => tab.textContent.trim() === targetLabel
      ), {
        beforeMin: 350,
        beforeMax: 650,
        afterMin: 600,
        afterMax: 900,
        shouldCancel,
      }))) throw new Error(`업적 "${targetLabel}" 탭 클릭에 실패했습니다.`);
      visitedTabs += 1;
    }

    Core.log('daily', `업적: 레드닷 카테고리 ${visitedTabs}개 확인, 보상 ${claimed}개 수령`);
    return `업적 보상 ${claimed}개 수령`;
  };

  Modules.daily.craftBoxQuestItem = async function () {
    await Core.clickNavMenuExact('마을', '대장간');
    const onCraftPage = await Core.waitFor(() => Core.bodyText().includes('조합소'), 15000, 300);
    if (!onCraftPage) {
      Core.log('daily', '⚠ 대장간 화면 진입을 확인하지 못해 아이템 조합을 건너뜁니다.');
      return false;
    }

    const craftTab = await Core.retryStep('"조합소" 탭 찾기', () => Core.findButtonByText('조합소'));
    if (!craftTab) {
      Core.log('daily', '⚠ "조합소" 탭을 찾지 못해 아이템 조합을 건너뜁니다.');
      return false;
    }
    if (!(await Core.safeClick(() => Core.findButtonByText('조합소'), { beforeMin: 500, beforeMax: 900, afterMin: 700, afterMax: 1100 }))) {
      Core.log('daily', '⚠ "조합소" 탭 클릭에 실패해 아이템 조합을 건너뜁니다.');
      return false;
    }

    // ⚠ 실전 확인: 카테고리 필터(전체/가죽/결정/상자/해방/던전/일반)도
    // 인벤토리 보상 필터처럼 다중 토글이다(aria-pressed로 확인). "상자"만
    // 켜기 전에 이미 켜져 있는 다른 카테고리를 먼저 꺼야, 엉뚱한 카테고리
    // 레시피가 섞여 heading 검색이 꼬이지 않는다. 또한 페이지 전환 직후라
    // 클릭이 씹히는 경우를 실전에서 확인해, 클릭 후 실제 상태를 재확인하고
    // 필요하면 재시도한다.
    const setOnlyCategory = async (targetLabel) => {
      const categoryLabels = ['가죽', '결정', '상자', '해방', '던전', '일반'];
      for (let attempt = 0; attempt < 3; attempt++) {
        let allCorrect = true;
        for (const label of categoryLabels) {
          const btn = Core.gameElements('button').find((b) => b.textContent.trim() === label && Core.isElementVisible(b));
          if (!btn) continue;
          const isPressed = btn.getAttribute('aria-pressed') === 'true';
          const shouldBePressed = label === targetLabel;
          if (isPressed !== shouldBePressed) {
            allCorrect = false;
            btn.click();
            await Core.humanDelay(400, 700);
          }
        }
        if (allCorrect) return true;
      }
      return false;
    };
    await setOnlyCategory('상자');

    // 재료가 여러 경로(같은 완제품 이름의 서로 다른 레시피 행)로 존재할 수
    // 있다(예: "가죽끈"은 재료가 "가죽"인 행과 "낡은 가죽끈"인 행 둘 다 있음).
    // 이런 경우 모든 행을 순서대로 시도한다.
    //
    // ⚠ 버그 수정(2026-08, 사용자 확인): 예전엔 텍스트가 label과 정확히
    // 일치하는 모든 leaf를 찾아 레시피 행으로 오인했는데, 이러면 "낡은
    // 가죽끈"처럼 결과물 칸뿐 아니라 다른 레시피의 "필요 재료" 칸에도 같은
    // 이름이 나오는 경우 그 재료 칸까지 레시피 후보로 잘못 집어서, 조합을
    // 의도치 않게 2번 시도하는 사고가 있었다(실전 확인: 낡은 가죽끈이
    // "2회 조합됐다"는 게임 메시지). 실제 목록은 <tr><td>결과물</td>
    // <td>필요재료</td><td>버튼</td></tr> 테이블 구조이므로, 첫 번째 td
    // (결과물 칸)만 label과 비교해야 정확하다.
    const tryCraft = async (label) => {
      const findRecipeRows = () =>
        Core.gameElements('tr').filter((tr) => {
          const firstCell = tr.querySelector('td');
          return firstCell && firstCell.textContent.trim() === label && Core.isElementVisible(tr);
        });
      const rowCount = findRecipeRows().length;
      for (let variant = 0; variant < rowCount; variant++) {
        const getRow = () => findRecipeRows()[variant] || null;
        const getBtn = () => {
          const row = getRow();
          if (!row) return null;
          return [...row.querySelectorAll('button')].find((b) => ['선택', '확인'].includes(b.textContent.trim()));
        };
        if (!getBtn()) continue;
        if (!(await Core.safeClick(getBtn, { beforeMin: 400, beforeMax: 700, afterMin: 700, afterMax: 1100 }))) continue;

        const dialog = await Core.waitFor(
          () => Core.gameElements('[role="dialog"]').find((d) => Core.isElementVisible(d) && d.textContent.includes('조합 확인')) || null,
          8000,
          250
        );
        if (!dialog) continue;

        // ⚠ 실전 확인(2026-08): 조합 확인창은 레시피에 따라 두 형식이다.
        //   1) 고정 필요 재료 개수(예: "금의 상자" - 조각 6개, 성공률
        //      100%) - 재료가 충분하면 바로 "조합" 버튼이 활성화된다.
        //   2) 투입 수량을 라디오로 선택(예: "가죽끈" - 4개 100%/3개
        //      85%/2개 70%) - 라디오를 하나 선택해야 "조합" 버튼이
        //      활성화된다.
        // 두 형식 모두 "조합" 버튼 클릭 = 정확히 1회 시도다. "N개 투입"은
        // "N회 시도"가 아니라 "1회 시도에 재료 N개를 써서 성공률을 높인다"
        // 는 뜻임을 실전으로 확인했다(2개 옵션으로 1회 시도 → "조합에
        // 실패했습니다" 메시지 정확히 1번, 골드·재료도 1회분만 소모).
        // 라디오가 있으면 재료를 아끼기 위해 가장 낮은 투입량(화면에
        // 나열된 순서상 마지막 옵션, 성공률도 가장 낮음)을 선택한다.
        const radios = [...dialog.querySelectorAll('input[type="radio"]')];
        if (radios.length > 0) {
          radios[radios.length - 1].click();
          await Core.humanDelay(300, 500);
        }

        const confirmBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '조합');
        if (confirmBtn && !confirmBtn.disabled) {
          confirmBtn.click();
          await Core.humanDelay(1000, 1600);
          Core.log('daily', `일일 퀘스트용 아이템 조합 시도 완료: ${label}`);
          return true;
        }
        const cancelBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '취소');
        if (cancelBtn) cancelBtn.click();
        await Core.humanDelay(400, 700);
      }
      return false;
    };

    for (const label of ['금의 상자', '은의 상자', '동의 상자']) {
      if (await tryCraft(label)) return true;
    }

    // ⚠ 사용자 요청(2026-08): 상자 카테고리에서 전부 실패하면 가죽 카테고리로
    // 넘어간다. 우선순위(사용자 지정): 고급 가죽끈 → 가죽끈 → 낡은 가죽끈.
    Core.log('daily', '상자 카테고리에서 조합 가능한 재료가 없어 가죽 카테고리로 전환합니다.');
    await setOnlyCategory('가죽');

    for (const label of ['고급 가죽끈', '가죽끈', '낡은 가죽끈']) {
      if (await tryCraft(label)) return true;
    }

    Core.log('daily', '상자·가죽 카테고리 모두에서 조합 가능한 재료가 없습니다.');
    return false;
  };

  // ⚠ 사용자 요청(2026-08): 심층던전(보상 3종)/아레나(지난 주 순위 보상)를
  // 각 매크로가 실제로 돌아가는지와 완전히 무관하게, "일일" 실행 시 이번
  // 주에 한 번만 확인해서 받는다. 아레나는 토·일에만 진입 가능한데 보상은
  // 월~금에만 받을 수 있어, 아레나 매크로 자체에 묶으면 영영 못 받는 모순이
  // 생긴다는 걸 사용자가 명확히 지적함 — 그래서 여기 daily 레벨에서 독립
  // 처리한다.
  Modules.daily.claimWeeklyRewardsIfDue = async function () {
    const weekId = Core.getKstMondayWeekId();
    const results = [];

    if (localStorage.getItem(DD_REWARD_WEEK_KEY) === weekId) {
      results.push('심층던전: 이번 주 이미 확인함');
    } else {
      const ok = await Modules.deepdungeon.claimWeeklyWorldBossRewards();
      if (ok) {
        localStorage.setItem(DD_REWARD_WEEK_KEY, weekId);
        results.push('심층던전: 확인 완료');
      } else {
        results.push('심층던전: 확인 실패(다음 실행 시 재시도)');
      }
    }

    if (localStorage.getItem(ARENA_REWARD_WEEK_KEY) === weekId) {
      results.push('아레나: 이번 주 이미 확인함');
    } else {
      const ok = await Modules.arena.claimLastWeekRewardIfAny();
      if (ok) {
        localStorage.setItem(ARENA_REWARD_WEEK_KEY, weekId);
        results.push('아레나: 확인 완료');
      } else {
        results.push('아레나: 확인 실패(다음 실행 시 재시도)');
      }
    }

    return results.join(' / ');
  };

  // ⚠ 사용자 요청(2026-08): 길드 보스(히드라)는 화·목에 길드마스터가
  // 소환하고, 개인 보상은 레이드가 끝난 뒤 그 화면(/guild/boss)에서
  // "개인 보상 수령하기"로 받는다. 화·목 다음날인 수·금에 확인해야 한다
  // (실전 확인: 레이드 종료 후에도 결과·보상 화면은 계속 접근 가능하고,
  // 수령하면 확인창 없이 즉시 처리되며 버튼이 "개인 보상 수령 완료"로
  // 바뀜). 하루에 여러 번 일일을 돌려도 같은 날 재확인 안 하도록 KST
  // 날짜로 캐시한다.
  Modules.daily.claimGuildBossRewardIfDue = async function () {
    const kstDay = Core.getKstDayOfWeek();
    if (kstDay !== 3 && kstDay !== 5) {
      return '길드 보스 보상: 오늘은 확인 요일이 아님(수·금만 확인)';
    }
    const todayKey = Modules.arena.todayKey();
    if (localStorage.getItem(GUILD_BOSS_REWARD_DAY_KEY) === todayKey) {
      return '길드 보스 보상: 오늘 이미 확인함';
    }

    try {
      await Modules.guildboss.goToGuildBossScreen();
    } catch (e) {
      Core.log('daily', `⚠ 길드 보스 화면 진입 실패(이번 주 소환이 없었을 수 있음): ${e.message}`);
      return '길드 보스 보상: 화면 진입 실패(다음 실행 시 재시도)';
    }

    const claimBtn = Core.findButtonByText('개인 보상 수령하기');
    if (!claimBtn) {
      localStorage.setItem(GUILD_BOSS_REWARD_DAY_KEY, todayKey);
      return '길드 보스 개인 보상: 받을 것 없음(이미 수령했거나 보상 없음)';
    }
    if (!(await Core.safeClick(() => claimBtn, { beforeMin: 500, beforeMax: 900, afterMin: 1000, afterMax: 1500 }))) {
      return '길드 보스 보상: 수령 버튼 클릭 실패(다음 실행 시 재시도)';
    }
    localStorage.setItem(GUILD_BOSS_REWARD_DAY_KEY, todayKey);
    return '길드 보스 개인 보상 수령 완료';
  };

  // ⚠ 사용자 요청(2026-08, 실전 확인): 길드 화면(/guild, "길드 정보" 탭)에
  // "마을 효과 명성 받기 (+명성 25)" 버튼이 있으면 눌러서 받는다. 확인창
  // 없이 즉시 "일일 명성 25을 획득했습니다!"로 처리되고, 받고 나면 버튼
  // 자체가 화면에서 사라진다(하루 1회로 추정). 버튼 존재 여부만 매번
  // 확인하면 되므로 별도 날짜 캐시는 필요 없다.
  Modules.daily.claimGuildTownEffectReputationIfAvailable = async function () {
    try {
      await Modules.guildboss.goToGuildScreen();
    } catch (e) {
      Core.log('daily', `⚠ 길드 화면 진입 실패(마을효과 명성 확인 생략): ${e.message}`);
      return '길드 마을효과 명성: 화면 진입 실패';
    }
    await Core.humanDelay(500, 900);

    const findClaimBtn = () =>
      Core.gameElements('button').find((b) => Core.isElementVisible(b) && b.textContent.includes('마을 효과 명성 받기'));
    const claimBtn = findClaimBtn();
    if (!claimBtn) {
      return '길드 마을효과 명성: 받을 것 없음(이미 받았거나 없음)';
    }
    if (!(await Core.safeClick(findClaimBtn, { beforeMin: 500, beforeMax: 900, afterMin: 900, afterMax: 1400 }))) {
      return '길드 마을효과 명성: 수령 버튼 클릭 실패(다음 실행 시 재시도)';
    }
    return '길드 마을효과 명성(+25) 수령 완료';
  };

  // ⚠ 사용자 요청(2026-08, 실전 확인): 편지함에 매번 들어가지 않고, 먼저
  // 계정 드롭다운의 "편지" 메뉴 항목에 붙는 레드닷(MUI Badge,
  // .MuiBadge-badge)이 있을 때만 편지함에 들어간다. 안 읽은 메일은
  // fontWeight가 700(굵게)으로 표시되고, 클릭해서 열면 즉시 읽음 처리되며
  // (fontWeight가 400으로 바뀜), 첨부 아이템이 있는 메일은 목록 행에
  // svg[aria-label="미수령 아이템 있음"] 아이콘이 붙고 상세 다이얼로그에
  // "아이템 수령하기" 버튼이 뜬다(확인창 없이 즉시 수령 처리됨).
  Modules.daily.checkMailIfDue = async function () {
    const findAccountIconBtn = () => {
      const navBtns = Core.gameElements('button').filter((el) => {
        if (!Core.isElementVisible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.top < 40 && r.top >= 0;
      });
      if (navBtns.length === 0) return null;
      return navBtns.reduce((a, b) => (a.getBoundingClientRect().right > b.getBoundingClientRect().right ? a : b));
    };
    const accountBtn = await Core.waitFor(findAccountIconBtn, 10000, 250);
    if (!accountBtn) {
      return '메일함: 계정 아이콘을 찾지 못해 확인 생략';
    }
    if (!(await Core.safeClick(findAccountIconBtn, { beforeMin: 400, beforeMax: 700, afterMin: 600, afterMax: 1000 }))) {
      return '메일함: 계정 아이콘 클릭 실패로 확인 생략';
    }

    const mailItem = await Core.waitFor(
      () => Core.gameElements('[role="menuitem"]').find((el) => el.textContent.trim().startsWith('편지') && Core.isElementVisible(el)),
      8000,
      200
    );
    if (!mailItem) {
      return '메일함: "편지" 메뉴 항목을 찾지 못해 확인 생략';
    }

    // 레드닷(안 읽은 메일 배지)이 없으면 편지함 자체에 들어가지 않는다.
    const badge = mailItem.querySelector('.MuiBadge-badge');
    if (!badge || !badge.textContent.trim()) {
      // 드롭다운을 연 채로 두지 않도록 닫는다.
      document.body.click();
      return '메일함: 안 읽은 메일 없음(레드닷 없음) - 진입 생략';
    }
    const unreadCountAtStart = parseInt(badge.textContent.trim(), 10) || 0;

    mailItem.click();
    const onMailPage = await Core.waitFor(() => location.pathname.startsWith('/mail'), 15000, 300);
    if (!onMailPage) {
      return '메일함: 화면 진입을 확인하지 못함';
    }
    await Core.humanDelay(500, 900);

    let processed = 0;
    let claimedAttachments = 0;
    const maxIterations = 50;
    for (let i = 0; i < maxIterations; i++) {
      const rows = Core.gameElements('tr').filter((tr) => tr.querySelector('td') && Core.isElementVisible(tr));
      const unreadRow = rows.find((tr) => getComputedStyle(tr.querySelector('td')).fontWeight === '700');
      if (!unreadRow) break;

      const hasAttachment = !!unreadRow.querySelector('svg[aria-label="미수령 아이템 있음"]');
      if (!(await Core.safeClick(() => unreadRow, { beforeMin: 400, beforeMax: 700, afterMin: 800, afterMax: 1200 }))) {
        break;
      }
      processed++;

      const dialog = await Core.waitFor(
        () => Core.gameElements('[role="dialog"]').find((d) => Core.isElementVisible(d)) || null,
        6000,
        250
      );
      if (dialog) {
        if (hasAttachment) {
          const claimBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '아이템 수령하기');
          if (claimBtn) {
            claimBtn.click();
            await Core.humanDelay(900, 1400);
            claimedAttachments++;
          }
        }
        const closeBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '닫기');
        if (closeBtn) closeBtn.click();
        await Core.humanDelay(400, 700);
      }
    }

    Core.log(
      'daily',
      `메일함: 안 읽은 메일 ${unreadCountAtStart}건 확인, 읽음 처리 ${processed}건, 첨부 아이템 수령 ${claimedAttachments}건`
    );
    return `메일함: ${processed}건 읽음 처리(첨부 수령 ${claimedAttachments}건)`;
  };

  Modules.daily.runStep = async function (step) {
    if (step === 'weeklyRewards') {
      return await this.claimWeeklyRewardsIfDue();
    }
    if (step === 'dailyQuests') {
      // ⚠ 버그 수정(2026-08, 사용자 확인): 예전엔 아래 하위 작업들을 개별
      // try/catch 없이 순차로 그냥 await했다. 이러면 앞쪽 작업(특히
      // completeCraftQuestIfNeeded가 맨 처음이라 가장 취약) 중 하나가
      // Core.clickNavMenuExact 같은 공용 헬퍼의 예외(메뉴 버튼/항목을
      // 못 찾음 - 예: 이전 단계(던전/보스 등)가 화면을 이상한 상태로
      // 남겨서 발생)를 만나면, 그 즉시 dailyQuests 전체가 중단되고 뒤에
      // 있던 나머지(특히 주간 퀘스트 확인·수령)가 통째로 스킵됐다(사용자가
      // "일일 돌렸는데 주간 퀘스트를 안 받은 계정이 있다"고 실전에서
      // 발견). 이제 각 하위 작업을 개별 try/catch로 감싸서, 하나가
      // 실패해도 나머지는 계속 시도한다.
      const runSubTask = async (name, fn) => {
        try {
          return await fn();
        } catch (e) {
          Core.log('daily', `⚠ [dailyQuests] "${name}" 실패(다음 작업은 계속 진행): ${e.message}`);
          return false;
        }
      };

      // "장인 정신"(아이템 조합), "대장간 이용"(수리) 구현됨. 다른 항목이
      // 추가되면 이 자리에 이어서 호출한다.
      const craftOk = await runSubTask('아이템 조합', () => this.completeCraftQuestIfNeeded());
      const repairOk = await runSubTask('장비 수리', () => this.completeRepairQuestIfNeeded());
      await runSubTask('일간 보상 수령', () => this.claimQuestRewardIfReady('일간'));

      // ⚠ 사용자 요청(2026-08): 주간 퀘스트도 요일 제약(예전엔 주말에만)
      // 없이 매일 확인하고, 일간 퀘스트 보상 받을 때 같이 처리한다.
      // "길드의 용사"(길드 보스 공격)는 길드보스 매크로로 자연히 채워지고,
      // "꾸준한 수행"은 직접 완료시킨다. "낚시광"은 자동화를 시도했다가
      // 사용자 요청으로 다시 뺐다 - 탭이 원격/백그라운드로 밀리면 게임 내
      // 자동 낚시 타이머 자체가 거의 안 흐르는 현상이 실전에서 확인돼서,
      // 무인 실행 시 이 단계에서 사실상 멈춘 것처럼 오래 걸릴 수 있었다.
      const cultivationOk = await runSubTask('꾸준한 수행', () => this.completeCultivationQuestIfNeeded());
      await runSubTask('주간 보상 수령', () => this.claimQuestRewardIfReady('주간'));

      const achievementResult = await runSubTask('업적 보상 확인', () => this.claimAchievementRewardsIfIndicated());
      if (achievementResult) Core.log('daily', achievementResult);

      // ⚠ 사용자 요청(2026-08): 길드 보스(히드라) 개인 보상도 일간 퀘스트
      // 보상을 받을 때 같이 처리한다.
      const guildBossResult = await runSubTask('길드 보스 보상', () => this.claimGuildBossRewardIfDue());
      if (guildBossResult) Core.log('daily', guildBossResult);

      // ⚠ 사용자 요청(2026-08): 길드 화면의 "마을 효과 명성 받기"도 같이 확인한다.
      const townEffectResult = await runSubTask('길드 마을효과 명성', () => this.claimGuildTownEffectReputationIfAvailable());
      if (townEffectResult) Core.log('daily', townEffectResult);

      // ⚠ 사용자 요청(2026-08, 실전 확인): 레드닷(안 읽은 메일 배지)이 있을
      // 때만 편지함에 들어가서 안 읽은 메일을 전부 읽고, 첨부 아이템이
      // 있으면 같이 수령한다.
      const mailResult = await runSubTask('메일함 확인', () => this.checkMailIfDue());
      if (mailResult) Core.log('daily', mailResult);

      return craftOk && repairOk && cultivationOk
        ? '일간+주간 퀘스트 처리 완료'
        : '일간/주간 퀘스트 일부 처리 실패(로그에서 어느 항목인지 확인)';
    }
    if (step === 'attendance') {
      return await this.runAttendance();
    }
    if (step === 'dungeon') {
      await this.runCoreModule('dungeon');
      const dungeonResult = await this.verifyDungeon();
      // ⚠ 버그 수정(2026-08): 주석엔 "보스(그리고 던전)를 잡고 나면 보상
      // 상자를 사용한다"고 적혀 있었는데, 실제로는 boss 단계에만 연결돼
      // 있고 dungeon 단계엔 호출 자체가 빠져 있었다(사용자가 "안 쓰는 것
      // 같다"고 지적해서 발견함). 보스와 동일하게, 실패해도 일일 시퀀스를
      // 멈추지 않고 로그만 남긴다.
      try {
        await Core.useAllRewardBoxes('dungeon');
      } catch (e) {
        Core.log('dungeon', `⚠ 보상 상자 자동 사용 실패(던전 완료 자체는 완료됨): ${e.message}`);
      }
      return dungeonResult;
    }
    if (step === 'arena') {
      await this.runCoreModule('arena');
      // ⚠ 버그 수정(2026-08, 사용자 확인): 프리시즌 기간엔 에너지가 절대
      // 유료로 안 바뀌므로(게임 규칙), mainLoop와 동일하게 프리시즌
      // 여부에 따라 검증 기준을 분기한다 - 아니면 프리시즌 기간에 정상
      // 완료(보석 150/150)된 것도 "무료 전투가 남아있다"며 오판해 실패로
      // 처리될 수 있다.
      const count = Modules.arena.readTodayBattleCount();
      const isPreseason = Core.bodyText().includes('프리시즌');
      if (isPreseason) {
        const gemProgress = Modules.arena.readPreseasonGemProgress();
        if (!gemProgress || gemProgress.current < gemProgress.max) {
          throw new Error(`아레나(프리시즌) 완료 확인 실패: 보석 ${gemProgress ? `${gemProgress.current}/${gemProgress.max}` : '읽기 실패'}`);
        }
        return `오늘 아레나 ${count}회 완료(프리시즌 보석 ${gemProgress.current}/${gemProgress.max}개 확인)`;
      }
      // ⚠ 사용자 요청(2026-08): 고정 목표 횟수 대신 "다음 전투 에너지
      // 비용이 무료가 아니게 됐는지"로 완료를 판정한다(정규 아레나는 하루
      // 20회부터 유료 전환).
      const energyCost = Modules.arena.readNextBattleEnergyCost();
      if (!energyCost || energyCost.isFree) {
        throw new Error(`아레나 완료 확인 실패: 아직 무료 전투가 남아있거나 확인 못함 (오늘 ${count ?? '읽기 실패'}회)`);
      }
      return `오늘 아레나 ${count}회 완료(무료 전투 소진 확인)`;
    }
    // ⚠ 사용자 요청(2026-08): 프리시즌 기간엔 정규 아레나와 별개로 평일에도
    // 돌려야 한다. 화면/버튼 구조가 동일해 Modules.arena.readTodayBattleCount
    // (this 안 쓰는 순수 함수)를 그대로 재사용해 검증한다.
    if (step === 'preseason') {
      await this.runCoreModule('preseason');
      // ⚠ 사용자 요청(2026-08): 고정 목표 횟수 대신 "오늘 받은 프리시즌
      // 보석"이 하루 최대치에 도달했는지로 완료를 판정한다.
      const gemProgress = Modules.arena.readPreseasonGemProgress();
      if (!gemProgress || gemProgress.current < gemProgress.max) {
        throw new Error(`프리시즌 아레나 완료 확인 실패: 보석 ${gemProgress ? `${gemProgress.current}/${gemProgress.max}` : '읽기 실패'}`);
      }
      // ⚠ 사용자 요청(2026-08): "햇살 토큰"(여름 이벤트 한정) 일괄 사용도
      // 프리시즌 단계에 묶어서 일일 매크로 실행 시 같이 처리한다. 실패해도
      // 이미 완료된 프리시즌 전투 자체는 성공으로 보고한다.
      try {
        await Modules.preseason.useSunshineTokens();
      } catch (e) {
        Core.log('preseason', `⚠ 햇살 토큰 자동 사용 실패(프리시즌 전투 자체는 완료됨): ${e.message}`);
      }
      return `오늘 프리시즌 보석 ${gemProgress.current}/${gemProgress.max}개 완료`;
    }
    if (step === 'boss') {
      const boss = await Core.waitFor(() => window.__bossMacro || null, 10000, 250, null);
      if (!boss || typeof boss.runDailySelectedBosses !== 'function') {
        throw new Error('보스 일일 실행 엔진을 찾지 못함');
      }
      const bossResult = await boss.runDailySelectedBosses();
      // ⚠ 사용자 요청(2026-08): 보스(그리고 던전)를 잡고 나면 보상으로 쌓이는
      // "N의 보상" 상자들을 전부 사용한다. 보상 상자 사용 자체가 실패해도
      // 보스 처치라는 본 목표는 이미 달성된 것이므로, 여기서 에러가 나도
      // 일일 시퀀스 전체를 멈추지 않고 로그만 남긴다.
      try {
        await Core.useAllRewardBoxes('boss');
      } catch (e) {
        Core.log('boss', `⚠ 보상 상자 자동 사용 실패(보스 처치 자체는 완료됨): ${e.message}`);
      }
      return bossResult;
    }
    if (step === 'autohunt') {
      await this.runCoreModule('autohunt');
      return await this.verifyAutohunt();
    }
    if (step === 'deepdungeon') {
      const mod = Modules.deepdungeon;
      const shouldCancel = () => this.stopRequested || !Core.dailyActive;
      const arrived = await mod.goToDeepDungeon(shouldCancel);
      if (shouldCancel()) throw new Error('사용자가 일일 실행을 정지했습니다.');
      if (!arrived) throw new Error('심층던전 화면 진입을 확인하지 못함');
      const before = await mod.readWeeklyCumulativeDamage(shouldCancel);
      if (shouldCancel()) throw new Error('사용자가 일일 실행을 정지했습니다.');
      if (before === null) throw new Error('심층던전 시작 전 주간 누적 데미지를 읽지 못함');
      if (before >= 1000000) return `이미 주간 누적 데미지 ${before.toLocaleString()} - 실행 생략`;

      const previousRetry = mod.config.retryIfWeeklyDamageUnder1M;
      mod.config.retryIfWeeklyDamageUnder1M = true;
      try {
        await this.runCoreModule('deepdungeon');
      } finally {
        mod.config.retryIfWeeklyDamageUnder1M = previousRetry;
      }
      return await this.verifyDeepDungeon();
    }
    throw new Error(`알 수 없는 일일 단계: ${step}`);
  };

  Modules.daily.mainLoop = async function () {
    let state = this.loadState();
    if (!state) return;
    let auth = null;
    try {
      auth = JSON.parse(sessionStorage.getItem(DAILY_AUTH_KEY) || 'null');
    } catch (e) {
      auth = null;
    }
    // 지연된 mainLoop 호출이 정지 뒤 도착해도 실행 상태를 다시 살리지 못한다.
    if (
      !auth ||
      auth.schema !== DAILY_AUTH_SCHEMA ||
      auth.startedAt !== state.startedAt ||
      this.stopRequested
    ) return;
    Core.dailyActive = true;
    this.running = true;
    Core.updateModuleButtons();

    while (state.running && state.index < state.steps.length && !this.stopRequested) {
      const step = state.steps[state.index];
      const label = DAILY_STEP_LABELS[step] || step;
      Core.log('daily', `▶ [${state.index + 1}/${state.steps.length}] ${label} 시작`);
      try {
        const detail = await this.runStep(step);
        state.reports.push({ step, label, ok: true, detail });
        Core.log('daily', `✅ ${label}: ${detail}`);
      } catch (e) {
        if (this.stopRequested) break;
        const detail = e && e.message ? e.message : String(e);
        state.reports.push({ step, label, ok: false, detail });
        Core.log('daily', `⚠ ${label} 이슈: ${detail} → 다음 작업으로 이동`);
      }
      if (this.stopRequested) break;
      state.index += 1;
      this.saveState(state);
      await Core.humanDelay(900, 1600);
    }

    const stopped = this.stopRequested || !state.running;
    state.running = false;
    this.saveState(state);
    Core.dailyActive = false;
    this.running = false;
    Core.activeModuleId = null;
    Core.backgroundKeeper.release('daily');
    Core.updateModuleButtons();

    if (stopped) {
      Core.showBanner('daily', '사용자 요청으로 일일 연속 실행을 정지했습니다.', false);
      return;
    }

    const issues = state.reports.filter((report) => !report.ok);
    const summary = state.reports
      .map((report) => `${report.ok ? '✅' : '⚠'} ${report.label}: ${report.detail}`)
      .join('\n');
    if (issues.length === 0) {
      Core.showBanner('daily', '선택한 일일 작업을 모두 완료하고 사후 확인했습니다.', true);
      Core.playCompleteSound();
    } else {
      Core.showBanner('daily', `${issues.length}개 작업에서 이슈가 있었습니다. 일일 로그를 확인해주세요.`, false);
      Core.playStopSound();
    }
    alert(`일일 연속 실행 결과\n\n${summary || '실행한 작업 없음'}`);
  };

  Core.startDaily = function () {
    const mod = Modules.daily;
    if (Core.dailyActive || mod.running || Core.activeModuleId) {
      Core.showBanner('daily', '다른 작업이 실행 중입니다. 정지 후 다시 시작해주세요.');
      return;
    }
    // ⚠ 사용자 요청(2026-08): 심층던전(주 1회)과 아레나(주말 한정)는 자주
    // 열리지 않으므로 우선순위를 뒤로 미룬다. 던전 → 보스 → 사냥 → 심층던전
    // → 아레나 순서로 실행한다. 주간 보상(weeklyRewards)은 체크박스 설정과
    // 무관하게 항상 맨 먼저 실행한다(해당 매크로를 안 돌려도 반드시 받아야
    // 하는 보상이기 때문). 일간 퀘스트(dailyQuests)는 다른 모든 단계가
    // 끝난 뒤에야 정확한 진행도를 확인할 수 있으므로 항상 맨 마지막에
    // 실행한다(매일). 주간 퀘스트는 이제 요일 제약 없이 매일 dailyQuests
    // 단계 안에서 함께 확인·처리한다(예전엔 토·일에만 별도 실행했음).
    const steps = [
      'weeklyRewards',
      'attendance',
      ...['dungeon', 'boss', 'autohunt', 'deepdungeon', 'arena', 'preseason']
        .filter((key) => mod.config[key]),
      'dailyQuests',
    ];
    if (
      steps.includes('dungeon') &&
      !Core.ELEMENT_OPTIONS.includes(Modules.dungeon.config.originalElement)
    ) {
      Core.showBanner('daily', '던전 탭에서 원래 속성을 먼저 선택해주세요.');
      return;
    }
    if (
      steps.includes('autohunt') &&
      !Core.ELEMENT_OPTIONS.includes(Modules.autohunt.config.originalElement)
    ) {
      Core.showBanner('daily', '자동사냥 탭에서 원래 속성을 먼저 선택해주세요.');
      return;
    }
    if (
      steps.includes('deepdungeon') &&
      !Core.ELEMENT_OPTIONS.includes(Modules.deepdungeon.config.originalElement)
    ) {
      Core.showBanner('daily', '심층던전 탭에서 원래 속성을 먼저 선택해주세요.');
      return;
    }
    if (steps.includes('boss')) {
      const checkedBosses = [...document.querySelectorAll('#lrm-boss-ref-panel .lrm-boss-check:checked')];
      if (checkedBosses.length === 0) {
        Core.showBanner('daily', '보스 탭에서 일일 실행할 보스를 하나 이상 체크해주세요.');
        return;
      }
    }
    const state = {
      running: true,
      index: 0,
      steps,
      reports: [],
      startedAt: Date.now(),
    };
    mod.stopRequested = false;
    Core.backgroundKeeper.acquire('daily');
    sessionStorage.setItem(DAILY_AUTH_KEY, JSON.stringify({
      schema: DAILY_AUTH_SCHEMA,
      startedAt: state.startedAt,
      issuedAt: Date.now(),
    }));
    // 사용자가 새 일일 실행을 명시적으로 누른 경우에만 이전 보스 정지
    // 래치를 해제한다.
    if (window.__bossMacro && typeof window.__bossMacro.armBossRun === 'function') {
      window.__bossMacro.armBossRun();
    }
    mod.saveState(state);
    mod.mainLoop()
      .catch((e) => {
        Core.dailyActive = false;
        mod.running = false;
        Core.showBanner('daily', `일일 실행 자체 오류: ${e.message}`, false);
        Core.updateModuleButtons();
      })
      .finally(() => Core.backgroundKeeper.release('daily'));
  };

  Core.stopDaily = function () {
    const mod = Modules.daily;
    mod.stopRequested = true;
    Core.backgroundKeeper.release('daily');
    sessionStorage.removeItem(DAILY_AUTH_KEY);
    const state = mod.loadState();
    if (state) {
      state.running = false;
      mod.saveState(state);
    }
    if (Core.activeModuleId && Modules[Core.activeModuleId]) {
      Core.requestStopModule(Core.activeModuleId, { fromDailyStop: true });
    }
    if (window.__bossMacro) {
      if (typeof window.__bossMacro.clearBossRunState === 'function') {
        if (typeof window.__bossMacro.requestImmediateStop === 'function') {
          window.__bossMacro.requestImmediateStop();
        } else {
          window.__bossMacro.clearBossRunState();
        }
      } else {
        window.__bossMacro.stopRequested = true;
        localStorage.setItem('lrm-boss-ref-user-stopped', String(Date.now()));
        localStorage.removeItem('lrm-boss-ref-pending');
        localStorage.removeItem('lrm-boss-ref-queue');
      }
    }
  };

  function buildDailyTab(container) {
    const mod = Modules.daily;
    const refs = UIRefs.daily;
    Core.loadModuleConfig('daily', DAILY_CONFIG_KEYS);

    const intro = document.createElement('div');
    intro.textContent = '출석체크를 먼저 수행한 뒤 체크한 작업을 던전 → 보스 → 자동사냥 → 심층던전 → 아레나 → 프리시즌 순서로 실행하고, 각 단계의 실제 완료 상태를 확인합니다.';
    intro.style.cssText = 'color:#ccc; font-size:11px; line-height:1.5; margin-bottom:8px;';
    container.appendChild(intro);

    const inputs = [];
    [
      ['dungeon', '던전 — 입장 가능한 던전 모두 클리어'],
      ['boss', '보스 — 선택한 보스 중 주간 보상이 남은 보스'],
      ['autohunt', '자동사냥 — 설정한 행동력 제한까지'],
      ['deepdungeon', '심층던전 — 주간 누적 피해 100만까지'],
      ['arena', '아레나 — 설정한 오늘 총 전투 횟수까지'],
      ['preseason', '프리시즌 — 요일 제약 없이 설정한 오늘 총 전투 횟수까지'],
    ].forEach(([key, text]) => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex; align-items:flex-start; gap:7px; margin:7px 0; cursor:pointer;';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = !!mod.config[key];
      check.addEventListener('change', () => {
        mod.config[key] = check.checked;
        Core.saveModuleConfig('daily', DAILY_CONFIG_KEYS);
      });
      const label = document.createElement('span');
      label.textContent = text;
      row.append(check, label);
      container.appendChild(row);
      inputs.push(check);
    });

    const note = document.createElement('div');
    note.textContent = '월간 출석체크는 항상 실행하며 이미 수령했거나 받을 보상이 없으면 건너뜁니다. 보스 보상이 모두 끝난 날은 수호자에 입장한 뒤 포기하여 일일 도전 과제만 처리합니다. 문제가 생긴 단계는 기록하고 다음 단계로 넘어갑니다.';
    note.style.cssText = 'color:#f5a623; font-size:10px; line-height:1.45; margin:8px 0;';
    container.appendChild(note);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:6px; margin-top:6px;';
    const startBtn = document.createElement('button');
    startBtn.textContent = '일일 실행';
    startBtn.style.cssText = btnStyle('#2e7d32');
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '정지';
    stopBtn.style.cssText = btnStyle('#c62828');
    stopBtn.disabled = true;
    startBtn.addEventListener('click', () => Core.startDaily());
    stopBtn.addEventListener('click', () => Core.stopDaily());
    row.append(startBtn, stopBtn);
    container.appendChild(row);

    const statusEl = document.createElement('div');
    statusEl.textContent = '대기중';
    statusEl.style.cssText = 'font-size:11px; color:#aaa; margin-top:5px;';
    container.appendChild(statusEl);
    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.inputs = inputs;
  }
