  // -------------------------- 프리시즌 아레나 --------------------------
  // ⚠ 사용자 요청(2026-08): 정규 아레나는 토·일에만 열리지만, 프리시즌
  // 기간엔 같은 화면(/arena)이 평일에도 열린다. 실전 확인: "아레나 시즌 8
  // 프리시즌" 배너와 함께 "오늘 전투 횟수", "전투 시작" 등 기존 아레나와
  // 완전히 동일한 화면 구조가 그대로 뜬다(같은 URL, 같은 셀렉터). 그래서
  // Modules.arena의 이미 검증된 헬퍼(goToArena/readTodayBattleCount/
  // waitForEnabledStart/handleResultIfPresent - 전부 순수 함수라 this
  // 바인딩 없이 그대로 재사용 가능함)를 그대로 쓰고, 요일 제약만 뺀 별도
  // 모듈로 만든다. 프리시즌이 끝나 화면에 배너가 안 뜨거나 /arena 진입
  // 자체가 막히면 goToArena가 기존과 동일하게 에러로 정지시킨다.
  Modules.preseason = {
    id: 'preseason',
    running: false,
    stopRequested: false,
    cycleCount: 0,
  };

  Modules.preseason.mainLoop = async function () {
    const mod = this;
    mod.cycleCount = 0;

    await Modules.arena.goToArena();
    if (!Core.bodyText().includes('프리시즌')) {
      throw new Error('현재 프리시즌 기간이 아닌 것으로 보입니다 (화면에 "프리시즌" 표시가 없음).');
    }

    // 전투 도중 새로고침되었을 경우 결과창부터 정리한다.
    await Modules.arena.handleResultIfPresent();

    while (!mod.stopRequested) {
      const before = Modules.arena.readTodayBattleCount();
      if (before === null) throw new Error('아레나의 오늘 전투 횟수를 읽지 못했습니다.');
      mod.cycleCount = before;
      Core.updateModuleButtons();

      // ⚠ 사용자 요청(2026-08): 고정 횟수 대신, "오늘 받은 프리시즌 보석"이
      // 하루 최대치에 도달할 때까지 돈다. 프리시즌은 에너지가 안 드니
      // 전투 횟수가 아니라 보석 진행률이 진짜 목표다.
      const gemProgress = Modules.arena.readPreseasonGemProgress();
      if (!gemProgress) throw new Error('오늘 받은 프리시즌 보석 진행률을 읽지 못했습니다.');
      if (gemProgress.current >= gemProgress.max) {
        Core.notifyCompleted('preseason', `오늘 프리시즌 보석 ${gemProgress.current}/${gemProgress.max}개 완료 (전투 ${before}회)`);
        return;
      }

      Core.log('preseason', `쿨타임 및 버튼 활성화 대기 중: 보석 ${gemProgress.current}/${gemProgress.max}개`);
      const startButton = await Modules.arena.waitForEnabledStart();
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
        Core.log('preseason', '⚠ 전투 시작 클릭 후 결과 화면이 나타나지 않음 — 클릭 누락으로 판단, 즉시 재시도');
        continue;
      }
      await Modules.arena.handleResultIfPresent();
      const incremented = await Core.waitFor(() => {
        const count = Modules.arena.readTodayBattleCount();
        return count !== null && count > before ? count : null;
      }, 15000, 300);
      if (incremented === null) throw new Error('전투 후 오늘 전투 횟수 증가를 확인하지 못했습니다.');
      mod.cycleCount = incremented;
      const gemAfter = Modules.arena.readPreseasonGemProgress();
      Core.log('preseason', `프리시즌 아레나 전투 완료: 오늘 ${incremented}회, 보석 ${gemAfter ? `${gemAfter.current}/${gemAfter.max}` : '?'}개`);
    }
  };

  // ⚠ 사용자 요청(2026-08): 여름 이벤트 한정 "햇살 토큰"을 인벤토리에서
  // 찾아 "사용 가능 상태"로 전환하는 일회성 액션. 프리시즌 탭에 묶어두고
  // 프리시즌이 끝나면(여름 이벤트도 같이 끝날 것으로 예상) 이 로직도 함께
  // 폐기한다. 자동 반복 매크로가 아니라 버튼 클릭 시 즉시 실행되는 1회성
  // 액션이다.
  //
  // 실전 확인: "사용" 클릭 시 확인창이 뜨고, 수량 입력칸은 이미 그 아이템의
  // 1회 사용 최대치(실전 확인: 50개)로 자동 채워져 있다(수정 불필요, 손대면
  // 안 됨 - 보상 상자 사용 로직에서 겪은 것과 동일한 함정). "사용" 확정하면
  // "햇살 토큰 N개를 사용 가능 상태로 전환했습니다"로 즉시 처리되고, 그
  // 행이 목록에서 갱신된다(수량이 줄거나 완전히 사라짐). 보유 수량이
  // 많으면(예: 547개) 여러 번 반복해야 다 소진된다.
  Modules.preseason.useSunshineTokens = async function () {
    Core.log('preseason', '"햇살 토큰" 사용 시작');
    await Core.clickNavMenuExact('캐릭', '인벤토리');
    const onInventoryPage = await Core.waitFor(() => location.pathname.startsWith('/inventory'), 15000, 300);
    if (!onInventoryPage) throw new Error('인벤토리 화면 진입을 확인하지 못했습니다.');
    await Core.humanDelay(500, 900);

    if (!(await Core.safeClick(() => Core.findButtonByText('소모품'), { beforeMin: 400, beforeMax: 700, afterMin: 700, afterMax: 1100 }))) {
      throw new Error('"소모품" 탭 클릭에 실패했습니다.');
    }

    const findTokenRow = () => Core.gameElements('tr').find((tr) => tr.textContent.includes('햇살 토큰') && Core.isElementVisible(tr));

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
      if (!useBtn) throw new Error('"햇살 토큰" 사용 버튼을 찾지 못했습니다.');
      if (!(await Core.safeClick(() => useBtn, { beforeMin: 400, beforeMax: 700, afterMin: 700, afterMax: 1000 }))) {
        throw new Error('"햇살 토큰" 사용 버튼 클릭에 실패했습니다.');
      }

      const dialog = await Core.waitFor(
        () => Core.gameElements('[role="dialog"]').find((d) => Core.isElementVisible(d) && d.textContent.includes('햇살 토큰을(를) 사용하시겠습니까')) || null,
        6000,
        250
      );
      if (!dialog) throw new Error('"햇살 토큰" 사용 확인창을 찾지 못했습니다.');

      // ⚠ 수량 입력칸은 이미 1회 사용 최대치로 채워져 있다 - 절대 건드리지 않는다.
      const confirmBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용');
      if (!confirmBtn) throw new Error('"햇살 토큰" 사용 확인 버튼을 찾지 못했습니다.');
      if (confirmBtn.disabled) throw new Error('"햇살 토큰" 사용 확인 버튼이 비활성화 상태입니다.');
      if (!(await Core.safeClick(() => confirmBtn, { beforeMin: 500, beforeMax: 900, afterMin: 900, afterMax: 1400 }))) {
        throw new Error('"햇살 토큰" 사용을 확정하지 못했습니다.');
      }
      Core.log('preseason', `"햇살 토큰" 사용 ${usedCycles + 1}회차 완료`);
    }

    if (usedCycles === 0) {
      Core.log('preseason', '"햇살 토큰"이 없거나 이미 전부 사용했습니다.');
    } else {
      Core.log('preseason', `"햇살 토큰" 사용 완료 (총 ${usedCycles}회 반복)`);
    }
  };

  function buildPreseasonTab(container) {
    const mod = Modules.preseason;
    const refs = UIRefs.preseason;

    const description = document.createElement('div');
    description.textContent =
      '정규 아레나는 토·일에만 열리지만, 프리시즌 기간엔 평일에도 아레나(/arena)가 열립니다. 이 탭은 요일 제약 없이 실행됩니다. 고정 횟수가 아니라, "오늘 받은 프리시즌 보석"이 하루 최대치에 도달할 때까지 실행합니다.';
    description.style.cssText = 'font-size:11px; color:#ccc; line-height:1.5; margin:7px 0;';
    container.appendChild(description);

    const note = document.createElement('div');
    note.textContent = '※ 화면에 "프리시즌" 표시가 없으면(프리시즌 기간이 아니면) 정지합니다.';
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

    // ⚠ 사용자 요청(2026-08): "햇살 토큰"(여름 이벤트 한정) 일괄 사용
    // 버튼. 자동 반복 매크로가 아니라 눌렀을 때 그 자리에서 바로 실행되는
    // 1회성 액션이라 시작/정지 상태와 무관하게 별도로 둔다.
    const tokenBtnRow = document.createElement('div');
    tokenBtnRow.style.cssText = 'margin-top:10px; padding-top:10px; border-top:1px solid #333;';
    const tokenLabel = document.createElement('div');
    tokenLabel.textContent = '햇살 토큰 일괄 사용 (여름 이벤트 한정, 이벤트 종료 시 같이 제거될 기능)';
    tokenLabel.style.cssText = 'font-size:11px; color:#ccc; margin-bottom:5px;';
    const tokenBtn = document.createElement('button');
    tokenBtn.textContent = '햇살 토큰 사용';
    tokenBtn.style.cssText = btnStyle('#8e5cf7');
    const tokenStatusEl = document.createElement('span');
    tokenStatusEl.textContent = '';
    tokenStatusEl.style.cssText = 'margin-left:8px; font-size:11px; color:#aaa;';
    tokenBtn.addEventListener('click', async () => {
      tokenBtn.disabled = true;
      tokenStatusEl.textContent = '사용 중...';
      try {
        await Modules.preseason.useSunshineTokens();
        tokenStatusEl.textContent = '완료';
      } catch (e) {
        tokenStatusEl.textContent = '실패: ' + e.message;
        Core.log('preseason', `⚠ 햇살 토큰 사용 실패: ${e.message}`);
      }
      tokenBtn.disabled = false;
    });
    tokenBtnRow.append(tokenLabel, tokenBtn, tokenStatusEl);
    container.appendChild(tokenBtnRow);
  }
