"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  FAL_AUP_URL,
  FAL_TERMS_URL,
  parseGenerationProviderAcceptanceHttpAck,
} from "@/lib/generation-provider-acceptance";
import {
  clientMutationResponseNeedsReconciliation,
  readBoundedClientJsonResponse,
  runClientMutation,
  type ClientMutationEvidence,
} from "@/lib/client-mutation";

export function GenerationProviderAcceptanceGate() {
  const router = useRouter();
  const requestIdRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const lifecycleRef = useRef<AbortController | null>(null);
  const [adult, setAdult] = useState(false);
  const [terms, setTerms] = useState(false);
  const [aup, setAup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = adult && terms && aup;

  useEffect(() => {
    const controller = new AbortController();
    lifecycleRef.current = controller;
    return () => {
      controller.abort(new Error("provider_acceptance_gate_unmounted"));
      if (lifecycleRef.current === controller) lifecycleRef.current = null;
    };
  }, []);

  const submit = async () => {
    if (!ready || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    requestIdRef.current ??= crypto.randomUUID();
    const requestId = requestIdRef.current;
    const requestBody = JSON.stringify({
      requestId,
      adultSelfAttested: true,
      falTermsAccepted: true,
      falAupAccepted: true,
    });
    const lifecycleSignal = lifecycleRef.current?.signal;
    try {
      const deliver = async (
        signal: AbortSignal,
      ): Promise<ClientMutationEvidence<true>> => {
        const response = await fetch(
          "/api/account/generation-provider-acceptance",
          {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
          cache: "no-store",
          signal,
          },
        );
        const responseBody =
          await readBoundedClientJsonResponse(response, signal);
        const body: unknown = responseBody.ok
          ? responseBody.value
          : null;
        if (response.ok) {
          try {
            parseGenerationProviderAcceptanceHttpAck(body, requestId);
            return { kind: "confirmed", value: true };
          } catch (error) {
            return {
              kind: "unconfirmed",
              reason: "provider_acceptance_response_invalid",
              error,
            };
          }
        }
        if (
          clientMutationResponseNeedsReconciliation(
            response.status,
            response.ok,
          )
        ) {
          return {
            kind: "unconfirmed",
            reason: "provider_acceptance_response_ambiguous",
            error: response.status,
          };
        }
        return { kind: "rejected", error: response.status };
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
      setError(
        outcome.kind === "unconfirmed"
          ? "저장 결과를 확인하지 못했어요. 같은 요청을 안전하게 재확인했지만 확정되지 않았습니다. 다시 시도해주세요."
          : outcome.error === 503
          ? "현재 AI 생성 기능을 준비 중입니다."
          : "확인을 저장하지 못했어요. 다시 시도해주세요.",
      );
    } catch {
      if (!lifecycleSignal?.aborted) {
        setError("저장 결과를 확인하지 못했어요. 다시 시도해주세요.");
      }
    } finally {
      busyRef.current = false;
      if (!lifecycleSignal?.aborted) setBusy(false);
    }
  };

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <section className="w-full max-w-lg rounded-2xl border border-foreground/15 ui-surface p-6">
        <h1 className="text-2xl font-bold">AI 생성 이용 전 확인</h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-500">
          기본 게임의 만 14세 이상 확인과 별도로, AI 생성에는 아래 세
          항목을 각각 확인해야 합니다.
        </p>
        <div className="mt-6 space-y-3">
          <AcceptanceCheck
            checked={adult}
            disabled={busy}
            onChange={setAdult}
          >
            본인은 대한민국 기준 만 19세 이상입니다.
          </AcceptanceCheck>
          <AcceptanceCheck
            checked={terms}
            disabled={busy}
            onChange={setTerms}
          >
            fal.ai{" "}
            <a
              href={FAL_TERMS_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              이용약관
            </a>
            을 읽고 준수하는 데 동의합니다.
          </AcceptanceCheck>
          <AcceptanceCheck checked={aup} disabled={busy} onChange={setAup}>
            fal.ai{" "}
            <a
              href={FAL_AUP_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Acceptable Use Policy
            </a>
            를 읽고 준수하는 데 동의합니다.
          </AcceptanceCheck>
        </div>
        {error && (
          <p role="alert" className="mt-4 text-sm text-red-400">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={!ready || busy}
          onClick={submit}
          className="mt-6 w-full rounded-full bg-foreground py-4 font-semibold text-paper-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "저장 중…" : "각 항목 확인 후 계속"}
        </button>
      </section>
    </main>
  );
}

function AcceptanceCheck({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-3 rounded-xl border border-foreground/15 p-3 text-sm leading-relaxed">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="mt-1 h-4 w-4"
      />
      <span>{children}</span>
    </label>
  );
}
