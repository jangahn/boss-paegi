"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SERVICE_NAME } from "@/lib/policy";
import { useBfcacheReset } from "@/lib/use-bfcache-reset";
import { startOAuth, type OAuthProvider } from "@/lib/auth-oauth";
import { safeNext } from "@/lib/oauth-metadata";
import { Spinner } from "@/components/Spinner";
import { Paperclip, CornerFold } from "@/components/dossier";

function KakaoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#191600"
        d="M9 1.6c-4.2 0-7.6 2.66-7.6 5.94 0 2.12 1.42 3.98 3.57 5.03-.16.57-.57 2.07-.65 2.39-.1.4.15.4.3.29.12-.08 1.93-1.31 2.72-1.85.54.08 1.1.12 1.66.12 4.2 0 7.6-2.66 7.6-5.94S13.2 1.6 9 1.6z"
      />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.02-2.34z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.02 2.34C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

const ERROR_MESSAGES: Record<string, string> = {
  email_required: "이메일 제공에 동의해야 가입할 수 있어요. 다시 시도해주세요.",
  oauth: "로그인에 실패했어요. 다시 시도해주세요.",
  exchange: "로그인 처리 중 문제가 생겼어요. 다시 시도해주세요.",
  account_deleted: "탈퇴 처리된 계정이에요. 같은 계정으로는 다시 이용할 수 없어요.",
  age_required: "만 14세 이상만 이용할 수 있어요.",
};

export function LoginForm() {
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const rawAuto = params.get("auto");
  const auto: OAuthProvider | null =
    rawAuto === "kakao" || rawAuto === "google" ? rawAuto : null; // allowlist
  const errorKey = params.get("error");
  const errorMsg = errorKey ? ERROR_MESSAGES[errorKey] ?? ERROR_MESSAGES.oauth : null;

  const [busy, setBusy] = useState<OAuthProvider | null>(auto);
  const [err, setErr] = useState<string | null>(null);
  const [autoFailed, setAutoFailed] = useState(false);
  const autoStarted = useRef(false);

  // 자동 재로그인 (identity_already_exists 후) — useRef 로 StrictMode/재렌더 중복 실행 방지, 1회만.
  useEffect(() => {
    if (!auto || autoStarted.current) return;
    autoStarted.current = true;
    startOAuth(auto, { next, forceSignIn: true }).catch(() => {
      setAutoFailed(true);
      setBusy(null);
    });
  }, [auto, next]);

  // OAuth 페이지에서 뒤로가기 → bfcache 복원 시 React 상태(busy 스피너)가 그대로 살아나
  // 버튼이 로딩 상태로 방치되는 문제 해결(공유 훅 — credits/signup/reconsent 와 동일 패턴).
  useBfcacheReset(() => {
    setBusy(null); // 멈춘 스피너 해제 → 버튼 재활성
    autoStarted.current = false;
    if (auto) setAutoFailed(true); // 자동 재로그인 변형도 스피너 화면 풀고 버튼 노출
  });

  const onLogin = async (provider: OAuthProvider) => {
    if (busy) return;
    setBusy(provider);
    setErr(null);
    try {
      await startOAuth(provider, { next });
      // 성공 시 OAuth 페이지로 리다이렉트됨 (이 줄 도달 안 함).
    } catch {
      setErr("로그인을 시작하지 못했어요. 잠시 후 다시 시도해주세요.");
      setBusy(null);
    }
  };

  // 자동 재로그인 진행 중 — 버튼 대신 스피너 (거부 화면 없음).
  if (auto && !autoFailed) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <div className="flex flex-col items-center gap-4">
          <Spinner className="h-8 w-8" />
          <p className="text-sm text-zinc-500">로그인 중…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="relative flex w-full max-w-sm flex-col items-center gap-6 rounded-2xl border border-foreground/10 ui-surface px-7 pb-7 pt-10 shadow-sm">
        <Paperclip className="left-7" />
        <CornerFold />
        <Link href="/" className="font-display text-4xl tracking-tight text-ink">
          {SERVICE_NAME}
        </Link>
        <p className="text-base leading-relaxed text-zinc-600 dark:text-zinc-400">
          로그인하고 나만의 부장님을
          <br />
          만들어보세요.
        </p>

        {autoFailed && (
          <p className="w-full rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
            자동 로그인에 실패했어요. 아래 버튼으로 다시 시도해주세요.
          </p>
        )}
        {errorMsg && (
          <p className="w-full rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
            {errorMsg}
          </p>
        )}

        <div className="mt-2 flex w-full flex-col gap-3">
          <button
            type="button"
            onClick={() => void onLogin("kakao")}
            disabled={!!busy}
            className="flex items-center justify-center gap-2 rounded-xl bg-[#FEE500] py-4 text-base font-semibold text-[#191600] transition hover:opacity-90 disabled:opacity-50"
          >
            {busy === "kakao" ? <Spinner className="h-5 w-5" /> : <KakaoIcon />}
            카카오로 시작하기
          </button>
          <button
            type="button"
            onClick={() => void onLogin("google")}
            disabled={!!busy}
            className="flex items-center justify-center gap-2 rounded-xl border border-foreground/20 bg-white py-4 text-base font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:opacity-50"
          >
            {busy === "google" ? <Spinner className="h-5 w-5" /> : <GoogleIcon />}
            Google로 시작하기
          </button>
        </div>

        {err && <p className="text-sm text-red-400">{err}</p>}

        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
          계속 진행하면{" "}
          <Link href="/terms" className="underline underline-offset-2 hover:text-foreground">
            이용약관
          </Link>
          과{" "}
          <Link href="/privacy" className="underline underline-offset-2 hover:text-foreground">
            개인정보처리방침
          </Link>
          에 동의하는 것으로 간주됩니다.
        </p>
        <p className="text-xs leading-relaxed text-zinc-500">
          새 계정으로 가입하면 현재 비회원 기록(점수 등)이 이전됩니다. 기존 계정으로
          로그인하면 비회원 기록은 이전되지 않습니다.
        </p>
        <Link
          href="/"
          className="text-sm text-zinc-500 underline-offset-4 transition hover:text-foreground hover:underline"
        >
          ← 홈으로
        </Link>
      </div>
    </main>
  );
}
