"use client";

import { createContext, useContext } from "react";
import {
  SCORE_CONFIG_DEFAULT,
  type ScoreConfig,
} from "@/lib/config/domains/score";

// 서버(루트 레이아웃)에서 getScoreConfig() 로 읽은 등급을 클라(GameOverModal)에 주입. 라이브·코드 기본값 폴백.
const Ctx = createContext<ScoreConfig>(SCORE_CONFIG_DEFAULT);

export function ScoreConfigProvider({
  value,
  children,
}: {
  value: ScoreConfig;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useScoreConfig(): ScoreConfig {
  return useContext(Ctx);
}
