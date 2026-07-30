const [
  ,
  ,
  userId,
  nextEmail,
  expectedOutcome,
  expectedCurrentEmail,
  expectedFenceAction,
  expectedKeep,
] = process.argv;
const url = process.env.QA_LOCAL_SUPABASE_URL;
const serviceKey = process.env.QA_LOCAL_SUPABASE_SERVICE_ROLE_KEY;

if (
  !url ||
  !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(url) ||
  !serviceKey
) {
  throw new Error("local Supabase Auth credentials are missing or non-local");
}
if (
  !/^[0-9a-f-]{36}$/i.test(userId ?? "") ||
  !nextEmail ||
  !["success", "error"].includes(expectedOutcome) ||
  !expectedCurrentEmail ||
  !["activate", "cancel", "none"].includes(expectedFenceAction) ||
  !expectedKeep
) {
  throw new Error("invalid reactivation Auth API test arguments");
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function serialized(value) {
  return JSON.stringify(canonicalize(value));
}

function normalizedIdentity(identity) {
  return canonicalize(identity);
}

function identityKey(identity) {
  const stableId = identity.identity_id;
  if (
    typeof stableId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(stableId)
  ) {
    throw new Error("Auth identity has no stable identity_id");
  }
  return `${identity.provider}:${stableId}`;
}

function providerIdentity(identities, provider) {
  const matches = identities.filter(
    (identity) => identity.provider === provider,
  );
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${provider} identity`);
  }
  return matches[0];
}

function snapshot(user) {
  return {
    email: normalizeEmail(user.email),
    identities: [...(user.identities ?? [])]
      .map(normalizedIdentity)
      .sort((left, right) =>
        identityKey(left).localeCompare(identityKey(right)),
      ),
    appMetadata: canonicalize(user.app_metadata),
    userMetadata: canonicalize(user.user_metadata),
  };
}

function assertTwoProviderFixture(current) {
  if (current.identities.length !== 2) {
    throw new Error("Auth fixture identity cardinality changed");
  }
  providerIdentity(current.identities, "email");
  providerIdentity(current.identities, "google");
}

function withoutEmailMutationFields(identity) {
  const copy = structuredClone(identity);
  if (copy.identity_data && typeof copy.identity_data === "object") {
    delete copy.identity_data.email;
  }
  // GoTrue can expose/update these compatibility fields along with the email
  // identity. identity_id remains the durable identity row identifier.
  delete copy.id;
  delete copy.email;
  delete copy.updated_at;
  return canonicalize(copy);
}

function changedKeys(left, right) {
  return Object.keys({ ...left, ...right })
    .filter(
      (key) =>
        serialized(left?.[key]) !== serialized(right?.[key]),
    )
    .sort();
}

function withoutEmailVerificationMetadata(metadata) {
  const copy = structuredClone(metadata);
  if (copy && typeof copy === "object") {
    delete copy.email_verified;
  }
  return canonicalize(copy);
}

async function readUser() {
  const response = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.id !== userId) {
    throw new Error("local Auth user read failed");
  }
  return body;
}

const beforeUser = await readUser();
const before = snapshot(beforeUser);
assertTwoProviderFixture(before);
if (before.email !== normalizeEmail(expectedCurrentEmail)) {
  throw new Error("unexpected Auth precondition email");
}
if (before.appMetadata?.keep !== expectedKeep) {
  throw new Error("unrelated app_metadata precondition was lost");
}
if (
  expectedFenceAction !== "none" &&
  before.appMetadata?.bp_reactivation_fence?.action !== expectedFenceAction
) {
  throw new Error("exact Auth fence precondition is missing");
}

const updateResponse = await fetch(
  `${url}/auth/v1/admin/users/${userId}`,
  {
    method: "PUT",
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: nextEmail, email_confirm: true }),
  },
);
const updateBody = await updateResponse.json().catch(() => null);
const update = {
  ok: updateResponse.ok,
  body: updateBody,
};
const after = snapshot(await readUser());
assertTwoProviderFixture(after);

if (expectedOutcome === "error") {
  if (update.ok) {
    throw new Error("stale/third-real Auth update unexpectedly succeeded");
  }
  if (serialized(after) !== serialized(before)) {
    throw new Error("rejected Auth update was not transactionally rolled back");
  }
} else {
  if (!update.ok || !update.body || update.body.id !== userId) {
    throw new Error("fenced local Auth update unexpectedly failed");
  }
  const normalizedNext = normalizeEmail(nextEmail);
  const beforeEmailIdentity = providerIdentity(
    before.identities,
    "email",
  );
  const afterEmailIdentity = providerIdentity(after.identities, "email");
  const beforeGoogleIdentity = providerIdentity(
    before.identities,
    "google",
  );
  const afterGoogleIdentity = providerIdentity(
    after.identities,
    "google",
  );
  if (
    after.email !== normalizedNext ||
    normalizeEmail(afterEmailIdentity.identity_data?.email) !==
      normalizedNext ||
    (
      Object.hasOwn(afterEmailIdentity, "email") &&
      normalizeEmail(afterEmailIdentity.email) !== normalizedNext
    )
  ) {
    throw new Error("Auth user/email identity did not converge together");
  }
  if (
    identityKey(beforeEmailIdentity) !== identityKey(afterEmailIdentity) ||
    serialized(withoutEmailMutationFields(beforeEmailIdentity)) !==
      serialized(withoutEmailMutationFields(afterEmailIdentity))
  ) {
    const beforeComparable =
      withoutEmailMutationFields(beforeEmailIdentity);
    const afterComparable =
      withoutEmailMutationFields(afterEmailIdentity);
    throw new Error(
      "Auth email update replaced or clobbered its identity " +
        `(identity_stable=${
          identityKey(beforeEmailIdentity) ===
          identityKey(afterEmailIdentity)
        }, changed=${changedKeys(
          beforeComparable,
          afterComparable,
        ).join(",")}, identity_data_changed=${changedKeys(
          beforeComparable.identity_data,
          afterComparable.identity_data,
        ).join(",")})`,
    );
  }
  if (
    identityKey(beforeGoogleIdentity) !==
      identityKey(afterGoogleIdentity) ||
    serialized(beforeGoogleIdentity) !== serialized(afterGoogleIdentity)
  ) {
    throw new Error("Auth email update changed the non-email identity");
  }
  if (
    serialized(after.appMetadata) !== serialized(before.appMetadata) ||
    serialized(withoutEmailVerificationMetadata(after.userMetadata)) !==
      serialized(withoutEmailVerificationMetadata(before.userMetadata)) ||
    after.userMetadata?.email_verified !== true
  ) {
    throw new Error(
      "Auth email update clobbered account metadata " +
        `(app_metadata_changed=${changedKeys(
          before.appMetadata,
          after.appMetadata,
        ).join(",")}, user_metadata_changed=${changedKeys(
          before.userMetadata,
          after.userMetadata,
        ).join(",")})`,
    );
  }
}

process.stdout.write(`local Auth ${expectedOutcome} contract passed\n`);
