"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import { ModalShell } from "@/components/ModalShell";
import { LegalDocView } from "@/components/legal/LegalDocView";
import { useBfcacheReset } from "@/lib/use-bfcache-reset";
import { SERVICE_NAME } from "@/lib/policy";
import { getMyProfile, writeCachedProfile, clearProfileCache } from "@/lib/profile";
import { signOut } from "@/lib/auth-oauth";
import { firstTouchSourceForConversion } from "@/lib/acquisition";
import { parseAccountConsentHttpAck } from "@/lib/account-http-contract";
import type { ConsentItem } from "@/lib/consent";
import type { LegalSection } from "@/lib/legal/types";
import {
  clientMutationResponseNeedsReconciliation,
  runReplayedJsonMutation,
} from "@/lib/client-mutation";

/** /consent 서버가 내려주는 약관/방침 전문(인라인 "보기" 모달용). */
export type LegalDocLite = {
  title: string;
  sections: LegalSection[];
  version: number;
  effectiveDate: string | null;
};

const ITEM_LABEL: Record<ConsentItem, string> = {
  age: "본인은 만 14세 이상입니다. (만 14세 미만은 이용할 수 없습니다.)",
  terms: "이용약관에 동의합니다.",
  privacy:
    "개인정보처리방침 및 국외 이전(미국·싱가포르 등 클라우드/AI 사업자)에 동의합니다.",
};

/**
 * 통합 동의 폼 — 글로벌 게이트(proxy)가 미동의 로그인 사용자를 보냄. 서버가 산출한 필요 항목(items)만 표시.
 * 약관/방침 "보기"는 **인라인 모달**(네비게이션 없음). [동의하고 시작]→원래 목적지(next)로.
 * **[로그아웃]→로그아웃**(미동의 시 유일한 비동의 선택지 — 모든 페이지가 /consent 로 가니 돌아갈 곳 없음).
 */
export function ConsentForm({
  items,
  next,
  docs,
}: {
  items: ConsentItem[];
  next: string;
  docs: Partial<Record<ConsentItem, LegalDocLite | null>>;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ConsentItem | null>(null);
  const mountedRef = useRef(false);
  const busyRef = useRef(false);
  const operationEpochRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationEpochRef.current += 1;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
    };
  }, []);

  // 같은 탭 이동 → 뒤로가기(bfcache) 시 멈춘 스피너 해제.
  useBfcacheReset(() => {
    operationEpochRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    busyRef.current = false;
    setBusy(false);
  });

  const all = items.every((i) => checked[i]);
  // 약관/방침 항목인데 전문 로드 실패(서버 조회 일시 오류) → 동의 차단(읽지 못한 채 동의 방지, B10).
  const docLoadFailed = items.some((i) => (i === "terms" || i === "privacy") && !docs[i]);
  const toggle = (id: ConsentItem) => setChecked((p) => ({ ...p, [id]: !p[id] }));

  const submit = async () => {
    if (busyRef.current || !all) return;
    busyRef.current = true;
    const operationEpoch = operationEpochRef.current + 1;
    operationEpochRef.current = operationEpoch;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), 12_000);
    let navigating = false;
    setBusy(true);
    setErr(null);
    try {
      const payload: Record<string, boolean | number> = {};
      items.forEach((i) => (payload[i] = true));
      if (items.includes("terms") && docs.terms) {
        payload.termsVersion = docs.terms.version;
      }
      if (items.includes("privacy") && docs.privacy) {
        payload.privacyVersion = docs.privacy.version;
      }
      const requestBody = JSON.stringify({
        ...payload,
        acqSource: firstTouchSourceForConversion(),
      });
      const outcome = await runReplayedJsonMutation({
        input: "/api/account/consent",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        },
        signal: controller.signal,
        classify: (response, body) => {
          if (
            response.ok &&
            parseAccountConsentHttpAck(body)
          ) {
            return { kind: "confirmed", value: true };
          }
          const error =
            body &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            typeof (body as Record<string, unknown>).error ===
              "string"
              ? String((body as Record<string, unknown>).error)
              : null;
          if (
            clientMutationResponseNeedsReconciliation(
              response.status,
              response.ok,
            )
          ) {
            return {
              kind: "unconfirmed",
              reason: "consent_response_unconfirmed",
              error,
            };
          }
          return {
            kind: "rejected",
            error: error ?? `consent_http_${response.status}`,
          };
        },
      });
      if (
        !mountedRef.current ||
        operationEpochRef.current !== operationEpoch
      ) {
        return;
      }
      if (outcome.kind === "confirmed") {
        // 성공 응답 뒤 프로필 캐시 최적화가 지연돼도 목적지 이동을
        // 막지 않는다. 캐시는 먼저 비우고 best-effort로 다시 채운다.
        clearProfileCache();
        void getMyProfile()
          .then((p) => {
            if (p) writeCachedProfile(p.id, p);
          })
          .catch(() => {
            /* 캐시는 비워졌으므로 다음 계정 조회가 권위값을 다시 읽음 */
          });
        router.replace(next);
        navigating = true;
        return;
      }
      const error =
        outcome.kind === "rejected" &&
        typeof outcome.error === "string"
          ? outcome.error
          : null;
      if (error === "account_deleted") {
        window.location.assign("/login?error=account_deleted");
        navigating = true;
        return;
      }
      if (error === "legal_version_changed") {
        window.location.reload();
        navigating = true;
        return;
      }
      setErr("처리에 실패했어요. 잠시 후 다시 시도해주세요.");
    } catch {
      if (
        mountedRef.current &&
        operationEpochRef.current === operationEpoch
      ) {
        setErr("네트워크 오류 — 다시 시도해주세요.");
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (requestAbortRef.current === controller) {
        requestAbortRef.current = null;
      }
      if (
        !navigating &&
        mountedRef.current &&
        operationEpochRef.current === operationEpoch
      ) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const logout = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const operationEpoch = operationEpochRef.current + 1;
    operationEpochRef.current = operationEpoch;
    setBusy(true);
    setErr(null);
    try {
      await signOut();
    } catch {
      if (
        mountedRef.current &&
        operationEpochRef.current === operationEpoch
      ) {
        setErr("로그아웃을 완료하지 못했어요. 다시 시도해주세요.");
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const viewingDoc = viewing ? docs[viewing] : null;

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold">{SERVICE_NAME}</h1>
          <p className="mt-2 text-sm text-zinc-500">
            서비스 이용을 위해 아래 약관에 동의해주세요.
          </p>
        </div>

        <div className="space-y-3">
          {items.map((id) => {
            const on = !!checked[id];
            const hasDoc = !!docs[id];
            return (
              <div
                key={id}
                className="flex items-start gap-3 rounded-xl border border-foreground/15 ui-surface p-3"
              >
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => toggle(id)}
                  aria-pressed={on}
                  className="flex flex-1 items-start gap-3 text-left"
                >
                  <span
                    aria-hidden
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition ${
                      on
                        ? "border-foreground bg-foreground text-paper-2"
                        : "border-foreground/40 text-transparent"
                    }`}
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5 12l5 5L20 7" />
                    </svg>
                  </span>
                  <span className="text-sm leading-relaxed">{ITEM_LABEL[id]}</span>
                </button>
                {hasDoc && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setViewing(id)}
                    className="shrink-0 text-xs text-zinc-500 underline underline-offset-2 hover:text-foreground"
                  >
                    보기
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {docLoadFailed && (
          <p role="alert" className="text-sm text-red-400">
            약관을 불러올 수 없어요. 잠시 후 새로고침해 다시 시도해주세요.
          </p>
        )}
        {err && (
          <p role="alert" className="text-sm text-red-400">
            {err}
          </p>
        )}

        <button
          type="button"
          disabled={!all || busy || docLoadFailed}
          onClick={() => void submit()}
          className="flex items-center justify-center gap-2 rounded-full bg-foreground py-4 font-semibold text-paper-2 transition disabled:cursor-not-allowed disabled:opacity-30"
        >
          {busy && <Spinner className="h-5 w-5" />}
          동의하고 시작
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void logout()}
          className="text-center text-sm text-zinc-500 underline-offset-4 transition hover:text-foreground hover:underline disabled:opacity-40"
        >
          로그아웃
        </button>
      </div>

      {viewing && viewingDoc && (
        <ModalShell
          wide
          ariaLabel={`${viewingDoc.title} 전문`}
          onClose={() => setViewing(null)}
        >
          <div className="mb-1 flex justify-end">
            <button
              type="button"
              onClick={() => setViewing(null)}
              aria-label="닫기"
              className="text-lg leading-none text-zinc-500 hover:text-foreground"
            >
              ✕
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto pr-1">
            <LegalDocView
              title={viewingDoc.title}
              sections={viewingDoc.sections}
              version={viewingDoc.version}
              effectiveDate={viewingDoc.effectiveDate}
              badge="current"
            />
          </div>
          <button
            type="button"
            onClick={() => setViewing(null)}
            className="mt-4 w-full rounded-full border border-foreground/15 ui-surface py-2.5 text-sm font-medium transition hover:bg-foreground/5"
          >
            닫기
          </button>
        </ModalShell>
      )}
    </main>
  );
}
