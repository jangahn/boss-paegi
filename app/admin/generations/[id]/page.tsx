import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getGeneration } from "@/lib/admin-generations";
import { fmtKst, shortId } from "@/lib/admin-format";
import { FadeImg } from "@/components/FadeImg";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  requested: "생성요청",
  rejected: "거부",
  failed: "기타 실패",
  unpicked: "선택 전",
  expired: "미선택 만료",
  picked: "선택완료",
};

// fail_reason → 한글. 입력 거부(no_face/multiple_people/face_obstructed) + 기술 실패.
const FAIL_KO: Record<string, string> = {
  no_face: "얼굴 미검출",
  multiple_people: "여러 명 감지",
  face_obstructed: "얼굴 가림(손/물건)",
  no_credits: "크레딧 부족",
  submit_error: "제출 오류",
  submit_failed: "제출 실패",
  persist_failed: "기록 실패",
  provenance_presave_fail: "기록 실패(선저장)",
  fal_error: "생성 오류(fal)",
  no_requests: "요청 없음",
  timeout: "시간초과(30분)",
  expired: "후보 만료",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-sm">
      <span className="w-32 shrink-0 text-zinc-500">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-foreground/5 p-2 font-mono text-[11px] leading-relaxed">
      {children}
    </pre>
  );
}

export default async function AdminGenerationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // 방어적 재확인(레이아웃도 requireAdmin 하지만 페이지 단위로 재확인).
  const gate = await requireAdmin();
  if (!gate.ok) notFound();

  const { id } = await params;
  const gen = await getGeneration(id);
  if (!gen) notFound();

  const p = gen.provenance;

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between">
          <Link href="/admin/generations" className="text-xs text-zinc-500 hover:text-foreground">
            ← 생성 현황
          </Link>
          {gen.pickedDollId && (
            <Link
              href={`/doll/${gen.pickedDollId}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-sky-600 underline-offset-2 hover:underline"
              title="공개 캐릭터 공유 페이지 (새 탭)"
            >
              공유 페이지 {shortId(gen.pickedDollId)} ↗
            </Link>
          )}
        </div>
        <h1 className="mt-2 text-2xl font-bold">캐릭터 생성 {shortId(gen.id)}</h1>

        {/* 개요 */}
        <section className="mt-4 rounded-2xl border border-foreground/10 ui-surface p-4">
          <Row label="상태">{STATUS_LABEL[gen.adminStatus] ?? gen.adminStatus}</Row>
          <Row label="회원">
            <Link href={`/admin/users/${gen.ownerId}`} className="underline underline-offset-2">
              {gen.ownerName ?? shortId(gen.ownerId)}
            </Link>
          </Row>
          <Row label="롤">{gen.role}</Row>
          <Row label="생성 시각">{fmtKst(gen.createdAt)}</Row>
          <Row label="후보 수">{gen.candidateCount}</Row>
          <Row label="크레딧">
            {gen.adminStatus === "expired"
              ? "−1 차감 · 생성 성공 후 미선택 만료(환불 없음)"
              : gen.creditNote === "consumed"
                ? "−1 차감"
                : gen.creditNote === "refunded"
                  ? "차감 후 환불"
                  : "미차감"}
          </Row>
          {gen.pickedIndex != null && <Row label="선택 후보">#{gen.pickedIndex}</Row>}
          {gen.failReason && (
            <Row
              label={
                gen.adminStatus === "rejected"
                  ? "거부 사유"
                  : gen.adminStatus === "expired"
                    ? "만료 사유"
                    : "실패 사유"
              }
            >
              {FAIL_KO[gen.failReason] ?? gen.failReason}
            </Row>
          )}
        </section>

        {gen.adminStatus === "rejected" && (
          <p className="mt-4 rounded-xl border border-dashed border-orange-500/40 bg-orange-500/5 p-4 text-sm text-orange-600">
            입력 사진이 부적합해 <b>유료 이미지 생성 제출 전 반려</b>됐어요. 일반 회원은
            선차감 영수증을 원자 환급하고, 운영 계정은 미차감합니다. 위 크레딧 표시는 실제
            소비 lot·환급 시각 기준이며 아래 얼굴 분석에서 원인을 볼 수 있어요.
          </p>
        )}

        {gen.adminStatus === "expired" && (
          <p className="mt-4 rounded-xl border border-dashed border-zinc-500/40 bg-zinc-500/5 p-4 text-sm text-zinc-500">
            생성은 정상 완료됐지만 후보를 고르지 않아 만료됐어요. 생성권은 이미 사용돼 환불되지 않으며,
            후보 파일은 정리 대상이라 이 화면에서도 서명 썸네일을 만들지 않아요.
          </p>
        )}

        {!p ? (
          <p className="mt-4 rounded-xl border border-dashed border-foreground/15 p-4 text-center text-sm text-zinc-500">
            생성 파라미터·프롬프트 기록이 없어요 (기능 배포 이전 생성 — 소급 불가).
          </p>
        ) : (
          <>
            {/* 설정 — 입력 거부 row 엔 config 없음 */}
            {p.config && (
              <section className="mt-4 rounded-2xl border border-foreground/10 ui-surface p-4">
                <h2 className="mb-2 text-sm font-bold text-zinc-500">설정 (generation_config)</h2>
                <Row label="출처">
                  {p.config.source === "db" ? `발행값 v${p.config.version ?? "?"}` : "코드 기본값"}
                  {p.config.invalid ? " · 검증실패 폴백" : ""}
                </Row>
              </section>
            )}

            {/* 1단계: 얼굴 분석 */}
            <section className="mt-4 rounded-2xl border border-foreground/10 ui-surface p-4">
              <h2 className="mb-2 text-sm font-bold text-zinc-500">① 얼굴 분석 (moondream)</h2>
              <Row label="모델">{p.analyze.model}</Row>
              <Row label="얼굴 감지">{p.analyze.faceVisible ? "예" : "아니오"}</Row>
              {p.analyze.peopleCount != null && <Row label="인원 수">{p.analyze.peopleCount}명</Row>}
              {p.analyze.faceClear != null && (
                <Row label="얼굴 가림">{p.analyze.faceClear ? "없음" : "가려짐"}</Row>
              )}
              <Row label="안경">{p.analyze.wearsGlasses ? "예" : "아니오"}</Row>
              <Row label="상태">{p.analyze.status}</Row>
              {p.analyze.checks?.length ? (
                <div className="mt-1">
                  <span className="text-sm text-zinc-500">검증 원문</span>
                  <Pre>
                    {p.analyze.checks
                      .map((c) => `${c.key}: ${c.rawOutput ?? "(호출 실패)"}`)
                      .join("\n")}
                  </Pre>
                </div>
              ) : (
                p.analyze.rawOutput != null && (
                  <Row label="원문">
                    <span className="font-mono text-xs">{p.analyze.rawOutput || "(빈 응답)"}</span>
                  </Row>
                )
              )}
            </section>

            {/* 2단계: 생성 (flux-pulid) — 입력 거부 row 엔 generation 없음 */}
            {p.generation && (
            <section className="mt-4 rounded-2xl border border-foreground/10 ui-surface p-4">
              <h2 className="mb-2 text-sm font-bold text-zinc-500">② 생성 (flux-pulid ×{p.generation.candidates.length})</h2>
              <Row label="모델">{p.generation.model}</Row>
              <Row label="수치">
                steps {p.generation.request.numInferenceSteps} · guidance{" "}
                {p.generation.request.guidanceScale} · true_cfg {p.generation.request.trueCfg} · id_weight{" "}
                {p.generation.request.idWeight} · {p.generation.request.imageSize} · safety{" "}
                {String(p.generation.request.enableSafetyChecker)} · max_seq{" "}
                {p.generation.request.maxSequenceLength}
              </Row>
              <div className="mt-2">
                <span className="text-sm text-zinc-500">공통 프롬프트 스냅샷</span>
                <Pre>{`head: ${p.generation.snapshot.headTemplate}\ntail: ${p.generation.snapshot.tail}\nidentity: ${p.generation.snapshot.identity}\nnegative: ${p.generation.snapshot.negative}\nglasses: ${p.generation.snapshot.glassesPrompt} | ${p.generation.snapshot.glassesIdentityPrompt}\nrole: ${p.generation.snapshot.subject} / ${p.generation.snapshot.attireTemplate} / ${p.generation.snapshot.expression}`}</Pre>
              </div>

              <div className="mt-3 flex flex-col gap-3">
                {p.generation.candidates.map((c) => {
                  const thumb = gen.candidateThumbByIndex[c.index];
                  const isPicked = gen.pickedIndex === c.index;
                  return (
                    <div key={c.index} className="rounded-xl border border-foreground/10 p-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold">후보 #{c.index}</span>
                        {isPicked && (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-600">
                            선택됨
                          </span>
                        )}
                        <span className="text-[11px] text-zinc-400">
                          {c.status} · 정장색 {c.suitColor} · seed {c.seed ?? "—"}
                        </span>
                      </div>
                      <div className="mt-2 flex gap-3">
                        <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-foreground/10 bg-foreground/5">
                          {thumb ? (
                            <FadeImg src={thumb} className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-center text-[10px] text-zinc-400">
                              {gen.adminStatus === "picked"
                                ? "선택 후 삭제됨"
                                : gen.adminStatus === "expired"
                                  ? "미선택 만료로 정리됨"
                                  : "이미지 없음"}
                            </div>
                          )}
                        </div>
                        <Pre>{c.positivePrompt}</Pre>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
            )}

            {/* 3단계: 배경 제거 + 선택 */}
            {(p.postprocess || p.picked) && (
              <section className="mt-4 rounded-2xl border border-foreground/10 ui-surface p-4">
                <h2 className="mb-2 text-sm font-bold text-zinc-500">③ 배경 제거 · 선택</h2>
                {p.postprocess && (
                  <>
                    <Row label="누끼 모델">{p.postprocess.model}</Row>
                    <Row label="대상 후보">#{p.postprocess.candidateIndex}</Row>
                    <Row label="완료">{fmtKst(p.postprocess.completedAt)}</Row>
                  </>
                )}
                {p.picked && (
                  <>
                    <Row label="선택 후보">#{p.picked.candidateIndex}</Row>
                    <Row label="캐릭터">{shortId(p.picked.dollId)}</Row>
                    <Row label="선택 시각">{fmtKst(p.picked.pickedAt)}</Row>
                  </>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
