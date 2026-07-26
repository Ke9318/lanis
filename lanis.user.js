// ==UserScript==
// @name         lanis
// @namespace    lanis
// @version      1.5.0-stable
// @description  재전직 / 자동사냥 / 레어맵 / 던전 / 심층던전 자동클리어와 개인 보스 자동화를 제공. 기존 통합 패널과 보스 도구는 서로 독립적으로 동작.
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
      let workerFailed = false;
      const fallback = (resolve, ms) => setTimeout(resolve, Math.max(0, ms));
      worker.onmessage = function (e) {
        const item = pending.get(e.data);
        if (item) {
          pending.delete(e.data);
          item.resolve();
        }
      };
      worker.onerror = function (event) {
        workerFailed = true;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        for (const item of pending.values()) {
          const elapsed = Date.now() - item.startedAt;
          fallback(item.resolve, item.ms - elapsed);
        }
        pending.clear();
        try {
          worker.terminate();
          URL.revokeObjectURL(url);
        } catch (e) {
          /* 정리 실패는 무시 */
        }
      };
      return function (ms) {
        return new Promise((resolve) => {
          if (workerFailed) {
            fallback(resolve, ms);
            return;
          }
          const id = ++counter;
          pending.set(id, { resolve, ms, startedAt: Date.now() });
          try {
            worker.postMessage({ id, ms });
          } catch (e) {
            pending.delete(id);
            fallback(resolve, ms);
          }
        });
      };
    } catch (e) {
      return null; // 워커를 만들 수 없는 환경 - 아래에서 기존 방식으로 폴백
    }
  })();

  Core.sleep = Core._bgSleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  Core.rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  Core.humanDelay = (minMs, maxMs) => Core.sleep(minMs + Math.random() * (maxMs - minMs));

  Core.isRunCancelled = function (moduleId, runId) {
    if (!moduleId) return false;
    const mod = Modules[moduleId];
    return !mod || !mod.running || mod.stopRequested || (runId !== undefined && mod.runId !== runId);
  };

  Core.defaultShouldCancel = function () {
    const ctx = Core.runContext;
    return !!ctx && Core.isRunCancelled(ctx.moduleId, ctx.runId);
  };

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

  Core.waitFor = async function (fn, timeoutMs = 15000, intervalMs = 300, shouldCancel = Core.defaultShouldCancel) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (shouldCancel && shouldCancel()) return null;
      let result = null;
      try {
        result = await fn();
      } catch (e) {
        result = null;
      }
      if (result) return result;
      await Core.sleep(intervalMs);
    }
    return null;
  };

  Core.retryStep = async function (
    label,
    checkFn,
    { attempts = 4, waits = [1000, 3000, 6000, 10000], shouldCancel = Core.defaultShouldCancel } = {}
  ) {
    for (let i = 0; i < attempts; i++) {
      if (shouldCancel && shouldCancel()) return null;
      let result = null;
      try {
        result = await checkFn();
      } catch (e) {
        result = null;
      }
      if (result) return result;

      if (Core.bodyText().includes('서버에 재연결')) {
        Core.log('core', `(${label}) 서버 재연결 감지 → 3초 추가 대기 후 재확인`);
        await Core.sleep(3000);
        if (shouldCancel && shouldCancel()) return null;
        let retryResult = null;
        try {
          retryResult = await checkFn();
        } catch (e) {
          retryResult = null;
        }
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

  Core.resolveClickable = function (target) {
    return typeof target === 'function' ? target() : target;
  };

  Core.safeClick = async function (
    target,
    { beforeMin = 500, beforeMax = 1300, afterMin = 0, afterMax = 0, shouldCancel = Core.defaultShouldCancel } = {}
  ) {
    if (shouldCancel && shouldCancel()) return false;
    await Core.humanDelay(beforeMin, beforeMax);
    if (shouldCancel && shouldCancel()) return false;
    const el = Core.resolveClickable(target);
    if (
      !el ||
      !el.isConnected ||
      el.disabled ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.getClientRects().length === 0
    ) return false;
    el.click();
    if (afterMax > 0) await Core.humanDelay(afterMin, afterMax);
    return true;
  };

  Core.clickAndWaitFor = async function (
    target,
    checkFn,
    { minDelay = 500, maxDelay = 1300, timeoutMs = 15000, shouldCancel = Core.defaultShouldCancel } = {}
  ) {
    const clicked = await Core.safeClick(target, {
      beforeMin: minDelay,
      beforeMax: maxDelay,
      shouldCancel,
    });
    if (!clicked) return null;
    return Core.waitFor(checkFn, timeoutMs, 300, shouldCancel);
  };

  Core.clickNavMenuExact = async function (navLabel, itemText) {
    const navBtn = await Core.waitFor(() => Core.findButtonByText(navLabel), 15000);
    if (!navBtn) throw new Error(`상단 메뉴 "${navLabel}" 버튼을 찾을 수 없음`);
    if (!(await Core.safeClick(() => Core.findButtonByText(navLabel), { beforeMin: 500, beforeMax: 1000 }))) {
      throw new Error(`상단 메뉴 "${navLabel}" 버튼이 클릭 직전에 사라짐`);
    }
    const item = await Core.waitFor(() =>
      [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim() === itemText)
    );
    if (!item) throw new Error(`메뉴 항목 "${itemText}"를 찾을 수 없음`);
    if (!(await Core.safeClick(() =>
      [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim() === itemText)
    ))) throw new Error(`메뉴 항목 "${itemText}"가 클릭 직전에 사라짐`);
  };

  Core.clickNavMenuSuffix = async function (navLabel, suffixText) {
    const navBtn = await Core.waitFor(() => Core.findButtonByText(navLabel), 15000);
    if (!navBtn) throw new Error(`상단 메뉴 "${navLabel}" 버튼을 찾을 수 없음`);
    if (!(await Core.safeClick(() => Core.findButtonByText(navLabel), { beforeMin: 500, beforeMax: 1000 }))) {
      throw new Error(`상단 메뉴 "${navLabel}" 버튼이 클릭 직전에 사라짐`);
    }
    const item = await Core.waitFor(() =>
      [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim().endsWith(suffixText))
    );
    if (!item) throw new Error(`메뉴 항목("...${suffixText}")을 찾을 수 없음`);
    if (!(await Core.safeClick(() =>
      [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim().endsWith(suffixText))
    ))) throw new Error(`메뉴 항목("...${suffixText}")이 클릭 직전에 사라짐`);
  };

  // ---------------- 캐릭터 속성 확인/변경 (자동사냥·던전 공용) ----------------
  Core.ELEMENT_OPTIONS = ['불', '물', '번개', '별', '바람', '빛', '어둠'];

  Core.gameElements = function (selector) {
    return [...document.querySelectorAll(selector)].filter(
      (el) =>
        !el.closest('#lrm-panel') &&
        !el.closest('#lrm-banner') &&
        !el.closest('#lrm-boss-ref-panel')
    );
  };

  Core.readCharacterElementOnStatus = function () {
    const leaf = Core.gameElements('*').find(
      (el) =>
        el.children.length === 0 &&
        /^속성\s*:\s*(불|물|번개|별|바람|빛|어둠)$/.test(el.textContent.trim())
    );
    if (!leaf) return null;
    const match = leaf.textContent.trim().match(/^속성\s*:\s*(.+)$/);
    return match ? match[1].trim() : null;
  };

  Core.goToCharacterPage = async function (itemText, expectedPath) {
    await Core.clickNavMenuExact('캐릭', itemText);
    const arrived = await Core.waitFor(
      () => location.pathname.replace(/\/$/, '') === expectedPath,
      10000,
      250
    );
    if (!arrived) throw new Error(`캐릭 메뉴 "${itemText}" 이동 확인 실패`);
    await Core.humanDelay(700, 1300);
  };

  Core.useElementStone = async function (targetElement, moduleId) {
    const stoneName = `${targetElement}의 돌`;
    await Core.goToCharacterPage('인벤토리', '/inventory');

    const consumableTab = await Core.waitFor(
      () =>
        Core.gameElements('[role="tab"], button').find(
          (el) => el.textContent.trim() === '소모품' && el.getClientRects().length > 0
        ) || null,
      8000
    );
    if (!consumableTab) throw new Error('인벤토리 소모품 탭을 찾지 못했습니다.');
    if (!(await Core.safeClick(consumableTab, { beforeMin: 600, beforeMax: 1100, afterMin: 700, afterMax: 1300 }))) {
      throw new Error('소모품 탭을 열지 못했습니다.');
    }

    let useButton = null;
    for (let page = 1; page <= 20 && !useButton; page++) {
      const row = Core.gameElements('tr').find(
        (tr) => tr.textContent.includes(stoneName) && tr.getClientRects().length > 0
      );
      if (row) {
        useButton =
          [...row.querySelectorAll('button')].find(
            (button) =>
              ['사용', '사용하기'].includes(button.textContent.trim()) &&
              button.getClientRects().length > 0
          ) || null;
        break;
      }
      const next = Core.gameElements('button').find(
        (button) =>
          button.getAttribute('aria-label') === 'Go to next page' &&
          !button.disabled &&
          button.getClientRects().length > 0
      );
      if (!next) break;
      if (!(await Core.safeClick(next, { beforeMin: 500, beforeMax: 900, afterMin: 650, afterMax: 1100 }))) break;
    }
    if (!useButton) throw new Error(`인벤토리에서 "${stoneName}"을 찾지 못했습니다.`);

    if (!(await Core.safeClick(useButton, { beforeMin: 900, beforeMax: 1600 }))) {
      throw new Error(`"${stoneName}" 사용 버튼이 클릭 직전에 사라졌습니다.`);
    }
    const confirm = await Core.waitFor(
      () => Core.findButtonInDialog('아이템 사용', '확인') || Core.findButtonInDialog(stoneName, '확인'),
      6000
    );
    if (!confirm) throw new Error(`"${stoneName}" 사용 확인창을 찾지 못했습니다.`);
    if (!(await Core.safeClick(confirm, { beforeMin: 700, beforeMax: 1200, afterMin: 1200, afterMax: 1800 }))) {
      throw new Error(`"${stoneName}" 사용을 확정하지 못했습니다.`);
    }
    Core.log(moduleId, `${stoneName} 1개 사용 완료`);
  };

  Core.ensureCharacterElement = async function (targetElement, moduleId) {
    if (!Core.ELEMENT_OPTIONS.includes(targetElement)) {
      throw new Error(`지원하지 않는 목표 속성입니다: ${targetElement}`);
    }

    await Core.goToCharacterPage('내 정보', '/status');
    let currentElement = await Core.waitFor(() => Core.readCharacterElementOnStatus(), 8000, 250);
    if (!currentElement) throw new Error('내 정보에서 현재 캐릭터 속성을 읽지 못했습니다.');

    if (currentElement === targetElement) {
      Core.log(moduleId, `속성 확인 완료: ${targetElement} (변경 불필요)`);
      return true;
    }

    Core.log(moduleId, `속성 불일치: 현재 ${currentElement} / 설정 ${targetElement} → ${targetElement}의 돌 사용`);
    await Core.useElementStone(targetElement, moduleId);
    await Core.goToCharacterPage('내 정보', '/status');
    currentElement = await Core.waitFor(() => Core.readCharacterElementOnStatus(), 8000, 250);
    if (currentElement !== targetElement) {
      throw new Error(`속성 변경 검증 실패: 현재 ${currentElement || '확인 불가'} / 목표 ${targetElement}`);
    }
    Core.log(moduleId, `속성 변경 및 재검증 완료: ${targetElement}`);
    return true;
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
    const mod = Modules[moduleId];
    if (mod) {
      mod.runId = (mod.runId || 0) + 1;
      mod.running = false;
      mod.stopRequested = true;
    }
    if (Core.activeModuleId === moduleId) Core.activeModuleId = null;
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
  // 모듈 정의: 재전직 / 자동사냥 / 레어맵 / 던전 / 심층던전
  // ==========================================================================
  const MODULE_LABELS = {
    rejob: '재전직',
    autohunt: '자동사냥',
    raremap: '레어맵',
    dungeon: '던전',
    deepdungeon: '심층던전',
  };

  const Modules = {};

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
    if (!(await Core.safeClick(() => findTargetUseButton(), {
      beforeMin: mod.config.clickDelay[0],
      beforeMax: mod.config.clickDelay[1],
    }))) {
      Core.notifyStopped('rejob', '활력의 포션 "사용" 버튼이 클릭 직전에 사라졌습니다.');
      return false;
    }

    const qtyDialogEl = await Core.retryStep('수량 확인 팝업 컨테이너 찾기', () => {
      const marker = [...document.querySelectorAll('*')].find((el) => {
        if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
        return el.textContent.trim() === '사용할 개수';
      });
      if (!marker) return null;
      // 버그 수정: "사용할 개수" 라벨(<p>) 자체는 자식이 없어(childCount=0) "가장 작은 컨테이너 찾기" 방식으로는
      // 항상 이 라벨 자신이 선택되어버려 그 안에 input/button이 하나도 없었음(실제 입력칸/버튼은 role="dialog" 조상에 있음).
      // → 텍스트 매칭이 아니라 실제 다이얼로그 조상(role="dialog")을 직접 찾도록 변경.
      return marker.closest('[role="dialog"]') || marker.closest('.MuiDialogContent-root') || marker.parentElement;
    });

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
          nativeSetter.call(qtyInput, 1);
          qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
          await mod.clickDelayWait();
        }
        const qtyConfirmBtn = await Core.retryStep('수량 확인 팝업의 "사용" 버튼 찾기', () =>
          [...qtyDialogEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용') || null
        );
        if (qtyConfirmBtn) {
          qtyConfirmBtn.click();
          await mod.clickDelayWait();
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

    if (!Number.isFinite(mod.nextRestAt)) {
      mod.nextRestAt = mod.cycleCount + Core.rand(mod.config.restEvery[0], mod.config.restEvery[1]);
    }
    if (mod.cycleCount >= mod.nextRestAt) {
      const restSec = Core.rand(mod.config.restSeconds[0], mod.config.restSeconds[1]);
      Core.log('rejob', `${mod.cycleCount}사이클 도달 → ${restSec}초 휴식`);
      await Core.sleep(restSec * 1000);
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
      if (result.potionRemaining === null || result.potionRemaining < 50) {
        await mod.refillExpPotion();
      }
      if (!mod.running) return;
      if (result.gold !== null && result.gold > 1000000) {
        await Core.bankDepositAll('rejob');
      }
      // 버그 수정: 사망(레벨 100 미달) 판정의 실제 원인이 사냥터가 너무 강해서가 아니라
      // 행동력(에너지) 고갈로 전투가 중간에 끊긴 경우일 수 있음. 성공 분기에서만 행동력을 보충하면
      // 이 경우 행동력이 계속 낮은 채로 방치되어 다음 사냥도 계속 실패하는 문제가 있었음.
      await mod.refillEnergyIfNeeded();
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
      originalElement: '',
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
    if (this.findHuntX50Button(groundSuffix)) {
      if (floor) {
        const floorSelected = await this.selectFloor(floor);
        if (!floorSelected) return false;
      }
      return !!this.findHuntX50Button(groundSuffix);
    }
    try {
      await Core.clickNavMenuSuffix('전투', groundSuffix);
    } catch (e) {
      Core.log('autohunt', `오류: ${e.message}`);
      return false;
    }
    await Core.sleep(600);
    if (floor) {
      const floorSelected = await this.selectFloor(floor);
      if (!floorSelected) return false;
    }
    return !!(await Core.waitFor(() => this.findHuntX50Button(groundSuffix), 8000));
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
    Core.log('autohunt', `시작 전 원래 속성(${mod.config.originalElement}) 확인`);
    await Core.ensureCharacterElement(mod.config.originalElement, 'autohunt');
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

      const previousResultText = Core.bodyText();
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
    const radios = [...dialog.querySelectorAll('.MuiRadio-root')];
    return (
      radios.find((radio) => {
        const input = radio.querySelector('input');
        const row = radio.closest('label, li, [role="radio"]') || radio.parentElement;
        const text = row ? row.textContent : '';
        return !(input && input.disabled) && radio.getAttribute('aria-disabled') !== 'true' && !/[xX×]\s*0\b/.test(text);
      }) || null
    );
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
    if (!(await Core.safeClick(() => this.getMapIcon(), { beforeMin: 600, beforeMax: 1300 }))) return false;

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
    if (!(await Core.safeClick(() => {
      const freshDialog = this.getMapDialog();
      return freshDialog ? this.getTopRadio(freshDialog) : null;
    }, { beforeMin: 600, beforeMax: 1300 }))) return false;

    const useBtn = this.getUseButton(dialog);
    if (!useBtn) {
      Core.log('raremap', '사용하기 버튼을 찾지 못했습니다.');
      return false;
    }
    if (!(await Core.safeClick(() => {
      const freshDialog = this.getMapDialog();
      return freshDialog ? this.getUseButton(freshDialog) : null;
    }, { beforeMin: 600, beforeMax: 1300 }))) return false;
    return !!(await Core.waitFor(() => (!this.getMapDialog() || this.getRareMapButton() ? true : null), 10000, 300));
  };

  Modules.raremap.clearRareMapsIfAny = async function () {
    let count = 0;
    let unchangedCount = 0;
    while (this.running && count < 100) {
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
        Core.log('raremap', `동일 레어맵 버튼이 그대로 남아 있습니다 (${unchangedCount}/3).`);
        if (unchangedCount >= 3) {
          throw new Error('동일 레어맵 버튼이 반복해서 남아 있어 안전을 위해 중단합니다.');
        }
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
      originalElement: '',
      enableDailySewer: true,
      rerollMinTokens: 50,
      instantClear: {
        oldMasterTower: { targetAC: 4000, targetEV: 4500 },
        masterTower: { targetAC: 4000, targetEV: 4500 },
        oldMysticCave: { targetAC: 5500, targetEV: 6000 },
        mysticCave: { targetAC: 5500, targetEV: 6000 },
        sewer: { targetAC: 0, targetEV: 0 },
      },
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
    allStatsBoughtCount: 0,
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
      instantClearRequirement: { requireGodStrike: true, minAllStats: 2, requireStats: [] },
    },
    {
      id: 'sewer',
      label: '지하 하수도',
      requiredItemName: null,
      daily: true,
      statMode: 'extended',
      abilityMode: 'ordered',
      instantClearRequirement: { requireGodStrike: true, minAllStats: 3, requireStats: ['힘', '속도'] },
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

  Modules.dungeon.getEntryConfirmDialog = function () {
    const candidates = [...document.querySelectorAll('*')].filter((el) => {
      if (el.closest('#lrm-panel') || el.closest('#lrm-banner')) return false;
      if (!el.textContent.includes('던전 입장 확인')) return false;
      return el.querySelectorAll('button').length > 0;
    });
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a.querySelectorAll('*').length < b.querySelectorAll('*').length ? a : b));
  };

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
    this.allStatsBoughtCount = 0;
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
    if (req.minAllStats && this.allStatsBoughtCount < req.minAllStats) {
      missing.push(`모든 스탯 ${this.allStatsBoughtCount}/${req.minAllStats}회`);
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
      const lines = (el.innerText || el.textContent).split('\n').map((s) => s.trim()).filter(Boolean);
      const label = lines[0];
      if (!label || label.length > 30 || seen.has(label)) continue;
      seen.add(label);
      // 카드 텍스트 안의 마지막 순수 숫자 줄이 가격이다 (예: "모든 스탯 +33\n\n40").
      // 이게 없으면 가격을 알 수 없는 카드로 취급(cost=null, 구매 가능한 것으로 간주).
      const costLine = [...lines].reverse().find((l) => /^[\d,]+$/.test(l));
      const cost = costLine ? parseInt(costLine.replace(/,/g, ''), 10) : null;
      // 테두리 색상만으로 잡은 el이 실제 클릭 가능한 카드가 아니라 안쪽의 장식용
      // 요소일 수 있다. el 자신이나 조상 중 role="button"/버튼 태그/클릭 커서를
      // 가진 실제 클릭 대상이 있으면 그걸 우선 사용하고, 없으면 기존처럼 el 자체를
      // 클릭 대상으로 둔다(뒤로 물러날 안전장치).
      let clickTarget = el;
      let probe = el;
      for (let i = 0; i < 4 && probe; i++) {
        if (
          probe.tagName === 'BUTTON' ||
          probe.getAttribute('role') === 'button' ||
          getComputedStyle(probe).cursor === 'pointer'
        ) {
          clickTarget = probe;
          break;
        }
        probe = probe.parentElement;
      }
      cards.push({ selectEl: clickTarget, label, borderColor: getComputedStyle(el).borderColor, cost });
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
      return { card: allStatCards[0], onBought: () => (this.allStatsBoughtCount += 1) };
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

      // 가격이 보유 토큰보다 비싸서 애초에 못 사는(비활성) 카드는 후보에서
      // 제외한다. 이 체크가 없으면 살 수 없는 카드를 골라 몇 번을 재시도해도
      // 영원히 실패하는 문제가 있었다.
      const affordableCards = cards.filter((c) => c.cost === null || c.cost <= tokens);
      if (affordableCards.length < cards.length) {
        const unaffordable = cards.filter((c) => !(c.cost === null || c.cost <= tokens));
        Core.log(
          'dungeon',
          `토큰 부족으로 후보에서 제외: ${unaffordable.map((c) => `${c.label}(${c.cost})`).join(', ')} (보유 ${tokens})`
        );
      }

      const pick = this.pickShopCard(dungeonDef, affordableCards, isLastShopBeforeBoss);
      const isPremiumPick = pick && (this.isGodStrikeFamily(pick.card.label) || this.isAllStatsLabel(pick.card.label));
      const shouldBuyNow = pick && (isLastShopBeforeBoss || rerollGuard === 0 || isPremiumPick);

      if (shouldBuyNow) {
        let bought = false;
        const tokensBefore = tokens;
        const buyWaits = [4000, 5000, 6500, 8000];
        // 카드 선택은 재시도 때마다 다시 누르지 않는다 - 만약 선택이 "누르면 선택,
        // 다시 누르면 해제"되는 토글 방식이라면, 재시도할수록 오히려 선택이
        // 풀려버려 계속 실패하는 원인이 될 수 있다.
        pick.card.selectEl.click();
        await Core.humanDelay(900, 1600);
        for (let buyAttempt = 0; buyAttempt < buyWaits.length && !bought; buyAttempt++) {
          const buyBtn = Core.findButtonByText('구매');
          if (!buyBtn) break;
          buyBtn.click();
          await Core.humanDelay(1100, 2000);
          await Core.waitFor(
            () =>
              !this.isShopScreen() ||
              Core.bodyText().includes('구매했습니다') ||
              this.getShopTokenCount() < tokensBefore
                ? true
                : null,
            buyWaits[buyAttempt]
          );
          // "구매했습니다" 토스트는 화면이 곧장 넘어가면 사라져있을 수 있어 신뢰도가
          // 낮다 - 토큰이 실제로 줄었는지(더 확실한 신호)도 함께 확인한다.
          bought =
            Core.bodyText().includes('구매했습니다') ||
            (this.isShopScreen() && this.getShopTokenCount() < tokensBefore) ||
            !this.isShopScreen();
          if (!bought && buyAttempt < buyWaits.length - 1) {
            Core.log(
              'dungeon',
              `"${pick.card.label}" 구매 확인 실패 (${buyAttempt + 1}/${buyWaits.length}) - 다시 시도`
            );
            await Core.humanDelay(800, 1500);
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
        // 리롤 버튼의 실제 textContent는 "리롤" + 남은 횟수 배지가 붙어서
        // "리롤3" 같은 형태다. 완전 일치(Core.findButtonByText)로는 절대 못 찾으므로
        // "리롤"로 시작하는 버튼을 찾는다 - 이게 리롤이 항상 실패하던 진짜 원인이었다.
        const rerollBtn = await Core.retryStep(
          '리롤 버튼 찾기',
          () => {
            const b = Core.allButtons().find((btn) => btn.textContent.trim().startsWith('리롤'));
            return b && !b.disabled ? b : null;
          },
          { attempts: 3, waits: [500, 1000, 1500] }
        );
        if (rerollBtn) {
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
      this.allStatsBoughtCount = 0;
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
          originalElement: this.config.originalElement,
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
      if (Core.ELEMENT_OPTIONS.includes(saved.originalElement)) this.config.originalElement = saved.originalElement;
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
    Core.log('dungeon', `시작 전 원래 속성(${mod.config.originalElement}) 확인`);
    await Core.ensureCharacterElement(mod.config.originalElement, 'dungeon');
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

  // -------------------------- 모듈 5: 심층던전 --------------------------
  // 일반 던전(수행자의 탑/신비의 동굴 등)과는 완전히 다른 화면 구조와 게임 로직을
  // 가진 별도 콘텐츠라, 어빌리티/우선순위 판단 로직을 서로 공유하지 않고 독립적으로
  // 둔다 (예: 신의 일격 계열은 일반 던전에서만 의미 있고 심층던전에는 존재하지 않음).
  Modules.deepdungeon = {
    id: 'deepdungeon',
    running: false,
    stopRequested: false,
    cycleCount: 0, // 완료한 던전의 주인 도전 횟수
    config: {
      requiredTier1: ['관통', '집중', '정확한 한 발'],
      requiredLifePair: ['라이프 드레인', '재생'],
      recommendedAbilities: [
        '매직컬 댄싱',
        '분노의 일격',
        '연속 타격',
        '전환',
        '샤프스',
        '피의 맹약',
        '정복자의 발걸음',
        '심연의 기운',
      ],
      tokenShopThreshold: 500,
      emergencyHpPercent: 30,
      bossPreFloors: [8, 18, 28, 38, 48],
      bossPreFloorHpPercent: 50,
      hpDropTriggerPercent: 10,
      wanderingSoulFloorThreshold: 40,
      targetAC: 0,
      targetDefense: 3000,
      retryIfWeeklyDamageUnder1M: false, // 주간 누적 데미지 100만 이하면 재도전
      jobMode: '물리딜', // 물리딜(관통/집중/정확한 한 발 기반, 실제 동작) / 신술(개발 중)
    },
    hpBeforeBattle: null,
    requiredPhaseDone: false,
    usedSmithyOnce: false, // 마술 전용: 45층 이후 대장간을 한 번 방문했는지
    shopVisitReason: null, // 'deliberate'(토큰 기준 충족) | 'fallback'(다른 선택지 없어서)
  };

  const DD_GRADE_ORDER = { 동: 0, 은: 1, 금: 2, 칠색: 3 };

  // 직업별 규칙을 데이터로 분리해둔다 (물리딜/신술 로직이 서로 다른 어빌/스탯
  // 우선순위를 쓰므로, 하드코딩된 리스트 대신 이 프로필을 통해 참조한다).
  // requiredTargets: 어빌리티 이름 -> 제단에서 밀어붙일 목표 등급(그 등급 이상이면
  //   더 이상 제단 우선순위에 넣지 않음). requiredLifePair: 물리딜 전용(둘 중 하나만
  //   있으면 됨), 신술은 해당 없음(null).
  const DD_JOB_PROFILES = {
    물리딜: {
      requiredTargets: {
        '급속 성장': '칠색',
        관통: '칠색',
        집중: '칠색',
        '정확한 한 발': '칠색',
      },
      requiredLifePair: { names: ['라이프 드레인', '재생'], target: '칠색' },
      recommendedAbilities: [
        '매직컬 댄싱',
        '분노의 일격',
        '연속 타격',
        '전환',
        '샤프스',
        '피의 맹약',
        '정복자의 발걸음',
        '심연의 기운',
      ],
      recommendedCap: 2,
      mainStat: '힘',
      speedThreshold: 800,
      // 정신(적중 목표)/생명(방어 목표) 조건을 만족한 뒤 최후순위로 고를 스탯.
      fallbackStat: '행운',
    },
    신술: {
      requiredTargets: {
        '급속 성장': '칠색',
        마법검: '칠색',
        관통: '금',
        집중: '금',
        '정확한 한 발': '금',
      },
      requiredLifePair: null,
      recommendedAbilities: ['독참', '상태이상공명', '도박사의 룰렛', '재생', '디버프 증폭', '고통의 공명'],
      recommendedCap: 2,
      mainStat: '지능',
      speedThreshold: 700,
      // 신술은 행운을 찍지 않고, 대신 힘을 최후순위로 고른다.
      fallbackStat: '힘',
    },
    마술: {
      requiredTargets: {
        '급속 성장': '칠색',
        관통: '칠색',
        집중: '칠색',
        '정확한 한 발': '칠색',
        과부하: '칠색',
        매직파워: '칠색',
        마나비전: '칠색',
      },
      requiredLifePair: null,
      recommendedAbilities: ['재생', '영혼 복제', '정복자의 발걸음'],
      recommendedCap: 2,
      mainStat: '지능',
      speedThreshold: 700,
      // 신술과 동일하게 행운을 찍지 않고 힘을 최후순위로 고른다.
      fallbackStat: '힘',
      // 마술 전용: 상점에서 여유 토큰으로 "장비 조각 x100"을 사고, 45층 이후
      // 대장간에서 장비를 강화한다.
      buyEquipmentShards: true,
    },
  };

  Modules.deepdungeon.getJobProfile = function () {
    return DD_JOB_PROFILES[this.config.jobMode] || DD_JOB_PROFILES.물리딜;
  };

  // 라이프 드레인 또는 재생을 이미 금 등급 이상으로 보유하고 있는지 확인.
  Modules.deepdungeon.hasLifePairAtGoldPlus = function (abilities) {
    const pair = this.getJobProfile().requiredLifePair;
    if (!pair) return false; // 이 직업은 라이프드레인/재생 페어 조건이 없음(예: 신술)
    return pair.names.some((name) => {
      const a = abilities.find((x) => x.name === name);
      return a && DD_GRADE_ORDER[a.grade] >= DD_GRADE_ORDER['금'];
    });
  };

  // 추천 어빌리티(금·칠색만 채용)로 인정할지 판단. 피의 맹약은 예외로, 라이프
  // 드레인/재생을 이미 금 등급 이상으로 보유하고 있을 때만 채용한다.
  Modules.deepdungeon.isRecommendedEligible = function (name, grade, abilities) {
    const profile = this.getJobProfile();
    if (!profile.recommendedAbilities.includes(name)) return false;
    if (!(grade === '금' || grade === '칠색')) return false;
    if (name === '피의 맹약' && !this.hasLifePairAtGoldPlus(abilities)) return false;
    // 추천 어빌은 직업별 캡(기본 2개)까지만 채용한다 - 그 이상 확보했으면 더 이상
    // 새로 채용하지 않고 스탯 보상에 집중한다. 던전 입장 시 메인/직업 어빌이
    // 자동으로 "동" 등급 변환되면서 우연히 추천 리스트 이름과 겹칠 수 있으므로,
    // 금·칠색만 카운트한다.
    const recommendedOwnedCount = abilities.filter(
      (a) => profile.recommendedAbilities.includes(a.name) && (a.grade === '금' || a.grade === '칠색')
    ).length;
    if (recommendedOwnedCount >= profile.recommendedCap) return false;
    return true;
  };
  // 속성 상성: 불<물<번개<별<바람<불 (순환), 빛<어둠<빛 (순환).
  // "A < B"는 "A가 B에 약하다(B가 A를 이긴다)"는 뜻이므로, 내 속성이 X일 때
  // 내가 이기는 상대 속성은 체인에서 X의 "앞" 원소다 (예: 물<번개 → 번개는 물을
  // 이긴다 → 내 속성이 번개면 상대를 물로 지정해야 함). 이전 버전은 이 방향이
  // 반대로(내 뒤 원소, 즉 나를 이기는 속성) 되어 있어서 오히려 나에게 불리한
  // 속성으로 지정하는 심각한 버그였다.
  const DD_ATTR_COUNTER = {
    불: '바람',
    물: '불',
    번개: '물',
    별: '번개',
    바람: '별',
    빛: '어둠',
    어둠: '빛',
    무: '무',
  };

  Modules.deepdungeon.upToCard = function (leafEl) {
    let n = leafEl;
    for (let i = 0; i < 6 && n; i++) {
      if (/MuiPaper-root/.test(n.className || '')) return n;
      n = n.parentElement;
    }
    return leafEl ? leafEl.parentElement : null;
  };

  Modules.deepdungeon.findLeafCard = function (exactText) {
    const leaf = [...document.querySelectorAll('*')].find(
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim() === exactText &&
        !el.closest('#lrm-panel') &&
        !el.closest('#lrm-banner')
    );
    if (!leaf) return null;
    return this.upToCard(leaf);
  };

  Modules.deepdungeon.findLeafCardStartsWith = function (prefix) {
    const leaf = [...document.querySelectorAll('*')].find(
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim().startsWith(prefix) &&
        !el.closest('#lrm-panel') &&
        !el.closest('#lrm-banner')
    );
    if (!leaf) return null;
    return this.upToCard(leaf);
  };

  Modules.deepdungeon.clickCardForLabel = async function (label) {
    const card = this.findLeafCard(label);
    if (!card) return false;
    card.click();
    await Core.humanDelay(400, 900);
    return true;
  };

  Modules.deepdungeon.confirmEventSelection = async function () {
    const enabled = await Core.retryStep(
      '"이벤트 선택" 버튼 활성화 대기',
      () => {
        const btn = Core.findButtonByText('이벤트 선택');
        return btn && !btn.disabled ? btn : null;
      },
      { attempts: 4, waits: [400, 800, 1500, 2500] }
    );
    if (!enabled) return false;
    enabled.click();
    await Core.humanDelay(600, 1200);
    return true;
  };

  Modules.deepdungeon.readHp = function () {
    const m = Core.bodyText().match(/HP\s*\n?\s*([\d,]+)\s*\/\s*([\d,]+)/);
    if (!m) return null;
    return { cur: parseInt(m[1].replace(/,/g, ''), 10), max: parseInt(m[2].replace(/,/g, ''), 10) };
  };

  Modules.deepdungeon.readFloor = function () {
    const m = Core.bodyText().match(/(\d+)\s*층\s*\/\s*50\s*층/);
    return m ? parseInt(m[1], 10) : null;
  };

  Modules.deepdungeon.readTokens = function () {
    const m = Core.bodyText().match(/토큰\s*([\d,]+)/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  };

  Modules.deepdungeon.readMyAttribute = function () {
    const m = Core.bodyText().match(/\n(무|물|불|바람|번개|별|빛|어둠)\n/);
    return m ? m[1] : null;
  };

  // 캐릭터 카드 상단의 "물리공격력\n물리방어력\n공격속도\n속성" 3숫자+속성 패턴에서
  // 실제 표시되는 물리 방어력 값을 읽는다. (생명 스탯 수치가 아니라 그걸로 계산된
  // 실제 방어력 결과값 - 목표 방어력과 직접 비교해야 하므로 이쪽을 읽는다)
  Modules.deepdungeon.readCombatSummaryStats = function () {
    const m = Core.bodyText().match(/\n(\d+)\n(\d+)\n(\d+)\n(무|물|불|바람|번개|별|빛|어둠)\n/);
    if (!m) return null;
    return {
      atk: parseInt(m[1], 10),
      def: parseInt(m[2], 10),
      spd: parseInt(m[3], 10),
      attr: m[4],
    };
  };

  Modules.deepdungeon.readAbilities = function () {
    const text = Core.bodyText();
    const startIdx = text.indexOf('어빌리티 (');
    if (startIdx === -1) return [];
    const after = text.slice(startIdx);
    const endIdx = after.indexOf('세트 효과');
    const section = endIdx === -1 ? after : after.slice(0, endIdx);
    const lines = section.split('\n').map((l) => l.trim()).filter(Boolean);
    const abilities = [];
    for (const line of lines) {
      const m = line.match(/^(.*?)\s*\((동|은|금|칠색)\)$/);
      if (m) abilities.push({ name: m[1].trim(), grade: m[2] });
    }
    return abilities;
  };

  // "어빌리티 / 스킬 템플릿" 드롭다운이 접혀있으면 보유 어빌 목록(readAbilities)이
  // 비어 보이므로, 판단이 필요한 시점마다 먼저 펼쳐서 확인한다.
  Modules.deepdungeon.ensureAbilityPanelExpanded = async function () {
    if (Core.bodyText().includes('어빌리티 (')) return true;
    const toggle = Core.findButtonByText('어빌리티 / 스킬 템플릿');
    if (!toggle) return false;
    toggle.click();
    const expanded = await Core.waitFor(() => (Core.bodyText().includes('어빌리티 (') ? true : null), 3000, 200);
    return !!expanded;
  };

  // 필수 어빌(관통/집중/정확한 한 발 전부 + 라이프드레인·재생 중 하나)을 모두
  // 보유했고, 추천 어빌리티도 2개 이상 보유했으면 "수집 단계"가 끝난 것으로 본다.
  // 이 시점부터는 전투보다 특수 이벤트(약병/어빌 업그레이드)를 우선한다.
  Modules.deepdungeon.isCollectionPhaseComplete = async function () {
    await this.ensureAbilityPanelExpanded();
    const abilities = this.readAbilities();
    const names = abilities.map((a) => a.name);
    const profile = this.getJobProfile();

    const tier1Names = Object.keys(profile.requiredTargets).filter((n) => n !== '급속 성장');
    const tier1Owned = tier1Names.every((n) => names.includes(n));
    const lifeOwned = profile.requiredLifePair ? profile.requiredLifePair.names.some((n) => names.includes(n)) : true;
    if (!tier1Owned || !lifeOwned) return false;

    // 던전 입장 시 메인/직업 어빌이 자동으로 "동" 등급 던전 어빌로 변환되는데, 이때
    // 우연히 추천 리스트에 있는 이름이 걸리면(예: 분노의 일격) 실제로는 아무 것도
    // 안 했는데도 "추천 어빌 확보"로 잘못 세어지는 문제가 있었다. 등급 상관없이
    // 이름만 보고 세지 말고, 실제로 채용 기준을 만족하는(금·칠색) 것만 센다.
    const recommendedOwnedCount = abilities.filter(
      (a) => profile.recommendedAbilities.includes(a.name) && (a.grade === '금' || a.grade === '칠색')
    ).length;
    return recommendedOwnedCount >= profile.recommendedCap;
  };

  Modules.deepdungeon.isRequiredPhaseActive = async function () {
    await this.ensureAbilityPanelExpanded();
    const abilities = this.readAbilities();
    const byName = {};
    abilities.forEach((a) => (byName[a.name] = a.grade));
    const profile = this.getJobProfile();

    // 어빌리티별로 목표 등급이 다를 수 있다(예: 신술은 급속성장/마법검만 칠색,
    // 관통/집중/정확한 한 발은 금까지). 보유 중인데 아직 목표 등급 미만이면
    // 제단 우선순위가 필요하다고 본다.
    for (const [name, target] of Object.entries(profile.requiredTargets)) {
      const g = byName[name];
      if (g && DD_GRADE_ORDER[g] < DD_GRADE_ORDER[target]) return true;
    }
    if (profile.requiredLifePair) {
      for (const name of profile.requiredLifePair.names) {
        const g = byName[name];
        if (g && DD_GRADE_ORDER[g] < DD_GRADE_ORDER[profile.requiredLifePair.target]) return true;
      }
    }
    return false;
  };

  // 제단/축복의 샘은 오직 필수 어빌(급속 성장, 관통/집중/정확한 한 발, 라이프
  // 드레인·재생) 승급에만 사용한다. 추천 어빌리티는 절대 제단으로 올리지 않고
  // 전투/상점/특수이벤트에서 주워지는 등급 그대로 둔다 - 자리가 남아도 추천 어빌로
  // 채우지 않는다.
  // candidates: parseAltarCandidates()가 반환하는 {name, from, to} 목록.
  // 어빌리티별 목표 등급(직업 프로필)에 아직 못 미친 것만 승급 대상으로 고른다 -
  // 이미 목표 등급에 도달한 항목은 화면에 후보로 떠도 더 이상 올리지 않는다
  // (예: 신술의 관통/집중/정확한 한 발은 금이 목표라 금 도달 후엔 스킵).
  Modules.deepdungeon.pickAltarTargets = function (candidates, count) {
    const profile = this.getJobProfile();
    const byName = {};
    candidates.forEach((c) => (byName[c.name] = c));

    const needsUpgrade = (name, target) => {
      const c = byName[name];
      return c && DD_GRADE_ORDER[c.from] < DD_GRADE_ORDER[target];
    };

    const picked = [];
    const tryPick = (name) => {
      if (picked.length >= count) return;
      if (byName[name] && !picked.includes(name)) picked.push(name);
    };

    if (needsUpgrade('급속 성장', profile.requiredTargets['급속 성장'] || '칠색')) tryPick('급속 성장');
    for (const [name, target] of Object.entries(profile.requiredTargets)) {
      if (name === '급속 성장') continue;
      if (needsUpgrade(name, target)) tryPick(name);
    }
    if (profile.requiredLifePair) {
      for (const name of profile.requiredLifePair.names) {
        if (needsUpgrade(name, profile.requiredLifePair.target)) tryPick(name);
      }
    }
    return picked;
  };

  // 적중_회피_공식: 적중치(AC) = 정신*2.8 + 행운*1.6 + 속도*1.6
  Modules.deepdungeon.computeAC = function (stats) {
    if (!stats) return null;
    return (stats.정신 || 0) * 2.8 + (stats.행운 || 0) * 1.6 + (stats.속도 || 0) * 1.6;
  };

  Modules.deepdungeon.pickStatPriority = function (offeredStats, ctx) {
    const profile = this.getJobProfile();
    const order = [];
    // 방어력이 목표치에 아직 못 미쳤으면 생명을 주력 스탯보다도 우선한다 (실제
    // 방어력 값을 목표 방어력 설정과 직접 비교).
    const defenseBehind =
      this.config.targetDefense > 0 &&
      ctx.currentDefense !== null &&
      ctx.currentDefense !== undefined &&
      ctx.currentDefense < this.config.targetDefense;
    if (defenseBehind) order.push('생명');
    order.push(profile.mainStat);
    if (ctx.hpDropPercent >= this.config.hpDropTriggerPercent) order.push('생명');
    order.push('생명');

    // 적중치가 목표치에 아직 못 미쳤을 때만 정신을 우선 투자한다. 목표를 넘겼으면
    // (targetAC=0이라 아예 목표가 없는 경우도 포함) 정신은 더 이상 우선순위에
    // 넣지 않고 맨 뒤로 미뤄 오버슈팅을 막는다.
    const acBehind =
      this.config.targetAC <= 0 || ctx.currentAC === null || ctx.currentAC === undefined
        ? true // 목표를 안 정했으면(0) 기존처럼 정상 우선순위로 취급
        : ctx.currentAC < this.config.targetAC;
    if (acBehind) order.push('정신');

    // 속도가 직업별 기준(물리딜 800 / 신술 600) 미만이면 속도, 아니면 직업별
    // 폴백 스탯(물리딜=행운, 신술=힘)을 고른다.
    order.push(ctx.mySpeed !== null && ctx.mySpeed < profile.speedThreshold ? '속도' : profile.fallbackStat);
    order.push(profile.fallbackStat, '속도');
    if (!acBehind) order.push('정신'); // 목표 달성 후엔 최후순위로만 (다른 선택지 없을 때)
    // 정말 다른 선택지가 없을 때 고르는 최후의 최후 스탯 - 물리딜은 지능(회피만
    // 올려줘서 사실상 안 씀), 신술은 행운(신술은 행운을 아예 안 찍기로 함).
    order.push(profile.mainStat === '힘' ? '지능' : '행운');

    for (const s of order) {
      if (offeredStats.includes(s)) return s;
    }
    return offeredStats[0] || null;
  };


  Modules.deepdungeon.parseRewardAbilityCard = function (cardEl) {
    const lines = (cardEl.innerText || cardEl.textContent).split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const name = lines[0];
    const gradeLine = lines.find((l) => ['동', '은', '금', '칠색'].includes(l));
    if (!gradeLine) return null;
    return { name, grade: gradeLine, cardEl };
  };

  Modules.deepdungeon.parseShopItemCard = function (cardEl) {
    const lines = (cardEl.innerText || cardEl.textContent).split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const title = lines[0];
    const abilityMatch = title.match(/^(.*?)\s*\((동|은|금|칠색)\)$/);
    const priceLines = lines.filter((l) => /^[\d,]+$/.test(l));
    const cost = priceLines.length > 0 ? parseInt(priceLines[priceLines.length - 1].replace(/,/g, ''), 10) : null;
    return {
      title,
      isAbility: !!abilityMatch,
      name: abilityMatch ? abilityMatch[1].trim() : title,
      grade: abilityMatch ? abilityMatch[2] : null,
      cost,
      cardEl,
    };
  };

  Modules.deepdungeon.pickBestAbilityItem = async function (items) {
    const abilityItems = items.filter((it) => it.isAbility);
    const profile = this.getJobProfile();
    const allRequired = [
      ...Object.keys(profile.requiredTargets),
      ...(profile.requiredLifePair ? profile.requiredLifePair.names : []),
    ];
    for (const it of abilityItems) {
      if (allRequired.includes(it.name)) return it;
    }
    await this.ensureAbilityPanelExpanded();
    const owned = this.readAbilities();
    for (const it of abilityItems) {
      if (this.isRecommendedEligible(it.name, it.grade, owned)) return it;
    }
    return null;
  };

  Modules.deepdungeon.handleStatSubChoiceIfPresent = async function () {
    const shown = await Core.waitFor(() => (Core.bodyText().includes('증가시킬') ? true : null), 3000, 200);
    if (!shown) return false;
    const buttons = Core.allButtons().filter((b) => /^[가-힣]+\s*\+?\d+$/.test(b.textContent.trim().replace(/\s+/g, ' ')));
    const offered = buttons.map((b) => (b.textContent.match(/^([가-힣]+)/) || [])[1]).filter(Boolean);
    const hp = this.readHp();
    const hpDropPercent =
      this.hpBeforeBattle && hp ? Math.max(0, ((this.hpBeforeBattle - hp.cur) / hp.max) * 100) : 0;
    const stats = this.readStatsSnapshot();
    const combat = this.readCombatSummaryStats();
    const pickName = this.pickStatPriority(offered, {
      hpDropPercent,
      mySpeed: stats.속도,
      currentDefense: combat ? combat.def : null,
      currentAC: this.computeAC(stats),
    });
    if (!pickName) return false;
    const btn = buttons.find((b) => b.textContent.trim().startsWith(pickName));
    if (!btn) return false;
    btn.click();
    await Core.humanDelay(500, 1000);
    return true;
  };

  Modules.deepdungeon.readStatsSnapshot = function () {
    const text = Core.bodyText();
    const grab = (label) => {
      const m = text.match(new RegExp(`${label}\\s*\\n\\s*([\\d,]+)`));
      return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
    };
    return {
      힘: grab('힘'),
      생명: grab('생명'),
      지능: grab('지능'),
      정신: grab('정신'),
      속도: grab('속도'),
      행운: grab('행운'),
    };
  };

  Modules.deepdungeon.decideFloorEvent = async function (options) {
    const hp = this.readHp();
    const hpPct = hp ? (hp.cur / hp.max) * 100 : 100;
    const floor = this.readFloor();
    const tokens = this.readTokens();
    const cfg = this.config;

    if (hpPct <= cfg.emergencyHpPercent) {
      if (options.includes('휴식')) return '휴식';
      if (options.includes('상점')) {
        this.shopVisitReason = 'fallback';
        return '상점';
      }
    }

    if (floor !== null && cfg.bossPreFloors.includes(floor) && hpPct <= cfg.bossPreFloorHpPercent) {
      if (options.includes('휴식')) return '휴식';
      if (options.includes('상점')) {
        this.shopVisitReason = 'fallback';
        return '상점';
      }
    }

    // 대장간: 마술 전용 - 45층 이후에 뜨면 딱 한 번만 들어가서 장비를 강화한다.
    // 그 전에 뜨거나, 이미 한 번 방문했으면 다른 선택지를 고른다(대장간을 옵션
    // 목록에서 그냥 무시하는 것과 같음).
    if (
      cfg.jobMode === '마술' &&
      options.includes('대장간') &&
      floor !== null &&
      floor >= 45 &&
      !this.usedSmithyOnce
    ) {
      return '대장간';
    }

    if ((await this.isRequiredPhaseActive()) && options.includes('제단')) return '제단';

    const collectionDone = await this.isCollectionPhaseComplete();

    if (collectionDone) {
      // 2단계: 필수 어빌 + 추천 어빌 2개를 다 갖춤 → 특수 이벤트(약병/업그레이드)
      // 위주로 전환. 정예 전투는 그래도 전투 자체보단 낫고 위험도 없어서 유지.
      if (options.includes('특수 이벤트')) return '특수 이벤트';
      if (options.includes('정예 전투')) return '정예 전투';
      if (options.includes('상점') && tokens >= cfg.tokenShopThreshold) {
        this.shopVisitReason = 'deliberate';
        return '상점';
      }
      if (options.includes('전투')) return '전투';
    } else {
      // 1단계: 아직 필수/추천 어빌을 다 못 갖춤 → 전투(정예/일반)로 스탯·어빌 수집.
      // 심층던전은 한 층에 전투 종류가 정예 전투 또는 전투 중 하나만 뜨는 구조라,
      // 이렇게 해도 전투가 아예 없는 층에서는 자연스럽게 특수 이벤트/상점으로 넘어간다.
      if (options.includes('정예 전투')) return '정예 전투';
      if (options.includes('전투')) return '전투';
      if (options.includes('특수 이벤트')) return '특수 이벤트';
      if (options.includes('상점') && tokens >= cfg.tokenShopThreshold) {
        this.shopVisitReason = 'deliberate';
        return '상점';
      }
    }

    // 제단은 위에서 이미 "승급할 필수 어빌이 있는지" 판단해서 필요할 때만
    // 골랐다. 여기 폴백에서 조건 없이 다시 고르면, 승급할 게 없는데도 일단
    // 들어갔다가 "건너뜁니다"로 나오는(입장 후 판단) 상황이 생기므로 넣지 않는다.
    if (options.includes('상점')) {
      this.shopVisitReason = 'fallback';
      return '상점';
    }
    if (options.includes('휴식')) return '휴식';
    return options[0] || null;
  };

  Modules.deepdungeon.getFloorEventOptions = function () {
    const known = ['정예 전투', '전투', '휴식', '상점', '제단', '특수 이벤트', '보스 전투', '대장간'];
    const text = Core.bodyText();
    return known.filter((label) => {
      const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return re.test(text) && this.findLeafCard(label);
    });
  };

  Modules.deepdungeon.handleFloorEventSelect = async function () {
    const options = this.getFloorEventOptions();
    if (options.length === 0) return false;
    const choice = await this.decideFloorEvent(options);
    if (!choice) return false;
    Core.log('deepdungeon', `층 이벤트 선택: [${options.join('/')}] → ${choice}`);
    const clicked = await this.clickCardForLabel(choice);
    if (!clicked) {
      Core.log('deepdungeon', `"${choice}" 카드를 클릭하지 못했습니다.`);
      return false;
    }
    const confirmed = await this.confirmEventSelection();
    if (!confirmed) {
      Core.log('deepdungeon', '"이벤트 선택" 버튼을 확인하지 못했습니다.');
    }
    return true;
  };

  Modules.deepdungeon.handleMonsterEncounter = async function () {
    const hp = this.readHp();
    this.hpBeforeBattle = hp ? hp.cur : null;

    const startBtn = Core.findButtonByText('전투 시작') || Core.findButtonByText('보스 전투 시작!');
    if (!startBtn) return false;
    startBtn.click();

    const battleEnded = await Core.retryStep(
      '전투 결과 확인',
      () => (/승리!|패배\.{2,}/.test(Core.bodyText()) ? true : null),
      { attempts: 5, waits: [2000, 3000, 5000, 8000, 12000] }
    );
    if (!battleEnded) {
      Core.log('deepdungeon', '전투 결과 화면을 확인하지 못했습니다 (재시도 후에도 실패).');
      return false;
    }

    const backBtn = await Core.retryStep('"심층 던전으로 돌아가기" 버튼 찾기', () =>
      Core.findButtonByText('심층 던전으로 돌아가기')
    );
    if (backBtn) {
      backBtn.click();
      await Core.humanDelay(700, 1400);
    }
    return true;
  };

  Modules.deepdungeon.handleRewardScreen = async function () {
    const statLeafCard = this.findLeafCard('랜덤 스탯 보상');
    if (!statLeafCard) return false;
    const container = statLeafCard.parentElement;
    if (!container || container.children.length === 0) return false;

    const cards = Array.from(container.children);
    const statCard = cards[0];
    const abilityCardsRaw = cards.slice(1, -1);
    const abilityCards = abilityCardsRaw.map((c) => this.parseRewardAbilityCard(c)).filter(Boolean);

    const profile = this.getJobProfile();
    const allRequired = [
      ...Object.keys(profile.requiredTargets),
      ...(profile.requiredLifePair ? profile.requiredLifePair.names : []),
    ];
    let pick = abilityCards.find((a) => allRequired.includes(a.name));
    if (!pick) {
      await this.ensureAbilityPanelExpanded();
      const owned = this.readAbilities();
      pick = abilityCards.find((a) => this.isRecommendedEligible(a.name, a.grade, owned));
    }

    if (pick) {
      Core.log('deepdungeon', `보상 선택: 어빌리티 [${pick.name}] (${pick.grade})`);
      pick.cardEl.click();
      await Core.humanDelay(500, 1000);
    } else {
      Core.log('deepdungeon', '보상 선택: 스탯 보상으로 진행');
      statCard.click();
      await Core.humanDelay(500, 1000);
      await this.handleStatSubChoiceIfPresent();
    }

    const nextBtn = await Core.retryStep('"다음 층으로" 버튼 찾기', () => Core.findButtonByText('다음 층으로'));
    if (nextBtn) {
      nextBtn.click();
      await Core.humanDelay(600, 1200);
    }
    return true;
  };

  Modules.deepdungeon.parseAltarCandidates = async function () {
    await this.ensureAbilityPanelExpanded();
    const abilities = this.readAbilities();
    const text = Core.bodyText();
    const results = [];
    for (const a of abilities) {
      const escaped = a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`${escaped}\\s*\\n\\s*(동|은|금|칠색)\\s*→\\s*(동|은|금|칠색)`);
      const m = text.match(re);
      if (m) results.push({ name: a.name, from: m[1], to: m[2] });
    }
    return results;
  };

  Modules.deepdungeon.handleAltarScreen = async function () {
    const isFountain = Core.bodyText().includes('샘물 마시기');
    const wantCount = isFountain ? 2 : 1;
    const candidates = await this.parseAltarCandidates(); // [{name, from, to}, ...]
    const candidateNames = candidates.map((c) => c.name);
    const profile = this.getJobProfile();

    let targets = candidates.length > 0 ? this.pickAltarTargets(candidates, wantCount) : [];

    if (targets.length === 0) {
      // 승급할 필수 어빌이 없다 (전부 이미 목표 등급이거나, 아직 보유하지 않았거나).
      // 제단(단일 선택)은 아무것도 안 골라도 "다음 층으로"가 활성화되는 경우가
      // 많아 그대로 건너뛸 수 있지만, 축복의 샘(2개 선택)은 2개를 채우기 전까지
      // "다음 층으로"가 비활성 상태라 이 방법으로 건너뛸 수 없다. 버튼이 실제로
      // 클릭 가능한지(disabled 여부)까지 확인해서, 안 되면 아래 폴백으로 넘어간다.
      const skipBtn = Core.findButtonByText('다음 층으로');
      if (skipBtn && !skipBtn.disabled) {
        Core.log(
          'deepdungeon',
          `${isFountain ? '축복의 샘' : '제단'}: 승급할 필수 어빌이 없어 건너뜁니다 (추천 어빌은 제단 대상 아님).`
        );
        skipBtn.click();
        await Core.humanDelay(600, 1200);
        return true;
      }
      // 건너뛸 수 없는 경우(축복의 샘 등) - "던전 포기" 말고는 벗어날 방법이
      // 없으므로, 부득이하게 추천 어빌 → 그 외 순으로 채워서라도 화면을 통과한다.
      Core.log(
        'deepdungeon',
        `${isFountain ? '축복의 샘' : '제단'}: 필수 어빌이 없고 건너뛸 수도 없어(다음 층으로 비활성), 부득이하게 다른 어빌로 채웁니다.`
      );
      const fallbackPool = [
        ...profile.recommendedAbilities.filter((n) => candidateNames.includes(n)),
        ...candidateNames,
      ];
      for (const name of fallbackPool) {
        if (targets.length >= wantCount) break;
        if (!targets.includes(name)) targets.push(name);
      }
    } else if (targets.length < wantCount) {
      // 필수 대상이 일부만 있는 경우(예: 축복의 샘 2슬롯 중 1개만 필수 후보) -
      // 나머지 자리도 채워야 확인 버튼이 활성화되므로 같은 폴백 풀로 채운다.
      const fallbackPool = [
        ...profile.recommendedAbilities.filter((n) => candidateNames.includes(n)),
        ...candidateNames,
      ];
      for (const name of fallbackPool) {
        if (targets.length >= wantCount) break;
        if (!targets.includes(name)) targets.push(name);
      }
    }

    Core.log('deepdungeon', `${isFountain ? '축복의 샘' : '제단'} 승급 대상: ${targets.join(', ')}`);

    for (const name of targets) {
      const card = this.findLeafCard(name);
      if (card) {
        card.click();
        await Core.humanDelay(400, 900);
      }
    }

    const confirmBtn = isFountain
      ? await Core.retryStep(
          '"샘물 마시기" 버튼 활성화 대기',
          () => {
            const b = Core.allButtons().find((btn) => btn.textContent.trim().startsWith('샘물 마시기'));
            return b && !b.disabled ? b : null;
          },
          { attempts: 3, waits: [800, 1200, 1800] }
        )
      : Core.findButtonByText('승급');

    if (!confirmBtn) {
      // 확인 버튼이 여전히 비활성 - "다음 층으로"라도 활성화됐는지 다시 확인한다.
      const skipBtn = Core.findButtonByText('다음 층으로');
      if (skipBtn && !skipBtn.disabled) {
        Core.log('deepdungeon', `${isFountain ? '축복의 샘' : '제단'} 확인 버튼이 활성화되지 않아 건너뜁니다.`);
        skipBtn.click();
        await Core.humanDelay(600, 1200);
        return true;
      }
      // 그래도 안 되면 후보군에서 아무거나 더 채워서 한 번 더 시도해본다 (무한
      // 루프 방지를 위해 여기서도 실패하면 일단 true를 반환해 다음 tick에서
      // 다시 판단하게 한다 - 같은 상태가 반복되면 stepOnce의 무응답 감지에 걸림).
      Core.log('deepdungeon', `${isFountain ? '축복의 샘' : '제단'}: 확인 버튼을 찾지 못했습니다.`);
      return false;
    }
    confirmBtn.click();
    await Core.humanDelay(700, 1400);

    const nextBtn = await Core.retryStep('"다음 층으로" 버튼 찾기', () => Core.findButtonByText('다음 층으로'));
    if (nextBtn) {
      nextBtn.click();
      await Core.humanDelay(600, 1200);
    }
    return true;
  };

  Modules.deepdungeon.getShopItemContainer = function () {
    const anchor = this.findLeafCardStartsWith('HP/MP 전체 회복') || this.findLeafCard('HP/MP 전체 회복');
    if (!anchor) return null;
    return anchor.parentElement;
  };

  Modules.deepdungeon.parseShopItems = function () {
    const container = this.getShopItemContainer();
    if (!container) return [];
    return Array.from(container.children).map((c) => this.parseShopItemCard(c)).filter(Boolean);
  };

  Modules.deepdungeon.buyShopItem = async function (item) {
    item.cardEl.click();
    await Core.humanDelay(500, 1000);
    const buyBtn = Core.findButtonByText('구매');
    if (!buyBtn || buyBtn.disabled) return false;
    buyBtn.click();
    await Core.humanDelay(700, 1400);
    await this.handleStatSubChoiceIfPresent();
    return true;
  };

  // 대장간: 무기를 먼저 최대한 강화하고, 조각이 남으면 방어구 → 악세서리 순으로
  // 넘어가며 마저 강화한다 (마술 전용, 45층 이후 딱 한 번).
  Modules.deepdungeon.readSmithyShards = function () {
    const m = Core.bodyText().match(/장비\s*조각\s*:\s*([\d,]+)/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  };

  // "무기"/"방어구"/"악세서리" 글자는 실제 버튼 안의 텍스트가 아니라, 아이콘
  // 전용 버튼 옆에 붙은 별도 라벨이다. Core.findButtonByText로는 못 찾으므로,
  // 라벨 텍스트를 가진 leaf에서 조상으로 올라가며 그 안에 있는 첫 번째 버튼을
  // 찾는다 (실전 확인: 라벨의 6단계 위 조상 안에 실제 버튼이 있음).
  Modules.deepdungeon.findSlotSelectButton = function (slotLabel) {
    const leaf = [...document.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && el.textContent.trim() === slotLabel
    );
    if (!leaf) return null;
    let node = leaf;
    for (let i = 0; i < 8 && node; i++) {
      const btn = node.querySelector('button');
      if (btn) return btn;
      node = node.parentElement;
    }
    return null;
  };

  Modules.deepdungeon.enhanceSlotToMax = async function (slotLabel) {
    const tabBtn = this.findSlotSelectButton(slotLabel);
    if (tabBtn) {
      tabBtn.click();
      await Core.humanDelay(400, 800);
    } else {
      Core.log('deepdungeon', `대장간: "${slotLabel}" 슬롯 선택 버튼을 찾지 못했습니다.`);
    }

    // 슬롯 선택 직후 "10회 강화" 버튼이 활성화되기까지 렌더링 지연이 있을 수
    // 있어, 고정 대기 대신 활성화될 때까지 재확인한다. 조각이 부족해서 원래
    // 비활성인 경우엔 여기서 재시도만 소모하고 자연스럽게 넘어간다.
    const firstEnhanceBtn = await Core.retryStep(
      `"${slotLabel}" 강화 버튼 활성화 대기`,
      () => {
        const b = Core.allButtons().find(
          (btn) => btn.textContent.trim().includes('강화') && /\d+회\s*강화/.test(btn.textContent.trim())
        );
        return b && !b.disabled ? b : null;
      },
      { attempts: 4, waits: [500, 800, 1200, 1500] }
    );
    if (!firstEnhanceBtn) {
      Core.log('deepdungeon', `대장간: "${slotLabel}" 강화 버튼이 활성화되지 않았습니다 (조각 부족이거나 이미 최대일 수 있음).`);
      return;
    }

    for (let i = 0; i < 30; i++) {
      const enhanceBtn = Core.allButtons().find((b) => b.textContent.trim().includes('강화') && /\d+회\s*강화/.test(b.textContent.trim()));
      if (!enhanceBtn || enhanceBtn.disabled) break;
      const shardsBefore = this.readSmithyShards();
      enhanceBtn.click();
      await Core.humanDelay(600, 1100);
      const shardsAfter = this.readSmithyShards();
      Core.log('deepdungeon', `대장간: ${slotLabel} 강화 시도 (조각 ${shardsBefore} → ${shardsAfter})`);
      if (shardsAfter >= shardsBefore) break; // 조각이 안 줄었으면 더 강화가 안 된 것(소진/최대)
      if (shardsAfter <= 0) break;
    }
  };

  Modules.deepdungeon.handleSmithy = async function () {
    Core.log('deepdungeon', `대장간 도착 (보유 조각: ${this.readSmithyShards()}) - 무기부터 최대한 강화합니다.`);
    await this.enhanceSlotToMax('무기');
    if (this.readSmithyShards() > 0) await this.enhanceSlotToMax('방어구');
    if (this.readSmithyShards() > 0) await this.enhanceSlotToMax('악세서리');

    this.usedSmithyOnce = true;
    Core.log('deepdungeon', `대장간 완료 (남은 조각: ${this.readSmithyShards()})`);

    const nextBtn = await Core.retryStep('"다음 층으로" 버튼 찾기', () => Core.findButtonByText('다음 층으로'));
    if (nextBtn) {
      nextBtn.click();
      await Core.humanDelay(600, 1200);
    }
    return true;
  };

  Modules.deepdungeon.handleNormalShop = async function () {
    const hp = this.readHp();
    const hpPct = hp ? (hp.cur / hp.max) * 100 : 100;
    const profile = this.getJobProfile();
    // 마술이 "상점"을 의도적으로(토큰 기준 충족) 고른 게 아니라 다른 선택지가
    // 없어서 어쩔 수 없이 들어온 경우엔, 스탯 구매만 하고 어빌/장비조각 구매는
    // 하지 않는다. 물리딜/신술은 이 구분 없이 항상 기존 방식대로 동작한다.
    const statOnly = profile.buyEquipmentShards && this.shopVisitReason !== 'deliberate';

    for (let i = 0; i < 8; i++) {
      const items = this.parseShopItems();
      if (items.length === 0) break;
      const tokens = this.readTokens();

      if (hpPct <= this.config.emergencyHpPercent) {
        const healItem = items.find((it) => it.title.startsWith('HP/MP 전체 회복'));
        if (healItem && healItem.cost !== null && tokens >= healItem.cost) {
          Core.log('deepdungeon', '상점: HP/MP 전체 회복 구매 (응급)');
          await this.buyShopItem(healItem);
          continue;
        }
      }

      if (!statOnly) {
        const abilityPick = await this.pickBestAbilityItem(items);
        if (abilityPick && abilityPick.cost !== null && tokens >= abilityPick.cost) {
          Core.log('deepdungeon', `상점: 어빌리티 [${abilityPick.name}] (${abilityPick.grade}) 구매`);
          await this.buyShopItem(abilityPick);
          continue;
        }
      }

      const statItem = items.find((it) => it.title.startsWith('스탯 선택 보상'));
      if (statItem && statItem.cost !== null && tokens >= statItem.cost) {
        Core.log('deepdungeon', '상점: 스탯 선택 보상 구매');
        await this.buyShopItem(statItem);
        continue;
      }

      if (!statOnly && profile.buyEquipmentShards) {
        const shardItem = items.find((it) => it.title.startsWith('장비 조각 x100'));
        if (shardItem && shardItem.cost !== null && tokens >= shardItem.cost) {
          Core.log('deepdungeon', '상점: 장비 조각 x100 구매 (여유 토큰 소진)');
          await this.buyShopItem(shardItem);
          continue;
        }
      }
      break;
    }

    const nextBtn = await Core.retryStep('"다음 층으로" 버튼 찾기', () => Core.findButtonByText('다음 층으로'));
    if (nextBtn) {
      nextBtn.click();
      await Core.humanDelay(600, 1200);
    }
    return true;
  };

  Modules.deepdungeon.handleShadyMerchant = async function () {
    const viewBtn = Core.findButtonByText('상품 보기');
    if (viewBtn) {
      viewBtn.click();
      await Core.humanDelay(700, 1400);
    }
    const items = this.parseShopItems();
    const tokens = this.readTokens();

    let pick = await this.pickBestAbilityItem(items);
    if (!pick) {
      pick = items.find((it) => it.title.startsWith('스탯 선택 보상'));
    }
    if (pick && pick.cost !== null && tokens >= pick.cost) {
      Core.log('deepdungeon', `수상한 상인: [${pick.title}] 구매`);
      await this.buyShopItem(pick);
    } else {
      Core.log('deepdungeon', '수상한 상인: 살 만한 게 없어 거절합니다.');
      const rejectBtn = Core.findButtonByText('거절');
      if (rejectBtn) {
        rejectBtn.click();
        await Core.humanDelay(500, 1000);
      }
    }
    const nextBtn = await Core.retryStep('"다음 층으로" 버튼 찾기', () => Core.findButtonByText('다음 층으로'));
    if (nextBtn) {
      nextBtn.click();
      await Core.humanDelay(600, 1200);
    }
    return true;
  };

  Modules.deepdungeon.handleRestScreen = async function () {
    const restBtn = Core.findButtonByText('휴식하기');
    if (restBtn) {
      restBtn.click();
      await Core.humanDelay(700, 1400);
      return true;
    }
    const nextBtn = Core.findButtonByText('다음 층으로');
    if (nextBtn) {
      nextBtn.click();
      await Core.humanDelay(600, 1200);
      return true;
    }
    return false;
  };

  Modules.deepdungeon.handleTreasureOrPotion = async function () {
    const btn = Core.findButtonByText('약병 마시기');
    if (btn) {
      btn.click();
      await Core.humanDelay(600, 1200);
    }
    const nextBtn = await Core.retryStep('"다음 층으로" 버튼 찾기', () => Core.findButtonByText('다음 층으로'));
    if (nextBtn) {
      nextBtn.click();
      await Core.humanDelay(600, 1200);
    }
    return true;
  };

  Modules.deepdungeon.handleWanderingSoul = async function () {
    const floor = this.readFloor();
    const belowThreshold = floor === null || floor < this.config.wanderingSoulFloorThreshold;
    await this.ensureAbilityPanelExpanded();
    const abilities = this.readAbilities();
    const growth = abilities.find((a) => a.name === '급속 성장');
    const growthMaxed = !growth || growth.grade === '칠색';

    if (belowThreshold || growthMaxed) {
      Core.log('deepdungeon', '떠도는 영혼: 조건 미충족 - 도망갑니다.');
      const runBtn = Core.findButtonByText('도망가기');
      if (runBtn) {
        runBtn.click();
        await Core.humanDelay(500, 1000);
      }
    } else {
      const growthCard = this.findLeafCard('급속 성장');
      if (growthCard) {
        growthCard.click();
        await Core.humanDelay(400, 900);
      }
      const requestBtn = Core.findButtonByText('교환 요청');
      if (requestBtn) {
        requestBtn.click();
        await Core.humanDelay(700, 1400);
      }
      const candidateCards = [...document.querySelectorAll('*')].filter(
        (el) => el.children.length === 0 && /^(동|은|금|칠색)$/.test(el.textContent.trim())
      );
      await this.ensureAbilityPanelExpanded();
      const owned = this.readAbilities();
      let found = null;
      for (const gradeLeaf of candidateCards) {
        const card = this.upToCard(gradeLeaf);
        if (!card) continue;
        const parsed = this.parseRewardAbilityCard(card);
        if (parsed && this.isRecommendedEligible(parsed.name, parsed.grade, owned)) {
          found = parsed;
          break;
        }
      }
      if (found) {
        Core.log('deepdungeon', `떠도는 영혼: [${found.name}]로 교환합니다.`);
        found.cardEl.click();
        await Core.humanDelay(400, 900);
        const exchangeBtn = Core.findButtonByText('교환');
        if (exchangeBtn) {
          exchangeBtn.click();
          await Core.humanDelay(600, 1200);
        }
      } else {
        Core.log('deepdungeon', '떠도는 영혼: 교환 후보 중 추천 어빌이 없어 도망갑니다.');
        const runBtn = Core.findButtonByText('도망가기');
        if (runBtn) {
          runBtn.click();
          await Core.humanDelay(500, 1000);
        }
      }
    }

    const nextBtn = await Core.retryStep('"다음 층으로" 버튼 찾기', () => Core.findButtonByText('다음 층으로'));
    if (nextBtn) {
      nextBtn.click();
      await Core.humanDelay(600, 1200);
    }
    return true;
  };

  Modules.deepdungeon.handleTrainingRoom = async function () {
    const allBtn = this.findLeafCard('전체 선택');
    if (allBtn) {
      allBtn.click();
      await Core.humanDelay(400, 900);
    }
    const trainBtn = await Core.retryStep('"수련하기" 버튼 찾기', () =>
      Core.allButtons().find((b) => b.textContent.trim().startsWith('수련하기'))
    );
    if (trainBtn) {
      trainBtn.click();
      await Core.humanDelay(700, 1400);
    }
    const nextBtn = await Core.retryStep('"다음 층으로" 버튼 찾기', () => Core.findButtonByText('다음 층으로'));
    if (nextBtn) {
      nextBtn.click();
      await Core.humanDelay(600, 1200);
    }
    return true;
  };

  Modules.deepdungeon.handleRuneAnvil = async function () {
    const allBtn = this.findLeafCard('전체 선택');
    if (allBtn) {
      allBtn.click();
      await Core.humanDelay(400, 900);
    }
    const forgeBtn = await Core.retryStep('"모루 두드리기" 버튼 찾기', () =>
      Core.allButtons().find((b) => b.textContent.trim().startsWith('모루 두드리기'))
    );
    if (forgeBtn) {
      forgeBtn.click();
      await Core.humanDelay(700, 1400);
    }
    const nextBtn = await Core.retryStep('"다음 층으로" 버튼 찾기', () => Core.findButtonByText('다음 층으로'));
    if (nextBtn) {
      nextBtn.click();
      await Core.humanDelay(600, 1200);
    }
    return true;
  };

  Modules.deepdungeon.handleCompass = async function () {
    const myAttr = this.readMyAttribute();
    const target = myAttr ? DD_ATTR_COUNTER[myAttr] : null;
    if (target) {
      const attrCard = this.findLeafCard(target);
      if (attrCard) {
        attrCard.click();
        await Core.humanDelay(400, 900);
      }
      const applyBtn = await Core.retryStep('"속성 적용" 버튼 찾기', () =>
        Core.allButtons().find((b) => b.textContent.includes('속성 적용'))
      );
      if (applyBtn) {
        applyBtn.click();
        await Core.humanDelay(600, 1200);
      }
      Core.log('deepdungeon', `예언의 나침반: 던전의 주인 속성을 [${target}](으)로 지정했습니다.`);
    } else {
      Core.log('deepdungeon', '예언의 나침반: 내 속성을 읽지 못해 거절합니다.');
      const rejectBtn = Core.findButtonByText('거절');
      if (rejectBtn) {
        rejectBtn.click();
        await Core.humanDelay(500, 1000);
      }
    }
    const nextBtn = await Core.retryStep('"다음 층으로" 버튼 찾기', () => Core.findButtonByText('다음 층으로'));
    if (nextBtn) {
      nextBtn.click();
      await Core.humanDelay(600, 1200);
    }
    return true;
  };

  Modules.deepdungeon.handleSpecialEventScreen = async function () {
    const text = Core.bodyText();
    if (text.includes('보물상자') || text.includes('아드레날린')) return this.handleTreasureOrPotion();
    if (text.includes('떠도는 영혼')) return this.handleWanderingSoul();
    if (text.includes('수상한 상인')) return this.handleShadyMerchant();
    if (text.includes('수련의 방')) return this.handleTrainingRoom();
    if (text.includes('룬의 모루')) return this.handleRuneAnvil();
    if (text.includes('예언의 나침반')) return this.handleCompass();
    if (text.includes('축복의 샘')) return this.handleAltarScreen();

    Core.log('deepdungeon', '알 수 없는 특수 이벤트를 만났습니다 - 화면을 확인해주세요. 안전 옵션으로 넘어갑니다.');
    const safeBtn =
      Core.findButtonByText('거절') || Core.findButtonByText('도망가기') || Core.findButtonByText('지나가기');
    if (safeBtn) {
      safeBtn.click();
      await Core.humanDelay(500, 1000);
    }
    const nextBtn = await Core.retryStep('"다음 층으로" 버튼 찾기', () => Core.findButtonByText('다음 층으로'), {
      attempts: 2,
      waits: [1000, 2000],
    });
    if (nextBtn) {
      nextBtn.click();
      await Core.humanDelay(600, 1200);
    }
    return true;
  };

  Modules.deepdungeon.handleDungeonMaster = async function () {
    const challengeBtn = Core.findButtonByText('던전의 주인 도전');
    if (!challengeBtn) return false;
    challengeBtn.click();

    const ended = await Core.retryStep(
      '던전의 주인 도전 결과 확인',
      () => (/던전의\s*주인\s*격파|전투\s*종료/.test(Core.bodyText()) ? true : null),
      { attempts: 5, waits: [2000, 3000, 5000, 8000, 12000] }
    );
    if (!ended) {
      Core.log('deepdungeon', '던전의 주인 도전 결과 화면을 확인하지 못했습니다.');
      return false;
    }

    const scoreMatch = Core.bodyText().match(/데미지\s*\n?\s*([\d,]+)/);
    const rankMatch = Core.bodyText().match(/순위\s*\n?\s*(\d+)\s*위/);
    Core.log(
      'deepdungeon',
      `던전의 주인 도전 결과 - 데미지: ${scoreMatch ? scoreMatch[1] : '알 수 없음'}, 순위: ${
        rankMatch ? rankMatch[1] + '위' : '알 수 없음'
      }`
    );

    const backBtn = await Core.retryStep('"심층 던전으로 돌아가기" 버튼 찾기', () =>
      Core.findButtonByText('심층 던전으로 돌아가기')
    );
    if (backBtn) {
      backBtn.click();
      await Core.humanDelay(700, 1400);
    }

    this.cycleCount += 1;
    return true;
  };

  Modules.deepdungeon.goToDeepDungeon = async function () {
    await Core.clickNavMenuExact('전투', '심층 던전');
    await Core.waitFor(() => (/deep-dungeon/.test(location.href) || Core.bodyText().includes('던전 진입') ? true : null));
  };

  // "기록" 탭으로 이동해서 "주간 누적 데미지" 값을 읽는다. 실패하면 null 반환.
  Modules.deepdungeon.readWeeklyCumulativeDamage = async function () {
    const recordTab = await Core.retryStep('"기록" 탭 찾기', () => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      return tabs.find((t) => t.textContent.trim() === '기록') || null;
    });
    if (!recordTab) return null;
    recordTab.click();
    await Core.humanDelay(600, 1200);

    const matched = await Core.retryStep('"주간 누적 데미지" 텍스트 확인', () => {
      const m = Core.bodyText().match(/주간\s*누적\s*데미지\s*([\d,]+)/);
      return m || null;
    });
    if (!matched) return null;
    return parseInt(matched[1].replace(/,/g, ''), 10);
  };

  // 실제 확인된 플로우: 로비에서 "던전 진입" 클릭 → 디버프/버프 특성 선택 화면
  // (사용자가 미리 설정해둔 특성이 그대로 유지된 상태)이 뜸 → 여기서 특성을 건드리지
  // 않고 그대로 "입장"만 누른다. "특성 없이 입장"을 누르면 미리 설정해둔 디버프/버프가
  // 전부 사라지므로 절대 누르면 안 된다(반드시 정확히 "입장" 텍스트인 버튼만 클릭).
  // "입장"이라는 정확히 같은 텍스트가 페이지 상단 탭(심층 던전/입장/기록/랭킹...)에도
  // 존재해서 Core.findButtonByText('입장')이 탭을 먼저 찾아버리는 문제가 있었다.
  // 탭(role="tab" 또는 MuiTab 클래스)을 제외한 진짜 버튼만 찾는 전용 헬퍼.
  Modules.deepdungeon.findEnterConfirmButton = function () {
    return (
      Core.allButtons().find(
        (b) =>
          b.textContent.trim() === '입장' &&
          b.getAttribute('role') !== 'tab' &&
          !/MuiTab/.test(b.className)
      ) || null
    );
  };

  // 로비 화면에는 세 가지 경우가 있다:
  //  1) 이미 층이 진행 중인 화면(/deep-dungeon/play, "N층 / 50층" 표시) - 그대로 진행
  //  2) 이전에 시작해둔 런이 남아있는 경우 - "진행 중인 던전 이어하기 (N층)" 버튼
  //     (특성 선택 화면 없이 바로 이어짐)
  //  3) 완전히 새로 시작하는 경우 - "던전 진입" 버튼 → 특성 선택 화면 → "입장"
  Modules.deepdungeon.findResumeButton = function () {
    return Core.allButtons().find((b) => b.textContent.trim().startsWith('진행 중인 던전 이어하기')) || null;
  };

  Modules.deepdungeon.enterFreshRunIfNeeded = async function () {
    if (this.readFloor() !== null) return true;

    const resumeBtn = await Core.retryStep('"진행 중인 던전 이어하기" 버튼 찾기', () => this.findResumeButton(), {
      attempts: 2,
      waits: [800, 1500],
    });
    if (resumeBtn) {
      Core.log('deepdungeon', '진행 중이던 런을 이어갑니다.');
      resumeBtn.click();
      await Core.humanDelay(1000, 1800);
      return await Core.waitFor(() => this.readFloor() !== null, 10000, 500);
    }

    // 이전 시도에서 이미 "던전 진입"까지 눌러놓아 "0층 — 특성 선택" 모달이 떠 있는
    // 상태일 수 있다. 이 경우 "던전 진입" 버튼은 더 이상 화면에 없으므로(모달에 가려짐)
    // 다시 찾으려 하지 말고 곧바로 "입장"을 누른다.
    const onTraitScreen = () =>
      Core.bodyText().includes('특성 선택') || !!Core.findButtonByText('특성 없이 입장');

    if (!onTraitScreen()) {
      const enterBtn = await Core.retryStep('"던전 진입" 버튼 찾기', () => Core.findButtonByText('던전 진입'), {
        attempts: 3,
        waits: [1000, 2000, 3000],
      });
      if (!enterBtn) {
        // 던전 진입 버튼도 없다면 이미 특성 선택 화면일 수 있으니 한 번 더 확인
        if (!onTraitScreen()) return false;
      } else {
        enterBtn.click();
        await Core.humanDelay(800, 1500);
      }
    }

    // 디버프(포인트 획득) 선택 화면 - 사용자가 미리 세팅해둔 특성을 그대로 두고
    // "입장"만 누른다. 상단 탭과 텍스트가 같아서 findEnterConfirmButton으로 탭을
    // 제외한 실제 확정 버튼만 찾는다. 카드 목록이 길어 렌더링이 늦을 수 있으므로
    // 넉넉하게 재시도한다.
    const confirmBtn = await Core.retryStep(
      '특성 선택 화면의 "입장" 버튼 찾기',
      () => this.findEnterConfirmButton(),
      { attempts: 5, waits: [1000, 2000, 3000, 4000, 5000] }
    );
    if (!confirmBtn) {
      Core.log('deepdungeon', '특성 선택 화면의 "입장" 버튼을 찾지 못했습니다.');
      return false;
    }
    confirmBtn.click();
    await Core.humanDelay(1000, 1800);

    return await Core.waitFor(() => this.readFloor() !== null, 10000, 500);
  };

  Modules.deepdungeon.stepOnce = async function () {
    const text = Core.bodyText();

    if (text.includes('던전의 주인') && Core.findButtonByText('던전의 주인 도전')) {
      return await this.handleDungeonMaster();
    }
    if (/이번\s*전투에서\s*상대할|몬스터\s*등장!|정예\s*몬스터\s*등장!|보스\s*등장!/.test(text)) {
      return await this.handleMonsterEncounter();
    }
    if (text.includes('보상을 선택하세요')) {
      return await this.handleRewardScreen();
    }
    if (text.includes('전투 패배')) {
      // 패배 시에는 보상 없이 "다음 층으로" 버튼만 뜬다.
      const nextBtn = await Core.retryStep('"다음 층으로" 버튼 찾기', () => Core.findButtonByText('다음 층으로'));
      if (nextBtn) {
        nextBtn.click();
        await Core.humanDelay(600, 1200);
      }
      return true;
    }
    if (text.includes('등급을 승급할 어빌리티를 선택하세요') || text.includes('샘물 마시기')) {
      return await this.handleAltarScreen();
    }
    if (text.includes('강화할 장비를 선택하세요')) {
      return await this.handleSmithy();
    }
    if (text.includes('휴식 공간을 발견했습니다')) {
      return await this.handleRestScreen();
    }
    if (text.includes('보유 토큰') && !text.includes('수상한 상인')) {
      return await this.handleNormalShop();
    }
    if (text.includes('수상한 상인')) {
      return await this.handleShadyMerchant();
    }
    if (
      text.includes('떠도는 영혼') ||
      text.includes('수련의 방') ||
      text.includes('룬의 모루') ||
      text.includes('예언의 나침반') ||
      text.includes('축복의 샘') ||
      text.includes('보물상자')
    ) {
      return await this.handleSpecialEventScreen();
    }
    if (text.includes('이번 층의 이벤트를 선택하세요')) {
      return await this.handleFloorEventSelect();
    }
    if (text.includes('50층 클리어 완료')) {
      await Core.sleep(500);
      return true;
    }
    return false;
  };

  Modules.deepdungeon.mainLoop = async function () {
    const mod = this;
    mod.cycleCount = 0; // 매크로를 다시 시작할 때마다 "이번 실행"의 도전 횟수로 리셋
    mod.usedSmithyOnce = false;

    Core.log('deepdungeon', `심층던전 자동클리어 시작 (${mod.config.jobMode})`);

    await mod.goToDeepDungeon();
    if (!mod.running) return;

    // "누적 데미지 100만 이하시 재도전" 옵션이 켜져 있으면, 매크로를 시작하는
    // 시점에도 먼저 주간 누적 데미지를 확인한다. 이미 100만을 넘겼다면 (예:
    // 수동 플레이로 이미 채워둔 경우) 새 런에 진입하지 않고 바로 정지한다.
    if (mod.config.retryIfWeeklyDamageUnder1M) {
      const startDamage = await mod.readWeeklyCumulativeDamage();
      if (startDamage !== null && startDamage > 1000000) {
        Core.notifyCompleted(
          'deepdungeon',
          `이미 주간 누적 데미지 ${startDamage.toLocaleString()} (100만 초과)라 시작하지 않고 정지합니다.`
        );
        return;
      }
      const enterTabAtStart = await Core.retryStep('"입장" 탭 찾기', () => {
        const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
        return tabs.find((t) => t.textContent.trim() === '입장') || null;
      });
      if (enterTabAtStart) {
        enterTabAtStart.click();
        await Core.humanDelay(600, 1200);
      }
    }

    const entered = await mod.enterFreshRunIfNeeded();
    if (!entered) {
      Core.log('deepdungeon', '심층던전 화면 진입을 확인하지 못했습니다 (이미 진행 중인 런이 없을 수 있음).');
    }

    let consecutiveNoProgress = 0;
    const maxNoProgress = 6;

    while (mod.running) {
      let acted = false;
      try {
        acted = await mod.stepOnce();
      } catch (e) {
        Core.log('deepdungeon', `오류 발생: ${e.message}`);
      }

      if (!mod.running) break;

      if (acted) {
        consecutiveNoProgress = 0;
      } else {
        consecutiveNoProgress += 1;
        if (consecutiveNoProgress >= maxNoProgress) {
          Core.notifyStopped('deepdungeon', '현재 화면을 인식하지 못해 여러 번 대기했습니다. 화면 상태를 확인해주세요.');
          break;
        }
        await Core.sleep(2000);
      }

      Core.updateModuleButtons();

      if (mod.cycleCount >= 1) {
        // 던전의 주인은 한 런당 1회만 도전 가능하다. "주간 누적 데미지 100만 이하시
        // 재도전" 옵션이 켜져 있으면, 기록 탭에서 실제 주간 누적 데미지를 확인해서
        // 아직 100만 이하면 새 런을 시작해 계속 도전한다.
        if (mod.config.retryIfWeeklyDamageUnder1M) {
          const weeklyDamage = await mod.readWeeklyCumulativeDamage();
          if (weeklyDamage !== null && weeklyDamage <= 1000000) {
            Core.log(
              'deepdungeon',
              `주간 누적 데미지 ${weeklyDamage.toLocaleString()} (100만 이하) → 재도전을 위해 새 런을 시작합니다.`
            );
            const enterTab = await Core.retryStep('"입장" 탭 찾기', () => {
              const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
              return tabs.find((t) => t.textContent.trim() === '입장') || null;
            });
            if (enterTab) {
              enterTab.click();
              await Core.humanDelay(600, 1200);
            }
            const enteredAgain = await mod.enterFreshRunIfNeeded();
            if (enteredAgain) {
              mod.cycleCount = 0;
              consecutiveNoProgress = 0;
              await Core.humanDelay(300, 700);
              continue;
            }
            Core.notifyStopped('deepdungeon', '재도전을 위해 새 런을 시작하지 못했습니다.');
            break;
          }
          if (weeklyDamage === null) {
            Core.log('deepdungeon', '주간 누적 데미지를 확인하지 못해 안전하게 정지합니다.');
          } else {
            Core.log('deepdungeon', `주간 누적 데미지 ${weeklyDamage.toLocaleString()} (100만 초과) → 정지합니다.`);
          }
        }
        Core.notifyCompleted('deepdungeon', '던전의 주인 도전을 완료했습니다.');
        break;
      }

      await Core.humanDelay(300, 700);
    }
  };

  // ==========================================================================
  // 공용 시작/정지 처리 (한 번에 하나의 모듈만 실행되도록 보호)
  // ==========================================================================
  Core.startModule = function (moduleId) {
    const mod = Modules[moduleId];
    if (!mod) return;
    if (
      (moduleId === 'autohunt' || moduleId === 'dungeon') &&
      !Core.ELEMENT_OPTIONS.includes(mod.config.originalElement)
    ) {
      Core.showBanner(moduleId, '시작 전에 원래 속성을 선택해주세요.');
      Core.log(moduleId, '원래 속성 미선택으로 시작을 차단했습니다.');
      return;
    }
    if (Core.activeModuleId && Core.activeModuleId !== moduleId) {
      Core.showBanner(
        moduleId,
        `"${MODULE_LABELS[Core.activeModuleId]}" 모듈이 이미 실행 중입니다. 먼저 그 모듈을 정지한 뒤 시작해주세요.`
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
    mod.running = true;
    mod.stopRequested = false;
    if (moduleId === 'rejob') {
      mod.nextRestAt = mod.cycleCount + Core.rand(mod.config.restEvery[0], mod.config.restEvery[1]);
    }
    Core.log(moduleId, `${MODULE_LABELS[moduleId]} 매크로 시작`);
    Core.updateModuleButtons();
    let loopPromise;
    loopPromise = Promise.resolve()
      .then(async () => {
        Core.runContext = { moduleId, runId };
        await mod.mainLoop(runId);
      })
      .catch((e) => {
        if (!Core.isRunCancelled(moduleId, runId)) {
          Core.log(moduleId, `처리되지 않은 오류: ${e && e.message ? e.message : String(e)}`);
          Core.showBanner(moduleId, `처리되지 않은 오류로 정지했습니다: ${e && e.message ? e.message : String(e)}`, false);
          Core.playStopSound();
        }
      })
      .finally(() => {
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
  };

  Core.requestStopModule = function (moduleId) {
    const mod = Modules[moduleId];
    if (!mod || !mod.running) return;
    mod.runId = (mod.runId || 0) + 1;
    mod.stopRequested = true;
    mod.running = false;
    if (Core.activeModuleId === moduleId) Core.activeModuleId = null;
    Core.log(moduleId, '사용자 요청으로 정지합니다...');
    Core.updateModuleButtons();
  };

  // ==========================================================================
  // 패널 UI (탭 구조, 하나의 패널을 다섯 모듈이 공유)
  // ==========================================================================
  const UIRefs = { rejob: {}, autohunt: {}, raremap: {}, dungeon: {}, deepdungeon: {} };
  let activeTab = 'rejob';

  Core.updateModuleButtons = function () {
    ['rejob', 'autohunt', 'raremap', 'dungeon', 'deepdungeon'].forEach((id) => {
      const mod = Modules[id];
      const refs = UIRefs[id];
      if (!refs.startBtn) return;
      const otherRunning = Core.activeModuleId && Core.activeModuleId !== id;
      const safetyLocked = id === 'rejob' && refs.safetyCheck && !refs.safetyCheck.checked;
      refs.startBtn.disabled = mod.running || otherRunning || safetyLocked;
      refs.stopBtn.disabled = !mod.running;
      const cycleLabel =
        id === 'dungeon'
          ? `오늘 클리어 ${mod.cycleCount}개`
          : id === 'deepdungeon'
          ? `던전의 주인 도전 ${mod.cycleCount}회`
          : `사이클 ${mod.cycleCount}`;
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

  const AUTOHUNT_PERSIST_KEYS = ['originalElement', 'groundSuffix', 'floor', 'goldThreshold', 'minEnergy', 'ignoreProtectionOff'];

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
    refs.inputs = [elementSelect, groundSelect, floorSelect, goldInput, energyInput, protCheck];
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
      mod.saveConfig();
    });
    container.appendChild(elementSelect);

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
    refs.inputs = [elementSelect, dailyCheck, rerollInput, ...instantInputs];
  }

  const DEEPDUNGEON_CONFIG_KEY = 'lrm-deepdungeon-config';

  Modules.deepdungeon.saveConfig = function () {
    try {
      localStorage.setItem(
        DEEPDUNGEON_CONFIG_KEY,
        JSON.stringify({
          tokenShopThreshold: this.config.tokenShopThreshold,
          emergencyHpPercent: this.config.emergencyHpPercent,
          bossPreFloorHpPercent: this.config.bossPreFloorHpPercent,
          hpDropTriggerPercent: this.config.hpDropTriggerPercent,
          wanderingSoulFloorThreshold: this.config.wanderingSoulFloorThreshold,
          targetAC: this.config.targetAC,
          targetDefense: this.config.targetDefense,
          retryIfWeeklyDamageUnder1M: this.config.retryIfWeeklyDamageUnder1M,
          jobMode: this.config.jobMode,
        })
      );
    } catch (e) {
      /* localStorage 사용 불가 환경이면 조용히 무시 */
    }
  };

  Modules.deepdungeon.loadConfigIntoSelf = function () {
    try {
      const raw = localStorage.getItem(DEEPDUNGEON_CONFIG_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      Object.keys(saved).forEach((k) => {
        if (typeof saved[k] === 'number' || typeof saved[k] === 'boolean' || typeof saved[k] === 'string') {
          this.config[k] = saved[k];
        }
      });
    } catch (e) {
      /* 저장된 값이 손상됐으면 기본값 그대로 사용 */
    }
  };

  // 심층던전 탭 - 일반 던전 모듈과는 완전히 다른 화면/로직이라 설정값도 별도로
  // 관리한다 (labelEl/inputStyle/btnStyle 등 UI 헬퍼는 위에서 공용으로 이미 정의됨).
  function buildDeepDungeonTab(container) {
    const mod = Modules.deepdungeon;
    const refs = UIRefs.deepdungeon;
    mod.loadConfigIntoSelf();

    container.appendChild(labelEl('직업 (물리딜/신술 둘 다 지원)'));
    const jobSelect = document.createElement('select');
    jobSelect.style.cssText = inputStyle();
    const JOB_OPTIONS = ['물리딜', '신술', '마술'];
    JOB_OPTIONS.forEach((name) => {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      if (name === mod.config.jobMode) o.selected = true;
      jobSelect.appendChild(o);
    });
    container.appendChild(jobSelect);

    const requiredLabel = labelEl('');
    const recommendedLabel = labelEl('');
    container.appendChild(requiredLabel);
    container.appendChild(recommendedLabel);

    function renderJobDescription() {
      const profile = mod.getJobProfile();
      const targetParts = Object.entries(profile.requiredTargets).map(([name, target]) => `${name}(${target})`);
      if (profile.requiredLifePair) {
        targetParts.push(`[${profile.requiredLifePair.names.join('/')}](${profile.requiredLifePair.target}, 하나만)`);
      }
      requiredLabel.textContent = `필수 어빌(등급 무관 최우선 채용, 괄호=제단 목표 등급): ${targetParts.join(' · ')}`;
      recommendedLabel.textContent = `추천 어빌(금·칠색만 채용, 최대 ${profile.recommendedCap}개): ${profile.recommendedAbilities.join('/')}`;
    }
    renderJobDescription();

    jobSelect.addEventListener('change', (e) => {
      mod.config.jobMode = e.target.value;
      mod.saveConfig();
      renderJobDescription();
    });

    container.appendChild(labelEl('토큰 상점 방문 기준'));
    const tokenInput = document.createElement('input');
    tokenInput.type = 'number';
    tokenInput.value = mod.config.tokenShopThreshold;
    tokenInput.style.cssText = inputStyle();
    tokenInput.addEventListener('change', (e) => {
      mod.config.tokenShopThreshold = parseInt(e.target.value, 10) || 500;
      mod.saveConfig();
    });
    container.appendChild(tokenInput);

    container.appendChild(labelEl('응급 회복 HP% 기준 (이하면 휴식/상점 최우선)'));
    const emergInput = document.createElement('input');
    emergInput.type = 'number';
    emergInput.value = mod.config.emergencyHpPercent;
    emergInput.style.cssText = inputStyle();
    emergInput.addEventListener('change', (e) => {
      mod.config.emergencyHpPercent = parseInt(e.target.value, 10) || 30;
      mod.saveConfig();
    });
    container.appendChild(emergInput);

    container.appendChild(labelEl('보스 2층 전(8/18/28/38/48층) 회복 HP% 기준'));
    const bossPreInput = document.createElement('input');
    bossPreInput.type = 'number';
    bossPreInput.value = mod.config.bossPreFloorHpPercent;
    bossPreInput.style.cssText = inputStyle();
    bossPreInput.addEventListener('change', (e) => {
      mod.config.bossPreFloorHpPercent = parseInt(e.target.value, 10) || 50;
      mod.saveConfig();
    });
    container.appendChild(bossPreInput);

    container.appendChild(labelEl('목표 적중치 (0=사용 안 함)'));
    const acInput = document.createElement('input');
    acInput.type = 'number';
    acInput.value = mod.config.targetAC;
    acInput.style.cssText = inputStyle();
    acInput.addEventListener('change', (e) => {
      mod.config.targetAC = parseInt(e.target.value, 10) || 0;
      mod.saveConfig();
    });
    container.appendChild(acInput);

    container.appendChild(labelEl('목표 방어력 (0=사용 안 함, 생명 우선순위 참고용)'));
    const defInput = document.createElement('input');
    defInput.type = 'number';
    defInput.value = mod.config.targetDefense;
    defInput.style.cssText = inputStyle();
    defInput.addEventListener('change', (e) => {
      mod.config.targetDefense = parseInt(e.target.value, 10) || 0;
      mod.saveConfig();
    });
    container.appendChild(defInput);

    const retryRow = document.createElement('div');
    retryRow.style.cssText = 'display:flex; align-items:center; gap:6px; margin:6px 0 4px;';
    const retryCheck = document.createElement('input');
    retryCheck.type = 'checkbox';
    retryCheck.checked = mod.config.retryIfWeeklyDamageUnder1M;
    retryCheck.addEventListener('change', (e) => {
      mod.config.retryIfWeeklyDamageUnder1M = e.target.checked;
      mod.saveConfig();
    });
    const retryLabel = document.createElement('span');
    retryLabel.textContent = '누적 데미지 100만 이하시 재도전 ("기록" 탭의 주간 누적 데미지 기준)';
    retryLabel.style.cssText = 'font-size:11px; color:#ccc;';
    retryRow.appendChild(retryCheck);
    retryRow.appendChild(retryLabel);
    container.appendChild(retryRow);

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
    startBtn.addEventListener('click', () => Core.startModule('deepdungeon'));
    stopBtn.addEventListener('click', () => Core.requestStopModule('deepdungeon'));
    btnRow.appendChild(startBtn);
    btnRow.appendChild(stopBtn);
    container.appendChild(btnRow);
    container.appendChild(statusEl);

    const hint = document.createElement('div');
    hint.textContent =
      '※ 캐릭터 요약 화면("던전 진입" 버튼 보이는 화면)이나, 이미 층이 진행 중인 화면 어느 쪽에서 시작해도 됩니다.';
    hint.style.cssText = 'color:#888; font-size:10px; margin-top:4px;';
    container.appendChild(hint);

    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.inputs = [jobSelect, tokenInput, emergInput, bossPreInput, acInput, defInput, retryCheck];
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
    tabBar.style.cssText = 'display:flex; border-bottom:1px solid #444; flex-wrap:wrap;';
    const tabButtons = {};
    Object.keys(MODULE_LABELS).forEach((id) => {
      const tabBtn = document.createElement('button');
      tabBtn.textContent = MODULE_LABELS[id];
      tabBtn.style.cssText = 'flex:1; min-width:60px; padding:6px 0; background:#1a1a1a; color:#eee; border:none; cursor:pointer; font-size:12px;';
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
    buildDeepDungeonTab(tabContents.deepdungeon);
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
    Core.log('core', '통합 매크로 패널 로드 완료 (재전직 / 자동사냥 / 레어맵 / 던전 / 심층던전)');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();

// ==================== 독립 개인 보스 자동화 도구 ====================
// ============================================================================
// 라니스 개인 보스전 자동화 로직 - 참고용 프로토타입
// (기존 lanis_user.js 통합 매크로에는 아직 병합하지 않음. 검증 완료 후 합칠 예정)
//
// 템퍼몽키에 이 파일을 별도 스크립트로 등록하면, 보스 도전 화면에서 브라우저
// 패널에서 직업과 보스를 선택해 실행하거나, 콘솔(F12)에서 직업별
// run* 함수를 직접 호출할 수 있음.
//
// 마술은 수호자·황제·엔트 로직이 연결되어 있으며, 망령은 실전 공략이
// 확정되기 전까지 안전하게 실행을 중단하도록 되어 있음.
//
// ⚠️ 매우 중요한 안전 규칙 ⚠️
// 화면 오른쪽의 "🎯 라니스 통합 매크로" GUI 패널은 사용자가 직접 조작하는
// 영역이며, 이 보스전 스크립트는 그 패널의 어떤 버튼/요소도 절대 클릭하거나
// 검색 대상으로 삼으면 안 됨. 아래 M.queryAll 계열 함수들은 macroPanelRoot에
// 포함된 요소를 항상 제외하도록 구현되어 있음 (이 규칙을 지우지 말 것).
//
// 과거 사고 사례: "회복" 액션 확인 버튼을 찾을 때 페이지 전체에서 '시작'
// 이라는 일반 텍스트로 fallback 검색을 했다가, 매크로 패널의 "재전직" 탭
// "시작" 버튼을 잘못 클릭해 실제 재전직 자동매크로가 의도치 않게 실행된 적
// 있음. 그래서:
//   1) 모든 요소 검색은 macroPanelRoot를 제외한다 (M.queryAll)
//   2) 확인/시작 버튼은 반드시 "현재 열려있는 모달(팝업) 안"에서만 찾는다
//      (M.findConfirmInOpenDialog) - 페이지 전체에서 텍스트로 찾지 않는다
// ============================================================================

(function () {
  const M = {};
  window.__bossMacro = M;

  // ==========================================================================
  // 백그라운드(포커스 없는) 탭에서 메인 스레드 setTimeout이 크롬에 의해
  // 강제로 느려지는 문제 대응. Web Worker 안에서 타이머를 돌리면 그 영향을
  // 덜 받는다(기존 lanis_user.js의 Core._bgSleep과 동일한 패턴, 실전에서
  // 자동사냥이 백그라운드에서도 안 멈추는 걸로 이미 검증된 방식).
  //
  // 단, Worker만으로 완전히 해결되는 건 아님(다른 분석에서 지적받은 내용):
  //   - Worker는 DOM에 접근 못 하므로 클릭 자체는 결국 메인 스레드에서 해야 함
  //   - Worker 타이머가 정확히 끝나도, 그 시점에 React 렌더링이 아직 안
  //     끝나 있으면 찾는 버튼이 없을 수 있음
  //   - 그래서 "고정 시간 대기 후 한 번만 확인"이 아니라, M.waitFor로
  //     원하는 상태가 나타날 때까지 반복 확인하는 방식을 같이 써야 함
  M._workerSleepFn = (function () {
    try {
      const workerCode =
        'self.onmessage = function (e) {' +
        '  var id = e.data.id, ms = e.data.ms;' +
        '  setTimeout(function () { postMessage(id); }, ms);' +
        '};';
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      const pending = new Map(); // id -> { resolve, ms, startedAt }
      let counter = 0;
      worker.onmessage = function (e) {
        const entry = pending.get(e.data);
        if (entry) {
          pending.delete(e.data);
          entry.resolve();
        }
      };
      // 워커가 죽으면(에러) 대기 중이던 Promise들이 영원히 안 풀려서
      // 매크로가 "말없이" 영구 정지하는 심각한 문제가 있었음. 워커가
      // 죽으면 즉시 일반 setTimeout으로 전환하고, 그 시점에 이미 걸려있던
      // 모든 대기도 각자 남은 시간만큼 일반 타이머로 넘겨서 마저 풀어준다.
      worker.onerror = function () {
        M._workerDead = true;
        for (const [id, entry] of pending) {
          pending.delete(id);
          const elapsed = Date.now() - entry.startedAt;
          const remaining = Math.max(0, entry.ms - elapsed);
          setTimeout(entry.resolve, remaining);
        }
      };
      return function (ms) {
        if (M._workerDead) return new Promise((resolve) => setTimeout(resolve, ms));
        return new Promise((resolve) => {
          const id = ++counter;
          pending.set(id, { resolve, ms, startedAt: Date.now() });
          worker.postMessage({ id, ms });
        });
      };
    } catch (e) {
      return null; // 워커를 만들 수 없는 환경 - 아래에서 기존 방식으로 폴백
    }
  })();

  M.sleep = (ms) => {
    if (M._workerSleepFn && !M._workerDead) return M._workerSleepFn(ms);
    return new Promise((r) => setTimeout(r, ms));
  };
  M.rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  // 메뉴를 읽고 다음 행동을 결정하는 사람의 반응 시간을 흉내 내는 공통 대기.
  // 백그라운드에서도 Worker 타이머를 사용하므로 탭 포커스 유무와 무관하게 동작.
  M.humanPause = (min = 600, max = 1200) => M.sleep(M.rand(min, max));

  // 원하는 조건(fn이 truthy를 반환)이 나타날 때까지 반복 확인.
  // 고정 시간만 자고 한 번만 확인하는 것보다 훨씬 안정적 - 백그라운드
  // 탭에서 렌더링이 늦어져도, 실제로 준비될 때까지 계속 재확인함.
  // stopRequested가 켜지면 즉시 빠져나오게 해서 "정지" 버튼 반응성을 높인다.
  M.waitFor = async function (fn, timeoutMs = 15000, intervalMs = 300) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (M.stopRequested) return null;
      const result = fn();
      if (result) return result;
      await M.sleep(intervalMs);
    }
    return null;
  };

  // --- 매크로 패널(사용자 GUI) 격리 -----------------------------------------
  function findMacroRoot() {
    const marker = [...document.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && el.textContent.includes('라니스 통합 매크로')
    );
    let root = marker;
    let steps = 0;
    while (
      root &&
      steps < 10 &&
      !(root.textContent.includes('심층던전') && root.textContent.includes('로그'))
    ) {
      root = root.parentElement;
      steps++;
    }
    return root || null;
  }
  M.macroPanelRoot = findMacroRoot();
  M.refreshMacroRoot = () => { M.macroPanelRoot = findMacroRoot(); };
  M.inMacroPanel = (el) =>
    !!el.closest('#lrm-panel, #lrm-banner') ||
    (M.macroPanelRoot ? M.macroPanelRoot.contains(el) : false);
  M.queryAll = (selector) =>
    [...document.querySelectorAll(selector)].filter((el) => !M.inMacroPanel(el));

  M.findButtonByText = (text) =>
    M.queryAll('button').find(
      (b) => b.textContent.trim() === text || b.getAttribute('aria-label') === text
    ) || null;

  M.findLeafByExactText = (text) =>
    M.queryAll('*').find((el) => el.children.length === 0 && el.textContent.trim() === text) ||
    null;

  // 확인/시작류 버튼은 반드시 "현재 열려있는 모달" 안에서만 찾는다
  // 실제로 화면에 "보이는" 요소인지 확인 (DOM엔 남아있지만 숨겨진 모달이
  // 열린 모달로 취급되는 문제 방지)
  M.isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  M.findConfirmInOpenDialog = (candidates) => {
    const dialogs = M.queryAll('[role="dialog"], [role="presentation"]').filter(M.isVisible);
    for (const d of dialogs) {
      for (const text of candidates) {
        const btn = [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === text && M.isVisible(b));
        if (btn) return btn;
      }
    }
    return null;
  };

  // "N개 스크롤 사용" 확정 버튼처럼, 안전 규칙(확인 버튼은 반드시 열린
  // 모달 안에서만 찾는다)을 지키면서도 candidates가 정규식 패턴인 경우를
  // 위한 버전. 스크롤 확정 버튼을 페이지 전체에서 찾던 문제(실전 지적됨)를
  // 고치기 위해 추가.
  M.findConfirmByPatternInOpenDialog = (pattern) => {
    const dialogs = M.queryAll('[role="dialog"], [role="presentation"]').filter(M.isVisible);
    for (const d of dialogs) {
      const btn = [...d.querySelectorAll('button')].find((b) => pattern.test(b.textContent.trim()) && M.isVisible(b));
      if (btn) return btn;
    }
    return null;
  };

  // --- 프리셋 -----------------------------------------------------------------
  M.openPresetPanel = async () => {
    const btn = await M.waitFor(() => M.findButtonByText('프리셋 변경'));
    if (!btn) throw new Error('프리셋 변경 버튼 못찾음');
    btn.click();
    const tab = await M.waitFor(() => M.findButtonByText('프리셋'), 5000);
    if (tab) {
      tab.click();
      await M.waitFor(() => M.queryAll('*').some((el) => el.children.length === 0 && el.textContent.trim() === '이 보스 전용'), 5000);
    }
  };
  M.closePresetPanel = () => {
    const b = M.findButtonByText('프리셋 패널 닫기');
    if (b) b.click();
  };
  M.applyBossPreset = async (name) => {
    await M.openPresetPanel();
    const found = await M.waitFor(() => M.findLeafByExactText(name), 5000);
    if (!found) {
      M.closePresetPanel();
      throw new Error('프리셋 이름 못찾음: ' + name);
    }
    // 클릭 직전에 다시 찾아서 클릭 (그 사이 화면이 다시 그려졌을 수 있으므로
    // 처음 찾은 참조가 아니라 최신 요소를 클릭한다)
    await M.sleep(M.rand(150, 350));
    const fresh = M.findLeafByExactText(name);
    if (!fresh) { M.closePresetPanel(); throw new Error('프리셋 이름 못찾음(재검색 실패): ' + name); }
    fresh.click();
    // 클릭이 실제로 반영됐는지 확인 없이 바로 패널을 닫으면 적용이 누락될
    // 수 있다는 지적(실전 검증 전 반드시 고칠 항목)에 따라, 게임이 보여주는
    // "프리셋 'OO'을(를) 적용했습니다" 토스트를 짧게 기다린다. 토스트
    // 문구가 다르거나 너무 빨리 사라져 못 잡더라도(치명적이지 않음) 그냥
    // 진행한다 - 완전히 막지는 않되, 확인 시도는 반드시 한다.
    const confirmed = await M.waitFor(
      () => M.queryAll('*').some((el) => el.children.length === 0 && el.textContent.includes(`'${name}'`) && el.textContent.includes('적용')),
      2500,
      150
    );
    if (M.uiLog && !confirmed) M.uiLog(`(참고) 프리셋 "${name}" 적용 확인 토스트를 못 봤음 - 계속 진행`);
    M.closePresetPanel();
  };

  // --- 턴 진행 / 회복 / 스크롤 --------------------------------------------------
  M.clickTurn = async (n) => {
    const btn = await M.waitFor(() => M.findButtonByText(`턴 진행${n}턴`));
    if (!btn) throw new Error('턴 진행 버튼 못찾음: ' + n);
    btn.click();
    const startBtn = await M.waitFor(() => M.findConfirmInOpenDialog(['전투 시작']));
    if (!startBtn) throw new Error('전투 시작 확인 버튼(모달 내) 못찾음');
    // 클릭 직전 재검색: 모달이 그 사이 다시 그려졌을 수 있음
    await M.sleep(M.rand(100, 300));
    const freshStart = M.findConfirmInOpenDialog(['전투 시작']) || startBtn;
    freshStart.click();
    // 턴 진행 결과가 로그/HP에 반영될 시간을 기다림 (고정이지만, 이후
    // 각 단계에서 다시 waitFor로 실제 결과를 확인하므로 큰 문제 없음)
    await M.sleep(1800);
  };

  M.clickRecover = async () => {
    const btn = await M.waitFor(() => M.findButtonByText('회복2턴'));
    if (!btn) throw new Error('회복 버튼 못찾음');
    btn.click();
    const startBtn = await M.waitFor(() => M.findConfirmInOpenDialog(['회복', '전투 시작', '회복 시작']));
    if (!startBtn) throw new Error('회복 확인 버튼(모달 내) 못찾음');
    await M.sleep(M.rand(100, 300));
    const freshStart = M.findConfirmInOpenDialog(['회복', '전투 시작', '회복 시작']) || startBtn;
    freshStart.click();
    await M.sleep(1800);
  };

  M.useScrolls = async (names) => {
    const openBtn = await M.waitFor(() => M.queryAll('button').find((b) => b.textContent.trim().startsWith('전투 스크롤 사용')));
    if (!openBtn) throw new Error('전투 스크롤 사용 버튼 못찾음');
    openBtn.click();
    await M.waitFor(() => M.findLeafByExactText(`스크롤:${names[0]}`), 5000);
    // 이미 "활성" 상태로 지속 중인 스크롤을 다시 클릭하면 오히려 꺼버리게
    // 되는 문제가 실전에서 확인됨. 그래서 이미 활성인 항목은 건드리지 않고
    // 새로 켜야 하는 것만 클릭한다.
    let newlySelected = 0;
    for (const name of names) {
      const label = `스크롤:${name}`;
      const el = await M.waitFor(() => M.findLeafByExactText(label), 5000);
      if (!el) throw new Error('스크롤 옵션 못찾음: ' + label);
      const alreadyActive = el.parentElement && el.parentElement.textContent.includes('활성');
      if (alreadyActive) continue;
      el.click();
      await M.sleep(M.rand(150, 300));
      newlySelected++;
    }
    if (newlySelected === 0) {
      // 원하는 스크롤이 전부 이미 활성 상태 - 새로 쓸 필요 없으니 취소로 닫음
      const cancelBtn = M.findConfirmInOpenDialog(['취소']);
      if (cancelBtn) cancelBtn.click();
      return;
    }
    const confirmPattern = /^\d+개 스크롤 사용$/;
    const confirmBtn = await M.waitFor(() => M.findConfirmByPatternInOpenDialog(confirmPattern));
    if (!confirmBtn) throw new Error('스크롤 확정 버튼(모달 내) 못찾음');
    await M.sleep(M.rand(100, 300));
    const freshConfirm = M.findConfirmByPatternInOpenDialog(confirmPattern) || confirmBtn;
    freshConfirm.click();
    await M.sleep(800);
  };

  // --- 상태 읽기 (HP/MP, 봉인된 어빌리티) --------------------------------------
  M.getHpMpNumbers = () => {
    const hpLabels = M.queryAll('*').filter(
      (el) => el.children.length === 0 && el.textContent.trim() === 'HP'
    );
    const mpLabels = M.queryAll('*').filter(
      (el) => el.children.length === 0 && el.textContent.trim() === 'MP'
    );
    // React가 다시 그리는 찰나에 라벨이 아직 없거나 숫자 파싱이 실패하는
    // 경우가 있음(실전에서 확인 가능성 지적됨). 예외를 던지는 대신 null을
    // 반환해서, 호출부가 M.waitForValidState 같은 걸로 정상값이 나올 때까지
    // 기다릴 수 있게 한다. NaN이 섞이면 "보스가 죽었다"고 오판할 수 있어
    // 반드시 걸러야 함.
    const parse = (el) => {
      if (!el || !el.parentElement) return null;
      const t = el.parentElement.textContent.replace(/^HP|^MP/, '').trim();
      const nums = t.split('/').map((s) => parseInt(s.replace(/,/g, ''), 10));
      if (nums.length < 2 || Number.isNaN(nums[0]) || Number.isNaN(nums[1])) return null;
      return { cur: nums[0], max: nums[1] };
    };
    const playerHp = parse(hpLabels[0]);
    const playerMp = parse(mpLabels[0]);
    const bossHp = parse(hpLabels[1]);
    const bossMp = parse(mpLabels[1]);
    if (!playerHp || !playerMp || !bossHp || !bossMp) return null;
    return {
      player: { hp: playerHp, mp: playerMp },
      boss: { hp: bossHp, mp: bossMp },
    };
  };

  // getHpMpNumbers()가 null을 반환하는(화면이 막 다시 그려지는) 짧은 순간을
  // 넘겨서, 실제 유효한 값이 나올 때까지 기다린 뒤 반환한다. 모든 보스
  // 로직은 이 함수를 통해 상태를 읽어야 안전하다.
  M.getValidHpMpNumbers = async (timeoutMs = 8000) => {
    const state = await M.waitFor(() => M.getHpMpNumbers(), timeoutMs, 200);
    if (!state) throw new Error('HP/MP 값을 정상적으로 읽지 못함(화면 상태 이상)');
    return state;
  };

  // 전투 기록 로그 컨테이너 (문서 전체로 범위가 새지 않도록 상한을 둠)
  M.getLogContainer = () => {
    const marker = M.queryAll('*').find(
      (el) => el.children.length === 0 && el.textContent.trim().startsWith('전투 기록 (')
    );
    if (!marker) return null;
    let container = marker.parentElement;
    let steps = 0;
    while (container && container.textContent.length < 300 && steps < 6) {
      container = container.parentElement;
      steps++;
    }
    return container;
  };

  // 🔒 로그에서 특정 어빌리티들이 봉인되었는지 확인.
  // 쉼표로 쪼개 파싱하면 "나: 공속↓150", "보스: 적중↓200" 같은 뒤따르는
  // 상태이상 문구가 델리미터 없이 바로 붙어 나올 때 경계를 잘못 잘라내는
  // 문제가 있었음(실전 테스트에서 확인됨). 그래서 쪼개 파싱하는 대신, 한
  // 로그 항목(타임스탬프로 경계 구분) 안에서 🔒 표시 뒤 텍스트에 candidates로
  // 준 어빌리티 이름이 "포함되어 있는지"만 substring으로 검사한다.
  M.parseSealedAbilities = (candidates) => {
    const set = new Set();
    const logContainer = M.getLogContainer();
    if (!logContainer) return set;
    const tsLeaves = [...logContainer.querySelectorAll('*')].filter(
      (el) => el.children.length === 0 && /^\d+(초|분)\s*전$/.test(el.textContent.trim())
    );
    for (const leaf of tsLeaves) {
      const entryText = leaf.parentElement.textContent;
      const lockIdx = entryText.indexOf('🔒');
      if (lockIdx === -1) continue;
      const lockPart = entryText.slice(lockIdx);
      for (const name of candidates) {
        if (lockPart.includes(name)) set.add(name);
      }
    }
    return set;
  };

  // 클리어 팝업의 "확인" 버튼을 닫아준다 (모달 스코프)
  M.closeClearPopupIfAny = async () => {
    await M.sleep(500);
    const btn = M.findConfirmInOpenDialog(['확인']);
    if (btn) btn.click();
  };

  // 보스 자세(공격태세/수비태세) 판정: 지하의 망령 전용 기믹.
  // 화면에 보스 이름이 여러 번 나올 수 있어(리스트 페이지의 "이번 주 보상
  // 보스" 배지 등) 마지막(가장 안쪽) 일치 항목을 실제 보스 카드로 본다.
  // 그 다음에 오는 숫자 2개(공격력, 방어력)를 비교해서 자세를 판정한다.
  M.getBossStance = (bossLabel) => {
    const heads = M.findAllLeavesByExactText(bossLabel);
    if (!heads.length) return null;
    const heading = heads[heads.length - 1];
    const all = M.queryAll('*');
    const idx = all.indexOf(heading);
    const nums = [];
    for (let i = idx + 1; i < all.length && nums.length < 2; i++) {
      const el = all[i];
      if (el.children.length === 0) {
        const t = el.textContent.trim();
        if (/^\d+$/.test(t)) nums.push(parseInt(t, 10));
      }
    }
    if (nums.length < 2) return null;
    const [atk, def] = nums;
    return { atk, def, stance: atk > def ? '공격태세' : (def > atk ? '수비태세' : '동일') };
  };

  // getBossStance가 null을 반환하는 짧은 순간(화면이 막 다시 그려지는 때)을
  // 넘겨서 실제 값이 나올 때까지 기다린다. 망령은 1턴씩 수십 번 반복하므로
  // 이 null 안전성이 특히 중요함(실전에서 위험 지적됨).
  M.getValidBossStance = async (bossLabel, timeoutMs = 8000) => {
    const stance = await M.waitFor(() => M.getBossStance(bossLabel), timeoutMs, 200);
    if (!stance) throw new Error('보스 자세(공격력/방어력)를 정상적으로 읽지 못함(화면 상태 이상)');
    return stance;
  };

  // 보스 속성별로 사용해야 할 딜 스킬 (사용자 확정). 딜 턴 진입 전, /skill-management
  // 페이지에서 활성 스킬셋의 "항상" 슬롯 스킬을 이걸로 바꿔줘야 함 (아직 자동화 코드
  // 미완성 - 사이트 내 메뉴 클릭(캐릭>스킬)으로 이동은 SPA라 새로고침 없이 왕복 가능함을
  // 확인함. history.back()으로 원래 전투 화면 복귀 가능).
  M.ELEMENT_TO_SKILL = {
    '불': '뇌제일섬',
    '물': '뇌제일섬',
    '번개': '뇌제일섬',
    '바람': '황염참',
    '별': '차원검',
    '빛': '멸영환',
    '어둠': '뇌제일섬',
  };

  // 전투 화면에서 보스의 오늘 속성을 읽음 (보스 이름 heading 다음에 나오는
  // 스탯 3개 뒤의 속성 텍스트를 찾음). ELEMENT_TO_SKILL과 조합해서 오늘
  // 써야 할 스킬을 결정하는 데 씀.
  M.getBossElementInBattle = (bossLabel) => {
    const ELEMENTS = ['불', '물', '번개', '별', '바람', '빛', '어둠'];
    const heads = M.findAllLeavesByExactText(bossLabel);
    if (!heads.length) return null;
    const heading = heads[heads.length - 1];
    const all = M.queryAll('*');
    const idx = all.indexOf(heading);
    for (let i = idx + 1; i < all.length; i++) {
      const el = all[i];
      if (el.children.length === 0) {
        const t = el.textContent.trim();
        if (t === 'HP') break;
        if (ELEMENTS.includes(t)) return t;
      }
    }
    return null;
  };

  // 전투 화면에서, 오늘 보스 속성에 맞는 스킬로 현재 활성 스킬셋의 "항상"
  // 슬롯을 자동으로 바꿔줌. /skill-management 로 갔다가 다시 전투로 돌아옴.
  // 이 왕복은 사이트 내 메뉴 클릭(캐릭>스킬, 뒤로가기)으로만 하는 SPA 전환이라
  // 새로고침이 없고 전투 상태가 유지됨을 실전 확인함.
  M.setDealSkillForBossElement = async (bossLabel) => {
    const element = M.getBossElementInBattle(bossLabel);
    if (!element) return { changed: false, reason: '보스 속성 확인 실패' };
    const targetSkill = M.ELEMENT_TO_SKILL[element];
    if (!targetSkill) return { changed: false, reason: `속성-스킬 매핑 없음: ${element}` };

    // history.back() 후 실제로 전투화면에 정상 복귀했는지 확인 없이 바로
    // 다음 동작으로 넘어가면, 뒤로가기가 실패하거나 엉뚱한 화면으로 가도
    // 모른 채 진행하게 됨(실전 검증 전 반드시 고칠 항목으로 지적됨).
    const goBackAndConfirmBattle = async () => {
      history.back();
      const ok = await M.waitFor(() => M.isInBattleScreen(bossLabel), 6000, 200);
      if (!ok) throw new Error('스킬관리 화면에서 전투화면으로 복귀 확인 실패');
    };

    const charBtn = M.findButtonByText('캐릭');
    if (!charBtn) return { changed: false, reason: '"캐릭" 메뉴 못찾음' };
    charBtn.click();
    // 드롭다운 메뉴 항목은 <button>이 아니라 <li role="menuitem">로 렌더링됨
    // (실전 테스트에서 확인). 태그 제한 없이 텍스트로 찾는다.
    const skillItem = await M.waitFor(() => M.queryAll('*').find((el) => el.children.length === 0 && el.textContent.trim() === '스킬'));
    if (!skillItem) return { changed: false, reason: '"스킬" 메뉴 못찾음' };
    skillItem.click();
    await M.waitFor(() => M.queryAll('*').some((el) => el.children.length === 0 && el.textContent.trim() === '항상'), 5000);

    // "항상" 조건 슬롯 바로 다음에 나오는 첫 input을 그 슬롯의 스킬칸으로 본다
    const findAlwaysSkillInput = () => {
      const alwaysLeaf = M.queryAll('*').find((el) => el.children.length === 0 && el.textContent.trim() === '항상');
      if (!alwaysLeaf) return null;
      const all = M.queryAll('*');
      const idx = all.indexOf(alwaysLeaf);
      for (let i = idx + 1; i < all.length; i++) {
        if (all[i].tagName === 'INPUT') return all[i];
      }
      return null;
    };

    const input = await M.waitFor(findAlwaysSkillInput, 5000);
    if (!input) {
      await goBackAndConfirmBattle();
      return { changed: false, reason: '"항상" 스킬 입력칸 못찾음' };
    }

    if (input.value === targetSkill) {
      await goBackAndConfirmBattle();
      return { changed: false, reason: '이미 설정되어 있음', skill: targetSkill, element };
    }

    input.click();
    // "사용 가능한 스킬" 목록의 스킬명도 <button>이 아니라 <p> 텍스트라서
    // (실전 테스트에서 확인) 태그 제한 없이 텍스트로 찾아 클릭한다.
    const skillBtn = await M.waitFor(() => M.queryAll('*').find((el) => el.children.length === 0 && el.textContent.trim() === targetSkill));
    if (!skillBtn) {
      await goBackAndConfirmBattle();
      return { changed: false, reason: `스킬 목록에서 "${targetSkill}" 못찾음` };
    }
    skillBtn.click();
    await M.sleep(500);

    await goBackAndConfirmBattle();
    return { changed: true, skill: targetSkill, element };
  };

  // ==========================================================================
  // 길찾기 로직: GUI에서 어떤 화면에 있든 버튼만 누르면
  // 전투 화면인지 확인 -> 아니면 개인 보스 목록으로 이동 -> 해당 보스 카드의
  // 도전하기/계속하기/재도전 버튼을 찾아 클릭 -> 전투 진입 -> 로직 실행
  // 까지 자동으로 이어지게 함.
  // 목록 페이지로 가기 위해 풀 새로고침이 필요한 경우, localStorage에 어떤
  // 보스를 진행 중이었는지 남겨두고, 스크립트가 다시 로드되면 이어서 진행함.
  // ==========================================================================
  const BOSS_REGISTRY = {
    fallenGuardian: { label: '타락한 수호자' },
    voidEmperor: { label: '공허의 황제' },
    vineEnt: { label: '지하를 휘감은 엔트' },
    vineWraith: { label: '지하의 망령' },
  };
  // 임시 실전 테스트 옵션. true인 동안에는 카드에 "클리어"가 표시되어도
  // 자동 완료 처리하지 않고 도전/재도전 버튼을 계속 탐색한다.
  // 검증 완료 후 통합할 때 false로 되돌릴 것.
  const ALLOW_CLEARED_BOSS_TEST = false;
  // 보스 기믹(자세전환/봉인 조건 등)은 직업과 무관하게 똑같지만, 그걸
  // 공략하는 방식(프리셋 전환, 스크롤 사용 여부, 목표 수치 등)은 직업마다
  // 다름. 수호자/황제는 검술과 인술이 동일해서 함수를 공유하고, 엔트/망령은
  // 직업별로 별도 함수를 둔다. 여기 없는 직업은 아직 구현 전이라 검술
  // 함수로 폴백한다(동작 보장은 없음 - GUI에서 "준비 중"으로 안내해야 함).
  const BOSS_RUN_BY_JOB = {
    검술: {
      fallenGuardian: 'runFallenGuardian',
      voidEmperor: 'runVoidEmperor',
      vineEnt: 'runVineEntSword',
      vineWraith: 'runVineWraithSword',
    },
    인술: {
      fallenGuardian: 'runFallenGuardian',
      voidEmperor: 'runVoidEmperor',
      vineEnt: 'runVineEntNinja',
      vineWraith: 'runVineWraithNinja',
    },
    궁술: {
      fallenGuardian: 'runFallenGuardianArchery',
      voidEmperor: 'runVoidEmperorArchery',
      vineEnt: 'runVineEntArchery',
      vineWraith: 'runVineWraithArchery',
    },
    체술: {
      fallenGuardian: 'runFallenGuardianMartial',
      voidEmperor: 'runVoidEmperorMartial',
      vineEnt: 'runVineEntMartial',
      vineWraith: 'runVineWraithMartial',
    },
    마술: {
      fallenGuardian: 'runFallenGuardianMagic',
      voidEmperor: 'runVoidEmperorMagic',
      vineEnt: 'runVineEntMagic',
      vineWraith: 'runVineWraithMagic',
    },
  };
  M.getSelectedJob = () => {
    const sel = document.getElementById('lrm-boss-ref-job');
    const value = sel ? sel.value : loadSelectedJob();
    return ['검술', '인술', '궁술', '체술', '마술'].includes(value) ? value : '궁술';
  };
  M.getRunFunctionName = (key, jobOverride = null) => {
    const job = jobOverride || M.getSelectedJob();
    const table = BOSS_RUN_BY_JOB[job] || BOSS_RUN_BY_JOB['검술'];
    return table[key] || BOSS_RUN_BY_JOB['검술'][key];
  };
  const PENDING_KEY = 'lrm-boss-ref-pending';
  const QUEUE_KEY = 'lrm-boss-ref-queue';

  M.isInBattleScreen = (bossLabel) => {
    const heading = M.findLeafByExactText(bossLabel);
    const turnBtn = M.findButtonByText('턴 진행5턴');
    return !!(heading && turnBtn);
  };

  // 개인 보스 목록 페이지 상단의 "이번 주 보상 보스" 배지에도 보스 이름이
  // 뜨기 때문에, 페이지에 같은 이름 텍스트가 2번 이상 나올 수 있다(배지 1번 +
  // 실제 카드 제목 1번). findLeafByExactText는 첫 번째 일치만 반환하므로
  // 이름이 겹치는 보스(예: 지하를 휘감은 엔트)에서는 배지를 잘못 집어
  // 엉뚱한 카드/버튼으로 이어지는 문제가 실전에서 확인됨. 그래서 아래는
  // 이름이 일치하는 모든 후보를 문서 순서대로 순회하며, 실제로 도전 버튼을
  // 찾을 수 있는 후보를 사용한다.
  M.findAllLeavesByExactText = (text) =>
    M.queryAll('*').filter((el) => el.children.length === 0 && el.textContent.trim() === text);

  const BOSS_CARD_BOUNDARY_NAMES = [
    '타락한 수호자', '공허의 황제', '지하를 휘감은 엔트', '지하의 망령',
    '타락한 정화자', '허무의 황제', '지하 분쇄자 엔트',
  ];

  M.findBossCardActionButton = (bossLabel) => {
    const headings = M.findAllLeavesByExactText(bossLabel);
    const all = M.queryAll('*');
    for (const heading of headings) {
      const headingIdx = all.indexOf(heading);
      if (headingIdx === -1) continue;
      for (let i = headingIdx + 1; i < all.length; i++) {
        const el = all[i];
        if (el.tagName === 'BUTTON' && ['도전하기', '계속하기', '재도전'].includes(el.textContent.trim())) {
          return el;
        }
        if (el.children.length === 0) {
          const t = el.textContent.trim();
          // 다음 보스 카드(다른 이름)로 넘어가면 이 후보는 포기하고 다음 후보로
          if (t && t !== bossLabel && BOSS_CARD_BOUNDARY_NAMES.includes(t)) break;
        }
      }
    }
    return null;
  };

  M.isBossAlreadyCleared = (bossLabel) => {
    const headings = M.findAllLeavesByExactText(bossLabel);
    const all = M.queryAll('*');
    for (const heading of headings) {
      const headingIdx = all.indexOf(heading);
      if (headingIdx === -1) continue;
      for (let i = headingIdx + 1; i < all.length; i++) {
        const el = all[i];
        if (el.children.length !== 0) continue;
        const text = el.textContent.trim();
        if (text && text !== bossLabel && BOSS_CARD_BOUNDARY_NAMES.includes(text)) break;
        if (text === '클리어' || text === '도전 완료') return true;
        // 다른 보스의 실제 도전 버튼까지 갔다면 현재 후보 카드에는 클리어
        // 표시가 없다는 뜻이므로 다음 동명 후보를 확인한다.
        if (['도전하기', '계속하기', '재도전'].includes(text)) break;
      }
    }
    return false;
  };

  M.getBossElementFromList = (bossLabel) => {
    const elements = ['불', '물', '번개', '별', '바람', '빛', '어둠'];
    const headings = M.findAllLeavesByExactText(bossLabel);
    const all = M.queryAll('*');
    for (const heading of headings) {
      const start = all.indexOf(heading);
      if (start < 0) continue;
      for (let i = start + 1; i < all.length; i++) {
        const el = all[i];
        if (el.children.length !== 0) continue;
        const text = el.textContent.trim();
        if (text !== bossLabel && BOSS_CARD_BOUNDARY_NAMES.includes(text)) break;
        if (elements.includes(text)) return text;
      }
    }
    return null;
  };

  M.openCharacterMenuItem = async (itemText) => {
    const findVisibleItem = () => M.queryAll('[role="menuitem"], [role="option"], li, button, a')
      .find((el) => el.textContent.trim() === itemText && M.isVisible(el));

    // 직전 탐색 실패나 페이지 전환 직후에는 캐릭 메뉴가 이미 열려 있을 수
    // 있다. 이때 캐릭 버튼을 다시 누르면 메뉴를 닫아버려 "내 정보"를 못
    // 찾는 문제가 실전 진단에서 확인됐다. 열린 메뉴 항목을 먼저 사용하고,
    // 없을 때만 캐릭 버튼을 눌러 메뉴를 연다.
    let item = findVisibleItem();
    if (!item) {
      const charBtn = await M.waitFor(() => M.findButtonByText('캐릭'), 5000);
      if (!charBtn) throw new Error('"캐릭" 메뉴 버튼 못찾음');
      await M.humanPause(500, 900);
      charBtn.click();
      await M.humanPause(650, 1100);
      item = await M.waitFor(findVisibleItem, 5000);
    }
    if (!item) throw new Error(`캐릭 메뉴에서 "${itemText}" 못찾음`);
    await M.humanPause(550, 1000);
    item.click();

    // SPA 이동이 실제로 시작되기 전에 다음 단계가 현재 화면 DOM을 읽으면
    // 이전 페이지를 새 페이지로 오인할 수 있으므로 대상 경로를 확인한다.
    const expectedPath = itemText === '내 정보' ? '/status'
      : itemText === '인벤토리' ? '/inventory'
      : null;
    if (expectedPath) {
      const arrived = await M.waitFor(
        () => location.pathname.replace(/\/$/, '') === expectedPath,
        8000,
        200
      );
      if (!arrived) throw new Error(`캐릭 메뉴 "${itemText}" 이동 확인 실패`);
      await M.humanPause(700, 1300);
    }
  };

  M.getCharacterElementOnStatus = () => {
    const leaf = M.queryAll('*').find((el) =>
      el.children.length === 0 && /^속성\s*:\s*(불|물|번개|별|바람|빛|어둠)$/.test(el.textContent.trim())
    );
    if (!leaf) return null;
    const match = leaf.textContent.trim().match(/^속성\s*:\s*(.+)$/);
    return match ? match[1].trim() : null;
  };

  M.goToBossListViaMenu = async () => {
    const battleBtn = await M.waitFor(() => M.findButtonByText('전투'), 5000);
    if (!battleBtn) throw new Error('"전투" 메뉴 버튼 못찾음');
    battleBtn.click();
    const bossItem = await M.waitFor(
      () => M.queryAll('*').find((el) => el.children.length === 0 && el.textContent.trim() === '보스'),
      5000
    );
    if (!bossItem) throw new Error('전투 메뉴에서 "보스" 못찾음');
    bossItem.click();
    const arrived = await M.waitFor(
      () => location.pathname.replace(/\/$/, '') === '/personal-boss',
      8000,
      200
    );
    if (!arrived) throw new Error('개인 보스 목록 복귀 실패');
  };

  M.useElementStone = async (element) => {
    await M.openCharacterMenuItem('인벤토리');
    const consumableTab = await M.waitFor(
      () => M.queryAll('[role="tab"], button')
        .find((el) => el.textContent.trim() === '소모품' && M.isVisible(el)),
      8000
    );
    if (!consumableTab) throw new Error('인벤토리 소모품 탭 못찾음');
    await M.humanPause(600, 1100);
    consumableTab.click();
    await M.humanPause(750, 1300);

    const stoneName = `${element}의 돌`;
    let useButton = null;
    // 돌 이름에는 수량이 붙어 렌더링되고(예: "빛의 돌x14"), 소모품은
    // 여러 페이지로 나뉜다. 정확한 leaf 텍스트 검색 대신 행 단위로 찾고
    // 발견될 때까지 다음 페이지를 순회한다.
    for (let page = 1; page <= 20 && !useButton; page++) {
      const row = M.queryAll('tr').find((tr) =>
        tr.textContent.includes(stoneName) && M.isVisible(tr)
      );
      if (row) {
        useButton = [...row.querySelectorAll('button')].find((button) =>
          ['사용', '사용하기'].includes(button.textContent.trim()) && M.isVisible(button)
        ) || null;
        break;
      }
      const next = M.queryAll('button').find((button) =>
        button.getAttribute('aria-label') === 'Go to next page' &&
        !button.disabled &&
        M.isVisible(button)
      );
      if (!next) break;
      await M.humanPause(500, 900);
      next.click();
      await M.humanPause(650, 1100);
    }
    if (!useButton) throw new Error(`"${stoneName}" 사용 버튼 못찾음`);
    // 돌 이름과 수량을 확인한 뒤 사용하는 시간.
    await M.humanPause(900, 1600);
    useButton.click();

    const confirm = await M.waitFor(
      () => M.findConfirmInOpenDialog(['확인']),
      5000
    );
    if (!confirm) throw new Error(`"${stoneName}" 사용 확인 모달 못찾음`);
    await M.humanPause(700, 1200);
    confirm.click();
    await M.humanPause(1200, 1800);
  };

  // 모든 직업 공통 전처리: 보스 목록의 오늘 속성과 내 정보의 캐릭터 속성을
  // 비교하고, 다르면 인벤토리에서 해당 속성의 돌을 한 개 사용한 뒤 재검증한다.
  M.ensureElementForBoss = async (bossLabel) => {
    const startHistoryLength = history.length;
    const targetElement = M.getBossElementFromList(bossLabel);
    if (!targetElement) throw new Error(`"${bossLabel}"의 오늘 속성을 읽지 못함`);

    await M.openCharacterMenuItem('내 정보');
    let currentElement = await M.waitFor(() => M.getCharacterElementOnStatus(), 8000);
    if (!currentElement) throw new Error('내 정보에서 캐릭터 속성을 읽지 못함');
    await M.humanPause(800, 1400);

    if (currentElement !== targetElement) {
      if (M.uiLog) M.uiLog(`속성 불일치: 캐릭터=${currentElement}, 보스=${targetElement} → ${targetElement}의 돌 사용`);
      await M.useElementStone(targetElement);
      await M.openCharacterMenuItem('내 정보');
      currentElement = await M.waitFor(() => M.getCharacterElementOnStatus(), 8000);
      if (currentElement !== targetElement) {
        throw new Error(`속성 돌 사용 후 검증 실패: 캐릭터=${currentElement}, 목표=${targetElement}`);
      }
      await M.humanPause(900, 1500);
    } else if (M.uiLog) {
      M.uiLog(`속성 일치 확인: ${targetElement}`);
    }

    // 속성 확인을 시작한 보스 목록의 이력 위치로 정확히 돌아간다.
    // 상단 전투 메뉴는 페이지에 따라 메뉴 항목의 DOM 구조가 달라져 "보스"
    // 항목을 못 찾는 경우가 있었으므로, 같은 SPA 안에서 쌓인 history 길이를
    // 기준으로 우선 복귀하고 실패할 때만 메뉴 방식을 폴백으로 사용한다.
    const historyDelta = startHistoryLength - history.length;
    if (historyDelta < 0) {
      history.go(historyDelta);
      const returnedByHistory = await M.waitFor(
        () => location.pathname.replace(/\/$/, '') === '/personal-boss',
        8000,
        200
      );
      if (!returnedByHistory) await M.goToBossListViaMenu();
    } else {
      await M.goToBossListViaMenu();
    }
    await M.waitFor(() => M.findBossCardActionButton(bossLabel), 8000, 200);
    return { targetElement, currentElement };
  };

  M.enterBossBattle = async (bossLabel) => {
    // 일반/HARD 탭이 있으면 일반 탭 보장 (지금 다루는 보스는 모두 일반 모드)
    const normalTab = M.findButtonByText('일반');
    if (normalTab) {
      normalTab.click();
      await M.sleep(300);
    }
    let btn = M.findBossCardActionButton(bossLabel);
    if (!btn) throw new Error(`"${bossLabel}" 카드에서 도전 버튼을 못찾음 (목록 페이지가 맞는지 확인 필요)`);
    let btnText = btn.textContent.trim();
    btn.click();
    await M.sleep(500);

    // 다른 보스 도전이 진행 중이면 새 보스를 누른 직후 "도전 포기" 확인창이
    // 먼저 뜬다. 이 창을 대상 보스의 재도전 확인창으로 오인하면 목록에 남은
    // 채 진입 실패를 반복한다. 큐에서 명시적으로 선택한 다음 보스로 넘어가기
    // 위해 기존 도전을 포기하고, 목록 렌더링 후 대상 카드 버튼을 다시 누른다.
    const abandonConfirm = M.findConfirmInOpenDialog(['포기', '포기하기']);
    if (abandonConfirm) {
      abandonConfirm.click();
      const returned = await M.waitFor(
        () => location.pathname.replace(/\/$/, '') === '/personal-boss',
        8000,
        200
      );
      if (!returned) throw new Error('기존 보스 포기 후 목록 복귀 실패');
      btn = await M.waitFor(() => M.findBossCardActionButton(bossLabel), 8000, 200);
      if (!btn) throw new Error(`기존 도전 포기 후 "${bossLabel}" 도전 버튼을 못찾음`);
      btnText = btn.textContent.trim();
      btn.click();
      await M.sleep(500);
    }

    if (btnText === '도전하기') {
      const confirmBtn = M.findConfirmInOpenDialog(['도전', '확인']);
      if (confirmBtn) {
        confirmBtn.click();
        await M.sleep(1200);
      }
    } else if (btnText === '재도전') {
      const confirmBtn = M.findConfirmInOpenDialog(['재도전', '도전', '확인']);
      if (confirmBtn) {
        confirmBtn.click();
        await M.sleep(1200);
      }
    } else {
      await M.sleep(800); // 계속하기는 보통 바로 진입
    }
  };

  M.abandonCurrentBossAttempt = async () => {
    const candidates = ['도전 포기', '전투 포기', '포기하기', '포기'];
    const button = await M.waitFor(
      () => candidates.map((text) => M.findButtonByText(text)).find(Boolean),
      5000
    );
    if (!button) throw new Error('현재 보스 도전의 포기 버튼을 못찾음');
    button.click();
    const confirm = await M.waitFor(
      () => M.findConfirmInOpenDialog(['포기', '포기하기', '확인']),
      5000
    );
    if (!confirm) throw new Error('도전 포기 확인 모달의 "포기" 버튼을 못찾음');
    confirm.click();
    const returned = await M.waitFor(
      () => location.pathname.replace(/\/$/, '') === '/personal-boss',
      8000,
      200
    );
    if (!returned) throw new Error('보스 포기 후 목록 복귀 실패');
    return true;
  };

  M.isRunning = false;

  // 반환값: 'redirecting' | { entered: boolean, cleared: boolean }
  //   - entered=false: 카드를 못 찾는 등 애초에 전투 진입 자체를 못함
  //   - entered=true, cleared=true: 실제로 보스 HP 0을 확인하고 처치 완료
  //   - entered=true, cleared=false: 진입은 했지만 실제 처치 실패(최대 시도
  //     횟수 도달 등) - 순수히 "전투화면을 벗어났는지"만으로 성공을 판단하면
  //     스킬화면 오류·페이지 이동 등으로 어쩌다 전투화면을 벗어난 것도
  //     성공으로 오판할 수 있어(실전 지적됨), 반드시 보스 함수 자신이 보고한
  //     cleared 값을 근거로 삼는다.
  M.driveToBossAndRun = async (key, jobOverride = null) => {
    const entry = BOSS_REGISTRY[key];
    if (!entry) return { entered: false, cleared: false };
    const runName = M.getRunFunctionName(key, jobOverride);

    if (M.isRunning) {
      if (M.uiLog) M.uiLog(`⛔ 이미 다른 작업이 실행 중이라 "${entry.label}" 요청을 무시함`);
      localStorage.removeItem(PENDING_KEY);
      return { entered: false, cleared: false };
    }
    M.isRunning = true;

    const runAndReport = async () => {
      try {
        const result = await M[runName]();
        return {
          entered: true,
          cleared: !!(result && result.cleared),
          retryRequired: !!(result && result.retryRequired),
        };
      } catch (e) {
        // 전투 로직 실행 도중 에러(모달 타이밍 등)가 나도 여기서 삼켜서
        // 큐 전체가 중단되지 않게 한다.
        if (M.uiLog) M.uiLog(`⚠ "${entry.label}" 전투 중 오류: ${e.message}`);
        return { entered: true, cleared: false };
      }
    };

    try {
      if (M.isInBattleScreen(entry.label)) {
        localStorage.removeItem(PENDING_KEY);
        if (M.uiLog) M.uiLog(`✅ 이미 "${entry.label}" 전투 화면, 바로 시작 (${jobOverride || M.getSelectedJob()})`);
        return await runAndReport();
      }

      // "목록 페이지에 있다"는 판정은 .includes()가 아니라 정확한 경로 일치로
      // 해야 함 - /personal-boss/<battleId> 같은 개별 전투 화면 URL도
      // .includes('/personal-boss')가 true라서, 큐로 여러 보스를 연속 처리할 때
      // 방금 클리어한 보스의 전투 URL에 그대로 남아있는 상태를 "목록 페이지"로
      // 착각해 다음 보스 카드를 못 찾는 버그가 실전에서 확인됨(황제 클리어 후
      // 엔트 진입 실패). 정확히 목록 경로일 때만 카드 탐색을 시도한다.
      const path = location.pathname.replace(/\/$/, '');
      if (path === '/personal-boss') {
        // 직전에 다른 보스를 막 클리어하고 목록으로 돌아온 직후일 수 있어
        // SPA가 목록을 완전히 다시 그릴 시간을 살짝 준다 (실전에서, 클리어
        // 직후 바로 다음 카드를 찾으면 못 찾는 경우가 확인됨).
        await M.sleep(800);
        try {
          if (M.uiLog) M.uiLog(`🔎 "${entry.label}" 속성 확인 중...`);
          await M.ensureElementForBoss(entry.label);
          if (!ALLOW_CLEARED_BOSS_TEST && M.isBossAlreadyCleared(entry.label)) {
            localStorage.removeItem(PENDING_KEY);
            if (M.uiLog) M.uiLog(`⏭ "${entry.label}"은(는) 이미 클리어됨 - 완료 처리`);
            return { entered: true, cleared: true, alreadyCleared: true };
          }
          if (M.uiLog) M.uiLog(`🧭 "${entry.label}" 카드 찾는 중...`);
          await M.enterBossBattle(entry.label);
          await M.sleep(500);
          if (M.isInBattleScreen(entry.label)) {
            localStorage.removeItem(PENDING_KEY);
            return await runAndReport();
          }
          if (M.uiLog) M.uiLog('⚠ 전투 화면 진입 확인 실패. 버튼을 다시 눌러줘.');
        } catch (e) {
          if (M.uiLog) M.uiLog('⚠ ' + e.message);
        }
        return { entered: false, cleared: false };
      }

      // 개인 보스 목록 페이지가 아니면 이동 (풀 새로고침 발생 가능 - pending 값으로 재개됨)
      if (M.uiLog) M.uiLog('➡ 개인 보스 목록으로 이동 중...');
      location.href = 'https://lanis.me/personal-boss';
      // location.href 대입은 "즉시" 페이지를 끊지 않는다 - 실제 브라우저가
      // 이동을 처리하기까지 짧은 시차가 있어서, 이 대입 직후 바로 false를
      // 반환하면 continueBossQueue가 "아직도 전투화면 아니네 → 실패"로
      // 착각해 3연속 실패를 순식간에(새로고침도 되기 전에) 만들어버리는
      // 버그가 실전에서 확인됨(캐릭터 요약 페이지에서 도전 눌렀을 때 재현).
      // 그래서 실패와 구분되는 별도 값('redirecting')을 반환하고, 실제
      // 이동이 일어날 시간을 좀 더 기다린다(안 넘어가도 아래에서 그냥
      // redirecting을 반환하고 끝 - 다음 재개 때 이어짐).
      await M.sleep(3000);
      return 'redirecting';
    } finally {
      M.isRunning = false;
    }
  };

  // ==========================================================================
  // 백그라운드(포커스 없는) 탭 타이머 스로틀링 방지.
  // 크롬은 화면에 안 보이는 탭의 setTimeout을 강제로 느리게 만드는데,
  // 실전에서 매크로 실행 중 탭이 백그라운드로 가면 턴 진행이 눈에 띄게
  // 느려지거나 멈춘 것처럼 보이는 문제가 확인됨. 오디오를 재생 중인 탭은
  // 크롬이 스로틀링을 덜 하므로, 거의 무음(거의 0 볼륨)인 오디오를 매크로
  // 실행 동안 계속 틀어둬서 우회한다. 버튼 클릭(사용자 제스처) 직후에
  // 호출해야 오디오 자동재생 정책에 안 걸림.
  // ==========================================================================
  M.antiThrottle = {
    ctx: null,
    osc: null,
    start() {
      if (this.ctx) return;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.002; // 완전 무음은 크롬 스로틀링 면제 대상이 아님(공식 확인)
        // 사용자 청취 테스트: 0.002는 안 들리고 0.003부터 미세하게 들림.
        // 거슬리지 않는 걸 우선해 0.002로 설정(사용자 요청) - 사람 귀엔 안
        // 들려도 신호 자체는 0이 아니라서 크롬이 "재생 중"으로 인식할 수도
        // 있지만, 인식 못 할 위험도 0.01보다 커짐. 실전에서 스로틀링 방지
        // 효과가 없는 것 같으면 이 값을 다시 올려야 함.
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        this.ctx = ctx;
        this.osc = osc;
      } catch (e) {
        // 오디오 컨텍스트 생성 실패해도 매크로 자체는 계속 진행되게 조용히 무시
      }
    },
    stop() {
      try { if (this.osc) this.osc.stop(); } catch (e) {}
      try { if (this.ctx) this.ctx.close(); } catch (e) {}
      this.ctx = null;
      this.osc = null;
    },
  };

  // 백그라운드 실행 자가진단.
  // 게임 버튼이나 전투 상태는 전혀 건드리지 않고, 매크로가 실제로 사용하는
  // Worker 기반 M.sleep과 브라우저 기본 setTimeout의 60초 지연만 비교한다.
  // 진단 중 다른 탭으로 전환했다가 돌아오면 visibilitychange 기록도 함께 남아
  // 실제로 백그라운드 상태였는지 확인할 수 있다.
  M.runBackgroundDiagnostic = async (durationMs = 60000) => {
    if (M.backgroundDiagnosticRunning) {
      if (M.uiLog) M.uiLog('⚠ 백그라운드 진단이 이미 실행 중');
      return null;
    }

    M.backgroundDiagnosticRunning = true;
    const startedAt = Date.now();
    const visibilityEvents = [{
      elapsed: 0,
      state: document.visibilityState,
    }];
    let nativeElapsed = null;
    let workerElapsed = null;

    const onVisibilityChange = () => {
      const elapsed = Date.now() - startedAt;
      visibilityEvents.push({ elapsed, state: document.visibilityState });
      if (M.uiLog) {
        M.uiLog(`[백그라운드 진단] ${Math.round(elapsed / 1000)}초: 탭 상태=${document.visibilityState}`);
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    if (M.uiLog) {
      M.uiLog(`=== 백그라운드 진단 시작 (${Math.round(durationMs / 1000)}초) ===`);
      M.uiLog('지금 다른 탭으로 전환하고, 60초 이상 지난 뒤 돌아오세요.');
    }

    const nativeTimer = new Promise((resolve) => {
      setTimeout(() => {
        nativeElapsed = Date.now() - startedAt;
        resolve();
      }, durationMs);
    });

    try {
      await M.sleep(durationMs);
      workerElapsed = Date.now() - startedAt;

      // Worker 타이머가 끝났는데 일반 타이머 콜백이 아직 실행되지 않았다면
      // 최대 30초만 더 기다린다. 이 추가 대기도 Worker 기반이라 기본 타이머가
      // 얼마나 심하게 밀렸는지 안전하게 판정할 수 있다.
      if (nativeElapsed === null) {
        await Promise.race([nativeTimer, M.sleep(30000)]);
      }

      const hiddenObserved = visibilityEvents.some((event) => event.state === 'hidden');
      const result = {
        durationMs,
        workerElapsed,
        nativeElapsed,
        workerDelay: workerElapsed - durationMs,
        nativeDelay: nativeElapsed === null ? null : nativeElapsed - durationMs,
        hiddenObserved,
        visibilityEvents,
        workerDead: !!M._workerDead,
      };

      if (M.uiLog) {
        M.uiLog(`[백그라운드 진단] Worker: ${workerElapsed}ms (지연 ${result.workerDelay}ms)`);
        M.uiLog(
          nativeElapsed === null
            ? '[백그라운드 진단] 기본 타이머: Worker 완료 후 30초 안에도 실행되지 않음'
            : `[백그라운드 진단] 기본 타이머: ${nativeElapsed}ms (지연 ${result.nativeDelay}ms)`
        );
        M.uiLog(`[백그라운드 진단] hidden 감지=${hiddenObserved ? '예' : '아니오'}, Worker 오류=${result.workerDead ? '예' : '아니오'}`);
        M.uiLog(hiddenObserved && !result.workerDead && result.workerDelay < 5000
          ? '✅ 백그라운드 Worker 타이머 정상'
          : '⚠ 백그라운드 실행 조건을 충족하지 못했거나 지연이 큼');
        M.uiLog('=== 백그라운드 진단 종료 ===');
      }
      return result;
    } finally {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      M.backgroundDiagnosticRunning = false;
    }
  };

  M.startBossRun = async (key) => {
    if (M.isRunning) {
      if (M.uiLog) M.uiLog('⛔ 이미 실행 중이라 새 요청을 무시함');
      return;
    }
    M.antiThrottle.start();
    localStorage.setItem(PENDING_KEY, key);
    try {
      await M.driveToBossAndRun(key);
    } finally {
      M.antiThrottle.stop();
    }
  };

  // 약한 순서 (BOSS_REGISTRY 등록 순서와 동일)
  const BOSS_ORDER = ['fallenGuardian', 'voidEmperor', 'vineEnt', 'vineWraith'];

  // 선택한 보스들을 약한 순서대로 정렬해 큐에 저장하고 시작
  M.startBossQueue = async (selectedKeys) => {
    if (M.isRunning) {
      if (M.uiLog) M.uiLog('⛔ 이미 실행 중이라 새 요청을 무시함');
      return;
    }
    M.antiThrottle.start();
    const remaining = BOSS_ORDER.filter((k) => selectedKeys.includes(k));
    const q = {
      remaining,
      attempts: 0,
      entryFailStreak: 0,
      failedLabels: [],
      job: M.getSelectedJob(),
    };
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    try {
      await M.continueBossQueue();
    } finally {
      M.antiThrottle.stop();
    }
  };

  // 큐를 이어서 진행. 새로고침이 일어나도(예: 목록 페이지 이동) localStorage에
  // 남은 큐가 있으면 resumePendingIfAny가 이 함수를 다시 호출해 이어감.
  M.continueBossQueue = async () => {
    let raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return;

    while (true) {
      raw = localStorage.getItem(QUEUE_KEY);
      if (!raw) return;
      const q = JSON.parse(raw);
      if (q.attempts === undefined) q.attempts = 0;
      if (q.entryFailStreak === undefined) q.entryFailStreak = 0;
      if (M.stopRequested || q.remaining.length === 0) break;

      const key = q.remaining[0];
      const entry = BOSS_REGISTRY[key];
      if (M.uiLog) M.uiLog(`▶▶ [큐] "${entry.label}" 도전 시작 (남은 ${q.remaining.length}개)`);

      const result = await M.driveToBossAndRun(key, q.job || M.getSelectedJob());

      // 페이지 이동이 예약된 경우: 실패로 세지 않고, 큐도 그대로 둔 채
      // 조용히 종료한다 (실제 새로고침이 일어나면 resumePendingIfAny가
      // 이어서 처리하고, 혹시 이동이 안 일어났어도 다음에 다시 시도할 수
      // 있게 remaining을 그대로 남겨둔다). 이걸 실패로 세면, 새로고침이
      // 채 일어나기도 전에 3연속 실패로 오판되는 버그가 있었음.
      if (result === 'redirecting') {
        if (M.uiLog) M.uiLog('⏸ 페이지 이동 대기 중 (새로고침 후 자동으로 이어짐)');
        return;
      }

      const raw2 = localStorage.getItem(QUEUE_KEY);
      if (!raw2) return; // 그 사이 정지 등으로 큐가 지워졌으면 종료
      const q2 = JSON.parse(raw2);
      if (q2.attempts === undefined) q2.attempts = 0;
      if (q2.entryFailStreak === undefined) q2.entryFailStreak = 0;

      if (result.retryRequired) {
        q2.attempts++;
        if (q2.attempts >= 3) {
          localStorage.removeItem(QUEUE_KEY);
          if (M.uiLog) M.uiLog(`🛑 "${entry.label}" 첫 사이클 전환 3회 실패 - 큐 중단`);
          return;
        }
        try {
          if (M.uiLog) M.uiLog(`↻ "${entry.label}" 도전 포기 후 재진입 (${q2.attempts}/3)`);
          await M.abandonCurrentBossAttempt();
          localStorage.setItem(QUEUE_KEY, JSON.stringify(q2));
          continue;
        } catch (e) {
          localStorage.removeItem(QUEUE_KEY);
          if (M.uiLog) M.uiLog('🛑 자동 재도전 준비 실패: ' + e.message);
          return;
        }
      }

      // "진입 자체를 못한 것"과 "진입해서 공략했지만 실패한 것"은 서로
      // 다른 문제라서 구분해야 한다는 지적에 따라 분리함:
      //   - 진입 자체 실패(카드/버튼을 못 찾는 등 구조적 문제) → 별도
      //     카운터로 세고, 반복되면 "진입 자체가 안 된다"는 걸 명확히
      //     알리고 즉시 중단한다.
      //   - 진입은 했지만 실제 공략에 실패(최대 시도 도달 등) → "같은
      //     보스"를 최대 3번까지 재시도하고, 그래도 안 되면 설정/전략을
      //     점검하라는 의미로 알리고 중단한다. (사용자가 원래 의도한 "3회
      //     연속 실패"는 이 경우를 말한 것)
      if (!result.entered) {
        q2.entryFailStreak++;
        if (M.uiLog) M.uiLog(`⚠ [큐] "${entry.label}" 전투 진입 자체 실패 (${q2.entryFailStreak}/3) - 시도조차 못 함`);
        if (q2.entryFailStreak >= 3) {
          localStorage.removeItem(QUEUE_KEY);
          if (M.uiLog) M.uiLog('🛑 진입 자체가 계속 실패 - 큐 중단');
          alert(`⚠ "${entry.label}" 전투 화면 진입에 3회 연속 실패했습니다(카드/버튼을 못 찾음).\n공략 시도조차 못 한 상태입니다. 페이지 상태나 보스 목록을 확인해주세요.`);
          return;
        }
        localStorage.setItem(QUEUE_KEY, JSON.stringify(q2));
        await M.sleep(1500);
        continue; // 같은 보스로 재시도 (remaining은 그대로)
      }

      // 여기부터는 진입은 확실히 함 (entryFailStreak 리셋)
      q2.entryFailStreak = 0;

      if (result.cleared) {
        if (M.uiLog) M.uiLog(`✅ [큐] "${entry.label}" 완료`);
        q2.attempts = 0;
        q2.remaining.shift();
        localStorage.setItem(QUEUE_KEY, JSON.stringify(q2));
        continue;
      }

      // 진입해서 실제로 공략까지 했는데 처치 실패 (최대 시도 도달 등)
      q2.attempts++;
      if (!q2.failedLabels.includes(entry.label)) q2.failedLabels.push(entry.label);
      if (M.uiLog) M.uiLog(`⛔ [큐] "${entry.label}" 공략 실패 (같은 보스 연속 ${q2.attempts}/3회)`);
      if (q2.attempts >= 3) {
        localStorage.removeItem(QUEUE_KEY);
        if (M.uiLog) M.uiLog(`🛑 "${entry.label}" 3회 연속 공략 실패 - 큐 중단`);
        alert(`⚠ "${entry.label}" 공략에 3회 연속 실패했습니다.\n설정(프리셋/스킬 등)이나 공략 로직을 점검해주세요. 큐를 중단합니다.`);
        return;
      }
      localStorage.setItem(QUEUE_KEY, JSON.stringify(q2));
      // remaining은 그대로 둬서 같은 보스를 다시 시도함
    }

    const finalRaw = localStorage.getItem(QUEUE_KEY);
    const failedLabels = finalRaw ? JSON.parse(finalRaw).failedLabels : [];
    localStorage.removeItem(QUEUE_KEY);
    if (M.uiLog) M.uiLog('=== 보스 큐 종료 ===');
    if (failedLabels.length > 0) {
      // 실패가 하나라도 있었으면 팝업으로 알림 (사용자 요청)
      alert(`일부 보스는 재시도 끝에 처치했지만 중간에 실패가 있었습니다: ${failedLabels.join(', ')}\n로그를 확인해주세요.`);
    } else if (!M.stopRequested) {
      // 전부 성공은 alert()로 방해하지 않고 로그에만 남김
      // (alert는 브라우저 네이티브 모달이라 다음 자동화까지 막아버릴 수 있음)
      if (M.uiLog) M.uiLog('🎉 선택한 보스를 모두 처치했습니다!');
    }
  };

  // ==========================================================================
  // 간이 GUI 패널 (참고용 - 기존 "🎯 라니스 통합 매크로" 패널과는 완전히 별개)
  // 오른쪽 위에 작은 창으로 떠서 시작/정지 버튼과 로그를 보여줌.
  // "항상 위로" 핀 옵션으로 다른 요소에 가려지지 않게 z-index를 최상단으로 고정.
  // ==========================================================================
  M.stopRequested = false;

  const POS_KEY = 'lrm-boss-ref-pos';
  const PIN_KEY = 'lrm-boss-ref-pinned';
  const JOB_KEY = 'lrm-boss-ref-job';
  const BOSS_SELECTION_KEY = 'lrm-boss-ref-selected-bosses';

  function loadPos() {
    try { return JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { return null; }
  }
  function savePos(pos) {
    try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (e) {}
  }
  function loadPinned() {
    const v = localStorage.getItem(PIN_KEY);
    return v === null ? true : v === '1'; // 기본값: 항상 위로 켜짐
  }
  function savePinned(v) {
    try { localStorage.setItem(PIN_KEY, v ? '1' : '0'); } catch (e) {}
  }
  function loadSelectedJob() {
    try {
      const value = localStorage.getItem(JOB_KEY);
      return ['검술', '인술', '궁술', '체술', '마술'].includes(value) ? value : '궁술';
    } catch (e) {
      return '궁술';
    }
  }
  function saveSelectedJob(value) {
    try { localStorage.setItem(JOB_KEY, value); } catch (e) {}
  }
  function loadSelectedBosses() {
    try {
      const parsed = JSON.parse(localStorage.getItem(BOSS_SELECTION_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }
  function saveSelectedBosses(values) {
    try { localStorage.setItem(BOSS_SELECTION_KEY, JSON.stringify(values)); } catch (e) {}
  }

  function buildPanel() {
    if (document.getElementById('lrm-boss-ref-panel')) return; // 중복 생성 방지

    let pinned = loadPinned();
    const savedPos = loadPos();

    const panel = document.createElement('div');
    panel.id = 'lrm-boss-ref-panel';
    panel.style.cssText = `
      position: fixed; top: ${savedPos ? savedPos.top : 80}px;
      ${savedPos ? `left: ${savedPos.left}px;` : 'right: 20px;'}
      width: 280px;
      background: #1a1a1a; color: #eee; border: 1px solid #555;
      border-radius: 8px; font-size: 13px;
      z-index: ${pinned ? 2147483647 : 999999};
      font-family: sans-serif; box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    `;
    panel.innerHTML = `
      <div id="lrm-boss-ref-header" style="padding:8px 10px; background:#2a2a2a; border-radius:8px 8px 0 0; cursor:move; font-weight:bold; display:flex; align-items:center; justify-content:space-between;">
        <span>🗡 보스 자동화 (참고용)</span>
        <label style="font-weight:normal; font-size:11px; display:flex; align-items:center; gap:4px; cursor:pointer;">
          <input type="checkbox" id="lrm-boss-ref-pin" ${pinned ? 'checked' : ''} style="cursor:pointer;">
          📌 항상 위로
        </label>
      </div>
      <div style="padding:10px;">
        <div style="font-size:11px; color:#999; margin-bottom:2px;">직업 (검술·인술·궁술·체술·마술 지원)</div>
        <select id="lrm-boss-ref-job" style="width:100%; margin-bottom:10px; padding:5px; background:#111; color:#eee; border:1px solid #555; border-radius:4px; cursor:pointer;">
          <option value="검술">검술</option>
          <option value="인술">인술</option>
          <option value="궁술">궁술</option>
          <option value="체술">체술</option>
          <option value="마술">마술</option>
        </select>

        <div style="font-size:11px; color:#999; margin-bottom:4px;">보스 선택 (약한 순으로 자동 정렬해서 도전)</div>
        <label style="display:flex; align-items:center; gap:6px; margin-bottom:4px; cursor:pointer;">
          <input type="checkbox" class="lrm-boss-check" value="fallenGuardian" style="width:16px; height:16px; cursor:pointer;"> 타락한 수호자
        </label>
        <label style="display:flex; align-items:center; gap:6px; margin-bottom:4px; cursor:pointer;">
          <input type="checkbox" class="lrm-boss-check" value="voidEmperor" style="width:16px; height:16px; cursor:pointer;"> 공허의 황제
        </label>
        <label style="display:flex; align-items:center; gap:6px; margin-bottom:4px; cursor:pointer;">
          <input type="checkbox" class="lrm-boss-check" value="vineEnt" style="width:16px; height:16px; cursor:pointer;"> 지하를 휘감은 엔트
        </label>
        <label style="display:flex; align-items:center; gap:6px; margin-bottom:8px; cursor:pointer;">
          <input type="checkbox" class="lrm-boss-check" value="vineWraith" style="width:16px; height:16px; cursor:pointer;"> 지하의 망령
        </label>

        <button id="lrm-boss-ref-run-queue" style="width:100%; margin-bottom:6px; padding:6px; background:#2e7d32; color:#fff; border:none; border-radius:4px; cursor:pointer;">보스 도전</button>
        <button id="lrm-boss-ref-bg-test" style="width:100%; margin-bottom:6px; padding:6px; background:#1565c0; color:#fff; border:none; border-radius:4px; cursor:pointer;">백그라운드 진단 (60초)</button>
        <button id="lrm-boss-ref-stop" style="width:100%; margin-bottom:6px; padding:6px; background:#c62828; color:#fff; border:none; border-radius:4px; cursor:pointer;">정지</button>
        <div style="font-size:11px; color:#999; margin-bottom:4px;">로그</div>
        <div id="lrm-boss-ref-log" style="height:160px; overflow-y:auto; background:#000; padding:6px; border-radius:4px; white-space:pre-wrap; font-size:11px; line-height:1.4;"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // 마지막으로 선택한 직업과 보스 체크 상태는 실행 큐와 별도로 영구 저장한다.
    // 새로고침이나 보스 화면 이동으로 스크립트가 다시 로드돼도 그대로 복원됨.
    const jobSelect = panel.querySelector('#lrm-boss-ref-job');
    jobSelect.value = loadSelectedJob();
    jobSelect.addEventListener('change', (e) => saveSelectedJob(e.target.value));

    const savedBosses = new Set(loadSelectedBosses());
    panel.querySelectorAll('.lrm-boss-check').forEach((checkbox) => {
      checkbox.checked = savedBosses.has(checkbox.value);
      checkbox.addEventListener('change', () => {
        const checkedValues = [...panel.querySelectorAll('.lrm-boss-check:checked')]
          .map((item) => item.value);
        saveSelectedBosses(checkedValues);
      });
    });

    // 항상 위로(핀) 토글: 켜져 있으면 z-index를 최대값으로 고정해 다른 요소에 가려지지 않게 함
    panel.querySelector('#lrm-boss-ref-pin').addEventListener('change', (e) => {
      pinned = e.target.checked;
      panel.style.zIndex = pinned ? '2147483647' : '999999';
      savePinned(pinned);
    });

    // 드래그 이동 (위치는 localStorage에 저장해 새로고침/재접속해도 유지)
    const header = panel.querySelector('#lrm-boss-ref-header');
    let dragging = false, offsetX = 0, offsetY = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('label')) return; // 체크박스 클릭은 드래그로 취급 안 함
      dragging = true;
      offsetX = e.clientX - panel.offsetLeft;
      offsetY = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const left = e.clientX - offsetX;
      const top = e.clientY - offsetY;
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      savePos({ left: panel.offsetLeft, top: panel.offsetTop });
    });

    const logEl = panel.querySelector('#lrm-boss-ref-log');
    M.uiLog = (line) => {
      const div = document.createElement('div');
      div.textContent = line;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    };

    const setRunningState = (running) => {
      panel.querySelector('#lrm-boss-ref-run-queue').disabled = running;
      panel.querySelectorAll('.lrm-boss-check').forEach((c) => { c.disabled = running; });
    };

    panel.querySelector('#lrm-boss-ref-run-queue').addEventListener('click', async () => {
      const checked = [...panel.querySelectorAll('.lrm-boss-check:checked')].map((c) => c.value);
      if (checked.length === 0) {
        M.uiLog('⚠ 선택된 보스가 없음');
        return;
      }
      M.stopRequested = false;
      setRunningState(true);
      M.uiLog(`▶ 보스 도전 시작 (선택: ${checked.length}개)`);
      try {
        await M.startBossQueue(checked);
      } catch (e) {
        M.uiLog('⚠ 오류: ' + e.message);
      }
      setRunningState(false);
    });

    panel.querySelector('#lrm-boss-ref-bg-test').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await M.runBackgroundDiagnostic(60000);
      } catch (err) {
        M.uiLog('⚠ 백그라운드 진단 오류: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    });

    panel.querySelector('#lrm-boss-ref-stop').addEventListener('click', () => {
      M.stopRequested = true;
      localStorage.removeItem(PENDING_KEY);
      localStorage.removeItem(QUEUE_KEY);
      M.antiThrottle.stop();
      M.uiLog('■ 정지 요청됨 (다음 턴 진행 전에 멈춤, 큐/재개 예약도 취소)');
    });
  }

  buildPanel();

  // 새로고침/재접속으로 스크립트가 다시 로드된 경우, 진행 중이던 요청이 있으면 자동으로 이어감
  (function resumePendingIfAny() {
    const queueRaw = localStorage.getItem(QUEUE_KEY);
    if (queueRaw) {
      setTimeout(() => {
        if (M.uiLog) M.uiLog('⏳ 보스 큐 이어서 진행');
        // 새로고침 직후라 사용자 제스처가 없어 오디오 자동재생이 막힐 수도
        // 있지만(브라우저 정책), 안 되면 조용히 무시되고 매크로는 계속 진행됨.
        M.antiThrottle.start();
        M.continueBossQueue()
          .catch((e) => { if (M.uiLog) M.uiLog('⚠ ' + e.message); })
          .finally(() => M.antiThrottle.stop());
      }, 1200);
      return;
    }
    const pending = localStorage.getItem(PENDING_KEY);
    if (pending && BOSS_REGISTRY[pending]) {
      setTimeout(() => {
        if (M.uiLog) M.uiLog(`⏳ 이전 요청 이어서 진행: ${BOSS_REGISTRY[pending].label}`);
        M.antiThrottle.start();
        M.driveToBossAndRun(pending)
          .catch((e) => { if (M.uiLog) M.uiLog('⚠ ' + e.message); })
          .finally(() => M.antiThrottle.stop());
      }, 1200); // 페이지가 완전히 로드될 시간을 조금 줌
    }
  })();

  // ==========================================================================
  // 보스별 공략 로직
  // ==========================================================================

  // --- 타락한 수호자 (검술 잡, 일반) -------------------------------------------
  // 1) 봉인 프리셋으로 "불굴"+"엔드 블로킹" 봉인될 때까지 5턴씩 반복
  // 2) 마나 프리셋으로 보스 마나 0 될 때까지 10턴씩 반복
  // 3) 딜 프리셋 + 공격/집중 스크롤로 5턴씩 반복해 처치
  M.runFallenGuardian = async ({
    requiredSeals = ['불굴', '엔드 블로킹'],
    maxSealRounds = 15,
    maxManaRounds = 20, // 10턴씩이라 실제 최대 200턴
    maxDealRounds = 30,
    hpThreshold = 0.5,
  } = {}) => {
    const log = [];
    const push = (line) => { log.push(line); if (M.uiLog) M.uiLog(line); };
    const stopped = () => {
      if (M.stopRequested) { push('■ 사용자 요청으로 정지'); return true; }
      return false;
    };
    const recoverUntilSafe = async () => {
      for (let i = 0; i < 10; i++) {
        const state = await M.getValidHpMpNumbers();
        const ratio = state.player.hp.cur / state.player.hp.max;
        if (ratio > hpThreshold) return;
        await M.clickRecover();
        push(`내HP ${Math.round(ratio * 100)}% -> 회복`);
      }
      throw new Error('수호자: 10회 회복 후에도 HP 50% 초과 실패');
    };

    await M.applyBossPreset('봉인');
    push('[1단계] 봉인 프리셋 적용');
    let sealed = M.parseSealedAbilities(requiredSeals);
    let r = 0;
    while (!requiredSeals.every((a) => sealed.has(a)) && r < maxSealRounds) {
      if (stopped()) return { log, cleared: false };
      await recoverUntilSafe();
      await M.clickTurn(5);
      r++;
      for (const s of M.parseSealedAbilities(requiredSeals)) sealed.add(s); // 화면에 최근 로그만 남아 예전 정보를 잊지 않도록 누적
      push(`[1단계 ${r}회차] sealed=${[...sealed].join(',')}`);
    }
    if (!requiredSeals.every((a) => sealed.has(a))) {
      push('[1단계] 경고: 최대 시도 내 목표 봉인 미완료, 다음 단계로 진행');
    }
    if (stopped()) return { log, cleared: false };

    // 2단계: 마나 (10턴씩)
    await M.applyBossPreset('마나');
    push('[2단계] 마나 프리셋 적용');
    let state = (await M.getValidHpMpNumbers());
    r = 0;
    while (state.boss.mp.cur > 0 && r < maxManaRounds) {
      if (stopped()) return { log, cleared: false };
      await recoverUntilSafe();
      await M.clickTurn(10);
      r++;
      state = (await M.getValidHpMpNumbers());
      push(`[2단계 ${r}회차/10턴] bossMp=${state.boss.mp.cur}/${state.boss.mp.max} bossHp=${state.boss.hp.cur}`);
    }
    if (state.boss.mp.cur > 0) push('[2단계] 경고: 최대 시도 내 마나 0 미도달, 다음 단계로 진행');
    if (stopped()) return { log, cleared: false };

    await M.applyBossPreset('딜');
    push('[3단계] 딜 프리셋 적용');
    state = (await M.getValidHpMpNumbers());
    r = 0;
    let scrollRoundsUsed = 0;
    while (state.boss.hp.cur > 0 && r < maxDealRounds) {
      if (stopped()) return { log, cleared: false };
      await recoverUntilSafe();
      // 공격+집중은 합계 2장, 전투당 스크롤 한도 10장이므로 최대 5회.
      // 각 사용 직후 5턴을 공격하고, 모두 소진되면 스크롤 없이 계속 공격한다.
      if (scrollRoundsUsed < 5) {
        await M.useScrolls(['공격', '집중']);
        scrollRoundsUsed++;
        push(`[3단계] 공격/집중 스크롤 사용 (${scrollRoundsUsed}/5)`);
      }
      await M.clickTurn(5);
      r++;
      state = (await M.getValidHpMpNumbers());
      push(`[3단계 ${r}회차] bossHp=${state.boss.hp.cur}`);
      if (state.boss.hp.cur <= 0) break;
    }

    const finalCleared = state.boss.hp.cur <= 0;
    if (finalCleared) {
      push('✅ 처치 완료');
    } else {
      push(`⛔ 최대 시도 횟수 도달, 보스 HP ${state.boss.hp.cur} 남음 (미처치)`);
    }
    if (finalCleared) await M.closeClearPopupIfAny();
    return { log, cleared: finalCleared };
  };

  // --- 공허의 황제 (검술 잡, 일반) ---------------------------------------------
  // 1) 봉인 프리셋으로 "차원왜곡" 봉인될 때까지 5턴씩 반복
  // 2) 마나 프리셋으로 보스 마나 0 될 때까지 "10턴"씩 반복  ← 5턴에서 변경됨
  // 3) 딜 프리셋 전환 + 스크롤 패턴:
  //      1회차: 공격+집중
  //      2회차: 공격+집중
  //      3회차: 공격+집중+재생
  //      4회차부터: 스크롤 없이 5턴씩만 반복
  //    내 HP가 30% 이하로 떨어지면 그 턴은 공격 대신 회복(2턴) 사용
  M.runVoidEmperor = async ({
    requiredSeal = '차원왜곡',
    maxSealRounds = 15,
    maxManaRounds = 20, // 10턴씩이라 실제 최대 200턴
    maxDealRounds = 30,
    lowHpThreshold = 0.3,
  } = {}) => {
    const log = [];
    const push = (line) => { log.push(line); if (M.uiLog) M.uiLog(line); };
    const stopped = () => {
      if (M.stopRequested) { push('■ 사용자 요청으로 정지'); return true; }
      return false;
    };

    // 1단계: 봉인
    await M.applyBossPreset('봉인');
    push('[1단계] 봉인 프리셋 적용');
    let sealed = M.parseSealedAbilities([requiredSeal]);
    let r = 0;
    while (!sealed.has(requiredSeal) && r < maxSealRounds) {
      if (stopped()) return { log, cleared: false };
      await M.clickTurn(5);
      r++;
      for (const s of M.parseSealedAbilities([requiredSeal])) sealed.add(s); // 화면에 최근 로그만 남아 예전 정보를 잊지 않도록 누적
      push(`[1단계 ${r}회차] sealed=${[...sealed].join(',')}`);
    }
    if (!sealed.has(requiredSeal)) {
      push(`[1단계] 경고: 최대 시도 내 "${requiredSeal}" 미봉인, 다음 단계로 진행`);
    }
    if (stopped()) return { log, cleared: false };

    // 2단계: 마나. 모든 직업 공통으로 MP가 300을 초과하면 5턴,
    // 300 이하면 1턴씩 진행해 0을 넘겨 낭비하지 않는다.
    await M.applyBossPreset('마나');
    push('[2단계] 마나 프리셋 적용');
    let state = (await M.getValidHpMpNumbers());
    r = 0;
    while (state.boss.mp.cur > 0 && r < maxManaRounds) {
      if (stopped()) return { log, cleared: false };
      const turns = state.boss.mp.cur > 300 ? 5 : 1;
      await M.clickTurn(turns);
      r++;
      state = (await M.getValidHpMpNumbers());
      push(`[2단계 ${r}회차/${turns}턴] bossMp=${state.boss.mp.cur}/${state.boss.mp.max} bossHp=${state.boss.hp.cur}`);
    }
    if (state.boss.mp.cur > 0) push('[2단계] 경고: 최대 시도 내 마나 0 미도달, 다음 단계로 진행');
    if (stopped()) return { log, cleared: false };

    // 3단계: 딜 (스크롤 패턴 + 회복 개입)
    await M.applyBossPreset('딜');
    push('[3단계] 딜 프리셋 적용');

    state = (await M.getValidHpMpNumbers());
    let round = 0;
    let attackRound = 0;
    while (state.boss.hp.cur > 0 && round < maxDealRounds) {
      if (stopped()) return { log, cleared: false };
      round++;
      const myHpRatio = state.player.hp.cur / state.player.hp.max;
      if (myHpRatio < lowHpThreshold) {
        await M.clickRecover();
        push(`[3단계 ${round}회차] 내HP ${Math.round(myHpRatio * 100)}% -> 회복`);
      } else {
        // 스크롤 패턴은 "실제 공격한 턴" 기준이어야 함 - round를 그대로
        // 쓰면 회복이 끼어들 때 스크롤을 공격 안 하는 회복턴에 낭비하거나
        // 패턴이 밀리는 문제가 있었음(같은 종류 버그가 인술 망령에서도
        // 지적됨).
        attackRound++;
        if (attackRound === 1 || attackRound === 2) {
          await M.useScrolls(['공격', '집중']);
          push(`[3단계 스크롤 공격${attackRound}회차] 공격+집중`);
        } else if (attackRound === 3) {
          await M.useScrolls(['공격', '집중', '재생']);
          push(`[3단계 스크롤 공격${attackRound}회차] 공격+집중+재생`);
        }
        await M.clickTurn(5);
      }
      state = (await M.getValidHpMpNumbers());
      push(`[3단계 ${round}회차] bossHp=${state.boss.hp.cur} myHp=${state.player.hp.cur}/${state.player.hp.max}`);
    }

    const finalCleared = state.boss.hp.cur <= 0;
    if (finalCleared) {
      push('✅ 처치 완료');
    } else {
      push(`⛔ 최대 시도 횟수 도달, 보스 HP ${state.boss.hp.cur} 남음 (미처치)`);
    }
    if (finalCleared) await M.closeClearPopupIfAny();
    return { log, cleared: finalCleared };
  };

  // --- 지하를 휘감은 엔트 (검술 잡, 일반) ---------------------------------------
  // 1) 항상: 내 HP 30% 이하면 공격 대신 회복
  // 2) 봉인 프리셋으로 "노 컨디션" 봉인될 때까지 5턴씩 반복
  //    - 단, 이 도중에 "휘감은 뿌리"가 (노 컨디션보다 먼저) 봉인되면 화상 단계를
  //      건너뛰고 바로 정신일도 단계로 진행
  // 3) 노 컨디션이 먼저 봉인된 정상 경로라면: 화상 프리셋으로 전환해
  //    "휘감은 뿌리" 봉인될 때까지 5턴씩 반복
  // 4) 정신일도 프리셋으로 5턴 공격 (1회)
  // 5) 딜 프리셋 + 공격/집중 스크롤로 5턴씩 반복 처치. 매 라운드마다 스크롤을
  //    다시 사용하되, 스크롤 사용 전 내 HP가 50% 이하면 그 라운드는 회복만 함
  M.runVineEntSword = async ({
    requiredSeals = ['노 컨디션', '휘감은 뿌리'],
    maxSealRounds = 8, // 150턴 예산 안에서 딜 단계 턴을 확보하기 위해 축소
    maxBurnRounds = 8,
    maxDealRounds = 40,
    globalLowHpThreshold = 0.3,
    dealLowHpThreshold = 0.5,
  } = {}) => {
    const log = [];
    const push = (line) => { log.push(line); if (M.uiLog) M.uiLog(line); };
    const stopped = () => {
      if (M.stopRequested) { push('■ 사용자 요청으로 정지'); return true; }
      return false;
    };
    let mechanicTurns = 0;
    // 공통: HP 낮으면 회복, 아니면 5턴 공격. 회복했으면 true 반환
    const attackOrRecover = async (threshold) => {
      const s = (await M.getValidHpMpNumbers());
      const ratio = s.player.hp.cur / s.player.hp.max;
      if (ratio <= threshold) {
        await M.clickRecover();
        mechanicTurns += 2;
        push(`내HP ${Math.round(ratio * 100)}% -> 회복`);
        return true;
      }
      await M.clickTurn(5);
      mechanicTurns += 5;
      return false;
    };

    // 2단계: 봉인 (노 컨디션 목표, 휘감은 뿌리 먼저 봉인되면 화상 단계 스킵)
    await M.applyBossPreset('봉인');
    push('[1단계] 봉인 프리셋 적용');
    let sealed = M.parseSealedAbilities(requiredSeals);
    let skipBurnPhase = sealed.has('휘감은 뿌리');
    let r = 0;
    while (!sealed.has('노 컨디션') && !sealed.has('휘감은 뿌리') && r < maxSealRounds) {
      if (stopped()) return { log, cleared: false };
      await attackOrRecover(globalLowHpThreshold);
      r++;
      for (const s of M.parseSealedAbilities(requiredSeals)) sealed.add(s);
      push(`[1단계 ${r}회차] sealed=${[...sealed].join(',')}`);
      if (mechanicTurns > 45 && !sealed.has('노 컨디션') && !sealed.has('휘감은 뿌리')) {
        push('⛔ 엔트 기믹 45턴 초과 - 포기 후 재도전');
        return { log, cleared: false, retryRequired: true };
      }
    }
    if (sealed.has('휘감은 뿌리')) {
      skipBurnPhase = true;
      push('[1단계] "휘감은 뿌리"가 먼저 봉인됨 -> 화상 단계 생략');
    } else if (!sealed.has('노 컨디션')) {
      push('[1단계] 경고: 최대 시도 내 "노 컨디션" 미봉인, 다음 단계로 진행');
    }
    if (stopped()) return { log, cleared: false };

    // 3단계: 화상 (휘감은 뿌리 목표) - 이미 봉인됐으면 생략
    if (!skipBurnPhase) {
      await M.applyBossPreset('화상');
      push('[2단계] 화상 프리셋 적용');
      r = 0;
      while (!sealed.has('휘감은 뿌리') && r < maxBurnRounds) {
        if (stopped()) return { log, cleared: false };
        await attackOrRecover(globalLowHpThreshold);
        r++;
        for (const s of M.parseSealedAbilities(requiredSeals)) sealed.add(s);
        push(`[2단계 ${r}회차] sealed=${[...sealed].join(',')}`);
        if (mechanicTurns > 45 && !sealed.has('휘감은 뿌리')) {
          push('⛔ 엔트 기믹 45턴 초과 - 포기 후 재도전');
          return { log, cleared: false, retryRequired: true };
        }
      }
      if (!sealed.has('휘감은 뿌리')) {
        push('[2단계] 경고: 최대 시도 내 "휘감은 뿌리" 미봉인, 다음 단계로 진행');
      }
    } else {
      push('[2단계] 생략됨 (이미 봉인)');
    }
    if (stopped()) return { log, cleared: false };

    // 4단계: 정신일도 (5턴 1회 시도 - 회복이 개입했으면 그렇게 로그에 남김)
    await M.applyBossPreset('정신일도');
    push('[3단계] 정신일도 프리셋 적용');
    if (stopped()) return { log, cleared: false };
    let recoveryCount = 0;
    while (await attackOrRecover(globalLowHpThreshold)) {
      recoveryCount++;
      if (stopped()) return { log, cleared: false };
      if (recoveryCount >= 10) throw new Error('정신일도 전 10회 회복 후에도 안전 HP 미도달');
    }
    push(`[3단계] 정신일도 5턴 공격 완료 (사전 회복 ${recoveryCount}회)`);
    if (stopped()) return { log, cleared: false };

    // 5단계: 딜 (매 라운드 스크롤 재사용, 스크롤 전 HP<=50%면 회복)
    await M.applyBossPreset('딜');
    push('[4단계] 딜 프리셋 적용');
    let state = (await M.getValidHpMpNumbers());
    r = 0;
    let dealAttackRound = 0;
    while (state.boss.hp.cur > 0 && r < maxDealRounds) {
      if (stopped()) return { log, cleared: false };
      r++;
      const ratio = state.player.hp.cur / state.player.hp.max;
      if (ratio <= dealLowHpThreshold) {
        await M.clickRecover();
        push(`[4단계 ${r}회차] 내HP ${Math.round(ratio * 100)}% -> 회복 (스크롤 생략)`);
      } else {
        dealAttackRound++;
        if (dealAttackRound <= 5) {
          await M.useScrolls(['공격', '집중']);
          push(`[4단계 공격${dealAttackRound}회차] 공격+집중 스크롤 (${dealAttackRound}/5)`);
        } else {
          push(`[4단계 공격${dealAttackRound}회차] 스크롤 소진 후 무스크롤 공격`);
        }
        await M.clickTurn(5);
        push(`[4단계 ${r}회차] 5턴 공격`);
      }
      state = (await M.getValidHpMpNumbers());
      push(`[4단계 ${r}회차] bossHp=${state.boss.hp.cur} myHp=${state.player.hp.cur}/${state.player.hp.max}`);
    }

    const finalCleared = state.boss.hp.cur <= 0;
    if (finalCleared) {
      push('✅ 처치 완료');
    } else {
      push(`⛔ 최대 시도 횟수 도달, 보스 HP ${state.boss.hp.cur} 남음 (미처치)`);
    }
    if (finalCleared) await M.closeClearPopupIfAny();
    return { log, cleared: finalCleared };
  };

  // --- 지하의 망령 (검술 잡, 일반) ---------------------------------------------
  // 기믹: 망령은 공격태세/수비태세를 오가며, 한 자세를 오래 유지할수록 더
  // 잡기 어려워짐(공격태세는 시간이 지날수록 공격력·적중 상승, 수비태세는
  // 방어력 상승). 자세가 "깨질" 때마다(공격<->수비 전환 1왕복 = 1사이클)
  // 방어력이 -100씩 누적됨. 이를 이용해 방어력을 충분히 낮춘 뒤 스킬딜로 마무리.
  //
  // 자세 전환 조건 (사용자 확인):
  //   - 공격태세 -> 수비태세: 내가 "받는" 피해(💔)가 5턴 누적 100 이하일 때
  //   - 수비태세 -> 공격태세: 내가 "주는" 피해(⚔️)가 3턴 누적 100 이하일 때
  //   (버프가 쌓이면 데미지가 올라가 조건을 계속 못 채울 수 있음 - 버프는
  //    지속시간이 있어 결국 빠지므로, 그냥 1턴씩 계속 시도하면 됨)
  //
  // 자세 판정은 화면에 뜨는 보스의 "공격력 vs 방어력" 숫자 비교로 함
  // (M.getBossStance) - 로그에 "자세가 깨졌다!"라는 문구도 뜨지만 어느
  // 방향인지는 텍스트만으론 구분이 안 돼서 판정에 안 씀.
  //
  // ⚠️ 매우 중요: 전투 스크롤은 "전투당 총 10개" 한도가 있음. 사이클마다
  // 회피 스크롤을 딱 1번만 써야 함 (공격 페이즈 시작할 때만). 수비 페이즈로
  // 넘어갈 때 스크롤을 또 쓰면 절대 안 됨 - 실전에서 이 실수로 5사이클
  // 만에 스크롤 10개를 다 써버려 딜 단계에서 못 쓰는 사고가 있었음.
  // 0단계(첫 전환)는 스크롤 없이 진행, 이후 1~5단계에서만 사이클당 1개씩
  // 사용 -> 총 5개 소비, 딜 단계에 5개가 남음.
  //
  // 딜 단계: 딜 프리셋 + 공격 스크롤(단일, 5공격턴마다 재사용) + 1턴씩 공격.
  //   - 내 HP 65% 이하 -> 회복
  //   - 내 MP 60% 이하 -> 회복
  //   (1턴 공격하고 1턴 회복하는 패턴이 자주 나오는 게 정상)
  //
  // ⚠️ 딜 스킬은 보스의 그날 속성에 맞춰 미리 바꿔둬야 함 (M.ELEMENT_TO_SKILL
  // 참고). 스킬 변경은 /skill-management 페이지에서 하며, 이 페이지 왕복은
  // SPA 전환이라 새로고침 없이 전투 상태를 유지한 채 다녀올 수 있음
  // (캐릭>스킬 메뉴 클릭 후, 볼일 다 보면 history.back()으로 복귀).
  // 이 스킬 자동 전환 로직은 아직 이 함수에 통합되지 않음 - 전투 시작 전에
  // 미리 손으로 맞춰두거나, 추후 자동화 필요.
  M.runVineWraithSword = async ({
    firstAttackMaxTurns = 8,
    laterAttackMaxTurns = 25,
    maxDefendTurns = 25,
    maxDealRounds = 80,
    hpThreshold = 0.7,
    mpThreshold = 0.6,
  } = {}) => {
    const bossLabel = '지하의 망령';
    const log = [];
    const push = (line) => { log.push(line); if (M.uiLog) M.uiLog(line); };
    const stopped = () => { if (M.stopRequested) { push('■ 사용자 요청으로 정지'); return true; } return false; };
    const getStance = async () => (await M.getValidBossStance(bossLabel)).stance;
    const recoverUntilSafe = async () => {
      for (let i = 0; i < 10; i++) {
        const state = await M.getValidHpMpNumbers();
        const ratio = state.player.hp.cur / state.player.hp.max;
        if (ratio > hpThreshold) return;
        await M.clickRecover();
        push(`HP ${Math.round(ratio * 100)}% -> 회복`);
      }
      throw new Error('망령: 10회 회복 후에도 HP 70% 초과 실패');
    };
    const safeTurn = async (turns) => {
      await recoverUntilSafe();
      await M.clickTurn(turns);
    };

    // 공격 페이즈: 5턴 시도 후, 안 바뀌면 1턴씩 추가 시도 (버프 소멸 대기)
    const attackUntilFlip = async (label, maxTurns) => {
      let stance = await getStance();
      await safeTurn(5);
      let n = 5;
      while ((await getStance()) === stance && n < maxTurns) {
        if (stopped()) return false;
        await safeTurn(1);
        n++;
      }
      const ok = (await getStance()) !== stance;
      push(`[${label}] ${n}턴만에 ${ok ? '전환 성공' : '전환 실패'}: ` + JSON.stringify(await M.getValidBossStance(bossLabel)));
      return ok;
    };
    // 수비 페이즈: 1턴씩 시도 (스크롤 재사용 없음)
    const defendUntilFlip = async (label) => {
      let stance = await getStance();
      let n = 0;
      while ((await getStance()) === stance && n < maxDefendTurns) {
        if (stopped()) return false;
        await safeTurn(1);
        n++;
      }
      const ok = (await getStance()) !== stance;
      push(`[${label}] ${n}턴만에 ${ok ? '전환 성공' : '전환 실패'}: ` + JSON.stringify(await M.getValidBossStance(bossLabel)));
      return ok;
    };

    // 0단계: 기본 사이클 (스크롤 없음)
    await M.applyBossPreset('공격'); push('[0단계] 공격 프리셋 적용');
    if (!(await attackUntilFlip('0단계-공격', firstAttackMaxTurns))) {
      push('[0단계] 8턴 내 전환 실패 - 포기 후 재도전 필요');
      return { log, cleared: false, retryRequired: true };
    }
    await M.applyBossPreset('수비'); push('[0단계] 수비 프리셋 적용');
    if (!(await defendUntilFlip('0단계-수비'))) { push('[0단계] 실패 - 리셋 필요'); return { log, cleared: false }; }

    // 1~5단계: 회피 스크롤 사이클 (사이클당 딱 1번만 사용!)
    for (let cycle = 1; cycle <= 5; cycle++) {
      if (stopped()) return { log, cleared: false };
      await M.applyBossPreset('공격');
      await recoverUntilSafe();
      await M.useScrolls(['회피']); // 이번 사이클의 유일한 스크롤 사용
      push(`[${cycle}단계] 공격 프리셋 + 회피 스크롤(1회) 적용`);
      if (!(await attackUntilFlip(`${cycle}단계-공격`, laterAttackMaxTurns))) {
        push(`[${cycle}단계] 실패 - 리셋 필요`);
        return { log, cleared: false };
      }

      await M.applyBossPreset('수비'); // 스크롤 재사용 절대 금지
      push(`[${cycle}단계] 수비 프리셋 적용 (스크롤 없음)`);
      if (!(await defendUntilFlip(`${cycle}단계-수비`))) { push(`[${cycle}단계] 실패 - 리셋 필요`); return { log, cleared: false }; }
    }

    push('[전환완료] ' + JSON.stringify(await M.getValidBossStance(bossLabel)));

    // 딜 단계
    await M.applyBossPreset('딜'); push('[딜단계] 딜 프리셋 적용');
    const skillResult = await M.setDealSkillForBossElement(bossLabel);
    push('[딜단계] 속성별 스킬 세팅: ' + JSON.stringify(skillResult));
    let attackCounter = 0;
    let state = (await M.getValidHpMpNumbers());
    let round = 0;
    while (state.boss.hp.cur > 0 && round < maxDealRounds) {
      if (stopped()) return { log, cleared: false };
      round++;
      const hpRatio = state.player.hp.cur / state.player.hp.max;
      const mpRatio = state.player.mp.cur / state.player.mp.max;
      if (hpRatio <= hpThreshold) {
        await M.clickRecover();
        push(`[딜 ${round}] HP ${Math.round(hpRatio * 100)}% -> 회복`);
      } else if (mpRatio <= mpThreshold) {
        await M.clickRecover();
        push(`[딜 ${round}] MP ${Math.round(mpRatio * 100)}% -> 회복`);
      } else {
        if (attackCounter % 5 === 0) {
          try { await M.useScrolls(['공격']); push(`[딜 ${round}] 공격 스크롤 사용`); }
          catch (e) { push(`[딜 ${round}] 스크롤 실패(잔여 소진 추정): ` + e.message); }
        }
        await M.clickTurn(1);
        attackCounter++;
        push(`[딜 ${round}] 1턴 공격 (누적 공격턴=${attackCounter})`);
      }
      state = (await M.getValidHpMpNumbers());
      push(`   bossHp=${state.boss.hp.cur} myHp=${state.player.hp.cur}/${state.player.hp.max} myMp=${state.player.mp.cur}/${state.player.mp.max}`);
    }

    const finalCleared = state.boss.hp.cur <= 0;
    if (finalCleared) {
      push('✅ 처치 완료');
    } else {
      push(`⛔ 최대 시도 횟수 도달, 보스 HP ${state.boss.hp.cur} 남음 (미처치)`);
    }
    if (finalCleared) await M.closeClearPopupIfAny();
    return { log, cleared: finalCleared };
  };

  // --- 지하를 휘감은 엔트 (인술 잡) --------------------------------------------
  // 검술과 달리 정신일도 단계가 없음. 노 컨디션->휘감은 뿌리 순으로 봉인
  // (휘감은 뿌리가 먼저 되면 화상 단계 생략) 후 바로 딜. 회복 기준은
  // HP 50% 이하 하나뿐(MP 신경 안 씀).
  M.runVineEntNinja = async ({
    requiredSeals = ['노 컨디션', '휘감은 뿌리'],
    maxSealRounds = 8,
    maxBurnRounds = 8,
    maxDealRounds = 40,
    hpThreshold = 0.7,
  } = {}) => {
    const log = [];
    const push = (line) => { log.push(line); if (M.uiLog) M.uiLog(line); };
    const stopped = () => { if (M.stopRequested) { push('■ 사용자 요청으로 정지'); return true; } return false; };
    let mechanicTurns = 0;
    const attackOrRecover = async () => {
      const s = (await M.getValidHpMpNumbers()); const ratio = s.player.hp.cur / s.player.hp.max;
      if (ratio <= hpThreshold) {
        await M.clickRecover();
        mechanicTurns += 2;
        push(`내HP ${Math.round(ratio * 100)}% -> 회복`);
        return true;
      }
      await M.clickTurn(5);
      mechanicTurns += 5;
      return false;
    };

    await M.applyBossPreset('봉인'); push('[1단계] 봉인 프리셋 적용');
    let sealed = M.parseSealedAbilities(requiredSeals);
    let skipBurnPhase = sealed.has('휘감은 뿌리');
    let r = 0;
    while (!sealed.has('노 컨디션') && !sealed.has('휘감은 뿌리') && r < maxSealRounds) {
      if (stopped()) return { log, cleared: false }; await attackOrRecover(); r++;
      for (const s of M.parseSealedAbilities(requiredSeals)) sealed.add(s);
      push(`[1단계 ${r}회차] sealed=${[...sealed].join(',')}`);
      if (mechanicTurns > 45 && !sealed.has('노 컨디션') && !sealed.has('휘감은 뿌리')) {
        push('⛔ 엔트 기믹 45턴 초과 - 포기 후 재도전');
        return { log, cleared: false, retryRequired: true };
      }
    }
    if (sealed.has('휘감은 뿌리')) { skipBurnPhase = true; push('[1단계] "휘감은 뿌리"가 먼저 봉인됨 -> 화상 단계 생략'); }
    else if (!sealed.has('노 컨디션')) { push('[1단계] 경고: 최대 시도 내 "노 컨디션" 미봉인, 다음 단계로 진행'); }
    if (stopped()) return { log, cleared: false };

    if (!skipBurnPhase) {
      await M.applyBossPreset('화상'); push('[2단계] 화상 프리셋 적용');
      r = 0;
      while (!sealed.has('휘감은 뿌리') && r < maxBurnRounds) {
        if (stopped()) return { log, cleared: false }; await attackOrRecover(); r++;
        for (const s of M.parseSealedAbilities(requiredSeals)) sealed.add(s);
        push(`[2단계 ${r}회차] sealed=${[...sealed].join(',')}`);
        if (mechanicTurns > 45 && !sealed.has('휘감은 뿌리')) {
          push('⛔ 엔트 기믹 45턴 초과 - 포기 후 재도전');
          return { log, cleared: false, retryRequired: true };
        }
      }
      if (!sealed.has('휘감은 뿌리')) push('[2단계] 경고: 최대 시도 내 "휘감은 뿌리" 미봉인, 다음 단계로 진행');
    } else { push('[2단계] 생략됨 (이미 봉인)'); }
    if (stopped()) return { log, cleared: false };

    await M.applyBossPreset('딜'); push('[3단계] 딜 프리셋 적용');
    let state = (await M.getValidHpMpNumbers()); r = 0;
    while (state.boss.hp.cur > 0 && r < maxDealRounds) {
      if (stopped()) return { log, cleared: false }; r++;
      const ratio = state.player.hp.cur / state.player.hp.max;
      if (ratio <= hpThreshold) {
        await M.clickRecover();
        push(`[3단계 ${r}회차] 내HP ${Math.round(ratio * 100)}% -> 회복 (스크롤 생략)`);
      } else {
        await M.useScrolls(['공격', '집중']);
        await M.clickTurn(5);
        push(`[3단계 ${r}회차] 공격+집중 스크롤 후 5턴 공격`);
      }
      state = (await M.getValidHpMpNumbers());
      push(`[3단계 ${r}회차] bossHp=${state.boss.hp.cur} myHp=${state.player.hp.cur}/${state.player.hp.max}`);
    }

    const finalCleared = state.boss.hp.cur <= 0;
    if (finalCleared) {
      push('✅ 처치 완료');
    } else {
      push(`⛔ 최대 시도 횟수 도달, 보스 HP ${state.boss.hp.cur} 남음 (미처치)`);
    }
    if (finalCleared) await M.closeClearPopupIfAny();
    return { log, cleared: finalCleared };
  };

  // --- 지하의 망령 (인술 잡) ----------------------------------------------------
  // 검술과 기믹은 동일(자세전환으로 방어력 깎기)하지만 인술은 기본 스킬
  // "연막"이 회피기라서 회피 스크롤을 아예 쓰지 않음. 목표 방어력도 340이
  // 아니라 140. 딜 단계 스크롤 패턴도 다름(1·2회차 공격+집중, 3·4회차
  // 공격+집중+방어로 스크롤 10개를 전부 소모한 뒤 이후엔 스크롤 없이 진행).
  // 회복은 HP 50% 이하 하나뿐(딜 세팅이 마나 안 쓰는 평타 위주라 MP 안 봄).
  M.runVineWraithNinja = async ({
    firstAttackMaxTurns = 8,
    laterAttackMaxTurns = 25,
    maxDefendTurns = 25,
    maxDealRounds = 80,
    hpThreshold = 0.5,
    targetDef = 140,
  } = {}) => {
    const bossLabel = '지하의 망령';
    const log = [];
    const push = (line) => { log.push(line); if (M.uiLog) M.uiLog(line); };
    const stopped = () => { if (M.stopRequested) { push('■ 사용자 요청으로 정지'); return true; } return false; };
    const getStance = async () => (await M.getValidBossStance(bossLabel)).stance;
    const getDef = async () => (await M.getValidBossStance(bossLabel)).def;
    const recoverUntilSafe = async () => {
      for (let i = 0; i < 10; i++) {
        const state = await M.getValidHpMpNumbers();
        const ratio = state.player.hp.cur / state.player.hp.max;
        if (ratio > hpThreshold) return;
        await M.clickRecover();
        push(`HP ${Math.round(ratio * 100)}% -> 회복`);
      }
      throw new Error('망령: 10회 회복 후에도 HP 70% 초과 실패');
    };
    const safeTurn = async (turns) => {
      await recoverUntilSafe();
      await M.clickTurn(turns);
    };

    // 공격 페이즈: 5턴 시도 후, 안 바뀌면 1턴씩 추가 시도 (스크롤 없음)
    const attackUntilFlip = async (label, maxTurns) => {
      let stance = await getStance();
      await safeTurn(5);
      let n = 5;
      while ((await getStance()) === stance && n < maxTurns) {
        if (stopped()) return false;
        await safeTurn(1);
        n++;
      }
      const ok = (await getStance()) !== stance;
      push(`[${label}] ${n}턴만에 ${ok ? '전환 성공' : '전환 실패'}: ` + JSON.stringify(await M.getValidBossStance(bossLabel)));
      return ok;
    };
    const defendUntilFlip = async (label) => {
      let stance = await getStance();
      let n = 0;
      while ((await getStance()) === stance && n < maxDefendTurns) {
        if (stopped()) return false;
        await safeTurn(1);
        n++;
      }
      const ok = (await getStance()) !== stance;
      push(`[${label}] ${n}턴만에 ${ok ? '전환 성공' : '전환 실패'}: ` + JSON.stringify(await M.getValidBossStance(bossLabel)));
      return ok;
    };

    // 사이클 상한: 자세 전환마다 방어력이 정확히 고정 수치(-100)씩 깎이는
    // 게임 규칙이라, 전환 로직 자체만 정확하면 무한 반복될 일은 없다고
    // 판단함(사용자 확인). 그래도 혹시 모를 상황을 대비해 안전판으로 넉넉한
    // 상한(20사이클)만 둔다.
    let cycle = 0;
    const maxCycles = 20;
    while ((await getDef()) > targetDef && cycle < maxCycles) {
      if (stopped()) return { log, cleared: false };
      cycle++;
      await M.applyBossPreset('공격');
      push(`[사이클${cycle}] 공격 프리셋 적용`);
      const attackMaxTurns = cycle === 1 ? firstAttackMaxTurns : laterAttackMaxTurns;
      if (!(await attackUntilFlip(`사이클${cycle}-공격`, attackMaxTurns))) {
        push(`[사이클${cycle}] 실패 - 리셋 필요`);
        return { log, cleared: false, retryRequired: cycle === 1 };
      }
      await M.applyBossPreset('수비');
      push(`[사이클${cycle}] 수비 프리셋 적용`);
      if (!(await defendUntilFlip(`사이클${cycle}-수비`))) { push(`[사이클${cycle}] 실패 - 리셋 필요`); return { log, cleared: false }; }
    }
    push(`[전환완료] 방어력=${await getDef()}`);

    await M.applyBossPreset('딜'); push('[딜단계] 딜 프리셋 적용');
    // 인술은 딜 스킬이 전부 평타(기본공격)로 구성되어 있어서, 검술과 달리
    // 속성 상성 스킬로 바꿔줄 필요가 없음(사용자 확인) - 스킬 교체 호출 생략.

    let state = (await M.getValidHpMpNumbers()); let round = 0; let attackRound = 0;
    while (state.boss.hp.cur > 0 && round < maxDealRounds) {
      if (stopped()) return { log, cleared: false };
      round++;
      const hpRatio = state.player.hp.cur / state.player.hp.max;
      if (hpRatio <= hpThreshold) {
        await M.clickRecover();
        push(`[딜 ${round}] HP ${Math.round(hpRatio * 100)}% -> 회복`);
      } else {
        // 스크롤 패턴(1·2회차 공격+집중, 3·4회차 +방어)은 "실제 공격한
        // 턴" 기준이어야 함 - round를 그대로 쓰면 회복이 끼어들 때마다
        // 카운트가 밀려서 스크롤 패턴이 엉키는 문제가 있었음(실전 지적됨).
        attackRound++;
        if (attackRound === 1 || attackRound === 2) {
          await M.useScrolls(['공격', '집중']);
          push(`[딜 스크롤 공격${attackRound}회차] 공격+집중`);
        } else if (attackRound === 3 || attackRound === 4) {
          await M.useScrolls(['공격', '집중', '방어']);
          push(`[딜 스크롤 공격${attackRound}회차] 공격+집중+방어`);
        }
        await M.clickTurn(5);
      }
      state = (await M.getValidHpMpNumbers());
      push(`[딜 ${round}회차] bossHp=${state.boss.hp.cur} myHp=${state.player.hp.cur}/${state.player.hp.max}`);
    }

    const finalCleared = state.boss.hp.cur <= 0;
    if (finalCleared) {
      push('✅ 처치 완료');
    } else {
      push(`⛔ 최대 시도 횟수 도달, 보스 HP ${state.boss.hp.cur} 남음 (미처치)`);
    }
    if (finalCleared) await M.closeClearPopupIfAny();
    return { log, cleared: finalCleared };
  };

  // ==========================================================================
  // 궁술 공략
  // ==========================================================================
  M.archeryRecoverUntilAbove = async (hpThreshold, mpThreshold = null, push = null) => {
    for (let i = 0; i < 10; i++) {
      const state = await M.getValidHpMpNumbers();
      const hpRatio = state.player.hp.cur / state.player.hp.max;
      const mpRatio = state.player.mp.cur / state.player.mp.max;
      const needsHp = hpRatio <= hpThreshold;
      const needsMp = mpThreshold !== null && mpRatio <= mpThreshold;
      if (!needsHp && !needsMp) return state;
      await M.clickRecover();
      if (push) push(`회복: HP ${Math.round(hpRatio * 100)}%, MP ${Math.round(mpRatio * 100)}%`);
    }
    throw new Error('10회 회복 후에도 궁술 안전 기준을 충족하지 못함');
  };

  M.runFallenGuardianArchery = async ({
    maxSealRounds = 15,
    maxDealRounds = 40,
    hpThreshold = 0.5,
  } = {}) => {
    const requiredSeals = ['불굴', '엔드 블로킹'];
    const log = [];
    const push = (line) => { log.push(line); if (M.uiLog) M.uiLog(line); };

    await M.applyBossPreset('봉인');
    let sealed = M.parseSealedAbilities(requiredSeals);
    for (let r = 1; !requiredSeals.every((name) => sealed.has(name)) && r <= maxSealRounds; r++) {
      if (M.stopRequested) return { log, cleared: false };
      await M.archeryRecoverUntilAbove(hpThreshold, null, push);
      await M.clickTurn(5);
      for (const name of M.parseSealedAbilities(requiredSeals)) sealed.add(name);
      push(`[봉인 ${r}] ${[...sealed].join(',') || '미봉인'}`);
    }
    if (!requiredSeals.every((name) => sealed.has(name))) {
      push('⛔ 필수 봉인 실패');
      return { log, cleared: false };
    }

    await M.applyBossPreset('딜');
    let state = await M.getValidHpMpNumbers();
    let attackRound = 0;
    for (let round = 1; state.boss.hp.cur > 0 && round <= maxDealRounds; round++) {
      if (M.stopRequested) return { log, cleared: false };
      await M.archeryRecoverUntilAbove(hpThreshold, null, push);
      attackRound++;
      if (attackRound === 1 || attackRound === 2) {
        await M.useScrolls(['공격', '집중']);
      } else if (attackRound === 3) {
        await M.useScrolls(['공격', '집중', '재생']);
      }
      await M.clickTurn(5);
      state = await M.getValidHpMpNumbers();
      push(`[딜 ${attackRound}] bossHp=${state.boss.hp.cur}`);
    }
    const cleared = state.boss.hp.cur <= 0;
    if (cleared) await M.closeClearPopupIfAny();
    return { log, cleared };
  };

  M.runVoidEmperorArchery = async ({
    maxSealRounds = 15,
    maxManaRounds = 80,
    maxDealRounds = 50,
    hpThreshold = 0.7,
  } = {}) => {
    const requiredSeal = '차원왜곡';
    const log = [];
    const push = (line) => { log.push(line); if (M.uiLog) M.uiLog(line); };

    await M.applyBossPreset('봉인');
    let sealed = M.parseSealedAbilities([requiredSeal]);
    for (let r = 1; !sealed.has(requiredSeal) && r <= maxSealRounds; r++) {
      if (M.stopRequested) return { log, cleared: false };
      await M.archeryRecoverUntilAbove(hpThreshold, null, push);
      await M.clickTurn(5);
      for (const name of M.parseSealedAbilities([requiredSeal])) sealed.add(name);
    }
    if (!sealed.has(requiredSeal)) return { log, cleared: false };

    await M.applyBossPreset('마나');
    let state = await M.getValidHpMpNumbers();
    for (let r = 1; state.boss.mp.cur > 0 && r <= maxManaRounds; r++) {
      if (M.stopRequested) return { log, cleared: false };
      await M.archeryRecoverUntilAbove(hpThreshold, null, push);
      const turns = state.boss.mp.cur > 300 ? 5 : 1;
      await M.clickTurn(turns);
      state = await M.getValidHpMpNumbers();
      push(`[마나 ${r}] ${turns}턴, bossMp=${state.boss.mp.cur}`);
    }
    if (state.boss.mp.cur > 0) return { log, cleared: false };

    await M.applyBossPreset('딜');
    await M.archeryRecoverUntilAbove(hpThreshold, null, push);
    await M.clickTurn(5); // 속도 감소 디버프 해소
    state = await M.getValidHpMpNumbers();

    let attackRound = 0;
    for (let round = 1; state.boss.hp.cur > 0 && round <= maxDealRounds; round++) {
      if (M.stopRequested) return { log, cleared: false };
      await M.archeryRecoverUntilAbove(hpThreshold, null, push);
      attackRound++;
      if (attackRound === 1 || attackRound === 2) {
        await M.useScrolls(['공격', '집중']);
      } else if (attackRound === 3) {
        await M.useScrolls(['공격', '집중', '재생']);
      }
      await M.clickTurn(5);
      state = await M.getValidHpMpNumbers();
      push(`[딜 ${attackRound}] bossHp=${state.boss.hp.cur}`);
    }
    const cleared = state.boss.hp.cur <= 0;
    if (cleared) await M.closeClearPopupIfAny();
    return { log, cleared };
  };

  M.runVineEntArchery = async ({
    maxSealRounds = 15,
    maxBurnRounds = 15,
    maxDealRounds = 50,
    hpThreshold = 0.7,
  } = {}) => {
    const requiredSeals = ['노 컨디션', '휘감은 뿌리'];
    const log = [];
    const push = (line) => { log.push(line); if (M.uiLog) M.uiLog(line); };

    await M.applyBossPreset('봉인');
    let sealed = M.parseSealedAbilities(requiredSeals);
    for (let r = 1; !sealed.has('노 컨디션') && !sealed.has('휘감은 뿌리') && r <= maxSealRounds; r++) {
      if (M.stopRequested) return { log, cleared: false };
      await M.archeryRecoverUntilAbove(hpThreshold, null, push);
      await M.clickTurn(5);
      for (const name of M.parseSealedAbilities(requiredSeals)) sealed.add(name);
    }

    if (!sealed.has('휘감은 뿌리')) {
      if (!sealed.has('노 컨디션')) return { log, cleared: false };
      await M.applyBossPreset('화상');
      for (let r = 1; !sealed.has('휘감은 뿌리') && r <= maxBurnRounds; r++) {
        if (M.stopRequested) return { log, cleared: false };
        await M.archeryRecoverUntilAbove(hpThreshold, null, push);
        await M.clickTurn(5);
        for (const name of M.parseSealedAbilities(requiredSeals)) sealed.add(name);
      }
    }
    if (!sealed.has('휘감은 뿌리')) return { log, cleared: false };

    await M.applyBossPreset('딜');
    let state = await M.getValidHpMpNumbers();
    let attackRound = 0;
    for (let round = 1; state.boss.hp.cur > 0 && round <= maxDealRounds; round++) {
      if (M.stopRequested) return { log, cleared: false };
      await M.archeryRecoverUntilAbove(hpThreshold, null, push);
      attackRound++;
      if (attackRound <= 4) {
        const scrolls = attackRound % 2 === 1
          ? ['공격', '집중']
          : ['공격', '집중', '재생'];
        await M.useScrolls(scrolls);
      }
      await M.clickTurn(5);
      state = await M.getValidHpMpNumbers();
      push(`[딜 ${attackRound}] bossHp=${state.boss.hp.cur}`);
    }
    const cleared = state.boss.hp.cur <= 0;
    if (cleared) await M.closeClearPopupIfAny();
    return { log, cleared };
  };

  M.runVineWraithArchery = async ({
    maxDefendTurns = 25,
    maxDealRounds = 160,
    hpThreshold = 0.7,
    mpThreshold = 0.5,
    targetDef = 340,
  } = {}) => {
    const bossLabel = '지하의 망령';
    const log = [];
    const push = (line) => { log.push(line); if (M.uiLog) M.uiLog(line); };
    const stance = async () => (await M.getValidBossStance(bossLabel)).stance;

    const safeTurn = async (turns, checkMp = false) => {
      await M.archeryRecoverUntilAbove(hpThreshold, checkMp ? mpThreshold : null, push);
      await M.clickTurn(turns);
    };
    const attackToDefense = async (firstCycle) => {
      const before = await stance();
      await safeTurn(5);
      let used = 5;
      while ((await stance()) === before && used < 8) {
        await safeTurn(1);
        used++;
      }
      const ok = (await stance()) !== before;
      push(`[공격→수비] ${used}턴, ${ok ? '성공' : '실패'}`);
      return ok;
    };
    const defenseToAttack = async () => {
      const before = await stance();
      let used = 0;
      while ((await stance()) === before && used < maxDefendTurns) {
        await safeTurn(1);
        used++;
      }
      const ok = (await stance()) !== before;
      push(`[수비→공격] ${used}턴, ${ok ? '성공' : '실패'}`);
      return ok;
    };

    await M.applyBossPreset('공격');
    if (!(await attackToDefense(true))) {
      push('⛔ 첫 사이클 8턴 내 자세 전환 실패 - 재도전 필요');
      return { log, cleared: false, retryRequired: true };
    }
    await M.applyBossPreset('수비');
    if (!(await defenseToAttack())) return { log, cleared: false };

    for (let cycle = 1; cycle <= 5; cycle++) {
      if (M.stopRequested) return { log, cleared: false };
      await M.applyBossPreset('공격');
      await M.archeryRecoverUntilAbove(hpThreshold, null, push);
      await M.useScrolls(['회피']);
      if (!(await attackToDefense(false))) return { log, cleared: false };
      await M.applyBossPreset('수비');
      if (!(await defenseToAttack())) return { log, cleared: false };
    }

    const bossStats = await M.getValidBossStance(bossLabel);
    if (bossStats.def > targetDef) {
      push(`⛔ 목표 방어력 미도달: ${bossStats.def}`);
      return { log, cleared: false };
    }

    // 궁술은 암흑 디버프가 필요하므로 딜 스킬을 속성별로 바꾸지 않는다.
    await M.applyBossPreset('딜');
    let state = await M.getValidHpMpNumbers();
    let attacks = 0;
    let attackScrollsUsed = 0;
    for (let round = 1; state.boss.hp.cur > 0 && round <= maxDealRounds; round++) {
      if (M.stopRequested) return { log, cleared: false };
      await M.archeryRecoverUntilAbove(hpThreshold, mpThreshold, push);
      if (attacks % 5 === 0 && attackScrollsUsed < 5) {
        await M.useScrolls(['공격']);
        attackScrollsUsed++;
      }
      await M.clickTurn(1);
      attacks++;
      state = await M.getValidHpMpNumbers();
      push(`[딜 ${attacks}] bossHp=${state.boss.hp.cur}, 공격스크롤=${attackScrollsUsed}/5`);
    }
    const cleared = state.boss.hp.cur <= 0;
    if (cleared) await M.closeClearPopupIfAny();
    return { log, cleared };
  };

  // --- 체술 공통 -------------------------------------------------------------
  // 실전 검증값:
  // 수호자 70%, 황제 60%, 엔트 50%, 망령 기믹 25%/75%, 최종 딜 70%.
  M.martialRecover = async (threshold, push = null, inclusive = true) => {
    for (let i = 0; i < 10; i++) {
      const state = await M.getValidHpMpNumbers();
      const ratio = state.player.hp.cur / state.player.hp.max;
      const unsafe = inclusive ? ratio <= threshold : ratio < threshold;
      if (!unsafe) return state;
      await M.clickRecover();
      if (push) push(`내HP ${Math.round(ratio * 100)}% -> 회복`);
    }
    throw new Error(`체술: HP ${Math.round(threshold * 100)}% 안전선 회복 실패`);
  };

  M.runFallenGuardianMartial = async ({
    maxSealRounds = 15,
    maxDealRounds = 30,
    hpThreshold = 0.7,
  } = {}) => {
    const log = [];
    const push = (s) => { log.push(s); if (M.uiLog) M.uiLog(s); };
    const required = ['불굴', '엔드 블로킹'];
    await M.applyBossPreset('봉인');
    let sealed = M.parseSealedAbilities(required);
    for (let r = 1; !required.every((x) => sealed.has(x)) && r <= maxSealRounds; r++) {
      if (M.stopRequested) return { log, cleared: false };
      await M.martialRecover(hpThreshold, push);
      await M.clickTurn(5);
      for (const x of M.parseSealedAbilities(required)) sealed.add(x);
      push(`[봉인 ${r}] ${[...sealed].join(',')}`);
    }
    if (!required.every((x) => sealed.has(x))) return { log, cleared: false };

    await M.applyBossPreset('딜');
    let state = await M.getValidHpMpNumbers();
    const pattern = [
      ['공격', '집중'],
      ['공격', '집중'],
      ['공격', '집중', '재생'],
    ];
    for (let r = 0; state.boss.hp.cur > 0 && r < maxDealRounds; r++) {
      await M.martialRecover(hpThreshold, push);
      if (r < pattern.length) await M.useScrolls(pattern[r]);
      await M.clickTurn(5);
      state = await M.getValidHpMpNumbers();
      push(`[딜 ${r + 1}] bossHp=${state.boss.hp.cur}`);
    }
    const cleared = state.boss.hp.cur <= 0;
    if (cleared) await M.closeClearPopupIfAny();
    return { log, cleared };
  };

  M.runVoidEmperorMartial = async ({
    maxSealRounds = 15,
    maxManaRounds = 40,
    maxDealRounds = 40,
    hpThreshold = 0.6,
  } = {}) => {
    const log = [];
    const push = (s) => { log.push(s); if (M.uiLog) M.uiLog(s); };
    await M.applyBossPreset('봉인');
    let sealed = M.parseSealedAbilities(['차원왜곡']);
    for (let r = 1; !sealed.has('차원왜곡') && r <= maxSealRounds; r++) {
      await M.martialRecover(hpThreshold, push);
      await M.clickTurn(5);
      for (const x of M.parseSealedAbilities(['차원왜곡'])) sealed.add(x);
    }
    if (!sealed.has('차원왜곡')) return { log, cleared: false };

    await M.applyBossPreset('마나');
    let state = await M.getValidHpMpNumbers();
    for (let r = 1; state.boss.mp.cur > 0 && r <= maxManaRounds; r++) {
      await M.martialRecover(hpThreshold, push);
      await M.clickTurn(state.boss.mp.cur > 300 ? 5 : 1);
      state = await M.getValidHpMpNumbers();
      push(`[마나 ${r}] bossMp=${state.boss.mp.cur}`);
    }
    if (state.boss.mp.cur > 0) return { log, cleared: false };

    await M.applyBossPreset('딜');
    await M.martialRecover(hpThreshold, push);
    await M.clickTurn(5); // 공속 저하 디버프 해소
    state = await M.getValidHpMpNumbers();
    const pattern = [
      ['공격', '집중'],
      ['공격', '집중'],
      ['공격', '집중', '재생'],
    ];
    for (let r = 0; state.boss.hp.cur > 0 && r < maxDealRounds; r++) {
      await M.martialRecover(hpThreshold, push);
      if (r < pattern.length) await M.useScrolls(pattern[r]);
      await M.clickTurn(5);
      state = await M.getValidHpMpNumbers();
      push(`[딜 ${r + 1}] bossHp=${state.boss.hp.cur}`);
    }
    const cleared = state.boss.hp.cur <= 0;
    if (cleared) await M.closeClearPopupIfAny();
    return { log, cleared };
  };

  M.runVineEntMartial = async ({
    maxDealRounds = 50,
    hpThreshold = 0.5,
  } = {}) => {
    const log = [];
    const push = (s) => { log.push(s); if (M.uiLog) M.uiLog(s); };
    const candidates = ['노 컨디션', '휘감은 뿌리'];
    let sealed = M.parseSealedAbilities(candidates);
    let burn = false;
    await M.applyBossPreset('봉인');
    // 45턴까지 휘감은 뿌리가 안 잠기면 재도전한다. 노 컨디션은 선택 사항.
    for (let used = 0; !sealed.has('휘감은 뿌리') && used < 45; used += 5) {
      await M.martialRecover(hpThreshold, push);
      await M.clickTurn(5);
      for (const x of M.parseSealedAbilities(candidates)) sealed.add(x);
      if (sealed.has('노 컨디션') && !sealed.has('휘감은 뿌리') && !burn) {
        await M.applyBossPreset('화상');
        burn = true;
      }
    }
    if (!sealed.has('휘감은 뿌리')) {
      push('⛔ 45턴 내 휘감은 뿌리 미봉인 - 재도전');
      return { log, cleared: false, retryRequired: true };
    }

    await M.applyBossPreset('방깎');
    await M.martialRecover(hpThreshold, push);
    await M.clickTurn(10);
    await M.applyBossPreset('딜');
    let state = await M.getValidHpMpNumbers();
    let scrollPairs = 0;
    for (let r = 1; state.boss.hp.cur > 0 && r <= maxDealRounds; r++) {
      await M.martialRecover(hpThreshold, push);
      if (scrollPairs < 7) {
        try {
          await M.useScrolls(['공격', '집중']);
          scrollPairs++;
        } catch (e) {
          push(`스크롤 소진 확인: ${e.message}`);
          scrollPairs = 7;
        }
      }
      await M.clickTurn(5);
      state = await M.getValidHpMpNumbers();
      push(`[딜 ${r}] bossHp=${state.boss.hp.cur}`);
    }
    const cleared = state.boss.hp.cur <= 0;
    if (cleared) await M.closeClearPopupIfAny();
    return { log, cleared };
  };

  M.runVineWraithMartial = async ({
    maxDefenseTurns = 30,
    maxDealRounds = 20,
  } = {}) => {
    const bossLabel = '지하의 망령';
    const log = [];
    const push = (s) => { log.push(s); if (M.uiLog) M.uiLog(s); };
    const stance = async () => (await M.getValidBossStance(bossLabel)).stance;

    const defenseToAttack = async () => {
      await M.applyBossPreset('수비');
      await M.martialRecover(0.25, push);
      const before = await stance();
      for (let n = 1; n <= maxDefenseTurns; n++) {
        await M.clickTurn(1);
        if ((await stance()) !== before) return true;
      }
      return false;
    };

    const attackToDefense = async () => {
      await M.applyBossPreset('공격');
      await M.martialRecover(0.25, push);
      await M.useScrolls(['방어']);
      const before = await stance();
      await M.clickTurn(5);
      let used = 5;
      while ((await stance()) === before && used < 8) {
        await M.clickTurn(1);
        used++;
      }
      push(`[공격→수비] ${used}턴`);
      return (await stance()) !== before;
    };

    // 첫 사이클: 기력발산 10턴 -> 극딜 5턴 -> 공격+방어스크롤.
    await M.applyBossPreset('기력발산');
    await M.clickTurn(10);
    await M.applyBossPreset('극딜');
    await M.clickTurn(5);
    if (!(await attackToDefense())) return { log, cleared: false, retryRequired: true };
    if (!(await defenseToAttack())) return { log, cleared: false };

    // 공격+집중 3회와 방어 3회를 교대로 사용하면, 첫 방어를 포함해 총 10장.
    for (let cycle = 1; cycle <= 3; cycle++) {
      await M.applyBossPreset('기력발산');
      await M.clickTurn(10);
      await M.martialRecover(0.75, push);
      await M.useScrolls(['공격', '집중']);
      await M.applyBossPreset('극딜');
      await M.clickTurn(5);
      if (!(await attackToDefense())) return { log, cleared: false, retryRequired: true };
      if (!(await defenseToAttack())) return { log, cleared: false };
    }

    await M.applyBossPreset('스크롤 이후');
    let state = await M.getValidHpMpNumbers();
    for (let r = 1; state.boss.hp.cur > 0 && r <= maxDealRounds; r++) {
      await M.martialRecover(0.7, push, false);
      await M.clickTurn(5);
      state = await M.getValidHpMpNumbers();
      push(`[최종 딜 ${r}] bossHp=${state.boss.hp.cur}`);
    }
    const cleared = state.boss.hp.cur <= 0;
    if (cleared) await M.closeClearPopupIfAny();
    return { log, cleared };
  };

  // --- 마술 공통 -------------------------------------------------------------
  M.magicRecover = async (threshold, push = null) => {
    for (let i = 0; i < 10; i++) {
      const state = await M.getValidHpMpNumbers();
      const ratio = state.player.hp.cur / state.player.hp.max;
      if (ratio > threshold) return state;
      await M.clickRecover();
      if (push) push(`내HP ${Math.round(ratio * 100)}% -> 회복`);
    }
    throw new Error(`마술: HP ${Math.round(threshold * 100)}% 안전선 회복 실패`);
  };

  M.runFallenGuardianMagic = async ({
    maxSealRounds = 15,
    maxDealRounds = 30,
    hpThreshold = 0.7,
  } = {}) => {
    const log = [];
    const push = (s) => { log.push(s); if (M.uiLog) M.uiLog(s); };
    const required = ['불굴', '엔드 블로킹'];
    await M.applyBossPreset('봉인');
    let sealed = M.parseSealedAbilities(required);
    for (let r = 1; !required.every((x) => sealed.has(x)) && r <= maxSealRounds; r++) {
      if (M.stopRequested) return { log, cleared: false };
      await M.magicRecover(hpThreshold, push);
      await M.clickTurn(5);
      for (const x of M.parseSealedAbilities(required)) sealed.add(x);
      push(`[봉인 ${r}] ${[...sealed].join(',')}`);
    }
    if (!required.every((x) => sealed.has(x))) return { log, cleared: false };

    await M.applyBossPreset('딜');
    let state = await M.getValidHpMpNumbers();
    let scrollsUsed = 0;
    for (let r = 1; state.boss.hp.cur > 0 && r <= maxDealRounds; r++) {
      await M.magicRecover(hpThreshold, push);
      if (scrollsUsed < 7) {
        await M.useScrolls(['공격']);
        scrollsUsed++;
      }
      await M.clickTurn(5);
      state = await M.getValidHpMpNumbers();
      push(`[딜 ${r}] bossHp=${state.boss.hp.cur}, 공격스크롤=${scrollsUsed}/7`);
    }
    const cleared = state.boss.hp.cur <= 0;
    if (cleared) await M.closeClearPopupIfAny();
    return { log, cleared };
  };

  M.runVoidEmperorMagic = async ({
    maxSealRounds = 15,
    maxManaRounds = 50,
    maxDealRounds = 50,
    hpThreshold = 0.6,
    drainedManaThreshold = 50,
  } = {}) => {
    const log = [];
    const push = (s) => { log.push(s); if (M.uiLog) M.uiLog(s); };
    await M.applyBossPreset('봉인');
    let sealed = M.parseSealedAbilities(['차원왜곡']);
    for (let r = 1; !sealed.has('차원왜곡') && r <= maxSealRounds; r++) {
      await M.magicRecover(hpThreshold, push);
      await M.clickTurn(5);
      for (const x of M.parseSealedAbilities(['차원왜곡'])) sealed.add(x);
    }
    if (!sealed.has('차원왜곡')) return { log, cleared: false };

    await M.applyBossPreset('마나');
    let state = await M.getValidHpMpNumbers();
    for (let r = 1; state.boss.mp.cur > drainedManaThreshold && r <= maxManaRounds; r++) {
      await M.magicRecover(hpThreshold, push);
      await M.clickTurn(state.boss.mp.cur > 300 ? 5 : 1);
      state = await M.getValidHpMpNumbers();
      push(`[마나 ${r}] bossMp=${state.boss.mp.cur}`);
    }
    if (state.boss.mp.cur > drainedManaThreshold) return { log, cleared: false };

    await M.applyBossPreset('딜');
    await M.magicRecover(hpThreshold, push);
    await M.clickTurn(5); // 공속 저하 디버프 해소
    state = await M.getValidHpMpNumbers();
    let scrollsUsed = 0;
    for (let r = 1; state.boss.hp.cur > 0 && r <= maxDealRounds; r++) {
      await M.magicRecover(hpThreshold, push);
      if (scrollsUsed < 7) {
        await M.useScrolls(['공격']);
        scrollsUsed++;
      }
      await M.clickTurn(5);
      state = await M.getValidHpMpNumbers();
      push(`[딜 ${r}] bossHp=${state.boss.hp.cur}, 공격스크롤=${scrollsUsed}/7`);
    }
    const cleared = state.boss.hp.cur <= 0;
    if (cleared) await M.closeClearPopupIfAny();
    return { log, cleared };
  };

  M.runVineEntMagic = async ({
    maxManaRecoveryRounds = 30,
    maxFinalCycles = 30,
    finalHpThreshold = 0.6,
  } = {}) => {
    const log = [];
    const push = (s) => { log.push(s); if (M.uiLog) M.uiLog(s); };
    const candidates = ['노 컨디션', '휘감은 뿌리'];
    let sealed = M.parseSealedAbilities(candidates);
    let burn = false;
    await M.applyBossPreset('봉인');
    for (let used = 0; !sealed.has('휘감은 뿌리') && used < 45; used += 5) {
      await M.clickTurn(5);
      for (const x of M.parseSealedAbilities(candidates)) sealed.add(x);
      if (sealed.has('노 컨디션') && !sealed.has('휘감은 뿌리') && !burn) {
        await M.applyBossPreset('화상');
        burn = true;
      }
    }
    if (!sealed.has('휘감은 뿌리')) {
      push('⛔ 45턴 내 휘감은 뿌리 미봉인 - 재도전');
      return { log, cleared: false, retryRequired: true };
    }

    const recoverMana = async (targetRatio, turnCount) => {
      await M.applyBossPreset('마나회복');
      let state = await M.getValidHpMpNumbers();
      for (let r = 1;
        state.boss.hp.cur > 0 &&
        state.player.mp.cur / state.player.mp.max < targetRatio &&
        r <= maxManaRecoveryRounds;
        r++) {
        await M.clickTurn(turnCount);
        state = await M.getValidHpMpNumbers();
        push(`[마나회복 ${r}] ${Math.round(state.player.mp.cur / state.player.mp.max * 100)}%`);
      }
      return state;
    };

    let state = await M.getValidHpMpNumbers();
    let pairCount = 0;
    while (state.boss.hp.cur > 0 && pairCount < 7) {
      state = await recoverMana(0.8, 5);
      if (state.boss.hp.cur <= 0) break;
      await M.applyBossPreset('딜');
      await M.useScrolls(['공격', '재생']);
      pairCount++;
      await M.clickTurn(5);
      state = await M.getValidHpMpNumbers();
      push(`[공격+재생 ${pairCount}/7] bossHp=${state.boss.hp.cur}`);
    }

    // 7쌍(14장) 뒤 보스가 살아 있으면 마지막 15번째는 공격만 사용한다.
    if (state.boss.hp.cur > 0) {
      state = await recoverMana(0.8, 5);
      if (state.boss.hp.cur > 0) {
        await M.applyBossPreset('딜');
        await M.useScrolls(['공격']);
        await M.clickTurn(5);
        state = await M.getValidHpMpNumbers();
        push(`[마지막 공격스크롤] bossHp=${state.boss.hp.cur}`);
      }
    }

    // 스크롤 이후: 마나회복 세팅으로 1턴씩 MP 60% 확보 후,
    // 딜 세팅에서 HP 60% 초과를 보장하며 MP 30% 이하까지 1턴씩 공격.
    for (let cycle = 1; state.boss.hp.cur > 0 && cycle <= maxFinalCycles; cycle++) {
      state = await recoverMana(0.6, 1);
      if (state.boss.hp.cur <= 0) break;
      await M.applyBossPreset('딜');
      while (state.boss.hp.cur > 0 && state.player.mp.cur / state.player.mp.max > 0.3) {
        state = await M.magicRecover(finalHpThreshold, push);
        await M.clickTurn(1);
        state = await M.getValidHpMpNumbers();
      }
      push(`[후속 ${cycle}] bossHp=${state.boss.hp.cur}, mp=${state.player.mp.cur}`);
    }

    const cleared = state.boss.hp.cur <= 0;
    if (cleared) await M.closeClearPopupIfAny();
    return { log, cleared };
  };

  M.runVineWraithMagic = async () => {
    const message = '마술 망령 공략은 아직 실전 검증 전입니다.';
    if (M.uiLog) M.uiLog(`⛔ ${message}`);
    throw new Error(message);
  };
})();

// ----------------------------------------------------------------------------
// 사용법: lanis.me 접속 시 오른쪽 위에 "🗡 보스 자동화 (참고용)" 라는 작은
// 창이 뜸 (헤더를 드래그해서 위치 이동 가능). 보스 도전 화면에 들어간 뒤
// 원하는 보스 버튼을 누르면 자동으로 진행되고, "정지" 버튼을 누르면 다음
// 턴 진행 전에 멈춤. 기존 "🎯 라니스 통합 매크로" 패널과는 완전히 별개의
// 창이며 서로 간섭하지 않음.
// ----------------------------------------------------------------------------
