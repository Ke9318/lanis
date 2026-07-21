// ==UserScript==
// @name         lanis
// @namespace    lanis
// @version      1.2.13
// @description  재전직 / 자동사냥 / 레어맵 / 던전 자동클리어 매크로를 하나의 패널로 통합. 탭으로 전환, 패널 위치 저장, 동시에 하나의 모듈만 실행되도록 보호.
// @match        https://lanis.me/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Ke9318/lanis/main/lanis.user.js
// @downloadURL  https://raw.githubusercontent.com/Ke9318/lanis/main/lanis.user.js
// ==/UserScript==

// ============================================================================
// 통합 매크로 v1.2
// v1.1 대비 수정 사항:
//   1) [던전] 모듈 신규 추가. 아래 5개 던전을 우선순위 순서로 순회하며 자동 클리어:
//        [구] 수행자의 탑: 상층부 > 수행자의 탑: 상층부 >
//        [구] 신비의 동굴 > 신비의 동굴 > 지하 하수도(일일 던전)
//      (일일 던전 중 깊은 숲 속 / 각성의 탑은 현재 비활성화 - 수동 처리)
//   2) [공용] 여러 창을 동시에 돌릴 때 클릭이 씹히거나 멈추는 문제 완화를 위해
//      클릭 사이 기본 지연을 늘림(기존 300~800ms → 500~1300ms). 특히 확인/모달류
//      클릭 뒤에는 다음 요소를 찾기 전 명시적으로 더 대기하도록 retryStep/waitFor
//      기반으로 처리.
//   3) [자동사냥] "보호용 기름 없이도 사냥" 체크옵션 추가. 체크하면 장비 보호(기름)가
//      풀린 상태여도 정지하지 않고 계속 사냥을 진행함(기본값: 미체크 = 기존 동작 유지).
//   4) [버그 수정] Core.allButtons()가 매크로 패널/배너 자체의 버튼(예: 숨겨진 배너의
//      "확인" 버튼)까지 포함해서 찾는 바람에, findButtonByText('확인')이 캐릭터 정보
//      모달의 진짜 확인 버튼 대신 숨겨진 배너 버튼을 잘못 클릭하던 문제 수정
//      (던전 입장이 항상 멈추던 원인). 패널/배너 하위 버튼은 항상 검색에서 제외.
//   5) [버그 수정] "던전 입장 확인" 팝업의 "입장" 버튼을 findButtonByText('입장')으로
//      찾았는데, 던전 목록 페이지 자체에 카드마다 "입장" 버튼이 여러 개 있어서 문서
//      전체에서 첫 번째로 매칭되는(팝업이 아닌 배경 목록의) "입장" 버튼을 잘못 클릭하던
//      문제 수정. Core.findButtonInDialog()를 추가해 모달 컨테이너 안으로 검색 범위를
//      좁혀서 "확인"/"입장" 등 흔한 텍스트의 버튼도 정확한 팝업 안에서만 찾도록 함.
//   6) [던전] 던전마다 매번 메뉴를 다시 열어 하나씩 입장권을 확인하던 방식을 개선.
//      던전 목록 화면을 한 번만 로드해서 5개 던전의 입장권/완료 여부를 전부 스캔한 뒤
//      "입장 가능한 던전 큐"를 확정하고, 그 큐만 순서대로 입장하도록 변경(불필요한
//      메뉴 재진입 제거로 속도 개선).
//   7) [버그 수정] 던전 완료 화면에서 "보상 받고 던전 나가기" 버튼을 찾기만 하면 바로
//      "클리어 완료"로 기록하던 문제 수정. 이제 버튼을 클릭한 뒤 실제로 완료 화면을
//      벗어난 것까지 확인해야만 클리어로 카운트함(보상 수령 = 클리어라는 원칙에 맞춤).
//   8) [던전] 전투 결과("승리!"/"패배..")를 못 찾으면 곧바로 던전 전체를 포기하고
//      정지하던 문제 완화 - 전투 시작/결과 확인을 최대 3회까지 재시도한 뒤에만 포기하도록
//      수정. 아직 진행 중인데(예: 3/15) 일시적 지연으로 결과를 못 읽어 통째로 멈추는
//      상황을 줄임.
//   9) [던전] 스크립트를 재시작했을 때 이미 던전 안(전투/상점/완료 화면)에 들어와 있는
//      상태라면, 던전 목록으로 돌아가 새로 입장하지 않고 화면에 표시된 던전 이름을
//      인식해서 바로 이어서 진행하도록 함(detectResumeDungeon).
//   10) [버그 수정] detectResumeDungeon()과 getDungeonCardEl()이 매크로 패널 자체에
//      있는 던전 이름 라벨(즉시완료 목표치 설정 UI)까지 검색 대상에 포함해서, 실제
//      게임 화면과 무관하게 항상 목록 맨 앞 던전으로 잘못 인식하던 문제 수정(예: 실제
//      화면은 "지하 하수도"인데 "[구] 수행자의 탑"으로 잘못 이어하기 시도함). 패널/배너
//      하위 요소는 항상 검색에서 제외하도록 수정.
//   11) [버그 수정] 상점 카드 인식(getShopCards)이 "텍스트 리프를 먼저 찾고 테두리
//      있는 조상을 역추적"하는 방식이었는데 실제로는 카드를 계속 못 찾아서(토큰만 계속
//      쌓이고 구매/리롤이 전혀 안 일어남) 사실상 상점 기능이 통째로 죽어 있었음.
//      등급 테두리 색(금/칠색/은/동)이 정해져 있다는 걸 이용해 "테두리 색이 일치하는
//      요소를 먼저 찾고 그 텍스트를 라벨로 쓰는" 방식으로 뒤집어서 재작성.
//   12) [버그 수정] 위 카드 라벨을 el.textContent로 읽었는데, textContent는 자식
//      요소 사이에 줄바꿈을 넣어주지 않아 라벨("행운 +98")과 바로 옆 가격 숫자("30")가
//      구분자 없이 붙어 "행운 +9830" 같은 엉뚱한 라벨로 파싱되는 문제가 있었음.
//      렌더링된 줄바꿈을 반영하는 el.innerText로 교체.
//   13) [던전] 전투 결과 확인이 반복 실패하다 뒤늦게 성공하는 경우가 잦아 클릭 사이
//      지연을 전반적으로 더 늘림(던전 모듈 전용: 대략 700~1400ms → 1100~2000ms 수준).
//   14) [버그 수정] 즉시완료(즉시 최상층 도전) 판단이 던전 진입 직후(진행도 0)에만
//      한 번 확인하고 끝났고, 그때 스탯이 기준 미달이면 이후 스탯이 올라 기준을 넘어도
//      다시는 확인하지 않던 문제 수정. "기준 미달로 아직 시도조차 안 한 경우"와
//      "실제로 도전했다가 진 경우"를 구분해서, 전자는 매 전투마다 계속 재확인하고
//      후자(실제 도전 후 결과가 난 경우)만 그 던전에서 다시 시도하지 않도록 함.
//   15) [개선] 캐릭터 카드의 "자세히"를 펼치면 실제 적중치/회피치 수치가 화면에 그대로
//      표시된다는 것을 확인함. 근사 공식(무기 무게 미반영)으로만 판단하던 것을, 이제
//      "자세히"를 자동으로 펼쳐서 실제 값을 우선 읽고, 확인이 안 될 때만 근사 공식으로
//      대체하도록 개선(ensureDetailsExpanded/readRealACEV/getCurrentACEV 추가).
//   16) [버그 수정] 이어하기(resume) 경로에서 instantClearTried를 무조건 true로 세워
//      즉시완료 자체를 아예 시도하지 않던 잔재 코드 제거. 매 전투 재확인 로직(14번)과
//      모순되어 이어하기 세션에서는 즉시완료가 영영 확인되지 않던 문제 수정.
//   17) [개선] "자세히"를 눌러도 적중치/회피치 텍스트가 안 나와 계속 근사 공식으로만
//      판단되던 경우가 있어, 클릭 1회+대기로 끝내지 않고 최대 3회까지 재시도하도록
//      강화. 그래도 실패하면 근사 공식으로 대체한다는 로그를 남겨 원인 추적이 쉽도록 함.
//   18) [버그 수정] 사용자 제보: "모든 스탯"을 살 수 있었는데도 구매하지 않고 넘어감.
//      isAllStatsLabel/parseStatLabel/isGodStrikeFamily 등 라벨 매칭 정규식이 전부
//      문자열 맨 앞(^) 고정 매칭이었는데, 라벨 앞에 예기치 않은 문자가 섞여 들어오면
//      매칭이 실패해 그냥 지나칠 수 있었음 → 전부 ^ 고정 없이 느슨하게 매칭하도록 완화.
//      또한 카드 선택→구매 클릭이 한 번에 안 먹히는 경우를 대비해 구매 시퀀스를 최대
//      2회까지 재시도하도록 보강.
//   19) [버그 수정] 사용자 제보: "자세히"는 힘/생명/정신/지능/행운/속도 원본 스탯과
//      직업/메인 어빌리티를 보여주는 버튼이었고, 적중치/회피치는 캐릭터 이름 옆의
//      화살표(▲/▼) 토글을 눌러야 나오는 완전히 별개의 버튼이었음. 엉뚱한 버튼("자세히")
//      을 누르고 있었으니 실제 값이 계속 안 나왔던 것 - 캐릭터 카드(무기/HP/MP가 함께
//      있는 컨테이너) 안에서 "자세히"가 아닌 버튼(이름 옆 토글)을 찾아 누르도록 수정.
//   20) [버그 수정] 실제 값 읽기가 정상화된 뒤 "즉시 최상층 도전"을 클릭해도 여전히
//      진행이 안 되던 문제 발견 - 클릭 후 별도의 확인 팝업("도전"/"취소")이 뜨는데
//      이를 처리하는 코드가 없어 확인을 안 누른 채 전투 결과만 기다리며 계속 실패하고
//      있었음. 팝업이 뜨면 Core.findButtonInDialog로 정확히 "도전" 버튼을 찾아 클릭하도록
//      추가.
//   21) [던전] "오늘 클리어한 던전" 개수가 새로고침/스크립트 재시작 때마다 0으로
//      초기화되던 것을 localStorage에 저장해서 유지되도록 함(loadClearCount/
//      saveClearCount). 날짜가 바뀌면 자동으로 0부터 다시 센다.
//   22) [던전] 위 21번은 클리어 개수였는데, 실제 요청은 GUI에 입력하는 설정값
//      (던전별 즉시완료 목표 적중치/회피치, 리롤 최소 토큰, 일일던전 체크)이 새로고침
//      할 때마다 초기화되는 문제였음 - 이 설정값들도 localStorage에 저장/복원하도록
//      추가(saveConfig/loadConfigIntoSelf, 패널 위치 저장 방식과 동일한 원리).
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
    // v1.2.1 버그 수정: 매크로 패널/배너 자체에도 "확인" 같은 흔한 텍스트의 버튼이 있어서
    // (예: 배너 닫기 버튼) findButtonByText가 게임 모달의 진짜 버튼 대신 숨겨진 패널/배너
    // 버튼을 잘못 집는 문제가 있었음(캐릭터 정보 모달의 "확인"을 못 누르던 원인).
    // 패널/배너 하위 버튼은 항상 제외하고 찾도록 수정.
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

  // v1.2.1 버그 수정: "확인", "입장" 같은 흔한 텍스트의 버튼은 페이지 안에 여러 개
  // 동시에 존재할 수 있음(예: 던전 목록의 카드마다 "입장" 버튼이 있음). 문서 전체에서
  // 첫 번째 매칭 버튼을 집는 findButtonByText를 모달 버튼에 쓰면 엉뚱한(배경의) 버튼을
  // 잘못 클릭하게 됨. dialogMarkerText를 포함하는 가장 좁은 컨테이너를 먼저 찾고,
  // 그 안에서만 buttonText 버튼을 찾도록 스코프를 좁힌 헬퍼.
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

  // 타이밍에 예민한 지점(팝업/버튼 렌더링 등)을 위한 재시도 헬퍼.
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

  // 클릭 하나 하고 나서 다음 조건이 충족될 때까지 여유있게 기다리는 헬퍼 (v1.2 신규).
  // 여러 창을 동시에 돌릴 때 "확인" 등을 너무 빨리 눌러 씹히던 문제 완화용.
  Core.clickAndWaitFor = async function (el, checkFn, { minDelay = 500, maxDelay = 1300, timeoutMs = 15000 } = {}) {
    el.click();
    await Core.humanDelay(minDelay, maxDelay);
    return Core.waitFor(checkFn, timeoutMs, 300);
  };

  // 상단 네비(전투/마을/캐릭) 클릭 후 드롭다운에서 정확히 일치하는 항목 클릭
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

  // 상단 네비 클릭 후 드롭다운에서 "접미어"로 끝나는 항목 클릭
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
    await Core.humanDelay(800, 1600);
    Core.log(moduleId, '전액 입금 완료');
    return true;
  };

  // 장비(무기/방어구/장신구) 수리
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
      return candidates.reduce((smallest, el) =>
        el.querySelectorAll('*').length < smallest.querySelectorAll('*').length ? el : smallest
      );
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
      await Core.humanDelay(500, 1000);
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
    await Core.humanDelay(500, 1000);

    const confirmDialog = await Core.waitFor(() => Core.bodyText().includes('사용하시겠습니까'), 3000);
    if (confirmDialog) {
      const confirmBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '사용');
      if (confirmBtn) {
        confirmBtn.click();
        await Core.humanDelay(500, 1000);
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
      ignoreProtectionOff: false, // 체크 시 보호용 기름(장비 보호)이 없어도 정지하지 않고 계속 사냥
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

  // -------------------------- 모듈 4: 던전 (v1.2 신규) --------------------------
  // 5개 던전을 아래 우선순위로 순회: 입장권이 있는 던전만 실제로 입장한다.
  //   [구] 수행자의 탑: 상층부 > 수행자의 탑: 상층부 > [구] 신비의 동굴 > 신비의 동굴 > 지하 하수도(일일)
  Modules.dungeon = {
    id: 'dungeon',
    running: false,
    stopRequested: false,
    cycleCount: 0, // 오늘 클리어한 던전 개수
    config: {
      enableDailySewer: true, // 일일 던전 중 "지하 하수도"만 자동화 대상 (깊은 숲속/각성의 탑은 비활성화)
      rerollMinTokens: 50, // 이 값 미만이면 리롤 안 하고 넘어가기
      // 던전별 즉시완료(즉시 최상층 도전) 시도 기준 - 0으로 두면 해당 던전은 즉시완료 시도 안 함.
      // 정확한 적중치/회피치는 게임 화면에 표시되지 않아, 아래 공식으로 근사 계산함(공격속도 ≈ 속도로 근사, 무기 무게 미반영 - 추후 보정 필요):
      //   회피치(EV) ≈ 지능*3.5 + 행운*2 + 속도*2
      //   적중치(AC) ≈ 정신*2.8 + 행운*1.6 + 속도*1.6
      instantClear: {
        oldMasterTower: { targetAC: 4000, targetEV: 4500 },
        masterTower: { targetAC: 4000, targetEV: 4500 },
        oldMysticCave: { targetAC: 5500, targetEV: 6000 },
        mysticCave: { targetAC: 5500, targetEV: 6000 },
        sewer: { targetAC: 0, targetEV: 0 }, // 확인된 기준치 없음 - 기본은 시도 안 함(0=비활성)
      },
    },
    // 실행 중 상태
    currentDungeonId: null,
    difficulty: '매우어려움', // 'shim' 상태에서 항상 최우선. 패배 시 '어려움'으로 하향(다시 못 올림).
    deathLimit: null,
    instantClearTried: false,
    boughtGodStrikeOrEquiv: false, // 신의 일격/일격필살/회심의 일격 (신비의동굴/수행자의탑: 동급 1회 한정)
    boughtSingleStat: {}, // { 속도:true, 행운:true, 정신:true, 지능:true, 힘:true, 생명:true, 체력:true, 마나:true }
    // 일일 던전(지하 하수도) 전용: 신의일격/일격필살/회심의일격을 개별 우선순위로 취급
    boughtGodStrike: false,
    boughtCertainHit: false, // 일격필살
    boughtCritStrike: false, // 회심의 일격
    boughtRegen: false,
  };

  // 던전 정의 (우선순위 순서 그대로)
  Modules.dungeon.DUNGEONS = [
    {
      id: 'oldMasterTower',
      label: '[구] 수행자의 탑: 상층부',
      requiredItemName: '수행자의 열쇠',
      daily: false,
      statMode: 'standard', // 속도/행운/정신/지능 각 1회, 금/칠색 등급만
      abilityMode: 'equalPriority', // 신의일격/일격필살/회심의일격 동급 취급
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
    },
    {
      id: 'sewer',
      label: '지하 하수도',
      requiredItemName: null,
      daily: true,
      statMode: 'extended', // 재생4/5, 힘/생명/체력/마나까지 포함
      abilityMode: 'ordered', // 신의일격 > 일격필살 > 회심의일격 순서 (동급 아님)
    },
  ];

  const STAT_TARGET_ORDER = ['속도', '행운', '정신', '지능'];
  const STAT_EXTENDED_ORDER = ['속도', '행운', '정신', '지능', '힘', '생명', '체력', '마나'];
  const GRADE_COLOR = {
    gold: 'rgb(255, 215, 0)', // 금 등급
    rainbow: 'rgb(255, 20, 147)', // 칠색 등급 (실제로는 진한 핑크색으로 렌더링됨)
  };

  Modules.dungeon.bodyTextClean = function () {
    return Core.bodyText();
  };

  // ---- 던전 목록 화면 파싱 ----
  Modules.dungeon.getDungeonCardEl = function (label) {
    const heading = [...document.querySelectorAll('*')].find(
      (el) =>
        el.children.length === 0 &&
        el.textContent.trim() === label &&
        !el.closest('#lrm-panel') &&
        !el.closest('#lrm-banner')
    );
    if (!heading) return null;
    // 카드 컨테이너: "입장" 버튼을 포함하는 가장 가까운 조상
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
    if (dungeonDef.daily) return Infinity; // 일일 던전은 별도 소모 아이템 없음(입장 횟수 공유로 별도 체크)
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

  // v1.2.2 신규: 던전 목록 화면에서 한 번에 5개 던전 전부의 입장권/완료 여부를 확인해
  // "입장 가능한 던전 큐"를 만든다. 예전에는 던전마다 매번 메뉴를 다시 열어 하나씩
  // 확인하느라 시간이 걸렸는데, 이제 목록 화면 한 번 로드로 전부 판단한다.
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

  // ---- 던전 입장 (캐릭터 정보 확인 모달 → 던전 입장 확인 모달) ----
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

    // 1) 캐릭터 정보 확인 모달
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

    // 캐릭터 정보 모달이 실제로 닫혔는지 확인 (안 닫혔으면 아직 남은 다른 확인 절차가 있을 수 있음)
    await Core.retryStep(
      '캐릭터 정보 모달 닫힘 확인',
      () => (!Core.bodyText().includes('캐릭터 정보') ? true : null),
      { attempts: 3, waits: [1000, 2000, 3000] }
    );

    // 2) 던전 입장 확인 모달 (사망 허용 횟수 파싱)
    const entryModalFound = await Core.retryStep(
      '던전 입장 확인 모달 찾기',
      () => (Core.bodyText().includes('던전 입장 확인') ? true : null),
      { attempts: 4, waits: [1000, 2000, 3000, 4000] }
    );
    if (!entryModalFound) {
      Core.log('dungeon', '"던전 입장 확인" 모달을 확인하지 못했습니다 (이미 입장됐을 수 있음).');
    } else {
      const deathMatch = Core.bodyText().match(/(\d+)\s*번\s*사망\s*시\s*던전에서\s*강제\s*퇴장/);
      this.deathLimit = deathMatch ? parseInt(deathMatch[1], 10) : null;
      Core.log('dungeon', `"${dungeonDef.label}" 부활 허용: ${this.deathLimit ?? '알 수 없음'}회`);

      const enterConfirmBtn = await Core.retryStep('던전 입장 확인 모달의 입장 버튼 찾기', () =>
        Core.findButtonInDialog('던전 입장 확인', '입장')
      );
      if (!enterConfirmBtn) {
        Core.log('dungeon', '입장 확인 버튼을 찾지 못했습니다.');
        return false;
      }
      enterConfirmBtn.click();
      await Core.humanDelay(1100, 2000);
    }

    const enteredBattle = await Core.retryStep('던전 전투 화면 진입 확인', () =>
      /진행도/.test(Core.bodyText()) ? true : null
    );
    if (!enteredBattle) {
      Core.log('dungeon', '던전 전투 화면 진입을 확인하지 못했습니다.');
      return false;
    }

    // 새 던전 진입 시 상태 초기화
    this.difficulty = '매우어려움';
    this.instantClearTried = false;
    this.boughtGodStrikeOrEquiv = false;
    this.boughtSingleStat = {};
    this.boughtGodStrike = false;
    this.boughtCertainHit = false;
    this.boughtCritStrike = false;
    this.boughtRegen = false;
    return true;
  };

  // ---- 진행도/전투 화면 ----
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

  // 캐릭터 스탯 읽기 (자세히 패널이 아니라 상단 요약 or 게임 메인 정보 패널의 힘/생명/정신/지능/행운/속도)
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

  // 무기 무게 데이터가 없어 공격속도 ≈ 속도로 근사 계산 (아래 getCurrentACEV의 폴백용)
  Modules.dungeon.estimateACEV = function () {
    const s = this.readStats();
    if (!s || s.속도 == null) return null;
    const atkSpeed = s.속도;
    const EV = (s.지능 || 0) * 3.5 + (s.행운 || 0) * 2 + atkSpeed * 2;
    const AC = (s.정신 || 0) * 2.8 + (s.행운 || 0) * 1.6 + atkSpeed * 1.6;
    return { AC, EV };
  };

  // v1.2.7: "자세히"를 펼치면 실제 적중치/회피치 수치가 화면에 그대로 표시된다는 것을
  // 확인함. 근사 공식 대신 이 실제 값을 우선 사용하도록 수정(근사식은 폴백으로만 유지).
  // v1.2.10 버그 수정: "자세히" 버튼은 힘/생명/정신/지능/행운/속도 원본 스탯과
  // 직업/메인 어빌리티를 보여주는 별개의 토글이었고, 적중치/회피치는 캐릭터 이름 옆의
  // 화살표(▲/▼) 토글을 눌러야 나오는 것이었음(사용자가 스크린샷으로 확인해줌).
  // 캐릭터 카드(무기/방어구/장신구 + HP/MP가 함께 있는 컨테이너) 안에서 "자세히"가
  // 아닌 버튼(이름 옆 화살표 토글)을 찾아 클릭하도록 수정.
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

  Modules.dungeon.tryInstantClear = async function (dungeonDef) {
    if (this.instantClearTried) return false;
    const target = this.config.instantClear[dungeonDef.id];
    if (!target || (!target.targetAC && !target.targetEV)) return false;

    const est = await this.getCurrentACEV();
    if (!est) return false;
    const tag = est.isReal ? '실제' : '추정';
    if (est.AC < target.targetAC || est.EV < target.targetEV) {
      Core.log(
        'dungeon',
        `즉시완료 기준 미달 (${tag} 적중 ${Math.round(est.AC)}/${target.targetAC}, ${tag} 회피 ${Math.round(est.EV)}/${target.targetEV}) → 다음 전투에서 다시 확인`
      );
      // v1.2.6 버그 수정: 여기서 instantClearTried를 true로 세우면 스탯이 나중에 기준을
      // 넘어도 다시는 확인하지 않게 됨(그래서 "회피/적중을 초과했는데도 즉완을 누르지
      // 않는다"는 문제가 발생). "실패"는 실제로 도전을 시도했다가 진 경우를 말하는
      // 것이므로, 기준 미달로 아직 시도조차 안 한 경우엔 플래그를 세우지 않고 다음
      // 전투에서 다시 확인하도록 둔다.
      return false;
    }

    const btn = Core.findButtonByText('즉시 최상층 도전');
    if (!btn || btn.disabled) {
      Core.log('dungeon', '"즉시 최상층 도전" 버튼을 사용할 수 없는 상태입니다 (캐릭터 등급 제한 등). 이후 재확인하지 않습니다.');
      this.instantClearTried = true; // 버튼 자체를 못 쓰는 경우는 스탯이 올라도 의미 없으므로 여기서만 비활성화
      return false;
    }
    Core.log('dungeon', `즉시완료 기준 충족 (${tag} 적중 ${Math.round(est.AC)}/${target.targetAC}, ${tag} 회피 ${Math.round(est.EV)}/${target.targetEV}) → 즉시 최상층 도전 시도`);
    btn.click();
    await Core.humanDelay(1100, 2000);
    // v1.2.11 버그 수정: "즉시 최상층 도전" 클릭 후 별도의 확인 팝업("도전"/"취소")이
    // 뜨는데 이걸 처리하는 코드가 없어서, 확인을 안 누른 채로 전투 결과만 기다리다
    // 계속 실패하던 문제 수정. 팝업이 뜨면 "도전" 버튼을 찾아 눌러서 확정한다.
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
    this.instantClearTried = true; // 실제로 도전을 시도했으므로 결과(승/패)와 무관하게 이후 재시도하지 않음
    return true;
  };

  Modules.dungeon.startBattle = async function () {
    await this.selectDifficultyTab();
    const btn = await Core.retryStep('전투 시작 버튼 찾기', () => Core.findButtonByText('전투 시작'));
    if (!btn) return false;
    btn.click();
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

  // ---- 상점 처리 ----
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

  // 상점 카드 3개를 { el, label, cost, gradeColor } 형태로 파싱
  // v1.2.4: 예전 방식(텍스트 리프를 먼저 찾고 테두리 있는 조상을 역추적)이 실제
  // 게임에서 카드 인식에 계속 실패해(토큰만 계속 쌓이고 구매/리롤이 전혀 안 됨) 아예
  // 안 통했던 것으로 확인됨. 등급 테두리 색(금/칠색/은/동)이 정해져 있다는 걸 이용해
  // "테두리 색이 일치하는 요소를 먼저 찾고, 그 요소의 텍스트를 라벨로 쓰는" 방식으로
  // 완전히 뒤집어서 재작성 - 수동 테스트 때 실제로 안정적으로 동작을 확인한 방식.
  Modules.dungeon.GRADE_COLORS_ALL = [
    'rgb(255, 215, 0)', // 금
    'rgb(255, 20, 147)', // 칠색
    'rgb(192, 192, 192)', // 은
    'rgb(205, 127, 50)', // 동
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
      // v1.2.5 버그 수정: el.textContent는 자식 요소 사이에 줄바꿈을 넣어주지 않아서,
      // 라벨("행운 +98")과 바로 옆의 가격 숫자("30")가 구분자 없이 그대로 붙어
      // "행운 +9830" 같은 엉뚱한 라벨로 파싱되는 문제가 있었음. 렌더링된 줄바꿈을
      // 반영하는 innerText를 사용해 첫 줄(라벨)만 정확히 가져오도록 수정.
      const label = (el.innerText || el.textContent).trim().split('\n')[0].trim();
      if (!label || label.length > 30 || seen.has(label)) continue;
      seen.add(label);
      cards.push({ selectEl: el, label, borderColor: getComputedStyle(el).borderColor });
      if (cards.length >= 3) break;
    }
    return cards;
  };

  // v1.2.9: 라벨 앞에 아이콘/공백 등 예기치 않은 문자가 섞여 들어와 ^ 고정 매칭이
  // 실패하는 사례가 있어(예: "모든 스탯 +42"를 못 알아보고 그냥 넘어감), 문자열 시작
  // 고정(^) 없이 어디에 있어도 매칭되도록 전부 완화함.
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

  // 우선순위대로 이번 상점에서 살 카드를 고른다. 없으면 null 반환.
  Modules.dungeon.pickShopCard = function (dungeonDef, cards, isLastShopBeforeBoss) {
    // 1) 어빌리티 (신의 일격 / 일격필살 / 회심의 일격)
    if (dungeonDef.abilityMode === 'equalPriority') {
      if (!this.boughtGodStrikeOrEquiv) {
        const abilityCard = cards.find((c) => this.isGodStrikeFamily(c.label));
        if (abilityCard) return { card: abilityCard, onBought: () => (this.boughtGodStrikeOrEquiv = true) };
      }
    } else {
      // 일일 던전: 신의일격 > 일격필살 > 회심의일격 순서
      if (!this.boughtGodStrike) {
        const c = cards.find((c) => /신의\s*일격/.test(c.label));
        if (c) return { card: c, onBought: () => (this.boughtGodStrike = true) };
      }
    }

    // 2) 모든 스탯 (수치 높은 것 우선)
    const allStatCards = cards.filter((c) => this.isAllStatsLabel(c.label));
    if (allStatCards.length > 0) {
      allStatCards.sort((a, b) => this.parseAllStatsValue(b.label) - this.parseAllStatsValue(a.label));
      return { card: allStatCards[0], onBought: () => {} };
    }

    // 3) (일일 던전만) 일격필살 > 회심의 일격
    if (dungeonDef.abilityMode === 'ordered') {
      if (!this.boughtCertainHit) {
        const c = cards.find((c) => /일격\s*필살/.test(c.label));
        if (c) return { card: c, onBought: () => (this.boughtCertainHit = true) };
      }
      if (!this.boughtCritStrike) {
        const c = cards.find((c) => /회심의\s*일격/.test(c.label));
        if (c) return { card: c, onBought: () => (this.boughtCritStrike = true) };
      }
      // 4) 재생4/5
      if (!this.boughtRegen) {
        const c = cards.find((c) => this.isRegenLabel(c.label));
        if (c) return { card: c, onBought: () => (this.boughtRegen = true) };
      }
    }

    // 5) 단일 스탯 (금/칠색 등급만, 스탯당 1회) - 던전 종류에 따라 대상 스탯 범위 다름
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

    // 6) 마지막 스테이지(15번째) 직전 상점: 위 우선순위에 맞는 게 없으면 아무거나 수치 높은 것 구매
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
    const isLastShopBeforeBoss = progress === 14; // 14번째 몬스터를 잡은 직후 상점 = 15번째(보스) 직전
    let rerollGuard = 0;
    while (this.running) {
      const tokens = this.getShopTokenCount();
      const cards = this.getShopCards();
      if (cards.length === 0) {
        Core.log('dungeon', '상점 카드를 파싱하지 못했습니다. 넘어가기를 시도합니다.');
        break;
      }

      const pick = this.pickShopCard(dungeonDef, cards, isLastShopBeforeBoss);
      if (pick) {
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
          // 구매하면 자동으로 다음 화면으로 넘어감
          return;
        }
        // 구매 실패(토큰 부족 등으로 선택이 안 먹었을 가능성) - 넘어가기로 폴백
        Core.log('dungeon', `"${pick.card.label}" 구매를 확인하지 못함(재시도 포함) - 넘어가기로 진행`);
        break;
      }

      // 우선순위에 맞는 게 없음: 토큰 충분하면 리롤, 아니면 넘어가기
      if (!isLastShopBeforeBoss && tokens >= this.config.rerollMinTokens && rerollGuard < 15) {
        const rerollBtn = Core.findButtonByText('리롤');
        if (rerollBtn && !rerollBtn.disabled) {
          rerollBtn.click();
          await Core.humanDelay(1100, 2000);
          rerollGuard += 1;
          continue;
        }
      }
      break;
    }

    const skipBtn = Core.findButtonByText('넘어가기');
    if (skipBtn) {
      skipBtn.click();
      await Core.humanDelay(1100, 2000);
    }
  };

  // ---- 한 던전 전체 클리어 루프 ----
  // opts.resume === true 이면 이미 던전 안에 들어와 있는 상태(스크립트 재시작 등)로 보고
  // enterDungeon()을 건너뛰고 현재 화면부터 바로 이어서 처리한다.
  Modules.dungeon.runOneDungeon = async function (dungeonDef, opts = {}) {
    if (!opts.resume) {
      Core.log('dungeon', `"${dungeonDef.label}" 입장 시도`);
      const entered = await this.enterDungeon(dungeonDef);
      if (!entered || !this.running) return false;
    } else {
      Core.log('dungeon', `"${dungeonDef.label}" 이미 진행 중이던 상태에서 이어서 진행합니다.`);
      // 이어하기 시에는 이전 실행에서 무엇을 샀었는지 알 수 없으므로 안전하게 리셋.
      // (최악의 경우 이미 가진 단일 스탯을 한 번 더 사는 정도의 사소한 손해만 발생)
      // v1.2.8 버그 수정: 여기서 instantClearTried를 true로 세우면 이어하기 세션에서는
      // 즉시완료를 영영 확인하지 않게 됨(스탯이 기준을 넘겨도 매 전투 재확인하는 최신
      // 로직과 모순됨). 이어하기여도 아직 실제로 도전한 적은 없으므로 false로 유지해서
      // 정상적으로 매 전투 재확인하도록 함.
      this.instantClearTried = false;
      this.boughtGodStrikeOrEquiv = false;
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
        // v1.2.3: 실제로 보상을 받고 화면을 벗어났는지 확인한 뒤에만 "클리어"로 카운트.
        // (버튼만 찾으면 바로 클리어로 기록하던 예전 로직은 클릭이 실패해도 클리어로
        // 잘못 기록될 수 있었음 - 보상 수령 = 클리어라는 원칙에 맞게 수정)
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

      // 전투 화면 (진행도 X/15, 난이도 선택 + 전투 시작)
      if (/이번\s*전투에서\s*상대할/.test(Core.bodyText())) {
        let result = null;
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
          if (!result) {
            Core.log('dungeon', `전투 결과 확인 실패 (시도 ${battleAttempt + 1}/3) - 재시도`);
            await Core.sleep(2000);
          }
        }

        if (result === 'win') {
          await this.clickBackFromResult();
          continue;
        }
        if (result === 'lose') {
          Core.log('dungeon', `전투 패배 (난이도: ${this.difficulty})`);
          if (this.difficulty === '매우어려움') {
            this.difficulty = '어려움';
            Core.log('dungeon', '매우어려움에서 패배 → 이후 어려움으로 난이도를 낮춰서 계속 진행 (다시 올리지 않음)');
          }
          const kickedOut = await Core.waitFor(() => !/진행도/.test(Core.bodyText()), 3000);
          await this.clickBackFromResult();
          if (kickedOut) {
            Core.log('dungeon', '부활 허용 횟수를 초과하여 던전에서 강제 퇴장된 것으로 보입니다.');
            return false;
          }
          continue;
        }
        Core.notifyStopped('dungeon', '전투 결과를 여러 번 재시도해도 확인하지 못했습니다. 화면 상태를 확인해주세요.');
        return false;
      }

      // 어느 화면인지 판별 못한 경우: 잠시 대기 후 재확인
      await Core.sleep(1500);
      if (!/진행도|아이템\s*상점|던전\s*완료\s*보상/.test(Core.bodyText())) {
        Core.log('dungeon', '알 수 없는 화면 상태 - 정지합니다.');
        return false;
      }
    }
    return false;
  };

  // v1.2.3 신규: 스크립트를 다시 시작했을 때 이미 던전 안(전투/상점/완료 화면)에
  // 들어와 있는 상태라면 그 던전 이름을 인식해서 이어서 진행할 수 있게 한다.
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

  const DUNGEON_CONFIG_KEY = 'lrm-dungeon-config'; // GUI 설정값(즉시완료 목표치, 리롤 기준 등) 저장용

  // v1.2.13: 적중치/회피치 즉시완료 목표치, 리롤 최소 토큰, 일일 던전 체크 등 GUI
  // 설정값이 새로고침할 때마다 초기화되던 것을 localStorage에 저장해서 유지되도록 함.
  Modules.dungeon.saveConfig = function () {
    try {
      localStorage.setItem(
        DUNGEON_CONFIG_KEY,
        JSON.stringify({
          enableDailySewer: this.config.enableDailySewer,
          rerollMinTokens: this.config.rerollMinTokens,
          instantClear: this.config.instantClear,
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
    } catch (e) {
      /* 저장된 값이 손상됐으면 기본값 그대로 사용 */
    }
  };

  const DUNGEON_CLEAR_COUNT_KEY = 'lrm-dungeon-cleared-today'; // 오늘 클리어한 던전 개수 저장용 (새로고침해도 유지)

  Modules.dungeon.getTodayDateStr = function () {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // v1.2.12 신규: "오늘 클리어한 던전" 개수가 페이지 새로고침/스크립트 재시작 때마다
  // 0으로 초기화되던 것을 localStorage에 저장해서 유지되도록 함. 날짜가 바뀌면(다음 날)
  // 자동으로 0부터 다시 센다.
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

    // 이미 던전 진행 중이던 화면이면(스크립트 재시작 등) 목록 화면으로 가지 않고 바로 이어서 처리
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

      // 이전 던전을 막 클리어했다면 "보상 받고 던전 나가기" 후 자동으로 던전 목록 화면에
      // 돌아와 있으므로, 목록 화면이 아닐 때만 메뉴를 통해 다시 이동한다(불필요한 재진입 방지).
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

    const protRow = document.createElement('div');
    protRow.style.cssText = 'display:flex; align-items:center; gap:6px; margin:4px 0;';
    const protCheck = document.createElement('input');
    protCheck.type = 'checkbox';
    protCheck.checked = mod.config.ignoreProtectionOff;
    protCheck.addEventListener('change', (e) => (mod.config.ignoreProtectionOff = e.target.checked));
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

  function buildDungeonTab(container) {
    const mod = Modules.dungeon;
    const refs = UIRefs.dungeon;
    mod.loadConfigIntoSelf(); // 저장된 GUI 설정값 복원 (즉시완료 목표치, 리롤 기준, 일일던전 체크)

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

    container.appendChild(labelEl('던전별 즉시완료 목표치 (0 = 즉시완료 시도 안 함)'));

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex; gap:4px; align-items:center; margin-bottom:2px;';
    const headerNameSpan = document.createElement('span');
    headerNameSpan.style.cssText = 'flex:1.4;';
    const headerAC = document.createElement('span');
    headerAC.textContent = '적중치';
    headerAC.style.cssText = 'flex:1; font-size:10px; color:#f5a623; text-align:center;';
    const headerEV = document.createElement('span');
    headerEV.textContent = '회피치';
    headerEV.style.cssText = 'flex:1; font-size:10px; color:#4fc3f7; text-align:center;';
    headerRow.appendChild(headerNameSpan);
    headerRow.appendChild(headerAC);
    headerRow.appendChild(headerEV);
    container.appendChild(headerRow);

    const instantInputs = [];
    mod.DUNGEONS.forEach((d) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:4px; align-items:center; margin-bottom:2px;';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = d.label;
      nameSpan.style.cssText = 'font-size:10px; color:#aaa; flex:1.4; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      const acInput = document.createElement('input');
      acInput.type = 'number';
      acInput.title = '목표 적중치';
      acInput.placeholder = '적중';
      acInput.value = mod.config.instantClear[d.id].targetAC;
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
      evInput.style.cssText = inputStyle() + 'flex:1;';
      evInput.addEventListener('change', (e) => {
        mod.config.instantClear[d.id].targetEV = parseInt(e.target.value, 10) || 0;
        mod.saveConfig();
      });
      row.appendChild(nameSpan);
      row.appendChild(acInput);
      row.appendChild(evInput);
      container.appendChild(row);
      instantInputs.push(acInput, evInput);
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

    // 배너
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

    // 저장된 위치 복원
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
    Core.log('core', '통합 매크로 패널 로드 완료 (재전직 / 자동사냥 / 레어맵 / 던전)');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();
