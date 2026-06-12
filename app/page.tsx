"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SERVICE_NAME } from "@/lib/policy";
import { createClient } from "@/lib/supabase/client";
import { AppNav } from "@/components/AppNav";

export default function Home() {
  const [hasDolls, setHasDolls] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sb = createClient();
      const { data: sessionData } = await sb.auth.getSession();
      if (!sessionData.session) return;
      const { count } = await sb
        .from("dolls")
        .select("*", { head: true, count: "exact" });
      if (!cancelled) setHasDolls((count ?? 0) > 0);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <div className="flex max-w-md flex-col items-center gap-6">
          <h1 className="text-5xl font-extrabold tracking-tight">
            {SERVICE_NAME}
          </h1>
          <p className="text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
            오늘 부장님한테 받은 스트레스,
            <br />
            여기서 마음껏 풀고 가세요.
          </p>

          <div className="mt-4 flex w-full flex-col gap-3">
            <Link
              href="/generate"
              className="rounded-full bg-foreground px-6 py-4 text-base font-semibold text-background transition hover:opacity-90"
            >
              내 부장님 만들기
            </Link>
            <Link
              href="/play"
              className="rounded-full border border-foreground/15 px-6 py-4 text-base font-medium transition hover:bg-foreground/5"
            >
              기본 부장님으로 바로 시작
            </Link>
            <div className="flex justify-center gap-4 pt-1 text-sm">
              {hasDolls && (
                <Link
                  href="/gallery"
                  className="font-medium text-zinc-500 underline-offset-4 transition hover:text-foreground hover:underline"
                >
                  내 부장님 갤러리 →
                </Link>
              )}
              <Link
                href="/leaderboard"
                className="font-medium text-zinc-500 underline-offset-4 transition hover:text-foreground hover:underline"
              >
                오늘의 랭킹 →
              </Link>
            </div>
          </div>

          <p className="mt-8 text-xs leading-relaxed text-zinc-500">
            본 서비스는 코믹한 스트레스 해소를 위한 캐주얼 게임입니다.
            <br />
            타인 비방·괴롭힘 목적의 사용은 금지됩니다.
          </p>
        </div>
      </main>
    </>
  );
}
