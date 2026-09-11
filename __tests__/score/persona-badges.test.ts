import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { buildGameplayStats } = await import("../../lib/stats.ts");
const { PERSONA_DEFS, PERSONA_FALLBACK_ID, personaBadgeSlug } = await import("../../lib/persona.ts");
const { BADGE_CATALOG_DEFAULT, CODE_RETIRED_BADGE_SLUGS, badgeCatalogSchema, evaluateBadges, knownSlugs } = await import(
  "../../lib/config/domains/badges.ts"
);

function statsFor(weaponCounts: Record<string, number>) {
  const hitCount = Object.values(weaponCounts).reduce((s, n) => s + n, 0);
  return buildGameplayStats({
    hitCount,
    maxCombo: 1,
    durationMs: 60_000,
    weaponCounts,
    weaponScores: Object.fromEntries(Object.keys(weaponCounts).map((k) => [k, 0])),
    ultScore: 0,
    ultimateCount: 0,
    firstHitMs: 0,
    bgVisits: [],
    intervalCV: null,
  });
}

test("디폴트 카탈로그: 유형 패밀리 + 유형 뱃지 1:1, 폴백만 비활성, 라벨은 유형 정의 미러", () => {
  const persona = BADGE_CATALOG_DEFAULT.badges.filter((b) => b.familyKey === "persona");
  assert.equal(persona.length, PERSONA_DEFS.length);
  for (const d of PERSONA_DEFS) {
    const b = persona.find((x) => x.slug === personaBadgeSlug(d.id));
    assert.ok(b, d.id);
    assert.equal(b!.label, `${d.emoji} ${d.label}`);
    assert.equal(b!.active, d.id !== PERSONA_FALLBACK_ID);
  }
  assert.ok(BADGE_CATALOG_DEFAULT.families.some((f) => f.key === "persona"));
  assert.ok(knownSlugs(BADGE_CATALOG_DEFAULT).has(personaBadgeSlug("pinch")));
});

test("구 카탈로그(7패밀리) 저장본을 읽으면 유형 패밀리가 편입되고 다른 편집은 보존된다", () => {
  const legacy = {
    families: BADGE_CATALOG_DEFAULT.families.filter((f) => f.key !== "persona").map((f) =>
      f.key === "combo" ? { ...f, name: "콤보(수정)" } : f,
    ),
    badges: BADGE_CATALOG_DEFAULT.badges
      .filter((b) => b.familyKey !== "persona")
      .map((b) => (b.slug === "combo_100" ? { ...b, active: false } : b)),
  };
  const parsed = badgeCatalogSchema.parse(legacy);
  assert.equal(parsed.families.length, 8);
  assert.equal(parsed.families.find((f) => f.key === "combo")?.name, "콤보(수정)");
  assert.equal(parsed.badges.find((b) => b.slug === "combo_100")?.active, false);
  const persona = parsed.badges.filter((b) => b.familyKey === "persona");
  assert.equal(persona.length, PERSONA_DEFS.length);
  assert.equal(persona.find((b) => b.slug === personaBadgeSlug(PERSONA_FALLBACK_ID))?.active, false);
});

test("유형 뱃지 저장값: active 만 존중, 라벨/미지 slug 는 코드 정의로 정규화", () => {
  const tampered = {
    ...BADGE_CATALOG_DEFAULT,
    badges: [
      ...BADGE_CATALOG_DEFAULT.badges.map((b) =>
        b.slug === personaBadgeSlug("pinch") ? { ...b, active: false, label: "임의 라벨" } : b,
      ),
      { slug: "persona_made_up", familyKey: "persona", threshold: 0, label: "x", desc: "y", active: true },
    ],
  };
  const parsed = badgeCatalogSchema.parse(tampered);
  const pinch = parsed.badges.find((b) => b.slug === personaBadgeSlug("pinch"));
  assert.equal(pinch?.active, false);
  assert.equal(pinch?.label, "🤌 볼따구 학대형");
  assert.ok(!parsed.badges.some((b) => b.slug === "persona_made_up"));
});

test("evaluateBadges: 이 판의 유형과 일치하는 활성 유형 뱃지 1개만 부여", () => {
  const earned = evaluateBadges(statsFor({ pinch: 6, fist: 4 }), 1000, BADGE_CATALOG_DEFAULT);
  const personaEarned = earned.filter((s) => s.startsWith("persona_"));
  assert.deepEqual(personaEarned, [personaBadgeSlug("pinch")]);
  // 폴백 유형은 디폴트 비활성이라 부여 없음
  const balanced = evaluateBadges(statsFor({ fist: 3, slap: 3, book: 3 }), 1000, BADGE_CATALOG_DEFAULT);
  assert.equal(balanced.filter((s) => s.startsWith("persona_")).length, 0);
  // 어드민이 폴백을 켜면 부여
  const enabled = badgeCatalogSchema.parse({
    ...BADGE_CATALOG_DEFAULT,
    badges: BADGE_CATALOG_DEFAULT.badges.map((b) =>
      b.slug === personaBadgeSlug(PERSONA_FALLBACK_ID) ? { ...b, active: true } : b,
    ),
  });
  assert.deepEqual(
    evaluateBadges(statsFor({ fist: 3, slap: 3, book: 3 }), 1000, enabled).filter((s) => s.startsWith("persona_")),
    [personaBadgeSlug(PERSONA_FALLBACK_ID)],
  );
});

test("v1.37 무기 tier: 저장 카탈로그에 없는 10·13·16·19 는 편입, weapon_9 는 v1.39 부터 은퇴 아님(저장 active 존중), 코드 은퇴 slug 없음", () => {
  const NEW = ["weapon_10", "weapon_13", "weapon_16", "weapon_19"];
  for (const slug of NEW) assert.equal(BADGE_CATALOG_DEFAULT.badges.find((b) => b.slug === slug)?.active, true, slug);
  assert.equal(BADGE_CATALOG_DEFAULT.badges.find((b) => b.slug === "weapon_9")?.active, true, "디폴트 weapon_9 활성");
  assert.equal(CODE_RETIRED_BADGE_SLUGS.size, 0, "v1.39: 코드 은퇴 slug 없음(어드민 활성 체크가 정본)");
  // 발행본(v1.36 이전): 무기 tier [2,4,6,8,9] 전부 활성, 유형 행 없음
  const stored = {
    families: BADGE_CATALOG_DEFAULT.families.filter((f) => f.key !== "persona"),
    badges: BADGE_CATALOG_DEFAULT.badges
      .filter((b) => b.familyKey !== "persona" && !NEW.includes(b.slug))
      .map((b) => (b.slug === "weapon_9" ? { ...b, active: true } : b.slug === "weapon_4" ? { ...b, active: false } : b)),
  };
  const parsed = badgeCatalogSchema.parse(stored);
  for (const slug of NEW) assert.equal(parsed.badges.find((b) => b.slug === slug)?.active, true, slug);
  assert.equal(parsed.badges.find((b) => b.slug === "weapon_9")?.active, true, "저장값(true) 존중 — 어드민이 켠 9종은 켜진다");
  assert.equal(parsed.badges.find((b) => b.slug === "weapon_4")?.active, false, "어드민이 끈 다른 tier 는 보존");
  const weaponSlugs = parsed.badges.filter((b) => b.familyKey === "weapon").map((b) => b.threshold);
  assert.deepEqual(weaponSlugs, [2, 4, 6, 8, 9, 10, 13, 16, 19], "저장 순서 뒤에 신규 tier 오름차순 편입");
  const weaponIdx = parsed.badges.flatMap((b, i) => (b.familyKey === "weapon" ? [i] : []));
  assert.equal(weaponIdx[weaponIdx.length - 1] - weaponIdx[0] + 1, weaponIdx.length, "편입 뒤에도 무기 행은 연속 블록");
  assert.equal(new Set(parsed.badges.map((b) => b.slug)).size, parsed.badges.length, "slug 중복 없음");
});

test("v1.38 편입 교정: 어드민이 뺀 시드 tier 는 되살리지 않고, 신설 tier 는 패밀리 블록 안 threshold 자리에 끼운다", async () => {
  const { CODE_ADDED_BADGE_SLUGS } = await import("../../lib/config/domains/badges.ts");
  assert.deepEqual([...CODE_ADDED_BADGE_SLUGS].sort(), ["weapon_10", "weapon_13", "weapon_16", "weapon_19"]);
  // 프로드 발행본(v5, 2026-06-24) 모양: 무기 3·6·9 만, 맵 2·4·6 만, 콤보 300 없음, 어드민 추가 행(combo_15000·ult_40)이 맨 뒤.
  const row = (familyKey: string, threshold: number, slug = `${familyKey}_${threshold}`) => ({
    slug,
    familyKey,
    threshold,
    label: slug,
    desc: slug,
    active: true,
  });
  const stored = {
    families: BADGE_CATALOG_DEFAULT.families.filter((f) => f.key !== "persona"),
    badges: [
      ...[100, 200, 500, 1000].map((t) => row("combo", t)),
      ...[3, 6, 9].map((t) => row("weapon", t)),
      ...[2, 4, 6].map((t) => row("map", t)),
      row("combo", 15000),
      row("ult", 40),
    ],
  };
  const parsed = badgeCatalogSchema.parse(stored);
  const thresholds = (fam: string) => parsed.badges.filter((b) => b.familyKey === fam).map((b) => b.threshold);
  assert.deepEqual(thresholds("map"), [2, 4, 6], "map_3·map_5 는 되살리지 않는다");
  assert.deepEqual(thresholds("combo"), [100, 200, 500, 1000, 15000], "combo_300 은 되살리지 않고 어드민 행 보존");
  assert.deepEqual(thresholds("ult"), [40], "ult 시드 tier 는 편입하지 않는다");
  assert.deepEqual(thresholds("weapon"), [3, 6, 9, 10, 13, 16, 19], "신설 4종은 threshold 순 자리(9 뒤)에 편입");
  assert.equal(parsed.badges.find((b) => b.slug === "weapon_9")?.active, true, "저장 active 존중");
  const weaponIdx = parsed.badges.flatMap((b, i) => (b.familyKey === "weapon" ? [i] : []));
  assert.deepEqual(weaponIdx, [4, 5, 6, 7, 8, 9, 10], "무기 행은 저장 블록 자리에 연속 — 맨 뒤(combo_15000·ult_40 뒤)에 붙지 않는다");
  const off = { ...stored, badges: stored.badges.map((b) => (b.slug === "weapon_9" ? { ...b, active: false } : b)) };
  assert.equal(badgeCatalogSchema.parse(off).badges.find((b) => b.slug === "weapon_9")?.active, false, "어드민이 끈 값도 그대로");
  // 저장 무기 순서가 커스텀(내림차순)이어도 편입은 threshold 가 더 낮은 마지막 행 뒤
  const custom = { ...stored, badges: [row("weapon", 8), row("weapon", 4), row("weapon", 2)] };
  assert.deepEqual(
    badgeCatalogSchema.parse(custom).badges.filter((b) => b.familyKey === "weapon").map((b) => b.threshold),
    [8, 4, 2, 10, 13, 16, 19]
  );
  // 저장본에 무기 행이 하나도 없으면 맨 끝에 붙는다
  const none = { ...stored, badges: [row("map", 2)] };
  assert.deepEqual(
    badgeCatalogSchema.parse(none).badges.filter((b) => b.familyKey !== "persona").map((b) => b.slug),
    ["map_2", "weapon_10", "weapon_13", "weapon_16", "weapon_19"]
  );
});
