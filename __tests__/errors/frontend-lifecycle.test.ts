import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register("../telemetry/node-loader.mjs", import.meta.url);

const { isCurrentHighlightRecording } = await import(
  "../../app/play/useHighlightRecorder.ts"
);
const { shouldFinalizeTelemetryPageHide } = await import(
  "../../app/play/useTelemetry.ts"
);
const { isCurrentClientEpoch } = await import(
  "../../lib/client-lifecycle.ts"
);

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("highlight completion belongs to exactly one live recording epoch", () => {
  for (const candidate of [0, 1, 2, Number.MAX_SAFE_INTEGER]) {
    for (const current of [0, 1, 2, Number.MAX_SAFE_INTEGER]) {
      for (const cancelled of [false, true]) {
        assert.equal(
          isCurrentHighlightRecording(candidate, current, cancelled),
          candidate === current && !cancelled,
          `${candidate}/${current}/${cancelled}`,
        );
      }
    }
  }
  for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isCurrentHighlightRecording(invalid, invalid, false), false);
  }

  const hook = source("app/play/useHighlightRecorder.ts");
  const consider = hook.indexOf("const consider = useCallback(");
  const firstFence = hook.indexOf("isCurrentHighlightRecording(", consider);
  const blackProbe = hook.indexOf(
    "const black = await isConfidentBlack(blob)",
    consider,
  );
  const secondFence = hook.indexOf(
    "isCurrentHighlightRecording(",
    blackProbe,
  );
  assert.ok(consider >= 0);
  assert.ok(firstFence >= 0);
  assert.ok(blackProbe > firstFence);
  assert.ok(secondFence > blackProbe);
  assert.match(hook, /recordingEpochRef\.current \+= 1/);
});

test("bfcache pagehide preserves the live telemetry session", () => {
  assert.equal(shouldFinalizeTelemetryPageHide(false), true);
  assert.equal(shouldFinalizeTelemetryPageHide(true), false);

  const hook = source("app/play/useTelemetry.ts");
  assert.match(hook, /shouldFinalizeTelemetryPageHide\(event\.persisted\)/);
  assert.match(
    hook,
    /if \(!shouldFinalizeTelemetryPageHide\(event\.persisted\)\)[\s\S]*?clearTimeout\(hiddenTimer\)[\s\S]*?return;/,
  );
  assert.match(hook, /finalize\("abandon"\)/);
});

test("account profile lifecycle survives StrictMode and ignores stale refreshes", () => {
  const menu = source("components/AccountMenu.tsx");
  assert.match(
    menu,
    /useEffect\(\(\) => \{[\s\S]*?mountedRef\.current = true;[\s\S]*?mountedRef\.current = false;/,
  );
  assert.match(
    menu,
    /const requestEpoch = profileRequestEpochRef\.current \+ 1;/,
  );
  assert.ok(
    (menu.match(/profileRequestEpochRef\.current !== requestEpoch/g) ?? [])
      .length >= 2,
  );
});

test("client async results belong to exactly one mounted UI epoch", () => {
  for (const candidate of [0, 1, 2, Number.MAX_SAFE_INTEGER]) {
    for (const current of [0, 1, 2, Number.MAX_SAFE_INTEGER]) {
      for (const mounted of [false, true]) {
        assert.equal(
          isCurrentClientEpoch(candidate, current, mounted),
          mounted && candidate === current,
          `${candidate}/${current}/${mounted}`,
        );
      }
    }
  }
  for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isCurrentClientEpoch(invalid, invalid, true), false);
  }

  const modal = source("components/GameOverModal.tsx");
  assert.match(modal, /openCycleEpochRef\.current \+= 1/);
  assert.ok(
    (modal.match(/isCurrentClientEpoch\(/g) ?? []).length >= 4,
  );
  assert.match(modal, /disabled=\{!scoreId \|\| sharing\}/);
  assert.match(
    modal,
    /setShareMsg\(null\);[\s\S]*?setNickname\(""\);/,
  );
});

test("share surfaces abort stale downloads and fence every async UI result", () => {
  for (const path of [
    "components/HighlightPlayer.tsx",
    "components/ShareReportButton.tsx",
  ]) {
    const component = source(path);
    assert.match(component, /new AbortController\(\)/, path);
    assert.match(component, /signal: abort\.signal/, path);
    assert.match(component, /activeAbortRef\.current\?\.abort\(\)/, path);
    assert.ok(
      (component.match(/isCurrentClientEpoch\(/g) ?? []).length >= 3,
      path,
    );
    assert.match(component, /busyRef\.current/, path);
    assert.match(component, /aria-live="polite"/, path);
  }
});

test("gallery mutations synchronously single-flight before React rerenders", () => {
  const gallery = source("app/gallery/page.tsx");
  const card = source("components/gallery/DollCard.tsx");
  assert.match(gallery, /deletingIdsRef\.current\.has\(id\)/);
  assert.match(gallery, /deletingIdsRef\.current\.add\(id\)/);
  assert.match(gallery, /deletingIdsRef\.current\.delete\(id\)/);
  assert.match(card, /sharingRef\.current/);
  assert.match(card, /savingRoleRef\.current/);
  assert.ok((card.match(/isCurrentClientEpoch\(/g) ?? []).length >= 4);
  assert.match(card, /clearTimeout\(flashTimerRef\.current\)/);
  assert.match(card, /disabled=\{deleting \|\| savingRole \|\| sharing\}/);
  assert.match(gallery, /catch \(error\) \{\s*if \(requestEpochRef\.current !== epoch\) return;/);
  assert.match(gallery, /mountedRef\.current[\s\S]*?setDolls/);
  assert.match(card, /roleAbortRef\.current\?\.abort\(\)/);
  assert.match(card, /signal: controller\.signal/);
});

test("account, report, login, and consent actions occupy synchronously and fence teardown", () => {
  const account = source("app/account/page.tsx");
  const report = source("components/ReportDialog.tsx");
  const login = source("app/login/LoginForm.tsx");
  const consent = source("app/consent/ConsentForm.tsx");

  assert.match(account, /savingNickRef\.current/);
  assert.match(account, /busyRef\.current \|\| !ready/);
  assert.match(
    account,
    /runBoundedClientJsonFetch\(\{[\s\S]*input: "\/api\/account\/refundable-credits",[\s\S]*signal: controller\.signal/,
  );
  assert.match(account, /mountedRef\.current/);

  assert.match(report, /if \(busyRef\.current \|\| !reason\) return/);
  assert.match(report, /requestAbortRef\.current\?\.abort\(\)/);
  assert.match(report, /signal: controller\.signal/);
  assert.match(report, /const close = \(\) => \{\s*if \(!busyRef\.current\) onClose\(\)/);

  assert.match(login, /authBusyRef\.current/);
  assert.match(login, /authOperationEpochRef\.current !== operationEpoch/);
  assert.match(login, /disabled=\{rvBusy \|\| !!busy\}/);

  assert.match(consent, /if \(busyRef\.current \|\| !all\) return/);
  assert.match(consent, /requestAbortRef\.current\?\.abort\(\)/);
  assert.match(consent, /signal: controller\.signal/);
  const routeMove = consent.indexOf("router.replace(next)");
  const profileRefresh = consent.indexOf("void getMyProfile()");
  assert.ok(profileRefresh >= 0 && routeMove > profileRefresh);
  assert.doesNotMatch(
    consent,
    /const p = await getMyProfile\(\)[\s\S]{0,200}router\.replace/,
  );
});

test("menus, toasts, and leaderboard requests cannot strand keyboard or timers", () => {
  const account = source("components/AccountMenu.tsx");
  const toast = source("components/gallery/HookToast.tsx");
  const leaderboard = source("app/leaderboard/page.tsx");
  const gameOver = source("components/GameOverModal.tsx");

  assert.match(account, /aria-controls=\{open \? menuId : undefined\}/);
  assert.match(account, /event\.key === "Escape"/);
  assert.match(account, /event\.key === "ArrowDown"/);
  assert.match(account, /event\.key === "ArrowUp"/);
  assert.match(account, /event\.key !== "Home"/);
  assert.match(account, /event\.key (?:!==|===) "End"/);
  assert.match(account, /triggerRef\.current\?\.focus\(\)/);
  assert.match(account, /signingOutRef\.current/);
  assert.match(account, /savingRef\.current/);

  assert.match(toast, /onCloseRef\.current/);
  assert.match(toast, /\}, \[message\]\);/);
  assert.match(toast, /aria-live="polite"/);

  assert.match(leaderboard, /new AbortController\(\)/);
  assert.match(leaderboard, /signal: controller\.signal/);
  assert.match(leaderboard, /controller\.abort\(\)/);

  assert.match(gameOver, /Analytics is never allowed to block/);
  assert.match(gameOver, /File construction can fail/);
  assert.match(gameOver, /shareGameResult\(sid, score/);
});
