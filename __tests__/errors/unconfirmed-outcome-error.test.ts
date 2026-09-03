import assert from "node:assert/strict";
import test from "node:test";
import { unconfirmedOutcomeError } from "../../lib/client-mutation.ts";
import { isTransportFailure } from "../../lib/transport-failure.ts";
import { errInfo } from "../../lib/err-info.ts";

test("deadline outcomes become no-response TimeoutErrors that classify as transport", () => {
  const error = unconfirmedOutcomeError(
    { kind: "unconfirmed", reason: "deadline" },
    "auth_anon_sign_in_unconfirmed",
  );
  assert.equal(error.message, "auth_anon_sign_in_unconfirmed");
  assert.equal(error.name, "TimeoutError");
  assert.equal((error as { status?: unknown }).status, 0);
  assert.equal((error as { reason?: unknown }).reason, "deadline");
  assert.equal(isTransportFailure(error), true);
  const info = errInfo(error);
  assert.equal(info.errReason, "deadline");
  assert.equal(info.errStatus, 0);
  assert.equal(info.errName, "TimeoutError");
});

test("transport outcomes keep the provider failure as cause for logs", () => {
  const cause = new TypeError("Failed to fetch");
  const error = unconfirmedOutcomeError(
    { kind: "unconfirmed", reason: "transport", error: cause },
    "score_submit_response_unconfirmed",
  );
  assert.equal(error.cause, cause);
  assert.equal(isTransportFailure(error), true);
  const info = errInfo(error);
  assert.equal(info.errMessage, "score_submit_response_unconfirmed");
  assert.equal(info.errReason, "transport");
  assert.equal(info.errCauseName, "TypeError");
  assert.equal(info.errCauseMessage, "Failed to fetch");
});

test("aborted outcomes are AbortErrors, unconfirmed responses stay server-judged", () => {
  const aborted = unconfirmedOutcomeError(
    { kind: "aborted" },
    "client_asset_load_unconfirmed",
  );
  assert.equal(aborted.name, "AbortError");
  assert.equal(isTransportFailure(aborted), true);

  const answered = unconfirmedOutcomeError(
    { kind: "unconfirmed", reason: "response_unconfirmed" },
    "score_submit_response_unconfirmed",
  );
  assert.equal(answered.name, "Error");
  assert.equal((answered as { status?: unknown }).status, undefined);
  assert.equal(isTransportFailure(answered), false);
  assert.equal(errInfo(answered).errReason, "response_unconfirmed");
});

test("errInfo scrubs secrets inside a cause message and reads non-Error causes", () => {
  const withUrl = new Error("wrapped", {
    cause: new Error("GET https://x.test/file.png?token=abc failed"),
  });
  assert.equal(
    errInfo(withUrl).errCauseMessage,
    "GET https://x.test/file.png?[redacted] failed",
  );
  const plain = new Error("wrapped", {
    cause: { message: "duplicate key", code: "23505", status: 409 },
  });
  const info = errInfo(plain);
  assert.equal(info.errCauseMessage, "duplicate key");
  assert.equal(info.errCauseCode, "23505");
  assert.equal(info.errCauseStatus, 409);
});
