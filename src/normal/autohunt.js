  // -------------------------- 모듈 2: 자동사냥 --------------------------
  Modules.autohunt = {
    id: 'autohunt',
    running: false,
    stopRequested: false,
    cycleCount: 0,
    protectionVerificationPending: false,
    config: {
      originalElement: '',
      groundSuffix: '광산',
      floor: null,
      goldThreshold: 1000000,
      minEnergy: 100,
      ignoreProtectionOff: false,
      // ⚠ 유료 "x50" 일괄 사냥 기능이 없는 캐릭터용: 한 번에 한 전투만 진행하고,
      // 각 전투 후 매번 지도 아이템(레어맵)을 확인/사용해 레어맵이 있으면 바로 들어간다.
      singleBattleMode: false,
    },
  };

  Modules.autohunt.GROUND_OPTIONS = [
    { label: '평야', suffix: '평야', hasFloor: false },
    { label: '늪', suffix: '늪', hasFloor: false },
    { label: '숲', suffix: '숲', hasFloor: false },
    { label: '탑', suffix: '탑', hasFloor: false },
    { label: '지하', suffix: '지하', hasFloor: false },
    { label: '광산', suffix: '광산', hasFloor: true },
  ];

  Modules.autohunt.leafTextEls = function () {
    return Array.from(document.querySelectorAll('body *')).filter(
      (el) => el.children.length === 0 && el.textContent.trim().length > 0 && !el.closest('#lrm-panel') && !el.closest('#lrm-banner')
    );
  };

  Modules.autohunt.valueAfterLabel = function (label) {
    const leaves = this.leafTextEls();
    const idx = leaves.findIndex((el) => el.textContent.trim() === label);
    if (idx === -1 || idx + 1 >= leaves.length) return null;
    return leaves[idx + 1].textContent.trim();
  };

  Modules.autohunt.parseNumber = function (text) {
    if (!text) return null;
    const cleaned = text.replace(/[^0-9.-]/g, '');
    if (!cleaned) return null;
    return Number(cleaned);
  };

  Modules.autohunt.parseFraction = function (text) {
    if (!text) return null;
    const m = text.match(/([\d,]+)\s*\/\s*([\d,]+)/);
    if (!m) return null;
    return { cur: this.parseNumber(m[1]), max: this.parseNumber(m[2]) };
  };

  Modules.autohunt.ensureOnGround = async function (
    groundSuffix,
    floor,
    shouldCancel = Core.defaultShouldCancel
  ) {
    // ⚠ 1전투 모드에서는 x50 버튼이 아니라 단일 전투 버튼을 기준으로 확인한다.
    const findBtn = () =>
      this.config.singleBattleMode
        ? this.findSingleBattleButton(groundSuffix)
        : this.findHuntX50Button(groundSuffix);
    if (findBtn()) {
      if (floor) {
        const floorSelected = await this.selectFloor(floor, shouldCancel);
        if (!floorSelected) return false;
      }
      return !!findBtn();
    }
    try {
      await Core.clickNavMenuSuffix('전투', groundSuffix, shouldCancel);
    } catch (e) {
      Core.log('autohunt', `오류: ${e.message}`);
      return false;
    }
    await Core.sleep(600);
    if (shouldCancel && shouldCancel()) return false;
    if (floor) {
      const floorSelected = await this.selectFloor(floor, shouldCancel);
      if (!floorSelected) return false;
    }
    return !!(await Core.waitFor(
      () => findBtn(),
      8000,
      300,
      shouldCancel
    ));
  };

  Modules.autohunt.selectFloor = async function (
    floor,
    shouldCancel = Core.defaultShouldCancel
  ) {
    const target = `${floor}층`;
    const btn = await Core.waitFor(
      () => Core.allButtons().find((b) => b.textContent.trim() === target) || null,
      6000,
      300,
      shouldCancel
    );
    if (!btn) {
      Core.log('autohunt', `경고: "${target}" 버튼을 찾지 못했습니다.`);
      return false;
    }
    if (btn.getAttribute('aria-pressed') !== 'true') {
      if (!(await Core.safeClick(
        () => Core.allButtons().find((b) => b.textContent.trim() === target) || null,
        { beforeMin: 350, beforeMax: 700, shouldCancel }
      ))) return false;
      await Core.sleep(500);
    }
    return true;
  };

  Modules.autohunt.findHuntX50Button = function (groundSuffix = this.config.groundSuffix) {
    return (
      Core.allButtons().find((b) => {
        const text = b.textContent.trim();
        if (!/[×xX]\s*50\s*$/.test(text)) return false;
        if (!groundSuffix || text.includes(groundSuffix)) return true;
        let parent = b.parentElement;
        for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
          if ((parent.textContent || '').includes(groundSuffix)) return true;
        }
        return false;
      }) || null
    );
  };

  Modules.autohunt.clickHuntX50 = async function () {
    const btn = await Core.waitFor(() => this.findHuntX50Button(this.config.groundSuffix), 6000);
    if (!btn) {
      Core.log('autohunt', '오류: "x 50" 사냥 버튼을 찾지 못했습니다.');
      return 'not_found';
    }
    if (btn.disabled) return 'disabled';
    return (await Core.safeClick(() => this.findHuntX50Button(this.config.groundSuffix), {
      beforeMin: 500,
      beforeMax: 1300,
    }))
      ? 'clicked'
      : 'not_found';
  };

  // ⚠ x50 유료 기능이 없는 캐릭터는 사냥터 버튼에 "50" 접미사 없이 사냥터
  // 이름만 뜬다(예: "숲"). 그 버튼 하나만 누르면 매번 단 한 번의 전투만 진행된다.
  Modules.autohunt.findSingleBattleButton = function (groundSuffix = this.config.groundSuffix) {
    return (
      Core.allButtons().find((b) => b.textContent.trim() === groundSuffix) || null
    );
  };

  Modules.autohunt.clickSingleBattle = async function () {
    const btn = await Core.waitFor(() => this.findSingleBattleButton(this.config.groundSuffix), 6000);
    if (!btn) {
      Core.log('autohunt', '오류: "1전투" 사냥 버튼을 찾지 못했습니다.');
      return 'not_found';
    }
    if (btn.disabled) return 'disabled';
    return (await Core.safeClick(() => this.findSingleBattleButton(this.config.groundSuffix), {
      beforeMin: 500,
      beforeMax: 1300,
    }))
      ? 'clicked'
      : 'not_found';
  };

  // ⚠ 사용자 확인: 이 1전투 모드는 순수히 사냥만 해야 하며, "지도 아이템"을
  // 절대 사용(소모)해서는 안 된다. 지도 아이콘/다이얼로그는 "레어맵 생성" 전용
  // 매크로(Modules.raremap.useTopMapItem)에서만 쓰는 것이고, 자동사냥은 이미 화면에 자연스럽게
  // 떠 있는 레어맵 버튼이 있는지만 순수하게 확인해서 진입한다(버튼 클릭 외에
  // 다른 상호작용 없음).
  //
  // Modules.raremap.getMineContainer/findRareButtonIn은 "광산"으로 고정되어
  // 있어 다른 사냥터에는 쓸 수 없어서, 현재 사냥터 이름을 기준으로 일반화한다.
  Modules.autohunt.findGroundContainer = function (groundSuffix) {
    const anchor = document.querySelector('[data-tour="battle-start-button"]');
    if (!anchor) return null;
    let el = anchor;
    let base = null;
    for (let i = 0; i < 6; i++) {
      el = el.parentElement;
      if (!el) return base;
      const groundButtons = Array.from(el.querySelectorAll('button.MuiButton-fullWidth')).filter(
        (b) => b.textContent.trim() === groundSuffix
      );
      if (groundButtons.length >= 1) {
        base = el;
        if (this.findExistingRareMapButtonIn(el, groundSuffix)) return el;
      }
    }
    return base;
  };

  Modules.autohunt.findExistingRareMapButtonIn = function (container, groundSuffix) {
    const buttons = Array.from(container.querySelectorAll('button.MuiButton-fullWidth'));
    return buttons.find((b) => {
      const t = b.textContent.trim();
      if (!t) return false;
      if (t === groundSuffix) return false;
      if (Modules.raremap.EXCLUDE_TEXTS.some((ex) => t.includes(ex))) return false;
      if (/^\d+\s*층$/.test(t)) return false;
      return true;
    }) || null;
  };

  Modules.autohunt.findExistingRareMapButton = function (groundSuffix) {
    const container = this.findGroundContainer(groundSuffix);
    if (!container) return null;
    return this.findExistingRareMapButtonIn(container, groundSuffix);
  };

  // 이미 떠 있는 레어맵을 순서대로 모두 진입해 클리어한다. 지도 아이템은
  // 절대 사용하지 않는다.
  Modules.autohunt.checkAndEnterExistingRareMapIfAny = async function () {
    let count = 0;
    let unchangedCount = 0;
    while (this.running && !this.stopRequested && count < 20) {
      const rareBtn = this.findExistingRareMapButton(this.config.groundSuffix);
      if (!rareBtn) break;
      const beforeText = rareBtn.textContent.trim();
      Core.log('autohunt', `레어맵 발견: "${beforeText}" → 진입 (지도 아이템 미사용, 자연 발생분만)`);
      const clicked = await Core.safeClick(
        () => this.findExistingRareMapButton(this.config.groundSuffix),
        { beforeMin: 600, beforeMax: 1300 }
      );
      if (!clicked) break;
      const changed = await Core.waitFor(() => {
        const next = this.findExistingRareMapButton(this.config.groundSuffix);
        return !next || next.textContent.trim() !== beforeText ? true : null;
      }, 10000, 400);
      if (!changed) {
        unchangedCount++;
        Core.log('autohunt', `동일 레어맵 버튼이 그대로 남아 있습니다 (${unchangedCount}/3).`);
        if (unchangedCount >= 3) {
          Core.log('autohunt', '레어맵 확인을 안전을 위해 중단합니다.');
          break;
        }
        continue;
      }
      unchangedCount = 0;
      count++;
    }
    return count;
  };

  Modules.autohunt.readEnergy = function () {
    const el = this.leafTextEls().find((e) => /^[\d,]+\/\s*2000$/.test(e.textContent.trim()));
    if (!el) return null;
    const f = this.parseFraction(el.textContent.trim());
    return f ? f.cur : null;
  };

  Modules.autohunt.readGold = function () {
    return this.parseNumber(this.valueAfterLabel('골드'));
  };

  Modules.autohunt.readPlayerHPMP = function () {
    const leaves = this.leafTextEls();
    const hpIdx = leaves.findIndex((e) => e.textContent.trim() === 'HP');
    const mpIdx = leaves.findIndex((e) => e.textContent.trim() === 'MP');
    if (hpIdx === -1 || mpIdx === -1) return null;
    const hp = this.parseFraction(leaves[hpIdx + 1] ? leaves[hpIdx + 1].textContent.trim() : '');
    const mp = this.parseFraction(leaves[mpIdx + 1] ? leaves[mpIdx + 1].textContent.trim() : '');
    if (!hp || !mp) return null;
    return { hp, mp };
  };

  Modules.autohunt.readExpPotionRemaining = function () {
    const m = Core.bodyText().match(/농축 경험의 물약 효과 \(5배\):\s*([\d,]+)회 남음/);
    if (!m) return null;
    return parseInt(m[1].replace(/,/g, ''), 10);
  };

  Modules.autohunt.readMpPotionRemaining = function () {
    const m = Core.bodyText().match(/MP\s*포션:\s*[\d,]+\s*사용\s*\(([\d,]+)\s*남음\)/);
    if (!m) return null;
    return parseInt(m[1].replace(/,/g, ''), 10);
  };

  Modules.autohunt.readHpPotionRemaining = function () {
    const m = Core.bodyText().match(/HP\s*포션:\s*[\d,]+\s*사용\s*\(([\d,]+)\s*남음\)/);
    if (!m) return null;
    return parseInt(m[1].replace(/,/g, ''), 10);
  };

  // 포션(HP/MP) 잔량이 0이 되었을 때, 그냥 정지하지 않고 데자브에서 사 온
  // 뒤 원래 사냥터로 복귀해 계속 진행한다. 구매 자체가 실패하면(둘 다 골드
  // 부족 등) 기존처럼 은행 입금 후 정지한다.
  // ⚠ 사용자 요청(2026-08): 순서를 "은행입금 → 여관회복 → 데자브이동 →
  // 포션구매 → 기존 사냥터 복귀"로 명확히 한다. potionTypes는 ['HP'],
  // ['MP'], 또는 ['HP','MP'] 배열을 받아 필요한 것만 산다.
  Modules.autohunt.recoverPotionAndResume = async function (potionTypes, label) {
    const mod = this;
    Core.log('autohunt', `${label} 부족 확인 - 회복 절차 시작 (은행입금 → 여관회복 → 데자브 포션구매 → 사냥터 복귀)`);

    // 1. 은행 입금 (보유 골드 보호)
    await Core.bankDepositAll('autohunt');

    // 2. 여관에서 무료로 HP/MP 완전 회복 (현재 마을에서 바로 가능, 이동 불필요)
    try {
      await Core.restAtInn('autohunt');
    } catch (e) {
      Core.log('autohunt', `⚠ 여관 휴식 실패(포션 구매는 계속 진행): ${e.message}`);
    }

    // 3. 데자브로 이동해 부족한 포션을 전부 구매
    try {
      for (const potionType of potionTypes) {
        await Core.buyEmergencyPotion(potionType, 'autohunt');
      }
    } catch (e) {
      Core.notifyStopped('autohunt', `${label} 구매에 실패해 정지합니다: ${e.message}`);
      return false;
    }

    // 4. 포션은 데자브 한정이므로, 구매 후에는 반드시 사냥용 속성 마을과
    // 사냥터로 되돌아가야 버프를 받는다.
    try {
      await Core.ensureCurrentTownForElement(mod.config.originalElement, 'autohunt');
      const okGround = await mod.ensureOnGround(mod.config.groundSuffix, mod.config.floor);
      if (!okGround) throw new Error('사냥터 재진입 실패');
    } catch (e) {
      Core.notifyStopped('autohunt', `${label} 구매 후 원래 사냥터로 복귀하지 못해 정지합니다: ${e.message}`);
      return false;
    }
    Core.log('autohunt', `${label} 회복 완료 후 원래 사냥터로 복귀 완료 - 계속 진행`);
    return true;
  };

  // 포션 재고(잔량 수치)는 남아 있어도, 일일 사용 한도 등 다른 이유로
  // 이번 전투에는 실제로 포션이 안 쓰였을 수 있다(패배로 이어짐). 그래서
  // "잔량 0" 체크뿐 아니라 "전투 후 HP/MP가 실제로 안 찼는지"까지 함께
  // 봐야 하고, 이 체크는 승리/패배 결과와 무관하게 항상 실행되어야 한다.
  Modules.autohunt.checkPotionExhaustedAndStop = async function () {
    const expPotion = this.readExpPotionRemaining();
    if (expPotion !== null && expPotion <= 0) {
      await Core.bankDepositAll('autohunt');
      Core.notifyStopped('autohunt', '농축 경험의 물약 효과가 모두 소진되었습니다 — 은행에 입금 후 정지합니다. 인벤토리에서 물약을 채워주세요.');
      return true;
    }
    const mpPotionRemaining = this.readMpPotionRemaining();
    const hpPotionRemaining = this.readHpPotionRemaining();
    const zeroTypes = [];
    if (mpPotionRemaining !== null && mpPotionRemaining <= 0) zeroTypes.push('MP');
    if (hpPotionRemaining !== null && hpPotionRemaining <= 0) zeroTypes.push('HP');
    if (zeroTypes.length > 0) {
      const label = zeroTypes.map((t) => `${t} 포션`).join('/');
      const recovered = await this.recoverPotionAndResume(zeroTypes, label);
      return !recovered;
    }
    // ⚠ 사용자 확인: 1전투 모드는 x50과 달리 전투 후 HP/MP가 가득
    // 차지 않아도 정상이다(포션이 매 전투마다 자동으로 풀회복을 보장하는 게
    // 아니기 때문). 이 HP/MP 추론 체크는 x50 모드에서만 쓰고, 1전투
    // 모드에서는 건너뛰고 위의 명시적인 "잔량 수치" 체크만 신뢰한다.
    // ⚠ 버그 수정(2026-08): 이 분기가 은행 입금 후 그냥 정지만 하고
    // 회복 절차(여관/포션 구매)를 전혀 타지 않고 있었다. 잔량 수치 체크와
    // 동일하게 recoverPotionAndResume으로 연결한다.
    if (!this.config.singleBattleMode) {
      const hpmp = this.readPlayerHPMP();
      if (hpmp) {
        const needed = [];
        if (hpmp.hp.cur < hpmp.hp.max) needed.push('HP');
        if (hpmp.mp.cur < hpmp.mp.max) needed.push('MP');
        if (needed.length > 0) {
          const recovered = await this.recoverPotionAndResume(needed, '포션(전투 후 HP/MP 미충전)');
          return !recovered;
        }
      }
    }
    return false;
  };

  Modules.autohunt.detectResultState = function () {
    const text = Core.bodyText();
    if (/장비\s*내구도\s*부족/.test(text)) return 'durability';
    if (/패배\s*\.{2,}/.test(text) || /소지금이\s*절반으로\s*줄어들었다/.test(text)) return 'defeat';
    if (/(\d+\s*회\s*전투\s*완료|승리!)/.test(text)) return 'success';
    return null;
  };

  Modules.autohunt.waitForResult = async function (timeoutMs = 20000) {
    return Core.waitFor(() => this.detectResultState(), timeoutMs, 500);
  };

  Modules.autohunt.isHpZeroBlocked = function () {
    const text = Core.bodyText();
    return /HP\s*0\s*일땐\s*전투할\s*수\s*없습니다/.test(text) || /체력이\s*0이\s*되었습니다/.test(text);
  };

  Modules.autohunt.isProtectionOff = function () {
    return this.readEquipmentProtectionState().offIcons.length > 0;
  };

  Modules.autohunt.readEquipmentProtectionState = function () {
    const protectionIcons = Core.gameElements('[aria-label]').filter((element) =>
      /보호/.test(element.getAttribute('aria-label') || '')
    );
    const offIcons = protectionIcons.filter((element) =>
      /보호\s*없음/.test(element.getAttribute('aria-label') || '')
    );
    return {
      seen: protectionIcons.length > 0,
      protectionIcons,
      offIcons,
    };
  };

  Modules.autohunt.getUnprotectedEquipmentCategories = function () {
    const { protectionIcons, offIcons } = this.readEquipmentProtectionState();
    const resolved = [];
    let unresolved = 0;

    for (const icon of offIcons) {
      let category = null;
      for (let node = icon, depth = 0; node && depth < 7; node = node.parentElement, depth++) {
        const context = [
          node.getAttribute && node.getAttribute('aria-label'),
          node.getAttribute && node.getAttribute('title'),
          node.getAttribute && node.getAttribute('data-slot'),
          node.getAttribute && node.getAttribute('data-category'),
          node.textContent,
        ].filter(Boolean).join(' ');
        const matches = Core.EQUIPMENT_CATEGORIES.filter((candidate) =>
          context.includes(candidate)
        );
        if (matches.length === 1) {
          category = matches[0];
          break;
        }
      }
      // 보호 아이콘이 정확히 3개라면 게임의 장착 장비 표시 순서
      // (무기 → 방어구 → 장신구)를 사용할 수 있다. aria-label이 단순히
      // "보호 없음"뿐이라 조상 텍스트로 슬롯을 못 읽는 실화면의 보정이다.
      if (!category && protectionIcons.length === Core.EQUIPMENT_CATEGORIES.length) {
        const slotIndex = protectionIcons.indexOf(icon);
        if (slotIndex >= 0) category = Core.EQUIPMENT_CATEGORIES[slotIndex];
      }
      if (category) resolved.push(category);
      else unresolved++;
    }

    if (unresolved > 0 || resolved.length === 0) {
      // 화면에서 슬롯명을 확정할 수 없을 때 한 부위를 임의로 고르면 계속
      // 보호 없음이 남아 기름 사용 무한반복이 생긴다. 이 경우에만 세 부위를
      // 한 번씩 보호하고, 사냥터 복귀 뒤 실제 '보호 없음' 소멸을 재검증한다.
      return [...Core.EQUIPMENT_CATEGORIES];
    }
    return [...new Set(resolved)];
  };

  Modules.autohunt.recoverEquipmentProtection = async function () {
    const mod = this;
    const shouldCancel = () => mod.stopRequested || !mod.running;
    const categories = mod.getUnprotectedEquipmentCategories();
    Core.log(
      'autohunt',
      `장비 보호(기름) 해제 감지 → ${categories.join(' → ')} 착용 장비에 장비용 기름 사용`
    );
    const used = await Core.useEquipmentOilForCategories(
      categories,
      'autohunt',
      shouldCancel
    );
    if (!used || shouldCancel()) return false;

    const returned = await mod.ensureOnGround(
      mod.config.groundSuffix,
      mod.config.floor,
      shouldCancel
    );
    if (!returned) throw new Error('장비용 기름 사용 후 사냥터 복귀에 실패했습니다.');
    // 사냥터의 대기 화면에는 장비 보호 아이콘이 렌더링되지 않는다.
    // 따라서 복귀 직후 확인하면 정상 적용도 실패로 오판한다. 다음 50회
    // 전투 결과 화면에서 아이콘이 다시 나타날 때 단 한 번 재검증한다.
    mod.protectionVerificationPending = true;
    Core.log('autohunt', '장비용 기름 적용 완료 → 다음 사냥 결과에서 보호 상태 재검증 예정');
    return true;
  };

  Modules.autohunt.checkAndDepositGold = async function () {
    const gold = this.readGold();
    if (gold !== null && gold > this.config.goldThreshold) {
      Core.log('autohunt', `현재 골드 ${gold.toLocaleString()}G가 기준(${this.config.goldThreshold.toLocaleString()}G)을 초과하여 입금합니다.`);
      await Core.bankDepositAll('autohunt');
    }
  };

  Modules.autohunt.mainLoop = async function () {
    const mod = this;
    mod.cycleCount = 0;
    mod.protectionVerificationPending = false;

    // ⚠ 사용자 요청(2026-08): 프리셋/속성(필요시 속성돌 소모)부터 맞추고 나서
    // 행동력을 확인하던 순서를 반대로 바꾼다. 이미 행동력이 기준 이하로
    // 소진된 상태(예: 일부 사냥을 끝내고 일일을 다시 돌리는 경우)에서
    // 시작하면, 실제로는 한 사이클도 못 돌면서 속성돌만 낭비하는 문제가
    // 있었다. 행동력 표시는 어느 화면에서나 바로 읽을 수 있으므로, 프리셋/
    // 속성을 건드리기 전에 먼저 확인한다.
    const startEnergy = mod.readEnergy();
    if (startEnergy !== null && startEnergy < mod.config.minEnergy) {
      Core.notifyCompleted(
        'autohunt',
        `시작 전 행동력이 이미 ${startEnergy}로 기준(${mod.config.minEnergy}) 이하라 사냥 없이 정지합니다.`
      );
      return;
    }

    Core.log('autohunt', '시작 전 공용 프리셋 "사냥" 적용');
    await Core.applyCommonPreset('사냥', 'autohunt');
    Core.log('autohunt', `시작 전 원래 속성(${mod.config.originalElement}) 확인`);
    await Core.ensureCharacterElement(mod.config.originalElement, 'autohunt');
    // ⚠ 사용자 확인(2026-08): 보스/던전과 달리 자동사냥은 "사냥을 시작한 마을의
    // 속성"과 "캐릭터 속성"이 일치해야 버프를 받는다. 마을 위치는 상관없는
    // 던전과 혼동하기 쉬운 지점이므로, 캐릭터 속성 확인 직후 마을 위치도 함께
    // 확인해서 다르면 이동한다.
    Core.log('autohunt', `시작 전 마을 위치(${Core.ELEMENT_TO_TOWN[mod.config.originalElement]}) 확인`);
    await Core.ensureCurrentTownForElement(mod.config.originalElement, 'autohunt');
    Core.log(
      'autohunt',
      `매크로 시작: 사냥터=${mod.config.groundSuffix}${mod.config.floor ? ' ' + mod.config.floor + '층' : ''}, 입금 기준=${mod.config.goldThreshold.toLocaleString()}G, 최소 행동력=${mod.config.minEnergy}`
    );

    let consecutiveFailures = 0;

    while (mod.running && !mod.stopRequested) {
      mod.cycleCount++;
      Core.log('autohunt', `--- ${mod.cycleCount}번째 사이클 ---`);
      Core.updateModuleButtons();

      const okGround = await mod.ensureOnGround(mod.config.groundSuffix, mod.config.floor);
      if (!okGround) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          Core.notifyStopped('autohunt', '사냥터 이동에 반복 실패하여 정지합니다. 화면 상태를 확인해주세요.');
          break;
        }
        if (!(await Core.interruptibleSleep(
          3000,
          () => mod.stopRequested || !mod.running
        ))) break;
        continue;
      }

      if (mod.isHpZeroBlocked()) {
        Core.notifyStopped('autohunt', '포션이 부족해 체력이 0인 상태로 전투가 불가능합니다 — 정지합니다.');
        break;
      }
      const protectionState = mod.readEquipmentProtectionState();
      if (
        !mod.config.ignoreProtectionOff &&
        mod.protectionVerificationPending &&
        protectionState.seen
      ) {
        if (protectionState.offIcons.length > 0) {
          mod.protectionVerificationPending = false;
          Core.notifyStopped(
            'autohunt',
            '장비용 기름 사용 후 다음 사냥 결과에서도 "보호 없음"이 남아 있어 안전 정지합니다.'
          );
          break;
        }
        mod.protectionVerificationPending = false;
        Core.log('autohunt', '장비용 기름 적용 및 다음 사냥 결과의 보호 상태 재검증 완료');
      }
      if (
        !mod.config.ignoreProtectionOff &&
        !mod.protectionVerificationPending &&
        protectionState.offIcons.length > 0
      ) {
        try {
          if (!(await mod.recoverEquipmentProtection())) break;
        } catch (e) {
          if (mod.stopRequested || !mod.running) break;
          Core.notifyStopped(
            'autohunt',
            `장비용 기름 자동 사용에 실패하여 안전 정지합니다: ${e.message}`
          );
          break;
        }
        // 인벤토리 왕복 뒤에는 이전 사냥 결과 DOM을 재사용하지 않고 새
        // 사이클에서 행동력·포션·사냥 버튼을 전부 다시 읽는다.
        continue;
      }

      const energy = mod.readEnergy();
      if (energy !== null && energy < mod.config.minEnergy) {
        Core.notifyCompleted('autohunt', `설정한 행동력 제한 도달(${energy}/2000, 기준 ${mod.config.minEnergy})`);
        break;
      }

      const preExpPotion = mod.readExpPotionRemaining();
      if (preExpPotion !== null && preExpPotion <= 0) {
        Core.notifyStopped('autohunt', '농축 경험의 물약 효과가 모두 소진되었습니다 — 정지합니다. 인벤토리에서 물약을 채워주세요.');
        break;
      }

      const previousResultText = Core.bodyText();
      const okClick = mod.config.singleBattleMode
        ? await mod.clickSingleBattle()
        : await mod.clickHuntX50();
      if (okClick === 'disabled') {
        Core.notifyCompleted('autohunt', '행동력 제한에 도달해 사냥 버튼이 비활성화되었습니다.');
        break;
      }
      if (okClick !== 'clicked') {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          Core.notifyStopped('autohunt', '사냥 버튼 클릭에 반복 실패하여 정지합니다.');
          break;
        }
        if (!(await Core.interruptibleSleep(
          3000,
          () => mod.stopRequested || !mod.running
        ))) break;
        continue;
      }

      await Core.sleep(1000);
      const result = await Core.waitFor(() => {
        const currentText = Core.bodyText();
        if (currentText === previousResultText) return null;
        return mod.detectResultState();
      }, 25000, 500);
      if (!result) {
        if (mod.isHpZeroBlocked()) {
          Core.notifyStopped('autohunt', '포션이 부족해 체력이 0인 상태로 전투가 불가능합니다 — 정지합니다.');
          break;
        }
        consecutiveFailures++;
        Core.log('autohunt', '경고: 사냥 결과 화면을 확인하지 못했습니다.');
        if (consecutiveFailures >= 3) {
          Core.notifyStopped('autohunt', '사냥 결과를 반복적으로 확인하지 못해 정지합니다.');
          break;
        }
        if (!(await Core.interruptibleSleep(
          3000,
          () => mod.stopRequested || !mod.running
        ))) break;
        continue;
      }
      consecutiveFailures = 0;

      if (result === 'durability') {
        await Core.repairAllEquipment('autohunt');
        await mod.checkAndDepositGold();
        await Core.sleep(600);
        continue;
      }

      if (result === 'defeat') {
        Core.log('autohunt', '패배 감지 → 포션 소진 여부 확인 중...');
        // 패배는 포션이 안 먹혀서 회복이 안 된 결과일 수 있다. 원인 확인 없이
        // 바로 다음 사이클로 넘어가면 포션 없이 계속 패배만 반복할 수 있으므로,
        // 은행 입금 전에 반드시 포션 소진 여부부터 확인한다.
        if (await mod.checkPotionExhaustedAndStop()) break;
        Core.log('autohunt', '은행에 남은 골드를 모두 입금한 뒤 다시 사냥을 이어갑니다.');
        await Core.bankDepositAll('autohunt');
        await Core.sleep(600);
        continue;
      }

      if (await mod.checkPotionExhaustedAndStop()) break;

      await mod.checkAndDepositGold();

      // ⚠ 1전투 모드일 때만: 매 전투 후 레어맵 지도 아이템을 확인해서
      // 있으면 바로 사용해 레어맵으로 진입하고, 없으면 다음 사이클에서 다시 1전투한다.
      if (mod.config.singleBattleMode) {
        await mod.checkAndEnterExistingRareMapIfAny();
      }

      await Core.sleep(1000 + Math.random() * 1400);
    }

    mod.running = false;
    Core.activeModuleId = Core.activeModuleId === 'autohunt' ? null : Core.activeModuleId;
    Core.log('autohunt', '매크로가 정지되었습니다.');
    Core.updateModuleButtons();
  };


  const AUTOHUNT_PERSIST_KEYS = ['originalElement', 'groundSuffix', 'floor', 'goldThreshold', 'minEnergy', 'ignoreProtectionOff', 'singleBattleMode'];

  function buildAutohuntTab(container) {
    const mod = Modules.autohunt;
    const refs = UIRefs.autohunt;
    Core.loadModuleConfig('autohunt', AUTOHUNT_PERSIST_KEYS);

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
      Core.saveModuleConfig('autohunt', AUTOHUNT_PERSIST_KEYS);
    });
    container.appendChild(elementSelect);

    container.appendChild(labelEl('사냥터'));
    const groundSelect = document.createElement('select');
    groundSelect.style.cssText = inputStyle();
    mod.GROUND_OPTIONS.forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt.suffix;
      o.textContent = opt.label;
      if (opt.suffix === mod.config.groundSuffix) o.selected = true;
      groundSelect.appendChild(o);
    });
    container.appendChild(groundSelect);

    const floorRow = document.createElement('div');
    floorRow.appendChild(labelEl('층 (광산)'));
    const floorSelect = document.createElement('select');
    floorSelect.style.cssText = inputStyle();
    [1, 2, 3, 4, 5].forEach((n) => {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = `${n}층`;
      if (mod.config.floor === n) o.selected = true;
      floorSelect.appendChild(o);
    });
    floorSelect.addEventListener('change', (e) => {
      mod.config.floor = Number(e.target.value);
      Core.saveModuleConfig('autohunt', AUTOHUNT_PERSIST_KEYS);
    });
    floorRow.appendChild(floorSelect);
    container.appendChild(floorRow);

    function syncFloorVisibility() {
      const opt = mod.GROUND_OPTIONS.find((o) => o.suffix === groundSelect.value);
      floorRow.style.display = opt && opt.hasFloor ? 'block' : 'none';
    }
    groundSelect.addEventListener('change', () => {
      mod.config.groundSuffix = groundSelect.value;
      syncFloorVisibility();
      Core.saveModuleConfig('autohunt', AUTOHUNT_PERSIST_KEYS);
    });
    syncFloorVisibility();

    container.appendChild(labelEl('골드 입금 기준액'));
    const goldInput = document.createElement('input');
    goldInput.type = 'number';
    goldInput.value = mod.config.goldThreshold;
    goldInput.style.cssText = inputStyle();
    goldInput.addEventListener('change', (e) => {
      mod.config.goldThreshold = parseInt(e.target.value, 10) || 0;
      Core.saveModuleConfig('autohunt', AUTOHUNT_PERSIST_KEYS);
    });
    container.appendChild(goldInput);

    container.appendChild(labelEl('최소 행동력 (미만이면 정지)'));
    const energyInput = document.createElement('input');
    energyInput.type = 'number';
    energyInput.value = mod.config.minEnergy;
    energyInput.style.cssText = inputStyle();
    energyInput.addEventListener('change', (e) => {
      mod.config.minEnergy = parseInt(e.target.value, 10) || 0;
      Core.saveModuleConfig('autohunt', AUTOHUNT_PERSIST_KEYS);
    });
    container.appendChild(energyInput);

    const protRow = document.createElement('div');
    protRow.style.cssText = 'display:flex; align-items:center; gap:6px; margin:4px 0;';
    const protCheck = document.createElement('input');
    protCheck.type = 'checkbox';
    protCheck.checked = mod.config.ignoreProtectionOff;
    protCheck.addEventListener('change', (e) => {
      mod.config.ignoreProtectionOff = e.target.checked;
      Core.saveModuleConfig('autohunt', AUTOHUNT_PERSIST_KEYS);
    });
    const protLabel = document.createElement('span');
    protLabel.textContent = '장비용 기름 자동 사용 안 함 (체크 시 보호 없어도 계속 사냥)';
    protLabel.style.cssText = 'font-size:11px; color:#ccc;';
    protRow.appendChild(protCheck);
    protRow.appendChild(protLabel);
    container.appendChild(protRow);

    const singleRow = document.createElement('div');
    singleRow.style.cssText = 'display:flex; align-items:center; gap:6px; margin:4px 0;';
    const singleCheck = document.createElement('input');
    singleCheck.type = 'checkbox';
    singleCheck.checked = mod.config.singleBattleMode;
    singleCheck.addEventListener('change', (e) => {
      mod.config.singleBattleMode = e.target.checked;
      Core.saveModuleConfig('autohunt', AUTOHUNT_PERSIST_KEYS);
    });
    const singleLabel = document.createElement('span');
    singleLabel.textContent = '50연속전투 없는 캐릭터용: 1전투씩 진행 + 매 전투 후 레어맵 자동 확인/진입';
    singleLabel.style.cssText = 'font-size:11px; color:#ccc;';
    singleRow.appendChild(singleCheck);
    singleRow.appendChild(singleLabel);
    container.appendChild(singleRow);

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
      const opt = mod.GROUND_OPTIONS.find((o) => o.suffix === groundSelect.value);
      mod.config.floor = opt && opt.hasFloor ? Number(floorSelect.value) : null;
      Core.startModule('autohunt');
    });
    stopBtn.addEventListener('click', () => Core.requestStopModule('autohunt'));
    btnRow.appendChild(startBtn);
    btnRow.appendChild(stopBtn);
    container.appendChild(btnRow);
    container.appendChild(statusEl);

    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.inputs = [elementSelect, groundSelect, floorSelect, goldInput, energyInput, protCheck, singleCheck];
  }
