import { Suspense } from "react";
import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "로그인",
  robots: { index: false, follow: true },
  alternates: { canonical: "/login" },
};

// useSearchParams 는 Suspense 경계 필요 (Next 16).
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex flex-1" />}>
      <LoginForm />
    </Suspense>
  );
}
