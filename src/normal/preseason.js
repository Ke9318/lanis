  // -------------------------- 가을 심층던전 아레나 --------------------------
  Modules.preseason = {
    id: 'preseason',
    running: false,
    stopRequested: false,
    cycleCount: 0,
  };

  Modules.preseason.readAutumnTokenProgress = function () {
    const text = Core.bodyText();
    const today = text.match(/오늘 획득한 단풍 토큰\s*(\d+)\s*\/\s*(\d+)\s*개/);
    const weekly = text.match(/이번 주 획득한 단풍 토큰\s*(\d+)\s*\/\s*(\d+)\s*개/);
    if (!today || !weekly) return null;
    return {
      today: { current: Number(today[1]), max: Number(today[2]) },
      weekly: { current: Number(weekly[1]), max: Number(weekly[2]) },
    };
  };

  Modules.preseason.findReadyBattleStartButton = function () {
    return Core.allButtons().find((button) => {
      const text = button.textContent.replace(/\s+/g, ' ').trim();
      return text.startsWith('전투 시작') && !button.disabled &&
        button.getAttribute('aria-disabled') !== 'true' && Core.isElementVisible(button);
    }) || null;
  };

  Modules.preseason.goToAutumnDeepArena = async function () {
    const onArena = () =>
      location.pathname.replace(/\/$/, '') === '/event/autumn' &&
      Core.bodyText().includes('오늘 획득한 단풍 토큰') &&
      Core.bodyText().includes('이번 주 획득한 단풍 토큰');
    if (onArena()) return true;

    // 우측 끝 프로필 아이콘 → 가을 이벤트 → 심층던전 아레나 순서로 진입한다.
    const headerButtons = Core.gameElements('header button').filter((button) => Core.isElementVisible(button));
    const menuButton = headerButtons[headerButtons.length - 1];
    if (!menuButton) throw new Error('상단 오른쪽 메뉴 아이콘을 찾지 못했습니다.');
    menuButton.click();
    const autumnMenu = await Core.waitFor(
      () => Core.gameElements('[role="menuitem"]').find(
        (item) => Core.isElementVisible(item) && item.textContent.trim() === '가을 이벤트'
      ) || null,
      5000,
      150
    );
    if (!autumnMenu) throw new Error('오른쪽 메뉴에서 "가을 이벤트"를 찾지 못했습니다.');
    await Core.humanDelay(500, 900);
    autumnMenu.click();

    const autumnPage = await Core.waitFor(
      () => location.pathname.replace(/\/$/, '') === '/event/autumn' ? true : null,
      12000,
      250
    );
    if (!autumnPage) throw new Error('가을 이벤트 화면 진입을 확인하지 못했습니다.');
    const arenaTab = await Core.waitFor(
      () => Core.findButtonByText('심층던전 아레나'),
      7000,
      200
    );
    if (!arenaTab) throw new Error('가을 이벤트의 "심층던전 아레나" 탭을 찾지 못했습니다.');
    await Core.humanDelay(500, 900);
    arenaTab.click();
    const ready = await Core.waitFor(() => onArena() ? true : null, 10000, 250);
    if (!ready) throw new Error('심층던전 아레나 진행률 화면을 확인하지 못했습니다.');
    return true;
  };

  Modules.preseason.mainLoop = async function () {
    const mod = this;
    mod.cycleCount = 0;
    await mod.goToAutumnDeepArena();

    while (!mod.stopRequested) {
      const before = mod.readAutumnTokenProgress();
      if (!before) throw new Error('오늘/주간 단풍 토큰 진행률을 읽지 못했습니다.');
      if (before.today.current >= before.today.max || before.weekly.current >= before.weekly.max) {
        Core.notifyCompleted(
          'preseason',
          `가을 심층던전 아레나 완료: 오늘 ${before.today.current}/${before.today.max}, 주간 ${before.weekly.current}/${before.weekly.max}`
        );
        return;
      }

      Core.log(
        'preseason',
        `단풍 토큰 획득 전투 준비: 오늘 ${before.today.current}/${before.today.max}, 주간 ${before.weekly.current}/${before.weekly.max}`
      );
      if (mod.stopRequested) return;
      const readyState = await Core.waitFor(
        () => {
          const progress = mod.readAutumnTokenProgress();
          if (progress && (
            progress.today.current >= progress.today.max
            || progress.weekly.current >= progress.weekly.max
          )) {
            return { completed: true, progress };
          }
          const button = mod.findReadyBattleStartButton();
          return button ? { completed: false, button } : null;
        },
        12000,
        250,
        () => mod.stopRequested
      );
      if (!readyState) throw new Error('가을 심층던전 아레나의 완료 상태나 활성화된 "전투 시작" 버튼을 확인하지 못했습니다.');
      if (readyState.completed) {
        const progress = readyState.progress;
        Core.notifyCompleted(
          'preseason',
          `가을 심층던전 아레나 완료: 오늘 ${progress.today.current}/${progress.today.max}, 주간 ${progress.weekly.current}/${progress.weekly.max}`
        );
        return;
      }
      const clicked = await Core.safeClick(
        () => mod.findReadyBattleStartButton(),
        { beforeMin: 180, beforeMax: 420, afterMin: 120, afterMax: 260 }
      );
      if (!clicked) throw new Error('가을 심층던전 아레나 "전투 시작" 버튼 클릭에 실패했습니다.');

      const resultBack = await Core.waitFor(
        () => Core.findButtonByText('심층던전 아레나로 돌아가기'),
        15000,
        250
      );
      if (!resultBack) throw new Error('가을 심층던전 아레나 전투 결과 화면을 확인하지 못했습니다.');
      if (mod.stopRequested) return;
      await Core.humanDelay(180, 350);
      if (!(await Core.safeClick(
        () => Core.findButtonByText('심층던전 아레나로 돌아가기'),
        { beforeMin: 150, beforeMax: 320, afterMin: 180, afterMax: 380 }
      ))) {
        throw new Error('"심층던전 아레나로 돌아가기" 버튼 클릭에 실패했습니다.');
      }

      const increased = await Core.waitFor(() => {
        const after = mod.readAutumnTokenProgress();
        return after &&
          (after.today.current > before.today.current || after.weekly.current > before.weekly.current)
          ? after
          : null;
      }, 12000, 300);
      if (!increased) throw new Error('전투 후 단풍 토큰 진행률 증가를 확인하지 못했습니다.');
      mod.cycleCount++;
      Core.updateModuleButtons();
      Core.log(
        'preseason',
        `가을 심층던전 아레나 전투 완료: 오늘 ${increased.today.current}/${increased.today.max}, 주간 ${increased.weekly.current}/${increased.weekly.max}`
      );
      await Core.humanDelay(120, 280);
    }
  };

  // ⚠ 사용자 요청(2026-08): 가을 이벤트 "단풍 토큰"을 인벤토리에서
  // 찾아 "사용 가능 상태"로 전환하는 일회성 액션. 프리시즌 탭에 묶어두고
  // 프리시즌이 끝나면(여름 이벤트도 같이 끝날 것으로 예상) 이 로직도 함께
  // 폐기한다. 자동 반복 매크로가 아니라 버튼 클릭 시 즉시 실행되는 1회성
  // 액션이다.
  //
  // 실전 확인: "사용" 클릭 시 확인창이 뜨고, 수량 입력칸은 이미 그 아이템의
  // 1회 사용 최대치(실전 확인: 50개)로 자동 채워져 있다(수정 불필요, 손대면
  // 안 됨 - 보상 상자 사용 로직에서 겪은 것과 동일한 함정). "사용" 확정하면
  // "단풍 토큰 N개를 사용 가능 상태로 전환했습니다"로 즉시 처리되고, 그
  // 행이 목록에서 갱신된다(수량이 줄거나 완전히 사라짐). 보유 수량이
  // 많으면(예: 547개) 여러 번 반복해야 다 소진된다.
  Modules.preseason.useAutumnTokens = async function () {
    Core.log('preseason', '"단풍 토큰" 사용 시작');
    await Core.clickNavMenuExact('캐릭', '인벤토리');
    const onInventoryPage = await Core.waitFor(() => location.pathname.startsWith('/inventory'), 15000, 300);
    if (!onInventoryPage) throw new Error('인벤토리 화면 진입을 확인하지 못했습니다.');
    await Core.humanDelay(500, 900);

    if (!(await Core.safeClick(() => Core.findButtonByText('소모품'), { beforeMin: 400, beforeMax: 700, afterMin: 700, afterMax: 1100 }))) {
      throw new Error('"소모품" 탭 클릭에 실패했습니다.');
    }

    const findTokenRow = () => Core.gameElements('tr').find((tr) => tr.textContent.includes('단풍 토큰') && Core.isElementVisible(tr));

    let usedCycles = 0;
    const maxCycles = 30; // 1회당 최대 50개 * 30회 = 최대 1500개까지 대응
    for (; usedCycles < maxCycles; usedCycles++) {
      // 이전 사용으로 목록/페이지 구성이 바뀔 수 있으니 매번 1페이지로 복귀 후 탐색
      const firstPageBtn = Core.gameElements('button').find(
        (b) => b.getAttribute('aria-label') === 'Go to first page' && !b.disabled && Core.isElementVisible(b)
      );
      if (firstPageBtn) {
        firstPageBtn.click();
        await Core.humanDelay(300, 500);
      }

      let row = findTokenRow();
      if (!row) {
        for (let page = 0; page < 20 && !row; page++) {
          const nextPageBtn = Core.gameElements('button').find(
            (b) => b.getAttribute('aria-label') === 'Go to next page' && !b.disabled && Core.isElementVisible(b)
          );
          if (!nextPageBtn) break;
          nextPageBtn.click();
          await Core.humanDelay(400, 700);
          row = findTokenRow();
        }
      }
      if (!row) break; // 더 이상 없음 = 소진 완료

      const useBtn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용');
      if (!useBtn) throw new Error('"단풍 토큰" 사용 버튼을 찾지 못했습니다.');
      if (!(await Core.safeClick(() => useBtn, { beforeMin: 400, beforeMax: 700, afterMin: 700, afterMax: 1000 }))) {
        throw new Error('"단풍 토큰" 사용 버튼 클릭에 실패했습니다.');
      }

      const dialog = await Core.waitFor(
        () => Core.gameElements('[role="dialog"]').find((d) => Core.isElementVisible(d) && d.textContent.includes('단풍 토큰을(를) 사용하시겠습니까')) || null,
        6000,
        250
      );
      if (!dialog) throw new Error('"단풍 토큰" 사용 확인창을 찾지 못했습니다.');

      // ⚠ 수량 입력칸은 이미 1회 사용 최대치로 채워져 있다 - 절대 건드리지 않는다.
      const confirmBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용');
      if (!confirmBtn) throw new Error('"단풍 토큰" 사용 확인 버튼을 찾지 못했습니다.');
      if (confirmBtn.disabled) throw new Error('"단풍 토큰" 사용 확인 버튼이 비활성화 상태입니다.');
      if (!(await Core.safeClick(() => confirmBtn, { beforeMin: 500, beforeMax: 900, afterMin: 900, afterMax: 1400 }))) {
        throw new Error('"단풍 토큰" 사용을 확정하지 못했습니다.');
      }
      Core.log('preseason', `"단풍 토큰" 사용 ${usedCycles + 1}회차 완료`);
    }

    if (usedCycles === 0) {
      Core.log('preseason', '"단풍 토큰"이 없거나 이미 전부 사용했습니다.');
    } else {
      Core.log('preseason', `"단풍 토큰" 사용 완료 (총 ${usedCycles}회 반복)`);
    }
  };

  const PRESEASON_ARENA_FISH_INTERVAL_MS = 30 * 60 * 1000;
  Modules.preseasonArena = {
    id: 'preseasonArena',
    running: false,
    stopRequested: false,
    runId: 0,
    loopPromise: null,
    cycleCount: 0,
    nextFishingAt: 0,
  };

  Modules.preseasonArena.ensureArena = async function () {
    await Modules.arena.goToArena();
    await Modules.arena.handleResultIfPresent();
    if (!Core.bodyText().includes('프리시즌')) {
      throw new Error('현재 아레나가 프리시즌 상태가 아닙니다. 무한아레나를 중단합니다.');
    }
  };

  Modules.preseasonArena.waitForArenaStart = async function () {
    const deadline = Date.now() + 95000;
    while (!this.stopRequested && Date.now() < deadline) {
      if (location.pathname.replace(/\/$/, '') !== '/arena') {
        Core.log('preseasonArena', '다른 화면 감지 → 아레나로 자동 복귀');
        await this.ensureArena();
      }
      const button = Core.findButtonByText('전투 시작');
      if (button && !button.disabled) return button;
      await Core.interruptibleSleep(800, () => this.stopRequested, 400);
    }
    return null;
  };

  Modules.preseasonArena.runFishingCycle = async function () {
    Core.log('preseasonArena', '30분 주기 통발 작업 시작');
    await Core.clickNavMenuExact('마을', '낚시터', () => this.stopRequested);
    const arrived = await Core.waitFor(
      () => location.pathname.startsWith('/fishing') && Core.bodyText().includes('심포니아 낚시터'),
      15000,
      300
    );
    if (!arrived) throw new Error('낚시터 진입을 확인하지 못했습니다.');
    if (this.stopRequested) return;

    let installButton = Core.findButtonByText('통발 설치하기');
    if (!installButton) {
      const collectButton = Core.findButtonByText('통발 수거하기');
      if (!collectButton || collectButton.disabled) {
        Core.log('preseasonArena', '통발이 아직 수거 불가 상태라 이번 주기는 건너뜁니다.');
        return;
      }
      if (!(await Core.safeClick(
        () => {
          const button = Core.findButtonByText('통발 수거하기');
          return button && !button.disabled ? button : null;
        },
        { beforeMin: 450, beforeMax: 850, afterMin: 700, afterMax: 1100 }
      ))) throw new Error('통발 수거 버튼 클릭에 실패했습니다.');
      installButton = await Core.waitFor(() => Core.findButtonByText('통발 설치하기'), 8000, 250);
      if (!installButton) throw new Error('통발 수거 후 설치 버튼이 나타나지 않았습니다.');
      Core.log('preseasonArena', '통발 수거 완료');
    }

    if (this.stopRequested) return;
    if (!(await Core.safeClick(
      () => Core.findButtonByText('통발 설치하기'),
      { beforeMin: 450, beforeMax: 850, afterMin: 350, afterMax: 650 }
    ))) throw new Error('통발 설치 버튼 클릭에 실패했습니다.');

    const confirmButton = await Core.waitFor(() => {
      const dialog = Core.gameElements('[role="dialog"]').find(
        (el) => Core.isElementVisible(el) && el.textContent.includes('통발 설치 확인')
      );
      return dialog
        ? [...dialog.querySelectorAll('button')].find((button) => button.textContent.trim() === '확인' && !button.disabled) || null
        : null;
    }, 6000, 200);
    if (!confirmButton) throw new Error('통발 설치 확인창의 확인 버튼을 찾지 못했습니다.');
    if (!(await Core.safeClick(() => confirmButton, {
      beforeMin: 400,
      beforeMax: 750,
      afterMin: 700,
      afterMax: 1100,
    }))) throw new Error('통발 설치 확인에 실패했습니다.');
    const installed = await Core.waitFor(
      () => {
        const button = Core.findButtonByText('통발 설치 중');
        return button && button.disabled ? true : null;
      },
      8000,
      250
    );
    if (!installed) throw new Error('통발 재설치 상태를 확인하지 못했습니다.');
    Core.log('preseasonArena', '통발 재설치 완료 → 아레나 복귀');
  };

  Modules.preseasonArena.mainLoop = async function () {
    this.cycleCount = 0;
    this.nextFishingAt = Date.now() + PRESEASON_ARENA_FISH_INTERVAL_MS;
    await this.ensureArena();
    while (!this.stopRequested) {
      if (Date.now() >= this.nextFishingAt) {
        await this.runFishingCycle();
        this.nextFishingAt = Date.now() + PRESEASON_ARENA_FISH_INTERVAL_MS;
        if (this.stopRequested) return;
        await this.ensureArena();
      } else {
        await this.ensureArena();
      }

      const before = Modules.arena.readTodayBattleCount();
      if (before === null) throw new Error('아레나의 오늘 전투 횟수를 읽지 못했습니다.');
      const startButton = await this.waitForArenaStart();
      if (!startButton) {
        if (this.stopRequested) return;
        throw new Error('95초 안에 아레나 전투 시작 버튼이 활성화되지 않았습니다.');
      }
      if (!(await Core.safeClick(
        () => {
          const button = Core.findButtonByText('전투 시작');
          return button && !button.disabled ? button : null;
        },
        { beforeMin: 650, beforeMax: 1150 }
      ))) throw new Error('프리시즌 아레나 전투 시작 클릭에 실패했습니다.');

      const resultBack = await Core.waitFor(
        () => Core.findButtonByText('아레나로 돌아가기') || Core.findButtonByText('돌아가기'),
        15000,
        400
      );
      if (!resultBack) {
        Core.log('preseasonArena', '결과 화면을 확인하지 못해 아레나 화면부터 다시 확인합니다.');
        continue;
      }
      await Modules.arena.handleResultIfPresent();
      const after = await Core.waitFor(() => {
        const count = Modules.arena.readTodayBattleCount();
        return count !== null && count > before ? count : null;
      }, 15000, 300);
      if (after === null) throw new Error('전투 후 오늘 전투 횟수 증가를 확인하지 못했습니다.');
      this.cycleCount++;
      Core.updateModuleButtons();
      const fishingIn = Math.max(0, Math.ceil((this.nextFishingAt - Date.now()) / 60000));
      Core.log('preseasonArena', `아레나 전투 완료: 오늘 ${after}회 / 다음 통발 작업 약 ${fishingIn}분 후`);
    }
  };

  function buildPreseasonTab(container) {
    const mod = Modules.preseason;
    const refs = UIRefs.preseason;

    const description = document.createElement('div');
    description.textContent =
      '오른쪽 메뉴의 가을 이벤트 → 심층던전 아레나로 이동해 전투합니다. 오늘 단풍 토큰 한도 또는 주간 단풍 토큰 한도에 도달하면 자동으로 멈춥니다.';
    description.style.cssText = 'font-size:11px; color:#ccc; line-height:1.5; margin:7px 0;';
    container.appendChild(description);

    const note = document.createElement('div');
    note.textContent = '※ 전투 시작과 결과 복귀 사이에 자연스러운 지연을 두며, 매 전투 후 오늘/주간 단풍 토큰 증가를 확인합니다.';
    note.style.cssText = 'font-size:10px; color:#f5a623; line-height:1.45; margin-bottom:7px;';
    container.appendChild(note);

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
    startBtn.addEventListener('click', () => Core.startModule('preseason'));
    stopBtn.addEventListener('click', () => Core.requestStopModule('preseason'));
    btnRow.append(startBtn, stopBtn);
    container.append(btnRow, statusEl);

    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.inputs = [];

    // ⚠ 사용자 요청(2026-08): "단풍 토큰"(가을 이벤트) 일괄 사용
    // 버튼. 자동 반복 매크로가 아니라 눌렀을 때 그 자리에서 바로 실행되는
    // 1회성 액션이라 시작/정지 상태와 무관하게 별도로 둔다.
    const tokenBtnRow = document.createElement('div');
    tokenBtnRow.style.cssText = 'margin-top:10px; padding-top:10px; border-top:1px solid #333;';
    const tokenLabel = document.createElement('div');
    tokenLabel.textContent = '단풍 토큰 일괄 사용 (가을 이벤트)';
    tokenLabel.style.cssText = 'font-size:11px; color:#ccc; margin-bottom:5px;';
    const tokenBtn = document.createElement('button');
    tokenBtn.textContent = '단풍 토큰 사용';
    tokenBtn.style.cssText = btnStyle('#8e5cf7');
    const tokenStatusEl = document.createElement('span');
    tokenStatusEl.textContent = '';
    tokenStatusEl.style.cssText = 'margin-left:8px; font-size:11px; color:#aaa;';
    tokenBtn.addEventListener('click', async () => {
      tokenBtn.disabled = true;
      tokenStatusEl.textContent = '사용 중...';
      try {
        await Modules.preseason.useAutumnTokens();
        tokenStatusEl.textContent = '완료';
      } catch (e) {
        tokenStatusEl.textContent = '실패: ' + e.message;
        Core.log('preseason', `⚠ 단풍 토큰 사용 실패: ${e.message}`);
      }
      tokenBtn.disabled = false;
    });
    tokenBtnRow.append(tokenLabel, tokenBtn, tokenStatusEl);
    container.appendChild(tokenBtnRow);

    // 프리시즌 일반 아레나는 보석 일일 한도와 무관하게 계속 돌 수 있으므로
    // 기존 가을 이벤트 아레나와 실행 상태를 완전히 분리한다. 이 실행 중에는
    // 30분마다 통발을 수거·재설치하고 다시 아레나로 돌아온다.
    const infiniteRow = document.createElement('div');
    infiniteRow.style.cssText = 'margin-top:10px; padding-top:10px; border-top:1px solid #333;';
    const infiniteLabel = document.createElement('div');
    infiniteLabel.textContent = '프리시즌 무한아레나 (30분마다 통발 수거·재설치)';
    infiniteLabel.style.cssText = 'font-size:11px; color:#ccc; margin-bottom:5px;';
    const infiniteDescription = document.createElement('div');
    infiniteDescription.textContent = '횟수 제한 없이 일반 아레나를 반복합니다. 다른 화면으로 이동하면 자동 복귀하며, 통발 작업 후에도 아레나로 돌아옵니다.';
    infiniteDescription.style.cssText = 'font-size:10px; color:#f5a623; line-height:1.45; margin-bottom:7px;';
    const infiniteBtnRow = document.createElement('div');
    infiniteBtnRow.style.cssText = 'display:flex; gap:6px; align-items:center;';
    const infiniteStartBtn = document.createElement('button');
    infiniteStartBtn.textContent = '무한아레나 시작';
    infiniteStartBtn.style.cssText = btnStyle('#1565c0');
    const infiniteStopBtn = document.createElement('button');
    infiniteStopBtn.textContent = '정지';
    infiniteStopBtn.style.cssText = btnStyle('#c62828');
    infiniteStopBtn.disabled = true;
    const infiniteStatusEl = document.createElement('div');
    infiniteStatusEl.textContent = '대기중';
    infiniteStatusEl.style.cssText = 'font-size:11px; color:#ccc; margin-top:5px;';
    infiniteStartBtn.addEventListener('click', () => Core.startModule('preseasonArena'));
    infiniteStopBtn.addEventListener('click', () => Core.requestStopModule('preseasonArena'));
    infiniteBtnRow.append(infiniteStartBtn, infiniteStopBtn);
    infiniteRow.append(infiniteLabel, infiniteDescription, infiniteBtnRow, infiniteStatusEl);
    container.appendChild(infiniteRow);

    UIRefs.preseasonArena.startBtn = infiniteStartBtn;
    UIRefs.preseasonArena.stopBtn = infiniteStopBtn;
    UIRefs.preseasonArena.statusEl = infiniteStatusEl;
    UIRefs.preseasonArena.inputs = [];
  }
