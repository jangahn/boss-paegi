"use client";

import { createContext, useContext } from "react";
import {
  SESSION_LIMITS_DEFAULT,
  type SessionLimits,
} from "@/lib/config/domains/session";

// 서버(루트 레이아웃)에서 getSessionLimits() 로 읽은 강제종료 한도를 클라(play)에 주입.
// 게임은 시작 시 1회 읽어 ref 로 동결(게임 중 마케터 변경은 진행 판에 무영향).
const Ctx = createContext<SessionLimits>(SESSION_LIMITS_DEFAULT);

export function SessionLimitsProvider({
  value,
  children,
}: {
  value: SessionLimits;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSessionLimits(): SessionLimits {
  return useContext(Ctx);
}
