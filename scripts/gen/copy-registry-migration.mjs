#!/usr/bin/env node
/**
 * 고지 문구 변경용 registry seed 마이그레이션 생성기.
 *
 * 코드 상수(lib/pay/copy-registry.ts 의 activeCopyRegistryRows)가 문구의
 * 원본이고, DB 검증은 `commerce_copy_registry` 의 active 행과의 jsonb 등가다
 * (0105 계약). 문구를 바꾸면:
 *   1) lib/pay/display-evidence.ts · withdrawal-evidence.ts 상수 수정(새 copyVersion)
 *   2) `npm run gen:copy-registry-migration -- <버전번호>`  (예: 0106)
 *      → supabase/migrations/<버전>_copy_registry_update.sql 생성
 *      (구 active 행 deactivate + 새 행 insert(active))
 *   3) 계약 테스트(__tests__/payments/copy-registry-contract.test.ts)가
 *      마이그 누적 상태와 코드 상수의 정확 일치를 강제 — 상수만 바꾸고
 *      마이그레이션을 잊은 머지는 차단된다.
 *
 * seed 블록은 마커 주석 + $copyjson$ dollar-quote 의 canonical 형식만 사용한다
 * — 계약 테스트가 이 형식을 파싱한다.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDir = join(root, "supabase", "migrations");

export function renderSeedBlock(surface, copyVersion, copy, active) {
  const payload = JSON.stringify(copy);
  if (payload.includes("$copyjson$")) {
    throw new Error("copy payload may not contain the dollar-quote tag");
  }
  return `-- copy-registry-seed ${surface} ${copyVersion} active=${active ? "true" : "false"}
insert into public.commerce_copy_registry (surface, copy_version, copy, active)
values (
  '${surface}',
  '${copyVersion}',
  $copyjson$${payload}$copyjson$::jsonb,
  ${active ? "true" : "false"}
)
on conflict (surface, copy_version) do nothing;
`;
}

export function renderDeactivateBlock(surface, copyVersion) {
  return `-- copy-registry-deactivate ${surface} ${copyVersion}
update public.commerce_copy_registry
   set active = false
 where surface = '${surface}'
   and copy_version = '${copyVersion}'
   and active;
`;
}

/**
 * 현행(active) 등록분 — 문구 원본인 코드 상수에서 유도한다. 이 함수가
 * 상수→registry 행의 단일 유도 지점이다(offer 는 copyVersion/schemaVersion 을
 * 제외한 displayCopy 원문, withdrawal 은 statement 문자열).
 */
export async function loadActiveCopyRows() {
  const { CREDITS_OFFER_COPY } = await import(
    "../../lib/pay/display-evidence.ts"
  );
  const { CHECKOUT_WITHDRAWAL_CONFIRMATION } = await import(
    "../../lib/pay/withdrawal-evidence.ts"
  );
  const { copyVersion, schemaVersion, ...displayCopy } = CREDITS_OFFER_COPY;
  void schemaVersion;
  return [
    { surface: "credits_offer", copyVersion, copy: displayCopy },
    {
      surface: "checkout_withdrawal_limit",
      copyVersion: CHECKOUT_WITHDRAWAL_CONFIRMATION.copyVersion,
      copy: CHECKOUT_WITHDRAWAL_CONFIRMATION.statement,
    },
  ];
}

/**
 * 마이그레이션 디렉토리의 seed/deactivate 마커를 누적 재생해 registry 의
 * 최종 상태를 계산한다 — 계약 테스트와 이 생성기의 공용 단일 파서.
 */
export function replayRegistryState(dir) {
  const state = new Map(); // key: `${surface} ${version}` → {copy, active}
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    const blockRe =
      /-- copy-registry-(seed) (\S+) (\S+) active=(true|false)\n[^]*?\$copyjson\$([^]*?)\$copyjson\$::jsonb|-- copy-registry-(deactivate) (\S+) (\S+)/g;
    for (const m of sql.matchAll(blockRe)) {
      if (m[1] === "seed") {
        const [, , surface, version, active, payload] = m;
        const key = `${surface} ${version}`;
        if (!state.has(key)) {
          state.set(key, { copy: JSON.parse(payload), active: active === "true" });
        }
      } else {
        const surface = m[7];
        const version = m[8];
        const key = `${surface} ${version}`;
        const row = state.get(key);
        if (row) row.active = false;
      }
    }
  }
  return state;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const version = process.argv[2];
  if (!/^[0-9]{4,}$/.test(version ?? "")) {
    console.error("usage: gen:copy-registry-migration -- <migration-version e.g. 0106>");
    process.exit(2);
  }
  const rows = await loadActiveCopyRows();
  const state = replayRegistryState(migrationsDir);

  let out = `-- ${version}: 고지 문구 registry 갱신 — gen:copy-registry-migration 산출\n\nbegin;\n\n`;
  let changes = 0;
  for (const row of rows) {
    const key = `${row.surface} ${row.copyVersion}`;
    const existing = state.get(key);
    if (existing && existing.active) continue; // 이미 최신 — 변화 없음
    for (const [k, v] of state) {
      const [surface] = k.split(" ");
      if (surface === row.surface && v.active) {
        out += renderDeactivateBlock(surface, k.split(" ")[1]) + "\n";
      }
    }
    out += renderSeedBlock(row.surface, row.copyVersion, row.copy, true) + "\n";
    changes += 1;
  }
  if (changes === 0) {
    console.log("registry already matches the code constants — nothing to generate");
    process.exit(0);
  }
  out += "commit;\n";
  const file = join(migrationsDir, `${version}_copy_registry_update.sql`);
  if (existsSync(file)) {
    console.error(`refusing to overwrite existing migration: ${file}`);
    process.exit(1);
  }
  writeFileSync(file, out);
  console.log(`wrote ${file} (${changes} surface update${changes > 1 ? "s" : ""})`);
}
