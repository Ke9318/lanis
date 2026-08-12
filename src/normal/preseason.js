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
  const PRESEASON_CONFIG_KEY = 'lrm-preseason-config';
  Modules.preseason = {
    id: 'preseason',
    running: false,
    stopRequested: false,
    cycleCount: 0,
    config: {
      targetBattles: 10,
    },
  };

  Modules.preseason.saveConfig = function () {
    try {
      localStorage.setItem(PRESEASON_CONFIG_KEY, JSON.stringify(this.config));
    } catch (e) {}
  };

  Modules.preseason.loadConfig = function () {
    try {
      const saved = JSON.parse(localStorage.getItem(PRESEASON_CONFIG_KEY) || '{}');
      const value = parseInt(saved.targetBattles, 10);
      if (Number.isFinite(value) && value >= 1 && value <= 200) this.config.targetBattles = value;
    } catch (e) {}
  };

  Modules.preseason.mainLoop = async function () {
    const mod = this;
    mod.cycleCount = 0;
    mod.loadConfig();

    const target = Math.max(1, Math.min(200, parseInt(mod.config.targetBattles, 10) || 10));
    mod.config.targetBattles = target;
    mod.saveConfig();

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
      if (before >= target) {
        Core.notifyCompleted('preseason', `오늘 프리시즌 아레나 ${before}회 완료 (설정 ${target}회)`);
        return;
      }

      Core.log('preseason', `쿨타임 및 버튼 활성화 대기 중: 오늘 ${before}/${target}회`);
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
      Core.log('preseason', `프리시즌 아레나 전투 완료: 오늘 ${incremented}/${target}회`);
    }
  };

  function buildPreseasonTab(container) {
    const mod = Modules.preseason;
    const refs = UIRefs.preseason;
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
      '정규 아레나는 토·일에만 열리지만, 프리시즌 기간엔 평일에도 아레나(/arena)가 열립니다. 이 탭은 요일 제약 없이 실행됩니다. "오늘 전투 횟수"를 기준으로 설정 횟수까지 실행합니다.';
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
    refs.inputs = [countInput];
  }
