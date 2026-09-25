import { Suspense } from "react";
import type { Metadata } from "next";
import { getBusinessInfo } from "@/lib/config/getters";
import { LoginForm, LoginFormFallback } from "./LoginForm";

export const metadata: Metadata = {
  title: "로그인",
  robots: { index: false, follow: true },
  alternates: { canonical: "/login" },
};

// useSearchParams 는 Suspense 경계 필요 (Next 16). 정적 페이지라 서버 HTML 에는 fallback 이 실린다 — 빈 값 대신 같은 카드(v1.60).
export default async function LoginPage() {
  // 탈퇴 계정 안내 분기의 고객센터 노출용 — 푸터는 /login 에서 self-hide 라
  // 약관·사업자 정보와 동일한 단일 소스(business_info)에서 직접 내려준다.
  const businessInfo = await getBusinessInfo();
  return (
    <Suspense fallback={<LoginFormFallback />}>
      <LoginForm supportEmail={businessInfo.info?.email} />
    </Suspense>
  );
}
