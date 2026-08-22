import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import {
  PAYMENT_INTENT_EXPIRE_MS,
  portoneConfigured,
  getPortonePaymentSnapshot,
} from "@/lib/portone";
import {
  handleObservedCancellation,
  sweepOpenPgAttempts,
} from "@/lib/refund-saga";
import { log, errInfo } from "@/lib/log";
import { validateAdminRows } from "@/lib/admin-read-contract";
import { requireSupabaseExactCount } from "@/lib/supabase-operation";
import { cronSecretMatches } from "@/lib/ops-auth";
import {
  parseMarkOrderFailedResult,
  parseMarkOrderCanceledUnpaidResult,
  parseMarkPaidAndGrantResult,
  parsePaidOrderPostcondition,
} from "@/lib/pay/order-mutation-result";
import {
  boundedBatchMayHaveMore,
  createOpsMaintenanceDeadline,
  opsMaintenanceDeadlineReached,
  opsMaintenanceResponseInit,
  opsMaintenanceStatus,
  runOpsMaintenanceWithDeadline,
} from "@/lib/ops-maintenance-status";
import {
  classifyPortoneEvidenceForRollout,
  classifyPortoneNonMoneyEvidence,
} from "@/lib/pay/payment-evidence";
import { recordOrderEvidenceMarkerIfUnsettled } from "@/lib/pay/order-observation-write";

export const runtime = "nodejs";
// PortOne POST/GET와 DB 전이는 모두 durable idempotency key/receipt 기반이다.
// 외부 scheduler 90초 전에 platform이 중단해도 다음 run이 안전하게 수렴한다.
export const maxDuration = 25;

/**
 * 오래된 결제요청 대사 — cron-job.org 가 x-cron-secret 헤더로 주기 호출(머신, requireAdmin 아님).
 * 결제 시도 후 2시간+ pending 을 포트원 단건 조회로 **실제 대사**한다(페이앱 시절 '탐지+경고만'에서 승격):
 *  - PAID + immutable evidence exact → 멱등 지급(mark_paid_and_grant — 웹훅과 동일 RPC, 중복 안전)
 *  - CANCELLED/PARTIAL_CANCELLED → 이벤트 영속 + 대사 RPC(handleObservedCancellation — 직접 종단 금지 §13)
 *  - FAILED 관측 → mark_order_failed(pending→failed 준종단; 시효(6h)+ 경과면 아래 시효 종단)
 *  - **시효(6h)+ 미해결 intent(READY 등 진행형·FAILED 공통) → mark_order_canceled_unpaid 로 canceled
 *    시효 종단**(PAYMENT_INTENT_EXPIRE_MS=6h). 준종단(failed)의 '늦은 PAID 부활 지급' 창은 이 시효로
 *    한정 — 그 안에서는 매 사이클 단건조회가 PAID 를 회수한다. 24h 뒤 canceled 종단은 사용자
 *    전역 1-intent 잠금을 해제한다(2026-08-19 실사고: 7월 결제창 이탈 failed 가 영구 잠금이
 *    되어 새 결제 전면 거절 — failed 는 어떤 경로로도 안 풀리던 갭의 근본 수정). oldest-first
 *    배치의 불멸 row 기아 차단도 유지.
 *  - 그 외/조회 실패 → 미해결로 남기고 경고(운영 확인)
 * 지급 대사 후 refund-sweep 확장(B.8.6): open PG attempt 순회(항목별 독립·완전 멱등).
 * 처리량은 호출당 20건(오래된 순) — Vercel 함수 타임아웃 안에서 외부 API 직렬 호출을 감당하는 상한.
 */
const STALE_MS = 2 * 60 * 60 * 1000;
const BATCH = 20;
const MAX_IDS = 10;

/** cron 심박 기록(§29) — rpc 실패는 경고만(cron 자체를 죽이지 않음). */
async function heartbeat(
  admin: ReturnType<typeof createAdminClient>,
  phase: "start" | "success" | "failure",
  errorCode?: string,
  signal?: AbortSignal,
) {
  try {
    const request = admin.rpc("ops_cron_heartbeat", {
      p_job: "reconcile",
      p_phase: phase,
      p_error_code: errorCode ?? null,
    });
    const { error } = await (signal ? request.abortSignal(signal) : request);
    if (error) {
      log.warn("pay.reconcile_heartbeat_fail", { phase, ...errInfo(error) });
    }
  } catch (error) {
    log.warn("pay.reconcile_heartbeat_fail", {
      phase,
      ...errInfo(error),
    });
  }
}

function maintenanceTimeBudgetResponse() {
  return NextResponse.json(
    { ok: false, error: "maintenance_time_budget", retryPending: 1 },
    opsMaintenanceResponseInit(429),
  );
}

export async function POST(req: NextRequest) {
  const secret = SERVER_ENV.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "reconcile_disabled" },
      opsMaintenanceResponseInit(503),
    );
  }
  if (!cronSecretMatches(req.headers.get("x-cron-secret"), secret)) {
    return NextResponse.json(
      { error: "unauthorized" },
      opsMaintenanceResponseInit(401),
    );
  }

  const deadline = createOpsMaintenanceDeadline();
  return runOpsMaintenanceWithDeadline<NextResponse>(
    deadline,
    async () => {
      const admin = createAdminClient();
      await heartbeat(admin, "start", undefined, deadline.signal);
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }

      try {
        const cutoff = new Date(Date.now() - STALE_MS).toISOString();
        const { data, error } = await admin
          .from("orders")
          .select(
            "order_uuid, payment_id, amount, user_id, created_at, status, paid_at, error_message, is_test, expected_store_id, expected_currency, expected_channel_key",
          )
          .in("status", ["pending", "failed"])
          .is("canceled_at", null)
          .is("paid_at", null)
          .eq("provider", "portone")
          .not("payment_id", "is", null)
          .lt("created_at", cutoff)
          .order("created_at", { ascending: true })
          .limit(BATCH)
          .abortSignal(deadline.signal);

        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        if (error) {
          log.error("pay.reconcile_query_fail", errInfo(error));
          await heartbeat(admin, "failure", "query_failed", deadline.signal);
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          return NextResponse.json(
            { error: "query_failed" },
            opsMaintenanceResponseInit(503),
          );
        }

        let rows: Array<{
          order_uuid: string;
          payment_id: string;
          amount: number;
          user_id: string;
          created_at: string;
          status: string;
          paid_at: string | null;
          error_message: string | null;
          is_test: boolean;
          expected_store_id: string | null;
          expected_currency: string | null;
          expected_channel_key: string | null;
        }>;
        try {
          rows = validateAdminRows("pay.reconcile.orders", data, {
            order_uuid: "uuid",
            payment_id: "string",
            amount: "nonnegativeInteger",
            user_id: "uuid",
            created_at: "timestamp",
            status: "string",
            paid_at: "nullableTimestamp",
            error_message: "nullableString",
            is_test: "boolean",
            expected_store_id: "nullableString",
            expected_currency: "nullableString",
            expected_channel_key: "nullableString",
          });
        } catch (shapeError) {
          log.error("pay.reconcile_invalid_rows", errInfo(shapeError));
          await heartbeat(admin, "failure", "invalid_rows", deadline.signal);
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          return NextResponse.json(
            { error: "query_failed" },
            opsMaintenanceResponseInit(503),
          );
        }
        let granted = 0;
        let manualReview = 0;
        let canceled = 0;
        let failed = 0;
      let expired = 0;
        let terminalRaces = 0;
        let systemErrors = 0;
        const unresolved: string[] = [];
        // 시효(6h) 내 non-terminal(READY 등) — 재호출이 진전시키지 못하는 **감시 상태**.
        // retryPending 에 넣으면 스케줄러 응답이 장시간 연속 429 가 되어
        // cron-job.org 가 잡을 자동 비활성화한다(2026-08-19 실사고·과거 7/31 사망 동일 기전).
        const watching: string[] = [];

        if (rows.length > 0 && !portoneConfigured()) {
          log.warn("pay.reconcile_unconfigured", { count: rows.length });
          await heartbeat(admin, "failure", "pg_unconfigured", deadline.signal);
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          return NextResponse.json(
            { count: rows.length, error: "pg_unconfigured" },
            opsMaintenanceResponseInit(503),
          );
        }

        for (const row of rows) {
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          const got = await getPortonePaymentSnapshot(
            row.payment_id!,
            row.expected_store_id ?? undefined,
            deadline.signal,
          );
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          if (!got.ok) {
            if (got.kind === "not_found") {
              // 결제 시도 자체가 없던 이탈 pending — 실패 종단 처리(잔존 방지, 전이는 RPC 소관).
              const { data: fData, error: fErr } = await admin
                .rpc("mark_order_failed", {
                  p_order_uuid: row.order_uuid,
                  p_pg_status: null,
                  p_error_message: "reconcile_no_payment",
                })
                .abortSignal(deadline.signal);
              if (opsMaintenanceDeadlineReached(deadline)) {
                return maintenanceTimeBudgetResponse();
              }
              const fResult = fErr ? null : parseMarkOrderFailedResult(fData);
              if (!fResult) {
                systemErrors += 1;
                unresolved.push(row.order_uuid);
              } else if (fResult.outcome === "skipped") {
                terminalRaces += 1;
              } else {
                failed += 1;
              }
            } else {
              systemErrors += 1;
              unresolved.push(row.order_uuid);
            }
            continue;
          }
          const snapshot = got.snapshot;
          if (
            snapshot.status !== "PAID" &&
            snapshot.status !== "CANCELLED" &&
            snapshot.status !== "PARTIAL_CANCELLED"
          ) {
            const nonMoneyEvidence = classifyPortoneNonMoneyEvidence(
              snapshot,
              row,
            );
            if (nonMoneyEvidence.kind !== "exact") {
              log.error("pay.reconcile_nonmoney_evidence_rejected", {
                orderUuid: row.order_uuid,
                reason:
                  nonMoneyEvidence.kind === "mismatch"
                    ? nonMoneyEvidence.reason
                    : nonMoneyEvidence.kind,
              });
              if (nonMoneyEvidence.kind === "mismatch") {
                const markerResult = await recordOrderEvidenceMarkerIfUnsettled(
                  admin,
                  {
                    orderUuid: row.order_uuid,
                    expectedStatus: row.status,
                    expectedErrorMessage: row.error_message,
                    marker: `payment_evidence_${nonMoneyEvidence.reason}`,
                  },
                );
                if (opsMaintenanceDeadlineReached(deadline)) {
                  return maintenanceTimeBudgetResponse();
                }
                if (!markerResult.ok) {
                  systemErrors += 1;
                  log.error("pay.reconcile_evidence_mismatch_record_fail", {
                    orderUuid: row.order_uuid,
                    ...errInfo(markerResult.error),
                  });
                } else if (markerResult.outcome === "terminal") {
                  if (markerResult.paidState?.errorMessage) manualReview += 1;
                  else if (markerResult.status === "paid") terminalRaces += 1;
                  else canceled += 1;
                  continue;
                }
              }
              unresolved.push(row.order_uuid);
              continue;
            }
          }
          const evidence =
            snapshot.status === "PAID"
              ? classifyPortoneEvidenceForRollout(snapshot, row)
              : null;
          if (evidence?.kind === "mismatch") {
            log.error("pay.reconcile_evidence_mismatch", {
              orderUuid: row.order_uuid,
              reason: evidence.reason,
            });
            const markerResult = await recordOrderEvidenceMarkerIfUnsettled(
              admin,
              {
                orderUuid: row.order_uuid,
                expectedStatus: row.status,
                expectedErrorMessage: row.error_message,
                marker: `payment_evidence_${evidence.reason}`,
              },
            );
            if (opsMaintenanceDeadlineReached(deadline)) {
              return maintenanceTimeBudgetResponse();
            }
            if (!markerResult.ok) {
              systemErrors += 1;
              log.error("pay.reconcile_evidence_mismatch_record_fail", {
                orderUuid: row.order_uuid,
                ...errInfo(markerResult.error),
              });
            }
            if (markerResult.ok && markerResult.outcome === "terminal") {
              if (markerResult.paidState?.errorMessage) manualReview += 1;
              else if (markerResult.status === "paid") terminalRaces += 1;
              else canceled += 1;
            } else {
              unresolved.push(row.order_uuid);
            }
          } else if (snapshot.status === "PAID") {
            if (evidence?.kind === "legacy_deferred") {
              log.warn("pay.reconcile_legacy_evidence_deferred", {
                orderUuid: row.order_uuid,
                paymentId: row.payment_id,
              });
              // Keep the order pending and visible to the incomplete-work
              // heartbeat. The immutable tuple must be backfilled before any
              // automatic grant RPC can run.
              unresolved.push(row.order_uuid);
              continue;
            }
            // paid_at 명시 전달 필수(§12.4) — 부재면 grant 시도 자체를 실패 로깅 후 미해결로 보존.
            const paidAt =
              typeof snapshot.raw.paidAt === "string"
                ? snapshot.raw.paidAt
                : null;
            if (!paidAt) {
              systemErrors += 1;
              log.error("pay.paid_at_missing", {
                orderUuid: row.order_uuid,
                paymentId: row.payment_id,
              });
              unresolved.push(row.order_uuid);
              continue;
            }
            const { data: ok, error: gErr } = await admin
              .rpc("mark_paid_and_grant", {
                p_order_uuid: row.order_uuid,
                p_pg_tx_id:
                  typeof snapshot.raw.transactionId === "string"
                    ? snapshot.raw.transactionId
                    : null,
                p_price: snapshot.totalAmount,
                p_raw: snapshot.raw,
                p_paid_at: paidAt,
                p_receipt_url:
                  typeof snapshot.raw.receiptUrl === "string"
                    ? snapshot.raw.receiptUrl
                    : null,
              })
              .abortSignal(deadline.signal);
            if (opsMaintenanceDeadlineReached(deadline)) {
              return maintenanceTimeBudgetResponse();
            }
            const grantAck = gErr ? null : parseMarkPaidAndGrantResult(ok);
            if (grantAck === null) {
              systemErrors += 1;
              log.error("pay.reconcile_grant_fail", {
                orderUuid: row.order_uuid,
                ...errInfo(gErr),
              });
              unresolved.push(row.order_uuid);
            } else {
              const { data: current, error: currentError } = await admin
                .from("orders")
                .select("status, paid_at, error_message")
                .eq("order_uuid", row.order_uuid)
                .abortSignal(deadline.signal)
                .maybeSingle();
              if (opsMaintenanceDeadlineReached(deadline)) {
                return maintenanceTimeBudgetResponse();
              }
              const paidState = parsePaidOrderPostcondition(current);
              if (currentError || !paidState) {
                systemErrors += 1;
                log.error("pay.reconcile_paid_transition_incomplete", {
                  orderUuid: row.order_uuid,
                  grantAck,
                  ...errInfo(currentError),
                });
                unresolved.push(row.order_uuid);
              } else if (paidState.errorMessage !== null) {
                manualReview += 1;
                log.warn("pay.reconcile_paid_manual_review", {
                  message:
                    "결제는 PAID로 종결됐지만 live 크레딧은 지급되지 않아 운영 확인 필요",
                  orderUuid: row.order_uuid,
                  noGrantReason: paidState.errorMessage,
                });
              } else if (grantAck === false) {
                terminalRaces += 1;
                log.info("pay.reconcile_paid_idempotent", {
                  orderUuid: row.order_uuid,
                });
              } else {
                granted += 1;
                log.warn("pay.reconcile_granted", {
                  message:
                    "웹훅 유실 감지 — 대사에서 지급 처리(웹훅 설정 점검 필요)",
                  orderUuid: row.order_uuid,
                  noGrantReason: paidState.errorMessage,
                });
              }
            }
          } else if (
            snapshot.status === "CANCELLED" ||
            snapshot.status === "PARTIAL_CANCELLED"
          ) {
            // 직접 canceled UPDATE 제거(§13) — 이벤트 영속 + 대사 RPC. 부분취소는 영속만(1급 관측),
            // 경제 해소는 resolver/운영자 — 미해결로 보고해 운영 확인 흐름 유지.
            const res = await handleObservedCancellation(
              admin,
              {
                order_uuid: row.order_uuid,
                paid_at: row.paid_at,
                payment_id: row.payment_id,
                amount: row.amount,
                is_test: row.is_test,
                expected_store_id: row.expected_store_id,
                expected_currency: row.expected_currency,
                expected_channel_key: row.expected_channel_key,
              },
              snapshot,
            );
            if (opsMaintenanceDeadlineReached(deadline)) {
              return maintenanceTimeBudgetResponse();
            }
            if (
              res.outcome === "canceled_unpaid" ||
              res.outcome === "resolved_full"
            )
              canceled += 1;
            else {
              if (res.outcome === "error") {
                systemErrors += 1;
                log.error("pay.reconcile_cancellation_fail", {
                  orderUuid: row.order_uuid,
                  detail: res.error,
                });
              }
              unresolved.push(row.order_uuid);
            }
          } else if (
            Date.now() - new Date(row.created_at).getTime() >
            PAYMENT_INTENT_EXPIRE_MS
          ) {
            // 시효(6h)+ 미해결 intent(READY 등 진행형·FAILED 공통) — 비-PAID 를 방금 단건조회로
            // 재확인했으므로 canceled 시효 종단. 부활(늦은 PAID) 창은 시효 내 사이클이
            // 이미 소진했고, 이 종단이 사용자 전역 1-intent 잠금을 해제한다.
            const { data: eData, error: eErr } = await admin
              .rpc("mark_order_canceled_unpaid", {
                p_order_uuid: row.order_uuid,
                p_pg_status: snapshot.status,
                p_pg_tx_id: null,
                p_raw: snapshot.raw,
              })
              .abortSignal(deadline.signal);
            if (opsMaintenanceDeadlineReached(deadline)) {
              return maintenanceTimeBudgetResponse();
            }
            const eResult = eErr
              ? null
              : parseMarkOrderCanceledUnpaidResult(eData);
            if (!eResult) {
              systemErrors += 1;
              unresolved.push(row.order_uuid);
            } else if (eResult.outcome === "skipped") terminalRaces += 1;
            else expired += 1;
          } else if (snapshot.status === "FAILED") {
            const { data: fData, error: fErr } = await admin
              .rpc("mark_order_failed", {
                p_order_uuid: row.order_uuid,
                p_pg_status: snapshot.status,
                p_error_message: "pg_failed",
                p_raw: snapshot.raw,
              })
              .abortSignal(deadline.signal);
            if (opsMaintenanceDeadlineReached(deadline)) {
              return maintenanceTimeBudgetResponse();
            }
            const fResult = fErr ? null : parseMarkOrderFailedResult(fData);
            if (!fResult) {
              systemErrors += 1;
              unresolved.push(row.order_uuid);
            } else if (fResult.outcome === "skipped") terminalRaces += 1;
            else failed += 1;
          } else {
            // READY/PENDING 등 시효(6h) 미만 — 아직 진행 중일 수 있어 보존.
            // 감시 상태(시간이 해소)이므로 응답 코드에는 반영하지 않는다.
            watching.push(row.order_uuid);
          }
        }

        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        if (unresolved.length > 0) {
          // 확인 필요 경고(미지급 단정 아님) — 자동 대사가 해소하지 못한 건만 warn(Sentry 경보).
          // orderIds 는 최대 10개만 동봉.
          log.warn("pay.stale_payment_request", {
            message:
              "오래된 결제요청 — 자동 대사로 해소되지 않아 운영 확인 필요",
            count: unresolved.length,
            watching: watching.length,
            orderIds: unresolved.slice(0, MAX_IDS),
          });
        } else if (watching.length > 0) {
          // 시효 내 결제창 이탈 등 감시 상태뿐 — 시간이 해소하므로 info(브레드크럼)로만 남긴다.
          // (2026-08-23 까지는 warn 에 합산돼 매 틱 Sentry 경보가 울리던 노이즈를 분리.)
          log.info("pay.stale_payment_watching", {
            count: watching.length,
            orderIds: watching.slice(0, MAX_IDS),
          });
        }

        // refund-sweep 확장(B.8.6) — open PG attempt(pg_requested/pg_pending/pg_succeeded) 순회.
        // 항목별 독립 처리·완전 멱등(processAttemptAuto) — 지급 대사 실패와 무관하게 항상 수행.
        const sweep = await sweepOpenPgAttempts(admin, 20);
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }

        systemErrors += sweep.systemErrors;
        let openIssues = 0;
        try {
          openIssues = await requireSupabaseExactCount(
            "pay.reconcile.open_issues",
            () =>
              admin
                .from("reconciliation_issues")
                .select("id", { count: "exact", head: true })
                .eq("state", "open")
                .abortSignal(deadline.signal),
          );
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          if (manualReview > 0 && openIssues === 0) {
            systemErrors += 1;
            log.error("pay.reconcile_manual_review_issue_missing", {
              manualReview,
            });
          }
        } catch (issueCountError) {
          systemErrors += 1;
          log.error(
            "pay.reconcile_open_issue_count_fail",
            errInfo(issueCountError),
          );
        }
        const retryPending = unresolved.length + sweep.retryPending;
        const boundedBacklogs =
          (boundedBatchMayHaveMore(rows.length, BATCH) ? 1 : 0) +
          sweep.boundedBacklogs;
        const status = opsMaintenanceStatus({
          systemErrors,
          retryPending,
          boundedBacklogs,
          operatorPending: openIssues,
        });
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        if (status === 200) {
          await heartbeat(admin, "success", undefined, deadline.signal);
        } else {
          await heartbeat(
            admin,
            "failure",
            status === 503 ? "system_error" : "incomplete",
            deadline.signal,
          );
        }
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        return NextResponse.json(
          {
            ok: status === 200,
            count: rows.length,
            granted,
            manualReview,
            openIssues,
            canceled,
            failed,
          expired,
            terminalRaces,
            unresolved: unresolved.length,
            watching: watching.length,
            attemptsChecked: sweep.attemptsChecked,
            transitions: sweep.transitions,
            issuesOpened: sweep.issuesOpened,
            refundBlocked: sweep.blocked,
            refundOutstanding: sweep.outstanding,
            refundPending: sweep.pending,
            retryPending,
            boundedBacklogs,
            systemErrors,
          },
          opsMaintenanceResponseInit(status),
        );
      } catch (e) {
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        log.error("pay.reconcile_exception", errInfo(e));
        await heartbeat(admin, "failure", "exception", deadline.signal);
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        return NextResponse.json(
          { error: "exception" },
          opsMaintenanceResponseInit(503),
        );
      }
    },
    async () => {
      log.error("pay.reconcile_maintenance_time_budget");
      await heartbeat(
        createAdminClient(),
        "failure",
        "time_budget",
        AbortSignal.timeout(1_000),
      );
      return maintenanceTimeBudgetResponse();
    },
  );
}
