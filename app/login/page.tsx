import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

// useSearchParams 는 Suspense 경계 필요 (Next 16).
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex flex-1" />}>
      <LoginForm />
    </Suspense>
  );
}
