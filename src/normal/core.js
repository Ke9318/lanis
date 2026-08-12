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
    shouldCancel = Core.defaultShouldCancel
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
        beforeMin: 500,
        beforeMax: 1000,
        shouldCancel,
      }))) {
        throw new Error(`상단 메뉴 "${navLabel}" 버튼이 클릭 직전에 사라짐`);
      }
      const item = await Core.waitFor(findItem, 15000, 300, shouldCancel);
      if (!item) throw new Error(`메뉴 항목 "${itemText}"를 찾을 수 없음`);
      if (!(await Core.safeClick(findItem, { shouldCancel }))) {
        throw new Error(`메뉴 항목 "${itemText}"가 클릭 직전에 사라짐`);
      }
    };
    // 이전 화면 전환 중 남아있던 메뉴 항목은 클릭하는 순간 스스로 닫혀
    // 사라질 수 있다. 그 첫 시도가 실패해도 곧장 예외를 던지지 않고,
    // "캐릭" 버튼을 새로 눌러 메뉴를 여는 정상 경로로 재시도한다.
    if (findItem() && (await Core.safeClick(findItem, { shouldCancel }))) return;
    await openFresh();
  };

  Core.clickNavMenuSuffix = async function (
    navLabel,
    suffixText,
    shouldCancel = Core.defaultShouldCancel
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
        beforeMin: 500,
        beforeMax: 1000,
        shouldCancel,
      }))) {
        throw new Error(`상단 메뉴 "${navLabel}" 버튼이 클릭 직전에 사라짐`);
      }
      const item = await Core.waitFor(findItem, 15000, 300, shouldCancel);
      if (!item) throw new Error(`메뉴 항목("...${suffixText}")을 찾을 수 없음`);
      if (!(await Core.safeClick(findItem, { shouldCancel }))) {
        throw new Error(`메뉴 항목("...${suffixText}")이 클릭 직전에 사라짐`);
      }
    };
    // clickNavMenuExact와 동일한 이유로, 재사용하려던 메뉴 항목의 첫 클릭이
    // 실패해도 곧장 실패 처리하지 않고 메뉴를 새로 열어 재시도한다.
    if (findItem() && (await Core.safeClick(findItem, { shouldCancel }))) return;
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
    Core.playStopSound();
    Core.stopModule(moduleId);
  };

  Core.notifyCompleted = function (moduleId, msg) {
    Core.moduleResults[moduleId] = { ok: true, message: msg, at: Date.now() };
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

