"use client";

import Link from "next/link";
import { FadeImg } from "@/components/FadeImg";
import type { ViewerState } from "@/lib/gallery-cta";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { roleFrom } from "@/lib/config/domains/roles";
import { asRole } from "@/lib/roles";
import { BASE_DOLLS, DEFAULT_BASE_DOLL } from "@/lib/base-dolls";

// 카드 썸네일(v1.61) — 게임용 원본(768×1024 PNG) 대신 384×512 WebP.
const DEFAULT_BOSS_SRC = BASE_DOLLS[DEFAULT_BASE_DOLL].thumb;


/**
 * 기본부장님 카드 — 갤러리 맨 앞 상시 노출, '기본' 뱃지로 내 캐릭터와 구분.
 * - 이미지 클릭 → /play (doll 파라미터 없음 = 기본부장님 플레이).
 * - ⋯ 메뉴 없음(v1.42): 기본 캐릭터(기본 부장님·추가 4종)는 공유·삭제·역할 변경 기능이 없고 어떤 뷰어 상태에서도 일관되게
 *   비활성. 종전의 [공유, 역할 변경] 가짜 후킹 항목은 제거(역할 변경은 v1.29 에 사용자 기능에서 사라짐). 후킹은 배너·잠금 카드가 맡는다.
 *   DB row 가 아니므로 shareDoll/PATCH/DELETE 호출 금지.
 */
export function DefaultBossCard({ state: _state }: { state: ViewerState }) {
  const bossChip = roleFrom(asRole("boss"), useRoleConfig()).label; // DB 발행 호칭(기본 "부장님")
  return (
    <div className="group relative">
      <div className="relative aspect-square overflow-hidden rounded-2xl border border-foreground/10 ui-surface">
        {/* 이미지 영역만 Link — 카드 전체를 Link 로 감싸지 않음(⋯ 버튼은 Link 밖) */}
        <Link href="/play" className="block h-full w-full">
          <FadeImg
            src={DEFAULT_BOSS_SRC}
            alt="기본 부장님"
            placeholder="shimmer"
            loading="eager"
            fit="cover"
            className="h-full w-full transition duration-300 group-hover:scale-105"
          />
        </Link>
      </div>

      {/* 롤 칩 + '기본' 뱃지 (좌상단) */}
      <div className="pointer-events-none absolute left-2 top-2 z-20 flex items-center gap-1">
        <span className="rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-semibold text-white shadow backdrop-blur-sm">
          {bossChip}
        </span>
        <span className="rounded-full bg-amber-500/90 px-2 py-0.5 text-[10px] font-semibold text-white shadow backdrop-blur-sm">
          기본
        </span>
      </div>

    </div>
  );
}
