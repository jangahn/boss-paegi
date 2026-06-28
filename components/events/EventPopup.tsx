"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ModalShell } from "@/components/ModalShell";
import { EVENT_TYPE_LABEL } from "@/lib/events/types";
import { useActiveEvents } from "./useActiveEvents";

const KEY = (id: string) => `event_dismiss_${id}`;

/** "○일 안보기" 미만료 여부 — 클라 전용(localStorage·Date.now). effect/handler 안에서만 호출. */
function isDismissed(id: string): boolean {
  try {
    return Number(localStorage.getItem(KEY(id)) ?? "0") > Date.now();
  } catch {
    return false; // localStorage 불가 → 미dismiss
  }
}

/**
 * 홈 진입 팝업(a) — 활성 팝업 1건. "○일 안보기"(이벤트별 localStorage) 미만료 시 미표시.
 * 클릭→/news/[id]. 이미지 불요. (홈에서만 마운트.)
 * impure 검사(localStorage·Date.now)는 effect 의 async 경계 뒤에서만(render 순수성·set-state-in-effect 회피).
 */
export function EventPopup() {
  const { popup } = useActiveEvents();
  const [open, setOpen] = useState(false);
  const [dontShow, setDontShow] = useState(false);

  useEffect(() => {
    if (!popup) return;
    let alive = true;
    void (async () => {
      await Promise.resolve(); // render 밖 비동기 경계
      if (alive && !isDismissed(popup.id)) setOpen(true);
    })();
    return () => {
      alive = false;
    };
  }, [popup]);

  if (!popup || !open) return null;

  const close = () => {
    if (dontShow) {
      try {
        localStorage.setItem(KEY(popup.id), String(Date.now() + popup.popupDismissDays * 86_400_000));
      } catch {
        /* noop */
      }
    }
    setOpen(false);
  };

  return (
    <ModalShell onClose={close}>
      <div className="flex flex-col gap-3">
        <span className="w-fit rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] font-semibold text-zinc-500">
          {EVENT_TYPE_LABEL[popup.type]}
        </span>
        <h2 className="text-lg font-bold">{popup.title}</h2>
        <p className="text-sm leading-relaxed text-zinc-500">{popup.summary}</p>

        <Link
          href={`/news/${popup.id}`}
          onClick={close}
          className="mt-1 rounded-full bg-foreground py-3 text-center text-sm font-semibold text-paper-2 transition hover:opacity-90"
        >
          자세히 보기
        </Link>

        <div className="mt-1 flex items-center justify-between text-xs text-zinc-500">
          <label className="inline-flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
            {popup.popupDismissDays}일 동안 안보기
          </label>
          <button type="button" onClick={close} className="underline-offset-4 hover:text-foreground hover:underline">
            닫기
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
