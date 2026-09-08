"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import { parseAdminDollGenderMutationResult } from "@/lib/admin-mutation";
import {
  clientMutationResponseNeedsReconciliation,
  readBoundedClientJsonResponse,
  runClientMutation,
  type ClientMutationEvidence,
} from "@/lib/client-mutation";
import { GENDERS, GENDER_LABEL, type Gender } from "@/lib/gender";

/**
 * 캐릭터 성별 후처리(v1.26) — 어드민 캐릭터(생성) 상세에서 남/여 토글. 무결성 조치(IntegrityActions)와 같은
 * exact-replay 패턴: 결정적 payload(JSON 문자열 고정) → POST /api/admin/doll-gender → 응답 유실 시 같은
 * payload 재전달(서버 receipt 가 멱등). version 은 dolls.version CAS — 다른 변경이 먼저면 409 → 새로고침 안내.
 */
export function DollGenderControl({
  dollId,
  gender,
  version,
}: {
  dollId: string;
  gender: Gender;
  version: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const lifecycleRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifecycleRef.current = controller;
    return () => {
      controller.abort(new Error("doll_gender_control_unmounted"));
      if (lifecycleRef.current === controller) lifecycleRef.current = null;
    };
  }, []);

  const change = async (next: Gender) => {
    if (busyRef.current || next === gender) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    // This exact string is replayed after response loss. Changing any field
    // would create a different deterministic server receipt.
    const requestBody = JSON.stringify({ dollId, gender: next, expectedVersion: version });
    const lifecycleSignal = lifecycleRef.current?.signal;
    try {
      const deliver = async (
        signal: AbortSignal,
      ): Promise<
        ClientMutationEvidence<
          NonNullable<ReturnType<typeof parseAdminDollGenderMutationResult>>
        >
      > => {
        const res = await fetch("/api/admin/doll-gender", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
          signal,
        });
        const responseBody = await readBoundedClientJsonResponse(res, signal);
        const body: unknown = responseBody.ok ? responseBody.value : null;
        const result = res.ok ? parseAdminDollGenderMutationResult(body) : null;
        if (result?.nextGender === next) {
          return { kind: "confirmed", value: result };
        }
        const apiError =
          body && typeof body === "object" && !Array.isArray(body)
            ? (body as { error?: unknown }).error
            : undefined;
        if (clientMutationResponseNeedsReconciliation(res.status, res.ok)) {
          return {
            kind: "unconfirmed",
            reason: "doll_gender_response_unconfirmed",
            error: apiError,
          };
        }
        return {
          kind: "rejected",
          error: typeof apiError === "string" ? apiError : `doll_gender_http_${res.status}`,
        };
      };
      const outcome = await runClientMutation({
        attempt: deliver,
        reconcile: deliver,
        signal: lifecycleSignal,
      });
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "confirmed") {
        router.refresh();
        return;
      }
      const apiError = outcome.kind === "rejected" ? outcome.error : undefined;
      setError(
        apiError === "state_conflict"
          ? "다른 변경이 먼저 반영됐어요. 새로고침 후 다시 시도하세요."
          : apiError === "doll_not_found"
            ? "캐릭터를 찾을 수 없어요(새로고침 후 확인)."
            : apiError === "not_admin"
              ? "권한이 없어요."
              : outcome.kind === "unconfirmed"
                ? "처리 결과를 확인하지 못했어요. 성공으로 간주하지 않았습니다. 새로고침해 현재 상태를 확인하세요."
                : "처리 실패 — 잠시 후 다시 시도하세요.",
      );
    } catch {
      if (!lifecycleSignal?.aborted) {
        setError("처리 결과를 확인하지 못했어요. 새로고침해 현재 상태를 확인하세요.");
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[11px] text-zinc-400">캐릭터 보이스</span>
        {GENDERS.map((g) => (
          <button
            key={g}
            type="button"
            disabled={busy}
            onClick={() => void change(g)}
            className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium transition disabled:opacity-40 ${
              g === gender ? "bg-foreground text-paper-2" : "bg-foreground/5 text-zinc-500 hover:bg-foreground/10"
            }`}
          >
            {GENDER_LABEL[g]}
          </button>
        ))}
        {busy && <Spinner className="h-3.5 w-3.5" />}
        <span className="text-[11px] text-zinc-400">· 시비 멘트·피격 반응만 바뀌고 이미지는 그대로</span>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
