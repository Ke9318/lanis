  // -------------------------- 아레나 --------------------------
  const ARENA_RESUME_KEY = 'lrm-arena-resume';
  Modules.arena = {
    id: 'arena',
    running: false,
    stopRequested: false,
    runId: 0,
    loopPromise: null,
    cycleCount: 0,
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

  // ⚠ 사용자 요청(2026-08, 실전 확인): 정규 아레나는 하루 20회부터 전투마다
  // 에너지가 소모된다(20-39회:1, 40-59회:2 ... 게임 자체 규칙 설명에 명시).
  // "오늘 전투 횟수"라는 고정 목표 대신, 화면의 "다음 전투 에너지 비용"이
  // "무료"인 동안에만 계속 돌리고 무료가 아니게 되는 순간 멈추는 게 맞다.
  // 실전 확인: 라벨과 값이 델리미터 없이 붙어서 나온다
  // (예: "다음 전투 에너지 비용무료").
  Modules.arena.readNextBattleEnergyCost = function () {
    const marker = Core.gameElements('*').find((el) =>
      el.children.length === 0 && el.textContent.trim() === '다음 전투 에너지 비용'
    );
    if (!marker) return null;
    let node = marker.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const text = node.textContent || '';
      if (text.includes('다음 전투 에너지 비용') && text.length < 60) {
        return { isFree: text.includes('무료'), raw: text.replace('다음 전투 에너지 비용', '').trim() };
      }
    }
    return null;
  };

  // ⚠ 사용자 요청(2026-08, 실전 확인): 프리시즌은 에너지가 전혀 소모되지
  // 않는 대신, "오늘 받은 프리시즌 보석"이 하루 최대치(실전 확인: 150개,
  // 전투 1회당 5개 지급이라 30회분)에 도달하면 더 받을 게 없다. 고정 전투
  // 횟수 대신 이 진행률을 기준으로 반복해야 한다.
  Modules.arena.readPreseasonGemProgress = function () {
    const marker = Core.gameElements('*').find((el) =>
      el.children.length === 0 && el.textContent.trim() === '오늘 받은 프리시즌 보석'
    );
    if (!marker) return null;
    let node = marker.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const match = (node.textContent || '').match(/오늘 받은 프리시즌 보석\s*(\d+)\s*\/\s*(\d+)\s*개/);
      if (match) return { current: parseInt(match[1], 10), max: parseInt(match[2], 10) };
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
  // 받는다. 실전 확인: GET /api/arena/last-week의 {participated,
  // rewardReceived}로 정확히 판별 가능(수령 후 rewardReceived가 true로
  // 바뀌는 것까지 확인함). ⚠ 아레나는 토·일에만 진입 가능한데 이 보상은
  // 월~금에만 받을 수 있어, 아레나 매크로 자체에 묶으면 영영 못 받는
  // 모순이 생긴다. 그래서 이 함수는 아레나 mainLoop가 아니라 "일일" 단계에서
  // 최우선으로, 아레나 매크로 실행 여부와 무관하게 별도로 호출한다
  // (Modules.daily.claimWeeklyRewardsIfDue 참고). 성공적으로 확인(수령했거나
  // 받을 게 없었거나)했으면 true, API 실패 등으로 재시도가 필요하면 false.
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
      Core.log('arena', `⚠ 아레나 지난 주 보상 확인 실패: ${e.message}`);
      return false;
    }
    if (!data.participated || data.rewardReceived) {
      Core.log('arena', '아레나 지난 주 보상: 받을 것 없음(참여 안 했거나 이미 수령함)');
      return true;
    }
    Core.log('arena', `아레나 지난 주 보상 수령 시도 (전체 ${data.finalRank}위, 직업군 ${data.baseClassRank}위)`);

    try {
      await this.goToArena();
      const rewardTab = await Core.retryStep('아레나 "보상" 탭 찾기', () => Core.findButtonByText('보상'));
      if (!rewardTab) {
        Core.log('arena', '⚠ "보상" 탭을 찾지 못해 지난 주 보상 수령을 건너뜁니다.');
        return false;
      }
      if (!(await Core.safeClick(() => Core.findButtonByText('보상'), { beforeMin: 500, beforeMax: 900, afterMin: 700, afterMax: 1200 }))) {
        Core.log('arena', '⚠ "보상" 탭 클릭에 실패해 지난 주 보상 수령을 건너뜁니다.');
        return false;
      }
      const claimBtn = await Core.waitFor(() => Core.findButtonByText('보상 받기'), 8000, 250);
      if (!claimBtn) {
        Core.log('arena', '⚠ "보상 받기" 버튼을 찾지 못했습니다.');
        return false;
      }
      if (!(await Core.safeClick(() => Core.findButtonByText('보상 받기'), { beforeMin: 600, beforeMax: 1100, afterMin: 1000, afterMax: 1500 }))) {
        Core.log('arena', '⚠ "보상 받기" 클릭에 실패했습니다.');
        return false;
      }
      Core.log('arena', '아레나 지난 주 보상 수령 완료');
      return true;
    } catch (e) {
      Core.log('arena', `⚠ 아레나 지난 주 보상 수령 중 오류: ${e.message}`);
      return false;
    }
  };

  Modules.arena.mainLoop = async function () {
    const mod = this;
    mod.cycleCount = 0;

    if (!mod.isWeekend()) {
      mod.clearResume();
      Core.notifyStopped('arena', '아레나는 토요일과 일요일에만 자동 실행할 수 있습니다.');
      return;
    }
    mod.saveResume();
    await mod.goToArena();

    // 전투 도중 새로고침되었을 경우 결과창부터 정리한다.
    await mod.handleResultIfPresent();

    while (!mod.stopRequested) {
      const before = mod.readTodayBattleCount();
      if (before === null) throw new Error('아레나의 오늘 전투 횟수를 읽지 못했습니다.');
      mod.cycleCount = before;
      Core.updateModuleButtons();

      // ⚠ 버그 수정(2026-08, 사용자 확인 - 실전에서 오늘 전투 248회까지
      // 멈추지 않고 도는 것 확인됨): 프리시즌 기간에는 "다음 전투 에너지
      // 비용"이 몇 번을 싸우든 절대 "무료"에서 바뀌지 않는다(게임 규칙:
      // "프리시즌 기간에는 에너지가 소모되지 않으며"). 그래서 정규 아레나
      // 매크로가 프리시즌 기간 중에 실행되면(예: 토요일이 마침 프리시즌
      // 기간과 겹칠 때) "무료가 아니게 될 때까지"라는 정지 조건이 절대
      // 성립하지 않아 무한 루프에 빠졌다. 프리시즌 기간이면 에너지 체크
      // 대신 "오늘 받은 프리시즌 보석" 진행률로 정지 조건을 판단한다
      // (이벤트 탭의 프리시즌 매크로와 동일한 기준).
      const isPreseason = Core.bodyText().includes('프리시즌');
      if (isPreseason) {
        const gemProgress = mod.readPreseasonGemProgress();
        if (!gemProgress) throw new Error('프리시즌 기간인데 오늘 받은 프리시즌 보석 진행률을 읽지 못했습니다.');
        if (gemProgress.current >= gemProgress.max) {
          mod.clearResume();
          Core.notifyCompleted(
            'arena',
            `오늘 프리시즌 보석 ${gemProgress.current}/${gemProgress.max}개 완료 (전투 ${before}회) - 프리시즌 기간이라 보석 기준으로 정지`
          );
          return;
        }
      } else {
        // ⚠ 사용자 요청(2026-08): 고정 횟수 대신, 다음 전투 에너지 비용이
        // "무료"인 동안만 계속 돈다. 무료가 아니게 된 순간 정지한다(보통
        // 20회 지점). 프리시즌이 아닐 때만 유효한 판정이다(위 참고).
        const energyCost = mod.readNextBattleEnergyCost();
        if (!energyCost) throw new Error('아레나의 "다음 전투 에너지 비용"을 읽지 못했습니다.');
        if (!energyCost.isFree) {
          mod.clearResume();
          Core.notifyCompleted('arena', `오늘 아레나 ${before}회 완료 (에너지 비용이 "${energyCost.raw}"로 전환됨 - 무료 전투 소진)`);
          return;
        }
      }

      // ⚠ 사용자 요청(2026-08): 기존엔 마지막 공격 시각부터 고정 35초를 무조건
      // 기다린 뒤에야 waitForEnabledStart로 진짜 쿨타임(버튼 활성화)을 확인하는
      // 이중 구조였다. 결과창에서 "돌아가기"를 누르고 곧바로 이 자리로 돌아오므로,
      // 고정 대기 없이 진짜 쿨타임 감지(0.5초 간격 폴링)만으로 버튼이 켜지는
      // 즉시 공격하도록 단순화한다.
      Core.log('arena', `쿨타임 및 버튼 활성화 대기 중: 오늘 ${before}회 (다음 전투 비용: 무료)`);
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
      Core.log('arena', `아레나 전투 완료: 오늘 ${incremented}회`);
    }
  };


  function buildArenaTab(container) {
    const mod = Modules.arena;
    const refs = UIRefs.arena;

    const description = document.createElement('div');
    description.textContent =
      '고정 횟수가 아니라, 화면의 "다음 전투 에너지 비용"이 "무료"인 동안만 계속 실행합니다. 무료가 아니게 되는 순간(보통 하루 20회) 자동으로 멈춥니다.';
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
    refs.inputs = [];
  }
