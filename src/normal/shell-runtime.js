  Core.startModule = function (moduleId, options = {}) {
    const mod = Modules[moduleId];
    if (!mod) return null;
    if (Core.dailyActive && !options.fromDaily) {
      Core.showBanner(moduleId, '일일 연속 실행이 진행 중입니다. 먼저 일일 작업을 정지해주세요.');
      return null;
    }
    const requiredElement =
      moduleId === 'guildboss'
        ? mod.activeBossId && mod.config.bosses[mod.activeBossId] && mod.config.bosses[mod.activeBossId].originalElement
        : mod.config && mod.config.originalElement;
    if (
      (moduleId === 'autohunt' || moduleId === 'dungeon' || moduleId === 'deepdungeon' || moduleId === 'guildboss') &&
      !Core.ELEMENT_OPTIONS.includes(requiredElement)
    ) {
      Core.showBanner(moduleId, '시작 전에 원래 속성을 선택해주세요.');
      Core.log(moduleId, '원래 속성 미선택으로 시작을 차단했습니다.');
      return;
    }
    if (Core.activeModuleId && Core.activeModuleId !== moduleId) {
      Core.showBanner(
        moduleId,
        `"${moduleDisplayLabel(Core.activeModuleId)}" 모듈이 이미 실행 중입니다. 먼저 그 모듈을 정지한 뒤 시작해주세요.`
      );
      return;
    }
    if (mod.loopPromise) {
      Core.showBanner(moduleId, '이전 실행이 아직 정리 중입니다. 잠시 후 다시 시작해주세요.');
      return;
    }
    if (mod.running) return;
    // 재전직은 사용자가 이번 실행을 직접 확인한 경우에만 시작한다.
    // 체크 상태는 저장하지 않으며 시작과 동시에 다시 해제한다.
    if (moduleId === 'rejob') {
      const safetyCheck = UIRefs.rejob && UIRefs.rejob.safetyCheck;
      if (!safetyCheck || !safetyCheck.checked) {
        Core.showBanner('rejob', '재전직 시작 안전 확인을 먼저 체크해주세요.');
        Core.log('rejob', '안전 확인 미체크로 시작을 차단했습니다.');
        return;
      }
      safetyCheck.checked = false;
    }
    Core.hideBanner();
    Core.activeModuleId = moduleId;
    mod.runId = (mod.runId || 0) + 1;
    const runId = mod.runId;
    const keeperOwner = `module:${moduleId}:${runId}`;
    Core.backgroundKeeper.acquire(keeperOwner);
    mod.running = true;
    mod.stopRequested = false;
    Core.moduleResults[moduleId] = { ok: null, message: '실행 중', at: Date.now() };
    if (moduleId === 'rejob') {
      mod.nextRestAt = mod.cycleCount + Core.rand(mod.config.restEvery[0], mod.config.restEvery[1]);
    }
    Core.log(moduleId, `${moduleDisplayLabel(moduleId)} 매크로 시작`);
    Core.updateModuleButtons();
    let loopPromise;
    loopPromise = Promise.resolve()
      .then(async () => {
        Core.runContext = { moduleId, runId };
        await mod.mainLoop(runId);
      })
      .catch((e) => {
        Core.moduleResults[moduleId] = {
          ok: false,
          message: e && e.message ? e.message : String(e),
          at: Date.now(),
        };
        if (!Core.isRunCancelled(moduleId, runId)) {
          Core.log(moduleId, `처리되지 않은 오류: ${e && e.message ? e.message : String(e)}`);
          Core.showBanner(moduleId, `처리되지 않은 오류로 정지했습니다: ${e && e.message ? e.message : String(e)}`, false);
          // ⚠ 버그 수정(2026-08): notifyStopped/notifyCompleted와 동일한
          // 이유로, 일일 매크로 실행 중에는 하위 모듈 개별 오류 소리를
          // 억제한다(최종 소리는 일일 종료 처리에서 한 번만 울림).
          if (!Core.dailyActive) Core.playStopSound();
        }
      })
      .finally(() => {
        Core.backgroundKeeper.release(keeperOwner);
        if (mod.loopPromise === loopPromise) mod.loopPromise = null;
        if (Core.runContext && Core.runContext.moduleId === moduleId && Core.runContext.runId === runId) {
          Core.runContext = null;
        }
        if (mod.runId === runId) {
          mod.running = false;
          mod.stopRequested = true;
          if (Core.activeModuleId === moduleId) Core.activeModuleId = null;
        }
        Core.updateModuleButtons();
      });
    mod.loopPromise = loopPromise;
    return loopPromise;
  };

  Core.requestStopModule = function (moduleId, options = {}) {
    // 일일 연속 실행이 소유한 하위 모듈의 정지는 곧 일일 전체 정지다.
    // 하위 모듈만 끄면 daily.mainLoop의 catch가 이를 "이슈"로 처리한 뒤
    // 다음 작업(특히 보스)을 다시 시작할 수 있다.
    if (Core.dailyActive && !options.fromDailyStop) {
      Core.stopDaily();
      return;
    }
    const mod = Modules[moduleId];
    if (!mod || !mod.running) return;
    mod.runId = (mod.runId || 0) + 1;
    mod.stopRequested = true;
    mod.running = false;
    if (Core.activeModuleId === moduleId) Core.activeModuleId = null;
    Core.log(moduleId, '사용자 요청으로 정지합니다...');
    if (moduleId === 'arena') Modules.arena.clearResume();
    Core.updateModuleButtons();
  };

  // 보스 엔진은 별도 네임스페이스에서 동작하지만 실행 잠금만 통합 코어와
  // 공유한다. 따라서 보스 로직이 던전/심층던전 내부 상태나 함수를 참조하지
  // 않으면서도 두 자동화가 동시에 클릭하는 사고는 방지한다.
  window.__lanisBossCoordinator = {
    acquire() {
      if (Core.activeModuleId && Core.activeModuleId !== 'boss') {
        Core.showBanner(
          'boss',
          `"${moduleDisplayLabel(Core.activeModuleId)}" 모듈이 이미 실행 중입니다. 먼저 그 모듈을 정지한 뒤 시작해주세요.`
        );
        return false;
      }
      Core.hideBanner();
      Core.activeModuleId = 'boss';
      Core.log('boss', '보스 매크로 시작');
      Core.updateModuleButtons();
      return true;
    },
    release() {
      if (Core.activeModuleId === 'boss') Core.activeModuleId = null;
      Core.log('boss', '보스 매크로 종료');
      Core.updateModuleButtons();
    },
    isOtherModuleRunning() {
      return !!Core.activeModuleId && Core.activeModuleId !== 'boss';
    },
    isDailyActive() {
      return !!Core.dailyActive;
    },
    hasDailyRun() {
      return !!Core.dailyActive || !!Modules.daily.loadState();
    },
    requestDailyStop() {
      Core.stopDaily();
    },
    refresh() {
      Core.updateModuleButtons();
    },
  };

  // ==========================================================================
  // 패널 UI (탭 구조, 하나의 패널을 다섯 모듈이 공유)
  // ==========================================================================
  const UIRefs = {
    daily: {},
    rejob: {},
    autohunt: {},
    raremap: {},
    dungeon: {},
    arena: {},
    preseason: {},
    deepdungeon: {},
    guildboss: {},
  };
  let activeTab = 'rejob';

  Core.updateModuleButtons = function () {
    ['rejob', 'autohunt', 'raremap', 'dungeon', 'arena', 'preseason', 'deepdungeon'].forEach((id) => {
      const mod = Modules[id];
      const refs = UIRefs[id];
      if (!refs.startBtn) return;
      const otherRunning =
        (Core.activeModuleId && Core.activeModuleId !== id) ||
        (Core.dailyActive && !mod.running);
      const safetyLocked = id === 'rejob' && refs.safetyCheck && !refs.safetyCheck.checked;
      refs.startBtn.disabled = mod.running || otherRunning || safetyLocked;
      refs.stopBtn.disabled = !mod.running;
      const cycleLabel =
        id === 'dungeon'
          ? `오늘 클리어 ${mod.cycleCount}개`
          : id === 'arena'
          ? `오늘 전투 ${mod.cycleCount}회 (무료인 동안 반복)`
          : id === 'preseason'
          ? `오늘 전투 ${mod.cycleCount}회 (보석 한도까지 반복)`
          : id === 'deepdungeon'
          ? `던전의 주인 도전 ${mod.cycleCount}회`
          : `사이클 ${mod.cycleCount}`;
      refs.statusEl.textContent = mod.running ? `실행중 (${cycleLabel})` : otherRunning ? '다른 모듈 실행중' : '대기중';
      if (refs.inputs) refs.inputs.forEach((inp) => (inp.disabled = mod.running));
    });

    // ⚠ 길드보스는 보스별 하위 탭마다 별도 시작/정지 버튼을 가진다
    // (UIRefs.guildboss[bossId] 형태로 중첩됨). 실행 중인 보스의 버튼만
    // 정지 가능하게 하고, 나머지 하위 탭은 시작이 막힌다(동시에 한 보스만
    // 실행 가능).
    const guildbossMod = Modules.guildboss;
    if (guildbossMod) {
      Object.keys(UIRefs.guildboss).forEach((bossId) => {
        const refs = UIRefs.guildboss[bossId];
        if (!refs.startBtn) return;
        const isThisBossActive = guildbossMod.running && guildbossMod.activeBossId === bossId;
        const otherRunning =
          (Core.activeModuleId && Core.activeModuleId !== 'guildboss') ||
          (Core.activeModuleId === 'guildboss' && guildbossMod.activeBossId !== bossId) ||
          (Core.dailyActive && !isThisBossActive);
        refs.startBtn.disabled = guildbossMod.running || otherRunning;
        refs.stopBtn.disabled = !isThisBossActive;
        refs.statusEl.textContent = isThisBossActive ? '실행중' : otherRunning ? '다른 모듈 실행중' : '대기중';
        if (refs.inputs) refs.inputs.forEach((inp) => (inp.disabled = guildbossMod.running));
      });
    }

    const bossPanel = document.getElementById('lrm-boss-ref-panel');
    if (bossPanel) {
      const bossEngine = window.__bossMacro;
      // 페이지 이동/재개 타이밍에는 코디네이터의 activeModuleId가 잠깐
      // 풀릴 수 있다. 실제 엔진·저장 큐도 함께 봐야 정지 버튼이 실행
      // 도중 잘못 비활성화되지 않는다.
      const bossRunning =
        Core.activeModuleId === 'boss' ||
        !!(bossEngine && bossEngine.isRunning) ||
        !!localStorage.getItem('lrm-boss-ref-queue') ||
        !!localStorage.getItem('lrm-boss-ref-pending');
      const anyModuleRunning = !!Core.activeModuleId || Core.dailyActive;
      const startBtn = bossPanel.querySelector('#lrm-boss-ref-run-queue');
      const stopBtn = bossPanel.querySelector('#lrm-boss-ref-stop');
      if (startBtn) startBtn.disabled = anyModuleRunning;
      if (stopBtn) stopBtn.disabled = !bossRunning;
      bossPanel.querySelectorAll('#lrm-boss-ref-job, .lrm-boss-check').forEach((input) => {
        input.disabled = bossRunning;
      });
    }

    const dailyRefs = UIRefs.daily;
    if (dailyRefs.startBtn) {
      dailyRefs.startBtn.disabled = Core.dailyActive || !!Core.activeModuleId;
      dailyRefs.stopBtn.disabled = !Core.dailyActive;
      if (dailyRefs.inputs) dailyRefs.inputs.forEach((input) => {
        input.disabled = Core.dailyActive;
      });
      dailyRefs.statusEl.textContent = Core.dailyActive ? '연속 실행중' : '대기중';
    }
  };


  function labelEl(text) {
    const l = document.createElement('div');
    l.textContent = text;
    l.style.cssText = 'color:#ccc; font-size:11px; margin-top:4px;';
    return l;
  }

  function inputStyle() {
    return 'width:100%; box-sizing:border-box; padding:4px; border-radius:4px; border:1px solid #555; background:#2a2a2e; color:#eee; margin-bottom:2px;';
  }

  function btnStyle(color) {
    return `flex:1; padding:6px; border:none; border-radius:4px; color:#fff; background:${color}; cursor:pointer; font-weight:bold;`;
  }

  function buildBossTab(container) {
    container.id = 'lrm-boss-tool-host';
    if (typeof window.__mountLanisBossTool === 'function') {
      window.__mountLanisBossTool(container);
    }
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'lrm-panel';
    panel.style.cssText = `
      position: fixed; top: 60px; right: 10px; width: 320px;
      background: #1a1a1a; color: #eee; border: 1px solid #555; border-radius: 8px;
      font-size: 12px; z-index: 999999; font-family: sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    `;
    Core.panelEl = panel;

    const header = document.createElement('div');
    header.id = 'lrm-drag-handle';
    header.style.cssText = 'cursor:move; font-weight:bold; padding:6px 8px 6px 10px; background:#262626; border-radius:8px 8px 0 0; user-select:none; display:flex; align-items:center; justify-content:space-between;';
    const title = document.createElement('span');
    title.textContent = '🎯 라니스 통합 매크로';
    const dailyHeaderBtn = document.createElement('button');
    dailyHeaderBtn.textContent = '일일';
    dailyHeaderBtn.style.cssText = 'padding:4px 12px; border:1px solid #f5a623; border-radius:12px; background:#1a1a1a; color:#f5a623; cursor:pointer; font-size:11px; font-weight:bold;';
    dailyHeaderBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    dailyHeaderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      switchTab('daily');
    });
    header.append(title, dailyHeaderBtn);
    panel.appendChild(header);

    // ⚠ 사용자 요청(2026-08): 탭을 종류별로 정확히 4줄로 고정해서 배치한다
    // (화면 너비에 따라 자동 줄바꿈되는 flex-wrap 한 덩어리가 아니라, 그룹별
    // 로 명시적인 행을 나눔) - 성장/파밍(재전직·레어맵), 전투 콘텐츠(던전·
    // 자동사냥·보스·심층던전·아레나), 길드(길드보스), 이벤트(이벤트) 순.
    const TAB_ROWS = [
      ['rejob', 'raremap'],
      ['dungeon', 'autohunt', 'boss', 'deepdungeon', 'arena'],
      ['guildboss'],
      ['preseason'],
    ];
    const tabButtons = {};
    TAB_ROWS.forEach((rowIds) => {
      const rowEl = document.createElement('div');
      rowEl.style.cssText = 'display:flex; border-bottom:1px solid #444;';
      rowIds.forEach((id) => {
        const tabBtn = document.createElement('button');
        tabBtn.textContent = MODULE_LABELS[id];
        tabBtn.style.cssText = 'flex:1; min-width:60px; padding:6px 0; background:#1a1a1a; color:#eee; border:none; cursor:pointer; font-size:12px;';
        tabBtn.addEventListener('click', () => switchTab(id));
        rowEl.appendChild(tabBtn);
        tabButtons[id] = tabBtn;
      });
      panel.appendChild(rowEl);
    });

    const tabContents = {};
    const contentWrap = document.createElement('div');
    contentWrap.style.cssText = 'padding:10px; max-height:60vh; overflow-y:auto;';
    Object.keys(MODULE_LABELS).forEach((id) => {
      const c = document.createElement('div');
      c.style.display = 'none';
      tabContents[id] = c;
      contentWrap.appendChild(c);
    });
    buildRejobTab(tabContents.rejob);
    buildAutohuntTab(tabContents.autohunt);
    buildRaremapTab(tabContents.raremap);
    buildDungeonTab(tabContents.dungeon);
    buildArenaTab(tabContents.arena);
    buildPreseasonTab(tabContents.preseason);
    buildDeepDungeonTab(tabContents.deepdungeon);
    buildGuildBossTab(tabContents.guildboss);
    buildBossTab(tabContents.boss);
    buildDailyTab(tabContents.daily);
    panel.appendChild(contentWrap);

    function switchTab(id) {
      activeTab = id;
      Object.keys(tabContents).forEach((k) => {
        tabContents[k].style.display = k === id ? 'block' : 'none';
        if (tabButtons[k]) {
          tabButtons[k].style.background = k === id ? '#333' : '#1a1a1a';
          tabButtons[k].style.borderBottom = k === id ? '2px solid #f5a623' : 'none';
        }
      });
      dailyHeaderBtn.style.background = id === 'daily' ? '#f5a623' : '#1a1a1a';
      dailyHeaderBtn.style.color = id === 'daily' ? '#111' : '#f5a623';
    }
    switchTab(activeTab);

    const logLabel = document.createElement('div');
    logLabel.textContent = '로그';
    logLabel.style.cssText = 'color:#ccc; font-size:11px; padding:0 10px;';
    panel.appendChild(logLabel);
    const logBox = document.createElement('div');
    logBox.id = 'lrm-log';
    logBox.style.cssText =
      'height:150px; overflow-y:auto; background:#000; padding:4px; white-space:pre-wrap; font-size:11px; border-radius:4px; margin:4px 10px 10px 10px;';
    panel.appendChild(logBox);
    Core.logEl = logBox;

    document.body.appendChild(panel);

    const banner = document.createElement('div');
    banner.id = 'lrm-banner';
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 1000000;
      background: #b71c1c; color: #fff; padding: 10px 14px; font-size: 13px;
      font-family: sans-serif; display: none; justify-content: space-between; align-items: center;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    `;
    banner.innerHTML = `<span></span><button id="lrm-banner-close" style="background:#fff;color:#b71c1c;border:none;padding:3px 10px;border-radius:4px;cursor:pointer;margin-left:12px;">확인</button>`;
    document.body.appendChild(banner);
    banner.querySelector('#lrm-banner-close').addEventListener('click', () => Core.hideBanner());
    Core.bannerEl = banner;

    const savedPos = Core.loadPanelPosition();
    if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
      panel.style.left = `${savedPos.left}px`;
      panel.style.top = `${savedPos.top}px`;
      panel.style.right = 'auto';
    }

    let dragging = false,
      offsetX = 0,
      offsetY = 0;
    header.addEventListener('mousedown', (e) => {
      dragging = true;
      offsetX = e.clientX - panel.getBoundingClientRect().left;
      offsetY = e.clientY - panel.getBoundingClientRect().top;
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = `${e.clientX - offsetX}px`;
      panel.style.top = `${e.clientY - offsetY}px`;
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) {
        const rect = panel.getBoundingClientRect();
        Core.savePanelPosition(rect.left, rect.top);
      }
      dragging = false;
    });
  }

  // ==========================================================================
  // 초기화
  // ==========================================================================
  function init() {
    if (document.getElementById('lrm-panel')) return;
    buildPanel();
    Core.log('core', '통합 매크로 패널 로드 완료 (재전직 / 자동사냥 / 레어맵 / 던전 / 아레나 / 심층던전 / 보스 / 일일)');
    if (Core.wasDiscarded) {
      const state = Modules.daily.loadState();
      let auth = null;
      try {
        auth = JSON.parse(sessionStorage.getItem(DAILY_AUTH_KEY) || 'null');
      } catch (e) {
        auth = null;
      }
      const canResumeDaily = !!(
        state &&
        auth &&
        auth.schema === DAILY_AUTH_SCHEMA &&
        auth.startedAt === state.startedAt
      );
      if (canResumeDaily) {
        Modules.daily.stopRequested = false;
        Core.dailyActive = true;
        Modules.daily.running = true;
        Core.backgroundKeeper.acquire('daily');
        Core.log(
          'core',
          `Chrome 폐기 탭 복원 감지: 일일 ${state.index + 1}/${state.steps.length} 단계부터 안전 재개`
        );
        Core.sleep(1800)
          .then(() => Modules.daily.mainLoop())
          .catch((e) => {
            Core.dailyActive = false;
            Modules.daily.running = false;
            Core.showBanner('daily', `폐기 탭 복구 중 오류: ${e.message}`, false);
          })
          .finally(() => Core.backgroundKeeper.release('daily'));
      } else {
        if (state) {
          state.running = false;
          Modules.daily.saveState(state);
        }
        sessionStorage.removeItem(DAILY_AUTH_KEY);
        Core.log('core', 'Chrome 폐기 탭 복원 감지: 유효한 일일 실행 허가가 없어 일일 작업은 중단');
      }
      // 보스 큐는 아래 보스 엔진이 같은 조건(document.wasDiscarded + 현재
      // sessionStorage 허가)을 다시 검증한 뒤에만 재개한다.
      return;
    }
    // 저장값만으로 자동화를 재개하지 않는다. 통합 일일 작업은 SPA 안에서
    // 연속 실행되며, 실제 새로고침/탭 재실행이 발생했다면 안전하게 중단한다.
    // 오래된 running 상태를 복구하면 동일 단계(특히 보스)를 처음부터 다시
    // 실행해 무한 재도전할 수 있으므로 모두 폐기한다.
    Modules.arena.clearResume();
    sessionStorage.removeItem(DAILY_AUTH_KEY);
    const staleDaily = Modules.daily.loadState();
    if (staleDaily) {
      staleDaily.running = false;
      Modules.daily.saveState(staleDaily);
    }
    localStorage.removeItem('lrm-boss-ref-pending');
    localStorage.removeItem('lrm-boss-ref-queue');
    localStorage.setItem('lrm-boss-ref-user-stopped', String(Date.now()));
    Core.log('core', '새로고침 후 자동 재개 차단: 저장된 아레나/일일/보스 실행 상태 폐기');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
