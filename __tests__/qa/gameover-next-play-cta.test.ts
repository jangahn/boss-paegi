import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

// marketing.ts 는 `@/` alias 체인(template → lib/roles)이라 Node 러너에서 직접 import 하지 못한다.
// 다른 컴포넌트 계약 테스트와 같은 source 계약 방식으로 스키마·기본값을 고정한다.
test("game-over next-play copy keys carry the decided defaults and backfill published rows", () => {
  const marketing = source("lib/config/domains/marketing.ts");

  // 스키마: 신규 2키는 .default() — 이미 발행된 marketing_copy 행(키 부재)도 무중단 충전.
  assert.match(
    marketing,
    /gameoverPlayBtnMember: tpl\(30\)\.default\("다른 캐릭터로 패기"\),/,
  );
  assert.match(
    marketing,
    /gameoverPlayBtnNonmember: tpl\(30\)\.default\("다른 캐릭터 더 열고 패기"\),/,
  );
  // 다시 패기 키는 이름·검증 불변(발행값 보존).
  assert.match(marketing, /gameoverRetryBtn: tpl\(20\),/);

  // 코드 기본값(폴백)도 같은 문구.
  assert.match(marketing, /gameoverPlayBtnMember: "다른 캐릭터로 패기",/);
  assert.match(marketing, /gameoverPlayBtnNonmember: "다른 캐릭터 더 열고 패기",/);
  assert.match(marketing, /gameoverRetryBtn: "다시 패기",/);
});

test("game-over modal routes the primary CTA by login state and demotes retry to the text row", () => {
  const modal = source("components/GameOverModal.tsx");

  // 1차 버튼: 회원=갤러리, 비회원=가입 후 갤러리(추가 캐릭터 4종이 열리는 곳, v1.42).
  assert.match(modal, /href: "\/gallery", label: mk\.share\.gameoverPlayBtnMember/);
  assert.match(modal, /href: LOGIN_THEN_GALLERY,/);
  assert.match(modal, /resolveCopy\(mk\.share\.gameoverPlayBtnNonmember, roleLabel\)/);
  // 비회원 부제 = 종료 화면 전용 키(v1.42, 갤러리 배너 제목과 분리).
  assert.match(
    modal,
    /nextPlay\.kind === "nonmember" &&[\s\S]*?mk\.share\.gameoverNonmemberSub/,
  );
  // 로그인 상태(v1.51): 프로필 확인 전(null)에는 회원 힌트(첫 페인트 전 쿠키 판별)를 따르고 프로필 응답으로 확정 —
  // 비회원 기본값이면 회원에게 비회원 1차 버튼과 부제가 잠깐 보였다(__tests__/qa/member-hint.test.ts 가 상세 계약).
  assert.match(modal, /const \[isLoggedIn, setIsLoggedIn\] = useState<boolean \| null>\(null\);/);
  assert.match(modal, /const nextPlay = \(isLoggedIn \?\? readMemberHint\(\)\)/);
  assert.match(modal, /setIsLoggedIn\(p\.isLoggedIn\);/);
  // 다시 패기: 하단 텍스트 행의 button(onRestart). 2차 알약 버튼 형태는 제거.
  assert.match(
    modal,
    /<button\s+type="button"\s+onClick=\{onRestart\}\s+className="underline-offset-4 hover:underline"\s*>\s*\{mk\.share\.gameoverRetryBtn\}/,
  );
  assert.doesNotMatch(modal, /onClick=\{onRestart\}\s+className="rounded-full/);
  // 갤러리 텍스트 링크 제거(1차 버튼이 담당). 공유 버튼의 비활성 조건은 불변.
  assert.doesNotMatch(modal, /href="\/gallery" className="underline-offset-4/);
  assert.match(modal, /disabled=\{!scoreId \|\| sharing\}/);
});

test("marketing surface diagram field map and editable regions stay in lockstep", () => {
  const src = source("components/admin/content/diagram/SurfaceDiagram.tsx");
  const surfacesBlock = src.slice(
    src.indexOf("const SURFACES"),
    src.indexOf("// 저수준 렌더"),
  );
  const fieldBlock = src.slice(
    src.indexOf("export const FIELD_SURFACE"),
    src.indexOf("/* ── 롤 대사 에디터 전용"),
  );
  assert.ok(surfacesBlock.length > 0 && fieldBlock.length > 0);

  const regionIds = new Set(
    [...surfacesBlock.matchAll(/id: "([A-Za-z]+)"/g)].map((m) => m[1]),
  );
  const fieldKeys = new Set(
    [...fieldBlock.matchAll(/^ {2}([A-Za-z]+): \[/gm)].map((m) => m[1]),
  );
  assert.deepEqual([...regionIds].sort(), [...fieldKeys].sort());
  for (const [, region] of fieldBlock.matchAll(/region: "([A-Za-z]+)"/g)) {
    assert.ok(regionIds.has(region), region);
  }

  // 게임 종료 화면 필드는 하이라이트 유/무 두 도식 모두에 매핑된다.
  for (const key of [
    "gameoverPlayBtnMember",
    "gameoverPlayBtnNonmember",
    "gameoverNonmemberSub",
    "scoreShareText",
    "gameoverRetryBtn",
  ]) {
    const entry = fieldBlock.slice(fieldBlock.indexOf(`  ${key}: [`));
    const body = entry.slice(0, entry.indexOf("],"));
    assert.match(body, /surface: "gameover",/, key);
    assert.match(body, /surface: "gameoverHl"/, key);
  }
});
