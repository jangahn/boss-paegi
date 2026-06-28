import Link from "next/link";
import { getEntry } from "@/lib/config/registry";
import type { DomainKey } from "@/lib/config/keys";

// 콘텐츠/설정 허브 — 마케터가 코드 없이 문구·수치를 편집하는 도메인 목록.
// 각 도메인은 레지스트리(getEntry)에 등록되면 자동 활성화(해당 PR 에서 에디터 라우트 추가).
export const dynamic = "force-dynamic";

const DOMAINS: { key: DomainKey; label: string; desc: string }[] = [
  { key: "marketing_copy", label: "마케팅 카피", desc: "홈·갤러리·가입 배너·CTA 문구" },
  { key: "role_content", label: "롤 대사", desc: "시비 멘트·반응·인사기록·호칭" },
  { key: "score_config", label: "점수 설정", desc: "점수 구간(밴드 간격)·등급 라벨" },
  { key: "badge_catalog", label: "뱃지", desc: "카테고리·임계값·라벨" },
  { key: "session_limits", label: "세션 한도", desc: "최대 플레이 시간·점수(강제 종료)" },
  { key: "growth_levers", label: "성장 레버", desc: "가입 생성권·충전 가격" },
  { key: "site_content", label: "소개·FAQ (SEO)", desc: "홈 소개·자주 묻는 질문·검색 메타" },
  { key: "media_config", label: "미디어 자산", desc: "기본 OG 공유 이미지·서비스 로고" },
];

export default function ContentHome() {
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-3xl">
        <h1 className="text-2xl font-bold">콘텐츠 / 설정</h1>
        <p className="mt-1 text-sm text-zinc-500">
          코드 변경 없이 마케팅·게임 문구와 수치를 직접 편집합니다. 발행 즉시 반영되며 변경 이력으로 되돌릴 수 있어요.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {DOMAINS.map((d) => {
            const ready = !!getEntry(d.key);
            const inner = (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{d.label}</span>
                  {!ready && (
                    <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] text-zinc-500">
                      준비 중
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-zinc-500">{d.desc}</p>
              </>
            );
            return ready ? (
              <Link
                key={d.key}
                href={`/admin/content/${d.key}`}
                className="rounded-2xl border border-foreground/10 ui-surface p-4 transition hover:border-foreground/30 hover:bg-foreground/5"
              >
                {inner}
              </Link>
            ) : (
              <div
                key={d.key}
                className="rounded-2xl border border-dashed border-foreground/10 p-4 opacity-60"
              >
                {inner}
              </div>
            );
          })}
        </div>

        {/* 법무 문서 — config 도메인이 아닌 전용 메커니즘(버전·시행일·발행) */}
        <h2 className="mt-8 text-sm font-semibold text-zinc-500">법무 문서</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Link
            href="/admin/content/legal"
            className="rounded-2xl border border-foreground/10 ui-surface p-4 transition hover:border-foreground/30 hover:bg-foreground/5"
          >
            <span className="font-semibold">이용약관 · 개인정보처리방침</span>
            <p className="mt-1 text-xs text-zinc-500">
              버전·시행일 관리, 예약 발행, 개정 이력 공개. /terms · /privacy 에 반영
            </p>
          </Link>
        </div>
      </div>
    </main>
  );
}
