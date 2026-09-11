// nickname-vocab.test.ts — 랜덤 닉네임 v2 어휘 계약(0128 백필 + 0129 공백 제거): 접두 20·수식어 40·명사 50, 각 ≤3자, 숫자·공백·중복 없음,
//   조합 "접두수식어명사" 최대 9자(공백 없음), 구 자동 패턴 15개 백필 대상, 백업 테이블 RLS·FK 없음, NICKNAME_MAX 10.
//   실행: node --test __tests__/account/nickname-vocab.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const sql128 = fs.readFileSync(path.resolve(process.cwd(), "supabase/migrations/0128_nickname_three_part.sql"), "utf8");
const sql129 = fs.readFileSync(path.resolve(process.cwd(), "supabase/migrations/0129_nickname_no_space.sql"), "utf8");
/** 파일 안의 `<name> text[] := array[...]` 선언 전부(함수 본문 + DO 블록) */
function arraysOf(sql: string, name: string): string[][] {
  return [...sql.matchAll(new RegExp(`${name} text\\[\\] := array\\[([\\s\\S]*?)\\];`, "g"))].map((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]),
  );
}
function vocab(sql: string, name: string): string[] {
  const all = arraysOf(sql, name);
  assert.ok(all.length >= 1, `${name} array`);
  for (const a of all) assert.deepEqual(a, all[0], `${name}: 파일 내 선언 전부 동일(함수 = DO 블록)`);
  return all[0];
}

test("어휘 규모·길이·중복·문자 규칙(0129 = 현행 함수)", () => {
  const p = vocab(sql129, "prefixes"), m = vocab(sql129, "modifiers"), n = vocab(sql129, "nouns");
  assert.equal(arraysOf(sql129, "prefixes").length, 2, "함수 + DO 블록 두 벌");
  assert.equal(p.length, 20); assert.equal(m.length, 40); assert.equal(n.length, 50);
  const all = [...p, ...m, ...n];
  assert.equal(new Set(all).size, all.length, "중복 없음");
  for (const w of all) {
    assert.ok(w.length >= 2 && w.length <= 3, `${w}: 2~3자`);
    assert.doesNotMatch(w, /[0-9\s]/, `${w}: 숫자·공백 없음`);
    assert.match(w, /^[가-힣]+$/, `${w}: 한글`);
  }
  const maxLen = Math.max(...p.map((x) => x.length)) + Math.max(...m.map((x) => x.length)) + Math.max(...n.map((x) => x.length));
  assert.equal(maxLen, 9, "최장 조합 = 접두3 + 수식어3 + 명사3(공백 없음)");
  assert.equal(p.length * m.length * n.length, 40_000);
  // 공백 제거가 단사이려면 접두어끼리 접두 관계가 없어야 한다(예: '우리'+'팀…' 와 '우리팀'+'…' 충돌 방지)
  for (const a of p) for (const b of p) if (a !== b) assert.ok(!b.startsWith(a), `접두어 접두 관계 금지: ${a} ⊂ ${b}`);
  // 0128(백필 당시 어휘)과 동일 — 공백 제거 마이그의 정확 일치 패턴이 0128 생성분을 전부 덮는다
  assert.deepEqual(vocab(sql128, "prefixes"), p);
  assert.deepEqual(vocab(sql128, "modifiers"), m);
  assert.deepEqual(vocab(sql128, "nouns"), n);
});

test("함수 계약(0129): 공백 없는 3조각·30회 재추첨·활성 프로필 충돌 검사·ACL revoke", () => {
  const fn = sql129.slice(sql129.indexOf("create or replace function public.random_nickname()"), sql129.indexOf("revoke all on function"));
  assert.match(fn, /for i in 1 \.\. 30 loop/);
  assert.match(fn, /candidate := prefixes\[[^\]]+\]\s*\|\| modifiers\[[^\]]+\]\s*\|\| nouns\[[^\]]+\];/, "접두 || 수식어 || 명사 — 공백 리터럴 없음");
  assert.doesNotMatch(fn, /\|\| ' '/, "공백 리터럴 없음");
  assert.match(fn, /p\.display_name = candidate and p\.deleted_at is null/);
  assert.match(sql129, /revoke all on function public\.random_nickname\(\)\s+from public, anon, authenticated;/);
});

test("마이그(0129): 활성은 공백 제거(어휘 정확 일치)·충돌 시 재추첨·매핑 갱신, 삭제 익명은 가드 국소 해제(0108 방식) 후 공백 제거·구 패턴 재추첨", () => {
  const doBlock = sql129.slice(sql129.lastIndexOf("do $$"));
  assert.match(doBlock, /spaced_pattern := '\^\(' \|\| array_to_string\(prefixes, '\|'\) \|\| '\) \('\s*\|\| array_to_string\(modifiers, '\|'\) \|\| '\)\(' \|\| array_to_string\(nouns, '\|'\) \|\| '\)\$';/);
  assert.match(doBlock, /where deleted_at is null\s+and display_name ~ spaced_pattern/, "① 활성 프로필은 트리거 정상 상태에서");
  assert.match(doBlock, /n := replace\(r\.display_name, ' ', ''\);/);
  assert.match(doBlock, /p\.display_name = n and p\.deleted_at is null and p\.id <> r\.id/, "충돌 검사(자기 자신 제외)");
  assert.match(doBlock, /n := public\.random_nickname\(\);/, "충돌 시 재추첨");
  assert.match(doBlock, /on conflict \(profile_id\) do update set new_name = excluded\.new_name;/, "백필 행은 new_name 만 갱신(old_name 보존)");
  // ② 삭제 프로필: 0128 이 건너뛴 구 자동 패턴(접두어 15 + 4자리)과 공백 포함 생성명 — get_leaderboard 는 deleted_at 을 거르지 않는다
  const legacy129 = doBlock.match(/'\^\(([^)]*)\) \[0-9\]\{4\}\$'/);
  assert.ok(legacy129, "0129 legacy pattern");
  assert.equal(legacy129![1].split("|").length, 15);
  assert.match(doBlock, /where p\.deleted_at is not null\s+and \(p\.display_name ~ spaced_pattern or p\.display_name ~ legacy_pattern\)/);
  assert.match(doBlock, /not exists \(\s*select 1 from public\.member_accounts m where m\.user_id = p\.id\s*\)/, "회원 탈퇴자 제외(0108 과 동일)");
  // bp_reject_deleted_profile_update 가드 국소 해제는 삭제 루프 앞뒤로만(트랜잭션 로컬), 활성 루프는 가드·감사 트리거 정상
  const bypassOn = doBlock.indexOf("execute 'set local session_replication_role = replica'");
  const bypassOff = doBlock.indexOf("execute 'set local session_replication_role = origin'");
  const activeLoop = doBlock.indexOf("where deleted_at is null");
  const deletedLoop = doBlock.indexOf("where p.deleted_at is not null");
  assert.ok(activeLoop < bypassOn && bypassOn < deletedLoop && deletedLoop < bypassOff, "replica 구간 = 삭제 루프만");
});

test("백필 계약(0128): 구 접두어 15개 패턴·백업 테이블 RLS·revoke·profiles FK 없음", () => {
  const legacy = sql128.match(/'\^\(([^)]*)\) \[0-9\]\{4\}\$'/);
  assert.ok(legacy, "legacy pattern");
  assert.equal(legacy![1].split("|").length, 15);
  assert.match(sql128, /enable row level security/);
  assert.match(sql128, /revoke all on table public\.nickname_backfill_2026_09 from public, anon, authenticated;/);
  // 백업 테이블은 profiles 에 FK 를 걸지 않는다 — FK 는 profiles 쪽 내부 RI 트리거로 OAuth 릴레이션 지문
  // (scripts/qa/oauth-relation-fingerprints.mjs)·삭제 계보를 바꾼다(0128 주석). 순수 백업이므로 매핑만 보관.
  assert.match(sql128, /create table if not exists public\.nickname_backfill_2026_09 \(\n  profile_id uuid primary key,\n/);
  assert.doesNotMatch(sql128, /nickname_backfill_2026_09[\s\S]{0,400}references public\.profiles/);
});

test("커스텀 닉네임 상한 10자(랜덤 닉네임 최대 9자 ≤ 10)", () => {
  const profile = fs.readFileSync(path.resolve(process.cwd(), "lib/profile.ts"), "utf8");
  const oauth = fs.readFileSync(path.resolve(process.cwd(), "lib/oauth-metadata.ts"), "utf8");
  assert.match(profile, /const NICKNAME_MAX = 10;/);
  assert.match(oauth, /const NICKNAME_MAX = 10;/);
});
