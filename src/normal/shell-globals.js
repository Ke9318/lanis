  // ==========================================================================
  // 모듈 정의: 재전직 / 자동사냥 / 레어맵 / 던전 / 심층던전
  // ==========================================================================
  const MODULE_LABELS = {
    daily: '일일',
    rejob: '재전직',
    autohunt: '자동사냥',
    raremap: '레어맵',
    dungeon: '던전',
    arena: '아레나',
    preseason: '프리시즌',
    deepdungeon: '심층던전',
    guildboss: '길드보스',
    boss: '보스',
  };
  const moduleDisplayLabel = (moduleId) => MODULE_LABELS[moduleId] || moduleId;

  const Modules = {};

