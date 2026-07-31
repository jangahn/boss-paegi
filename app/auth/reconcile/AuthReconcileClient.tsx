"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  AuthReconcileInput,
} from "@/lib/auth-reconcile";
import {
  clearBrowserSupabaseAuthStorageExclusive,
  reconcileBrowserSupabaseSession,
} from "@/lib/supabase/client";
import {
  reconcileDeletedAccountSignOut,
} from "@/lib/auth-oauth";
import { clearProfileCache } from "@/lib/profile";
import { clearSentryIdentity } from "@/lib/sentry-context";
import { Spinner } from "@/components/Spinner";

const RECONCILE_TIMEOUT_MS = 30_000;

export function AuthReconcileClient({
  input,
}: {
  input: AuthReconcileInput | null;
}) {
  const [failed, setFailed] = useState(false);
  const attemptRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback(() => {
    if (input === null) return;
    controllerRef.current?.abort(
      new Error("auth_reconcile_superseded"),
    );
    attemptRef.current += 1;
    const attempt = attemptRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(RECONCILE_TIMEOUT_MS),
    ]);
    void (async () => {
      if (input.reason === "auth_session_invalid") {
        await clearBrowserSupabaseAuthStorageExclusive(
          signal,
          input.cookiePath,
          input.cookieNames,
        );
      } else if (
        input.reason === "auth_session_check_required"
      ) {
        await reconcileBrowserSupabaseSession(
          {
            userId: input.expectedUserId,
            sessionId: input.expectedSessionId,
          },
          signal,
        );
        await clearBrowserSupabaseAuthStorageExclusive(
          signal,
          input.cookiePath,
          input.cookieNames,
        );
      } else {
        try {
          await reconcileDeletedAccountSignOut(
            {
              userId: input.expectedUserId,
              sessionId: input.expectedSessionId,
            },
            signal,
          );
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              error.message === "signout_session_invalid"
            )
          ) {
            throw error;
          }
        }
        await clearBrowserSupabaseAuthStorageExclusive(
          signal,
          input.cookiePath,
          input.cookieNames,
        );
      }
      clearProfileCache();
      clearSentryIdentity();
      window.location.replace(input.next);
    })().catch((error: unknown) => {
      if (
        error instanceof Error &&
        (
          error.message === "auth_reconcile_session_changed" ||
          error.message === "signout_session_invalid"
        )
      ) {
        // Another tab completed a newer login after the proxy redirect. The
        // stale expected UUIDs have caused no mutation; let the proxy judge
        // the newly current session instead of trapping it on this page.
        window.location.replace(input.next);
        return;
      }
      if (
        !controller.signal.aborted &&
        attemptRef.current === attempt
      ) {
        setFailed(true);
      }
    });
  }, [input]);

  useEffect(() => {
    run();
    return () => {
      attemptRef.current += 1;
      controllerRef.current?.abort(
        new Error("auth_reconcile_disposed"),
      );
      controllerRef.current = null;
    };
  }, [run]);

  if (input === null) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
        <h1 className="text-xl font-semibold">
          세션 복구 요청을 확인할 수 없어요
        </h1>
        <Link className="text-sm underline" href="/login">
          로그인 화면으로 이동
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-semibold">
        {failed
          ? "로그인 상태를 확인하지 못했어요"
          : "로그인 상태를 안전하게 확인하고 있어요"}
      </h1>
      {failed ? (
        <>
          <p className="text-sm text-zinc-500">
            네트워크가 복구된 뒤 다시 시도해 주세요.
          </p>
          <button
            type="button"
            className="rounded-full border px-4 py-2 text-sm"
            onClick={() => {
              setFailed(false);
              run();
            }}
          >
            다시 시도
          </button>
        </>
      ) : (
        <Spinner className="h-5 w-5" />
      )}
    </main>
  );
}
