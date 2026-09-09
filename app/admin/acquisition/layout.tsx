import { AcquisitionTabs } from "@/components/admin/AcquisitionTabs";

/**
 * 「공유·유입」 공용 레이아웃(v1.31) — 제목과 2차 탭(집계 | 원본 이벤트)을 레이아웃에 두어 탭 전환 중에도
 * 마운트를 유지한다(「캐릭터」 2차 탭과 같은 패턴). 내용 영역만 loading.tsx 로 바뀐다.
 */
export default function AcquisitionLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-bold">공유·유입 분석</h1>
        <AcquisitionTabs />
        {children}
      </div>
    </main>
  );
}
