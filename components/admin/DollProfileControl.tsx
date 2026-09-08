"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import { parseAdminDollProfileMutationResult } from "@/lib/admin-mutation";
import {
  clientMutationResponseNeedsReconciliation,
  readBoundedClientJsonResponse,
  runClientMutation,
  type ClientMutationEvidence,
} from "@/lib/client-mutation";
import { GENDERS, GENDER_LABEL, type Gender } from "@/lib/gender";
import { ROLE_IDS, type RoleId } from "@/lib/roles";
import { roleFrom, type RoleConfig } from "@/lib/config/domains/roles";

/**
 * 캐릭터 속성(롤·성별) 제어(v1.29) — 어드민 캐릭터 상세의 유일한 쓰기 UI. 롤 select + 성별 남/여 + 적용 한 번(CAS).
 * 무결성 조치(IntegrityActions)와 같은 exact-replay 패턴: 결정적 payload(JSON 문자열 고정) → POST /api/admin/doll-profile
 * → 응답 유실 시 같은 payload 재전달(서버 receipt 가 멱등). version 은 dolls.version CAS — 다른 변경이 먼저면 409 → 새로고침 안내.
 * 롤·성별은 메타데이터라 이미지는 불변(호칭·인사기록·보이스·공유 카피만 바뀜).
 */
export function DollProfileControl({
  dollId,
  role,
  gender,
  version,
  cfg,
  disabledReason,
}: {
  dollId: string;
  role: RoleId;
  gender: Gender;
  version: number;
  /** 롤 호칭 = 발행 config(서버 부모에서 prop). */
  cfg: RoleConfig;
  /** 숨김·영구삭제 등 제어 불가 사유 — 있으면 컨트롤 비활성 + 사유 표시. */
  disabledReason?: string | null;
}) {
  const router = useRouter();
  const [nextRole, setNextRole] = useState<RoleId>(role);
  const [nextGender, setNextGender] = useState<Gender>(gender);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const lifecycleRef = useRef<AbortController | null>(null);
  const dirty = nextRole !== role || nextGender !== gender;

  useEffect(() => {
    const controller = new AbortController();
    lifecycleRef.current = controller;
    return () => {
      controller.abort(new Error("doll_profile_control_unmounted"));
      if (lifecycleRef.current === controller) lifecycleRef.current = null;
    };
  }, []);

  const apply = async () => {
    if (busyRef.current || !dirty || disabledReason) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    // This exact string is replayed after response loss. Changing any field
    // would create a different deterministic server receipt.
    const requestBody = JSON.stringify({
      dollId,
      role: nextRole,
      gender: nextGender,
      expectedVersion: version,
    });
    const lifecycleSignal = lifecycleRef.current?.signal;
    try {
      const deliver = async (
        signal: AbortSignal,
      ): Promise<
        ClientMutationEvidence<
          NonNullable<ReturnType<typeof parseAdminDollProfileMutationResult>>
        >
      > => {
        const res = await fetch("/api/admin/doll-profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
          signal,
        });
        const responseBody = await readBoundedClientJsonResponse(res, signal);
        const body: unknown = responseBody.ok ? responseBody.value : null;
        const result = res.ok ? parseAdminDollProfileMutationResult(body) : null;
        if (result?.nextRole === nextRole && result.nextGender === nextGender) {
          return { kind: "confirmed", value: result };
        }
        const apiError =
          body && typeof body === "object" && !Array.isArray(body)
            ? (body as { error?: unknown }).error
            : undefined;
        if (clientMutationResponseNeedsReconciliation(res.status, res.ok)) {
          return {
            kind: "unconfirmed",
            reason: "doll_profile_response_unconfirmed",
            error: apiError,
          };
        }
        return {
          kind: "rejected",
          error: typeof apiError === "string" ? apiError : `doll_profile_http_${res.status}`,
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
            : apiError === "doll_unavailable" || apiError === "already_purged"
              ? "숨김·삭제된 캐릭터는 바꿀 수 없어요. 신고 큐에서 상태를 먼저 처리하세요."
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

  const locked = !!disabledReason || busy;
  const fieldCls =
    "rounded-lg border border-foreground/15 ui-field px-2.5 py-1.5 text-sm outline-none focus:border-foreground/40 disabled:opacity-40";

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-center">
        <label className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
          <span className="w-8 shrink-0">롤</span>
          <select
            value={nextRole}
            disabled={locked}
            onChange={(e) => setNextRole(e.target.value as RoleId)}
            className={`min-w-0 flex-1 ${fieldCls}`}
          >
            {ROLE_IDS.map((rid) => (
              <option key={rid} value={rid}>
                {roleFrom(rid, cfg).label} ({rid})
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="w-8 shrink-0">성별</span>
          <div className="flex gap-1">
            {GENDERS.map((g) => (
              <button
                key={g}
                type="button"
                disabled={locked}
                onClick={() => setNextGender(g)}
                className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
                  g === nextGender
                    ? "bg-foreground text-paper-2"
                    : "bg-foreground/5 text-zinc-500 hover:bg-foreground/10"
                }`}
              >
                {GENDER_LABEL[g]}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          disabled={locked || !dirty}
          onClick={() => void apply()}
          className="flex items-center justify-center gap-2 rounded-full bg-foreground px-4 py-1.5 text-sm font-semibold text-paper-2 transition hover:opacity-90 disabled:opacity-40"
        >
          {busy && <Spinner className="h-3.5 w-3.5" />}
          적용
        </button>
      </div>
      <p className="text-[11px] text-zinc-400">
        {disabledReason ??
          "롤·성별은 메타데이터예요 — 이미지는 그대로, 호칭·인사기록·시비 멘트·피격 반응·공유 문구만 바뀝니다."}
      </p>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
