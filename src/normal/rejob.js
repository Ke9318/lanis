  // -------------------------- 모듈 1: 재전직 --------------------------
  Modules.rejob = {
    id: 'rejob',
    running: false,
    stopRequested: false,
    runId: 0,
    loopPromise: null,
    cycleCount: 0,
    nextRestAt: null,
    config: {
      targetScore: 5000,
      tierIndex: 3,
      maxRejobCount: 500,
      restEvery: [50, 65],
      restSeconds: [60, 180],
      clickDelay: [500, 1300],
      useHiddenRoomMap: false,
    },
    expectedJobName: null,
    nextTierIndexOverride: null,
    skipRejobThisCycle: false,
    MAX_CONSECUTIVE_ENERGY_REFILLS: 5,
    energyRefillStreak: 0,
  };

  Modules.rejob.TIERS = [
    { short: '평야' },
    { short: '늪' },
    { short: '숲' },
    { short: '탑' },
    { short: '지하' },
    { short: '광산' },
  ];

  Modules.rejob.clickDelayWait = function () {
    return Core.humanDelay(this.config.clickDelay[0], this.config.clickDelay[1]);
  };

  Modules.rejob.findEnergyPlusButton = function () {
    const byLabel = [...document.querySelectorAll('button, [role="button"], [aria-label]')]
      .find((el) => {
        const label = el.getAttribute('aria-label') || '';
        return label.includes('활력') && (label.includes('포션') || label.includes('사용') || label.includes('충전'));
      });
    if (byLabel) return byLabel;

    // 접근성 라벨이 없는 UI 변형에서는 좌표로 찾지 않는다. 백그라운드 탭은
    // getBoundingClientRect()가 모두 0이 될 수 있으므로, 활력 수치(/2000)를
    // 포함하는 의미 영역 안의 +/사용 버튼을 찾는다.
    const bars = [...document.querySelectorAll('[role="progressbar"]')];
    const energyBar = bars.find((bar) => {
      const label = `${bar.getAttribute('aria-label') || ''} ${bar.parentElement ? bar.parentElement.textContent : ''}`;
      return label.includes('활력') || /\d+\s*\/\s*2000/.test(label);
    });
    if (!energyBar) return null;
    let scope = energyBar.parentElement;
    for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
      const buttons = [...scope.querySelectorAll('button, [role="button"]')];
      const candidate = buttons.find((el) => {
        const text = el.textContent.trim();
        const label = el.getAttribute('aria-label') || '';
        return label.includes('활력') || text === '+' || text.includes('포션 사용');
      });
      if (candidate) return candidate;
    }
    return null;
  };

  Modules.rejob.parseEnergy = function () {
    const m = Core.bodyText().match(/(\d+)\s*\/\s*2000/);
    return m ? parseInt(m[1], 10) : null;
  };

  // ⚠ 사용자 요청(2026-08): 황력의 포션/농축 경험의 물약 팝업을 자동으로
  // 클릭해 사용하는 로직이 게임 UI 변경마다 계속 깨져서 반복적으로
  // 멈춤. 자동 "사용" 클릭은 완전히 제거하고, 잔량만 확인해 부족하면
  // 로그로 알리고 정지한다(실제 보충은 사용자가 직접 한다). 아래
  // refillEnergyIfNeeded/refillExpPotion(팝업 자동 클릭 함수)은 더 이상 호출되지
  // 않으며, 코드는 참고용으로만 남겨둔다.
  Modules.rejob.checkExpPotionAndStopIfLow = function (potionRemaining) {
    // ⚠ 버그 수정: potionRemaining은 인벤토리 개수가 아니라 "농축 경험의
    // 물약 효과 (5배): N회 남음" 문구를 파싱한 값이다. 버프가 다 떨어지면 이
    // 문구 자체가 화면에서 사라져 null이 된다. 이전에 null을 "문제없음"으로
    // 처리해 버프가 완전히 끝난 상태에서도 정지 없이 계속 대대적으로 돕는 사고가
    // 실전에서 확인됨. null도 0과 동일하게 "부족"으로 취급해 정지한다.
    if (potionRemaining === null || potionRemaining === undefined || potionRemaining <= 0) {
      Core.notifyStopped(
        'rejob',
        `농축 경험의 물약 5배 효과가 소진된 것으로 보입니다(잔여: ${potionRemaining ?? '확인 안됨(문구 없음)'}). ` +
          '자동 사용은 비활성화되어 있으니 직접 사용 후 다시 시작해주세요.'
      );
      return false;
    }
    if (potionRemaining < 50) {
      Core.log('rejob', `농축 경험의 물약 효과 잔여 ${potionRemaining}회(50회 미만) - 자동 사용은 비활성화되어 있음, 곧 소진되니 직접 사용해두세요.`);
    }
    return true;
  };

  Modules.rejob.checkEnergyAndStopIfLow = function () {
    const energy = this.parseEnergy();
    if (energy === null) return true;
    if (energy <= 100) {
      Core.notifyStopped(
        'rejob',
        `행동력이 ${energy}로 부족합니다(기준 100). 활력의 포션 자동 사용은 비활성화되어 있으니 직접 충전 후 다시 시작해주세요.`
      );
      return false;
    }
    return true;
  };

  Modules.rejob.refillEnergyIfNeeded = async function () {
    const mod = this;
    const energy = mod.parseEnergy();
    if (energy === null) {
      Core.log('rejob', '행동력 수치를 읽지 못함 (건너뜀)');
      return;
    }
    if (energy > 100) return;

    if (mod.energyRefillStreak >= mod.MAX_CONSECUTIVE_ENERGY_REFILLS) {
      Core.notifyStopped(
        'rejob',
        `사냥 진행 없이 활력의 포션을 연속 ${mod.energyRefillStreak}회 사용했습니다. 무언가 잘못됐을 수 있어 정지합니다.`
      );
      return;
    }

    Core.log('rejob', `행동력 ${energy} 이하 → 활력의 포션 사용 시도`);

    const plusBtn = await Core.retryStep('행동력 "+" 버튼 찾기', () => mod.findEnergyPlusButton());
    if (!plusBtn) {
      Core.notifyStopped('rejob', '행동력 "+" 버튼을 찾지 못했습니다 (여러 번 재시도 후에도 실패).');
      return;
    }
    if (!(await Core.safeClick(() => mod.findEnergyPlusButton(), {
      beforeMin: mod.config.clickDelay[0],
      beforeMax: mod.config.clickDelay[1],
    }))) {
      Core.notifyStopped('rejob', '행동력 "+" 버튼이 클릭 직전에 사라졌습니다.');
      return false;
    }

    const dialogFound = await Core.retryStep('활력의 포션 팝업 열림 확인', () =>
      Core.bodyText().includes('활력의 포션 사용') ? true : null
    );
    if (!dialogFound) {
      Core.notifyStopped('rejob', '활력의 포션 선택 팝업이 뜨지 않았습니다 (여러 번 재시도 후에도 실패).');
      return;
    }

    const dialogEl = await Core.retryStep('활력의 포션 팝업 컨테이너 찾기', () => {
      const candidates = [...document.querySelectorAll('*')].filter((el) => {
        if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
        if (!el.textContent.includes('활력의 포션 사용')) return false;
        if (!el.textContent.includes('보유:')) return false;
        const hasUseButton = [...el.querySelectorAll('button')].some((b) => b.textContent.trim() === '사용');
        return hasUseButton;
      });
      if (candidates.length === 0) return null;
      return candidates.reduce((smallest, el) =>
        el.querySelectorAll('*').length < smallest.querySelectorAll('*').length ? el : smallest
      );
    });
    if (!dialogEl) {
      Core.notifyStopped('rejob', '활력의 포션 팝업 컨테이너를 찾지 못했습니다 (여러 번 재시도 후에도 실패).');
      return;
    }

    const boundMatch = dialogEl.textContent.match(/\(귀속\)[\s\S]{0,40}보유:\s*([\d,]+)개/);
    const boundQty = boundMatch ? parseInt(boundMatch[1].replace(/,/g, ''), 10) : 0;

    function findTargetUseButton() {
      const dialogEls = [...dialogEl.querySelectorAll('*')];
      const useBtnEls = dialogEls.filter((el) => el.tagName === 'BUTTON' && el.textContent.trim() === '사용');
      let boundBtn = null;
      let regularBtn = null;
      let segmentStart = 0;
      for (const btn of useBtnEls) {
        const btnIdx = dialogEls.indexOf(btn);
        const segmentText = dialogEls
          .slice(segmentStart, btnIdx)
          .map((e) => (e.children.length === 0 ? e.textContent : ''))
          .join(' ');
        if (segmentText.includes('귀속')) {
          boundBtn = boundBtn || btn;
        } else {
          regularBtn = regularBtn || btn;
        }
        segmentStart = btnIdx + 1;
      }
      return (boundQty > 0 && boundBtn) || regularBtn || boundBtn || useBtnEls[0] || null;
    }

    const targetBtn = await Core.retryStep('활력의 포션 "사용" 버튼 찾기', () => findTargetUseButton(), {
      attempts: 4,
      waits: [500, 1500, 3000, 5000],
    });
    if (!targetBtn) {
      Core.notifyStopped(
        'rejob',
        `활력의 포션 "사용" 버튼을 찾지 못했습니다 (여러 번 재시도 후에도 실패).\n(팝업 내용: ${dialogEl.textContent.slice(0, 200)})`
      );
      return;
    }
    // ⚠ 실전 확인: 이 "사용" 버튼을 단 한 번만 클릭하고 수량 확인
    // 팝업이 안 뜵면 아무 처리 없이(else 분기 자체가 없음) 조용히
    // 다음 단계로 넘어가던 적이 있었다. 클릭이 실제로 안 먹혔을 때도
    // 감지하지 못해 결국 상단 메뉴 클릭까지 실패하는 것이 실전에서 확인됨.
    let qtyDialogEl = null;
    let selectionDialogClosed = false;
    for (let attempt = 1; attempt <= 4 && !qtyDialogEl && !selectionDialogClosed; attempt++) {
      if (!(await Core.safeClick(() => findTargetUseButton(), {
        beforeMin: mod.config.clickDelay[0],
        beforeMax: mod.config.clickDelay[1],
      }))) {
        Core.notifyStopped('rejob', '활력의 포션 "사용" 버튼이 클릭 직전에 사라졌습니다.');
        return false;
      }
      qtyDialogEl = await Core.retryStep('수량 확인 팝업 컨테이너 찾기', () => {
        const marker = [...document.querySelectorAll('*')].find((el) => {
          if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
          return el.textContent.trim() === '사용할 개수';
        });
        if (!marker) return null;
        return marker.closest('[role="dialog"]') || marker.closest('.MuiDialogContent-root') || marker.parentElement;
      }, { attempts: 2, waits: [1000, 2000] });
      if (qtyDialogEl) break;
      selectionDialogClosed = !dialogEl.isConnected || !Core.isElementVisible(dialogEl);
      if (!selectionDialogClosed) {
        Core.log('rejob', `활력의 포션 선택 팝업이 그대로 남아 있어 "사용" 버튼을 다시 클릭합니다 (${attempt}/4).`);
      }
    }
    if (!qtyDialogEl && !selectionDialogClosed) {
      Core.notifyStopped('rejob', '"활력의 포션 사용" 선택 팝업이 여러 번 클릭해도 닫히지 않았습니다.');
      return false;
    }
    if (!qtyDialogEl) {
      Core.log('rejob', '수량 확인 팝업 없이 선택 팝업이 닫힘 (바로 소모되는 케이스로 추정)');
      await Core.waitForNoOpenDialog();
    }

    if (qtyDialogEl) {
      const qtyInput = qtyDialogEl.querySelector('input[type="number"]');
      let useQty = null;
      if (qtyInput) {
        const holdMatch = qtyDialogEl.textContent.match(/보유 수량:\s*([\d,]+)개/);
        const held = holdMatch ? parseInt(holdMatch[1].replace(/,/g, ''), 10) : 1;
        useQty = Math.min(3, held);
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(qtyInput, useQty);
        qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
        await mod.clickDelayWait();
      } else {
        Core.log('rejob', '수량 입력칸을 찾지 못함 (수량을 물어보지 않는 케이스로 추정) → 기본값으로 확인 버튼만 클릭');
      }
      // 입력칸 유무와 무관하게 "사용" 확인 버튼은 항상 클릭해야 실제로 포션이 소모됨
      const confirmBtn = await Core.retryStep('수량 확인 팝업의 "사용" 버튼 찾기', () =>
        [...qtyDialogEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용') || null
      );
      if (confirmBtn) {
        const clicked = await Core.safeClick(
          () => [...qtyDialogEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용') || null,
          { beforeMin: mod.config.clickDelay[0], beforeMax: mod.config.clickDelay[1] }
        );
        if (!clicked) {
          Core.notifyStopped('rejob', '수량 확인 팝업의 "사용" 버튼이 클릭 직전에 사라졌습니다.');
          return false;
        }
        // ⚠ 위와 같은 이유로 팝업이 실제로 닫힐는지 확인한다.
        await Core.waitForNoOpenDialog();
        mod.energyRefillStreak += 1;
        Core.log('rejob', useQty !== null ? `활력의 포션 ${useQty}개 사용 완료` : '활력의 포션 사용 완료');
      } else {
        Core.notifyStopped('rejob', '수량 확인 팝업에서 "사용" 버튼을 찾지 못했습니다 (여러 번 재시도 후에도 실패).');
        return false;
      }
    }
    const increasedEnergy = await Core.waitFor(() => {
      const current = mod.parseEnergy();
      return current !== null && current > energy ? current : null;
    }, 10000, 400);
    if (increasedEnergy === null) {
      Core.notifyStopped('rejob', '활력의 포션 사용 후 행동력 증가를 확인하지 못했습니다.');
      return false;
    }
    return true;
  };

  Modules.rejob.doRejob = async function () {
    const mod = this;
    Core.log('rejob', '전직의 신전으로 이동');
    await Core.clickNavMenuExact('캐릭', '전직의 신전');
    await Core.waitFor(() => Core.bodyText().includes('전직 가능 직업'));

    if (Core.bodyText().includes('50레벨 이상에서만 전직이 가능합니다')) {
      Core.log('rejob', '현재 레벨이 50 미만이라 재전직 불가 → 이번 사이클은 재전직 건너뛰고 사냥만 진행');
      return 'skip';
    }

    const jobMatch = Core.bodyText().match(/현재 직업:\s*\n?\s*([^\n]+)/);
    const currentJob = jobMatch ? jobMatch[1].trim() : null;
    if (!currentJob) {
      Core.notifyStopped('rejob', '현재 직업 텍스트를 읽지 못했습니다.');
      return false;
    }
    if (mod.expectedJobName === null) {
      mod.expectedJobName = currentJob;
      Core.log('rejob', `직업 자동 감지: ${mod.expectedJobName}`);
    } else if (currentJob !== mod.expectedJobName) {
      Core.notifyStopped('rejob', `예상한 직업(${mod.expectedJobName})과 다른 직업(${currentJob})이 감지되었습니다.`);
      return false;
    }

    const cardHeading = await Core.retryStep(
      `"${mod.expectedJobName} (5차)" 카드 찾기`,
      () =>
        [...document.querySelectorAll('h6, h5, h4')].find((h) => h.textContent.trim() === `${mod.expectedJobName} (5차)`) ||
        [...document.querySelectorAll('h6, h5, h4')].find(
          (h) => h.textContent.includes(mod.expectedJobName) && h.textContent.includes('(5차)')
        ) ||
        null
    );
    if (!cardHeading) {
      Core.notifyStopped('rejob', `"${mod.expectedJobName} (5차)" 카드를 찾지 못했습니다 (여러 번 재시도 후에도 실패).`);
      return false;
    }
    cardHeading.click();
    await mod.clickDelayWait();

    const enabled = await Core.retryStep('"전직하기" 버튼 활성화 대기', () => {
      const btn = Core.findButtonByText('전직하기');
      return btn && !btn.disabled ? btn : null;
    });
    if (!enabled) {
      Core.notifyStopped('rejob', '"전직하기" 버튼이 활성화되지 않았습니다 (여러 번 재시도 후에도 실패).');
      return false;
    }
    enabled.click();
    await mod.clickDelayWait();

    // ⚠ 실전 확인: 이 확인창은 보통 1초 안에 뜵지만, 서버 응답이 느린 때는
    // 기존 재시도 예산(기본값 약 20초)을 넘어 실패로 보고되는 것이 실전에서 확인됨.
    // 실제로는 전직이 이미 성공해 있을 가능성이 높으니(본도 후 상태를 되돌리면 더
    // 위험하다), 포기하기 전에 더 오래, 더 자주 확인한다(최대 약 45초).
    const successToast = await Core.retryStep(
      '전직 완료 확인',
      () => (Core.bodyText().includes('전직 완료') ? true : null),
      { attempts: 6, waits: [1000, 2000, 3000, 5000, 8000, 12000] }
    );
    if (!successToast) {
      Core.notifyStopped('rejob', '전직 완료 확인을 못했습니다 (여러 번 재시도 후에도 실패).');
      return false;
    }
    Core.log('rejob', '재전직 성공');

    const confirmBtn = await Core.waitFor(() => Core.findButtonByText('확인'));
    if (confirmBtn) {
      confirmBtn.click();
      await mod.clickDelayWait();
    }
    return true;
  };

  Modules.rejob.doHunt = async function () {
    const mod = this;
    const useOverride = mod.nextTierIndexOverride !== null;
    const tier = useOverride ? mod.TIERS[mod.nextTierIndexOverride] : mod.TIERS[mod.config.tierIndex];
    mod.nextTierIndexOverride = null;

    Core.log('rejob', `전투 → ...${tier.short} 이동`);
    await Core.clickNavMenuSuffix('전투', tier.short);
    await Core.waitFor(() => Core.bodyText().includes(`${tier.short} × 50`) || Core.bodyText().includes(tier.short));

    const huntBtn = await Core.retryStep(`"${tier.short} × 50" 버튼 찾기`, () =>
      [...document.querySelectorAll('button')].find((b) => new RegExp(`^${tier.short}\\s*[×xX]\\s*50$`).test(b.textContent.trim())) ||
      null
    );
    if (!huntBtn) {
      Core.notifyStopped('rejob', `"${tier.short} × 50" 버튼을 찾지 못했습니다 (여러 번 재시도 후에도 실패).`);
      return null;
    }
    huntBtn.click();
    await mod.clickDelayWait();

    let resultShown = await Core.retryStep(
      '사냥 결과 화면 확인',
      () => (/레벨\s*1\s*→\s*\d+\s*달성|전투\s*후\s*중단|\d+\s*회\s*전투\s*완료/.test(Core.bodyText()) ? true : null),
      { attempts: 4, waits: [3000, 5000, 8000, 12000] }
    );
    if (!resultShown) {
      Core.notifyStopped('rejob', '사냥 결과 화면을 확인하지 못했습니다 (여러 번 재시도 후에도 실패).');
      return null;
    }

    let repairAttempts = 0;
    while (Core.bodyText().includes('장비 내구도 부족') && repairAttempts < 3) {
      await Core.repairAllEquipment('rejob');
      repairAttempts += 1;
      const huntBtnAgain = await Core.waitFor(() =>
        [...document.querySelectorAll('button')].find((b) => new RegExp(`^${tier.short}\\s*[×xX]\\s*50$`).test(b.textContent.trim()))
      );
      if (!huntBtnAgain) break;
      huntBtnAgain.click();
      await mod.clickDelayWait();
      resultShown = await Core.waitFor(() => /레벨\s*1\s*→\s*\d+\s*달성|전투\s*후\s*중단|\d+\s*회\s*전투\s*완료/.test(Core.bodyText()), 15000);
      if (!resultShown) break;
    }

    if (!resultShown || Core.bodyText().includes('장비 내구도 부족')) {
      Core.notifyStopped('rejob', '장비 수리 후에도 정상적인 사냥 결과를 확인하지 못했습니다.');
      return null;
    }

    const text = Core.bodyText();
    mod.energyRefillStreak = 0;
    const levelMatch = text.match(/레벨\s*\/\s*경험치[^\d]*(\d+)/);
    const goldMatch = text.match(/골드\s*\n?\s*([\d,]+)/);
    const potionMatch = text.match(/농축 경험의 물약 효과 \(5배\):\s*([\d,]+)회 남음/);
    const mpPotionMatch = text.match(/MP\s*포션:\s*[\d,]+\s*사용\s*\(([\d,]+)\s*남음\)/);

    return {
      level: levelMatch ? parseInt(levelMatch[1], 10) : null,
      gold: goldMatch ? parseInt(goldMatch[1].replace(/,/g, ''), 10) : null,
      potionRemaining: potionMatch ? parseInt(potionMatch[1].replace(/,/g, ''), 10) : null,
      mpPotionRemaining: mpPotionMatch ? parseInt(mpPotionMatch[1].replace(/,/g, ''), 10) : null,
      tierUsed: tier,
    };
  };

  Modules.rejob.getHiddenRoomMapOption = function (dialog) {
    const candidates = [...dialog.querySelectorAll('*')].filter((el) => {
      if (!el.textContent.includes('숨겨진 방의 지도')) return false;
      return !!el.querySelector('.MuiRadio-root');
    });
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a.querySelectorAll('*').length < b.querySelectorAll('*').length ? a : b));
  };

  Modules.rejob.isHiddenRoomMapExhausted = function (optionEl) {
    if (/[xX]\s*0\b/.test(optionEl.textContent)) return true;
    const radioInput = optionEl.querySelector('.MuiRadio-root input');
    if (radioInput && radioInput.disabled) return true;
    return false;
  };

  Modules.rejob.findEnlightenmentTowerButton = function () {
    const container = Modules.raremap.getMineContainer();
    if (!container) return null;
    return (
      [...container.querySelectorAll('button.MuiButton-fullWidth')].find((b) => b.textContent.includes('깨달음의 방')) || null
    );
  };

  Modules.rejob.doHiddenRoomHunt = async function () {
    const mod = this;
    Core.log('rejob', '광산으로 이동 (숨겨진 방의 지도 사용)');
    try {
      await Core.clickNavMenuSuffix('전투', '광산');
    } catch (e) {
      Core.notifyStopped('rejob', `광산 이동 실패: ${e.message}`);
      return null;
    }
    await Core.sleep(700);

    const MAX_GENERATE_ATTEMPTS = 3;
    let towerBtn = null;
    for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS && mod.running; attempt++) {
      const mapIcon = await Core.retryStep(
        '지도 아이콘 찾기',
        () => document.querySelector('div[aria-label="지도 아이템을 사용해 레어맵으로 이동하기"]'),
        { attempts: 3, waits: [1000, 2000, 3000] }
      );
      if (!mapIcon) {
        Core.notifyStopped('rejob', '지도 아이콘을 찾지 못했습니다.');
        return null;
      }
      mapIcon.click();
      await mod.clickDelayWait();

      const dialog = await Core.retryStep('"지도 아이템 사용하기" 모달 찾기', () => {
        const titleEl = [...document.querySelectorAll('h1, h2, h3')].find((el) => el.textContent.trim() === '지도 아이템 사용하기');
        return titleEl ? titleEl.closest('[role="dialog"]') : null;
      });
      if (!dialog) {
        Core.log('rejob', `지도 아이템 모달을 찾지 못했습니다 (시도 ${attempt}/${MAX_GENERATE_ATTEMPTS}).`);
        await Core.sleep(1500);
        continue;
      }

      const option = await Core.retryStep('"숨겨진 방의 지도" 항목 찾기', () => mod.getHiddenRoomMapOption(dialog), {
        attempts: 3,
        waits: [800, 1500, 2500],
      });
      if (!option) {
        Core.notifyStopped('rejob', '"숨겨진 방의 지도" 항목을 모달에서 찾지 못했습니다 (화면 구조가 다를 수 있음).');
        return null;
      }
      if (mod.isHiddenRoomMapExhausted(option)) {
        Core.notifyCompleted('rejob', '숨겨진 방의 지도를 모두 사용했습니다 (재고 없음). 정지합니다.');
        return null;
      }
      const radioEl = option.querySelector('.MuiRadio-root');
      radioEl.click();
      await mod.clickDelayWait();

      const useBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용하기');
      if (!useBtn) {
        Core.notifyStopped('rejob', '"사용하기" 버튼을 찾지 못했습니다.');
        return null;
      }
      useBtn.click();
      await mod.clickDelayWait();

      towerBtn = await Core.retryStep('"깨달음의 방" 버튼 찾기', () => mod.findEnlightenmentTowerButton());
      if (towerBtn) break;

      Core.log(
        'rejob',
        `"깨달음의 방"이 생성된 것을 확인하지 못했습니다 (시도 ${attempt}/${MAX_GENERATE_ATTEMPTS}) - 처음부터 다시 시도합니다.`
      );
      const leftoverDialog = [...document.querySelectorAll('h1, h2, h3')].find(
        (el) => el.textContent.trim() === '지도 아이템 사용하기'
      );
      if (leftoverDialog) {
        const dlg = leftoverDialog.closest('[role="dialog"]');
        const cancelBtn = dlg && [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === '취소');
        if (cancelBtn) {
          cancelBtn.click();
          await mod.clickDelayWait();
        }
      }
      await Core.sleep(1500);
    }
    if (!towerBtn) {
      Core.notifyStopped('rejob', `"깨달음의 방"이 생성된 것을 확인하지 못했습니다 (${MAX_GENERATE_ATTEMPTS}번 재시도 후에도 실패).`);
      return null;
    }
    towerBtn.click();
    await mod.clickDelayWait();

    let resultShown = await Core.retryStep(
      '깨달음의 방 전투 결과 화면 확인',
      () => (/레벨\s*1\s*→\s*\d+\s*달성|전투\s*후\s*중단|\d+\s*회\s*전투\s*완료/.test(Core.bodyText()) ? true : null),
      { attempts: 4, waits: [2000, 4000, 6000, 9000] }
    );
    if (!resultShown) {
      Core.notifyStopped('rejob', '깨달음의 방 전투 결과 화면을 확인하지 못했습니다.');
      return null;
    }

    let repairAttempts = 0;
    while (Core.bodyText().includes('장비 내구도 부족') && repairAttempts < 3) {
      await Core.repairAllEquipment('rejob');
      repairAttempts += 1;
      const towerBtnAgain = await Core.waitFor(() => mod.findEnlightenmentTowerButton());
      if (!towerBtnAgain) break;
      towerBtnAgain.click();
      await mod.clickDelayWait();
      resultShown = await Core.waitFor(
        () => /레벨\s*1\s*→\s*\d+\s*달성|전투\s*후\s*중단|\d+\s*회\s*전투\s*완료/.test(Core.bodyText()),
        15000
      );
      if (!resultShown) break;
    }
    if (!resultShown) {
      Core.notifyStopped('rejob', '장비 수리 후에도 깨달음의 방 전투 결과 화면을 확인하지 못했습니다.');
      return null;
    }

    const text = Core.bodyText();
    const levelMatch = text.match(/레벨\s*\/\s*경험치[^\d]*(\d+)/);
    const goldMatch = text.match(/골드\s*\n?\s*([\d,]+)/);
    const potionMatch = text.match(/농축 경험의 물약 효과 \(5배\):\s*([\d,]+)회 남음/);

    return {
      level: levelMatch ? parseInt(levelMatch[1], 10) : null,
      gold: goldMatch ? parseInt(goldMatch[1].replace(/,/g, ''), 10) : null,
      potionRemaining: potionMatch ? parseInt(potionMatch[1].replace(/,/g, ''), 10) : null,
      tierUsed: { short: '숨겨진 방(깨달음의 방)' },
      viaHiddenRoomMap: true,
    };
  };

  Modules.rejob.refillExpPotion = async function () {
    const mod = this;
    Core.log('rejob', '농축 경험의 물약 보충 시도 (인벤토리 이동)');
    await Core.clickNavMenuExact('캐릭', '인벤토리');
    await Core.waitFor(() => Core.bodyText().includes('보유 아이템'));

    const consumTab = Core.findButtonByText('소모품') || Core.findByExactText('button, [role="tab"]', '소모품');
    if (consumTab) {
      consumTab.click();
      await Core.humanDelay(500, 1000);
    }

    const rowContainer = await Core.retryStep('농축 경험의 물약 항목 컨테이너 찾기', () => {
      const candidates = [...document.querySelectorAll('*')].filter((el) => {
        if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
        if (!el.textContent.trim().startsWith('농축 경험의 물약')) return false;
        return [...el.querySelectorAll('button')].some((b) => b.textContent.trim() === '사용');
      });
      if (candidates.length === 0) return null;
      return candidates.reduce((a, b) => (a.querySelectorAll('*').length < b.querySelectorAll('*').length ? a : b));
    });
    if (!rowContainer) {
      Core.notifyStopped('rejob', '"농축 경험의 물약" 항목을 찾지 못했습니다 (없거나 화면 구조가 다를 수 있음).');
      return false;
    }
    if (/x\s*0\b|보유:\s*0\b/.test(rowContainer.textContent)) {
      Core.notifyStopped('rejob', '농축 경험의 물약 없음! 수동으로 채워주세요.');
      return false;
    }

    let confirmClicked = false;
    const MAX_USE_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_USE_ATTEMPTS && !confirmClicked; attempt++) {
      // 오래된 요소 참조를 재사용하지 않도록 매 시도마다 행(row)과 "사용" 버튼을 새로 찾음
      const row = [...document.querySelectorAll('*')].filter((el) => {
        if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
        if (!el.textContent.trim().startsWith('농축 경험의 물약')) return false;
        return [...el.querySelectorAll('button')].some((b) => b.textContent.trim() === '사용');
      }).reduce((a, b) => (!a ? b : a.querySelectorAll('*').length < b.querySelectorAll('*').length ? a : b), null);
      const freshUseBtn = row && [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용');
      if (!freshUseBtn) {
        Core.notifyStopped('rejob', '농축 경험의 물약 "사용" 버튼을 찾지 못했습니다 (재시도 중).');
        return false;
      }
      freshUseBtn.click();
      await mod.clickDelayWait();

      const qtyDialogEl = await Core.retryStep(
        '농축 경험의 물약 수량 확인 팝업 찾기',
        () => {
          const marker = [...document.querySelectorAll('*')].find((el) => {
            if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
            return el.textContent.trim() === '사용할 개수';
          });
          if (!marker) return null;
          // 버그 수정: 활력의 포션 팝업과 동일한 원인(라벨 <p> 자체가 선택되어 그 안에 input/button이 없었음).
          // 실제 입력칸/버튼이 있는 role="dialog" 조상을 직접 찾도록 변경.
          return marker.closest('[role="dialog"]') || marker.closest('.MuiDialogContent-root') || marker.parentElement;
        },
        { attempts: 2, waits: [800, 1500] }
      );

      // 사용자 제보: 라니스 자체의 타이밍성 버그로, "사용"을 눌렀을 때 의도한 "농축 경험의 물약"이 아니라
      // 엉뚱한 다른 아이템(예: 그냥 "경험의 물약")의 확인 팝업이 뜨는 경우가 있음(매크로만의 문제가 아니라
      // 게임 자체에서 다른 캐릭터로도 재현됨). 팝업이 실제로 "농축 경험의 물약"을 언급하는지 확인하고,
      // 아니면 취소한 뒤 처음부터(행/버튼 재탐색) 다시 시도.
      const dialogTextNow = qtyDialogEl ? qtyDialogEl.textContent : Core.bodyText();
      if (!dialogTextNow.includes('농축 경험의 물약')) {
        Core.log(
          'rejob',
          `농축 경험의 물약을 눌렀는데 다른 아이템 확인 팝업이 떴습니다(라니스 자체 타이밍 이슈로 추정) → 취소 후 재시도 (${attempt}/${MAX_USE_ATTEMPTS})`
        );
        const cancelBtn =
          (qtyDialogEl && [...qtyDialogEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '취소')) ||
          Core.findButtonByText('취소');
        if (cancelBtn) {
          cancelBtn.click();
          await mod.clickDelayWait();
        }
        await Core.sleep(1000);
        continue;
      }

      if (qtyDialogEl) {
        const qtyInput = qtyDialogEl.querySelector('input[type="number"]');
        if (qtyInput) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          let qtyConfirmedAs1 = false;
          for (let setAttempt = 1; setAttempt <= 3 && !qtyConfirmedAs1; setAttempt++) {
            nativeSetter.call(qtyInput, 1);
            qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
            qtyInput.dispatchEvent(new Event('change', { bubbles: true }));
            await mod.clickDelayWait();
            qtyConfirmedAs1 = qtyInput.value === '1' || qtyInput.value === 1;
            if (!qtyConfirmedAs1) {
              Core.log('rejob', `수량 입력칸이 아직 1로 안 바뀜(현재: "${qtyInput.value}") - 재시도 (${setAttempt}/3)`);
            }
          }
          if (!qtyConfirmedAs1) {
            const cancelBtn = [...qtyDialogEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '취소');
            if (cancelBtn) cancelBtn.click();
            Core.notifyStopped(
              'rejob',
              `농축 경험의 물약 수량을 1로 확정하지 못해(현재 값: "${qtyInput.value}") 안전을 위해 확인 없이 취소하고 정지합니다.`
            );
            return false;
          }
        }
        const qtyConfirmBtn = await Core.retryStep('수량 확인 팝업의 "사용" 버튼 찾기', () =>
          [...qtyDialogEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용') || null
        );
        if (qtyConfirmBtn) {
          const finalInput = qtyDialogEl.querySelector('input[type="number"]');
          if (finalInput && finalInput.value !== '1' && finalInput.value !== 1) {
            const cancelBtn = [...qtyDialogEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '취소');
            if (cancelBtn) cancelBtn.click();
            Core.notifyStopped(
              'rejob',
              `확인 직전 최종 점검에서 수량이 "1"이 아님("${finalInput.value}")을 발견해 확인 없이 취소하고 정지합니다.`
            );
            return false;
          }
          qtyConfirmBtn.click();
          await mod.clickDelayWait();
          // ⚠ 팝업이 실제로 닫힐는지 확인하지 않고 넘어가면, 닫히는
          // 애니메이션 중 배경이 일시적으로 aria-hidden 처리된 채 남아
          // 있을 수 있다(다음 사이클의 "칵리" 메뉴 클릭이 가끔 실패하는
          // 원인으로 추정됨).
          await Core.waitForNoOpenDialog();
          confirmClicked = true;
        }
      } else {
        const confirmBtn = await Core.retryStep(
          '농축 경험의 물약 사용 확인 팝업의 확인 버튼 찾기',
          () => {
            if (!Core.bodyText().includes('농축 경험의 물약') || !Core.bodyText().includes('사용하시겠습니까')) return null;
            // 실측 결과: 이 팝업은 수량을 묻지 않고 바로 "아이템 사용" 확인 팝업으로 뜨며,
            // 버튼 라벨이 "사용"이 아니라 "확인"임(취소/확인 2개 버튼). 두 라벨 모두 대응.
            return (
              Core.findButtonInDialog('사용하시겠습니까', '확인') || Core.findButtonInDialog('사용하시겠습니까', '사용')
            );
          },
          { attempts: 2, waits: [800, 1500] }
        );
        if (confirmBtn) {
          confirmBtn.click();
          await mod.clickDelayWait();
          await Core.waitForNoOpenDialog();
          confirmClicked = true;
        }
      }
    }
    if (!confirmClicked) {
      // 버그 수정: 이전에는 버튼을 못 찾아도 무조건 "사용 완료"로 로그를 남겨서, 실제로는 포션이
      // 전혀 소모되지 않았는데도 성공한 것처럼 보이는 문제가 있었음(잔여 횟수가 계속 0/null로 남아
      // 5배 경험치 버프 없이 사냥이 진행되던 근본 원인).
      Core.notifyStopped(
        'rejob',
        '농축 경험의 물약을 사용하지 못했습니다 (확인 버튼을 못 찾았거나, 계속 엉뚱한 아이템 팝업이 떠서 여러 번 재시도 후에도 실패).'
      );
      return false;
    }
    Core.log('rejob', '농축 경험의 물약 1개 사용 완료');
    return true;
  };

  Modules.rejob.checkStrongScore = async function () {
    Core.log('rejob', '내 정보에서 강함 점수 확인');
    await Core.clickNavMenuExact('캐릭', '내 정보');
    await Core.waitFor(() => Core.bodyText().includes('강함 점수'));

    const match = await Core.retryStep('강함 점수 텍스트 찾기', () => {
      const m = Core.bodyText().match(/강함 점수:\s*([\d,]+)/);
      return m || null;
    });
    if (!match) {
      Core.notifyStopped('rejob', '강함 점수를 읽지 못했습니다 (여러 번 재시도 후에도 실패).');
      return null;
    }
    const score = parseInt(match[1].replace(/,/g, ''), 10);
    Core.log('rejob', `현재 강함 점수: ${score.toLocaleString()} (목표: ${this.config.targetScore.toLocaleString()})`);
    return score;
  };

  Modules.rejob.finishCycleCommon = async function (result) {
    const mod = this;
    if (result.gold !== null && result.gold > 1000000) {
      await Core.bankDepositAll('rejob');
    }
    if (!mod.running) return;

    const score = await mod.checkStrongScore();
    if (score !== null && score >= mod.config.targetScore) {
      Core.notifyCompleted(
        'rejob',
        `강함 점수 ${score.toLocaleString()}이(가) 목표치(${mod.config.targetScore.toLocaleString()})를 초과했습니다! 목표를 달성하여 정지합니다.`
      );
      return;
    }

    mod.cycleCount += 1;
    Core.updateModuleButtons();

    if (mod.config.maxRejobCount > 0 && mod.cycleCount >= mod.config.maxRejobCount) {
      Core.notifyCompleted('rejob', `설정하신 최대 재전직 횟수(${mod.config.maxRejobCount})에 도달하여 정지합니다.`);
      return;
    }

    if (!Number.isFinite(mod.nextRestAt)) {
      mod.nextRestAt = mod.cycleCount + Core.rand(mod.config.restEvery[0], mod.config.restEvery[1]);
    }
    if (mod.cycleCount >= mod.nextRestAt) {
      const restSec = Core.rand(mod.config.restSeconds[0], mod.config.restSeconds[1]);
      Core.log('rejob', `${mod.cycleCount}사이클 도달 → ${restSec}초 휴식`);
      if (!(await Core.interruptibleSleep(
        restSec * 1000,
        () => mod.stopRequested || !mod.running
      ))) return;
      mod.nextRestAt = mod.cycleCount + Core.rand(mod.config.restEvery[0], mod.config.restEvery[1]);
    }
  };

  Modules.rejob.runCycle = async function () {
    const mod = this;
    if (!mod.skipRejobThisCycle) {
      const ok = await mod.doRejob();
      if (!ok || !mod.running) return;
    } else {
      Core.log('rejob', '직전 사냥에서 100레벨 미달 → 재전직 생략하고 재사냥만 진행');
    }

    const result = mod.config.useHiddenRoomMap ? await mod.doHiddenRoomHunt() : await mod.doHunt();
    if (!result || !mod.running) return;

    if (result.viaHiddenRoomMap) {
      Core.log('rejob', `결과(숨겨진 방의 지도) - 레벨:${result.level} 골드:${result.gold?.toLocaleString()}`);
      mod.skipRejobThisCycle = false;
      await mod.finishCycleCommon(result);
      return;
    }

    Core.log(
      'rejob',
      `결과 - 레벨:${result.level} 골드:${result.gold?.toLocaleString()} 농축물약잔여:${result.potionRemaining} MP포션잔여:${
        result.mpPotionRemaining ?? '알 수 없음'
      }`
    );

    if (result.level === null || !Number.isFinite(result.level)) {
      throw new Error('사냥 결과에서 레벨을 읽지 못했습니다. 화면 갱신 후 다시 시도합니다.');
    }

    if (result.level < 100) {
      Core.log('rejob', `레벨 ${result.level} (100 미달) → ${result.tierUsed.short}에서 사망 추정, 한 단계 아래 사냥터로 재시도`);
      const idx = mod.TIERS.findIndex((t) => t.short === result.tierUsed.short);
      mod.nextTierIndexOverride = Math.max(0, idx - 1);
      mod.skipRejobThisCycle = true;
      // ⚠ 사용자 요청: 황력의 포션/농축 경험의 물약 팝업 자동 클릭이
      // 게임 UI가 바뀌끔마다 계속 깨져서 반복적으로 멈춤. 자동 "사용" 클릭은
      // 완전히 제거하고, 잔량만 확인해 부족하면 로그로 알리고 정지한다
      // (실제 사용은 사용자가 직접 한다).
      if (result.gold !== null && result.gold > 1000000) {
        await Core.bankDepositAll('rejob');
      }
      if (!mod.running) return;
      if (!mod.checkExpPotionAndStopIfLow(result.potionRemaining)) return;
      if (!mod.running) return;
      if (!mod.checkEnergyAndStopIfLow()) return;
      return;
    }
    mod.skipRejobThisCycle = false;
    if (!mod.running) return;

    // ⚠ 사용자 확인: 물약/행동력 체크가 정지를 유발하면서 입금보다 먼저
    // 실행되면, 입금(finishCycleCommon 안에 있음)까지 도달하기 전에 멈춰버려 골드가
    // 은행에 안 들어가는 문제가 실전에서 확인됨. 입금을 먼저 처리해 이 문제를 막는다.
    if (result.gold !== null && result.gold > 1000000) {
      await Core.bankDepositAll('rejob');
    }
    if (!mod.running) return;

    if (!mod.checkExpPotionAndStopIfLow(result.potionRemaining)) return;
    if (!mod.running) return;

    if (!mod.checkEnergyAndStopIfLow()) return;
    if (!mod.running) return;

    await mod.finishCycleCommon(result);
  };

  Modules.rejob.mainLoop = async function () {
    const mod = this;
    let consecutiveFailures = 0;
    const maxRetries = 3;
    while (mod.running) {
      try {
        await mod.runCycle();
        consecutiveFailures = 0;
      } catch (e) {
        consecutiveFailures += 1;
        Core.log('rejob', `오류 발생 (${consecutiveFailures}/${maxRetries}번째 연속): ${e.message}`);
        if (consecutiveFailures >= maxRetries) {
          Core.notifyStopped('rejob', `같은 오류가 ${maxRetries}번 연속 발생하여 정지합니다: ${e.message}`);
          break;
        }
        Core.log('rejob', '10초 대기 후 이번 사이클 재시도');
        if (!(await Core.interruptibleSleep(
          10000,
          () => mod.stopRequested || !mod.running
        ))) break;
      }
      await mod.clickDelayWait();
    }
  };


  const REJOB_PERSIST_KEYS = ['targetScore', 'tierIndex', 'maxRejobCount', 'useHiddenRoomMap'];

  function buildRejobTab(container) {
    const mod = Modules.rejob;
    const refs = UIRefs.rejob;
    Core.loadModuleConfig('rejob', REJOB_PERSIST_KEYS);
    container.appendChild(labelEl('목표 강함점수'));
    const scoreInput = document.createElement('input');
    scoreInput.type = 'number';
    scoreInput.min = '0';
    scoreInput.step = '100';
    scoreInput.value = mod.config.targetScore;
    scoreInput.title = '클릭 후 원하는 점수를 직접 입력할 수 있습니다. 화살표는 100점씩 증감합니다.';
    scoreInput.style.cssText = inputStyle();
    // 기존 값 위에 바로 새 점수를 입력할 수 있게 첫 포커스에서 전체 선택.
    // 화살표만 사용하더라도 기본 1점이 아니라 100점씩 증감한다.
    scoreInput.addEventListener('focus', (e) => e.target.select());
    scoreInput.addEventListener('input', (e) => {
      const value = parseInt(e.target.value, 10);
      if (!Number.isFinite(value) || value < 0) return;
      mod.config.targetScore = value;
      Core.saveModuleConfig('rejob', REJOB_PERSIST_KEYS);
    });
    scoreInput.addEventListener('change', (e) => {
      const value = parseInt(e.target.value, 10);
      if (!Number.isFinite(value) || value < 0) {
        e.target.value = mod.config.targetScore;
      }
    });
    container.appendChild(scoreInput);

    container.appendChild(labelEl('사냥터'));
    const tierSelect = document.createElement('select');
    tierSelect.style.cssText = inputStyle();
    mod.TIERS.forEach((t, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = t.short;
      if (i === mod.config.tierIndex) o.selected = true;
      tierSelect.appendChild(o);
    });
    tierSelect.addEventListener('change', (e) => {
      mod.config.tierIndex = parseInt(e.target.value, 10);
      Core.saveModuleConfig('rejob', REJOB_PERSIST_KEYS);
    });
    container.appendChild(tierSelect);

    container.appendChild(labelEl('최대 재전직 횟수 (0=무제한)'));
    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.value = mod.config.maxRejobCount;
    maxInput.style.cssText = inputStyle();
    maxInput.addEventListener('change', (e) => {
      mod.config.maxRejobCount = parseInt(e.target.value, 10) || 0;
      Core.saveModuleConfig('rejob', REJOB_PERSIST_KEYS);
    });
    container.appendChild(maxInput);

    const hiddenRoomRow = document.createElement('div');
    hiddenRoomRow.style.cssText = 'display:flex; align-items:center; gap:6px; margin:4px 0;';
    const hiddenRoomCheck = document.createElement('input');
    hiddenRoomCheck.type = 'checkbox';
    hiddenRoomCheck.checked = mod.config.useHiddenRoomMap;
    hiddenRoomCheck.addEventListener('change', (e) => {
      mod.config.useHiddenRoomMap = e.target.checked;
      Core.saveModuleConfig('rejob', REJOB_PERSIST_KEYS);
    });
    const hiddenRoomLabel = document.createElement('span');
    hiddenRoomLabel.textContent = '숨겨진 방의 지도로 사냥 대체 (광산 지도 → 깨달음의 방, 1전투로 즉시 레벨100)';
    hiddenRoomLabel.style.cssText = 'font-size:11px; color:#ccc;';
    hiddenRoomRow.appendChild(hiddenRoomCheck);
    hiddenRoomRow.appendChild(hiddenRoomLabel);
    container.appendChild(hiddenRoomRow);

    const safetyRow = document.createElement('label');
    safetyRow.style.cssText = 'display:flex; align-items:center; gap:6px; margin:7px 0 4px; color:#ffcc80; font-size:11px; cursor:pointer;';
    const safetyCheck = document.createElement('input');
    safetyCheck.type = 'checkbox';
    safetyCheck.checked = false; // 저장하지 않음: 새로고침하면 항상 해제
    const safetyText = document.createElement('span');
    safetyText.textContent = '재전직 시작 안전 확인 (체크해야 시작 가능)';
    safetyRow.appendChild(safetyCheck);
    safetyRow.appendChild(safetyText);
    container.appendChild(safetyRow);

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
    safetyCheck.addEventListener('change', () => {
      Core.hideBanner();
      Core.updateModuleButtons();
    });
    startBtn.addEventListener('click', () => Core.startModule('rejob'));
    stopBtn.addEventListener('click', () => Core.requestStopModule('rejob'));
    btnRow.appendChild(startBtn);
    btnRow.appendChild(stopBtn);
    container.appendChild(btnRow);
    container.appendChild(statusEl);

    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.safetyCheck = safetyCheck;
    refs.inputs = [scoreInput, tierSelect, maxInput, hiddenRoomCheck, safetyCheck];
    Core.updateModuleButtons();
  }
