import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getRoleConfigWithMeta, getScoreConfig } from "@/lib/config/getters";
import { RoleContentEditor } from "@/components/admin/content/RoleContentEditor";
import { TIER_COUNT } from "@/lib/score-tiers";

export const dynamic = "force-dynamic";

export default async function RoleContentPage() {
  const gate = await requireAdmin();
  if (!gate.ok) redirect(gate.error === "consent_required" ? "/consent?next=/admin" : "/");

  // 칸 캡션의 구간 경계는 점수 설정(score_config)의 현재 값 — 여기선 읽기만(편집은 점수 설정 페이지).
  const [{ value, version, source, invalid }, scoreCfg] = await Promise.all([
    getRoleConfigWithMeta(),
    getScoreConfig(),
  ]);
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between">
          <Link href="/admin/content" className="text-xs text-zinc-500 hover:text-foreground">
            ← 콘텐츠
          </Link>
          <Link href="/admin/content/history/role_content" className="text-xs text-zinc-500 hover:text-foreground">
            변경 내역 →
          </Link>
        </div>
        <h1 className="mt-2 text-2xl font-bold">롤 대사</h1>
        <p className="mt-1 text-sm text-zinc-500">
          롤별 시비 멘트·반응·인사기록·호칭. 점수 {TIER_COUNT}단계의 경계는{" "}
          <Link href="/admin/content/score_config" className="underline underline-offset-2">점수 설정</Link>에서 바꾸고, 여기선 칸 안의
          문구만 편집합니다. 줄바꿈으로 여러 개를 입력하면 랜덤으로 노출돼요.
        </p>
        <RoleContentEditor
          initial={value}
          version={version ?? 0}
          source={source}
          invalid={!!invalid}
          thresholds={scoreCfg.thresholds}
        />
      </div>
    </main>
  );
}
