// nickname-vocab.test.ts — 랜덤 닉네임 v2(0128) 어휘 계약: 접두 20·수식어 40·명사 50, 각 ≤3자, 숫자·공백·중복 없음, 최대 길이 10,
//   구 자동 패턴 15개 백필 대상, NICKNAME_MAX 10.  실행: node --test __tests__/account/nickname-vocab.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(path.resolve(process.cwd(), "supabase/migrations/0128_nickname_three_part.sql"), "utf8");
function arrayOf(name: string): string[] {
  const m = sql.match(new RegExp(`${name} text\\[\\] := array\\[([\\s\\S]*?)\\];`));
  assert.ok(m, `${name} array`);
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test("어휘 규모·길이·중복·문자 규칙", () => {
  const p = arrayOf("prefixes"), m = arrayOf("modifiers"), n = arrayOf("nouns");
  assert.equal(p.length, 20); assert.equal(m.length, 40); assert.equal(n.length, 50);
  const all = [...p, ...m, ...n];
  assert.equal(new Set(all).size, all.length, "중복 없음");
  for (const w of all) {
    assert.ok(w.length >= 2 && w.length <= 3, `${w}: 2~3자`);
    assert.doesNotMatch(w, /[0-9\s]/, `${w}: 숫자·공백 없음`);
    assert.match(w, /^[가-힣]+$/, `${w}: 한글`);
  }
  const maxLen = Math.max(...p.map((x) => x.length)) + 1 + Math.max(...m.map((x) => x.length)) + Math.max(...n.map((x) => x.length));
  assert.equal(maxLen, 10, "최장 조합 = 접두3 + 공백 + 수식어3 + 명사3");
  assert.equal(p.length * m.length * n.length, 40_000);
});

test("함수 계약: 30회 재추첨·활성 프로필 충돌 검사·ACL revoke·백필 패턴은 구 접두어 15개", () => {
  assert.match(sql, /for i in 1 \.\. 30 loop/);
  assert.match(sql, /p\.display_name = candidate and p\.deleted_at is null/);
  assert.match(sql, /revoke all on function public\.random_nickname\(\)\s+from public, anon, authenticated;/);
  const legacy = sql.match(/'\^\(([^)]*)\) \[0-9\]\{4\}\$'/);
  assert.ok(legacy, "legacy pattern");
  assert.equal(legacy![1].split("|").length, 15);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table public\.nickname_backfill_2026_09 from public, anon, authenticated;/);
});

test("커스텀 닉네임 상한 10자(랜덤 닉네임 최대 길이와 동일)", () => {
  const profile = fs.readFileSync(path.resolve(process.cwd(), "lib/profile.ts"), "utf8");
  const oauth = fs.readFileSync(path.resolve(process.cwd(), "lib/oauth-metadata.ts"), "utf8");
  assert.match(profile, /const NICKNAME_MAX = 10;/);
  assert.match(oauth, /const NICKNAME_MAX = 10;/);
});
