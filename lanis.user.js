// ==UserScript==
// @name         lanis
// @namespace    lanis
// @version      1.1
// @description  재전직 / 자동사냥 / 레어맵 매크로를 하나의 패널로 통합. 탭으로 전환, 패널 위치 저장, 동시에 하나의 모듈만 실행되도록 보호.
// @match        https://lanis.me/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Ke9318/lanis/main/lanis.user.js
// @downloadURL  https://raw.githubusercontent.com/Ke9318/lanis/main/lanis.user.js
// ==/UserScript==

// ============================================================================
// 통합 매크로 v1.1
// v1.0 대비 수정 사항:
//   1) [재전직] 직업명 파싱 정규식이 \S+ 라서 두 단어 이상인 직업명(예: "○○ ○○")은
//      첫 단어만 잘려서 저장됨 → 이후 "직업명 (5차)" 카드를 절대 못 찾아서(실제로는
//      카드가 있는데 잘린 이름으로 찾으니 매번 실패) 재전직 도중 계속 멈추는 원인이었음.
//      전체 줄을 캡처하도록 정규식 수정 + 카드 검색에 보조(포함 매칭) 로직 추가.
//   2) [자동사냥] 모듈에는 애초에 "농축 경험의 물약" 잔여량을 확인하는 로직이 없었음
//      (재전직 모듈에만 있었음) → 물약이 다 떨어져도 계속 사냥을 반복하던 원인.
//      자동사냥 사이클마다 잔여량을 확인해서 0이 되면 정지하도록 추가.
//   3) [재전직] 활력의 포션 사용 개수가 Math.min(1, held)로 고정되어 있어 항상 1개씩만
//      사용됨 → 3개씩 사용하도록 변경(Math.min(3, held)).
// ============================================================================

(function () {
  'use strict';

  // ==========================================================================
  // Core: 모든 모듈이 공유하는 유틸리티
  // ==========================================================================
  const Core = {
    activeModuleId: null, // 지금 실행 중인 모듈 id (null = 아무것도 실행 중이 아님)
    panelEl: null,
    logEl: null,
    bannerEl: null,
    originalTitle: document.title,
    titleFlashInterval: null,
  };

  const PANEL_POS_KEY = 'lrm-unified-panel-pos'; // 패널 위치 저장용 localStorage 키 (하나의 패널이므로 키도 하나)

  Core.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  Core.rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  Core.humanDelay = (minMs, maxMs) => Core.sleep(minMs + Math.random() * (maxMs - minMs));

  // 패널/배너 자기 자신의 텍스트가 페이지 텍스트 파싱과 혼동되는 걸 막기 위해,
  // 잠깐 숨긴 상태로 읽고 되돌려놓음 (예전 재전직 매크로에서 실제로 겪었던 버그의 재발 방지)
  Core.bodyText = function () {
    const prevPanelDisplay = Core.panelEl ? Core.panelEl.style.display : null;
    const prevBannerDisplay = Core.bannerEl ? Core.bannerEl.style.display : null;
    if (Core.panelEl) Core.panelEl.style.display = 'none';
    if (Core.bannerEl) Core.bannerEl.style.display = 'none';
    const text = document.body.innerText;
    if (Core.panelEl) Core.panelEl.style.display = prevPanelDisplay;
    if (Core.bannerEl) Core.bannerEl.style.display = prevBannerDisplay;
    return text;
  };

  Core.allButtons = function () {
    return Array.from(document.querySelectorAll('button'));
  };

  Core.findButtonByText = function (text) {
    return Core.allButtons().find((b) => b.textContent.trim() === text) || null;
  };

  Core.findByExactText = function (selector, text) {
    return [...document.querySelectorAll(selector)].find((el) => el.textContent.trim() === text) || null;
  };

  Core.waitFor = async function (fn, timeoutMs = 15000, intervalMs = 250) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = fn();
      if (result) return result;
      await Core.sleep(intervalMs);
    }
    return null;
  };

  // 타이밍에 예민한 지점(팝업/버튼 렌더링 등)을 위한 재시도 헬퍼.
  // 서버가 잠깐 재연결되는 경우를 감지하면 추가로 조금 더 기다렸다가 재확인함.
  Core.retryStep = async function (label, checkFn, { attempts = 4, waits = [1000, 3000, 6000, 10000] } = {}) {
    for (let i = 0; i < attempts; i++) {
      const result = await checkFn();
      if (result) return result;

      if (Core.bodyText().includes('서버에 재연결')) {
        Core.log('core', `(${label}) 서버 재연결 감지 → 3초 추가 대기 후 재확인`);
        await Core.sleep(3000);
        const retryResult = await checkFn();
        if (retryResult) return retryResult;
      }

      if (i < attempts - 1) {
        const waitMs = waits[Math.min(i, waits.length - 1)];
        Core.log('core', `(${label}) 아직 실패 (${i + 1}/${attempts}) → ${waitMs / 1000}초 후 재시도`);
        await Core.sleep(waitMs);
      }
    }
    return null;
  };

  // 상단 네비(전투/마을/캐릭) 클릭 후 드롭다운에서 정확히 일치하는 항목 클릭
  Core.clickNavMenuExact = async function (navLabel, itemText) {
    const navBtn = await Core.waitFor(() => Core.findButtonByText(navLabel), 15000);
    if (!navBtn) throw new Error(`상단 메뉴 "${navLabel}" 버튼을 찾을 수 없음`);
    navBtn.click();
    await Core.humanDelay(300, 800);
    const item = await Core.waitFor(() =>
      [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim() === itemText)
    );
    if (!item) throw new Error(`메뉴 항목 "${itemText}"를 찾을 수 없음`);
    item.click();
    await Core.humanDelay(300, 800);
  };

  // 상단 네비 클릭 후 드롭다운에서 "접미어"로 끝나는 항목 클릭
  // (마을마다 "에렌시아의 탑" / "르인의 탑"처럼 접두어가 달라서 접미어로 매칭)
  Core.clickNavMenuSuffix = async function (navLabel, suffixText) {
    const navBtn = await Core.waitFor(() => Core.findButtonByText(navLabel), 15000);
    if (!navBtn) throw new Error(`상단 메뉴 "${navLabel}" 버튼을 찾을 수 없음`);
    navBtn.click();
    await Core.humanDelay(300, 800);
    const item = await Core.waitFor(() =>
      [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim().endsWith(suffixText))
    );
    if (!item) throw new Error(`메뉴 항목("...${suffixText}")을 찾을 수 없음`);
    item.click();
    await Core.humanDelay(300, 800);
  };

  // 은행 전액 입금 (재전직/자동사냥 모듈이 공용으로 사용)
  Core.bankDepositAll = async function (moduleId) {
    Core.log(moduleId, '은행으로 이동해 전액 입금 진행');
    await Core.clickNavMenuExact('마을', '은행');
    await Core.waitFor(() => Core.bodyText().includes('전액 입금'));
    const depositBtn = await Core.retryStep('"전액 입금" 버튼 찾기', () => Core.findButtonByText('전액 입금'));
    if (!depositBtn) {
      Core.notifyStopped(moduleId, '"전액 입금" 버튼을 찾지 못했습니다 (여러 번 재시도 후에도 실패).');
      return false;
    }
    depositBtn.click();
    await Core.humanDelay(600, 1300);
    Core.log(moduleId, '전액 입금 완료');
    return true;
  };

  // 장비(무기/방어구/장신구) 수리 - 활성화된 수리 버튼이 없어질 때까지 반복 클릭
  Core.repairAllEquipment = async function (moduleId) {
    Core.log(moduleId, '장비 내구도 부족 감지 → 장비 수리 진행');
    for (let attempt = 0; attempt < 12; attempt++) {
      const target = Core.allButtons().find((b) => /수리/.test(b.textContent) && !b.disabled);
      if (!target) break;
      target.click();
      await Core.humanDelay(500, 900);
    }
    const remaining = Core.allButtons().filter((b) => /수리/.test(b.textContent) && !b.disabled);
    if (remaining.length > 0) {
      Core.log(moduleId, '경고: 일부 장비를 완전히 수리하지 못했습니다(골드 부족 가능성). 계속 진행합니다.');
    } else {
      Core.log(moduleId, '장비 수리 완료.');
    }
  };

  // ---------------- 로그 / 배너 / 정지 알림 ----------------
  Core.log = function (moduleId, msg) {
    const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const tag = MODULE_LABELS[moduleId] || moduleId;
    const line = `[${time}][${tag}] ${msg}`;
    console.log('[라니스 통합매크로]', line);
    if (Core.logEl) {
      Core.logEl.textContent = line + '\n' + Core.logEl.textContent;
      const lines = Core.logEl.textContent.split('\n');
      if (lines.length > 300) Core.logEl.textContent = lines.slice(0, 300).join('\n');
    }
  };

  Core.startTitleFlash = function () {
    Core.stopTitleFlash();
    let on = false;
    Core.titleFlashInterval = setInterval(() => {
      document.title = on ? Core.originalTitle : '⚠ 확인 요망 - 라니스 통합매크로';
      on = !on;
    }, 1000);
  };

  Core.stopTitleFlash = function () {
    if (Core.titleFlashInterval) {
      clearInterval(Core.titleFlashInterval);
      Core.titleFlashInterval = null;
      document.title = Core.originalTitle;
    }
  };

  Core.showBanner = function (moduleId, msg) {
    if (!Core.bannerEl) return;
    Core.bannerEl.querySelector('span').textContent = `⚠ [${MODULE_LABELS[moduleId] || moduleId}] ${msg}`;
    Core.bannerEl.style.display = 'flex';
    Core.startTitleFlash();
  };

  Core.hideBanner = function () {
    if (Core.bannerEl) Core.bannerEl.style.display = 'none';
    Core.stopTitleFlash();
  };

  // 정말로 모듈을 멈춰야 하는 상황(목표 달성/오류 등)에서 호출. alert() 대신 배너로만
  // 알리므로 화면이 멈추지 않음 - 사람이 와서 원인을 보고 다시 시작만 누르면 됨.
  Core.notifyStopped = function (moduleId, msg) {
    Core.log(moduleId, `⚠ ${msg}`);
    Core.showBanner(moduleId, msg);
    Core.stopModule(moduleId);
  };

  Core.stopModule = function (moduleId) {
    Core.activeModuleId = null;
    const mod = Modules[moduleId];
    if (mod) {
      mod.running = false;
      mod.stopRequested = true;
    }
    Core.log(moduleId, '모듈 정지됨');
    Core.updateModuleButtons();
  };

  // ---------------- 패널 위치 저장/복원 (모든 모듈이 하나의 패널을 공유) ----------------
  Core.savePanelPosition = function (left, top) {
    try {
      localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left, top }));
    } catch (e) {
      /* localStorage 사용 불가 환경이면 조용히 무시 */
    }
  };

  Core.loadPanelPosition = function () {
    try {
      const raw = localStorage.getItem(PANEL_POS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  };

  // ==========================================================================
  // 모듈 정의: 재전직 / 자동사냥 / 레어맵
  // 각 모듈은 자기 상태(running 등)와 설정, 사이클 로직, 시작 함수를 가짐.
  // ==========================================================================
  const MODULE_LABELS = {
    rejob: '재전직',
    autohunt: '자동사냥',
    raremap: '레어맵',
  };

  const Modules = {};

  // -------------------------- 모듈 1: 재전직 --------------------------
  Modules.rejob = {
    id: 'rejob',
    running: false,
    stopRequested: false,
    cycleCount: 0,
    config: {
      targetScore: 5000,
      tierIndex: 3, // 기본: 탑
      maxRejobCount: 500, // 0 = 무제한
      restEvery: [50, 65],
      restSeconds: [60, 180],
      clickDelay: [300, 800],
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

  // 행동력 "+" 버튼: aria-label로 직접 찾음 (좌표 추측은 폴백으로만 남김 - 예전에
  // 좌표 추측 방식이 바로 옆의 "?" 안내 아이콘과 혼동되던 버그가 있었음)
  Modules.rejob.findEnergyPlusButton = function () {
    const byLabel = document.querySelector('[aria-label="활력의 포션 사용"]');
    if (byLabel) return byLabel;
    const bars = [...document.querySelectorAll('[role="progressbar"]')];
    const energyBar = bars.find((b) => {
      const r = b.getBoundingClientRect();
      return r.top < 200 && r.width > 200;
    });
    if (!energyBar) return null;
    const barRect = energyBar.getBoundingClientRect();
    const candidates = [...document.querySelectorAll('div')].filter((el) => {
      const r = el.getBoundingClientRect();
      const label = el.getAttribute('aria-label') || '';
      return (
        Math.abs(r.top - barRect.top) < 40 &&
        r.left > barRect.left &&
        r.left < barRect.right + 150 &&
        r.width > 15 &&
        r.width < 45 &&
        r.height > 15 &&
        r.height < 45 &&
        label.includes('활력')
      );
    });
    return candidates[0] || null;
  };

  Modules.rejob.parseEnergy = function () {
    const m = Core.bodyText().match(/(\d+)\s*\/\s*2000/);
    return m ? parseInt(m[1], 10) : null;
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
    plusBtn.click();
    await mod.clickDelayWait();

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
    targetBtn.click();
    await mod.clickDelayWait();

    // v1.0 버그 수정(유지): "사용할 개수" 팝업이 뜨면 document.querySelector('input[type="number"]')로
    // 페이지 전체에서 첫 번째 number input을 찾으면, 우리 패널의 "목표 강함점수" 입력칸도
    // type="number"이고 DOM상 게임 팝업보다 먼저 붙어있어서, 실제로는 그 입력칸을 잘못 집어
    // 값을 덮어써버리는 문제가 있었음(목표점수가 갑자기 1로 바뀌는 것처럼 보이던 원인).
    // 수정: 패널/배너를 제외한 요소들 중 "사용할 개수" 텍스트를 포함하는 가장 좁은 범위의
    // 요소(실제 팝업 컨테이너)를 먼저 찾고, 그 안에서만 number input과 "사용" 버튼을 찾도록 함
    const qtyDialogEl = await Core.retryStep('수량 확인 팝업 컨테이너 찾기', () => {
      const candidates = [...document.querySelectorAll('*')].filter((el) => {
        if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
        return el.textContent.includes('사용할 개수');
      });
      if (candidates.length === 0) return null;
      return candidates.reduce((smallest, el) =>
        el.querySelectorAll('*').length < smallest.querySelectorAll('*').length ? el : smallest
      );
    });

    if (qtyDialogEl) {
      const qtyInput = qtyDialogEl.querySelector('input[type="number"]');
      if (qtyInput) {
        const holdMatch = qtyDialogEl.textContent.match(/보유 수량:\s*([\d,]+)개/);
        const held = holdMatch ? parseInt(holdMatch[1].replace(/,/g, ''), 10) : 1;
        // v1.1 변경: 1개씩 사용하던 것을 3개씩 사용하도록 변경 (보유 수량이 3개 미만이면 있는 만큼만 사용)
        const useQty = Math.min(3, held);
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(qtyInput, useQty);
        qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
        await mod.clickDelayWait();
        const confirmBtn = [...qtyDialogEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용');
        if (confirmBtn) {
          confirmBtn.click();
          await mod.clickDelayWait();
          mod.energyRefillStreak += 1;
          Core.log('rejob', `활력의 포션 ${useQty}개 사용 완료`);
        }
      } else {
        Core.log('rejob', '수량 확인 팝업은 찾았으나 입력칸을 찾지 못함 (수량 입력 없이 진행되는 케이스로 추정)');
      }
    }
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

    // v1.1 수정: 기존 정규식(\S+)은 공백이 없는 한 단어짜리 직업명만 제대로 캡처됨.
    // 직업명이 "○○ ○○"처럼 공백이 포함된 두 단어 이상이면 첫 단어만 잘려서 저장되어
    // 이후 "(직업명) (5차)" 카드를 절대 찾지 못하는 문제가 있었음(재전직 도중 반복 정지의
    // 주 원인으로 추정). 줄 끝까지 캡처하도록 변경.
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

    // v1.1 수정: 직업명 파싱이 잘못됐던 과거 상태와의 호환 및 추가 안전장치로,
    // 정확히 일치하는 카드가 없으면 "직업명을 포함 + (5차)를 포함"하는 카드도 보조로 찾음.
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

    const successToast = await Core.retryStep('전직 완료 확인', () => (Core.bodyText().includes('전직 완료') ? true : null));
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
      () => (/레벨\s*1\s*→\s*\d+\s*달성|전투\s*후\s*중단/.test(Core.bodyText()) ? true : null),
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
      resultShown = await Core.waitFor(() => /레벨\s*1\s*→\s*\d+\s*달성|전투\s*후\s*중단/.test(Core.bodyText()), 15000);
      if (!resultShown) break;
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

  Modules.rejob.refillExpPotion = async function () {
    Core.log('rejob', '농축 경험의 물약 보충 시도 (인벤토리 이동)');
    await Core.clickNavMenuExact('캐릭', '인벤토리');
    await Core.waitFor(() => Core.bodyText().includes('보유 아이템'));

    const consumTab = Core.findButtonByText('소모품') || Core.findByExactText('button, [role="tab"]', '소모품');
    if (consumTab) {
      consumTab.click();
      await Core.humanDelay(300, 800);
    }

    const row = [...document.querySelectorAll('*')]
      .filter((el) => el.textContent.trim().startsWith('농축 경험의 물약'))
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    if (!row) {
      Core.notifyStopped('rejob', '"농축 경험의 물약"이 없습니다! 인벤토리를 채워주세요.');
      return false;
    }
    if (/x\s*0\b/.test(row.textContent)) {
      Core.notifyStopped('rejob', '농축 경험의 물약 없음! 수동으로 채워주세요.');
      return false;
    }

    const rowContainer = row.closest('tr') || row.closest('li') || row.parentElement.parentElement;
    const useBtn = await Core.retryStep('농축 경험의 물약 "사용" 버튼 찾기', () =>
      rowContainer ? [...rowContainer.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용') || null : null
    );
    if (!useBtn) {
      Core.notifyStopped('rejob', '농축 경험의 물약 "사용" 버튼을 찾지 못했습니다 (여러 번 재시도 후에도 실패).');
      return false;
    }
    useBtn.click();
    await Core.humanDelay(300, 800);

    const confirmDialog = await Core.waitFor(() => Core.bodyText().includes('사용하시겠습니까'), 3000);
    if (confirmDialog) {
      const confirmBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용');
      if (confirmBtn) {
        confirmBtn.click();
        await Core.humanDelay(300, 800);
      }
    }
    Core.log('rejob', '농축 경험의 물약 사용 완료');
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

  Modules.rejob.runCycle = async function () {
    const mod = this;
    if (!mod.skipRejobThisCycle) {
      const ok = await mod.doRejob();
      if (!ok || !mod.running) return;
    } else {
      Core.log('rejob', '직전 사냥에서 100레벨 미달 → 재전직 생략하고 재사냥만 진행');
    }

    const result = await mod.doHunt();
    if (!result || !mod.running) return;

    Core.log(
      'rejob',
      `결과 - 레벨:${result.level} 골드:${result.gold?.toLocaleString()} 농축물약잔여:${result.potionRemaining} MP포션잔여:${
        result.mpPotionRemaining ?? '알 수 없음'
      }`
    );

    if (result.level !== 100) {
      Core.log('rejob', `레벨 ${result.level} (100 미달) → ${result.tierUsed.short}에서 사망 추정, 한 단계 아래 사냥터로 재시도`);
      const idx = mod.TIERS.findIndex((t) => t.short === result.tierUsed.short);
      mod.nextTierIndexOverride = Math.max(0, idx - 1);
      mod.skipRejobThisCycle = true;
      if (result.potionRemaining === null || result.potionRemaining < 50) {
        await mod.refillExpPotion();
      }
      if (!mod.running) return;
      if (result.gold !== null && result.gold > 1000000) {
        await Core.bankDepositAll('rejob');
      }
      return;
    }
    mod.skipRejobThisCycle = false;
    if (!mod.running) return;

    if (result.potionRemaining === null || result.potionRemaining < 50) {
      const refilled = await mod.refillExpPotion();
      if (!refilled) return;
    }
    if (!mod.running) return;

    if (result.gold !== null && result.gold > 1000000) {
      await Core.bankDepositAll('rejob');
    }
    if (!mod.running) return;

    await mod.refillEnergyIfNeeded();
    if (!mod.running) return;

    const score = await mod.checkStrongScore();
    if (score !== null && score > mod.config.targetScore) {
      Core.notifyStopped(
        'rejob',
        `강함 점수 ${score.toLocaleString()}이(가) 목표치(${mod.config.targetScore.toLocaleString()})를 초과했습니다! 목표를 달성하여 정지합니다.`
      );
      return;
    }

    mod.cycleCount += 1;
    Core.updateModuleButtons();

    if (mod.config.maxRejobCount > 0 && mod.cycleCount >= mod.config.maxRejobCount) {
      Core.notifyStopped('rejob', `설정하신 최대 재전직 횟수(${mod.config.maxRejobCount})에 도달하여 정지합니다.`);
      return;
    }

    const restThreshold = Core.rand(mod.config.restEvery[0], mod.config.restEvery[1]);
    if (mod.cycleCount % restThreshold === 0) {
      const restSec = Core.rand(mod.config.restSeconds[0], mod.config.restSeconds[1]);
      Core.log('rejob', `${restThreshold}사이클 도달 → ${restSec}초 휴식`);
      await Core.sleep(restSec * 1000);
    }
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
        await Core.sleep(10000);
      }
      await mod.clickDelayWait();
    }
  };

  // -------------------------- 모듈 2: 자동사냥 --------------------------
  Modules.autohunt = {
    id: 'autohunt',
    running: false,
    stopRequested: false,
    cycleCount: 0,
    config: {
      groundSuffix: '광산',
      floor: null,
      goldThreshold: 1000000,
      minEnergy: 100,
    },
  };

  Modules.autohunt.GROUND_OPTIONS = [
    { label: '에렌시아의 평야 (평야)', suffix: '평야', hasFloor: false },
    { label: '에렌시아의 늪 (늪)', suffix: '늪', hasFloor: false },
    { label: '에렌시아의 숲 (숲)', suffix: '숲', hasFloor: false },
    { label: '에렌시아의 탑 (탑)', suffix: '탑', hasFloor: false },
    { label: '에렌시아의 지하 (지하)', suffix: '지하', hasFloor: false },
    { label: '에렌시아의 광산 (광산)', suffix: '광산', hasFloor: true },
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

  Modules.autohunt.ensureOnGround = async function (groundSuffix, floor) {
    try {
      await Core.clickNavMenuSuffix('전투', groundSuffix);
    } catch (e) {
      Core.log('autohunt', `오류: ${e.message}`);
      return false;
    }
    await Core.sleep(500);
    if (floor) {
      await this.selectFloor(floor);
    }
    return true;
  };

  Modules.autohunt.selectFloor = async function (floor) {
    const target = `${floor}층`;
    const btn = await Core.waitFor(() => Core.allButtons().find((b) => b.textContent.trim() === target) || null, 6000);
    if (!btn) {
      Core.log('autohunt', `경고: "${target}" 버튼을 찾지 못했습니다.`);
      return false;
    }
    if (btn.getAttribute('aria-pressed') !== 'true') {
      btn.click();
      await Core.sleep(400);
    }
    return true;
  };

  Modules.autohunt.findHuntX50Button = function () {
    return Core.allButtons().find((b) => /×\s*50\s*$/.test(b.textContent.trim())) || null;
  };

  Modules.autohunt.clickHuntX50 = async function () {
    const btn = await Core.waitFor(() => this.findHuntX50Button(), 6000);
    if (!btn) {
      Core.log('autohunt', '오류: "x 50" 사냥 버튼을 찾지 못했습니다.');
      return 'not_found';
    }
    if (btn.disabled) return 'disabled';
    btn.click();
    return 'clicked';
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

  // v1.1 신규: 농축 경험의 물약 잔여 회수 확인 (기존 자동사냥 모듈에는 이 체크가 아예 없었음 →
  // 물약이 다 떨어져도 계속 사냥을 반복하던 버그의 원인)
  Modules.autohunt.readExpPotionRemaining = function () {
    const m = Core.bodyText().match(/농축 경험의 물약 효과 \(5배\):\s*([\d,]+)회 남음/);
    if (!m) return null;
    return parseInt(m[1].replace(/,/g, ''), 10);
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
    const icons = Array.from(document.querySelectorAll('[aria-label]')).filter((e) =>
      /보호\s*없음/.test(e.getAttribute('aria-label') || '')
    );
    return icons.length > 0;
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
        await Core.sleep(3000);
        continue;
      }

      if (mod.isHpZeroBlocked()) {
        Core.notifyStopped('autohunt', '포션이 부족해 체력이 0인 상태로 전투가 불가능합니다 — 정지합니다.');
        break;
      }
      if (mod.isProtectionOff()) {
        Core.notifyStopped('autohunt', '장비 보호(기름)가 풀린 상태입니다 — 정지합니다.');
        break;
      }

      const energy = mod.readEnergy();
      if (energy !== null && energy < mod.config.minEnergy) {
        Core.notifyStopped('autohunt', `행동력 부족(${energy}/2000, 기준 ${mod.config.minEnergy}) — 정지합니다.`);
        break;
      }

      // v1.1 신규: 사냥 전 농축 경험의 물약이 이미 0회 남음이면(효과 종료) 굳이 사냥을 더 진행하지 않고 정지
      const preExpPotion = mod.readExpPotionRemaining();
      if (preExpPotion !== null && preExpPotion <= 0) {
        Core.notifyStopped('autohunt', '농축 경험의 물약 효과가 모두 소진되었습니다 — 정지합니다. 인벤토리에서 물약을 채워주세요.');
        break;
      }

      const okClick = await mod.clickHuntX50();
      if (okClick === 'disabled') {
        Core.notifyStopped('autohunt', '행동력이 부족하여 사냥 버튼이 비활성화되어 있습니다 — 정지합니다.');
        break;
      }
      if (okClick !== 'clicked') {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          Core.notifyStopped('autohunt', '사냥 버튼 클릭에 반복 실패하여 정지합니다.');
          break;
        }
        await Core.sleep(3000);
        continue;
      }

      await Core.sleep(800);
      const result = await mod.waitForResult(25000);
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
        await Core.sleep(3000);
        continue;
      }
      consecutiveFailures = 0;

      if (result === 'durability') {
        await Core.repairAllEquipment('autohunt');
        await mod.checkAndDepositGold();
        await Core.sleep(500);
        continue;
      }

      if (result === 'defeat') {
        Core.log('autohunt', '패배 감지 → 은행에 남은 골드를 모두 입금한 뒤 다시 사냥을 이어갑니다.');
        await Core.bankDepositAll('autohunt');
        await Core.sleep(500);
        continue;
      }

      // v1.1 신규: 사냥 결과 화면에서도 잔여 물약 회수를 다시 확인 (전투 도중 0이 된 경우 즉시 정지)
      const postExpPotion = mod.readExpPotionRemaining();
      if (postExpPotion !== null && postExpPotion <= 0) {
        Core.notifyStopped('autohunt', '농축 경험의 물약 효과가 모두 소진되었습니다 — 정지합니다. 인벤토리에서 물약을 채워주세요.');
        break;
      }

      const hpmp = mod.readPlayerHPMP();
      if (hpmp && (hpmp.hp.cur < hpmp.hp.max || hpmp.mp.cur < hpmp.mp.max)) {
        Core.notifyStopped('autohunt', '포션이 부족한 것으로 보입니다(전투 후 HP/MP가 가득 차지 않음) — 정지합니다.');
        break;
      }

      await mod.checkAndDepositGold();
      await Core.sleep(800 + Math.random() * 1200);
    }

    mod.running = false;
    Core.activeModuleId = Core.activeModuleId === 'autohunt' ? null : Core.activeModuleId;
    Core.log('autohunt', '매크로가 정지되었습니다.');
    Core.updateModuleButtons();
  };

  // -------------------------- 모듈 3: 레어맵 --------------------------
  Modules.raremap = {
    id: 'raremap',
    running: false,
    stopRequested: false,
    cycleCount: 0,
    config: {
      maxCycles: 200, // 안전장치: 최대 반복 횟수
    },
  };

  Modules.raremap.EXCLUDE_TEXTS = ['전투', '마을', '캐릭', '설정', '취소', '사용하기', '닫기', '로그아웃', '알림'];

  Modules.raremap.randomClickDelay = function () {
    return 1000 + Math.random() * 800; // 1~1.8초, 사람처럼 보이도록
  };

  Modules.raremap.getMapIcon = function () {
    return document.querySelector('div[aria-label="지도 아이템을 사용해 레어맵으로 이동하기"]');
  };

  Modules.raremap.getMapDialog = function () {
    const titleEl = Array.from(document.querySelectorAll('h1, h2, h3')).find((el) => el.textContent.trim() === '지도 아이템 사용하기');
    if (!titleEl) return null;
    return titleEl.closest('[role="dialog"]');
  };

  Modules.raremap.getTopRadio = function (dialog) {
    return dialog.querySelector('.MuiRadio-root');
  };

  Modules.raremap.getUseButton = function (dialog) {
    return Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent.trim() === '사용하기');
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
    const mapIcon = this.getMapIcon();
    if (!mapIcon) {
      Core.log('raremap', '지도 아이콘을 찾지 못했습니다.');
      return false;
    }
    mapIcon.click();
    await Core.sleep(this.randomClickDelay());

    const dialog = this.getMapDialog();
    if (!dialog) {
      Core.log('raremap', '지도 아이템 모달을 찾지 못했습니다.');
      return false;
    }

    const topRadio = this.getTopRadio(dialog);
    if (!topRadio) {
      Core.log('raremap', '모달에서 지도 항목을 찾지 못했습니다.');
      return false;
    }
    topRadio.click();
    await Core.sleep(this.randomClickDelay());

    const useBtn = this.getUseButton(dialog);
    if (!useBtn) {
      Core.log('raremap', '사용하기 버튼을 찾지 못했습니다.');
      return false;
    }
    useBtn.click();
    await Core.sleep(this.randomClickDelay());
    return true;
  };

  Modules.raremap.clearRareMapsIfAny = async function () {
    let count = 0;
    while (this.running) {
      const rareBtn = this.getRareMapButton();
      if (!rareBtn) break;
      Core.log('raremap', `레어맵 발견: "${rareBtn.textContent.trim()}" → 클릭`);
      rareBtn.click();
      count++;
      await Core.sleep(this.randomClickDelay());
      Core.log('raremap', '다음 레어맵이 있는지 1초 후 재확인합니다...');
      await Core.sleep(1000);
    }
    return count;
  };

  Modules.raremap.runCycle = async function () {
    const mod = this;
    mod.cycleCount++;
    Core.log('raremap', `--- 사이클 ${mod.cycleCount} 시작 ---`);
    Core.updateModuleButtons();

    const preCleared = await mod.clearRareMapsIfAny();
    if (preCleared > 0) {
      Core.log('raremap', `사이클 시작 전 남아있던 레어맵 ${preCleared}개 클리어`);
    }

    const used = await mod.useTopMapItem();
    if (!used) {
      Core.log('raremap', '지도 사용 실패 → 정지');
      mod.running = false;
      return;
    }
    const cleared = await mod.clearRareMapsIfAny();
    Core.log('raremap', `이번 사이클 레어맵 ${cleared}개 클리어`);
  };

  Modules.raremap.mainLoop = async function () {
    const mod = this;
    mod.cycleCount = 0;
    while (mod.running && mod.cycleCount < mod.config.maxCycles) {
      await mod.runCycle();
      if (!mod.running) break;
      await Core.sleep(1500);
    }
    Core.log('raremap', '매크로 종료 (최대 반복 횟수 도달 또는 중지됨)');
    mod.running = false;
    Core.activeModuleId = Core.activeModuleId === 'raremap' ? null : Core.activeModuleId;
    Core.updateModuleButtons();
  };

  // ==========================================================================
  // 공용 시작/정지 처리 (한 번에 하나의 모듈만 실행되도록 보호)
  // ==========================================================================
  Core.startModule = function (moduleId) {
    const mod = Modules[moduleId];
    if (!mod) return;
    if (Core.activeModuleId && Core.activeModuleId !== moduleId) {
      Core.showBanner(
        moduleId,
        `"${MODULE_LABELS[Core.activeModuleId]}" 모듈이 이미 실행 중입니다. 먼저 그 모듈을 정지한 뒤 시작해주세요.`
      );
      return;
    }
    if (mod.running) return;
    Core.hideBanner();
    Core.activeModuleId = moduleId;
    mod.running = true;
    mod.stopRequested = false;
    Core.log(moduleId, `${MODULE_LABELS[moduleId]} 매크로 시작`);
    Core.updateModuleButtons();
    mod.mainLoop();
  };

  Core.requestStopModule = function (moduleId) {
    const mod = Modules[moduleId];
    if (!mod || !mod.running) return;
    mod.stopRequested = true;
    mod.running = false; // 재전직 모듈의 while(mod.running) 루프는 이 값으로 즉시 멈춤
    if (Core.activeModuleId === moduleId) Core.activeModuleId = null;
    Core.log(moduleId, '사용자 요청으로 정지합니다...');
    Core.updateModuleButtons();
  };

  // ==========================================================================
  // 패널 UI (탭 구조, 하나의 패널을 세 모듈이 공유)
  // ==========================================================================
  const UIRefs = { rejob: {}, autohunt: {}, raremap: {} };
  let activeTab = 'rejob';

  Core.updateModuleButtons = function () {
    ['rejob', 'autohunt', 'raremap'].forEach((id) => {
      const mod = Modules[id];
      const refs = UIRefs[id];
      if (!refs.startBtn) return;
      const otherRunning = Core.activeModuleId && Core.activeModuleId !== id;
      refs.startBtn.disabled = mod.running || otherRunning;
      refs.stopBtn.disabled = !mod.running;
      refs.statusEl.textContent = mod.running ? `실행중 (사이클 ${mod.cycleCount})` : otherRunning ? '다른 모듈 실행중' : '대기중';
      if (refs.inputs) refs.inputs.forEach((inp) => (inp.disabled = mod.running));
    });
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

  function buildRejobTab(container) {
    const mod = Modules.rejob;
    const refs = UIRefs.rejob;
    container.appendChild(labelEl('목표 강함점수'));
    const scoreInput = document.createElement('input');
    scoreInput.type = 'number';
    scoreInput.value = mod.config.targetScore;
    scoreInput.style.cssText = inputStyle();
    scoreInput.addEventListener('change', (e) => (mod.config.targetScore = parseInt(e.target.value, 10) || 5000));
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
    tierSelect.addEventListener('change', (e) => (mod.config.tierIndex = parseInt(e.target.value, 10)));
    container.appendChild(tierSelect);

    container.appendChild(labelEl('최대 재전직 횟수 (0=무제한)'));
    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.value = mod.config.maxRejobCount;
    maxInput.style.cssText = inputStyle();
    maxInput.addEventListener('change', (e) => (mod.config.maxRejobCount = parseInt(e.target.value, 10) || 0));
    container.appendChild(maxInput);

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
    startBtn.addEventListener('click', () => Core.startModule('rejob'));
    stopBtn.addEventListener('click', () => Core.requestStopModule('rejob'));
    btnRow.appendChild(startBtn);
    btnRow.appendChild(stopBtn);
    container.appendChild(btnRow);
    container.appendChild(statusEl);

    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.inputs = [scoreInput, tierSelect, maxInput];
  }

  function buildAutohuntTab(container) {
    const mod = Modules.autohunt;
    const refs = UIRefs.autohunt;

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
      floorSelect.appendChild(o);
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
    });
    syncFloorVisibility();

    container.appendChild(labelEl('골드 입금 기준액'));
    const goldInput = document.createElement('input');
    goldInput.type = 'number';
    goldInput.value = mod.config.goldThreshold;
    goldInput.style.cssText = inputStyle();
    goldInput.addEventListener('change', (e) => (mod.config.goldThreshold = parseInt(e.target.value, 10) || 0));
    container.appendChild(goldInput);

    container.appendChild(labelEl('최소 행동력 (미만이면 정지)'));
    const energyInput = document.createElement('input');
    energyInput.type = 'number';
    energyInput.value = mod.config.minEnergy;
    energyInput.style.cssText = inputStyle();
    energyInput.addEventListener('change', (e) => (mod.config.minEnergy = parseInt(e.target.value, 10) || 0));
    container.appendChild(energyInput);

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
    refs.inputs = [groundSelect, floorSelect, goldInput, energyInput];
  }

  function buildRaremapTab(container) {
    const mod = Modules.raremap;
    const refs = UIRefs.raremap;

    container.appendChild(labelEl('최대 반복 사이클 (안전장치)'));
    const maxCyclesInput = document.createElement('input');
    maxCyclesInput.type = 'number';
    maxCyclesInput.value = mod.config.maxCycles;
    maxCyclesInput.style.cssText = inputStyle();
    maxCyclesInput.addEventListener('change', (e) => (mod.config.maxCycles = parseInt(e.target.value, 10) || 200));
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

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'lrm-panel';
    panel.style.cssText = `
      position: fixed; top: 60px; right: 10px; width: 300px;
      background: #1a1a1a; color: #eee; border: 1px solid #555; border-radius: 8px;
      font-size: 12px; z-index: 999999; font-family: sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    `;
    Core.panelEl = panel;

    const header = document.createElement('div');
    header.id = 'lrm-drag-handle';
    header.textContent = '🎯 라니스 통합 매크로';
    header.style.cssText = 'cursor:move; font-weight:bold; padding:8px 10px; background:#262626; border-radius:8px 8px 0 0; user-select:none;';
    panel.appendChild(header);

    // 탭 바
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex; border-bottom:1px solid #444;';
    const tabButtons = {};
    Object.keys(MODULE_LABELS).forEach((id) => {
      const tabBtn = document.createElement('button');
      tabBtn.textContent = MODULE_LABELS[id];
      tabBtn.style.cssText = 'flex:1; padding:6px 0; background:#1a1a1a; color:#eee; border:none; cursor:pointer; font-size:12px;';
      tabBtn.addEventListener('click', () => switchTab(id));
      tabBar.appendChild(tabBtn);
      tabButtons[id] = tabBtn;
    });
    panel.appendChild(tabBar);

    const tabContents = {};
    const contentWrap = document.createElement('div');
    contentWrap.style.cssText = 'padding:10px;';
    Object.keys(MODULE_LABELS).forEach((id) => {
      const c = document.createElement('div');
      c.style.display = 'none';
      tabContents[id] = c;
      contentWrap.appendChild(c);
    });
    buildRejobTab(tabContents.rejob);
    buildAutohuntTab(tabContents.autohunt);
    buildRaremapTab(tabContents.raremap);
    panel.appendChild(contentWrap);

    function switchTab(id) {
      activeTab = id;
      Object.keys(tabContents).forEach((k) => {
        tabContents[k].style.display = k === id ? 'block' : 'none';
        tabButtons[k].style.background = k === id ? '#333' : '#1a1a1a';
        tabButtons[k].style.borderBottom = k === id ? '2px solid #f5a623' : 'none';
      });
    }
    switchTab(activeTab);

    // 공용 로그
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

    // 배너 (모든 모듈 공용, 패널 위에 화면 상단 고정)
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

    // 저장된 위치 복원 (기존 재전직 매크로 v1.5에서 쓰던 것과 같은 방식 — 통합 패널 하나에 적용)
    const savedPos = Core.loadPanelPosition();
    if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
      panel.style.left = `${savedPos.left}px`;
      panel.style.top = `${savedPos.top}px`;
      panel.style.right = 'auto';
    }

    // 드래그 이동 + 위치 저장
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
    Core.log('core', '통합 매크로 패널 로드 완료 (재전직 / 자동사냥 / 레어맵)');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();
