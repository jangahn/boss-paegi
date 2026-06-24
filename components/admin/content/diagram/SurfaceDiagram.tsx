"use client";

/**
 * 도식형 주석 레이아웃 — 실제 화면 대신 박스+라벨로 표면 구조를 그린다(UI 변경에 안 깨짐).
 * 에디터 필드에 포커스하면 active 영역이 하이라이트되어 "이 문구가 어디에 들어가는지" 보여준다.
 * 편집 가능한 영역은 id 를 가지며 마케팅 필드의 region.id 와 매칭.
 */

export type Region = { id?: string; label: string; tone?: "edit" | "ctx" };
export type SurfaceKey = "home" | "gallery" | "doll" | "share" | "gameover";

const SURFACES: Record<SurfaceKey, { title: string; regions: Region[] }> = {
  home: {
    title: "홈 화면",
    regions: [
      { label: "부장님 패기 (앱명·고정)", tone: "ctx" },
      { id: "tagline", label: "태그라인", tone: "edit" },
      { id: "primaryCta", label: "주 버튼", tone: "edit" },
      { id: "secondaryCta", label: "보조 버튼", tone: "edit" },
      { label: "갤러리·랭킹 링크 (고정)", tone: "ctx" },
      { id: "disclaimer", label: "고지", tone: "edit" },
    ],
  },
  gallery: {
    title: "갤러리 가입 배너",
    regions: [
      { id: "nonmemberTitle", label: "비회원 제목", tone: "edit" },
      { id: "nonmemberSub", label: "비회원 설명", tone: "edit" },
      { id: "memberEmptyTitle", label: "회원·0캐릭터 제목", tone: "edit" },
      { id: "memberEmptySub", label: "회원·0캐릭터 설명", tone: "edit" },
    ],
  },
  doll: {
    title: "인사기록 카드 (캐릭터 공유)",
    regions: [
      { id: "dollOgTitle", label: "공유 미리보기 제목 (OG)", tone: "edit" },
      { id: "dollOgDesc", label: "공유 미리보기 설명 (OG)", tone: "edit" },
      { label: "인사기록(성명·직급·소속·특이사항) — 롤 콘텐츠", tone: "ctx" },
      { id: "dollHook", label: "후킹 문구", tone: "edit" },
      { id: "dollCtaMake", label: "만들기 버튼", tone: "edit" },
      { id: "dollCtaDefault", label: "기본 캐릭터 버튼", tone: "edit" },
      { id: "dollShareText", label: "웹 공유 텍스트", tone: "edit" },
    ],
  },
  share: {
    title: "점수 결과 보고서 (공유)",
    regions: [
      { id: "scoreOgTitle", label: "공유 미리보기 제목 (OG)", tone: "edit" },
      { label: "보고서 본문(점수·등급·피격자 의견) — 롤/등급 콘텐츠", tone: "ctx" },
      { id: "scoreHook", label: "후킹(패기유형 보유 시)", tone: "edit" },
      { id: "scoreCtaPlay", label: "패러 가기 버튼", tone: "edit" },
      { id: "scoreCtaPersona", label: "페르소나 받기 버튼", tone: "edit" },
      { id: "scoreShareText", label: "웹 공유 텍스트", tone: "edit" },
    ],
  },
  gameover: {
    title: "게임 종료 화면",
    regions: [
      { label: "결과 보고서(점수·뱃지·피격자 의견) — 롤/등급 콘텐츠", tone: "ctx" },
      { id: "gameoverShareBtn", label: "공유 버튼", tone: "edit" },
      { id: "gameoverRetryBtn", label: "다시 버튼", tone: "edit" },
    ],
  },
};

export function SurfaceDiagram({
  surface,
  active,
}: {
  surface: SurfaceKey;
  active?: string;
}) {
  const s = SURFACES[surface];
  return (
    <div className="rounded-2xl border border-foreground/15 bg-foreground/[0.03] p-3">
      <div className="mb-2 text-center text-[11px] font-semibold text-zinc-500">
        {s.title}
      </div>
      <div className="mx-auto flex max-w-[220px] flex-col gap-1.5">
        {s.regions.map((r, i) => {
          const isActive = !!r.id && r.id === active;
          const base =
            r.tone === "ctx"
              ? "border-dashed border-foreground/15 text-zinc-400"
              : "border-foreground/20 text-zinc-600 dark:text-zinc-300";
          return (
            <div
              key={r.id ?? `ctx${i}`}
              className={`rounded-lg border px-2 py-1.5 text-center text-[11px] transition ${base} ${
                isActive
                  ? "border-amber-500 bg-amber-500/15 font-semibold text-amber-700 ring-2 ring-amber-500/40 dark:text-amber-300"
                  : ""
              }`}
            >
              {r.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 마케팅 필드 key → (표면, 영역 id) 매핑. 포커스 시 해당 표면 도식의 영역 하이라이트. */
export const FIELD_SURFACE: Record<string, { surface: SurfaceKey; region: string }> = {
  tagline: { surface: "home", region: "tagline" },
  primaryCta: { surface: "home", region: "primaryCta" },
  secondaryCta: { surface: "home", region: "secondaryCta" },
  disclaimer: { surface: "home", region: "disclaimer" },
  nonmemberTitle: { surface: "gallery", region: "nonmemberTitle" },
  nonmemberSub: { surface: "gallery", region: "nonmemberSub" },
  memberEmptyTitle: { surface: "gallery", region: "memberEmptyTitle" },
  memberEmptySub: { surface: "gallery", region: "memberEmptySub" },
  dollHook: { surface: "doll", region: "dollHook" },
  dollCtaMake: { surface: "doll", region: "dollCtaMake" },
  dollCtaDefault: { surface: "doll", region: "dollCtaDefault" },
  dollShareText: { surface: "doll", region: "dollShareText" },
  dollOgTitle: { surface: "doll", region: "dollOgTitle" },
  dollOgDesc: { surface: "doll", region: "dollOgDesc" },
  scoreHook: { surface: "share", region: "scoreHook" },
  scoreCtaPlay: { surface: "share", region: "scoreCtaPlay" },
  scoreCtaPersona: { surface: "share", region: "scoreCtaPersona" },
  scoreShareText: { surface: "share", region: "scoreShareText" },
  scoreOgTitle: { surface: "share", region: "scoreOgTitle" },
  gameoverShareBtn: { surface: "gameover", region: "gameoverShareBtn" },
  gameoverRetryBtn: { surface: "gameover", region: "gameoverRetryBtn" },
};
