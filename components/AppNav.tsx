"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getMyProfile, updateNickname, NICKNAME_MAX } from "@/lib/profile";
import { Spinner } from "@/components/Spinner";

/**
 * 전역 네비게이션 — 홈/갤러리/랭킹/만들기 자유 이동 + 닉네임 표시·수정.
 * /play 는 몰입 화면이라 미장착 (게임 종료 보고서에서 이동 제공).
 */
export function AppNav() {
  const pathname = usePathname();
  const [nickname, setNickname] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMyProfile()
      .then((p) => {
        if (!cancelled && p) setNickname(p.display_name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const links = [
    { href: "/", label: "홈" },
    { href: "/gallery", label: "갤러리" },
    { href: "/leaderboard", label: "랭킹" },
  ];

  return (
    <>
      <nav className="sticky top-0 z-40 border-b border-foreground/10 bg-background/85 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-2 px-4 py-2.5">
          <div className="flex items-center gap-1">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                  pathname === l.href
                    ? "bg-foreground text-background"
                    : "text-zinc-500 hover:bg-foreground/5 hover:text-foreground"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex max-w-[40%] items-center gap-1.5 rounded-full border border-foreground/15 px-3 py-1.5 text-sm transition hover:bg-foreground/5"
            aria-label="닉네임 수정"
          >
            <span aria-hidden>👤</span>
            <span className="truncate">
              {nickname ?? <Spinner className="h-3.5 w-3.5" />}
            </span>
            <span aria-hidden className="text-xs text-zinc-500">
              ✎
            </span>
          </button>
        </div>
      </nav>
      {editing && (
        <NicknameEditor
          current={nickname ?? ""}
          onClose={() => setEditing(false)}
          onSaved={(name) => {
            setNickname(name);
            setEditing(false);
          }}
        />
      )}
    </>
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
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
      </div>
    </div>
  );
}
