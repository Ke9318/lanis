  // -------------------------- 모듈: 길드 보스 --------------------------
  // ⚠ 사용자 요청(2026-08): 길드 보스는 화/목 등 길드마스터가 소환한 특정
  // 시간에만 도전 가능하다. 개인 보스와 달리 요일/시간 자동 판정은 하지
  // 않고(소환 여부 자체를 매크로가 알 수 없음), 사용자가 소환된 시점에
  // 직접 시작 버튼을 눌러야 한다.
  //
  // ⚠ 사용자 요청(2026-08): 길드 보스는 보스 종류별로 하위 탭을 따로 두고,
  // 이 파일 하나에서 새 보스가 추가될 때마다 BOSS_REGISTRY에만 등록하면
  // UI/실행까지 자동으로 늘어나는 구조로 만든다. 첫 번째 등록 보스: 히드라
  // (심연의 히드라).
  Modules.guildboss = {
    id: 'guildboss',
    running: false,
    stopRequested: false,
    activeBossId: null,
    config: {
      bosses: {},
    },
  };

  // ⚠ 사용자 확인(2026-08, 히드라 기준): 머리 이름(화염/빙결/전격/대지/바람)은
  // 고정이지만, 각 머리에 배정된 속성은 소환마다 랜덤이고 전투 중에도
  // 바뀐다 - 머리 3개가 죽으면 남은 것 중 하나가 어둠으로, 어둠 머리도
  // 죽으면 남은 것이 빛으로 바뀐다. 그래서 "이름"이 아니라 "속성"으로
  // 지정하고, 코드가 매번 목록 화면에서 그 속성을 가진 머리가 지금 어떤
  // 이름인지 다시 찾는다.
  //
  // 새 길드 보스를 추가하려면: 여기 BOSS_REGISTRY에 항목을 하나 추가한다.
  //   label: 하위 탭에 표시할 이름
  //   presetName: 캐릭>프리셋(공용 프리셋)에서 적용할 프리셋 이름
  //   headNames: 그 보스의 부위/머리 이름 목록 (부위 개념이 없는 단일 보스면 빈 배열)
  //   maxAttacks: 개인 공격 횟수 제한 (실전 확인 필요)
  Modules.guildboss.BOSS_REGISTRY = {
    hydra: {
      label: '히드라',
      presetName: '히드라',
      headNames: ['화염의 머리', '빙결의 머리', '전격의 머리', '대지의 머리', '바람의 머리'],
      maxAttacks: 8,
    },
  };

  Modules.guildboss.getBossConfig = function (bossId) {
    const mod = Modules.guildboss;
    if (!mod.config.bosses[bossId]) {
      mod.config.bosses[bossId] = { originalElement: '', targetElement: '' };
    }
    return mod.config.bosses[bossId];
  };

  // 목록 화면에서 지정한 속성을 가진 머리의 "이름"을 찾는다. 처치된 머리는
  // 건너뛴다(실전 확인: 처치된 머리 근처엔 "처치됨" 텍스트가 붙음).
  Modules.guildboss.findHeadNameByElement = function (bossId, targetElement) {
    const headNames = Modules.guildboss.BOSS_REGISTRY[bossId].headNames;
    const all = Core.gameElements('*');
    for (const headName of headNames) {
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

  // 공용 프리셋 적용 (캐릭 > 프리셋 화면, 보스 전용 프리셋이 아니라 공용 프리셋)
  Modules.guildboss.applyBossPreset = async function (presetName) {
    await Core.clickNavMenuExact('캐릭', '프리셋');
    const onPresetPage = await Core.waitFor(() => location.pathname.replace(/\/$/, '') === '/user-presets', 15000, 300);
    if (!onPresetPage) throw new Error('프리셋 화면 진입을 확인하지 못했습니다.');
    await Core.humanDelay(500, 900);

    const findApplyBtn = () => {
      const all = Core.gameElements('*');
      const heading = all.find((el) => el.children.length === 0 && el.textContent.trim() === presetName);
      if (!heading) return null;
      const idx = all.indexOf(heading);
      for (let i = idx + 1; i < Math.min(idx + 15, all.length); i++) {
        const el = all[i];
        if (el.tagName === 'BUTTON' && el.textContent.trim() === '적용' && Core.isElementVisible(el)) return el;
      }
      return null;
    };
    const applyBtn = await Core.waitFor(findApplyBtn, 8000, 250);
    if (!applyBtn) throw new Error(`"${presetName}" 프리셋을 찾지 못했습니다 (프리셋 이름/존재 여부 확인 필요).`);
    if (!(await Core.safeClick(findApplyBtn, { beforeMin: 500, beforeMax: 900, afterMin: 1000, afterMax: 1500 }))) {
      throw new Error(`"${presetName}" 프리셋 적용 클릭에 실패했습니다.`);
    }
    Core.log('guildboss', `"${presetName}" 프리셋 적용 완료`);
  };

  // 우측 상단 계정 아이콘(텍스트/aria-label 없는, 상단 네비게이션 바에서
  // 가장 오른쪽에 위치한 아이콘 버튼) → 드롭다운 "길드" → "보스" 탭.
  // 실전 확인: 이 아이콘은 aria-label이 없어 텍스트로 찾을 수 없고, 화면
  // 최상단(top<40px)에 있는 버튼 중 가장 오른쪽(right 값 최대)인 것으로 특정함.
  // 모든 길드 보스에 공통되는 진입 경로.
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

  // 목록에서 지정한 속성의 머리를 찾아 선택 → "공격하기" → 전투 서브화면 진입
  Modules.guildboss.enterHeadBattle = async function (bossId, targetElement) {
    const resolveHeadName = () => Modules.guildboss.findHeadNameByElement(bossId, targetElement);
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

  Modules.guildboss.runAttackLoop = async function (bossId) {
    const mod = this;
    const maxAttacks = mod.BOSS_REGISTRY[bossId].maxAttacks;
    for (let i = 0; i < maxAttacks; i++) {
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

      // 실전 확인된 완료 문구: 버튼이 "최대 공격 횟수 도달 (N회)"로 바뀜
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
    const bossId = mod.activeBossId;
    const bossDef = mod.BOSS_REGISTRY[bossId];
    if (!bossDef) {
      Core.notifyStopped('guildboss', '선택된 길드 보스 정보를 찾을 수 없습니다.');
      return;
    }
    const bossConfig = mod.getBossConfig(bossId);
    Core.log('guildboss', `길드 보스(${bossDef.label}) 매크로 시작`);
    try {
      if (!bossConfig.targetElement) throw new Error('공격할 속성을 먼저 선택해주세요.');

      Core.log('guildboss', `시작 전 원래 속성(${bossConfig.originalElement}) 확인`);
      await Core.ensureCharacterElement(bossConfig.originalElement, 'guildboss');
      if (!mod.running || mod.stopRequested) return;

      await mod.applyBossPreset(bossDef.presetName);
      if (!mod.running || mod.stopRequested) return;

      await mod.goToGuildBossScreen();
      if (!mod.running || mod.stopRequested) return;

      const headLabel = await mod.enterHeadBattle(bossId, bossConfig.targetElement);
      if (!mod.running || mod.stopRequested) return;

      const loopResult = await mod.runAttackLoop(bossId);
      if (loopResult.headDefeated) {
        const msg = loopResult.defeatedByOthers
          ? `"${headLabel}"(${bossConfig.targetElement} 속성)이(가) 다른 길드원에 의해 먼저 처치되어 더 공격할 수 없습니다 - 정지합니다.`
          : `"${headLabel}"(${bossConfig.targetElement} 속성) 처치 완료 - 정지합니다.`;
        Core.notifyStopped('guildboss', msg);
        return;
      }
      if (!loopResult.stopped) {
        Core.notifyCompleted('guildboss', `길드 보스(${bossDef.label}) 공격을 완료했습니다.`);
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

  const GUILDBOSS_PERSIST_KEYS = ['bosses'];

  // 보스 하나의 설정 패널(속성 select 2개 + 시작/정지 + 안내문)을 만든다.
  function buildGuildBossSubPanel(panelContainer, bossId) {
    const mod = Modules.guildboss;
    const bossDef = mod.BOSS_REGISTRY[bossId];
    const bossConfig = mod.getBossConfig(bossId);
    const refs = (UIRefs.guildboss[bossId] = UIRefs.guildboss[bossId] || {});

    panelContainer.appendChild(labelEl('원래 속성 (시작 전 자동 확인·변경)'));
    const elementSelect = document.createElement('select');
    elementSelect.style.cssText = inputStyle();
    const elementPlaceholder = document.createElement('option');
    elementPlaceholder.value = '';
    elementPlaceholder.textContent = '속성 선택 필요';
    elementPlaceholder.selected = !Core.ELEMENT_OPTIONS.includes(bossConfig.originalElement);
    elementSelect.appendChild(elementPlaceholder);
    Core.ELEMENT_OPTIONS.forEach((element) => {
      const option = document.createElement('option');
      option.value = element;
      option.textContent = element;
      option.selected = element === bossConfig.originalElement;
      elementSelect.appendChild(option);
    });
    elementSelect.addEventListener('change', (e) => {
      bossConfig.originalElement = e.target.value;
      Core.saveModuleConfig('guildboss', GUILDBOSS_PERSIST_KEYS);
    });
    panelContainer.appendChild(elementSelect);

    // ⚠ 사용자 확인(2026-08): 부위/머리 이름은 고정이지만 배정된 속성은
    // 소환마다·전투 중에도 바뀌므로 "이름"이 아니라 "속성"으로 지정한다.
    panelContainer.appendChild(labelEl('공격할 속성 (해당 속성 부위를 매번 자동으로 찾음)'));
    const targetSelect = document.createElement('select');
    targetSelect.style.cssText = inputStyle();
    const targetPlaceholder = document.createElement('option');
    targetPlaceholder.value = '';
    targetPlaceholder.textContent = '속성 선택 필요';
    targetPlaceholder.selected = !Core.ELEMENT_OPTIONS.includes(bossConfig.targetElement);
    targetSelect.appendChild(targetPlaceholder);
    Core.ELEMENT_OPTIONS.forEach((element) => {
      const option = document.createElement('option');
      option.value = element;
      option.textContent = element;
      option.selected = element === bossConfig.targetElement;
      targetSelect.appendChild(option);
    });
    targetSelect.addEventListener('change', (e) => {
      bossConfig.targetElement = e.target.value;
      Core.saveModuleConfig('guildboss', GUILDBOSS_PERSIST_KEYS);
    });
    panelContainer.appendChild(targetSelect);

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
    startBtn.addEventListener('click', () => {
      Modules.guildboss.activeBossId = bossId;
      Core.startModule('guildboss');
    });
    stopBtn.addEventListener('click', () => Core.requestStopModule('guildboss'));
    btnRow.appendChild(startBtn);
    btnRow.appendChild(stopBtn);
    panelContainer.appendChild(btnRow);
    panelContainer.appendChild(statusEl);

    const hint = document.createElement('div');
    hint.textContent = `※ 길드마스터가 "${bossDef.label}"을(를) 소환한 시간에만 사용 가능합니다. 개인 공격 횟수 최대 ${bossDef.maxAttacks}회.`;
    hint.style.cssText = 'color:#888; font-size:10px; margin-top:4px;';
    panelContainer.appendChild(hint);

    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.inputs = [elementSelect, targetSelect];
  }

  // 길드보스 탭 전체: 보스별 하위 탭 바 + 각 보스의 설정 패널.
  // BOSS_REGISTRY에 새 보스를 추가하면 이 함수가 자동으로 하위 탭을 만든다.
  function buildGuildBossTab(container) {
    const mod = Modules.guildboss;
    Core.loadModuleConfig('guildboss', GUILDBOSS_PERSIST_KEYS);
    const bossIds = Object.keys(mod.BOSS_REGISTRY);
    bossIds.forEach((bossId) => mod.getBossConfig(bossId));

    const subTabBar = document.createElement('div');
    subTabBar.style.cssText = 'display:flex; border-bottom:1px solid #444; margin-bottom:8px;';
    const subTabContentWrap = document.createElement('div');

    const subTabButtons = {};
    const subTabContents = {};

    function switchSubTab(bossId) {
      bossIds.forEach((id) => {
        subTabContents[id].style.display = id === bossId ? 'block' : 'none';
        subTabButtons[id].style.borderBottom = id === bossId ? '2px solid #f5a623' : '2px solid transparent';
        subTabButtons[id].style.color = id === bossId ? '#f5a623' : '#eee';
      });
    }

    bossIds.forEach((bossId) => {
      const btn = document.createElement('button');
      btn.textContent = mod.BOSS_REGISTRY[bossId].label;
      btn.style.cssText =
        'flex:1; padding:5px 0; background:#1a1a1a; color:#eee; border:none; border-bottom:2px solid transparent; cursor:pointer; font-size:11px;';
      btn.addEventListener('click', () => switchSubTab(bossId));
      subTabBar.appendChild(btn);
      subTabButtons[bossId] = btn;

      const content = document.createElement('div');
      content.style.display = 'none';
      subTabContentWrap.appendChild(content);
      subTabContents[bossId] = content;
      buildGuildBossSubPanel(content, bossId);
    });

    container.appendChild(subTabBar);
    container.appendChild(subTabContentWrap);
    if (bossIds.length > 0) switchSubTab(bossIds[0]);
  }
