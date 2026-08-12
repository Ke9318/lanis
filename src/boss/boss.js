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
          const moved = await M.waitFor(() => {
            const actual = M.readLiveBossEquipmentFingerprint();
            return M.bossEquipmentFingerprintMatches(
              verification.equipment,
              actual
            ) ? actual : null;
          }, 5000, 150);
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
        const result = await M.waitFor(
          () => {
            if (confirmationFailureText) return { failed: true };
            const actualEquipment = M.readLiveBossEquipmentFingerprint();
            if (
              M.bossEquipmentFingerprintMatches(expectedEquipment, actualEquipment) &&
              (!requiresFreshSuccessNotice || confirmationSuccessText)
            ) {
              return { failed: false, actualEquipment };
            }
            return null;
          },
          4000,
          150
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

  // ⚠ 허무의 황제 전용(2026-08, 사용자 확인): "공속"은 공격속도. 정신일도
  // 딜 단계에서 내게 걸린 공격속도 감소 디버프가 최신 전투 로그에 남아있는
  // 동안은 1턴씩 추가로 공격해서 디버프를 소진시켜야 한다.
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
  M.ensureElementForBoss = async (bossLabel) => {
    M.throwIfStopped();
    const startHistoryLength = history.length;
    const targetElement = M.getBossElementFromList(bossLabel);
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
    await M.waitFor(() => M.findBossCardActionButton(bossLabel), 8000, 200);
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
    // 일반/HARD 탭이 있으면 대상 탭 보장. 기존 4개 보스는 전부 일반 모드,
    // 타락한 정화자(하드)처럼 HARD 전용 보스는 hard:true로 호출한다.
    const targetTabLabel = hard ? 'HARD' : '일반';
    const targetTab = M.findButtonByText(targetTabLabel);
    if (targetTab) {
      M.throwIfStopped();
      targetTab.click();
      await M.sleep(300);
    }
    let btn = M.findBossCardActionButton(bossLabel);
    if (!btn) throw new Error(`"${bossLabel}" 카드에서 도전 버튼을 못찾음 (목록 페이지가 맞는지 확인 필요)`);
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
  M.driveToBossAndRun = async (key, jobOverride = null) => {
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
          if (!ALLOW_CLEARED_BOSS_TEST) {
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
          await M.ensureElementForBoss(entry.label);
          if (M.uiLog) M.uiLog(`🧭 "${entry.label}" 카드 찾는 중...`);
          await M.enterBossBattle(entry.label, { hard: !!entry.hard });
          // 기존엔 sleep(500) 뒤 딱 한 번만 확인해서, SPA 렌더가 조금만 느려도
          // 그 자리에서 "진입 실패"로 단정하고 큐를 통째로 중단했다. 같은 일을
          // 하는 일일 수호자 경로는 이미 waitFor로 10초를 기다리고 있어서 이 큐
          // 경로만 유독 취약했다. 동일하게 폴링 방식으로 맞춘다.
          const entered = await M.waitFor(() => M.isInBattleScreen(entry.label), 12000, 250);
          if (entered) {
            localStorage.removeItem(PENDING_KEY);
            return await runAndReport();
          }
          if (M.uiLog) {
            M.uiLog('⚠ 전투 화면 진입 확인 실패(12초 대기). ' + M.describeBattleEntryState(entry.label));
          }
        } catch (e) {
          if (M.uiLog) M.uiLog('⚠ ' + e.message);
        }
        return { entered: false, cleared: false };
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

    await M.waitFor(() => selected.some((key) => M.findBossCardActionButton(BOSS_REGISTRY[key].label)), 10000, 250);
    M.assertBossRunAuthorized(auth.id);
    await M.claimBossRewardsAndVerify();
    M.assertBossRunAuthorized(auth.id);

    const progressBefore = await Promise.all(selected.map(async (key) => ({
      key,
      label: BOSS_REGISTRY[key].label,
      progress: await M.getWeeklyRewardProgress(BOSS_REGISTRY[key].label),
    })));
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
      .filter((item) => !item.progress.exhausted && !M.isBossAlreadyCleared(item.label))
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
      // 공략 패턴이 있음(월/화/일만 - 목/토 방깎 패턴은 아직 미구현이라 여기
      // 넣지 않음, 나중에 추가되면 이 배열만 늘리면 됨), (2) 현재 선택된
      // 직업에 정화자 로직이 등록돼 있음(현재 검술만), (3) 오늘 정화자를
      // 아직 안 잡았음. 넷 다 맞으면 필러 대신 실전 투입한다.
      const purifierUserSelected = loadSelectedBosses().includes('corruptedPurifier');
      const IMPLEMENTED_PURIFIER_DAYS = [0, 1, 2]; // KST getUTCDay 기준: 일=0, 월=1, 화=2
      const todayKstDay = M.getKstDayOfWeek();
      let purifierRunName = null;
      try {
        purifierRunName = M.getRunFunctionName('corruptedPurifier');
      } catch (e) {
        purifierRunName = null;
      }
      const purifierAlreadyClearedToday = M.isBossAlreadyCleared(BOSS_REGISTRY.corruptedPurifier.label);
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
  M.startBossQueue = async (selectedKeys) => {
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

      const result = await M.driveToBossAndRun(key, q.job || M.getSelectedJob());
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
        await M.startBossQueue(checked);
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
  buildPanel();

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
  M.runCorruptedPurifierSword = async ({
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
        if (scrollReady && defDrop !== null && defDrop >= defenseDropThreshold) {
          try {
            await M.useScrolls(['공격']);
            push(`[딜 ${round}] 방↓${defDrop} >= ${defenseDropThreshold} -> 공격 스크롤 사용`);
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
      await M.applyBossPreset('극딜');
      push(`[극딜 사이클 ${dealCycle}] 프리셋 적용`);
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
