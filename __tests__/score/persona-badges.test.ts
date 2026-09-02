import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { buildGameplayStats } = await import("../../lib/stats.ts");
const { PERSONA_DEFS, PERSONA_FALLBACK_ID, personaBadgeSlug } = await import("../../lib/persona.ts");
const { BADGE_CATALOG_DEFAULT, badgeCatalogSchema, evaluateBadges, knownSlugs } = await import(
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
