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
  const [withdrawing, setWithdrawing] = useState(false);
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
          setProfile(
            (prev) =>
              prev ?? { id: uid, ...cached, genCredits: null, isAdmin: false }
          );
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
          {isMember && profile.genCredits !== null && (
            <div className="border-b border-foreground/10 px-4 py-2.5 text-sm text-zinc-500">
              생성권{" "}
              <span className="font-semibold text-foreground">
                {formatCredits(profile.genCredits)}
              </span>
            </div>
          )}
          {isMember && (
            <Link
              href="/credits"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-4 py-2.5 text-left text-sm font-semibold text-amber-600 transition hover:bg-foreground/5"
            >
              생성권 충전
            </Link>
          )}
          {isMember && profile.isAdmin && (
            <Link
              href="/admin"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block border-b border-foreground/10 px-4 py-2.5 text-left text-sm font-semibold text-emerald-600 transition hover:bg-foreground/5"
            >
              운영 대시보드
            </Link>
          )}
          <Link
            href="/badges"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-left text-sm transition hover:bg-foreground/5"
          >
            내 뱃지
          </Link>
          <Link
            href={`/history/${profile.id}`}
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-left text-sm transition hover:bg-foreground/5"
          >
            내 기록
          </Link>
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
          {isMember && (
            <MenuItem
              onClick={() => {
                setWithdrawing(true);
                setOpen(false);
              }}
              className="border-t border-foreground/10 text-red-500"
            >
              계정 삭제
            </MenuItem>
          )}
        </div>
      )}

      {withdrawing && <WithdrawModal onClose={() => setWithdrawing(false)} />}

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

// 셀프 탈퇴 — 2-step 확인(고지 + 동의 체크). 성공 시 signOut(세션 종료·캐시/Sentry 정리·홈).
function WithdrawModal({ onClose }: { onClose: () => void }) {
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !ack) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (res.ok) {
        await signOut(); // 세션 종료 + clearProfileCache + Sentry.setUser(null) + 홈
        return;
      }
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      setError(
        out.error === "payment_pending"
          ? "진행 중인 결제가 있어요. 잠시 후 다시 시도해 주세요."
          : "탈퇴 처리에 실패했어요. 잠시 후 다시 시도해 주세요."
      );
    } catch {
      setError("네트워크 오류 — 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-bold text-red-500">계정 삭제(탈퇴)</h2>
      <div className="mt-2 space-y-1.5 text-sm text-zinc-500">
        <p>
          탈퇴하면 프로필과 업로드한 캐릭터 이미지는 삭제 또는 익명화되며,{" "}
          <b className="text-foreground">되돌릴 수 없습니다.</b>
        </p>
        <p>· 남은 생성권은 사용할 수 없으며 복구되지 않을 수 있습니다.</p>
        <p>· 결제 기록은 관련 법령에 따라 일정 기간 보존될 수 있습니다.</p>
        <p>· 탈퇴 후 같은 계정으로 다시 로그인할 수 없습니다.</p>
      </div>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          className="mt-0.5"
        />
        <span>위 내용을 이해했으며 되돌릴 수 없음에 동의합니다.</span>
      </label>
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
          onClick={() => void submit()}
          disabled={busy || !ack}
          className="flex flex-1 items-center justify-center gap-2 rounded-full bg-red-500 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
        >
          {busy && <Spinner className="h-4 w-4" />}
          탈퇴하기
        </button>
      </div>
    </ModalShell>
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
