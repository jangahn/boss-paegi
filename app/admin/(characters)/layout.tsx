import { CharacterTabs } from "@/components/admin/CharacterTabs";

/**
 * 「캐릭터」 메뉴 공용 레이아웃(v1.30) — 제목과 2차 탭(캐릭터 목록 | 생성 현황)을 라우트 그룹 레이아웃에 두어
 * 탭 전환(소프트 내비게이션) 중에도 마운트를 유지한다. 내용 영역만 그룹 loading.tsx 로 바뀐다.
 * 상세 페이지(/admin/dolls/[id], /admin/generations/[id])는 그룹 밖 — 자체 헤더를 쓴다. URL 은 그대로(라우트 그룹).
 */
export default function CharactersLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-bold">캐릭터</h1>
        <CharacterTabs />
        {children}
      </div>
    </main>
  );
}
