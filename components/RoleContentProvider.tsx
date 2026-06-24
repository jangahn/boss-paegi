"use client";

import { createContext, useContext } from "react";
import {
  ROLE_CONFIG_DEFAULT,
  roleFrom,
  type RoleConfig,
  type RoleFull,
} from "@/lib/config/domains/roles";
import type { RoleId } from "@/lib/roles";

// 서버(루트 레이아웃)에서 getRoleConfig() 로 읽은 롤 콘텐츠를 클라(시비멘트/반응/칩)에 주입.
// 롤 콘텐츠는 라이브 반영(보강#2 스냅샷 제외 대상) — 코스메틱이라 게임 중 변경돼도 안전.
const Ctx = createContext<RoleConfig>(ROLE_CONFIG_DEFAULT);

export function RoleContentProvider({
  value,
  children,
}: {
  value: RoleConfig;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 전체 롤 config (예: 칩 라벨 룩업). */
export function useRoleConfig(): RoleConfig {
  return useContext(Ctx);
}

/** 한 롤의 콘텐츠. */
export function useRoleContent(role: RoleId | string): RoleFull {
  return roleFrom(role, useContext(Ctx));
}
