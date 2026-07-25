import Link from "next/link";
import { getGenerationConfigWithMeta } from "@/lib/config/getters";
import { GenerationConfigEditor } from "@/components/admin/content/GenerationConfigEditor";

export const dynamic = "force-dynamic";

export default async function GenerationConfigPage() {
  const { value, version, source, invalid } = await getGenerationConfigWithMeta();
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between">
          <Link href="/admin/content" className="text-xs text-zinc-500 hover:text-foreground">
            ← 콘텐츠
          </Link>
          <Link
            href="/admin/content/history/generation_config"
            className="text-xs text-zinc-500 hover:text-foreground"
          >
            변경 내역 →
          </Link>
        </div>
        <h1 className="mt-2 text-2xl font-bold">캐릭터 생성 (프롬프트·수치)</h1>
        <p className="mt-1 text-sm text-zinc-500">
          캐릭터 생성(fal flux-pulid) 의 프롬프트·수치를 여기서 제어합니다. 발행 즉시 다음 생성부터
          반영돼요. 결과가 너무 실사 같으면 수치·프롬프트를 조정하고, 문제가 생기면 변경 내역에서 이전
          버전으로 되돌리세요. (강제 키워드는 없으니 캐릭터화 시드는 신중히 편집.)
        </p>
        <GenerationConfigEditor
          initial={value}
          version={version ?? 0}
          source={source}
          invalid={!!invalid}
        />
      </div>
    </main>
  );
}
