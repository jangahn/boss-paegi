"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Paperclip, CornerFold } from "@/components/dossier";
import { useMarketingCopy } from "@/components/MarketingCopyProvider";
import { useMediaAssets } from "@/components/MediaAssetsProvider";
import { EventBanner } from "@/components/events/EventBanner";
import { EventPopup } from "@/components/events/EventPopup";
import { HomeCharacterRow } from "@/components/home/HomeCharacterRow";
import { SERVICE_NAME } from "@/lib/policy";
import { runBoundedClientOperation } from "@/lib/client-operation";
import { log } from "@/lib/log";

export default function Home() {
  const { home } = useMarketingCopy();
  const { logoUrl } = useMediaAssets();
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const { data: sessionData } =
          await runBoundedClientOperation(
            () => createClient().auth.getSession(),
            { signal: controller.signal },
          );
        if (!sessionData.session) return;
        if (!cancelled) {
          setIsLoggedIn(
            sessionData.session.user.is_anonymous !== true,
          );
        }
      } catch {
        // The default logged-out CTA is the fail-closed state.
      }
    })();
    return () => {
      cancelled = true;
      controller.abort(new Error("home_session_read_disposed"));
    };
  }, []);

  // 진입 경로(v1.49) — 1차 = 플레이, 2차 = 만들기. 비회원은 기본 부장님 1종이라 바로 플레이, 회원은 기본 5종 + 내 캐릭터라
  // 갤러리에서 고른다. 캐릭터 줄이 기본 5종의 바로 가기(비회원은 추가 4종 잠금 티저)를 맡는다.
  const state = isLoggedIn ? "member" : "nonmember";
  const play = isLoggedIn
    ? { href: "/gallery", label: home.memberPlayCta }
    : { href: "/play", label: home.playCta };
  const createHref = isLoggedIn ? "/generate" : "/login?next=/generate";
  const noteClick = (slot: string) => {
    // 홈 진입 경로 클릭 계측(Sentry Logs, gameover.cta_click 과 같은 관례) — 계측이 내비를 막지 않는다.
    try {
      log.info("home.cta_click", { slot, state });
    } catch {
      // Logging must never block navigation.
    }
  };

  return (
    <>
      <EventPopup />
      <main className="flex flex-1 flex-col items-center px-6 py-6">
        <h1 className="sr-only">
          {SERVICE_NAME} — 직장인 스트레스 해소 게임
        </h1>
        <div className="flex w-full max-w-sm flex-col gap-6">
          <EventBanner surface="home" />
          <div className="relative flex flex-col items-center gap-6 rounded-2xl border border-foreground/10 ui-surface px-7 pb-7 pt-10 text-center shadow-sm">
            <Paperclip className="left-7" />
            <CornerFold />
            {/* 정사각 로고 슬롯(LOGO_TRANSFORM 640²·에디터 미리보기와 동일 비율) — 4:3 정적 폴백은 object-contain 으로 안전 수용.
                w-28·main py-6: 캐릭터 줄이 들어와도 iPhone SE 첫 화면(Safari 553px)에 1차·2차 버튼이 모두 보이게
                (실측: 발행 로고 640×480 기준 비회원 2차 버튼 하단 547px). */}
            <Image
              src={logoUrl ?? "/logo.png"}
              alt="부장님 패기"
              width={640}
              height={640}
              unoptimized
              priority
              className="w-28 max-w-full object-contain"
            />
            <p className="whitespace-pre-line text-base leading-relaxed text-zinc-600">
              {home.tagline}
            </p>

            <HomeCharacterRow
              isLoggedIn={isLoggedIn}
              lockedCaption={home.lockedCaption}
              onPlay={(key) => noteClick(`character:${key}`)}
            />

            <div className="flex w-full flex-col gap-3">
              {/* 로그인 상태 전환 시 key 리마운트(iOS WebKit 텍스트 잔상 처방 — 게임 종료 1차 버튼과 같은 관례). */}
              <Link
                key={state}
                href={play.href}
                onClick={() => noteClick("play")}
                className="rounded-full bg-foreground px-6 py-4 text-base font-semibold text-paper-2 transition hover:opacity-90"
              >
                {play.label}
              </Link>
              <Link
                href={createHref}
                onClick={() => noteClick("create")}
                className="rounded-full border border-foreground/15 ui-surface px-6 py-4 text-base font-medium transition hover:bg-foreground/5"
              >
                {home.createCta}
              </Link>
              <div className="flex justify-center gap-4 pt-1 text-sm">
                <Link
                  href="/leaderboard"
                  className="font-semibold text-steel underline-offset-4 transition hover:text-stamp hover:underline"
                >
                  오늘의 랭킹 →
                </Link>
                <Link
                  href="/badges"
                  className="font-semibold text-steel underline-offset-4 transition hover:text-stamp hover:underline"
                >
                  내 뱃지 →
                </Link>
              </div>
            </div>
          </div>

          <div className="px-2 text-center">
            <p className="whitespace-pre-line text-xs leading-relaxed text-zinc-600">
              {home.disclaimer}
            </p>
            <nav className="mt-3 flex flex-wrap justify-center gap-3 text-[11px] text-zinc-600">
              <Link href="/faq" className="underline-offset-4 hover:text-stamp hover:underline">
                소개·FAQ
              </Link>
              <span aria-hidden>·</span>
              <Link href="/terms" className="underline-offset-4 hover:text-stamp hover:underline">
                이용약관
              </Link>
              <span aria-hidden>·</span>
              <Link href="/privacy" className="underline-offset-4 hover:text-stamp hover:underline">
                개인정보처리방침
              </Link>
            </nav>
          </div>
        </div>
      </main>
    </>
  );
}
