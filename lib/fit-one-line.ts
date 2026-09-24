/**
 * 한 줄 맞춤(v1.57) — `.fit-one-line`(app/globals.css)이 칸 폭 ÷ 글자 폭 합(--fit-weight, em)으로 글자를 줄여 한 줄에 넣는다.
 * 쓰는 곳: 결과 보고서 결재란 작성자(components/ReportParts.tsx). 의존성 없는 순수 모듈(서버 · 클라 · 테스트 공용).
 */
const EMOJI = /\p{Extended_Pictographic}/u;
const WIDE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3\u2e80-\u9fff\uff00-\uffef]/;
// 글자 단위 = 자소 묶음(grapheme). Intl.Segmenter 가 없는 브라우저(Firefox 125 · Safari 14.1 미만)는 코드 포인트로 센다
// — 합쳐진 이모지를 여러 글자로 세어 조금 더 줄일 뿐, 모듈 로드가 실패해 결과 화면이 깨지지 않게.
const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("ko", { granularity: "grapheme" }) : null;
const units = (text: string): string[] =>
  segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);

/**
 * 한 줄에 필요한 글자 폭 합(em) — 실측(11px) 기준 넉넉한 상한: 이모지 1.5(1.27~1.45 실측) · 한글 · 한자 · 전각 1.0(0.86) ·
 * 공백 0.35 · 그 외 영문 · 숫자 · 기호 0.9(W · m 0.85). `.fit-one-line` 이 칸 폭 ÷ 이 값으로 글자를 줄인다.
 */
export function fitOneLineWeight(text: string): number {
  let sum = 0;
  for (const segment of units(text)) {
    sum += EMOJI.test(segment) ? 1.5 : WIDE.test(segment) ? 1 : segment === " " ? 0.35 : 0.9;
  }
  return Math.max(1, Math.round(sum * 100) / 100);
}
