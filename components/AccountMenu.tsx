"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  getMyProfile,
  updateNickname,
  formatCredits,
  readCachedProfile,
  writeCachedProfile,
  NICKNAME_MAX,
  type MyProfile,
} from "@/lib/profile";
import { createClient } from "@/lib/supabase/client";
import { signOut } from "@/lib/auth-oauth";
import { ModalShell } from "@/components/ModalShell";
import { AvatarEditor } from "@/components/AvatarEditor";
import { Spinner } from "@/components/Spinner";

const DEFAULT_AVATAR = "/avatars/default.png";

/**
 * 계정 메뉴 — 익명/멤버 공통으로 **아바타+닉네임 버튼 → 드롭다운** (UI 일관).
 * 드롭다운 항목만 상태별로 다름:
 * - 익명: 로그인/회원가입 · 닉네임 변경
 * - 멤버: 닉네임 변경 · 프로필 사진 변경 · 로그아웃
 */
export function AccountMenu() {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [editingNick, setEditingNick] = useState(false);
  const [editingAvatar, setEditingAvatar] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    // 1) 로컬 세션 → 캐시된 닉/프사 즉시 렌더(네트워크 없이) → nav 스피너 제거.
    createClient()
      .auth.getSession()
      .then(({ data }) => {
        const uid = data.session?.user.id;
        if (!uid || cancelled) return;
        const cached = readCachedProfile(uid);
        // prev ?? — 백그라운드 fresh 가 먼저 도착했으면 덮어쓰지 않음.
        if (cached)
          setProfile((prev) => prev ?? { id: uid, ...cached, genCredits: null });
      })
      .catch(() => {});
    // 2) 백그라운드 fresh 조회(genCredits 포함) + 캐시 갱신.
    getMyProfile()
      .then((p) => {
        if (cancelled || !p) return;
        setProfile(p);
        writeCachedProfile(p.id, p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!profile) {
    return (
      <div className="flex h-8 w-24 items-center justify-end">
        <Spinner className="h-4 w-4" />
      </div>
    );
  }

  const isMember = profile.isMember;
  const avatar = profile.avatar_url ?? DEFAULT_AVATAR;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-[48vw] items-center gap-1.5 rounded-full border border-foreground/15 py-1 pl-1 pr-2.5 text-sm transition hover:bg-foreground/5"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="내 계정"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatar}
          alt=""
          className="h-6 w-6 rounded-full border border-foreground/10 object-cover"
        />
        <span className="truncate">{profile.display_name}</span>
        <span aria-hidden className="text-xs text-zinc-500">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1.5 w-48 overflow-hidden rounded-2xl border border-foreground/10 bg-background py-1 shadow-xl"
        >
          {isMember && profile.genCredits !== null && (
            <div className="border-b border-foreground/10 px-4 py-2.5 text-sm text-zinc-500">
              생성권{" "}
              <span className="font-semibold text-foreground">
                {formatCredits(profile.genCredits)}
              </span>
            </div>
          )}
          <Link
            href="/badges"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-left text-sm font-semibold transition hover:bg-foreground/5"
          >
            🏅 내 뱃지
          </Link>
          {!isMember && (
            <Link
              href="/login"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-4 py-2.5 text-left text-sm font-semibold transition hover:bg-foreground/5"
            >
              로그인 / 회원가입
            </Link>
          )}
          <MenuItem
            onClick={() => {
              setEditingNick(true);
              setOpen(false);
            }}
          >
            닉네임 변경
          </MenuItem>
          {isMember && (
            <MenuItem
              onClick={() => {
                setEditingAvatar(true);
                setOpen(false);
              }}
            >
              프로필 사진 변경
            </MenuItem>
          )}
          {isMember && (
            <MenuItem onClick={() => void signOut()} className="text-red-500">
              로그아웃
            </MenuItem>
          )}
        </div>
      )}

      {editingNick && (
        <NicknameEditor
          current={profile.display_name}
          onClose={() => setEditingNick(false)}
          onSaved={(name) => {
            setProfile((p) => {
              if (!p) return p;
              const next = { ...p, display_name: name };
              writeCachedProfile(p.id, next);
              return next;
            });
            setEditingNick(false);
          }}
        />
      )}
      {editingAvatar && (
        <AvatarEditor
          current={avatar}
          hasCustomAvatar={profile.avatar_url !== null}
          onClose={() => setEditingAvatar(false)}
          onSaved={(url) => {
            setProfile((p) => {
              if (!p) return p;
              const next = { ...p, avatar_url: url };
              writeCachedProfile(p.id, next);
              return next;
            });
            setEditingAvatar(false);
          }}
        />
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`w-full px-4 py-2.5 text-left text-sm transition hover:bg-foreground/5 ${className}`}
    >
      {children}
    </button>
  );
}

function NicknameEditor({
  current,
  onClose,
  onSaved,
}: {
  current: string;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await updateNickname(value);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-bold">닉네임 수정</h2>
      <p className="mt-1 text-xs text-zinc-500">
        랭킹과 공유 페이지에 표시되는 이름이에요. ({NICKNAME_MAX}자 이내)
      </p>
      <input
        autoFocus
        type="text"
        value={value}
        maxLength={NICKNAME_MAX}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleSave();
          if (e.key === "Escape") onClose();
        }}
        className="mt-4 w-full rounded-xl border border-foreground/15 bg-transparent px-4 py-3 text-base outline-none focus:border-foreground/40"
      />
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 rounded-full border border-foreground/15 py-2.5 text-sm font-medium transition hover:bg-foreground/5"
        >
          취소
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || value.trim().length < 2}
          className="flex flex-1 items-center justify-center gap-2 rounded-full bg-foreground py-2.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-40"
        >
          {saving && <Spinner className="h-4 w-4" />}
          저장
        </button>
      </div>
    </ModalShell>
  );
}
