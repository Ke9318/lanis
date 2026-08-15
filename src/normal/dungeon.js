  // -------------------------- 모듈 4: 던전 --------------------------
  Modules.dungeon = {
    id: 'dungeon',
    running: false,
    stopRequested: false,
    cycleCount: 0,
    config: {
      originalElement: '',
      enableDailySewer: true,
      rerollMinTokens: 50,
      instantClear: {
        oldMasterTower: { targetAC: 4000, targetEV: 4500 },
        masterTower: { targetAC: 4000, targetEV: 4500 },
        oldMysticCave: { targetAC: 5500, targetEV: 6000 },
        mysticCave: { targetAC: 5500, targetEV: 6000 },
        sewer: { targetAC: 0, targetEV: 0 },
      },
      forceInstantClear: {
        oldMasterTower: false,
        masterTower: false,
        oldMysticCave: false,
        mysticCave: false,
        sewer: false,
      },
    },
    currentDungeonId: null,
    difficulty: '매우어려움',
    deathLimit: null,
    instantClearTried: false,
    boughtGodStrikeOrEquiv: false,
    boughtGodStrikeExact: false,
    allStatsBoughtCount: 0,
    boughtSingleStat: {},
    boughtGodStrike: false,
    boughtCertainHit: false,
    boughtCritStrike: false,
    boughtRegen: false,
  };

  Modules.dungeon.DUNGEONS = [
    {
      id: 'oldMasterTower',
      label: '[구] 수행자의 탑: 상층부',
      requiredItemName: '수행자의 열쇠',
      daily: false,
      statMode: 'standard',
      abilityMode: 'equalPriority',
    },
    {
      id: 'masterTower',
      label: '수행자의 탑: 상층부',
      requiredItemName: '수행자의 기록',
      daily: false,
      statMode: 'standard',
      abilityMode: 'equalPriority',
    },
    {
      id: 'oldMysticCave',
      label: '[구] 신비의 동굴',
      requiredItemName: '빛을 내는 랜턴',
      daily: false,
      statMode: 'standard',
      abilityMode: 'equalPriority',
    },
    {
      id: 'mysticCave',
      label: '신비의 동굴',
      requiredItemName: '동굴 탐험 기록',
      daily: false,
      statMode: 'standard',
      abilityMode: 'equalPriority',
      instantClearRequirement: { requireGodStrike: true, minAllStats: 2, requireStats: [] },
    },
    {
      id: 'sewer',
      label: '지하 하수도',
      requiredItemName: null,
      daily: true,
      statMode: 'extended',
      abilityMode: 'ordered',
      instantClearRequirement: { requireGodStrike: true, minAllStats: 3, requireStats: ['힘', '속도'] },
    },
  ];

  const STAT_TARGET_ORDER = ['속도', '행운', '정신', '지능'];
  const STAT_EXTENDED_ORDER = ['속도', '행운', '정신', '지능', '힘', '생명', '체력', '마나'];
  const GRADE_COLOR = {
    gold: 'rgb(255, 215, 0)',
    rainbow: 'rgb(255, 20, 147)',
  };

  Modules.dungeon.bodyTextClean = function () {
    return Core.bodyText();
  };

  Modules.dungeon.getDungeonCardEl = function (label) {
    const heading = [...document.querySelectorAll('*')].find(
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim() === label &&
        !el.closest('#lrm-panel') &&
        !el.closest('#lrm-banner')
    );
    if (!heading) return null;
    let node = heading;
    for (let i = 0; i < 8; i++) {
      node = node.parentElement;
      if (!node) return null;
      if ([...node.querySelectorAll('button')].some((b) => b.textContent.trim() === '입장')) {
        return node;
      }
    }
    return null;
  };

  Modules.dungeon.getTicketCount = function (dungeonDef) {
    if (dungeonDef.daily) return Infinity;
    const card = this.getDungeonCardEl(dungeonDef.label);
    if (!card) return 0;
    const m = card.textContent.match(new RegExp(`${dungeonDef.requiredItemName}\\s*\\(([\\d,]+)개\\s*보유\\)`));
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  };

  Modules.dungeon.isDungeonCompletedToday = function (dungeonDef) {
    const card = this.getDungeonCardEl(dungeonDef.label);
    if (!card) return false;
    return card.textContent.includes('오늘 완료');
  };

  Modules.dungeon.goToDungeonSelect = async function (
    shouldCancel = Core.defaultShouldCancel
  ) {
    await Core.clickNavMenuExact('전투', '던전', shouldCancel);
    return !!(await Core.waitFor(
      () => Core.bodyText().includes('일일 던전'),
      15000,
      300,
      shouldCancel
    ));
  };

  // ⚠ 버그 수정(2026-08, 실전 확인): "전투 > 던전" 메뉴는 진행 중인 던전이
  // 있으면 목록 화면이 아니라 그 던전의 진행 화면으로 곧바로 이동시킨다
  // (목록 화면 특징 텍스트인 "일일 던전"이 아니라 "진행도"가 뜸). 기존
  // goToDungeonSelect는 "일일 던전" 텍스트만 성공 조건으로 봐서, 진행 중인
  // 던전이 있는 상태에서 호출하면 15초 내내 기다리다 실패한다. 이어하기
  // (resume) 경로 전용으로, 목록 화면/진행 화면 둘 다 성공으로 인정한다.
  Modules.dungeon.goToDungeonScreen = async function (
    shouldCancel = Core.defaultShouldCancel
  ) {
    await Core.clickNavMenuExact('전투', '던전', shouldCancel);
    return !!(await Core.waitFor(
      () => Core.bodyText().includes('일일 던전') || Core.bodyText().includes('진행도'),
      15000,
      300,
      shouldCancel
    ));
  };

  Modules.dungeon.scanEligibleDungeons = function () {
    const queue = [];
    for (const dungeonDef of this.DUNGEONS) {
      if (dungeonDef.daily && !this.config.enableDailySewer) {
        Core.log('dungeon', `"${dungeonDef.label}" 비활성화 설정 - 건너뜀`);
        continue;
      }
      if (this.isDungeonCompletedToday(dungeonDef)) {
        Core.log('dungeon', `"${dungeonDef.label}" 오늘 이미 완료됨 - 건너뜀`);
        continue;
      }
      const tickets = this.getTicketCount(dungeonDef);
      if (!dungeonDef.daily && tickets <= 0) {
        Core.log('dungeon', `"${dungeonDef.label}" 입장권 없음(${dungeonDef.requiredItemName} 0개) - 건너뜀`);
        continue;
      }
      Core.log(
        'dungeon',
        dungeonDef.daily
          ? `"${dungeonDef.label}" 입장 가능 (일일 던전) - 큐에 추가`
          : `"${dungeonDef.label}" 입장 가능 (${dungeonDef.requiredItemName} ${tickets}개 보유) - 큐에 추가`
      );
      queue.push(dungeonDef);
    }
    return queue;
  };

  Modules.dungeon.getEntryConfirmDialog = function () {
    const candidates = [...document.querySelectorAll('*')].filter((el) => {
      if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
      if (!el.textContent.includes('던전 입장 확인')) return false;
      return el.querySelectorAll('button').length > 0;
    });
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a.querySelectorAll('*').length < b.querySelectorAll('*').length ? a : b));
  };

  Modules.dungeon.pickEntryMethodButton = function (dialogEl, ticketsAvailable) {
    const buttons = [...dialogEl.querySelectorAll('button')].filter((b) => b.textContent.trim() !== '취소');
    if (buttons.length === 0) return null;
    if (buttons.length === 1) return buttons[0];

    const enoughKeys = (btn) => {
      const m = btn.textContent.match(/열쇠\s*(\d+)\s*개/);
      const needed = m ? parseInt(m[1], 10) : 0;
      return ticketsAvailable === null || ticketsAvailable === undefined || ticketsAvailable >= needed;
    };

    const energyBtn = buttons.find((b) => /에너지/.test(b.textContent) && !/에너지\s*무료/.test(b.textContent));
    if (energyBtn && enoughKeys(energyBtn)) return energyBtn;
    if (energyBtn) {
      const m = energyBtn.textContent.match(/열쇠\s*(\d+)\s*개/);
      const needed = m ? parseInt(m[1], 10) : 0;
      Core.log('dungeon', `열쇠+에너지 입장에 필요한 열쇠(${needed}개)가 부족해(보유 ${ticketsAvailable}개) 다른 입장 방법을 사용합니다.`);
    }
    return buttons.find((b) => b !== energyBtn) || buttons[0];
  };

  Modules.dungeon.enterDungeon = async function (dungeonDef) {
    const card = this.getDungeonCardEl(dungeonDef.label);
    if (!card) {
      Core.log('dungeon', `"${dungeonDef.label}" 카드를 찾지 못함`);
      return false;
    }
    const enterBtn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '입장');
    if (!enterBtn || enterBtn.disabled) {
      Core.log('dungeon', `"${dungeonDef.label}" 입장 버튼이 없거나 비활성 상태`);
      return false;
    }

    enterBtn.click();
    await Core.humanDelay(1000, 1800);

    const charModalConfirm = await Core.retryStep(
      '캐릭터 정보 모달의 확인 버튼 찾기',
      () => {
        if (!Core.bodyText().includes('캐릭터 정보')) return null;
        return Core.findButtonInDialog('캐릭터 정보', '확인');
      },
      { attempts: 4, waits: [1000, 2000, 3000, 4000] }
    );
    if (charModalConfirm) {
      charModalConfirm.click();
      await Core.humanDelay(1000, 1900);
    }

    await Core.retryStep(
      '캐릭터 정보 모달 닫힘 확인',
      () => (!Core.bodyText().includes('캐릭터 정보') ? true : null),
      { attempts: 3, waits: [1000, 2000, 3000] }
    );

    const entryModalFound = await Core.retryStep(
      '던전 입장 확인 모달 찾기',
      () => (Core.bodyText().includes('던전 입장 확인') ? true : null),
      { attempts: 4, waits: [1000, 2000, 3000, 4000] }
    );
    if (!entryModalFound) {
      Core.log('dungeon', '"던전 입장 확인" 모달을 확인하지 못했습니다 (이미 입장됐을 수 있음).');
    } else {
      const deathMatch = await Core.retryStep(
        '부활 허용 횟수 문구 찾기',
        () => Core.bodyText().match(/(\d+)\s*번\s*사망\s*시\s*던전에서\s*강제\s*퇴장/),
        { attempts: 3, waits: [500, 1000, 1500] }
      );
      this.deathLimit = deathMatch ? parseInt(deathMatch[1], 10) : null;
      Core.log('dungeon', `"${dungeonDef.label}" 부활 허용: ${this.deathLimit ?? '알 수 없음'}회`);

      const tickets = this.getTicketCount(dungeonDef);
      let entryDismissed = false;
      for (let attempt = 1; attempt <= 3 && !entryDismissed; attempt++) {
        const entryDialog = await Core.retryStep('던전 입장 확인 모달 컨테이너 찾기', () => this.getEntryConfirmDialog());
        if (!entryDialog) {
          Core.log('dungeon', `입장 확인 모달 컨테이너를 찾지 못했습니다 (시도 ${attempt}/3).`);
          await Core.sleep(1200);
          continue;
        }
        const enterConfirmBtn = this.pickEntryMethodButton(entryDialog, dungeonDef.daily ? null : tickets);
        if (!enterConfirmBtn) {
          Core.log('dungeon', `입장 방법 버튼을 찾지 못했습니다 (시도 ${attempt}/3).`);
          await Core.sleep(1200);
          continue;
        }
        Core.log('dungeon', `입장 방법 선택: "${enterConfirmBtn.textContent.trim()}" (시도 ${attempt}/3)`);
        enterConfirmBtn.click();
        await Core.humanDelay(1100, 2000);
        entryDismissed = await Core.waitFor(() => (!Core.bodyText().includes('던전 입장 확인') ? true : null), 3000, 300);
        if (!entryDismissed) {
          Core.log('dungeon', `입장 확인 모달이 클릭 후에도 닫히지 않았습니다 (시도 ${attempt}/3) - 다시 시도합니다.`);
        }
      }
      if (!entryDismissed) {
        Core.log('dungeon', '던전 입장 확인 모달을 닫지 못했습니다 (여러 번 시도 후에도 실패).');
        return false;
      }
    }

    const enteredBattle = await Core.retryStep('던전 전투 화면 진입 확인', () =>
      /진행도/.test(Core.bodyText()) ? true : null
    );
    if (!enteredBattle) {
      Core.log('dungeon', '던전 전투 화면 진입을 확인하지 못했습니다.');
      return false;
    }

    this.difficulty = '매우어려움';
    this.instantClearTried = false;
    this.boughtGodStrikeOrEquiv = false;
    this.boughtGodStrikeExact = false;
    this.allStatsBoughtCount = 0;
    this.boughtSingleStat = {};
    this.boughtGodStrike = false;
    this.boughtCertainHit = false;
    this.boughtCritStrike = false;
    this.boughtRegen = false;
    return true;
  };

  Modules.dungeon.readProgress = function () {
    const m = Core.bodyText().match(/진행도\s*\n?\s*(\d+)\s*\/\s*15/);
    return m ? parseInt(m[1], 10) : null;
  };

  Modules.dungeon.selectDifficultyTab = async function () {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const target = tabs.find((t) => t.textContent.trim() === this.difficulty);
    if (!target) return false;
    if (target.getAttribute('aria-selected') !== 'true') {
      target.click();
      await Core.humanDelay(900, 1600);
    }
    return true;
  };

  Modules.dungeon.readStats = function () {
    const text = Core.bodyText();
    const grab = (label) => {
      const m = text.match(new RegExp(`${label}\\s*[:：]?\\s*([\\d,]+)`));
      return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
    };
    return {
      힘: grab('힘'),
      생명: grab('생명'),
      정신: grab('정신'),
      지능: grab('지능'),
      행운: grab('행운'),
      속도: grab('속도'),
    };
  };

  Modules.dungeon.estimateACEV = function () {
    const s = this.readStats();
    if (!s || s.속도 == null) return null;
    const atkSpeed = s.속도;
    const EV = (s.지능 || 0) * 3.5 + (s.행운 || 0) * 2 + atkSpeed * 2;
    const AC = (s.정신 || 0) * 2.8 + (s.행운 || 0) * 1.6 + atkSpeed * 1.6;
    return { AC, EV };
  };

  Modules.dungeon.findCombatStatsToggleButton = function () {
    const cardCandidates = [...document.querySelectorAll('*')].filter((el) => {
      if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
      const t = el.textContent;
      return t.includes('무기') && t.includes('HP') && t.includes('MP');
    });
    if (cardCandidates.length === 0) return null;
    const card = cardCandidates.reduce((a, b) => (a.querySelectorAll('*').length < b.querySelectorAll('*').length ? a : b));
    const buttons = [...card.querySelectorAll('button')];
    return buttons.find((b) => b.textContent.trim() !== '자세히') || null;
  };

  Modules.dungeon.ensureDetailsExpanded = async function () {
    if (/적중치[:：]?\s*[\d,]+/.test(Core.bodyText()) && /회피치[:：]?\s*[\d,]+/.test(Core.bodyText())) {
      return true;
    }
    const expanded = await Core.retryStep(
      '전투 스탯(적중치/회피치) 토글 펼치기',
      async () => {
        const btn = this.findCombatStatsToggleButton();
        if (!btn) return null;
        btn.click();
        await Core.humanDelay(800, 1500);
        return /적중치[:：]?\s*[\d,]+/.test(Core.bodyText()) && /회피치[:：]?\s*[\d,]+/.test(Core.bodyText()) ? true : null;
      },
      { attempts: 3, waits: [800, 1500, 2500] }
    );
    if (!expanded) {
      Core.log('dungeon', '전투 스탯 토글을 펼쳤지만 적중치/회피치 텍스트를 확인하지 못했습니다 - 근사 공식으로 대체합니다.');
    }
    return expanded;
  };

  Modules.dungeon.readRealACEV = function () {
    const text = Core.bodyText();
    const acMatch = text.match(/적중치[:：]?\s*([\d,]+)/);
    const evMatch = text.match(/회피치[:：]?\s*([\d,]+)/);
    if (!acMatch || !evMatch) return null;
    return { AC: parseInt(acMatch[1].replace(/,/g, ''), 10), EV: parseInt(evMatch[1].replace(/,/g, ''), 10) };
  };

  Modules.dungeon.getCurrentACEV = async function () {
    await this.ensureDetailsExpanded();
    const real = this.readRealACEV();
    if (real) return { AC: real.AC, EV: real.EV, isReal: true };
    const est = this.estimateACEV();
    return est ? { AC: est.AC, EV: est.EV, isReal: false } : null;
  };

  Modules.dungeon.meetsInstantClearRequirement = function (dungeonDef) {
    const req = dungeonDef.instantClearRequirement;
    if (!req) return { ok: true };
    const missing = [];
    if (req.requireGodStrike && !this.boughtGodStrikeExact) missing.push('신의 일격 미구매');
    if (req.minAllStats && this.allStatsBoughtCount < req.minAllStats) {
      missing.push(`모든 스탯 ${this.allStatsBoughtCount}/${req.minAllStats}회`);
    }
    if (req.requireStats) {
      req.requireStats.forEach((stat) => {
        if (!this.boughtSingleStat[stat]) missing.push(`${stat} 미구매`);
      });
    }
    return { ok: missing.length === 0, missing };
  };

  Modules.dungeon.tryInstantClear = async function (dungeonDef) {
    if (this.instantClearTried) return false;

    const forced = !!this.config.forceInstantClear[dungeonDef.id];
    let logSuffix = '';

    if (!forced) {
      const target = this.config.instantClear[dungeonDef.id];
      if (!target || (!target.targetAC && !target.targetEV)) return false;

      const reqCheck = this.meetsInstantClearRequirement(dungeonDef);
      if (!reqCheck.ok) {
        Core.log('dungeon', `즉시완료 추가 조건 미충족 (${reqCheck.missing.join(', ')}) → 다음 전투에서 다시 확인`);
        return false;
      }

      const est = await this.getCurrentACEV();
      if (!est) return false;
      const tag = est.isReal ? '실제' : '추정';
      if (est.AC < target.targetAC || est.EV < target.targetEV) {
        Core.log(
          'dungeon',
          `즉시완료 기준 미달 (${tag} 적중 ${Math.round(est.AC)}/${target.targetAC}, ${tag} 회피 ${Math.round(est.EV)}/${target.targetEV}) → 다음 전투에서 다시 확인`
        );
        return false;
      }
      logSuffix = ` (${tag} 적중 ${Math.round(est.AC)}/${target.targetAC}, ${tag} 회피 ${Math.round(est.EV)}/${target.targetEV})`;
    } else {
      Core.log('dungeon', `"${dungeonDef.label}" 체크된 즉시완료 강제 옵션 - 조건 확인 없이 바로 즉시 최상층 도전 시도`);
    }

    const btn = Core.findButtonByText('즉시 최상층 도전');
    if (!btn || btn.disabled) {
      Core.log('dungeon', '"즉시 최상층 도전" 버튼을 아직 사용할 수 없는 상태입니다 - 다음 전투에서 다시 확인합니다.');
      return false;
    }
    if (!forced) {
      Core.log('dungeon', `즉시완료 기준 충족${logSuffix} → 즉시 최상층 도전 시도`);
    }
    btn.click();
    await Core.humanDelay(1100, 2000);
    const confirmBtn = await Core.retryStep(
      '즉시 최상층 도전 확인 팝업의 "도전" 버튼 찾기',
      () => (Core.bodyText().includes('즉시 최상층 도전') ? Core.findButtonInDialog('즉시 최상층 도전', '도전') : null),
      { attempts: 3, waits: [800, 1500, 2500] }
    );
    if (confirmBtn) {
      confirmBtn.click();
      await Core.humanDelay(1100, 2000);
    } else {
      Core.log('dungeon', '즉시 최상층 도전 확인 팝업을 찾지 못했습니다 (이미 진행됐을 수 있음).');
    }
    this.instantClearTried = true;
    return true;
  };

  Modules.dungeon.startBattle = async function () {
    await this.selectDifficultyTab();
    const btn = await Core.retryStep('전투 시작 버튼 찾기', () => Core.findButtonByText('전투 시작'));
    if (!btn) return false;
    btn.click();
    const registered = await Core.waitFor(
      () => (/전투\s*중|승리!|패배\.{2,}/.test(Core.bodyText()) ? true : null),
      3000,
      300
    );
    if (!registered) {
      Core.log('dungeon', '전투 시작 클릭 반응이 없어 다시 클릭합니다.');
      const btnAgain = Core.findButtonByText('전투 시작');
      if (btnAgain && !btnAgain.disabled) {
        btnAgain.click();
      }
    }
    await Core.humanDelay(1100, 2000);
    return true;
  };

  Modules.dungeon.waitForBattleResult = async function () {
    return Core.retryStep(
      '전투 결과 확인',
      () => {
        const t = Core.bodyText();
        if (/승리!/.test(t)) return 'win';
        if (/패배\.{2,}/.test(t)) return 'lose';
        return null;
      },
      { attempts: 5, waits: [1500, 3000, 5000, 8000, 12000] }
    );
  };

  Modules.dungeon.clickBackFromResult = async function () {
    const btn = await Core.retryStep('돌아가기 버튼 찾기', () => Core.findButtonByText('돌아가기'));
    if (!btn) return false;
    btn.click();
    await Core.humanDelay(1100, 2000);
    return true;
  };

  Modules.dungeon.isShopScreen = function () {
    return /아이템\s*상점/.test(Core.bodyText());
  };

  Modules.dungeon.isDungeonCompleteScreen = function () {
    return /던전\s*완료\s*보상/.test(Core.bodyText());
  };

  Modules.dungeon.getShopTokenCount = function () {
    const m = Core.bodyText().match(/아이템\s*상점\s*\n?\s*(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  };

  Modules.dungeon.GRADE_COLORS_ALL = [
    'rgb(255, 215, 0)',
    'rgb(255, 20, 147)',
    'rgb(192, 192, 192)',
    'rgb(205, 127, 50)',
  ];

  Modules.dungeon.getShopCards = function () {
    if (!this.isShopScreen()) return [];
    const bordered = [...document.querySelectorAll('*')].filter((el) => {
      if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
      const style = getComputedStyle(el);
      if (style.borderStyle === 'none' || parseFloat(style.borderWidth) <= 0) return false;
      return this.GRADE_COLORS_ALL.includes(style.borderColor);
    });
    const seen = new Set();
    const cards = [];
    for (const el of bordered) {
      const lines = (el.innerText || el.textContent).split('\n').map((s) => s.trim()).filter(Boolean);
      const label = lines[0];
      if (!label || label.length > 30 || seen.has(label)) continue;
      seen.add(label);
      // 카드 텍스트 안의 마지막 순수 숫자 줄이 가격이다 (예: "모든 스탯 +33\n\n40").
      // 이게 없으면 가격을 알 수 없는 카드로 취급(cost=null, 구매 가능한 것으로 간주).
      const costLine = [...lines].reverse().find((l) => /^[\d,]+$/.test(l));
      const cost = costLine ? parseInt(costLine.replace(/,/g, ''), 10) : null;
      // 테두리 색상만으로 잡은 el이 실제 클릭 가능한 카드가 아니라 안쪽의 장식용
      // 요소일 수 있다. el 자신이나 조상 중 role="button"/버튼 태그/클릭 커서를
      // 가진 실제 클릭 대상이 있으면 그걸 우선 사용하고, 없으면 기존처럼 el 자체를
      // 클릭 대상으로 둔다(뒤로 물러날 안전장치).
      let clickTarget = el;
      let probe = el;
      for (let i = 0; i < 4 && probe; i++) {
        if (
          probe.tagName === 'BUTTON' ||
          probe.getAttribute('role') === 'button' ||
          getComputedStyle(probe).cursor === 'pointer'
        ) {
          clickTarget = probe;
          break;
        }
        probe = probe.parentElement;
      }
      cards.push({ selectEl: clickTarget, label, borderColor: getComputedStyle(el).borderColor, cost });
      if (cards.length >= 3) break;
    }
    return cards;
  };

  Modules.dungeon.isRegenLabel = function (label) {
    return /재생\s*LV\s*[45]/.test(label);
  };

  Modules.dungeon.isGodStrikeFamily = function (label) {
    return /신의\s*일격|일격\s*필살|회심의\s*일격/.test(label);
  };

  Modules.dungeon.isAllStatsLabel = function (label) {
    return /모든\s*스탯\s*\+/.test(label);
  };

  Modules.dungeon.parseStatLabel = function (label) {
    const m = label.match(/(속도|행운|정신|지능|힘|생명|체력|마나)\s*\+(\d+)/);
    if (!m) return null;
    return { stat: m[1], value: parseInt(m[2], 10) };
  };

  Modules.dungeon.parseAllStatsValue = function (label) {
    const m = label.match(/^모든\s*스탯\s*\+(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  };

  Modules.dungeon.qualifiesGrade = function (borderColor) {
    return borderColor === GRADE_COLOR.gold || borderColor === GRADE_COLOR.rainbow;
  };

  Modules.dungeon.pickShopCard = function (dungeonDef, cards, isLastShopBeforeBoss) {
    if (dungeonDef.abilityMode === 'equalPriority') {
      if (!this.boughtGodStrikeOrEquiv) {
        const abilityCard = cards.find((c) => this.isGodStrikeFamily(c.label));
        if (abilityCard) {
          const isExactGodStrike = /신의\s*일격/.test(abilityCard.label);
          return {
            card: abilityCard,
            onBought: () => {
              this.boughtGodStrikeOrEquiv = true;
              if (isExactGodStrike) this.boughtGodStrikeExact = true;
            },
          };
        }
      }
    } else {
      if (!this.boughtGodStrike) {
        const c = cards.find((c) => /신의\s*일격/.test(c.label));
        if (c)
          return {
            card: c,
            onBought: () => {
              this.boughtGodStrike = true;
              this.boughtGodStrikeExact = true;
            },
          };
      }
    }

    const allStatCards = cards.filter((c) => this.isAllStatsLabel(c.label));
    if (allStatCards.length > 0) {
      allStatCards.sort((a, b) => this.parseAllStatsValue(b.label) - this.parseAllStatsValue(a.label));
      return { card: allStatCards[0], onBought: () => (this.allStatsBoughtCount += 1) };
    }

    if (dungeonDef.abilityMode === 'ordered') {
      if (!this.boughtCertainHit) {
        const c = cards.find((c) => /일격\s*필살/.test(c.label));
        if (c) return { card: c, onBought: () => (this.boughtCertainHit = true) };
      }
      if (!this.boughtCritStrike) {
        const c = cards.find((c) => /회심의\s*일격/.test(c.label));
        if (c) return { card: c, onBought: () => (this.boughtCritStrike = true) };
      }
      if (!this.boughtRegen) {
        const c = cards.find((c) => this.isRegenLabel(c.label));
        if (c) return { card: c, onBought: () => (this.boughtRegen = true) };
      }
    }

    const statOrder = dungeonDef.statMode === 'extended' ? STAT_EXTENDED_ORDER : STAT_TARGET_ORDER;
    const statCandidates = cards
      .map((c) => ({ c, parsed: this.parseStatLabel(c.label) }))
      .filter(
        (x) =>
          x.parsed &&
          statOrder.includes(x.parsed.stat) &&
          !this.boughtSingleStat[x.parsed.stat] &&
          this.qualifiesGrade(x.c.borderColor)
      );
    if (statCandidates.length > 0) {
      statCandidates.sort((a, b) => b.parsed.value - a.parsed.value);
      const best = statCandidates[0];
      return { card: best.c, onBought: () => (this.boughtSingleStat[best.parsed.stat] = true) };
    }

    if (isLastShopBeforeBoss && cards.length > 0) {
      const withValue = cards.map((c) => {
        const stat = this.parseStatLabel(c.label);
        const all = this.parseAllStatsValue(c.label);
        return { c, value: stat ? stat.value : all };
      });
      withValue.sort((a, b) => b.value - a.value);
      return { card: withValue[0].c, onBought: () => {} };
    }

    return null;
  };

  Modules.dungeon.handleShop = async function (dungeonDef, progress) {
    const isLastShopBeforeBoss = progress === 14;
    let rerollGuard = 0;
    while (this.running) {
      const tokens = this.getShopTokenCount();
      const cards = this.getShopCards();
      if (cards.length === 0) {
        Core.log('dungeon', '상점 카드를 파싱하지 못했습니다. 넘어가기를 시도합니다.');
        break;
      }

      // 가격이 보유 토큰보다 비싸서 애초에 못 사는(비활성) 카드는 후보에서
      // 제외한다. 이 체크가 없으면 살 수 없는 카드를 골라 몇 번을 재시도해도
      // 영원히 실패하는 문제가 있었다.
      const affordableCards = cards.filter((c) => c.cost === null || c.cost <= tokens);
      if (affordableCards.length < cards.length) {
        const unaffordable = cards.filter((c) => !(c.cost === null || c.cost <= tokens));
        Core.log(
          'dungeon',
          `토큰 부족으로 후보에서 제외: ${unaffordable.map((c) => `${c.label}(${c.cost})`).join(', ')} (보유 ${tokens})`
        );
      }

      const pick = this.pickShopCard(dungeonDef, affordableCards, isLastShopBeforeBoss);
      const isPremiumPick = pick && (this.isGodStrikeFamily(pick.card.label) || this.isAllStatsLabel(pick.card.label));
      // 일반 후보는 첫 화면이라는 이유만으로 즉시 사지 않는다. 보스 직전이거나
      // 신의 일격/모든 스탯 계열을 찾았을 때만 구매하고, 그 외에는 리롤한다.
      const shouldBuyNow = pick && (isLastShopBeforeBoss || isPremiumPick);

      if (shouldBuyNow) {
        let bought = false;
        const tokensBefore = tokens;
        const buyWaits = [4000, 5000, 6500, 8000];
        // 카드 선택은 재시도 때마다 다시 누르지 않는다 - 만약 선택이 "누르면 선택,
        // 다시 누르면 해제"되는 토글 방식이라면, 재시도할수록 오히려 선택이
        // 풀려버려 계속 실패하는 원인이 될 수 있다.
        pick.card.selectEl.click();
        await Core.humanDelay(900, 1600);
        for (let buyAttempt = 0; buyAttempt < buyWaits.length && !bought; buyAttempt++) {
          const buyBtn = Core.findButtonByText('구매');
          if (!buyBtn) break;
          buyBtn.click();
          await Core.humanDelay(1100, 2000);
          await Core.waitFor(
            () =>
              !this.isShopScreen() ||
              Core.bodyText().includes('구매했습니다') ||
              this.getShopTokenCount() < tokensBefore
                ? true
                : null,
            buyWaits[buyAttempt]
          );
          // "구매했습니다" 토스트는 화면이 곧장 넘어가면 사라져있을 수 있어 신뢰도가
          // 낮다 - 토큰이 실제로 줄었는지(더 확실한 신호)도 함께 확인한다.
          bought =
            Core.bodyText().includes('구매했습니다') ||
            (this.isShopScreen() && this.getShopTokenCount() < tokensBefore) ||
            !this.isShopScreen();
          if (!bought && buyAttempt < buyWaits.length - 1) {
            Core.log(
              'dungeon',
              `"${pick.card.label}" 구매 확인 실패 (${buyAttempt + 1}/${buyWaits.length}) - 다시 시도`
            );
            await Core.humanDelay(800, 1500);
          }
        }
        if (bought) {
          pick.onBought();
          Core.log('dungeon', `상점 구매: ${pick.card.label}`);
          return;
        }
        Core.log('dungeon', `"${pick.card.label}" 구매를 확인하지 못함(재시도 포함) - 넘어가기로 진행`);
        break;
      }
      if (pick && !isPremiumPick) {
        Core.log('dungeon', `리롤 중 - "${pick.card.label}"은 신의 일격/모든 스탯이 아니라 구매하지 않고 계속 리롤합니다.`);
      }

      if (!isLastShopBeforeBoss && tokens >= this.config.rerollMinTokens && rerollGuard < 200) {
        // 리롤 버튼의 실제 textContent는 "리롤" + 남은 횟수 배지가 붙어서
        // "리롤3" 같은 형태다. 완전 일치(Core.findButtonByText)로는 절대 못 찾으므로
        // "리롤"로 시작하는 버튼을 찾는다 - 이게 리롤이 항상 실패하던 진짜 원인이었다.
        const rerollBtn = await Core.retryStep(
          '리롤 버튼 찾기',
          () => {
            const b = Core.allButtons().find((btn) => btn.textContent.trim().startsWith('리롤'));
            return b && !b.disabled ? b : null;
          },
          { attempts: 3, waits: [500, 1000, 1500] }
        );
        if (rerollBtn) {
          rerollBtn.click();
          await Core.humanDelay(1100, 2000);
          rerollGuard += 1;
          continue;
        }
        Core.log('dungeon', '리롤 버튼을 찾지 못했거나 비활성 상태입니다.');
      } else if (!isLastShopBeforeBoss) {
        Core.log('dungeon', `리롤 조건 미충족 (토큰 ${tokens}/${this.config.rerollMinTokens}) - 넘어가기로 진행`);
      }
      break;
    }

    const skipBtn = Core.findButtonByText('넘어가기');
    if (skipBtn) {
      skipBtn.click();
      await Core.humanDelay(1100, 2000);
    }
  };

  Modules.dungeon.runOneDungeon = async function (dungeonDef, opts = {}) {
    if (!opts.resume) {
      Core.log('dungeon', `"${dungeonDef.label}" 입장 시도`);
      const entered = await this.enterDungeon(dungeonDef);
      if (!entered || !this.running) return false;
    } else {
      Core.log('dungeon', `"${dungeonDef.label}" 이미 진행 중이던 상태에서 이어서 진행합니다.`);
      this.instantClearTried = false;
      this.boughtGodStrikeOrEquiv = false;
      this.boughtGodStrikeExact = false;
      this.allStatsBoughtCount = 0;
      this.boughtSingleStat = {};
      this.boughtGodStrike = false;
      this.boughtCertainHit = false;
      this.boughtCritStrike = false;
      this.boughtRegen = false;
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      const selectedTab = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
      if (selectedTab && ['쉬움', '어려움', '매우어려움'].includes(selectedTab.textContent.trim())) {
        this.difficulty = selectedTab.textContent.trim();
      }
    }

    while (this.running) {
      const progress = this.readProgress();
      if (progress === null) {
        Core.log('dungeon', '진행도를 읽지 못했습니다. 상점/완료 화면인지 확인합니다.');
      }

      if (this.isDungeonCompleteScreen()) {
        const claimBtn = await Core.retryStep('"보상 받고 던전 나가기" 버튼 찾기', () =>
          Core.findButtonByText('보상 받고 던전 나가기')
        );
        if (!claimBtn) {
          Core.notifyStopped('dungeon', '"보상 받고 던전 나가기" 버튼을 찾지 못했습니다.');
          return false;
        }
        claimBtn.click();
        await Core.humanDelay(1100, 2000);
        const left = await Core.retryStep(
          '보상 수령 후 화면 전환 확인',
          () => (!this.isDungeonCompleteScreen() ? true : null),
          { attempts: 3, waits: [1000, 2000, 3000] }
        );
        if (!left) {
          Core.notifyStopped('dungeon', '보상을 받았지만 화면 전환을 확인하지 못했습니다. 상태를 확인해주세요.');
          return false;
        }
        Core.log('dungeon', `"${dungeonDef.label}" 클리어 완료! (보상 수령 확인됨)`);
        this.cycleCount += 1;
        this.saveClearCount(this.cycleCount);
        Core.updateModuleButtons();
        return true;
      }

      if (this.isShopScreen()) {
        await this.handleShop(dungeonDef, progress);
        if (!this.running) return false;
        continue;
      }

      if (/이번\s*전투에서\s*상대할/.test(Core.bodyText())) {
        let result = null;
        let resultWasInstant = false;
        for (let battleAttempt = 0; battleAttempt < 3 && !result && this.running; battleAttempt++) {
          let usedInstant = false;
          if (!this.instantClearTried) {
            usedInstant = await this.tryInstantClear(dungeonDef);
          }
          if (!usedInstant) {
            await this.selectDifficultyTab();
            const started = await this.startBattle();
            if (!started) {
              Core.log('dungeon', `"전투 시작" 버튼을 찾지 못했습니다 (시도 ${battleAttempt + 1}/3).`);
              await Core.sleep(2000);
              continue;
            }
          }
          result = await this.waitForBattleResult();
          if (result) {
            resultWasInstant = usedInstant;
          } else {
            Core.log('dungeon', `전투 결과 확인 실패 (시도 ${battleAttempt + 1}/3) - 재시도`);
            await Core.sleep(2000);
          }
        }

        if (result === 'win') {
          await this.clickBackFromResult();
          continue;
        }
        if (result === 'lose') {
          if (resultWasInstant) {
            Core.log('dungeon', '즉시완료(즉시 최상층 도전) 실패 - 난이도는 그대로 유지하고 정공법으로 15단계까지 계속 진행합니다.');
          } else {
            Core.log('dungeon', `전투 패배 (난이도: ${this.difficulty})`);
            if (this.difficulty === '매우어려움') {
              this.difficulty = '어려움';
              Core.log('dungeon', '매우어려움에서 패배 → 이후 어려움으로 난이도를 낮춰서 계속 진행 (다시 올리지 않음)');
            }
          }
          await this.clickBackFromResult();
          const stillInDungeon = await Core.waitFor(
            () => (/진행도|아이템\s*상점/.test(Core.bodyText()) ? true : null),
            4000
          );
          if (!stillInDungeon) {
            Core.log('dungeon', '부활 허용 횟수를 초과하여 던전에서 강제 퇴장된 것으로 보입니다.');
            return false;
          }
          continue;
        }
        Core.notifyStopped('dungeon', '전투 결과를 여러 번 재시도해도 확인하지 못했습니다. 화면 상태를 확인해주세요.');
        return false;
      }

      await Core.sleep(1500);
      if (!/진행도|아이템\s*상점|던전\s*완료\s*보상/.test(Core.bodyText())) {
        Core.log('dungeon', '알 수 없는 화면 상태 - 정지합니다.');
        return false;
      }
    }
    return false;
  };

  Modules.dungeon.detectResumeDungeon = function () {
    if (!/진행도/.test(Core.bodyText())) return null;
    for (const d of this.DUNGEONS) {
      const heading = [...document.querySelectorAll('*')].find(
        (el) =>
          el.children.length === 0 &&
          el.textContent.trim() === d.label &&
          !el.closest('#lrm-panel') &&
          !el.closest('#lrm-banner')
      );
      if (heading) return d;
    }
    return null;
  };

  const DUNGEON_CONFIG_KEY = 'lrm-dungeon-config';

  Modules.dungeon.saveConfig = function () {
    try {
      localStorage.setItem(
        DUNGEON_CONFIG_KEY,
        JSON.stringify({
          originalElement: this.config.originalElement,
          enableDailySewer: this.config.enableDailySewer,
          rerollMinTokens: this.config.rerollMinTokens,
          instantClear: this.config.instantClear,
          forceInstantClear: this.config.forceInstantClear,
        })
      );
    } catch (e) {
      /* localStorage 사용 불가 환경이면 조용히 무시 */
    }
  };

  Modules.dungeon.loadConfigIntoSelf = function () {
    try {
      const raw = localStorage.getItem(DUNGEON_CONFIG_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (Core.ELEMENT_OPTIONS.includes(saved.originalElement)) this.config.originalElement = saved.originalElement;
      if (typeof saved.enableDailySewer === 'boolean') this.config.enableDailySewer = saved.enableDailySewer;
      if (typeof saved.rerollMinTokens === 'number') this.config.rerollMinTokens = saved.rerollMinTokens;
      if (saved.instantClear) {
        Object.keys(this.config.instantClear).forEach((id) => {
          if (saved.instantClear[id]) {
            if (typeof saved.instantClear[id].targetAC === 'number') this.config.instantClear[id].targetAC = saved.instantClear[id].targetAC;
            if (typeof saved.instantClear[id].targetEV === 'number') this.config.instantClear[id].targetEV = saved.instantClear[id].targetEV;
          }
        });
      }
      if (saved.forceInstantClear) {
        Object.keys(this.config.forceInstantClear).forEach((id) => {
          if (typeof saved.forceInstantClear[id] === 'boolean') this.config.forceInstantClear[id] = saved.forceInstantClear[id];
        });
      }
    } catch (e) {
      /* 저장된 값이 손상됐으면 기본값 그대로 사용 */
    }
  };

  const DUNGEON_CLEAR_COUNT_KEY = 'lrm-dungeon-cleared-today';

  Modules.dungeon.getTodayDateStr = function () {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  Modules.dungeon.loadClearCount = function () {
    try {
      const raw = localStorage.getItem(DUNGEON_CLEAR_COUNT_KEY);
      if (!raw) return 0;
      const data = JSON.parse(raw);
      if (data.date !== this.getTodayDateStr()) return 0;
      return data.count || 0;
    } catch (e) {
      return 0;
    }
  };

  Modules.dungeon.saveClearCount = function (count) {
    try {
      localStorage.setItem(DUNGEON_CLEAR_COUNT_KEY, JSON.stringify({ date: this.getTodayDateStr(), count }));
    } catch (e) {
      /* localStorage 사용 불가 환경이면 조용히 무시 */
    }
  };

  Modules.dungeon.mainLoop = async function () {
    const mod = this;
    mod.cycleCount = mod.loadClearCount();
    Core.log('dungeon', `던전 자동클리어 시작 (오늘 이미 클리어한 던전: ${mod.cycleCount}개)`);

    // ⚠ 버그 수정(2026-08, 사용자 확인): 예전엔 "재시작 시점에 마침 열려
    // 있던 페이지"만 보고 재개 여부(detectResumeDungeon)를 판정했다. 정지
    // 후 다시 시작할 때 사용자가 던전 화면이 아닌 다른 곳에 있으면 이
    // 판정이 항상 실패(null)하고, 그러면 "새 큐 스캔" 경로(구 버전
    // goToDungeonSelect)로 빠지는데, 그 함수는 "일일 던전" 텍스트만
    // 성공으로 봤다 - 그런데 실제로 진행 중인 던전이 있으면 "전투 > 던전"
    // 메뉴 클릭이 목록이 아니라 진행 화면으로 곧바로 이동시켜버려서(§0-6
    // 참고 패턴과 동일) 15초 내내 기다리다 실패하고, 그 실패 여부를 체크도
    // 안 한 채 scanEligibleDungeons를 불러 목록 카드를 하나도 못 찾아 빈
    // 큐가 되어 "입장 가능한 던전이 없습니다"로 조기 종료됐다(실전 확인:
    // 던전 도중 정지 후 재시작하면 이어하지 않고 그냥 멈춤). 이제 먼저
    // 실제로 "전투 > 던전" 메뉴로 이동해(목록/진행 화면 둘 다 인정하는
    // goToDungeonScreen) 게임이 데려다주는 화면을 보고 나서 재개 여부를
    // 판정한다 - 재시작 시점에 사용자가 어느 페이지에 있었든 무관해진다.
    const navigated = await mod.goToDungeonScreen();
    if (!mod.running) return;
    if (!navigated) {
      Core.notifyStopped('dungeon', '던전 화면 진입을 확인하지 못해 정지합니다.');
      return;
    }

    const resumeDungeon = mod.detectResumeDungeon();
    let queue = [];
    if (!resumeDungeon) {
      // 이미 위에서 던전 화면(목록)에 도착해 있으므로 다시 메뉴를 누를
      // 필요가 없다.
      queue = mod.scanEligibleDungeons();
      if (queue.length === 0) {
        Core.log('dungeon', '입장 가능한 던전이 없습니다 (전부 완료됐거나 입장권이 없음). 정지합니다.');
        Core.moduleResults.dungeon = { ok: true, message: '입장 가능한 모든 던전 완료 또는 입장권 소진', at: Date.now() };
        mod.running = false;
        Core.activeModuleId = Core.activeModuleId === 'dungeon' ? null : Core.activeModuleId;
        Core.updateModuleButtons();
        return;
      }
      Core.log('dungeon', `입장 큐 확정: ${queue.map((d) => d.label).join(' → ')}`);
    }

    // 여기 도달했다는 건 할 일이 있다는 뜻(재개할 던전이 있거나, 새로 들어갈
    // 던전이 있음) → 이제서야 프리셋/속성을 맞춘다.
    Core.log('dungeon', '시작 전 공용 프리셋 "던전" 적용');
    await Core.applyCommonPreset('던전', 'dungeon');
    Core.log('dungeon', `시작 전 원래 속성(${mod.config.originalElement}) 확인`);
    await Core.ensureCharacterElement(mod.config.originalElement, 'dungeon');

    if (resumeDungeon) {
      Core.log('dungeon', `이미 진행 중이던 "${resumeDungeon.label}"을(를) 인식했습니다 - 이어서 진행합니다.`);

      // ⚠ 버그 수정(2026-08, 실전 확인): 프리셋/속성 확인 과정에서 화면이
      // "캐릭 > 프리셋", "캐릭 > 내정보"로 이동하는데, 그 이후 던전 화면으로
      // 복귀하는 코드가 빠져 있었다(심층던전에서 발견해 고친 것과 동일
      // 패턴). "전투 > 던전" 메뉴는 진행 중인 던전이 있으면 목록이 아니라
      // 그 던전의 진행 화면으로 곧바로 이동시키는 것을 실전에서 직접
      // 확인함(진행도 0/15 상태에서 캐릭>프리셋→캐릭>내정보로 화면을 이동시킨
      // 뒤, "전투>던전"만 다시 눌러 정확히 원래 진행 화면으로 복귀 확인됨).
      const backOnDungeonScreen = await mod.goToDungeonScreen();
      if (!backOnDungeonScreen) {
        Core.notifyStopped('dungeon', '속성/프리셋 확인 후 던전 화면으로 복귀하지 못해 정지합니다.');
        return;
      }

      await mod.runOneDungeon(resumeDungeon, { resume: true });
      if (!mod.running) {
        Core.log('dungeon', `던전 자동클리어 종료. 오늘 클리어한 던전: ${mod.cycleCount}개`);
        mod.running = false;
        Core.activeModuleId = Core.activeModuleId === 'dungeon' ? null : Core.activeModuleId;
        Core.updateModuleButtons();
        return;
      }
      await mod.goToDungeonSelect();
      if (!mod.running) return;
      queue = mod.scanEligibleDungeons();
      if (queue.length === 0) {
        Core.log('dungeon', '입장 가능한 던전이 없습니다 (전부 완료됐거나 입장권이 없음). 정지합니다.');
        Core.moduleResults.dungeon = { ok: true, message: '입장 가능한 모든 던전 완료 또는 입장권 소진', at: Date.now() };
        mod.running = false;
        Core.activeModuleId = Core.activeModuleId === 'dungeon' ? null : Core.activeModuleId;
        Core.updateModuleButtons();
        return;
      }
      Core.log('dungeon', `입장 큐 확정: ${queue.map((d) => d.label).join(' → ')}`);
    }

    for (const dungeonDef of queue) {
      if (!mod.running) break;

      if (!/일일\s*던전/.test(Core.bodyText())) {
        await mod.goToDungeonSelect();
      }
      if (!mod.running) break;

      await mod.runOneDungeon(dungeonDef);
      if (!mod.running) break;
    }

    Core.log('dungeon', `던전 자동클리어 종료. 오늘 클리어한 던전: ${mod.cycleCount}개`);
    if (!Core.moduleResults.dungeon || Core.moduleResults.dungeon.ok === null) {
      Core.moduleResults.dungeon = { ok: true, message: `입장 가능한 던전 ${mod.cycleCount}개 완료`, at: Date.now() };
    }
    mod.running = false;
    Core.activeModuleId = Core.activeModuleId === 'dungeon' ? null : Core.activeModuleId;
    Core.updateModuleButtons();
  };


  function buildDungeonTab(container) {
    const mod = Modules.dungeon;
    const refs = UIRefs.dungeon;
    mod.loadConfigIntoSelf();

    container.appendChild(labelEl('원래 속성 (시작 전 자동 확인·변경)'));
    const elementSelect = document.createElement('select');
    elementSelect.style.cssText = inputStyle();
    const elementPlaceholder = document.createElement('option');
    elementPlaceholder.value = '';
    elementPlaceholder.textContent = '속성 선택 필요';
    elementPlaceholder.selected = !Core.ELEMENT_OPTIONS.includes(mod.config.originalElement);
    elementSelect.appendChild(elementPlaceholder);
    Core.ELEMENT_OPTIONS.forEach((element) => {
      const option = document.createElement('option');
      option.value = element;
      option.textContent = element;
      option.selected = element === mod.config.originalElement;
      elementSelect.appendChild(option);
    });
    elementSelect.addEventListener('change', (e) => {
      mod.config.originalElement = e.target.value;
      mod.saveConfig();
    });
    container.appendChild(elementSelect);

    const dailyRow = document.createElement('div');
    dailyRow.style.cssText = 'display:flex; align-items:center; gap:6px; margin:4px 0;';
    const dailyCheck = document.createElement('input');
    dailyCheck.type = 'checkbox';
    dailyCheck.checked = mod.config.enableDailySewer;
    dailyCheck.addEventListener('change', (e) => {
      mod.config.enableDailySewer = e.target.checked;
      mod.saveConfig();
    });
    const dailyLabel = document.createElement('span');
    dailyLabel.textContent = '일일 던전: 지하 하수도 포함 (깊은 숲속/각성의 탑은 수동)';
    dailyLabel.style.cssText = 'font-size:11px; color:#ccc;';
    dailyRow.appendChild(dailyCheck);
    dailyRow.appendChild(dailyLabel);
    container.appendChild(dailyRow);

    container.appendChild(labelEl('던전 순서 (자동): [구]수행자의 탑 → 수행자의 탑 → [구]신비의 동굴 → 신비의 동굴 → 지하 하수도'));

    container.appendChild(labelEl('리롤 최소 보유 토큰'));
    const rerollInput = document.createElement('input');
    rerollInput.type = 'number';
    rerollInput.value = mod.config.rerollMinTokens;
    rerollInput.style.cssText = inputStyle();
    rerollInput.addEventListener('change', (e) => {
      mod.config.rerollMinTokens = parseInt(e.target.value, 10) || 50;
      mod.saveConfig();
    });
    container.appendChild(rerollInput);

    container.appendChild(labelEl('던전별 즉시완료 목표치 (0 = 즉시완료 시도 안 함) / 체크 시 조건 없이 즉시완료'));

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex; gap:4px; align-items:center; margin-bottom:2px;';
    const headerCheck = document.createElement('span');
    headerCheck.style.cssText = 'width:16px;';
    const headerNameSpan = document.createElement('span');
    headerNameSpan.style.cssText = 'flex:1.4;';
    const headerAC = document.createElement('span');
    headerAC.textContent = '적중치';
    headerAC.style.cssText = 'flex:1; font-size:10px; color:#f5a623; text-align:center;';
    const headerEV = document.createElement('span');
    headerEV.textContent = '회피치';
    headerEV.style.cssText = 'flex:1; font-size:10px; color:#4fc3f7; text-align:center;';
    headerRow.appendChild(headerCheck);
    headerRow.appendChild(headerNameSpan);
    headerRow.appendChild(headerAC);
    headerRow.appendChild(headerEV);
    container.appendChild(headerRow);

    const instantInputs = [];
    mod.DUNGEONS.forEach((d) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:4px; align-items:center; margin-bottom:2px;';

      const forceCheck = document.createElement('input');
      forceCheck.type = 'checkbox';
      forceCheck.title = '체크 시 조건 확인 없이 시작하자마자 즉시 최상층 도전';
      forceCheck.checked = !!mod.config.forceInstantClear[d.id];
      forceCheck.style.cssText = 'width:14px; height:14px; flex:none;';
      forceCheck.addEventListener('change', (e) => {
        mod.config.forceInstantClear[d.id] = e.target.checked;
        acInput.disabled = e.target.checked;
        evInput.disabled = e.target.checked;
        mod.saveConfig();
      });

      const nameSpan = document.createElement('span');
      nameSpan.textContent = d.label;
      nameSpan.style.cssText = 'font-size:10px; color:#aaa; flex:1.4; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      const acInput = document.createElement('input');
      acInput.type = 'number';
      acInput.title = '목표 적중치';
      acInput.placeholder = '적중';
      acInput.value = mod.config.instantClear[d.id].targetAC;
      acInput.disabled = forceCheck.checked;
      acInput.style.cssText = inputStyle() + 'flex:1;';
      acInput.addEventListener('change', (e) => {
        mod.config.instantClear[d.id].targetAC = parseInt(e.target.value, 10) || 0;
        mod.saveConfig();
      });
      const evInput = document.createElement('input');
      evInput.type = 'number';
      evInput.title = '목표 회피치';
      evInput.placeholder = '회피';
      evInput.value = mod.config.instantClear[d.id].targetEV;
      evInput.disabled = forceCheck.checked;
      evInput.style.cssText = inputStyle() + 'flex:1;';
      evInput.addEventListener('change', (e) => {
        mod.config.instantClear[d.id].targetEV = parseInt(e.target.value, 10) || 0;
        mod.saveConfig();
      });
      row.appendChild(forceCheck);
      row.appendChild(nameSpan);
      row.appendChild(acInput);
      row.appendChild(evInput);
      container.appendChild(row);
      instantInputs.push(forceCheck, acInput, evInput);
    });

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:6px; margin-top:6px; align-items:center;';
    const startBtn = document.createElement('button');
    startBtn.textContent = '시작';
    startBtn.style.cssText = btnStyle('#2e7d32');
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '정지';
    stopBtn.style.cssText = btnStyle('#c62828');
    stopBtn.disabled = true;
    const statusEl = document.createElement('span');
    statusEl.textContent = '대기중';
    statusEl.style.cssText = 'margin-left:4px; font-size:11px;';
    startBtn.addEventListener('click', () => Core.startModule('dungeon'));
    stopBtn.addEventListener('click', () => Core.requestStopModule('dungeon'));
    btnRow.appendChild(startBtn);
    btnRow.appendChild(stopBtn);
    container.appendChild(btnRow);
    container.appendChild(statusEl);

    const hint = document.createElement('div');
    hint.textContent = '※ 캐릭터 카드의 "자세히"를 펼치면 나오는 실제 적중치/회피치를 우선 사용하고, 확인이 안 되면 근사 공식으로 대체 판단합니다.';
    hint.style.cssText = 'color:#888; font-size:10px; margin-top:4px;';
    container.appendChild(hint);

    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.inputs = [elementSelect, dailyCheck, rerollInput, ...instantInputs];
  }
