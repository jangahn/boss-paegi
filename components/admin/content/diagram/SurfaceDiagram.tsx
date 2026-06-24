"use client";

/**
 * 도식형 주석 레이아웃 — 실제 화면 대신 박스+라벨로 표면 구조를 그린다(UI 변경에 안 깨짐).
 * 영역 순서 = 실제 화면 렌더 순서. 에디터 필드 포커스 시 해당 영역이 하이라이트되고,
 * 한 값이 여러 화면에 쓰이면 관련 화면 도식이 동시에 뜬다(FIELD_SURFACE 1:다).
 * 용어 일괄: {대상} 공유 카드 / {대상} 공유 미리보기 (OG).
 */

export type Region = { id?: string; label: string; tone?: "edit" | "ctx" };
export type SurfaceKey =
  | "home"
  | "galNonmember"
  | "galMemberEmpty"
  | "galHeader"
  | "doll"
  | "dollOg"
  | "share"
  | "shareOg"
  | "gameover";

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
  galNonmember: {
    title: "갤러리 — 비회원 배너",
    regions: [
      { id: "nonmemberTitle", label: "제목", tone: "edit" },
      { id: "nonmemberSub", label: "설명", tone: "edit" },
      { id: "nonmemberCta", label: "버튼", tone: "edit" },
    ],
  },
  galMemberEmpty: {
    title: "갤러리 — 회원·첫 캐릭터 전 배너",
    regions: [
      { id: "memberEmptyTitle", label: "제목", tone: "edit" },
      { id: "memberEmptySub", label: "설명", tone: "edit" },
      { id: "memberEmptyCta", label: "버튼", tone: "edit" },
    ],
  },
  galHeader: {
    title: "갤러리 — 헤더 버튼 (모든 방문자)",
    regions: [
      { label: "갤러리 상단 (모든 방문자에게 표시)", tone: "ctx" },
      { id: "memberHeaderCta", label: "새로 만들기 버튼", tone: "edit" },
    ],
  },
  doll: {
    title: "캐릭터 공유 카드",
    regions: [
      { label: "인사기록(성명·직급·소속·특이사항) — 롤 콘텐츠", tone: "ctx" },
      { id: "dollHook", label: "후킹 문구", tone: "edit" },
      { id: "dollCtaMake", label: "만들기 버튼", tone: "edit" },
      { id: "dollCtaDefault", label: "기본 캐릭터 버튼", tone: "edit" },
    ],
  },
  dollOg: {
    title: "캐릭터 공유 미리보기 (OG)",
    regions: [
      { label: "이미지 (캐릭터)", tone: "ctx" },
      { id: "dollHook", label: "하단 푸터 (후킹)", tone: "edit" },
      { id: "dollOgTitle", label: "OG 제목", tone: "edit" },
      { id: "dollOgDesc", label: "OG 설명", tone: "edit" },
      { id: "dollShareText", label: "웹 공유 텍스트", tone: "edit" },
    ],
  },
  share: {
    title: "점수 공유 카드",
    regions: [
      { label: "보고서 본문(제목·점수·등급·피격자 의견) — 코드/롤/등급", tone: "ctx" },
      { id: "scoreHook", label: "후킹 문구", tone: "edit" },
      { id: "scoreCtaPlay", label: "패러 가기 버튼", tone: "edit" },
      { id: "scoreCtaPersona", label: "두 번째 버튼", tone: "edit" },
      { id: "scoreRankLink", label: "랭킹 보기 링크", tone: "edit" },
    ],
  },
  shareOg: {
    title: "점수 공유 미리보기 (OG)",
    regions: [
      { label: "이미지 (보고서 카드)", tone: "ctx" },
      { id: "scoreHook", label: "하단 푸터 (후킹)", tone: "edit" },
      { id: "scoreOgTitle", label: "OG 제목 (메타)", tone: "edit" },
      { id: "scoreOgDesc", label: "OG 설명", tone: "edit" },
      { id: "scoreShareText", label: "웹 공유 텍스트", tone: "edit" },
    ],
  },
  gameover: {
    title: "게임 종료 화면",
    regions: [
      { label: "보고서 본문(제목·점수·뱃지·피격자 의견) — 코드/롤/등급", tone: "ctx" },
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

/**
 * 마케팅 필드 key → 이 값이 실제 나타나는 화면(들)·영역. 1:다.
 * 후킹은 카드 + 해당 OG 푸터(같은 도메인) 양쪽. 웹 공유 텍스트는 공유 후 노출이라 OG 쪽.
 */
export const FIELD_SURFACE: Record<
  string,
  ReadonlyArray<{ surface: SurfaceKey; region: string }>
> = {
  // 홈
  tagline: [{ surface: "home", region: "tagline" }],
  primaryCta: [{ surface: "home", region: "primaryCta" }],
  secondaryCta: [{ surface: "home", region: "secondaryCta" }],
  disclaimer: [{ surface: "home", region: "disclaimer" }],
  // 갤러리
  nonmemberTitle: [{ surface: "galNonmember", region: "nonmemberTitle" }],
  nonmemberSub: [{ surface: "galNonmember", region: "nonmemberSub" }],
  nonmemberCta: [{ surface: "galNonmember", region: "nonmemberCta" }],
  memberEmptyTitle: [{ surface: "galMemberEmpty", region: "memberEmptyTitle" }],
  memberEmptySub: [{ surface: "galMemberEmpty", region: "memberEmptySub" }],
  memberEmptyCta: [{ surface: "galMemberEmpty", region: "memberEmptyCta" }],
  memberHeaderCta: [{ surface: "galHeader", region: "memberHeaderCta" }],
  // 캐릭터 공유 — 후킹은 카드 + OG 푸터 양쪽.
  dollHook: [
    { surface: "doll", region: "dollHook" },
    { surface: "dollOg", region: "dollHook" },
  ],
  dollCtaMake: [{ surface: "doll", region: "dollCtaMake" }],
  dollCtaDefault: [{ surface: "doll", region: "dollCtaDefault" }],
  dollOgTitle: [{ surface: "dollOg", region: "dollOgTitle" }],
  dollOgDesc: [{ surface: "dollOg", region: "dollOgDesc" }],
  dollShareText: [{ surface: "dollOg", region: "dollShareText" }],
  // 점수 공유 — 후킹은 카드 + OG 푸터 양쪽.
  scoreHook: [
    { surface: "share", region: "scoreHook" },
    { surface: "shareOg", region: "scoreHook" },
  ],
  scoreCtaPlay: [{ surface: "share", region: "scoreCtaPlay" }],
  scoreCtaPersona: [{ surface: "share", region: "scoreCtaPersona" }],
  scoreRankLink: [{ surface: "share", region: "scoreRankLink" }],
  scoreOgTitle: [{ surface: "shareOg", region: "scoreOgTitle" }],
  scoreOgDesc: [{ surface: "shareOg", region: "scoreOgDesc" }],
  scoreShareText: [{ surface: "shareOg", region: "scoreShareText" }],
  // 게임오버
  gameoverShareBtn: [{ surface: "gameover", region: "gameoverShareBtn" }],
  gameoverRetryBtn: [{ surface: "gameover", region: "gameoverRetryBtn" }],
};
