"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ModalShell } from "@/components/ModalShell";
import { Spinner } from "@/components/Spinner";
import {
  createContentReportSubmissionId,
  parseContentReportHttpAck,
} from "@/lib/content-report";
import {
  clientMutationResponseNeedsReconciliation,
  runReplayedJsonMutation,
} from "@/lib/client-mutation";

// 사유 코드 = /api/report allowlist 와 일치. label 만 한국어.
const REASONS: { value: string; label: string }[] = [
  { value: "portrait", label: "비동의 내 얼굴 / 초상권 침해" },
  { value: "defamation", label: "명예훼손 · 모욕" },
  { value: "obscene", label: "음란 · 부적절" },
  { value: "hate", label: "욕설 · 혐오" },
  { value: "other", label: "기타" },
];

/** 콘텐츠 신고 다이얼로그 — 비로그인도 제출 가능. Phase 1 target=doll. */
export function ReportDialog({
  dollId,
  onClose,
}: {
  dollId: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submissionIdRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const requestEpochRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const fieldPrefix = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestEpochRef.current += 1;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
    };
  }, []);

  const beginNewIntent = () => {
    submissionIdRef.current = null;
    setError(null);
  };

  const submit = async () => {
    if (busyRef.current || !reason) return;
    busyRef.current = true;
    const requestEpoch = requestEpochRef.current + 1;
    requestEpochRef.current = requestEpoch;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), 12_000);
    setBusy(true);
    setError(null);
    try {
      const submissionId =
        submissionIdRef.current ?? createContentReportSubmissionId();
      // Keep the same observable intent across every network/response-loss
      // retry for the lifetime of this dialog.
      submissionIdRef.current = submissionId;
      const requestBody = JSON.stringify({
          submissionId,
          targetId: dollId,
          reason,
          detail: detail.trim() || undefined,
          contact: contact.trim() || undefined,
      });
      const outcome = await runReplayedJsonMutation({
        input: "/api/report",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        },
        signal: controller.signal,
        classify: (response, body) => {
          if (response.ok && parseContentReportHttpAck(body)) {
            return { kind: "confirmed", value: true };
          }
          const errorCode =
            body &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            typeof (body as { error?: unknown }).error ===
              "string"
              ? (body as { error: string }).error
              : null;
          if (
            errorCode === "rate_limited" ||
            errorCode === "submission_conflict" ||
            errorCode === "client_upgrade_required"
          ) {
            return { kind: "rejected", error: errorCode };
          }
          if (
            clientMutationResponseNeedsReconciliation(
              response.status,
              response.ok,
            )
          ) {
            return {
              kind: "unconfirmed",
              reason: "content_report_response_unconfirmed",
              error: errorCode,
            };
          }
          return {
            kind: "rejected",
            error:
              errorCode ?? `content_report_http_${response.status}`,
          };
        },
      });
      if (
        !mountedRef.current ||
        requestEpochRef.current !== requestEpoch
      ) {
        return;
      }
      if (outcome.kind === "confirmed") {
        setDone(true);
        return;
      }
      const errorCode =
        outcome.kind === "rejected" &&
        typeof outcome.error === "string"
          ? outcome.error
          : null;
      // A rate-limit response is a definitive, durably cached rejection of
      // this submission id. A later user retry must start a new intent;
      // transport/ambiguous failures keep the id for response-loss recovery.
      if (
        errorCode === "rate_limited" ||
        errorCode === "submission_conflict"
      ) {
        submissionIdRef.current = null;
      }
      setError(
        errorCode === "rate_limited"
          ? "신고가 너무 잦아요. 잠시 후 다시 시도해 주세요."
          : errorCode === "client_upgrade_required"
            ? "새 버전이 필요해요. 페이지를 새로고침한 뒤 다시 신고해 주세요."
            : errorCode === "submission_conflict"
              ? "이전 전송 시도와 내용이 달라요. 창을 닫았다 다시 열어 새 신고로 접수해 주세요."
          : "신고 접수에 실패했어요. 잠시 후 다시 시도해 주세요."
      );
    } catch {
      if (
        mountedRef.current &&
        requestEpochRef.current === requestEpoch
      ) {
        setError("네트워크 오류 — 다시 시도해 주세요.");
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (requestAbortRef.current === controller) {
        requestAbortRef.current = null;
      }
      busyRef.current = false;
      if (
        mountedRef.current &&
        requestEpochRef.current === requestEpoch
      ) {
        setBusy(false);
      }
    }
  };

  const close = () => {
    if (!busyRef.current) onClose();
  };

  if (done) {
    return (
      <ModalShell ariaLabel="신고 접수 완료" onClose={close}>
        <h2 className="text-lg font-bold">신고가 접수됐어요</h2>
        <p className="mt-2 text-sm text-zinc-500">
          검토 후 조치하겠습니다. 연락처를 남기셨다면 처리 관련 연락을 드릴 수 있어요.
        </p>
        <button
          type="button"
          onClick={close}
          className="mt-4 w-full rounded-full bg-foreground py-2.5 text-sm font-semibold text-paper-2 transition hover:opacity-90"
        >
          닫기
        </button>
      </ModalShell>
    );
  }

  return (
    <ModalShell ariaLabel="콘텐츠 신고" onClose={close}>
      <h2 className="text-lg font-bold">콘텐츠 신고</h2>
      <p className="mt-1 text-sm text-zinc-500">
        동의 없이 올라간 얼굴 등 문제가 있으면 신고해 주세요.
      </p>

      <fieldset className="mt-3 space-y-1.5">
        <legend className="sr-only">신고 사유</legend>
        {REASONS.map((r) => (
          <label key={r.value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="report-reason"
              value={r.value}
              checked={reason === r.value}
              disabled={busy}
              onChange={() => {
                beginNewIntent();
                setReason(r.value);
              }}
              className="shrink-0"
            />
            <span>{r.label}</span>
          </label>
        ))}
      </fieldset>

      <label htmlFor={`${fieldPrefix}-detail`} className="sr-only">
        상세 내용 (선택)
      </label>
      <textarea
        id={`${fieldPrefix}-detail`}
        value={detail}
        disabled={busy}
        onChange={(e) => {
          beginNewIntent();
          setDetail(e.target.value);
        }}
        maxLength={2000}
        rows={3}
        placeholder="상세 내용 (선택)"
        className="mt-3 w-full resize-none rounded-xl border border-foreground/15 ui-field p-2.5 text-sm outline-none focus:border-foreground/30"
      />
      <label htmlFor={`${fieldPrefix}-contact`} className="sr-only">
        처리 관련 연락을 받을 연락처 (선택)
      </label>
      <input
        id={`${fieldPrefix}-contact`}
        value={contact}
        disabled={busy}
        onChange={(e) => {
          beginNewIntent();
          setContact(e.target.value);
        }}
        maxLength={200}
        placeholder="연락처 (선택) — 처리 관련 연락을 받을 수 있어요"
        className="mt-2 w-full rounded-xl border border-foreground/15 ui-field p-2.5 text-sm outline-none focus:border-foreground/30"
      />

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={close}
          disabled={busy}
          className="flex-1 rounded-full border border-foreground/15 ui-surface py-2.5 text-sm font-medium transition hover:bg-foreground/5"
        >
          취소
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !reason}
          className="flex flex-1 items-center justify-center gap-2 rounded-full bg-red-500 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
        >
          {busy && <Spinner className="h-4 w-4" />}
          {busy ? "신고 중…" : "신고"}
        </button>
      </div>
    </ModalShell>
  );
}
