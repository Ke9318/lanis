  // -------------------------- 모듈: 길드 보스 --------------------------
  // ⚠ 사용자 요청(2026-08): 길드 보스(심연의 히드라)는 화/목 등 길드마스터가
  // 소환한 특정 시간에만 도전 가능하다. 개인 보스와 달리 요일/시간 자동
  // 판정은 하지 않고(소환 여부 자체를 매크로가 알 수 없음), 사용자가 소환된
  // 시점에 직접 시작 버튼을 눌러야 한다.
  //
  // 실전 확인된 구조:
  //   - 보스 HP 전체를 5개의 속성별 "머리"로 나눠 관리 (화염/빙결/전격/대지/바람)
  //   - 참여자 개인당 "공격 횟수" 제한(실전 확인: 8회)
  //   - 목록 화면에서 머리 선택 → "공격하기" → 전투 서브화면(/guild/boss/battle)
  //     진입 → 그 화면의 "공격" 버튼을 누르면 즉시 결과가 나오고 30초 쿨타임
  //   - 쿨타임 텍스트가 "0초"로 표시된 직후에도 버튼이 몇 초간 더 disabled로
  //     남아있음이 실전 확인됨 → 텍스트가 아니라 버튼의 실제 disabled 여부로
  //     판정해야 함
  //
  // 로직: 속성 확인(다르면 속성돌 사용) → 공용 프리셋 "히드라" 적용 → 길드
  // 보스 화면 진입 → 사용자가 지정한 "속성"을 가진 머리를 화면에서 찾아
  // 선택 → 공격하기 → 쿨타임마다 공격을 8회까지 반복 → 중간에 대상 머리가
  // 죽으면 정지 후 알림.
  //
  // ⚠ 사용자 확인(2026-08): 머리 이름(화염/빙결/전격/대지/바람)은 고정이지만,
  // 각 머리에 배정된 속성은 소환마다 랜덤이고 전투 중에도 바뀐다 - 머리
  // 3개가 죽으면 남은 것 중 하나가 어둠으로, 어둠 머리도 죽으면 남은 것이
  // 빛으로 바뀐다. 그래서 "이름"이 아니라 "속성"으로 지정하고, 코드가 매번
  // 목록 화면에서 그 속성을 가진 머리가 지금 어떤 이름인지 다시 찾아야 한다.
  Modules.guildboss = {
    id: 'guildboss',
    running: false,
    stopRequested: false,
    config: {
      originalElement: '',
      targetElement: '',
    },
  };

  Modules.guildboss.HEAD_NAMES = ['화염의 머리', '빙결의 머리', '전격의 머리', '대지의 머리', '바람의 머리'];
  Modules.guildboss.MAX_ATTACKS = 8;

  // 목록 화면에서 지정한 속성을 가진 머리의 "이름"을 찾는다. 처치된 머리는
  // 건너뛴다(실전 확인: 처치된 머리 근처엔 "처치됨" 텍스트가 붙음).
  Modules.guildboss.findHeadNameByElement = function (targetElement) {
    const all = Core.gameElements('*');
    for (const headName of Modules.guildboss.HEAD_NAMES) {
      const heading = all.find(
        (el) => el.children.length === 0 && el.textContent.trim() === headName && Core.isElementVisible(el)
      );
      if (!heading) continue;
      const idx = all.indexOf(heading);
      let elementText = null;
      let isDefeated = false;
      for (let i = idx + 1; i < Math.min(idx + 8, all.length); i++) {
        const t = all[i].textContent.trim();
        if (t === '처치됨') isDefeated = true;
        if (!elementText && Core.ELEMENT_OPTIONS.includes(t)) elementText = t;
        if (t === 'HP') break;
      }
      if (isDefeated) continue;
      if (elementText === targetElement) return headName;
    }
    return null;
  };

  // 공용 프리셋 "히드라" 적용 (캐릭 > 프리셋 화면, 보스 전용 프리셋이 아니라 공용 프리셋임)
  Modules.guildboss.applyHydraPreset = async function () {
    await Core.clickNavMenuExact('캐릭', '프리셋');
    const onPresetPage = await Core.waitFor(() => location.pathname.replace(/\/$/, '') === '/user-presets', 15000, 300);
    if (!onPresetPage) throw new Error('프리셋 화면 진입을 확인하지 못했습니다.');
    await Core.humanDelay(500, 900);

    const findApplyBtn = () => {
      const all = Core.gameElements('*');
      const heading = all.find((el) => el.children.length === 0 && el.textContent.trim() === '히드라');
      if (!heading) return null;
      const idx = all.indexOf(heading);
      for (let i = idx + 1; i < Math.min(idx + 15, all.length); i++) {
        const el = all[i];
        if (el.tagName === 'BUTTON' && el.textContent.trim() === '적용' && Core.isElementVisible(el)) return el;
      }
      return null;
    };
    const applyBtn = await Core.waitFor(findApplyBtn, 8000, 250);
    if (!applyBtn) throw new Error('"히드라" 프리셋을 찾지 못했습니다 (프리셋 이름/존재 여부 확인 필요).');
    if (!(await Core.safeClick(findApplyBtn, { beforeMin: 500, beforeMax: 900, afterMin: 1000, afterMax: 1500 }))) {
      throw new Error('"히드라" 프리셋 적용 클릭에 실패했습니다.');
    }
    Core.log('guildboss', '"히드라" 프리셋 적용 완료');
  };

  // 우측 상단 계정 아이콘(텍스트/aria-label 없는, 상단 네비게이션 바에서
  // 가장 오른쪽에 위치한 아이콘 버튼) → 드롭다운 "길드" → "보스" 탭.
  // 실전 확인: 이 아이콘은 aria-label이 없어 텍스트로 찾을 수 없고, 화면
  // 최상단(top<40px)에 있는 버튼 중 가장 오른쪽(right 값 최대)인 것으로 특정함.
  Modules.guildboss.goToGuildBossScreen = async function () {
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
    if (!accountBtn) throw new Error('계정 아이콘 버튼을 찾지 못했습니다.');
    if (!(await Core.safeClick(findAccountIconBtn, { beforeMin: 400, beforeMax: 700, afterMin: 600, afterMax: 1000 }))) {
      throw new Error('계정 아이콘 클릭에 실패했습니다.');
    }

    const guildItem = await Core.waitFor(
      () => Core.gameElements('[role="menuitem"]').find((el) => el.textContent.trim() === '길드' && Core.isElementVisible(el)),
      8000,
      200
    );
    if (!guildItem) throw new Error('"길드" 메뉴 항목을 찾지 못했습니다.');
    guildItem.click();
    const onGuildPage = await Core.waitFor(() => location.pathname.replace(/\/$/, '') === '/guild', 10000, 250);
    if (!onGuildPage) throw new Error('길드 화면 진입을 확인하지 못했습니다.');
    await Core.humanDelay(500, 900);

    const bossTab = await Core.retryStep('"보스" 탭 찾기', () => Core.findButtonByText('보스'));
    if (!bossTab) throw new Error('"보스" 탭을 찾지 못했습니다.');
    if (!(await Core.safeClick(() => Core.findButtonByText('보스'), { beforeMin: 400, beforeMax: 700, afterMin: 700, afterMax: 1100 }))) {
      throw new Error('"보스" 탭 클릭에 실패했습니다.');
    }
    const onBossListPage = await Core.waitFor(() => location.pathname.replace(/\/$/, '') === '/guild/boss', 10000, 250);
    if (!onBossListPage) {
      throw new Error('길드 보스 화면 진입을 확인하지 못했습니다 (오늘은 소환되지 않았을 수 있습니다).');
    }
    return true;
  };

  // 목록에서 지정한 머리 선택 → "공격하기" → 전투 서브화면 진입
  Modules.guildboss.enterHeadBattle = async function (targetElement) {
    const resolveHeadName = () => Modules.guildboss.findHeadNameByElement(targetElement);
    const headLabel = await Core.waitFor(resolveHeadName, 10000, 250);
    if (!headLabel) {
      throw new Error(`"${targetElement}" 속성을 가진 머리를 찾지 못했습니다 (이미 처치됐거나 이번 소환에 없을 수 있습니다).`);
    }
    Core.log('guildboss', `"${targetElement}" 속성 머리 확인: "${headLabel}"`);

    const findHeadHeading = () =>
      Core.gameElements('*').find((el) => el.children.length === 0 && el.textContent.trim() === headLabel && Core.isElementVisible(el));
    if (!(await Core.safeClick(findHeadHeading, { beforeMin: 400, beforeMax: 700, afterMin: 500, afterMax: 900 }))) {
      throw new Error(`"${headLabel}" 선택에 실패했습니다.`);
    }

    const attackListBtn = await Core.retryStep('"공격하기" 버튼 찾기', () => Core.findButtonByText('공격하기'));
    if (!attackListBtn) throw new Error('"공격하기" 버튼을 찾지 못했습니다.');
    if (!(await Core.safeClick(() => Core.findButtonByText('공격하기'), { beforeMin: 500, beforeMax: 900, afterMin: 800, afterMax: 1300 }))) {
      throw new Error('"공격하기" 클릭에 실패했습니다.');
    }
    const onBattlePage = await Core.waitFor(() => location.pathname.replace(/\/$/, '') === '/guild/boss/battle', 10000, 250);
    if (!onBattlePage) throw new Error('길드 보스 전투 화면 진입을 확인하지 못했습니다.');
    return headLabel;
  };

  // ⚠ 실전 확인: 쿨타임이 "0초"로 표시된 직후에도 버튼이 몇 초 더 disabled
  // 상태로 남아있어, 텍스트만으로 판정하면 클릭이 씹힐 수 있다. 반드시
  // disabled 속성과 텍스트가 정확히 "공격"인지를 함께 확인해야 한다.
  Modules.guildboss.getReadyAttackButton = function () {
    const btn = Core.gameElements('button').find(
      (b) => Core.isElementVisible(b) && /^(공격|쿨타임)/.test(b.textContent.trim())
    );
    if (!btn) return null;
    return !btn.disabled && btn.textContent.trim() === '공격' ? btn : null;
  };

  Modules.guildboss.getAttackCount = function () {
    const m = Core.bodyText().match(/공격\s*횟수\s*(\d+)\s*\/\s*(\d+)/);
    return m ? { current: parseInt(m[1], 10), max: parseInt(m[2], 10) } : null;
  };

  Modules.guildboss.getTargetHeadHp = function () {
    const text = Core.bodyText();
    const idx = text.indexOf('공격 대상');
    if (idx === -1) return null;
    const snippet = text.slice(idx, idx + 200);
    const m = snippet.match(/HP:\s*([\d,]+)\s*\/\s*([\d,]+)/);
    if (!m) return null;
    return { cur: parseInt(m[1].replace(/,/g, ''), 10), max: parseInt(m[2].replace(/,/g, ''), 10) };
  };

  // ⚠ 실전 확인: 목록 화면에서 이미 처치된 머리는 "처치됨" 텍스트가 붙는다.
  // HP 텍스트가 정확히 "0/N"으로 안 바뀌는 경우까지 대비해 두 신호를 함께 본다.
  Modules.guildboss.isTargetHeadDefeated = function () {
    const headHp = Modules.guildboss.getTargetHeadHp();
    if (headHp && headHp.cur <= 0) return true;
    const text = Core.bodyText();
    const idx = text.indexOf('공격 대상');
    if (idx !== -1 && text.slice(idx, idx + 60).includes('처치됨')) return true;
    return false;
  };

  Modules.guildboss.runAttackLoop = async function () {
    const mod = this;
    for (let i = 0; i < mod.MAX_ATTACKS; i++) {
      if (!mod.running || mod.stopRequested) return { stopped: true };

      // ⚠ 사용자 요청(2026-08): 쿨타임 대기 중 다른 길드원이 먼저 대상
      // 머리를 처치할 수 있다. 이 경우 공격을 계속 시도하지 말고, 공격
      // 시도 직전에 매번 대상 상태를 확인해서 이미 죽어 있으면 즉시
      // 정지+알람으로 끝낸다(공격 버튼을 아예 누르지 않음).
      if (mod.isTargetHeadDefeated()) {
        return { stopped: true, headDefeated: true, defeatedByOthers: true };
      }

      const ready = await Core.waitFor(() => mod.getReadyAttackButton(), 40000, 500);
      if (!ready) throw new Error('공격 버튼이 활성화되지 않았습니다 (쿨타임 대기 실패).');
      if (!mod.running || mod.stopRequested) return { stopped: true };

      // 쿨타임 대기 도중에도 처치될 수 있으므로 클릭 직전 한 번 더 확인한다.
      if (mod.isTargetHeadDefeated()) {
        return { stopped: true, headDefeated: true, defeatedByOthers: true };
      }

      if (!(await Core.safeClick(() => mod.getReadyAttackButton(), { beforeMin: 400, beforeMax: 800, afterMin: 1200, afterMax: 1800 }))) {
        throw new Error('공격 버튼 클릭에 실패했습니다.');
      }

      const countInfo = await Core.waitFor(() => mod.getAttackCount(), 8000, 250);
      Core.log(
        'guildboss',
        `공격 ${i + 1}회 완료 (공격 횟수: ${countInfo ? `${countInfo.current}/${countInfo.max}` : '확인 불가'})`
      );

      if (mod.isTargetHeadDefeated()) {
        return { stopped: true, headDefeated: true };
      }

      // 실전 확인된 완료 문구: 버튼이 "최대 공격 횟수 도달 (8회)"로 바뀜
      if (Core.bodyText().includes('최대 공격 횟수 도달')) {
        Core.log('guildboss', '최대 공격 횟수에 도달했습니다.');
        break;
      }

      if (countInfo && countInfo.current >= countInfo.max) {
        Core.log('guildboss', '오늘 사용 가능한 공격 횟수를 모두 소진했습니다.');
        break;
      }
    }
    return { stopped: false };
  };

  Modules.guildboss.mainLoop = async function () {
    const mod = this;
    Core.log('guildboss', '길드 보스 매크로 시작');
    try {
      if (!mod.config.targetElement) throw new Error('공격할 속성을 먼저 선택해주세요.');

      Core.log('guildboss', `시작 전 원래 속성(${mod.config.originalElement}) 확인`);
      await Core.ensureCharacterElement(mod.config.originalElement, 'guildboss');
      if (!mod.running || mod.stopRequested) return;

      await mod.applyHydraPreset();
      if (!mod.running || mod.stopRequested) return;

      await mod.goToGuildBossScreen();
      if (!mod.running || mod.stopRequested) return;

      const headLabel = await mod.enterHeadBattle(mod.config.targetElement);
      if (!mod.running || mod.stopRequested) return;

      const loopResult = await mod.runAttackLoop();
      if (loopResult.headDefeated) {
        const msg = loopResult.defeatedByOthers
          ? `"${headLabel}"(${mod.config.targetElement} 속성)이(가) 다른 길드원에 의해 먼저 처치되어 더 공격할 수 없습니다 - 정지합니다.`
          : `"${headLabel}"(${mod.config.targetElement} 속성) 처치 완료 - 정지합니다.`;
        Core.notifyStopped('guildboss', msg);
        return;
      }
      if (!loopResult.stopped) {
        Core.notifyCompleted('guildboss', '길드 보스 공격을 완료했습니다.');
        return;
      }
    } catch (e) {
      Core.notifyStopped('guildboss', e.message);
      return;
    }
    mod.running = false;
    Core.activeModuleId = Core.activeModuleId === 'guildboss' ? null : Core.activeModuleId;
    Core.updateModuleButtons();
  };

  const GUILDBOSS_PERSIST_KEYS = ['originalElement', 'targetElement'];

  function buildGuildBossTab(container) {
    const mod = Modules.guildboss;
    const refs = UIRefs.guildboss;
    Core.loadModuleConfig('guildboss', GUILDBOSS_PERSIST_KEYS);

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
      Core.saveModuleConfig('guildboss', GUILDBOSS_PERSIST_KEYS);
    });
    container.appendChild(elementSelect);

    // ⚠ 사용자 확인(2026-08): 머리 이름은 고정이지만 배정된 속성은 소환마다,
    // 전투 중에도(3개 죽으면 어둠, 어둠도 죽으면 빛으로) 바뀐다. 그래서
    // "머리 이름"이 아니라 "속성"으로 지정한다.
    container.appendChild(labelEl('공격할 속성 (해당 속성 머리를 매번 자동으로 찾음)'));
    const elementTargetSelect = document.createElement('select');
    elementTargetSelect.style.cssText = inputStyle();
    const elementTargetPlaceholder = document.createElement('option');
    elementTargetPlaceholder.value = '';
    elementTargetPlaceholder.textContent = '속성 선택 필요';
    elementTargetPlaceholder.selected = !Core.ELEMENT_OPTIONS.includes(mod.config.targetElement);
    elementTargetSelect.appendChild(elementTargetPlaceholder);
    Core.ELEMENT_OPTIONS.forEach((element) => {
      const option = document.createElement('option');
      option.value = element;
      option.textContent = element;
      option.selected = element === mod.config.targetElement;
      elementTargetSelect.appendChild(option);
    });
    elementTargetSelect.addEventListener('change', (e) => {
      mod.config.targetElement = e.target.value;
      Core.saveModuleConfig('guildboss', GUILDBOSS_PERSIST_KEYS);
    });
    container.appendChild(elementTargetSelect);

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
    startBtn.addEventListener('click', () => Core.startModule('guildboss'));
    stopBtn.addEventListener('click', () => Core.requestStopModule('guildboss'));
    btnRow.appendChild(startBtn);
    btnRow.appendChild(stopBtn);
    container.appendChild(btnRow);
    container.appendChild(statusEl);

    const hint = document.createElement('div');
    hint.textContent = '※ 길드마스터가 보스를 소환한 시간에만 사용 가능합니다. 개인 공격 횟수 최대 8회.';
    hint.style.cssText = 'color:#888; font-size:10px; margin-top:4px;';
    container.appendChild(hint);

    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.inputs = [elementSelect, elementTargetSelect];
  }
