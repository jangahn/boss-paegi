"use client";

import { useState } from "react";
import Link from "next/link";
import { MenuItem } from "@/components/gallery/MenuItem";
import { HookToast } from "@/components/gallery/HookToast";
import { ctaFor, type ViewerState } from "@/lib/gallery-cta";
import { useMarketingCopy } from "@/components/MarketingCopyProvider";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { RubberStamp } from "@/components/dossier";
import { roleFrom } from "@/lib/config/domains/roles";
import { asRole } from "@/lib/roles";

const DEFAULT_BOSS_SRC = "/sprites/boss-default.png";

// 후킹 토스트 문구 — 공유/역할 변경 시도 시. 실제 액션 대신 가입/생성 유도.
const SHARE_HOOK = "나만의 캐릭터를 만들면 공유할 수 있어요!";
const ROLE_HOOK = "다른 역할은 캐릭터를 만들어야 바꿀 수 있어요!";

/**
 * 기본부장님 카드 — 갤러리 맨 앞 상시 노출, '기본' 뱃지로 내 캐릭터와 구분.
 * - 이미지 클릭 → /play (doll 파라미터 없음 = 기본부장님 플레이).
 * - state==="member"(캐릭터 보유 회원): ⋯ 메뉴 없음(play 전용).
 * - 그 외(nonmember·member-empty): ⋯ → [공유, 롤 변경]만 → 후킹 토스트(실 액션 호출 안 함).
 *   삭제 메뉴는 절대 없음. DB row 가 아니므로 shareDoll/PATCH/DELETE 호출 금지.
 */
export function DefaultBossCard({ state }: { state: ViewerState }) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const hasMenu = state !== "member"; // 캐릭터 보유 회원에겐 후킹 불필요 → play 전용
  const bossChip = roleFrom(asRole("boss"), useRoleConfig()).label; // DB 발행 호칭(기본 "부장님")
  const banner = useMarketingCopy().signupBanner;
  const cta = {
    label: state === "nonmember" ? banner.nonmemberCta : banner.memberEmptyCta,
    href: ctaFor(state).href,
  };

  const hook = (msg: string) => {
    setMenuOpen(false);
    setToastMsg(msg);
  };

  return (
    <div className="group relative">
      <div className="relative aspect-square overflow-hidden rounded-xl border border-line">
        {!imgLoaded && (
          <div className="absolute inset-0 animate-pulse bg-foreground/10" />
        )}
        {/* 이미지 영역만 Link — 카드 전체를 Link 로 감싸지 않음(⋯ 버튼은 Link 밖) */}
        <Link href="/play" className="block h-full w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={DEFAULT_BOSS_SRC}
            alt="기본 부장님"
            onLoad={() => setImgLoaded(true)}
            className={`h-full w-full object-cover transition duration-300 group-hover:scale-105 ${
              imgLoaded ? "opacity-100" : "opacity-0"
            }`}
          />
        </Link>
      </div>

      {/* 롤 칩 + '기본' 뱃지 (좌상단) */}
      <div className="pointer-events-none absolute left-2 top-2 z-20 flex items-center gap-1">
        <span className="rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-semibold text-white shadow backdrop-blur-sm">
          {bossChip}
        </span>
        <RubberStamp tone="gold" className="bg-paper/90 text-[10px] shadow backdrop-blur-sm">
          기본
        </RubberStamp>
      </div>

      {hasMenu && (
        <>
          {/* ⋯ 옵션 버튼 — Link 밖 absolute button (공유/롤 변경만, 삭제 없음) */}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            aria-label="옵션"
            className="absolute right-2 top-2 z-20 flex h-9 w-9 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-black/65 text-lg font-bold leading-none text-white shadow-lg backdrop-blur-sm transition hover:bg-black/80 active:scale-90"
          >
            ⋯
          </button>

          {menuOpen && (
            <>
              {/* 바깥 탭으로 닫기 */}
              <div
                className="fixed inset-0 z-20"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenuOpen(false);
                }}
              />
              <div className="absolute right-2 top-12 z-30 w-36 overflow-hidden rounded-lg border border-line bg-paper shadow-2xl">
                <MenuItem onClick={() => hook(SHARE_HOOK)}>공유</MenuItem>
                <MenuItem onClick={() => hook(ROLE_HOOK)}>역할 변경</MenuItem>
              </div>
            </>
          )}
        </>
      )}

      {toastMsg && (
        <HookToast
          message={toastMsg}
          cta={cta}
          onClose={() => setToastMsg(null)}
        />
      )}
    </div>
  );
}
