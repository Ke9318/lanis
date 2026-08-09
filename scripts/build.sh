#!/bin/bash
# 결정론적 병합 빌드 스크립트.
# 순서 제약 (분석으로 확인됨, 2026-08):
#   1) core.js가 반드시 최상단 (Core 정의)
#   2) shell-globals.js(const Modules = {} 등)가 모든 Modules.X 정의보다 먼저
#   3) 8개 일반 모듈 파일은 서로 순서 무관 (함수 몸통 안 참조만 있어 정의 시점과 무관)
#   4) shell-runtime.js(Core.startModule, buildPanel, init 실행 트리거 등)가
#      모든 모듈 정의보다 반드시 뒤 — 특히 맨 끝의 init() 호출부가 전체 중 최후여야 함
#   5) boss.js는 완전히 독립된 두 번째 IIFE로, 첫 번째 IIFE 종료 후 이어붙임
set -e
cd "$(dirname "$0")/.."

HEADER=$(cat <<'HDR'
// ==UserScript==
// @name         lanis
// @namespace    lanis
// @version      __VERSION__
// @description  재전직 / 자동사냥 / 레어맵 / 던전 / 아레나 / 심층던전 / 개인 보스 / 일일 연속 자동화를 하나의 패널에서 제공하며 각 모듈의 실행 로직은 독립적으로 격리.
// @match        https://lanis.me/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Ke9318/lanis/main/lanis.user.js
// @downloadURL  https://raw.githubusercontent.com/Ke9318/lanis/main/lanis.user.js
// ==/UserScript==
HDR
)

VERSION="${1:?사용법: build.sh <version> (예: 1.13.54-stable)}"
OUT="lanis.user.js"

{
  echo "$HEADER" | sed "s/__VERSION__/$VERSION/"
  echo ""
  echo "(function () {"
  cat src/normal/core.js
  echo ""
  cat src/normal/shell-globals.js
  echo ""
  cat src/normal/daily.js
  echo ""
  cat src/normal/arena.js
  echo ""
  cat src/normal/rejob.js
  echo ""
  cat src/normal/autohunt.js
  echo ""
  cat src/normal/raremap.js
  echo ""
  cat src/normal/dungeon.js
  echo ""
  cat src/normal/deepdungeon.js
  echo ""
  cat src/normal/shell-runtime.js
  echo "})();"
  echo ""
  cat src/boss/boss.js
} > "$OUT"

echo "빌드 완료: $OUT ($(wc -l < "$OUT") 줄)"
