"use client";

import Link from "next/link";
import { EVENT_TYPE_LABEL, type BannerSurface } from "@/lib/events/types";
import { useActiveEvents } from "./useActiveEvents";

/**
 * 배너 구좌(c) — 지면별(홈·갤러리·랭킹) 독립. 해당 지면 활성 배너 이벤트의 summary 를 짧게, 클릭→/news/[id].
 * 없으면 미렌더. (기존 가입 배너 SignupBanner 와 별개 구좌로 공존.)
 */
export function EventBanner({ surface }: { surface: BannerSurface }) {
  const { banners, error, retry } = useActiveEvents();
  const banner = banners[surface];
  if (error) {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-3 rounded-2xl border border-red-500/20 bg-red-500/5 p-3.5 text-xs text-red-500"
      >
        <span>공지 정보를 불러오지 못했어요.</span>
        <button
          type="button"
          onClick={retry}
          className="shrink-0 font-semibold underline underline-offset-4"
        >
          다시 시도
        </button>
      </div>
    );
  }
  if (!banner) return null;
  return (
    <Link
      href={`/news/${banner.id}`}
      className="flex items-center justify-between gap-3 rounded-2xl border border-steel/30 bg-steel/10 p-3.5 transition hover:bg-steel/15"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 rounded-full bg-steel/20 px-2 py-0.5 text-[10px] font-semibold text-steel">
          {EVENT_TYPE_LABEL[banner.type]}
        </span>
        <p className="truncate text-sm font-medium">{banner.summary}</p>
      </div>
      <span className="shrink-0 text-xs font-semibold text-steel">자세히 →</span>
    </Link>
  );
}
