"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Spinner } from "@/components/Spinner";
import { FadeImg } from "@/components/FadeImg";
import { MenuItem } from "@/components/gallery/MenuItem";
import { shareDoll } from "@/lib/doll-share";
import { trackShare } from "@/lib/acquisition";
import { useMarketingCopy } from "@/components/MarketingCopyProvider";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { roleFrom } from "@/lib/config/domains/roles";
import { asRole } from "@/lib/roles";
import { isCurrentClientEpoch } from "@/lib/client-lifecycle";

export type Doll = {
  id: string;
  image_url: string;
  created_at: string;
  role: string;
};

// 실 캐릭터 카드 — 공유/삭제. 롤·성별은 캐릭터의 속성이지만 생성 뒤엔 어드민만 바꾼다(v1.29 — 유저 「역할 변경」 제거).
export function DollCard({
  doll,
  deleting,
  onDelete,
}: {
  doll: Doll;
  deleting: boolean;
  onDelete: () => void;
}) {
  const role = asRole(doll.role);
  const mk = useMarketingCopy();
  const cfg = useRoleConfig(); // DB 발행 호칭(roleFrom) — 마케터 변경이 갤러리칩/메뉴/토스트에 반영
  const [menuOpen, setMenuOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const actionEpochRef = useRef(0);
  const sharingRef = useRef(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      actionEpochRef.current += 1;
      if (flashTimerRef.current !== null) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, []);

  const flash = (msg: string, actionEpoch: number) => {
    if (
      !isCurrentClientEpoch(
        actionEpoch,
        actionEpochRef.current,
        mountedRef.current,
      )
    ) {
      return;
    }
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    setActionMsg(msg);
    flashTimerRef.current = setTimeout(() => {
      flashTimerRef.current = null;
      if (
        isCurrentClientEpoch(
          actionEpoch,
          actionEpochRef.current,
          mountedRef.current,
        )
      ) {
        setActionMsg(null);
      }
    }, 1800);
  };

  const closeMenu = () => {
    setMenuOpen(false);
  };

  const beginAction = () => {
    const actionEpoch = actionEpochRef.current + 1;
    actionEpochRef.current = actionEpoch;
    if (flashTimerRef.current !== null) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    setActionMsg(null);
    return actionEpoch;
  };

  const handleShare = async () => {
    closeMenu();
    if (sharingRef.current || deleting) return;
    sharingRef.current = true;
    const actionEpoch = beginAction();
    setSharing(true);
    // 공유 시도(분석) — 갤러리 캐릭터. (surface×target×session) 3초 디바운스.
    try {
      trackShare({ surface: "gallery", target: "doll" });
    } catch {
      // Analytics must never block the share action.
    }
    try {
      const result = await shareDoll(doll.image_url, doll.id, role, undefined, mk);
      if (result === "copied") flash("링크 복사됨", actionEpoch);
      else if (result === "failed") flash("공유 실패", actionEpoch);
    } catch {
      flash("공유 실패", actionEpoch);
    } finally {
      if (
        isCurrentClientEpoch(
          actionEpoch,
          actionEpochRef.current,
          mountedRef.current,
        )
      ) {
        sharingRef.current = false;
        setSharing(false);
      }
    }
  };

  return (
    // outer 는 overflow 없음 — 드롭다운이 카드 경계 (둥근 모서리 클리핑) 에
    // 잘리지 않게 이미지 영역과 분리 (작은 폰에서 메뉴가 카드보다 큼)
    <div className="group relative">
      <div className="relative aspect-square overflow-hidden rounded-2xl border border-foreground/10 ui-surface">
        {/* 이미지 로드 전 shimmer 스켈레톤(FadeImg) → 로드 시 페이드인. hover 줌은 wrapper 스케일. */}
        <Link href={`/play?doll=${doll.id}`} className="block h-full w-full">
          <FadeImg
            src={doll.image_url}
            placeholder="shimmer"
            loading="lazy"
            fit="cover"
            className="h-full w-full transition duration-300 group-hover:scale-105"
          />
        </Link>

        {actionMsg && (
          <span className="absolute bottom-2 left-2 z-10 rounded-full bg-black/65 px-2.5 py-1 text-[10px] text-white">
            {actionMsg}
          </span>
        )}
        {sharing && (
          <span className="absolute bottom-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/65">
            <Spinner className="h-3.5 w-3.5 text-white" />
          </span>
        )}

        {/* 삭제 진행 중 — 카드 dim + 스피너 */}
        {deleting && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/55 backdrop-blur-[2px]">
            <Spinner className="h-6 w-6 text-white" />
            <span className="text-xs font-medium text-white/90">
              삭제 중...
            </span>
          </div>
        )}

      </div>

      {/* 롤 칩 (좌상단 — ⋯ 버튼/공유 스피너와 안 겹치게) */}
      <span className="pointer-events-none absolute left-2 top-2 z-20 rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-semibold text-white shadow backdrop-blur-sm">
        {roleFrom(role, cfg).label}
      </span>

      {/* ⋯ 옵션 버튼 — 공유/삭제 메뉴 */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        disabled={deleting || sharing}
        aria-label="옵션"
        className="absolute right-2 top-2 z-20 flex h-9 w-9 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-black/65 text-lg font-bold leading-none text-white shadow-lg backdrop-blur-sm transition hover:bg-black/80 active:scale-90 disabled:opacity-40"
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
              closeMenu();
            }}
          />
          <div className="absolute right-2 top-12 z-30 w-36 overflow-hidden rounded-xl border border-foreground/10 ui-surface shadow-2xl">
            <MenuItem onClick={handleShare}>공유</MenuItem>
            <MenuItem
              onClick={() => {
                closeMenu();
                onDelete();
              }}
              danger
            >
              삭제
            </MenuItem>
          </div>
        </>
      )}
    </div>
  );
}
