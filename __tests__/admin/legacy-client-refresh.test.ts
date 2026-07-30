import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CLIENT_REFRESH_REQUIRED,
  legacyAdminClientRefresh,
  type LegacyAdminClientSurface,
} from "../../lib/admin-client-compat.ts";

const TARGET_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_ID = "223e4567-e89b-42d3-a456-426614174001";
const OPERATION_ID = "323e4567-e89b-42d3-a456-426614174002";
const REASON = "confirmed legacy request";

type LegacyCase = {
  name: string;
  surface: LegacyAdminClientSurface;
  legacy: Record<string, unknown>;
  requiredKeys: readonly string[];
  upgrades: Record<string, unknown>;
};

const legacyEventSave = {
  action: "save",
  id: TARGET_ID,
  type: "notice",
  title: "Legacy event",
  summary: "Legacy summary",
  body: "Legacy body",
  coverImagePath: null,
  startsAt: null,
  endsAt: null,
  popupActive: false,
  bannerHomeActive: false,
  bannerGalleryActive: false,
  bannerLeaderboardActive: false,
  priority: 0,
  pinned: false,
  noindex: false,
  popupDismissDays: 7,
};

const legacyCases: LegacyCase[] = [
  {
    name: "credit adjustment",
    surface: "adjust",
    legacy: { targetUserId: TARGET_ID, delta: 1, reason: REASON },
    requiredKeys: ["targetUserId", "delta", "reason"],
    upgrades: { action: "apply", requestId: OPERATION_ID },
  },
  {
    name: "event save",
    surface: "events",
    legacy: legacyEventSave,
    requiredKeys: ["action", "type", "title", "summary", "body"],
    upgrades: {
      expectedVersion: 3,
      requestId: OPERATION_ID,
      targetKey: `event:${TARGET_ID}`,
    },
  },
  {
    name: "new event save",
    surface: "events",
    legacy: { ...legacyEventSave, id: null },
    requiredKeys: ["action", "type", "title", "summary", "body"],
    upgrades: {
      expectedVersion: 0,
      requestId: OPERATION_ID,
      targetKey: `new:${SECOND_ID}`,
    },
  },
  ...(["publish", "unpublish", "delete"] as const).map((action) => ({
    name: `event ${action}`,
    surface: "events" as const,
    legacy: { action, id: TARGET_ID },
    requiredKeys: ["action", "id"],
    upgrades: { expectedVersion: 3 },
  })),
  {
    name: "legal draft save",
    surface: "legal",
    legacy: {
      action: "save_draft",
      docType: "privacy",
      title: "Legacy privacy policy",
      sections: [{ heading: "Purpose", body: "Legacy section body" }],
      publicNote: null,
      adminNote: null,
    },
    requiredKeys: ["action", "docType", "title", "sections"],
    upgrades: {
      operationId: OPERATION_ID,
      baseUpdatedAt: "2026-07-29T00:00:00.000Z",
    },
  },
  {
    name: "legal publish",
    surface: "legal",
    legacy: {
      action: "publish",
      docType: "terms",
      effectiveDate: "2026-08-01",
    },
    requiredKeys: ["action", "docType", "effectiveDate"],
    upgrades: {
      operationId: OPERATION_ID,
      draftId: TARGET_ID,
      draftUpdatedAt: "2026-07-29T00:00:00.000Z",
    },
  },
  {
    name: "legal unpublish",
    surface: "legal",
    legacy: { action: "unpublish", docType: "privacy" },
    requiredKeys: ["action", "docType"],
    upgrades: {
      operationId: OPERATION_ID,
      reservationId: TARGET_ID,
      reservationVersion: 2,
    },
  },
  ...(["Ban", "Unban"] as const).map((action) => ({
    name: `integrity ${action.toLowerCase()}`,
    surface: `integrity${action}` as const,
    legacy: { memberId: TARGET_ID, reason: REASON },
    requiredKeys: ["memberId", "reason"],
    upgrades: { expectedState: "clean", expectedVersion: 4 },
  })),
  ...(["Clear", "Void"] as const).map((action) => ({
    name: `integrity ${action.toLowerCase()}`,
    surface: `integrity${action}` as const,
    legacy: { scoreId: TARGET_ID, reason: REASON },
    requiredKeys: ["scoreId", "reason"],
    upgrades: { expectedState: "registered", expectedVersion: 4 },
  })),
  ...(["Takedown", "Dismiss", "Restore"] as const).map((action) => ({
    name: `moderation ${action.toLowerCase()}`,
    surface: `moderation${action}` as const,
    legacy: { dollId: TARGET_ID, reason: REASON },
    requiredKeys: ["dollId", "reason"],
    upgrades: { expectedState: "pending", expectedVersion: 4 },
  })),
  {
    name: "moderation permanent delete",
    surface: "moderationPermanentDelete",
    legacy: { dollId: TARGET_ID, reason: REASON },
    requiredKeys: ["dollId", "reason"],
    upgrades: {
      expectedState: "hidden",
      expectedVersion: 4,
      requestId: OPERATION_ID,
    },
  },
  {
    name: "account reactivation",
    surface: "reactivate",
    legacy: {
      userId: TARGET_ID,
      reason: REASON,
      emailOverride: "owner@example.com",
    },
    requiredKeys: ["userId", "reason"],
    upgrades: {
      expectedDeletedAt: "2026-07-29T00:00:00.000Z",
      expectedWithdrawalGeneration: 1,
    },
  },
  {
    name: "account reactivation without email override",
    surface: "reactivate",
    legacy: { userId: TARGET_ID, reason: REASON },
    requiredKeys: ["userId", "reason"],
    upgrades: {
      expectedDeletedAt: "2026-07-29T00:00:00.000Z",
      expectedWithdrawalGeneration: 1,
    },
  },
  {
    name: "reviewer provision",
    surface: "reviewersPost",
    legacy: { email: " reviewer@example.com ", note: "legacy reviewer" },
    requiredKeys: ["email"],
    upgrades: { operationId: OPERATION_ID },
  },
  {
    name: "reviewer activate",
    surface: "reviewersPatch",
    legacy: { action: "set_active", userId: TARGET_ID, active: true },
    requiredKeys: ["action", "userId", "active"],
    upgrades: { operationId: OPERATION_ID },
  },
  {
    name: "reviewer password reset",
    surface: "reviewersPatch",
    legacy: { action: "reset_password", userId: TARGET_ID },
    requiredKeys: ["action", "userId"],
    upgrades: { operationId: OPERATION_ID },
  },
  {
    name: "reviewer delete",
    surface: "reviewersDelete",
    legacy: { userId: TARGET_ID },
    requiredKeys: ["userId"],
    upgrades: { operationId: OPERATION_ID },
  },
];

test("all confirmed origin/main legacy admin mutations require a client refresh", () => {
  assert.ok(Object.isFrozen(CLIENT_REFRESH_REQUIRED));

  for (const scenario of legacyCases) {
    const decision = legacyAdminClientRefresh(
      scenario.surface,
      scenario.legacy,
    );
    assert.deepEqual(
      decision,
      {
        status: 409,
        body: { error: "client_refresh_required", reload: true },
      },
      scenario.name,
    );
    assert.equal(decision?.body, CLIENT_REFRESH_REQUIRED, scenario.name);
  }
});

test("every non-empty partial upgrade misses the strict legacy classifier", () => {
  for (const scenario of legacyCases) {
    const entries = Object.entries(scenario.upgrades);
    assert.ok(entries.length > 0, `${scenario.name}: upgrade keys required`);

    for (let mask = 1; mask < 2 ** entries.length; mask += 1) {
      const request = { ...scenario.legacy };
      const added: string[] = [];
      entries.forEach(([key, value], index) => {
        if ((mask & (1 << index)) !== 0) {
          request[key] = value;
          added.push(key);
        }
      });
      assert.equal(
        legacyAdminClientRefresh(scenario.surface, request),
        null,
        `${scenario.name}: partial upgrade ${added.join(",")}`,
      );
    }
  }
});

test("every required-key omission and unknown top-level field misses the classifier", () => {
  for (const scenario of legacyCases) {
    for (const key of scenario.requiredKeys) {
      const request = { ...scenario.legacy };
      delete request[key];
      assert.equal(
        legacyAdminClientRefresh(scenario.surface, request),
        null,
        `${scenario.name}: missing ${key}`,
      );
    }

    assert.equal(
      legacyAdminClientRefresh(scenario.surface, {
        ...scenario.legacy,
        unexpected: true,
      }),
      null,
      `${scenario.name}: unknown top-level field`,
    );
  }
});

test("legacy adjustment exhaustively accepts exactly the finite integer delta domain", () => {
  for (let delta = -100; delta <= 100; delta += 1) {
    const decision = legacyAdminClientRefresh("adjust", {
      targetUserId: TARGET_ID,
      delta,
      reason: REASON,
    });
    assert.equal(
      decision?.status ?? null,
      delta === 0 ? null : 409,
      `delta ${delta}`,
    );
  }

  for (const delta of [-101, 101, -0.5, 0.5, Number.NaN, Infinity]) {
    assert.equal(
      legacyAdminClientRefresh("adjust", {
        targetUserId: TARGET_ID,
        delta,
        reason: REASON,
      }),
      null,
      `invalid delta ${delta}`,
    );
  }
});

test("all reason-bearing legacy surfaces share exact 5..500 boundaries", () => {
  const scenarios = legacyCases.filter(
    (scenario) => typeof scenario.legacy.reason === "string",
  );
  for (const scenario of scenarios) {
    for (const reason of ["12345", "x".repeat(500)]) {
      assert.equal(
        legacyAdminClientRefresh(scenario.surface, {
          ...scenario.legacy,
          reason,
        })?.status,
        409,
        `${scenario.name}: valid reason length ${reason.length}`,
      );
    }
    for (const reason of ["1234", "x".repeat(501), "     "]) {
      assert.equal(
        legacyAdminClientRefresh(scenario.surface, {
          ...scenario.legacy,
          reason,
        }),
        null,
        `${scenario.name}: invalid reason length ${reason.trim().length}`,
      );
    }
  }
});

test("malformed and current-only requests remain on normal route validation", () => {
  const malformed: Array<{
    surface: LegacyAdminClientSurface;
    value: unknown;
  }> = [
    { surface: "adjust", value: null },
    {
      surface: "adjust",
      value: { targetUserId: "not-a-uuid", delta: 1, reason: REASON },
    },
    {
      surface: "events",
      value: { action: "publish", id: "not-a-uuid" },
    },
    {
      surface: "legal",
      value: {
        action: "save_draft",
        docType: "privacy",
        title: "No sections",
        sections: [],
      },
    },
    {
      surface: "integrityBan",
      value: { memberId: TARGET_ID, reason: "four" },
    },
    {
      surface: "moderationTakedown",
      value: { dollId: TARGET_ID, reason: "four" },
    },
    {
      surface: "reactivate",
      value: { userId: SECOND_ID, reason: "four" },
    },
    {
      surface: "reactivate",
      value: {
        userId: SECOND_ID,
        reason: REASON,
        emailOverride: `deleted+${SECOND_ID}@deleted.invalid`,
      },
    },
    {
      surface: "reviewersPost",
      value: { email: "not-an-email" },
    },
    {
      surface: "reviewersPatch",
      value: { action: "set_active", userId: TARGET_ID },
    },
    {
      surface: "reviewersPatch",
      value: {
        action: "set_note",
        userId: TARGET_ID,
        note: "current route action",
      },
    },
    {
      surface: "reviewersDelete",
      value: { userId: "not-a-uuid" },
    },
  ];

  for (const scenario of malformed) {
    assert.equal(
      legacyAdminClientRefresh(scenario.surface, scenario.value),
      null,
      `${scenario.surface}: ${JSON.stringify(scenario.value)}`,
    );
  }
});

type RouteSpec = {
  file: string;
  method: "POST" | "PATCH" | "DELETE";
  surface: LegacyAdminClientSurface;
  validation: string;
};

const routeSpecs: RouteSpec[] = [
  {
    file: "app/api/admin/adjust/route.ts",
    method: "POST",
    surface: "adjust",
    validation: "if (!body?.requestId",
  },
  {
    file: "app/api/admin/events/route.ts",
    method: "POST",
    surface: "events",
    validation: "bodySchema.safeParse(body)",
  },
  {
    file: "app/api/admin/legal/route.ts",
    method: "POST",
    surface: "legal",
    validation: "bodySchema.safeParse(body)",
  },
  ...(["ban", "unban", "clear", "void"] as const).map((action) => ({
    file: `app/api/admin/integrity/${action}/route.ts`,
    method: "POST" as const,
    surface:
      `integrity${action[0].toUpperCase()}${action.slice(1)}` as LegacyAdminClientSurface,
    validation: "const reason =",
  })),
  ...(["takedown", "dismiss", "restore"] as const).map((action) => ({
    file: `app/api/admin/moderation/${action}/route.ts`,
    method: "POST" as const,
    surface:
      `moderation${action[0].toUpperCase()}${action.slice(1)}` as LegacyAdminClientSurface,
    validation: "!body?.dollId",
  })),
  {
    file: "app/api/admin/moderation/permanent-delete/route.ts",
    method: "POST",
    surface: "moderationPermanentDelete",
    validation: "!body ||",
  },
  {
    file: "app/api/admin/reactivate/route.ts",
    method: "POST",
    surface: "reactivate",
    validation: "const reason =",
  },
  {
    file: "app/api/admin/reviewers/route.ts",
    method: "POST",
    surface: "reviewersPost",
    validation: "postSchema.safeParse(body)",
  },
  {
    file: "app/api/admin/reviewers/route.ts",
    method: "PATCH",
    surface: "reviewersPatch",
    validation: "patchSchema.safeParse(bodyValue)",
  },
  {
    file: "app/api/admin/reviewers/route.ts",
    method: "DELETE",
    surface: "reviewersDelete",
    validation: "deleteSchema.safeParse(body)",
  },
];

function routeHandler(file: string, method: RouteSpec["method"]): string {
  const source = readFileSync(
    new URL(`../../${file}`, import.meta.url),
    "utf8",
  );
  const start = source.indexOf(`export async function ${method}`);
  assert.ok(start >= 0, `${file}: ${method} handler missing`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

test("authenticated legacy branches return before validation and every mutation surface", () => {
  const response =
    "return NextResponse.json(refresh.body, { status: refresh.status });";
  const forbiddenBeforeReturn = [
    "createAdminClient()",
    ".rpc(",
    ".auth.admin",
    ".storage.",
    "revalidatePath(",
    "revalidateTag(",
    "revalidateDollSurfaces(",
  ];

  for (const spec of routeSpecs) {
    const handler = routeHandler(spec.file, spec.method);
    const auth = handler.indexOf("await requireAdmin()");
    const guard = handler.indexOf(`legacyAdminClientRefresh("${spec.surface}"`);
    const earlyReturn = handler.indexOf(response, guard);
    const validation = handler.indexOf(spec.validation, earlyReturn);
    const admin = handler.indexOf("createAdminClient()", validation);

    assert.ok(auth >= 0, `${spec.file} ${spec.method}: admin auth missing`);
    assert.ok(
      auth < guard,
      `${spec.file} ${spec.method}: compatibility guard must follow auth`,
    );
    assert.ok(
      guard < earlyReturn,
      `${spec.file} ${spec.method}: exact 409 return missing`,
    );
    assert.ok(
      earlyReturn < validation,
      `${spec.file} ${spec.method}: malformed current validation must follow guard`,
    );
    assert.ok(
      validation < admin,
      `${spec.file} ${spec.method}: admin client must follow validation`,
    );

    const legacyBranch = handler.slice(0, earlyReturn + response.length);
    for (const forbidden of forbiddenBeforeReturn) {
      assert.doesNotMatch(
        legacyBranch,
        new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${spec.file} ${spec.method}: ${forbidden} before legacy return`,
      );
    }
  }
});
