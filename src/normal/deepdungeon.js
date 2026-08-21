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
