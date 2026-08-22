// ==UserScript==
// @name         lanis
// @namespace    lanis
// @version      1.16.1-stable
// @description  재전직 / 유물 자동각인 / 자동사냥 / 레어맵 / 던전 / 아레나 / 심층던전 / 개인 보스 / 일일 연속 자동화를 하나의 패널에서 제공하며 각 모듈의 실행 로직은 독립적으로 격리.
// @match        https://lanis.me/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Ke9318/lanis/main/lanis.user.js
// @downloadURL  https://raw.githubusercontent.com/Ke9318/lanis/main/lanis.user.js
// ==/UserScript==

// Ranis Shared Core 1.0.0
// Generated deterministically from src/normal and src/boss.
(function (global) {
  'use strict';
  if (global.__lanisSharedCoreBootstrap) return;
  global.__lanisSharedCoreBootstrap = function (options = {}) {
    if (global.__lanisSharedCoreAdapter) {
      if (options.mode !== 'headless') {
        global.__lanisSharedCoreOptions = Object.freeze({ mode: 'manual', version: '1.0.0' });
        global.__mountLanisUnifiedPanel?.();
        global.__mountLanisBossTool?.();
      }
      return global.__lanisSharedCoreAdapter;
    }
    global.__lanisSharedCoreOptions = Object.freeze({ mode: options.mode === 'headless' ? 'headless' : 'manual', version: '1.0.0' });
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
    dailyActive: false,
    moduleResults: {},
    // Chrome이 메모리 절약으로 탭을 폐기했다가 복원한 경우에만 안전한
    // 체크포인트 재개를 허용한다. 사용자의 일반 새로고침과는 명확히 구분한다.
    wasDiscarded: document.wasDiscarded === true,
  };
  window.__lanisWasDiscarded = Core.wasDiscarded;

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
          clearTimeout(item.fallbackTimer);
          item.resolve();
        }
      };
      worker.onerror = function (event) {
        workerFailed = true;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        for (const item of pending.values()) {
          clearTimeout(item.fallbackTimer);
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
          // Worker가 오류 이벤트도 없이 멎는 경우를 대비한다. 일반 타이머도
          // 숨은 탭에서 늦어질 수 있지만, 탭이 다시 살아나는 순간에는 둘 중
          // 먼저 도착한 쪽이 Promise를 반드시 해제한다.
          const finish = () => {
            const item = pending.get(id);
            if (!item) return;
            pending.delete(id);
            item.resolve();
          };
          const fallbackTimer = setTimeout(finish, Math.max(0, ms) + 5000);
          pending.set(id, { resolve, ms, startedAt: Date.now(), fallbackTimer });
          try {
            worker.postMessage({ id, ms });
          } catch (e) {
            clearTimeout(fallbackTimer);
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
  Core.interruptibleSleep = async function (
    ms,
    shouldCancel = Core.defaultShouldCancel,
    chunkMs = 400
  ) {
    const deadline = Date.now() + Math.max(0, ms);
    while (Date.now() < deadline) {
      if (shouldCancel && shouldCancel()) return false;
      await Core.sleep(Math.min(chunkMs, deadline - Date.now()));
    }
    return !(shouldCancel && shouldCancel());
  };
  // 보스 엔진도 동일한 스케줄러를 사용한다. 두 Worker/오디오 구현이 서로
  // 다른 상태로 멎는 구조를 피하고 한 곳에서 상태를 관리한다.
  window.__lanisBackgroundSleep = Core.sleep;
  Core.rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  Core.humanDelay = (minMs, maxMs) => Core.sleep(minMs + Math.random() * (maxMs - minMs));
  // Fisher–Yates shuffle. 원본 배열은 건드리지 않고 새 배열을 반환한다.
  // (sort(() => Math.random() - 0.5) 방식은 비교 함수 특성상 분포가 고르지
  // 않다고 알려져 있어 이 방식을 쓴다.)
  Core.shuffleArray = function (arr) {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  };

  Core.isRunCancelled = function (moduleId, runId) {
    if (!moduleId) return false;
    const mod = Modules[moduleId];
    return !mod || !mod.running || mod.stopRequested || (runId !== undefined && mod.runId !== runId);
  };

  Core.defaultShouldCancel = function () {
    const ctx = Core.runContext;
    return !!ctx && Core.isRunCancelled(ctx.moduleId, ctx.runId);
  };

  Core._bodyTextCache = { at: 0, value: '' };
  Core.bodyText = function () {
    const now = performance.now();
    if (now - Core._bodyTextCache.at < 25) return Core._bodyTextCache.value;
    // innerText는 전체 페이지 레이아웃을 강제로 계산한다. 숨은 탭에서 이
    // 계산이 지연되거나 오래된 결과를 줄 수 있으므로 텍스트 노드를 직접
    // 수집한다. 매크로 GUI·스크립트·숨김 DOM은 제외한다.
    const chunks = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      const parent = textNode.parentElement;
      if (!parent) continue;
      if (parent.closest(
        '#lrm-panel, #lrm-banner, #lrm-boss-ref-panel, script, style, noscript, template, [hidden], [aria-hidden="true"]'
      )) continue;
      const value = (textNode.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (value) chunks.push(value);
    }
    const value = `\n${chunks.join('\n')}\n`;
    Core._bodyTextCache = { at: now, value };
    return value;
  };

  Core.allButtons = function () {
    return Array.from(document.querySelectorAll('button')).filter(
      (b) => !b.closest('#lrm-panel') && !b.closest('#lrm-banner')
    );
  };

  Core.findButtonByText = function (text) {
    return Core.allButtons().find(
      (b) => b.textContent.trim() === text && (!Core.isElementVisible || Core.isElementVisible(b))
    ) || null;
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
    const startedAt = Date.now();
    const maxThrottleAllowance = Math.min(Math.max(timeoutMs, 0), 30000);
    let throttleAllowance = 0;
    let lastTick = Date.now();
    while (true) {
      const now = Date.now();
      const delayedBy = now - lastTick;
      // 숨은 탭이라는 이유만으로 매 반복마다 전체 지연 시간을 더하면
      // deadline도 같은 속도로 밀려 조건이 영원히 충족되지 않는 무한 대기가
      // 된다. 실제 콜백이 비정상적으로 늦게 도착한 초과분만, 최대 30초까지
      // 제한적으로 보정한다.
      const throttleThreshold = Math.max(1200, intervalMs * 4);
      if (delayedBy > throttleThreshold && throttleAllowance < maxThrottleAllowance) {
        const excessDelay = Math.max(0, delayedBy - intervalMs);
        throttleAllowance += Math.min(excessDelay, maxThrottleAllowance - throttleAllowance);
      }
      lastTick = now;
      if (shouldCancel && shouldCancel()) return null;
      let result = null;
      try {
        result = await fn();
      } catch (e) {
        result = null;
      }
      if (result) return result;
      // 장시간 숨김 뒤 깨어났을 때는 화면이 이미 준비됐을 수 있다. 조건을
      // 한 번 확인한 뒤에만 제한시간 만료를 적용한다.
      if (now - startedAt >= timeoutMs + throttleAllowance) break;
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
        if (!(await Core.interruptibleSleep(3000, shouldCancel))) return null;
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
        if (!(await Core.interruptibleSleep(waitMs, shouldCancel))) return null;
      }
    }
    return null;
  };

  Core.resolveClickable = function (target) {
    return typeof target === 'function' ? target() : target;
  };

  // ⚠ 실전 확인(2026-08): 인벤토리 카테고리 필터(MUI ToggleButtonGroup)
  // 버튼은 프로그래밍적 el.click()에 신뢰할 수 없게 반응한다 - 통제된
  // 테스트에서 el.click()을 여러 번 호출해도 aria-pressed가 전혀 안
  // 바뀌었는데, 좌표 기반 실제 클릭이나 이 함수처럼 마우스 이벤트
  // 시퀀스(pointerdown→mousedown→pointerup→mouseup→click)를 직접
  // 디스패치하면 즉시 정상 반영됨을 확인했다. 이게 원인이 되어 "보상"
  // 카테고리만 켜려다 "연금"을 끄지 못하고 함께 켜진 채로 남는 사고가
  // 있었다(사용자가 실전에서 직접 목격). el.click()이 불안정한 컴포넌트
  // (특히 MUI ToggleButton류)에 대해 이 함수를 사용한다.
  Core.dispatchRealClick = function (el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  };

  Core.isElementVisible = function (el) {
    if (!el || !el.isConnected) return false;
    // 닫힌 메뉴·이전 모달의 자식은 자기 display가 block이어도 조상이
    // 숨겨져 있을 수 있으므로 조상까지 확인한다.
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return false;
    }
    // Chrome이 백그라운드/최소화 탭의 레이아웃 계산을 생략하면 실제 버튼도
    // rect가 0개로 보고된다. 숨은 탭에서는 CSS/aria 상태를 신뢰하고,
    // 포그라운드에서만 rect 검사를 추가한다.
    return document.hidden || el.getClientRects().length > 0;
  };

  // ⚠ 사용자 제보: 아이템/포션 사용 확인 팝업을 닫고 바로 다음
  // 단계로 넘어가면, 닫히는 애니메이션이나 MUI의 aria-hidden 제거가
  // 다 지나기 전에 다음 화면 조작이 시작될 수 있다. 그러면 배경(상단 네비
  // 포함)이 여전히 aria-hidden 처리된 채로 남아 있어, 바로 다음에 찾는 버튼이
  // "보이지 않는" 것으로 판정되는 간헐적 오류가 있었다(재전직 모듈에서 실전
  // 확인됨). 모든 다이얼로그 사용 후에는 이 함수로 실제로 닫혔는지 확인하고 넘어가야
  // 한다.
  Core.waitForNoOpenDialog = async function (timeoutMs = 8000) {
    // ⚠ 실전 확인(진단 스크립트로 직접 잡음): "캐릭" 상단 메뉴 드롭다운이 열려 있는
    // 동안은 MUI가 버튼 자체에 aria-hidden="true"를 걸어버려(메뉴가 정상적으로
    // 열려 있는 동안은 정상), 만약 메뉴 항목 클릭이 제대로 없어졌거나 페이지
    // 전환이 실패해 메뉴가 안 닫힌 채 남으면, 다음 사이클에서 "캐릭"을 다시
    // 찾을 때 계속 aria-hidden으로 외면에 걸린다. 그런데 이 드롭다운 컴테이너는
    // role="dialog"가 아니라 role="menu"/"presentation"이라 기존 체크(오직 dialog만 보던)가
    // 이 상황을 전혀 놓치고 있었다. 이제 dialog/menu/presentation 모두 확인한다.
    return Core.waitFor(() => {
      const openDialogs = [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="presentation"]')].filter(
        (d) => Core.isElementVisible(d)
      );
      return openDialogs.length === 0 ? true : null;
    }, timeoutMs, 300);
  };

  Core.safeClick = async function (
    target,
    {
      beforeMin = 500,
      beforeMax = 1300,
      afterMin = 0,
      afterMax = 0,
      shouldCancel = Core.defaultShouldCancel,
      afterCheck = null,
      afterTimeout = 8000,
    } = {}
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
      !Core.isElementVisible(el)
    ) return false;
    el.click();
    if (afterMax > 0) await Core.humanDelay(afterMin, afterMax);
    if (afterCheck) {
      const confirmed = await Core.waitFor(afterCheck, afterTimeout, 200, shouldCancel);
      if (!confirmed) return false;
    }
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

  Core.clickNavMenuExact = async function (
    navLabel,
    itemText,
    shouldCancel = Core.defaultShouldCancel,
    { nav = { min: 500, max: 1000 }, item = { min: 500, max: 1300 } } = {}
  ) {
    // ⚠ 실전 확인(진단 스크립트로 직접 잡음): 이전 사이클에서 상단 메뉴가 안
    // 닫힌 채 남아있으면, 그 동안 동작하는 MUI 메뉴 트리거(이 경우 "${navLabel}")
    // 자체가 aria-hidden="true"로 가려져 버려(정상적인 메뉴-열림 동작), 그 버튼을
    // 다시 찾는 건 언제까지나 실패한다. 그리고 합성 클릭/ESC로는 MUI의
    // ClickAwayListener가 메뉴를 절대 닫지 않는다(실전 확인됨 - isTrusted 이벤트만
    // 반응). 대신 메뉴 항목(itemText) 자체는 메뉴가 열려있는 동안에도 정상적으로
    // 클릭 가능함을 실전에서 확인했다. 그래서 먼저 원하는 메뉴 항목이 이미
    // 화면에 뜵지(이전 사이클의 메뉴가 안 닫힌 상태) 확인하고, 뜵으면 "${navLabel}"를
    // 아예 누르지 않고 바로 항목을 클릭한다.
    const findItem = () => [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent.trim() === itemText && Core.isElementVisible(el)
    ) || null;
    const openFresh = async () => {
      const navBtn = await Core.waitFor(
        () => Core.findButtonByText(navLabel),
        15000,
        300,
        shouldCancel
      );
      if (!navBtn) throw new Error(`상단 메뉴 "${navLabel}" 버튼을 찾을 수 없음`);
      if (!(await Core.safeClick(() => Core.findButtonByText(navLabel), {
        beforeMin: nav.min,
        beforeMax: nav.max,
        shouldCancel,
      }))) {
        throw new Error(`상단 메뉴 "${navLabel}" 버튼이 클릭 직전에 사라짐`);
      }
      const itemEl = await Core.waitFor(findItem, 15000, 300, shouldCancel);
      if (!itemEl) throw new Error(`메뉴 항목 "${itemText}"를 찾을 수 없음`);
      if (!(await Core.safeClick(findItem, { beforeMin: item.min, beforeMax: item.max, shouldCancel }))) {
        throw new Error(`메뉴 항목 "${itemText}"가 클릭 직전에 사라짐`);
      }
    };
    // 이전 화면 전환 중 남아있던 메뉴 항목은 클릭하는 순간 스스로 닫혀
    // 사라질 수 있다. 그 첫 시도가 실패해도 곧장 예외를 던지지 않고,
    // "캐릭" 버튼을 새로 눌러 메뉴를 여는 정상 경로로 재시도한다.
    if (findItem() && (await Core.safeClick(findItem, { beforeMin: item.min, beforeMax: item.max, shouldCancel }))) return;
    await openFresh();
  };

  Core.clickNavMenuSuffix = async function (
    navLabel,
    suffixText,
    shouldCancel = Core.defaultShouldCancel,
    { nav = { min: 500, max: 1000 }, item = { min: 500, max: 1300 } } = {}
  ) {
    // ⚠ clickNavMenuExact와 동일한 이유로 메뉴 항목이 이미 열려있는지 먼저 확인한다.
    const findItem = () => [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent.trim().endsWith(suffixText) && Core.isElementVisible(el)
    ) || null;
    const openFresh = async () => {
      const navBtn = await Core.waitFor(
        () => Core.findButtonByText(navLabel),
        15000,
        300,
        shouldCancel
      );
      if (!navBtn) throw new Error(`상단 메뉴 "${navLabel}" 버튼을 찾을 수 없음`);
      if (!(await Core.safeClick(() => Core.findButtonByText(navLabel), {
        beforeMin: nav.min,
        beforeMax: nav.max,
        shouldCancel,
      }))) {
        throw new Error(`상단 메뉴 "${navLabel}" 버튼이 클릭 직전에 사라짐`);
      }
      const itemEl = await Core.waitFor(findItem, 15000, 300, shouldCancel);
      if (!itemEl) throw new Error(`메뉴 항목("...${suffixText}")을 찾을 수 없음`);
      if (!(await Core.safeClick(findItem, { beforeMin: item.min, beforeMax: item.max, shouldCancel }))) {
        throw new Error(`메뉴 항목("...${suffixText}")이 클릭 직전에 사라짐`);
      }
    };
    // clickNavMenuExact와 동일한 이유로, 재사용하려던 메뉴 항목의 첫 클릭이
    // 실패해도 곧장 실패 처리하지 않고 메뉴를 새로 열어 재시도한다.
    if (findItem() && (await Core.safeClick(findItem, { beforeMin: item.min, beforeMax: item.max, shouldCancel }))) return;
    await openFresh();
  };

  // ---------------- 공용 프리셋 적용 (던전·자동사냥·심층던전 공용) ----------------
  Core.classifyPresetApplyNotice = function (text, presetName, isExplicitNotice = false) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    const hasPresetContext =
      normalized.includes(presetName) ||
      normalized.includes('프리셋') ||
      isExplicitNotice;
    if (!hasPresetContext) return null;

    // 실패 문구를 성공보다 먼저 검사한다. "적용하지 못했습니다" 같은 응답을
    // "적용했습니다"의 변형으로 잘못 승인하면 잘못된 장비로 다음 작업을 시작한다.
    if (
      /(?:실패|오류|적용하지\s*못|불러오지\s*못|적용할\s*수\s*없)/.test(normalized)
    ) return 'failure';
    if (
      /(?:적용했습니다|적용되었습니다|적용\s*완료|불러왔습니다|불러오기\s*완료)/.test(normalized)
    ) return 'success';
    return null;
  };

  Core.applyCommonPreset = async function (presetName, moduleId) {
    await Core.clickNavMenuExact('캐릭', '프리셋');
    const pageReady = await Core.waitFor(
      () => Core.bodyText().includes('공용 프리셋') && Core.bodyText().includes('현재 상태 저장'),
      15000,
      300
    );
    if (!pageReady) throw new Error('공용 프리셋 화면 진입을 확인하지 못했습니다.');

    const findPresetCard = () => {
      const nameLeaf = Core.gameElements('*').find(
        (el) => el.children.length === 0 && el.textContent.trim() === presetName
      );
      if (!nameLeaf) return null;
      let node = nameLeaf.parentElement;
      for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        const applyButtons = [...node.querySelectorAll('button')].filter(
          (button) => button.textContent.trim() === '적용'
        );
        const hasManagementButtons = [...node.querySelectorAll('button')].some(
          (button) => button.textContent.trim() === '전체 갱신'
        );
        if (applyButtons.length === 1 && hasManagementButtons) {
          return { card: node, button: applyButtons[0] };
        }
      }
      return null;
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const preset = await Core.waitFor(findPresetCard, 5000, 250);
      if (!preset) {
        throw new Error(`공용 프리셋 "${presetName}"을 찾지 못했습니다. 캐릭 → 프리셋에서 먼저 만들어주세요.`);
      }
      let confirmationMutated = false;
      let confirmationFailureText = '';
      const observer = new MutationObserver((records) => {
        const noticeSelector =
          '[role="alert"], [role="status"], .MuiSnackbar-root, .MuiAlert-root, ' +
          '[class*="toast" i], [class*="snackbar" i], [class*="alert" i]';
        for (const record of records) {
          // childList의 record.target은 흔히 document.body다. 여기에 페이지의
          // 프리셋 이름과 예전 알림 문구를 합쳐 읽으면 새 성공 알림으로 오인한다.
          // 클릭 후 실제로 추가·변경된 노드만 검사한다.
          const nodes = [
            ...record.addedNodes,
            ...(record.type === 'characterData' ? [record.target] : []),
          ];
          for (const node of nodes) {
            const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
            if (
              !el ||
              !el.closest ||
              el.closest('#lrm-panel, #lrm-banner, #lrm-boss-ref-panel')
            ) continue;

            const explicitNotices = [];
            const closestNotice = el.closest(noticeSelector);
            if (closestNotice) explicitNotices.push(closestNotice);
            if (el.matches && el.matches(noticeSelector)) explicitNotices.push(el);
            if (el.querySelectorAll) {
              explicitNotices.push(...el.querySelectorAll(noticeSelector));
            }
            const candidates = explicitNotices.length > 0
              ? [...new Set(explicitNotices)]
              : [el];

            for (const candidate of candidates) {
              const text = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
              // 해시 클래스의 커스텀 토스트는 role/class 표식이 없을 수 있다.
              // 정확한 프리셋 카드의 적용 버튼을 누른 직후 새로 추가된 짧은
              // 노드라면 알림으로 취급하되, 페이지 전체처럼 큰 노드는 배제한다.
              const isExplicitNotice =
                explicitNotices.includes(candidate) ||
                (candidate === el && text.length > 0 && text.length <= 300);
              const verdict = Core.classifyPresetApplyNotice(
                text,
                presetName,
                isExplicitNotice
              );
              if (verdict === 'failure') {
                confirmationFailureText = text;
                break;
              }
              if (verdict === 'success') {
                confirmationMutated = true;
                break;
              }
            }
            if (confirmationMutated || confirmationFailureText) break;
          }
          if (confirmationMutated || confirmationFailureText) break;
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      let clicked = false;
      try {
        clicked = await Core.safeClick(() => {
          const current = findPresetCard();
          return current ? current.button : null;
        }, { beforeMin: 650, beforeMax: 1100, afterMin: 100, afterMax: 250 });
      } finally {
        if (!clicked) observer.disconnect();
      }
      if (!clicked) throw new Error(`공용 프리셋 "${presetName}" 적용 버튼 클릭에 실패했습니다.`);
      let confirmed = null;
      try {
        confirmed = await Core.waitFor(
          // 정확한 카드의 적용 버튼을 누른 뒤 발생한 새 알림만 인정한다.
          // 알림 자체가 이름을 생략해도 클릭 대상과 시간 상관관계로 안전하게
          // 확인하며, 게임이 명시한 실패 알림은 즉시 중단한다.
          () => confirmationMutated || confirmationFailureText || null,
          5000,
          150
        );
      } finally {
        observer.disconnect();
      }
      if (confirmationFailureText) {
        throw new Error(
          `공용 프리셋 "${presetName}" 적용을 게임이 거부했습니다: ${confirmationFailureText}`
        );
      }
      if (confirmed) {
        Core.log(moduleId, `공용 프리셋 "${presetName}" 적용 확인`);
        return true;
      }
      if (attempt < 2) {
        Core.log(moduleId, `공용 프리셋 "${presetName}" 적용 확인 실패 (${attempt}/2) → 재시도`);
        await Core.humanDelay(500, 900);
      }
    }
    throw new Error(`공용 프리셋 "${presetName}" 적용 결과를 확인하지 못했습니다.`);
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

  // ⚠ 사용자 요청(2026-08): 보스/던전 클리어 보상으로 쌓이는 "N의 보상
  // (난이도)" 상자를 전부 사용한다. 인벤토리 소모품 카테고리 필터는 여러
  // 개를 동시에 켤 수 있는 다중 토글이라(실전 확인됨), 이전에 다른 필터가
  // 켜져 있으면 그 카테고리 아이템까지 섞여 보인다. "보상" 상자를 열면
  // "상급 유물 상자" 같은 완전히 다른 카테고리("상자") 아이템이 나오므로,
  // 반드시 "보상" 하나만 켜고 나머지는 전부 꺼서 엉뚱한 아이템의 "사용"을
  // 누르지 않도록 한다.
  Core.selectOnlyInventoryCategory = async function (categoryLabel, moduleId) {
    const toggleLabels = ['연금', '책', '보상', '상자', '지도', '기타'];
    for (const label of toggleLabels) {
      const shouldBePressed = label === categoryLabel;
      for (let attempt = 0; attempt < 3; attempt++) {
        const btn = Core.findButtonByText(label);
        if (!btn) break;
        const pressed = btn.getAttribute('aria-pressed') === 'true';
        if (pressed === shouldBePressed) break;
        await Core.humanDelay(300, 600);
        // ⚠ 실전 확인(2026-08): 이 버튼(MUI ToggleButtonGroup)은 일반
        // el.click()(Core.safeClick 내부)에 반응 안 할 때가 있다 - 반드시
        // 실제 마우스 이벤트 시퀀스로 클릭하고, 매번 실제로 반영됐는지
        // 재확인해서 안 됐으면 재시도한다.
        Core.dispatchRealClick(btn);
        await Core.humanDelay(400, 700);
        const nowPressed = Core.findButtonByText(label)?.getAttribute('aria-pressed') === 'true';
        if (nowPressed === shouldBePressed) break;
        if (attempt === 2) {
          throw new Error(`인벤토리 필터 "${label}" 상태 변경에 실패했습니다(3회 시도).`);
        }
      }
    }
    Core.log(moduleId, `인벤토리 필터를 "${categoryLabel}"만 켜진 상태로 정렬 완료`);
  };

  Core.useAllRewardBoxes = async function (moduleId) {
    await Core.goToCharacterPage('인벤토리', '/inventory');
    const consumableTab = await Core.waitFor(
      () => Core.gameElements('[role="tab"], button').find(
        (el) => el.textContent.trim() === '소모품' && Core.isElementVisible(el)
      ),
      8000, 250
    );
    if (!consumableTab) throw new Error('인벤토리 소모품 탭을 찾지 못했습니다.');
    if (!(await Core.safeClick(() => consumableTab, { beforeMin: 500, beforeMax: 900, afterMin: 600, afterMax: 1000 }))) {
      throw new Error('소모품 탭을 열지 못했습니다.');
    }

    // 반드시 "보상"만 켜서, 상자를 열었을 때 생기는 "상급 유물 상자" 같은
    // 다른 카테고리 아이템이 목록에 섞이지 않게 한다.
    await Core.selectOnlyInventoryCategory('보상', moduleId);

    let used = 0;
    const maxAttempts = 50;
    for (let i = 0; i < maxAttempts; i++) {
      // ⚠ 버그 수정(2026-08, 사용자 확인): 실전에서 "보상" 카테고리 상자를
      // 여러 개 연속으로 사용하던 도중 필터가 "연금" 카테고리로 바뀐 채
      // 멈추는 사고가 있었다(정확한 계기는 특정 못함 - 게임 화면 자체의
      // 리렌더링/카테고리 토글 상태 변경일 가능성). 한 번만 설정하고 끝까지
      // 믿는 대신, 매 반복 시작 시 "보상" 버튼이 실제로 눌려있는지 빠르게
      // 확인하고 아니면 다시 정렬한다 - 어떤 이유로 필터가 흐트러져도 다음
      // 아이템을 열기 전에 스스로 바로잡는다.
      const rewardTabBtn = Core.findButtonByText('보상');
      if (!rewardTabBtn || rewardTabBtn.getAttribute('aria-pressed') !== 'true') {
        Core.log(moduleId, '⚠ "보상" 카테고리 필터가 풀려있어 다시 정렬합니다.');
        await Core.selectOnlyInventoryCategory('보상', moduleId);
      }

      let row = Core.gameElements('tr').find(
        (tr) =>
          [...tr.querySelectorAll('button')].some((b) => b.textContent.trim() === '사용') &&
          Core.isElementVisible(tr)
      );
      // ⚠ 버그 수정(2026-08, 사용자 확인): 보상 상자 종류가 많으면(실전 확인:
      // 완성된 이면의 보상/완성된 지하의 보상/이면의 보상/지하의 보상/
      // 지하의 보상(매우어려움) 등 5종류 이상) 목록이 여러 페이지로 나뉘는데,
      // 예전엔 현재 페이지에서 "사용" 행을 못 찾으면 곧바로 멈춰서 다음
      // 페이지에 남은 상자를 전혀 까지 못했다. 다음 페이지로 넘겨서 한 번 더
      // 찾아본다.
      if (!row) {
        const nextPageBtn = Core.gameElements('button').find(
          (b) => b.getAttribute('aria-label') === 'Go to next page' && !b.disabled && Core.isElementVisible(b)
        );
        if (!nextPageBtn) break;
        nextPageBtn.click();
        await Core.humanDelay(500, 800);
        row = Core.gameElements('tr').find(
          (tr) =>
            [...tr.querySelectorAll('button')].some((b) => b.textContent.trim() === '사용') &&
            Core.isElementVisible(tr)
        );
        if (!row) break;
      }
      const useBtn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용');
      if (!(await Core.safeClick(() => useBtn, { beforeMin: 500, beforeMax: 900 }))) {
        throw new Error('보상 상자 "사용" 버튼 클릭에 실패했습니다.');
      }
      const dialog = await Core.waitFor(() => {
        const d = Core.gameElements('[role="dialog"]').find(
          (el) => el.textContent.includes('아이템 사용 확인') && Core.isElementVisible(el)
        );
        return d || null;
      }, 6000, 250);
      if (!dialog) throw new Error('보상 상자 사용 확인창을 찾지 못했습니다.');

      // ⚠ 버그 수정(2026-08, 실전 확인): 다이얼로그를 열면 수량 입력칸이 이미
      // "보유 수량 전체"로 자동 채워져 있다. 예전에는 "최대 10개까지일 수
      // 있으니 방어적으로 10을 강제로 넣는다"는 로직이 있었는데, 보유 수량이
      // 10보다 적으면(예: 2개) 유효하지 않은 값이 되어 "사용" 버튼이
      // disabled로 막혀버렸다(실전에서 confirmBtnDisabled=true로 직접 확인).
      // 이 때문에 확인창이 닫히지 않고 계속 열려 있어서, 뒤이은 자동사냥/
      // 심층던전/아레나 단계가 전부 "상단 메뉴 버튼을 찾을 수 없음"으로
      // 실패했다(모달이 화면을 덮고 있었기 때문). 수량 입력은 절대 건드리지
      // 않고 기본값(보유 수량 전체) 그대로 확정한다.
      const confirmBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용');
      if (!confirmBtn) throw new Error('보상 상자 사용 확인 버튼을 찾지 못했습니다.');
      if (confirmBtn.disabled) throw new Error('보상 상자 사용 확인 버튼이 비활성화 상태입니다.');
      if (!(await Core.safeClick(() => confirmBtn, { beforeMin: 600, beforeMax: 1100, afterMin: 900, afterMax: 1400 }))) {
        throw new Error('보상 상자 사용을 확정하지 못했습니다.');
      }
      used++;
      Core.log(moduleId, `보상 상자 사용 ${used}개째 완료`);

      // ⚠ 상자를 하나 쓰면 그 종류가 목록에서 통째로 사라지거나 수량이
      // 바뀌면서 페이지 구성이 흔들릴 수 있다. 안전하게 1페이지로 되돌아가
      // 처음부터 다시 "사용" 가능한 행을 찾는다(페이지네이션이 없으면
      // 이 클릭은 그냥 아무 효과 없이 넘어감).
      const firstPageBtn = Core.gameElements('button').find(
        (b) => b.getAttribute('aria-label') === 'Go to first page' && !b.disabled && Core.isElementVisible(b)
      );
      if (firstPageBtn) {
        firstPageBtn.click();
        await Core.humanDelay(300, 500);
      }
    }
    if (used > 0) {
      Core.log(moduleId, `보상 상자 사용 완료: 총 ${used}개`);
    } else {
      Core.log(moduleId, '사용할 보상 상자가 없습니다.');
    }
    return used;
  };

  // 인벤토리 소모품 탭을 열어 targetElement의 돌 "사용" 버튼을 찾는다.
  // 페이지네이션까지 뒤진다. 못 찾으면 null.
  Core.findElementStoneUseButton = async function (targetElement) {
    const stoneName = `${targetElement}의 돌`;
    const consumableTab = await Core.waitFor(
      () =>
        Core.gameElements('[role="tab"], button').find(
          (el) => el.textContent.trim() === '소모품' && Core.isElementVisible(el)
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
        (tr) => tr.textContent.includes(stoneName) && Core.isElementVisible(tr)
      );
      if (row) {
        useButton =
          [...row.querySelectorAll('button')].find(
            (button) =>
              ['사용', '사용하기'].includes(button.textContent.trim()) &&
              Core.isElementVisible(button)
          ) || null;
        break;
      }
      const next = Core.gameElements('button').find(
        (button) =>
          button.getAttribute('aria-label') === 'Go to next page' &&
          !button.disabled &&
          Core.isElementVisible(button)
      );
      if (!next) break;
      if (!(await Core.safeClick(next, { beforeMin: 500, beforeMax: 900, afterMin: 650, afterMax: 1100 }))) break;
    }
    return useButton;
  };

  Core.useElementStone = async function (targetElement, moduleId) {
    const stoneName = `${targetElement}의 돌`;
    await Core.goToCharacterPage('인벤토리', '/inventory');

    let useButton = await Core.findElementStoneUseButton(targetElement);

    // ⚠ 사용자 요청(2026-08): 인벤토리에 없으면 그냥 멈추던 것을, 속성에 맞는
    // 마을로 이동해 상점에서 사 온 뒤 다시 찾도록 확장. 실전 확인된 구매 흐름
    // (마을 이동 → 아이템 상점 → 기타 탭 → 구매 → 확인)을 그대로 재사용함.
    if (!useButton) {
      Core.log(moduleId, `인벤토리에 "${stoneName}"이 없음 → 상점에서 구매 시도`);
      await Core.buyElementStoneAtTown(targetElement, moduleId);
      await Core.goToCharacterPage('인벤토리', '/inventory');
      useButton = await Core.findElementStoneUseButton(targetElement);
    }
    if (!useButton) throw new Error(`상점 구매 후에도 인벤토리에서 "${stoneName}"을 찾지 못했습니다.`);

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

  // ⚠ 사용자 요청(2026-08): 속성의 돌이 인벤토리에 없으면 그냥 멈추던 것을,
  // 속성에 맞는 마을로 이동해 상점에서 사 오는 로직으로 확장한다. 실전 확인된
  // 매핑(번대 대기 화면에서 각 마을을 직접 클릭해 속성을 확인함):
  //   불=베곤, 물=피렌트, 번개=심포니아, 바람=카웬, 별=포트스미스,
  //   빛=에렌시아, 어둠=데자브
  Core.ELEMENT_TO_TOWN = {
    불: '베곤',
    물: '피렌트',
    번개: '심포니아',
    바람: '카웬',
    별: '포트스미스',
    빛: '에렌시아',
    어둠: '데자브',
  };

  // 현재 위치한 마을 이름을 읽는다. 이동 없이 관찰만 한다(/town-move 페이지에
  // 가야 한다). 특정 페이지에 있을 필요 없이 한 곳에서 바로 불러서 읽을 수
  // 있도록, 상태를 복원하지 않고 /town-move로 잠시 갔다 오는 방식을 쓴다.
  Core.readCurrentTown = async function (moduleId) {
    if (location.pathname.replace(/\/$/, '') !== '/town-move') {
      await Core.clickNavMenuExact('마을', '마을 이동');
      const arrived = await Core.waitFor(
        () => location.pathname.replace(/\/$/, '') === '/town-move',
        10000,
        250
      );
      if (!arrived) throw new Error('마을 이동 화면으로 진입하지 못했습니다.');
    }
    // ⚠ 실전 확인: "현재 위치는 X (a, b) 입니다." 문구는 안내 문장과 한
    // <p> 안에 <br>로 붙어 있어(리프 노드가 아님), leaf 기준 검색으로는
    // 못 찾는다. includes로 후보를 찾고 그중 가장 작은(자식 적은) 요소의
    // textContent에서 정규식으로 직접 추출한다.
    const match = await Core.waitFor(() => {
      const candidates = Core.gameElements('*').filter((e) => e.textContent.includes('현재 위치는'));
      if (!candidates.length) return null;
      const smallest = candidates.reduce(
        (best, el) =>
          !best || el.querySelectorAll('*').length < best.querySelectorAll('*').length ? el : best,
        null
      );
      return smallest.textContent.match(/현재 위치는\s*(\S+)\s*\(/);
    }, 8000, 250);
    if (!match) throw new Error('현재 위치 텍스트를 찾지 못했습니다.');
    return match[1];
  };

  // 지도에서 마을 하나를 클릭해 상세 패널을 열고, "이 마을로 이동" 버튼을
  // 누른다. /town-move에 이미 있다는 것이 전제이므로, readCurrentTown 호출
  // 직후에만 쓰이도록 설계함.
  Core.clickTownOnMap = async function (townName) {
    const candidates = Core.gameElements('*').filter(
      (e) => e.textContent.trim() === townName
    );
    // 가장 작은(자식 수가 적은) 후보가 실제 라벨 요소임.
    const labelEl = candidates.reduce(
      (best, el) =>
        !best || el.querySelectorAll('*').length < best.querySelectorAll('*').length ? el : best,
      null
    );
    if (!labelEl) throw new Error(`지도에서 마을 "${townName}"을 찾지 못했습니다.`);
    // 실전 확인: 라벨(span) 자체가 아니라 그 조상(depth 2) 노드가 클릭 가능함.
    let clickTarget = labelEl;
    for (let i = 0; i < 2 && clickTarget.parentElement; i++) clickTarget = clickTarget.parentElement;
    if (!(await Core.safeClick(() => clickTarget, { beforeMin: 400, beforeMax: 800 }))) {
      throw new Error(`마을 "${townName}" 클릭에 실패했습니다.`);
    }
    const moveBtn = await Core.waitFor(
      () => Core.findButtonByText('이 마을로 이동'),
      6000,
      250
    );
    if (!moveBtn) throw new Error(`"${townName}" 상세 패널에서 "이 마을로 이동" 버튼을 찾지 못했습니다.`);
    if (!(await Core.safeClick(() => Core.findButtonByText('이 마을로 이동'), { beforeMin: 500, beforeMax: 1000 }))) {
      throw new Error(`"${townName}"(으)로 이동 버튼 클릭에 실패했습니다.`);
    }
    const arrived = await Core.waitFor(
      () => location.pathname.replace(/\/$/, '') === '/game',
      10000,
      250
    );
    if (!arrived) throw new Error(`"${townName}"(으)로 이동 후 도착 확인 실패`);
    await Core.humanDelay(500, 1000);
  };

  // 목표 속성에 필요한 마을에 지금 있는지 확인하고, 아니면 이동한다.
  Core.ensureCurrentTownForElement = async function (targetElement, moduleId) {
    const requiredTown = Core.ELEMENT_TO_TOWN[targetElement];
    if (!requiredTown) throw new Error(`속성 "${targetElement}"에 대응하는 마을 정보가 없습니다.`);
    const current = await Core.readCurrentTown(moduleId);
    if (current === requiredTown) {
      Core.log(moduleId, `마을 위치 확인 완료: ${current} (이동 불필요)`);
      return true;
    }
    Core.log(moduleId, `마을 위치 불일치: 현재 ${current} / 필요 ${requiredTown}(${targetElement} 속성) → 이동`);
    await Core.clickTownOnMap(requiredTown);
    const verify = await Core.readCurrentTown(moduleId);
    if (verify !== requiredTown) {
      throw new Error(`마을 이동 검증 실패: 현재 ${verify} / 목표 ${requiredTown}`);
    }
    Core.log(moduleId, `마을 이동 완료: ${requiredTown}`);
    return true;
  };

  // 속성과 무관하게 특정 마을로 고정 이동한다(예: 포션이 싼 데자브).
  Core.ensureAtTown = async function (townName, moduleId) {
    const current = await Core.readCurrentTown(moduleId);
    if (current === townName) {
      Core.log(moduleId, `마을 위치 확인 완료: ${current} (이동 불필요)`);
      return true;
    }
    Core.log(moduleId, `마을 위치 불일치: 현재 ${current} / 필요 ${townName} → 이동`);
    await Core.clickTownOnMap(townName);
    const verify = await Core.readCurrentTown(moduleId);
    if (verify !== townName) {
      throw new Error(`마을 이동 검증 실패: 현재 ${verify} / 목표 ${townName}`);
    }
    Core.log(moduleId, `마을 이동 완료: ${townName}`);
    return true;
  };

  // ⚠ 사용자 요청(2026-08): 포션은 아무 마을에서나 팔지만, 데자브에서만 싸게
  // 살 수 있다. "초대형 {HP/MP}포션"(상점 "기타" 탭 맨 아래)을 최대 3개까지
  // 시도하고, 살 수 있는 만큼만 산다(구매 확인창의 "보유 골드"는 은행+소지금
  // 합산값이며 상점 구매 시 은행에서 자동 인출됨을 실전 확인함). 1개도 못
  // 사면 한 단계 아래인 "최상급 {HP/MP}포션"으로 전환해 같은 방식으로 시도.
  // 그것마저 1개도 못 사면 실패로 처리한다(호출부에서 정지 처리).
  Core.buyPotionTier = async function (tierLabel, potionType, maxCount, moduleId) {
    const itemName = `${tierLabel} ${potionType}포션`;
    await Core.clickNavMenuExact('마을', '아이템 상점');
    const arrivedShop = await Core.waitFor(
      () => location.pathname.replace(/\/$/, '') === '/shop',
      10000,
      250
    );
    if (!arrivedShop) throw new Error('아이템 상점으로 진입하지 못했습니다.');

    const otherTab = await Core.waitFor(() => Core.findButtonByText('기타'), 8000, 250);
    if (!otherTab) throw new Error('아이템 상점 "기타" 탭을 찾지 못했습니다.');
    if (!(await Core.safeClick(() => Core.findButtonByText('기타'), { beforeMin: 500, beforeMax: 900 }))) {
      throw new Error('아이템 상점 "기타" 탭 클릭에 실패했습니다.');
    }

    let bought = 0;
    for (let i = 0; i < maxCount; i++) {
      const findRow = () =>
        Core.gameElements('tr').find(
          (tr) =>
            tr.textContent.includes(itemName) &&
            [...tr.querySelectorAll('button')].some((b) => b.textContent.trim() === '구매') &&
            Core.isElementVisible(tr)
        ) || null;
      const row = await Core.waitFor(findRow, 8000, 250);
      if (!row) throw new Error(`상점 "기타" 탭에서 "${itemName}"을 찾지 못했습니다.`);
      const buyBtn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '구매');
      if (!(await Core.safeClick(() => buyBtn, { beforeMin: 500, beforeMax: 900 }))) {
        throw new Error(`"${itemName}" 구매 버튼 클릭에 실패했습니다.`);
      }

      const dialog = await Core.waitFor(() => {
        const d = Core.gameElements('[role="dialog"]').find(
          (el) => el.textContent.includes('아이템 구매 확인') && Core.isElementVisible(el)
        );
        return d || null;
      }, 6000, 250);
      if (!dialog) throw new Error(`"${itemName}" 구매 확인창을 찾지 못했습니다.`);

      const goldMatch = dialog.textContent.match(/보유\s*골드\s*([\d,]+)\s*G/);
      const costMatch = dialog.textContent.match(/구매\s*비용[\s\S]*?-([\d,]+)\s*G/);
      const gold = goldMatch ? parseInt(goldMatch[1].replace(/,/g, ''), 10) : null;
      const cost = costMatch ? parseInt(costMatch[1].replace(/,/g, ''), 10) : null;

      if (gold === null || cost === null || gold < cost) {
        const cancelBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '취소');
        if (cancelBtn) cancelBtn.click();
        Core.log(
          moduleId,
          `"${itemName}" 구매 불가(보유 골드 ${gold ?? '읽기 실패'} < 비용 ${cost ?? '읽기 실패'}) - ${bought}개 구매 후 중단`
        );
        break;
      }

      const confirmBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '구매');
      if (!(await Core.safeClick(() => confirmBtn, { beforeMin: 600, beforeMax: 1100, afterMin: 900, afterMax: 1400 }))) {
        throw new Error(`"${itemName}" 구매를 확정하지 못했습니다.`);
      }
      bought++;
      Core.log(moduleId, `"${itemName}" ${bought}/${maxCount}개 구매 완료`);
    }
    return bought;
  };

  Core.buyEmergencyPotion = async function (potionType, moduleId) {
    await Core.ensureAtTown('데자브', moduleId);
    let bought = await Core.buyPotionTier('초대형', potionType, 3, moduleId);
    if (bought === 0) {
      Core.log(moduleId, `초대형 ${potionType}포션을 하나도 구매하지 못해 최상급으로 전환`);
      bought = await Core.buyPotionTier('최상급', potionType, 3, moduleId);
    }
    if (bought === 0) {
      throw new Error(`초대형/최상급 ${potionType}포션을 모두 하나도 구매하지 못했습니다(골드 부족으로 추정).`);
    }
    return bought;
  };

  // ⚠ 사용자 요청(2026-08): 포션 부족으로 정지하기 전에, 마을 어디서든 무료로
  // HP/MP를 완전 회복시켜주는 "여관"에 먼저 들른다(확인창 없이 "휴식하기"
  // 버튼 한 번으로 즉시 회복됨을 실전 확인함). 현재 마을에서 바로 가능하므로
  // 굳이 특정 마을로 이동할 필요는 없다.
  Core.restAtInn = async function (moduleId) {
    await Core.clickNavMenuExact('마을', '여관');
    const arrived = await Core.waitFor(
      () => location.pathname.replace(/\/$/, '') === '/inn',
      10000,
      250
    );
    if (!arrived) throw new Error('여관 화면으로 진입하지 못했습니다.');
    const restBtn = await Core.waitFor(() => Core.findButtonByText('휴식하기'), 8000, 250);
    if (!restBtn) throw new Error('"휴식하기" 버튼을 찾지 못했습니다.');
    if (!(await Core.safeClick(() => Core.findButtonByText('휴식하기'), {
      beforeMin: 500, beforeMax: 900, afterMin: 900, afterMax: 1400,
    }))) {
      throw new Error('"휴식하기" 클릭에 실패했습니다.');
    }
    Core.log(moduleId, '여관에서 무료로 HP/MP 완전 회복 완료');
  };

  // 해당 속성의 돌을 파는 마을(ELEMENT_TO_TOWN)로 이동해 아이템 상점 "기타"
  // 탭에서 구매한다. 이미 그 마을에 있으면 이동을 생략한다
  // (ensureCurrentTownForElement가 자체적으로 판단함).
  Core.buyElementStoneAtTown = async function (targetElement, moduleId) {
    const stoneName = `${targetElement}의 돌`;
    await Core.ensureCurrentTownForElement(targetElement, moduleId);

    await Core.clickNavMenuExact('마을', '아이템 상점');
    const arrivedShop = await Core.waitFor(
      () => location.pathname.replace(/\/$/, '') === '/shop',
      10000,
      250
    );
    if (!arrivedShop) throw new Error('아이템 상점으로 진입하지 못했습니다.');

    const otherTab = await Core.waitFor(
      () => Core.findButtonByText('기타'),
      8000,
      250
    );
    if (!otherTab) throw new Error('아이템 상점 "기타" 탭을 찾지 못했습니다.');
    if (!(await Core.safeClick(() => Core.findButtonByText('기타'), { beforeMin: 500, beforeMax: 900 }))) {
      throw new Error('아이템 상점 "기타" 탭 클릭에 실패했습니다.');
    }

    const findRow = () =>
      Core.gameElements('tr').find(
        (tr) =>
          tr.textContent.includes(stoneName) &&
          [...tr.querySelectorAll('button')].some((b) => b.textContent.trim() === '구매') &&
          Core.isElementVisible(tr)
      ) || null;
    const row = await Core.waitFor(findRow, 8000, 250);
    if (!row) throw new Error(`상점 "기타" 탭에서 "${stoneName}"을 찾지 못했습니다.`);
    const buyBtn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '구매');
    if (!(await Core.safeClick(() => buyBtn, { beforeMin: 500, beforeMax: 900 }))) {
      throw new Error(`"${stoneName}" 구매 버튼 클릭에 실패했습니다.`);
    }

    const confirmBtn = await Core.waitFor(
      () => Core.findButtonInDialog('아이템 구매 확인', '구매') || Core.findButtonInDialog(stoneName, '구매'),
      6000,
      250
    );
    if (!confirmBtn) throw new Error(`"${stoneName}" 구매 확인창을 찾지 못했습니다.`);
    if (!(await Core.safeClick(() => confirmBtn, { beforeMin: 600, beforeMax: 1100, afterMin: 1000, afterMax: 1600 }))) {
      throw new Error(`"${stoneName}" 구매를 확정하지 못했습니다.`);
    }
    Core.log(moduleId, `${stoneName} 상점에서 구매 완료 (${Core.ELEMENT_TO_TOWN[targetElement]})`);
  };

  // ---------------- 장비용 기름 자동 사용 (자동사냥) ----------------
  Core.EQUIPMENT_OIL_NAME = '장비용 기름';
  Core.EQUIPMENT_CATEGORIES = ['무기', '방어구', '장신구'];

  Core.openInventoryConsumables = async function (shouldCancel = Core.defaultShouldCancel) {
    if (location.pathname.replace(/\/$/, '') !== '/inventory') {
      await Core.goToCharacterPage('인벤토리', '/inventory');
    }
    if (shouldCancel && shouldCancel()) return false;

    const findTab = () =>
      Core.gameElements('[role="tab"], button').find(
        (el) => el.textContent.trim() === '소모품' && Core.isElementVisible(el)
      ) || null;
    const tab = await Core.waitFor(findTab, 8000, 200, shouldCancel);
    if (!tab) throw new Error('인벤토리 소모품 탭을 찾지 못했습니다.');

    const isSelected =
      tab.getAttribute('aria-selected') === 'true' ||
      tab.getAttribute('aria-pressed') === 'true' ||
      tab.getAttribute('data-state') === 'active';
    if (!isSelected) {
      if (!(await Core.safeClick(findTab, {
        beforeMin: 600,
        beforeMax: 1100,
        afterMin: 700,
        afterMax: 1200,
        shouldCancel,
      }))) {
        throw new Error('인벤토리 소모품 탭을 열지 못했습니다.');
      }
    }
    return true;
  };

  Core.findEquipmentOilRow = function () {
    return Core.gameElements('tr').find((row) => {
      if (!Core.isElementVisible(row)) return false;
      // ⚠ 실전 확인: 게임이 수량을 이름과 같은 <p> 안에 별도 <span>으로
      // 붙이는 구조로 바뀌면서(예: <p>장비용 기름<span>x26</span></p>)
      // 이름 요소가 자식(span)을 가지게 되어 기존 "리프(자식 없음)" 조건에
      // 안 걸려 인벤토리에 26개가 반히 보여도 영구히 못 찾는 문제가 있었다.
      // 자식 엔리트를 제외한 "직접 텍스트 노드"만 모아 비교하는 방식을 추가해
      // 이 구조에도 대응한다(기존 리프 기반 검사는 그대로 유지).
      const allEls = [...row.querySelectorAll('*')];
      const hasExactOilName = allEls.some((el) => {
        if (el.children.length === 0) {
          const text = el.textContent.replace(/\s+/g, ' ').trim();
          if (
            text === Core.EQUIPMENT_OIL_NAME ||
            /^장비용 기름\s*[x×]\s*[\d,]+$/.test(text)
          ) return true;
        }
        const ownText = [...el.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
        return ownText === Core.EQUIPMENT_OIL_NAME;
      });
      if (!hasExactOilName) return false;
      const useButtons = [...row.querySelectorAll('button')].filter(
        (button) =>
          ['사용', '사용하기'].includes(button.textContent.trim()) &&
          Core.isElementVisible(button)
      );
      return useButtons.length === 1;
    }) || null;
  };

  Core.findEquipmentOilUseTarget = async function (shouldCancel = Core.defaultShouldCancel) {
    // 인벤토리는 사용자가 마지막으로 보던 페이지를 유지할 수 있다. 현재
    // 페이지부터 뒤쪽만 훑으면 3페이지의 기름을 4페이지에서 시작했을 때
    // 영구히 놓치므로, 매 검색마다 1페이지로 돌아간 뒤 유한 순회한다.
    const currentPageButton = Core.gameElements('button').find((button) =>
      /^page\s+\d+$/.test(button.getAttribute('aria-label') || '') &&
      Core.isElementVisible(button)
    );
    if (
      currentPageButton &&
      currentPageButton.getAttribute('aria-label') !== 'page 1'
    ) {
      const firstPage = Core.gameElements('button').find((button) =>
        button.getAttribute('aria-label') === 'Go to page 1' &&
        !button.disabled &&
        Core.isElementVisible(button)
      );
      if (firstPage && !(await Core.safeClick(firstPage, {
        beforeMin: 450,
        beforeMax: 800,
        afterMin: 550,
        afterMax: 900,
        shouldCancel,
      }))) {
        throw new Error('장비용 기름 검색을 위해 소모품 1페이지로 돌아가지 못했습니다.');
      }
    }

    for (let page = 1; page <= 20; page++) {
      if (shouldCancel && shouldCancel()) return null;
      const row = Core.findEquipmentOilRow();
      if (row) {
        const buttons = [...row.querySelectorAll('button')].filter(
          (button) =>
            ['사용', '사용하기'].includes(button.textContent.trim()) &&
            Core.isElementVisible(button)
        );
        if (buttons.length === 1) return { row, button: buttons[0] };
        throw new Error('"장비용 기름" 행의 사용 버튼이 하나가 아니어서 안전하게 중단합니다.');
      }

      const next = Core.gameElements('button').find(
        (button) =>
          button.getAttribute('aria-label') === 'Go to next page' &&
          !button.disabled &&
          Core.isElementVisible(button)
      );
      if (!next) break;
      if (!(await Core.safeClick(next, {
        beforeMin: 500,
        beforeMax: 900,
        afterMin: 650,
        afterMax: 1100,
        shouldCancel,
      }))) break;
    }
    return null;
  };

  Core.readEquipmentOilCount = function (row) {
    if (!row) return null;
    const text = row.textContent.replace(/\s+/g, ' ');
    const match = text.match(/장비용 기름\s*[x×]\s*([\d,]+)/);
    if (match) return parseInt(match[1].replace(/,/g, ''), 10);
    // 수량이 1개일 때 게임은 이름에 x1을 붙이지 않고 두 번째 셀에만
    // "1"을 표시한다.
    const cells = [...row.querySelectorAll('td')];
    const countText = cells[1] ? cells[1].textContent.trim() : '';
    return /^[\d,]+$/.test(countText)
      ? parseInt(countText.replace(/,/g, ''), 10)
      : null;
  };

  Core.getOpenGameDialogs = function () {
    return Core.gameElements('[role="dialog"], [role="presentation"]').filter(
      (dialog) => Core.isElementVisible(dialog)
    );
  };

  Core.findEquipmentOilDialog = function () {
    const candidates = Core.getOpenGameDialogs().filter((dialog) => {
      const hasExactHeading = [...dialog.querySelectorAll('h1, h2, h3, h4, h5, h6')]
        .some((heading) =>
          heading.textContent.trim() === '장비용 기름을 바를 장비 선택'
        );
      const categoryControls = [...dialog.querySelectorAll('[role="tab"], button')]
        .filter((control) => Core.isElementVisible(control));
      const hasAllCategories = Core.EQUIPMENT_CATEGORIES.every((category) =>
        categoryControls.some((control) => {
          const text = control.textContent.replace(/\s+/g, ' ').trim();
          return text === category || text.startsWith(`${category} (`);
        })
      );
      const selectButtons = [...dialog.querySelectorAll('button')].filter(
        (button) =>
          button.textContent.trim() === '선택' &&
          Core.isElementVisible(button)
      );
      return hasExactHeading && hasAllCategories && selectButtons.length === 1;
    });
    if (candidates.length === 0) return null;
    return candidates.reduce((smallest, candidate) =>
      candidate.querySelectorAll('*').length < smallest.querySelectorAll('*').length
        ? candidate
        : smallest
    );
  };

  Core.findEquipmentOilCategoryControl = function (category) {
    const dialog = Core.findEquipmentOilDialog();
    if (!dialog) return null;
    const controls = [...dialog.querySelectorAll('[role="tab"], button, [role="button"]')]
      .filter(
        (control) => {
          const text = control.textContent.replace(/\s+/g, ' ').trim();
          return (
            (text === category || text.startsWith(`${category} (`)) &&
            Core.isElementVisible(control)
          );
        }
      );
    return controls.length === 1 ? controls[0] : null;
  };

  Core.findTopEquippedOilTarget = function () {
    const dialog = Core.findEquipmentOilDialog();
    if (!dialog) return null;
    const equippedBadges = [...dialog.querySelectorAll('*')].filter(
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim() === '착용중' &&
        Core.isElementVisible(el)
    );
    if (equippedBadges.length === 0) return null;

    // 게임이 현재 착용 장비를 최상단에 정렬하므로 첫 번째 '착용중' 행만 쓴다.
    // 실제 UI에서 행 본문([role=button])은 장비 상세를 펼치고, 선택 상태는
    // 라디오를 감싼 span을 눌러야 바뀐다. 따라서 행 전체를 임의 클릭하지
    // 않고 그 행 안의 단 하나뿐인 라디오 컨트롤만 사용한다.
    const badge = equippedBadges[0];
    const row = badge.closest('li') || badge.closest('[role="option"]');
    if (!row || !dialog.contains(row)) return null;
    const radioCandidates = [...row.querySelectorAll('input[type="radio"], [role="radio"]')];
    if (radioCandidates.length !== 1) return null;
    const radio = radioCandidates[0];
    const clickTarget =
      radio.closest('label') ||
      (radio.parentElement && row.contains(radio.parentElement) ? radio.parentElement : null);
    return clickTarget && Core.isElementVisible(clickTarget) ? clickTarget : null;
  };

  Core.findEquipmentOilSubmitButton = function () {
    const dialog = Core.findEquipmentOilDialog();
    if (!dialog) return null;
    const buttons = [...dialog.querySelectorAll('button')].filter(
      (button) =>
        button.textContent.trim() === '선택' &&
        Core.isElementVisible(button) &&
        !button.disabled &&
        button.getAttribute('aria-disabled') !== 'true'
    );
    return buttons.length === 1 ? buttons[0] : null;
  };

  Core.findEquipmentOilSecondaryConfirm = function (selectionDialog) {
    const dialogs = Core.getOpenGameDialogs().filter(
      (dialog) => dialog !== selectionDialog && !selectionDialog.contains(dialog)
    );
    for (const dialog of dialogs) {
      const text = dialog.textContent.replace(/\s+/g, ' ').trim();
      const hasUseConfirmHeading = [...dialog.querySelectorAll('h1, h2, h3, h4, h5, h6')]
        .some((heading) => heading.textContent.trim() === '사용 확인');
      if (
        !hasUseConfirmHeading ||
        !text.includes(Core.EQUIPMENT_OIL_NAME) ||
        !text.includes('정말')
      ) continue;
      const buttons = [...dialog.querySelectorAll('button')].filter(
        (button) =>
          button.textContent.trim() === '확인' &&
          Core.isElementVisible(button) &&
          !button.disabled
      );
      if (buttons.length === 1) return buttons[0];
    }
    return null;
  };

  Core.useEquipmentOilOnce = async function (
    category,
    moduleId,
    shouldCancel = Core.defaultShouldCancel
  ) {
    if (!Core.EQUIPMENT_CATEGORIES.includes(category)) {
      throw new Error(`지원하지 않는 장비용 기름 대상입니다: ${category}`);
    }
    if (!(await Core.openInventoryConsumables(shouldCancel))) return false;

    const useTarget = await Core.findEquipmentOilUseTarget(shouldCancel);
    if (!useTarget) {
      throw new Error(`"${category}"에 바를 "${Core.EQUIPMENT_OIL_NAME}"을 인벤토리에서 찾지 못했습니다.`);
    }
    const countBefore = Core.readEquipmentOilCount(useTarget.row);
    const existingDialogs = new Set(Core.getOpenGameDialogs());
    if (!(await Core.safeClick(() => {
      const fresh = Core.findEquipmentOilRow();
      if (!fresh) return null;
      const buttons = [...fresh.querySelectorAll('button')].filter(
        (button) =>
          ['사용', '사용하기'].includes(button.textContent.trim()) &&
          Core.isElementVisible(button)
      );
      return buttons.length === 1 ? buttons[0] : null;
    }, {
      beforeMin: 850,
      beforeMax: 1500,
      afterMin: 250,
      afterMax: 450,
      shouldCancel,
    }))) {
      throw new Error(`"${Core.EQUIPMENT_OIL_NAME}" 사용 버튼이 클릭 직전에 사라졌습니다.`);
    }

    const selectionDialog = await Core.waitFor(() => {
      const dialog = Core.findEquipmentOilDialog();
      return dialog && (!existingDialogs.has(dialog) || dialog.textContent.includes('착용중'))
        ? dialog
        : null;
    }, 6000, 150, shouldCancel);
    if (!selectionDialog) throw new Error(`"${Core.EQUIPMENT_OIL_NAME}" 장비 선택창을 찾지 못했습니다.`);

    const categoryControl = await Core.waitFor(
      () => Core.findEquipmentOilCategoryControl(category),
      5000,
      150,
      shouldCancel
    );
    if (!categoryControl) {
      throw new Error(`장비용 기름 선택창에서 "${category}" 분류를 정확히 찾지 못했습니다.`);
    }
    const categorySelected =
      categoryControl.getAttribute('aria-selected') === 'true' ||
      categoryControl.getAttribute('aria-pressed') === 'true' ||
      categoryControl.getAttribute('data-state') === 'active';
    if (!categorySelected) {
      if (!(await Core.safeClick(
        () => Core.findEquipmentOilCategoryControl(category),
        {
          beforeMin: 500,
          beforeMax: 950,
          afterMin: 500,
          afterMax: 850,
          shouldCancel,
          afterCheck: () => {
            const current = Core.findEquipmentOilCategoryControl(category);
            return current && (
              current.getAttribute('aria-selected') === 'true' ||
              current.getAttribute('aria-pressed') === 'true' ||
              current.getAttribute('data-state') === 'active'
            ) ? current : null;
          },
        }
      ))) {
        throw new Error(`장비용 기름 선택창의 "${category}" 분류 클릭에 실패했습니다.`);
      }
    }

    const equippedTarget = await Core.waitFor(
      () => Core.findTopEquippedOilTarget(),
      5000,
      150,
      shouldCancel
    );
    if (!equippedTarget) {
      throw new Error(`"${category}" 목록에서 '착용중' 장비의 선택 컨트롤을 찾지 못했습니다.`);
    }
    const targetRadio = equippedTarget.matches('input[type="radio"], [role="radio"]')
      ? equippedTarget
      : equippedTarget.querySelector('input[type="radio"], [role="radio"]');
    const alreadySelected = !!(
      targetRadio &&
      (targetRadio.checked || targetRadio.getAttribute('aria-checked') === 'true')
    );
    if (!alreadySelected) {
      if (!(await Core.safeClick(
        () => {
          const fresh = Core.findTopEquippedOilTarget();
          return fresh && Core.isElementVisible(fresh) ? fresh : null;
        },
        {
          beforeMin: 650,
          beforeMax: 1150,
          afterMin: 350,
          afterMax: 650,
          shouldCancel,
        }
      ))) {
        throw new Error(`"${category}"의 최상단 착용 장비 선택에 실패했습니다.`);
      }
    }

    const submit = await Core.waitFor(
      () => Core.findEquipmentOilSubmitButton(),
      5000,
      150,
      shouldCancel
    );
    if (!submit) {
      throw new Error('장비용 기름 선택창의 활성화된 "선택" 버튼을 하나로 확정하지 못했습니다.');
    }

    let successMutation = false;
    const successObserver = new MutationObserver((records) => {
      for (const record of records) {
        const nodes = [
          ...record.addedNodes,
          record.type === 'characterData' ? record.target.parentElement : null,
        ].filter(Boolean);
        if (nodes.some((node) => {
          const text = node.textContent || '';
          return text.includes('기름') &&
            /(사용|보호)/.test(text) &&
            /(완료|적용|사용했|발랐|보호됩니다)/.test(text);
        })) {
          successMutation = true;
          break;
        }
      }
    });
    successObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
      if (!(await Core.safeClick(
        () => Core.findEquipmentOilSubmitButton(),
        {
          beforeMin: 700,
          beforeMax: 1200,
          afterMin: 250,
          afterMax: 450,
          shouldCancel,
        }
      ))) {
        throw new Error(`"${category}" 장비에 기름을 바르는 최종 버튼 클릭에 실패했습니다.`);
      }

      const secondaryConfirm = await Core.waitFor(
        () => Core.findEquipmentOilSecondaryConfirm(selectionDialog) || (
          !selectionDialog.isConnected || !Core.isElementVisible(selectionDialog) ? true : null
        ),
        1800,
        120,
        shouldCancel
      );
      if (secondaryConfirm && secondaryConfirm !== true) {
        if (!(await Core.safeClick(
          () => Core.findEquipmentOilSecondaryConfirm(selectionDialog),
          {
            beforeMin: 500,
            beforeMax: 900,
            afterMin: 450,
            afterMax: 750,
            shouldCancel,
          }
        ))) {
          throw new Error(`"${category}" 장비용 기름 확인창 클릭에 실패했습니다.`);
        }
      }

      const applied = await Core.waitFor(() => {
        const freshRow = Core.findEquipmentOilRow();
        const countAfter = Core.readEquipmentOilCount(freshRow);
        if (countBefore !== null) {
          if (!freshRow || (countAfter !== null && countAfter < countBefore)) return true;
        }
        if (successMutation) return true;
        const dialogClosed =
          !selectionDialog.isConnected || !Core.isElementVisible(selectionDialog);
        return countBefore === null && dialogClosed ? true : null;
      }, 7000, 200, shouldCancel);
      if (!applied) {
        throw new Error(`"${category}" 장비용 기름 사용 후 수량 감소 또는 완료 신호를 확인하지 못했습니다.`);
      }
    } finally {
      successObserver.disconnect();
    }

    Core.log(moduleId, `장비용 기름 적용 완료: ${category} 최상단 착용 장비`);
    return true;
  };

  Core.useEquipmentOilForCategories = async function (
    categories,
    moduleId,
    shouldCancel = Core.defaultShouldCancel
  ) {
    const uniqueCategories = [...new Set(categories)].filter(
      (category) => Core.EQUIPMENT_CATEGORIES.includes(category)
    );
    if (uniqueCategories.length === 0) {
      throw new Error('장비 보호가 풀린 부위를 결정하지 못했습니다.');
    }
    for (const category of uniqueCategories) {
      if (shouldCancel && shouldCancel()) return false;
      await Core.useEquipmentOilOnce(category, moduleId, shouldCancel);
    }
    return true;
  };

  // ⚠ 사용자 요청(2026-08): "캐릭 → 내 정보"에 있는 "HP 건강도"/"MP 건강도"가
  // 100%가 아니면 경고를 띄운다. 자동사냥 시작 시 속성 확인(ensureCharacterElement)이
  // 이미 이 페이지(/status)에 들어가므로, 그 타이밍에 같이 확인한다(별도 이동 불필요).
  Core.readHealthPercentages = function () {
    const text = Core.bodyText();
    const hpMatch = text.match(/HP\s*건강도:\s*(\d+)%/);
    const mpMatch = text.match(/MP\s*건강도:\s*(\d+)%/);
    return {
      hp: hpMatch ? parseInt(hpMatch[1], 10) : null,
      mp: mpMatch ? parseInt(mpMatch[1], 10) : null,
    };
  };

  // notifyStopped/notifyCompleted와 달리 모듈을 정지시키지 않는, 경고 전용
  // 배너. 실행은 계속하되 사용자에게 강하게 알려야 하는 상황(HP/MP 건강도
  // 저하 등)에 쓴다.
  Core.warnBanner = function (moduleId, msg) {
    Core.log(moduleId, `⚠ ${msg}`);
    Core.showBanner(moduleId, msg, false);
    Core.playStopSound();
  };

  Core.checkHealthAndWarn = function (moduleId) {
    const { hp, mp } = Core.readHealthPercentages();
    const problems = [];
    if (hp !== null && hp < 100) problems.push(`HP 건강도 ${hp}%`);
    if (mp !== null && mp < 100) problems.push(`MP 건강도 ${mp}%`);
    if (problems.length > 0) {
      Core.warnBanner(moduleId, `${problems.join(', ')} - 100%가 아닙니다. 확인이 필요합니다.`);
    } else if (hp !== null && mp !== null) {
      Core.log(moduleId, 'HP/MP 건강도 확인: 100% (정상)');
    }
    return { hp, mp };
  };

  Core.ensureCharacterElement = async function (targetElement, moduleId) {
    if (!Core.ELEMENT_OPTIONS.includes(targetElement)) {
      throw new Error(`지원하지 않는 목표 속성입니다: ${targetElement}`);
    }

    await Core.goToCharacterPage('내 정보', '/status');
    let currentElement = await Core.waitFor(() => Core.readCharacterElementOnStatus(), 8000, 250);
    if (!currentElement) throw new Error('내 정보에서 현재 캐릭터 속성을 읽지 못했습니다.');
    Core.checkHealthAndWarn(moduleId);

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

  Core.bankDepositAll = async function (moduleId, { fast = false } = {}) {
    Core.log(moduleId, '은행으로 이동해 전액 입금 진행');
    await Core.clickNavMenuExact(
      '마을',
      '은행',
      Core.defaultShouldCancel,
      fast ? { nav: { min: 250, max: 500 }, item: { min: 250, max: 500 } } : undefined
    );
    await Core.waitFor(() => Core.bodyText().includes('전액 입금'));
    const depositBtn = await Core.retryStep('"전액 입금" 버튼 찾기', () => Core.findButtonByText('전액 입금'));
    if (!depositBtn) {
      Core.notifyStopped(moduleId, '"전액 입금" 버튼을 찾지 못했습니다 (여러 번 재시도 후에도 실패).');
      return false;
    }
    depositBtn.click();
    await Core.humanDelay(fast ? 450 : 800, fast ? 900 : 1600);
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
    const tag = moduleDisplayLabel(moduleId);
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

  // 실행 모듈이 하나라도 있는 동안 거의 들리지 않는 오디오 신호를 유지해
  // Chrome의 숨은 탭 타이머 제한을 완화한다. 보스에만 있던 유지 장치를
  // 던전·아레나·자동사냥·심층던전과 일일 전체 실행에도 공통 적용한다.
  // 소유자 집합을 사용하므로 일일과 그 하위 모듈이 겹쳐도 먼저 끝난 쪽이
  // 다른 쪽의 유지 신호를 끄지 않는다.
  Core.backgroundKeeper = {
    owners: new Set(),
    ctx: null,
    osc: null,
    healthRunId: 0,
    resume() {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    },
    startHealthLoop() {
      const runId = ++this.healthRunId;
      (async () => {
        while (this.owners.size > 0 && runId === this.healthRunId) {
          this.resume();
          await Core.sleep(5000);
        }
      })().catch(() => {});
    },
    acquire(owner) {
      if (!owner) return;
      this.owners.add(owner);
      if (this.ctx) {
        this.resume();
        this.startHealthLoop();
        return;
      }
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.002;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        this.ctx = ctx;
        this.osc = osc;
        ctx.onstatechange = () => this.resume();
        this.resume();
        this.startHealthLoop();
      } catch (e) {
        Core.log('core', `백그라운드 유지 오디오 시작 실패: ${e.message}`);
      }
    },
    release(owner) {
      if (owner) this.owners.delete(owner);
      if (this.owners.size > 0) return;
      this.healthRunId++;
      try { if (this.osc) this.osc.stop(); } catch (e) {}
      try { if (this.ctx) this.ctx.close(); } catch (e) {}
      this.ctx = null;
      this.osc = null;
    },
  };
  document.addEventListener('visibilitychange', () => {
    if (Core.backgroundKeeper.owners.size > 0) Core.backgroundKeeper.resume();
  });
  window.__lanisBackgroundKeeper = Core.backgroundKeeper;

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
    Core.bannerEl.querySelector('span').textContent = `${isSuccess ? '✅' : '⚠'} [${moduleDisplayLabel(moduleId)}] ${msg}`;
    Core.bannerEl.style.background = isSuccess ? '#2e7d32' : '#b71c1c';
    Core.bannerEl.style.display = 'flex';
    Core.startTitleFlash();
  };

  Core.hideBanner = function () {
    if (Core.bannerEl) Core.bannerEl.style.display = 'none';
    Core.stopTitleFlash();
  };

  Core.notifyStopped = function (moduleId, msg) {
    Core.moduleResults[moduleId] = { ok: false, message: msg, at: Date.now() };
    Core.log(moduleId, `⚠ ${msg}`);
    Core.showBanner(moduleId, msg, false);
    // ⚠ 버그 수정(2026-08, 사용자 확인): 일일 매크로가 하위 모듈(던전·보스·
    // 자동사냥 등)을 순서대로 실행하는 동안, 각 하위 모듈이 끝날 때마다
    // 이 함수가 그대로 호출되어 그때마다 소리가 났다 - 일일 한 번 돌리는
    // 동안 선택된 단계 수만큼(최대 6~7번) 소리가 울리고, 거기에 일일
    // 전체 완료 소리까지 더해져 "중간에 여러 번 들린다"는 문제가 있었다.
    // 일일 매크로 실행 중(Core.dailyActive)에는 개별 하위 모듈 소리를
    // 내지 않고 배너·로그만 남긴다 - 최종 소리는 일일 자체 종료 처리에서
    // (dailyActive를 false로 되돌린 뒤) 딱 한 번만 울린다. 개별 모듈을
    // 단독 실행할 때(dailyActive=false)는 기존처럼 그대로 소리가 난다.
    if (!Core.dailyActive) Core.playStopSound();
    Core.stopModule(moduleId);
  };

  Core.notifyCompleted = function (moduleId, msg) {
    Core.moduleResults[moduleId] = { ok: true, message: msg, at: Date.now() };
    Core.log(moduleId, `✅ ${msg}`);
    Core.showBanner(moduleId, msg, true);
    if (!Core.dailyActive) Core.playCompleteSound();
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

  // ⚠ 사용자 요청(2026-08): 심층던전/아레나 주간 보상은 "일주일에 한 번만"
  // 확인하면 된다. 서버 초기화 기준(매주 월요일 00:00 KST)에 맞춰, 현재가
  // 속한 주의 "월요일 날짜(YYYY-MM-DD, KST 기준)"를 문자열로 반환한다.
  // 이 문자열이 바뀌는 시점(=다음 월요일 KST 00:00)마다 새로 확인하면 된다.
  Core.getKstMondayWeekId = function () {
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000); // UTC -> KST 보정
    const day = kst.getUTCDay(); // 0=일, 1=월, ... 6=토
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(kst);
    monday.setUTCDate(kst.getUTCDate() + diffToMonday);
    const y = monday.getUTCFullYear();
    const m = String(monday.getUTCMonth() + 1).padStart(2, '0');
    const d = String(monday.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  // ⚠ 사용자 요청(2026-08): 길드 보스(히드라)는 화·목에 소환되고, 개인
  // 보상은 다음날(수·금)에 받아야 한다. KST(UTC+9) 기준 요일(0=일 ~ 6=토)을
  // 반환한다.
  Core.getKstDayOfWeek = function () {
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    return kst.getUTCDay();
  };


  // ==========================================================================
  // 모듈 정의: 재전직 / 자동사냥 / 레어맵 / 던전 / 심층던전
  // ==========================================================================
  const MODULE_LABELS = {
    daily: '일일',
    rejob: '재전직',
    relic: '유물',
    raremap: '레어맵',
    dungeon: '던전',
    autohunt: '자동사냥',
    boss: '보스',
    deepdungeon: '심층던전',
    arena: '아레나',
    guildboss: '길드보스',
    preseason: '이벤트',
    preseasonArena: '프리시즌 무한아레나',
  };
  const moduleDisplayLabel = (moduleId) => MODULE_LABELS[moduleId] || moduleId;

  const Modules = {};


  Modules.daily = {
    id: 'daily',
    running: false,
    stopRequested: false,
    config: {
      dungeon: true,
      arena: true,
      boss: true,
      autohunt: true,
      deepdungeon: true,
      // ⚠ 사용자 요청(2026-08): 매일 똑같은 순서(던전→보스→자동사냥→…)로만
      // 도니까 패턴이 너무 뻔하다는 의견이 있어, 중간 작업들의 실행 순서를
      // 매 실행마다(또는 원하면 계속 고정) 랜덤으로 섞을 수 있는 옵션을
      // 추가한다. 기본값은 false(기존 고정 순서 그대로) — 켜야만 랜덤화된다.
      randomOrder: false,
    },
  };

  // -------------------------- 일일 연속 실행 --------------------------
  const DAILY_STATE_KEY = 'lrm-daily-sequence-state';
  const DAILY_AUTH_SCHEMA = 'daily-explicit-v2';
  // localStorage의 오래된 running 값만으로 작업을 자동 시작하지 않는다.
  // 사용자가 이 탭에서 직접 시작했을 때만 sessionStorage 허가가 생기며,
  // 정지/탭 종료 시 사라진다.
  const DAILY_AUTH_KEY = 'lrm-daily-explicit-run-auth';
  const DAILY_CONFIG_KEYS = ['dungeon', 'arena', 'preseason', 'boss', 'autohunt', 'deepdungeon', 'randomOrder'];
  // 순서를 섞어도 되는 "중간" 작업들. weeklyRewards/attendance는 항상 먼저,
  // dailyQuests는 항상 마지막 — 이 셋은 절대 섞지 않는다(Core.startDaily
  // 주석 참고: 진행도/선행조건 때문에 순서가 고정되어야 함).
  const DAILY_RANDOMIZABLE_STEPS = ['dungeon', 'boss', 'autohunt', 'deepdungeon', 'arena', 'preseason'];
  // ⚠ 사용자 요청(2026-08): 심층던전/아레나 주간 보상은 그 매크로를 돌리지
  // 않아도 "일일" 실행 시 최우선으로 받아야 하고, 일주일에 한 번만 확인하면
  // 된다. Core.getKstMondayWeekId()가 반환하는 값(매주 월요일 00:00 KST마다
  // 바뀜)을 여기에 저장해, 이미 확인한 주라면 API 호출조차 다시 하지 않는다.
  const DD_REWARD_WEEK_KEY = 'lrm-deepdungeon-reward-week-done';
  const ARENA_REWARD_WEEK_KEY = 'lrm-arena-reward-week-done';
  const GUILD_BOSS_REWARD_DAY_KEY = 'lrm-guildboss-reward-day-done';
  const DAILY_STEP_LABELS = {
    weeklyRewards: '주간 보상(심층던전+아레나)',
    dailyQuests: '일간+주간 퀘스트',
    attendance: '출석체크',
    dungeon: '던전',
    arena: '아레나',
    preseason: '프리시즌',
    boss: '보스',
    autohunt: '자동사냥',
    deepdungeon: '심층던전',
  };

  Modules.daily.loadState = function () {
    try {
      const value = JSON.parse(localStorage.getItem(DAILY_STATE_KEY) || 'null');
      return value && value.running ? value : null;
    } catch (e) {
      return null;
    }
  };

  Modules.daily.saveState = function (state) {
    localStorage.setItem(DAILY_STATE_KEY, JSON.stringify(state));
  };

  Modules.daily.findVisibleMenuItem = function (text) {
    return Core.gameElements('[role="menuitem"]').find((item) =>
      item.textContent.trim() === text &&
      Core.isElementVisible(item)
    ) || null;
  };

  Modules.daily.goToMonthlyAttendance = async function () {
    const shouldCancel = () => this.stopRequested || !Core.dailyActive;
    if (location.pathname.replace(/\/$/, '') !== '/event/pass') {
      let eventItem = this.findVisibleMenuItem('이벤트');
      if (!eventItem) {
        const findProfileButton = () => {
          const header = document.querySelector('header, [role="banner"]');
          if (!header) return null;
          const buttons = [...header.querySelectorAll('button')]
            .filter((button) => !button.closest('#lrm-panel, #lrm-banner'));
          return buttons.length > 0 ? buttons[buttons.length - 1] : null;
        };
        const opened = await Core.safeClick(findProfileButton, {
          beforeMin: 550,
          beforeMax: 950,
          afterMin: 250,
          afterMax: 450,
          shouldCancel,
        });
        if (!opened) throw new Error('맨 오른쪽 사용자 메뉴 버튼을 누르지 못했습니다.');
        eventItem = await Core.waitFor(
          () => this.findVisibleMenuItem('이벤트'),
          6000,
          150,
          shouldCancel
        );
      }
      if (!eventItem) throw new Error('사용자 메뉴의 "이벤트" 항목을 찾지 못했습니다.');
      const clickedEvent = await Core.safeClick(
        () => this.findVisibleMenuItem('이벤트'),
        {
          beforeMin: 550,
          beforeMax: 950,
          afterMin: 350,
          afterMax: 650,
          shouldCancel,
        }
      );
      if (!clickedEvent) throw new Error('사용자 메뉴의 "이벤트"를 누르지 못했습니다.');
    }

    const eventPage = await Core.waitFor(
      () =>
        location.pathname.replace(/\/$/, '') === '/event/pass' &&
        Core.gameElements('[role="tab"]').some((tab) =>
          tab.textContent.trim() === '월간 출석체크'
        ),
      15000,
      250,
      shouldCancel
    );
    if (!eventPage) throw new Error('이벤트 화면 진입을 확인하지 못했습니다.');

    const findMonthlyTab = () => Core.gameElements('[role="tab"]').find(
      (tab) => tab.textContent.trim() === '월간 출석체크'
    ) || null;
    const monthlyTab = findMonthlyTab();
    if (!monthlyTab) throw new Error('"월간 출석체크" 탭을 찾지 못했습니다.');
    if (monthlyTab.getAttribute('aria-selected') !== 'true') {
      const clickedTab = await Core.safeClick(findMonthlyTab, {
        beforeMin: 500,
        beforeMax: 900,
        afterMin: 350,
        afterMax: 650,
        shouldCancel,
      });
      if (!clickedTab) throw new Error('"월간 출석체크" 탭을 누르지 못했습니다.');
    }

    const attendanceReady = await Core.waitFor(
      () => {
        const tab = findMonthlyTab();
        if (!tab || tab.getAttribute('aria-selected') !== 'true') return null;
        const text = Core.bodyText();
        return text.includes('출석일수:') && text.includes('다음 출석체크 가능 시간:')
          ? true
          : null;
      },
      10000,
      200,
      shouldCancel
    );
    if (!attendanceReady) throw new Error('월간 출석체크 화면의 상태를 읽지 못했습니다.');
  };

  Modules.daily.runAttendance = async function () {
    const shouldCancel = () => this.stopRequested || !Core.dailyActive;
    await this.goToMonthlyAttendance();
    if (shouldCancel()) throw new Error('사용자가 일일 실행을 정지했습니다.');

    const findClaimButton = () => Core.gameElements('button').find((button) =>
      button.textContent.trim() === '월간 출석체크하기' &&
      !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true'
    ) || null;
    const claimButton = findClaimButton();
    if (!claimButton) {
      const alreadyDone = Core.gameElements('button').some((button) =>
        button.textContent.trim() === '오늘 월간 출석체크 완료' && button.disabled
      );
      return alreadyDone
        ? '오늘 월간 출석체크 이미 완료 - 건너뜀'
        : '현재 받을 수 있는 월간 출석 보상 없음 - 건너뜀';
    }

    const beforeText = Core.bodyText();
    const beforeMatch = beforeText.match(/출석일수:\s*(\d+)일/);
    const beforeDays = beforeMatch ? parseInt(beforeMatch[1], 10) : null;
    const clicked = await Core.safeClick(findClaimButton, {
      beforeMin: 650,
      beforeMax: 1100,
      afterMin: 300,
      afterMax: 550,
      shouldCancel,
    });
    if (!clicked) throw new Error('월간 출석체크 수령 버튼 클릭에 실패했습니다.');

    const completed = await Core.waitFor(
      () => {
        const doneButton = Core.gameElements('button').find((button) =>
          button.textContent.trim() === '오늘 월간 출석체크 완료' && button.disabled
        );
        if (!doneButton) return null;
        const match = Core.bodyText().match(/출석일수:\s*(\d+)일/);
        const afterDays = match ? parseInt(match[1], 10) : null;
        return beforeDays === null || afterDays === null || afterDays > beforeDays
          ? { afterDays }
          : null;
      },
      12000,
      200,
      shouldCancel
    );
    if (!completed) throw new Error('월간 출석체크 보상 수령 완료 상태를 확인하지 못했습니다.');

    const closeButton = Core.gameElements('[role="alert"] button').find((button) =>
      ['Close', '닫기', '확인'].includes(button.textContent.trim()) ||
      ['Close', '닫기'].includes(button.getAttribute('aria-label') || '')
    );
    if (closeButton) {
      await Core.safeClick(() => closeButton.isConnected ? closeButton : null, {
        beforeMin: 250,
        beforeMax: 450,
        shouldCancel,
      });
    }
    return completed.afterDays
      ? `월간 출석체크 ${completed.afterDays}일차 보상 수령 완료`
      : '월간 출석체크 보상 수령 완료';
  };

  Modules.daily.verifyDungeon = async function () {
    const shouldCancel = () => this.stopRequested || !Core.dailyActive;
    const arrived = await Modules.dungeon.goToDungeonSelect(shouldCancel);
    if (shouldCancel()) throw new Error('사용자가 일일 실행을 정지했습니다.');
    if (!arrived) throw new Error('던전 선택 화면 진입을 확인하지 못함');
    const remaining = Modules.dungeon.scanEligibleDungeons();
    if (remaining.length > 0) {
      throw new Error(`아직 입장 가능한 던전이 남아 있음: ${remaining.map((d) => d.label).join(', ')}`);
    }
    return '입장 가능한 모든 던전 완료 또는 입장권 소진 확인';
  };

  Modules.daily.verifyAutohunt = async function () {
    const shouldCancel = () => this.stopRequested || !Core.dailyActive;
    const mod = Modules.autohunt;
    const onGround = await mod.ensureOnGround(
      mod.config.groundSuffix,
      mod.config.floor,
      shouldCancel
    );
    if (shouldCancel()) throw new Error('사용자가 일일 실행을 정지했습니다.');
    if (!onGround) throw new Error('사냥 종료 후 사냥터 화면을 확인하지 못함');
    const energyReading = await Core.waitFor(
      () => {
        const value = mod.readEnergy();
        return value === null ? null : { value };
      },
      8000,
      250,
      shouldCancel
    );
    const energy = energyReading ? energyReading.value : null;
    if (energy === null) throw new Error('사냥 종료 후 행동력을 읽지 못함');
    if (energy >= mod.config.minEnergy) {
      throw new Error(`행동력이 제한 이상으로 남음: ${energy}/2000 (기준 ${mod.config.minEnergy})`);
    }
    return `행동력 제한 도달 확인: ${energy}/2000`;
  };

  Modules.daily.verifyDeepDungeon = async function () {
    const shouldCancel = () => this.stopRequested || !Core.dailyActive;
    const mod = Modules.deepdungeon;
    const arrived = await mod.goToDeepDungeon(shouldCancel);
    if (shouldCancel()) throw new Error('사용자가 일일 실행을 정지했습니다.');
    if (!arrived) throw new Error('심층던전 화면 진입을 확인하지 못함');
    const damage = await mod.readWeeklyCumulativeDamage(shouldCancel);
    if (shouldCancel()) throw new Error('사용자가 일일 실행을 정지했습니다.');
    if (damage === null) throw new Error('심층던전 주간 누적 데미지를 읽지 못함');
    if (damage < 1000000) throw new Error(`주간 누적 데미지가 아직 100만 미만: ${damage.toLocaleString()}`);
    return `주간 누적 데미지 ${damage.toLocaleString()} 확인`;
  };

  Modules.daily.runCoreModule = async function (moduleId) {
    Core.moduleResults[moduleId] = { ok: null, message: '일일 작업에서 시작', at: Date.now() };
    const promise = Core.startModule(moduleId, { fromDaily: true });
    if (!promise) throw new Error(`${DAILY_STEP_LABELS[moduleId]} 시작이 차단됨`);
    await promise;
    const result = Core.moduleResults[moduleId];
    if (result && result.ok === false) throw new Error(result.message);
  };

  // ⚠ 사용자 요청(2026-08): 일일 퀘스트 "장인 정신"(아이템 조합 1회)을 위해
  // 마을 > 대장간 > 조합소 > 상자 카테고리에서 금 → 은 → 동 순서로 시도해
  // 1개 조합한다. 실전 확인: 목록의 "선택"/"확인" 버튼 텍스트는 재료 보유
  // 여부와 무관하다(둘 다 재료가 충분해도 라벨이 다르게 나옴) — 반드시
  // 클릭해서 확인 다이얼로그를 열고 "최대 N개 조합 가능" 문구로 실제
  // 조합 가능 여부를 판단해야 한다. 상자 셋 다 실패하면 가죽 카테고리로
  // 넘어간다(세부 우선순위는 추후 확정 - 지금은 상자만 구현).
  // ⚠ 사용자 요청(2026-08): 이 퀘스트는 "1회 조합"이면 완료되므로, 절대
  // 중복으로 조합하면 안 된다. 대장간에 가기 전에 먼저 퀘스트 화면에서
  // "장인 정신" 진행도(N/M)를 확인해서, 이미 완료(N>=M)면 대장간에 아예
  // 가지 않고 스킵한다. 이렇게 하면 "일일"을 하루에 여러 번 돌려도 두 번째
  // 부터는 조합 자체를 시도하지 않는다.
  Modules.daily.completeCraftQuestIfNeeded = async function () {
    await Core.clickNavMenuExact('캐릭', '퀘스트');
    const onQuestPage = await Core.waitFor(() => location.pathname.startsWith('/quests'), 15000, 300);
    if (!onQuestPage) {
      Core.log('daily', '⚠ 퀘스트 화면 진입을 확인하지 못해 아이템 조합 퀘스트를 건너뜁니다.');
      return false;
    }
    await Core.humanDelay(500, 900);

    const questText = Core.bodyText();
    const match = questText.match(/장인\s*정신\s*(\d+)\s*\/\s*(\d+)/);
    if (match && parseInt(match[1], 10) >= parseInt(match[2], 10)) {
      Core.log('daily', '"장인 정신" 퀘스트 이미 완료됨 - 조합 생략');
      return true;
    }

    return await Modules.daily.craftBoxQuestItem();
  };

  // ⚠ 사용자 요청(2026-08): 주간 퀘스트 "꾸준한 수행"(수행 5회)을 위해
  // 캐릭 > 수행 화면에서 "수행하기"를 눌러 나오는 "여러 번 수행하기"
  // 다이얼로그의 수량을 채운다. 기본값이 100(최대치)으로 잡혀 있어 그대로
  // 두면 안 되고, 실제로 필요한 횟수만 입력해야 한다 — 이미 몇 회 했는지도
  // 감안해 남은 횟수(목표-현재)만 정확히 채운다(실전 확인: 5회 실행 시
  // 숙련도 정확히 1,800×5 소모, 퀘스트 진행도 5/5로 정확히 반영됨).
  Modules.daily.completeCultivationQuestIfNeeded = async function () {
    await Core.clickNavMenuExact('캐릭', '퀘스트');
    const onQuestPage = await Core.waitFor(() => location.pathname.startsWith('/quests'), 15000, 300);
    if (!onQuestPage) {
      Core.log('daily', '⚠ 퀘스트 화면 진입을 확인하지 못해 수행 퀘스트를 건너뜁니다.');
      return false;
    }
    await Core.humanDelay(500, 900);

    const weeklyTab = await Core.retryStep('"주간" 탭 찾기', () => Core.findButtonByText('주간'));
    if (!weeklyTab) {
      Core.log('daily', '⚠ "주간" 탭을 찾지 못해 수행 퀘스트를 건너뜁니다.');
      return false;
    }
    if (!(await Core.safeClick(() => Core.findButtonByText('주간'), { beforeMin: 400, beforeMax: 700, afterMin: 700, afterMax: 1100 }))) {
      Core.log('daily', '⚠ "주간" 탭 클릭에 실패해 수행 퀘스트를 건너뜁니다.');
      return false;
    }

    const match = Core.bodyText().match(/꾸준한\s*수행\s*(\d+)\s*\/\s*(\d+)/);
    if (!match) {
      Core.log('daily', '⚠ "꾸준한 수행" 퀘스트 항목을 찾지 못했습니다.');
      return false;
    }
    const current = parseInt(match[1], 10);
    const target = parseInt(match[2], 10);
    if (current >= target) {
      Core.log('daily', '"꾸준한 수행" 퀘스트 이미 완료됨 - 생략');
      return true;
    }
    const remaining = target - current;

    await Core.clickNavMenuExact('캐릭', '수행');
    const onTrainingPage = await Core.waitFor(() => location.pathname.startsWith('/training'), 15000, 300);
    if (!onTrainingPage) {
      Core.log('daily', '⚠ 수행 화면 진입을 확인하지 못했습니다.');
      return false;
    }
    await Core.humanDelay(500, 900);

    const trainBtn = await Core.retryStep('"수행하기" 버튼 찾기', () => Core.findButtonByText('수행하기'));
    if (!trainBtn) {
      Core.log('daily', '⚠ "수행하기" 버튼을 찾지 못했습니다.');
      return false;
    }
    if (!(await Core.safeClick(() => Core.findButtonByText('수행하기'), { beforeMin: 500, beforeMax: 900, afterMin: 700, afterMax: 1100 }))) {
      Core.log('daily', '⚠ "수행하기" 버튼 클릭에 실패했습니다.');
      return false;
    }

    const dialog = await Core.waitFor(
      () => Core.gameElements('[role="dialog"]').find((d) => Core.isElementVisible(d) && d.textContent.includes('여러 번 수행하기')) || null,
      8000,
      250
    );
    if (!dialog) {
      Core.log('daily', '⚠ 수행 횟수 입력창을 찾지 못했습니다.');
      return false;
    }
    const input = dialog.querySelector('input');
    if (!input) {
      Core.log('daily', '⚠ 수행 횟수 입력칸을 찾지 못했습니다.');
      return false;
    }
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, String(remaining));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Core.humanDelay(400, 700);

    const confirmBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '수행하기');
    if (!confirmBtn) {
      Core.log('daily', '⚠ 수행 확인 버튼을 찾지 못했습니다.');
      return false;
    }
    confirmBtn.click();
    await Core.humanDelay(1200, 1800);
    Core.log('daily', `"꾸준한 수행" 퀘스트용 수행 ${remaining}회 완료`);
    return true;
  };

  // ⚠ 사용자 요청(2026-08): 일간 퀘스트 "대장간 이용"(대장간 수리 1회)을
  // 위해 마을 > 대장간 화면에서 활성화된 "수리" 버튼을 하나 누른다.
  // Core.repairAllEquipment는 내구도가 심각하게 낮을 때만 호출되는 함수라,
  // "그냥 아무거나 한 번 수리하면 되는" 이 퀘스트의 낮은 기준과 맞지 않아
  // 자연스러운 부산물로 채워지지 않았다(실전 확인: 자동사냥을 오래 돌려도
  // 내구도가 그 정도로까지 안 떨어지면 이 퀘스트만 항상 미완료로 남음).
  Modules.daily.completeRepairQuestIfNeeded = async function () {
    await Core.clickNavMenuExact('캐릭', '퀘스트');
    const onQuestPage = await Core.waitFor(() => location.pathname.startsWith('/quests'), 15000, 300);
    if (!onQuestPage) {
      Core.log('daily', '⚠ 퀘스트 화면 진입을 확인하지 못해 대장간 수리 퀘스트를 건너뜁니다.');
      return false;
    }
    await Core.humanDelay(500, 900);

    const match = Core.bodyText().match(/대장간\s*이용\s*(\d+)\s*\/\s*(\d+)/);
    if (!match) {
      Core.log('daily', '⚠ "대장간 이용" 퀘스트 항목을 찾지 못했습니다.');
      return false;
    }
    if (parseInt(match[1], 10) >= parseInt(match[2], 10)) {
      Core.log('daily', '"대장간 이용" 퀘스트 이미 완료됨 - 생략');
      return true;
    }

    await Core.clickNavMenuExact('마을', '대장간');
    const onBlacksmithPage = await Core.waitFor(() => location.pathname.startsWith('/blacksmith'), 15000, 300);
    if (!onBlacksmithPage) {
      Core.log('daily', '⚠ 대장간 화면 진입을 확인하지 못했습니다.');
      return false;
    }
    await Core.humanDelay(500, 900);

    const repairBtn = Core.gameElements('button').find(
      (b) => Core.isElementVisible(b) && /수리/.test(b.textContent) && !b.disabled
    );
    if (!repairBtn) {
      Core.log('daily', '수리 가능한 장비가 없습니다(전부 내구도 최대) - 대장간 이용 퀘스트를 이번엔 채우지 못함');
      return true;
    }
    if (!(await Core.safeClick(() => repairBtn, { beforeMin: 500, beforeMax: 900, afterMin: 700, afterMax: 1100 }))) {
      Core.log('daily', '⚠ 수리 버튼 클릭에 실패했습니다.');
      return false;
    }
    Core.log('daily', '일일 퀘스트용 장비 수리 완료');
    return true;
  };

  // ⚠ 사용자 요청(2026-08): 일간/주간 퀘스트 "보상 받기" 버튼도 자동으로
  // 누른다. 실전 확인: 확인창 없이 클릭 한 번으로 즉시 처리되고, 이미
  // 받았으면 버튼이 "수령 완료"로 바뀌며 disabled 상태가 된다. 7개 미만
  // 완료 상태면 "보상 받기 (N/7)"로 표시되지만 이때도 disabled라, 두
  // 경우 다 disabled 여부 하나로 정확히 "지금 받을 수 있는지"를 판별할
  // 수 있다(텍스트를 따로 안 봐도 됨).
  Modules.daily.claimQuestRewardIfReady = async function (tabLabel) {
    await Core.clickNavMenuExact('캐릭', '퀘스트');
    const onQuestPage = await Core.waitFor(() => location.pathname.startsWith('/quests'), 15000, 300);
    if (!onQuestPage) {
      Core.log('daily', `⚠ 퀘스트 화면 진입을 확인하지 못해 ${tabLabel} 퀘스트 보상 수령을 건너뜁니다.`);
      return false;
    }
    await Core.humanDelay(500, 900);

    if (tabLabel === '주간') {
      const weeklyTab = await Core.retryStep('"주간" 탭 찾기', () => Core.findButtonByText('주간'));
      if (!weeklyTab) {
        Core.log('daily', '⚠ "주간" 탭을 찾지 못해 주간 퀘스트 보상 수령을 건너뜁니다.');
        return false;
      }
      if (!(await Core.safeClick(() => Core.findButtonByText('주간'), { beforeMin: 400, beforeMax: 700, afterMin: 700, afterMax: 1100 }))) {
        Core.log('daily', '⚠ "주간" 탭 클릭에 실패해 주간 퀘스트 보상 수령을 건너뜁니다.');
        return false;
      }
    }

    const rewardBtn = Core.gameElements('button').find(
      (b) => Core.isElementVisible(b) && b.textContent.trim().startsWith('보상 받기') && !b.disabled
    );
    if (!rewardBtn) {
      Core.log('daily', `${tabLabel} 퀘스트 보상: 받을 것 없음(조건 미달이거나 이미 수령함)`);
      return true;
    }
    rewardBtn.click();
    await Core.humanDelay(1000, 1500);
    Core.log('daily', `${tabLabel} 퀘스트 보상 수령 완료`);
    return true;
  };

  // 일간/주간 퀘스트까지 처리한 뒤 캐릭 메뉴에 레드닷이 남아 있으면 업적을
  // 확인한다. 업적 카테고리의 작은 빨간 점이 있는 탭만 열고, disabled가
  // 아닌 "보상 수령" 버튼만 누른다. 한 번 수령한 뒤 다음 단계 보상이 바로
  // 활성화될 수 있으므로 같은 카테고리에서 받을 것이 없어질 때까지 반복한다.
  Modules.daily.claimAchievementRewardsIfIndicated = async function () {
    const shouldCancel = () => this.stopRequested || !Core.dailyActive;
    const hasRedDot = (root) => {
      if (!root) return false;
      if (root.querySelector('.MuiBadge-dot')) return true;
      return [...root.querySelectorAll('span, div')].some((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.width > 12 || rect.height > 12) return false;
        const color = getComputedStyle(el).backgroundColor;
        return color === 'rgb(244, 67, 54)' || color === 'rgb(239, 68, 68)' || color === 'rgb(255, 0, 0)';
      });
    };
    const characterButton = Core.allButtons().find(
      (button) => button.textContent.trim() === '캐릭' && Core.isElementVisible(button)
    );
    if (!hasRedDot(characterButton)) {
      Core.log('daily', '업적: 캐릭 레드닷 없음 - 확인 생략');
      return '캐릭 레드닷 없음';
    }

    Core.log('daily', '업적: 캐릭 레드닷 확인 - 활성 보상 확인 시작');
    await Core.clickNavMenuExact('캐릭', '업적', shouldCancel);
    const onAchievementPage = await Core.waitFor(
      () => location.pathname.startsWith('/achievements'),
      15000,
      300,
      shouldCancel
    );
    if (!onAchievementPage) throw new Error('업적 화면 진입을 확인하지 못했습니다.');
    await Core.humanDelay(500, 900);

    const topTabs = new Set(['업적', '칭호', '프로필']);
    const findRedCategoryTabs = () => Core.gameElements('button[role="tab"]').filter(
      (tab) => Core.isElementVisible(tab) && !topTabs.has(tab.textContent.trim()) && hasRedDot(tab)
    );
    const findClaimButton = () => Core.gameElements('button').find(
      (button) => Core.isElementVisible(button) && button.textContent.trim() === '보상 수령' && !button.disabled
    ) || null;

    let claimed = 0;
    let visitedTabs = 0;
    // 비정상 DOM 갱신으로 무한 반복하지 않도록 충분히 큰 상한을 둔다.
    for (let guard = 0; guard < 100 && !shouldCancel(); guard += 1) {
      const claimButton = findClaimButton();
      if (claimButton) {
        if (!(await Core.safeClick(findClaimButton, {
          beforeMin: 350,
          beforeMax: 650,
          afterMin: 700,
          afterMax: 1100,
          shouldCancel,
        }))) throw new Error('활성 업적 보상 버튼이 클릭 직전에 사라졌습니다.');
        claimed += 1;
        continue;
      }

      const redTabs = findRedCategoryTabs();
      if (redTabs.length === 0) break;
      const selectedRedTab = redTabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
      const targetTab = redTabs.find((tab) => tab !== selectedRedTab) || selectedRedTab;
      // 선택된 빨간 탭인데 받을 버튼이 없다면 다른 알림이거나 갱신 대기 상태다.
      // 같은 탭을 계속 누르지 않고 종료해 다음 일일 실행에서 다시 확인한다.
      if (!targetTab || targetTab === selectedRedTab) break;
      const targetLabel = targetTab.textContent.trim();
      if (!(await Core.safeClick(() => findRedCategoryTabs().find(
        (tab) => tab.textContent.trim() === targetLabel
      ), {
        beforeMin: 350,
        beforeMax: 650,
        afterMin: 600,
        afterMax: 900,
        shouldCancel,
      }))) throw new Error(`업적 "${targetLabel}" 탭 클릭에 실패했습니다.`);
      visitedTabs += 1;
    }

    Core.log('daily', `업적: 레드닷 카테고리 ${visitedTabs}개 확인, 보상 ${claimed}개 수령`);
    return `업적 보상 ${claimed}개 수령`;
  };

  Modules.daily.craftBoxQuestItem = async function () {
    await Core.clickNavMenuExact('마을', '대장간');
    const onCraftPage = await Core.waitFor(() => Core.bodyText().includes('조합소'), 15000, 300);
    if (!onCraftPage) {
      Core.log('daily', '⚠ 대장간 화면 진입을 확인하지 못해 아이템 조합을 건너뜁니다.');
      return false;
    }

    const craftTab = await Core.retryStep('"조합소" 탭 찾기', () => Core.findButtonByText('조합소'));
    if (!craftTab) {
      Core.log('daily', '⚠ "조합소" 탭을 찾지 못해 아이템 조합을 건너뜁니다.');
      return false;
    }
    if (!(await Core.safeClick(() => Core.findButtonByText('조합소'), { beforeMin: 500, beforeMax: 900, afterMin: 700, afterMax: 1100 }))) {
      Core.log('daily', '⚠ "조합소" 탭 클릭에 실패해 아이템 조합을 건너뜁니다.');
      return false;
    }

    // ⚠ 실전 확인: 카테고리 필터(전체/가죽/결정/상자/해방/던전/일반)도
    // 인벤토리 보상 필터처럼 다중 토글이다(aria-pressed로 확인). "상자"만
    // 켜기 전에 이미 켜져 있는 다른 카테고리를 먼저 꺼야, 엉뚱한 카테고리
    // 레시피가 섞여 heading 검색이 꼬이지 않는다. 또한 페이지 전환 직후라
    // 클릭이 씹히는 경우를 실전에서 확인해, 클릭 후 실제 상태를 재확인하고
    // 필요하면 재시도한다.
    const setOnlyCategory = async (targetLabel) => {
      const categoryLabels = ['가죽', '결정', '상자', '해방', '던전', '일반'];
      for (let attempt = 0; attempt < 3; attempt++) {
        let allCorrect = true;
        for (const label of categoryLabels) {
          const btn = Core.gameElements('button').find((b) => b.textContent.trim() === label && Core.isElementVisible(b));
          if (!btn) continue;
          const isPressed = btn.getAttribute('aria-pressed') === 'true';
          const shouldBePressed = label === targetLabel;
          if (isPressed !== shouldBePressed) {
            allCorrect = false;
            btn.click();
            await Core.humanDelay(400, 700);
          }
        }
        if (allCorrect) return true;
      }
      return false;
    };
    await setOnlyCategory('상자');

    // 재료가 여러 경로(같은 완제품 이름의 서로 다른 레시피 행)로 존재할 수
    // 있다(예: "가죽끈"은 재료가 "가죽"인 행과 "낡은 가죽끈"인 행 둘 다 있음).
    // 이런 경우 모든 행을 순서대로 시도한다.
    //
    // ⚠ 버그 수정(2026-08, 사용자 확인): 예전엔 텍스트가 label과 정확히
    // 일치하는 모든 leaf를 찾아 레시피 행으로 오인했는데, 이러면 "낡은
    // 가죽끈"처럼 결과물 칸뿐 아니라 다른 레시피의 "필요 재료" 칸에도 같은
    // 이름이 나오는 경우 그 재료 칸까지 레시피 후보로 잘못 집어서, 조합을
    // 의도치 않게 2번 시도하는 사고가 있었다(실전 확인: 낡은 가죽끈이
    // "2회 조합됐다"는 게임 메시지). 실제 목록은 <tr><td>결과물</td>
    // <td>필요재료</td><td>버튼</td></tr> 테이블 구조이므로, 첫 번째 td
    // (결과물 칸)만 label과 비교해야 정확하다.
    const tryCraft = async (label) => {
      const findRecipeRows = () =>
        Core.gameElements('tr').filter((tr) => {
          const firstCell = tr.querySelector('td');
          return firstCell && firstCell.textContent.trim() === label && Core.isElementVisible(tr);
        });
      const rowCount = findRecipeRows().length;
      for (let variant = 0; variant < rowCount; variant++) {
        const getRow = () => findRecipeRows()[variant] || null;
        const getBtn = () => {
          const row = getRow();
          if (!row) return null;
          return [...row.querySelectorAll('button')].find((b) => ['선택', '확인'].includes(b.textContent.trim()));
        };
        if (!getBtn()) continue;
        if (!(await Core.safeClick(getBtn, { beforeMin: 400, beforeMax: 700, afterMin: 700, afterMax: 1100 }))) continue;

        const dialog = await Core.waitFor(
          () => Core.gameElements('[role="dialog"]').find((d) => Core.isElementVisible(d) && d.textContent.includes('조합 확인')) || null,
          8000,
          250
        );
        if (!dialog) continue;

        // ⚠ 실전 확인(2026-08): 조합 확인창은 레시피에 따라 두 형식이다.
        //   1) 고정 필요 재료 개수(예: "금의 상자" - 조각 6개, 성공률
        //      100%) - 재료가 충분하면 바로 "조합" 버튼이 활성화된다.
        //   2) 투입 수량을 라디오로 선택(예: "가죽끈" - 4개 100%/3개
        //      85%/2개 70%) - 라디오를 하나 선택해야 "조합" 버튼이
        //      활성화된다.
        // 두 형식 모두 "조합" 버튼 클릭 = 정확히 1회 시도다. "N개 투입"은
        // "N회 시도"가 아니라 "1회 시도에 재료 N개를 써서 성공률을 높인다"
        // 는 뜻임을 실전으로 확인했다(2개 옵션으로 1회 시도 → "조합에
        // 실패했습니다" 메시지 정확히 1번, 골드·재료도 1회분만 소모).
        // 라디오가 있으면 재료를 아끼기 위해 가장 낮은 투입량(화면에
        // 나열된 순서상 마지막 옵션, 성공률도 가장 낮음)을 선택한다.
        const radios = [...dialog.querySelectorAll('input[type="radio"]')];
        if (radios.length > 0) {
          radios[radios.length - 1].click();
          await Core.humanDelay(300, 500);
        }

        const confirmBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '조합');
        if (confirmBtn && !confirmBtn.disabled) {
          confirmBtn.click();
          await Core.humanDelay(1000, 1600);
          Core.log('daily', `일일 퀘스트용 아이템 조합 시도 완료: ${label}`);
          return true;
        }
        const cancelBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '취소');
        if (cancelBtn) cancelBtn.click();
        await Core.humanDelay(400, 700);
      }
      return false;
    };

    for (const label of ['금의 상자', '은의 상자', '동의 상자']) {
      if (await tryCraft(label)) return true;
    }

    // ⚠ 사용자 요청(2026-08): 상자 카테고리에서 전부 실패하면 가죽 카테고리로
    // 넘어간다. 우선순위(사용자 지정): 고급 가죽끈 → 가죽끈 → 낡은 가죽끈.
    Core.log('daily', '상자 카테고리에서 조합 가능한 재료가 없어 가죽 카테고리로 전환합니다.');
    await setOnlyCategory('가죽');

    for (const label of ['고급 가죽끈', '가죽끈', '낡은 가죽끈']) {
      if (await tryCraft(label)) return true;
    }

    Core.log('daily', '상자·가죽 카테고리 모두에서 조합 가능한 재료가 없습니다.');
    return false;
  };

  // ⚠ 사용자 요청(2026-08): 심층던전(보상 3종)/아레나(지난 주 순위 보상)를
  // 각 매크로가 실제로 돌아가는지와 완전히 무관하게, "일일" 실행 시 이번
  // 주에 한 번만 확인해서 받는다. 아레나는 토·일에만 진입 가능한데 보상은
  // 월~금에만 받을 수 있어, 아레나 매크로 자체에 묶으면 영영 못 받는 모순이
  // 생긴다는 걸 사용자가 명확히 지적함 — 그래서 여기 daily 레벨에서 독립
  // 처리한다.
  Modules.daily.claimWeeklyRewardsIfDue = async function () {
    const weekId = Core.getKstMondayWeekId();
    const results = [];

    if (localStorage.getItem(DD_REWARD_WEEK_KEY) === weekId) {
      results.push('심층던전: 이번 주 이미 확인함');
    } else {
      const ok = await Modules.deepdungeon.claimWeeklyWorldBossRewards();
      if (ok) {
        localStorage.setItem(DD_REWARD_WEEK_KEY, weekId);
        results.push('심층던전: 확인 완료');
      } else {
        results.push('심층던전: 확인 실패(다음 실행 시 재시도)');
      }
    }

    if (localStorage.getItem(ARENA_REWARD_WEEK_KEY) === weekId) {
      results.push('아레나: 이번 주 이미 확인함');
    } else {
      const ok = await Modules.arena.claimLastWeekRewardIfAny();
      if (ok) {
        localStorage.setItem(ARENA_REWARD_WEEK_KEY, weekId);
        results.push('아레나: 확인 완료');
      } else {
        results.push('아레나: 확인 실패(다음 실행 시 재시도)');
      }
    }

    return results.join(' / ');
  };

  // ⚠ 사용자 요청(2026-08): 길드 보스(히드라)는 화·목에 길드마스터가
  // 소환하고, 개인 보상은 레이드가 끝난 뒤 그 화면(/guild/boss)에서
  // "개인 보상 수령하기"로 받는다. 화·목 다음날인 수·금에 확인해야 한다
  // (실전 확인: 레이드 종료 후에도 결과·보상 화면은 계속 접근 가능하고,
  // 수령하면 확인창 없이 즉시 처리되며 버튼이 "개인 보상 수령 완료"로
  // 바뀜). 하루에 여러 번 일일을 돌려도 같은 날 재확인 안 하도록 KST
  // 날짜로 캐시한다.
  Modules.daily.claimGuildBossRewardIfDue = async function () {
    const kstDay = Core.getKstDayOfWeek();
    if (kstDay !== 3 && kstDay !== 5) {
      return '길드 보스 보상: 오늘은 확인 요일이 아님(수·금만 확인)';
    }
    const todayKey = Modules.arena.todayKey();
    if (localStorage.getItem(GUILD_BOSS_REWARD_DAY_KEY) === todayKey) {
      return '길드 보스 보상: 오늘 이미 확인함';
    }

    try {
      await Modules.guildboss.goToGuildBossScreen();
    } catch (e) {
      Core.log('daily', `⚠ 길드 보스 화면 진입 실패(이번 주 소환이 없었을 수 있음): ${e.message}`);
      return '길드 보스 보상: 화면 진입 실패(다음 실행 시 재시도)';
    }

    const claimBtn = Core.findButtonByText('개인 보상 수령하기');
    if (!claimBtn) {
      localStorage.setItem(GUILD_BOSS_REWARD_DAY_KEY, todayKey);
      return '길드 보스 개인 보상: 받을 것 없음(이미 수령했거나 보상 없음)';
    }
    if (!(await Core.safeClick(() => claimBtn, { beforeMin: 500, beforeMax: 900, afterMin: 1000, afterMax: 1500 }))) {
      return '길드 보스 보상: 수령 버튼 클릭 실패(다음 실행 시 재시도)';
    }
    localStorage.setItem(GUILD_BOSS_REWARD_DAY_KEY, todayKey);
    return '길드 보스 개인 보상 수령 완료';
  };

  // ⚠ 사용자 요청(2026-08, 실전 확인): 길드 화면(/guild, "길드 정보" 탭)에
  // "마을 효과 명성 받기 (+명성 25)" 버튼이 있으면 눌러서 받는다. 확인창
  // 없이 즉시 "일일 명성 25을 획득했습니다!"로 처리되고, 받고 나면 버튼
  // 자체가 화면에서 사라진다(하루 1회로 추정). 버튼 존재 여부만 매번
  // 확인하면 되므로 별도 날짜 캐시는 필요 없다.
  Modules.daily.claimGuildTownEffectReputationIfAvailable = async function () {
    try {
      await Modules.guildboss.goToGuildScreen();
    } catch (e) {
      Core.log('daily', `⚠ 길드 화면 진입 실패(마을효과 명성 확인 생략): ${e.message}`);
      return '길드 마을효과 명성: 화면 진입 실패';
    }
    await Core.humanDelay(500, 900);

    const findClaimBtn = () =>
      Core.gameElements('button').find((b) => Core.isElementVisible(b) && b.textContent.includes('마을 효과 명성 받기'));
    const claimBtn = findClaimBtn();
    if (!claimBtn) {
      return '길드 마을효과 명성: 받을 것 없음(이미 받았거나 없음)';
    }
    if (!(await Core.safeClick(findClaimBtn, { beforeMin: 500, beforeMax: 900, afterMin: 900, afterMax: 1400 }))) {
      return '길드 마을효과 명성: 수령 버튼 클릭 실패(다음 실행 시 재시도)';
    }
    return '길드 마을효과 명성(+25) 수령 완료';
  };

  // ⚠ 사용자 요청(2026-08, 실전 확인): 편지함에 매번 들어가지 않고, 먼저
  // 계정 드롭다운의 "편지" 메뉴 항목에 붙는 레드닷(MUI Badge,
  // .MuiBadge-badge)이 있을 때만 편지함에 들어간다. 안 읽은 메일은
  // fontWeight가 700(굵게)으로 표시되고, 클릭해서 열면 즉시 읽음 처리되며
  // (fontWeight가 400으로 바뀜), 첨부 아이템이 있는 메일은 목록 행에
  // svg[aria-label="미수령 아이템 있음"] 아이콘이 붙고 상세 다이얼로그에
  // "아이템 수령하기" 버튼이 뜬다(확인창 없이 즉시 수령 처리됨).
  Modules.daily.checkMailIfDue = async function () {
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
    if (!accountBtn) {
      return '메일함: 계정 아이콘을 찾지 못해 확인 생략';
    }
    if (!(await Core.safeClick(findAccountIconBtn, { beforeMin: 400, beforeMax: 700, afterMin: 600, afterMax: 1000 }))) {
      return '메일함: 계정 아이콘 클릭 실패로 확인 생략';
    }

    const mailItem = await Core.waitFor(
      () => Core.gameElements('[role="menuitem"]').find((el) => el.textContent.trim().startsWith('편지') && Core.isElementVisible(el)),
      8000,
      200
    );
    if (!mailItem) {
      return '메일함: "편지" 메뉴 항목을 찾지 못해 확인 생략';
    }

    // 레드닷(안 읽은 메일 배지)이 없으면 편지함 자체에 들어가지 않는다.
    const badge = mailItem.querySelector('.MuiBadge-badge');
    if (!badge || !badge.textContent.trim()) {
      // 드롭다운을 연 채로 두지 않도록 닫는다.
      document.body.click();
      return '메일함: 안 읽은 메일 없음(레드닷 없음) - 진입 생략';
    }
    const unreadCountAtStart = parseInt(badge.textContent.trim(), 10) || 0;

    mailItem.click();
    const onMailPage = await Core.waitFor(() => location.pathname.startsWith('/mail'), 15000, 300);
    if (!onMailPage) {
      return '메일함: 화면 진입을 확인하지 못함';
    }
    await Core.humanDelay(500, 900);

    let processed = 0;
    let claimedAttachments = 0;
    const maxIterations = 50;
    for (let i = 0; i < maxIterations; i++) {
      const rows = Core.gameElements('tr').filter((tr) => tr.querySelector('td') && Core.isElementVisible(tr));
      const unreadRow = rows.find((tr) => getComputedStyle(tr.querySelector('td')).fontWeight === '700');
      if (!unreadRow) break;

      const hasAttachment = !!unreadRow.querySelector('svg[aria-label="미수령 아이템 있음"]');
      if (!(await Core.safeClick(() => unreadRow, { beforeMin: 400, beforeMax: 700, afterMin: 800, afterMax: 1200 }))) {
        break;
      }
      processed++;

      const dialog = await Core.waitFor(
        () => Core.gameElements('[role="dialog"]').find((d) => Core.isElementVisible(d)) || null,
        6000,
        250
      );
      if (dialog) {
        if (hasAttachment) {
          const claimBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '아이템 수령하기');
          if (claimBtn) {
            claimBtn.click();
            await Core.humanDelay(900, 1400);
            claimedAttachments++;
          }
        }
        const closeBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '닫기');
        if (closeBtn) closeBtn.click();
        await Core.humanDelay(400, 700);
      }
    }

    Core.log(
      'daily',
      `메일함: 안 읽은 메일 ${unreadCountAtStart}건 확인, 읽음 처리 ${processed}건, 첨부 아이템 수령 ${claimedAttachments}건`
    );
    return `메일함: ${processed}건 읽음 처리(첨부 수령 ${claimedAttachments}건)`;
  };

  Modules.daily.runStep = async function (step) {
    if (step === 'weeklyRewards') {
      return await this.claimWeeklyRewardsIfDue();
    }
    if (step === 'dailyQuests') {
      // ⚠ 버그 수정(2026-08, 사용자 확인): 예전엔 아래 하위 작업들을 개별
      // try/catch 없이 순차로 그냥 await했다. 이러면 앞쪽 작업(특히
      // completeCraftQuestIfNeeded가 맨 처음이라 가장 취약) 중 하나가
      // Core.clickNavMenuExact 같은 공용 헬퍼의 예외(메뉴 버튼/항목을
      // 못 찾음 - 예: 이전 단계(던전/보스 등)가 화면을 이상한 상태로
      // 남겨서 발생)를 만나면, 그 즉시 dailyQuests 전체가 중단되고 뒤에
      // 있던 나머지(특히 주간 퀘스트 확인·수령)가 통째로 스킵됐다(사용자가
      // "일일 돌렸는데 주간 퀘스트를 안 받은 계정이 있다"고 실전에서
      // 발견). 이제 각 하위 작업을 개별 try/catch로 감싸서, 하나가
      // 실패해도 나머지는 계속 시도한다.
      const runSubTask = async (name, fn) => {
        try {
          return await fn();
        } catch (e) {
          Core.log('daily', `⚠ [dailyQuests] "${name}" 실패(다음 작업은 계속 진행): ${e.message}`);
          return false;
        }
      };

      // "장인 정신"(아이템 조합), "대장간 이용"(수리) 구현됨. 다른 항목이
      // 추가되면 이 자리에 이어서 호출한다.
      const craftOk = await runSubTask('아이템 조합', () => this.completeCraftQuestIfNeeded());
      const repairOk = await runSubTask('장비 수리', () => this.completeRepairQuestIfNeeded());
      await runSubTask('일간 보상 수령', () => this.claimQuestRewardIfReady('일간'));

      // ⚠ 사용자 요청(2026-08): 주간 퀘스트도 요일 제약(예전엔 주말에만)
      // 없이 매일 확인하고, 일간 퀘스트 보상 받을 때 같이 처리한다.
      // "길드의 용사"(길드 보스 공격)는 길드보스 매크로로 자연히 채워지고,
      // "꾸준한 수행"은 직접 완료시킨다. "낚시광"은 자동화를 시도했다가
      // 사용자 요청으로 다시 뺐다 - 탭이 원격/백그라운드로 밀리면 게임 내
      // 자동 낚시 타이머 자체가 거의 안 흐르는 현상이 실전에서 확인돼서,
      // 무인 실행 시 이 단계에서 사실상 멈춘 것처럼 오래 걸릴 수 있었다.
      const cultivationOk = await runSubTask('꾸준한 수행', () => this.completeCultivationQuestIfNeeded());
      await runSubTask('주간 보상 수령', () => this.claimQuestRewardIfReady('주간'));

      const achievementResult = await runSubTask('업적 보상 확인', () => this.claimAchievementRewardsIfIndicated());
      if (achievementResult) Core.log('daily', achievementResult);

      // ⚠ 사용자 요청(2026-08): 길드 보스(히드라) 개인 보상도 일간 퀘스트
      // 보상을 받을 때 같이 처리한다.
      const guildBossResult = await runSubTask('길드 보스 보상', () => this.claimGuildBossRewardIfDue());
      if (guildBossResult) Core.log('daily', guildBossResult);

      // ⚠ 사용자 요청(2026-08): 길드 화면의 "마을 효과 명성 받기"도 같이 확인한다.
      const townEffectResult = await runSubTask('길드 마을효과 명성', () => this.claimGuildTownEffectReputationIfAvailable());
      if (townEffectResult) Core.log('daily', townEffectResult);

      // ⚠ 사용자 요청(2026-08, 실전 확인): 레드닷(안 읽은 메일 배지)이 있을
      // 때만 편지함에 들어가서 안 읽은 메일을 전부 읽고, 첨부 아이템이
      // 있으면 같이 수령한다.
      const mailResult = await runSubTask('메일함 확인', () => this.checkMailIfDue());
      if (mailResult) Core.log('daily', mailResult);

      return craftOk && repairOk && cultivationOk
        ? '일간+주간 퀘스트 처리 완료'
        : '일간/주간 퀘스트 일부 처리 실패(로그에서 어느 항목인지 확인)';
    }
    if (step === 'attendance') {
      return await this.runAttendance();
    }
    if (step === 'dungeon') {
      await this.runCoreModule('dungeon');
      const dungeonResult = await this.verifyDungeon();
      // ⚠ 버그 수정(2026-08): 주석엔 "보스(그리고 던전)를 잡고 나면 보상
      // 상자를 사용한다"고 적혀 있었는데, 실제로는 boss 단계에만 연결돼
      // 있고 dungeon 단계엔 호출 자체가 빠져 있었다(사용자가 "안 쓰는 것
      // 같다"고 지적해서 발견함). 보스와 동일하게, 실패해도 일일 시퀀스를
      // 멈추지 않고 로그만 남긴다.
      try {
        await Core.useAllRewardBoxes('dungeon');
      } catch (e) {
        Core.log('dungeon', `⚠ 보상 상자 자동 사용 실패(던전 완료 자체는 완료됨): ${e.message}`);
      }
      return dungeonResult;
    }
    if (step === 'arena') {
      await this.runCoreModule('arena');
      const count = Modules.arena.readTodayBattleCount();
      const gemProgress = Modules.arena.readBattleGemProgress();
      if (gemProgress && gemProgress.current >= gemProgress.max) {
        return `오늘 아레나 ${count}회 완료(전투 보석 ${gemProgress.current}/${gemProgress.max}개 확인)`;
      }
      const energyCost = Modules.arena.readNextBattleEnergyCost();
      if (gemProgress && energyCost && energyCost.amount >= 2) {
        return `아레나 안전 중지: 보석 ${gemProgress.current}/${gemProgress.max}개, 필요 에너지 ${energyCost.amount}`;
      }
      throw new Error(
        `아레나 완료 확인 실패: 보석 ${gemProgress ? `${gemProgress.current}/${gemProgress.max}` : '읽기 실패'}, ` +
        `에너지 ${energyCost ? energyCost.raw : '읽기 실패'} (오늘 ${count ?? '읽기 실패'}회)`
      );
    }
    // ⚠ 사용자 요청(2026-08): 프리시즌 기간엔 정규 아레나와 별개로 평일에도
    // 돌려야 한다. 화면/버튼 구조가 동일해 Modules.arena.readTodayBattleCount
    // (this 안 쓰는 순수 함수)를 그대로 재사용해 검증한다.
    if (step === 'preseason') {
      await this.runCoreModule('preseason');
      const progress = Modules.preseason.readAutumnTokenProgress();
      if (!progress || (progress.today.current < progress.today.max && progress.weekly.current < progress.weekly.max)) {
        throw new Error('가을 심층던전 아레나 완료 확인 실패: 오늘/주간 단풍 토큰 진행률이 한도에 도달하지 않았습니다.');
      }
      // 가을 이벤트 인벤토리의 "단풍 토큰"도 같은 단계에서 전부 사용한다.
      try {
        await Modules.preseason.useAutumnTokens();
      } catch (e) {
        Core.log('preseason', `⚠ 단풍 토큰 자동 사용 실패(심층던전 아레나 전투 자체는 완료됨): ${e.message}`);
      }
      return `가을 심층던전 아레나 완료: 오늘 ${progress.today.current}/${progress.today.max}, 주간 ${progress.weekly.current}/${progress.weekly.max}`;
    }
    if (step === 'boss') {
      const boss = await Core.waitFor(() => window.__bossMacro || null, 10000, 250, null);
      if (!boss || typeof boss.runDailySelectedBosses !== 'function') {
        throw new Error('보스 일일 실행 엔진을 찾지 못함');
      }
      const bossResult = await boss.runDailySelectedBosses();
      // ⚠ 사용자 요청(2026-08): 보스(그리고 던전)를 잡고 나면 보상으로 쌓이는
      // "N의 보상" 상자들을 전부 사용한다. 보상 상자 사용 자체가 실패해도
      // 보스 처치라는 본 목표는 이미 달성된 것이므로, 여기서 에러가 나도
      // 일일 시퀀스 전체를 멈추지 않고 로그만 남긴다.
      try {
        await Core.useAllRewardBoxes('boss');
      } catch (e) {
        Core.log('boss', `⚠ 보상 상자 자동 사용 실패(보스 처치 자체는 완료됨): ${e.message}`);
      }
      return bossResult;
    }
    if (step === 'autohunt') {
      await this.runCoreModule('autohunt');
      return await this.verifyAutohunt();
    }
    if (step === 'deepdungeon') {
      const mod = Modules.deepdungeon;
      const shouldCancel = () => this.stopRequested || !Core.dailyActive;
      const arrived = await mod.goToDeepDungeon(shouldCancel);
      if (shouldCancel()) throw new Error('사용자가 일일 실행을 정지했습니다.');
      if (!arrived) throw new Error('심층던전 화면 진입을 확인하지 못함');
      const before = await mod.readWeeklyCumulativeDamage(shouldCancel);
      if (shouldCancel()) throw new Error('사용자가 일일 실행을 정지했습니다.');
      if (before === null) throw new Error('심층던전 시작 전 주간 누적 데미지를 읽지 못함');
      if (before >= 1000000) return `이미 주간 누적 데미지 ${before.toLocaleString()} - 실행 생략`;

      const previousRetry = mod.config.retryIfWeeklyDamageUnder1M;
      mod.config.retryIfWeeklyDamageUnder1M = true;
      try {
        await this.runCoreModule('deepdungeon');
      } finally {
        mod.config.retryIfWeeklyDamageUnder1M = previousRetry;
      }
      return await this.verifyDeepDungeon();
    }
    throw new Error(`알 수 없는 일일 단계: ${step}`);
  };

  Modules.daily.mainLoop = async function () {
    let state = this.loadState();
    if (!state) return;
    let auth = null;
    try {
      auth = JSON.parse(sessionStorage.getItem(DAILY_AUTH_KEY) || 'null');
    } catch (e) {
      auth = null;
    }
    // 지연된 mainLoop 호출이 정지 뒤 도착해도 실행 상태를 다시 살리지 못한다.
    if (
      !auth ||
      auth.schema !== DAILY_AUTH_SCHEMA ||
      auth.startedAt !== state.startedAt ||
      this.stopRequested
    ) return;
    Core.dailyActive = true;
    this.running = true;
    Core.updateModuleButtons();

    while (state.running && state.index < state.steps.length && !this.stopRequested) {
      const step = state.steps[state.index];
      const label = DAILY_STEP_LABELS[step] || step;
      Core.log('daily', `▶ [${state.index + 1}/${state.steps.length}] ${label} 시작`);
      try {
        const detail = await this.runStep(step);
        state.reports.push({ step, label, ok: true, detail });
        Core.log('daily', `✅ ${label}: ${detail}`);
      } catch (e) {
        if (this.stopRequested) break;
        const detail = e && e.message ? e.message : String(e);
        state.reports.push({ step, label, ok: false, detail });
        Core.log('daily', `⚠ ${label} 이슈: ${detail} → 다음 작업으로 이동`);
      }
      if (this.stopRequested) break;
      state.index += 1;
      this.saveState(state);
      await Core.humanDelay(900, 1600);
    }

    const stopped = this.stopRequested || !state.running;
    state.running = false;
    this.saveState(state);
    Core.dailyActive = false;
    this.running = false;
    Core.activeModuleId = null;
    Core.backgroundKeeper.release('daily');
    Core.updateModuleButtons();

    if (stopped) {
      Core.moduleResults.daily = {
        ok: false,
        stopped: true,
        message: '사용자 요청으로 일일 연속 실행을 정지했습니다.',
        at: Date.now(),
      };
      Core.showBanner('daily', '사용자 요청으로 일일 연속 실행을 정지했습니다.', false);
      return Core.moduleResults.daily;
    }

    const issues = state.reports.filter((report) => !report.ok);
    const summary = state.reports
      .map((report) => `${report.ok ? '✅' : '⚠'} ${report.label}: ${report.detail}`)
      .join('\n');
    if (issues.length === 0) {
      Core.moduleResults.daily = {
        ok: true,
        stopped: false,
        message: '선택한 일일 작업을 모두 완료하고 사후 확인했습니다.',
        reports: state.reports.slice(),
        at: Date.now(),
      };
      Core.showBanner('daily', '선택한 일일 작업을 모두 완료하고 사후 확인했습니다.', true);
      Core.playCompleteSound();
    } else {
      Core.moduleResults.daily = {
        ok: false,
        stopped: false,
        message: `${issues.length}개 작업에서 이슈가 있었습니다.`,
        reports: state.reports.slice(),
        at: Date.now(),
      };
      Core.showBanner('daily', `${issues.length}개 작업에서 이슈가 있었습니다. 일일 로그를 확인해주세요.`, false);
      Core.playStopSound();
    }
    alert(`일일 연속 실행 결과\n\n${summary || '실행한 작업 없음'}`);
    return Core.moduleResults.daily;
  };

  Core.startDaily = function () {
    const mod = Modules.daily;
    if (Core.dailyActive || mod.running || Core.activeModuleId) {
      Core.showBanner('daily', '다른 작업이 실행 중입니다. 정지 후 다시 시작해주세요.');
      return;
    }
    // ⚠ 사용자 요청(2026-08): 심층던전(주 1회)과 아레나(주말 한정)는 자주
    // 열리지 않으므로 우선순위를 뒤로 미룬다. 던전 → 보스 → 사냥 → 심층던전
    // → 아레나 순서로 실행한다. 주간 보상(weeklyRewards)은 체크박스 설정과
    // 무관하게 항상 맨 먼저 실행한다(해당 매크로를 안 돌려도 반드시 받아야
    // 하는 보상이기 때문). 일간 퀘스트(dailyQuests)는 다른 모든 단계가
    // 끝난 뒤에야 정확한 진행도를 확인할 수 있으므로 항상 맨 마지막에
    // 실행한다(매일). 주간 퀘스트는 이제 요일 제약 없이 매일 dailyQuests
    // 단계 안에서 함께 확인·처리한다(예전엔 토·일에만 별도 실행했음).
    // ⚠ 사용자 요청(2026-08): 매일 순서가 똑같으면 패턴이 뻔해서, "일일 작업
    // 순서 랜덤" 체크박스가 켜져 있으면 아래 중간 작업들만 실행마다 무작위로
    // 섞는다(weeklyRewards/attendance/dailyQuests는 진행도 확인 순서상
    // 절대 고정 — 섞지 않음). 한 번 섞은 순서는 state.steps에 그대로 저장돼
    // mainLoop가 순서대로 소비하므로, 탭 복원 등으로 재개되어도 도중에 다시
    // 섞이지 않는다.
    const enabledMiddleSteps = DAILY_RANDOMIZABLE_STEPS.filter((key) => mod.config[key]);
    const middleSteps = mod.config.randomOrder
      ? Core.shuffleArray(enabledMiddleSteps)
      : enabledMiddleSteps;
    const steps = [
      'weeklyRewards',
      'attendance',
      ...middleSteps,
      'dailyQuests',
    ];
    if (mod.config.randomOrder) {
      const orderLabels = middleSteps.map((key) => DAILY_STEP_LABELS[key] || key).join(' → ');
      Core.log('daily', `🔀 일일 작업 순서 랜덤 적용: ${orderLabels || '(선택된 작업 없음)'}`);
    }
    if (
      steps.includes('dungeon') &&
      !Core.ELEMENT_OPTIONS.includes(Modules.dungeon.config.originalElement)
    ) {
      Core.showBanner('daily', '던전 탭에서 원래 속성을 먼저 선택해주세요.');
      return;
    }
    if (
      steps.includes('autohunt') &&
      !Core.ELEMENT_OPTIONS.includes(Modules.autohunt.config.originalElement)
    ) {
      Core.showBanner('daily', '자동사냥 탭에서 원래 속성을 먼저 선택해주세요.');
      return;
    }
    if (
      steps.includes('deepdungeon') &&
      !Core.ELEMENT_OPTIONS.includes(Modules.deepdungeon.config.originalElement)
    ) {
      Core.showBanner('daily', '심층던전 탭에서 원래 속성을 먼저 선택해주세요.');
      return;
    }
    if (steps.includes('boss')) {
      const checkedBosses = [...document.querySelectorAll('#lrm-boss-ref-panel .lrm-boss-check:checked')];
      if (checkedBosses.length === 0) {
        Core.showBanner('daily', '보스 탭에서 일일 실행할 보스를 하나 이상 체크해주세요.');
        return;
      }
    }
    const state = {
      running: true,
      index: 0,
      steps,
      reports: [],
      startedAt: Date.now(),
    };
    mod.stopRequested = false;
    Core.moduleResults.daily = { ok: null, stopped: false, message: '실행 중', at: Date.now() };
    Core.backgroundKeeper.acquire('daily');
    sessionStorage.setItem(DAILY_AUTH_KEY, JSON.stringify({
      schema: DAILY_AUTH_SCHEMA,
      startedAt: state.startedAt,
      issuedAt: Date.now(),
    }));
    // 사용자가 새 일일 실행을 명시적으로 누른 경우에만 이전 보스 정지
    // 래치를 해제한다.
    if (window.__bossMacro && typeof window.__bossMacro.armBossRun === 'function') {
      window.__bossMacro.armBossRun();
    }
    mod.saveState(state);
    let loopPromise;
    loopPromise = mod.mainLoop()
      .catch((e) => {
        Core.dailyActive = false;
        mod.running = false;
        Core.moduleResults.daily = {
          ok: false,
          stopped: false,
          message: e && e.message ? e.message : String(e),
          at: Date.now(),
        };
        Core.showBanner('daily', `일일 실행 자체 오류: ${e.message}`, false);
        Core.updateModuleButtons();
      })
      .finally(() => {
        if (mod.loopPromise === loopPromise) mod.loopPromise = null;
        Core.backgroundKeeper.release('daily');
      });
    mod.loopPromise = loopPromise;
    return loopPromise;
  };

  Core.stopDaily = function () {
    const mod = Modules.daily;
    mod.stopRequested = true;
    Core.backgroundKeeper.release('daily');
    sessionStorage.removeItem(DAILY_AUTH_KEY);
    const state = mod.loadState();
    if (state) {
      state.running = false;
      mod.saveState(state);
    }
    if (Core.activeModuleId && Modules[Core.activeModuleId]) {
      Core.requestStopModule(Core.activeModuleId, { fromDailyStop: true });
    }
    if (window.__bossMacro) {
      if (typeof window.__bossMacro.clearBossRunState === 'function') {
        if (typeof window.__bossMacro.requestImmediateStop === 'function') {
          window.__bossMacro.requestImmediateStop();
        } else {
          window.__bossMacro.clearBossRunState();
        }
      } else {
        window.__bossMacro.stopRequested = true;
        localStorage.setItem('lrm-boss-ref-user-stopped', String(Date.now()));
        localStorage.removeItem('lrm-boss-ref-pending');
        localStorage.removeItem('lrm-boss-ref-queue');
      }
    }
  };

  // Runtime Host와 수동 UI가 같은 Core 상태/정지 수명주기를 사용하도록 하는
  // 좁은 공유 계약이다. 게임 로직이나 네트워크 호출은 이 표면에 복제하지
  // 않는다. 원격 start는 exact-session bridge가 발급한 명시 승인만 허용한다.
  const SHARED_CORE_ADAPTER_VERSION = '1.0.0';
  const SHARED_CORE_RUNTIME_VERSION = '1.2.0-daily-adapter';
  const EXECUTION_LEASE_KEY = 'lanis:shared-core:execution-lease:v1';
  const EXECUTION_LEASE_CHANNEL = 'lanis:shared-core:execution-lease:liveness:v1';
  const EXECUTION_LEASE_PROBE_MS = 250;
  const executionTabId = (() => {
    const key = 'lanis:shared-core:execution-tab-id:v1';
    let value = sessionStorage.getItem(key);
    if (!value) {
      value = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(key, value);
    }
    return value;
  })();
  const executionLeaseChannel = typeof BroadcastChannel === 'function'
    ? new BroadcastChannel(EXECUTION_LEASE_CHANNEL)
    : null;
  let ownedExecutionLease = null;

  const readExecutionLease = () => {
    try {
      const value = JSON.parse(localStorage.getItem(EXECUTION_LEASE_KEY) || 'null');
      return value && value.schema === 'execution-lease-v1' && value.state === 'running'
        ? value
        : null;
    } catch (_) {
      return null;
    }
  };
  const publicLease = (lease) => lease ? ({
    owner: lease.owner,
    job: lease.job,
    sessionId: lease.sessionId,
    startedAt: lease.startedAt,
    state: lease.state,
  }) : null;
  const coreDailyIsRunning = () => !!(Core.dailyActive || Modules.daily.running);
  const releaseExecutionLease = (leaseId) => {
    const current = readExecutionLease();
    if (current && current.leaseId === leaseId && current.tabId === executionTabId) {
      localStorage.removeItem(EXECUTION_LEASE_KEY);
    }
    if (ownedExecutionLease && ownedExecutionLease.leaseId === leaseId) ownedExecutionLease = null;
  };
  const probeLeaseOwner = (lease) => new Promise((resolve) => {
    if (!executionLeaseChannel) {
      resolve(null);
      return;
    }
    const probeId = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    const onMessage = (event) => {
      const value = event && event.data;
      if (!value || value.type !== 'lease-alive' || value.probeId !== probeId || value.leaseId !== lease.leaseId) return;
      settled = true;
      executionLeaseChannel.removeEventListener('message', onMessage);
      resolve(true);
    };
    executionLeaseChannel.addEventListener('message', onMessage);
    executionLeaseChannel.postMessage({ type: 'lease-probe', probeId, leaseId: lease.leaseId });
    setTimeout(() => {
      if (settled) return;
      executionLeaseChannel.removeEventListener('message', onMessage);
      resolve(false);
    }, EXECUTION_LEASE_PROBE_MS);
  });
  executionLeaseChannel?.addEventListener('message', (event) => {
    const value = event && event.data;
    if (!value || value.type !== 'lease-probe' || !ownedExecutionLease) return;
    if (value.leaseId !== ownedExecutionLease.leaseId || !coreDailyIsRunning()) return;
    executionLeaseChannel.postMessage({
      type: 'lease-alive',
      probeId: value.probeId,
      leaseId: ownedExecutionLease.leaseId,
    });
  });
  const acquireExecutionLease = async (request) => {
    const existing = readExecutionLease();
    if (existing) {
      const locallyLive = existing.tabId === executionTabId && coreDailyIsRunning();
      const remotelyLive = locallyLive ? true : await probeLeaseOwner(existing);
      const unchanged = readExecutionLease();
      if (remotelyLive || !unchanged || unchanged.leaseId !== existing.leaseId) {
        if (remotelyLive) return { acquired: false, lease: existing };
        return acquireExecutionLease(request);
      }
      // The owning tab/session did not answer and this Core is not running it.
      // Recovery is based on observed liveness, never lease age alone.
      localStorage.removeItem(EXECUTION_LEASE_KEY);
    }
    const auth = request && request.authorization;
    const lease = {
      schema: 'execution-lease-v1',
      leaseId: `lease-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      profileId: auth && auth.profileId ? auth.profileId : 'browser-profile-origin',
      tabId: executionTabId,
      owner: request && request.source === 'runtime-host' ? 'operator' : 'manual',
      job: 'daily',
      sessionId: auth && auth.sessionId ? auth.sessionId : executionTabId,
      startedAt: Date.now(),
      state: 'running',
    };
    localStorage.setItem(EXECUTION_LEASE_KEY, JSON.stringify(lease));
    const winner = readExecutionLease();
    if (!winner || winner.leaseId !== lease.leaseId) return { acquired: false, lease: winner };
    ownedExecutionLease = lease;
    return { acquired: true, lease };
  };
  const SharedCoreAdapter = Object.freeze({
    version: SHARED_CORE_ADAPTER_VERSION,
    runtimeVersion: SHARED_CORE_RUNTIME_VERSION,
    getStatus() {
      const dailyState = Modules.daily.loadState();
      const activeModule = Core.activeModuleId ? Modules[Core.activeModuleId] : null;
      return {
        source: 'lanis-shared-core',
        adapterVersion: SHARED_CORE_ADAPTER_VERSION,
        runtimeVersion: SHARED_CORE_RUNTIME_VERSION,
        daily: {
          running: !!(Core.dailyActive || Modules.daily.running),
          stopRequested: !!Modules.daily.stopRequested,
          stepIndex: dailyState ? dailyState.index : null,
          stepCount: dailyState && Array.isArray(dailyState.steps) ? dailyState.steps.length : null,
          result: Core.moduleResults.daily || null,
          lease: publicLease(readExecutionLease()),
        },
        activeModule: Core.activeModuleId ? {
          id: Core.activeModuleId,
          running: !!(activeModule && activeModule.running),
          stopRequested: !!(activeModule && activeModule.stopRequested),
          runId: activeModule && Number.isFinite(activeModule.runId) ? activeModule.runId : null,
          result: Core.moduleResults[Core.activeModuleId] || null,
        } : null,
      };
    },
    async startDaily(request = {}) {
      const event = request && request.source === 'manual-ui' ? request.event : null;
      const auth = request && request.source === 'runtime-host' ? request.authorization : null;
      const managedAuthorized = !!(auth && auth.schema === 'daily-runtime-explicit-v1' &&
        auth.explicit === true && auth.commandId === request.commandId &&
        typeof auth.profileId === 'string' && auth.profileId &&
        typeof auth.sessionId === 'string' && auth.sessionId &&
        typeof auth.runId === 'string' && auth.runId &&
        auth.runtimeVersion === SHARED_CORE_RUNTIME_VERSION &&
        Number.isFinite(auth.issuedAt) && Math.abs(Date.now() - auth.issuedAt) <= 30000);
      if ((!event || event.isTrusted !== true) && !managedAuthorized) {
        return Promise.resolve({
          ok: false,
          skipped: true,
          code: 'ACTION_EXECUTION_GATED',
          message: 'daily.start 명시 승인이 없거나 현재 세션과 일치하지 않습니다.',
        });
      }
      const leaseResult = await acquireExecutionLease(request);
      if (!leaseResult.acquired) {
        return {
          ok: false,
          skipped: true,
          code: 'ALREADY_RUNNING',
          message: '같은 계정/프로필에서 장기 실행 작업이 이미 실행 중입니다.',
          existing: publicLease(leaseResult.lease),
        };
      }
      const loopPromise = Core.startDaily();
      const started = !!(Core.dailyActive || Modules.daily.running);
      if (!started) {
        releaseExecutionLease(leaseResult.lease.leaseId);
        return Promise.resolve({
          ok: false,
          skipped: true,
          code: 'START_REJECTED_BY_CORE',
          message: '기존 Core 시작 조건이 실행을 차단했습니다.',
        });
      }
      Promise.resolve(loopPromise).finally(() => releaseExecutionLease(leaseResult.lease.leaseId));
      if (request.source === 'manual-ui') return Promise.resolve({ ok: true, started: true });
      return new Promise((resolve) => {
        let finished = false;
        const finish = (value) => {
          if (finished) return;
          finished = true;
          document.removeEventListener('ranis:daily-result', onResult);
          unsubscribeStop?.();
          resolve(value);
        };
        const onResult = () => {
          let result = null;
          try { result = JSON.parse(sessionStorage.getItem('ranisOperatorDailyResult') || 'null'); } catch (_) {}
          finish(result && result.state === 'stopped'
            ? { ok: true, stopped: true, result }
            : result && result.state === 'failed'
              ? { ok: false, code: 'CORE_FAILED', message: result.message, result }
              : { ok: true, result });
        };
        document.addEventListener('ranis:daily-result', onResult);
        const unsubscribeStop = request.scope?.onStop(() => {
          Core.stopDaily();
          finish({ ok: true, stopped: true });
        });
      });
    },
    requestStop(request = {}) {
      const before = this.getStatus();
      Core.stopDaily();
      const after = this.getStatus();
      return {
        ok: true,
        stopped: !!before.daily.running,
        alreadyStopped: !before.daily.running,
        commandId: typeof request.commandId === 'string' ? request.commandId : null,
        before,
        after,
      };
    },
  });
  window.__lanisSharedCoreAdapter = SharedCoreAdapter;
  window.dispatchEvent(new CustomEvent('lanis:shared-core:ready', {
    detail: { adapterVersion: SHARED_CORE_ADAPTER_VERSION, runtimeVersion: SHARED_CORE_RUNTIME_VERSION },
  }));

  const reportManualDailyStartResult = (result, refs) => {
    if (!result || result.code !== 'ALREADY_RUNNING') return result;
    const existing = result.existing || {};
    const ownerLabel = existing.owner === 'operator'
      ? 'Operator'
      : existing.owner === 'manual'
        ? '수동 UI'
        : '다른 실행 주체';
    const jobLabel = existing.job === 'daily' ? '일일 작업' : '장기 작업';
    const message = `이미 ${ownerLabel}에서 ${jobLabel} 실행 중입니다.`;
    const sessionDetail = existing.sessionId ? ` 기존 세션: ${existing.sessionId}` : '';
    if (refs.statusEl) {
      refs.statusEl.textContent = message;
      refs.statusEl.title = sessionDetail.trim();
    }
    Core.showBanner('daily', `${message}${sessionDetail}`, false);
    Core.log('daily', `${message}${sessionDetail}`);
    return result;
  };

  function buildDailyTab(container) {
    const mod = Modules.daily;
    const refs = UIRefs.daily;
    Core.loadModuleConfig('daily', DAILY_CONFIG_KEYS);

    const intro = document.createElement('div');
    intro.textContent = '출석체크를 먼저 수행한 뒤 체크한 작업을 던전 → 보스 → 자동사냥 → 심층던전 → 아레나 → 이벤트 순서로 실행하고, 각 단계의 실제 완료 상태를 확인합니다.';
    intro.style.cssText = 'color:#ccc; font-size:11px; line-height:1.5; margin-bottom:8px;';
    container.appendChild(intro);

    const inputs = [];
    [
      ['dungeon', '던전 — 입장 가능한 던전 모두 클리어'],
      ['boss', '보스 — 선택한 보스 중 주간 보상이 남은 보스'],
      ['autohunt', '자동사냥 — 설정한 행동력 제한까지'],
      ['deepdungeon', '심층던전 — 주간 누적 피해 100만까지'],
      ['arena', '아레나 — 설정한 오늘 총 전투 횟수까지'],
      ['preseason', '이벤트 — 가을 심층던전 아레나 단풍 토큰 일일/주간 한도까지'],
    ].forEach(([key, text]) => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex; align-items:flex-start; gap:7px; margin:7px 0; cursor:pointer;';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = !!mod.config[key];
      check.addEventListener('change', () => {
        mod.config[key] = check.checked;
        Core.saveModuleConfig('daily', DAILY_CONFIG_KEYS);
      });
      const label = document.createElement('span');
      label.textContent = text;
      row.append(check, label);
      container.appendChild(row);
      inputs.push(check);
    });

    const randomRow = document.createElement('label');
    randomRow.style.cssText = 'display:flex; align-items:flex-start; gap:7px; margin:10px 0 7px; padding-top:8px; border-top:1px solid #444; cursor:pointer;';
    const randomCheck = document.createElement('input');
    randomCheck.type = 'checkbox';
    randomCheck.checked = !!mod.config.randomOrder;
    randomCheck.addEventListener('change', () => {
      mod.config.randomOrder = randomCheck.checked;
      Core.saveModuleConfig('daily', DAILY_CONFIG_KEYS);
    });
    const randomLabel = document.createElement('span');
    randomLabel.textContent = '일일 작업 순서 랜덤 — 체크 시 던전/보스/자동사냥/심층던전/아레나/이벤트 순서를 실행마다 무작위로 섞습니다 (주간 보상·출석체크·일간+주간 퀘스트는 항상 처음/마지막 고정)';
    randomLabel.style.cssText = 'font-size:11px; color:#ccc; line-height:1.4;';
    randomRow.append(randomCheck, randomLabel);
    container.appendChild(randomRow);
    inputs.push(randomCheck);

    const note = document.createElement('div');
    note.textContent = '월간 출석체크는 항상 실행하며 이미 수령했거나 받을 보상이 없으면 건너뜁니다. 보스 보상이 모두 끝난 날은 수호자에 입장한 뒤 포기하여 일일 도전 과제만 처리합니다. 문제가 생긴 단계는 기록하고 다음 단계로 넘어갑니다.';
    note.style.cssText = 'color:#f5a623; font-size:10px; line-height:1.45; margin:8px 0;';
    container.appendChild(note);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:6px; margin-top:6px;';
    const startBtn = document.createElement('button');
    startBtn.textContent = '일일 실행';
    startBtn.style.cssText = btnStyle('#2e7d32');
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '정지';
    stopBtn.style.cssText = btnStyle('#c62828');
    stopBtn.disabled = true;
    startBtn.addEventListener('click', async (event) => {
      const result = await SharedCoreAdapter.startDaily({ source: 'manual-ui', event });
      reportManualDailyStartResult(result, refs);
    });
    stopBtn.addEventListener('click', () => SharedCoreAdapter.requestStop({ source: 'manual-ui' }));
    row.append(startBtn, stopBtn);
    container.appendChild(row);

    const statusEl = document.createElement('div');
    statusEl.textContent = '대기중';
    statusEl.style.cssText = 'font-size:11px; color:#aaa; margin-top:5px;';
    container.appendChild(statusEl);
    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.inputs = inputs;
  }

  // -------------------------- 아레나 --------------------------
  const ARENA_RESUME_KEY = 'lrm-arena-resume';
  Modules.arena = {
    id: 'arena',
    running: false,
    stopRequested: false,
    runId: 0,
    loopPromise: null,
    cycleCount: 0,
  };

  Modules.arena.todayKey = function () {
    return new Date().toLocaleDateString('en-CA');
  };

  Modules.arena.isWeekend = function () {
    const day = new Date().getDay();
    return day === 0 || day === 6;
  };

  Modules.arena.saveResume = function () {
    try {
      localStorage.setItem(ARENA_RESUME_KEY, JSON.stringify({
        running: true,
        date: this.todayKey(),
      }));
    } catch (e) {}
  };

  Modules.arena.clearResume = function () {
    try { localStorage.removeItem(ARENA_RESUME_KEY); } catch (e) {}
  };

  Modules.arena.isRegistrationScreen = function () {
    return location.pathname.replace(/\/$/, '') === '/arena' &&
      !!Core.findButtonByText('아레나 등록') &&
      Core.bodyText().includes('아레나 등록 버튼을 눌러');
  };

  Modules.arena.isBattleScreen = function () {
    return location.pathname.replace(/\/$/, '') === '/arena' &&
      Core.bodyText().includes('오늘 전투 횟수');
  };

  Modules.arena.goToArena = async function ({ allowRegistration = false } = {}) {
    if (location.pathname.replace(/\/$/, '') !== '/arena') {
      await Core.clickNavMenuExact('전투', '아레나');
    }
    const arrived = await Core.waitFor(
      () => this.isBattleScreen() || (allowRegistration && this.isRegistrationScreen()),
      15000,
      300
    );
    if (!arrived) throw new Error('아레나 화면 진입을 확인하지 못했습니다.');
  };

  // 새 시즌 최초 진입 때만 실행한다. 실전에서 확인한 순서 그대로
  // 아레나 프리셋 → 시즌 등록 → 탬플릿 생성 → 첫 전투 → 직업군 등록을 마친다.
  Modules.arena.setupNewSeasonIfNeeded = async function () {
    if (!this.isRegistrationScreen()) return false;

    Core.log('arena', '새 시즌 아레나 미등록 감지 → 초기 세팅 등록 시작');
    await Core.applyCommonPreset('아레나', 'arena');
    await this.goToArena({ allowRegistration: true });

    if (!(await Core.safeClick(() => {
      const button = Core.findButtonByText('아레나 등록');
      return button && !button.disabled ? button : null;
    }, { beforeMin: 700, beforeMax: 1200, afterMin: 900, afterMax: 1500 }))) {
      throw new Error('새 시즌 "아레나 등록" 버튼 클릭에 실패했습니다.');
    }
    const registered = await Core.waitFor(() => this.isBattleScreen() || null, 15000, 300);
    if (!registered) throw new Error('새 시즌 아레나 등록 후 전투 화면을 확인하지 못했습니다.');

    if (!(await Core.safeClick(() => Core.findButtonByText('설정'), {
      beforeMin: 500,
      beforeMax: 900,
      afterMin: 500,
      afterMax: 900,
    }))) throw new Error('아레나 "설정" 탭 클릭에 실패했습니다.');
    const createTemplate = await Core.waitFor(() => Core.findButtonByText('탬플릿 생성'), 10000, 250);
    if (!createTemplate) throw new Error('아레나 "탬플릿 생성" 버튼을 찾지 못했습니다.');
    if (!(await Core.safeClick(() => Core.findButtonByText('탬플릿 생성'), {
      beforeMin: 600,
      beforeMax: 1000,
      afterMin: 900,
      afterMax: 1400,
    }))) throw new Error('아레나 탬플릿 생성에 실패했습니다.');

    const firstBattle = await this.waitForEnabledStart();
    if (!firstBattle) throw new Error('탬플릿 생성 후 첫 아레나 전투 버튼이 활성화되지 않았습니다.');
    if (!(await Core.safeClick(() => {
      const button = Core.findButtonByText('전투 시작');
      return button && !button.disabled ? button : null;
    }, { beforeMin: 700, beforeMax: 1300 }))) {
      throw new Error('새 시즌 첫 아레나 전투 시작에 실패했습니다.');
    }
    const resultBack = await Core.waitFor(
      () => Core.findButtonByText('아레나로 돌아가기') || Core.findButtonByText('돌아가기'),
      15000,
      500
    );
    if (!resultBack) throw new Error('새 시즌 첫 전투 결과 화면을 확인하지 못했습니다.');
    await this.handleResultIfPresent();

    const findClassRegisterButton = () => Core.allButtons().find((button) =>
      /직업군으로 등록$/.test(button.textContent.replace(/\s+/g, ' ').trim()) &&
      !button.disabled && Core.isElementVisible(button)
    ) || null;
    const classRegisterButton = await Core.waitFor(findClassRegisterButton, 10000, 250);
    if (!classRegisterButton) throw new Error('첫 전투 후 직업군 등록 버튼을 찾지 못했습니다.');
    const className = classRegisterButton.textContent.replace(/\s*직업군으로 등록\s*$/, '').trim();
    if (!(await Core.safeClick(findClassRegisterButton, {
      beforeMin: 600,
      beforeMax: 1000,
      afterMin: 800,
      afterMax: 1300,
    }))) throw new Error(`${className || '현재'} 직업군 등록에 실패했습니다.`);
    const classRegistered = await Core.waitFor(
      () => !/현재 직업군:\s*미등록/.test(Core.bodyText()) && !findClassRegisterButton() ? true : null,
      10000,
      250
    );
    if (!classRegistered) throw new Error('직업군 등록 완료 상태를 확인하지 못했습니다.');

    Core.log('arena', `새 시즌 초기 세팅 완료: 아레나 프리셋·탬플릿·첫 전투·${className || '현재'} 직업군 등록`);
    return true;
  };

  Modules.arena.readTodayBattleCount = function () {
    const marker = Core.gameElements('*').find((el) =>
      el.children.length === 0 && el.textContent.trim() === '오늘 전투 횟수'
    );
    if (!marker) return null;
    let node = marker.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const match = (node.textContent || '').match(/오늘 전투 횟수\s*(\d+)\s*회/);
      if (match) return parseInt(match[1], 10);
    }
    return null;
  };

  // 아레나는 전투 20회부터 에너지 1, 40회부터 에너지 2가 든다. 보석 보상은
  // 30회까지이므로 에너지 1은 보석이 남아 있는 동안 허용하되, 파싱 오류나
  // 게임 규칙 변경으로 에너지 2 이상이 표시되면 안전을 위해 즉시 중지한다.
  Modules.arena.readNextBattleEnergyCost = function () {
    const marker = Core.gameElements('*').find((el) =>
      el.children.length === 0 && el.textContent.trim() === '다음 전투 에너지 비용'
    );
    if (!marker) return null;
    let node = marker.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const text = node.textContent || '';
      if (text.includes('다음 전투 에너지 비용') && text.length < 60) {
        const raw = text.replace('다음 전투 에너지 비용', '').trim();
        const amountMatch = raw.match(/\d+/);
        return {
          isFree: raw.includes('무료'),
          amount: raw.includes('무료') ? 0 : (amountMatch ? parseInt(amountMatch[0], 10) : null),
          raw,
        };
      }
    }
    return null;
  };

  // ⚠ 사용자 요청(2026-08, 실전 확인): 프리시즌은 에너지가 전혀 소모되지
  // 않는 대신, "오늘 받은 프리시즌 보석"이 하루 최대치(실전 확인: 150개,
  // 전투 1회당 5개 지급이라 30회분)에 도달하면 더 받을 게 없다. 고정 전투
  // 횟수 대신 이 진행률을 기준으로 반복해야 한다.
  Modules.arena.readPreseasonGemProgress = function () {
    const marker = Core.gameElements('*').find((el) =>
      el.children.length === 0 && el.textContent.trim() === '오늘 받은 프리시즌 보석'
    );
    if (!marker) return null;
    let node = marker.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const match = (node.textContent || '').match(/오늘 받은 프리시즌 보석\s*(\d+)\s*\/\s*(\d+)\s*개/);
      if (match) return { current: parseInt(match[1], 10), max: parseInt(match[2], 10) };
    }
    return null;
  };

  Modules.arena.readBattleGemProgress = function () {
    const labels = ['오늘 받은 전투 보석', '오늘 받은 프리시즌 보석'];
    const marker = Core.gameElements('*').find((el) =>
      el.children.length === 0 && labels.includes(el.textContent.trim())
    );
    if (!marker) return null;
    let node = marker.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const match = (node.textContent || '').match(/오늘 받은 (?:전투|프리시즌) 보석\s*(\d+)\s*\/\s*(\d+)\s*개/);
      if (match) return { current: parseInt(match[1], 10), max: parseInt(match[2], 10) };
    }
    return null;
  };

  Modules.arena.waitForEnabledStart = async function () {
    return await Core.waitFor(() => {
      const button = Core.findButtonByText('전투 시작');
      return button && !button.disabled ? button : null;
    }, 90000, 500);
  };

  Modules.arena.handleResultIfPresent = async function () {
    const findBack = () =>
      Core.findButtonByText('아레나로 돌아가기') ||
      Core.findButtonByText('돌아가기');
    const back = findBack();
    if (!back) return false;
    if (!(await Core.safeClick(findBack, {
      beforeMin: 700,
      beforeMax: 1200,
      afterMin: 800,
      afterMax: 1300,
    }))) throw new Error('아레나 결과창의 "돌아가기" 버튼 클릭에 실패했습니다.');
    await Core.waitFor(() => Core.bodyText().includes('오늘 전투 횟수'), 15000, 300);
    return true;
  };

  // ⚠ 사용자 요청(2026-08): 지난 주 아레나 순위 보상(전체 순위+직업군 순위)을
  // 받는다. 실전 확인: GET /api/arena/last-week의 {participated,
  // rewardReceived}로 정확히 판별 가능(수령 후 rewardReceived가 true로
  // 바뀌는 것까지 확인함). ⚠ 아레나는 토·일에만 진입 가능한데 이 보상은
  // 월~금에만 받을 수 있어, 아레나 매크로 자체에 묶으면 영영 못 받는
  // 모순이 생긴다. 그래서 이 함수는 아레나 mainLoop가 아니라 "일일" 단계에서
  // 최우선으로, 아레나 매크로 실행 여부와 무관하게 별도로 호출한다
  // (Modules.daily.claimWeeklyRewardsIfDue 참고). 성공적으로 확인(수령했거나
  // 받을 게 없었거나)했으면 true, API 실패 등으로 재시도가 필요하면 false.
  Modules.arena.claimLastWeekRewardIfAny = async function () {
    let data;
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('https://lanis.me/api/arena/last-week', {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`API 호출 실패 (HTTP ${res.status})`);
      data = await res.json();
    } catch (e) {
      Core.log('arena', `⚠ 아레나 지난 주 보상 확인 실패: ${e.message}`);
      return false;
    }
    if (!data.participated || data.rewardReceived) {
      Core.log('arena', '아레나 지난 주 보상: 받을 것 없음(참여 안 했거나 이미 수령함)');
      return true;
    }
    Core.log('arena', `아레나 지난 주 보상 수령 시도 (전체 ${data.finalRank}위, 직업군 ${data.baseClassRank}위)`);

    try {
      await this.goToArena();
      const rewardTab = await Core.retryStep('아레나 "보상" 탭 찾기', () => Core.findButtonByText('보상'));
      if (!rewardTab) {
        Core.log('arena', '⚠ "보상" 탭을 찾지 못해 지난 주 보상 수령을 건너뜁니다.');
        return false;
      }
      if (!(await Core.safeClick(() => Core.findButtonByText('보상'), { beforeMin: 500, beforeMax: 900, afterMin: 700, afterMax: 1200 }))) {
        Core.log('arena', '⚠ "보상" 탭 클릭에 실패해 지난 주 보상 수령을 건너뜁니다.');
        return false;
      }
      const claimBtn = await Core.waitFor(() => Core.findButtonByText('보상 받기'), 8000, 250);
      if (!claimBtn) {
        Core.log('arena', '⚠ "보상 받기" 버튼을 찾지 못했습니다.');
        return false;
      }
      if (!(await Core.safeClick(() => Core.findButtonByText('보상 받기'), { beforeMin: 600, beforeMax: 1100, afterMin: 1000, afterMax: 1500 }))) {
        Core.log('arena', '⚠ "보상 받기" 클릭에 실패했습니다.');
        return false;
      }
      Core.log('arena', '아레나 지난 주 보상 수령 완료');
      return true;
    } catch (e) {
      Core.log('arena', `⚠ 아레나 지난 주 보상 수령 중 오류: ${e.message}`);
      return false;
    }
  };

  Modules.arena.mainLoop = async function () {
    const mod = this;
    mod.cycleCount = 0;

    if (!mod.isWeekend()) {
      mod.clearResume();
      Core.notifyStopped('arena', '아레나는 토요일과 일요일에만 자동 실행할 수 있습니다.');
      return;
    }
    mod.saveResume();
    await mod.goToArena({ allowRegistration: true });
    await mod.setupNewSeasonIfNeeded();

    // 전투 도중 새로고침되었을 경우 결과창부터 정리한다.
    await mod.handleResultIfPresent();

    while (!mod.stopRequested) {
      const before = mod.readTodayBattleCount();
      if (before === null) throw new Error('아레나의 오늘 전투 횟수를 읽지 못했습니다.');
      mod.cycleCount = before;
      Core.updateModuleButtons();

      const gemProgress = mod.readBattleGemProgress();
      if (!gemProgress) throw new Error('아레나의 "오늘 받은 전투 보석" 진행률을 읽지 못했습니다.');
      if (gemProgress.current >= gemProgress.max) {
        mod.clearResume();
        Core.notifyCompleted(
          'arena',
          `오늘 아레나 보석 ${gemProgress.current}/${gemProgress.max}개 완료 (전투 ${before}회)`
        );
        return;
      }

      const energyCost = mod.readNextBattleEnergyCost();
      if (!energyCost) throw new Error('아레나의 "다음 전투 에너지 비용"을 읽지 못했습니다.');
      if (energyCost.amount === null) {
        mod.clearResume();
        Core.notifyStopped('arena', `아레나 에너지 비용 "${energyCost.raw}"을 숫자로 확인할 수 없어 안전 중지합니다.`);
        return;
      }
      if (energyCost.amount >= 2) {
        mod.clearResume();
        Core.notifyStopped(
          'arena',
          `아레나 보석 ${gemProgress.current}/${gemProgress.max}개 상태에서 필요 에너지가 ${energyCost.amount}로 올라 안전 중지합니다.`
        );
        return;
      }

      // ⚠ 사용자 요청(2026-08): 기존엔 마지막 공격 시각부터 고정 35초를 무조건
      // 기다린 뒤에야 waitForEnabledStart로 진짜 쿨타임(버튼 활성화)을 확인하는
      // 이중 구조였다. 결과창에서 "돌아가기"를 누르고 곧바로 이 자리로 돌아오므로,
      // 고정 대기 없이 진짜 쿨타임 감지(0.5초 간격 폴링)만으로 버튼이 켜지는
      // 즉시 공격하도록 단순화한다.
      Core.log(
        'arena',
        `쿨타임 및 버튼 활성화 대기 중: 오늘 ${before}회 / 보석 ${gemProgress.current}/${gemProgress.max} / 다음 전투 에너지 ${energyCost.amount}`
      );
      const startButton = await mod.waitForEnabledStart();
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
        Core.log('arena', '⚠ 전투 시작 클릭 후 결과 화면이 나타나지 않음 — 클릭 누락으로 판단, 즉시 재시도');
        continue;
      }
      await mod.handleResultIfPresent();
      const incremented = await Core.waitFor(() => {
        const count = mod.readTodayBattleCount();
        return count !== null && count > before ? count : null;
      }, 15000, 300);
      if (incremented === null) throw new Error('전투 후 오늘 전투 횟수 증가를 확인하지 못했습니다.');
      mod.cycleCount = incremented;
      Core.log('arena', `아레나 전투 완료: 오늘 ${incremented}회`);
    }
  };


  function buildArenaTab(container) {
    const mod = Modules.arena;
    const refs = UIRefs.arena;

    const description = document.createElement('div');
    description.textContent =
      '오늘 받은 전투 보석이 최대치가 될 때까지 실행합니다. 필요 에너지 1은 허용하지만 2 이상이면 안전을 위해 즉시 멈춥니다.';
    description.style.cssText = 'font-size:11px; color:#ccc; line-height:1.5; margin:7px 0;';
    container.appendChild(description);

    const weekendNote = document.createElement('div');
    weekendNote.textContent = '※ 토요일·일요일에만 시작됩니다. 전투 결과에서 돌아온 뒤 버튼이 다시 활성화될 때까지 백그라운드 타이머로 대기합니다.';
    weekendNote.style.cssText = 'font-size:10px; color:#f5a623; line-height:1.45; margin-bottom:7px;';
    container.appendChild(weekendNote);

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
    startBtn.addEventListener('click', () => Core.startModule('arena'));
    stopBtn.addEventListener('click', () => Core.requestStopModule('arena'));
    btnRow.append(startBtn, stopBtn);
    container.append(btnRow, statusEl);

    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.inputs = [];
  }

  // -------------------------- 가을 심층던전 아레나 --------------------------
  Modules.preseason = {
    id: 'preseason',
    running: false,
    stopRequested: false,
    cycleCount: 0,
  };

  Modules.preseason.readAutumnTokenProgress = function () {
    const text = Core.bodyText();
    const today = text.match(/오늘 획득한 단풍 토큰\s*(\d+)\s*\/\s*(\d+)\s*개/);
    const weekly = text.match(/이번 주 획득한 단풍 토큰\s*(\d+)\s*\/\s*(\d+)\s*개/);
    if (!today || !weekly) return null;
    return {
      today: { current: Number(today[1]), max: Number(today[2]) },
      weekly: { current: Number(weekly[1]), max: Number(weekly[2]) },
    };
  };

  Modules.preseason.findReadyBattleStartButton = function () {
    return Core.allButtons().find((button) => {
      const text = button.textContent.replace(/\s+/g, ' ').trim();
      return text.startsWith('전투 시작') && !button.disabled &&
        button.getAttribute('aria-disabled') !== 'true' && Core.isElementVisible(button);
    }) || null;
  };

  Modules.preseason.goToAutumnDeepArena = async function () {
    const onArena = () =>
      location.pathname.replace(/\/$/, '') === '/event/autumn' &&
      Core.bodyText().includes('오늘 획득한 단풍 토큰') &&
      Core.bodyText().includes('이번 주 획득한 단풍 토큰');
    if (onArena()) return true;

    // 우측 끝 프로필 아이콘 → 가을 이벤트 → 심층던전 아레나 순서로 진입한다.
    const headerButtons = Core.gameElements('header button').filter((button) => Core.isElementVisible(button));
    const menuButton = headerButtons[headerButtons.length - 1];
    if (!menuButton) throw new Error('상단 오른쪽 메뉴 아이콘을 찾지 못했습니다.');
    menuButton.click();
    const autumnMenu = await Core.waitFor(
      () => Core.gameElements('[role="menuitem"]').find(
        (item) => Core.isElementVisible(item) && item.textContent.trim() === '가을 이벤트'
      ) || null,
      5000,
      150
    );
    if (!autumnMenu) throw new Error('오른쪽 메뉴에서 "가을 이벤트"를 찾지 못했습니다.');
    await Core.humanDelay(500, 900);
    autumnMenu.click();

    const autumnPage = await Core.waitFor(
      () => location.pathname.replace(/\/$/, '') === '/event/autumn' ? true : null,
      12000,
      250
    );
    if (!autumnPage) throw new Error('가을 이벤트 화면 진입을 확인하지 못했습니다.');
    const arenaTab = await Core.waitFor(
      () => Core.findButtonByText('심층던전 아레나'),
      7000,
      200
    );
    if (!arenaTab) throw new Error('가을 이벤트의 "심층던전 아레나" 탭을 찾지 못했습니다.');
    await Core.humanDelay(500, 900);
    arenaTab.click();
    const ready = await Core.waitFor(() => onArena() ? true : null, 10000, 250);
    if (!ready) throw new Error('심층던전 아레나 진행률 화면을 확인하지 못했습니다.');
    return true;
  };

  Modules.preseason.mainLoop = async function () {
    const mod = this;
    mod.cycleCount = 0;
    await mod.goToAutumnDeepArena();

    while (!mod.stopRequested) {
      const before = mod.readAutumnTokenProgress();
      if (!before) throw new Error('오늘/주간 단풍 토큰 진행률을 읽지 못했습니다.');
      if (before.today.current >= before.today.max || before.weekly.current >= before.weekly.max) {
        Core.notifyCompleted(
          'preseason',
          `가을 심층던전 아레나 완료: 오늘 ${before.today.current}/${before.today.max}, 주간 ${before.weekly.current}/${before.weekly.max}`
        );
        return;
      }

      Core.log(
        'preseason',
        `단풍 토큰 획득 전투 준비: 오늘 ${before.today.current}/${before.today.max}, 주간 ${before.weekly.current}/${before.weekly.max}`
      );
      if (mod.stopRequested) return;
      const readyState = await Core.waitFor(
        () => {
          const progress = mod.readAutumnTokenProgress();
          if (progress && (
            progress.today.current >= progress.today.max
            || progress.weekly.current >= progress.weekly.max
          )) {
            return { completed: true, progress };
          }
          const button = mod.findReadyBattleStartButton();
          return button ? { completed: false, button } : null;
        },
        12000,
        250,
        () => mod.stopRequested
      );
      if (!readyState) throw new Error('가을 심층던전 아레나의 완료 상태나 활성화된 "전투 시작" 버튼을 확인하지 못했습니다.');
      if (readyState.completed) {
        const progress = readyState.progress;
        Core.notifyCompleted(
          'preseason',
          `가을 심층던전 아레나 완료: 오늘 ${progress.today.current}/${progress.today.max}, 주간 ${progress.weekly.current}/${progress.weekly.max}`
        );
        return;
      }
      const clicked = await Core.safeClick(
        () => mod.findReadyBattleStartButton(),
        { beforeMin: 180, beforeMax: 420, afterMin: 120, afterMax: 260 }
      );
      if (!clicked) throw new Error('가을 심층던전 아레나 "전투 시작" 버튼 클릭에 실패했습니다.');

      const resultBack = await Core.waitFor(
        () => Core.findButtonByText('심층던전 아레나로 돌아가기'),
        15000,
        250
      );
      if (!resultBack) throw new Error('가을 심층던전 아레나 전투 결과 화면을 확인하지 못했습니다.');
      if (mod.stopRequested) return;
      await Core.humanDelay(180, 350);
      if (!(await Core.safeClick(
        () => Core.findButtonByText('심층던전 아레나로 돌아가기'),
        { beforeMin: 150, beforeMax: 320, afterMin: 180, afterMax: 380 }
      ))) {
        throw new Error('"심층던전 아레나로 돌아가기" 버튼 클릭에 실패했습니다.');
      }

      const increased = await Core.waitFor(() => {
        const after = mod.readAutumnTokenProgress();
        return after &&
          (after.today.current > before.today.current || after.weekly.current > before.weekly.current)
          ? after
          : null;
      }, 12000, 300);
      if (!increased) throw new Error('전투 후 단풍 토큰 진행률 증가를 확인하지 못했습니다.');
      mod.cycleCount++;
      Core.updateModuleButtons();
      Core.log(
        'preseason',
        `가을 심층던전 아레나 전투 완료: 오늘 ${increased.today.current}/${increased.today.max}, 주간 ${increased.weekly.current}/${increased.weekly.max}`
      );
      await Core.humanDelay(120, 280);
    }
  };

  // ⚠ 사용자 요청(2026-08): 가을 이벤트 "단풍 토큰"을 인벤토리에서
  // 찾아 "사용 가능 상태"로 전환하는 일회성 액션. 프리시즌 탭에 묶어두고
  // 프리시즌이 끝나면(여름 이벤트도 같이 끝날 것으로 예상) 이 로직도 함께
  // 폐기한다. 자동 반복 매크로가 아니라 버튼 클릭 시 즉시 실행되는 1회성
  // 액션이다.
  //
  // 실전 확인: "사용" 클릭 시 확인창이 뜨고, 수량 입력칸은 이미 그 아이템의
  // 1회 사용 최대치(실전 확인: 50개)로 자동 채워져 있다(수정 불필요, 손대면
  // 안 됨 - 보상 상자 사용 로직에서 겪은 것과 동일한 함정). "사용" 확정하면
  // "단풍 토큰 N개를 사용 가능 상태로 전환했습니다"로 즉시 처리되고, 그
  // 행이 목록에서 갱신된다(수량이 줄거나 완전히 사라짐). 보유 수량이
  // 많으면(예: 547개) 여러 번 반복해야 다 소진된다.
  Modules.preseason.useAutumnTokens = async function () {
    Core.log('preseason', '"단풍 토큰" 사용 시작');
    await Core.clickNavMenuExact('캐릭', '인벤토리');
    const onInventoryPage = await Core.waitFor(() => location.pathname.startsWith('/inventory'), 15000, 300);
    if (!onInventoryPage) throw new Error('인벤토리 화면 진입을 확인하지 못했습니다.');
    await Core.humanDelay(500, 900);

    if (!(await Core.safeClick(() => Core.findButtonByText('소모품'), { beforeMin: 400, beforeMax: 700, afterMin: 700, afterMax: 1100 }))) {
      throw new Error('"소모품" 탭 클릭에 실패했습니다.');
    }

    const findTokenRow = () => Core.gameElements('tr').find((tr) => tr.textContent.includes('단풍 토큰') && Core.isElementVisible(tr));

    let usedCycles = 0;
    const maxCycles = 30; // 1회당 최대 50개 * 30회 = 최대 1500개까지 대응
    for (; usedCycles < maxCycles; usedCycles++) {
      // 이전 사용으로 목록/페이지 구성이 바뀔 수 있으니 매번 1페이지로 복귀 후 탐색
      const firstPageBtn = Core.gameElements('button').find(
        (b) => b.getAttribute('aria-label') === 'Go to first page' && !b.disabled && Core.isElementVisible(b)
      );
      if (firstPageBtn) {
        firstPageBtn.click();
        await Core.humanDelay(300, 500);
      }

      let row = findTokenRow();
      if (!row) {
        for (let page = 0; page < 20 && !row; page++) {
          const nextPageBtn = Core.gameElements('button').find(
            (b) => b.getAttribute('aria-label') === 'Go to next page' && !b.disabled && Core.isElementVisible(b)
          );
          if (!nextPageBtn) break;
          nextPageBtn.click();
          await Core.humanDelay(400, 700);
          row = findTokenRow();
        }
      }
      if (!row) break; // 더 이상 없음 = 소진 완료

      const useBtn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용');
      if (!useBtn) throw new Error('"단풍 토큰" 사용 버튼을 찾지 못했습니다.');
      if (!(await Core.safeClick(() => useBtn, { beforeMin: 400, beforeMax: 700, afterMin: 700, afterMax: 1000 }))) {
        throw new Error('"단풍 토큰" 사용 버튼 클릭에 실패했습니다.');
      }

      const dialog = await Core.waitFor(
        () => Core.gameElements('[role="dialog"]').find((d) => Core.isElementVisible(d) && d.textContent.includes('단풍 토큰을(를) 사용하시겠습니까')) || null,
        6000,
        250
      );
      if (!dialog) throw new Error('"단풍 토큰" 사용 확인창을 찾지 못했습니다.');

      // ⚠ 수량 입력칸은 이미 1회 사용 최대치로 채워져 있다 - 절대 건드리지 않는다.
      const confirmBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용');
      if (!confirmBtn) throw new Error('"단풍 토큰" 사용 확인 버튼을 찾지 못했습니다.');
      if (confirmBtn.disabled) throw new Error('"단풍 토큰" 사용 확인 버튼이 비활성화 상태입니다.');
      if (!(await Core.safeClick(() => confirmBtn, { beforeMin: 500, beforeMax: 900, afterMin: 900, afterMax: 1400 }))) {
        throw new Error('"단풍 토큰" 사용을 확정하지 못했습니다.');
      }
      Core.log('preseason', `"단풍 토큰" 사용 ${usedCycles + 1}회차 완료`);
    }

    if (usedCycles === 0) {
      Core.log('preseason', '"단풍 토큰"이 없거나 이미 전부 사용했습니다.');
    } else {
      Core.log('preseason', `"단풍 토큰" 사용 완료 (총 ${usedCycles}회 반복)`);
    }
  };

  const PRESEASON_ARENA_FISH_INTERVAL_MS = 30 * 60 * 1000;
  Modules.preseasonArena = {
    id: 'preseasonArena',
    running: false,
    stopRequested: false,
    runId: 0,
    loopPromise: null,
    cycleCount: 0,
    nextFishingAt: 0,
  };

  Modules.preseasonArena.ensureArena = async function () {
    await Modules.arena.goToArena();
    await Modules.arena.handleResultIfPresent();
    if (!Core.bodyText().includes('프리시즌')) {
      throw new Error('현재 아레나가 프리시즌 상태가 아닙니다. 무한아레나를 중단합니다.');
    }
  };

  Modules.preseasonArena.waitForArenaStart = async function () {
    const deadline = Date.now() + 95000;
    while (!this.stopRequested && Date.now() < deadline) {
      if (location.pathname.replace(/\/$/, '') !== '/arena') {
        Core.log('preseasonArena', '다른 화면 감지 → 아레나로 자동 복귀');
        await this.ensureArena();
      }
      const button = Core.findButtonByText('전투 시작');
      if (button && !button.disabled) return button;
      await Core.interruptibleSleep(800, () => this.stopRequested, 400);
    }
    return null;
  };

  Modules.preseasonArena.runFishingCycle = async function () {
    Core.log('preseasonArena', '30분 주기 통발 작업 시작');
    await Core.clickNavMenuExact('마을', '낚시터', () => this.stopRequested);
    const arrived = await Core.waitFor(
      () => location.pathname.startsWith('/fishing') && Core.bodyText().includes('심포니아 낚시터'),
      15000,
      300
    );
    if (!arrived) throw new Error('낚시터 진입을 확인하지 못했습니다.');
    if (this.stopRequested) return;

    let installButton = Core.findButtonByText('통발 설치하기');
    if (!installButton) {
      const collectButton = Core.findButtonByText('통발 수거하기');
      if (!collectButton || collectButton.disabled) {
        Core.log('preseasonArena', '통발이 아직 수거 불가 상태라 이번 주기는 건너뜁니다.');
        return;
      }
      if (!(await Core.safeClick(
        () => {
          const button = Core.findButtonByText('통발 수거하기');
          return button && !button.disabled ? button : null;
        },
        { beforeMin: 450, beforeMax: 850, afterMin: 700, afterMax: 1100 }
      ))) throw new Error('통발 수거 버튼 클릭에 실패했습니다.');
      installButton = await Core.waitFor(() => Core.findButtonByText('통발 설치하기'), 8000, 250);
      if (!installButton) throw new Error('통발 수거 후 설치 버튼이 나타나지 않았습니다.');
      Core.log('preseasonArena', '통발 수거 완료');
    }

    if (this.stopRequested) return;
    if (!(await Core.safeClick(
      () => Core.findButtonByText('통발 설치하기'),
      { beforeMin: 450, beforeMax: 850, afterMin: 350, afterMax: 650 }
    ))) throw new Error('통발 설치 버튼 클릭에 실패했습니다.');

    const confirmButton = await Core.waitFor(() => {
      const dialog = Core.gameElements('[role="dialog"]').find(
        (el) => Core.isElementVisible(el) && el.textContent.includes('통발 설치 확인')
      );
      return dialog
        ? [...dialog.querySelectorAll('button')].find((button) => button.textContent.trim() === '확인' && !button.disabled) || null
        : null;
    }, 6000, 200);
    if (!confirmButton) throw new Error('통발 설치 확인창의 확인 버튼을 찾지 못했습니다.');
    if (!(await Core.safeClick(() => confirmButton, {
      beforeMin: 400,
      beforeMax: 750,
      afterMin: 700,
      afterMax: 1100,
    }))) throw new Error('통발 설치 확인에 실패했습니다.');
    const installed = await Core.waitFor(
      () => {
        const button = Core.findButtonByText('통발 설치 중');
        return button && button.disabled ? true : null;
      },
      8000,
      250
    );
    if (!installed) throw new Error('통발 재설치 상태를 확인하지 못했습니다.');
    Core.log('preseasonArena', '통발 재설치 완료 → 아레나 복귀');
  };

  Modules.preseasonArena.mainLoop = async function () {
    this.cycleCount = 0;
    this.nextFishingAt = Date.now() + PRESEASON_ARENA_FISH_INTERVAL_MS;
    await this.ensureArena();
    while (!this.stopRequested) {
      if (Date.now() >= this.nextFishingAt) {
        await this.runFishingCycle();
        this.nextFishingAt = Date.now() + PRESEASON_ARENA_FISH_INTERVAL_MS;
        if (this.stopRequested) return;
        await this.ensureArena();
      } else {
        await this.ensureArena();
      }

      const before = Modules.arena.readTodayBattleCount();
      if (before === null) throw new Error('아레나의 오늘 전투 횟수를 읽지 못했습니다.');
      const startButton = await this.waitForArenaStart();
      if (!startButton) {
        if (this.stopRequested) return;
        throw new Error('95초 안에 아레나 전투 시작 버튼이 활성화되지 않았습니다.');
      }
      if (!(await Core.safeClick(
        () => {
          const button = Core.findButtonByText('전투 시작');
          return button && !button.disabled ? button : null;
        },
        { beforeMin: 650, beforeMax: 1150 }
      ))) throw new Error('프리시즌 아레나 전투 시작 클릭에 실패했습니다.');

      const resultBack = await Core.waitFor(
        () => Core.findButtonByText('아레나로 돌아가기') || Core.findButtonByText('돌아가기'),
        15000,
        400
      );
      if (!resultBack) {
        Core.log('preseasonArena', '결과 화면을 확인하지 못해 아레나 화면부터 다시 확인합니다.');
        continue;
      }
      await Modules.arena.handleResultIfPresent();
      const after = await Core.waitFor(() => {
        const count = Modules.arena.readTodayBattleCount();
        return count !== null && count > before ? count : null;
      }, 15000, 300);
      if (after === null) throw new Error('전투 후 오늘 전투 횟수 증가를 확인하지 못했습니다.');
      this.cycleCount++;
      Core.updateModuleButtons();
      const fishingIn = Math.max(0, Math.ceil((this.nextFishingAt - Date.now()) / 60000));
      Core.log('preseasonArena', `아레나 전투 완료: 오늘 ${after}회 / 다음 통발 작업 약 ${fishingIn}분 후`);
    }
  };

  function buildPreseasonTab(container) {
    const mod = Modules.preseason;
    const refs = UIRefs.preseason;

    const description = document.createElement('div');
    description.textContent =
      '오른쪽 메뉴의 가을 이벤트 → 심층던전 아레나로 이동해 전투합니다. 오늘 단풍 토큰 한도 또는 주간 단풍 토큰 한도에 도달하면 자동으로 멈춥니다.';
    description.style.cssText = 'font-size:11px; color:#ccc; line-height:1.5; margin:7px 0;';
    container.appendChild(description);

    const note = document.createElement('div');
    note.textContent = '※ 전투 시작과 결과 복귀 사이에 자연스러운 지연을 두며, 매 전투 후 오늘/주간 단풍 토큰 증가를 확인합니다.';
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
    refs.inputs = [];

    // ⚠ 사용자 요청(2026-08): "단풍 토큰"(가을 이벤트) 일괄 사용
    // 버튼. 자동 반복 매크로가 아니라 눌렀을 때 그 자리에서 바로 실행되는
    // 1회성 액션이라 시작/정지 상태와 무관하게 별도로 둔다.
    const tokenBtnRow = document.createElement('div');
    tokenBtnRow.style.cssText = 'margin-top:10px; padding-top:10px; border-top:1px solid #333;';
    const tokenLabel = document.createElement('div');
    tokenLabel.textContent = '단풍 토큰 일괄 사용 (가을 이벤트)';
    tokenLabel.style.cssText = 'font-size:11px; color:#ccc; margin-bottom:5px;';
    const tokenBtn = document.createElement('button');
    tokenBtn.textContent = '단풍 토큰 사용';
    tokenBtn.style.cssText = btnStyle('#8e5cf7');
    const tokenStatusEl = document.createElement('span');
    tokenStatusEl.textContent = '';
    tokenStatusEl.style.cssText = 'margin-left:8px; font-size:11px; color:#aaa;';
    tokenBtn.addEventListener('click', async () => {
      tokenBtn.disabled = true;
      tokenStatusEl.textContent = '사용 중...';
      try {
        await Modules.preseason.useAutumnTokens();
        tokenStatusEl.textContent = '완료';
      } catch (e) {
        tokenStatusEl.textContent = '실패: ' + e.message;
        Core.log('preseason', `⚠ 단풍 토큰 사용 실패: ${e.message}`);
      }
      tokenBtn.disabled = false;
    });
    tokenBtnRow.append(tokenLabel, tokenBtn, tokenStatusEl);
    container.appendChild(tokenBtnRow);

    // 프리시즌 일반 아레나는 보석 일일 한도와 무관하게 계속 돌 수 있으므로
    // 기존 가을 이벤트 아레나와 실행 상태를 완전히 분리한다. 이 실행 중에는
    // 30분마다 통발을 수거·재설치하고 다시 아레나로 돌아온다.
    const infiniteRow = document.createElement('div');
    infiniteRow.style.cssText = 'margin-top:10px; padding-top:10px; border-top:1px solid #333;';
    const infiniteLabel = document.createElement('div');
    infiniteLabel.textContent = '프리시즌 무한아레나 (30분마다 통발 수거·재설치)';
    infiniteLabel.style.cssText = 'font-size:11px; color:#ccc; margin-bottom:5px;';
    const infiniteDescription = document.createElement('div');
    infiniteDescription.textContent = '횟수 제한 없이 일반 아레나를 반복합니다. 다른 화면으로 이동하면 자동 복귀하며, 통발 작업 후에도 아레나로 돌아옵니다.';
    infiniteDescription.style.cssText = 'font-size:10px; color:#f5a623; line-height:1.45; margin-bottom:7px;';
    const infiniteBtnRow = document.createElement('div');
    infiniteBtnRow.style.cssText = 'display:flex; gap:6px; align-items:center;';
    const infiniteStartBtn = document.createElement('button');
    infiniteStartBtn.textContent = '무한아레나 시작';
    infiniteStartBtn.style.cssText = btnStyle('#1565c0');
    const infiniteStopBtn = document.createElement('button');
    infiniteStopBtn.textContent = '정지';
    infiniteStopBtn.style.cssText = btnStyle('#c62828');
    infiniteStopBtn.disabled = true;
    const infiniteStatusEl = document.createElement('div');
    infiniteStatusEl.textContent = '대기중';
    infiniteStatusEl.style.cssText = 'font-size:11px; color:#ccc; margin-top:5px;';
    infiniteStartBtn.addEventListener('click', () => Core.startModule('preseasonArena'));
    infiniteStopBtn.addEventListener('click', () => Core.requestStopModule('preseasonArena'));
    infiniteBtnRow.append(infiniteStartBtn, infiniteStopBtn);
    infiniteRow.append(infiniteLabel, infiniteDescription, infiniteBtnRow, infiniteStatusEl);
    container.appendChild(infiniteRow);

    UIRefs.preseasonArena.startBtn = infiniteStartBtn;
    UIRefs.preseasonArena.stopBtn = infiniteStopBtn;
    UIRefs.preseasonArena.statusEl = infiniteStatusEl;
    UIRefs.preseasonArena.inputs = [];
  }

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
      await Core.clickNavMenuSuffix('전투', groundSuffix, shouldCancel, {
        nav: { min: 250, max: 500 },
        item: { min: 250, max: 500 },
      });
    } catch (e) {
      Core.log('autohunt', `오류: ${e.message}`);
      return false;
    }
    await Core.sleep(300);
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
    const parseEnergy = (text) => {
      const match = String(text || '').replace(/\s+/g, ' ').match(/([\d,]+)\s*\/\s*2,?000\b/);
      if (!match) return null;
      const value = this.parseNumber(match[1]);
      return Number.isFinite(value) && value >= 0 && value <= 2000 ? value : null;
    };
    const leaves = this.leafTextEls();
    const label = leaves.find((el) => el.textContent.trim() === '행동력');
    if (label) {
      let node = label.parentElement;
      for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
        const value = parseEnergy(node.textContent);
        if (value !== null) return value;
      }
      const index = leaves.indexOf(label);
      for (let offset = 1; offset <= 3 && index + offset < leaves.length; offset++) {
        const value = parseEnergy(leaves[index + offset].textContent);
        if (value !== null) return value;
      }
    }
    for (const el of leaves) {
      const value = parseEnergy(el.textContent);
      if (value !== null) return value;
    }
    return null;
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
    await Core.bankDepositAll('autohunt', { fast: true });

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
      await Core.bankDepositAll('autohunt', { fast: true });
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
      await Core.bankDepositAll('autohunt', { fast: true });
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
        await Core.bankDepositAll('autohunt', { fast: true });
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

  // 지도 사용은 각 클릭 뒤의 실제 DOM 변화를 확인하므로, 정상 경로에서
  // 긴 선행 대기를 세 번씩 겹칠 필요가 없다. 짧은 입력 간격으로 진행하고
  // 렌더링이 느릴 때는 아래 waitFor가 준비될 때까지 기다린다.
  Modules.raremap.MAP_ACTION_DELAYS = {
    open: { beforeMin: 120, beforeMax: 280 },
    select: { beforeMin: 80, beforeMax: 180 },
    use: { beforeMin: 100, beforeMax: 220 },
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
          this.MAP_ACTION_DELAYS.open
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
      }, this.MAP_ACTION_DELAYS.select);
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
      }, this.MAP_ACTION_DELAYS.use);
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
    // ⚠ 사용자 확인(2026-08): 레어맵은 같은 종류가 26회 이상 연속으로 나오는
    // 경우도 있다. 버튼 텍스트가 이전과 같은 것만으로는 "클릭이 안 먹혔다"와
    // "같은 종류 레어맵이 또 나왔다"를 구분할 수 없다(실전 확인: 일반 광산
    // 버튼도 클릭 후 완전히 동일한 DOM 요소가 재사용되며 텍스트도 그대로임).
    // 동일 텍스트 연속 횟수는 중단 조건으로 사용하지 않는다.
    const UNCHANGED_SAFETY_LIMIT = '제한 없음';
    while (this.running && count < 150) {
      const rareBtn = this.getRareMapButton();
      if (!rareBtn) break;
      const beforeText = rareBtn.textContent.trim();
      Core.log('raremap', `레어맵 발견: "${beforeText}" → 클릭`);
      // ⚠ 사용자 확인(2026-08): 클릭 직전마다 600~1300ms를 기다리던 건
      // 불필요한 이중 대기였다 - 바로 아래 waitFor가 이미 "버튼이 실제로
      // 바뀌어 클릭 가능해진 시점"을 폴링으로 감지하고 나서야 루프가
      // 돌아오므로, 그 위에 또 사람처럼 보이려는 랜덤 대기를 얹는 건
      // 오히려 실제 사람보다 느리게 만든다(쿨이 끝나면 바로 누르는 게
      // 자연스러움). 완전히 0ms로는 하지 않고 최소한의 짧은 지터만 둔다.
      const clicked = await Core.safeClick(() => this.getRareMapButton(), { beforeMin: 80, beforeMax: 200 });
      if (!clicked) break;
      const changed = await Core.waitFor(() => {
        const next = this.getRareMapButton();
        return !next || next.textContent.trim() !== beforeText ? true : null;
      }, 1200, 150);
      if (!changed) {
        unchangedCount++;
        // 텍스트가 같아도 클릭 자체는 매번 성공했으므로, 같은 종류 레어맵이
        // 연속 출현 중인 정상 상황일 가능성이 높다. 진행 카운트는 그대로
        // 늘리고, 안전장치(UNCHANGED_SAFETY_LIMIT)에만 별도로 반영한다.
        Core.log('raremap', `동일 종류 레어맵이 연속 출현 중일 수 있습니다 (연속 ${unchangedCount}/${UNCHANGED_SAFETY_LIMIT}, 정상 범위: 최대 25회 안팎).`);
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
    let nextBatchPauseAt = Core.rand(5, 8);
    while (mod.running && mod.cycleCount < mod.config.maxCycles) {
      await mod.runCycle();
      if (!mod.running) break;
      if (mod.cycleCount >= nextBatchPauseAt) {
        const pauseMs = Core.rand(1800, 3200);
        Core.log('raremap', `${mod.cycleCount}장 처리 완료 → ${Math.round(pauseMs / 100) / 10}초 묶음 휴식`);
        await Core.sleep(pauseMs);
        nextBatchPauseAt = mod.cycleCount + Core.rand(5, 8);
      } else {
        await Core.sleep(Core.rand(250, 550));
      }
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

  Modules.dungeon.goToDungeonSelect = async function (
    shouldCancel = Core.defaultShouldCancel
  ) {
    await Core.clickNavMenuExact('전투', '던전', shouldCancel);
    return !!(await Core.waitFor(
      () => Core.bodyText().includes('일일 던전'),
      15000,
      300,
      shouldCancel
    ));
  };

  // ⚠ 버그 수정(2026-08, 실전 확인): "전투 > 던전" 메뉴는 진행 중인 던전이
  // 있으면 목록 화면이 아니라 그 던전의 진행 화면으로 곧바로 이동시킨다
  // (목록 화면 특징 텍스트인 "일일 던전"이 아니라 "진행도"가 뜸). 기존
  // goToDungeonSelect는 "일일 던전" 텍스트만 성공 조건으로 봐서, 진행 중인
  // 던전이 있는 상태에서 호출하면 15초 내내 기다리다 실패한다. 이어하기
  // (resume) 경로 전용으로, 목록 화면/진행 화면 둘 다 성공으로 인정한다.
  Modules.dungeon.goToDungeonScreen = async function (
    shouldCancel = Core.defaultShouldCancel
  ) {
    await Core.clickNavMenuExact('전투', '던전', shouldCancel);
    return !!(await Core.waitFor(
      () => Core.bodyText().includes('일일 던전') || Core.bodyText().includes('진행도'),
      15000,
      300,
      shouldCancel
    ));
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
      // 일반 후보는 첫 화면이라는 이유만으로 즉시 사지 않는다. 보스 직전이거나
      // 신의 일격/모든 스탯 계열을 찾았을 때만 구매하고, 그 외에는 리롤한다.
      const shouldBuyNow = pick && (isLastShopBeforeBoss || isPremiumPick);

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
    Core.log('dungeon', `던전 자동클리어 시작 (오늘 이미 클리어한 던전: ${mod.cycleCount}개)`);

    // ⚠ 버그 수정(2026-08, 사용자 확인): 예전엔 "재시작 시점에 마침 열려
    // 있던 페이지"만 보고 재개 여부(detectResumeDungeon)를 판정했다. 정지
    // 후 다시 시작할 때 사용자가 던전 화면이 아닌 다른 곳에 있으면 이
    // 판정이 항상 실패(null)하고, 그러면 "새 큐 스캔" 경로(구 버전
    // goToDungeonSelect)로 빠지는데, 그 함수는 "일일 던전" 텍스트만
    // 성공으로 봤다 - 그런데 실제로 진행 중인 던전이 있으면 "전투 > 던전"
    // 메뉴 클릭이 목록이 아니라 진행 화면으로 곧바로 이동시켜버려서(§0-6
    // 참고 패턴과 동일) 15초 내내 기다리다 실패하고, 그 실패 여부를 체크도
    // 안 한 채 scanEligibleDungeons를 불러 목록 카드를 하나도 못 찾아 빈
    // 큐가 되어 "입장 가능한 던전이 없습니다"로 조기 종료됐다(실전 확인:
    // 던전 도중 정지 후 재시작하면 이어하지 않고 그냥 멈춤). 이제 먼저
    // 실제로 "전투 > 던전" 메뉴로 이동해(목록/진행 화면 둘 다 인정하는
    // goToDungeonScreen) 게임이 데려다주는 화면을 보고 나서 재개 여부를
    // 판정한다 - 재시작 시점에 사용자가 어느 페이지에 있었든 무관해진다.
    const navigated = await mod.goToDungeonScreen();
    if (!mod.running) return;
    if (!navigated) {
      Core.notifyStopped('dungeon', '던전 화면 진입을 확인하지 못해 정지합니다.');
      return;
    }

    const resumeDungeon = mod.detectResumeDungeon();
    let queue = [];
    if (!resumeDungeon) {
      // 이미 위에서 던전 화면(목록)에 도착해 있으므로 다시 메뉴를 누를
      // 필요가 없다.
      queue = mod.scanEligibleDungeons();
      if (queue.length === 0) {
        Core.log('dungeon', '입장 가능한 던전이 없습니다 (전부 완료됐거나 입장권이 없음). 정지합니다.');
        Core.moduleResults.dungeon = { ok: true, message: '입장 가능한 모든 던전 완료 또는 입장권 소진', at: Date.now() };
        mod.running = false;
        Core.activeModuleId = Core.activeModuleId === 'dungeon' ? null : Core.activeModuleId;
        Core.updateModuleButtons();
        return;
      }
      Core.log('dungeon', `입장 큐 확정: ${queue.map((d) => d.label).join(' → ')}`);
    }

    // 여기 도달했다는 건 할 일이 있다는 뜻(재개할 던전이 있거나, 새로 들어갈
    // 던전이 있음) → 이제서야 프리셋/속성을 맞춘다.
    Core.log('dungeon', '시작 전 공용 프리셋 "던전" 적용');
    await Core.applyCommonPreset('던전', 'dungeon');
    Core.log('dungeon', `시작 전 원래 속성(${mod.config.originalElement}) 확인`);
    await Core.ensureCharacterElement(mod.config.originalElement, 'dungeon');

    if (resumeDungeon) {
      Core.log('dungeon', `이미 진행 중이던 "${resumeDungeon.label}"을(를) 인식했습니다 - 이어서 진행합니다.`);

      // ⚠ 버그 수정(2026-08, 실전 확인): 프리셋/속성 확인 과정에서 화면이
      // "캐릭 > 프리셋", "캐릭 > 내정보"로 이동하는데, 그 이후 던전 화면으로
      // 복귀하는 코드가 빠져 있었다(심층던전에서 발견해 고친 것과 동일
      // 패턴). "전투 > 던전" 메뉴는 진행 중인 던전이 있으면 목록이 아니라
      // 그 던전의 진행 화면으로 곧바로 이동시키는 것을 실전에서 직접
      // 확인함(진행도 0/15 상태에서 캐릭>프리셋→캐릭>내정보로 화면을 이동시킨
      // 뒤, "전투>던전"만 다시 눌러 정확히 원래 진행 화면으로 복귀 확인됨).
      const backOnDungeonScreen = await mod.goToDungeonScreen();
      if (!backOnDungeonScreen) {
        Core.notifyStopped('dungeon', '속성/프리셋 확인 후 던전 화면으로 복귀하지 못해 정지합니다.');
        return;
      }

      await mod.runOneDungeon(resumeDungeon, { resume: true });
      if (!mod.running) {
        Core.log('dungeon', `던전 자동클리어 종료. 오늘 클리어한 던전: ${mod.cycleCount}개`);
        mod.running = false;
        Core.activeModuleId = Core.activeModuleId === 'dungeon' ? null : Core.activeModuleId;
        Core.updateModuleButtons();
        return;
      }
      await mod.goToDungeonSelect();
      if (!mod.running) return;
      queue = mod.scanEligibleDungeons();
      if (queue.length === 0) {
        Core.log('dungeon', '입장 가능한 던전이 없습니다 (전부 완료됐거나 입장권이 없음). 정지합니다.');
        Core.moduleResults.dungeon = { ok: true, message: '입장 가능한 모든 던전 완료 또는 입장권 소진', at: Date.now() };
        mod.running = false;
        Core.activeModuleId = Core.activeModuleId === 'dungeon' ? null : Core.activeModuleId;
        Core.updateModuleButtons();
        return;
      }
      Core.log('dungeon', `입장 큐 확정: ${queue.map((d) => d.label).join(' → ')}`);
    }

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
    if (!Core.moduleResults.dungeon || Core.moduleResults.dungeon.ok === null) {
      Core.moduleResults.dungeon = { ok: true, message: `입장 가능한 던전 ${mod.cycleCount}개 완료`, at: Date.now() };
    }
    mod.running = false;
    Core.activeModuleId = Core.activeModuleId === 'dungeon' ? null : Core.activeModuleId;
    Core.updateModuleButtons();
  };


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
      originalElement: '',
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
      collectionGate: ['관통', '집중', '정확한 한 발'],
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
      collectionGate: ['마법검'],
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
      collectionGate: ['관통', '집중', '정확한 한 발'],
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

    // requiredTargets는 제단 승급 목표이고, 수집 단계 종료 조건과는 분리한다.
    // 둘을 묶으면 직업별 부가 목표 하나가 안 나왔다는 이유로 50층까지 일반
    // 전투만 고르는 구조가 된다.
    const tier1Names = profile.collectionGate ||
      Object.keys(profile.requiredTargets).filter((n) => n !== '급속 성장');
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

    // 속도가 직업별 기준(물리딜 800 / 신술·마술 700) 미만이면 속도, 아니면 직업별
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
    // 이전 층의 상점 진입 사유가 다음 상점까지 남으면 마술 상점 구매 정책이
    // 엉뚱하게 재사용된다. 매 층의 결정을 시작할 때 반드시 초기화한다.
    this.shopVisitReason = null;
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

    try {
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
    } finally {
      // 구매 도중 오류나 정지가 나도 다음 상점에 사유가 누수되지 않게 한다.
      this.shopVisitReason = null;
    }
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
    const combat = this.readCombatSummaryStats();
    const myAttr = (combat && combat.attr) || this.readMyAttribute();
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

  // ⚠ 가을 이벤트(2026-08, 사용자 요청): 50층 클리어 후 "던전의 주인 도전"
  // 버튼을 누르기 전에 "완주 기록 저장" 모달이 뜰 수 있다(심층던전/아레나 중
  // 원하는 슬롯에 이번 완주 기록을 저장할지 묻는 이벤트 한정 팝업). 이 모달이
  // 떠 있는 채로 도전 버튼을 누르면 모달에 가려 클릭이 안 먹는다. 규칙: 빈
  // 슬롯이 있으면 슬롯 1→2→3 순서로 첫 번째 빈 슬롯에 저장하고, 셋 다 이미
  // 차있으면 슬롯 3에 덮어쓴다. 이벤트가 끝나 모달 자체가 안 뜨면(텍스트가
  // 없으면) 아무것도 하지 않고 그대로 지나간다(기존 동작 그대로 유지).
  Modules.deepdungeon.handleRunRecordSaveModal = async function () {
    const findSaveDialog = () => Core.gameElements('[role="dialog"]').find(
      (dialog) => Core.isElementVisible(dialog) && (dialog.textContent || '').includes('완주 기록 저장')
    ) || null;
    const saveDialog = findSaveDialog();
    if (!saveDialog) return false;

    // 슬롯명 <span>에서 공용 upToCard()를 쓰면 가장 가까운 버튼이 아니라
    // 바깥 MUI Dialog(Paper)까지 올라가 버린다. 실전에서 이 때문에 모달의
    // 빈 영역만 반복 클릭하며 50층에서 무한 대기했다. 반드시 현재 저장
    // 모달 안의 실제 <button>을 직접 찾는다.
    const slotButtons = [...saveDialog.querySelectorAll('button')].filter((button) =>
      /^슬롯\s*[123]\b/.test((button.textContent || '').trim())
    );
    const firstEmpty = slotButtons.find((button) => (button.textContent || '').includes('빈 슬롯'));
    const target = firstEmpty || slotButtons.find((button) => /^슬롯\s*3\b/.test((button.textContent || '').trim()));
    if (!target) {
      throw new Error('가을 이벤트 "완주 기록 저장" 모달에서 저장할 슬롯 버튼을 찾지 못했습니다.');
    }

    const slotMatch = (target.textContent || '').match(/슬롯\s*([123])/);
    const slotLabel = slotMatch ? `슬롯 ${slotMatch[1]}` : '선택 슬롯';
    const overwrite = !firstEmpty;
    target.click();
    await Core.humanDelay(400, 700);

    // 세 슬롯이 모두 찼을 때는 슬롯 3 덮어쓰기 확인창이 추가로 뜰 수 있다.
    // 이벤트 UI가 확인창 없이 즉시 저장하는 경우도 허용한다.
    if (overwrite) {
      const confirmDialog = Core.gameElements('[role="dialog"]').find((dialog) => {
        if (!Core.isElementVisible(dialog)) return false;
        const text = dialog.textContent || '';
        return /덮어쓰|기존.*기록/.test(text);
      }) || null;
      if (confirmDialog) {
        const confirmButton = [...confirmDialog.querySelectorAll('button')].find((button) =>
          /^(덮어쓰기|확인|저장)$/.test((button.textContent || '').trim()) && !button.disabled
        );
        if (!confirmButton) throw new Error('슬롯 3 덮어쓰기 확인 버튼을 찾지 못했습니다.');
        confirmButton.click();
        await Core.humanDelay(400, 700);
      }
    }

    const saved = await Core.waitFor(
      () => (
        !findSaveDialog() || Core.bodyText().includes(`완주 기록이 ${slotLabel}에 저장되었습니다`)
          ? true
          : null
      ),
      6000,
      200
    );
    if (!saved) {
      throw new Error(`${slotLabel} 완주 기록 저장 완료를 확인하지 못했습니다.`);
    }

    Core.log(
      'deepdungeon',
      overwrite
        ? '🍂 가을 이벤트: 슬롯 1~3이 모두 차있어 "슬롯 3"에 덮어쓰기 완료'
        : `🍂 가을 이벤트: 완주 기록을 "${slotLabel}"(첫 빈 슬롯)에 저장 완료`
    );
    return true;
  };

  Modules.deepdungeon.handleDungeonMaster = async function () {
    await this.handleRunRecordSaveModal();

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

  Modules.deepdungeon.goToDeepDungeon = async function (
    shouldCancel = Core.defaultShouldCancel
  ) {
    await Core.clickNavMenuExact('전투', '심층 던전', shouldCancel);
    // ⚠ 버그 수정(2026-08, 실전 확인): 예전엔 bodyText().includes('던전 진입')도
    // 성공 조건에 포함시켰는데, 이게 화면이 실제로 안 바뀐 상태(/status 등)에서도
    // true를 반환하는 오판정을 실전에서 직접 재현함(다른 화면 조작이나 텍스트
    // 캐시 우연 일치로 추정). URL 경로만으로 판정하는 게 훨씬 신뢰도 높다 —
    // SPA 라우팅이 실제로 일어났다는 확실한 증거이기 때문.
    return !!(await Core.waitFor(
      () => (location.pathname.startsWith('/deep-dungeon') ? true : null),
      15000,
      300,
      shouldCancel
    ));
  };

  Modules.deepdungeon.parseWeeklyCumulativeDamage = function () {
    const matched = Core.bodyText().match(
      /주간\s*누적\s*(?:데미지|피해)\s*[:：]?\s*([\d,]+)/
    );
    return matched ? parseInt(matched[1].replace(/,/g, ''), 10) : null;
  };

  Modules.deepdungeon.findTopNavigationTab = function (label) {
    const tabLabels = ['입장', '기록', '랭킹', '보상', '목표 세트'];
    const controls = Core.gameElements(
      '[role="tab"], button, a, [role="button"]'
    ).filter((control) => {
      if (!Core.isElementVisible(control)) return false;
      const text = control.textContent.replace(/\s+/g, ' ').trim();
      const ariaLabel = (control.getAttribute('aria-label') || '').trim();
      return text === label || ariaLabel === label;
    });

    const belongsToTopNavigation = (control) => {
      if (
        control.getAttribute('role') === 'tab' ||
        /MuiTab/.test(control.className || '')
      ) return true;

      // 새 화면은 상단 메뉴를 일반 button으로 렌더링한다. 단순히 "입장"이라는
      // 글자만 찾으면 특성 선택창의 실제 입장 버튼을 오인하므로, 같은 컨테이너에
      // 기록·랭킹·보상 등 상단 메뉴가 3개 이상 함께 있는 경우만 탭으로 인정한다.
      // ⚠ 실전 확인: 특성 선택 모달이 React Portal로 <body> 바로
      // 밑에 렌더링되면서, 이 확인 버튼의 조상이 다음 6단계 안에 <body>까지
      // 올라가는 사고가 있었다. <body>는 페이지의 모든 요소를 포함하므로
      // 상단 탭 라벨 5개가 항상 "형제 컨트롬"로 잡혀 확인 버튼을 탭으로
      // 오판하는 버그가 있었다(실전 확인됨). <body>/<html>에 도달하면
      // 그 이상 올라가지 않는다.
      for (
        let node = control.parentElement, depth = 0;
        node &&
        depth < 6 &&
        node !== document.body &&
        node !== document.documentElement;
        node = node.parentElement, depth++
      ) {
        const siblingControls = [
          ...node.querySelectorAll('[role="tab"], button, a, [role="button"]'),
        ];
        const foundLabels = new Set();
        for (const sibling of siblingControls) {
          const text = sibling.textContent.replace(/\s+/g, ' ').trim();
          const ariaLabel = (sibling.getAttribute('aria-label') || '').trim();
          const matchedLabel = tabLabels.find(
            (candidate) => text === candidate || ariaLabel === candidate
          );
          if (matchedLabel) foundLabels.add(matchedLabel);
        }
        if (foundLabels.size >= 3) return true;
      }
      return false;
    };

    return controls.find(belongsToTopNavigation) || null;
  };

  // "기록" 탭으로 이동해서 "주간 누적 데미지" 값을 읽는다. 실패하면 null 반환.
  Modules.deepdungeon.readWeeklyCumulativeDamage = async function (
    shouldCancel = Core.defaultShouldCancel
  ) {
    // 기록 화면이 이미 열려 있으면 탭 DOM 형식과 관계없이 보이는 값을 먼저
    // 읽는다. 기존에는 이 화면에서도 role="tab" 탐색에 실패해 0을 놓쳤다.
    const visibleDamage = this.parseWeeklyCumulativeDamage();
    if (visibleDamage !== null) return visibleDamage;

    const recordTab = await Core.retryStep(
      '"기록" 탭 찾기',
      () => this.findTopNavigationTab('기록'),
      { shouldCancel }
    );
    if (!recordTab) return null;
    if (!(await Core.safeClick(
      () => this.findTopNavigationTab('기록'),
      { beforeMin: 350, beforeMax: 750, shouldCancel }
    ))) return null;
    await Core.humanDelay(600, 1200);

    const matched = await Core.retryStep('"주간 누적 데미지" 텍스트 확인', () => {
      const damage = this.parseWeeklyCumulativeDamage();
      // retryStep은 truthy 결과만 성공으로 취급하므로 숫자 0을 그대로 반환하면
      // 실패로 오인한다. 객체로 감싸 0도 정상 측정값으로 보존한다.
      return damage !== null ? { damage } : null;
    }, { shouldCancel });
    return matched ? matched.damage : null;
  };

  // 실제 확인된 플로우: 로비에서 "던전 진입" 클릭 → 디버프/버프 특성 선택 화면
  // (사용자가 미리 설정해둔 특성이 그대로 유지된 상태)이 뜸 → 여기서 특성을 건드리지
  // 않고 그대로 "입장"만 누른다. "특성 없이 입장"을 누르면 미리 설정해둔 디버프/버프가
  // 전부 사라지므로 절대 누르면 안 된다(반드시 정확히 "입장" 텍스트인 버튼만 클릭).
  // "입장"이라는 정확히 같은 텍스트가 페이지 상단 탭(심층 던전/입장/기록/랭킹...)에도
  // 존재해서 Core.findButtonByText('입장')이 탭을 먼저 찾아버리는 문제가 있었다.
  // 탭(role="tab" 또는 MuiTab 클래스)을 제외한 진짜 버튼만 찾는 전용 헬퍼.
  Modules.deepdungeon.findEnterConfirmButton = function () {
    const topEntryTab = this.findTopNavigationTab('입장');
    return (
      Core.allButtons().find(
        (b) =>
          b.textContent.trim() === '입장' &&
          b !== topEntryTab &&
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

    // ⚠ 버그 수정(2026-08, 사용자 실전 확인): "완주 기록 저장" 모달(가을 이벤트)이
    // 열려있는 동안엔 MUI 다이얼로그가 배경 화면 전체에 aria-hidden을 걸어버려서,
    // Core.bodyText()가 배경 텍스트(예: "던전의 주인", "50층 클리어 완료")를 전부
    // 걸러낸다 - 즉 모달이 떠 있을 땐 아래의 어떤 분기 조건도 매치되지 않고
    // stepOnce가 계속 false만 반환하며 멈춘다(실전에서 재현됨: 로그에 심층던전
    // 관련 진행 없이 멈춰있었음). "던전의 주인" 분기 안에 넣었던 처리는 그래서
    // 호출조차 안 됐다 - 이 모달은 배경 상태와 무관하게 그 자체로 최우선
    // 독립 분기여야 한다.
    if (text.includes('완주 기록 저장')) {
      return await this.handleRunRecordSaveModal();
    }

    // ⚠ 실전 확인: enterFreshRunIfNeeded()가 처음한 번 시도에서 입장
    // 확정 버튼을 못 찾으면 경고만 남기고 그대로 진행하는데, 이 함수
    // (stepOnce)에는 "0층 — 특성 선택" 화면을 인식하는 분기가 없어서, 화면에
    // "입장" 버튼이 뻔히 보여도 아무것도 안 하고 6회(약 12초) 동안 대기만
    // 하다 "화면을 인식하지 못함"으로 멈추는 사고가 실전에서 확인됨.
    // 매 사이클마다 특성 선택 화면을 직접 감지해서 "입장"을 재시도한다.
    if (this.readFloor() === null && (text.includes('특성 선택') || !!Core.findButtonByText('특성 없이 입장'))) {
      const confirmBtn = this.findEnterConfirmButton();
      if (!confirmBtn) {
        Core.log('deepdungeon', '특성 선택 화면의 "입장" 버튼을 아직 찾지 못함 - 다음 사이클에서 재시도');
        return false;
      }
      confirmBtn.click();
      Core.log('deepdungeon', '특성 선택 화면에서 "입장" 버튼 클릭 (재시도)');
      await Core.humanDelay(1000, 1800);
      return true;
    }

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

  // ⚠ 사용자 요청(2026-08): 심층던전 "던전의 주인" 주간 보상 3종(공유 HP
  // 차감/직업별 랭킹/개인 누적 데미지)을 확인해서, 아직 안 받은 것만 받는다.
  // 실전 확인: GET /api/deep-dungeon/world-boss/rewards의
  // {hpContribution,classRanking,personalCumulative}.{eligible,claimed}로
  // 정확히 판별 가능. ⚠ 심층던전 매크로(사냥/도전) 자체를 돌리지 않아도 이
  // 보상은 받아야 하므로, mainLoop에 묶지 않고 "일일" 단계에서 최우선으로,
  // 심층던전 매크로 실행 여부와 무관하게 별도로 호출한다(화면 진입까지
  // 이 함수가 직접 처리). 성공적으로 확인(수령했거나 받을 게 없었거나)
  // 했으면 true, API 실패 등으로 재시도가 필요하면 false.
  Modules.deepdungeon.claimWeeklyWorldBossRewards = async function () {
    let data;
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('https://lanis.me/api/deep-dungeon/world-boss/rewards', {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`API 호출 실패 (HTTP ${res.status})`);
      data = await res.json();
    } catch (e) {
      Core.log('deepdungeon', `⚠ 던전의 주인 주간 보상 확인 실패: ${e.message}`);
      return false;
    }

    const items = [
      { key: 'hpContribution', label: '공유 HP 차감 보상' },
      { key: 'classRanking', label: '직업별 랭킹 보상' },
      { key: 'personalCumulative', label: '개인 누적 데미지 보상' },
    ];
    const pending = items.filter(({ key }) => data[key] && data[key].eligible && !data[key].claimed);
    if (pending.length === 0) {
      Core.log('deepdungeon', '던전의 주인 주간 보상: 받을 것 없음(이미 수령했거나 자격 없음)');
      return true;
    }
    Core.log('deepdungeon', `던전의 주인 주간 보상 ${pending.length}개 수령 시도: ${pending.map((p) => p.label).join(', ')}`);

    try {
      await this.goToDeepDungeon();
      const rewardTab = await Core.retryStep('심층던전 "보상" 탭 찾기', () => this.findTopNavigationTab('보상'));
      if (!rewardTab) {
        Core.log('deepdungeon', '⚠ "보상" 탭을 찾지 못해 주간 보상 수령을 건너뜁니다.');
        return false;
      }
      if (!(await Core.safeClick(() => this.findTopNavigationTab('보상'), { beforeMin: 500, beforeMax: 900, afterMin: 800, afterMax: 1300 }))) {
        Core.log('deepdungeon', '⚠ "보상" 탭 클릭에 실패해 주간 보상 수령을 건너뜁니다.');
        return false;
      }

      let claimed = 0;
      for (let i = 0; i < 5; i++) {
        const btn = Core.findButtonByText('보상 수령');
        if (!btn) break;
        if (!(await Core.safeClick(() => Core.findButtonByText('보상 수령'), { beforeMin: 600, beforeMax: 1100, afterMin: 900, afterMax: 1400 }))) break;
        claimed++;
      }
      Core.log('deepdungeon', `던전의 주인 주간 보상 ${claimed}개 수령 완료`);
      return claimed >= pending.length;
    } catch (e) {
      Core.log('deepdungeon', `⚠ 던전의 주인 주간 보상 수령 중 오류: ${e.message}`);
      return false;
    }
  };

  Modules.deepdungeon.mainLoop = async function () {
    const mod = this;
    mod.cycleCount = 0; // 매크로를 다시 시작할 때마다 "이번 실행"의 도전 횟수로 리셋
    mod.usedSmithyOnce = false;

    Core.log('deepdungeon', `심층던전 자동클리어 시작 (${mod.config.jobMode})`);
    const deepOriginalElement = mod.config.originalElement;
    if (!Core.ELEMENT_OPTIONS.includes(deepOriginalElement)) {
      throw new Error('심층던전 탭에서 원래 속성을 먼저 선택해주세요.');
    }

    // ⚠ 사용자 요청(2026-08): 프리셋/속성부터 맞추고 나서 "오늘 이미 주간
    // 누적 데미지를 다 채웠는지"를 확인하던 순서를 반대로 바꾼다. 이미 다
    // 채운 상태에서 일일을 돌리면 아무 것도 안 하면서 속성돌만 낭비하는
    // 문제가 있었다. 화면 진입/누적 데미지 확인은 프리셋·속성과 무관하게
    // 할 수 있으므로 먼저 확인하고, 할 일이 있을 때만 프리셋/속성을 맞춘다.
    // ⚠ 버그 수정(2026-08, 실전 확인): 이 첫 goToDeepDungeon() 호출이 반환값을
    // 확인하지 않고 있었다. 실패해도 조용히 다음 단계(주간 누적 데미지 확인)로
    // 넘어가서 "기록 탭 찾기" 실패 로그만 반복되다가, 원인을 알 수 없는 채로
    // 이후 모든 단계가 줄줄이 실패하는 상태가 됨을 실전에서 직접 재현함.
    const enteredDeepDungeonAtStart = await mod.goToDeepDungeon();
    if (!mod.running) return;
    if (!enteredDeepDungeonAtStart) {
      Core.notifyStopped('deepdungeon', '심층던전 화면 진입에 실패해 정지합니다.');
      return;
    }

    if (mod.config.retryIfWeeklyDamageUnder1M) {
      const startDamage = await mod.readWeeklyCumulativeDamage();
      if (startDamage === null) {
        Core.notifyStopped(
          'deepdungeon',
          '시작 전 주간 누적 데미지를 읽지 못해 새 런에 진입하지 않고 정지합니다.'
        );
        return;
      }
      if (startDamage >= 1000000) {
        Core.notifyCompleted(
          'deepdungeon',
          `이미 주간 누적 데미지 ${startDamage.toLocaleString()} (100만 이상)라 시작하지 않고 정지합니다.`
        );
        return;
      }
    }

    Core.log('deepdungeon', '시작 전 공용 프리셋 "심층던전" 적용');
    await Core.applyCommonPreset('심층던전', 'deepdungeon');
    Core.log('deepdungeon', `시작 전 원래 속성(${deepOriginalElement}) 확인`);
    await Core.ensureCharacterElement(deepOriginalElement, 'deepdungeon');

    // ⚠ 버그 수정(2026-08, 실전 확인): 프리셋 적용은 "캐릭 > 프리셋", 속성
    // 확인은 "캐릭 > 내정보"로 화면을 이동시키는데, 그 이후 심층던전
    // 화면으로 복귀하는 코드가 빠져 있었다. 그 결과 "입장" 탭 찾기와
    // enterFreshRunIfNeeded()가 전부 엉뚱한 화면(/status)에서 실행되어
    // 매번 실패하고, 매크로가 "속성 확인 완료" 로그만 남긴 채 던전에
    // 진입하지 못하고 멈췄다(실전 로그로 직접 재현·확인함).
    if (!mod.running) return;
    const backOnDeepDungeon = await mod.goToDeepDungeon();
    if (!backOnDeepDungeon) {
      Core.notifyStopped('deepdungeon', '속성/프리셋 확인 후 심층던전 화면으로 복귀하지 못해 정지합니다.');
      return;
    }

    if (mod.config.retryIfWeeklyDamageUnder1M) {
      const enterTabAtStart = await Core.retryStep(
        '"입장" 탭 찾기',
        () => mod.findTopNavigationTab('입장')
      );
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
        // 던전의 주인은 한 런당 1회만 도전 가능하다. "주간 누적 데미지 100만 미만
        // 재도전" 옵션이 켜져 있으면, 기록 탭에서 실제 주간 누적 데미지를 확인해서
        // 아직 100만 미만이면 새 런을 시작해 계속 도전한다.
        if (mod.config.retryIfWeeklyDamageUnder1M) {
          const weeklyDamage = await mod.readWeeklyCumulativeDamage();
          if (weeklyDamage !== null && weeklyDamage < 1000000) {
            Core.log(
              'deepdungeon',
              `주간 누적 데미지 ${weeklyDamage.toLocaleString()} (100만 미만) → 재도전을 위해 새 런을 시작합니다.`
            );
            const enterTab = await Core.retryStep(
              '"입장" 탭 찾기',
              () => mod.findTopNavigationTab('입장')
            );
            if (enterTab) {
              enterTab.click();
              await Core.humanDelay(600, 1200);
            }
            const enteredAgain = await mod.enterFreshRunIfNeeded();
            if (enteredAgain) {
              mod.cycleCount = 0;
              mod.usedSmithyOnce = false;
              mod.hpBeforeBattle = null;
              mod.shopVisitReason = null;
              consecutiveNoProgress = 0;
              await Core.humanDelay(300, 700);
              continue;
            }
            Core.notifyStopped('deepdungeon', '재도전을 위해 새 런을 시작하지 못했습니다.');
            break;
          }
          if (weeklyDamage === null) {
            Core.notifyStopped(
              'deepdungeon',
              '주간 누적 데미지를 확인하지 못해 완료로 기록하지 않고 안전하게 정지합니다.'
            );
            break;
          } else {
            Core.log('deepdungeon', `주간 누적 데미지 ${weeklyDamage.toLocaleString()} (100만 이상) → 정지합니다.`);
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

  const DEEPDUNGEON_CONFIG_KEY = 'lrm-deepdungeon-config';

  Modules.deepdungeon.saveConfig = function () {
    try {
      localStorage.setItem(
        DEEPDUNGEON_CONFIG_KEY,
        JSON.stringify({
          originalElement: this.config.originalElement,
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
    refs.inputs = [elementSelect, jobSelect, tokenInput, emergInput, bossPreInput, acInput, defInput, retryCheck];
  }

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
  // 우측 상단 계정 아이콘(텍스트/aria-label 없는, 상단 네비게이션 바에서
  // 가장 오른쪽에 위치한 아이콘 버튼) → 드롭다운 "길드" → /guild 화면.
  // 길드 화면의 모든 하위 기능(보스, 마을효과 명성 등)에서 공통으로 쓰는
  // 진입 경로라 별도 함수로 분리했다.
  Modules.guildboss.goToGuildScreen = async function () {
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
    return true;
  };

  Modules.guildboss.goToGuildBossScreen = async function () {
    await Modules.guildboss.goToGuildScreen();
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
      // 정상 공격으로 페이지가 이미 받은 결과 DOM만 짧게 관찰하고 로컬 보고한다.
      // 이 관찰자는 fetch/XHR/WebSocket을 사용하지 않으며 최대 4초 뒤 종료된다.
      if (window.RanisHydraClientState) {
        window.RanisHydraClientState.observe({
          durationMs: 4000,
          targetHead: mod.findHeadNameByElement(bossId, mod.getBossConfig(bossId).targetElement),
          targetElement: mod.getBossConfig(bossId).targetElement,
        });
        window.RanisHydraClientState.capture({
          targetHead: mod.findHeadNameByElement(bossId, mod.getBossConfig(bossId).targetElement),
          targetElement: mod.getBossConfig(bossId).targetElement,
        });
      }
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

  // -------------------------- 유물 자동 각인 --------------------------
  // 이 모듈의 책임은 미각인 유물의 스탯 4개를 선택하고 8회 각인한 뒤,
  // 완료창의 스탯 합을 목표치와 비교하는 것까지다. 장착·해제·분해·초기화는
  // 사용자의 판단 영역이므로 어떤 경우에도 자동으로 누르지 않는다.
  const RELIC_STATS = ['힘', '생명', '지능', '정신', '속도', '행운'];
  const RELIC_CONFIG_KEYS = ['selectedStats', 'selectionOrder', 'targetSum'];

  Modules.relic = {
    id: 'relic',
    running: false,
    stopRequested: false,
    runId: 0,
    loopPromise: null,
    cycleCount: 0,
    config: {
      selectedStats: ['지능', '정신', '속도', '행운'],
      selectionOrder: ['지능', '정신', '속도', '행운'],
      targetSum: 26,
    },
  };
  Core.loadModuleConfig('relic', RELIC_CONFIG_KEYS);
  Modules.relic.config.selectedStats = Array.isArray(Modules.relic.config.selectedStats)
    ? Modules.relic.config.selectedStats.filter((stat, index, all) => RELIC_STATS.includes(stat) && all.indexOf(stat) === index).slice(0, 4)
    : [];
  Modules.relic.config.selectionOrder = Array.isArray(Modules.relic.config.selectionOrder)
    ? Modules.relic.config.selectionOrder.filter((stat, index, all) => Modules.relic.config.selectedStats.includes(stat) && all.indexOf(stat) === index)
    : [];
  Modules.relic.config.selectedStats.forEach((stat) => {
    if (!Modules.relic.config.selectionOrder.includes(stat)) Modules.relic.config.selectionOrder.push(stat);
  });
  Modules.relic.config.targetSum = Math.max(0, Math.floor(Number(Modules.relic.config.targetSum) || 0));

  Modules.relic.shouldCancel = function (runId) {
    return this.stopRequested || !this.running || this.runId !== runId;
  };

  Modules.relic.visibleDialogs = function () {
    return Core.gameElements('[role="dialog"]').filter((el) => Core.isElementVisible(el));
  };

  Modules.relic.findDialog = function (markerText) {
    return this.visibleDialogs().find((el) => el.textContent.includes(markerText)) || null;
  };

  Modules.relic.exactButtons = function (scope, text) {
    return [...scope.querySelectorAll('button')].filter(
      (button) => button.textContent.replace(/\s+/g, ' ').trim() === text && Core.isElementVisible(button)
    );
  };

  Modules.relic.exactLeaf = function (scope, text) {
    return [...scope.querySelectorAll('*')].find(
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim() === text &&
        Core.isElementVisible(el)
    ) || null;
  };

  Modules.relic.parseLevels = function (scope) {
    const text = scope.textContent.replace(/\s+/g, ' ').trim();
    const levels = {};
    this.config.selectedStats.forEach((stat) => {
      const match = text.match(new RegExp(`${stat}\\s*Lv\\.\\s*(\\d+)`));
      if (!match) throw new Error(`DOM에서 "${stat}" 레벨을 읽지 못했습니다.`);
      levels[stat] = Number(match[1]);
    });
    return levels;
  };

  Modules.relic.statPriority = function () {
    // 사용자 규칙: 최저 레벨이 동률이면 속도를 가장 먼저 선택한다.
    // 나머지는 GUI에서 사용자가 체크한 순서를 유지한다.
    return [
      ...(this.config.selectedStats.includes('속도') ? ['속도'] : []),
      ...this.config.selectionOrder.filter((stat) => stat !== '속도' && this.config.selectedStats.includes(stat)),
    ];
  };

  Modules.relic.chooseMainStat = function (levels) {
    const min = Math.min(...this.config.selectedStats.map((stat) => levels[stat]));
    const chosen = this.statPriority().find((stat) => levels[stat] === min);
    if (!chosen) throw new Error('주 슬롯으로 선택할 스탯을 결정하지 못했습니다.');
    return chosen;
  };

  Modules.relic.ensureRelicPage = async function (runId) {
    const shouldCancel = () => this.shouldCancel(runId);
    if (location.pathname !== '/relic') {
      await Core.clickNavMenuExact('캐릭', '유물 · 룬', shouldCancel);
    }
    const heading = await Core.waitFor(
      () => Core.gameElements('h1,h2,h3,h4,h5,h6').find((el) => el.textContent.trim() === '유물' && Core.isElementVisible(el)) || null,
      15000,
      300,
      shouldCancel
    );
    if (!heading) throw new Error('유물 페이지 진입을 확인하지 못했습니다.');
  };

  Modules.relic.openNextUnengraved = async function (runId) {
    const shouldCancel = () => this.shouldCancel(runId);
    const startButton = await Core.waitFor(() => {
      const buttons = Core.allButtons().filter(
        (button) => button.textContent.trim() === '각인 시작' && Core.isElementVisible(button) && !button.disabled
      );
      return buttons[0] || null;
    }, 8000, 300, shouldCancel);
    if (!startButton) return false;
    if (!(await Core.safeClick(() => startButton.isConnected ? startButton : null, {
      beforeMin: 250,
      beforeMax: 500,
      shouldCancel,
    }))) throw new Error('첫 번째 미각인 유물의 "각인 시작" 클릭에 실패했습니다.');

    const setup = await Core.waitFor(() => this.findDialog('각인할 스탯 설정'), 8000, 200, shouldCancel);
    if (!setup) throw new Error('각인할 스탯 설정창을 찾지 못했습니다.');

    for (const stat of this.config.selectionOrder) {
      if (!this.config.selectedStats.includes(stat)) continue;
      const buttons = this.exactButtons(setup, stat);
      if (buttons.length !== 1) throw new Error(`스탯 선택 버튼 "${stat}"이 ${buttons.length}개입니다.`);
      if (!(await Core.safeClick(() => buttons[0].isConnected ? buttons[0] : null, {
        beforeMin: 100,
        beforeMax: 220,
        shouldCancel,
      }))) throw new Error(`스탯 "${stat}" 선택에 실패했습니다.`);
    }
    const selectedFour = await Core.waitFor(
      () => setup.textContent.replace(/\s+/g, ' ').includes('4개의 스탯을 선택하세요 (4/4)') ? true : null,
      3000,
      150,
      shouldCancel
    );
    if (!selectedFour) throw new Error('각인 스탯 4개 선택을 DOM으로 확인하지 못했습니다.');
    const setupStart = this.exactButtons(setup, '각인 시작');
    if (setupStart.length !== 1 || setupStart[0].disabled) throw new Error('설정창의 각인 시작 버튼이 활성화되지 않았습니다.');
    if (!(await Core.safeClick(() => setupStart[0].isConnected ? setupStart[0] : null, {
      beforeMin: 200,
      beforeMax: 400,
      shouldCancel,
    }))) throw new Error('유물 각인 준비 시작에 실패했습니다.');

    const progressButton = await Core.waitFor(
      () => Core.allButtons().find((button) => button.textContent.trim() === '각인 진행' && Core.isElementVisible(button)) || null,
      8000,
      200,
      shouldCancel
    );
    if (!progressButton) throw new Error('준비된 유물의 "각인 진행" 버튼을 찾지 못했습니다.');
    if (!(await Core.safeClick(() => progressButton.isConnected ? progressButton : null, {
      beforeMin: 250,
      beforeMax: 500,
      shouldCancel,
    }))) throw new Error('유물 각인창 열기에 실패했습니다.');
    return true;
  };

  Modules.relic.runEightEngravings = async function (runId) {
    const shouldCancel = () => this.shouldCancel(runId);
    for (let round = 1; round <= 8; round++) {
      if (shouldCancel()) return null;
      const dialog = await Core.waitFor(() => this.findDialog('태초의 유물 각인'), 8000, 200, shouldCancel);
      if (!dialog) throw new Error(`${round}회차 유물 각인창을 찾지 못했습니다.`);
      if (dialog.textContent.includes('각인 완료!')) break;
      const levelsBefore = this.parseLevels(dialog);
      const mainStat = this.chooseMainStat(levelsBefore);
      const statElement = this.exactLeaf(dialog, mainStat);
      if (!statElement) throw new Error(`주 슬롯 "${mainStat}"을 DOM에서 찾지 못했습니다.`);
      if (!(await Core.safeClick(() => statElement.isConnected ? statElement : null, {
        beforeMin: 450,
        beforeMax: 750,
        shouldCancel,
      }))) throw new Error(`주 슬롯 "${mainStat}" 선택에 실패했습니다.`);

      const payButtons = [...dialog.querySelectorAll('button')].filter((button) => {
        // MUI 버튼은 화면/접근성 트리에서는 두 줄 사이가 공백으로 읽히지만
        // textContent에서는 "각인 진행1,000,000 골드"처럼 붙을 수 있다.
        // 공백을 모두 제거한 정확한 전체 문구로 동일 버튼임을 검증한다.
        const text = button.textContent.replace(/\s+/g, '');
        return text === '각인진행1,000,000골드' && Core.isElementVisible(button);
      });
      if (payButtons.length !== 1 || payButtons[0].disabled) {
        throw new Error(`${round}회차 각인 진행 버튼 상태가 올바르지 않습니다.`);
      }
      const remainingBeforeMatch = dialog.textContent.replace(/\s+/g, ' ').match(/각인 횟수:\s*(\d+)\s*\/\s*8회 남음/);
      if (!remainingBeforeMatch) throw new Error(`${round}회차 남은 각인 횟수를 읽지 못했습니다.`);
      const remainingBefore = Number(remainingBeforeMatch[1]);
      if (!(await Core.safeClick(() => payButtons[0].isConnected ? payButtons[0] : null, {
        beforeMin: 400,
        beforeMax: 700,
        shouldCancel,
      }))) throw new Error(`${round}회차 각인 실행에 실패했습니다.`);

      // 실전 DOM 재측정(2026-08-22, 실제 7회): 결과 갱신 2.756~2.949초,
      // 안정 확인 2.997~3.192초. 갱신 전에 다음 작업을 시작하지 않도록 실측
      // 하한보다 약간 이른 2.7초부터만 DOM 폴링을 허용한다.
      if (!(await Core.interruptibleSleep(Core.rand(2700, 3200), shouldCancel))) return null;

      const updated = await Core.waitFor(() => {
        const completed = this.findDialog('태초의 유물 각인 완료!');
        if (completed) return completed;
        const current = this.findDialog('태초의 유물 각인');
        if (!current) return null;
        const match = current.textContent.replace(/\s+/g, ' ').match(/각인 횟수:\s*(\d+)\s*\/\s*8회 남음/);
        return match && Number(match[1]) === remainingBefore - 1 ? current : null;
      }, 15000, 250, shouldCancel);
      if (!updated) throw new Error(`${round}회차 각인 결과 갱신을 확인하지 못했습니다.`);
      const latestLevels = this.parseLevels(updated);

      // 애니메이션 중간 프레임이나 React의 부분 렌더를 최종 결과로 채택하지
      // 않는다. 한 번 읽은 뒤 다시 기다리고, 동일한 대화상자에서 레벨 4개와
      // 남은 횟수가 모두 같은지 재확인해야 다음 회차로 진행한다.
      if (!(await Core.interruptibleSleep(Core.rand(500, 800), shouldCancel))) return null;
      const stableDialog =
        this.findDialog('태초의 유물 각인 완료!') ||
        this.findDialog('태초의 유물 각인');
      if (!stableDialog) throw new Error(`${round}회차 각인 결과 대화상자가 안정화 전에 사라졌습니다.`);
      const stableLevels = this.parseLevels(stableDialog);
      const levelsStable = this.config.selectedStats.every((stat) => stableLevels[stat] === latestLevels[stat]);
      if (!levelsStable) throw new Error(`${round}회차 각인 레벨이 재확인 중 변경되어 안전 정지했습니다.`);
      if (!stableDialog.textContent.includes('각인 완료!')) {
        const stableRemaining = stableDialog.textContent.replace(/\s+/g, ' ').match(/각인 횟수:\s*(\d+)\s*\/\s*8회 남음/);
        if (!stableRemaining || Number(stableRemaining[1]) !== remainingBefore - 1) {
          throw new Error(`${round}회차 남은 횟수가 안정적으로 갱신되지 않아 안전 정지했습니다.`);
        }
      }
      Core.log('relic', `${round}/8회 완료 (주 슬롯: ${mainStat}) → ${this.config.selectedStats.map((stat) => `${stat} ${latestLevels[stat]}`).join(', ')}`);
    }
    return Core.waitFor(() => this.findDialog('태초의 유물 각인 완료!'), 8000, 200, shouldCancel);
  };

  Modules.relic.mainLoop = async function (runId) {
    if (this.config.selectedStats.length !== 4) throw new Error('각인할 스탯을 정확히 4개 선택해주세요.');
    if (!Number.isFinite(this.config.targetSum) || this.config.targetSum < 0) throw new Error('목표 스탯 합을 0 이상으로 설정해주세요.');
    await this.ensureRelicPage(runId);
    while (!this.shouldCancel(runId)) {
      const opened = await this.openNextUnengraved(runId);
      if (!opened) {
        Core.notifyStopped('relic', '각인할 미장착·미각인 유물이 없어 종료했습니다.');
        return;
      }
      const completedDialog = await this.runEightEngravings(runId);
      if (!completedDialog || this.shouldCancel(runId)) return;
      const levels = this.parseLevels(completedDialog);
      const total = this.config.selectedStats.reduce((sum, stat) => sum + levels[stat], 0);
      this.cycleCount++;
      Core.updateModuleButtons();
      Core.log('relic', `유물 ${this.cycleCount}개차 완료: ${this.config.selectedStats.map((stat) => `${stat} ${levels[stat]}`).join(', ')} / 합계 ${total}`);

      if (total >= this.config.targetSum) {
        // 성공 유물은 사용자가 바로 판단할 수 있게 완료창을 그대로 남긴다.
        Core.notifyCompleted('relic', `목표 달성: 스탯 합 ${total} (목표 ${this.config.targetSum})`);
        return;
      }

      Core.log('relic', `목표 미달: 스탯 합 ${total} < ${this.config.targetSum} → 다음 유물로 계속`);
      const confirmButtons = this.exactButtons(completedDialog, '확인');
      if (confirmButtons.length !== 1) throw new Error('각인 완료창의 확인 버튼을 정확히 찾지 못했습니다.');
      if (!(await Core.safeClick(() => confirmButtons[0].isConnected ? confirmButtons[0] : null, {
        beforeMin: 250,
        beforeMax: 500,
        shouldCancel: () => this.shouldCancel(runId),
      }))) throw new Error('각인 완료창 닫기에 실패했습니다.');
      const closed = await Core.waitFor(() => !this.findDialog('태초의 유물 각인 완료!') ? true : null, 5000, 200, () => this.shouldCancel(runId));
      if (!closed) throw new Error('각인 완료창이 닫히지 않아 다음 유물로 넘어가지 못했습니다.');
    }
  };

  function buildRelicTab(container) {
    const mod = Modules.relic;
    const refs = UIRefs.relic;
    const description = document.createElement('div');
    description.textContent = '미장착·미각인 유물을 위에서부터 자동 각인합니다. 목표 합계 이상이 나오면 완료창을 남기고 정지합니다.';
    description.style.cssText = 'font-size:11px; color:#ccc; line-height:1.5; margin-bottom:8px;';
    container.appendChild(description);

    container.appendChild(labelEl('각인할 스탯 (4개 선택)'));
    const statGrid = document.createElement('div');
    statGrid.style.cssText = 'display:grid; grid-template-columns:repeat(3,1fr); gap:5px; margin:5px 0 9px;';
    const statInputs = [];
    RELIC_STATS.forEach((stat) => {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex; align-items:center; gap:4px; padding:5px; border:1px solid #444; border-radius:4px; cursor:pointer;';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = mod.config.selectedStats.includes(stat);
      input.addEventListener('change', () => {
        if (input.checked) {
          if (mod.config.selectedStats.length >= 4) {
            input.checked = false;
            Core.showBanner('relic', '각인 스탯은 4개까지 선택할 수 있습니다.');
            return;
          }
          mod.config.selectedStats.push(stat);
          mod.config.selectionOrder = mod.config.selectionOrder.filter((item) => item !== stat);
          mod.config.selectionOrder.push(stat);
        } else {
          mod.config.selectedStats = mod.config.selectedStats.filter((item) => item !== stat);
          mod.config.selectionOrder = mod.config.selectionOrder.filter((item) => item !== stat);
        }
        Core.saveModuleConfig('relic', RELIC_CONFIG_KEYS);
        Core.updateModuleButtons();
      });
      const text = document.createElement('span');
      text.textContent = stat;
      label.append(input, text);
      statGrid.appendChild(label);
      statInputs.push(input);
    });
    container.appendChild(statGrid);

    container.appendChild(labelEl('목표 스탯 합 (이상이면 종료)'));
    const targetInput = document.createElement('input');
    targetInput.type = 'number';
    targetInput.min = '0';
    targetInput.step = '1';
    targetInput.value = String(mod.config.targetSum);
    targetInput.style.cssText = inputStyle();
    targetInput.addEventListener('change', () => {
      const parsed = Math.max(0, Math.floor(Number(targetInput.value) || 0));
      mod.config.targetSum = parsed;
      targetInput.value = String(parsed);
      Core.saveModuleConfig('relic', RELIC_CONFIG_KEYS);
    });
    container.appendChild(targetInput);

    const safetyNote = document.createElement('div');
    safetyNote.textContent = '※ 속도는 최저 수치 동률 시 최우선입니다. 장착·해제·분해·초기화는 자동으로 하지 않습니다.';
    safetyNote.style.cssText = 'font-size:10px; color:#f5a623; line-height:1.45; margin:7px 0;';
    container.appendChild(safetyNote);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:6px; margin-top:6px;';
    const startBtn = document.createElement('button');
    startBtn.textContent = '시작';
    startBtn.style.cssText = btnStyle('#2e7d32');
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '정지';
    stopBtn.style.cssText = btnStyle('#c62828');
    stopBtn.disabled = true;
    const statusEl = document.createElement('div');
    statusEl.textContent = '대기중';
    statusEl.style.cssText = 'font-size:11px; color:#ccc; margin-top:6px;';
    startBtn.addEventListener('click', () => Core.startModule('relic'));
    stopBtn.addEventListener('click', () => Core.requestStopModule('relic'));
    btnRow.append(startBtn, stopBtn);
    container.append(btnRow, statusEl);

    refs.startBtn = startBtn;
    refs.stopBtn = stopBtn;
    refs.statusEl = statusEl;
    refs.inputs = [...statInputs, targetInput];
  }

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
    relic: {},
    autohunt: {},
    raremap: {},
    dungeon: {},
    arena: {},
    preseason: {},
    preseasonArena: {},
    deepdungeon: {},
    guildboss: {},
  };
  let activeTab = 'rejob';

  Core.updateModuleButtons = function () {
    ['rejob', 'relic', 'autohunt', 'raremap', 'dungeon', 'arena', 'preseason', 'preseasonArena', 'deepdungeon'].forEach((id) => {
      const mod = Modules[id];
      const refs = UIRefs[id];
      if (!refs.startBtn) return;
      const otherRunning =
        (Core.activeModuleId && Core.activeModuleId !== id) ||
        (Core.dailyActive && !mod.running);
      const safetyLocked =
        (id === 'rejob' && refs.safetyCheck && !refs.safetyCheck.checked) ||
        (id === 'relic' && mod.config.selectedStats.length !== 4);
      refs.startBtn.disabled = mod.running || otherRunning || safetyLocked;
      refs.stopBtn.disabled = !mod.running;
      const cycleLabel =
        id === 'dungeon'
          ? `오늘 클리어 ${mod.cycleCount}개`
          : id === 'arena'
          ? `오늘 전투 ${mod.cycleCount}회 (무료인 동안 반복)`
          : id === 'preseason'
          ? `가을 아레나 전투 ${mod.cycleCount}회 (단풍 토큰 한도까지 반복)`
          : id === 'preseasonArena'
          ? `전투 ${mod.cycleCount}회 / 30분마다 통발 작업`
          : id === 'deepdungeon'
          ? `던전의 주인 도전 ${mod.cycleCount}회`
          : id === 'relic'
          ? `유물 ${mod.cycleCount}개 각인 완료`
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
    // 로 명시적인 행을 나눔) - 성장/파밍(재전직·유물·레어맵), 전투 콘텐츠(던전·
    // 자동사냥·보스·심층던전·아레나), 길드(길드보스), 이벤트(이벤트) 순.
    const TAB_ROWS = [
      ['rejob', 'relic', 'raremap'],
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
    buildRelicTab(tabContents.relic);
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
    const headless = window.__lanisSharedCoreOptions?.mode === 'headless';
    if (!headless && document.getElementById('lrm-panel')) return;
    if (!headless) {
      buildPanel();
      Core.log('core', '통합 매크로 패널 로드 완료 (재전직 / 유물 / 자동사냥 / 레어맵 / 던전 / 아레나 / 심층던전 / 보스 / 일일)');
    }
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

  window.__mountLanisUnifiedPanel = buildPanel;

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
  M._workerSleepFn = window.__lanisBackgroundSleep || (function () {
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

  // 긴 Worker 대기를 한 번에 걸면 그 사이 정지를 눌러도 타이머가 끝날
  // 때까지 현재 async 함수가 살아 있다. 250ms 단위로 쪼개 매번 정지
  // 상태를 검사하여, 백그라운드에서도 실제 클릭 흐름을 즉시 끊는다.
  M.sleep = async (ms) => {
    const deadline = Date.now() + Math.max(0, ms);
    while (Date.now() < deadline) {
      if (M.stopRequested) {
        const error = new Error('사용자 정지 요청');
        error.isUserStop = true;
        throw error;
      }
      const chunk = Math.min(250, Math.max(1, deadline - Date.now()));
      if (M._workerSleepFn && !M._workerDead) {
        await M._workerSleepFn(chunk);
      } else {
        await new Promise((resolve) => setTimeout(resolve, chunk));
      }
    }
    if (M.stopRequested) {
      const error = new Error('사용자 정지 요청');
      error.isUserStop = true;
      throw error;
    }
  };
  M.throwIfStopped = () => {
    if (!M.stopRequested) return;
    const error = new Error('사용자 정지 요청');
    error.isUserStop = true;
    throw error;
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
    const startedAt = Date.now();
    const maxThrottleAllowance = Math.min(Math.max(timeoutMs, 0), 30000);
    let throttleAllowance = 0;
    let lastTick = Date.now();
    while (true) {
      const now = Date.now();
      const delayedBy = now - lastTick;
      // Core.waitFor와 같은 유한 보정 규칙을 사용한다. document.hidden인
      // 동안 제한 시간을 계속 늘리면 보스 프리셋/모달 하나가 누락됐을 때
      // 포그라운드로 돌아올 때까지 영구 정지한다.
      const throttleThreshold = Math.max(1200, intervalMs * 4);
      if (delayedBy > throttleThreshold && throttleAllowance < maxThrottleAllowance) {
        const excessDelay = Math.max(0, delayedBy - intervalMs);
        throttleAllowance += Math.min(excessDelay, maxThrottleAllowance - throttleAllowance);
      }
      lastTick = now;
      if (M.stopRequested) return null;
      const result = fn();
      if (result) return result;
      // 숨은 탭에서 오래 지연된 뒤 돌아온 첫 tick에도 실제 준비 상태를 먼저
      // 검사한다. 준비된 화면을 단순 시간 초과로 버리지 않는다.
      if (now - startedAt >= timeoutMs + throttleAllowance) break;
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
      (b) =>
        (b.textContent.trim() === text || b.getAttribute('aria-label') === text) &&
        (typeof M.isVisible !== 'function' || M.isVisible(b))
    ) || null;

  M.findLeafByExactText = (text) =>
    M.queryAll('*').find(
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim() === text &&
        (typeof M.isVisible !== 'function' || M.isVisible(el))
    ) ||
    null;

  // 확인/시작류 버튼은 반드시 "현재 열려있는 모달" 안에서만 찾는다
  // 실제로 화면에 "보이는" 요소인지 확인 (DOM엔 남아있지만 숨겨진 모달이
  // 열린 모달로 취급되는 문제 방지)
  M.isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    // 숨겨진 이전 모달을 잘못 고르지 않도록 자기 자신뿐 아니라 조상까지
    // CSS/aria 숨김 상태를 확인한다.
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return false;
    }
    // Chrome은 백그라운드/최소화된 탭에서 레이아웃 계산을 생략해 실제로
    // 열려 있는 프리셋 패널·확인 모달도 getClientRects()가 빈 배열로
    // 보일 수 있다. 이 상태를 "숨김"으로 처리하면 특히 망령 진입 직후
    // 첫 프리셋을 못 찾아 그대로 멈춘다. 숨은 탭에서는 CSS 숨김 여부만
    // 확인하고, 포그라운드에서는 기존의 엄격한 레이아웃 검사를 유지한다.
    if (!document.hidden && el.getClientRects().length === 0) return false;
    return true;
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

  // 보스 진입이 실패했을 때 "왜" 실패했는지 로그만 보고 알 수 있게 현재 화면
  // 상태를 요약한다. 기존에는 "전투 화면 진입 확인 실패" 한 줄만 남아서, 확인
  // 모달을 못 눌러서 실패한 건지 / 눌렀는데 렌더가 늦은 건지 구분이 불가능했다.
  M.describeOpenDialogs = () => {
    const dialogs = M.queryAll('[role="dialog"], [role="presentation"]').filter(M.isVisible);
    if (!dialogs.length) return '열린 모달 없음';
    const texts = dialogs.map(
      (d) =>
        [...d.querySelectorAll('button')]
          .filter(M.isVisible)
          .map((b) => `"${b.textContent.trim()}"`)
          .join(',') || '(버튼 없음)'
    );
    return `열린 모달 ${dialogs.length}개 버튼: ${texts.join(' | ')}`;
  };

  M.describeBattleEntryState = (bossLabel) =>
    [
      `path=${location.pathname}`,
      `보스이름=${M.findLeafByExactText(bossLabel) ? 'O' : 'X'}`,
      `턴진행버튼=${M.findButtonByText('턴 진행5턴') ? 'O' : 'X'}`,
      M.describeOpenDialogs(),
    ].join(' / ');

  // --- 프리셋 -----------------------------------------------------------------
  M.findBossPresetPanelTab = () => {
    const candidates = M.queryAll('button').filter(
      (button) => button.textContent.trim() === '프리셋' && M.isVisible(button)
    );
    return candidates.find((button) => {
      let node = button.parentElement;
      for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
        const labels = [...node.querySelectorAll('button')]
          .filter(M.isVisible)
          .map((item) => item.textContent.trim());
        if (labels.includes('프리셋(구)') && labels.includes('종합')) return true;
      }
      return false;
    }) || null;
  };
  M.isBossPresetPanelReady = () =>
    M.queryAll('*').some(
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim() === '이 보스 전용' &&
        M.isVisible(el)
    );
  M.openPresetPanel = async () => {
    M.throwIfStopped();
    // 이미 보스 전용 목록이 열려 있으면 상단 토글을 다시 누르지 않는다.
    // 열린 상태에서 "프리셋 변경"을 다시 누르면 구형 프리셋 화면으로
    // 되돌아가며, 백그라운드 렌더링이 늦을 때 내부 탭 탐색이 실패한다.
    if (M.isBossPresetPanelReady()) return true;

    for (let attempt = 1; attempt <= 3; attempt++) {
      M.throwIfStopped();
      let tab = M.findBossPresetPanelTab();

      // 패널 자체가 닫힌 경우에만 상단 토글을 누른다. 숨겨진 이전 전투의
      // 버튼을 선택하지 않도록 현재 보이는 버튼만 허용한다.
      if (!tab) {
        const toggle = await M.waitFor(
          () => M.queryAll('button').find(
            (button) =>
              M.isVisible(button) &&
              (
                button.textContent.trim() === '프리셋 변경' ||
                button.getAttribute('aria-label') === '프리셋 변경'
              )
          ) || null,
          5000
        );
        if (toggle) {
          M.throwIfStopped();
          toggle.click();
          tab = await M.waitFor(
            () => M.findBossPresetPanelTab() || (M.isBossPresetPanelReady() ? true : null),
            7000,
            200
          );
        }
      }

      if (M.isBossPresetPanelReady()) return true;
      if (tab && tab !== true) {
        M.throwIfStopped();
        tab.click();
        const ready = await M.waitFor(
          () => M.isBossPresetPanelReady() || null,
          7000,
          200
        );
        if (ready) return true;
      }

      if (attempt < 3) await M.humanPause(350, 700);
    }
    throw new Error('보스 전용 프리셋 패널을 3회 시도했지만 열지 못함');
  };
  M.closePresetPanel = () => {
    const b = M.queryAll('button').find(
      (button) =>
        M.isVisible(button) &&
        (
          button.textContent.trim() === '프리셋 패널 닫기' ||
          button.getAttribute('aria-label') === '프리셋 패널 닫기'
        )
    ) || null;
    if (b) b.click();
    return !!b;
  };
  M.isBossPresetPanelOpen = () =>
    M.isBossPresetPanelReady() || !!M.findBossPresetPanelTab();
  M.closeBossPresetPanelAndWait = async () => {
    if (!M.isBossPresetPanelOpen()) return true;
    for (let attempt = 1; attempt <= 3; attempt++) {
      M.throwIfStopped();
      M.closePresetPanel();
      const closed = await M.waitFor(
        () => !M.isBossPresetPanelOpen() ? true : null,
        5000,
        200
      );
      if (closed) return true;
      if (attempt < 3) await M.humanPause(250, 500);
    }
    throw new Error('프리셋 패널 닫기를 3회 시도했지만 닫힘을 확인하지 못함');
  };
  M.findBossPresetOption = (name) => {
    const leaves = M.queryAll('*').filter(
      (el) => el.children.length === 0 && el.textContent.trim() === name && M.isVisible(el)
    );
    return leaves.find((leaf) => {
      let node = leaf.parentElement;
      for (let depth = 0; node && depth < 9; depth++, node = node.parentElement) {
        const text = node.textContent || '';
        if (text.includes('이 보스 전용') && text.includes('프리셋(구)')) return true;
      }
      return false;
    }) || null;
  };
  M.normalizeBossPresetItemName = (value) =>
    String(value || '')
      .replace(/\(\s*\+\s*\d+\s*\)\s*$/u, '')
      .replace(/\s+/g, ' ')
      .trim();
  M.findBossPresetCard = (optionLeaf) => {
    let node = optionLeaf;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const exactLabels = new Set(
        [...node.querySelectorAll('*')]
          .filter((el) => el.children.length === 0)
          .map((el) => el.textContent.trim())
      );
      if (
        exactLabels.has('무기') &&
        exactLabels.has('방어') &&
        exactLabels.has('장신')
      ) return node;
    }
    return null;
  };
  M.readBossPresetEquipmentFingerprint = (optionLeaf) => {
    const card = M.findBossPresetCard(optionLeaf);
    if (!card) return null;
    const readRow = (label) => {
      const labelEl = [...card.querySelectorAll('*')].find(
        (el) => el.children.length === 0 && el.textContent.trim() === label
      );
      const row = labelEl && labelEl.parentElement;
      if (!row) return null;
      const values = [...row.querySelectorAll('p')]
        .map((el) => M.normalizeBossPresetItemName(el.textContent))
        .filter((text) => text && text !== label);
      return values.length ? values[values.length - 1] : null;
    };
    const fingerprint = {
      weapon: readRow('무기'),
      armor: readRow('방어'),
      accessory: readRow('장신'),
    };
    return Object.values(fingerprint).every(Boolean) ? fingerprint : null;
  };
  M.findLiveBossPlayerCard = () => {
    // ⚠ 실전 확인: img[alt="head-back"]을 기준으로 카드를 찾던 방식은 게임
    // UI가 바뀌면서 더 이상 해당 alt 값을 가진 이미지가 존재하지 않아(실전에서
    // 확인됨: "armor"/"head"/"arm-overlay"로 바뀌어 있음) 항상 null을 반환해
    // "장비 읽기 실패"가 반복되는 진짜 원인이었다. 게임 UI 이미지 alt값은 언제든
    // 바뀌을 수 있으므로, 이미지가 아니라 페이지에 단 하나뿐인 "무기" 라벨을 직접
    // 기준으로 삼고, 그 조상을 따라 올라가며 방어구/장신구/HP/MP가 다 모이는
    // 지점을 찾는다(실전 확인: depth 3에서 모두 모임).
    const weaponLabels = M.queryAll('*').filter(
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim() === '무기' &&
        M.isVisible(el)
    );
    for (const label of weaponLabels) {
      let node = label;
      for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
        const exactLabels = new Set(
          [...node.querySelectorAll('*')]
            .filter((el) => el.children.length === 0)
            .map((el) => el.textContent.trim())
        );
        if (
          exactLabels.has('무기') &&
          exactLabels.has('방어구') &&
          exactLabels.has('장신구') &&
          exactLabels.has('HP') &&
          exactLabels.has('MP')
        ) return node;
      }
    }
    return null;
  };
  M.readLiveBossEquipmentFingerprint = () => {
    const card = M.findLiveBossPlayerCard();
    if (!card) return null;
    const readRow = (label) => {
      const labelEl = [...card.querySelectorAll('*')].find(
        (el) => el.children.length === 0 && el.textContent.trim() === label
      );
      const row = labelEl && labelEl.parentElement;
      if (!row) return null;
      const values = [...row.querySelectorAll('p')]
        .map((el) => M.normalizeBossPresetItemName(el.textContent))
        .filter((text) => text && text !== label);
      return values.length ? values[values.length - 1] : null;
    };
    const fingerprint = {
      weapon: readRow('무기'),
      armor: readRow('방어구'),
      accessory: readRow('장신구'),
    };
    return Object.values(fingerprint).every(Boolean) ? fingerprint : null;
  };
  M.bossEquipmentFingerprintMatches = (expected, actual) =>
    !!expected &&
    !!actual &&
    expected.weapon === actual.weapon &&
    expected.armor === actual.armor &&
    expected.accessory === actual.accessory;
  M.waitForStableBossEquipment = async (
    expectedEquipment,
    { timeout = 8000, interval = 200, consecutive = 3 } = {}
  ) => {
    let matchedCount = 0;
    return M.waitFor(() => {
      const actualEquipment = M.readLiveBossEquipmentFingerprint();
      if (M.bossEquipmentFingerprintMatches(expectedEquipment, actualEquipment)) {
        matchedCount++;
        return matchedCount >= consecutive ? actualEquipment : null;
      }
      matchedCount = 0;
      return null;
    }, timeout, interval);
  };
  M.findBossPresetVerificationCard = (expectedEquipment, targetCard) => {
    const seen = new Set();
    const weaponLabels = M.queryAll('*').filter(
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim() === '무기' &&
        M.isVisible(el)
    );
    for (const label of weaponLabels) {
      const card = M.findBossPresetCard(label);
      if (!card || card === targetCard || seen.has(card) || !M.isVisible(card)) continue;
      seen.add(card);
      const equipment = M.readBossPresetEquipmentFingerprint(card);
      if (
        equipment &&
        !M.bossEquipmentFingerprintMatches(expectedEquipment, equipment)
      ) {
        const name = [...card.querySelectorAll('p')]
          .map((el) => el.textContent.trim())
          .find((text) => text && !['무기', '방어', '장신'].includes(text)) ||
          '검증용 프리셋';
        return { card, equipment, name };
      }
    }
    return null;
  };
  M.formatBossEquipmentFingerprint = (fingerprint) => fingerprint
    ? `${fingerprint.weapon} / ${fingerprint.armor} / ${fingerprint.accessory}`
    : '읽기 실패';
  M.applyBossPreset = async (name, { requireConfirmation = true, attempts = 3 } = {}) => {
    // 새 프리셋 전환을 시작하는 순간 이전 프리셋의 공격 허가를 폐기한다.
    // 적용 확인이 실패하면 이전 봉인 프리셋 상태로 공격을 이어갈 수 없다.
    const previousPreset = M.currentBossPreset;
    M.currentBossPreset = null;
    let confirmed = false;
    for (let attempt = 1; attempt <= attempts && !confirmed; attempt++) {
      M.throwIfStopped();
      await M.openPresetPanel();
      const found = await M.waitFor(() => M.findBossPresetOption(name), 5000);
      if (!found) {
        M.closePresetPanel();
        throw new Error('프리셋 이름 못찾음: ' + name);
      }
      await M.sleep(M.rand(300, 650));
      M.throwIfStopped();
      const fresh = M.findBossPresetOption(name);
      if (!fresh) {
        M.closePresetPanel();
        throw new Error('프리셋 이름 못찾음(재검색 실패): ' + name);
      }
      const expectedEquipment = M.readBossPresetEquipmentFingerprint(fresh);
      if (!expectedEquipment) {
        M.closePresetPanel();
        throw new Error(`프리셋 "${name}" 카드의 장비 정보를 읽지 못했습니다.`);
      }
      // 현재 보스 전용 프리셋은 성공 토스트를 만들지 않는다. 카드 전체에 걸린
      // 클릭 핸들러를 정확히 누른 뒤, 전투 캐릭터 카드의 무기·방어구·장신구가
      // 대상 카드와 일치하는지를 실제 적용 증거로 사용한다.
      let clickTarget = M.findBossPresetCard(fresh) ||
        fresh.closest('button, [role="button"], [tabindex]') ||
        fresh;
      let actualBefore = M.readLiveBossEquipmentFingerprint();
      let requiresFreshSuccessNotice =
        previousPreset !== name &&
        M.bossEquipmentFingerprintMatches(expectedEquipment, actualBefore);
      // 새 전투처럼 현재 프리셋 이름을 신뢰할 수 없는데 장비만 이미 같으면,
      // 대상 클릭이 먹히지 않아도 즉시 성공으로 오인할 수 있다. 장비가 다른
      // 검증용 프리셋으로 한 번 이동한 뒤 대상 장비로 돌아와 실제 클릭 성공을
      // 증명한다. 이전 단계에서 같은 이름을 이미 확인한 경우만 이 왕복을 생략한다.
      if (
        previousPreset !== name &&
        M.bossEquipmentFingerprintMatches(expectedEquipment, actualBefore)
      ) {
        const verification = M.findBossPresetVerificationCard(
          expectedEquipment,
          clickTarget
        );
        if (!verification) {
          // 다른 장비 카드가 없어도 게임이 클릭 직후 내보내는 정확한 성공
          // 알림을 새로 관찰하면 같은 장비의 어빌리티 프리셋을 검증할 수 있다.
          if (M.uiLog) {
            M.uiLog(
              `🔎 프리셋 "${name}" 동일 장비: 새 적용 성공 알림으로 확인`
            );
          }
        } else {
          if (M.uiLog) {
            M.uiLog(
              `↔ 프리셋 "${name}" 동일 장비 오인 방지: ` +
              `"${verification.name}"으로 이동 후 재적용`
            );
          }
          M.throwIfStopped();
          verification.card.click();
          // 프리셋 전환은 서버 반영과 React 재렌더가 모두 끝나기 전에 장비가
          // 잠깐 이전 값/중간 값으로 보일 수 있다. 클릭 직후 판정하지 않고,
          // 먼저 기다린 다음 같은 장비가 연속으로 관찰될 때만 전환 성공으로 본다.
          await M.humanPause(900, 1400);
          const moved = await M.waitForStableBossEquipment(
            verification.equipment,
            { timeout: 8000, interval: 200, consecutive: 3 }
          );
          if (!moved) {
            M.closePresetPanel();
            if (attempt < attempts) {
              if (M.uiLog) {
                M.uiLog(
                  `↻ 프리셋 "${name}" 검증용 장비 전환 실패 ` +
                  `(${attempt}/${attempts}) - 다시 시도`
                );
              }
              await M.humanPause(500, 900);
              continue;
            }
            throw new Error(
              `프리셋 "${name}" 적용 검증용 장비 전환을 ${attempts}회 시도했지만 확인하지 못함`
            );
          }
          actualBefore = moved || actualBefore;
          requiresFreshSuccessNotice = false;
          // 검증용 프리셋 클릭으로 React가 카드 DOM을 다시 만들 수 있다.
          // 전환 전의 노드를 그대로 클릭하면 이미 분리된(stale) 노드라서 아무
          // 반응이 없는데도 장비 비교만 기다리게 된다. 대상 카드를 반드시
          // 현재 DOM에서 다시 찾아 클릭한다.
          const refreshedTarget = M.findBossPresetOption(name);
          clickTarget = refreshedTarget && (
            M.findBossPresetCard(refreshedTarget) ||
            refreshedTarget.closest('button, [role="button"], [tabindex]') ||
            refreshedTarget
          );
          if (!clickTarget || !clickTarget.isConnected) {
            M.closePresetPanel();
            throw new Error(`프리셋 "${name}" 검증 전환 후 대상 카드를 다시 찾지 못했습니다.`);
          }
        }
      } else if (
        previousPreset === name &&
        M.bossEquipmentFingerprintMatches(expectedEquipment, actualBefore)
      ) {
        confirmed = true;
        await M.closeBossPresetPanelAndWait();
        if (M.uiLog) {
          M.uiLog(
            `✓ 프리셋 "${name}" 이전 적용 상태 유지 확인: ` +
            M.formatBossEquipmentFingerprint(actualBefore)
          );
        }
        break;
      }
      let confirmationFailureText = '';
      let confirmationSuccessText = '';
      const observer = new MutationObserver((records) => {
        const noticeSelector =
          '[role="alert"], [role="status"], .MuiSnackbar-root, .MuiAlert-root, ' +
          '[class*="toast" i], [class*="snackbar" i], [class*="alert" i]';
        for (const record of records) {
          const nodes = [
            ...record.addedNodes,
            ...(record.type === 'characterData' ? [record.target] : []),
          ];
          for (const node of nodes) {
            const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
            if (
              !el ||
              !el.closest ||
              el.closest('#lrm-panel, #lrm-banner, #lrm-boss-ref-panel')
            ) continue;

            const explicitNotices = [];
            const closestNotice = el.closest(noticeSelector);
            if (closestNotice) explicitNotices.push(closestNotice);
            if (el.matches && el.matches(noticeSelector)) explicitNotices.push(el);
            if (el.querySelectorAll) {
              explicitNotices.push(...el.querySelectorAll(noticeSelector));
            }
            const candidates = explicitNotices.length > 0
              ? [...new Set(explicitNotices)]
              : [el];

            for (const candidate of candidates) {
              const text = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
              const isExplicitNotice =
                explicitNotices.includes(candidate) ||
                (candidate === el && text.length > 0 && text.length <= 300);
              const verdict = M.classifyPresetApplyNotice(
                text,
                name,
                isExplicitNotice
              );
              if (verdict === 'failure') {
                confirmationFailureText = text;
                break;
              }
              if (verdict === 'success') {
                confirmationSuccessText = text;
              }
            }
            if (confirmationFailureText) break;
          }
          if (confirmationFailureText) break;
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      let confirmedEquipment = null;
      try {
        M.throwIfStopped();
        clickTarget.click();
        // 너무 빠른 프리셋 연속 전환을 막고 실제 장비 반영을 기다린다.
        await M.humanPause(900, 1400);
        let stableMatchCount = 0;
        const result = await M.waitFor(
          () => {
            if (confirmationFailureText) return { failed: true };
            const actualEquipment = M.readLiveBossEquipmentFingerprint();
            if (
              M.bossEquipmentFingerprintMatches(expectedEquipment, actualEquipment) &&
              (!requiresFreshSuccessNotice || confirmationSuccessText)
            ) {
              stableMatchCount++;
              // 한 번 읽힌 값만 믿지 않는다. React 재렌더를 가로질러 같은
              // 장비가 연속 3회 확인되어야 다음 공격 단계로 넘어간다.
              return stableMatchCount >= 3
                ? { failed: false, actualEquipment }
                : null;
            }
            stableMatchCount = 0;
            return null;
          },
          8000,
          200
        );
        confirmed = !!result && !result.failed;
        confirmedEquipment = confirmed ? result.actualEquipment : null;
      } finally {
        observer.disconnect();
      }
      await M.closeBossPresetPanelAndWait();
      if (confirmationFailureText) {
        throw new Error(
          `프리셋 "${name}" 적용을 게임이 거부했습니다: ${confirmationFailureText}`
        );
      }
      if (confirmed && M.uiLog) {
        M.uiLog(
          `✓ 프리셋 "${name}" 장비 적용 확인: ` +
          M.formatBossEquipmentFingerprint(confirmedEquipment)
        );
      }
      if (!confirmed && attempt < attempts) {
        const actualEquipment = M.readLiveBossEquipmentFingerprint();
        if (M.uiLog) {
          M.uiLog(
            `↻ 프리셋 "${name}" 장비 확인 실패 (${attempt}/${attempts}) ` +
            `(기대: ${M.formatBossEquipmentFingerprint(expectedEquipment)}, ` +
            `현재: ${M.formatBossEquipmentFingerprint(actualEquipment)}) - 다시 적용`
          );
        }
        await M.humanPause(500, 900);
      }
    }
    if (!confirmed && requireConfirmation) {
      throw new Error(`프리셋 "${name}" 장비 적용을 ${attempts}회 시도했지만 확인하지 못함`);
    }
    if (confirmed) M.currentBossPreset = name;
    if (M.uiLog && !confirmed) M.uiLog(`(참고) 프리셋 "${name}" 장비 적용을 확인하지 못해 공격하지 않습니다.`);
    return confirmed;
  };

  // --- 턴 진행 / 회복 / 스크롤 --------------------------------------------------
  M.waitForBattleTurnAdvance = async (beforeTurn, actionLabel) => {
    if (!beforeTurn) {
      throw new Error(`${actionLabel} 전 현재 전투 턴을 읽지 못해 클릭을 중단합니다.`);
    }
    const advanced = await M.waitFor(() => {
      const shown = M.readDisplayedBattleTurn();
      if (shown && shown.current > beforeTurn.current) return shown;
      if (typeof M.findBossClearPopup === 'function' && M.findBossClearPopup()) {
        return { cleared: true };
      }
      return null;
    }, 10000, 150);
    if (!advanced) {
      throw new Error(
        `${actionLabel} 클릭 후 턴 증가를 확인하지 못했습니다. ` +
        `클릭 누락 가능성이 있어 중복 공격 없이 중단합니다.`
      );
    }
    // ⚠ 사용자 피드백(실전): 보스전 진행이 너무 빨라 로그를 눈으로 따라가기
    // 어렵다는 요청. 턴 증가가 확인된 직후 짧게 쉬어 다음 조작으로 넘어가는
    // 속도를 늦춘다.
    await M.humanPause(1000, 1800);
    return advanced;
  };
  M.clickTurn = async (n) => {
    M.throwIfStopped();
    if (!M.currentBossPreset) {
      throw new Error('적용이 확인된 보스 프리셋이 없어 공격을 차단합니다.');
    }
    const beforeTurn = M.readDisplayedBattleTurn();
    if (!beforeTurn) throw new Error('공격 전 현재 전투 턴을 읽지 못함');
    const btn = await M.waitFor(() => M.findButtonByText(`턴 진행${n}턴`));
    if (!btn) throw new Error('턴 진행 버튼 못찾음: ' + n);
    M.throwIfStopped();
    btn.click();
    const startBtn = await M.waitFor(() => M.findConfirmInOpenDialog(['전투 시작']));
    if (!startBtn) throw new Error('전투 시작 확인 버튼(모달 내) 못찾음');
    // 클릭 직전 재검색: 모달이 그 사이 다시 그려졌을 수 있음
    await M.sleep(M.rand(100, 300));
    M.throwIfStopped();
    const freshStart = M.findConfirmInOpenDialog(['전투 시작']) || startBtn;
    freshStart.click();
    return await M.waitForBattleTurnAdvance(beforeTurn, `${n}턴 공격`);
  };

  M.clickRecover = async () => {
    M.throwIfStopped();
    const beforeTurn = M.readDisplayedBattleTurn();
    if (!beforeTurn) throw new Error('회복 전 현재 전투 턴을 읽지 못함');
    const btn = await M.waitFor(() => M.findButtonByText('회복2턴'));
    if (!btn) throw new Error('회복 버튼 못찾음');
    M.throwIfStopped();
    btn.click();
    const startBtn = await M.waitFor(() => M.findConfirmInOpenDialog(['회복', '전투 시작', '회복 시작']));
    if (!startBtn) throw new Error('회복 확인 버튼(모달 내) 못찾음');
    await M.sleep(M.rand(100, 300));
    M.throwIfStopped();
    const freshStart = M.findConfirmInOpenDialog(['회복', '전투 시작', '회복 시작']) || startBtn;
    freshStart.click();
    return await M.waitForBattleTurnAdvance(beforeTurn, '회복');
  };

  M.readDisplayedBattleTurn = () => {
    const matches = M.queryAll('*')
      .filter(
        (el) =>
          el.children.length === 0 &&
          M.isVisible(el) &&
          /^\d+\s*\/\s*\d+\s*턴$/.test(el.textContent.trim())
      )
      .map((el) => el.textContent.trim().match(/^(\d+)\s*\/\s*(\d+)\s*턴$/))
      .filter(Boolean)
      .map((match) => ({
        current: parseInt(match[1], 10),
        max: parseInt(match[2], 10),
      }));
    if (matches.length !== 1) return null;
    return matches[0];
  };

  // 화면의 실제 턴을 우선하고, 렌더링이 늦을 때만 로컬 누적값을 사용한다.
  // 회복 1회(2턴)도 같은 예산에 포함하므로 망령 자세 루프가 표시상 n턴보다
  // 훨씬 많은 실제 턴을 쓰는 문제를 막는다.
  M.createBattleTurnBudget = (fallbackMax = 150) => {
    const initial = M.readDisplayedBattleTurn();
    let used = initial ? initial.current : 0;
    let max = initial ? initial.max : fallbackMax;
    return {
      async spend(turns, action) {
        const shown = M.readDisplayedBattleTurn();
        if (shown) {
          used = Math.max(used, shown.current);
          max = shown.max || max;
        }
        if (used + turns > max) return false;
        await action();
        used += turns;
        return true;
      },
      current() {
        const shown = M.readDisplayedBattleTurn();
        if (shown) {
          used = Math.max(used, shown.current);
          max = shown.max || max;
        }
        return { used, max };
      },
    };
  };

  M.readBattleScrollUsage = () => {
    const button = M.queryAll('button').find(
      (el) => M.isVisible(el) && el.textContent.trim().startsWith('전투 스크롤 사용')
    );
    if (!button) return null;
    const match = button.textContent.match(/\((\d+)\s*\/\s*(\d+)\)/);
    return match
      ? {
          used: parseInt(match[1], 10),
          max: parseInt(match[2], 10),
        }
      : null;
  };
  M.getEffectiveBattleScrollLimit = (configuredLimit = 15) => {
    const displayed = M.readBattleScrollUsage();
    return displayed ? Math.min(configuredLimit, displayed.max) : configuredLimit;
  };
  M.canUseMoreBattleScrolls = (used, configuredLimit = 15) =>
    used < M.getEffectiveBattleScrollLimit(configuredLimit);
  M.useScrolls = async (names) => {
    M.throwIfStopped();
    const beforeUsage = M.readBattleScrollUsage();
    if (!beforeUsage) throw new Error('전투 스크롤 사용 전 현재 사용 수를 읽지 못함');
    if (beforeUsage.used >= beforeUsage.max) {
      throw new Error(
        `전투 스크롤 사용 한도 ${beforeUsage.max}/${beforeUsage.max}에 도달했습니다.`
      );
    }
    const openBtn = await M.waitFor(() => M.queryAll('button').find(
      (b) => M.isVisible(b) && b.textContent.trim().startsWith('전투 스크롤 사용')
    ));
    if (!openBtn) throw new Error('전투 스크롤 사용 버튼 못찾음');
    M.throwIfStopped();
    openBtn.click();
    await M.waitFor(() => M.findLeafByExactText(`스크롤:${names[0]}`), 5000);
    // 이미 "활성" 상태로 지속 중인 스크롤을 다시 클릭하면 오히려 꺼버리게
    // 되는 문제가 실전에서 확인됨. 그래서 이미 활성인 항목은 건드리지 않고
    // 새로 켜야 하는 것만 클릭한다.
    let newlySelected = 0;
    for (const name of names) {
      M.throwIfStopped();
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
      const closed = await M.waitFor(
        () => !M.findLeafByExactText(`스크롤:${names[0]}`) ? true : null,
        5000,
        150
      );
      if (!closed) throw new Error('활성 스크롤 확인창을 닫지 못함');
      return { ...beforeUsage, newlySelected: 0 };
    }
    const confirmPattern = /^\d+개 스크롤 사용$/;
    const confirmBtn = await M.waitFor(() => M.findConfirmByPatternInOpenDialog(confirmPattern));
    if (!confirmBtn) throw new Error('스크롤 확정 버튼(모달 내) 못찾음');
    await M.sleep(M.rand(100, 300));
    M.throwIfStopped();
    const freshConfirm = M.findConfirmByPatternInOpenDialog(confirmPattern) || confirmBtn;
    freshConfirm.click();
    const applied = await M.waitFor(() => {
      if (M.findConfirmByPatternInOpenDialog(confirmPattern)) return null;
      const after = M.readBattleScrollUsage();
      if (!after) return null;
      return after.used >= beforeUsage.used + newlySelected ? after : null;
    }, 8000, 150);
    if (!applied) {
      throw new Error(
        `스크롤 ${newlySelected}개 사용 후 사용 수 증가를 확인하지 못했습니다. ` +
        '중복 사용 없이 중단합니다.'
      );
    }
    return { ...applied, newlySelected };
  };

  // 전투별 스크롤 한도는 화면의 "전투 스크롤 사용 (사용/최대)" 값을
  // 기준으로 한다. 수호자 화면이 7/7인데 로컬 상수 15만 믿으면 보스가
  // 살아 있을 때 존재하지 않는 8번째 사용을 시도한다. 직업별 배치 상한과
  // 화면 한도 중 작은 값을 사용하고, 재개 시 화면 사용량도 함께 반영한다.
  M.useScrollsWithinLimit = async (names, used, limit = 15) => {
    const displayed = M.readBattleScrollUsage();
    const effectiveLimit = displayed
      ? Math.min(limit, displayed.max)
      : limit;
    const effectiveUsed = displayed
      ? Math.max(used, displayed.used)
      : used;
    const remaining = Math.max(0, effectiveLimit - effectiveUsed);
    if (remaining === 0) return effectiveUsed;
    const batch = names.slice(0, remaining);
    if (batch.length === 0) return effectiveUsed;
    const result = await M.useScrolls(batch);
    const consumed = result && Number.isInteger(result.newlySelected)
      ? result.newlySelected
      : batch.length;
    return effectiveUsed + consumed;
  };

  // --- 상태 읽기 (HP/MP, 봉인된 어빌리티) --------------------------------------
  M.getHpMpNumbers = () => {
    const hpLabels = M.queryAll('*').filter(
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim() === 'HP' &&
        M.isVisible(el)
    );
    const mpLabels = M.queryAll('*').filter(
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim() === 'MP' &&
        M.isVisible(el)
    );
    // React가 다시 그리는 찰나에 라벨이 아직 없거나 숫자 파싱이 실패하는
    // 경우가 있음(실전에서 확인 가능성 지적됨). 예외를 던지는 대신 null을
    // 반환해서, 호출부가 M.waitForValidState 같은 걸로 정상값이 나올 때까지
    // 기다릴 수 있게 한다. NaN이 섞이면 "보스가 죽었다"고 오판할 수 있어
    // 반드시 걸러야 함.
    // ⚠ 실전 확인: HP/MP 라벨과 값 사이에 장식용 요소(aria-hidden '#')가
    // 끼어들어 있으면 접두사만 잘라내는 방식은 숫자 앞에 '#'가 남아
    // parseInt가 NaN을 내버린다(실전 확인됨). 주변 장식이 무엇이든 상관없이
    // 숫자/숫자 패턴만 직접 정규식으로 추출한다.
    const parse = (el) => {
      if (!el || !el.parentElement) return null;
      const raw = el.parentElement.textContent;
      const m = raw.match(/([\d,]+)\s*\/\s*([\d,]+)/);
      if (!m) return null;
      const cur = parseInt(m[1].replace(/,/g, ''), 10);
      const max = parseInt(m[2].replace(/,/g, ''), 10);
      if (Number.isNaN(cur) || Number.isNaN(max)) return null;
      return { cur, max };
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
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim().startsWith('전투 기록 (') &&
        M.isVisible(el)
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

  // HP/MP DOM이 전투 종료 순간 다시 그려지면 마지막 공격은 성공했어도
  // 상태 파서가 null을 반환할 수 있다. 실제 클리어 팝업을 독립적인 성공
  // 신호로 읽어, 이를 공략 실패/재도전으로 잘못 집계하지 않는다.
  M.findBossClearPopup = (bossLabel = '') => {
    const markers = M.queryAll('*').filter((el) => {
      if (!M.isVisible(el) || el.children.length !== 0) return false;
      const text = el.textContent.trim();
      return /^보스 클리어!?$/.test(text) ||
        (text.includes('처치했습니다') && (!bossLabel || text.includes(bossLabel)));
    });
    for (const marker of markers) {
      let node = marker;
      for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        const text = node.textContent || '';
        if (
          text.includes('보스 클리어') &&
          text.includes('처치했습니다') &&
          (!bossLabel || text.includes(bossLabel))
        ) {
          return node;
        }
      }
    }
    return null;
  };

  M.consumeBossClearPopup = async (bossLabel = '') => {
    const popup = M.findBossClearPopup(bossLabel);
    if (!popup) return false;
    const confirm = [...popup.querySelectorAll('button')]
      .find((btn) => M.isVisible(btn) && btn.textContent.trim() === '확인');
    if (confirm) {
      await M.sleep(350);
      confirm.click();
    }
    return true;
  };

  // 모든 직업/보스 함수의 최종 안전망. 마지막 공격 직후에는 React가
  // HP=0과 클리어 모달을 서로 다른 프레임에 반영할 수 있으므로 잠깐
  // 재확인한다. 팝업 또는 실제 보스 HP 0 중 하나가 확인될 때만 성공이다.
  M.waitForBossClearEvidence = async (bossLabel = '', timeoutMs = 3000) => {
    const evidence = await M.waitFor(() => {
      const popup = M.findBossClearPopup(bossLabel);
      if (popup) return { type: 'popup', popup };
      const state = M.getHpMpNumbers();
      if (state && state.boss && state.boss.hp.cur <= 0) return { type: 'hp-zero' };
      return null;
    }, timeoutMs, 150);
    if (!evidence) return false;
    if (evidence.type === 'popup') await M.consumeBossClearPopup(bossLabel);
    return true;
  };

  // 클리어 팝업의 "확인" 버튼을 닫아준다 (모달 스코프)
  M.closeClearPopupIfAny = async () => {
    await M.sleep(500);
    const btn = M.findConfirmInOpenDialog(['확인']);
    if (btn) btn.click();
  };

  // ⚠ 타락한 정화자 전용(2026-08, 사용자 확인): 수/금은 정화자를 아예 잡을
  // 수 없는 요일이다. KST(UTC+9) 기준 요일(0=일 ~ 6=토)을 반환한다.
  M.getKstDayOfWeek = () => {
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    return kst.getUTCDay();
  };

  // ⚠ 타락한 정화자 전용(2026-08, 실전 확인): 캐릭터 카드에 표시되는
  // "물리 방어력" 숫자는 전투 내내 고정값이라(새로고침해도 안 바뀜) 신뢰할
  // 수 없다. 대신 전투 기록 로그의 "보스: 방↓N"이 매 턴 오르내리는 실시간
  // 지표임을 실전으로 확인함(예: 40→80→...→400→...→누적 아님, 상태이상
  // 지속시간에 따라 감소했다가 다시 상승하는 패턴). 로그는 최신순으로
  // 나열되므로 맨 위(가장 최근) 항목의 방↓ 값만 읽는다.
  M.getLatestBossDefenseDrop = () => {
    const logContainer = M.getLogContainer();
    if (!logContainer) return null;
    const match = logContainer.textContent.match(/방↓(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  };

  // ⚠ 허무의 황제 전용(2026-08): 페이지 텍스트(매크로 패널 제외)를 읽는
  // 범용 헬퍼. Core.bodyText()에 해당하는 게 M 스코프엔 없어서 새로 만듦.
  M.pageText = () => M.queryAll('*').filter((el) => el.children.length === 0).map((el) => el.textContent.trim()).join(' ');

  // ⚠ 허무의 황제 전용(2026-08, 실전 확인): 전투 기록은 최신순으로 나열되지만
  // "공속↓" 같은 상태이상은 매 턴 나타나는 게 아니라서(실전 확인: 특정 턴엔
  // 없다가 다음 턴엔 다시 나타남), 로그 컨테이너 전체 텍스트에서 그냥
  // 첫 매치를 찾으면 오래된 항목의 값을 잘못 집을 수 있다. "턴 N~M" 헤더
  // 사이 구간만 정확히 잘라 최신 항목 하나만 검사해야 한다.
  M.getLatestLogEntryText = () => {
    const logContainer = M.getLogContainer();
    if (!logContainer) return null;
    const text = logContainer.textContent;
    const turnHeaders = [...text.matchAll(/턴\s*\d+~\d+/g)];
    if (turnHeaders.length === 0) return null;
    const start = turnHeaders[0].index;
    const end = turnHeaders.length > 1 ? turnHeaders[1].index : text.length;
    return text.slice(start, end);
  };

  // ⚠ 허무의 황제 전용(2026-08, 사용자 확인): "공속"은 공격속도. 이 디버프는
  // 정신일도 단계 전용이 아니라 전투 내내 걸려있는 상태로, 사용자 확인
  // 스크린샷에서 봉인 단계(턴 1~5, 6~10) 로그에도 "나: 공속↓"가 나타났다.
  // 시간이 지날수록(턴이 지날수록) 수치가 자연 감소하다가(예: 275→150→125→
  // 50→25→...) 결국 로그에 아예 안 찍히는 시점이 오는데, 그때가 디버프가
  // 완전히 사라진 시점이다(실전 확인: "턴 43~47"에서 처음으로 공속↓가
  // 로그에서 없어짐). 그래서 "최신 전투 로그 항목에 공속↓가 있는지"만
  // 확인하면 정확히 판정된다 - 정신일도 딜 단계에서 이 함수를 호출해
  // 디버프가 로그에서 사라질 때까지 1턴씩 추가 공격한다.
  M.isMyAttackSpeedDebuffActive = () => {
    const latest = M.getLatestLogEntryText();
    return !!(latest && latest.includes('공속↓'));
  };

  // ⚠ 허무의 황제 전용(2026-08): 캐릭터 카드가 접혀있으면 "물리 공격력"
  // 등 상세 스탯 텍스트 자체가 DOM에 없다(펼쳐야 렌더링됨). 첫 번째 "HP"
  // 리프가 내 캐릭터 카드에 속한다(항상 플레이어 카드가 보스 카드보다
  // 먼저 렌더링됨 - M.getHpMpNumbers도 같은 전제로 작동). 그 조상에서
  // 가장 가까운 버튼(펼치기 화살표)을 찾아 누른다.
  M.ensureCharacterCardExpanded = async () => {
    if (M.pageText().includes('물리 공격력:')) return true;
    const hpLabels = M.queryAll('*').filter((el) => el.children.length === 0 && el.textContent.trim() === 'HP');
    if (hpLabels.length === 0) return false;
    let container = hpLabels[0].parentElement;
    for (let i = 0; i < 10 && container; i++) {
      const btn = container.querySelector('button');
      if (btn) {
        btn.click();
        await M.sleep(600);
        break;
      }
      container = container.parentElement;
    }
    return M.pageText().includes('물리 공격력:');
  };

  M.getMyPhysicalAttack = () => {
    const match = M.pageText().match(/물리\s*공격력:\s*(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  };

  // ⚠ 타락한 정화자 전용(2026-08, 실전 확인): 목표 어빌리티가 정해진 턴
  // 내에 봉인되지 않으면 "도전 포기" 후 재도전한다. 실전에서 "도전
  // 포기" → 확인창 "포기" → 목록(/personal-boss) 복귀 → 대상 보스
  // 재도전 전체 흐름을 검증함.
  M.abandonCurrentChallenge = async () => {
    const abandonBtn = M.findButtonByText('도전 포기');
    if (!abandonBtn) throw new Error('"도전 포기" 버튼을 찾지 못했습니다.');
    abandonBtn.click();
    await M.sleep(M.rand(500, 900));
    const confirmBtn = await M.waitFor(() => M.findConfirmInOpenDialog(['포기']), 5000);
    if (!confirmBtn) throw new Error('"도전 포기" 확인 버튼을 찾지 못했습니다.');
    confirmBtn.click();
    const returned = await M.waitFor(
      () => location.pathname.replace(/\/$/, '') === '/personal-boss',
      8000,
      200
    );
    if (!returned) throw new Error('도전 포기 후 목록 복귀를 확인하지 못했습니다.');
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
      if (el.children.length === 0 && M.isVisible(el)) {
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
      if (el.children.length === 0 && M.isVisible(el)) {
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
    M.throwIfStopped();
    const element = M.getBossElementInBattle(bossLabel);
    if (!element) return { changed: false, reason: '보스 속성 확인 실패' };
    const targetSkill = M.ELEMENT_TO_SKILL[element];
    if (!targetSkill) return { changed: false, reason: `속성-스킬 매핑 없음: ${element}` };

    // history.back() 후 실제로 전투화면에 정상 복귀했는지 확인 없이 바로
    // 다음 동작으로 넘어가면, 뒤로가기가 실패하거나 엉뚱한 화면으로 가도
    // 모른 채 진행하게 됨(실전 검증 전 반드시 고칠 항목으로 지적됨).
    const goBackAndConfirmBattle = async () => {
      M.throwIfStopped();
      history.back();
      const ok = await M.waitFor(() => M.isInBattleScreen(bossLabel), 6000, 200);
      if (!ok) throw new Error('스킬관리 화면에서 전투화면으로 복귀 확인 실패');
    };

    const charBtn = M.findButtonByText('캐릭');
    if (!charBtn) return { changed: false, reason: '"캐릭" 메뉴 못찾음' };
    M.throwIfStopped();
    charBtn.click();
    // 드롭다운 메뉴 항목은 <button>이 아니라 <li role="menuitem">로 렌더링됨
    // (실전 테스트에서 확인). 태그 제한 없이 텍스트로 찾는다.
    const skillItem = await M.waitFor(() => M.queryAll('*').find((el) => el.children.length === 0 && el.textContent.trim() === '스킬'));
    if (!skillItem) return { changed: false, reason: '"스킬" 메뉴 못찾음' };
    M.throwIfStopped();
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

    M.throwIfStopped();
    input.click();
    // "사용 가능한 스킬" 목록의 스킬명도 <button>이 아니라 <p> 텍스트라서
    // (실전 테스트에서 확인) 태그 제한 없이 텍스트로 찾아 클릭한다.
    const skillBtn = await M.waitFor(() => M.queryAll('*').find((el) => el.children.length === 0 && el.textContent.trim() === targetSkill));
    if (!skillBtn) {
      await goBackAndConfirmBattle();
      return { changed: false, reason: `스킬 목록에서 "${targetSkill}" 못찾음` };
    }
    M.throwIfStopped();
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
    corruptedPurifier: { label: '타락한 정화자', hard: true },
    voidEmperorEmpty: { label: '허무의 황제', hard: true },
  };
  // ⚠ 버그 수정(2026-08, 실전 확인): "이번 주 보상 보스" 선택(최대 3마리)은
  // 게임 자체의 별도 설정으로, 매크로가 보스를 처치해도 이 선택에 없으면
  // 카드에 "이번 주 보상 대상으로 선택되지 않았습니다"가 뜨며 보상이
  // 전혀 지급되지 않는다. weeklyTierLimits(진행률)와는 완전히 별개 데이터라
  // 기존 코드는 이 선택 자체를 전혀 건드리지 않고 있었다. API의 보스 id는
  // 우리 BOSS_REGISTRY 키와 이름이 달라(영문 snake_case) 매핑이 필요하다.
  const BOSS_API_ID_MAP = {
    fallenGuardian: 'corrupted_guardian',
    voidEmperor: 'void_emperor',
    vineEnt: 'underground_ent',
    vineWraith: 'lord_of_duality',
    corruptedPurifier: 'corrupted_guardian_hard',
    voidEmperorEmpty: 'void_emperor_hard',
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
      corruptedPurifier: 'runCorruptedPurifierSword',
      voidEmperorEmpty: 'runVoidEmperorHardSword',
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
  const BOSS_JOB_BY_CLASS_NAME = Object.freeze({
    검제: '검술',
    천무: '체술',
    신궁: '궁술',
    대마법사: '마술',
    암영: '인술',
  });
  const SUPPORTED_BOSS_JOBS = Object.freeze(Object.keys(BOSS_RUN_BY_JOB));

  M.getCharacterBossJobOnStatus = () => {
    const matches = M.queryAll('*')
      .filter((el) =>
        el.children.length === 0 &&
        M.isVisible(el) &&
        Object.prototype.hasOwnProperty.call(BOSS_JOB_BY_CLASS_NAME, el.textContent.trim())
      )
      .map((el) => el.textContent.trim());
    const unique = [...new Set(matches)];
    if (unique.length !== 1) return null;
    return {
      className: unique[0],
      job: BOSS_JOB_BY_CLASS_NAME[unique[0]],
    };
  };

  M.detectBossJob = async () => {
    M.throwIfStopped();
    await M.openCharacterMenuItem('내 정보');
    const detected = await M.waitFor(() => M.getCharacterBossJobOnStatus(), 8000, 200);
    if (!detected || !SUPPORTED_BOSS_JOBS.includes(detected.job)) {
      throw new Error(
        '내 정보에서 지원 직업(검제·천무·신궁·대마법사·암영)을 정확히 판별하지 못했습니다.'
      );
    }
    if (M.uiLog) M.uiLog(`직업 자동 감지: ${detected.className} → ${detected.job}`);
    const select = document.getElementById('lrm-boss-ref-job');
    if (select) select.value = detected.job;
    saveSelectedJob(detected.job);
    await M.goToBossListViaMenu();
    M.throwIfStopped();
    return detected;
  };

  M.getSelectedJob = () => {
    const sel = document.getElementById('lrm-boss-ref-job');
    const value = sel ? sel.value : loadSelectedJob();
    return SUPPORTED_BOSS_JOBS.includes(value) ? value : null;
  };
  M.getRunFunctionName = (key, jobOverride = null) => {
    const job = jobOverride || M.getSelectedJob();
    if (!job || !BOSS_RUN_BY_JOB[job]) {
      throw new Error(`지원하지 않거나 판별되지 않은 보스 직업입니다: ${job || '없음'}`);
    }
    const runName = BOSS_RUN_BY_JOB[job][key];
    if (!runName) throw new Error(`${job}의 "${key}" 보스 로직이 등록되지 않았습니다.`);
    return runName;
  };
  const PENDING_KEY = 'lrm-boss-ref-pending';
  const QUEUE_KEY = 'lrm-boss-ref-queue';
  const RUN_AUTH_KEY = 'lrm-boss-ref-explicit-run-auth';
  const RUN_AUTH_SCHEMA = 'boss-explicit-v2';
  // 사용자가 정지를 눌렀다는 사실을 새로고침 뒤에도 유지한다. 큐/pending만
  // 지우면 클릭 직전 저장된 페이지 상태나 다른 일일 실행 경로가 다시 큐를
  // 만들 수 있으므로, 명시적인 다음 시작 전까지 자동 재개를 금지한다.
  const STOP_LATCH_KEY = 'lrm-boss-ref-user-stopped';
  M.parseBossQueueState = (raw) => {
    try {
      const queue = JSON.parse(raw || 'null');
      if (
        !queue ||
        !Array.isArray(queue.remaining) ||
        queue.remaining.length > BOSS_ORDER.length ||
        new Set(queue.remaining).size !== queue.remaining.length ||
        typeof queue.authId !== 'string' ||
        queue.authId.trim() === '' ||
        queue.remaining.some((key) => !BOSS_REGISTRY[key])
      ) {
        throw new Error('필수 필드가 없거나 보스 키가 잘못됨');
      }
      if (
        queue.attempts !== undefined &&
        (!Number.isInteger(queue.attempts) || queue.attempts < 0 || queue.attempts > 3)
      ) {
        throw new Error('재시도 횟수가 잘못됨');
      }
      if (
        queue.entryFailStreak !== undefined &&
        (!Number.isInteger(queue.entryFailStreak) ||
          queue.entryFailStreak < 0 ||
          queue.entryFailStreak > 3)
      ) {
        throw new Error('진입 실패 횟수가 잘못됨');
      }
      if (
        queue.failedLabels !== undefined &&
        (!Array.isArray(queue.failedLabels) ||
          queue.failedLabels.some((label) => typeof label !== 'string'))
      ) {
        throw new Error('실패 목록이 잘못됨');
      }
      if (!Array.isArray(queue.failedLabels)) queue.failedLabels = [];
      return queue;
    } catch (error) {
      localStorage.removeItem(QUEUE_KEY);
      throw new Error(
        `저장된 보스 큐가 손상되어 안전하게 폐기했습니다: ${error.message}`
      );
    }
  };

  M.clearBossRunState = () => {
    M.stopRequested = true;
    localStorage.setItem(STOP_LATCH_KEY, String(Date.now()));
    localStorage.removeItem(PENDING_KEY);
    localStorage.removeItem(QUEUE_KEY);
    sessionStorage.removeItem(RUN_AUTH_KEY);
  };

  M.requestImmediateStop = () => {
    M.clearBossRunState();
    M.antiThrottle.stop();
    const cancel = M.findConfirmInOpenDialog(['취소', '닫기']);
    if (cancel) cancel.click();
    M.closePresetPanel();
    if (M.uiLog) {
      M.uiLog('■ 즉시 정지됨 (실행 대기·보스 큐·자동 재개 상태 모두 폐기)');
    }
  };

  // alert()는 브라우저의 JavaScript와 페이지 입력을 모두 정지시켜 사용자가
  // 정지 버튼을 누를 수 없게 한다. 보스 실행 중 알림은 비차단 배너로 표시한다.
  M.showBossNotice = (message, isError = true) => {
    let notice = document.getElementById('lrm-boss-nonblocking-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'lrm-boss-nonblocking-notice';
      notice.style.cssText =
        'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647;' +
        'max-width:620px;padding:12px 42px 12px 14px;border-radius:8px;color:#fff;' +
        'font-size:13px;white-space:pre-wrap;box-shadow:0 4px 18px #000;background:#7f1d1d;';
      const close = document.createElement('button');
      close.textContent = '×';
      close.style.cssText =
        'position:absolute;right:10px;top:5px;border:0;background:transparent;color:#fff;' +
        'font-size:24px;cursor:pointer;';
      close.addEventListener('click', () => notice.remove());
      notice.appendChild(close);
      document.body.appendChild(notice);
    }
    notice.style.background = isError ? '#7f1d1d' : '#166534';
    let text = notice.querySelector('[data-message]');
    if (!text) {
      text = document.createElement('span');
      text.dataset.message = '1';
      notice.appendChild(text);
    }
    text.textContent = message;
    if (M.uiLog) M.uiLog(message);
  };

  M.armBossRun = () => {
    localStorage.removeItem(STOP_LATCH_KEY);
    const auth = {
      schema: RUN_AUTH_SCHEMA,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      issuedAt: Date.now(),
      tabPath: location.pathname,
    };
    sessionStorage.setItem(RUN_AUTH_KEY, JSON.stringify(auth));
    M.stopRequested = false;
    return auth;
  };

  M.getBossRunAuth = () => {
    try {
      return JSON.parse(sessionStorage.getItem(RUN_AUTH_KEY) || 'null');
    } catch (e) {
      return null;
    }
  };

  M.isBossRunAuthorized = (expectedId = null) => {
    if (M.stopRequested || localStorage.getItem(STOP_LATCH_KEY)) return false;
    const auth = M.getBossRunAuth();
    if (!auth || auth.schema !== RUN_AUTH_SCHEMA || !auth.id) return false;
    return !expectedId || auth.id === expectedId;
  };

  M.assertBossRunAuthorized = (expectedId = null) => {
    if (M.isBossRunAuthorized(expectedId)) return;
    const error = new Error('사용자 실행 허가가 취소되어 보스 작업을 중단합니다.');
    error.isUserStop = true;
    throw error;
  };

  M.isInBattleScreen = (bossLabel) => {
    const heading = M.findLeafByExactText(bossLabel);
    const turnBtn = M.findButtonByText('턴 진행5턴');
    return !!(heading && turnBtn);
  };

  // 보스 카드의 속성/처치 상태/도전 버튼을 읽기 전에 해당 난이도 탭이
  // 실제로 선택되고 대상 카드가 렌더링됐는지 확인한다. HARD 보스는 기존에
  // 속성 확인을 먼저 수행해 일반 탭에서 카드를 찾지 못한 채 중단됐다.
  M.ensureBossDifficultyTab = async (bossLabel, { hard = false } = {}) => {
    M.throwIfStopped();
    const targetTabLabel = hard ? 'HARD' : '일반';
    const targetTab = await M.waitFor(
      () => M.queryAll('button').find(
        (button) =>
          M.isVisible(button) &&
          button.textContent.trim() === targetTabLabel
      ) || null,
      8000,
      200
    );
    if (!targetTab) {
      throw new Error(`보스 목록의 "${targetTabLabel}" 탭을 찾지 못했습니다.`);
    }

    const isSelected = () =>
      targetTab.getAttribute('aria-pressed') === 'true' ||
      targetTab.getAttribute('aria-selected') === 'true';
    if (!isSelected()) {
      M.throwIfStopped();
      targetTab.click();
    }

    const cardReady = await M.waitFor(
      () => M.findBossCardActionButton(bossLabel) || null,
      10000,
      200
    );
    if (!cardReady) {
      throw new Error(
        `"${targetTabLabel}" 탭 전환 후 "${bossLabel}" 카드 렌더링을 확인하지 못했습니다.`
      );
    }
    return cardReady;
  };

  // 개인 보스 목록 페이지 상단의 "이번 주 보상 보스" 배지에도 보스 이름이
  // 뜨기 때문에, 페이지에 같은 이름 텍스트가 2번 이상 나올 수 있다(배지 1번 +
  // 실제 카드 제목 1번). findLeafByExactText는 첫 번째 일치만 반환하므로
  // 이름이 겹치는 보스(예: 지하를 휘감은 엔트)에서는 배지를 잘못 집어
  // 엉뚱한 카드/버튼으로 이어지는 문제가 실전에서 확인됨. 그래서 아래는
  // 이름이 일치하는 모든 후보를 문서 순서대로 순회하며, 실제로 도전 버튼을
  // 찾을 수 있는 후보를 사용한다.
  M.findAllLeavesByExactText = (text) =>
    M.queryAll('*').filter(
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim() === text &&
        M.isVisible(el)
    );

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
        if (!M.isVisible(el)) continue;
        if (
          el.tagName === 'BUTTON' &&
          M.isVisible(el) &&
          ['도전하기', '계속하기', '재도전'].includes(el.textContent.trim())
        ) {
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
    // 보상 단계 목록에는 미완료 보스도 항상 마지막 단계 이름으로 "클리어"가
    // 표시된다. 이 텍스트만 검사하면 모든 보스를 완료로 오인한다. 실제 완료
    // 카드에서만 행동 버튼이 "재도전"으로 바뀌므로 그 상태를 기준으로 삼는다.
    const action = M.findBossCardActionButton(bossLabel);
    return !!action && action.textContent.trim() === '재도전';
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
        if (!M.isVisible(el) || el.children.length !== 0) continue;
        const text = el.textContent.trim();
        if (text !== bossLabel && BOSS_CARD_BOUNDARY_NAMES.includes(text)) break;
        if (elements.includes(text)) return text;
      }
    }
    return null;
  };

  M.openCharacterMenuItem = async (itemText) => {
    M.throwIfStopped();
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
      M.throwIfStopped();
      charBtn.click();
      await M.humanPause(650, 1100);
      item = await M.waitFor(findVisibleItem, 5000);
    }
    if (!item) throw new Error(`캐릭 메뉴에서 "${itemText}" 못찾음`);
    await M.humanPause(550, 1000);
    M.throwIfStopped();
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
      el.children.length === 0 &&
      M.isVisible(el) &&
      /^속성\s*:\s*(불|물|번개|별|바람|빛|어둠)$/.test(el.textContent.trim())
    );
    if (!leaf) return null;
    const match = leaf.textContent.trim().match(/^속성\s*:\s*(.+)$/);
    return match ? match[1].trim() : null;
  };

  M.goToBossListViaMenu = async () => {
    M.throwIfStopped();
    const battleBtn = await M.waitFor(() => M.findButtonByText('전투'), 5000);
    if (!battleBtn) throw new Error('"전투" 메뉴 버튼 못찾음');
    M.throwIfStopped();
    battleBtn.click();
    const bossItem = await M.waitFor(
      () => M.queryAll('*').find((el) => el.children.length === 0 && el.textContent.trim() === '보스'),
      5000
    );
    if (!bossItem) throw new Error('전투 메뉴에서 "보스" 못찾음');
    M.throwIfStopped();
    bossItem.click();
    const arrived = await M.waitFor(
      () => location.pathname.replace(/\/$/, '') === '/personal-boss',
      8000,
      200
    );
    if (!arrived) throw new Error('개인 보스 목록 복귀 실패');
  };

  // ⚠ 버그 수정(2026-08): 이 파일은 두 개의 독립된 IIFE로 구성되어 있고,
  // Core는 첫 번째 IIFE(자동사냥 등)의 지역 변수라서 두 번째 IIFE인 보스
  // 모듈(M)에서는 절대 접근할 수 없다(실전 확인: "Core is not defined"로
  // 매번 실패해 보스 전투 자체가 진행되지 않았음). Core.buyElementStoneAtTown
  // 등을 그대로 재사용하려 했던 이전 시도가 이 스코프 문제 때문에 실패했으므로,
  // 보스 모듈 자체에 동일한 로직을 독립적으로 구현한다.
  // ⚠ 버그 수정(2026-08): applyBossPreset이 내부에서 Core.classifyPresetApplyNotice를
  // 호출하고 있었는데, 이 역시 Core가 없는 스코프에서 실행되어 매번
  // ReferenceError로 실패하고 있었다(보스 전투 전 장비 프리셋 적용이 이
  // 함수에 의존하므로, 이게 "보스가 전혀 진행되지 않는" 증상의 실제 원인일
  // 가능성이 높다). 순수 함수라 로직을 그대로 복사해 온다.
  M.classifyPresetApplyNotice = function (text, presetName, isExplicitNotice = false) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    const hasPresetContext =
      normalized.includes(presetName) ||
      normalized.includes('프리셋') ||
      isExplicitNotice;
    if (!hasPresetContext) return null;
    if (
      /(?:실패|오류|적용하지\s*못|불러오지\s*못|적용할\s*수\s*없)/.test(normalized)
    ) return 'failure';
    if (
      /(?:적용했습니다|적용되었습니다|적용\s*완료|불러왔습니다|불러오기\s*완료)/.test(normalized)
    ) return 'success';
    return null;
  };

  M.ELEMENT_TO_TOWN = {
    불: '베곤',
    물: '피렌트',
    번개: '심포니아',
    바람: '카웬',
    별: '포트스미스',
    빛: '에렌시아',
    어둠: '데자브',
  };

  M.readCurrentTown = async () => {
    if (location.pathname.replace(/\/$/, '') !== '/town-move') {
      const townBtn = await M.waitFor(() => M.findButtonByText('마을'), 8000);
      if (!townBtn) throw new Error('"마을" 메뉴 버튼 못찾음');
      townBtn.click();
      await M.humanPause(500, 900);
      const moveItem = await M.waitFor(
        () => M.queryAll('[role="menuitem"]').find((el) => el.textContent.trim() === '마을 이동' && M.isVisible(el)),
        8000
      );
      if (!moveItem) throw new Error('"마을 이동" 메뉴 항목 못찾음');
      moveItem.click();
      const arrived = await M.waitFor(
        () => location.pathname.replace(/\/$/, '') === '/town-move',
        10000,
        250
      );
      if (!arrived) throw new Error('마을 이동 화면으로 진입하지 못했습니다.');
    }
    // 실전 확인: "현재 위치는 X (a, b) 입니다." 문구는 안내 문장과 한 <p>에
    // <br>로 붙어 있어 리프 노드 검색으로는 못 찾는다. includes로 후보를
    // 찾고 가장 작은(자식 적은) 요소의 textContent에서 정규식으로 추출한다.
    const match = await M.waitFor(() => {
      const candidates = M.queryAll('*').filter((e) => e.textContent.includes('현재 위치는'));
      if (!candidates.length) return null;
      const smallest = candidates.reduce(
        (best, el) => (!best || el.querySelectorAll('*').length < best.querySelectorAll('*').length ? el : best),
        null
      );
      return smallest.textContent.match(/현재 위치는\s*(\S+)\s*\(/);
    }, 8000, 250);
    if (!match) throw new Error('현재 위치 텍스트를 찾지 못했습니다.');
    return match[1];
  };

  M.clickTownOnMap = async (townName) => {
    const candidates = M.queryAll('*').filter((e) => e.textContent.trim() === townName);
    const labelEl = candidates.reduce(
      (best, el) => (!best || el.querySelectorAll('*').length < best.querySelectorAll('*').length ? el : best),
      null
    );
    if (!labelEl) throw new Error(`지도에서 마을 "${townName}"을 찾지 못했습니다.`);
    let clickTarget = labelEl;
    for (let i = 0; i < 2 && clickTarget.parentElement; i++) clickTarget = clickTarget.parentElement;
    await M.humanPause(400, 800);
    M.throwIfStopped();
    clickTarget.click();
    const moveBtn = await M.waitFor(() => M.findButtonByText('이 마을로 이동'), 6000);
    if (!moveBtn) throw new Error(`"${townName}" 상세 패널에서 "이 마을로 이동" 버튼을 찾지 못했습니다.`);
    await M.humanPause(500, 1000);
    M.throwIfStopped();
    moveBtn.click();
    const arrived = await M.waitFor(
      () => location.pathname.replace(/\/$/, '') === '/game',
      10000,
      250
    );
    if (!arrived) throw new Error(`"${townName}"(으)로 이동 후 도착 확인 실패`);
    await M.humanPause(500, 1000);
  };

  M.ensureCurrentTownForElement = async (targetElement) => {
    const requiredTown = M.ELEMENT_TO_TOWN[targetElement];
    if (!requiredTown) throw new Error(`속성 "${targetElement}"에 대응하는 마을 정보가 없습니다.`);
    const current = await M.readCurrentTown();
    if (current === requiredTown) {
      if (M.uiLog) M.uiLog(`마을 위치 확인 완료: ${current} (이동 불필요)`);
      return true;
    }
    if (M.uiLog) M.uiLog(`마을 위치 불일치: 현재 ${current} / 필요 ${requiredTown}(${targetElement} 속성) → 이동`);
    await M.clickTownOnMap(requiredTown);
    const verify = await M.readCurrentTown();
    if (verify !== requiredTown) {
      throw new Error(`마을 이동 검증 실패: 현재 ${verify} / 목표 ${requiredTown}`);
    }
    if (M.uiLog) M.uiLog(`마을 이동 완료: ${requiredTown}`);
    return true;
  };

  M.buyElementStoneAtTown = async (targetElement) => {
    const stoneName = `${targetElement}의 돌`;
    await M.ensureCurrentTownForElement(targetElement);

    const townBtn = await M.waitFor(() => M.findButtonByText('마을'), 8000);
    if (!townBtn) throw new Error('"마을" 메뉴 버튼 못찾음');
    townBtn.click();
    await M.humanPause(500, 900);
    const shopItem = await M.waitFor(
      () => M.queryAll('[role="menuitem"]').find((el) => el.textContent.trim() === '아이템 상점' && M.isVisible(el)),
      8000
    );
    if (!shopItem) throw new Error('"아이템 상점" 메뉴 항목 못찾음');
    shopItem.click();
    const arrivedShop = await M.waitFor(
      () => location.pathname.replace(/\/$/, '') === '/shop',
      10000,
      250
    );
    if (!arrivedShop) throw new Error('아이템 상점으로 진입하지 못했습니다.');

    const otherTab = await M.waitFor(() => M.findButtonByText('기타'), 8000);
    if (!otherTab) throw new Error('아이템 상점 "기타" 탭을 찾지 못했습니다.');
    await M.humanPause(500, 900);
    M.throwIfStopped();
    otherTab.click();

    const row = await M.waitFor(
      () => M.queryAll('tr').find(
        (tr) =>
          tr.textContent.includes(stoneName) &&
          [...tr.querySelectorAll('button')].some((b) => b.textContent.trim() === '구매') &&
          M.isVisible(tr)
      ) || null,
      8000,
      250
    );
    if (!row) throw new Error(`상점 "기타" 탭에서 "${stoneName}"을 찾지 못했습니다.`);
    const buyBtn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '구매');
    await M.humanPause(500, 900);
    M.throwIfStopped();
    buyBtn.click();

    const confirmBtn = await M.waitFor(() => M.findConfirmInOpenDialog(['구매']), 6000);
    if (!confirmBtn) throw new Error(`"${stoneName}" 구매 확인창을 찾지 못했습니다.`);
    await M.humanPause(600, 1100);
    M.throwIfStopped();
    confirmBtn.click();
    await M.humanPause(1000, 1600);
    if (M.uiLog) M.uiLog(`${stoneName} 상점에서 구매 완료 (${M.ELEMENT_TO_TOWN[targetElement]})`);
  };

  M.useElementStone = async (element) => {
    M.throwIfStopped();
    const stoneName = `${element}의 돌`;

    // 인벤토리 소모품 탭에서 "{돌}의 돌" 행을 찾아 사용 버튼을 반환한다.
    // 못 찾으면 null. 페이지네이션까지 뒤진다.
    const findUseButtonInInventory = async () => {
      await M.openCharacterMenuItem('인벤토리');
      const consumableTab = await M.waitFor(
        () => M.queryAll('[role="tab"], button')
          .find((el) => el.textContent.trim() === '소모품' && M.isVisible(el)),
        8000
      );
      if (!consumableTab) throw new Error('인벤토리 소모품 탭 못찾음');
      await M.humanPause(600, 1100);
      M.throwIfStopped();
      consumableTab.click();
      await M.humanPause(750, 1300);

      let useButton = null;
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
        M.throwIfStopped();
        next.click();
        await M.humanPause(650, 1100);
      }
      return useButton;
    };

    let useButton = await findUseButtonInInventory();

    // ⚠ 사용자 확인(2026-08): 인벤토리에 없으면 그냥 멈추던 것을, 위에서 보스
    // 모듈 자체에 새로 구현한 마을 이동+상점 구매 로직으로 사 온 뒤 다시
    // 찾도록 확장한다.
    if (!useButton) {
      if (M.uiLog) M.uiLog(`인벤토리에 "${stoneName}"이 없음 → 상점에서 구매 시도`);
      await M.buyElementStoneAtTown(element);
      useButton = await findUseButtonInInventory();
    }
    if (!useButton) throw new Error(`상점 구매 후에도 "${stoneName}" 사용 버튼 못찾음`);
    // 돌 이름과 수량을 확인한 뒤 사용하는 시간.
    await M.humanPause(900, 1600);
    M.throwIfStopped();
    useButton.click();

    const confirm = await M.waitFor(
      () => M.findConfirmInOpenDialog(['확인']),
      5000
    );
    if (!confirm) throw new Error(`"${stoneName}" 사용 확인 모달 못찾음`);
    await M.humanPause(700, 1200);
    M.throwIfStopped();
    confirm.click();
    await M.humanPause(1200, 1800);
  };

  // 모든 직업 공통 전처리: 보스 목록의 오늘 속성과 내 정보의 캐릭터 속성을
  // 비교하고, 다르면 인벤토리에서 해당 속성의 돌을 한 개 사용한 뒤 재검증한다.
  M.ensureElementForBoss = async (bossLabel, { hard = false } = {}) => {
    M.throwIfStopped();
    const startHistoryLength = history.length;
    await M.ensureBossDifficultyTab(bossLabel, { hard });
    // ⚠ 버그 수정(2026-08, 실전 확인): 예전엔 getBossElementFromList를
    // 단발성으로 한 번만 조회해서, 목록 페이지가 아직 렌더링 중이면(예:
    // HARD 탭 전환 직후) "속성을 읽지 못함" 에러로 큐 전체가 멈췄다. SPA
    // 렌더 타이밍 문제는 다른 곳(isInBattleScreen 등)처럼 폴링으로
    // 대응해야 한다.
    const targetElement = await M.waitFor(() => M.getBossElementFromList(bossLabel), 8000, 300);
    if (!targetElement) throw new Error(`"${bossLabel}"의 오늘 속성을 읽지 못함`);
    // ⚠ 사용자 확인(2026-08): 캐시 키에 bossLabel까지 포함돼 있어서, 오늘
    // 선택한 여러 보스가 전부 같은 속성(예: 전부 "별")이어도 보스가 바뀌면
    // 매번 "내 정보"→(불일치 시 인벤토리)를 다시 왕복하는 낭비가 있었다.
    // 오늘 이미 이 속성으로 검증됐다면(다른 보스 차례에 확인한 것이라도)
    // 그대로 재사용하도록 속성 기준으로만 캐시한다.
    const cacheKey = 'lrm-boss-element-verified';
    try {
      const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
      const today = new Date().toLocaleDateString('en-CA');
      if (cached && cached.date === today && cached.element === targetElement) {
        if (M.uiLog) M.uiLog(`속성 확인 생략: 오늘 ${targetElement} 속성은 이미 검증됨("${cached.bossLabel}" 확인 시)`);
        return { targetElement, currentElement: targetElement, cached: true };
      }
    } catch (e) {}

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

    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({
        date: new Date().toLocaleDateString('en-CA'),
        bossLabel,
        element: targetElement,
        verifiedAt: Date.now(),
      }));
    } catch (e) {}

    // 속성 확인을 시작한 보스 목록의 이력 위치로 정확히 돌아간다.
    // 상단 전투 메뉴는 페이지에 따라 메뉴 항목의 DOM 구조가 달라져 "보스"
    // 항목을 못 찾는 경우가 있었으므로, 같은 SPA 안에서 쌓인 history 길이를
    // 기준으로 우선 복귀하고 실패할 때만 메뉴 방식을 폴백으로 사용한다.
    const historyDelta = startHistoryLength - history.length;
    if (historyDelta < 0) {
      M.throwIfStopped();
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
    await M.ensureBossDifficultyTab(bossLabel, { hard });
    return { targetElement, currentElement };
  };

  // 다음에 발생하는 POST /api/personal-boss/start 호출의 응답 status만
  // 딱 한 번 가로채 반환한다. window.fetch를 아주 짧게(최대 timeoutMs)만
  // 감싸고 바로 원복하므로 다른 코드의 fetch 동작에 영향을 주지 않는다.
  // ⚠ 실전 확인: 이 사이트는 이 API 호출에 fetch가 아니라 XMLHttpRequest를
  // 사용한다(axios 기본 어대터로 추정). fetch만 감쓰면 절대 못 잡으므로
  // fetch와 XHR을 모두 감싼다.
  M.captureNextStartResponseStatus = (timeoutMs = 4000) => {
    return new Promise((resolve) => {
      let settled = false;
      const origFetch = window.fetch;
      const OrigXHR = window.XMLHttpRequest;
      const origOpen = OrigXHR.prototype.open;
      const origSend = OrigXHR.prototype.send;
      const restore = () => {
        window.fetch = origFetch;
        OrigXHR.prototype.open = origOpen;
        OrigXHR.prototype.send = origSend;
      };
      const finish = (status) => {
        if (settled) return;
        settled = true;
        restore();
        resolve(status);
      };
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const result = origFetch.apply(this, arguments);
        if (url.includes('/api/personal-boss/start')) {
          result.then((res) => finish(res.status)).catch(() => finish(null));
        }
        return result;
      };
      OrigXHR.prototype.open = function (method, url, ...rest) {
        this.__isStartCall = typeof url === 'string' && url.includes('/api/personal-boss/start');
        return origOpen.call(this, method, url, ...rest);
      };
      OrigXHR.prototype.send = function (...args) {
        if (this.__isStartCall) {
          this.addEventListener('loadend', () => finish(this.status));
        }
        return origSend.apply(this, args);
      };
      setTimeout(() => finish(null), timeoutMs);
    });
  };

  M.enterBossBattle = async (bossLabel, { hard = false } = {}) => {
    M.throwIfStopped();
    // 속성 확인 뒤 목록으로 돌아오는 과정에서도 기본 탭이 일반으로 바뀔 수
    // 있으므로 클릭 직전에 난이도와 대상 카드 렌더링을 다시 검증한다.
    let btn = await M.ensureBossDifficultyTab(bossLabel, { hard });
    let btnText = btn.textContent.trim();
    M.throwIfStopped();
    btn.click();
    await M.sleep(500);

    // 다른 보스 도전이 진행 중이면 새 보스를 누른 직후 "도전 포기" 확인창이
    // 먼저 뜬다. 이 창을 대상 보스의 재도전 확인창으로 오인하면 목록에 남은
    // 채 진입 실패를 반복한다. 큐에서 명시적으로 선택한 다음 보스로 넘어가기
    // 위해 기존 도전을 포기하고, 목록 렌더링 후 대상 카드 버튼을 다시 누른다.
    const abandonConfirm = M.findConfirmInOpenDialog(['포기', '포기하기']);
    if (abandonConfirm) {
      M.throwIfStopped();
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
      M.throwIfStopped();
      btn.click();
      await M.sleep(500);
    }

    // ⚠ 확인 모달은 카드 버튼 클릭 직후 500ms 안에 항상 뜨지는 않는다. 기존
    // 코드는 고정 500ms 뒤 딱 한 번만 찾고, 못 찾으면 로그도 없이 그냥 빠져
    // 나갔다. 그러면 "도전 버튼은 눌렀는데 확인은 안 누른" 상태로 목록에 남고,
    // 호출자는 "전투 화면 진입 확인 실패"로 보고해 큐가 통째로 멈춘다(실전 증상).
    // 모달을 waitFor로 기다리고, 무엇을 눌렀는지/못 찾았는지 로그에 남긴다.
    if (btnText === '도전하기' || btnText === '재도전') {
      const candidates = btnText === '재도전'
        ? ['재도전', '도전', '도전하기', '확인']
        : ['도전', '도전하기', '확인'];
      const confirmBtn = await M.waitFor(() => M.findConfirmInOpenDialog(candidates), 6000, 200);
      if (confirmBtn) {
        M.throwIfStopped();
        if (M.uiLog) M.uiLog(`   확인 모달 "${confirmBtn.textContent.trim()}" 클릭`);
        // ⚠ 실전 확인된 사실: 다른 보스 도전이 이미 "진행 중"인 상태에서 새
        // 보스의 확인 모달을 눌러도, 화면은 아무 에러 표시 없이 그냥 목록에
        // 남는다. 실제로는 서버가 POST /api/personal-boss/start 를 400으로
        // 거부한 것인데, 프론트가 이걸 토스트/모달로 알려주지 않아서 기존
        // 코드는 "전투 화면 진입 확인 실패"라는 애매한 메시지만 남겼다.
        // 확인 클릭과 동시에 fetch를 잠깐 가로채서 실제 응답 상태코드를
        // 직접 확인한다 - 그래야 진짜 원인(동시 진행 제한)을 정확히 로그로
        // 남기고, 무의미한 재시도 대신 바로 명확한 이유로 실패 처리한다.
        const startStatus = M.captureNextStartResponseStatus(4000);
        confirmBtn.click();
        const status = await startStatus;
        if (status === 400) {
          throw new Error(
            `"${bossLabel}" 도전 시작이 서버에 의해 거부됨(400) - 다른 보스 도전이 ` +
              `이미 진행 중이라 새 보스를 시작할 수 없는 것으로 보임. 그 보스를 ` +
              `완료하거나 포기한 뒤 다시 시도해야 함`
          );
        } else if (typeof status === 'number' && status >= 400) {
          throw new Error(`"${bossLabel}" 도전 시작 API 오류 (status ${status})`);
        }
      } else if (M.uiLog) {
        M.uiLog(`   ⚠ "${btnText}" 클릭 후 6초간 확인 모달을 못 찾음 - ${M.describeOpenDialogs()}`);
      }
    } else if (M.uiLog) {
      M.uiLog(`   "${btnText}" 클릭 - 확인 모달 없이 바로 진입 대기`);
    }
    // 실제 진입 여부는 호출자가 waitFor로 확인한다(여기서 고정 sleep 안 함).
  };

  // 카드/확인 버튼을 눌렀다는 사실만으로 진입 성공을 판단하지 않는다.
  // SPA 이동, 늦게 뜨는 확인창, 다른 안내 팝업을 계속 관찰하고 실제 전투
  // 화면 또는 명백한 실패 원인이 확인될 때만 호출자에게 결과를 돌려준다.
  M.waitForBossEntryOutcome = async (bossLabel, timeoutMs = 30000) => {
    const startedAt = Date.now();
    let lastDialogDescription = '';
    let lastPath = '';

    while (Date.now() - startedAt < timeoutMs) {
      M.throwIfStopped();
      if (M.isInBattleScreen(bossLabel)) {
        return { entered: true, reason: 'battle-screen' };
      }

      const path = location.pathname.replace(/\/$/, '');
      const dialogDescription = M.describeOpenDialogs();
      if (dialogDescription && dialogDescription !== lastDialogDescription) {
        lastDialogDescription = dialogDescription;
        if (M.uiLog) {
          M.uiLog(`⏳ 전투 진입 대기 중 팝업 감지 - 상태가 확정될 때까지 관찰: ${dialogDescription}`);
        }
      }
      if (path !== lastPath) {
        lastPath = path;
        if (M.uiLog && path !== '/personal-boss') {
          M.uiLog(`⏳ 전투 진입 경로 전환 감지(${path || '/'}) - 화면 렌더링 대기`);
        }
      }

      // 확인창이 늦게 나타난 경우에만 안전한 진입 버튼을 한 번 처리한다.
      // 정체를 모르는 팝업은 임의로 닫지 않고 사용자가 확인할 시간을 준다.
      const delayedConfirm = M.findConfirmInOpenDialog(['재도전', '도전하기', '도전', '확인']);
      if (delayedConfirm && !delayedConfirm.dataset.lanisBossEntryHandled) {
        delayedConfirm.dataset.lanisBossEntryHandled = '1';
        if (M.uiLog) M.uiLog(`   늦게 나타난 확인 모달 "${delayedConfirm.textContent.trim()}" 클릭`);
        delayedConfirm.click();
      }

      await M.sleep(250);
    }

    return {
      entered: false,
      reason: 'timeout',
      detail: `${M.describeBattleEntryState(bossLabel)} / 팝업: ${M.describeOpenDialogs()}`,
    };
  };

  M.abandonCurrentBossAttempt = async () => {
    M.throwIfStopped();
    const candidates = ['도전 포기', '전투 포기', '포기하기', '포기'];
    const button = await M.waitFor(
      () => candidates.map((text) => M.findButtonByText(text)).find(Boolean),
      5000
    );
    if (!button) throw new Error('현재 보스 도전의 포기 버튼을 못찾음');
    M.throwIfStopped();
    button.click();
    const confirm = await M.waitFor(
      () => M.findConfirmInOpenDialog(['포기', '포기하기', '확인']),
      5000
    );
    if (!confirm) throw new Error('도전 포기 확인 모달의 "포기" 버튼을 못찾음');
    M.throwIfStopped();
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

  // 반환값: { entered: boolean, cleared: boolean }
  //   - entered=false: 카드를 못 찾는 등 애초에 전투 진입 자체를 못함
  //   - entered=true, cleared=true: 실제로 보스 HP 0을 확인하고 처치 완료
  //   - entered=true, cleared=false: 진입은 했지만 실제 처치 실패(최대 시도
  //     횟수 도달 등) - 순수히 "전투화면을 벗어났는지"만으로 성공을 판단하면
  //     스킬화면 오류·페이지 이동 등으로 어쩌다 전투화면을 벗어난 것도
  //     성공으로 오판할 수 있어(실전 지적됨), 반드시 보스 함수 자신이 보고한
  //     cleared 값을 근거로 삼는다.
  M.driveToBossAndRun = async (key, jobOverride = null, forceChallenge = false) => {
    M.assertBossRunAuthorized();
    const entry = BOSS_REGISTRY[key];
    if (!entry) return { entered: false, cleared: false };
    const runName = M.getRunFunctionName(key, jobOverride);

    if (M.isRunning) {
      if (M.uiLog) M.uiLog(`⛔ 이미 다른 작업이 실행 중이라 "${entry.label}" 요청을 무시함`);
      localStorage.removeItem(PENDING_KEY);
      return { entered: false, cleared: false };
    }
    M.isRunning = true;
    M.currentBossPreset = null;

    const runAndReport = async () => {
      try {
        const result = await M[runName]();
        // 각 직업 함수가 자체 HP 판독으로 성공을 반환하지 못했을 때만
        // 공통 종료 증거를 재확인한다. 이 경로가 검술/인술/궁술/체술/마술
        // 전체 보스에 동일하게 적용된다.
        const commonCleared = result && result.cleared
          ? true
          : await M.waitForBossClearEvidence(entry.label);
        return {
          entered: true,
          cleared: commonCleared,
          retryRequired: !!(result && result.retryRequired),
        };
      } catch (e) {
        // 마지막 공격 직후 클리어 모달 때문에 HP/MP 읽기가 실패한 경우에도
        // 화면에 명백한 처치 결과가 있으면 성공이다.
        if (!e.isUserStop && await M.waitForBossClearEvidence(entry.label)) {
          if (M.uiLog) M.uiLog(`✅ "${entry.label}" 클리어 팝업 확인 - 성공 처리`);
          return { entered: true, cleared: true, retryRequired: false };
        }
        // 전투 로직 실행 도중 에러(모달 타이밍 등)가 나도 여기서 삼켜서
        // 큐 전체가 중단되지 않게 한다.
        if (M.uiLog) {
          M.uiLog(e && e.isUserStop
            ? `■ "${entry.label}" 사용자 정지 확인`
            : `⚠ "${entry.label}" 전투 중 오류: ${e.message}`);
        }
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
      let path = location.pathname.replace(/\/$/, '');
      if (path !== '/personal-boss') {
        if (M.uiLog) M.uiLog('➡ 전투 메뉴를 통해 개인 보스 목록으로 이동 중...');
        await M.goToBossListViaMenu();
        M.assertBossRunAuthorized();
        path = location.pathname.replace(/\/$/, '');
      }
      if (path === '/personal-boss') {
        // 직전에 다른 보스를 막 클리어하고 목록으로 돌아온 직후일 수 있어
        // SPA가 목록을 완전히 다시 그릴 시간을 살짝 준다 (실전에서, 클리어
        // 직후 바로 다음 카드를 찾으면 못 찾는 경우가 확인됨).
        await M.sleep(800);
        try {
          // 속성돌을 사용하기 전에 주간 8단계 보상 상태부터 확인한다.
          // 보상이 모두 달성된 보스라면 오늘 속성으로 바꿀 이유가 없으므로
          // 속성 확인/인벤토리 이동 자체를 생략한다.
          // ⚠ 버그 수정(2026-08, 사용자 확인): 이 스킵 로직은 원래 "일일
          // 매크로가 이미 보상 다 받은 보스는 굳이 또 안 잡아도 된다"는
          // 의도인데, 직접 "보스 도전" 버튼으로 돌릴 때도 continueBossQueue를
          // 공유하다 보니 그대로 걸려서, 보상이 이미 소진된 보스를 일부러
          // 다시 잡으려는(예: 로직 검증, 반복 테스트) 직접 실행까지 도전
          // 자체를 시작 못 하고 조용히 스킵되는 문제가 있었다. forceChallenge
          // (직접 버튼 경로에서만 true)가 켜져 있으면 보상 소진 여부와 무관
          // 하게 항상 실제로 도전한다.
          if (!ALLOW_CLEARED_BOSS_TEST && !forceChallenge) {
            const rewardProgress = await M.getWeeklyRewardProgress(entry.label);
            if (!rewardProgress) {
              throw new Error(`"${entry.label}" 주간 보상 상태를 읽지 못해 속성 변경 전에 안전하게 중단`);
            }
            if (M.uiLog) {
              M.uiLog(`🎁 "${entry.label}" 주간 보상 ${rewardProgress.achieved}/${rewardProgress.total} 확인`);
            }
            if (rewardProgress.exhausted) {
              localStorage.removeItem(PENDING_KEY);
              if (M.uiLog) M.uiLog(`⏭ "${entry.label}"은(는) 주간 보상 소진 - 속성 변경 없이 완료 처리`);
              return {
                entered: true,
                cleared: true,
                alreadyCleared: true,
                rewardsExhausted: true,
              };
            }
          }
          // ⚠ 서버가 보스별 동시 진행이 아니라 "계정당 진행 중 도전 1개"만
          // 허용하는 것으로 실전에서 확인됨(예: 지하의 망령을 진행 중인 채로
          // 공허의 황제를 시작하면 확인 모달까지는 뜨지만 서버가 400으로
          // 거부, 화면은 조용히 목록에 남음). 미리 다른 보스 카드가
          // "계속하기" 상태인지 확인해서, 무의미한 재시도 대신 바로 명확한
          // 이유로 큐를 멈춘다.
          const otherInProgress = Object.values(BOSS_REGISTRY)
            .map((e) => e.label)
            .filter((l) => l !== entry.label)
            .find((l) => {
              const b = M.findBossCardActionButton(l);
              return b && b.textContent.trim() === '계속하기';
            });
          if (otherInProgress) {
            if (M.uiLog) {
              M.uiLog(
                `⛔ "${otherInProgress}" 도전이 이미 진행 중이라 "${entry.label}"을(를) ` +
                  `시작할 수 없음 (서버는 동시에 하나만 허용). 먼저 "${otherInProgress}"를 ` +
                  `완료하거나 포기해야 함`
              );
            }
            localStorage.removeItem(PENDING_KEY);
            return { entered: false, cleared: false, blockedByOtherBoss: otherInProgress };
          }
          if (M.uiLog) M.uiLog(`🔎 "${entry.label}" 속성 확인 중...`);
          await M.ensureBossDifficultyTab(entry.label, { hard: !!entry.hard });
          await M.ensureElementForBoss(entry.label, { hard: !!entry.hard });
          if (M.uiLog) M.uiLog(`🧭 "${entry.label}" 카드 찾는 중...`);
          await M.enterBossBattle(entry.label, { hard: !!entry.hard });
          const entryOutcome = await M.waitForBossEntryOutcome(entry.label, 30000);
          if (entryOutcome.entered) {
            localStorage.removeItem(PENDING_KEY);
            return await runAndReport();
          }
          const detail = entryOutcome.detail || M.describeBattleEntryState(entry.label);
          throw new Error(`"${entry.label}" 전투 진입 상태를 30초 동안 확정하지 못함: ${detail}`);
        } catch (e) {
          if (M.uiLog) M.uiLog('⚠ ' + e.message);
          return { entered: false, cleared: false, error: e.message };
        }
      }

      return { entered: false, cleared: false };
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
    active: false,
    start() {
      const keeper = window.__lanisBackgroundKeeper;
      if (!keeper || this.active) return;
      keeper.acquire('boss');
      this.active = true;
    },
    stop() {
      const keeper = window.__lanisBackgroundKeeper;
      if (keeper && this.active) keeper.release('boss');
      this.active = false;
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
    M.armBossRun();
    M.antiThrottle.start();
    localStorage.setItem(PENDING_KEY, key);
    try {
      await M.driveToBossAndRun(key);
    } finally {
      M.antiThrottle.stop();
    }
  };

  // 약한 순서 (BOSS_REGISTRY 등록 순서와 동일). 타락한 정화자(HARD)는
  // 체력이 가장 높아 맨 뒤에 둔다.
  const BOSS_ORDER = ['fallenGuardian', 'voidEmperor', 'vineEnt', 'vineWraith', 'corruptedPurifier', 'voidEmperorEmpty'];

  // ⚠ 버그 수정(2026-08): bossLabel 텍스트가 페이지에 최소 2곳(카드 제목과
  // "이번 주 보상 보스" 요약 배지)에 나타나는데, 기존 코드는 findAllLeavesByExactText가
  // 반환한 첫 번째 후보(요약 배지)에서 조건(액션 버튼 + 마일스톤 8개)이 먼저
  // 만족되면 그 자리에서 return해버려, 실제로는 여러 카드를 아우르는 거대한
  // 컨테이너를 "카드"로 오인했다(실전에서 914자짜리 전체 섹션이 반환되는 것을
  // 확인함). 모든 후보를 다 모은 뒤 가장 작은(가장 좁은) 노드를 채택하도록 고친다.
  M.getBossCardContainer = (bossLabel) => {
    const milestoneLabels = ['클리어', '13%', '25%', '38%', '50%', '63%', '75%', '88%'];
    const candidates = [];
    for (const heading of M.findAllLeavesByExactText(bossLabel)) {
      let node = heading.parentElement;
      for (let depth = 0; node && depth < 9; depth++, node = node.parentElement) {
        const action = [...node.querySelectorAll('button')]
          .find((button) =>
            M.isVisible(button) &&
            ['도전하기', '계속하기', '재도전'].includes(button.textContent.trim())
          );
        const milestoneCount = milestoneLabels.filter((label) =>
          [...node.querySelectorAll('*')].some((el) => el.children.length === 0 && el.textContent.trim() === label)
        ).length;
        if (action && milestoneCount >= 8) {
          candidates.push(node);
          break;
        }
      }
    }
    if (!candidates.length) return null;
    return candidates.reduce((best, node) =>
      node.querySelectorAll('*').length < best.querySelectorAll('*').length ? node : best
    );
  };

  // ⚠ 버그 수정(2026-08, 사용자 실전 확인): "이 보스가 오늘 재도전 가능 상태인지"와
  // "이번 주 단계별 보상을 다 받았는지"는 서로 다른 개념인데, 기존 코드는
  // alreadyCleared(오늘 재도전 상태)만으로 exhausted를 판단했다. 실제로는 각
  // 단계(12%~100% 8단계)마다 "주간 N/M회"라는 별도의 소진 카운트가 있고, 이건
  // 마우스로 직접 hover해야만 뜨는 툴팁에만 있어 매크로 코드로는 못 읽는다
  // (합성 mouseenter/pointerenter 이벤트로는 MUI Tooltip이 안 뜨는 것을 실전
  // 확인함). 대신 게임이 실제로 쓰는 API(GET /api/personal-boss/list)가 이
  // 정보를 weeklyTierLimits[bossId][tier] = {current, max, remaining} 형태로
  // 그대로 제공하므로, 화면을 읽는 대신 이 API를 직접 호출해 정확한 값을 쓴다.
  M.fetchBossApiData = async () => {
    const now = Date.now();
    if (M._bossApiCache && now - M._bossApiCache.at < 3000) {
      return M._bossApiCache.data;
    }
    const token = localStorage.getItem('token');
    const res = await fetch('https://lanis.me/api/personal-boss/list', {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`보스 정보 API 호출 실패 (HTTP ${res.status})`);
    const data = await res.json();
    if (!data || data.success !== true || !Array.isArray(data.bosses) || !data.weeklyTierLimits) {
      throw new Error('보스 정보 API 응답 형식이 예상과 다릅니다.');
    }
    M._bossApiCache = { at: now, data };
    return data;
  };

  // ⚠ 버그 수정(2026-08, 실전 확인): "이번 주 보상 보스" 선택이 비어있으면
  // (또는 최대 인원 미만이면) 사용자가 체크한 보스 중에서 빈 슬롯만 채워
  // 자동 저장한다. 이미 선택된 항목은 절대 건드리지 않는다 — 한 번
  // rewardedBosses에 들어간 보스는 그 주에 절대 해제할 수 없다는 게 실전에서
  // 확인됐고(400 에러: "이미 보상을 받았으므로 해제할 수 없습니다"), 잘못
  // 건드리면 사용자가 원치 않는 보스에 보상이 잠겨버려 그 주엔 되돌릴 방법이
  // 없다. 그래서 이 함수는 "추가만" 하고 "교체/제거"는 절대 하지 않는다.
  M.ensureWeeklyBossSelection = async (selectedKeys) => {
    let data;
    try {
      data = await M.fetchBossApiData();
    } catch (e) {
      if (M.uiLog) M.uiLog(`⚠ 이번 주 보상 보스 선택 확인 실패(API): ${e.message}`);
      return false;
    }
    const weekly = data.weeklySelection;
    if (!weekly || !Array.isArray(weekly.selectedBosses) || typeof weekly.maxSelection !== 'number') {
      if (M.uiLog) M.uiLog('⚠ 이번 주 보상 보스 선택 정보를 API 응답에서 찾지 못해 건너뜁니다.');
      return false;
    }
    const current = weekly.selectedBosses;
    const slotsAvailable = weekly.maxSelection - current.length;
    if (slotsAvailable <= 0) return true; // 이미 꽉 참 - 손댈 것 없음(교체는 하지 않음)

    const candidateIds = selectedKeys
      .map((key) => BOSS_API_ID_MAP[key])
      .filter((id) => id && !current.includes(id));
    if (candidateIds.length === 0) return true;

    const newSelection = current.concat(candidateIds.slice(0, slotsAvailable));
    const token = localStorage.getItem('token');
    const res = await fetch('https://lanis.me/api/personal-boss/weekly-selection', {
      method: 'POST',
      credentials: 'include',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: `Bearer ${token}` } : {}
      ),
      body: JSON.stringify({ selectedBosses: newSelection }),
    });
    M._bossApiCache = null; // 방금 바뀐 선택을 다음 fetchBossApiData 호출에서 다시 읽도록 캐시 무효화
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (M.uiLog) M.uiLog(`⚠ 이번 주 보상 보스 자동 선택 저장 실패 (HTTP ${res.status}) ${text}`);
      return false;
    }
    const addedLabels = candidateIds
      .slice(0, slotsAvailable)
      .map((id) => {
        const key = Object.keys(BOSS_API_ID_MAP).find((k) => BOSS_API_ID_MAP[k] === id);
        return (key && BOSS_REGISTRY[key] && BOSS_REGISTRY[key].label) || id;
      });
    if (M.uiLog) M.uiLog(`🎯 이번 주 보상 보스에 자동 추가: ${addedLabels.join(', ')} (${newSelection.length}/${weekly.maxSelection})`);
    return true;
  };

  M.getWeeklyRewardProgress = async (bossLabel) => {
    const data = await M.fetchBossApiData();
    const bossEntry = data.bosses.find((b) => b.name === bossLabel);
    if (!bossEntry) return null;
    const tierLimits = data.weeklyTierLimits[bossEntry.id];
    if (!tierLimits) return null;
    const tierKeys = Object.keys(tierLimits);
    const achieved = tierKeys.filter((k) => tierLimits[k].remaining <= 0).length;
    const exhausted = tierKeys.every((k) => tierLimits[k].remaining <= 0);
    return {
      achieved,
      total: tierKeys.length,
      exhausted,
      tierLimits,
    };
  };

  M.findBossRewardClaimButton = () =>
    M.queryAll('button').find((el) =>
      ['보상 모두 받기', '보상 받기'].includes(el.textContent.trim()) &&
      M.isVisible(el) &&
      !el.disabled &&
      el.getAttribute('aria-disabled') !== 'true'
    ) || null;

  M.waitForBossListReady = async (bossKeys = BOSS_ORDER) => {
    return await M.waitFor(() => {
      if (location.pathname.replace(/\/$/, '') !== '/personal-boss') return null;
      if (M.findBossRewardClaimButton()) return true;
      return bossKeys.some((key) =>
        M.findBossCardActionButton(BOSS_REGISTRY[key].label)
      ) ? true : null;
    }, 15000, 250);
  };

  M.claimBossRewards = async () => {
    M.throwIfStopped();
    let claimed = 0;
    // 목록 URL이 먼저 바뀌고 보상 영역은 나중에 렌더링될 수 있다.
    // 카드 또는 보상 버튼이 실제 DOM에 나타난 뒤부터 수령 여부를 판단한다.
    const ready = await M.waitForBossListReady();
    if (!ready) throw new Error('보스 목록과 보상 영역의 렌더링을 확인하지 못했습니다.');
    await M.sleep(1200);
    M.throwIfStopped();

    for (let round = 0; round < 12; round++) {
      const button = M.findBossRewardClaimButton();
      if (!button) break;
      if (M.uiLog) M.uiLog(`🎁 보스 "보상 모두 받기" 클릭 (${round + 1}/12)`);
      await M.humanPause(650, 1100);
      M.throwIfStopped();
      button.click();
      claimed++;

      // 확인창이 있는 경우와 클릭 즉시 수령되는 경우를 모두 지원한다.
      const confirm = await M.waitFor(
        () => {
          const dialogButton = M.findConfirmInOpenDialog(['확인', '받기']);
          if (dialogButton) return dialogButton;
          return !button.isConnected || button.disabled || !M.findBossRewardClaimButton()
            ? true
            : null;
        },
        5000,
        150
      );
      M.throwIfStopped();
      if (confirm) {
        if (confirm !== true) {
          await M.humanPause(450, 800);
          M.throwIfStopped();
          confirm.click();
        }
      }

      const settled = await M.waitFor(
        () => {
          const openConfirm = M.findConfirmInOpenDialog(['확인', '받기']);
          if (openConfirm) return null;
          return !button.isConnected || button.disabled || !M.findBossRewardClaimButton()
            ? true
            : null;
        },
        10000,
        200
      );
      if (!settled) {
        throw new Error('"보상 모두 받기" 클릭 후 수령 완료 상태를 확인하지 못했습니다.');
      }
      await M.humanPause(500, 900);
    }
    return claimed;
  };

  M.claimBossRewardsAndVerify = async () => {
    M.throwIfStopped();
    const claimed = await M.claimBossRewards();
    M.throwIfStopped();

    // SPA 갱신 중 버튼이 잠깐 사라졌다 다시 나타나는 경우까지 막기 위해
    // 연속 세 번 미검출되어야 보상 수령 완료로 확정한다.
    let absentChecks = 0;
    const verified = await M.waitFor(() => {
      if (M.findBossRewardClaimButton()) {
        absentChecks = 0;
        return null;
      }
      absentChecks++;
      return absentChecks >= 3 ? true : null;
    }, 10000, 300);
    if (!verified) {
      throw new Error('보스 보상 수령 후에도 "보상 모두 받기" 버튼이 남아 있습니다.');
    }
    if (M.uiLog) {
      M.uiLog(claimed > 0
        ? `✅ 보스 보상 모두 받기 완료 (${claimed}회 클릭) - 다음 작업 진행`
        : '✅ 수령할 보스 보상 없음 확인 - 다음 작업 진행');
    }
    return claimed;
  };

  M.waitForBossQueueEnd = async (timeoutMs = 45 * 60 * 1000) => {
    const start = Date.now();
    while (localStorage.getItem(QUEUE_KEY)) {
      if (M.stopRequested) throw new Error('사용자가 보스 실행을 정지했습니다.');
      if (Date.now() - start > timeoutMs) throw new Error('보스 큐 완료 대기 시간이 초과되었습니다.');
      await M.sleep(1000);
    }
  };

  M.runDailySelectedBosses = async () => {
    const auth = M.getBossRunAuth();
    M.assertBossRunAuthorized(auth && auth.id);
    let selected = BOSS_ORDER.filter((key) => loadSelectedBosses().includes(key));
    if (selected.length === 0) throw new Error('선택한 보스가 없습니다.');

    // 실전 보스 처치를 시작하기 전에, 체크해둔 보스가 "이번 주 보상 보스"
    // 슬롯에 비어있으면 먼저 채워넣는다(§ensureWeeklyBossSelection 주석 참고).
    // 이걸 안 하면 보스를 처치해도 주간 보상 대상이 아니라서 보상이 전혀
    // 지급되지 않는 채로 계속 헛도전만 반복하게 된다.
    const weeklySelectionReady = await M.ensureWeeklyBossSelection(selected);
    if (!weeklySelectionReady) {
      throw new Error('이번 주 보상 보스 선택을 확인하거나 저장하지 못해 안전하게 중단합니다.');
    }

    // ⚠ 사용자 확인(2026-08): 수(3)/금(5)은 타락한 정화자를 아예 도전할 수
    // 없는 요일이다. 정지시키지 않고 큐에서만 빼고 알림 로그를 남긴다 -
    // 일일은 어차피 다 체크해두고 돌리며, 받을 게 없으면 수호자에 입장했다
    // 나가는 것처럼, 정화자도 오늘 못 잡으면 그냥 건너뛰면 되는 항목이다.
    const kstDay = M.getKstDayOfWeek();
    if ((kstDay === 3 || kstDay === 5) && selected.includes('corruptedPurifier')) {
      selected = selected.filter((key) => key !== 'corruptedPurifier');
      const dayLabel = kstDay === 3 ? '수요일' : '금요일';
      if (M.uiLog) M.uiLog(`⚠ 오늘은 ${dayLabel}이라 타락한 정화자는 도전 불가 - 이번 큐에서 제외`);
      if (selected.length === 0) {
        return '오늘은 정화자 도전 불가 요일이고 다른 선택 보스가 없어 처리할 것 없음';
      }
    }

    // Chrome이 실행 중인 탭을 폐기했다 복원한 경우에는 저장된 보스 큐가
    // 현재 전투 체크포인트다. 먼저 목록으로 이동하면 진행 중 전투를 버리고
    // 같은 보스를 처음부터 시작하므로, 큐를 그대로 끝낸 뒤 보상을 검증한다.
    if (window.__lanisWasDiscarded === true && localStorage.getItem(QUEUE_KEY)) {
      if (M.uiLog) M.uiLog('⏳ 폐기 탭 복구: 진행 중이던 보스 큐부터 재개');
      if (!M.isRunning) await M.continueBossQueue();
      await M.waitForBossQueueEnd();
      if (location.pathname.replace(/\/$/, '') !== '/personal-boss') {
        await M.goToBossListViaMenu();
      }
      const listReady = await M.waitForBossListReady(selected);
      if (!listReady) throw new Error('복구된 보스 큐 종료 후 목록 렌더링을 확인하지 못했습니다.');
      await M.claimBossRewardsAndVerify();
      const failedChecks = await Promise.all(selected.map(async (key) => {
        const progress = await M.getWeeklyRewardProgress(BOSS_REGISTRY[key].label);
        return { key, ok: !!(progress && progress.exhausted) };
      }));
      const failed = failedChecks.filter((c) => !c.ok).map((c) => c.key);
      if (failed.length) {
        throw new Error(
          `복구 후에도 주간 보상 완료를 확인하지 못함: ${failed.map((key) => BOSS_REGISTRY[key].label).join(', ')}`
        );
      }
      return `폐기 탭에서 보스 큐 복구 및 선택 보스 ${selected.length}종 보상 확인`;
    }

    if (location.pathname.replace(/\/$/, '') !== '/personal-boss') {
      await M.goToBossListViaMenu();
      M.assertBossRunAuthorized(auth.id);
    }

    await M.claimBossRewardsAndVerify();
    M.assertBossRunAuthorized(auth.id);

    // 보상 잔여량은 API로 읽지만 "오늘 이미 처치했는지"는 카드 버튼
    // (재도전 여부)을 읽는다. 일반/HARD 보스가 섞여 있어도 각 보스의 실제
    // 난이도 탭을 연 뒤 순차적으로 카드 상태를 확인한다. 탭 전환을 Promise.all
    // 로 병렬 실행하면 서로 탭을 덮어쓰므로 반드시 순차 처리한다.
    const progressBefore = [];
    for (const key of selected) {
      const entry = BOSS_REGISTRY[key];
      M.assertBossRunAuthorized(auth.id);
      await M.ensureBossDifficultyTab(entry.label, { hard: !!entry.hard });
      progressBefore.push({
        key,
        label: entry.label,
        progress: await M.getWeeklyRewardProgress(entry.label),
        alreadyCleared: M.isBossAlreadyCleared(entry.label),
      });
    }
    const unreadable = progressBefore.filter((item) => !item.progress);
    if (unreadable.length) {
      throw new Error(`주간 보상 횟수를 읽지 못한 보스: ${unreadable.map((item) => item.label).join(', ')}`);
    }
    // ⚠ 버그 수정(2026-08, 사용자 확인): 큐에 넣을 보스를 고를 때 주간 보상
    // 소진 여부(exhausted)만 확인하고 "오늘 이미 처치했는지"는 전혀 확인하지
    // 않고 있었다. isBossAlreadyCleared 함수는 이미 존재했지만 어디서도
    // 호출되지 않는 죽은 코드였다. 사용자 확인: 보스 도전이 성립하려면
    // "오늘 아직 안 잡았음" AND "주간 보상이 남아있음" 둘 다 만족해야
    // 한다(보상 퍼센트 단계는 여러 번 처치해야 채워지는 게 아니라, 체력을
    // 얼마나 깎았는지에 따른 단일 보상표일 뿐 — 처치=0%면 모든 단계 보상을
    // 한 번에 받음). 이 누락 때문에 "일일"이 이미 오늘 완전히 처치·보상
    // 수령까지 끝난 보스 3마리를 그대로 다시 큐에 넣어 불필요하게
    // 재처치(전투 스크롤 등 자원 소모)시키는 걸 실전에서 직접 확인함.
    const remaining = progressBefore
      .filter((item) => !item.progress.exhausted && !item.alreadyCleared)
      .map((item) => item.key);

    if (remaining.length === 0) {
      M.assertBossRunAuthorized(auth.id);

      // ⚠ 버그 수정(2026-08, 사용자 확인): 사용자가 체크박스에서 정화자를
      // 선택 안 했는데도 필러 대체가 실행됐다 - 요일/직업/오늘미처치 조건만
      // 확인하고 "사용자가 실제로 정화자를 선택했는지"를 빠뜨렸었다.
      // 사용자가 명시적으로 체크 해제했다면 그 선택을 존중해야 한다.
      // ⚠ 사용자 요청(2026-08): "필러"(수호자 들어갔다 나오기)로 일일 도전
      // 과제만 채우던 걸, 조건이 맞으면 실제 정화자 전투로 대체한다 - 이러면
      // 일일 도전과제도 채워지고 실제 보스 처치·보상도 같이 얻는다. 조건:
      // (0) 사용자가 체크박스에서 정화자를 선택해뒀음, (1) 오늘 요일에 구현된
      // 공략 패턴이 있음(월/화/일 봉인즉시딜 패턴 + 목/토 방깎 패턴 둘 다
      // 구현됨, 수/금은 여전히 미구현), (2) 현재 선택된 직업에 정화자
      // 로직이 등록돼 있음(현재 검술만), (3) 오늘 정화자를 아직 안 잡았음.
      // 넷 다 맞으면 필러 대신 실전 투입한다.
      const purifierUserSelected = loadSelectedBosses().includes('corruptedPurifier');
      const IMPLEMENTED_PURIFIER_DAYS = [0, 1, 2, 4, 6]; // KST getUTCDay 기준: 일=0,월=1,화=2,목=4,토=6
      const todayKstDay = M.getKstDayOfWeek();
      let purifierRunName = null;
      try {
        purifierRunName = M.getRunFunctionName('corruptedPurifier');
      } catch (e) {
        purifierRunName = null;
      }
      let purifierAlreadyClearedToday = true;
      if (
        purifierUserSelected &&
        IMPLEMENTED_PURIFIER_DAYS.includes(todayKstDay) &&
        purifierRunName
      ) {
        await M.ensureBossDifficultyTab(
          BOSS_REGISTRY.corruptedPurifier.label,
          { hard: true }
        );
        purifierAlreadyClearedToday = M.isBossAlreadyCleared(
          BOSS_REGISTRY.corruptedPurifier.label
        );
      }
      if (
        purifierUserSelected &&
        IMPLEMENTED_PURIFIER_DAYS.includes(todayKstDay) &&
        purifierRunName &&
        !purifierAlreadyClearedToday
      ) {
        if (M.uiLog) {
          M.uiLog('선택한 보스 전부 처리 완료 → 필러 대신 타락한 정화자 실전 투입(일일 과제+보상 동시 처리)');
        }
        await M.enterBossBattle(BOSS_REGISTRY.corruptedPurifier.label, { hard: true });
        const purifierEntered = await M.waitFor(
          () => M.isInBattleScreen(BOSS_REGISTRY.corruptedPurifier.label),
          10000,
          250
        );
        if (!purifierEntered) throw new Error('필러 대체용 정화자 전투 진입을 확인하지 못했습니다.');
        await M[purifierRunName]();
        return '선택 보스 주간 보상 소진 확인, 필러 대신 타락한 정화자 실전 처치 완료';
      }

      if (M.uiLog) M.uiLog('선택한 보스 전부 처리 완료(오늘 이미 처치했거나 주간 보상 소진) → 수호자 도전 후 포기');
      await M.enterBossBattle(BOSS_REGISTRY.fallenGuardian.label);
      const entered = await M.waitFor(() => M.isInBattleScreen(BOSS_REGISTRY.fallenGuardian.label), 10000, 250);
      if (!entered) throw new Error('일일 과제용 수호자 전투 진입을 확인하지 못했습니다.');
      await M.abandonCurrentBossAttempt();
      return '선택 보스 주간 보상 소진 확인, 수호자 도전 후 포기 완료';
    }

    if (M.uiLog) {
      M.uiLog(`주간 보상이 남은 보스: ${remaining.map((key) => BOSS_REGISTRY[key].label).join(', ')}`);
    }
    const existingQueue = localStorage.getItem(QUEUE_KEY);
    if (existingQueue) {
      if (!M.isRunning) M.continueBossQueue().catch((e) => M.uiLog && M.uiLog(`❌ ${e.message}`));
      await M.waitForBossQueueEnd();
    } else {
      M.assertBossRunAuthorized(auth.id);
      await M.startBossQueue(remaining);
      await M.waitForBossQueueEnd();
    }

    if (location.pathname.replace(/\/$/, '') !== '/personal-boss') {
      await M.goToBossListViaMenu();
      M.assertBossRunAuthorized(auth.id);
    }
    const listReadyAfterQueue = await M.waitForBossListReady(remaining);
    if (!listReadyAfterQueue) {
      throw new Error('보스 처치 후 목록과 보상 영역의 렌더링을 확인하지 못했습니다.');
    }
    M.assertBossRunAuthorized(auth.id);
    await M.claimBossRewardsAndVerify();
    M.assertBossRunAuthorized(auth.id);
    const failedChecks2 = await Promise.all(remaining.map(async (key) => {
      const progress = await M.getWeeklyRewardProgress(BOSS_REGISTRY[key].label);
      return { key, ok: !!(progress && progress.exhausted) };
    }));
    const failed = failedChecks2.filter((c) => !c.ok).map((c) => c.key);
    if (failed.length) {
      throw new Error(`처치 후에도 주간 보상 완료를 확인하지 못함: ${failed.map((key) => BOSS_REGISTRY[key].label).join(', ')}`);
    }
    return `보상 잔여 보스 ${remaining.length}종 처치 및 보상 수령 확인`;
  };

  // 선택한 보스들을 약한 순서대로 정렬해 큐에 저장하고 시작
  M.startBossQueue = async (selectedKeys, { forceChallenge = false } = {}) => {
    if (M.isRunning) {
      if (M.uiLog) M.uiLog('⛔ 이미 실행 중이라 새 요청을 무시함');
      return;
    }
    const auth = M.getBossRunAuth();
    M.assertBossRunAuthorized(auth && auth.id);
    M.antiThrottle.start();
    try {
      const detected = await M.detectBossJob();
      M.assertBossRunAuthorized(auth.id);
      const remaining = BOSS_ORDER.filter((k) => selectedKeys.includes(k));
      const q = {
        remaining,
        attempts: 0,
        entryFailStreak: 0,
        failedLabels: [],
        job: detected.job,
        className: detected.className,
        authId: auth.id,
        forceChallenge,
      };
      localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
      await M.continueBossQueue();
    } finally {
      M.antiThrottle.stop();
    }
  };

  // 현재 실행 안에서 큐를 순서대로 진행한다. 새로고침 뒤 자동 재개는 금지한다.
  M.continueBossQueue = async () => {
    // 일일 복구와 보스 복구가 같은 순간 호출되어도 큐 소비자는 하나만 둔다.
    if (M.queueRunning) return;
    M.queueRunning = true;
    try {
      let raw = localStorage.getItem(QUEUE_KEY);
      if (!raw) return;

      while (true) {
        raw = localStorage.getItem(QUEUE_KEY);
        if (!raw) return;
        const q = M.parseBossQueueState(raw);
        if (q.attempts === undefined) q.attempts = 0;
        if (q.entryFailStreak === undefined) q.entryFailStreak = 0;
        if (!M.isBossRunAuthorized(q.authId) || q.remaining.length === 0) break;

      const key = q.remaining[0];
      const entry = BOSS_REGISTRY[key];
      if (M.uiLog) M.uiLog(`▶▶ [큐] "${entry.label}" 도전 시작 (남은 ${q.remaining.length}개)`);

      const result = await M.driveToBossAndRun(key, q.job || M.getSelectedJob(), !!q.forceChallenge);
      if (!M.isBossRunAuthorized(q.authId)) return;

      const raw2 = localStorage.getItem(QUEUE_KEY);
      if (!raw2) return; // 그 사이 정지 등으로 큐가 지워졌으면 종료
      const q2 = M.parseBossQueueState(raw2);
      if (!M.isBossRunAuthorized(q2.authId)) return;
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
        if (result.error) {
          // 큐 내부에서 오류를 삼키면 waitForBossQueueEnd가 정상 종료로 오인해
          // 일일매크로가 보스를 건너뛴다. 원인을 상위 실행까지 그대로 전달한다.
          throw new Error(result.error);
        }
        localStorage.removeItem(QUEUE_KEY);
        if (M.uiLog) M.uiLog(`🛑 [큐] "${entry.label}" 전투 진입 확인 실패 - 자동 재클릭 없이 중단`);
        M.showBossNotice(
          `⚠ "${entry.label}" 전투 진입을 확인하지 못했습니다.\n` +
          '중복 도전을 방지하기 위해 카드/도전 버튼을 다시 누르지 않고 큐를 중단합니다.'
        );
        return;
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

      // 일반 공략 실패를 같은 보스 자동 재도전으로 바꾸지 않는다.
      // 프리셋/봉인/마나/턴 제한 오류를 재입장으로 숨기면 황제 같은 보스를
      // 계속 처음부터 시작하게 된다. 자동 재도전은 위 retryRequired
      // (망령 첫 자세 전환 실패 등) 경로에서만 허용한다.
      q2.attempts++;
      if (!q2.failedLabels.includes(entry.label)) q2.failedLabels.push(entry.label);
      localStorage.removeItem(QUEUE_KEY);
      if (M.uiLog) M.uiLog(`🛑 [큐] "${entry.label}" 공략 실패 - 자동 재도전 없이 중단`);
      M.showBossNotice(
        `⚠ "${entry.label}" 공략이 완료되지 않았습니다.\n` +
        '프리셋·봉인·마나·턴 제한 상태를 확인하기 위해 자동 재도전 없이 큐를 중단합니다.'
      );
      return;
    }

      const finalRaw = localStorage.getItem(QUEUE_KEY);
      const failedLabels = finalRaw
        ? M.parseBossQueueState(finalRaw).failedLabels
        : [];
      localStorage.removeItem(QUEUE_KEY);
      if (M.uiLog) M.uiLog('=== 보스 큐 종료 ===');
      if (failedLabels.length > 0) {
        // 실패가 하나라도 있었으면 비차단 배너로 알림.
        M.showBossNotice(`일부 보스는 재시도 끝에 처치했지만 중간에 실패가 있었습니다: ${failedLabels.join(', ')}\n로그를 확인해주세요.`);
      } else if (!M.stopRequested) {
        if (M.uiLog) M.uiLog('🎉 선택한 보스를 모두 처치했습니다!');
      }
    } catch (error) {
      // 예상하지 못한 DOM/프리셋/클릭 오류가 큐를 남긴 채 빠져나가면,
      // 일일 대기 루프가 끝나지 않거나 폐기 탭 복구 때 같은 보스를 다시
      // 시작할 수 있다. 실패 시 허가·pending·queue를 함께 폐기하고 다음
      // 명시적 시작 전에는 자동 재개하지 않는다.
      M.clearBossRunState();
      if (M.uiLog) M.uiLog(`🛑 보스 큐 예외 중단: ${error.message}`);
      throw error;
    } finally {
      M.queueRunning = false;
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
      return ['검술', '인술', '궁술', '체술', '마술'].includes(value) ? value : null;
    } catch (e) {
      return null;
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

  function buildPanel(hostOverride = null) {
    const host = hostOverride || document.getElementById('lrm-boss-tool-host');
    if (!host || host.querySelector('#lrm-boss-ref-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'lrm-boss-ref-panel';
    panel.style.cssText = 'color:#eee; font-size:12px; font-family:sans-serif;';
    panel.innerHTML = `
      <div>
        <div style="font-size:11px; color:#999; margin-bottom:2px;">직업 (보스 시작 시 내 정보에서 자동 감지)</div>
        <select id="lrm-boss-ref-job" disabled title="실행 시 실제 직업으로 자동 갱신됩니다." style="width:100%; margin-bottom:10px; padding:5px; background:#111; color:#eee; border:1px solid #555; border-radius:4px;">
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
        <label style="display:flex; align-items:center; gap:6px; margin-bottom:8px; cursor:pointer;">
          <input type="checkbox" class="lrm-boss-check" value="corruptedPurifier" style="width:16px; height:16px; cursor:pointer;"> 타락한 정화자 (HARD, 검술 공략만 구현됨·다른 직업 추후 추가)
        </label>
        <label style="display:flex; align-items:center; gap:6px; margin-bottom:8px; cursor:pointer;">
          <input type="checkbox" class="lrm-boss-check" value="voidEmperorEmpty" style="width:16px; height:16px; cursor:pointer;"> 허무의 황제 (HARD, 검술 공략만 구현됨·다른 직업 추후 추가)
        </label>

        <button id="lrm-boss-ref-run-queue" style="width:100%; margin-bottom:6px; padding:6px; background:#2e7d32; color:#fff; border:none; border-radius:4px; cursor:pointer;">보스 도전</button>
        <button id="lrm-boss-ref-bg-test" style="width:100%; margin-bottom:6px; padding:6px; background:#1565c0; color:#fff; border:none; border-radius:4px; cursor:pointer;">백그라운드 진단 (60초)</button>
        <button id="lrm-boss-ref-stop" style="width:100%; margin-bottom:6px; padding:6px; background:#c62828; color:#fff; border:none; border-radius:4px; cursor:pointer;">정지</button>
        <div style="font-size:11px; color:#999; margin-bottom:4px;">로그</div>
        <div id="lrm-boss-ref-log" style="height:160px; overflow-y:auto; background:#000; padding:6px; border-radius:4px; white-space:pre-wrap; font-size:11px; line-height:1.4;"></div>
      </div>
    `;
    host.appendChild(panel);

    // 마지막으로 선택한 직업과 보스 체크 상태는 실행 큐와 별도로 영구 저장한다.
    // 새로고침이나 보스 화면 이동으로 스크립트가 다시 로드돼도 그대로 복원됨.
    const jobSelect = panel.querySelector('#lrm-boss-ref-job');
    jobSelect.value = loadSelectedJob() || '';
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
      const coordinator = window.__lanisBossCoordinator;
      if (coordinator && !coordinator.acquire()) {
        M.uiLog('⚠ 다른 통합 매크로 모듈이 실행 중이라 보스 시작을 차단했습니다.');
        return;
      }
      M.armBossRun();
      setRunningState(true);
      M.uiLog(`▶ 보스 도전 시작 (선택: ${checked.length}개)`);
      try {
        const weeklySelectionReady = await M.ensureWeeklyBossSelection(checked);
        if (!weeklySelectionReady) {
          throw new Error('이번 주 보상 보스 선택을 확인하거나 저장하지 못해 안전하게 중단합니다.');
        }
        await M.startBossQueue(checked, { forceChallenge: true });
        // ⚠ 실전 확인: 이 "보스 도전" 버튼 경로는 startBossQueue만 호출하고 끝나서,
        // 보상 자동 수령(M.claimBossRewardsAndVerify)이 "일일" 탭의
        // runDailySelectedBosses 경로에서만 호출되고 여기서는 전혀 호출되지
        // 않았다(실전 확인됨 - 보스를 다 처치해도 보상이 자동으로 안 들어옴).
        // 보상 수령 실패는 처치 자체의 실패로 보지 않고 로그만 남긴다.
        try {
          await M.claimBossRewardsAndVerify();
          M.uiLog('✅ 보상 자동 수령 확인 완료');
        } catch (rewardError) {
          M.uiLog('⚠ 보상 자동 수령 확인 실패(보스 처치 자체는 완료됨): ' + rewardError.message);
        }
      } catch (e) {
        M.uiLog('⚠ 오류: ' + e.message);
      } finally {
        if (coordinator) coordinator.release();
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
      const coordinator = window.__lanisBossCoordinator;
      if (
        coordinator &&
        ((coordinator.isDailyActive && coordinator.isDailyActive()) ||
         (coordinator.hasDailyRun && coordinator.hasDailyRun()))
      ) {
        coordinator.requestDailyStop();
        return;
      }
      M.requestImmediateStop();
    });
    if (window.__lanisBossCoordinator) window.__lanisBossCoordinator.refresh();
  }

  window.__mountLanisBossTool = buildPanel;
  if (window.__lanisSharedCoreOptions?.mode !== 'headless') buildPanel();

  // 일반 새로고침은 항상 중단한다. Chrome 메모리 절약으로 폐기된 탭만
  // 현재 sessionStorage 실행 허가와 큐 authId가 모두 일치할 때 재개한다.
  (function resumePendingIfAny() {
    if (window.__lanisWasDiscarded !== true) {
      localStorage.removeItem(PENDING_KEY);
      localStorage.removeItem(QUEUE_KEY);
      sessionStorage.removeItem(RUN_AUTH_KEY);
      localStorage.setItem(STOP_LATCH_KEY, String(Date.now()));
      M.stopRequested = true;
      if (M.uiLog) M.uiLog('■ 새로고침 후 보스 자동 재개 차단 - 사용자가 시작을 눌러야 실행');
      return;
    }
    // 일일 실행 중이라면 일일 오케스트레이터가 기존 큐를 이어받는다.
    // 여기서 동시에 재개하면 같은 보스를 두 루프가 클릭할 수 있다.
    let dailyState = null;
    let dailyAuth = null;
    try {
      dailyState = JSON.parse(localStorage.getItem('lrm-daily-sequence-state') || 'null');
      dailyAuth = JSON.parse(sessionStorage.getItem('lrm-daily-explicit-run-auth') || 'null');
    } catch (e) {
      dailyState = null;
      dailyAuth = null;
    }
    if (
      dailyState &&
      dailyState.running &&
      dailyAuth &&
      dailyAuth.startedAt === dailyState.startedAt
    ) {
      if (M.uiLog) M.uiLog('⏳ Chrome 폐기 탭 복원: 일일 실행이 보스 큐를 이어받습니다.');
      return;
    }
    // 큐/pending 값은 과거 실행의 찌꺼기일 수 있다. 사용자가 현재 탭에서
    // 직접 시작해 발급된 허가가 없으면 어떤 경우에도 자동 실행하지 않는다.
    if (!sessionStorage.getItem(RUN_AUTH_KEY)) {
      localStorage.removeItem(PENDING_KEY);
      localStorage.removeItem(QUEUE_KEY);
      localStorage.setItem(STOP_LATCH_KEY, String(Date.now()));
      if (M.uiLog) M.uiLog('■ 사용자 실행 허가 없음 - 저장된 보스 작업 자동 시작 차단');
      return;
    }
    if (localStorage.getItem(STOP_LATCH_KEY)) {
      localStorage.removeItem(PENDING_KEY);
      localStorage.removeItem(QUEUE_KEY);
      if (M.uiLog) M.uiLog('■ 이전 사용자 정지 상태 유지 - 자동 재개하지 않음');
      return;
    }
    const queueRaw = localStorage.getItem(QUEUE_KEY);
    if (queueRaw) {
      let queuedAuthId = null;
      try {
        queuedAuthId = JSON.parse(queueRaw).authId || null;
      } catch (e) {
        queuedAuthId = null;
      }
      if (!queuedAuthId || !M.isBossRunAuthorized(queuedAuthId)) {
        M.clearBossRunState();
        if (M.uiLog) M.uiLog('■ 실행 허가가 일치하지 않는 보스 큐 폐기');
        return;
      }
      setTimeout(() => {
        const currentRaw = localStorage.getItem(QUEUE_KEY);
        let currentQueue = null;
        try {
          currentQueue = currentRaw ? JSON.parse(currentRaw) : null;
        } catch (e) {
          currentQueue = null;
        }
        // 예약 당시의 큐가 정지/새 실행으로 바뀌었으면 절대 재개하지 않는다.
        if (!currentQueue || currentQueue.authId !== queuedAuthId ||
            !M.isBossRunAuthorized(queuedAuthId)) {
          if (M.uiLog) M.uiLog('■ 정지 또는 실행 변경 감지 - 예약된 보스 큐 재개 취소');
          return;
        }
        if (M.uiLog) M.uiLog('⏳ 보스 큐 이어서 진행');
        const coordinator = window.__lanisBossCoordinator;
        if (coordinator && !coordinator.acquire()) {
          if (M.uiLog) M.uiLog('⚠ 다른 모듈 실행 중이라 보스 큐 자동 재개를 보류했습니다.');
          return;
        }
        // 새로고침 직후라 사용자 제스처가 없어 오디오 자동재생이 막힐 수도
        // 있지만(브라우저 정책), 안 되면 조용히 무시되고 매크로는 계속 진행됨.
        M.antiThrottle.start();
        M.continueBossQueue()
          .catch((e) => { if (M.uiLog) M.uiLog('⚠ ' + e.message); })
          .finally(() => {
            M.antiThrottle.stop();
            if (coordinator) coordinator.release();
          });
      }, 1200);
      return;
    }
    const pending = localStorage.getItem(PENDING_KEY);
    if (pending && BOSS_REGISTRY[pending]) {
      const pendingAuth = M.getBossRunAuth();
      const pendingAuthId = pendingAuth && pendingAuth.id;
      setTimeout(() => {
        // 정지 버튼은 pending과 허가를 모두 지운다. 예약 콜백은 캡처한
        // 과거 값이 아니라 현재 저장값/허가를 다시 비교해야 한다.
        if (
          localStorage.getItem(PENDING_KEY) !== pending ||
          !M.isBossRunAuthorized(pendingAuthId)
        ) {
          if (M.uiLog) M.uiLog('■ 정지 또는 실행 변경 감지 - 예약된 보스 요청 재개 취소');
          return;
        }
        if (M.uiLog) M.uiLog(`⏳ 이전 요청 이어서 진행: ${BOSS_REGISTRY[pending].label}`);
        const coordinator = window.__lanisBossCoordinator;
        if (coordinator && !coordinator.acquire()) {
          if (M.uiLog) M.uiLog('⚠ 다른 모듈 실행 중이라 이전 보스 요청 자동 재개를 보류했습니다.');
          return;
        }
        M.antiThrottle.start();
        M.driveToBossAndRun(pending)
          .catch((e) => { if (M.uiLog) M.uiLog('⚠ ' + e.message); })
          .finally(() => {
            M.antiThrottle.stop();
            if (coordinator) coordinator.release();
          });
      }, 1200); // 페이지가 완전히 로드될 시간을 조금 줌
    }
  })();

  // ==========================================================================
  // 보스별 공략 로직
  // ==========================================================================

  // --- 타락한 정화자 (검술 잡, HARD 전용) --------------------------------------
  // 기믹: 요일마다 보스 방어력을 약화시키는 상태이상이 다르다.
  //   월=화상, 화=빙결, 수=못잡음, 목=중독, 금=못잡음, 토=모든상태이상(목요일과
  //   동일 취급), 일=암흑. 하지만 실제 전투 로직은 요일과 무관하게 두 패턴뿐:
  //   - 월/화/일: 딜 프리셋 자체에 상태이상을 거는 딜스킬이 포함돼 있어
  //     별도 방깎 프리셋 없이 "봉인 → 딜"만 하면 된다. (이 함수가 구현하는 패턴)
  //   - 목/토: 중독은 스킬딜이 없어 어빌리티·무기를 따로 빼야 해서 방깎을
  //     별도 프리셋으로 분리한다. "봉인 → 방깎 → 딜 → 방깎 → 딜" (2026-08
  //     시점 아직 미구현 - 다음에 추가 예정)
  //   수/금은 아예 도전 불가능한 요일이라 daily 단계에서 정화자를 큐에서
  //   제외하고 알림만 띄워야 한다(정지 아님) - 별도 처리.
  //
  // 1) 봉인 프리셋(공용 "봉인")으로 "불굴"+"엔드 블로킹" 봉인. 5턴씩,
  //    내 HP 50% 미만이면 그 턴은 회복. 10턴(5턴×2회) 내 봉인 안 되면
  //    "도전 포기" 후 재도전(최대 시도 횟수까지 반복).
  // 2) 봉인되면 오늘 보스 속성을 실시간으로 읽어 "{속성} 딜" 프리셋을 적용.
  //    프리셋이 없으면 applyBossPreset이 에러를 던져 매크로가 정지한다
  //    (프리셋 이름 오타/누락 신호 - 사용자 확인 필요).
  // 3) 내 HP/MP 60% 이상이면 1턴 공격, 미만이면 회복. 공격으로 보스에게
  //    상태이상을 쌓아 방어력을 깎다가, 전투 로그의 "보스: 방↓N"이 400
  //    이상이면 공격 스크롤(5턴 지속) 1개 사용. 스크롤 효과가 끝나는
  //    5공격턴마다 다시 방↓400 조건을 확인해 반복 사용(스크롤 소진되면
  //    이후로는 그냥 공격만 반복). 보스 죽을 때까지 반복.
  // ⚠ 사용자 확인(2026-08): 월/화/일 패턴. 봉인 완료 후 바로 오늘 속성
  // 딜 프리셋으로 전환해 1턴씩 공격(방↓400 이상일 때마다 공격 스크롤
  // 재사용). 목/토 패턴(방깎 단계가 별도로 있음)과는 완전히 다른 흐름이라
  // 별도 함수로 유지하고, M.runCorruptedPurifierSword가 요일을 보고 이
  // 함수와 목/토 패턴 중 하나로 위임한다.
  M.getCorruptedPurifierScrollDefenseThreshold = (
    element,
    baseThreshold = 400,
    kstDay = M.getKstDayOfWeek()
  ) => kstDay === 0 && element === '어둠' ? 280 : baseThreshold;

  M.runCorruptedPurifierSwordSealPattern = async ({
    requiredSeals = ['불굴', '엔드 블로킹'],
    sealRoundsPerAttempt = 2, // 5턴씩 2회 = 10턴
    maxSealAttempts = 5,
    sealLowHpThreshold = 0.5,
    dealHpThreshold = 0.6,
    dealMpThreshold = 0.6,
    defenseDropThreshold = 400,
    scrollDurationTurns = 5,
    maxDealRounds = 200,
  } = {}) => {
    const bossLabel = BOSS_REGISTRY.corruptedPurifier.label;
    const log = [];
    const push = (line) => { log.push(line); if (M.uiLog) M.uiLog(line); };

    // 1단계: 봉인 (재도전 포함)
    let sealed = new Set();
    let sealSucceeded = false;
    for (let attempt = 1; attempt <= maxSealAttempts; attempt++) {
      M.throwIfStopped();
      await M.applyBossPreset('봉인');
      push(`[봉인 시도 ${attempt}] 프리셋 적용`);
      sealed = M.parseSealedAbilities(requiredSeals);
      let rounds = 0;
      while (!requiredSeals.every((a) => sealed.has(a)) && rounds < sealRoundsPerAttempt) {
        M.throwIfStopped();
        const state = M.getHpMpNumbers();
        const hpRatio = state.player.hp.cur / state.player.hp.max;
        if (hpRatio < sealLowHpThreshold) {
          await M.clickRecover();
          push(`[봉인 시도 ${attempt}] 내HP ${Math.round(hpRatio * 100)}% -> 회복`);
        } else {
          await M.clickTurn(5);
          rounds++;
        }
        for (const s of M.parseSealedAbilities(requiredSeals)) sealed.add(s);
        push(`[봉인 시도 ${attempt}, ${rounds}회차] sealed=${[...sealed].join(',')}`);
      }
      if (requiredSeals.every((a) => sealed.has(a))) {
        push('[봉인] 목표 어빌리티 전부 봉인 완료');
        sealSucceeded = true;
        break;
      }
      if (attempt === maxSealAttempts) break;
      push(`[봉인 시도 ${attempt}] 10턴 내 봉인 실패 - 도전 포기 후 재도전`);
      await M.abandonCurrentChallenge();
      await M.enterBossBattle(bossLabel, { hard: true });
    }
    if (!sealSucceeded) {
      throw new Error(`최대 ${maxSealAttempts}회 재도전에도 봉인(${requiredSeals.join(',')})에 실패했습니다.`);
    }

    // 2단계: 오늘 보스 속성에 맞는 딜 프리셋 적용 (없으면 applyBossPreset이 에러로 정지시킴)
    const element = M.getBossElementInBattle(bossLabel);
    if (!element) throw new Error('보스 속성을 화면에서 확인하지 못했습니다.');
    const dealPresetName = `${element} 딜`;
    await M.applyBossPreset(dealPresetName);
    push(`[딜] 오늘 속성(${element}) 기준 프리셋 "${dealPresetName}" 적용`);
    const effectiveDefenseDropThreshold =
      M.getCorruptedPurifierScrollDefenseThreshold(element, defenseDropThreshold);
    if (effectiveDefenseDropThreshold !== defenseDropThreshold) {
      push(
        `[딜] 일요일 어둠 속성 저확률 보정: 공격 스크롤 기준 ` +
        `방↓${defenseDropThreshold} → 방↓${effectiveDefenseDropThreshold}`
      );
    }

    // 3단계: 딜 - HP/MP 기준 회복/공격 반복, 방↓400 이상일 때마다 스크롤 재사용
    let state = M.getHpMpNumbers();
    let round = 0;
    let turnsSinceScroll = null; // null = 아직 스크롤 안 씀(즉시 사용 가능)
    let scrollExhausted = false;
    while (state.boss.hp.cur > 0 && round < maxDealRounds) {
      M.throwIfStopped();
      round++;
      const hpRatio = state.player.hp.cur / state.player.hp.max;
      const mpRatio = state.player.mp.cur / state.player.mp.max;
      if (hpRatio < dealHpThreshold || mpRatio < dealMpThreshold) {
        await M.clickRecover();
        push(`[딜 ${round}] HP ${Math.round(hpRatio * 100)}% / MP ${Math.round(mpRatio * 100)}% -> 회복`);
      } else {
        const defDrop = M.getLatestBossDefenseDrop();
        const scrollReady = !scrollExhausted && (turnsSinceScroll === null || turnsSinceScroll >= scrollDurationTurns);
        if (
          scrollReady &&
          defDrop !== null &&
          defDrop >= effectiveDefenseDropThreshold
        ) {
          try {
            await M.useScrolls(['공격']);
            push(
              `[딜 ${round}] 방↓${defDrop} >= ${effectiveDefenseDropThreshold} ` +
              '-> 공격 스크롤 사용'
            );
            turnsSinceScroll = 0;
          } catch (e) {
            scrollExhausted = true;
            push(`[딜 ${round}] 스크롤 사용 실패(소진 추정, 이후 공격만 반복): ${e.message}`);
          }
        }
        await M.clickTurn(1);
        if (turnsSinceScroll !== null) turnsSinceScroll++;
      }
      state = M.getHpMpNumbers();
      push(`[딜 ${round}] bossHp=${state.boss.hp.cur} myHp=${state.player.hp.cur}/${state.player.hp.max}`);
      if (state.boss.hp.cur <= 0) break;
    }

    await M.closeClearPopupIfAny();
    push('완료');
    return log;
  };

  // ⚠ 사용자 확인(2026-08): 목/토 패턴. 봉인은 월/화/일과 완전히 동일
  // (불굴+엔드 블로킹, HP 65% 이하면 회복). 봉인 완료 후 "{오늘속성} 방깎"
  // 프리셋으로 전환해 5턴씩 반복(HP 65% 이하면 회복) - 전투 로그의
  // "방↓N"이 400 이상 될 때까지. 그 다음 "{오늘속성} 딜" 프리셋으로 전환해
  // 공격 스크롤을 매번 사용하고 5턴 공격 반복(HP<70% 또는 MP<85%면
  // 회복) - 스크롤이 소진되면 스크롤 없이 5턴 공격만 계속 반복.
  // 실전 검증(2026-08, 바람 속성): 방깎 2사이클 만에 방↓540(400 이상)
  // 도달, 딜 2사이클로 보스 HP 100%→52%까지 감소 확인.
  M.runCorruptedPurifierSwordDefenseBreakPattern = async ({
    requiredSeals = ['불굴', '엔드 블로킹'],
    sealRoundsPerAttempt = 2, // 5턴씩 2회 = 10턴
    maxSealAttempts = 5,
    sealLowHpThreshold = 0.65,
    defBreakLowHpThreshold = 0.65,
    defenseDropThreshold = 400,
    maxDefRounds = 30,
    dealHpThreshold = 0.7,
    dealMpThreshold = 0.85,
    maxDealRounds = 200,
  } = {}) => {
    const bossLabel = BOSS_REGISTRY.corruptedPurifier.label;
    const log = [];
    const push = (line) => { log.push(line); if (M.uiLog) M.uiLog(line); };

    // 1단계: 봉인 (월/화/일 패턴과 완전히 동일)
    let sealed = new Set();
    let sealSucceeded = false;
    for (let attempt = 1; attempt <= maxSealAttempts; attempt++) {
      M.throwIfStopped();
      await M.applyBossPreset('봉인');
      push(`[봉인 시도 ${attempt}] 프리셋 적용`);
      sealed = M.parseSealedAbilities(requiredSeals);
      let rounds = 0;
      while (!requiredSeals.every((a) => sealed.has(a)) && rounds < sealRoundsPerAttempt) {
        M.throwIfStopped();
        const state = M.getHpMpNumbers();
        const hpRatio = state.player.hp.cur / state.player.hp.max;
        if (hpRatio < sealLowHpThreshold) {
          await M.clickRecover();
          push(`[봉인 시도 ${attempt}] 내HP ${Math.round(hpRatio * 100)}% -> 회복`);
        } else {
          await M.clickTurn(5);
          rounds++;
        }
        for (const s of M.parseSealedAbilities(requiredSeals)) sealed.add(s);
        push(`[봉인 시도 ${attempt}, ${rounds}회차] sealed=${[...sealed].join(',')}`);
      }
      if (requiredSeals.every((a) => sealed.has(a))) {
        push('[봉인] 목표 어빌리티 전부 봉인 완료');
        sealSucceeded = true;
        break;
      }
      if (attempt === maxSealAttempts) break;
      push(`[봉인 시도 ${attempt}] 10턴 내 봉인 실패 - 도전 포기 후 재도전`);
      await M.abandonCurrentChallenge();
      await M.enterBossBattle(bossLabel, { hard: true });
    }
    if (!sealSucceeded) {
      throw new Error(`최대 ${maxSealAttempts}회 재도전에도 봉인(${requiredSeals.join(',')})에 실패했습니다.`);
    }

    // ⚠ 사용자 확인(2026-08): 토요일은 보스의 실제 오늘 속성 자체가 항상
    // "빛"으로 고정되어 있다(게임 자체의 요일별 로테이션). 그래서 목요일과
    // 동일하게 화면에서 그대로 읽으면 되고, 별도 하드코딩은 불필요하다.
    const element = M.getBossElementInBattle(bossLabel);
    if (!element) throw new Error('보스 속성을 화면에서 확인하지 못했습니다.');

    const defBreakPresetName = `${element} 방깎`;
    const dealPresetName = `${element} 딜`;

    // ⚠ 사용자 확인(2026-08, 실전 확인): 정화자는 허무의 황제와 달리
    // 방어력 감소가 영구 누적이 아니라 일정 턴이 지나면 자연 회복된다
    // (실전 확인: 방↓540까지 쌓았다가 몇 턴 지나자 방↓188로 줄고 보스
    // 체력이 4.4%에서 29.2%로 다시 올라가는 것까지 확인함). 그래서
    // "방깎 한 번 400 채우고 그 뒤로 계속 딜만" 방식이 아니라, 방깎↔딜을
    // 보스가 죽을 때까지 계속 오간다: 방깎 프리셋으로 5턴씩 반복해 방↓400
    // 이상 만들고 → 딜 프리셋으로 전환해 스크롤(소진되면 생략)+5턴 공격을
    // 딱 1번만 하고 → 다시 방깎 프리셋으로 돌아가 반복.
    let scrollExhausted = false;
    let cycle = 0;
    let state = M.getHpMpNumbers();
    while (state.boss.hp.cur > 0 && cycle < maxDealRounds) {
      M.throwIfStopped();
      cycle++;

      // 방깎 단계: 방↓400 이상 될 때까지 5턴씩 반복
      await M.applyBossPreset(defBreakPresetName);
      push(`[사이클 ${cycle}] "${defBreakPresetName}" 프리셋 적용`);
      let defDrop = M.getLatestBossDefenseDrop() || 0;
      let defRounds = 0;
      while (defDrop < defenseDropThreshold && defRounds < maxDefRounds) {
        M.throwIfStopped();
        const s = M.getHpMpNumbers();
        const hpRatio = s.player.hp.cur / s.player.hp.max;
        if (hpRatio < defBreakLowHpThreshold) {
          await M.clickRecover();
          push(`[사이클 ${cycle}, 방깎] 내HP ${Math.round(hpRatio * 100)}% -> 회복`);
        } else {
          await M.clickTurn(5);
          defRounds++;
        }
        defDrop = M.getLatestBossDefenseDrop() ?? defDrop;
        push(`[사이클 ${cycle}, 방깎 ${defRounds}회차] 방어력감소=${defDrop}`);
      }
      if (defDrop < defenseDropThreshold) {
        push(`[사이클 ${cycle}] 경고: 최대 시도 내 방어력감소 ${defenseDropThreshold} 미도달(현재 ${defDrop}), 딜 단계로 진행`);
      }
      state = M.getHpMpNumbers();
      if (state.boss.hp.cur <= 0) break;

      // 딜 단계: HP 70% 미만 또는 MP 85% 미만이면 조건 맞을 때까지 회복,
      // 그 후 스크롤(소진되면 생략) + 5턴 공격 딱 1회만 하고 방깎으로 복귀
      await M.applyBossPreset(dealPresetName);
      push(`[사이클 ${cycle}] "${dealPresetName}" 프리셋 적용`);
      let recoverRounds = 0;
      state = M.getHpMpNumbers();
      let hpRatio = state.player.hp.cur / state.player.hp.max;
      let mpRatio = state.player.mp.cur / state.player.mp.max;
      while ((hpRatio < dealHpThreshold || mpRatio < dealMpThreshold) && recoverRounds < 10) {
        M.throwIfStopped();
        await M.clickRecover();
        recoverRounds++;
        state = M.getHpMpNumbers();
        hpRatio = state.player.hp.cur / state.player.hp.max;
        mpRatio = state.player.mp.cur / state.player.mp.max;
        push(`[사이클 ${cycle}, 딜] 회복 ${recoverRounds}회차 - HP ${Math.round(hpRatio * 100)}% MP ${Math.round(mpRatio * 100)}%`);
      }
      if (!scrollExhausted) {
        try {
          await M.useScrolls(['공격']);
          push(`[사이클 ${cycle}] 공격 스크롤 사용`);
        } catch (e) {
          scrollExhausted = true;
          push(`[사이클 ${cycle}] 스크롤 사용 실패(소진 추정, 이후 스크롤 없이 진행): ${e.message}`);
        }
      }
      await M.clickTurn(5);
      state = M.getHpMpNumbers();
      push(`[사이클 ${cycle}] bossHp=${state.boss.hp.cur} myHp=${state.player.hp.cur}/${state.player.hp.max}`);
    }

    await M.closeClearPopupIfAny();
    push('완료');
    return log;
  };

  // ⚠ 사용자 요청(2026-08): 요일에 따라 서로 다른 공략 패턴(월/화/일 vs
  // 목/토)을 자동으로 선택하는 진입점. BOSS_RUN_BY_JOB 등록/UI/필러
  // 대체 로직은 이 이름 하나만 참조하므로, 등록부는 건드리지 않고 여기서만
  // 요일별 위임 처리한다.
  M.runCorruptedPurifierSword = async (options = {}) => {
    const kstDay = M.getKstDayOfWeek();
    if (kstDay === 4 || kstDay === 6) {
      // 목=4, 토=6 (KST getUTCDay 기준)
      return await M.runCorruptedPurifierSwordDefenseBreakPattern(options);
    }
    return await M.runCorruptedPurifierSwordSealPattern(options);
  };

  // --- 허무의 황제 (검술 잡, HARD 전용, 공허의 황제 리스킨) --------------------
  // ⚠ 사용자 확인(2026-08): 허무의 황제는 공허의 황제(일반)를 재사용한
  // HARD 보스라 봉인 대상 어빌리티 이름이 동일하다: 타락의가호, 공허의지배,
  // 차원왜곡.
  //
  // 1) 봉인: "봉인" 프리셋, 5턴씩(최대 10턴, 재도전 포함), 내 HP 60% 미만
  //    이면 회복.
  // 2) 방깎: "방깎" 프리셋, 5턴씩 반복 - 전투 로그의 "보스: 방↓N"이 500
  //    이상 될 때까지(HP 50% 미만이면 회복).
  // 3) 마나흡수: "마나흡수" 프리셋, 5턴씩 반복 - 보스 마나 0 될 때까지
  //    (HP 50% 미만이면 회복).
  // 4) 정신일도 진입: "정신일도" 프리셋, 5턴 공격 1회. 최신 전투 로그에
  //    "공속↓"(공격속도 감소, 내게 걸린 디버프)이 남아있으면 1턴씩 추가
  //    공격해서 디버프가 로그에서 사라질 때까지 반복.
  // 5) 극딜 사이클(보스 죽을 때까지 반복):
  //    a. 내 물리 공격력이 1000 미만이면 정신일도로 1턴씩 추가 공격
  //    b. 내 HP 100% / MP 85% 이상 될 때까지 회복 반복(극딜 직전 필수 조건)
  //    c. "극딜" 프리셋 적용 → 공격 스크롤 사용(소진되면 생략하고 계속
  //       진행) → 5턴 공격
  //    d. 안 죽었으면 "정신일도"로 복귀해 사이클 반복
  M.runVoidEmperorHardSword = async ({
    requiredSeals = ['타락의가호', '공허의지배', '차원왜곡'],
    sealRoundsPerAttempt = 2, // 5턴씩 2회 = 10턴
    maxSealAttempts = 5,
    sealLowHpThreshold = 0.6,
    phaseLowHpThreshold = 0.5,
    defenseDropThreshold = 500,
    maxDefenseRounds = 30,
    maxManaRounds = 30,
    spiritFocusMinAttack = 1000,
    maxAttackWaitTurns = 20,
    maxDebuffWaitTurns = 20,
    dealHpThreshold = 1.0,
    dealMpThreshold = 0.85,
    maxRecoverRoundsPerCycle = 10,
    maxDealCycles = 60,
  } = {}) => {
    const bossLabel = BOSS_REGISTRY.voidEmperorEmpty.label;
    const log = [];
    const push = (line) => { log.push(line); if (M.uiLog) M.uiLog(line); };

    // 1단계: 봉인 (재도전 포함)
    let sealed = new Set();
    let sealSucceeded = false;
    for (let attempt = 1; attempt <= maxSealAttempts; attempt++) {
      M.throwIfStopped();
      await M.applyBossPreset('봉인');
      push(`[봉인 시도 ${attempt}] 프리셋 적용`);
      sealed = M.parseSealedAbilities(requiredSeals);
      let rounds = 0;
      while (!requiredSeals.every((a) => sealed.has(a)) && rounds < sealRoundsPerAttempt) {
        M.throwIfStopped();
        const state = M.getHpMpNumbers();
        const hpRatio = state.player.hp.cur / state.player.hp.max;
        if (hpRatio < sealLowHpThreshold) {
          await M.clickRecover();
          push(`[봉인 시도 ${attempt}] 내HP ${Math.round(hpRatio * 100)}% -> 회복`);
        } else {
          await M.clickTurn(5);
          rounds++;
        }
        for (const s of M.parseSealedAbilities(requiredSeals)) sealed.add(s);
        push(`[봉인 시도 ${attempt}, ${rounds}회차] sealed=${[...sealed].join(',')}`);
      }
      if (requiredSeals.every((a) => sealed.has(a))) {
        push('[봉인] 목표 어빌리티 전부 봉인 완료');
        sealSucceeded = true;
        break;
      }
      if (attempt === maxSealAttempts) break;
      push(`[봉인 시도 ${attempt}] 10턴 내 봉인 실패 - 도전 포기 후 재도전`);
      await M.abandonCurrentChallenge();
      await M.enterBossBattle(bossLabel, { hard: true });
    }
    if (!sealSucceeded) {
      throw new Error(`최대 ${maxSealAttempts}회 재도전에도 봉인(${requiredSeals.join(',')})에 실패했습니다.`);
    }

    // 2단계: 방깎
    await M.applyBossPreset('방깎');
    push('[방깎] 프리셋 적용');
    let defDrop = M.getLatestBossDefenseDrop() || 0;
    let defRounds = 0;
    while (defDrop < defenseDropThreshold && defRounds < maxDefenseRounds) {
      M.throwIfStopped();
      const state = M.getHpMpNumbers();
      const hpRatio = state.player.hp.cur / state.player.hp.max;
      if (hpRatio < phaseLowHpThreshold) {
        await M.clickRecover();
        push(`[방깎] 내HP ${Math.round(hpRatio * 100)}% -> 회복`);
      } else {
        await M.clickTurn(5);
        defRounds++;
      }
      defDrop = M.getLatestBossDefenseDrop() ?? defDrop;
      push(`[방깎 ${defRounds}회차] 방어력감소=${defDrop}`);
    }
    if (defDrop < defenseDropThreshold) {
      push(`[방깎] 경고: 최대 시도 내 방어력감소 ${defenseDropThreshold} 미도달(현재 ${defDrop}), 다음 단계로 진행`);
    }

    // 3단계: 마나흡수
    await M.applyBossPreset('마나흡수');
    push('[마나흡수] 프리셋 적용');
    let state = M.getHpMpNumbers();
    let manaRounds = 0;
    while (state.boss.mp.cur > 0 && manaRounds < maxManaRounds) {
      M.throwIfStopped();
      const hpRatio = state.player.hp.cur / state.player.hp.max;
      if (hpRatio < phaseLowHpThreshold) {
        await M.clickRecover();
        push(`[마나흡수] 내HP ${Math.round(hpRatio * 100)}% -> 회복`);
      } else {
        await M.clickTurn(5);
        manaRounds++;
      }
      state = M.getHpMpNumbers();
      push(`[마나흡수 ${manaRounds}회차] bossMp=${state.boss.mp.cur}`);
    }
    if (state.boss.mp.cur > 0) {
      push('[마나흡수] 경고: 최대 시도 내 보스 마나 0 미도달, 다음 단계로 진행');
    }

    // 4단계: 정신일도 진입 - 5턴 + 공속 디버프 해제 대기
    await M.applyBossPreset('정신일도');
    push('[정신일도] 프리셋 적용');
    await M.clickTurn(5);
    push('[정신일도] 5턴 공격 완료');
    let debuffWaitTurns = 0;
    while (M.isMyAttackSpeedDebuffActive() && debuffWaitTurns < maxDebuffWaitTurns) {
      M.throwIfStopped();
      await M.clickTurn(1);
      debuffWaitTurns++;
      push(`[정신일도] 공속 감소 디버프 잔존 - 1턴 추가 공격 (${debuffWaitTurns})`);
    }
    push('[정신일도] 공속 감소 디버프 해제 확인');

    await M.ensureCharacterCardExpanded();

    // 5단계: 극딜 사이클 반복
    let scrollExhausted = false;
    let dealCycle = 0;
    state = M.getHpMpNumbers();
    while (state.boss.hp.cur > 0 && dealCycle < maxDealCycles) {
      M.throwIfStopped();
      dealCycle++;

      // 5-1. 공격력 1000 이상 될 때까지 1턴씩 (정신일도 프리셋 유지 상태)
      let atkWaitTurns = 0;
      let myAtk = M.getMyPhysicalAttack();
      while (myAtk !== null && myAtk < spiritFocusMinAttack && atkWaitTurns < maxAttackWaitTurns) {
        M.throwIfStopped();
        await M.clickTurn(1);
        atkWaitTurns++;
        myAtk = M.getMyPhysicalAttack();
        push(`[극딜 사이클 ${dealCycle}] 공격력 ${myAtk}(목표 ${spiritFocusMinAttack}) - 1턴 추가 (${atkWaitTurns})`);
      }

      // 5-2. HP 100% / MP 85% 이상 될 때까지 회복 (극딜 직전 필수 조건)
      let recoverRounds = 0;
      state = M.getHpMpNumbers();
      let hpRatio = state.player.hp.cur / state.player.hp.max;
      let mpRatio = state.player.mp.cur / state.player.mp.max;
      while ((hpRatio < dealHpThreshold || mpRatio < dealMpThreshold) && recoverRounds < maxRecoverRoundsPerCycle) {
        M.throwIfStopped();
        await M.clickRecover();
        recoverRounds++;
        state = M.getHpMpNumbers();
        hpRatio = state.player.hp.cur / state.player.hp.max;
        mpRatio = state.player.mp.cur / state.player.mp.max;
        push(`[극딜 사이클 ${dealCycle}] 회복 ${recoverRounds}회차 - HP ${Math.round(hpRatio * 100)}% MP ${Math.round(mpRatio * 100)}%`);
      }

      // 5-3. 극딜 프리셋 + 스크롤(소진되면 생략) + 5턴
      // ⚠ 사용자 요청(2026-08, 실전 확인): 오늘 보스 속성이 "별"이면 일반
      // "극딜" 대신 전용 "별 극딜" 프리셋을 쓴다(실전 확인: "이 보스 전용"
      // 프리셋 목록에 "극딜"과 "별 극딜"이 서로 다른 항목으로 존재함).
      const todayElement = M.getBossElementInBattle(bossLabel);
      const dealPresetName = todayElement === '별' ? '별 극딜' : '극딜';
      await M.applyBossPreset(dealPresetName);
      push(`[극딜 사이클 ${dealCycle}] 프리셋 "${dealPresetName}" 적용`);
      if (!scrollExhausted) {
        try {
          await M.useScrolls(['공격']);
          push(`[극딜 사이클 ${dealCycle}] 공격 스크롤 사용`);
        } catch (e) {
          scrollExhausted = true;
          push(`[극딜 사이클 ${dealCycle}] 스크롤 사용 실패(소진 추정, 이후 스크롤 없이 진행): ${e.message}`);
        }
      }
      await M.clickTurn(5);
      state = M.getHpMpNumbers();
      push(`[극딜 사이클 ${dealCycle}] bossHp=${state.boss.hp.cur}`);
      if (state.boss.hp.cur <= 0) break;

      // 5-4. 다음 사이클을 위해 정신일도로 복귀
      await M.applyBossPreset('정신일도');
      push(`[극딜 사이클 ${dealCycle}] 다음 사이클 위해 정신일도 프리셋 복귀`);
    }

    await M.closeClearPopupIfAny();
    push('완료');
    return log;
  };

  // --- 타락한 수호자 (검술 잡, 일반) -------------------------------------------
  // 1) 봉인 프리셋으로 "불굴"+"엔드 블로킹" 봉인될 때까지 5턴씩 반복
  // 2) 마나 프리셋으로 보스 마나 0 될 때까지 10턴씩 반복
  // 3) 딜 프리셋 + 공격/집중 스크롤로 5턴씩 반복해 처치
  M.runFallenGuardian = async ({
    requiredSeals = ['불굴', '엔드 블로킹'],
    maxSealRounds = 15,
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
      throw new Error('수호자: 필수 봉인 미완료로 공격 단계를 차단합니다.');
    }
    if (stopped()) return { log, cleared: false };

    await M.applyBossPreset('딜');
    push('[2단계] 딜 프리셋 적용');
    let state = (await M.getValidHpMpNumbers());
    r = 0;
    let scrollsUsed = 0;
    while (state.boss.hp.cur > 0 && r < maxDealRounds) {
      if (stopped()) return { log, cleared: false };
      await recoverUntilSafe();
      if (M.canUseMoreBattleScrolls(scrollsUsed, 15)) {
        scrollsUsed = await M.useScrollsWithinLimit(['공격', '집중'], scrollsUsed);
        push(`[3단계] 공격/집중 스크롤 사용 (누적 ${scrollsUsed}/15장)`);
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
    maxManaRounds = 80,
    maxDealRounds = 30,
    lowHpThreshold = 0.7,
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
      const sealState = await M.getValidHpMpNumbers();
      if (sealState.player.hp.cur / sealState.player.hp.max <= lowHpThreshold) {
        await M.clickRecover();
      }
      await M.clickTurn(5);
      r++;
      for (const s of M.parseSealedAbilities([requiredSeal])) sealed.add(s); // 화면에 최근 로그만 남아 예전 정보를 잊지 않도록 누적
      push(`[1단계 ${r}회차] sealed=${[...sealed].join(',')}`);
    }
    if (!sealed.has(requiredSeal)) {
      throw new Error(`황제: 필수 봉인 "${requiredSeal}" 미완료로 다음 단계를 차단합니다.`);
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
      const manaHpRatio = state.player.hp.cur / state.player.hp.max;
      if (manaHpRatio <= lowHpThreshold) {
        await M.clickRecover();
        state = await M.getValidHpMpNumbers();
      }
      const turns = state.boss.mp.cur > 300 ? 5 : 1;
      await M.clickTurn(turns);
      r++;
      state = (await M.getValidHpMpNumbers());
      push(`[2단계 ${r}회차/${turns}턴] bossMp=${state.boss.mp.cur}/${state.boss.mp.max} bossHp=${state.boss.hp.cur}`);
    }
    if (state.boss.mp.cur > 0) {
      throw new Error(`황제: 보스 MP가 ${state.boss.mp.cur} 남아 딜 단계를 차단합니다.`);
    }
    if (stopped()) return { log, cleared: false };

    // 3단계: 딜 (스크롤 패턴 + 회복 개입)
    await M.applyBossPreset('딜');
    push('[3단계] 딜 프리셋 적용');

    state = (await M.getValidHpMpNumbers());
    let round = 0;
    let attackRound = 0;
    let scrollsUsed = 0;
    while (state.boss.hp.cur > 0 && round < maxDealRounds) {
      if (stopped()) return { log, cleared: false };
      round++;
      const myHpRatio = state.player.hp.cur / state.player.hp.max;
      if (myHpRatio <= lowHpThreshold) {
        await M.clickRecover();
        push(`[3단계 ${round}회차] 내HP ${Math.round(myHpRatio * 100)}% -> 회복`);
      } else {
        // 스크롤 패턴은 "실제 공격한 턴" 기준이어야 함 - round를 그대로
        // 쓰면 회복이 끼어들 때 스크롤을 공격 안 하는 회복턴에 낭비하거나
        // 패턴이 밀리는 문제가 있었음(같은 종류 버그가 인술 망령에서도
        // 지적됨).
        attackRound++;
        const pattern = [
          ['공격', '집중'],
          ['공격', '집중'],
          ['공격', '집중', '재생'],
        ];
        if (M.canUseMoreBattleScrolls(scrollsUsed, 15)) {
          const batch = pattern[(attackRound - 1) % pattern.length];
          scrollsUsed = await M.useScrollsWithinLimit(batch, scrollsUsed);
          push(`[3단계 스크롤 공격${attackRound}회차] ${batch.join('+')} (누적 ${scrollsUsed}/15장)`);
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
      push('[1단계] "노 컨디션" 미봉인 - 재도전 필요');
      return { log, cleared: false, retryRequired: true };
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
        push('[2단계] "휘감은 뿌리" 미봉인 - 재도전 필요');
        return { log, cleared: false, retryRequired: true };
      }
    } else {
      push('[2단계] 생략됨 (이미 봉인)');
    }
    if (stopped()) return { log, cleared: false };

    // 4단계: 정신일도 (5턴 1회 시도 - 회복이 개입했으면 그렇게 로그에 남김)
    // 검술 엔트의 핵심 단계다. 클릭 누락을 허용하면 정신일도를 쓰지 않은 채
    // 딜 프리셋으로 넘어가므로, 적용 토스트를 확인할 때까지 최대 3회 재시도한다.
    await M.applyBossPreset('정신일도', { requireConfirmation: true, attempts: 3 });
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
    let scrollsUsed = 0;
    while (state.boss.hp.cur > 0 && r < maxDealRounds) {
      if (stopped()) return { log, cleared: false };
      r++;
      const ratio = state.player.hp.cur / state.player.hp.max;
      if (ratio <= dealLowHpThreshold) {
        await M.clickRecover();
        push(`[4단계 ${r}회차] 내HP ${Math.round(ratio * 100)}% -> 회복 (스크롤 생략)`);
      } else {
        dealAttackRound++;
        if (M.canUseMoreBattleScrolls(scrollsUsed, 15)) {
          scrollsUsed = await M.useScrollsWithinLimit(['공격', '집중'], scrollsUsed);
          push(`[4단계 공격${dealAttackRound}회차] 공격+집중 스크롤 (누적 ${scrollsUsed}/15장)`);
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
    const turnBudget = M.createBattleTurnBudget();
    const recoverUntilSafe = async () => {
      for (let i = 0; i < 10; i++) {
        const state = await M.getValidHpMpNumbers();
        const ratio = state.player.hp.cur / state.player.hp.max;
        if (ratio > hpThreshold) return true;
        if (!(await turnBudget.spend(2, () => M.clickRecover()))) return false;
        push(`HP ${Math.round(ratio * 100)}% -> 회복`);
      }
      throw new Error('망령: 10회 회복 후에도 HP 70% 초과 실패');
    };
    const safeTurn = async (turns) => {
      if (!(await recoverUntilSafe())) return false;
      return turnBudget.spend(turns, () => M.clickTurn(turns));
    };

    // 공격 페이즈: 5턴 시도 후, 안 바뀌면 1턴씩 추가 시도 (버프 소멸 대기)
    const attackUntilFlip = async (label, maxTurns) => {
      const stance = await getStance();
      if (!(await safeTurn(5))) return false;
      let n = 5;
      let observed = await getStance();
      while (observed === stance && n < maxTurns) {
        if (stopped()) return false;
        if (!(await safeTurn(1))) return false;
        n++;
        observed = await getStance();
      }
      const ok = observed !== stance;
      push(`[${label}] ${n}턴만에 ${ok ? '전환 성공' : '전환 실패'}: ` + JSON.stringify(await M.getValidBossStance(bossLabel)));
      return ok;
    };
    // 수비 페이즈: 1턴씩 시도 (스크롤 재사용 없음)
    const defendUntilFlip = async (label) => {
      const stance = await getStance();
      let n = 0;
      let observed = stance;
      while (observed === stance && n < maxDefendTurns) {
        if (stopped()) return false;
        if (!(await safeTurn(1))) return false;
        n++;
        observed = await getStance();
      }
      const ok = observed !== stance;
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
        if (!(await turnBudget.spend(2, () => M.clickRecover()))) {
          push('⛔ 실제 150턴 예산 소진 - 전투 중단');
          break;
        }
        push(`[딜 ${round}] HP ${Math.round(hpRatio * 100)}% -> 회복`);
      } else if (mpRatio <= mpThreshold) {
        if (!(await turnBudget.spend(2, () => M.clickRecover()))) {
          push('⛔ 실제 150턴 예산 소진 - 전투 중단');
          break;
        }
        push(`[딜 ${round}] MP ${Math.round(mpRatio * 100)}% -> 회복`);
      } else {
        if (attackCounter % 5 === 0) {
          try { await M.useScrolls(['공격']); push(`[딜 ${round}] 공격 스크롤 사용`); }
          catch (e) { push(`[딜 ${round}] 스크롤 실패(잔여 소진 추정): ` + e.message); }
        }
        if (!(await turnBudget.spend(1, () => M.clickTurn(1)))) {
          push('⛔ 실제 150턴 예산 소진 - 전투 중단');
          break;
        }
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
    else if (!sealed.has('노 컨디션')) {
      push('[1단계] "노 컨디션" 미봉인 - 재도전 필요');
      return { log, cleared: false, retryRequired: true };
    }
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
      if (!sealed.has('휘감은 뿌리')) {
        push('[2단계] "휘감은 뿌리" 미봉인 - 재도전 필요');
        return { log, cleared: false, retryRequired: true };
      }
    } else { push('[2단계] 생략됨 (이미 봉인)'); }
    if (stopped()) return { log, cleared: false };

    await M.applyBossPreset('딜'); push('[3단계] 딜 프리셋 적용');
    let state = (await M.getValidHpMpNumbers()); r = 0;
    let scrollsUsed = 0;
    while (state.boss.hp.cur > 0 && r < maxDealRounds) {
      if (stopped()) return { log, cleared: false }; r++;
      const ratio = state.player.hp.cur / state.player.hp.max;
      if (ratio <= hpThreshold) {
        await M.clickRecover();
        push(`[3단계 ${r}회차] 내HP ${Math.round(ratio * 100)}% -> 회복 (스크롤 생략)`);
      } else {
        if (M.canUseMoreBattleScrolls(scrollsUsed, 15)) {
          scrollsUsed = await M.useScrollsWithinLimit(['공격', '집중'], scrollsUsed);
        }
        await M.clickTurn(5);
        push(`[3단계 ${r}회차] 스크롤 누적 ${scrollsUsed}/15장 후 5턴 공격`);
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
    const turnBudget = M.createBattleTurnBudget();
    const recoverUntilSafe = async () => {
      for (let i = 0; i < 10; i++) {
        const state = await M.getValidHpMpNumbers();
        const ratio = state.player.hp.cur / state.player.hp.max;
        if (ratio > hpThreshold) return true;
        if (!(await turnBudget.spend(2, () => M.clickRecover()))) return false;
        push(`HP ${Math.round(ratio * 100)}% -> 회복`);
      }
      throw new Error(`망령: 10회 회복 후에도 HP ${Math.round(hpThreshold * 100)}% 초과 실패`);
    };
    const safeTurn = async (turns) => {
      if (!(await recoverUntilSafe())) return false;
      return turnBudget.spend(turns, () => M.clickTurn(turns));
    };

    // 공격 페이즈: 5턴 시도 후, 안 바뀌면 1턴씩 추가 시도 (스크롤 없음)
    const attackUntilFlip = async (label, maxTurns) => {
      const stance = await getStance();
      if (!(await safeTurn(5))) return false;
      let n = 5;
      let observed = await getStance();
      while (observed === stance && n < maxTurns) {
        if (stopped()) return false;
        if (!(await safeTurn(1))) return false;
        n++;
        observed = await getStance();
      }
      const ok = observed !== stance;
      push(`[${label}] ${n}턴만에 ${ok ? '전환 성공' : '전환 실패'}: ` + JSON.stringify(await M.getValidBossStance(bossLabel)));
      return ok;
    };
    const defendUntilFlip = async (label) => {
      const stance = await getStance();
      let n = 0;
      let observed = stance;
      while (observed === stance && n < maxDefendTurns) {
        if (stopped()) return false;
        if (!(await safeTurn(1))) return false;
        n++;
        observed = await getStance();
      }
      const ok = observed !== stance;
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
        if (!(await turnBudget.spend(2, () => M.clickRecover()))) {
          push('⛔ 실제 150턴 예산 소진 - 전투 중단');
          break;
        }
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
        if (!(await turnBudget.spend(5, () => M.clickTurn(5)))) {
          push('⛔ 실제 150턴 예산 소진 - 전투 중단');
          break;
        }
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
  M.archeryRecoverUntilAbove = async (
    hpThreshold,
    mpThreshold = null,
    push = null,
    turnBudget = null
  ) => {
    for (let i = 0; i < 10; i++) {
      const state = await M.getValidHpMpNumbers();
      const hpRatio = state.player.hp.cur / state.player.hp.max;
      const mpRatio = state.player.mp.cur / state.player.mp.max;
      const needsHp = hpRatio <= hpThreshold;
      const needsMp = mpThreshold !== null && mpRatio <= mpThreshold;
      if (!needsHp && !needsMp) return state;
      if (turnBudget) {
        if (!(await turnBudget.spend(2, () => M.clickRecover()))) {
          throw new Error('궁술: 실제 전투 턴 예산이 부족해 회복을 중단합니다.');
        }
      } else {
        await M.clickRecover();
      }
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
    let scrollsUsed = 0;
    const scrollPattern = [
      ['공격', '집중'],
      ['공격', '집중'],
      ['공격', '집중', '재생'],
    ];
    for (let round = 1; state.boss.hp.cur > 0 && round <= maxDealRounds; round++) {
      if (M.stopRequested) return { log, cleared: false };
      await M.archeryRecoverUntilAbove(hpThreshold, null, push);
      attackRound++;
      if (M.canUseMoreBattleScrolls(scrollsUsed, 15)) {
        const batch = scrollPattern[(attackRound - 1) % scrollPattern.length];
        scrollsUsed = await M.useScrollsWithinLimit(batch, scrollsUsed);
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
    let scrollsUsed = 0;
    const scrollPattern = [
      ['공격', '집중'],
      ['공격', '집중'],
      ['공격', '집중', '재생'],
    ];
    for (let round = 1; state.boss.hp.cur > 0 && round <= maxDealRounds; round++) {
      if (M.stopRequested) return { log, cleared: false };
      await M.archeryRecoverUntilAbove(hpThreshold, null, push);
      attackRound++;
      if (M.canUseMoreBattleScrolls(scrollsUsed, 15)) {
        const batch = scrollPattern[(attackRound - 1) % scrollPattern.length];
        scrollsUsed = await M.useScrollsWithinLimit(batch, scrollsUsed);
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
    let scrollsUsed = 0;
    for (let round = 1; state.boss.hp.cur > 0 && round <= maxDealRounds; round++) {
      if (M.stopRequested) return { log, cleared: false };
      await M.archeryRecoverUntilAbove(hpThreshold, null, push);
      attackRound++;
      if (M.canUseMoreBattleScrolls(scrollsUsed, 15)) {
        const scrolls = attackRound % 2 === 1
          ? ['공격', '집중']
          : ['공격', '집중', '재생'];
        scrollsUsed = await M.useScrollsWithinLimit(scrolls, scrollsUsed);
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
    const turnBudget = M.createBattleTurnBudget();

    const safeTurn = async (turns, checkMp = false) => {
      await M.archeryRecoverUntilAbove(
        hpThreshold,
        checkMp ? mpThreshold : null,
        push,
        turnBudget
      );
      return turnBudget.spend(turns, () => M.clickTurn(turns));
    };
    const attackToDefense = async (firstCycle) => {
      const before = await stance();
      if (!(await safeTurn(5))) return false;
      let used = 5;
      let observed = await stance();
      while (observed === before && used < 8) {
        if (!(await safeTurn(1))) return false;
        used++;
        observed = await stance();
      }
      const ok = observed !== before;
      push(`[공격→수비] ${used}턴, ${ok ? '성공' : '실패'}`);
      return ok;
    };
    const defenseToAttack = async () => {
      const before = await stance();
      let used = 0;
      let observed = before;
      while (observed === before && used < maxDefendTurns) {
        if (!(await safeTurn(1))) return false;
        used++;
        observed = await stance();
      }
      const ok = observed !== before;
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
      await M.archeryRecoverUntilAbove(hpThreshold, null, push, turnBudget);
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
      await M.archeryRecoverUntilAbove(hpThreshold, mpThreshold, push, turnBudget);
      if (attacks % 5 === 0 && attackScrollsUsed < 5) {
        await M.useScrolls(['공격']);
        attackScrollsUsed++;
      }
      if (!(await turnBudget.spend(1, () => M.clickTurn(1)))) {
        push('⛔ 실제 150턴 예산 소진 - 전투 중단');
        break;
      }
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
  M.martialRecover = async (
    threshold,
    push = null,
    inclusive = true,
    turnBudget = null
  ) => {
    for (let i = 0; i < 10; i++) {
      const state = await M.getValidHpMpNumbers();
      const ratio = state.player.hp.cur / state.player.hp.max;
      const unsafe = inclusive ? ratio <= threshold : ratio < threshold;
      if (!unsafe) return state;
      if (turnBudget) {
        if (!(await turnBudget.spend(2, () => M.clickRecover()))) {
          throw new Error('체술: 실제 전투 턴 예산이 부족해 회복을 중단합니다.');
        }
      } else {
        await M.clickRecover();
      }
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
    let scrollsUsed = 0;
    for (let r = 0; state.boss.hp.cur > 0 && r < maxDealRounds; r++) {
      await M.martialRecover(hpThreshold, push);
      if (M.canUseMoreBattleScrolls(scrollsUsed, 15)) {
        scrollsUsed = await M.useScrollsWithinLimit(pattern[r % pattern.length], scrollsUsed);
      }
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
    hpThreshold = 0.7,
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
    let scrollsUsed = 0;
    for (let r = 0; state.boss.hp.cur > 0 && r < maxDealRounds; r++) {
      await M.martialRecover(hpThreshold, push);
      if (M.canUseMoreBattleScrolls(scrollsUsed, 15)) {
        scrollsUsed = await M.useScrollsWithinLimit(pattern[r % pattern.length], scrollsUsed);
      }
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

    // 방깎 10턴 -> 공격/집중 스크롤 -> 딜 5턴을 보스가 죽을 때까지 반복한다.
    // 스크롤은 15장 한도라 7회 반복(14장) 후 1장만 남는데,
    // useScrollsWithinLimit이 남은 장수만큼만 앞에서부터 골라 쓰므로 8회차엔
    // 자동으로 "공격" 한 장만 쓰고("집중"은 제외) 5턴 공격으로 이어진다.
    let state = await M.getValidHpMpNumbers();
    let scrollsUsed = 0;
    for (let r = 1; state.boss.hp.cur > 0 && r <= maxDealRounds; r++) {
      await M.applyBossPreset('방깎');
      await M.martialRecover(hpThreshold, push);
      await M.clickTurn(10);

      if (M.canUseMoreBattleScrolls(scrollsUsed, 15)) {
        try {
          scrollsUsed = await M.useScrollsWithinLimit(['공격', '집중'], scrollsUsed);
        } catch (e) {
          push(`스크롤 소진 확인: ${e.message}`);
          scrollsUsed = 15;
        }
      }

      await M.applyBossPreset('딜');
      await M.martialRecover(hpThreshold, push);
      await M.clickTurn(5);

      state = await M.getValidHpMpNumbers();
      push(`[딜 ${r}] bossHp=${state.boss.hp.cur}, 스크롤 ${scrollsUsed}/15`);
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
    const turnBudget = M.createBattleTurnBudget();

    const defenseToAttack = async () => {
      await M.applyBossPreset('수비');
      await M.martialRecover(0.25, push, true, turnBudget);
      const before = await stance();
      let observed = before;
      for (let n = 1; n <= maxDefenseTurns; n++) {
        if (!(await turnBudget.spend(1, () => M.clickTurn(1)))) return false;
        observed = await stance();
        if (observed !== before) return true;
      }
      return false;
    };

    const attackToDefense = async () => {
      await M.applyBossPreset('공격');
      await M.martialRecover(0.25, push, true, turnBudget);
      await M.useScrolls(['방어']);
      const before = await stance();
      if (!(await turnBudget.spend(5, () => M.clickTurn(5)))) return false;
      let used = 5;
      let observed = await stance();
      while (observed === before && used < 8) {
        if (!(await turnBudget.spend(1, () => M.clickTurn(1)))) return false;
        used++;
        observed = await stance();
      }
      push(`[공격→수비] ${used}턴`);
      return observed !== before;
    };

    // 첫 사이클: 기력발산 10턴 -> 극딜 5턴 -> 공격+방어스크롤.
    await M.applyBossPreset('기력발산');
    if (!(await turnBudget.spend(10, () => M.clickTurn(10)))) return { log, cleared: false };
    await M.applyBossPreset('극딜');
    if (!(await turnBudget.spend(5, () => M.clickTurn(5)))) return { log, cleared: false };
    if (!(await attackToDefense())) return { log, cleared: false, retryRequired: true };
    if (!(await defenseToAttack())) return { log, cleared: false };

    // 공격+집중 3회와 방어 3회를 교대로 사용하면, 첫 방어를 포함해 총 10장.
    for (let cycle = 1; cycle <= 3; cycle++) {
      await M.applyBossPreset('기력발산');
      if (!(await turnBudget.spend(10, () => M.clickTurn(10)))) return { log, cleared: false };
      await M.martialRecover(0.75, push, true, turnBudget);
      await M.useScrolls(['공격', '집중']);
      await M.applyBossPreset('극딜');
      if (!(await turnBudget.spend(5, () => M.clickTurn(5)))) return { log, cleared: false };
      if (!(await attackToDefense())) return { log, cleared: false, retryRequired: true };
      if (!(await defenseToAttack())) return { log, cleared: false };
    }

    await M.applyBossPreset('스크롤 이후');
    let state = await M.getValidHpMpNumbers();
    for (let r = 1; state.boss.hp.cur > 0 && r <= maxDealRounds; r++) {
      await M.martialRecover(0.7, push, false, turnBudget);
      if (!(await turnBudget.spend(5, () => M.clickTurn(5)))) {
        push('⛔ 실제 150턴 예산 소진 - 전투 중단');
        break;
      }
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
      if (M.canUseMoreBattleScrolls(scrollsUsed, 15)) {
        scrollsUsed = await M.useScrollsWithinLimit(['공격'], scrollsUsed);
      }
      await M.clickTurn(5);
      state = await M.getValidHpMpNumbers();
      push(`[딜 ${r}] bossHp=${state.boss.hp.cur}, 공격스크롤=${scrollsUsed}/15`);
    }
    const cleared = state.boss.hp.cur <= 0;
    if (cleared) await M.closeClearPopupIfAny();
    return { log, cleared };
  };

  M.runVoidEmperorMagic = async ({
    maxSealRounds = 15,
    maxManaRounds = 50,
    maxDealRounds = 50,
    hpThreshold = 0.7,
    drainedManaThreshold = 0,
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
      if (M.canUseMoreBattleScrolls(scrollsUsed, 15)) {
        scrollsUsed = await M.useScrollsWithinLimit(['공격'], scrollsUsed);
      }
      await M.clickTurn(5);
      state = await M.getValidHpMpNumbers();
      push(`[딜 ${r}] bossHp=${state.boss.hp.cur}, 공격스크롤=${scrollsUsed}/15`);
    }
    const cleared = state.boss.hp.cur <= 0;
    if (cleared) await M.closeClearPopupIfAny();
    return { log, cleared };
  };

  M.runVineEntMagic = async ({
    maxManaRecoveryRounds = 30,
    maxFinalCycles = 30,
    sealHpThreshold = 0.7,
    finalHpThreshold = 0.6,
  } = {}) => {
    const log = [];
    const push = (s) => { log.push(s); if (M.uiLog) M.uiLog(s); };
    const candidates = ['노 컨디션', '휘감은 뿌리'];
    let sealed = M.parseSealedAbilities(candidates);
    let burn = false;
    await M.applyBossPreset('봉인');
    for (let used = 0; !sealed.has('휘감은 뿌리') && used < 45; used += 5) {
      // 봉인/화상 단계도 실제 전투다. 딜 단계 전용 회복만 두면 약한
      // 캐릭터가 기믹 완료 전에 사망할 수 있으므로 매 공격 전에 70%를 보장한다.
      await M.magicRecover(sealHpThreshold, push);
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

    return global.__lanisSharedCoreAdapter || null;
  };
})(window);

window.__lanisSharedCoreBootstrap({ mode: 'manual' });
