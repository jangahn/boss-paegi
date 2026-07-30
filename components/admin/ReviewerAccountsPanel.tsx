"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import { fmtKst } from "@/lib/admin-format";
import { RetryOperationIds } from "@/lib/legal/operation-ids";
import {
  parseReviewerMutationSuccess,
  parseReviewerPendingAck,
  reviewerHttpError,
  type ReviewerMutationAction,
  type ReviewerPendingError,
} from "@/lib/reviewer-http-contract";
import {
  clientMutationResponseNeedsReconciliation,
  readBoundedClientJsonResponse,
  runClientMutation,
  type ClientMutationEvidence,
} from "@/lib/client-mutation";

export type ReviewerRow = {
  user_id: string;
  email: string;
  active: boolean;
  auth_sync_pending: boolean;
  note: string | null;
  created_at: string;
};

export type ReviewerJobRow = {
  job_id: string;
  action: "provision" | "set_active" | "reset_password" | "delete";
  status: "pending" | "leased" | "failed";
  user_id: string | null;
  email: string;
  desired_active: boolean | null;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type ReviewerCallResult = {
  ok: boolean;
  password?: string;
  error?: string;
  credentialResetRequired?: boolean;
  status: number;
};

/**
 * 심사 계정 CUD 패널 — 생성(이메일 입력 → 서버가 비번 생성)·비번 재설정·활성 토글·삭제.
 * 비밀번호는 생성/재설정 응답에서 **1회만** 표시(서버 미저장) — PG 회신 메일에 붙여넣고 닫으면 끝.
 * 처리 후 router.refresh 로 서버 재조회(다른 admin 표들과 동일 패턴 — 로컬 상태 드리프트 없음).
 */
export function ReviewerAccountsPanel({
  initialRows,
  initialJobs,
}: {
  initialRows: ReviewerRow[];
  initialJobs: ReviewerJobRow[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // "create" | userId
  const [error, setError] = useState<string | null>(null);
  const operations = useRef(new RetryOperationIds());
  const busyRef = useRef(false);
  const lifecycleRef = useRef<AbortController | null>(null);
  // 마지막 발급 자격증명(1회 표시) — {email, password}
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifecycleRef.current = controller;
    return () => {
      controller.abort(new Error("reviewer_accounts_unmounted"));
      if (lifecycleRef.current === controller) lifecycleRef.current = null;
    };
  }, []);

  const call = async (
    method: "POST" | "PATCH" | "DELETE",
    body: Record<string, unknown>,
    busyKey: string,
    operationSlot: string,
    expected: {
      action: ReviewerMutationAction;
      pendingError: ReviewerPendingError;
      userId?: string;
    },
  ): Promise<ReviewerCallResult | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(busyKey);
    setError(null);
    const lifecycleSignal = lifecycleRef.current?.signal;
    const requestBody = {
      ...body,
      operationId: operations.current.get(operationSlot, body),
    };
    // Every delivery and reconciliation uses the same serialized body, so the
    // durable reviewer job can prove which operation completed.
    const serializedBody = JSON.stringify(requestBody);
    try {
      const deliver = async (
        signal: AbortSignal,
      ): Promise<ClientMutationEvidence<ReviewerCallResult>> => {
        const res = await fetch("/api/admin/reviewers", {
          method,
          headers: { "Content-Type": "application/json" },
          body: serializedBody,
          signal,
        });
        const responseBody =
          await readBoundedClientJsonResponse(res, signal);
        const data: unknown = responseBody.ok
          ? responseBody.value
          : null;
        const success =
          res.status === 200
            ? parseReviewerMutationSuccess(data, {
                action: expected.action,
                userId: expected.userId,
              })
            : null;
        if (success) {
          return {
            kind: "confirmed",
            value: {
              ok: true,
              password: success.password,
              credentialResetRequired: success.credentialResetRequired,
              status: res.status,
            },
          };
        }
        const pending =
          res.status === 202
            ? parseReviewerPendingAck(data, expected.pendingError)
            : null;
        if (pending) {
          return {
            kind: "confirmed",
            value: {
              ok: false,
              error: pending.error,
              status: res.status,
            },
          };
        }
        const apiError = reviewerHttpError(data);
        if (
          clientMutationResponseNeedsReconciliation(res.status, res.ok)
        ) {
          return {
            kind: "unconfirmed",
            reason: "reviewer_response_unconfirmed",
            error: apiError,
          };
        }
        return {
          kind: "rejected",
          error: {
            error: apiError ?? "요청 실패",
            status: res.status,
          },
        };
      };
      const outcome = await runClientMutation({
        attempt: deliver,
        reconcile: deliver,
        signal: lifecycleSignal,
      });
      if (outcome.kind === "aborted") return null;
      if (outcome.kind === "confirmed") {
        if (outcome.value.ok) {
          operations.current.clear(operationSlot);
        }
        return outcome.value;
      }
      if (outcome.kind === "rejected") {
        const rejection =
          outcome.error &&
          typeof outcome.error === "object" &&
          !Array.isArray(outcome.error)
            ? (outcome.error as { error?: unknown; status?: unknown })
            : null;
        const status =
          rejection && Number.isSafeInteger(rejection.status)
            ? (rejection.status as number)
            : 0;
        if (status >= 400 && status < 500) {
          operations.current.clear(operationSlot);
        }
        return {
          ok: false,
          error:
            rejection && typeof rejection.error === "string"
              ? rejection.error
              : "요청 실패",
          status,
        };
      }
      return {
        ok: false,
        error: "response_unconfirmed",
        status: 0,
      };
    } catch {
      return lifecycleSignal?.aborted
        ? null
        : { ok: false, error: "response_unconfirmed", status: 0 };
    } finally {
      busyRef.current = false;
      if (!lifecycleSignal?.aborted) setBusy(null);
    }
  };

  const ERROR_LABEL: Record<string, string> = {
    invalid_email: "이메일 형식이 올바르지 않아요.",
    email_exists: "이미 존재하는 계정 이메일이에요.",
    create_failed: "계정 생성에 실패했어요.",
    create_pending:
      "계정 생성 작업을 저장했고 자동 재시도 중이에요. 완료 후 비밀번호를 재설정하세요.",
    request_conflict:
      "같은 작업 ID가 다른 요청에 사용됐어요. 새로고침 후 다시 시도하세요.",
    lookup_failed: "현재 계정 상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.",
    update_failed: "변경에 실패했어요.",
    response_unconfirmed:
      "응답 영수증을 확인하지 못했어요. 같은 작업으로 다시 확인하세요.",
    reset_failed: "비밀번호 재설정 작업이 중단됐어요.",
    reset_pending:
      "비밀번호 변경 작업을 저장했고 자동 재시도 중이에요. 완료 후 한 번 더 재설정해 새 비밀번호를 발급하세요.",
    sync_pending:
      "Auth 상태 동기화 작업을 저장했고 자동 재시도 중이에요. 완료 전 결제는 차단됩니다.",
    sync_failed:
      "Auth 상태 동기화가 중단됐어요. 작업 상태를 확인한 뒤 다시 실행하세요.",
    delete_failed: "삭제에 실패했어요.",
    delete_pending:
      "로그인 차단·삭제 작업을 저장했고 자동 재시도 중이에요. 완료 전 결제는 차단됩니다.",
    credential_reset_required:
      "작업은 완료됐지만 일회용 비밀번호 응답은 복구할 수 없어요. 비밀번호 재설정을 한 번 더 실행해 새 비밀번호를 발급하세요.",
  };

  const onCreate = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    const r = await call(
      "POST",
      { email: normalizedEmail, note },
      "create",
      "reviewer-create",
      { action: "provision", pendingError: "create_pending" },
    );
    if (!r) return;
    if (!r.ok) {
      if (r.error === "create_pending") router.refresh();
      return setError(ERROR_LABEL[r.error ?? ""] ?? r.error ?? "실패");
    }
    if (r.password) setIssued({ email: email.trim().toLowerCase(), password: r.password });
    if (r.credentialResetRequired) {
      setError(ERROR_LABEL.credential_reset_required);
    }
    setEmail("");
    setNote("");
    router.refresh();
  };

  const onResetPw = async (row: ReviewerRow) => {
    const r = await call(
      "PATCH",
      { userId: row.user_id, action: "reset_password" },
      row.user_id,
      `reviewer-reset:${row.user_id}`,
      {
        action: "reset_password",
        pendingError: "reset_pending",
        userId: row.user_id,
      },
    );
    if (!r) return;
    if (!r.ok) {
      if (r.error === "reset_pending") router.refresh();
      return setError(ERROR_LABEL[r.error ?? ""] ?? r.error ?? "실패");
    }
    if (r.password) setIssued({ email: row.email, password: r.password });
    if (r.credentialResetRequired) {
      setError(ERROR_LABEL.credential_reset_required);
    }
    router.refresh();
  };

  const onToggle = async (row: ReviewerRow) => {
    const r = await call(
      "PATCH",
      { userId: row.user_id, action: "set_active", active: !row.active },
      row.user_id,
      `reviewer-active:${row.user_id}`,
      {
        action: "set_active",
        pendingError: "sync_pending",
        userId: row.user_id,
      },
    );
    if (!r) return;
    if (!r.ok) {
      if (r.error === "sync_pending") router.refresh();
      return setError(ERROR_LABEL[r.error ?? ""] ?? r.error ?? "실패");
    }
    router.refresh();
  };

  const onDelete = async (row: ReviewerRow) => {
    if (!window.confirm(`${row.email} 계정을 삭제할까요?\n(로그인 차단 + 목록 제거 — 주문 기록은 보존)`)) return;
    const r = await call(
      "DELETE",
      { userId: row.user_id },
      row.user_id,
      `reviewer-delete:${row.user_id}`,
      {
        action: "delete",
        pendingError: "delete_pending",
        userId: row.user_id,
      },
    );
    if (!r) return;
    if (!r.ok) {
      if (r.error === "delete_pending") router.refresh();
      return setError(ERROR_LABEL[r.error ?? ""] ?? r.error ?? "실패");
    }
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      {issued && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm">
          <p className="font-semibold text-emerald-500">발급된 로그인 정보 — 지금만 표시돼요(서버 미저장)</p>
          <p className="mt-2 font-mono text-[13px]">
            ID: {issued.email}
            <br />
            PW: {issued.password}
          </p>
          <p className="mt-2 text-xs text-zinc-500">
            진입 경로: <code>/login?reviewer=1</code> → 아이디/비밀번호 입력. 분실 시 비번 재설정으로 재발급.
          </p>
          <button
            type="button"
            onClick={() => setIssued(null)}
            className="mt-3 rounded-md border border-foreground/15 px-2 py-1 text-xs hover:bg-foreground/5"
          >
            닫기
          </button>
        </div>
      )}

      <div className="rounded-xl border border-foreground/10 ui-surface p-4">
        <p className="text-sm font-semibold">새 심사 계정</p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="pg-review@boss-paegi.app"
            className="flex-1 rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm"
          />
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="메모(예: 카카오페이 심사용)"
            className="flex-1 rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={!!busy || !email.trim()}
            onClick={() => void onCreate()}
            className="flex items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-paper-2 disabled:opacity-50"
          >
            {busy === "create" && <Spinner className="h-4 w-4" />}
            생성(비번 자동발급)
          </button>
        </div>
      </div>

      {error && <p className="rounded-xl bg-red-500/10 p-3 text-sm text-red-500">{error}</p>}

      {initialJobs.length > 0 && (
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <p className="font-semibold text-amber-700 dark:text-amber-300">
            미완료 Auth 동기화 작업 {initialJobs.length}건
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-zinc-500">
            {initialJobs.map((job) => (
              <li key={job.job_id}>
                {job.email} · {job.action} · {job.status} · 시도{" "}
                {job.attempt_count}회
                {job.last_error ? ` · ${job.last_error}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      {initialRows.length === 0 ? (
        <p className="text-sm text-zinc-400">등록된 심사 계정이 없어요.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-foreground/10">
          <table className="w-full text-left text-xs">
            <thead className="ui-surface text-zinc-500">
              <tr>
                <th className="px-2 py-1.5">이메일</th>
                <th className="px-2 py-1.5">상태</th>
                <th className="px-2 py-1.5">메모</th>
                <th className="px-2 py-1.5">생성(KST)</th>
                <th className="px-2 py-1.5">액션</th>
              </tr>
            </thead>
            <tbody>
              {initialRows.map((r) => (
                <tr key={r.user_id} className="border-t border-foreground/5">
                  <td className="px-2 py-1.5 font-mono">
                    <Link
                      href={`/admin/users/${r.user_id}`}
                      className="text-sky-600 underline-offset-2 hover:underline"
                      title="회원 상세로 이동 (첫 로그인·동의 전 계정은 비회원으로 표시)"
                    >
                      {r.email}
                    </Link>
                  </td>
                  <td className="px-2 py-1.5">
                    {r.auth_sync_pending ? (
                      <span className="font-semibold text-amber-500">
                        Auth 동기화 중(결제 차단)
                      </span>
                    ) : r.active ? (
                      <span className="font-semibold text-emerald-500">활성</span>
                    ) : (
                      <span className="text-zinc-400">비활성(로그인 차단)</span>
                    )}
                  </td>
                  <td className="max-w-[10rem] truncate px-2 py-1.5">{r.note ?? "—"}</td>
                  <td className="px-2 py-1.5 tabular-nums">{fmtKst(r.created_at)}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex gap-1">
                      <button
                        type="button"
                        disabled={!!busy || r.auth_sync_pending}
                        onClick={() => void onResetPw(r)}
                        className="rounded-md border border-foreground/15 px-2 py-1 text-[11px] hover:bg-foreground/5 disabled:opacity-50"
                      >
                        {busy === r.user_id ? <Spinner className="h-3 w-3" /> : "비번 재설정"}
                      </button>
                      <button
                        type="button"
                        disabled={!!busy || r.auth_sync_pending}
                        onClick={() => void onToggle(r)}
                        className="rounded-md border border-foreground/15 px-2 py-1 text-[11px] hover:bg-foreground/5 disabled:opacity-50"
                      >
                        {r.active ? "비활성화" : "재활성화"}
                      </button>
                      <button
                        type="button"
                        disabled={!!busy || r.auth_sync_pending}
                        onClick={() => void onDelete(r)}
                        className="rounded-md border border-red-500/30 px-2 py-1 text-[11px] text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                      >
                        삭제
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
