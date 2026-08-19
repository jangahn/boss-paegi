#!/usr/bin/env node
/**
 * supabase/migrations/*.sql 의 `raise exception '<code>...'` 전수에서 런타임 오류
 * 코드를 추출해 lib/pay/db-raise-codes.gen.ts 스냅샷을 재생성한다.
 *
 * 추출 규칙 (error-catalog-contract 테스트와 동일해야 함):
 *  - 리터럴 raise 만 존재함이 전제(비-리터럴 raise 발견 시 실패) —
 *    비-리터럴이 생기면 이 스크립트와 계약 테스트의 규칙을 함께 확장할 것.
 *  - 첫 콜론/공백 전까지가 토큰. `^[a-z][a-z0-9_]*$` 만 런타임 코드로 인정
 *    (숫자 시작은 `0070 postflight:` 류 마이그레이션 적용 시점 어서션 — 제외).
 *
 * 새 raise 코드를 추가하면 이 스크립트를 재실행해 스냅샷을 갱신하거나(불변식
 * 위반 계열), 정상 거절이면 lib/pay/error-catalog.ts 에 등록해야 한다 — 계약
 * 테스트가 어느 쪽도 하지 않은 머지를 차단한다.
 *
 * 실행: npm run gen:db-raise-codes
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDir = join(root, "supabase", "migrations");

export function extractDbRaiseCodes(dir) {
  const codes = new Set();
  const nonLiteral = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, file), "utf8");
    for (const m of sql.matchAll(/raise exception\s+([^;]{1,200})/gi)) {
      const arg = m[1].trimStart();
      if (!arg.startsWith("'")) {
        nonLiteral.push(`${file}: raise exception ${arg.slice(0, 60)}`);
        continue;
      }
      const literal = /^'([^']*)'/.exec(arg);
      if (!literal) continue;
      const token = literal[1].split(/[: ]/, 1)[0];
      if (/^[a-z][a-z0-9_]*$/.test(token)) codes.add(token);
    }
  }
  return { codes: [...codes].sort(), nonLiteral };
}

export function renderDbRaiseCodesModule(codes) {
  return `// 자동 생성 — 수정 금지. 재생성: npm run gen:db-raise-codes
// 소스: supabase/migrations/*.sql 의 리터럴 raise exception 코드 전수
// (마이그레이션 적용 시점 어서션 — 숫자 시작 토큰 — 제외).
export const DB_RAISE_CODES: ReadonlySet<string> = new Set([
${codes.map((c) => `  "${c}",`).join("\n")}
]);
`;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const { codes, nonLiteral } = extractDbRaiseCodes(migrationsDir);
  if (nonLiteral.length > 0) {
    console.error("non-literal raise exception found — extend the extraction rule first:");
    for (const line of nonLiteral) console.error("  " + line);
    process.exit(1);
  }
  writeFileSync(
    join(root, "lib", "pay", "db-raise-codes.gen.ts"),
    renderDbRaiseCodesModule(codes),
  );
  console.log(`db-raise-codes.gen.ts: ${codes.length} codes`);
}
