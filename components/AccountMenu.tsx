"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  getMyProfile,
  updateNickname,
  formatCredits,
  readCachedProfile,
  writeCachedProfile,
  NICKNAME_MAX,
  CREDITS_CHANGED_EVENT,
  type MyProfile,
} from "@/lib/profile";
import { createClient } from "@/lib/supabase/client";
import { signOut } from "@/lib/auth-oauth";
import { ModalShell } from "@/components/ModalShell";
import { Spinner } from "@/components/Spinner";
import { FadeImg } from "@/components/FadeImg";
import { runClientMutation } from "@/lib/client-mutation";

const DEFAULT_AVATAR = "/avatars/default.png";

/**
 * 계정 메뉴 — 익명/멤버 공통으로 **아바타+닉네임 버튼 → 드롭다운** (UI 일관).
 * 드롭다운 항목만 상태별로 다름:
 * - 익명: 로그인/회원가입 · 닉네임 변경
 * - 멤버: 닉네임 변경 · 프로필 사진 변경 · 로그아웃
 */
export function AccountMenu() {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [profileLoadFailed, setProfileLoadFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [editingNick, setEditingNick] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialMenuFocusRef = useRef<"first" | "last">("first");
  const signingOutRef = useRef(false);
  const menuId = useId();
  const mountedRef = useRef(false);
  const profileRequestEpochRef = useRef(0);
  const profileLifecycleRef = useRef<AbortController | null>(null);
  useEffect(() => {
    // React StrictMode probes effects with setup→cleanup→setup. The setup must
    // restore this bit or every later fresh profile response is discarded.
    mountedRef.current = true;
    const controller = new AbortController();
    profileLifecycleRef.current = controller;
    return () => {
      mountedRef.current = false;
      controller.abort(new Error("account_menu_unmounted"));
      if (profileLifecycleRef.current === controller) {
        profileLifecycleRef.current = null;
      }
    };
  }, []);

  // 헤더 생성권 fresh 재조회 — 마운트·크레딧 변동 이벤트·탭 복귀 시 공통 호출.
  const refreshProfile = useCallback(() => {
    const requestEpoch = profileRequestEpochRef.current + 1;
    profileRequestEpochRef.current = requestEpoch;
    getMyProfile(profileLifecycleRef.current?.signal)
      .then((p) => {
        if (
          !mountedRef.current ||
          profileRequestEpochRef.current !== requestEpoch
        ) {
          return;
        }
        if (!p) {
          setProfileLoadFailed(true);
          return;
        }
        setProfile(p);
        setProfileLoadFailed(false);
        writeCachedProfile(p.id, p);
      })
      .catch(() => {
        if (
          !mountedRef.current ||
          profileRequestEpochRef.current !== requestEpoch
        ) {
          return;
        }
        setProfileLoadFailed(true);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // 1) 로컬 세션 → 캐시된 닉/프사 즉시 렌더(네트워크 없이) → nav 스피너 제거.
    void runClientMutation({
      attempt: async (requestSignal) => {
        try {
          const result = await createClient(
            requestSignal,
          ).auth.getSession();
          return { kind: "confirmed" as const, value: result };
        } catch (error) {
          return { kind: "rejected" as const, error };
        }
      },
      signal: controller.signal,
    })
      .then((outcome) => {
        if (outcome.kind !== "confirmed") return;
        const { data } = outcome.value;
        const uid = data.session?.user.id;
        if (!uid || cancelled) return;
        const cached = readCachedProfile(uid);
        // prev ?? — 백그라운드 fresh 가 먼저 도착했으면 덮어쓰지 않음.
        if (cached)
          setProfile(
            (prev) =>
              prev ?? {
                id: uid,
                ...cached,
                genCredits: null,
                isAdmin: false,
              }
          );
      })
      .catch(() => {});
    // 2) 백그라운드 fresh 조회(genCredits 포함) + 캐시 갱신.
    refreshProfile();
    return () => {
      cancelled = true;
      controller.abort(new Error("account_menu_session_read_disposed"));
    };
  }, [refreshProfile]);

  // 크레딧 변동(생성 차감/구매/환불) 또는 탭 복귀 시 헤더 생성권 즉시 재조회(새로고침 불필요).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshProfile();
    };
    window.addEventListener(CREDITS_CHANGED_EVENT, refreshProfile);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(CREDITS_CHANGED_EVENT, refreshProfile);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshProfile]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const animationFrame = requestAnimationFrame(() => {
      const items = menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      );
      if (!items?.length) return;
      const target =
        initialMenuFocusRef.current === "last"
          ? items[items.length - 1]
          : items[0];
      target?.focus();
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [open]);

  if (!profile) {
    if (profileLoadFailed) {
      return (
        <button
          type="button"
          onClick={refreshProfile}
          className="max-w-[40vw] truncate rounded-full border border-red-500/30 px-2 py-1.5 text-xs text-red-500 sm:max-w-[48vw] sm:px-3"
        >
          계정 정보 재조회
        </button>
      );
    }
    return (
      <div className="flex h-8 w-16 max-w-[40vw] items-center justify-end sm:w-24 sm:max-w-[48vw]">
        <Spinner className="h-4 w-4" />
      </div>
    );
  }

  const isLoggedIn = profile.isLoggedIn;
  const avatar = profile.avatar_url ?? DEFAULT_AVATAR;
  const handleSignOut = async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    setSigningOut(true);
    setSignOutError(false);
    try {
      await signOut();
    } catch {
      signingOutRef.current = false;
      if (mountedRef.current) {
        setSignOutError(true);
        setSigningOut(false);
      }
    }
  };

  const closeNicknameEditor = () => {
    setEditingNick(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      ),
    );
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next = 0;
    if (event.key === "End") {
      next = items.length - 1;
    } else if (event.key === "ArrowUp") {
      next = current <= 0 ? items.length - 1 : current - 1;
    } else if (event.key === "ArrowDown") {
      next = current < 0 || current === items.length - 1 ? 0 : current + 1;
    }
    items[next]?.focus();
  };

  return (
    <div
      className="relative min-w-0 max-w-[40vw] shrink sm:max-w-[48vw]"
      ref={ref}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          initialMenuFocusRef.current = "first";
          setOpen((o) => !o);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          initialMenuFocusRef.current =
            event.key === "ArrowUp" ? "last" : "first";
          setOpen(true);
        }}
        className="flex w-full min-w-0 max-w-full items-center gap-1.5 rounded-full border border-foreground/15 ui-surface py-1 pl-1 pr-2 text-sm transition hover:bg-foreground/5 sm:pr-2.5"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="내 계정"
      >
        <FadeImg
          src={avatar}
          className="h-6 w-6 shrink-0 rounded-full border border-foreground/10"
          loading="eager"
          fallbackSrc={DEFAULT_AVATAR}
        />
        <span className="min-w-0 flex-1 truncate">{profile.display_name}</span>
        <span aria-hidden className="shrink-0 text-xs text-zinc-500">
          ▾
        </span>
      </button>

      {open && (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          aria-label="내 계정 메뉴"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-50 mt-1.5 w-48 overflow-hidden rounded-2xl border border-foreground/10 ui-surface py-1 shadow-xl"
        >
          {profileLoadFailed && (
            <button
              type="button"
              role="menuitem"
              onClick={refreshProfile}
              className="block w-full border-b border-red-500/20 px-4 py-2.5 text-left text-xs text-red-500"
            >
              권한·생성권 조회 실패 — 다시 확인
            </button>
          )}
          {!isLoggedIn && (
            <Link
              href="/login"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-4 py-2.5 text-left text-sm font-semibold transition hover:bg-foreground/5"
            >
              로그인 / 회원가입
            </Link>
          )}
          {isLoggedIn && profile.genCredits !== null && (
            <div className="border-b border-foreground/10 px-4 py-2.5 text-sm text-zinc-500">
              생성권{" "}
              <span className="font-semibold text-foreground">
                {formatCredits(profile.genCredits)}
              </span>
            </div>
          )}
          {isLoggedIn && (
            <Link
              href="/credits"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-4 py-2.5 text-left text-sm font-semibold text-amber-600 transition hover:bg-foreground/5"
            >
              생성권 충전
            </Link>
          )}
          {isLoggedIn && profile.isAdmin && (
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
          {!isLoggedIn && (
            <MenuItem
              onClick={() => {
                setEditingNick(true);
                setOpen(false);
              }}
            >
              닉네임 변경
            </MenuItem>
          )}
          {isLoggedIn && (
            <Link
              href="/account"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-4 py-2.5 text-left text-sm transition hover:bg-foreground/5"
            >
              마이페이지
            </Link>
          )}
          {isLoggedIn && (
            <>
              {signOutError && (
                <div
                  role="alert"
                  className="border-t border-red-500/20 px-4 py-2 text-xs text-red-500"
                >
                  로그아웃을 완료하지 못했어요. 다시 시도해주세요.
                </div>
              )}
              <MenuItem
                onClick={() => void handleSignOut()}
                disabled={signingOut}
                className="border-t border-foreground/10 text-red-500"
              >
                {signingOut ? "로그아웃 중…" : "로그아웃"}
              </MenuItem>
            </>
          )}
        </div>
      )}

      {editingNick && (
        <NicknameEditor
          current={profile.display_name}
          onClose={closeNicknameEditor}
          onSaved={(name) => {
            setProfile((p) => {
              if (!p) return p;
              const next = { ...p, display_name: name };
              writeCachedProfile(p.id, next);
              return next;
            });
            closeNicknameEditor();
          }}
        />
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  disabled = false,
  className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`w-full px-4 py-2.5 text-left text-sm transition hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
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
  const savingRef = useRef(false);
  const mountedRef = useRef(false);
  const requestEpochRef = useRef(0);
  const lifecycleRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    lifecycleRef.current = controller;
    return () => {
      mountedRef.current = false;
      requestEpochRef.current += 1;
      controller.abort(new Error("nickname_editor_unmounted"));
      if (lifecycleRef.current === controller) {
        lifecycleRef.current = null;
      }
    };
  }, []);

  const handleSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    const requestEpoch = requestEpochRef.current + 1;
    requestEpochRef.current = requestEpoch;
    setSaving(true);
    setError(null);
    try {
      const saved = await updateNickname(
        value,
        lifecycleRef.current?.signal,
      );
      if (
        !mountedRef.current ||
        requestEpochRef.current !== requestEpoch
      ) {
        return;
      }
      onSaved(saved);
    } catch (e) {
      if (
        mountedRef.current &&
        requestEpochRef.current === requestEpoch
      ) {
        setError(e instanceof Error ? e.message : "저장 실패");
      }
    } finally {
      savingRef.current = false;
      if (
        mountedRef.current &&
        requestEpochRef.current === requestEpoch
      ) {
        setSaving(false);
      }
    }
  };

  const close = () => {
    if (!savingRef.current) onClose();
  };

  return (
    <ModalShell ariaLabel="닉네임 수정" onClose={close}>
      <h2 className="text-lg font-bold">닉네임 수정</h2>
      <p className="mt-1 text-xs text-zinc-500">
        랭킹과 공유 페이지에 표시되는 이름이에요. ({NICKNAME_MAX}자 이내)
      </p>
      <input
        autoFocus
        type="text"
        aria-label="닉네임"
        value={value}
        maxLength={NICKNAME_MAX}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleSave();
          if (e.key === "Escape") close();
        }}
        className="mt-4 w-full rounded-xl border border-foreground/15 ui-field px-4 py-3 text-base outline-none focus:border-foreground/40"
      />
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {error}
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={close}
          disabled={saving}
          className="flex-1 rounded-full border border-foreground/15 ui-surface py-2.5 text-sm font-medium transition hover:bg-foreground/5"
        >
          취소
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || value.trim().length < 2}
          className="flex flex-1 items-center justify-center gap-2 rounded-full bg-foreground py-2.5 text-sm font-semibold text-paper-2 transition hover:opacity-90 disabled:opacity-40"
        >
          {saving && <Spinner className="h-4 w-4" />}
          저장
        </button>
      </div>
    </ModalShell>
  );
}
