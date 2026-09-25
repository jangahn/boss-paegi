"use client";

import Link from "next/link";
import { playJelly } from "@/lib/motion";
import { clearPlayDollSource, markPlayDollSource } from "@/lib/view-transition";
import { FadeImg } from "@/components/FadeImg";
import type { ViewerState } from "@/lib/gallery-cta";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { roleFrom } from "@/lib/config/domains/roles";
import { playHrefFor, type BaseDoll } from "@/lib/base-dolls";

/**
 * 추가 기본 캐릭터 카드(v1.42) — 기본 부장님 카드 뒤에 4장, '추가' 뱃지(청록)로 기본 부장님('기본' 호박)·내 캐릭터와 구분.
 * - 회원: 이미지 탭 → /play?doll=<key>. ⋯ 메뉴 없음(기본 캐릭터는 공유·삭제·역할 변경 기능 없음 — 어떤 상태에서도 일관).
 * - 비회원: 🔒 잠금 티저(흐림 + "가입하면 열림" 칩) — **상호작용 없음**(v1.44: 탭 토스트·어드민 문구 키 제거, 가입 유도는
 *   갤러리 배너·게임 종료 화면이 맡는다). 링크(URL)를 아는 비회원은 /play 로 직접 플레이 가능.
 */
export function BaseDollCard({ doll, state }: { doll: BaseDoll; state: ViewerState }) {
  const locked = state === "nonmember";
  const roleChip = roleFrom(doll.role, useRoleConfig()).label; // DB 발행 호칭(사장님·부장님·팀장님·신입)
  const alt = `추가 캐릭터 ${roleChip}`;

  const image = (
    <FadeImg
      src={doll.thumb}
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
          <div className="block h-full w-full">
            {image}
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="rounded-full bg-black/65 px-3 py-1.5 text-xs font-semibold text-white shadow backdrop-blur-sm">
                🔒 가입하면 열림
              </span>
            </span>
          </div>
        ) : (
          <Link
            href={playHrefFor(doll.key)}
            className="block h-full w-full"
            aria-label={`${alt} 패기`}
            onPointerDown={(e) => {
              playJelly(e.currentTarget, { amp: 0.07, origin: "50% 100%" });
              markPlayDollSource(e.currentTarget); // 이 카드가 게임 로딩 막의 캐릭터로 이어진다
            }}
            onPointerCancel={clearPlayDollSource}
          >
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
    </div>
  );
}
