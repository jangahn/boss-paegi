"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { topWeapon, useGameStore, selectIntervalCV } from "@/store/gameStore";
import { shareGameResult, uploadHighlightClip, saveCardHighlight } from "@/lib/share";
import { bossReaction, gradeFor, reportNo, scoreTier } from "@/lib/report";
import { trackShare } from "@/lib/acquisition";
import { type RoleId } from "@/lib/roles";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { useScoreConfig } from "@/components/ScoreConfigProvider";
import { roleFrom } from "@/lib/config/domains/roles";
import { buildGameplayStats } from "@/lib/stats";
import { matchPersona } from "@/lib/persona";
import { evaluateBadges } from "@/lib/config/domains/badges";
import { useBadgeCatalog } from "@/components/BadgeCatalogProvider";
import { useMarketingCopy } from "@/components/MarketingCopyProvider";
import { resolveCopy } from "@/lib/config/template";
import { getMyProfile } from "@/lib/profile";
import type { HighlightClip } from "@/lib/highlight";
import { elapsedScoreDurationMs } from "@/lib/score-retry";
import { useDialogFocus } from "@/lib/use-dialog-focus";
import { isCurrentClientEpoch } from "@/lib/client-lifecycle";
import { useClientOperationScope } from "@/lib/use-client-operation-scope";
import { useScoreSubmission } from "./useScoreSubmission";
import { ScoreReport } from "./ScoreReport";

type Props = {
  open: boolean;
  onRestart: () => void;
  weapon: string;
  dollId: string | null;
  /** 맞는 캐릭터의 롤 — 피격자 의견·공유 문구 분기. 기본 boss. */
  role?: RoleId;
  /** 보고서에 표시할 캐릭터 이미지 (커스텀 or 기본) */
  dollImageUrl?: string;
  /** 하이라이트 녹화분 (없으면 카드만 공유) */
  highlightClip?: HighlightClip | null;
  /** 클립 없을 때 카드용 급상승 메타 (timeline 기반) */
  getCardHighlight?: () => { delta: number; windowMs: number } | null;
  /** 플레이 중 들른 배경 key 목록 (해석 리포트용 — store 밖이라 page 가 전달) */
  bgVisits?: string[];
  /** 종료 사유 — 강제종료(시간/점수) 분석용. 기본 normal. */
  endReason?: "normal" | "time_limit" | "score_limit";
  /** 텔레메트리 세션 id — 점수↔세션 링크(scores.telemetry_session_id). */
  telemetrySessionId?: string | null;
};

export function GameOverModal({
  open,
  onRestart,
  weapon,
  dollId,
  role = "boss",
  dollImageUrl,
  highlightClip,
  getCardHighlight,
  bgVisits,
  endReason = "normal",
  telemetrySessionId = null,
}: Props) {
  const router = useRouter();
  const roleCfg = useRoleConfig(); // 마케터 편집 롤 콘텐츠(반응·라벨, 라이브)
  const roleLabel = roleFrom(role, roleCfg).label;
  const scoreGrades = useScoreConfig().grades; // 마케터 편집 등급 라벨/코멘트
  const mk = useMarketingCopy(); // 마케터 편집 공유/CTA 문구

  const score = useGameStore((s) => s.score);
  const maxCombo = useGameStore((s) => s.maxCombo);
  const hitCount = useGameStore((s) => s.hitCount);
  const weaponCounts = useGameStore((s) => s.weaponCounts);
  const weaponScores = useGameStore((s) => s.weaponScores);
  const ultScore = useGameStore((s) => s.ultScore);
  const ultimateCount = useGameStore((s) => s.ultimateCount);
  const firstHitMs = useGameStore((s) => s.firstHitMs);
  const startedAt = useGameStore((s) => s.startedAt);
  const endedAt = useGameStore((s) => s.endedAt);
  // 타격 간격 CV(어뷰징 jitter, S5) — 러닝 통계에서 지연 계산. 표본부족이면 null.
  const intervalCV = useGameStore((s) => selectIntervalCV(s));
  const dialogRef = useDialogFocus<HTMLDivElement>(open);
  const runScopedOperation = useClientOperationScope();

  // 플레이 해석 스탯 + 페르소나 — 룰베이스 즉시 계산(서버 대기 0). 저장도 같은 객체 제출.
  const gameplayStats = useMemo(
    () =>
      buildGameplayStats({
        hitCount,
        maxCombo,
        durationMs: elapsedScoreDurationMs(startedAt, endedAt),
        weaponCounts,
        weaponScores,
        ultScore,
        ultimateCount,
        firstHitMs,
        bgVisits: bgVisits ?? [],
        intervalCV,
      }),
    [
      hitCount,
      maxCombo,
      endedAt,
      startedAt,
      weaponCounts,
      weaponScores,
      ultScore,
      ultimateCount,
      firstHitMs,
      bgVisits,
      intervalCV,
    ]
  );
  const persona = useMemo(() => matchPersona(gameplayStats), [gameplayStats]);
  const badgeCatalog = useBadgeCatalog();
  // 이번 판 달성 뱃지 — 클라 즉시(서버 응답이 NEW/수집수를 채움). 표시용(서버가 인증 grant).
  const earnedBadges = useMemo(
    () => evaluateBadges(gameplayStats, score, badgeCatalog),
    [gameplayStats, score, badgeCatalog]
  );
  // The persisted score weapon must match every report surface's "주력 무기".
  // `weapon` is merely the tool selected at the instant the game ended.
  const mainWeapon = topWeapon(weaponCounts) ?? weapon;

  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [nickname, setNickname] = useState<string>("");
  // 하이라이트 업로드(백그라운드) 진행/완료 표시 + 1회 가드(중복 업로드 차단).
  const [uploading, setUploading] = useState(false);
  const [attached, setAttached] = useState(false);
  const [sharing, setSharing] = useState(false);
  const uploadStartedRef = useRef(false);
  const sharingRef = useRef(false);
  const mountedRef = useRef(false);
  const openCycleEpochRef = useRef(0);

  useEffect(() => {
    // StrictMode setup→cleanup→setup 뒤에도 현재 lifecycle을 복원한다.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      openCycleEpochRef.current += 1;
    };
  }, []);

  // 새 게임으로 다시 열릴 때(컴포넌트는 항상 마운트, open 토글) 공유/업로드 상태 리셋.
  // (gallery/leaderboard 등과 동일한 open→state sync 패턴.)
  useEffect(() => {
    openCycleEpochRef.current += 1;
    if (!open) return;
    uploadStartedRef.current = false;
    sharingRef.current = false;
    // open 토글(새 게임)마다 공유/업로드 상태 리셋 — 의도적 open→state 동기화(gallery/leaderboard 동일 패턴).
    /* eslint-disable react-hooks/set-state-in-effect */
    setUploading(false);
    setAttached(false);
    setSharing(false);
    setShareMsg(null);
    setNickname("");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open]);

  // 점수 자동 제출(중복/0점 가드·클램프·trace 는 hook 내부)
  const {
    scoreId,
    submitting,
    submitError,
    percentile,
    newBadges,
    collectedCount,
    reviewStatus,
    retrySubmission,
  } =
    useScoreSubmission({
      open,
      score,
      endedAt,
      startedAt,
      weapon: mainWeapon,
      dollId,
      maxCombo,
      gameplayStats,
      endReason,
      telemetrySessionId,
    });

  useEffect(() => {
    if (!open) return;
    const cycleEpoch = openCycleEpochRef.current;
    getMyProfile()
      .then((p) => {
        if (
          p &&
          isCurrentClientEpoch(
            cycleEpoch,
            openCycleEpochRef.current,
            mountedRef.current,
          )
        ) {
          setNickname(p.display_name);
        }
      })
      .catch(() => {});
  }, [open]);

  // 로컬 프리뷰 objectURL — clip 값 기반 memo, 언마운트/변경 시 revoke (set-state 회피).
  const clip = open ? highlightClip ?? null : null;
  const clipUrl = useMemo(
    () => (clip ? URL.createObjectURL(clip.blob) : null),
    [clip]
  );
  useEffect(() => {
    return () => {
      if (clipUrl) URL.revokeObjectURL(clipUrl);
    };
  }, [clipUrl]);

  if (!open) return null;

  const durationMs = elapsedScoreDurationMs(startedAt, endedAt);
  const grade = gradeFor(score, scoreGrades);
  const reaction = bossReaction(score, scoreId ?? String(score), role, roleCfg);
  const docNo = scoreId ? reportNo(scoreId, new Date()) : "결재 대기";
  // 어뷰징 의심(pending/voided) — 랭킹 미반영·공유 차단·뱃지 미노출·검토 안내.
  const isPending = !!reviewStatus && reviewStatus !== "registered";
  const pendingNotice = isPending
    ? { notice: mk.share.pendingReviewNotice, warning: mk.share.pendingReviewWarning }
    : null;

  // gesture 안에서 URL 즉시 공유(친구는 보통 수 초+ 뒤 열어 그때면 attach 완료).
  // 클립 업로드/카드 저장은 같은 탭의 백그라운드 — 실패해도 링크 공유는 이미 됨(불변 원칙).
  const handleShare = () => {
    if (!scoreId || sharingRef.current) return;
    const sid = scoreId;
    const cycleEpoch = openCycleEpochRef.current;
    sharingRef.current = true;
    setShareMsg(null);
    setSharing(true);
    // 공유 시도(분석) — 게임오버 결과화면당 1회(onceKey=scoreId). scoreId 는 키로만, analytics 엔 미저장.
    try {
      trackShare({
        surface: "game_over",
        target: "score",
        scoreTier: scoreTier(score),
        onceKey: sid,
      });
    } catch {
      // Analytics is never allowed to block the user-visible share action.
    }
    // 클립 업로드/카드 저장은 1회만(중복 업로드 차단). 즉시 링크 공유는 매 탭 가능.
    if (!uploadStartedRef.current) {
      uploadStartedRef.current = true;
      let cardH: { delta: number; windowMs: number } | null = null;
      try {
        cardH = getCardHighlight?.() ?? null;
      } catch {
        // A timeline fallback probe is optional; a captured clip/link can
        // still be shared when the probe itself is unavailable.
      }
      if (clip || cardH) {
        setUploading(true);
        void (async () => {
          try {
            const clipAttached = await runScopedOperation(
              async (signal) => {
                let attached = false;
                if (clip) {
                  const r = await uploadHighlightClip(
                    sid,
                    clip,
                    { signal },
                  );
                  if (r !== "failed") attached = true;
                  else if (cardH) {
                    await saveCardHighlight(sid, cardH, {
                      signal,
                    });
                  }
                } else if (cardH) {
                  await saveCardHighlight(sid, cardH, {
                    signal,
                  });
                }
                return attached;
              },
            );
            // '하이라이트 첨부 완료'는 실제 영상 클립이 붙었을 때만. card(stat 폴백)는 영상이 없어 표시 안 함.
            if (
              clipAttached &&
              isCurrentClientEpoch(
                cycleEpoch,
                openCycleEpochRef.current,
                mountedRef.current,
              )
            ) {
              setAttached(true);
            }
          } catch {
            // 업로드 실패해도 링크 공유는 이미 됨(불변 원칙) — 조용히 무시.
          } finally {
            if (
              isCurrentClientEpoch(
                cycleEpoch,
                openCycleEpochRef.current,
                mountedRef.current,
              )
            ) {
              setUploading(false);
            }
          }
        })();
      }
    }
    // 하이라이트 영상은 모바일에서만 첨부(runShare 게이트) — PC 는 자동으로 문구+링크.
    let clipFile: File | null = null;
    try {
      clipFile = clip
        ? new File(
          [clip.blob],
          `boss-paegi-highlight.${clip.mime.includes("webm") ? "webm" : "mp4"}`,
          { type: clip.mime }
        )
        : null;
    } catch {
      // File construction can fail under memory pressure or an incomplete
      // browser implementation. Preserve text/link sharing as the fallback.
    }
    let shareText: string | undefined;
    try {
      shareText = resolveCopy(mk.share.scoreShareText, roleLabel, {
        제작자: nickname ?? undefined,
        점수: score.toLocaleString(),
      });
    } catch {
      // shareGameResult owns a stable default copy.
    }
    void shareGameResult(sid, score, {
      // 게임종료=플레이어 본인 결과라 {제작자}=닉네임. history 경로와 vars 정합(어드민이
      // 웹공유텍스트에 {제작자} 넣어도 깨지지 않게 — 닉네임 미로드 시 빈 토큰).
      text: shareText,
      file: clipFile,
    })
      .then((result) => {
        if (
          !isCurrentClientEpoch(
            cycleEpoch,
            openCycleEpochRef.current,
            mountedRef.current,
          )
        ) {
          return;
        }
        if (result === "shared") setShareMsg("공유했어요!");
        else if (result === "copied") setShareMsg("링크 복사됨");
        else if (result === "failed") setShareMsg("공유 실패");
      })
      .catch(() => {
        if (
          isCurrentClientEpoch(
            cycleEpoch,
            openCycleEpochRef.current,
            mountedRef.current,
          )
        ) {
          setShareMsg("공유 실패");
        }
      })
      .finally(() => {
        if (
          isCurrentClientEpoch(
            cycleEpoch,
            openCycleEpochRef.current,
            mountedRef.current,
          )
        ) {
          sharingRef.current = false;
          setSharing(false);
        }
      });
  };

  return (
    // 스크롤-센터: 짧으면 가운데, 길면(클립 프리뷰로 키 큼) 위→아래 전체 스크롤 도달(상단 안 잘림).
    // 블러 백드롭은 형제 레이어로 분리 — iOS WebKit 의 backdrop-filter 자손 재도색 버그
    // (내용 변경 시 이전 래스터 고스트) 회피. ModalShell 과 동일 구조.
    <div className="absolute inset-0 z-20">
      <div
        aria-hidden
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="게임 결과"
        tabIndex={-1}
        className="absolute inset-0 overflow-y-auto"
      >
      <div className="flex min-h-full items-center justify-center px-4 py-6">
        <div className="w-full max-w-sm">
        {/* ── 보고서 (종이) ───────────────────────────────── */}
        <ScoreReport
          docNo={docNo}
          score={score}
          maxCombo={maxCombo}
          hitCount={hitCount}
          mainWeapon={mainWeapon}
          durationMs={durationMs}
          grade={grade}
          reaction={reaction}
          nickname={nickname}
          dollImageUrl={dollImageUrl}
          roleLabel={roleLabel}
          persona={isPending ? undefined : persona}
          percentile={percentile}
          badges={isPending ? [] : earnedBadges}
          newBadges={isPending ? [] : newBadges}
          collectedCount={collectedCount}
          badgeCatalog={badgeCatalog}
          submitting={submitting}
          submitError={submitError}
          onRetrySubmit={retrySubmission}
          pending={pendingNotice}
        />

        {/* ── 하이라이트 클립 프리뷰 (녹화 성공 시) ───────── */}
        {clipUrl && (
          <div className="mt-4 overflow-hidden rounded-2xl border border-white/15 bg-black">
            <video
              src={clipUrl}
              autoPlay
              loop
              muted
              playsInline
              className="aspect-[9/16] max-h-64 w-full object-contain"
            />
            <p className="bg-black/60 py-1 text-center text-[11px] text-white/70">
              🔥 점수 급상승 하이라이트
            </p>
          </div>
        )}

        {/* ── CTA ────────────────────────────────────────── */}
        <div className="mt-4 flex flex-col gap-2.5">
          {!isPending && (
            <button
              type="button"
              onClick={handleShare}
              disabled={!scoreId || sharing}
              className="rounded-full bg-white py-3 font-semibold text-black transition hover:opacity-90 disabled:opacity-40"
            >
              {sharing
                ? "공유 준비 중…"
                : clipUrl
                  ? mk.share.gameoverShareBtnHighlight
                  : mk.share.gameoverShareBtn}
            </button>
          )}
          <button
            type="button"
            onClick={onRestart}
            className="rounded-full border border-white/25 py-3 font-medium text-white transition hover:bg-white/10"
          >
            {mk.share.gameoverRetryBtn}
          </button>
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 pt-1 text-sm text-zinc-300">
            <button
              type="button"
              onClick={() => router.push("/leaderboard")}
              className="underline-offset-4 hover:underline"
            >
              랭킹
            </button>
            <Link
              href="/badges"
              className="underline-offset-4 hover:underline"
            >
              내 뱃지
            </Link>
            <Link href="/gallery" className="underline-offset-4 hover:underline">
              갤러리
            </Link>
            <Link href="/" className="underline-offset-4 hover:underline">
              홈으로
            </Link>
          </div>
          {uploading && (
            <p className="text-center text-xs text-zinc-400">하이라이트 올리는 중…</p>
          )}
          {attached && !uploading && (
            <p className="text-center text-xs text-emerald-500/80">하이라이트 첨부 완료</p>
          )}
          {shareMsg && (
            <p className="text-center text-xs text-zinc-400">{shareMsg}</p>
          )}
        </div>
        </div>
      </div>
      </div>
    </div>
  );
}
