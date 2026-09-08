import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getDoll } from "@/lib/admin-dolls";
import { fmtKst, shortId } from "@/lib/admin-format";
import { FadeImg } from "@/components/FadeImg";
import { getRoleConfig } from "@/lib/config/getters";
import { roleFrom } from "@/lib/config/domains/roles";
import { asRole } from "@/lib/roles";
import { GENDER_LABEL, GENDER_SYMBOL, asGender } from "@/lib/gender";
import { DollProfileControl } from "@/components/admin/DollProfileControl";
import { DollStateChip } from "@/components/admin/DollsTable";

export const dynamic = "force-dynamic";

const GEN_STATUS_LABEL: Record<string, string> = {
  queued: "진행 중",
  done: "선택 전",
  picked: "선택완료",
  failed: "실패",
  expired: "미선택 만료",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-sm">
      <span className="w-24 shrink-0 text-zinc-500">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

/**
 * 캐릭터 상세(v1.29) — 지금 살아 있는 결과물의 **현재 상태 + 제어** 허브. 만들던 과정은 「생성 기록」(생성 상세)이 담당.
 * 나가는 링크: 회원 상세 · 생성 상세 · 신고 큐(dollId 필터) · 공개 페이지. 캐릭터를 가리키는 모든 어드민 링크가 여기로 온다.
 */
export default async function AdminDollDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin();
  if (!gate.ok) notFound();

  const { id } = await params;
  const doll = await getDoll(id);
  if (!doll) notFound();
  const roleCfg = await getRoleConfig();
  const roleLabel = roleFrom(doll.role, roleCfg).label;
  const disabledReason =
    doll.state === "purged"
      ? "영구삭제된 캐릭터는 바꿀 수 없어요."
      : doll.state === "hidden"
        ? "숨김(신고 처리) 상태예요. 신고 큐에서 복구한 뒤 바꿀 수 있어요."
        : null;

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href="/admin/dolls" className="text-xs text-zinc-500 hover:text-foreground">
            ← 캐릭터 목록
          </Link>
          {doll.state !== "purged" && (
            <Link
              href={`/doll/${doll.id}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-sky-600 underline-offset-2 hover:underline"
              title="공개 캐릭터 공유 페이지 (새 탭)"
            >
              공개 페이지 ↗
            </Link>
          )}
        </div>
        <h1 className="mt-2 flex flex-wrap items-center gap-2 text-2xl font-bold">
          캐릭터 {shortId(doll.id)}
          <DollStateChip state={doll.state} />
        </h1>

        {/* 현재 캐릭터 */}
        <section className="mt-4 rounded-2xl border border-foreground/10 ui-surface p-4">
          <h2 className="mb-2 text-sm font-bold text-zinc-500">현재 캐릭터</h2>
          <div className="flex gap-4">
            <div className="flex aspect-[3/4] w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-foreground/10 bg-foreground/10 text-2xl">
              {doll.thumb ? (
                <FadeImg
                  src={doll.thumb}
                  placeholder="shimmer"
                  fit="contain"
                  className={`h-full w-full ${doll.state === "hidden" ? "opacity-60" : ""}`}
                />
              ) : (
                <span aria-hidden>🗑️</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <Row label="롤 · 성별">
                {roleLabel} {GENDER_SYMBOL[doll.gender]}{" "}
                <span className="text-zinc-400">
                  ({doll.role} · {GENDER_LABEL[doll.gender]})
                </span>
              </Row>
              <Row label="회원">
                <Link href={`/admin/users/${doll.ownerId}`} className="underline underline-offset-2">
                  {doll.ownerName ?? shortId(doll.ownerId)}
                </Link>
              </Row>
              <Row label="생성일">{fmtKst(doll.createdAt)}</Row>
              <Row label="version">{doll.version}</Row>
            </div>
          </div>
        </section>

        {/* 캐릭터 속성 제어 */}
        <section className="mt-4 rounded-2xl border border-foreground/10 ui-surface p-4">
          <h2 className="mb-2 text-sm font-bold text-zinc-500">캐릭터 속성 (롤 · 성별)</h2>
          <DollProfileControl
            dollId={doll.id}
            role={doll.role}
            gender={doll.gender}
            version={doll.version}
            cfg={roleCfg}
            disabledReason={disabledReason}
          />
        </section>

        {/* 변경 이력 */}
        <section className="mt-4 rounded-2xl border border-foreground/10 ui-surface p-4">
          <h2 className="mb-2 text-sm font-bold text-zinc-500">속성 변경 이력</h2>
          {doll.changes.length === 0 ? (
            <p className="text-sm text-zinc-400">어드민 변경 이력이 없어요.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-xs">
              {doll.changes.map((c) => (
                <li key={c.requestId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="shrink-0 tabular-nums text-zinc-400">{fmtKst(c.completedAt)}</span>
                  <span className="min-w-0">
                    {c.previousRole && c.nextRole && c.previousRole !== c.nextRole && (
                      <>
                        롤 {roleFrom(asRole(c.previousRole), roleCfg).label} → {roleFrom(asRole(c.nextRole), roleCfg).label}{" "}
                      </>
                    )}
                    {c.previousGender && c.nextGender && c.previousGender !== c.nextGender && (
                      <>
                        성별 {GENDER_LABEL[asGender(c.previousGender)]} → {GENDER_LABEL[asGender(c.nextGender)]}{" "}
                      </>
                    )}
                    {c.noOp && <span className="text-zinc-400">변경 없음(같은 값) </span>}
                  </span>
                  <span className="shrink-0 text-zinc-400">
                    by{" "}
                    <Link href={`/admin/users/${c.adminUserId}`} className="underline underline-offset-2">
                      {c.adminName ?? shortId(c.adminUserId)}
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 생성 기록 */}
        <section className="mt-4 rounded-2xl border border-foreground/10 ui-surface p-4">
          <h2 className="mb-2 text-sm font-bold text-zinc-500">생성 기록</h2>
          {doll.source ? (
            <>
              <Row label="생성 시 선택 롤">{roleFrom(asRole(doll.source.role), roleCfg).label}</Row>
              <Row label="판정 성별">
                {GENDER_LABEL[doll.source.gender]} <span className="text-zinc-400">(프롬프트 적용값)</span>
              </Row>
              <Row label="상태">{GEN_STATUS_LABEL[doll.source.status] ?? doll.source.status}</Row>
              <Row label="생성 시각">{fmtKst(doll.source.createdAt)}</Row>
              <Link
                href={`/admin/generations/${doll.source.id}`}
                className="mt-1 inline-block text-sm text-sky-600 underline-offset-2 hover:underline"
              >
                생성 상세 (파라미터·프롬프트·후보) →
              </Link>
            </>
          ) : (
            <p className="text-sm text-zinc-400">생성 기록이 없어요 (기능 배포 이전 캐릭터 — 소급 불가).</p>
          )}
        </section>

        {/* 신고 */}
        <section className="mt-4 rounded-2xl border border-foreground/10 ui-surface p-4">
          <h2 className="mb-2 text-sm font-bold text-zinc-500">신고</h2>
          <Row label="대기 신고">
            {doll.pendingReports}건{" "}
            <Link
              href={`/admin/moderation?dollId=${doll.id}`}
              className="text-sky-600 underline-offset-2 hover:underline"
            >
              신고 큐에서 보기 →
            </Link>
          </Row>
        </section>
      </div>
    </main>
  );
}
