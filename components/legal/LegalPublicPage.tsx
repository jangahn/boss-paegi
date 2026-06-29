import Link from "next/link";
import { LegalDocView } from "./LegalDocView";
import {
  getCurrentLegal,
  getUpcomingLegal,
  getLegalHistory,
  getPublishedLegalById,
} from "@/lib/legal";
import { DOC_LABEL, DOC_PATH, type DocType, type LegalDocRow } from "@/lib/legal/types";

// 공개 약관/방침 페이지 — server, force-dynamic(시행일 도래 자동 전환). /terms·/privacy 공용.
export async function LegalPublicPage({
  docType,
  viewId,
}: {
  docType: DocType;
  viewId?: string;
}) {
  const [current, upcoming, history] = await Promise.all([
    getCurrentLegal(docType),
    getUpcomingLegal(docType),
    getLegalHistory(docType),
  ]);
  const label = DOC_LABEL[docType];
  const path = DOC_PATH[docType];

  // ?v= 열람은 published 단건만(draft 절대 노출 금지). 무효/타도큐먼트면 현재본으로 폴백.
  let viewed: LegalDocRow | null = current;
  if (viewId) {
    const r = await getPublishedLegalById(viewId);
    if (r && r.doc_type === docType) viewed = r;
  }

  let badge: "current" | "upcoming" | "past" | undefined;
  if (viewed) {
    if (current && viewed.id === current.id) badge = "current";
    else if (upcoming && viewed.id === upcoming.id) badge = "upcoming";
    else badge = "past";
  }

  return (
    <>
      <main className="flex flex-1 flex-col ui-surface px-5 py-10">
        <div className="mx-auto w-full max-w-2xl">
          {!viewed ? (
            <div className="rounded-2xl border border-dashed border-foreground/15 p-8 text-center text-sm text-zinc-500">
              {label}은 준비 중입니다.
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {/* 예정본 사전 고지 — 현재본을 볼 때만 */}
              {!viewId && upcoming && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                  {upcoming.effective_date}부터 시행되는 개정 {label}이 예정되어 있어요.{" "}
                  <Link href={`${path}?v=${upcoming.id}`} className="font-semibold underline underline-offset-2">
                    시행 예정본 미리보기 →
                  </Link>
                </div>
              )}
              {viewId && (
                <Link
                  href={path}
                  className="text-xs text-zinc-500 underline-offset-4 hover:text-foreground hover:underline"
                >
                  ← 현재 시행본 보기
                </Link>
              )}

              <LegalDocView
                title={viewed.title}
                effectiveDate={viewed.effective_date}
                version={viewed.version}
                sections={viewed.sections}
                publicNote={viewed.public_note}
                badge={badge}
              />

              {/* 개정 이력 */}
              {history.length > 0 && (
                <div className="border-t border-foreground/10 pt-4">
                  <h3 className="text-sm font-semibold text-zinc-500">개정 이력</h3>
                  <ul className="mt-2 flex flex-col gap-1 text-sm">
                    {history.map((h) => (
                      <li key={h.id}>
                        <Link
                          href={`${path}?v=${h.id}`}
                          className="text-zinc-600 underline-offset-4 hover:text-foreground hover:underline dark:text-zinc-300"
                        >
                          {h.effective_date} 시행 · 버전 {h.version}
                          {current && h.id === current.id ? " (현재)" : ""}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
