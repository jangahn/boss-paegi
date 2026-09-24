import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { fitOneLineWeight } = await import("../../lib/fit-one-line.ts");
const {
  GRADE_COMMENT_ONE_LINE_MAX_CHARS,
  GRADE_COMMENT_ONE_LINE_MAX_HANGUL,
  GRADE_LABEL_ONE_LINE_MAX_HANGUL,
  gradeFitsOneLine,
  SCORE_CONFIG_DEFAULT,
} = await import("../../lib/config/domains/score.ts");

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("결재란 닉네임 한 줄 맞춤 가중치: 한글 1 · 이모지 1.5(합친 이모지도 한 글자) · 공백 0.35 · 그 외 0.9, 최소 1", () => {
  assert.equal(fitOneLineWeight("광견병걸린너구리"), 8);
  assert.equal(fitOneLineWeight("아 b"), 2.25);
  assert.equal(fitOneLineWeight("😀😀"), 3);
  assert.equal(fitOneLineWeight("👨‍👩‍👧‍👦"), 1.5);
  assert.equal(fitOneLineWeight("WWWWWWWWWW"), 9);
  assert.equal(fitOneLineWeight(""), 1);
});

test("판정 등급 한 줄 규칙(375px 실측): 등급 이름 한글 15자, 한 줄 평 공백 포함 34자 · 한글 28자 — 코드 기본값은 전부 안쪽", () => {
  assert.equal(GRADE_LABEL_ONE_LINE_MAX_HANGUL, 15);
  assert.equal(GRADE_COMMENT_ONE_LINE_MAX_CHARS, 34);
  assert.equal(GRADE_COMMENT_ONE_LINE_MAX_HANGUL, 28);
  for (const g of SCORE_CONFIG_DEFAULT.grades) {
    assert.deepEqual(gradeFitsOneLine(g), { label: true, comment: true }, `${g.label} — ${g.comment}`);
  }
  const hangul = (n: number) => "뷁".repeat(n);
  assert.equal(gradeFitsOneLine({ label: hangul(15), comment: "짧음" }).label, true);
  assert.equal(gradeFitsOneLine({ label: hangul(16), comment: "짧음" }).label, false);
  assert.equal(gradeFitsOneLine({ label: "짧음", comment: hangul(28) }).comment, true);
  assert.equal(gradeFitsOneLine({ label: "짧음", comment: hangul(29) }).comment, false);
  assert.equal(gradeFitsOneLine({ label: "짧음", comment: `${hangul(14)} ${"a".repeat(19)}` }).comment, true);
  assert.equal(gradeFitsOneLine({ label: "짧음", comment: `${hangul(14)} ${"a".repeat(20)}` }).comment, false);
});

test("세 화면(종료 · 공유 · 기록 상세)이 결재란 · 판정 등급 · 보고서 줄을 공용 조각 하나로 쓴다", () => {
  const parts = source("components/ReportParts.tsx");
  for (const path of ["components/ScoreReport.tsx", "app/share/[scoreId]/page.tsx", "app/history/[userId]/[scoreId]/page.tsx"]) {
    const s = source(path);
    assert.match(s, /import \{ GradeRow, ReportApprovalTable, ReportRow \} from "@\/components\/ReportParts";/, path);
    assert.match(s, /<ReportApprovalTable author=\{/, path);
    assert.match(s, /<GradeRow grade=\{grade\} \/>/, path);
    assert.doesNotMatch(s, /function (Report)?Row\(|<table|— \{grade\.comment\}/, path);
  }
  // 결재란: 이미지 옆 남은 폭(결재 칸만 고정) + 닉네임 한 줄(컨테이너 안 span)
  assert.match(parts, /className="w-full min-w-0 flex-1 table-fixed/);
  assert.match(parts, /<div className="@container">\s*<span className="fit-one-line"/);
  // 판정 등급: 등급 이름 = 값 자리, 한 줄 평 = 아래 줄 전체 폭(고르게 줄바꿈)
  assert.match(parts, /<dd className="text-right font-bold">\{grade\.label\}<\/dd>/);
  assert.match(parts, /<dd className="basis-full text-balance text-right text-xs text-zinc-500">[\s\S]*?\{grade\.comment\}\s*<\/dd>/);
  // 360px 미만 공유 · 기록 상세 이미지는 종료 화면과 같은 80px
  for (const path of ["app/share/[scoreId]/page.tsx", "app/history/[userId]/[scoreId]/page.tsx"]) {
    assert.match(source(path), /aspect-square w-20 shrink-0 [^"]*min-\[360px\]:w-24/, path);
  }
  const css = source("app/globals.css");
  assert.match(css, /@supports \(width: 1cqi\) \{\s*\.fit-one-line \{/);
  assert.match(css, /font-size: max\(8px, min\(1em, calc\(100cqi \/ var\(--fit-weight, 1\)\)\)\);/);
});

test("내 최고 기록은 최고 점수 하나만(이번 판 포함) — 「최고 N점까지」 같은 비교 문구 없음", () => {
  const report = source("components/ScoreReport.tsx");
  assert.match(report, /\{Math\.max\(score, previousBest \?\? score\)\.toLocaleString\(\)\}점/);
  assert.doesNotMatch(report, /점까지|이전 \{previousBest|최고 기록과 같은 점수|첫 판이 곧 최고 기록/);
});
