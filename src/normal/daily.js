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
  const DAILY_CONFIG_KEYS = ['dungeon', 'arena', 'boss', 'autohunt', 'deepdungeon'];
  const DAILY_STEP_LABELS = {
    attendance: '출석체크',
    dungeon: '던전',
    arena: '아레나',
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

  Modules.daily.runStep = async function (step) {
    if (step === 'attendance') {
      return await this.runAttendance();
    }
    if (step === 'dungeon') {
      await this.runCoreModule('dungeon');
      return await this.verifyDungeon();
    }
    if (step === 'arena') {
      await this.runCoreModule('arena');
      const count = Modules.arena.readTodayBattleCount();
      if (count === null || count < Modules.arena.config.targetBattles) {
        throw new Error(`아레나 목표 횟수 확인 실패: ${count ?? '읽기 실패'}/${Modules.arena.config.targetBattles}`);
      }
      return `오늘 아레나 ${count}/${Modules.arena.config.targetBattles}회 확인`;
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
    // → 아레나 순서로 실행한다.
    const steps = [
      'attendance',
      ...['dungeon', 'boss', 'autohunt', 'deepdungeon', 'arena']
        .filter((key) => mod.config[key]),
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
    intro.textContent = '출석체크를 먼저 수행한 뒤 체크한 작업을 던전 → 보스 → 자동사냥 → 심층던전 → 아레나 순서로 실행하고, 각 단계의 실제 완료 상태를 확인합니다.';
    intro.style.cssText = 'color:#ccc; font-size:11px; line-height:1.5; margin-bottom:8px;';
    container.appendChild(intro);

    const inputs = [];
    [
      ['dungeon', '던전 — 입장 가능한 던전 모두 클리어'],
      ['boss', '보스 — 선택한 보스 중 주간 보상이 남은 보스'],
      ['autohunt', '자동사냥 — 설정한 행동력 제한까지'],
      ['deepdungeon', '심층던전 — 주간 누적 피해 100만까지'],
      ['arena', '아레나 — 설정한 오늘 총 전투 횟수까지'],
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
