"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { AppNav } from "@/components/AppNav";
import { Paperclip, CornerFold } from "@/components/dossier";
import { useMarketingCopy } from "@/components/MarketingCopyProvider";
import { useMediaAssets } from "@/components/MediaAssetsProvider";
import { EventBanner } from "@/components/events/EventBanner";
import { EventPopup } from "@/components/events/EventPopup";

export default function Home() {
  const { home } = useMarketingCopy();
  const { logoUrl } = useMediaAssets();
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sb = createClient();
      const { data: sessionData } = await sb.auth.getSession();
      if (!sessionData.session) return;
      if (!cancelled)
        setIsLoggedIn(sessionData.session.user.is_anonymous !== true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <AppNav />
      <EventPopup />
      <main className="flex flex-1 flex-col items-center px-6 py-12">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <EventBanner surface="home" />
          <div className="relative flex flex-col items-center gap-6 rounded-2xl border border-foreground/10 ui-surface px-7 pb-7 pt-10 text-center shadow-sm">
            <Paperclip className="left-7" />
            <CornerFold />
            {/* 정사각 로고 슬롯(LOGO_TRANSFORM 640²·에디터 미리보기와 동일 비율) — 4:3 정적 폴백은 object-contain 으로 안전 수용 */}
            <Image
              src={logoUrl ?? "/logo.png"}
              alt="부장님 패기"
              width={640}
              height={640}
              priority
              className="w-36 max-w-full object-contain"
            />
            <p className="whitespace-pre-line text-base leading-relaxed text-zinc-600">
              {home.tagline}
            </p>

            <div className="flex w-full flex-col gap-3">
              <Link
                href={isLoggedIn ? "/generate" : "/login?next=/generate"}
                className="rounded-full bg-foreground px-6 py-4 text-base font-semibold text-paper-2 transition hover:opacity-90"
              >
                {home.primaryCta}
              </Link>
              <Link
                href="/play"
                className="rounded-full border border-foreground/15 ui-surface px-6 py-4 text-base font-medium transition hover:bg-foreground/5"
              >
                {home.secondaryCta}
              </Link>
              <div className="flex justify-center gap-4 pt-1 text-sm">
                <Link
                  href="/gallery"
                  className="font-semibold text-steel underline-offset-4 transition hover:text-stamp hover:underline"
                >
                  내 부장님 갤러리 →
                </Link>
                <Link
                  href="/leaderboard"
                  className="font-semibold text-steel underline-offset-4 transition hover:text-stamp hover:underline"
                >
                  오늘의 랭킹 →
                </Link>
              </div>
            </div>
          </div>

          <div className="px-2 text-center">
            <p className="whitespace-pre-line text-xs leading-relaxed text-zinc-500">
              {home.disclaimer}
            </p>
            <nav className="mt-3 flex flex-wrap justify-center gap-3 text-[11px] text-zinc-500">
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
