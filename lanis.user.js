// ==UserScript==
// @name         lanis
// @namespace    lanis
// @version      1.2.40
// @description  재전직 / 자동사냥 / 레어맵 / 던전 자동클리어 매크로를 하나의 패널로 통합. 탭으로 전환, 패널 위치 저장, 동시에 하나의 모듈만 실행되도록 보호.
// @match        https://lanis.me/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Ke9318/lanis/main/lanis.user.js
// @downloadURL  https://raw.githubusercontent.com/Ke9318/lanis/main/lanis.user.js
// ==/UserScript==

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
    audioCtx: null, // 알림음 재생용 (v1.2.24)
  };

  const PANEL_POS_KEY = 'lrm-unified-panel-pos'; // 패널 위치 저장용 localStorage 키 (하나의 패널이므로 키도 하나)

  // v1.2.36 신규: 크롬 등 브라우저는 탭이 백그라운드(다른 탭 보고 있거나 창이 최소화)
  // 상태로 일정 시간 지나면 해당 탭의 setTimeout/setInterval을 강하게 스로틀링한다
  // (심하면 1분에 한 번 수준까지 느려짐). 매크로의 모든 대기(Core.sleep)가 결국
  // setTimeout 기반이었기 때문에, 탭을 안 보고 한참 뒤에 돌아오면 "몇 시간 전에 하던
  // 것을 아직도 하고 있는" 것처럼 보이는 문제가 있었음. Web Worker 안의 타이머는 이
  // 탭 가시성 기반 스로틀링을 받지 않으므로, 별도 워커에게 대기를 위임하는 방식으로
  // 우회한다. 워커 생성이 실패하는 환경(엄격한 CSP 등)에서는 기존 setTimeout 방식으로
  // 조용히 폴백한다.
  Core._bgSleep = (function () {
    try {
      const workerCode =
        'self.onmessage = function (e) {' +
        '  var id = e.data.id, ms = e.data.ms;' +
        '  setTimeout(function () { postMessage(id); }, ms);' +
        '};';
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      const pending = new Map();
      let counter = 0;
      worker.onmessage = function (e) {
        const resolve = pending.get(e.data);
        if (resolve) {
          pending.delete(e.data);
          resolve();
        }
      };
      worker.onerror = function () {
        /* 워커 실행 중 오류가 나도 폴백 sleep을 계속 쓸 수 있도록 조용히 무시 */
      };
      return function (ms) {
        return new Promise((resolve) => {
          const id = ++counter;
          pending.set(id, resolve);
          worker.postMessage({ id, ms });
        });
      };
    } catch (e) {
      return null; // 워커를 만들 수 없는 환경 - 아래에서 기존 방식으로 폴백
    }
  })();

  Core.sleep = Core._bgSleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  Core.rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  // v1.2: 여러 창을 동시에 돌릴 때 클릭이 씹히는 문제 완화 - 기본 지연 증가
  Core.humanDelay = (minMs, maxMs) => Core.sleep(minMs + Math.random() * (maxMs - minMs));

  // 패널/배너 자기 자신의 텍스트가 페이지 텍스트 파싱과 혼동되는 걸 막기 위해,
  // 잠깐 숨긴 상태로 읽고 되돌려놓음
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
    return Array.from(document.querySelectorAll('button')).filter(
      (b) => !b.closest('#lrm-panel') && !b.closest('#lrm-banner')
    );
  };

  Core.findButtonByText = function (text) {
    return Core.allButtons().find((b) => b.textContent.trim() === text) || null;
  };

  Core.findByExactText = function (selector, text) {
    return [...document.querySelectorAll(selector)].find((el) => el.textContent.trim() === text) || null;
  };

  Core.findButtonInDialog = function (dialogMarkerText, buttonText) {
    const candidates = [...document.querySelectorAll('*')].filter((el) => {
      if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
      if (!el.textContent.includes(dialogMarkerText)) return false;
      return [...el.querySelectorAll('button')].some((b) => b.textContent.trim() === buttonText);
    });
    if (candidates.length === 0) return null;
    const smallest = candidates.reduce((a, b) => (a.querySelectorAll('*').length < b.querySelectorAll('*').length ? a : b));
    return [...smallest.querySelectorAll('button')].find((b) => b.textContent.trim() === buttonText) || null;
  };

  Core.waitFor = async function (fn, timeoutMs = 15000, intervalMs = 300) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = fn();
      if (result) return result;
      await Core.sleep(intervalMs);
    }
    return null;
  };

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

  Core.clickAndWaitFor = async function (el, checkFn, { minDelay = 500, maxDelay = 1300, timeoutMs = 15000 } = {}) {
    el.click();
    await Core.humanDelay(minDelay, maxDelay);
    return Core.waitFor(checkFn, timeoutMs, 300);
  };

  Core.clickNavMenuExact = async function (navLabel, itemText) {
    const navBtn = await Core.waitFor(() => Core.findButtonByText(navLabel), 15000);
    if (!navBtn) throw new Error(`상단 메뉴 "${navLabel}" 버튼을 찾을 수 없음`);
    navBtn.click();
    await Core.humanDelay(500, 1000);
    const item = await Core.waitFor(() =>
      [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim() === itemText)
    );
    if (!item) throw new Error(`메뉴 항목 "${itemText}"를 찾을 수 없음`);
    item.click();
    await Core.humanDelay(500, 1000);
  };

  Core.clickNavMenuSuffix = async function (navLabel, suffixText) {
    const navBtn = await Core.waitFor(() => Core.findButtonByText(navLabel), 15000);
    if (!navBtn) throw new Error(`상단 메뉴 "${navLabel}" 버튼을 찾을 수 없음`);
    navBtn.click();
    await Core.humanDelay(500, 1000);
    const item = await Core.waitFor(() =>
      [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim().endsWith(suffixText))
    );
    if (!item) throw new Error(`메뉴 항목("...${suffixText}")을 찾을 수 없음`);
    item.click();
    await Core.humanDelay(500, 1000);
  };

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
    await Core.humanDelay(800, 1600);
    Core.log(moduleId, '전액 입금 완료');
    return true;
  };

  Core.repairAllEquipment = async function (moduleId) {
    Core.log(moduleId, '장비 내구도 부족 감지 → 장비 수리 진행');
    for (let attempt = 0; attempt < 12; attempt++) {
      const target = Core.allButtons().find((b) => /수리/.test(b.textContent) && !b.disabled);
      if (!target) break;
      target.click();
      await Core.humanDelay(600, 1100);
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

  // ---------------- 알림음 (v1.2.24 신규) ----------------
  Core.getAudioCtx = function () {
    if (!Core.audioCtx) {
      try {
        Core.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        return null;
      }
    }
    if (Core.audioCtx.state === 'suspended') {
      Core.audioCtx.resume().catch(() => {});
    }
    return Core.audioCtx;
  };

  Core.beep = function (freq, durationMs, delayMs = 0, waveType = 'sine', volume = 0.2) {
    const ctx = Core.getAudioCtx();
    if (!ctx) return;
    setTimeout(() => {
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = waveType;
        osc.frequency.value = freq;
        gain.gain.value = volume;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + durationMs / 1000);
      } catch (e) {
        /* 오디오 재생 불가 환경이면 조용히 무시 */
      }
    }, delayMs);
  };

  Core.playStopSound = function () {
    Core.beep(300, 180, 0, 'square', 0.15);
    Core.beep(220, 220, 220, 'square', 0.15);
  };

  Core.playCompleteSound = function () {
    Core.beep(523.25, 150, 0, 'sine', 0.2);
    Core.beep(659.25, 150, 150, 'sine', 0.2);
    Core.beep(783.99, 260, 300, 'sine', 0.2);
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

  Core.showBanner = function (moduleId, msg, isSuccess = false) {
    if (!Core.bannerEl) return;
    Core.bannerEl.querySelector('span').textContent = `${isSuccess ? '✅' : '⚠'} [${MODULE_LABELS[moduleId] || moduleId}] ${msg}`;
    Core.bannerEl.style.background = isSuccess ? '#2e7d32' : '#b71c1c';
    Core.bannerEl.style.display = 'flex';
    Core.startTitleFlash();
  };

  Core.hideBanner = function () {
    if (Core.bannerEl) Core.bannerEl.style.display = 'none';
    Core.stopTitleFlash();
  };

  Core.notifyStopped = function (moduleId, msg) {
    Core.log(moduleId, `⚠ ${msg}`);
    Core.showBanner(moduleId, msg, false);
    Core.playStopSound();
    Core.stopModule(moduleId);
  };

  Core.notifyCompleted = function (moduleId, msg) {
    Core.log(moduleId, `✅ ${msg}`);
    Core.showBanner(moduleId, msg, true);
    Core.playCompleteSound();
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

  // ---------------- 모듈 설정값 저장/복원 (공용) ----------------
  Core.saveModuleConfig = function (moduleId, keys) {
    try {
      const mod = Modules[moduleId];
      const data = {};
      keys.forEach((k) => (data[k] = mod.config[k]));
      localStorage.setItem(`lrm-config-${moduleId}`, JSON.stringify(data));
    } catch (e) {
      /* localStorage 사용 불가 환경이면 조용히 무시 */
    }
  };

  Core.loadModuleConfig = function (moduleId, keys) {
    try {
      const raw = localStorage.getItem(`lrm-config-${moduleId}`);
      if (!raw) return;
      const saved = JSON.parse(raw);
      const mod = Modules[moduleId];
      keys.forEach((k) => {
        if (saved[k] !== undefined && saved[k] !== null) mod.config[k] = saved[k];
      });
    } catch (e) {
      /* 저장된 값이 손상됐으면 기본값 그대로 사용 */
    }
  };

  // ---------------- 패널 위치 저장/복원 ----------------
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
  // 모듈 정의: 재전직 / 자동사냥 / 레어맵 / 던전
  // ==========================================================================
  const MODULE_LABELS = {
    rejob: '재전직',
    autohunt: '자동사냥',
    raremap: '레어맵',
    dungeon: '던전',
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
      clickDelay: [500, 1300],
      useHiddenRoomMap: false, // v1.2.27: 체크 시 일반 사냥터(50연전) 대신 "숨겨진 방의 지도"로 깨달음의 방을 만들어 1회 전투로 즉시 레벨 100을 만듦
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

    const qtyDialogEl = await Core.retryStep('수량 확인 팝업 컨테이너 찾기', () => {
      const candidates = [...document.querySelectorAll('*')].filter((el) => {
        if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
        return el.textContent.includes('사용할 개수');
      });
      if (candidates.length === 0) return null;
      return candidates.reduce((a, b) => (a.querySelectorAll('*').length < b.querySelectorAll('*').length ? a : b));
    });

    if (qtyDialogEl) {
      const qtyInput = qtyDialogEl.querySelector('input[type="number"]');
      if (qtyInput) {
        const holdMatch = qtyDialogEl.textContent.match(/보유 수량:\s*([\d,]+)개/);
        const held = holdMatch ? parseInt(holdMatch[1].replace(/,/g, ''), 10) : 1;
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

  // v1.2.27 신규: "숨겨진 방의 지도"를 사용해 광산에서 "깨달음의 방"을 생성하고
  // 1회 전투로 즉시 레벨 100을 만드는 경로. 일반 사냥터(50연전, doHunt)와 달리
  // 50회 전투 버튼을 누르는 방식이 아니므로 행동력 체크(refillEnergyIfNeeded)나
  // 행동력 체크(refillEnergyIfNeeded)와 농축 경험의 물약 체크(refillExpPotion)를
  // 전혀 거치지 않는다 - 행동력이 1만 있어도 그대로 진행 가능하고, 경험치 배율과
  // 무관하게 무조건 레벨 100으로 만들어주기 때문(v1.2.33: v1.2.32에서 물약 체크를
  // 추가했다가, 그 제보가 사실은 일반 사냥 모드에 대한 것이었음이 확인되어 원복).
  // 이 경로가 멈춰야 하는 유일한 조건은 "숨겨진 방의 지도" 자체의 소진뿐이다.
  // v1.2.28 버그 수정: 처음엔 <label> + input[type="radio"] 조합으로 항목을 찾았는데,
  // 실제 게임 DOM에는 <label> 태그 자체가 없어(레어맵 모듈이 label 대신 .MuiRadio-root를
  // 직접 찾아 클릭하는 것과 동일한 구조) 매번 항목을 못 찾고 "재고 없음"으로 잘못
  // 판정해 즉시 정지해버리던 문제가 있었음(실제로는 243개 보유 중이었는데도 발생).
  // 레어맵 모듈(getTopRadio)과 동일하게 .MuiRadio-root를 기준으로, "숨겨진 방의 지도"
  // 텍스트를 포함하면서 그 안에 .MuiRadio-root가 있는 가장 좁은 컨테이너(행)를 찾는
  // 방식으로 교체.
  Modules.rejob.getHiddenRoomMapOption = function (dialog) {
    const candidates = [...dialog.querySelectorAll('*')].filter((el) => {
      if (!el.textContent.includes('숨겨진 방의 지도')) return false;
      return !!el.querySelector('.MuiRadio-root');
    });
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a.querySelectorAll('*').length < b.querySelectorAll('*').length ? a : b));
  };

  // 보유 수량이 0이거나(예: "x0") 라디오 자체가 비활성화된 경우 재고 소진으로 판단
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

    // v1.2.31 개선: 지도 선택→사용하기→깨달음의 방 확인 시퀀스 전체가 가끔(클릭이 씹히거나
    // 서버 응답이 늦는 등) 한 번에 실패할 수 있는데, 예전엔 "깨달음의 방" 버튼을 못 찾으면
    // 그 자리에서 바로 포기하고 매크로 전체를 정지시켰음. "한 번 실패하면 재시도를 안 한다"는
    // 제보에 따라, 이 전체 시퀀스를 처음부터(지도 아이콘 재클릭부터) 최대 3번까지 다시
    // 시도하도록 바깥쪽 재시도 루프를 추가함. 재고 소진(exhausted)만은 재시도해도 의미가
    // 없는 진짜 정지 조건이므로 즉시 완료 처리하고 루프를 빠져나온다.
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
      // 남아있는 모달이 있으면 닫고(취소) 다음 시도에서 지도 아이콘부터 다시 진행
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

    // 50회 전투 버튼이 아니라 1회 전투로 즉시 레벨 100을 만들어주는 경로이므로
    // 행동력 체크/농축 경험의 물약 체크를 하지 않고 곧바로 결과 화면만 확인한다.
    let resultShown = await Core.retryStep(
      '깨달음의 방 전투 결과 화면 확인',
      () => (/레벨\s*1\s*→\s*\d+\s*달성|전투\s*후\s*중단|\d+\s*회\s*전투\s*완료/.test(Core.bodyText()) ? true : null),
      { attempts: 4, waits: [2000, 4000, 6000, 9000] }
    );
    if (!resultShown) {
      Core.notifyStopped('rejob', '깨달음의 방 전투 결과 화면을 확인하지 못했습니다.');
      return null;
    }

    // v1.2.30 신규: 일반 사냥터(doHunt)와 동일하게, 깨달음의 방 전투에서도 장비
    // 내구도 부족이 뜰 수 있으므로 수리 후 버튼을 다시 눌러 최대 3번까지 재시도한다.
    // (기존에는 이 처리가 빠져 있어 장비가 깨지면 결과 화면을 못 찾고 오정지했음)
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

    const useBtn = [...rowContainer.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용');
    if (!useBtn) {
      Core.notifyStopped('rejob', '농축 경험의 물약 "사용" 버튼을 찾지 못했습니다.');
      return false;
    }
    useBtn.click();
    await mod.clickDelayWait();

    const qtyDialogEl = await Core.retryStep(
      '농축 경험의 물약 수량 확인 팝업 찾기',
      () => {
        const candidates = [...document.querySelectorAll('*')].filter((el) => {
          if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
          return el.textContent.includes('사용할 개수');
        });
        if (candidates.length === 0) return null;
        return candidates.reduce((a, b) => (a.querySelectorAll('*').length < b.querySelectorAll('*').length ? a : b));
      },
      { attempts: 2, waits: [800, 1500] }
    );
    if (qtyDialogEl) {
      const qtyInput = qtyDialogEl.querySelector('input[type="number"]');
      if (qtyInput) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(qtyInput, 1);
        qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
        await mod.clickDelayWait();
      }
      const qtyConfirmBtn = [...qtyDialogEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용');
      if (qtyConfirmBtn) {
        qtyConfirmBtn.click();
        await mod.clickDelayWait();
      }
    } else {
      const confirmBtn = await Core.retryStep(
        '농축 경험의 물약 사용 확인 팝업의 "사용" 버튼 찾기',
        () => (Core.bodyText().includes('사용하시겠습니까') ? Core.findButtonInDialog('사용하시겠습니까', '사용') : null),
        { attempts: 2, waits: [800, 1500] }
      );
      if (confirmBtn) {
        confirmBtn.click();
        await mod.clickDelayWait();
      }
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

  // v1.2.27: 사냥 경로(일반 사냥터 / 숨겨진 방의 지도) 종류와 무관하게 공통으로
  // 실행하는 마무리 단계(골드 입금, 강함점수 체크, 사이클 카운트, 휴식)를 하나로 묶음.
  Modules.rejob.finishCycleCommon = async function (result) {
    const mod = this;
    if (result.gold !== null && result.gold > 1000000) {
      await Core.bankDepositAll('rejob');
    }
    if (!mod.running) return;

    const score = await mod.checkStrongScore();
    if (score !== null && score > mod.config.targetScore) {
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

    const restThreshold = Core.rand(mod.config.restEvery[0], mod.config.restEvery[1]);
    if (mod.cycleCount % restThreshold === 0) {
      const restSec = Core.rand(mod.config.restSeconds[0], mod.config.restSeconds[1]);
      Core.log('rejob', `${restThreshold}사이클 도달 → ${restSec}초 휴식`);
      await Core.sleep(restSec * 1000);
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

    // v1.2.27: "숨겨진 방의 지도" 옵션이 켜져 있으면 일반 사냥터(50연전) 대신
    // 광산에서 지도로 "깨달음의 방"을 만들어 1회 전투로 레벨 100을 만든다.
    const result = mod.config.useHiddenRoomMap ? await mod.doHiddenRoomHunt() : await mod.doHunt();
    if (!result || !mod.running) return;

    if (result.viaHiddenRoomMap) {
      Core.log('rejob', `결과(숨겨진 방의 지도) - 레벨:${result.level} 골드:${result.gold?.toLocaleString()}`);
      // v1.2.33: v1.2.32에서 이 경로에 농축 물약 체크를 추가했었으나, 사용자 확인 결과
      // 그 제보는 일반 사냥(useHiddenRoomMap=false, doHunt) 상황에 대한 것이었음 -
      // 숨겨진 방의 지도(깨달음의 방)는 경험치 배율과 무관하게 무조건 레벨 100을
      // 만들어주므로 농축 물약이 없어도 문제 없이 계속 진행되는 게 맞음. 이 경로가
      // 멈춰야 하는 조건은 오직 "숨겨진 방의 지도" 자체가 소진됐을 때뿐(doHiddenRoomHunt의
      // isHiddenRoomMapExhausted에서 이미 처리됨) → 물약/행동력 체크 없이 바로 마무리
      // 단계로 진행하도록 원복.
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

    await mod.refillEnergyIfNeeded();
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
      ignoreProtectionOff: false,
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

  Modules.autohunt.ensureOnGround = async function (groundSuffix, floor) {
    if (this.findHuntX50Button()) {
      if (floor) {
        await this.selectFloor(floor);
      }
      return true;
    }
    try {
      await Core.clickNavMenuSuffix('전투', groundSuffix);
    } catch (e) {
      Core.log('autohunt', `오류: ${e.message}`);
      return false;
    }
    await Core.sleep(600);
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
      await Core.sleep(500);
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

  Modules.autohunt.readExpPotionRemaining = function () {
    const m = Core.bodyText().match(/농축 경험의 물약 효과 \(5배\):\s*([\d,]+)회 남음/);
    if (!m) return null;
    return parseInt(m[1].replace(/,/g, ''), 10);
  };

  // v1.2.39 신규: MP 포션 잔여량을 전투 결과 텍스트에서 직접 읽는다("MP 포션: N 사용
  // (M 남음)" 형식 - 재전직 모듈의 doHunt에서 이미 쓰던 것과 동일한 패턴). 기존에는
  // HP/MP 게이지 라벨("HP"/"MP" 리프 요소)을 화면에서 찾아 다음 형제 요소의 수치를
  // 읽는 방식(readPlayerHPMP)만 있었는데, 이 라벨을 못 찾으면(화면 구조가 살짝
  // 다르거나 일시적 렌더링 문제 등) 함수가 그냥 null을 반환해서 MP 소진 여부를 아예
  // 검사하지 못하고 넘어가는 경우가 있었음 - "MP 포션이 없는데도 계속 사냥한다"는
  // 제보의 주 원인으로 추정. 결과 텍스트에서 잔여량을 직접 읽는 이 체크를 추가해서,
  // 게이지 기반 감지가 실패해도 소진 여부를 놓치지 않도록 이중으로 확인한다.
  Modules.autohunt.readMpPotionRemaining = function () {
    const m = Core.bodyText().match(/MP\s*포션:\s*[\d,]+\s*사용\s*\(([\d,]+)\s*남음\)/);
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
      if (!mod.config.ignoreProtectionOff && mod.isProtectionOff()) {
        Core.notifyStopped('autohunt', '장비 보호(기름)가 풀린 상태입니다 — 정지합니다.');
        break;
      }

      const energy = mod.readEnergy();
      if (energy !== null && energy < mod.config.minEnergy) {
        Core.notifyStopped('autohunt', `행동력 부족(${energy}/2000, 기준 ${mod.config.minEnergy}) — 정지합니다.`);
        break;
      }

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

      await Core.sleep(1000);
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
        await Core.sleep(600);
        continue;
      }

      if (result === 'defeat') {
        Core.log('autohunt', '패배 감지 → 은행에 남은 골드를 모두 입금한 뒤 다시 사냥을 이어갑니다.');
        await Core.bankDepositAll('autohunt');
        await Core.sleep(600);
        continue;
      }

      const postExpPotion = mod.readExpPotionRemaining();
      if (postExpPotion !== null && postExpPotion <= 0) {
        Core.notifyStopped('autohunt', '농축 경험의 물약 효과가 모두 소진되었습니다 — 정지합니다. 인벤토리에서 물약을 채워주세요.');
        break;
      }

      const mpPotionRemaining = mod.readMpPotionRemaining();
      if (mpPotionRemaining !== null && mpPotionRemaining <= 0) {
        Core.notifyStopped('autohunt', 'MP 포션이 모두 소진되었습니다 — 정지합니다. 인벤토리에서 포션을 채워주세요.');
        break;
      }

      const hpmp = mod.readPlayerHPMP();
      if (hpmp && (hpmp.hp.cur < hpmp.hp.max || hpmp.mp.cur < hpmp.mp.max)) {
        Core.notifyStopped('autohunt', '포션이 부족한 것으로 보입니다(전투 후 HP/MP가 가득 차지 않음) — 정지합니다.');
        break;
      }

      await mod.checkAndDepositGold();
      await Core.sleep(1000 + Math.random() * 1400);
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
      await Core.sleep(1600);
    }
    Core.log('raremap', '매크로 종료 (최대 반복 횟수 도달 또는 중지됨)');
    mod.running = false;
    Core.activeModuleId = Core.activeModuleId === 'raremap' ? null : Core.activeModuleId;
    Core.updateModuleButtons();
  };

  // -------------------------- 모듈 4: 던전 --------------------------
  Modules.dungeon = {
    id: 'dungeon',
    running: false,
    stopRequested: false,
    cycleCount: 0,
    config: {
      enableDailySewer: true,
      rerollMinTokens: 50,
      instantClear: {
        oldMasterTower: { targetAC: 4000, targetEV: 4500 },
        masterTower: { targetAC: 4000, targetEV: 4500 },
        oldMysticCave: { targetAC: 5500, targetEV: 6000 },
        mysticCave: { targetAC: 5500, targetEV: 6000 },
        sewer: { targetAC: 0, targetEV: 0 },
      },
      // v1.2.34 신규: 체크한 던전은 적중치/회피치 기준이나 즉시완료 추가 조건(신의 일격/
      // 모든 스탯 등)을 전혀 확인하지 않고, 전투 화면에 들어가자마자 곧바로
      // "즉시 최상층 도전"을 시도한다.
      forceInstantClear: {
        oldMasterTower: false,
        masterTower: false,
        oldMysticCave: false,
        mysticCave: false,
        sewer: false,
      },
    },
    currentDungeonId: null,
    difficulty: '매우어려움',
    deathLimit: null,
    instantClearTried: false,
    boughtGodStrikeOrEquiv: false,
    boughtGodStrikeExact: false,
    allStatsBoughtValue: 0,
    boughtSingleStat: {},
    boughtGodStrike: false,
    boughtCertainHit: false,
    boughtCritStrike: false,
    boughtRegen: false,
  };

  Modules.dungeon.DUNGEONS = [
    {
      id: 'oldMasterTower',
      label: '[구] 수행자의 탑: 상층부',
      requiredItemName: '수행자의 열쇠',
      daily: false,
      statMode: 'standard',
      abilityMode: 'equalPriority',
    },
    {
      id: 'masterTower',
      label: '수행자의 탑: 상층부',
      requiredItemName: '수행자의 기록',
      daily: false,
      statMode: 'standard',
      abilityMode: 'equalPriority',
    },
    {
      id: 'oldMysticCave',
      label: '[구] 신비의 동굴',
      requiredItemName: '빛을 내는 랜턴',
      daily: false,
      statMode: 'standard',
      abilityMode: 'equalPriority',
    },
    {
      id: 'mysticCave',
      label: '신비의 동굴',
      requiredItemName: '동굴 탐험 기록',
      daily: false,
      statMode: 'standard',
      abilityMode: 'equalPriority',
      // v1.2.41 수정: "모든 스탯" 조건을 구매 횟수(minAllStats: 2회)가 아니라
      // 구매한 "모든 스탯 +N" 카드들의 수치 합계(포인트)로 판단하도록 변경.
      // 하급 카드(+10 등)를 여러 번 사서 "횟수"만 채우고 실제 스탯 총합은
      // 상급 1장(+50 등)보다 낮은데도 즉시완료를 시도해 실패하는 문제가 있었음.
      instantClearRequirement: { requireGodStrike: true, minAllStats: 150, requireStats: [] },
    },
    {
      id: 'sewer',
      label: '지하 하수도',
      requiredItemName: null,
      daily: true,
      statMode: 'extended',
      abilityMode: 'ordered',
      // v1.2.41 수정: 위와 동일한 이유로 minAllStats를 "횟수"에서 "합계 포인트"로 변경.
      instantClearRequirement: { requireGodStrike: true, minAllStats: 200, requireStats: ['힘', '속도'] },
    },
  ];

  const STAT_TARGET_ORDER = ['속도', '행운', '정신', '지능'];
  const STAT_EXTENDED_ORDER = ['속도', '행운', '정신', '지능', '힘', '생명', '체력', '마나'];
  const GRADE_COLOR = {
    gold: 'rgb(255, 215, 0)',
    rainbow: 'rgb(255, 20, 147)',
  };

  Modules.dungeon.bodyTextClean = function () {
    return Core.bodyText();
  };

  Modules.dungeon.getDungeonCardEl = function (label) {
    const heading = [...document.querySelectorAll('*')].find(
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim() === label &&
        !el.closest('#lrm-panel') &&
        !el.closest('#lrm-banner')
    );
    if (!heading) return null;
    let node = heading;
    for (let i = 0; i < 8; i++) {
      node = node.parentElement;
      if (!node) return null;
      if ([...node.querySelectorAll('button')].some((b) => b.textContent.trim() === '입장')) {
        return node;
      }
    }
    return null;
  };

  Modules.dungeon.getTicketCount = function (dungeonDef) {
    if (dungeonDef.daily) return Infinity;
    const card = this.getDungeonCardEl(dungeonDef.label);
    if (!card) return 0;
    const m = card.textContent.match(new RegExp(`${dungeonDef.requiredItemName}\\s*\\(([\\d,]+)개\\s*보유\\)`));
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  };

  Modules.dungeon.isDungeonCompletedToday = function (dungeonDef) {
    const card = this.getDungeonCardEl(dungeonDef.label);
    if (!card) return false;
    return card.textContent.includes('오늘 완료');
  };

  Modules.dungeon.goToDungeonSelect = async function () {
    await Core.clickNavMenuExact('전투', '던전');
    await Core.waitFor(() => Core.bodyText().includes('일일 던전'));
  };

  Modules.dungeon.scanEligibleDungeons = function () {
    const queue = [];
    for (const dungeonDef of this.DUNGEONS) {
      if (dungeonDef.daily && !this.config.enableDailySewer) {
        Core.log('dungeon', `"${dungeonDef.label}" 비활성화 설정 - 건너뜀`);
        continue;
      }
      if (this.isDungeonCompletedToday(dungeonDef)) {
        Core.log('dungeon', `"${dungeonDef.label}" 오늘 이미 완료됨 - 건너뜀`);
        continue;
      }
      const tickets = this.getTicketCount(dungeonDef);
      if (!dungeonDef.daily && tickets <= 0) {
        Core.log('dungeon', `"${dungeonDef.label}" 입장권 없음(${dungeonDef.requiredItemName} 0개) - 건너뜀`);
        continue;
      }
      Core.log(
        'dungeon',
        dungeonDef.daily
          ? `"${dungeonDef.label}" 입장 가능 (일일 던전) - 큐에 추가`
          : `"${dungeonDef.label}" 입장 가능 (${dungeonDef.requiredItemName} ${tickets}개 보유) - 큐에 추가`
      );
      queue.push(dungeonDef);
    }
    return queue;
  };

  // v1.2.35 신규: "던전 입장 확인" 텍스트를 포함하면서 버튼을 가진 가장 좁은 컨테이너를
  // 찾는다(Core.findButtonInDialog와 달리 특정 버튼 텍스트에 의존하지 않고 컨테이너
  // 자체를 반환 - 이후 그 안에서 여러 버튼 중 하나를 골라야 하기 때문).
  Modules.dungeon.getEntryConfirmDialog = function () {
    const candidates = [...document.querySelectorAll('*')].filter((el) => {
      if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
      if (!el.textContent.includes('던전 입장 확인')) return false;
      return el.querySelectorAll('button').length > 0;
    });
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a.querySelectorAll('*').length < b.querySelectorAll('*').length ? a : b));
  };

  // "취소"를 제외한 입장 방법 버튼들 중 하나를 고른다. 버튼이 하나뿐이면(예전처럼
  // "입장" 버튼 하나만 있는 경우) 그냥 그걸 쓰고, "열쇠 N개 (에너지 무료)" /
  // "열쇠 M개 + 에너지 K" 처럼 여러 선택지가 있으면 v1.2.37 요청에 따라 에너지를
  // 같이 쓰는 옵션(열쇠 + 에너지)을 우선 선택한다. 그 옵션에 필요한 열쇠가 부족하면
  // "에너지 무료" 옵션으로 대체한다.
  Modules.dungeon.pickEntryMethodButton = function (dialogEl, ticketsAvailable) {
    const buttons = [...dialogEl.querySelectorAll('button')].filter((b) => b.textContent.trim() !== '취소');
    if (buttons.length === 0) return null;
    if (buttons.length === 1) return buttons[0];

    const enoughKeys = (btn) => {
      const m = btn.textContent.match(/열쇠\s*(\d+)\s*개/);
      const needed = m ? parseInt(m[1], 10) : 0;
      return ticketsAvailable === null || ticketsAvailable === undefined || ticketsAvailable >= needed;
    };

    const energyBtn = buttons.find((b) => /에너지/.test(b.textContent) && !/에너지\s*무료/.test(b.textContent));
    if (energyBtn && enoughKeys(energyBtn)) return energyBtn;
    if (energyBtn) {
      const m = energyBtn.textContent.match(/열쇠\s*(\d+)\s*개/);
      const needed = m ? parseInt(m[1], 10) : 0;
      Core.log('dungeon', `열쇠+에너지 입장에 필요한 열쇠(${needed}개)가 부족해(보유 ${ticketsAvailable}개) 다른 입장 방법을 사용합니다.`);
    }
    return buttons.find((b) => b !== energyBtn) || buttons[0];
  };

  Modules.dungeon.enterDungeon = async function (dungeonDef) {
    const card = this.getDungeonCardEl(dungeonDef.label);
    if (!card) {
      Core.log('dungeon', `"${dungeonDef.label}" 카드를 찾지 못함`);
      return false;
    }
    const enterBtn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '입장');
    if (!enterBtn || enterBtn.disabled) {
      Core.log('dungeon', `"${dungeonDef.label}" 입장 버튼이 없거나 비활성 상태`);
      return false;
    }

    enterBtn.click();
    await Core.humanDelay(1000, 1800);

    const charModalConfirm = await Core.retryStep(
      '캐릭터 정보 모달의 확인 버튼 찾기',
      () => {
        if (!Core.bodyText().includes('캐릭터 정보')) return null;
        return Core.findButtonInDialog('캐릭터 정보', '확인');
      },
      { attempts: 4, waits: [1000, 2000, 3000, 4000] }
    );
    if (charModalConfirm) {
      charModalConfirm.click();
      await Core.humanDelay(1000, 1900);
    }

    await Core.retryStep(
      '캐릭터 정보 모달 닫힘 확인',
      () => (!Core.bodyText().includes('캐릭터 정보') ? true : null),
      { attempts: 3, waits: [1000, 2000, 3000] }
    );

    const entryModalFound = await Core.retryStep(
      '던전 입장 확인 모달 찾기',
      () => (Core.bodyText().includes('던전 입장 확인') ? true : null),
      { attempts: 4, waits: [1000, 2000, 3000, 4000] }
    );
    if (!entryModalFound) {
      Core.log('dungeon', '"던전 입장 확인" 모달을 확인하지 못했습니다 (이미 입장됐을 수 있음).');
    } else {
      const deathMatch = await Core.retryStep(
        '부활 허용 횟수 문구 찾기',
        () => Core.bodyText().match(/(\d+)\s*번\s*사망\s*시\s*던전에서\s*강제\s*퇴장/),
        { attempts: 3, waits: [500, 1000, 1500] }
      );
      this.deathLimit = deathMatch ? parseInt(deathMatch[1], 10) : null;
      Core.log('dungeon', `"${dungeonDef.label}" 부활 허용: ${this.deathLimit ?? '알 수 없음'}회`);

      // v1.2.35 버그 수정: 예전엔 이 모달에 "취소"/"입장" 버튼 두 개만 있었는데,
      // 게임 업데이트로 "열쇠 N개 (에너지 무료)" / "열쇠 M개 + 에너지 K개" 같은
      // 복수의 입장 방법 선택지가 뜨는 경우가 생김. 정확히 텍스트가 "입장"인 버튼만
      // 찾던 기존 코드는 이런 화면에서 그 버튼을 영영 못 찾아 재시도만 반복하다
      // 멈춰버렸음 → 모달 컨테이너를 찾아 "취소"를 제외한 버튼들 중 적절한 것을
      // 고르도록 교체. 입장 방법이 여러 개면 v1.2.37 요청에 따라 "열쇠 + 에너지"를
      // 함께 쓰는 옵션을 우선 선택(해당 옵션의 열쇠가 부족하면 나머지 옵션 사용).
      // v1.2.40 버그 수정: 클릭까지는 됐다고 판단했는데 실제로는 모달이 그대로 남아
      // 있는 제보가 있었음(클릭이 씹혔거나 그 사이 모달이 다시 그려져 버튼 참조가
      // stale해졌을 가능성) - 클릭 후 모달이 실제로 닫혔는지 확인하고, 안 닫히면
      // 모달을 다시 찾아 버튼을 재선택해서 최대 3번까지 재시도하도록 강화.
      const tickets = this.getTicketCount(dungeonDef);
      let entryDismissed = false;
      for (let attempt = 1; attempt <= 3 && !entryDismissed; attempt++) {
        const entryDialog = await Core.retryStep('던전 입장 확인 모달 컨테이너 찾기', () => this.getEntryConfirmDialog());
        if (!entryDialog) {
          Core.log('dungeon', `입장 확인 모달 컨테이너를 찾지 못했습니다 (시도 ${attempt}/3).`);
          await Core.sleep(1200);
          continue;
        }
        const enterConfirmBtn = this.pickEntryMethodButton(entryDialog, dungeonDef.daily ? null : tickets);
        if (!enterConfirmBtn) {
          Core.log('dungeon', `입장 방법 버튼을 찾지 못했습니다 (시도 ${attempt}/3).`);
          await Core.sleep(1200);
          continue;
        }
        Core.log('dungeon', `입장 방법 선택: "${enterConfirmBtn.textContent.trim()}" (시도 ${attempt}/3)`);
        enterConfirmBtn.click();
        await Core.humanDelay(1100, 2000);
        entryDismissed = await Core.waitFor(() => (!Core.bodyText().includes('던전 입장 확인') ? true : null), 3000, 300);
        if (!entryDismissed) {
          Core.log('dungeon', `입장 확인 모달이 클릭 후에도 닫히지 않았습니다 (시도 ${attempt}/3) - 다시 시도합니다.`);
        }
      }
      if (!entryDismissed) {
        Core.log('dungeon', '던전 입장 확인 모달을 닫지 못했습니다 (여러 번 시도 후에도 실패).');
        return false;
      }
    }

    const enteredBattle = await Core.retryStep('던전 전투 화면 진입 확인', () =>
      /진행도/.test(Core.bodyText()) ? true : null
    );
    if (!enteredBattle) {
      Core.log('dungeon', '던전 전투 화면 진입을 확인하지 못했습니다.');
      return false;
    }

    this.difficulty = '매우어려움';
    this.instantClearTried = false;
    this.boughtGodStrikeOrEquiv = false;
    this.boughtGodStrikeExact = false;
    this.allStatsBoughtValue = 0;
    this.boughtSingleStat = {};
    this.boughtGodStrike = false;
    this.boughtCertainHit = false;
    this.boughtCritStrike = false;
    this.boughtRegen = false;
    return true;
  };

  Modules.dungeon.readProgress = function () {
    const m = Core.bodyText().match(/진행도\s*\n?\s*(\d+)\s*\/\s*15/);
    return m ? parseInt(m[1], 10) : null;
  };

  Modules.dungeon.selectDifficultyTab = async function () {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const target = tabs.find((t) => t.textContent.trim() === this.difficulty);
    if (!target) return false;
    if (target.getAttribute('aria-selected') !== 'true') {
      target.click();
      await Core.humanDelay(900, 1600);
    }
    return true;
  };

  Modules.dungeon.readStats = function () {
    const text = Core.bodyText();
    const grab = (label) => {
      const m = text.match(new RegExp(`${label}\\s*[:：]?\\s*([\\d,]+)`));
      return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
    };
    return {
      힘: grab('힘'),
      생명: grab('생명'),
      정신: grab('정신'),
      지능: grab('지능'),
      행운: grab('행운'),
      속도: grab('속도'),
    };
  };

  Modules.dungeon.estimateACEV = function () {
    const s = this.readStats();
    if (!s || s.속도 == null) return null;
    const atkSpeed = s.속도;
    const EV = (s.지능 || 0) * 3.5 + (s.행운 || 0) * 2 + atkSpeed * 2;
    const AC = (s.정신 || 0) * 2.8 + (s.행운 || 0) * 1.6 + atkSpeed * 1.6;
    return { AC, EV };
  };

  Modules.dungeon.findCombatStatsToggleButton = function () {
    const cardCandidates = [...document.querySelectorAll('*')].filter((el) => {
      if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
      const t = el.textContent;
      return t.includes('무기') && t.includes('HP') && t.includes('MP');
    });
    if (cardCandidates.length === 0) return null;
    const card = cardCandidates.reduce((a, b) => (a.querySelectorAll('*').length < b.querySelectorAll('*').length ? a : b));
    const buttons = [...card.querySelectorAll('button')];
    return buttons.find((b) => b.textContent.trim() !== '자세히') || null;
  };

  Modules.dungeon.ensureDetailsExpanded = async function () {
    if (/적중치[:：]?\s*[\d,]+/.test(Core.bodyText()) && /회피치[:：]?\s*[\d,]+/.test(Core.bodyText())) {
      return true;
    }
    const expanded = await Core.retryStep(
      '전투 스탯(적중치/회피치) 토글 펼치기',
      async () => {
        const btn = this.findCombatStatsToggleButton();
        if (!btn) return null;
        btn.click();
        await Core.humanDelay(800, 1500);
        return /적중치[:：]?\s*[\d,]+/.test(Core.bodyText()) && /회피치[:：]?\s*[\d,]+/.test(Core.bodyText()) ? true : null;
      },
      { attempts: 3, waits: [800, 1500, 2500] }
    );
    if (!expanded) {
      Core.log('dungeon', '전투 스탯 토글을 펼쳤지만 적중치/회피치 텍스트를 확인하지 못했습니다 - 근사 공식으로 대체합니다.');
    }
    return expanded;
  };

  Modules.dungeon.readRealACEV = function () {
    const text = Core.bodyText();
    const acMatch = text.match(/적중치[:：]?\s*([\d,]+)/);
    const evMatch = text.match(/회피치[:：]?\s*([\d,]+)/);
    if (!acMatch || !evMatch) return null;
    return { AC: parseInt(acMatch[1].replace(/,/g, ''), 10), EV: parseInt(evMatch[1].replace(/,/g, ''), 10) };
  };

  Modules.dungeon.getCurrentACEV = async function () {
    await this.ensureDetailsExpanded();
    const real = this.readRealACEV();
    if (real) return { AC: real.AC, EV: real.EV, isReal: true };
    const est = this.estimateACEV();
    return est ? { AC: est.AC, EV: est.EV, isReal: false } : null;
  };

  Modules.dungeon.meetsInstantClearRequirement = function (dungeonDef) {
    const req = dungeonDef.instantClearRequirement;
    if (!req) return { ok: true };
    const missing = [];
    if (req.requireGodStrike && !this.boughtGodStrikeExact) missing.push('신의 일격 미구매');
    if (req.minAllStats && this.allStatsBoughtValue < req.minAllStats) {
      missing.push(`모든 스탯 합계 ${this.allStatsBoughtValue}/${req.minAllStats}`);
    }
    if (req.requireStats) {
      req.requireStats.forEach((stat) => {
        if (!this.boughtSingleStat[stat]) missing.push(`${stat} 미구매`);
      });
    }
    return { ok: missing.length === 0, missing };
  };

  Modules.dungeon.tryInstantClear = async function (dungeonDef) {
    if (this.instantClearTried) return false;

    // v1.2.34 신규: 체크박스로 "즉시완료 강제"가 켜진 던전은 적중치/회피치 기준이나
    // 신의 일격/모든 스탯 같은 즉시완료 추가 조건을 전혀 확인하지 않고, 전투 화면에
    // 들어가자마자 곧바로 즉시 최상층 도전을 시도한다.
    const forced = !!this.config.forceInstantClear[dungeonDef.id];
    let logSuffix = '';

    if (!forced) {
      const target = this.config.instantClear[dungeonDef.id];
      if (!target || (!target.targetAC && !target.targetEV)) return false;

      const reqCheck = this.meetsInstantClearRequirement(dungeonDef);
      if (!reqCheck.ok) {
        Core.log('dungeon', `즉시완료 추가 조건 미충족 (${reqCheck.missing.join(', ')}) → 다음 전투에서 다시 확인`);
        return false;
      }

      const est = await this.getCurrentACEV();
      if (!est) return false;
      const tag = est.isReal ? '실제' : '추정';
      if (est.AC < target.targetAC || est.EV < target.targetEV) {
        Core.log(
          'dungeon',
          `즉시완료 기준 미달 (${tag} 적중 ${Math.round(est.AC)}/${target.targetAC}, ${tag} 회피 ${Math.round(est.EV)}/${target.targetEV}) → 다음 전투에서 다시 확인`
        );
        return false;
      }
      logSuffix = ` (${tag} 적중 ${Math.round(est.AC)}/${target.targetAC}, ${tag} 회피 ${Math.round(est.EV)}/${target.targetEV})`;
    } else {
      Core.log('dungeon', `"${dungeonDef.label}" 체크된 즉시완료 강제 옵션 - 조건 확인 없이 바로 즉시 최상층 도전 시도`);
    }

    const btn = Core.findButtonByText('즉시 최상층 도전');
    if (!btn || btn.disabled) {
      // v1.2.38 버그 수정: 이 버튼이 아직 화면에 없거나 일시적으로 비활성 상태인
      // 경우까지 "다시는 시도 안 함"으로 영구 확정해버리던 문제 수정. 실제로 도전
      // 버튼을 누른 적이 없으므로(=진짜 실패가 아니므로) instantClearTried를 세우지
      // 않고 다음 전투에서 다시 확인하도록 함 - 조건을 다 채웠는데도 이 버튼이 한 번
      // 안 보였다는 이유만으로 그 던전에서 즉시완료가 영영 안 되던 원인 중 하나였음.
      Core.log('dungeon', '"즉시 최상층 도전" 버튼을 아직 사용할 수 없는 상태입니다 - 다음 전투에서 다시 확인합니다.');
      return false;
    }
    if (!forced) {
      Core.log('dungeon', `즉시완료 기준 충족${logSuffix} → 즉시 최상층 도전 시도`);
    }
    btn.click();
    await Core.humanDelay(1100, 2000);
    const confirmBtn = await Core.retryStep(
      '즉시 최상층 도전 확인 팝업의 "도전" 버튼 찾기',
      () => (Core.bodyText().includes('즉시 최상층 도전') ? Core.findButtonInDialog('즉시 최상층 도전', '도전') : null),
      { attempts: 3, waits: [800, 1500, 2500] }
    );
    if (confirmBtn) {
      confirmBtn.click();
      await Core.humanDelay(1100, 2000);
    } else {
      Core.log('dungeon', '즉시 최상층 도전 확인 팝업을 찾지 못했습니다 (이미 진행됐을 수 있음).');
    }
    this.instantClearTried = true;
    return true;
  };

  Modules.dungeon.startBattle = async function () {
    await this.selectDifficultyTab();
    const btn = await Core.retryStep('전투 시작 버튼 찾기', () => Core.findButtonByText('전투 시작'));
    if (!btn) return false;
    btn.click();
    const registered = await Core.waitFor(
      () => (/전투\s*중|승리!|패배\.{2,}/.test(Core.bodyText()) ? true : null),
      3000,
      300
    );
    if (!registered) {
      Core.log('dungeon', '전투 시작 클릭 반응이 없어 다시 클릭합니다.');
      const btnAgain = Core.findButtonByText('전투 시작');
      if (btnAgain && !btnAgain.disabled) {
        btnAgain.click();
      }
    }
    await Core.humanDelay(1100, 2000);
    return true;
  };

  Modules.dungeon.waitForBattleResult = async function () {
    return Core.retryStep(
      '전투 결과 확인',
      () => {
        const t = Core.bodyText();
        if (/승리!/.test(t)) return 'win';
        if (/패배\.{2,}/.test(t)) return 'lose';
        return null;
      },
      { attempts: 5, waits: [1500, 3000, 5000, 8000, 12000] }
    );
  };

  Modules.dungeon.clickBackFromResult = async function () {
    const btn = await Core.retryStep('돌아가기 버튼 찾기', () => Core.findButtonByText('돌아가기'));
    if (!btn) return false;
    btn.click();
    await Core.humanDelay(1100, 2000);
    return true;
  };

  Modules.dungeon.isShopScreen = function () {
    return /아이템\s*상점/.test(Core.bodyText());
  };

  Modules.dungeon.isDungeonCompleteScreen = function () {
    return /던전\s*완료\s*보상/.test(Core.bodyText());
  };

  Modules.dungeon.getShopTokenCount = function () {
    const m = Core.bodyText().match(/아이템\s*상점\s*\n?\s*(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  };

  Modules.dungeon.GRADE_COLORS_ALL = [
    'rgb(255, 215, 0)',
    'rgb(255, 20, 147)',
    'rgb(192, 192, 192)',
    'rgb(205, 127, 50)',
  ];

  Modules.dungeon.getShopCards = function () {
    if (!this.isShopScreen()) return [];
    const bordered = [...document.querySelectorAll('*')].filter((el) => {
      if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
      const style = getComputedStyle(el);
      if (style.borderStyle === 'none' || parseFloat(style.borderWidth) <= 0) return false;
      return this.GRADE_COLORS_ALL.includes(style.borderColor);
    });
    const seen = new Set();
    const cards = [];
    for (const el of bordered) {
      const label = (el.innerText || el.textContent).trim().split('\n')[0].trim();
      if (!label || label.length > 30 || seen.has(label)) continue;
      seen.add(label);
      cards.push({ selectEl: el, label, borderColor: getComputedStyle(el).borderColor });
      if (cards.length >= 3) break;
    }
    return cards;
  };

  Modules.dungeon.isRegenLabel = function (label) {
    return /재생\s*LV\s*[45]/.test(label);
  };

  Modules.dungeon.isGodStrikeFamily = function (label) {
    return /신의\s*일격|일격\s*필살|회심의\s*일격/.test(label);
  };

  Modules.dungeon.isAllStatsLabel = function (label) {
    return /모든\s*스탯\s*\+/.test(label);
  };

  Modules.dungeon.parseStatLabel = function (label) {
    const m = label.match(/(속도|행운|정신|지능|힘|생명|체력|마나)\s*\+(\d+)/);
    if (!m) return null;
    return { stat: m[1], value: parseInt(m[2], 10) };
  };

  Modules.dungeon.parseAllStatsValue = function (label) {
    const m = label.match(/^모든\s*스탯\s*\+(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  };

  Modules.dungeon.qualifiesGrade = function (borderColor) {
    return borderColor === GRADE_COLOR.gold || borderColor === GRADE_COLOR.rainbow;
  };

  Modules.dungeon.pickShopCard = function (dungeonDef, cards, isLastShopBeforeBoss) {
    if (dungeonDef.abilityMode === 'equalPriority') {
      if (!this.boughtGodStrikeOrEquiv) {
        const abilityCard = cards.find((c) => this.isGodStrikeFamily(c.label));
        if (abilityCard) {
          const isExactGodStrike = /신의\s*일격/.test(abilityCard.label);
          return {
            card: abilityCard,
            onBought: () => {
              this.boughtGodStrikeOrEquiv = true;
              if (isExactGodStrike) this.boughtGodStrikeExact = true;
            },
          };
        }
      }
    } else {
      if (!this.boughtGodStrike) {
        const c = cards.find((c) => /신의\s*일격/.test(c.label));
        if (c)
          return {
            card: c,
            onBought: () => {
              this.boughtGodStrike = true;
              this.boughtGodStrikeExact = true;
            },
          };
      }
    }

    const allStatCards = cards.filter((c) => this.isAllStatsLabel(c.label));
    if (allStatCards.length > 0) {
      allStatCards.sort((a, b) => this.parseAllStatsValue(b.label) - this.parseAllStatsValue(a.label));
      // v1.2.41 수정: "횟수(+= 1)"가 아니라 카드에 적힌 수치(예: "모든 스탯 +30" → 30)를
      // 그대로 누적 합산한다. 이렇게 하면 하급 카드를 여러 번 사서 "횟수"만 채우는
      // 것과 상급 카드 1장을 사는 것을 동일하게 취급하지 않고, 실제 스탯 총합 기준으로
      // 즉시완료 조건 충족 여부를 정확히 판단할 수 있다.
      const pickedValue = this.parseAllStatsValue(allStatCards[0].label);
      return { card: allStatCards[0], onBought: () => (this.allStatsBoughtValue += pickedValue) };
    }

    if (dungeonDef.abilityMode === 'ordered') {
      if (!this.boughtCertainHit) {
        const c = cards.find((c) => /일격\s*필살/.test(c.label));
        if (c) return { card: c, onBought: () => (this.boughtCertainHit = true) };
      }
      if (!this.boughtCritStrike) {
        const c = cards.find((c) => /회심의\s*일격/.test(c.label));
        if (c) return { card: c, onBought: () => (this.boughtCritStrike = true) };
      }
      if (!this.boughtRegen) {
        const c = cards.find((c) => this.isRegenLabel(c.label));
        if (c) return { card: c, onBought: () => (this.boughtRegen = true) };
      }
    }

    const statOrder = dungeonDef.statMode === 'extended' ? STAT_EXTENDED_ORDER : STAT_TARGET_ORDER;
    const statCandidates = cards
      .map((c) => ({ c, parsed: this.parseStatLabel(c.label) }))
      .filter(
        (x) =>
          x.parsed &&
          statOrder.includes(x.parsed.stat) &&
          !this.boughtSingleStat[x.parsed.stat] &&
          this.qualifiesGrade(x.c.borderColor)
      );
    if (statCandidates.length > 0) {
      statCandidates.sort((a, b) => b.parsed.value - a.parsed.value);
      const best = statCandidates[0];
      return { card: best.c, onBought: () => (this.boughtSingleStat[best.parsed.stat] = true) };
    }

    if (isLastShopBeforeBoss && cards.length > 0) {
      const withValue = cards.map((c) => {
        const stat = this.parseStatLabel(c.label);
        const all = this.parseAllStatsValue(c.label);
        return { c, value: stat ? stat.value : all };
      });
      withValue.sort((a, b) => b.value - a.value);
      return { card: withValue[0].c, onBought: () => {} };
    }

    return null;
  };

  Modules.dungeon.handleShop = async function (dungeonDef, progress) {
    const isLastShopBeforeBoss = progress === 14;
    let rerollGuard = 0;
    while (this.running) {
      const tokens = this.getShopTokenCount();
      const cards = this.getShopCards();
      if (cards.length === 0) {
        Core.log('dungeon', '상점 카드를 파싱하지 못했습니다. 넘어가기를 시도합니다.');
        break;
      }

      const pick = this.pickShopCard(dungeonDef, cards, isLastShopBeforeBoss);
      const isPremiumPick = pick && (this.isGodStrikeFamily(pick.card.label) || this.isAllStatsLabel(pick.card.label));
      const shouldBuyNow = pick && (isLastShopBeforeBoss || rerollGuard === 0 || isPremiumPick);

      if (shouldBuyNow) {
        let bought = false;
        for (let buyAttempt = 0; buyAttempt < 2 && !bought; buyAttempt++) {
          pick.card.selectEl.click();
          await Core.humanDelay(900, 1600);
          const buyBtn = Core.findButtonByText('구매');
          if (!buyBtn) break;
          buyBtn.click();
          await Core.humanDelay(1100, 2000);
          bought = await Core.waitFor(
            () => (!this.isShopScreen() || Core.bodyText().includes('구매했습니다') ? true : null),
            4000
          );
          bought = bought && Core.bodyText().includes('구매했습니다');
          if (!bought && buyAttempt === 0) {
            Core.log('dungeon', `"${pick.card.label}" 구매 확인 실패 - 한 번 더 시도`);
            await Core.humanDelay(500, 1000);
          }
        }
        if (bought) {
          pick.onBought();
          Core.log('dungeon', `상점 구매: ${pick.card.label}`);
          return;
        }
        Core.log('dungeon', `"${pick.card.label}" 구매를 확인하지 못함(재시도 포함) - 넘어가기로 진행`);
        break;
      }
      if (pick && !isPremiumPick) {
        Core.log('dungeon', `리롤 중 - "${pick.card.label}"은 신의 일격/모든 스탯이 아니라 구매하지 않고 계속 리롤합니다.`);
      }

      if (!isLastShopBeforeBoss && tokens >= this.config.rerollMinTokens && rerollGuard < 200) {
        const rerollBtn = Core.findButtonByText('리롤');
        if (rerollBtn && !rerollBtn.disabled) {
          rerollBtn.click();
          await Core.humanDelay(1100, 2000);
          rerollGuard += 1;
          continue;
        }
        Core.log('dungeon', '리롤 버튼을 찾지 못했거나 비활성 상태입니다.');
      } else if (!isLastShopBeforeBoss) {
        Core.log('dungeon', `리롤 조건 미충족 (토큰 ${tokens}/${this.config.rerollMinTokens}) - 넘어가기로 진행`);
      }
      break;
    }

    const skipBtn = Core.findButtonByText('넘어가기');
    if (skipBtn) {
      skipBtn.click();
      await Core.humanDelay(1100, 2000);
    }
  };

  Modules.dungeon.runOneDungeon = async function (dungeonDef, opts = {}) {
    if (!opts.resume) {
      Core.log('dungeon', `"${dungeonDef.label}" 입장 시도`);
      const entered = await this.enterDungeon(dungeonDef);
      if (!entered || !this.running) return false;
    } else {
      Core.log('dungeon', `"${dungeonDef.label}" 이미 진행 중이던 상태에서 이어서 진행합니다.`);
      this.instantClearTried = false;
      this.boughtGodStrikeOrEquiv = false;
      this.boughtGodStrikeExact = false;
      this.allStatsBoughtValue = 0;
      this.boughtSingleStat = {};
      this.boughtGodStrike = false;
      this.boughtCertainHit = false;
      this.boughtCritStrike = false;
      this.boughtRegen = false;
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      const selectedTab = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
      if (selectedTab && ['쉬움', '어려움', '매우어려움'].includes(selectedTab.textContent.trim())) {
        this.difficulty = selectedTab.textContent.trim();
      }
    }

    while (this.running) {
      const progress = this.readProgress();
      if (progress === null) {
        Core.log('dungeon', '진행도를 읽지 못했습니다. 상점/완료 화면인지 확인합니다.');
      }

      if (this.isDungeonCompleteScreen()) {
        const claimBtn = await Core.retryStep('"보상 받고 던전 나가기" 버튼 찾기', () =>
          Core.findButtonByText('보상 받고 던전 나가기')
        );
        if (!claimBtn) {
          Core.notifyStopped('dungeon', '"보상 받고 던전 나가기" 버튼을 찾지 못했습니다.');
          return false;
        }
        claimBtn.click();
        await Core.humanDelay(1100, 2000);
        const left = await Core.retryStep(
          '보상 수령 후 화면 전환 확인',
          () => (!this.isDungeonCompleteScreen() ? true : null),
          { attempts: 3, waits: [1000, 2000, 3000] }
        );
        if (!left) {
          Core.notifyStopped('dungeon', '보상을 받았지만 화면 전환을 확인하지 못했습니다. 상태를 확인해주세요.');
          return false;
        }
        Core.log('dungeon', `"${dungeonDef.label}" 클리어 완료! (보상 수령 확인됨)`);
        this.cycleCount += 1;
        this.saveClearCount(this.cycleCount);
        Core.updateModuleButtons();
        return true;
      }

      if (this.isShopScreen()) {
        await this.handleShop(dungeonDef, progress);
        if (!this.running) return false;
        continue;
      }

      if (/이번\s*전투에서\s*상대할/.test(Core.bodyText())) {
        let result = null;
        let resultWasInstant = false;
        for (let battleAttempt = 0; battleAttempt < 3 && !result && this.running; battleAttempt++) {
          let usedInstant = false;
          if (!this.instantClearTried) {
            usedInstant = await this.tryInstantClear(dungeonDef);
          }
          if (!usedInstant) {
            await this.selectDifficultyTab();
            const started = await this.startBattle();
            if (!started) {
              Core.log('dungeon', `"전투 시작" 버튼을 찾지 못했습니다 (시도 ${battleAttempt + 1}/3).`);
              await Core.sleep(2000);
              continue;
            }
          }
          result = await this.waitForBattleResult();
          if (result) {
            resultWasInstant = usedInstant;
          } else {
            Core.log('dungeon', `전투 결과 확인 실패 (시도 ${battleAttempt + 1}/3) - 재시도`);
            await Core.sleep(2000);
          }
        }

        if (result === 'win') {
          await this.clickBackFromResult();
          continue;
        }
        if (result === 'lose') {
          if (resultWasInstant) {
            Core.log('dungeon', '즉시완료(즉시 최상층 도전) 실패 - 난이도는 그대로 유지하고 정공법으로 15단계까지 계속 진행합니다.');
          } else {
            Core.log('dungeon', `전투 패배 (난이도: ${this.difficulty})`);
            if (this.difficulty === '매우어려움') {
              this.difficulty = '어려움';
              Core.log('dungeon', '매우어려움에서 패배 → 이후 어려움으로 난이도를 낮춰서 계속 진행 (다시 올리지 않음)');
            }
          }
          await this.clickBackFromResult();
          const stillInDungeon = await Core.waitFor(
            () => (/진행도|아이템\s*상점/.test(Core.bodyText()) ? true : null),
            4000
          );
          if (!stillInDungeon) {
            Core.log('dungeon', '부활 허용 횟수를 초과하여 던전에서 강제 퇴장된 것으로 보입니다.');
            return false;
          }
          continue;
        }
        Core.notifyStopped('dungeon', '전투 결과를 여러 번 재시도해도 확인하지 못했습니다. 화면 상태를 확인해주세요.');
        return false;
      }

      await Core.sleep(1500);
      if (!/진행도|아이템\s*상점|던전\s*완료\s*보상/.test(Core.bodyText())) {
        Core.log('dungeon', '알 수 없는 화면 상태 - 정지합니다.');
        return false;
      }
    }
    return false;
  };

  Modules.dungeon.detectResumeDungeon = function () {
    if (!/진행도/.test(Core.bodyText())) return null;
    for (const d of this.DUNGEONS) {
      const heading = [...document.querySelectorAll('*')].find(
        (el) =>
          el.children.length === 0 &&
          el.textContent.trim() === d.label &&
          !el.closest('#lrm-panel') &&
          !el.closest('#lrm-banner')
      );
      if (heading) return d;
    }
    return null;
  };

  const DUNGEON_CONFIG_KEY = 'lrm-dungeon-config';

  Modules.dungeon.saveConfig = function () {
    try {
      localStorage.setItem(
        DUNGEON_CONFIG_KEY,
        JSON.stringify({
          enableDailySewer: this.config.enableDailySewer,
          rerollMinTokens: this.config.rerollMinTokens,
          instantClear: this.config.instantClear,
          forceInstantClear: this.config.forceInstantClear,
        })
      );
    } catch (e) {
      /* localStorage 사용 불가 환경이면 조용히 무시 */
    }
  };

  Modules.dungeon.loadConfigIntoSelf = function () {
    try {
      const raw = localStorage.getItem(DUNGEON_CONFIG_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (typeof saved.enableDailySewer === 'boolean') this.config.enableDailySewer = saved.enableDailySewer;
      if (typeof saved.rerollMinTokens === 'number') this.config.rerollMinTokens = saved.rerollMinTokens;
      if (saved.instantClear) {
        Object.keys(this.config.instantClear).forEach((id) => {
          if (saved.instantClear[id]) {
            if (typeof saved.instantClear[id].targetAC === 'number') this.config.instantClear[id].targetAC = saved.instantClear[id].targetAC;
            if (typeof saved.instantClear[id].targetEV === 'number') this.config.instantClear[id].targetEV = saved.instantClear[id].targetEV;
          }
        });
      }
      if (saved.forceInstantClear) {
        Object.keys(this.config.forceInstantClear).forEach((id) => {
          if (typeof saved.forceInstantClear[id] === 'boolean') this.config.forceInstantClear[id] = saved.forceInstantClear[id];
        });
      }
    } catch (e) {
      /* 저장된 값이 손상됐으면 기본값 그대로 사용 */
    }
  };

  const DUNGEON_CLEAR_COUNT_KEY = 'lrm-dungeon-cleared-today';

  Modules.dungeon.getTodayDateStr = function () {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  Modules.dungeon.loadClearCount = function () {
    try {
      const raw = localStorage.getItem(DUNGEON_CLEAR_COUNT_KEY);
      if (!raw) return 0;
      const data = JSON.parse(raw);
      if (data.date !== this.getTodayDateStr()) return 0;
      return data.count || 0;
    } catch (e) {
      return 0;
    }
  };

  Modules.dungeon.saveClearCount = function (count) {
    try {
      localStorage.setItem(DUNGEON_CLEAR_COUNT_KEY, JSON.stringify({ date: this.getTodayDateStr(), count }));
    } catch (e) {
      /* localStorage 사용 불가 환경이면 조용히 무시 */
    }
  };

  Modules.dungeon.mainLoop = async function () {
    const mod = this;
    mod.cycleCount = mod.loadClearCount();
    Core.log('dungeon', `던전 자동클리어 시작 (오늘 이미 클리어한 던전: ${mod.cycleCount}개)`);

    const resumeDungeon = mod.detectResumeDungeon();
    if (resumeDungeon) {
      Core.log('dungeon', `이미 진행 중이던 "${resumeDungeon.label}"을(를) 인식했습니다 - 이어서 진행합니다.`);
      await mod.runOneDungeon(resumeDungeon, { resume: true });
      if (!mod.running) {
        Core.log('dungeon', `던전 자동클리어 종료. 오늘 클리어한 던전: ${mod.cycleCount}개`);
        mod.running = false;
        Core.activeModuleId = Core.activeModuleId === 'dungeon' ? null : Core.activeModuleId;
        Core.updateModuleButtons();
        return;
      }
    }

    await mod.goToDungeonSelect();
    if (!mod.running) return;

    const queue = mod.scanEligibleDungeons();
    if (queue.length === 0) {
      Core.log('dungeon', '입장 가능한 던전이 없습니다 (전부 완료됐거나 입장권이 없음). 정지합니다.');
      mod.running = false;
      Core.activeModuleId = Core.activeModuleId === 'dungeon' ? null : Core.activeModuleId;
      Core.updateModuleButtons();
      return;
    }
    Core.log('dungeon', `입장 큐 확정: ${queue.map((d) => d.label).join(' → ')}`);

    for (const dungeonDef of queue) {
      if (!mod.running) break;

      if (!/일일\s*던전/.test(Core.bodyText())) {
        await mod.goToDungeonSelect();
      }
      if (!mod.running) break;

      await mod.runOneDungeon(dungeonDef);
      if (!mod.running) break;
    }

    Core.log('dungeon', `던전 자동클리어 종료. 오늘 클리어한 던전: ${mod.cycleCount}개`);
    mod.running = false;
    Core.activeModuleId = Core.activeModuleId === 'dungeon' ? null : Core.activeModuleId;
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
    mod.running = false;
    if (Core.activeModuleId === moduleId) Core.activeModuleId = null;
    Core.log(moduleId, '사용자 요청으로 정지합니다...');
    Core.updateModuleButtons();
  };

  // ==========================================================================
  // 패널 UI (탭 구조, 하나의 패널을 네 모듈이 공유)
  // ==========================================================================
  const UIRefs = { rejob: {}, autohunt: {}, raremap: {}, dungeon: {} };
  let activeTab = 'rejob';

  Core.updateModuleButtons = function () {
    ['rejob', 'autohunt', 'raremap', 'dungeon'].forEach((id) => {
      const mod = Modules[id];
      const refs = UIRefs[id];
      if (!refs.startBtn) return;
      const otherRunning = Core.activeModuleId && Core.activeModuleId !== id;
      refs.startBtn.disabled = mod.running || otherRunning;
      refs.stopBtn.disabled = !mod.running;
      const cycleLabel = id === 'dungeon' ? `오늘 클리어 ${mod.cycleCount}개` : `사이클 ${mod.cycleCount}`;
      refs.statusEl.textContent = mod.running ? `실행중 (${cycleLabel})` : otherRunning ? '다른 모듈 실행중' : '대기중';
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

  const REJOB_PERSIST_KEYS = ['targetScore', 'tierIndex', 'maxRejobCount', 'useHiddenRoomMap'];

  function buildRejobTab(container) {
    const mod = Modules.rejob;
    const refs = UIRefs.rejob;
    Core.loadModuleConfig('rejob', REJOB_PERSIST_KEYS);
    container.appendChild(labelEl('목표 강함점수'));
    const scoreInput = document.createElement('input');
    scoreInput.type = 'number';
    scoreInput.value = mod.config.targetScore;
    scoreInput.style.cssText = inputStyle();
    scoreInput.addEventListener('change', (e) => {
      mod.config.targetScore = parseInt(e.target.value, 10) || 5000;
      Core.saveModuleConfig('rejob', REJOB_PERSIST_KEYS);
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

    // v1.2.27 신규: "숨겨진 방의 지도" 사용 옵션. 체크 시 일반 사냥터(50연전) 대신
    // 광산에서 지도로 "깨달음의 방"을 만들어 1회 전투로 레벨 100을 만든다.
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
    refs.inputs = [scoreInput, tierSelect, maxInput, hiddenRoomCheck];
  }

  const AUTOHUNT_PERSIST_KEYS = ['groundSuffix', 'floor', 'goldThreshold', 'minEnergy', 'ignoreProtectionOff'];

  function buildAutohuntTab(container) {
    const mod = Modules.autohunt;
    const refs = UIRefs.autohunt;
    Core.loadModuleConfig('autohunt', AUTOHUNT_PERSIST_KEYS);

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
    protLabel.textContent = '보호용 기름 없이도 사냥 (체크 시 기름 없어도 정지 안 함)';
    protLabel.style.cssText = 'font-size:11px; color:#ccc;';
    protRow.appendChild(protCheck);
    protRow.appendChild(protLabel);
    container.appendChild(protRow);

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
    refs.inputs = [groundSelect, floorSelect, goldInput, energyInput, protCheck];
  }

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

  function buildDungeonTab(container) {
    const mod = Modules.dungeon;
    const refs = UIRefs.dungeon;
    mod.loadConfigIntoSelf();

    const dailyRow = document.createElement('div');
    dailyRow.style.cssText = 'display:flex; align-items:center; gap:6px; margin:4px 0;';
    const dailyCheck = document.createElement('input');
    dailyCheck.type = 'checkbox';
    dailyCheck.checked = mod.config.enableDailySewer;
    dailyCheck.addEventListener('change', (e) => {
      mod.config.enableDailySewer = e.target.checked;
      mod.saveConfig();
    });
    const dailyLabel = document.createElement('span');
    dailyLabel.textContent = '일일 던전: 지하 하수도 포함 (깊은 숲속/각성의 탑은 수동)';
    dailyLabel.style.cssText = 'font-size:11px; color:#ccc;';
    dailyRow.appendChild(dailyCheck);
    dailyRow.appendChild(dailyLabel);
    container.appendChild(dailyRow);

    container.appendChild(labelEl('던전 순서 (자동): [구]수행자의 탑 → 수행자의 탑 → [구]신비의 동굴 → 신비의 동굴 → 지하 하수도'));

    container.appendChild(labelEl('리롤 최소 보유 토큰'));
    const rerollInput = document.createElement('input');
    rerollInput.type = 'number';
    rerollInput.value = mod.config.rerollMinTokens;
    rerollInput.style.cssText = inputStyle();
    rerollInput.addEventListener('change', (e) => {
      mod.config.rerollMinTokens = parseInt(e.target.value, 10) || 50;
      mod.saveConfig();
    });
    container.appendChild(rerollInput);

    container.appendChild(labelEl('던전별 즉시완료 목표치 (0 = 즉시완료 시도 안 함) / 체크 시 조건 없이 즉시완료'));

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex; gap:4px; align-items:center; margin-bottom:2px;';
    const headerCheck = document.createElement('span');
    headerCheck.style.cssText = 'width:16px;';
    const headerNameSpan = document.createElement('span');
    headerNameSpan.style.cssText = 'flex:1.4;';
    const headerAC = document.createElement('span');
    headerAC.textContent = '적중치';
    headerAC.style.cssText = 'flex:1; font-size:10px; color:#f5a623; text-align:center;';
    const headerEV = document.createElement('span');
    headerEV.textContent = '회피치';
    headerEV.style.cssText = 'flex:1; font-size:10px; color:#4fc3f7; text-align:center;';
    headerRow.appendChild(headerCheck);
    headerRow.appendChild(headerNameSpan);
    headerRow.appendChild(headerAC);
    headerRow.appendChild(headerEV);
    container.appendChild(headerRow);

    const instantInputs = [];
    mod.DUNGEONS.forEach((d) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:4px; align-items:center; margin-bottom:2px;';

      // v1.2.34 신규: 체크하면 이 던전은 적중치/회피치 기준이나 즉시완료 추가 조건을
      // 전혀 확인하지 않고, 전투 화면에 들어가자마자 곧바로 즉시 최상층 도전을 시도한다.
      const forceCheck = document.createElement('input');
      forceCheck.type = 'checkbox';
      forceCheck.title = '체크 시 조건 확인 없이 시작하자마자 즉시 최상층 도전';
      forceCheck.checked = !!mod.config.forceInstantClear[d.id];
      forceCheck.style.cssText = 'width:14px; height:14px; flex:none;';
      forceCheck.addEventListener('change', (e) => {
        mod.config.forceInstantClear[d.id] = e.target.checked;
        acInput.disabled = e.target.checked;
        evInput.disabled = e.target.checked;
        mod.saveConfig();
      });

      const nameSpan = document.createElement('span');
      nameSpan.textContent = d.label;
      nameSpan.style.cssText = 'font-size:10px; color:#aaa; flex:1.4; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      const acInput = document.createElement('input');
      acInput.type = 'number';
      acInput.title = '목표 적중치';
      acInput.placeholder = '적중';
      acInput.value = mod.config.instantClear[d.id].targetAC;
      acInput.disabled = forceCheck.checked;
      acInput.style.cssText = inputStyle() + 'flex:1;';
      acInput.addEventListener('change', (e) => {
        mod.config.instantClear[d.id].targetAC = parseInt(e.target.value, 10) || 0;
        mod.saveConfig();
      });
      const evInput = document.createElement('input');
      evInput.type = 'number';
      evInput.title = '목표 회피치';
      evInput.placeholder = '회피';
      evInput.value = mod.config.instantClear[d.id].targetEV;
      evInput.disabled = forceCheck.checked;
      evInput.style.cssText = inputStyle() + 'flex:1;';
      evInput.addEventListener('change', (e) => {
        mod.config.instantClear[d.id].targetEV = parseInt(e.target.value, 10) || 0;
        mod.saveConfig();
      });
      row.appendChild(forceCheck);
      row.appendChild(nameSpan);
      row.appendChild(acInput);
      row.appendChild(evInput);
      container.appendChild(row);
      instantInputs.push(forceCheck, acInput, evInput);
    });

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
    startBtn.addEventListener('click', () => Core.startModule('dungeon'));
    stopBtn.addEventListener('click', () => Core.requestStopModule('dungeon'));
    btnRow.appendChild(startBtn);
    btnRow.appendChild(stopBtn);
    container.appendChild(btnRow);
    container.appendChild(statusEl);

    const hint = document.createElement('div');
    hint.textContent = '※ 캐릭터 카드의 "자세히"를 펼치면 나오는 실제 적중치/회피치를 우선 사용하고, 확인이 안 되면 근사 공식으로 대체 판단합니다.';
    hint.style.cssText = 'color:#888; font-size:10px; margin-top:4px;';
    container.appendChild(hint);

    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.inputs = [dailyCheck, rerollInput, ...instantInputs];
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
    header.textContent = '🎯 라니스 통합 매크로';
    header.style.cssText = 'cursor:move; font-weight:bold; padding:8px 10px; background:#262626; border-radius:8px 8px 0 0; user-select:none;';
    panel.appendChild(header);

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
    Core.log('core', '통합 매크로 패널 로드 완료 (재전직 / 자동사냥 / 레어맵 / 던전)');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();
