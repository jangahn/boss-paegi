"use client";

import { useState } from "react";
import Link from "next/link";
import { FadeImg } from "@/components/FadeImg";
import { HookToast } from "@/components/gallery/HookToast";
import { LOGIN_THEN_GALLERY, type ViewerState } from "@/lib/gallery-cta";
import { useMarketingCopy } from "@/components/MarketingCopyProvider";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { roleFrom } from "@/lib/config/domains/roles";
import { playHrefFor, type BaseDoll } from "@/lib/base-dolls";

/**
 * 추가 기본 캐릭터 카드(v1.42) — 기본 부장님 카드 뒤에 4장, '추가' 뱃지(청록)로 기본 부장님('기본' 호박)·내 캐릭터와 구분.
 * - 회원: 이미지 탭 → /play?doll=<key>. ⋯ 메뉴 없음(기본 캐릭터는 공유·삭제·역할 변경 기능 없음 — 어떤 상태에서도 일관).
 * - 비회원: 🔒 잠금 티저(흐림) — 탭하면 가입 유도 토스트(LOGIN_THEN_GALLERY). 링크(URL)를 아는 비회원은 /play 로 직접 플레이 가능.
 */
const LOCKED_HOOK = "가입하면 추가 캐릭터 4명이 열려요!";

export function BaseDollCard({ doll, state }: { doll: BaseDoll; state: ViewerState }) {
  const locked = state === "nonmember";
  const [toast, setToast] = useState(false);
  const roleChip = roleFrom(doll.role, useRoleConfig()).label; // DB 발행 호칭(사장님·부장님·팀장님·신입)
  const banner = useMarketingCopy().signupBanner;
  const alt = `추가 캐릭터 ${roleChip}`;

  const image = (
    <FadeImg
      src={doll.image}
      alt={alt}
      placeholder="shimmer"
      fit="cover"
      className={`h-full w-full transition duration-300 ${locked ? "blur-[2px] opacity-60 grayscale-[35%]" : "group-hover:scale-105"}`}
    />
  );

  return (
    <div className="group relative">
      <div className="relative aspect-square overflow-hidden rounded-2xl border border-foreground/10 ui-surface">
        {locked ? (
          <button
            type="button"
            onClick={() => setToast(true)}
            aria-label={`${alt} — 가입하면 열려요`}
            className="block h-full w-full cursor-pointer"
          >
            {image}
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="rounded-full bg-black/65 px-3 py-1.5 text-xs font-semibold text-white shadow backdrop-blur-sm">
                🔒 가입하면 열림
              </span>
            </span>
          </button>
        ) : (
          <Link href={playHrefFor(doll.key)} className="block h-full w-full" aria-label={`${alt} 패기`}>
            {image}
          </Link>
        )}
      </div>

      {/* 롤 칩 + '추가' 뱃지 (좌상단) — 기본 부장님 카드와 같은 자리·크기 */}
      <div className="pointer-events-none absolute left-2 top-2 z-20 flex items-center gap-1">
        <span className="rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-semibold text-white shadow backdrop-blur-sm">
          {roleChip}
        </span>
        <span className="rounded-full bg-teal-600/90 px-2 py-0.5 text-[10px] font-semibold text-white shadow backdrop-blur-sm">
          추가
        </span>
      </div>

      {toast && (
        <HookToast
          message={LOCKED_HOOK}
          cta={{ label: banner.lockedCta, href: LOGIN_THEN_GALLERY }}
          onClose={() => setToast(false)}
        />
      )}
    </div>
  );
}
