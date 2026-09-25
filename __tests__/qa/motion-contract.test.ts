// 모션 규약(v1.65) — 게임 밖 화면 연출. 설계 = 레포 _local/SPEC-interaction-motion-2026-09-25.md, 사용자 결정(9/25):
// 추천안대로, 단 iOS · Android 한쪽에서만 되는 기능은 넣지 않는다(진동 제외).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { jellyFrames, squashScale, squashAt, JELLY_HIT } = await import("../../lib/jelly.ts");
const { CEREMONY_MS } = await import("../../lib/motion.ts");

const root = new URL("../../", import.meta.url);
const ROOT = fileURLToPath(root);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}
const appFiles = ["app", "components", "lib", "game", "store"].flatMap((d) => walk(join(ROOT, d)));

/** globals.css 의 「모션(v1.65)」 절 — 새 연출 CSS 는 전부 여기. */
function motionCss(): string {
  const css = source("app/globals.css");
  const start = css.indexOf("모션(v1.65)");
  assert.ok(start > 0, "globals.css 모션 절");
  return css.slice(start);
}

test("한쪽 플랫폼 전용 기능 금지 — 진동(navigator.vibrate, iOS Safari 미지원)을 쓰지 않는다", () => {
  for (const f of appFiles) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /navigator\.vibrate|\.vibrate\(/, relative(ROOT, f));
  }
});

test("젤리 곡선은 한 곳 — 게임 인형(Doll)과 게임 밖 찌르기가 같은 식(lib/jelly.ts)", () => {
  const doll = source("game/entities/Doll.ts");
  assert.match(doll, /import \{ JELLY_BOUNCE, JELLY_HIT, squashScale \} from "@\/lib\/jelly";/);
  assert.match(doll, /squashScale\(this\.sqAmp \* Math\.cos\(this\.sqPhase\), this\.sqAx, this\.sqAy\)/);
  assert.doesNotMatch(doll, /sq \* 0\.7/, "식을 인형 안에 다시 쓰지 않는다");
  // 종전 식과 같은 값: sx = 1 − sq·ax + 0.7·sq·ay, sy = 1 − sq·ay + 0.7·sq·ax
  for (const [sq, ax, ay] of [[0.15, 0, 1], [-0.1, 1, 0], [0.3, 0.5, 0.5]]) {
    const { sx, sy } = squashScale(sq, ax, ay);
    assert.ok(Math.abs(sx - (1 - sq * ax + sq * 0.7 * ay)) < 1e-12);
    assert.ok(Math.abs(sy - (1 - sq * ay + sq * 0.7 * ax)) < 1e-12);
  }
  // 한 번 찌르면 눌린 채 시작해 감쇠 진동하고 원래 크기로 끝난다.
  const frames = jellyFrames({ amp: 0.14 });
  assert.ok(frames[0].sy < 1 && frames[0].sx > 1, "위에서 눌림");
  assert.deepEqual([frames.at(-1)!.sx, frames.at(-1)!.sy, frames.at(-1)!.offset], [1, 1, 1]);
  assert.ok(Math.abs(squashAt(0, 1, JELLY_HIT.freq, JELLY_HIT.damp) - 1) < 1e-12);
});

test("애니메이션 라이브러리 없음 — 등장 · 반복은 CSS, 누름 · 퇴장은 WAAPI(Motion 은 재 보니 경로마다 압축 약 +76KB라 뺐다)", () => {
  const pkg = JSON.parse(source("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of ["motion", "framer-motion", "gsap", "lenis", "@studio-freight/lenis", "react-spring", "lottie-web"]) {
    assert.ok(!(name in deps), name);
  }
  for (const f of appFiles) assert.doesNotMatch(readFileSync(f, "utf8"), /from "(motion|framer-motion)(\/[a-z]+)?"/, relative(ROOT, f));
});

test("연출 CSS 는 transform 계열(+ clip-path)만 — 글자 opacity 금지(iOS 잔상), 예외는 View Transition 스냅샷 · 단색 덮개", () => {
  const css = motionCss();
  const keyframes = [...css.matchAll(/@keyframes ([\w-]+) \{([\s\S]*?)\n\}/g)];
  assert.ok(keyframes.length >= 10);
  for (const [, name, body] of keyframes) {
    const props = new Set([...body.matchAll(/^\s*([a-z-]+):/gm)].map((m) => m[1]));
    for (const prop of props) {
      const allowed =
        ["translate", "scale", "rotate", "transform", "clip-path"].includes(prop) ||
        (prop === "opacity" && (/^vt-/.test(name) || name === "scrim-in")); // VT 스냅샷 · 단색 덮개만
      assert.ok(allowed, `${name}: ${prop}`);
    }
  }
});

test("모션 감소 — 새 연출 클래스는 전부 끄고 View Transition 은 0초", () => {
  const css = motionCss();
  const reduce = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  const classes = new Set([...css.matchAll(/\.(motion-[\w-]+|cer-[\w-]+)\s*[{,]/g)].map((m) => m[1]));
  for (const cls of classes) assert.ok(reduce.includes(`.${cls}`), cls);
  assert.match(reduce, /::view-transition-group\(\*\)[\s\S]*animation-duration: 0s !important;/);
});

test("결과 보고서 연출 시점 — CSS 지연 = lib/motion.ts CEREMONY_MS", () => {
  const css = motionCss();
  assert.match(css, new RegExp(`\\.cer-stamp \\{\\s*animation: stamp-slam 420ms var\\(--ease-stamp\\) ${CEREMONY_MS.stamp}ms both;`));
  assert.match(css, new RegExp(`\\.cer-shake \\{\\s*animation: paper-shake 180ms linear ${CEREMONY_MS.impact}ms;`));
  assert.match(css, new RegExp(`animation-delay: calc\\(${CEREMONY_MS.rise}ms \\+ var\\(--i, 0\\) \\* 60ms\\);`));
  assert.match(css, new RegExp(`animation-delay: calc\\(${CEREMONY_MS.pop}ms \\+ var\\(--i, 0\\) \\* 80ms\\);`));
  assert.match(css, new RegExp(`\\.cer-nudge \\{\\s*animation: nudge 460ms var\\(--ease-stamp\\) ${CEREMONY_MS.nudge}ms;`));
});

test("결과 보고서 — 연출 중에도 버튼은 바로(다시 패기 클래스 · 순서 불변), 탭하면 끝 상태, 카운트업은 자리 고정", () => {
  const modal = source("components/GameOverModal.tsx");
  assert.match(modal, /<div data-ceremony=\{ceremony\} className="flex min-h-full flex-col">/);
  assert.match(modal, /onPointerDownCapture=\{ceremony === "play" \? finishCeremony : undefined\}/);
  assert.match(modal, /if \(prefersReducedMotion\(\)\) \{[\s\S]*?setCeremony\("done"\);/);
  assert.match(modal, /<div className="cer-nudge mx-auto w-full max-w-sm">/);
  const countUp = source("components/motion/CountUp.tsx");
  assert.match(countUp, /<span aria-hidden className="invisible">\s*\{final\}/, "최종 값 폭으로 자리");
  assert.match(countUp, /<span className="sr-only">\{final\}<\/span>/, "화면낭독기는 최종 값");
  assert.match(source("components/ScoreReport.tsx"), /<CountUp value=\{score\} play=\{ceremony\} delayMs=\{CEREMONY_MS\.score\} durationMs=\{CEREMONY_MS\.scoreMs\} \/>/);
  // 공유 · 기록 상세는 서버 HTML 에 연출 표지(첫 페인트, 카운트업 없음)
  for (const page of ["app/share/[scoreId]/page.tsx", "app/history/[userId]/[scoreId]/page.tsx"]) {
    assert.match(source(page), /<div data-ceremony="play" className="w-full max-w-sm">/, page);
  }
  // 결과 화면 동안 게임 그리기 멈춤
  assert.match(source("app/play/page.tsx"), /gameRef\.current\?\.setRendering\(!over\);/);
});

test("모달 · 메뉴 · 말풍선 — 등장은 CSS(덮개만 opacity), 사라질 때는 복제본 퇴장(부르는 쪽 수정 없음)", () => {
  const modal = source("components/ModalShell.tsx");
  assert.match(modal, /data-modal-scrim\s+className=\{`absolute inset-0 bg-black\/60 backdrop-blur-sm \$\{isAdmin \? "" : "motion-scrim"\}`\}/);
  assert.match(modal, /data-modal-sheet[\s\S]*?\$\{isAdmin \? "" : "motion-sheet"\}/);
  assert.match(modal, /useExitClone\(\s*rootRef,/);
  assert.match(source("components/AccountMenu.tsx"), /className="motion-menu absolute right-0/);
  assert.match(source("components/AccountMenu.tsx"), /useExitClone\(panelRef,/);
  assert.match(source("components/home/HomeCharacterRow.tsx"), /useExitClone\(bubbleRef,/);
  const exit = source("components/motion/useExitClone.ts");
  assert.match(exit, /clone\.inert = true;/);
  assert.match(exit, /clone\.setAttribute\("aria-hidden", "true"\);/);
  assert.match(exit, /if \(!el \|\| !parent \|\| !enabledRef\.current \|\| prefersReducedMotion\(\)\) return;/);
  // 글자가 있는 층에는 opacity 연출이 없다 — 덮개(scrim)만.
  for (const f of ["components/ModalShell.tsx", "components/AccountMenu.tsx", "components/home/HomeCharacterRow.tsx"]) {
    const lines = source(f).split("\n").filter((l) => /opacity/.test(l) && /animate\(/.test(l));
    for (const l of lines) assert.match(l, /data-modal-scrim/, `${f}: ${l.trim()}`);
  }
});

test("찌르기 · 도발 — 열린 캐릭터만(잠긴 캐릭터 무반응 v1.44 유지), 도발 문구는 롤 콘텐츠 시비 멘트 재사용", () => {
  const row = source("components/home/HomeCharacterRow.tsx");
  const lockedBranch = row.slice(row.indexOf("{locked ? ("), row.indexOf(") : ("));
  assert.doesNotMatch(lockedBranch, /onPointerDown|playJelly|markPlayDollSource/);
  assert.match(row, /roleVoice\(roleFrom\(doll\.role, roleCfg\), doll\.gender\)\.taunts\[0\]/);
  assert.match(row, /if \(prefersReducedMotion\(\)\) return;/);
  const base = source("components/gallery/BaseDollCard.tsx");
  const lockedCard = base.slice(base.indexOf("{locked ? ("), base.indexOf(") : ("));
  assert.doesNotMatch(lockedCard, /onPointerDown|playJelly/);
});

test("화면 전환 — 상단 메뉴만 본문 교차(nav 타입), 선택 알약 하나, 캐릭터 → 로딩 막 이어짐", () => {
  assert.match(source("components/AppNav.tsx"), /transitionTypes=\{\[NAV_TRANSITION\]\}/);
  assert.match(source("components/AppNav.tsx"), /style=\{\{ viewTransitionName: NAV_PILL_NAME \}\}/);
  assert.match(
    source("app/layout.tsx"),
    /<ViewTransition update=\{\{ \[NAV_TRANSITION\]: "nav-fade", \[PLAY_TRANSITION\]: "nav-fade", default: "none" \}\} enter="none" exit="none" default="none">/,
  );
  const preview = source("components/play/PlayDollPreview.tsx");
  assert.match(preview, /style=\{\{ viewTransitionName: PLAY_DOLL_TRANSITION \}\}/);
  for (const card of ["components/home/HomeCharacterRow.tsx", "components/gallery/BaseDollCard.tsx", "components/gallery/DefaultBossCard.tsx"]) {
    assert.match(source(card), /transitionTypes=\{\[PLAY_TRANSITION\]\}/, card);
  }
  assert.match(preview, /const key = doll \?\? pendingPlayDollKey\(\);/, "서버 HTML 틀(fallback)은 누른 캐릭터를 읽는다");
  assert.match(source("app/play/page.tsx"), /useEffect\(\(\) => resetPendingPlayDoll\(\), \[\]\);/);
  const css = motionCss();
  assert.match(css, /::view-transition \{\s*pointer-events: none;/);
  // 랭킹 목록은 연출 없이 바로(v1.66 사용자 결정 — 차례로 올라오는 물결이 꿀렁여 보였다). 탭 알약 미끄러짐은 유지.
  const leaderboard = source("app/leaderboard/page.tsx");
  assert.doesNotMatch(leaderboard, /motion-rise/);
  assert.match(leaderboard, /transition-transform duration-300 ease-\[var\(--ease-paper\)\]/);
});
