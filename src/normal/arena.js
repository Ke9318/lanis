  // -------------------------- 아레나 --------------------------
  const ARENA_CONFIG_KEY = 'lrm-arena-config';
  const ARENA_RESUME_KEY = 'lrm-arena-resume';
  Modules.arena = {
    id: 'arena',
    running: false,
    stopRequested: false,
    runId: 0,
    loopPromise: null,
    cycleCount: 0,
    config: {
      targetBattles: 10,
    },
  };

  Modules.arena.saveConfig = function () {
    try {
      localStorage.setItem(ARENA_CONFIG_KEY, JSON.stringify(this.config));
    } catch (e) {}
  };

  Modules.arena.loadConfig = function () {
    try {
      const saved = JSON.parse(localStorage.getItem(ARENA_CONFIG_KEY) || '{}');
      const value = parseInt(saved.targetBattles, 10);
      if (Number.isFinite(value) && value >= 1 && value <= 200) this.config.targetBattles = value;
    } catch (e) {}
  };

  Modules.arena.todayKey = function () {
    return new Date().toLocaleDateString('en-CA');
  };

  Modules.arena.isWeekend = function () {
    const day = new Date().getDay();
    return day === 0 || day === 6;
  };

  Modules.arena.saveResume = function () {
    try {
      localStorage.setItem(ARENA_RESUME_KEY, JSON.stringify({
        running: true,
        date: this.todayKey(),
        targetBattles: this.config.targetBattles,
      }));
    } catch (e) {}
  };

  Modules.arena.clearResume = function () {
    try { localStorage.removeItem(ARENA_RESUME_KEY); } catch (e) {}
  };

  Modules.arena.goToArena = async function () {
    if (location.pathname.replace(/\/$/, '') !== '/arena') {
      await Core.clickNavMenuExact('전투', '아레나');
    }
    const arrived = await Core.waitFor(
      () => location.pathname.replace(/\/$/, '') === '/arena' &&
        Core.bodyText().includes('오늘 전투 횟수'),
      15000,
      300
    );
    if (!arrived) throw new Error('아레나 화면 진입을 확인하지 못했습니다.');
  };

  Modules.arena.readTodayBattleCount = function () {
    const marker = Core.gameElements('*').find((el) =>
      el.children.length === 0 && el.textContent.trim() === '오늘 전투 횟수'
    );
    if (!marker) return null;
    let node = marker.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const match = (node.textContent || '').match(/오늘 전투 횟수\s*(\d+)\s*회/);
      if (match) return parseInt(match[1], 10);
    }
    return null;
  };

  Modules.arena.waitForEnabledStart = async function () {
    return await Core.waitFor(() => {
      const button = Core.findButtonByText('전투 시작');
      return button && !button.disabled ? button : null;
    }, 90000, 500);
  };

  Modules.arena.handleResultIfPresent = async function () {
    const findBack = () =>
      Core.findButtonByText('아레나로 돌아가기') ||
      Core.findButtonByText('돌아가기');
    const back = findBack();
    if (!back) return false;
    if (!(await Core.safeClick(findBack, {
      beforeMin: 700,
      beforeMax: 1200,
      afterMin: 800,
      afterMax: 1300,
    }))) throw new Error('아레나 결과창의 "돌아가기" 버튼 클릭에 실패했습니다.');
    await Core.waitFor(() => Core.bodyText().includes('오늘 전투 횟수'), 15000, 300);
    return true;
  };

  // ⚠ 사용자 요청(2026-08): 지난 주 아레나 순위 보상(전체 순위+직업군 순위)을
  // 주 1회 자동으로 받는다. 실전 확인: GET /api/arena/last-week의
  // {participated, rewardReceived}로 정확히 판별 가능(수령 후 rewardReceived
  // 가 true로 바뀌는 것까지 확인함). 이 보상은 요일 제약이 없으므로(주말
  // 한정 전투와 무관), mainLoop의 "주말에만 실행" 체크보다 먼저 처리해서
  // 평일에 모듈이 실행되더라도 보상 수령 기회를 놓치지 않게 한다.
  Modules.arena.claimLastWeekRewardIfAny = async function () {
    let data;
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('https://lanis.me/api/arena/last-week', {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`API 호출 실패 (HTTP ${res.status})`);
      data = await res.json();
    } catch (e) {
      Core.log('arena', `⚠ 아레나 지난 주 보상 확인 실패(계속 진행): ${e.message}`);
      return;
    }
    if (!data.participated || data.rewardReceived) {
      Core.log('arena', '아레나 지난 주 보상: 받을 것 없음(참여 안 했거나 이미 수령함)');
      return;
    }
    Core.log('arena', `아레나 지난 주 보상 수령 시도 (전체 ${data.finalRank}위, 직업군 ${data.baseClassRank}위)`);

    await this.goToArena();
    const rewardTab = await Core.retryStep('아레나 "보상" 탭 찾기', () => Core.findButtonByText('보상'));
    if (!rewardTab) {
      Core.log('arena', '⚠ "보상" 탭을 찾지 못해 지난 주 보상 수령을 건너뜁니다.');
      return;
    }
    if (!(await Core.safeClick(() => Core.findButtonByText('보상'), { beforeMin: 500, beforeMax: 900, afterMin: 700, afterMax: 1200 }))) {
      Core.log('arena', '⚠ "보상" 탭 클릭에 실패해 지난 주 보상 수령을 건너뜁니다.');
      return;
    }
    const claimBtn = await Core.waitFor(() => Core.findButtonByText('보상 받기'), 8000, 250);
    if (!claimBtn) {
      Core.log('arena', '⚠ "보상 받기" 버튼을 찾지 못했습니다.');
      return;
    }
    if (!(await Core.safeClick(() => Core.findButtonByText('보상 받기'), { beforeMin: 600, beforeMax: 1100, afterMin: 1000, afterMax: 1500 }))) {
      Core.log('arena', '⚠ "보상 받기" 클릭에 실패했습니다.');
      return;
    }
    Core.log('arena', '아레나 지난 주 보상 수령 완료');
  };

  Modules.arena.mainLoop = async function () {
    const mod = this;
    mod.cycleCount = 0;
    mod.loadConfig();

    // 지난 주 보상은 요일 제약이 없으므로, "주말에만 전투" 체크보다 먼저 처리한다.
    await mod.claimLastWeekRewardIfAny();
    if (!mod.running) return;

    if (!mod.isWeekend()) {
      mod.clearResume();
      Core.notifyStopped('arena', '아레나는 토요일과 일요일에만 자동 실행할 수 있습니다.');
      return;
    }
    const target = Math.max(1, Math.min(200, parseInt(mod.config.targetBattles, 10) || 10));
    mod.config.targetBattles = target;
    mod.saveConfig();
    mod.saveResume();
    await mod.goToArena();

    // 전투 도중 새로고침되었을 경우 결과창부터 정리한다.
    await mod.handleResultIfPresent();

    while (!mod.stopRequested) {
      const before = mod.readTodayBattleCount();
      if (before === null) throw new Error('아레나의 오늘 전투 횟수를 읽지 못했습니다.');
      mod.cycleCount = before;
      Core.updateModuleButtons();
      if (before >= target) {
        mod.clearResume();
        Core.notifyCompleted('arena', `오늘 아레나 ${before}회 완료 (설정 ${target}회)`);
        return;
      }

      // ⚠ 사용자 요청(2026-08): 기존엔 마지막 공격 시각부터 고정 35초를 무조건
      // 기다린 뒤에야 waitForEnabledStart로 진짜 쿨타임(버튼 활성화)을 확인하는
      // 이중 구조였다. 결과창에서 "돌아가기"를 누르고 곧바로 이 자리로 돌아오므로,
      // 고정 대기 없이 진짜 쿨타임 감지(0.5초 간격 폴링)만으로 버튼이 켜지는
      // 즉시 공격하도록 단순화한다.
      Core.log('arena', `쿨타임 및 버튼 활성화 대기 중: 오늘 ${before}/${target}회`);
      const startButton = await mod.waitForEnabledStart();
      if (!startButton) throw new Error('90초 안에 아레나 "전투 시작" 버튼이 활성화되지 않았습니다.');
      if (mod.stopRequested) return;
      if (!(await Core.safeClick(() => {
        const button = Core.findButtonByText('전투 시작');
        return button && !button.disabled ? button : null;
      }, { beforeMin: 700, beforeMax: 1300 }))) {
        throw new Error('아레나 "전투 시작" 버튼 클릭에 실패했습니다.');
      }

      const resultBack = await Core.waitFor(
        () => Core.findButtonByText('아레나로 돌아가기') || Core.findButtonByText('돌아가기'),
        15000,
        500
      );
      if (!resultBack) {
        Core.log('arena', '⚠ 전투 시작 클릭 후 결과 화면이 나타나지 않음 — 클릭 누락으로 판단, 즉시 재시도');
        continue;
      }
      await mod.handleResultIfPresent();
      const incremented = await Core.waitFor(() => {
        const count = mod.readTodayBattleCount();
        return count !== null && count > before ? count : null;
      }, 15000, 300);
      if (incremented === null) throw new Error('전투 후 오늘 전투 횟수 증가를 확인하지 못했습니다.');
      mod.cycleCount = incremented;
      Core.log('arena', `아레나 전투 완료: 오늘 ${incremented}/${target}회`);
    }
  };


  function buildArenaTab(container) {
    const mod = Modules.arena;
    const refs = UIRefs.arena;
    mod.loadConfig();

    container.appendChild(labelEl('오늘 실행할 총 전투 횟수'));
    const countInput = document.createElement('input');
    countInput.type = 'number';
    countInput.min = '1';
    countInput.max = '200';
    countInput.value = mod.config.targetBattles;
    countInput.style.cssText = inputStyle();
    countInput.addEventListener('change', () => {
      const value = Math.max(1, Math.min(200, parseInt(countInput.value, 10) || 10));
      mod.config.targetBattles = value;
      countInput.value = value;
      mod.saveConfig();
      Core.updateModuleButtons();
    });
    container.appendChild(countInput);

    const description = document.createElement('div');
    description.textContent =
      '아레나 화면의 "오늘 전투 횟수"를 기준으로 설정 횟수까지 실행합니다. 중간에 새로고침되거나 다시 시작해도 오늘 이미 진행한 횟수를 빼고 이어서 실행합니다.';
    description.style.cssText = 'font-size:11px; color:#ccc; line-height:1.5; margin:7px 0;';
    container.appendChild(description);

    const weekendNote = document.createElement('div');
    weekendNote.textContent = '※ 토요일·일요일에만 시작됩니다. 전투 결과에서 돌아온 뒤 버튼이 다시 활성화될 때까지 백그라운드 타이머로 대기합니다.';
    weekendNote.style.cssText = 'font-size:10px; color:#f5a623; line-height:1.45; margin-bottom:7px;';
    container.appendChild(weekendNote);

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
    startBtn.addEventListener('click', () => Core.startModule('arena'));
    stopBtn.addEventListener('click', () => Core.requestStopModule('arena'));
    btnRow.append(startBtn, stopBtn);
    container.append(btnRow, statusEl);

    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.inputs = [countInput];
  }
