"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  getMyProfile,
  updateNickname,
  NICKNAME_MAX,
  type MyProfile,
} from "@/lib/profile";
import { uploadAvatar } from "@/lib/avatar";
import { signOut } from "@/lib/auth-oauth";
import { Spinner } from "@/components/Spinner";

const DEFAULT_AVATAR = "/avatars/default.png";

/**
 * 계정 메뉴 — 익명/멤버에 따라 다른 UI.
 * - 익명: 닉네임 표시·수정 + 로그인 버튼
 * - 멤버: 아바타+닉네임 → 드롭다운(닉네임 변경 / 프사 변경 / 로그아웃)
 */
export function AccountMenu() {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [editingNick, setEditingNick] = useState(false);
  const [editingAvatar, setEditingAvatar] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    getMyProfile()
      .then((p) => {
        if (!cancelled && p) setProfile(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 바깥 클릭 시 드롭다운 닫기
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

  // ── 익명 — 닉네임 수정 + 로그인 ──────────────────────────────
  if (!profile.isMember) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setEditingNick(true)}
          className="flex max-w-[36vw] items-center gap-1 rounded-full border border-foreground/15 px-2.5 py-1.5 text-sm transition hover:bg-foreground/5"
          aria-label="닉네임 수정"
        >
          <span aria-hidden>👤</span>
          <span className="truncate">{profile.display_name}</span>
          <span aria-hidden className="text-xs text-zinc-500">
            ✎
          </span>
        </button>
        <Link
          href="/login"
          className="rounded-full bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition hover:opacity-90"
        >
          로그인
        </Link>
        {editingNick && (
          <NicknameEditor
            current={profile.display_name}
            onClose={() => setEditingNick(false)}
            onSaved={(name) => {
              setProfile((p) => (p ? { ...p, display_name: name } : p));
              setEditingNick(false);
            }}
          />
        )}
      </div>
    );
  }

  // ── 멤버 — 아바타 + 닉네임 드롭다운 ──────────────────────────
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-[44vw] items-center gap-1.5 rounded-full border border-foreground/15 py-1 pl-1 pr-2.5 text-sm transition hover:bg-foreground/5"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={profile.avatar_url ?? DEFAULT_AVATAR}
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
          className="absolute right-0 z-50 mt-1.5 w-44 overflow-hidden rounded-2xl border border-foreground/10 bg-background py-1 shadow-xl"
        >
          <MenuItem
            onClick={() => {
              setEditingNick(true);
              setOpen(false);
            }}
          >
            닉네임 변경
          </MenuItem>
          <MenuItem
            onClick={() => {
              setEditingAvatar(true);
              setOpen(false);
            }}
          >
            프로필 사진 변경
          </MenuItem>
          <MenuItem
            onClick={() => void signOut()}
            className="text-red-500"
          >
            로그아웃
          </MenuItem>
        </div>
      )}
      {editingNick && (
        <NicknameEditor
          current={profile.display_name}
          onClose={() => setEditingNick(false)}
          onSaved={(name) => {
            setProfile((p) => (p ? { ...p, display_name: name } : p));
            setEditingNick(false);
          }}
        />
      )}
      {editingAvatar && (
        <AvatarEditor
          current={profile.avatar_url ?? DEFAULT_AVATAR}
          onClose={() => setEditingAvatar(false)}
          onSaved={(url) => {
            setProfile((p) => (p ? { ...p, avatar_url: url } : p));
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

function AvatarEditor({
  current,
  onClose,
  onSaved,
}: {
  current: string;
  onClose: () => void;
  onSaved: (url: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const onFile = async (f: File) => {
    setError(null);
    if (!f.type.startsWith("image/")) {
      setError("이미지 파일만 올릴 수 있어요");
      return;
    }
    setBusy(true);
    try {
      const url = await uploadAvatar(f);
      onSaved(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "업로드 실패");
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-bold">프로필 사진 변경</h2>
      <p className="mt-1 text-xs text-zinc-500">
        랭킹에 표시되는 사진이에요. 정사각형으로 보여요.
      </p>
      <div className="mt-4 flex flex-col items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={current}
          alt=""
          className="h-28 w-28 rounded-full border border-foreground/15 object-cover"
        />
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="flex items-center justify-center gap-2 rounded-full border border-foreground/15 px-5 py-2.5 text-sm font-medium transition hover:bg-foreground/5 disabled:opacity-50"
        >
          {busy && <Spinner className="h-4 w-4" />}
          {busy ? "올리는 중…" : "사진 선택"}
        </button>
      </div>
      {error && <p className="mt-3 text-center text-xs text-red-400">{error}</p>}
      <button
        type="button"
        onClick={onClose}
        className="mt-4 w-full rounded-full border border-foreground/15 py-2.5 text-sm font-medium transition hover:bg-foreground/5"
      >
        닫기
      </button>
    </ModalShell>
  );
}

function ModalShell({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
