import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { missingConsentItems } from "../../lib/consent.ts";
import { kstDateAt as appKstDateAt } from "../../lib/legal/kst-boundary.ts";
import { LEGAL_V1_PRODUCTION_SNAPSHOT } from "../../legal/v1-production-snapshot.mjs";
import { LEGAL_V2 } from "../../legal/v2-documents.mjs";
import {
  buildCancelSql,
  buildPublishSql,
  buildStageSql,
  cancelOperationIds,
  canonicalDigest,
  documentsMatch,
  expectedStrictRpcSourceHashes,
  kstDateAt,
  noticeCalendarDays,
  parseLegalV2Args,
  planCancel,
  planPublish,
  planStage,
  runLegalV2Rollout,
  stableStringify,
  validateFutureEffectiveDate,
  validateFullNoticePeriod,
  validateLegalV2Source,
  validateNoticePeriod,
} from "../../scripts/qa/legal-v2-rollout.mjs";

function text(docType: "privacy" | "terms"): string {
  return LEGAL_V2.documents[docType].sections
    .map((section) => `${section.heading}\n${section.body}`)
    .join("\n\n");
}

const privacy = text("privacy");
const terms = text("terms");

test("legal v2 canonical source satisfies the exact DB payload limits", () => {
  assert.equal(validateLegalV2Source(), LEGAL_V2);
  assert.equal(LEGAL_V2.expectedPreviousVersion, 1);
  assert.equal(LEGAL_V2.targetVersion, 2);
  assert.deepEqual(Object.keys(LEGAL_V2.documents).sort(), [
    "privacy",
    "terms",
  ]);

  for (const [docType, document] of Object.entries(LEGAL_V2.documents)) {
    assert.ok(document.title.length >= 1 && document.title.length <= 200);
    assert.ok(document.publicNote.length <= 1_000);
    assert.ok(document.adminNote.length <= 2_000);
    assert.ok(document.sections.length >= 1 && document.sections.length <= 50);
    assert.ok(
      Buffer.byteLength(JSON.stringify(document.sections), "utf8") <= 200_000,
    );
    const headings = new Set<string>();
    for (const section of document.sections) {
      assert.ok(section.heading.length >= 1 && section.heading.length <= 120);
      assert.ok(section.body.length >= 1 && section.body.length <= 20_000);
      assert.equal(headings.has(section.heading), false, `${docType} duplicate`);
      headings.add(section.heading);
    }
  }
  assert.match(canonicalDigest(), /^[0-9a-f]{64}$/);
  assert.equal(canonicalDigest(), canonicalDigest(LEGAL_V2));
});

test("privacy v2 states the real auth-cookie, quota, analytics, and Sentry boundaries", () => {
  for (const required of [
    /HttpOnly가 아닙니다\(HttpOnly=false\)/,
    /Secure=true/,
    /SameSite=Lax/,
    /복원할 수 없는 64자리 HMAC/,
    /최근 3개 KST 달력일/,
    /자사 분석 기능이 있으나[\s\S]*운영 환경에서는 비활성화/,
    /원시 분석 이벤트는 90일/,
    /리플레이는 현재 기본 비활성/,
    /별도 운영 opt-in/,
    /오류가 난 세션 100%/,
    /그 밖의 세션 10%/,
    /maskAllText=false/,
    /blockAllMedia=false/,
    /maskAllInputs=false/,
    /\.sentry-block-face/,
    /sendDefaultPii=false/,
    /현재 요금제 기준 최대 30일/,
  ]) {
    assert.match(privacy, required);
  }
  assert.doesNotMatch(privacy, /인증 토큰을 HTTPOnly 쿠키로 저장/);
  assert.doesNotMatch(privacy, /일반 세션 20%/);
  assert.doesNotMatch(privacy, /페이앱|payapp|linkval/i);
});

test("privacy v2 distinguishes fal payload controls, media retention, and Usage Data", () => {
  for (const required of [
    /10분 서명 URL/,
    /8분 안에 시작/,
    /12분 경과 후 정기 정리/,
    /X-Fal-Store-IO: 0/,
    /현재 전송·생성하지 않습니다/,
    /기본적으로 공개 접근될 수 있고/,
    /private ACL 값과 5분 owner-token 읽기 계약/,
    /서면 확인·DPA/,
    /미선택 생성 후보[\s\S]*24시간/,
    /자체 AI 모델의 사전학습·미세조정에 사용하지 않습니다/,
    /Customer Input에서 유래할 수 있는 비식별·집계 Usage Data/,
    /Usage Data의 생성·이용 가능성까지 배제하는 별도 opt-out 약정은 아닙니다/,
    /외부 AI 처리를 원하지 않으면/,
    /부적절하거나 권리를 침해하는 결과/,
    /이의를 제기/,
  ]) {
    assert.match(privacy, required);
  }
  assert.doesNotMatch(
    privacy,
    /fal\.ai가[^.\n]*(입력물|사진|프롬프트|생성 결과)[^.\n]*학습에 사용하지/,
  );
  assert.doesNotMatch(
    privacy,
    /요청별 비공개 ACL과 최대 6시간 만료를 설정합니다/,
  );
});

test("privacy v2 encodes every implemented retention and deletion boundary", () => {
  for (const required of [
    /하이라이트 클립[\s\S]*30일 TTL/,
    /회원의 상세 타임라인은 30일/,
    /익명 세션 원본은 30일/,
    /결제·환불 상세[\s\S]*최소 5년/,
    /회당 최대 100건/,
    /최초 종결 시각은 변경하지 않고/,
    /정확히 3년인 시점까지 보존/,
    /3년을 초과하면/,
    /external_consumer_complaint_manual_retention_runbook/,
    /접근이 제한된 민원 대장/,
    /legal hold/,
    /처리 월·건수와 대장 상태의 해시/,
    /최소 2시간 5분/,
    /재활성화할 수 있으나/,
    /캐릭터·하이라이트·생성권·원본 이미지는 복구하지 않습니다/,
  ]) {
    assert.match(privacy, required);
  }
});

test("privacy v2 refuses to invent unresolved overseas-transfer facts", () => {
  for (const required of [
    /제28조의8 제1항 제3호/,
    /Supabase Inc\./,
    /싱가포르\(ap-southeast-1 운영 리전\)/,
    /Features & Labels Inc\.\(fal\.ai\)/,
    /현재 이전·생성 비활성/,
    /정확한 하위처리자별 국가와 보유기간을 확정하지 않습니다/,
    /서면 계약·DPA/,
    /사전고지·재동의/,
    /Functional Software, Inc\.\(Sentry\)/,
    /미국\(운영 조직 ingest 리전\)/,
    /Vercel Inc\./,
    /주 서버 실행 리전은 싱가포르\(sin1\)/,
    /실제 처리 국가·로그 보유기간 전체를 이 사실 하나로 확정할 수 없습니다/,
    /Google LLC/,
    /정확한 국가·하위처리자·항목별 보유기간을 확정하지 않습니다/,
    /국외 이전 거부/,
  ]) {
    assert.match(privacy, required);
  }
  assert.doesNotMatch(privacy, /fal\.ai[\s\S]{0,120}국가: 미국/);
});

test("terms v2 preserves every v1 paid-credit and consumer refund right", () => {
  const article10 = LEGAL_V2.documents.terms.sections.filter((section) =>
    section.heading.startsWith("제10조"),
  );
  assert.equal(article10.length, 1);
  const refund = article10[0]!.body;
  for (const required of [
    /유효기간은 구매일 또는 지급일로부터 1년/,
    /사용하지 않은 유료 생성권에 대해 유효기간 내 언제든 환불/,
    /결제일부터 7일 이내[\s\S]*100%/,
    /7일이 지난 뒤[\s\S]*90%/,
    /10%를 환불 수수료/,
    /이미 캐릭터 생성에 사용한 생성권[\s\S]*환불 대상이 아닙니다/,
    /대가 없이 받은 무상 생성권은 환불·환급 대상이 아닙니다/,
    /구매일부터 5년까지[\s\S]*90%/,
    /반드시 탈퇴 전에/,
    /3영업일 이내/,
    /원 결제수단/,
    /포인트 등 다른 수단으로 대신하지 않습니다/,
    /정당한 청약철회·환불 권리 행사를 남용으로 간주하지 않습니다/,
    /법정 권리/,
  ]) {
    assert.match(refund, required);
  }
});

test("terms v2 truthfully describes checkout evidence and freezes fal generation", () => {
  assert.match(
    terms,
    /실제 결제 제공 여부와 일반 또는 TEST 결제 여부는 운영 게이트와 이용 시점의 구매 화면/,
  );
  assert.match(
    terms,
    /결제 전에 이 제한을 다른 동의와 분리하여 명확히 표시하고 이용자의 적극적 확인/,
  );
  assert.match(
    terms,
    /적극적 확인이나 증거의 원자 저장·사후 검증 중 하나라도 실패하면 결제창을 열지 않습니다/,
  );
  assert.match(terms, /AI 생성은[\s\S]*대한민국 기준 만 19세 이상/);
  assert.match(terms, /fal\.ai 이용약관과 Acceptable Use Policy/);
  assert.match(terms, /정확한 이전 국가·기간과 얼굴 처리 허용에 대한 서면 확인 전에는 이 기능을 제공하지 않습니다/);
  assert.match(terms, /기존 구매와 이미 지급된 유료 생성권에 그대로 적용/);
});

test("v1 production snapshot pins notice and paid-credit rights semantically", () => {
  assert.equal(LEGAL_V1_PRODUCTION_SNAPSHOT.effectiveDate, "2026-06-26");
  assert.deepEqual(
    {
      privacy: LEGAL_V1_PRODUCTION_SNAPSHOT.documents.privacy,
      terms: LEGAL_V1_PRODUCTION_SNAPSHOT.documents.terms,
    },
    {
      privacy: {
        version: 1,
        sectionCount: 15,
        normalizedSha256:
          "eecab8d2fe83b8fa6cc194e2528b30b86680a34a4d42b80773bcfb20a865791b",
        postgresJsonbSha256:
          "c69b79fa0fbe3173e399842c6fb46122dc0dea8a91da0cc6919250fb02734794",
      },
      terms: {
        version: 1,
        sectionCount: 16,
        normalizedSha256:
          "981ae13bdf38e8f3889184584d1bdf8bd1d9a131ea78351279b54aded473b7ed",
        postgresJsonbSha256:
          "dba1a9a2b0af31a7eb885c8e901f30dbd7fb8c8397a951505e09564a1c97c61c",
      },
    },
  );
  assert.deepEqual(LEGAL_V1_PRODUCTION_SNAPSHOT.noticeRights, {
    ordinaryMinimumKstCalendarDays: 7,
    adverseOrMaterialMinimumKstCalendarDays: 30,
  });
  assert.deepEqual(LEGAL_V1_PRODUCTION_SNAPSHOT.paidCreditRights, {
    validity: "1_year_from_purchase_or_grant",
    unusedWithinValidity: "refundable_at_any_time",
    withinSevenDays: "100_percent_of_unused_unit_value",
    afterSevenDays: "90_percent_of_unused_unit_value",
    usedCredits: "not_refundable",
    freeCredits: "not_refundable",
    expiredPaidCredits:
      "90_percent_refundable_until_five_years_from_purchase",
    withdrawalFence: "request_before_account_withdrawal",
    paymentDeadline: "within_3_business_days_after_valid_request_verified",
    paymentMethod: "original_payment_method",
    substitutePointsWithoutConsent: false,
    minorStatutoryCancellationRightsPreserved: true,
  });
});

test("material/adverse v2 requires 30 complete KST calendar days", () => {
  assert.equal(LEGAL_V2.rollout.classification, "material_adverse");
  assert.equal(LEGAL_V2.rollout.minimumNoticeKstCalendarDays, 30);
  assert.ok(LEGAL_V2.rollout.publicationBlockers.length >= 1);
  assert.equal(noticeCalendarDays("2026-08-28", "2026-07-30"), 29);
  assert.equal(noticeCalendarDays("2026-08-29", "2026-07-30"), 30);
  assert.equal(validateNoticePeriod("2026-08-28", "2026-07-30"), false);
  assert.equal(validateNoticePeriod("2026-08-29", "2026-07-30"), true);
  assert.equal(validateNoticePeriod("2028-03-01", "2028-01-31"), true);
  assert.equal(validateNoticePeriod("2028-02-29", "2028-01-31"), false);

  const effectiveMidnight = Date.parse("2026-08-30T00:00:00+09:00");
  const exactNotice = effectiveMidnight - 30 * 86_400_000;
  assert.equal(
    validateFullNoticePeriod("2026-08-30", exactNotice - 1),
    true,
  );
  assert.equal(
    validateFullNoticePeriod("2026-08-30", exactNotice),
    true,
  );
  assert.equal(
    validateFullNoticePeriod("2026-08-30", exactNotice + 1),
    false,
  );
  const leapEffective = Date.parse("2028-03-01T00:00:00+09:00");
  assert.equal(
    validateFullNoticePeriod(
      "2028-03-01",
      leapEffective - 30 * 86_400_000,
    ),
    true,
  );

  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/008905_legal_commerce_generation_compliance.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /new\.version >= 2/);
  assert.match(
    migration,
    /tg_op = 'INSERT'[\s\S]*tg_op = 'UPDATE'[\s\S]*old\.sections is distinct from new\.sections/,
  );
  assert.doesNotMatch(migration, /new\.version = 2/);
});

test("publication blockers explicitly freeze every unresolved external contract", () => {
  assert.deepEqual(LEGAL_V2.rollout.publicationBlockers, [
    "fal_exact_subprocessor_country_retention_inventory",
    "fal_written_face_pii_dpa_confirmation",
    "fal_private_acl_owner_token_contract",
    "vercel_exact_transfer_country_retention_inventory",
    "google_oauth_exact_transfer_country_retention_inventory",
  ]);
});

test("v1 stamps require both v2 consents exactly at KST activation", () => {
  const activeMember = {
    age_confirmed_at: "2026-06-26T00:00:00.000Z",
    terms_version: 1,
    privacy_version: 1,
  };
  assert.deepEqual(
    missingConsentItems(activeMember, { terms: 1, privacy: 1 }),
    [],
  );
  assert.deepEqual(
    missingConsentItems(activeMember, { terms: 2, privacy: 2 }),
    ["terms", "privacy"],
  );
  assert.deepEqual(
    missingConsentItems(
      { ...activeMember, terms_version: 2, privacy_version: 2 },
      { terms: 2, privacy: 2 },
    ),
    [],
  );
  assert.deepEqual(
    missingConsentItems(
      { ...activeMember, terms_version: 3, privacy_version: 3 },
      { terms: 2, privacy: 2 },
    ),
    [],
  );
  assert.deepEqual(
    missingConsentItems(activeMember, { terms: null, privacy: null }),
    [],
  );

  const effectiveDate = "2026-08-01";
  const versionsAt = (instant: string) =>
    appKstDateAt(instant) >= effectiveDate
      ? { terms: 2, privacy: 2 }
      : { terms: 1, privacy: 1 };
  assert.equal(appKstDateAt("2026-07-31T14:59:59.999Z"), "2026-07-31");
  assert.equal(appKstDateAt("2026-07-31T15:00:00.000Z"), "2026-08-01");
  assert.deepEqual(
    missingConsentItems(activeMember, versionsAt("2026-07-31T14:59:59.999Z")),
    [],
  );
  assert.deepEqual(
    missingConsentItems(activeMember, versionsAt("2026-07-31T15:00:00.000Z")),
    ["terms", "privacy"],
  );
  assert.equal(kstDateAt("2026-07-31T15:00:00.000Z"), "2026-08-01");
});

test("rollout CLI is read-only by default and mutations require exact confirmations", () => {
  assert.deepEqual(parseLegalV2Args([]), {
    ok: true,
    value: {
      mode: "dry-run",
      apply: false,
      confirm: null,
      effectiveDate: null,
      adminEmail: "emfoa23@gmail.com",
      replaceExistingDraft: false,
    },
  });
  assert.deepEqual(parseLegalV2Args(["--mode", "stage"]), {
    ok: false,
    reason: "apply_required",
  });
  assert.deepEqual(
    parseLegalV2Args([
      "--mode",
      "stage",
      "--apply",
      "--confirm",
      "STAGE-BOSS-PAEGI-LEGAL-V2",
    ]).ok,
    true,
  );
  assert.deepEqual(
    parseLegalV2Args([
      "--mode",
      "stage",
      "--apply",
      "--replace-existing-draft",
      "--confirm",
      "STAGE-BOSS-PAEGI-LEGAL-V2",
    ]),
    { ok: false, reason: "stage_confirmation_mismatch" },
  );
  assert.equal(
    parseLegalV2Args([
      "--mode",
      "stage",
      "--apply",
      "--replace-existing-draft",
      "--confirm",
      "REPLACE-DRAFT-AND-STAGE-BOSS-PAEGI-LEGAL-V2",
    ]).ok,
    true,
  );
  assert.equal(
    parseLegalV2Args([
      "--mode",
      "cancel",
      "--apply",
      "--effective-date",
      "2026-08-29",
      "--confirm",
      "CANCEL-BOSS-PAEGI-LEGAL-V2",
    ]).ok,
    true,
  );
  assert.deepEqual(
    parseLegalV2Args([
      "--mode",
      "cancel",
      "--apply",
      "--effective-date",
      "2026-08-29",
      "--confirm",
      "wrong",
    ]),
    { ok: false, reason: "cancel_confirmation_mismatch" },
  );
  assert.deepEqual(
    parseLegalV2Args([
      "--mode",
      "publish",
      "--apply",
      "--effective-date",
      "2026-08-01",
      "--confirm",
      "wrong",
    ]),
    { ok: false, reason: "publish_confirmation_mismatch" },
  );
  assert.equal(
    parseLegalV2Args([
      "--mode",
      "publish",
      "--apply",
      "--effective-date",
      "2026-08-01",
      "--confirm",
      "PUBLISH-BOSS-PAEGI-LEGAL-V2",
    ]).ok,
    true,
  );
  assert.equal(
    validateFutureEffectiveDate("2026-08-01", "2026-07-31"),
    true,
  );
  assert.equal(
    validateFutureEffectiveDate("2026-07-31", "2026-07-31"),
    false,
  );
});

test("canonical comparisons ignore JSON object key order but not legal text", () => {
  const document = LEGAL_V2.documents.privacy;
  const row = {
    title: document.title,
    sections: document.sections.map(({ heading, body }) => ({ body, heading })),
    public_note: document.publicNote,
    admin_note: document.adminNote,
  };
  assert.equal(documentsMatch(row, document), true);
  assert.equal(
    documentsMatch(row, document, { includeAdminNote: true }),
    true,
  );
  assert.equal(
    documentsMatch({ ...row, public_note: `${document.publicNote}!` }, document),
    false,
  );
  assert.equal(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

function pendingInspection() {
  return Object.fromEntries(
    (["privacy", "terms"] as const).map((docType, index) => {
      const document = LEGAL_V2.documents[docType];
      const draft = {
        id:
          index === 0
            ? "11111111-1111-4111-8111-111111111111"
            : "22222222-2222-4222-8222-222222222222",
        doc_type: docType,
        status: "draft",
        version: 0,
        effective_date: null,
        title: document.title,
        sections: document.sections,
        public_note: document.publicNote,
        admin_note: document.adminNote,
        updated_at: `2026-07-30T00:00:0${index}.123456+00:00`,
      };
      return [
        docType,
        {
          docType,
          document,
          draft,
          latest: {
            version: 1,
            effective_date: "2026-06-26",
          },
          target: null,
          done: false,
        },
      ];
    }),
  );
}

test("stage and publish SQL use strict CAS RPCs in one atomic statement", () => {
  const inspected = pendingInspection();
  const unstaged = Object.fromEntries(
    Object.entries(inspected).map(([docType, item]) => [
      docType,
      { ...item, draft: null },
    ]),
  );
  const stageItems = planStage(unstaged);
  const publishItems = planPublish(
    inspected,
    "2026-08-30",
    "2026-07-30",
    {
      publicationBlockers: [],
      noticeInstant: new Date("2026-07-30T23:59:59.999+09:00"),
    },
  );
  assert.deepEqual(
    stageItems.map((item) => item.docType),
    ["privacy", "terms"],
  );
  assert.deepEqual(
    publishItems.map((item) => item.docType),
    ["privacy", "terms"],
  );

  const stageSql = buildStageSql(stageItems, "emfoa23@gmail.com");
  const stageSqlAgain = buildStageSql(stageItems, "emfoa23@gmail.com");
  assert.equal(stageSql, stageSqlAgain, "response-loss retry IDs must be stable");
  assert.match(stageSql, /^with admin as/);
  assert.match(stageSql, /public\.admin_save_legal_draft\(/g);
  assert.match(stageSql, /admin cross join op_0/);
  assert.match(stageSql, /::timestamptz/);
  assert.equal((stageSql.match(/public\.admin_save_legal_draft\(/g) ?? []).length, 2);

  const publishSql = buildPublishSql(
    publishItems,
    "emfoa23@gmail.com",
    "2026-08-30",
  );
  assert.match(publishSql, /^with admin as/);
  assert.match(publishSql, /public\.admin_publish_legal\(/g);
  assert.match(publishSql, /admin cross join op_0/);
  assert.match(publishSql, /'2026-08-30'::date/);
  assert.equal((publishSql.match(/public\.admin_publish_legal\(/g) ?? []).length, 2);
  assert.equal((publishSql.match(/[0-9a-f-]{36}'::uuid/g) ?? []).length, 4);
  assert.doesNotMatch(stageSql, /\bcommit\b|\bbegin\b/i);
  assert.doesNotMatch(publishSql, /\bcommit\b|\bbegin\b/i);
});

test("future v2 cancellation is one atomic privacy+terms unpublish statement", () => {
  const inspected = Object.fromEntries(
    Object.entries(pendingInspection()).map(([docType, item], index) => {
      const target = {
        ...item.draft,
        id:
          index === 0
            ? "30000000-0000-4000-8000-000000000003"
            : "40000000-0000-4000-8000-000000000003",
        status: "published",
        version: 2,
        effective_date: "2026-08-29",
      };
      return [
        docType,
        {
          ...item,
          draft: null,
          latest: target,
          target,
          done: true,
        },
      ];
    }),
  );
  const items = planCancel(
    inspected,
    "2026-08-29",
    "2026-07-30",
  );
  assert.deepEqual(
    items.map((item) => item.docType),
    ["privacy", "terms"],
  );
  const sql = buildCancelSql(
    items,
    "emfoa23@gmail.com",
    "2026-08-29",
  );
  assert.equal(
    (sql.match(/public\.admin_unpublish_legal\(/g) ?? []).length,
    2,
  );
  assert.match(sql, /^with admin as/);
  assert.match(sql, /admin cross join op_0/);
  assert.doesNotMatch(sql, /\bcommit\b|\bbegin\b/i);
  assert.deepEqual(
    cancelOperationIds("emfoa23@gmail.com", "2026-08-29"),
    cancelOperationIds("emfoa23@gmail.com", "2026-08-29"),
  );
  assert.throws(
    () => buildCancelSql(items.slice(0, 1), "emfoa23@gmail.com", "2026-08-29"),
    /cancel_requires_both_documents/,
  );
});

test("rollout helper never prints or embeds credential values in result paths", () => {
  const source = readFileSync(
    new URL("../../scripts/qa/legal-v2-rollout.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /BOSS_PAEGI_SUPABASE_ACCESS_TOKEN/);
  assert.match(source, /mode: "dry-run"/);
  assert.match(source, /mutated: false/);
  assert.doesNotMatch(
    source,
    /console\.log\([\s\S]*token|stdout[\s\S]*management\.token/i,
  );
  assert.doesNotMatch(source, /process\.stdout[\s\S]*management\.ref/i);
  assert.match(source, /production_target_fingerprint_mismatch/);
  assert.match(source, /strict_legal_rpc_ready/);
});

function productionFingerprint() {
  const hashes = expectedStrictRpcSourceHashes();
  const contract = (slot: "save" | "publish" | "unpublish") => ({
    exists: true,
    owner: "postgres",
    security_definer: true,
    empty_search_path: true,
    source_sha256: hashes[slot],
    service_execute: true,
    anon_execute: false,
    authenticated_execute: false,
    public_execute: false,
  });
  return [
    {
      strict_legal_rpc_ready: true,
      strict_rpc_contracts: {
        save: contract("save"),
        publish: contract("publish"),
        unpublish: contract("unpublish"),
      },
      migration_versions: [
        "0081_legal_state_machine_idempotency",
        "008904_privacy_retention_controls",
        "008905_legal_commerce_generation_compliance",
      ],
      admin_count: 1,
      admin_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      business_info: {
        info: {
          companyName: "제이엔에이",
          ownerName: "안병욱",
          bizRegNo: "220-11-70445",
        },
      },
    },
  ];
}

type LegalTestRow = {
  id: string;
  doc_type: "privacy" | "terms";
  status: "draft" | "published";
  version: number;
  effective_date: string | null;
  title: string;
  sections: readonly Readonly<{ heading: string; body: string }>[];
  public_note: string;
  admin_note: string;
  updated_at: string;
  normalized_v1_sha256: string | null;
};

function legalRows({
  drafts = false,
  publishedV2 = false,
  effectiveDate = "2026-08-01",
}: {
  drafts?: boolean;
  publishedV2?: boolean;
  effectiveDate?: string;
} = {}) {
  return (["privacy", "terms"] as const).flatMap((docType, index) => {
    const document = LEGAL_V2.documents[docType];
    const snapshot = LEGAL_V1_PRODUCTION_SNAPSHOT.documents[docType];
    const rows: LegalTestRow[] = [
      {
        id:
          index === 0
            ? "10000000-0000-4000-8000-000000000001"
            : "20000000-0000-4000-8000-000000000001",
        doc_type: docType,
        status: "published",
        version: 1,
        effective_date: "2026-06-26",
        title: document.title,
        sections: Array.from({ length: snapshot.sectionCount }, (_, item) => ({
          heading: `old-${item}`,
          body: `old-${item}`,
        })),
        public_note: "old",
        admin_note: "old",
        updated_at: "2026-06-26T00:00:00.000000+00:00",
        normalized_v1_sha256: snapshot.postgresJsonbSha256,
      },
    ];
    if (drafts) {
      rows.push({
        id:
          index === 0
            ? "10000000-0000-4000-8000-000000000002"
            : "20000000-0000-4000-8000-000000000002",
        doc_type: docType,
        status: "draft",
        version: 0,
        effective_date: null,
        title: document.title,
        sections: document.sections,
        public_note: document.publicNote,
        admin_note: document.adminNote,
        updated_at: `2026-07-30T00:00:0${index}.123456+00:00`,
        normalized_v1_sha256: null,
      });
    }
    if (publishedV2) {
      rows.push({
        id:
          index === 0
            ? "10000000-0000-4000-8000-000000000003"
            : "20000000-0000-4000-8000-000000000003",
        doc_type: docType,
        status: "published",
        version: 2,
        effective_date: effectiveDate,
        title: document.title,
        sections: document.sections,
        public_note: document.publicNote,
        admin_note: document.adminNote,
        updated_at: "2026-07-30T01:00:00.123456+00:00",
        normalized_v1_sha256: null,
      });
    }
    return rows;
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const fakeManagementEnv = {
  NODE_ENV: "test" as const,
  BOSS_PAEGI_SUPABASE_ACCESS_TOKEN: "secret-must-never-appear",
  BOSS_PAEGI_SUPABASE_PROJECT_REF: "jxnzolkmeqjvrnzikcmb",
};

test("full dry-run orchestration performs production reads and zero mutations", async () => {
  const queries: string[] = [];
  const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    queries.push(body.query);
    if (body.query.includes("strict_legal_rpc_ready")) {
      return jsonResponse(productionFingerprint());
    }
    if (body.query.includes("from public.legal_documents")) {
      return jsonResponse(legalRows());
    }
    if (body.query.includes("from public.legal_operation_receipts")) {
      return jsonResponse([]);
    }
    throw new Error("unexpected_mutation");
  }) as typeof fetch;
  const rawResult = await runLegalV2Rollout({
    argv: ["--mode", "dry-run", "--effective-date", "2026-08-29"],
    env: fakeManagementEnv,
    fetchImpl,
    now: new Date("2026-07-30T00:00:00.000Z"),
  });
  const result = rawResult as unknown as {
    ok: true;
    mode: "dry-run";
    mutated: false;
    plan: {
      stage: { ready: boolean; mutationsRequired: string[] };
      publish: { ready: boolean; blocker: string };
    };
  };
  assert.equal(result.ok, true);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.mutated, false);
  assert.deepEqual(result.plan.stage, {
    ready: true,
    mutationsRequired: ["privacy", "terms"],
  });
  assert.deepEqual(result.plan.publish, {
    ready: false,
    blocker: "publication_blockers_unresolved",
  });
  assert.equal(queries.length, 3);
  assert.equal(
    queries.some((query) => /^with admin as/.test(query.trim())),
    false,
  );
  assert.doesNotMatch(JSON.stringify(result), /secret-must-never-appear/);
});

test("full stage orchestration atomically writes both drafts and verifies them", async () => {
  const queries: string[] = [];
  let staged = false;
  const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    const query = body.query;
    queries.push(query);
    if (/^with admin as/.test(query.trim())) {
      assert.equal(
        (query.match(/public\.admin_save_legal_draft\(/g) ?? []).length,
        2,
      );
      staged = true;
      return jsonResponse([
        {
          result: {
            privacy: {
              ok: true,
              draft_id: "10000000-0000-4000-8000-000000000002",
              draft_updated_at: "2026-07-30T00:00:00.123456+00:00",
            },
            terms: {
              ok: true,
              draft_id: "20000000-0000-4000-8000-000000000002",
              draft_updated_at: "2026-07-30T00:00:01.123456+00:00",
            },
          },
        },
      ]);
    }
    if (query.includes("strict_legal_rpc_ready")) {
      return jsonResponse(productionFingerprint());
    }
    if (query.includes("from public.legal_documents")) {
      return jsonResponse(legalRows({ drafts: staged }));
    }
    throw new Error("unexpected_query");
  }) as typeof fetch;
  const rawResult = await runLegalV2Rollout({
    argv: [
      "--mode",
      "stage",
      "--apply",
      "--confirm",
      "STAGE-BOSS-PAEGI-LEGAL-V2",
    ],
    env: fakeManagementEnv,
    fetchImpl,
    now: new Date("2026-07-30T00:00:00.000Z"),
  });
  const result = rawResult as unknown as {
    ok: true;
    mode: "stage";
    mutated: boolean;
    documents: Record<
      "privacy" | "terms",
      { draft: "none" | "canonical" | "different" }
    >;
  };
  assert.equal(result.ok, true);
  assert.equal(result.mode, "stage");
  assert.equal(result.mutated, true);
  assert.equal(result.documents.privacy.draft, "canonical");
  assert.equal(result.documents.terms.draft, "canonical");
  assert.equal(
    queries.filter((query) => /^with admin as/.test(query.trim())).length,
    1,
  );
});

test("full publish orchestration cannot mutate while any legal blocker remains", async () => {
  const queries: string[] = [];
  const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    const query = body.query;
    queries.push(query);
    if (/^with admin as/.test(query.trim())) {
      throw new Error("unexpected_mutation");
    }
    if (query.includes("strict_legal_rpc_ready")) {
      return jsonResponse(productionFingerprint());
    }
    if (query.includes("from public.legal_documents")) {
      return jsonResponse(legalRows({ drafts: true }));
    }
    throw new Error("unexpected_query");
  }) as typeof fetch;
  await assert.rejects(
    runLegalV2Rollout({
      argv: [
        "--mode",
        "publish",
        "--apply",
        "--effective-date",
        "2026-08-29",
        "--confirm",
        "PUBLISH-BOSS-PAEGI-LEGAL-V2",
      ],
      env: fakeManagementEnv,
      fetchImpl,
      now: new Date("2026-07-30T00:00:00.000Z"),
    }),
    /publication_blockers_unresolved/,
  );
  assert.equal(
    queries.filter((query) => /^with admin as/.test(query.trim())).length,
    0,
  );
});

test("full cancellation recovers both documents and verifies durable receipts", async () => {
  const queries: string[] = [];
  const effectiveDate = "2026-08-29";
  const adminEmail = "emfoa23@gmail.com";
  const operationIds = cancelOperationIds(adminEmail, effectiveDate);
  let canceled = false;
  const receipts = () =>
    (["privacy", "terms"] as const).map((docType, index) => ({
      operation_id: operationIds[docType],
      doc_type: docType,
      action: "unpublish",
      request_payload: {
        expected_reservation_id:
          index === 0
            ? "10000000-0000-4000-8000-000000000003"
            : "20000000-0000-4000-8000-000000000003",
        expected_reservation_version: 2,
      },
      response: {
        ok: true,
        restored_draft: true,
        version: 2,
      },
      admin_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }));
  const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    const query = body.query;
    queries.push(query);
    if (/^with admin as/.test(query.trim())) {
      assert.equal(
        (query.match(/public\.admin_unpublish_legal\(/g) ?? []).length,
        2,
      );
      assert.match(query, /admin cross join op_0/);
      canceled = true;
      return jsonResponse([
        {
          result: {
            privacy: receipts()[0]!.response,
            terms: receipts()[1]!.response,
          },
        },
      ]);
    }
    if (query.includes("strict_legal_rpc_ready")) {
      return jsonResponse(productionFingerprint());
    }
    if (query.includes("from public.legal_documents")) {
      return jsonResponse(
        canceled
          ? legalRows({ drafts: true })
          : legalRows({ publishedV2: true, effectiveDate }),
      );
    }
    if (query.includes("from public.legal_operation_receipts")) {
      return jsonResponse(canceled ? receipts() : []);
    }
    throw new Error("unexpected_query");
  }) as typeof fetch;
  const rawResult = await runLegalV2Rollout({
    argv: [
      "--mode",
      "cancel",
      "--apply",
      "--effective-date",
      effectiveDate,
      "--confirm",
      "CANCEL-BOSS-PAEGI-LEGAL-V2",
    ],
    env: fakeManagementEnv,
    fetchImpl,
    now: new Date("2026-07-30T00:00:00.000Z"),
  });
  const result = rawResult as unknown as {
    ok: true;
    mode: "cancel";
    mutated: boolean;
    documents: Record<"privacy" | "terms", { draft: string; v2Status: string }>;
  };
  assert.equal(result.ok, true);
  assert.equal(result.mode, "cancel");
  assert.equal(result.mutated, true);
  assert.equal(result.documents.privacy.draft, "canonical");
  assert.equal(result.documents.terms.draft, "canonical");
  assert.equal(result.documents.privacy.v2Status, "absent");
  assert.equal(result.documents.terms.v2Status, "absent");
  assert.equal(
    queries.filter((query) => /^with admin as/.test(query.trim())).length,
    1,
  );
});
