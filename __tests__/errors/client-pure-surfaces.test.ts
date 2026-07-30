import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  BACKGROUNDS,
  findBackground,
  randomBackground,
  resolveBackground,
} = await import("../../lib/backgrounds.ts");
const {
  CREDIT_PRODUCT_LIST,
  CREDIT_PRODUCTS,
  getCreditProduct,
  perUnitPrice,
} = await import("../../lib/credit-products.ts");
const { isMobileOS } = await import("../../lib/device.ts");
const { ctaFor } = await import("../../lib/gallery-cta.ts");
const { ownRecordValue } = await import("../../lib/own-record.ts");

test("background lookup exhausts the finite catalog and random index intervals", () => {
  assert.equal(new Set(BACKGROUNDS.map((background) => background.key)).size, BACKGROUNDS.length);
  for (const background of BACKGROUNDS) {
    assert.equal(findBackground(background.key), background);
    assert.equal(resolveBackground(background.key), background);
  }
  for (const invalid of [undefined, null, "", "Office", "toString", "__proto__"]) {
    assert.equal(findBackground(invalid), undefined);
    assert.equal(resolveBackground(invalid), BACKGROUNDS[0]);
  }

  const originalRandom = Math.random;
  try {
    for (let index = 0; index < BACKGROUNDS.length; index += 1) {
      Math.random = () => (index + 0.5) / BACKGROUNDS.length;
      assert.equal(randomBackground(), BACKGROUNDS[index]);
    }
  } finally {
    Math.random = originalRandom;
  }
});

test("gallery CTA covers every viewer state without an open redirect", () => {
  assert.deepEqual(ctaFor("nonmember"), {
    label: "가입하고 만들기",
    href: "/login?next=%2Fgenerate",
  });
  for (const state of ["member-empty", "member"] as const) {
    assert.deepEqual(ctaFor(state), {
      label: "캐릭터 만들기",
      href: "/generate",
    });
  }
});

test("fallback credit catalog is an exact own-property allowlist", () => {
  assert.deepEqual(
    CREDIT_PRODUCT_LIST.map((product) => product.productId),
    Object.keys(CREDIT_PRODUCTS),
  );
  let previousPrice = -1;
  for (const [id, product] of Object.entries(CREDIT_PRODUCTS)) {
    assert.equal(getCreditProduct(id), product);
    assert.equal(product.productId, id);
    assert.ok(Number.isSafeInteger(product.price) && product.price >= 1_000);
    assert.ok(Number.isSafeInteger(product.credits) && product.credits > 0);
    assert.ok(product.price >= previousPrice);
    assert.equal(perUnitPrice(product), Math.round(product.price / product.credits));
    previousPrice = product.price;
  }
  for (const invalid of [
    "",
    "credits_3 ",
    "CREDITS_3",
    "toString",
    "constructor",
    "__proto__",
  ]) {
    assert.equal(getCreditProduct(invalid), null);
  }
});

test("runtime record lookup rejects every Object prototype confusion key", () => {
  const record = { known: "value" };
  assert.equal(ownRecordValue(record, "known"), "value");
  for (const key of [
    null,
    undefined,
    "",
    "toString",
    "valueOf",
    "constructor",
    "__proto__",
    "hasOwnProperty",
  ]) {
    assert.equal(ownRecordValue(record, key), undefined, String(key));
  }
});

test("public query and dependency error-code consumers use own-property lookup", () => {
  const login = readFileSync(
    new URL("../../app/login/LoginForm.tsx", import.meta.url),
    "utf8",
  );
  const reviewers = readFileSync(
    new URL("../../app/api/admin/reviewers/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    login,
    /ownRecordValue\(ERROR_MESSAGES, errorKey\) \?\? ERROR_MESSAGES\.oauth/,
  );
  assert.doesNotMatch(login, /ERROR_MESSAGES\[errorKey\]/);
  assert.match(reviewers, /ownRecordValue\(KNOWN_RPC_ERRORS, code\)/);
  assert.doesNotMatch(reviewers, /KNOWN_RPC_ERRORS\[code\]/);
});

test("mobile OS gate covers browser and iPad desktop-UA equivalence classes", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const setNavigator = (userAgent: string, maxTouchPoints = 0) => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent, maxTouchPoints },
    });
  };
  try {
    for (const ua of [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)",
      "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)",
      "Mozilla/5.0 (Linux; Android 15; Pixel 9)",
    ]) {
      setNavigator(ua);
      assert.equal(isMobileOS(), true, ua);
    }
    setNavigator("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5);
    assert.equal(isMobileOS(), true);
    setNavigator("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 1);
    assert.equal(isMobileOS(), false);
    setNavigator("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 10);
    assert.equal(isMobileOS(), false);
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "navigator", original);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  }
});
