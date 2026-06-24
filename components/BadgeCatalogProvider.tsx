"use client";

import { createContext, useContext } from "react";
import {
  BADGE_CATALOG_DEFAULT,
  type BadgeCatalog,
} from "@/lib/config/domains/badges";

// 서버(루트 레이아웃)에서 getBadgeCatalog() 로 읽은 카탈로그를 클라(챌린지·컬렉션·종료 프리뷰)에 주입.
// 라이브·코드 기본값 폴백. 인증 grant 는 /api/score 서버가 별도로 getBadgeCatalog 직접 사용.
const Ctx = createContext<BadgeCatalog>(BADGE_CATALOG_DEFAULT);

export function BadgeCatalogProvider({
  value,
  children,
}: {
  value: BadgeCatalog;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBadgeCatalog(): BadgeCatalog {
  return useContext(Ctx);
}
