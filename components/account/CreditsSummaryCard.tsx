"use client";

import { useEffect, useState } from "react";
import { Spinner } from "@/components/Spinner";

type MyCredits = {
  available: number;
  refundProcessing: number;
  expiredUnrefunded: number;
};

/**
 * 내 생성권 3분류 카드 — `/api/account/credits`(§11.6 단일 산식) 클라 조회로 표시.
 * 산식을 여기서 재계산하지 않는다(정본은 endpoint 하나 — 드리프트 방지). 표시 전용.
 */
export function CreditsSummaryCard() {
  const [credits, setCredits] = useState<MyCredits | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account/credits")
      .then((res) => (res.ok ? (res.json() as Promise<{ ok?: boolean } & MyCredits>) : null))
      .then((d) => {
        if (cancelled) return;
        if (d?.ok) setCredits(d);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="rounded-2xl border border-foreground/10 ui-surface p-5">
      <h2 className="text-sm font-semibold text-zinc-500">내 생성권</h2>
      {credits ? (
        <>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div>
              <dt className="text-xs text-zinc-500">사용 가능</dt>
              <dd className="mt-1 text-lg font-extrabold tabular-nums">{credits.available}개</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">환불 처리 중</dt>
              <dd className="mt-1 text-lg font-extrabold tabular-nums">
                {credits.refundProcessing}개
              </dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">만료·미환불</dt>
              <dd className="mt-1 text-lg font-extrabold tabular-nums">
                {credits.expiredUnrefunded}개
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-zinc-400">
            만료·미환불은 유효기간이 지난 유료 생성권 중 환불을 요청할 수 있는 수량이에요. 환불
            처리 중 수량은 처리 완료까지 사용할 수 없어요.
          </p>
        </>
      ) : failed ? (
        <p className="mt-3 text-xs text-zinc-400">
          생성권 정보를 불러오지 못했어요. 잠시 후 다시 시도해주세요.
        </p>
      ) : (
        <div className="mt-3 flex justify-center py-2">
          <Spinner className="h-5 w-5" />
        </div>
      )}
    </section>
  );
}
