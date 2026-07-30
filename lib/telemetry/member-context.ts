/**
 * Public telemetry still needs a fail-closed identity classification boundary.
 *
 * An authenticated member must never be silently downgraded to anonymous when
 * Auth or Postgres is unavailable: doing so permanently creates an owner-less
 * session and all later member deltas conflict with `owner_mismatch`.
 */

export type TelemetryActorRead<T> = {
  data: T | null;
  error: unknown | null;
};

export type TelemetryActorDependencies = {
  getAuthUser: () => Promise<
    TelemetryActorRead<{ id: string; isAnonymous: boolean }>
  >;
  getProfile: (
    userId: string,
  ) => Promise<TelemetryActorRead<{ deletedAt: string | null }>>;
  getMember: (
    userId: string,
  ) => Promise<TelemetryActorRead<{ userId: string }>>;
};

export type TelemetryActor =
  | {
      ok: true;
      isMember: boolean;
      /**
       * Analytics owner. Anonymous/pre-consent sessions deliberately keep this
       * null so telemetry cannot be joined across sessions by Auth subject.
       */
      ownerId: string | null;
      /**
       * Per-session capability input. The ingest RPC hashes this together with
       * the random session id and stores only that session-scoped digest.
       */
      submitterId: string | null;
    }
  | {
      ok: false;
      status: 403 | 503;
      error: "account_deleted" | "identity_unavailable";
      stage: "auth" | "profile" | "member";
      cause?: unknown;
    };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function read<T>(
  stage: "auth" | "profile" | "member",
  operation: () => Promise<TelemetryActorRead<T>>,
): Promise<
  | { ok: true; data: T | null }
  | Extract<TelemetryActor, { ok: false }>
> {
  try {
    const result = await operation();
    if (result.error !== null && result.error !== undefined) {
      return {
        ok: false,
        status: 503,
        error: "identity_unavailable",
        stage,
        cause: result.error,
      };
    }
    return { ok: true, data: result.data };
  } catch (cause) {
    return {
      ok: false,
      status: 503,
      error: "identity_unavailable",
      stage,
      cause,
    };
  }
}

export async function resolveTelemetryActor(
  dependencies: TelemetryActorDependencies,
): Promise<TelemetryActor> {
  const auth = await read("auth", dependencies.getAuthUser);
  if (!auth.ok) return auth;
  if (auth.data === null) {
    return {
      ok: true,
      isMember: false,
      ownerId: null,
      submitterId: null,
    };
  }
  if (!UUID_RE.test(auth.data.id)) {
    return {
      ok: false,
      status: 503,
      error: "identity_unavailable",
      stage: "auth",
      cause: new Error("invalid_authenticated_user_id"),
    };
  }

  const userId = auth.data.id;
  if (auth.data.isAnonymous) {
    return {
      ok: true,
      isMember: false,
      ownerId: null,
      submitterId: userId,
    };
  }
  const [profile, member] = await Promise.all([
    read("profile", () => dependencies.getProfile(userId)),
    read("member", () => dependencies.getMember(userId)),
  ]);
  if (!profile.ok) return profile;
  if (!member.ok) return member;
  if (profile.data === null) {
    return {
      ok: false,
      status: 503,
      error: "identity_unavailable",
      stage: "profile",
      cause: new Error("profile_row_missing"),
    };
  }
  if (profile.data.deletedAt !== null) {
    return {
      ok: false,
      status: 403,
      error: "account_deleted",
      stage: "profile",
    };
  }
  if (member.data === null) {
    // A non-anonymous OAuth session before consent is intentionally summary-only.
    return {
      ok: true,
      isMember: false,
      ownerId: null,
      submitterId: userId,
    };
  }
  if (member.data.userId !== userId) {
    return {
      ok: false,
      status: 503,
      error: "identity_unavailable",
      stage: "member",
      cause: new Error("member_identity_mismatch"),
    };
  }
  return {
    ok: true,
    isMember: true,
    ownerId: userId,
    submitterId: userId,
  };
}
