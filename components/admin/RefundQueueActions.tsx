"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ModalShell } from "@/components/ModalShell";
import { Spinner } from "@/components/Spinner";
import { PROCESS_OUTCOME_LABELS, refundErrMsg } from "@/components/admin/refund-saga-ui";

/**
 * 환불 운영 큐 행동(/admin/refunds §B.8) — 이슈·시도(attempt) 두 종류의 인라인 액션.
 * IntegrityActions 의 액션-모달 관용구를 그대로 따른다: 트리거 버튼 → ModalShell + 설명 + 입력 → 라우트.
 *  - 이슈: resolve/ignore → /api/admin/resolve-issue, 외부취소 화해(cancellation_id 존재 시) → /api/admin/resolve-cancellation.
 *  - 시도: process(auto)/switch_to_manual/commit_manual/release → /api/admin/refund-credits(mode:process).
 * 액션 노출은 상태로 게이트하되 유효성 최종 권위는 서버(invalid_state 는 새로고침 안내로 폴백).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYOUT_REF_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** 이슈 액션 3종 + 시도 액션 4종. 값은 라우트로 그대로 전달(switch 만 switch_to_manual 로 매핑). */
type ActionKey = "resolve" | "ignore" | "reconcile" | "auto" | "switch" | "commit_manual" | "release" | "replan";

type ActionMeta = {
  title: string;
  desc: string;
  btn: string;
  /** 트리거·확정 버튼의 위험(빨강) 스타일 여부. */
  danger: boolean;
  /** 사유/메모(5~500자) 입력 필요. */
  needsText: boolean;
  /** 수동 지급 증빙(지급 참조 + 증빙 uuid) 입력 필요 — commit_manual. */
  needsPayout: boolean;
  /** 경제 수량(선택 — 비우면 서버 비례 역산) 입력 노출 — reconcile. */
  needsEconomicQty: boolean;
};

const ACTION_META: Record<ActionKey, ActionMeta> = {
  resolve: {
    title: "이슈 해소",
    desc: "이 대사 이슈를 해소 처리합니다. 연결된 경제 조치가 완료됐음을 확정하고 큐에서 종결합니다.",
    btn: "해소",
    danger: false,
    needsText: true,
    needsPayout: false,
    needsEconomicQty: false,
  },
  ignore: {
    title: "이슈 무시",
    desc: "이 이슈를 무시(경제 조치 없이 종결)합니다. 미종단 취소·경제 화해가 필요한 이슈는 서버가 거부합니다.",
    btn: "무시",
    danger: true,
    needsText: true,
    needsPayout: false,
    needsEconomicQty: false,
  },
  reconcile: {
    title: "외부 취소 화해",
    desc: "PG(콘솔·분쟁 등) 취소를 경제적으로 화해합니다. 크레딧 회수·미회수분·원장·연결 이슈를 서버가 원자적으로 정리합니다.",
    btn: "화해",
    danger: false,
    needsText: true,
    needsPayout: false,
    needsEconomicQty: true,
  },
  auto: {
    title: "환불 진행(자동)",
    desc: "포트원 부분취소를 요청하고 크레딧을 회수합니다. 결과에 따라 확정·PG 대기·수동 검토로 전진합니다.",
    btn: "진행",
    danger: true,
    needsText: false,
    needsPayout: false,
    needsEconomicQty: false,
  },
  switch: {
    title: "수동 지급 전환",
    desc: "PG 취소가 불가/실패한 시도를 수동 계좌지급 경로로 전환합니다(무이동 증빙은 서버가 재확인). 이후 지급 확정이 필요합니다.",
    btn: "수동 전환",
    danger: true,
    needsText: true,
    needsPayout: false,
    needsEconomicQty: false,
  },
  commit_manual: {
    title: "수동 지급 확정",
    desc: "계좌 지급 완료를 확정합니다. 지급 참조번호와 증빙 객체를 남기며, 확정 후에는 되돌릴 수 없습니다.",
    btn: "지급 확정",
    danger: true,
    needsText: true,
    needsPayout: true,
    needsEconomicQty: false,
  },
  release: {
    title: "시도 해제",
    desc: "이 환불 시도를 해제하고 예약(reservation)을 복원합니다. 아직 PG 요청 전(prepared)인 시도를 되돌릴 때 사용합니다. 사유가 필요합니다.",
    btn: "해제",
    danger: true,
    needsText: true,
    needsPayout: false,
    needsEconomicQty: false,
  },
  replan: {
    title: "재계획",
    desc: "수동 검토 중인 시도를 해제하고 재계획합니다. PG 요청 전은 즉시, PG 요청 후는 무이동 증빙을 서버가 재확인합니다. 이후 새 환불 요청으로 다시 진행하세요. 사유가 필요합니다.",
    btn: "재계획",
    danger: true,
    needsText: true,
    needsPayout: false,
    needsEconomicQty: false,
  },
};

type IssueProps = { kind: "issue"; issueId: string; cancellationId: string | null };
type AttemptProps = { kind: "attempt"; attemptId: string; state: string };
export type RefundQueueActionsProps = IssueProps | AttemptProps;

/** 상태별 노출 액션 — 상태머신(§8) 도달 가능 전이만. 최종 유효성은 서버. */
function availableActions(props: RefundQueueActionsProps): ActionKey[] {
  if (props.kind === "issue") {
    return props.cancellationId ? ["reconcile", "resolve", "ignore"] : ["resolve", "ignore"];
  }
  switch (props.state) {
    case "prepared":
      return ["auto", "release"];
    case "pg_requested":
    case "pg_pending":
    case "pg_succeeded":
      return ["auto"];
    case "manual_review":
      return ["switch", "replan"];
    case "manual_pending":
      return ["commit_manual"];
    default:
      return [];
  }
}

// release 는 사유가 필수(라우트: auto 외 process 액션은 reason 5~500). auto 만 무입력.
const needsReason = (action: ActionKey) =>
  action === "release" || action === "replan" || action === "switch" || action === "commit_manual";

export function RefundQueueActions(props: RefundQueueActionsProps) {
  const router = useRouter();
  const [mode, setMode] = useState<ActionKey | null>(null);
  const [text, setText] = useState("");
  const [payoutRef, setPayoutRef] = useState("");
  const [evidenceId, setEvidenceId] = useState("");
  const [economicQty, setEconomicQty] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** auto 의 비종단 outcome(pending·outstanding·manual_review·blocked) 안내 — 종단이면 즉시 닫힘. */
  const [notice, setNotice] = useState<string | null>(null);

  const actions = availableActions(props);
  const meta = mode ? ACTION_META[mode] : null;

  const reset = () => {
    setMode(null);
    setText("");
    setPayoutRef("");
    setEvidenceId("");
    setEconomicQty("");
    setError(null);
    setNotice(null);
  };
  const close = () => {
    if (busy) return;
    reset();
  };
  const open = (action: ActionKey) => {
    setMode(action);
    setText("");
    setPayoutRef("");
    setEvidenceId("");
    setEconomicQty("");
    setError(null);
    setNotice(null);
  };

  const trimmed = text.trim();
  const textOk = trimmed.length >= 5 && trimmed.length <= 500;
  const payoutOk = PAYOUT_REF_RE.test(payoutRef) && UUID_RE.test(evidenceId);
  const economicOk =
    economicQty.trim() === "" ||
    (Number.isInteger(Number(economicQty)) && Number(economicQty) >= 0);

  const canSubmit = (() => {
    if (!meta) return false;
    if (meta.needsText && !textOk) return false;
    if (meta.needsPayout && !payoutOk) return false;
    if (meta.needsEconomicQty && !economicOk) return false;
    return true;
  })();

  const submit = async () => {
    if (busy || !mode || !meta || !canSubmit) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    let endpoint: string;
    let payload: Record<string, unknown>;
    if (props.kind === "issue") {
      if (mode === "reconcile") {
        endpoint = "/api/admin/resolve-cancellation";
        payload = { cancellationId: props.cancellationId, note: trimmed };
        if (economicQty.trim() !== "") payload.economicQty = Number(economicQty);
      } else {
        endpoint = "/api/admin/resolve-issue";
        payload = { issueId: props.issueId, action: mode, note: trimmed };
      }
    } else {
      endpoint = "/api/admin/refund-credits";
      const routeAction = mode === "switch" ? "switch_to_manual" : mode;
      payload = { mode: "process", attemptId: props.attemptId, action: routeAction };
      if (needsReason(mode)) payload.reason = trimmed;
      if (mode === "commit_manual") {
        payload.payout = { externalPayoutRef: payoutRef, evidenceObjectId: evidenceId };
      }
    }

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        outcome?: string;
      };
      if (!res.ok) {
        setError(refundErrMsg(body.error));
        setBusy(false);
        return;
      }
      // auto 는 비종단 outcome(PG 대기·수동 검토 등)이면 목록만 갱신하고 안내 후 대기 — 종단이면 닫힘.
      if (props.kind === "attempt" && mode === "auto") {
        const outcome = body.outcome ?? "";
        if (outcome !== "processed" && outcome !== "no_op") {
          setNotice(PROCESS_OUTCOME_LABELS[outcome] ?? outcome);
          setBusy(false);
          router.refresh();
          return;
        }
      }
      reset();
      router.refresh();
    } catch {
      setError(refundErrMsg("action_failed"));
      setBusy(false);
    }
  };

  const trigCls = (danger: boolean) =>
    `rounded-lg border px-2 py-1 text-xs font-medium transition ${
      danger
        ? "border-red-400/50 text-red-500 hover:bg-red-500/10"
        : "border-foreground/20 text-zinc-500 hover:bg-foreground/5 hover:text-foreground"
    }`;

  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {actions.map((a) => (
        <button key={a} type="button" className={trigCls(ACTION_META[a].danger)} onClick={() => open(a)}>
          {ACTION_META[a].btn}
        </button>
      ))}

      {mode && meta && (
        <ModalShell onClose={close}>
          <h3 className="text-base font-bold">{meta.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">{meta.desc}</p>

          {meta.needsText && (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                props.kind === "issue" ? "메모(5~500자) — 감사 기록에 남습니다" : "사유(5~500자) — 감사 기록에 남습니다"
              }
              maxLength={500}
              rows={2}
              className="mt-3 w-full rounded-lg border border-foreground/15 ui-field px-3 py-2 text-sm outline-none focus:border-foreground/40"
            />
          )}

          {meta.needsEconomicQty && (
            <label className="mt-3 flex flex-col gap-1 text-xs text-zinc-500">
              경제 수량(선택 — 비우면 비례 역산)
              <input
                type="number"
                min={0}
                value={economicQty}
                onChange={(e) => setEconomicQty(e.target.value)}
                placeholder="예: 3"
                className="w-full rounded-lg border border-foreground/15 ui-field px-3 py-2 text-sm tabular-nums outline-none focus:border-foreground/40"
              />
            </label>
          )}

          {meta.needsPayout && (
            <div className="mt-3 flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-xs text-zinc-500">
                지급 참조번호(영숫자 . _ : - · 128자 이내)
                <input
                  type="text"
                  value={payoutRef}
                  onChange={(e) => setPayoutRef(e.target.value)}
                  placeholder="예: bank-20260724-0001"
                  className="w-full rounded-lg border border-foreground/15 ui-field px-3 py-2 text-sm outline-none focus:border-foreground/40"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-zinc-500">
                증빙 객체 uuid
                <input
                  type="text"
                  value={evidenceId}
                  onChange={(e) => setEvidenceId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  className="w-full rounded-lg border border-foreground/15 ui-field px-3 py-2 font-mono text-xs outline-none focus:border-foreground/40"
                />
              </label>
            </div>
          )}

          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          {notice && <p className="mt-2 text-xs text-amber-600">{notice}</p>}

          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={close}
              disabled={busy}
              className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm disabled:opacity-40"
            >
              닫기
            </button>
            {!notice && (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || !canSubmit}
                className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-40 ${
                  meta.danger ? "bg-red-500 text-white" : "bg-foreground text-paper-2"
                }`}
              >
                {busy && <Spinner className="h-3.5 w-3.5" />}
                {meta.btn}
              </button>
            )}
          </div>
        </ModalShell>
      )}
    </div>
  );
}
