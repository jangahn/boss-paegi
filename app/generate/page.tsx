"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ConsentDialog } from "@/components/ConsentDialog";
import { PhotoCropper } from "@/components/PhotoCropper";
import { UploadStage } from "@/components/generate/UploadStage";
import { PickStage } from "@/components/generate/PickStage";
import { LoadingStage } from "@/components/generate/LoadingStage";
import { GeneratingProgress, SavingProgress } from "@/components/generate/GeneratingProgress";
import { RoleSelectStage } from "@/components/generate/RoleSelectStage";
import { getMyProfile, notifyCreditsChanged } from "@/lib/profile";
import { setSentryGenStage, setSentryLastAction } from "@/lib/sentry-context";
import { type RoleId } from "@/lib/roles";
import { log, errInfo } from "@/lib/log";
import { parsePendingGenerationsResponse } from "@/lib/pending-generations-response";
import {
  parseDollPickHttpResponse,
  parseGenerationSubmitHttpResponse,
} from "@/lib/character-gen/http-contract";
import {
  clearClientUploadOperation,
  stableClientOperation,
  stableClientUploadOperation,
} from "@/lib/client-upload-operation";
import {
  parseClientPollDirective,
  waitForClientPoll,
} from "@/lib/client-operation-poll";
import {
  runBoundedClientJsonFetch,
} from "@/lib/client-mutation";
import {
  useGenerationPolling,
  type GenerationProgressState,
  type Stage,
  type GeneratedImage,
} from "./useGenerationPolling";

function GeneratePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const resumeId = searchParams.get("resume");
  const [stage, setStage] = useState<Stage>(resumeId ? "generating" : "checking");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [results, setResults] = useState<GeneratedImage[]>([]);
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<RoleId>("boss");
  const [error, setError] = useState<string | null>(null);
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null);
  const operationAbortRef = useRef<AbortController | null>(null);

  const beginOperation = () => {
    operationAbortRef.current?.abort();
    const controller = new AbortController();
    operationAbortRef.current = controller;
    return controller;
  };

  // 폴링 대상 genId — resume(URL) 우선, fresh 는 state. 리로드 시 URL 이 살아있어 이어짐.
  // 종결(gone/invalid/interrupted)로 resume 을 지운 뒤에는 URL 파라미터를 무시한다
  // (replaceState 만으로는 useSearchParams 가 재평가되지 않을 수 있음).
  const [resumeCleared, setResumeCleared] = useState(false);
  const activeGenId = resumeCleared ? generationId : (resumeId ?? generationId);
  // 대기 화면의 서버 실단계 — 폴 응답이 단일 소스(시간 휴리스틱 아님).
  const [progress, setProgress] = useState<GenerationProgressState | null>(null);
  // 누끼 저장의 서버 실단계(202 응답 phase) — 타이머 아님.
  const [saveStage, setSaveStage] = useState<"background" | "saving" | "done">(
    "background",
  );
  const clearResume = useCallback(() => {
    window.history.replaceState(null, "", "/generate");
    setResumeCleared(true);
    setGenerationId(null);
    setProgress(null);
  }, []);

  // 진입 가드: 생성권 확인(getMyProfile 가 세션 워밍업도 겸함). resume 은 이미 진행 중이라 스킵.
  // **법적 동의는 서버 proxy 가 렌더 전 게이트** → 여기 도달 = 로그인+동의완료. 생성권 0 만 차단,
  // 그 외는 photo 동의 단계("consent" = ConsentDialog). 조회 실패는 생성 가능으로 축소하지 않는다.
  useEffect(() => {
    if (resumeId) return;
    let cancelled = false;
    const entryAbort = new AbortController();
    (async () => {
      try {
        // 먼저 세션/프로필을 확인해 익명 세션 생성 경쟁과 pending 401을 피한다. pending 권위
        // 조회까지 모두 성공해야만 새 생성 funnel을 연다.
        const profile = await getMyProfile();
        if (cancelled) return;
        const delivery = await runBoundedClientJsonFetch({
          input: "/api/generations?v=2",
          init: { cache: "no-store" },
          signal: entryAbort.signal,
        });
        if (delivery.kind === "aborted") return;
        if (delivery.kind !== "confirmed") {
          throw new Error("pending_generations_response_unconfirmed");
        }
        const { response: res, body } = delivery.value;
        if (!res.ok) {
          throw new Error(`pending_generations_http_${res.status}`);
        }
        const pending = parsePendingGenerationsResponse(body);
        // ready도 아직 pick되지 않은 소비 완료 생성이다. generating과 동일하게 먼저
        // 복귀시켜 새 요청/중복 차감을 막는다.
        const readyRow = pending.find(
          (generation) => generation.kind === "ready",
        );
        if (readyRow) {
          // 이미 후보가 있는 생성은 "생성 중" 경유 없이 곧장 고르기로(U5) —
          // 가드 응답이 후보·롤을 이미 들고 있다.
          setResults(
            readyRow.candidateUrls.map((url) => ({
              url,
              width: 512,
              height: 512,
            })),
          );
          setSelectedRole(readyRow.role);
          setGenerationId(readyRow.id);
          setStage("pick");
          window.history.replaceState(
            null,
            "",
            `/generate?resume=${readyRow.id}`,
          );
          return;
        }
        const active = pending.find(
          (generation) => generation.kind === "generating",
        );
        if (active) {
          setGenerationId(active.id);
          if (active.phase !== undefined) {
            setProgress({
              phase: active.phase,
              candidatesReady: active.candidatesReady ?? 0,
              startedAtMs: Date.parse(active.createdAt),
            });
          }
          setStage("generating");
          window.history.replaceState(
            null,
            "",
            `/generate?resume=${active.id}`,
          );
          return;
        }
        // 방금 정리된 끊김(즉시 환불 완료) — 무언 소실 금지, 1회 안내 후 새 퍼널(U1).
        const interruptedRow = pending.find(
          (generation) => generation.kind === "interrupted",
        );
        if (interruptedRow) {
          setError(
            interruptedRow.reason === "photo"
              ? "이전 생성이 사진 문제로 실패했어요. 사용한 생성권은 자동 환불되었어요."
              : "이전 생성이 중단 정리되었어요. 사용한 생성권은 자동 환불되었어요.",
          );
          notifyCreditsChanged();
        }
        setStage(
          profile?.isLoggedIn && profile.genCredits === 0
            ? "no_credits"
            : "consent",
        );
      } catch (loadError) {
        log.warn("gen.client_entry_guard_fail", errInfo(loadError));
        if (!cancelled) {
          setProfileLoadError(
            "계정·생성권·진행 중인 생성 상태를 모두 확인하지 못했어요. 새 생성은 시작하지 않았습니다. 잠시 후 다시 확인해 주세요.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      entryAbort.abort(new Error("generation_entry_inactive"));
    };
  }, [resumeId]);

  // 진행 중 생성 폴링(fresh/resume 공통) — ready 면 고르기 단계로. 동시폴/취소/복귀 처리는 hook 내부.
  useGenerationPolling({
    activeGenId,
    stage,
    setResults,
    setGenerationId,
    setStage,
    setError,
    setSelectedRole,
    setProgress,
    clearResume,
  });

  // 생성 퍼널 단계 태그(이탈 추적) — Sentry 저카디널리티 태그 + breadcrumb.
  useEffect(() => {
    setSentryGenStage(stage);
  }, [stage]);

  useEffect(() => {
    return () => {
      operationAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const handleFile = (f: File) => {
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setError(null);
    setStage("crop");
  };

  const handleCropConfirm = (blob: Blob) => {
    if (preview) URL.revokeObjectURL(preview);
    const newPreview = URL.createObjectURL(blob);
    setPreview(newPreview);
    setFile(new File([blob], "cropped.jpg", { type: "image/jpeg" }));
    // crop 끝나면 롤 선택 단계로 (롤 확정 후 생성 — 고른 롤이 프롬프트·doll.role 에 반영)
    setStage("role-select");
  };

  const handleGenerate = async (uploadFile?: File, role: RoleId = selectedRole) => {
    const target = uploadFile ?? file;
    if (!target) return;
    setSentryLastAction("generate");
    setStage("generating");
    // 제출 요청이 시작되는 순간부터 서버는 분석 단계다 — 첫 폴 응답 전까지의
    // 실단계 표시(폴이 도착하면 서버 값이 덮는다).
    setProgress({
      phase: "analyzing",
      candidatesReady: 0,
      startedAtMs: Date.now(),
    });
    setError(null);
    const scope = "generation-submit";
    const controller = beginOperation();
    try {
      const operation = await stableClientUploadOperation({
        scope,
        binding: role,
        blob: target,
      });
      let res: Response;
      let payload: unknown;
      const pollStartedAt = Date.now();
      const pollStartedAtMonotonic = performance.now();
      let pollDeadline: number | null = null;
      let pollMonotonicDeadline: number | null = null;
      for (;;) {
        const form = new FormData();
        form.append("image", target);
        form.append("role", role);
        form.append("requestId", operation.requestId);
        const delivery = await runBoundedClientJsonFetch({
          input: "/api/fal",
          init: {
            method: "POST",
            body: form,
          },
          signal: controller.signal,
          deadlineMs: 55_000,
          attemptMs: 45_000,
        });
        if (delivery.kind !== "confirmed") {
          throw new Error("generation_delivery_unconfirmed");
        }
        res = delivery.value.response;
        payload = delivery.value.body;
        const submitted = parseGenerationSubmitHttpResponse(payload);
        if (submitted) break;
        const pending =
          res.status === 202 &&
          payload !== null &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          (payload as Record<string, unknown>).error ===
            "generation_preflight_processing";
        if (!pending) break;
        const directive = parseClientPollDirective({
          retryAfter: res.headers.get("Retry-After"),
          pollUntil:
            payload !== null &&
            typeof payload === "object" &&
            !Array.isArray(payload)
              ? (payload as Record<string, unknown>).pollUntil
              : null,
          startedAtMs: pollStartedAt,
          startedAtMonotonicMs: pollStartedAtMonotonic,
          priorDeadlineMs: pollDeadline,
          priorMonotonicDeadlineMs: pollMonotonicDeadline,
        });
        if (!directive) throw new Error("operation_poll_deadline");
        pollDeadline = directive.deadlineMs;
        pollMonotonicDeadline = directive.monotonicDeadlineMs;
        await waitForClientPoll(directive, controller.signal);
      }
      if (!res.ok) {
        const err =
          payload !== null &&
          typeof payload === "object" &&
          !Array.isArray(payload)
            ? (payload as { error?: string })
            : { error: "failed" };
        if (
          (res.status < 500 && res.status !== 429) ||
          err.error === "generation_preflight_terminal"
        ) {
          clearClientUploadOperation(scope, operation.requestId);
        }
        if (err.error === "no_credits") {
          // 진입 후 크레딧 소진(드문 레이스) — 충전 화면으로.
          router.push("/credits");
          return;
        }
        if (err.error === "member_only") {
          // 비회원 — 로그인 페이지로.
          router.push("/login?next=/generate");
          return;
        }
        if (err.error === "consent_required") {
          // 동의 미완(in-between/레거시/구버전) — 통합 동의 화면으로.
          router.push("/consent?next=/generate");
          return;
        }
        if (err.error === "service_paused") {
          throw new Error(
            "생성 요청이 많아 AI 캐릭터 만들기가 일시적으로 중단됐어요. 잠시 후 다시 시도해주세요. (기본 부장님으로는 계속 플레이할 수 있어요)"
          );
        }
        // 제출 전 입력 게이트(차감 없음) — 원인별 재촬영 안내로 즉시 재시도.
        const INPUT_MSG: Record<string, string> = {
          no_face:
            "사진에서 얼굴을 찾지 못했어요. 얼굴이 정면으로 또렷하게 보이는 사진으로 다시 시도해주세요.",
          multiple_people:
            "사진에 여러 명이 있어요. 한 명만 나온 사진으로 다시 시도해주세요.",
          face_obstructed:
            "손이나 물건이 얼굴을 가리고 있어요. 얼굴을 가리지 않은 사진으로 다시 시도해주세요.",
        };
        if (err.error && INPUT_MSG[err.error]) {
          throw new Error(INPUT_MSG[err.error]);
        }
        throw new Error(err.error ?? "generation_failed");
      }
      // 비동기: 제출만 됨 → fal 이 생성 중. 폴링은 useGenerationPolling 이 담당.
      const data = parseGenerationSubmitHttpResponse(
        payload,
      );
      if (!data) throw new Error("generation_failed");
      const genId = data.generationId;
      clearClientUploadOperation(scope, operation.requestId);
      setGenerationId(genId);
      // 제출 성공 = 서버에서 생성권 1개 차감됨 → 헤더 잔액 즉시 갱신(새로고침 불필요).
      notifyCreditsChanged();
      // URL 에 genId 기록 → 리로드/모바일 eviction 후에도 resume 플로우로 재진입(폴링 이어감).
      // history.replaceState 는 Next 라우터와 동기화돼 resumeId 가 갱신되되 라우트 전환은
      // 안 일으킨다. (전환 안 돼도 activeGenId=generationId 라 이펙트가 폴링 시작.)
      window.history.replaceState(null, "", `/generate?resume=${genId}`);
    } catch (e) {
      if (controller.signal.aborted) return;
      log.warn("gen.client_request_fail", errInfo(e));
      const raw =
        e instanceof Error ? e.message : "알 수 없는 오류";
      setError(
        raw === "operation_poll_deadline"
          ? "처리가 오래 걸리고 있어 자동 확인을 멈췄어요. 다시 시도하면 같은 요청을 안전하게 이어갑니다."
          : /^[a-z0-9_]+$/.test(raw)
            ? "캐릭터 생성에 실패했어요. 사용한 생성권은 자동 환불되었어요. 잠시 후 다시 시도해주세요."
            : raw,
      );
      setStage("upload");
    }
  };

  const handlePick = async (img: GeneratedImage) => {
    setStage("saving");
    const controller = beginOperation();
    try {
      // 서버 권위 pick — candidateIndex(후보 경로 .../{index}.jpg 에서 파싱)를 보낸다. 서버가 소유·
      // done·candidate_urls 멤버십을 검증하고 경로를 재구성·서명하므로 클라 URL 자체는 신뢰되지 않음.
      const m = /\/candidates\/[^/]+\/(\d+)\.jpg/.exec(img.url);
      const candidateIndex = m ? Number(m[1]) : undefined;
      const expectedGenerationId = activeGenId;
      if (!expectedGenerationId) throw new Error("저장 실패");
      if (
        !Number.isInteger(candidateIndex) ||
        (candidateIndex as number) < 0 ||
        (candidateIndex as number) > 2
      ) {
        throw new Error("저장 실패");
      }
      setSaveStage("background");
      const scope = `doll-pick:${expectedGenerationId}`;
      const operation = await stableClientOperation({
        scope,
        binding: `${expectedGenerationId}:${candidateIndex}`,
      });
      let res: Response;
      let payload: unknown;
      const pollStartedAt = Date.now();
      const pollStartedAtMonotonic = performance.now();
      let pollDeadline: number | null = null;
      let pollMonotonicDeadline: number | null = null;
      for (;;) {
        const requestBody = JSON.stringify({
          generationId: expectedGenerationId,
          candidateIndex,
          requestId: operation.requestId,
        });
        const delivery = await runBoundedClientJsonFetch({
          input: "/api/doll",
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
          },
          signal: controller.signal,
        });
        if (delivery.kind !== "confirmed") {
          throw new Error("doll_pick_delivery_unconfirmed");
        }
        res = delivery.value.response;
        payload = delivery.value.body;
        if (res.status !== 202) break;
        // 서버 202가 실단계(phase)를 동봉 — 저장 화면 문구의 단일 소스.
        const processingPhase =
          payload !== null &&
          typeof payload === "object" &&
          !Array.isArray(payload)
            ? (payload as Record<string, unknown>).phase
            : undefined;
        if (processingPhase === "background" || processingPhase === "saving") {
          setSaveStage(processingPhase);
        }
        const directive = parseClientPollDirective({
          retryAfter: res.headers.get("Retry-After"),
          pollUntil:
            payload !== null &&
            typeof payload === "object" &&
            !Array.isArray(payload)
              ? (payload as Record<string, unknown>).pollUntil
              : null,
          startedAtMs: pollStartedAt,
          startedAtMonotonicMs: pollStartedAtMonotonic,
          priorDeadlineMs: pollDeadline,
          priorMonotonicDeadlineMs: pollMonotonicDeadline,
        });
        if (!directive) throw new Error("operation_poll_deadline");
        pollDeadline = directive.deadlineMs;
        pollMonotonicDeadline = directive.monotonicDeadlineMs;
        await waitForClientPoll(directive, controller.signal);
      }
      const providerRejected =
        res.status === 502 &&
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        (payload as Record<string, unknown>).error ===
          "provider_rejected";
      if (
        !res.ok &&
        ((res.status !== 429 && res.status < 500) || providerRejected)
      ) {
        clearClientUploadOperation(scope, operation.requestId);
      }
      if (!res.ok) {
        const errCode =
          payload !== null &&
          typeof payload === "object" &&
          !Array.isArray(payload)
            ? (payload as { error?: string }).error
            : undefined;
        if (errCode === "candidate_conflict") {
          // 다른 후보의 저장이 이미 진행 중 — 실패가 아니라 경합 안내(U8).
          throw new Error(
            "다른 후보의 저장이 이미 진행 중이에요. 잠시 후 먼저 고른 후보로 완료돼요.",
          );
        }
        throw new Error("저장 실패");
      }
      const data = parseDollPickHttpResponse(
        payload,
        expectedGenerationId,
      );
      if (!data) throw new Error("저장 실패");
      clearClientUploadOperation(scope, operation.requestId);
      setSaveStage("done");
      // 이미 다른 후보로 확정돼 있던 경우(already_picked) — 무언 치환 금지(U9).
      const committedIndex = (
        data.doll as { style_meta?: { candidateIndex?: unknown } }
      ).style_meta?.candidateIndex;
      if (
        typeof committedIndex === "number" &&
        committedIndex !== candidateIndex
      ) {
        setError(
          "이미 캐릭터가 선택되어 있어요. 확정된 캐릭터로 이동할게요.",
        );
        setStage("pick");
        setTimeout(() => {
          router.push(`/play?doll=${data.doll.id}`);
        }, 1500);
        return;
      }
      router.push(`/play?doll=${data.doll.id}`);
    } catch (e) {
      if (controller.signal.aborted) return;
      log.warn("doll.client_save_fail", { genId: generationId, ...errInfo(e) });
      setError(
        e instanceof Error && e.message === "operation_poll_deadline"
          ? "저장이 오래 걸리고 있어 자동 확인을 멈췄어요. 다시 선택하면 같은 저장 요청을 안전하게 이어갑니다."
          : e instanceof Error
            ? e.message
            : "저장 실패",
      );
      setStage("pick");
    }
  };

  return (
    <>
      <main className="flex flex-1 flex-col px-6 py-8">
      <h1 className="sr-only">캐릭터 만들기</h1>
      {stage === "checking" &&
        (profileLoadError ? (
          <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 rounded-3xl border border-red-500/30 bg-red-500/5 p-10 text-center">
            <p className="text-sm text-red-500">{profileLoadError}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-full border border-red-500/30 px-5 py-2.5 text-sm font-semibold"
            >
              다시 확인
            </button>
          </div>
        ) : (
          <LoadingStage label="생성권 확인 중…" />
        ))}
      {stage === "consent" && <ConsentDialog onAgree={() => setStage("upload")} />}
      {stage === "upload" && (
        <UploadStage preview={preview} onFile={handleFile} error={error} />
      )}
      {stage === "crop" && preview && (
        <PhotoCropper
          imageUrl={preview}
          onConfirm={handleCropConfirm}
          onCancel={() => setStage("upload")}
        />
      )}
      {stage === "role-select" && (
        <RoleSelectStage
          initialRole={selectedRole}
          onConfirm={(role) => {
            setSelectedRole(role);
            void handleGenerate(undefined, role);
          }}
        />
      )}
      {stage === "generating" &&
        (error ? (
          <div
            role="alert"
            className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 rounded-3xl border border-red-500/30 bg-red-500/5 p-10 text-center"
          >
            <p className="text-sm leading-relaxed text-red-500">{error}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-full border border-red-500/30 px-5 py-2.5 text-sm font-semibold"
            >
              생성 상태 다시 확인
            </button>
            <button
              type="button"
              onClick={() => router.push("/gallery")}
              className="text-sm text-zinc-500 underline"
            >
              갤러리에서 확인
            </button>
          </div>
        ) : (
          <GeneratingProgress
            phase={progress?.phase ?? "analyzing"}
            candidatesReady={progress?.candidatesReady ?? 0}
            startedAtMs={progress?.startedAtMs ?? Date.now()}
          />
        ))}
      {stage === "pick" && (
        <PickStage results={results} onPick={handlePick} error={error} />
      )}
      {stage === "saving" && <SavingProgress phase={saveStage} />}
      {stage === "no_credits" && (
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 rounded-3xl border border-dashed border-amber-500/40 bg-amber-500/5 p-10 text-center">
          <span className="text-3xl" aria-hidden>
            🎫
          </span>
          <h2 className="text-lg font-bold">생성권을 다 썼어요</h2>
          <p className="text-sm leading-relaxed text-zinc-500">
            생성권을 충전하면 바로 캐릭터를 만들 수 있어요.
          </p>
          <button
            type="button"
            onClick={() => router.push("/credits")}
            className="rounded-full bg-foreground px-6 py-3 text-sm font-semibold text-paper-2 transition hover:opacity-90"
          >
            생성권 충전하기
          </button>
          <button
            type="button"
            onClick={() => router.push("/gallery")}
            className="text-sm text-zinc-500 underline"
          >
            갤러리로 돌아가기
          </button>
        </div>
      )}
      </main>
    </>
  );
}

export default function GeneratePage() {
  return (
    <Suspense fallback={null}>
      <GeneratePageInner />
    </Suspense>
  );
}
