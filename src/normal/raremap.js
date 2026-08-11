  // -------------------------- 모듈 3: 레어맵 --------------------------
  Modules.raremap = {
    id: 'raremap',
    running: false,
    stopRequested: false,
    cycleCount: 0,
    stopReason: '',
    config: {
      maxCycles: 200,
    },
  };

  Modules.raremap.EXCLUDE_TEXTS = ['전투', '마을', '설정', '취소', '사용하기', '닫기', '로그아웃', '알림'];

  Modules.raremap.randomClickDelay = function () {
    return 1200 + Math.random() * 900;
  };

  Modules.raremap.getMapIcon = function () {
    return document.querySelector('div[aria-label="지도 아이템을 사용해 레어맵으로 이동하기"]');
  };

  // ⚠ 사용자 요청(2026-08): 레어맵 매크로는 지금까지 "이미 사냥터(/battle)
  // 화면에 있어야만" 작동했다. 다른 화면(인벤토리, 캐릭 등)에 있으면 지도
  // 사용 아이콘 자체가 없어 바로 실패했다. 실전 확인 결과 특정 사냥터일
  // 필요는 없고(지도 아이템 사용 아이콘은 /battle 화면이면 사냥터 종류와
  // 무관하게 항상 존재), 단순히 /battle 화면으로만 이동하면 된다.
  // ⚠ 사용자 요청(2026-08): 아무 사냥터가 아니라, 자동사냥 매크로에 등록된
  // 메인 사냥터(Modules.autohunt.config.groundSuffix/floor)로 가야 한다.
  // 이렇게 해야 레어맵이 실제로 노리는 사냥터와 일치한다.
  Modules.raremap.ensureOnBattleScreen = async function () {
    const groundSuffix = (Modules.autohunt.config && Modules.autohunt.config.groundSuffix) || '평야';
    const floor = Modules.autohunt.config && Modules.autohunt.config.floor;
    if (location.pathname.replace(/\/$/, '') === '/battle') {
      if (floor) await Modules.autohunt.selectFloor(floor);
      return true;
    }
    Core.log('raremap', `사냥터 화면이 아님 - 등록된 사냥터(${groundSuffix})로 이동`);
    try {
      await Core.clickNavMenuSuffix('전투', groundSuffix);
    } catch (e) {
      Core.log('raremap', `⚠ 사냥터 이동 실패: ${e.message}`);
      return false;
    }
    const arrived = await Core.waitFor(
      () => location.pathname.replace(/\/$/, '') === '/battle',
      10000,
      250
    );
    if (!arrived) return false;
    if (floor) await Modules.autohunt.selectFloor(floor);
    return true;
  };

  Modules.raremap.getMapDialog = function () {
    const titleEl = Array.from(document.querySelectorAll('h1, h2, h3')).find((el) => el.textContent.trim() === '지도 아이템 사용하기');
    if (!titleEl) return null;
    return titleEl.closest('[role="dialog"]');
  };

  // ⚠ 사용자 요청(2026-08): "숨겨진 방의 지도"는 재전직 때 따로 써야 하는
  // 아이템이라, 레어맵 매크로가 아무 지도나 목록 맨 위 걸 골라 써버리면
  // 안 된다(사용자가 그동안 창고에 매번 넣어서 보호해야 했던 이유). 이름이
  // 이 목록에 있으면 사용 후보에서 건너뛴다. 나중에 다른 지도도 보호하고
  // 싶으면 이 배열에 이름만 추가하면 된다.
  Modules.raremap.EXCLUDED_MAP_ITEM_NAMES = ['숨겨진 방의 지도'];

  Modules.raremap.getTopRadio = function (dialog) {
    const inputs = [...dialog.querySelectorAll('input[type="radio"]')];
    for (const input of inputs) {
      const radio = input.closest('.MuiRadio-root') || input.parentElement;
      const row = radio ? radio.parentElement : null;
      const text = row ? row.textContent : '';
      if (Modules.raremap.EXCLUDED_MAP_ITEM_NAMES.some((name) => text.includes(name))) continue;
      if (
        radio &&
        !input.disabled &&
        radio.getAttribute('aria-disabled') !== 'true' &&
        !/[xX×]\s*0\b/.test(text)
      ) return radio;
    }
    return null;
  };

  Modules.raremap.getUseButton = function (dialog) {
    return Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent.trim() === '사용하기');
  };

  Modules.raremap.getCancelButton = function (dialog) {
    return Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent.trim() === '취소');
  };

  Modules.raremap.closeMapDialog = async function () {
    const dialog = this.getMapDialog();
    if (!dialog) return true;
    const cancelled = await Core.safeClick(() => {
      const fresh = this.getMapDialog();
      return fresh ? this.getCancelButton(fresh) : null;
    }, { beforeMin: 350, beforeMax: 650 });
    if (!cancelled) return false;
    return !!(await Core.waitFor(() => (!this.getMapDialog() ? true : null), 5000, 150));
  };

  Modules.raremap.findRareButtonIn = function (container) {
    const buttons = Array.from(container.querySelectorAll('button.MuiButton-fullWidth'));
    return buttons.find((b) => {
      const t = b.textContent.trim();
      if (!t) return false;
      if (t.includes('광산')) return false;
      if (this.EXCLUDE_TEXTS.some((ex) => t.includes(ex))) return false;
      if (/^\d+\s*층$/.test(t)) return false;
      return true;
    });
  };

  Modules.raremap.getMineContainer = function () {
    const anchor = document.querySelector('[data-tour="battle-start-button"]');
    if (!anchor) return null;
    let el = anchor;
    let base = null;
    for (let i = 0; i < 6; i++) {
      el = el.parentElement;
      if (!el) return base;
      const mineButtons = Array.from(el.querySelectorAll('button.MuiButton-fullWidth')).filter((b) => b.textContent.includes('광산'));
      if (mineButtons.length >= 2) {
        base = el;
        if (this.findRareButtonIn(el)) return el;
      }
    }
    return base;
  };

  Modules.raremap.getRareMapButton = function () {
    const container = this.getMineContainer();
    if (!container) return null;
    return this.findRareButtonIn(container);
  };

  Modules.raremap.useTopMapItem = async function () {
    if (!this.getMapIcon()) {
      Core.log('raremap', '지도 아이콘을 찾지 못했습니다.');
      return { ok: false, reason: '지도 아이콘 없음' };
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!this.running || this.stopRequested) {
        return { ok: false, reason: '사용자 정지' };
      }

      if (!this.getMapDialog()) {
        const opened = await Core.safeClick(
          () => this.getMapIcon(),
          { beforeMin: 600, beforeMax: 1300 }
        );
        if (!opened) {
          Core.log('raremap', `지도 아이콘 클릭 실패 (${attempt}/3)`);
          continue;
        }
      }

      const dialog = await Core.waitFor(() => this.getMapDialog(), 6000, 150);
      if (!dialog) {
        Core.log('raremap', `지도 아이템 창 표시 대기 실패 (${attempt}/3)`);
        continue;
      }

      // 제목과 Dialog 껍데기가 먼저 나타나고 지도 목록은 뒤늦게 렌더링된다.
      // 라디오 input이 실제로 생성될 때까지 기다려야 간헐적으로 첫 항목을
      // 못 찾고 즉시 종료되는 경쟁 조건이 생기지 않는다.
      const radioState = await Core.waitFor(() => {
        const freshDialog = this.getMapDialog();
        if (!freshDialog) return null;
        const total = freshDialog.querySelectorAll('input[type="radio"]').length;
        if (total === 0) return null;
        return {
          total,
          available: this.getTopRadio(freshDialog),
        };
      }, 8000, 150);

      if (!radioState) {
        Core.log('raremap', `지도 목록 렌더링 대기 실패 (${attempt}/3)`);
        await this.closeMapDialog();
        continue;
      }
      if (!radioState.available) {
        Core.log('raremap', '사용 가능한 지도 아이템이 없습니다.');
        return { ok: false, reason: '사용 가능한 지도 없음', exhausted: true };
      }

      const selected = await Core.safeClick(() => {
        const freshDialog = this.getMapDialog();
        return freshDialog ? this.getTopRadio(freshDialog) : null;
      }, { beforeMin: 600, beforeMax: 1300 });
      if (!selected) {
        Core.log('raremap', `지도 항목 선택 실패 (${attempt}/3)`);
        await this.closeMapDialog();
        continue;
      }

      const enabledUseButton = await Core.waitFor(() => {
        const freshDialog = this.getMapDialog();
        if (!freshDialog) return null;
        const checked = freshDialog.querySelector('input[type="radio"]:checked');
        const button = this.getUseButton(freshDialog);
        return checked && button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'
          ? button
          : null;
      }, 5000, 150);
      if (!enabledUseButton) {
        Core.log('raremap', `지도 선택 또는 사용하기 활성화 확인 실패 (${attempt}/3)`);
        await this.closeMapDialog();
        continue;
      }

      const used = await Core.safeClick(() => {
        const freshDialog = this.getMapDialog();
        if (!freshDialog) return null;
        const button = this.getUseButton(freshDialog);
        return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'
          ? button
          : null;
      }, { beforeMin: 600, beforeMax: 1300 });
      if (!used) {
        Core.log('raremap', `사용하기 버튼 클릭 실패 (${attempt}/3)`);
        await this.closeMapDialog();
        continue;
      }

      const closed = await Core.waitFor(
        () => (!this.getMapDialog() ? true : null),
        10000,
        200
      );
      if (closed) return { ok: true };

      Core.log('raremap', `지도 사용 후 창 닫힘 확인 실패 (${attempt}/3)`);
      await this.closeMapDialog();
    }

    return { ok: false, reason: '지도 선택창 처리 3회 실패' };
  };

  Modules.raremap.clearRareMapsIfAny = async function () {
    let count = 0;
    let unchangedCount = 0;
    // ⚠ 사용자 확인(2026-08): 레어맵은 같은 종류가 25회 이상 연속으로 나오는
    // 경우도 있다. 버튼 텍스트가 이전과 같은 것만으로는 "클릭이 안 먹혔다"와
    // "같은 종류 레어맵이 또 나왔다"를 구분할 수 없다(실전 확인: 일반 광산
    // 버튼도 클릭 후 완전히 동일한 DOM 요소가 재사용되며 텍스트도 그대로임).
    // 그래서 안전 중단 임계값을 정상적인 연속 출현 범위보다 훨씬 크게 잡아,
    // 진짜 멈춤(같은 화면에서 수십 번째도 전혀 진행이 없는 경우)만 잡는다.
    const UNCHANGED_SAFETY_LIMIT = 40;
    while (this.running && count < 150) {
      const rareBtn = this.getRareMapButton();
      if (!rareBtn) break;
      const beforeText = rareBtn.textContent.trim();
      Core.log('raremap', `레어맵 발견: "${beforeText}" → 클릭`);
      const clicked = await Core.safeClick(() => this.getRareMapButton(), { beforeMin: 600, beforeMax: 1300 });
      if (!clicked) break;
      const changed = await Core.waitFor(() => {
        const next = this.getRareMapButton();
        return !next || next.textContent.trim() !== beforeText ? true : null;
      }, 10000, 400);
      if (!changed) {
        unchangedCount++;
        // 텍스트가 같아도 클릭 자체는 매번 성공했으므로, 같은 종류 레어맵이
        // 연속 출현 중인 정상 상황일 가능성이 높다. 진행 카운트는 그대로
        // 늘리고, 안전장치(UNCHANGED_SAFETY_LIMIT)에만 별도로 반영한다.
        Core.log('raremap', `동일 종류 레어맵이 연속 출현 중일 수 있습니다 (연속 ${unchangedCount}/${UNCHANGED_SAFETY_LIMIT}, 정상 범위: 최대 25회 안팎).`);
        if (unchangedCount >= UNCHANGED_SAFETY_LIMIT) {
          throw new Error(`동일 레어맵 버튼이 ${UNCHANGED_SAFETY_LIMIT}회 연속으로 전혀 바뀌지 않아 안전을 위해 중단합니다.`);
        }
        count++;
        continue;
      }
      unchangedCount = 0;
      count++;
    }
    return count;
  };

  Modules.raremap.runCycle = async function () {
    const mod = this;
    mod.cycleCount++;
    Core.log('raremap', `--- 사이클 ${mod.cycleCount} 시작 ---`);
    Core.updateModuleButtons();

    const onBattleScreen = await mod.ensureOnBattleScreen();
    if (!onBattleScreen) {
      mod.stopReason = '사냥터 화면으로 이동하지 못함';
      Core.log('raremap', '사냥터 화면으로 이동하지 못해 정지합니다.');
      mod.running = false;
      return;
    }

    const preCleared = await mod.clearRareMapsIfAny();
    if (preCleared > 0) {
      Core.log('raremap', `사이클 시작 전 남아있던 레어맵 ${preCleared}개 클리어`);
    }

    const useResult = await mod.useTopMapItem();
    if (!useResult.ok) {
      mod.stopReason = useResult.reason || '지도 사용 실패';
      Core.log(
        'raremap',
        useResult.exhausted
          ? '사용 가능한 지도가 없어 정상 종료합니다.'
          : `지도 사용 실패: ${mod.stopReason} → 정지`
      );
      mod.running = false;
      return;
    }
    const cleared = await mod.clearRareMapsIfAny();
    Core.log('raremap', `이번 사이클 레어맵 ${cleared}개 클리어`);
  };

  Modules.raremap.mainLoop = async function () {
    const mod = this;
    mod.cycleCount = 0;
    mod.stopReason = '';
    while (mod.running && mod.cycleCount < mod.config.maxCycles) {
      await mod.runCycle();
      if (!mod.running) break;
      await Core.sleep(1600);
    }
    if (mod.stopRequested) {
      Core.log('raremap', '사용자 요청으로 레어맵 매크로를 종료했습니다.');
    } else if (mod.stopReason === '사용 가능한 지도 없음') {
      Core.log('raremap', '레어맵 매크로 완료: 사용할 수 있는 지도 아이템이 없습니다.');
    } else if (mod.stopReason) {
      Core.log('raremap', `레어맵 매크로 오류 종료: ${mod.stopReason}`);
    } else if (mod.cycleCount >= mod.config.maxCycles) {
      Core.log('raremap', `안전장치 최대 반복 횟수 ${mod.config.maxCycles}회에 도달해 종료했습니다.`);
    } else {
      Core.log('raremap', '레어맵 매크로를 종료했습니다.');
    }
    mod.running = false;
    Core.activeModuleId = Core.activeModuleId === 'raremap' ? null : Core.activeModuleId;
    Core.updateModuleButtons();
  };


  const RAREMAP_PERSIST_KEYS = ['maxCycles'];

  function buildRaremapTab(container) {
    const mod = Modules.raremap;
    const refs = UIRefs.raremap;
    Core.loadModuleConfig('raremap', RAREMAP_PERSIST_KEYS);

    container.appendChild(labelEl('최대 반복 사이클 (안전장치)'));
    const maxCyclesInput = document.createElement('input');
    maxCyclesInput.type = 'number';
    maxCyclesInput.value = mod.config.maxCycles;
    maxCyclesInput.style.cssText = inputStyle();
    maxCyclesInput.addEventListener('change', (e) => {
      mod.config.maxCycles = parseInt(e.target.value, 10) || 200;
      Core.saveModuleConfig('raremap', RAREMAP_PERSIST_KEYS);
    });
    container.appendChild(maxCyclesInput);

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
    startBtn.addEventListener('click', () => Core.startModule('raremap'));
    stopBtn.addEventListener('click', () => Core.requestStopModule('raremap'));
    btnRow.appendChild(startBtn);
    btnRow.appendChild(stopBtn);
    container.appendChild(btnRow);
    container.appendChild(statusEl);

    const hint = document.createElement('div');
    hint.textContent = '※ 전투 화면(lanis.me/battle)에서만 지도 아이콘을 인식합니다.';
    hint.style.cssText = 'color:#888; font-size:10px; margin-top:4px;';
    container.appendChild(hint);

    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.inputs = [maxCyclesInput];
  }
