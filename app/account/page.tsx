"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppNav } from "@/components/AppNav";
import { Spinner } from "@/components/Spinner";
import { AvatarEditor } from "@/components/AvatarEditor";
import { FadeImg } from "@/components/FadeImg";
import { PaperPanel, Paperclip, DashedDivider } from "@/components/dossier";
import { signOut } from "@/lib/auth-oauth";
import {
  getMyProfile,
  updateNickname,
  writeCachedProfile,
  NICKNAME_MAX,
  type MyProfile,
} from "@/lib/profile";

const DEFAULT_AVATAR = "/avatars/default.png";

/**
 * 마이페이지(회원정보) — 회원 전용(proxy 게이트). 닉네임·프로필 사진·회원탈퇴.
 * (충전·뱃지·기록·대시보드는 접근 뎁스 유지를 위해 드롭다운 메뉴에 그대로 둠.)
 */
export default function AccountPage() {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [nick, setNick] = useState("");
  const [savingNick, setSavingNick] = useState(false);
  const [nickMsg, setNickMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editingAvatar, setEditingAvatar] = useState(false);

  useEffect(() => {
    getMyProfile()
      .then((p) => {
        if (p) {
          setProfile(p);
          setNick(p.display_name);
        }
      })
      .catch(() => {});
  }, []);

  if (!profile) {
    return (
      <>
        <AppNav />
        <main className="flex flex-1 items-center justify-center">
          <Spinner className="h-6 w-6" />
        </main>
      </>
    );
  }

  const avatar = profile.avatar_url ?? DEFAULT_AVATAR;

  const saveNick = async () => {
    if (savingNick || nick.trim().length < 2) return;
    setSavingNick(true);
    setNickMsg(null);
    try {
      const saved = await updateNickname(nick);
      setProfile((p) => {
        if (!p) return p;
        const next = { ...p, display_name: saved };
        writeCachedProfile(p.id, next);
        return next;
      });
      setNick(saved);
      setNickMsg({ ok: true, text: "저장됐어요." });
    } catch (e) {
      setNickMsg({ ok: false, text: e instanceof Error ? e.message : "저장 실패" });
    } finally {
      setSavingNick(false);
    }
  };

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col px-5 py-8">
        <div className="mx-auto w-full max-w-md">
          <PaperPanel folded className="relative px-6 pb-6 pt-10">
            <Paperclip className="left-7" />
            <h1 className="font-display text-4xl tracking-tight text-ink">회원정보</h1>

            <DashedDivider className="my-5" />

            {/* 프로필 사진 */}
            <section className="flex items-center gap-4">
              <FadeImg
                src={avatar}
                className="h-16 w-16 shrink-0 rounded-full border border-foreground/10"
                loading="eager"
                fallbackSrc={DEFAULT_AVATAR}
              />
              <button
                type="button"
                onClick={() => setEditingAvatar(true)}
                className="rounded-lg border-2 border-line px-4 py-2 text-sm font-medium text-ink transition hover:bg-foreground/5"
              >
                프로필 사진 변경
              </button>
            </section>

            {/* 닉네임 */}
            <section className="mt-6 flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-zinc-500">
                닉네임 <span className="text-zinc-400">({NICKNAME_MAX}자 이내)</span>
              </span>
              <div className="flex gap-2">
                <input
                  value={nick}
                  maxLength={NICKNAME_MAX}
                  onChange={(e) => setNick(e.target.value)}
                  className="flex-1 rounded-lg border border-foreground/15 bg-transparent p-2.5 text-sm outline-none focus:border-foreground/40"
                />
                <button
                  type="button"
                  onClick={() => void saveNick()}
                  disabled={savingNick || nick.trim().length < 2 || nick === profile.display_name}
                  className="flex items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-40"
                >
                  {savingNick && <Spinner className="h-4 w-4" />}
                  저장
                </button>
              </div>
              {nickMsg && (
                <p className={`text-xs ${nickMsg.ok ? "text-emerald-600" : "text-red-400"}`}>
                  {nickMsg.text}
                </p>
              )}
            </section>
          </PaperPanel>

          <WithdrawSection />

          <Link
            href="/"
            className="mt-8 inline-block text-sm text-zinc-500 underline-offset-4 hover:text-foreground hover:underline"
          >
            ← 홈
          </Link>
        </div>
      </main>

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
    </>
  );
}

// 회원탈퇴 — 눈에 안 띄는 하단, 2단계(고지 체크 + "회원탈퇴" 직접 입력)로 오조작 방지.
function WithdrawSection() {
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = ack && confirm.trim() === "회원탈퇴";

  const submit = async () => {
    if (busy || !ready) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (res.ok) {
        await signOut();
        return;
      }
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(
        out.error === "payment_pending"
          ? "진행 중인 결제가 있어요. 잠시 후 다시 시도해주세요."
          : "탈퇴 처리에 실패했어요. 잠시 후 다시 시도해주세요."
      );
    } catch {
      setErr("네트워크 오류 — 다시 시도해주세요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-12 border-t border-foreground/10 pt-6">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs text-zinc-400 underline-offset-4 hover:text-red-500 hover:underline"
        >
          회원탈퇴
        </button>
      ) : (
        <PaperPanel className="border-stamp bg-red-500/5 p-4">
          <h3 className="font-display text-xl tracking-tight text-stamp">회원탈퇴</h3>
          <div className="mt-2 space-y-1 text-xs text-zinc-500">
            <p>
              탈퇴하면 프로필 정보와 생성한 캐릭터 이미지·하이라이트는 삭제 또는 익명화되며,{" "}
              <b className="text-foreground">삭제된 데이터(캐릭터·하이라이트·생성권)는 되돌릴 수 없습니다.</b>{" "}
              (업로드한 원본 사진은 생성 직후 이미 폐기되어 보관하지 않습니다.)
            </p>
            <p>· 남은 생성권은 사용할 수 없으며 복구되지 않습니다.</p>
            <p>· 점수·랭킹 등 개인을 식별할 수 없는 기록은 운영을 위해 익명 형태로 남을 수 있습니다.</p>
            <p>· (결제 이용 시) 결제 기록은 관련 법령에 따라 일정 기간 보존될 수 있습니다.</p>
            <p>· 탈퇴 후 재이용은 제한되며, 재이용을 원하면 고객센터로 문의해 주세요(계정만 복구되고 위 데이터는 복구되지 않습니다).</p>
          </div>
          <label className="mt-3 flex items-start gap-2 text-xs">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
            <span>위 내용을 이해했으며 삭제된 데이터는 되돌릴 수 없음에 동의합니다.</span>
          </label>
          <p className="mt-3 text-xs text-zinc-500">
            확인을 위해 <b className="text-foreground">회원탈퇴</b>를 입력하세요.
          </p>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="회원탈퇴"
            className="mt-1 w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-red-500/40"
          />
          {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setAck(false);
                setConfirm("");
                setErr(null);
              }}
              className="flex-1 rounded-lg border-2 border-line py-2 text-xs font-medium text-ink"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!ready || busy}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-500 py-2 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
            >
              {busy && <Spinner className="h-3.5 w-3.5" />}
              탈퇴하기
            </button>
          </div>
        </PaperPanel>
      )}
    </div>
  );
}
