"use client";

import { LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";

const loadFeatures = () => import("@/lib/motion-features").then((mod) => mod.default);

/**
 * Motion 공급자(v1.65) — 루트 레이아웃에 한 번. `strict` 라 전체 `motion.*` 컴포넌트는 쓸 수 없고 가벼운 `m.*` 만 쓴다.
 * 기능 묶음은 비동기(`lib/motion-features.ts`), 모션 감소 설정은 사용자 OS 설정을 따른다(`reducedMotion="user"`).
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
