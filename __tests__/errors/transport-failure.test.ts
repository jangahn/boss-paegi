import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isTransportFailure } from "../../lib/transport-failure.ts";
import {
  requireSupabaseSuccess,
  SupabaseOperationError,
} from "../../lib/supabase-operation.ts";

function namedError(
  name: string,
  message: string,
  extra: Record<string, unknown> = {},
): Error {
  const error = new Error(message);
  error.name = name;
  return Object.assign(error, extra);
}

test("transport failure covers only no-response failures", () => {
  // supabase auth-js: fetch 무응답은 AuthRetryableFetchError(status 0).
  assert.equal(
    isTransportFailure(
      namedError("AuthRetryableFetchError", "Failed to fetch (db.supabase.co)", {
        status: 0,
      }),
    ),
    true,
  );
  // 브라우저 엔진별 네트워크 실패 워딩(호스트 서픽스 포함).
  assert.equal(
    isTransportFailure(new TypeError("Failed to fetch (db.supabase.co)")),
    true,
  );
  assert.equal(
    isTransportFailure(new TypeError("Load failed (db.supabase.co)")),
    true,
  );
  assert.equal(
    isTransportFailure(
      new TypeError("NetworkError when attempting to fetch resource."),
    ),
    true,
  );
  // PostgREST 는 fetch 실패를 문자열 프리픽스가 붙은 평범한 객체로 resolve 한다.
  assert.equal(
    isTransportFailure({
      message: "TypeError: Failed to fetch",
      details: "TypeError: Failed to fetch",
      hint: "",
      code: "",
    }),
    true,
  );
  // 이탈/타임아웃 abort — 응답 없음.
  assert.equal(isTransportFailure(namedError("AbortError", "aborted")), true);
  assert.equal(
    isTransportFailure(
      namedError("TimeoutError", "The operation was aborted due to timeout"),
    ),
    true,
  );
  // 래퍼는 원인으로 판별한다.
  assert.equal(
    isTransportFailure(
      new SupabaseOperationError(
        "profile.self",
        new TypeError("Load failed (db.supabase.co)"),
      ),
    ),
    true,
  );
});

test("server-judged failures never classify as transport", () => {
  // status 가 있으면 서버가 응답한 것 — retryable 5xx 포함.
  assert.equal(
    isTransportFailure(
      namedError("AuthRetryableFetchError", "Service temporarily unavailable", {
        status: 503,
      }),
    ),
    false,
  );
  assert.equal(
    isTransportFailure(
      namedError("AuthApiError", "Anonymous sign-ins are disabled", {
        status: 422,
      }),
    ),
    false,
  );
  // DB raise(P0001)·일반 예외·비객체.
  assert.equal(
    isTransportFailure({
      message: "withdrawal_limit_confirmation_required",
      code: "P0001",
    }),
    false,
  );
  assert.equal(isTransportFailure(new Error("game_init_inactive")), false);
  assert.equal(
    isTransportFailure(
      new SupabaseOperationError("profile.self", {
        message: "permission denied",
        code: "42501",
      }),
    ),
    false,
  );
  assert.equal(isTransportFailure(null), false);
  assert.equal(isTransportFailure("Failed to fetch"), false);
});

test("noise-classified emit sites split warn(logs-only) vs error(issue)", () => {
  const authClient = readFileSync("lib/auth-client.ts", "utf8");
  assert.match(authClient, /isTransportFailure\(error\)/);
  assert.match(authClient, /log\.warn\("auth\.anon_sign_in_fail"/);
  assert.match(authClient, /log\.error\("auth\.anon_sign_in_fail"/);

  const bootstrap = readFileSync("components/SessionBootstrap.tsx", "utf8");
  assert.match(bootstrap, /isTransportFailure\(error\)/);
  assert.match(bootstrap, /log\.warn\(\s*"auth\.bootstrap_profile_fail"/);
  assert.match(bootstrap, /log\.error\(\s*"auth\.bootstrap_profile_fail"/);

  const gameInit = readFileSync("app/play/useGameInit.ts", "utf8");
  // 언마운트 정리 abort 는 로깅하지 않는다(catch 첫 실행문이 cancelled 가드).
  assert.match(
    gameInit,
    /\.catch\(\(e\) => \{(?:\n\s*\/\/[^\n]*)*\n\s*if \(cancelled\) return;/,
  );
  assert.match(gameInit, /log\.warn\("play\.game_init_fail"/);
  assert.match(gameInit, /log\.error\("play\.game_init_fail"/);

  // warn 변형은 CAPTURE_SKIP(Logs 전용), error 변형은 이슈 승격 유지.
  const bridge = readFileSync("lib/sentry-bridge.ts", "utf8");
  const skipStart = bridge.indexOf("CAPTURE_SKIP");
  const skipBlock = bridge.slice(
    skipStart,
    bridge.indexOf("]);", skipStart),
  );
  for (const eventName of [
    "auth.anon_sign_in_fail",
    "auth.bootstrap_profile_fail",
    "play.game_init_fail",
  ]) {
    assert.ok(
      skipBlock.includes(`"${eventName}"`),
      `${eventName} must stay in CAPTURE_SKIP`,
    );
  }
});

test("resolved-error HTTP status rides the wrapper for diagnosis, classification, and 401 retry", async () => {
  // requireSupabaseSuccess 가 resolved `{ error, status }` 의 status 를 래퍼에 실어
  // errInfo(errStatus)·transport 판별(status 존재=서버 판정)·profile 401 재시도가 공유한다.
  // (2026-08-28 bootstrap_profile_fail 실측: PostgREST 401 인데 로그에 status 가 없어 판독 불가였음.)
  const err = await requireSupabaseSuccess("t.op", async () => ({
    data: null,
    error: { message: "JWT expired" },
    status: 401,
  })).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof SupabaseOperationError);
  assert.equal(err.status, 401);
  assert.equal(isTransportFailure(err), false);
  // status 가 숫자가 아니면 싣지 않는다(형태 오염 방지).
  const noStatus = await requireSupabaseSuccess("t.op", async () => ({
    data: null,
    error: { message: "boom" },
    status: "401",
  })).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(noStatus instanceof SupabaseOperationError);
  assert.equal(noStatus.status, undefined);
});

test("profile.self retries exactly once after a 401 via session refresh before escalating", () => {
  // 만료/스테일 JWT 첫 요청의 PostgREST 401(탭 복귀·부트스트랩 토큰 경합 — 직후 재요청은 성공)
  // 은 세션 갱신 후 1회 재시도. 401 외 실패·재시도 실패는 그대로 승격(실실패 은폐 금지).
  const profile = readFileSync("lib/profile.ts", "utf8");
  assert.match(
    profile,
    /error\.status !== 401[\s\S]*?auth\.profile_401_retry[\s\S]*?refreshSession\(\)[\s\S]*?await read\(\)/,
  );
});
