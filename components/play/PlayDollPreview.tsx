"use client";

import { BASE_DOLLS, type BaseDollKey } from "@/lib/base-dolls";
import { PLAY_DOLL_TRANSITION, pendingPlayDollKey } from "@/lib/view-transition";

/**
 * 로딩 막의 캐릭터 카드(v1.65) — 홈 얼굴 · 갤러리 카드에서 누른 기본 캐릭터가 이 자리로 커지며 이어진다(View Transition 모핑).
 * 게임 화면은 주소를 읽기 전 서버 HTML 틀(Suspense fallback)부터 그리므로 틀 안에서는 누른 캐릭터(lib/view-transition.ts
 * `pendingPlayDollKey`)를, 게임 화면 안에서는 주소의 캐릭터(`doll`)를 보여 준다. 서버 HTML · 직접 진입 · 커스텀 캐릭터는 없음.
 * 이름은 React `<ViewTransition>` 이 아니라 CSS 로 직접 단다 — 이동 순간 그려지는 틀이 Suspense fallback 이라 React 가 짝을
 * 만들지 않는다. 캐릭터 링크의 전환 타입(`PLAY_TRANSITION`)이 루트 레이아웃 경계로 전환을 시작하고, 브라우저가 이름으로 짝짓는다.
 */
export function PlayDollPreview({ doll }: { doll?: BaseDollKey | null }) {
  const key = doll ?? pendingPlayDollKey();
  if (!key) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 정적 썸네일(384×512), 자리 고정
    <img
      src={BASE_DOLLS[key].thumb}
      alt=""
      width={120}
      height={160}
      className="h-40 w-30 object-contain"
      style={{ viewTransitionName: PLAY_DOLL_TRANSITION }}
    />
  );
}
