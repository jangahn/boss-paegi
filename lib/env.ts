export const PUBLIC_ENV = {
  SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  SITE_URL: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
  // 공유·유입 분석 수집 게이트 — production 자동 on, 로컬은 NEXT_PUBLIC_ANALYTICS_ENABLED=1 로 켬(미설정 시 off).
  ANALYTICS_ENABLED:
    process.env.NEXT_PUBLIC_ANALYTICS_ENABLED === "1" || process.env.NODE_ENV === "production",
};
