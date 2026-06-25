"use client";

import { useState } from "react";
import Link from "next/link";
import { Spinner } from "@/components/Spinner";
import { MenuItem } from "@/components/gallery/MenuItem";
import { shareDoll } from "@/lib/doll-share";
import { useMarketingCopy } from "@/components/MarketingCopyProvider";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { roleFrom } from "@/lib/config/domains/roles";
import { ROLE_IDS, asRole, josaEuro, type RoleId } from "@/lib/roles";

export type Doll = {
  id: string;
  image_url: string;
  created_at: string;
  role: string;
};

// 실 캐릭터 카드 — 공유/롤 변경/삭제. (app/gallery/page.tsx 에서 분리·이동, 동작 변경 없음.)
export function DollCard({
  doll,
  deleting,
  onDelete,
  onRoleChange,
}: {
  doll: Doll;
  deleting: boolean;
  onDelete: () => void;
  onRoleChange: (id: string, role: RoleId) => void;
}) {
  const role = asRole(doll.role);
  const mk = useMarketingCopy();
  const cfg = useRoleConfig(); // DB 발행 호칭(roleFrom) — 마케터 변경이 갤러리칩/메뉴/토스트에 반영
  const [imgLoaded, setImgLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [roleMenu, setRoleMenu] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [savingRole, setSavingRole] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const flash = (msg: string) => {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(null), 1800);
  };

  const closeMenu = () => {
    setMenuOpen(false);
    setRoleMenu(false);
  };

  const handleShare = async () => {
    closeMenu();
    if (sharing) return;
    setSharing(true);
    try {
      const result = await shareDoll(doll.image_url, doll.id, role, undefined, mk);
      if (result === "copied") flash("링크 복사됨");
      else if (result === "failed") flash("공유 실패");
    } finally {
      setSharing(false);
    }
  };

  const handleRole = async (next: RoleId) => {
    if (savingRole) return;
    if (next === role) {
      closeMenu();
      return;
    }
    closeMenu(); // 메뉴 닫고 카드 오버레이("변경 중…")로 진행 표시
    setSavingRole(true);
    try {
      const r = await fetch("/api/doll", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: doll.id, role: next }),
      });
      if (!r.ok) {
        flash("역할 변경 실패");
        return;
      }
      onRoleChange(doll.id, next);
      const nextLabel = roleFrom(next, cfg).label;
      flash(`${nextLabel}${josaEuro(nextLabel)} 변경`);
    } catch {
      flash("역할 변경 실패");
    } finally {
      setSavingRole(false);
    }
  };

  return (
    // outer 는 overflow 없음 — 드롭다운이 카드 경계 (둥근 모서리 클리핑) 에
    // 잘리지 않게 이미지 영역과 분리 (작은 폰에서 메뉴가 카드보다 큼)
    <div className="group relative">
      <div className="relative aspect-square overflow-hidden rounded-2xl border border-foreground/10">
        {/* 이미지 로드 전 pulse placeholder */}
        {!imgLoaded && (
          <div className="absolute inset-0 animate-pulse bg-foreground/10" />
        )}
        <Link href={`/play?doll=${doll.id}`} className="block h-full w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={doll.image_url}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setImgLoaded(true)}
            className={`h-full w-full object-cover transition duration-300 group-hover:scale-105 ${
              imgLoaded ? "opacity-100" : "opacity-0"
            }`}
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

        {/* 롤 변경 진행 중 — 카드 dim + 스피너 (탭/대기 구분) */}
        {savingRole && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/55 backdrop-blur-[2px]">
            <Spinner className="h-6 w-6 text-white" />
            <span className="text-xs font-medium text-white/90">변경 중…</span>
          </div>
        )}
      </div>

      {/* 롤 칩 (좌상단 — ⋯ 버튼/공유 스피너와 안 겹치게) */}
      <span className="pointer-events-none absolute left-2 top-2 z-20 rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-semibold text-white shadow backdrop-blur-sm">
        {roleFrom(role, cfg).label}
      </span>

      {/* ⋯ 옵션 버튼 — 공유/롤 변경/삭제 메뉴 */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setRoleMenu(false);
          setMenuOpen((v) => !v);
        }}
        disabled={deleting}
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
          <div className="absolute right-2 top-12 z-30 w-36 overflow-hidden rounded-xl border border-foreground/10 bg-background shadow-2xl">
            {roleMenu ? (
              ROLE_IDS.map((rid) => (
                <MenuItem key={rid} onClick={() => void handleRole(rid)}>
                  {roleFrom(rid, cfg).label}
                  {rid === role ? " ✓" : ""}
                </MenuItem>
              ))
            ) : (
              <>
                <MenuItem onClick={handleShare}>공유</MenuItem>
                <MenuItem onClick={() => setRoleMenu(true)}>역할 변경</MenuItem>
                <MenuItem
                  onClick={() => {
                    closeMenu();
                    onDelete();
                  }}
                  danger
                >
                  삭제
                </MenuItem>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
