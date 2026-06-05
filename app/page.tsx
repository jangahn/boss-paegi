import Link from "next/link";
import { SERVICE_NAME } from "@/lib/policy";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex flex-col items-center gap-6 max-w-md">
        <h1 className="text-5xl font-extrabold tracking-tight">
          {SERVICE_NAME}
        </h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400 leading-relaxed">
          오늘 부장님한테 받은 스트레스,
          <br />
          여기서 마음껏 풀고 가세요.
        </p>

        <div className="flex flex-col gap-3 w-full mt-4">
          <Link
            href="/generate"
            className="rounded-full bg-foreground text-background py-4 px-6 font-semibold text-base hover:opacity-90 transition"
          >
            내 부장님 만들기
          </Link>
          <Link
            href="/play"
            className="rounded-full border border-foreground/15 py-4 px-6 font-medium text-base hover:bg-foreground/5 transition"
          >
            기본 부장님으로 바로 시작
          </Link>
        </div>

        <p className="text-xs text-zinc-500 mt-8 leading-relaxed">
          본 서비스는 코믹한 스트레스 해소를 위한 캐주얼 게임입니다.
          <br />
          타인 비방·괴롭힘 목적의 사용은 금지됩니다.
        </p>
      </div>
    </main>
  );
}
