import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isTransportFailure } from "../../lib/transport-failure.ts";
import { SupabaseOperationError } from "../../lib/supabase-operation.ts";

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
