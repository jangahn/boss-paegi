/**
 * 하이라이트 증분 추적 오케스트레이션 — **순수**(DOM 무관, Blob.size 만 사용).
 * 롤링버퍼(청크) + globalBest(점수) ↔ pending(청크 대기) ↔ candidates(확보) 3단 분리.
 * MediaRecorder/Blob 조립/검증은 useHighlightRecorder 가, 시간 정렬·선택 로직은 여기가 담당
 * (React 없이 단위 검증 가능).
 */
import {
  findBestScoreWindowIncremental,
  compareHighlightWindow,
  BUFFER_MS,
  SNAPSHOT_CANDIDATES,
  PRE_ROLL_MS,
  type ScoreSample,
  type HighlightWindow,
} from "@/lib/highlight";
import { selectWindowChunks, type RecChunk } from "./highlight-clip";

/** 확보된 스냅샷 후보 — Blob 은 finalize 시 chunkSeqs 로 조립(메모리 절약). */
export type Candidate = {
  delta: number;
  /** 검출 윈도우(메타 windowMs 용 — 실제 클립보다 좁음) */
  winStartAt: number;
  winEndAt: number;
  chunkSeqs: number[];
};

export class HighlightTracker {
  private chunks: RecChunk[] = [];
  private candidates: Candidate[] = [];
  private globalBest: HighlightWindow | null = null;
  private pending: HighlightWindow | null = null;
  initChunk: RecChunk | null = null;
  initSeq: number | null = null;
  recordingReadyPerf: number | null = null;

  /** ondataavailable — 청크 push 후 pending 스냅샷 재시도(청크 늦게 도착하는 레이스 해소). */
  pushChunk(chunk: RecChunk): void {
    if (chunk.blob.size === 0) return;
    if (!this.initChunk) {
      this.initChunk = chunk;
      this.initSeq = chunk.seq;
      this.recordingReadyPerf = chunk.startPerf;
    }
    this.chunks.push(chunk);
    this.trim();
    this.trySnapshot(false);
  }

  /** score 갱신마다 — best window 평가. 갱신 시 기존 pending 먼저 시도 후 덮음. */
  evaluate(samples: ScoreSample[]): void {
    const ready = this.recordingReadyPerf;
    if (ready == null) return; // 준비 전 → 카드만
    const localBest = findBestScoreWindowIncremental(samples);
    if (!localBest || localBest.startAt < ready) return;
    if (this.globalBest && compareHighlightWindow(localBest, this.globalBest) <= 0) {
      if (this.pending) this.trySnapshot(false);
      return;
    }
    if (this.pending) this.trySnapshot(false); // 덮기 전 유실 방지
    this.globalBest = localBest;
    this.pending = localBest;
    this.trySnapshot(false);
  }

  /** finalize — 마지막 구간 재평가(compare 만) 후 globalBest 강제 스냅샷. */
  finalize(samples: ScoreSample[]): void {
    const ready = this.recordingReadyPerf;
    if (ready != null) {
      const finalBest = findBestScoreWindowIncremental(samples);
      if (finalBest && finalBest.startAt >= ready) {
        if (!this.globalBest || compareHighlightWindow(finalBest, this.globalBest) > 0) {
          this.globalBest = finalBest; // 60초 cap 이라 덮어쓰기 금지 — 더 좋을 때만
        }
      }
    }
    if (this.globalBest) {
      this.pending = this.globalBest;
      this.trySnapshot(true);
    }
  }

  /** delta desc 후보. */
  orderedCandidates(): Candidate[] {
    return [...this.candidates].sort((a, b) => b.delta - a.delta);
  }

  /** seq → 청크(init 포함) — 조립용. */
  chunkMap(): Map<number, RecChunk> {
    const m = new Map<number, RecChunk>();
    for (const c of this.chunks) m.set(c.seq, c);
    if (this.initChunk) m.set(this.initChunk.seq, this.initChunk);
    return m;
  }

  /** 오래되고 후보 미참조인 청크 폐기(init/참조 청크 보존). now=최신 청크 끝(클럭 무관). */
  private trim(): void {
    const now = this.chunks.length ? this.chunks[this.chunks.length - 1].endPerf : 0;
    const cutoff = now - BUFFER_MS;
    const refSeqs = new Set<number>();
    for (const c of this.candidates) for (const s of c.chunkSeqs) refSeqs.add(s);
    this.chunks = this.chunks.filter(
      (c) => c.endPerf >= cutoff || refSeqs.has(c.seq) || c.seq === this.initSeq
    );
  }

  /** 같은 chunkSeqs 면 메타 갱신, 아니면 추가. delta desc 상위 K 유지 + 재-trim. */
  private upsert(win: HighlightWindow, chunkSeqs: number[]): void {
    const key = chunkSeqs.join(",");
    const existing = this.candidates.find((c) => c.chunkSeqs.join(",") === key);
    if (existing) {
      if (win.delta > existing.delta) {
        existing.delta = win.delta;
        existing.winStartAt = win.startAt;
        existing.winEndAt = win.endAt;
      }
    } else {
      this.candidates.push({
        delta: win.delta,
        winStartAt: win.startAt,
        winEndAt: win.endAt,
        chunkSeqs,
      });
    }
    this.candidates.sort((a, b) => b.delta - a.delta);
    if (this.candidates.length > SNAPSHOT_CANDIDATES) {
      this.candidates.length = SNAPSHOT_CANDIDATES;
    }
    this.trim();
  }

  /** pending window 의 청크가 확보됐으면 candidate 로. final 이면 trailing 완화. */
  private trySnapshot(final: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    const ready = this.recordingReadyPerf;
    if (!this.initChunk || this.initSeq == null || ready == null) return;
    if (pending.startAt < ready) {
      this.pending = null; // 준비 전 구간 → 영상 불가
      return;
    }
    const latestEnd = this.chunks.length ? this.chunks[this.chunks.length - 1].endPerf : -Infinity;
    if (!final && latestEnd < pending.endAt) return; // 끝점도 아직 — 대기
    const seqs = selectWindowChunks(this.chunks, this.initSeq, pending, ready, final);
    if (!seqs) {
      if (!final) {
        const earliest = this.chunks.length ? this.chunks[0].startPerf : Infinity;
        if (earliest > pending.startAt - PRE_ROLL_MS) this.pending = null; // 밀림 → 폐기
      }
      return;
    }
    this.upsert(pending, seqs);
    this.pending = null;
  }
}
