"use client";

import { createContext, useContext } from "react";
import type { SiteContent } from "@/lib/config/domains/site-content";

const Ctx = createContext<SiteContent | null>(null);

export function SiteContentProvider({
  value,
  children,
}: {
  value: SiteContent;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSiteContent(): SiteContent {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSiteContent must be used within SiteContentProvider");
  return v;
}
