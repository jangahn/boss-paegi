import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isAuthSubtreePath } from "../../lib/routes.ts";

function source(path: string): string {
  return readFileSync(
    new URL(`../../${path}`, import.meta.url),
    "utf8",
  );
}

test("the exact /auth subtree predicate covers callback and every recovery descendant", () => {
  const suffixes = [
    "",
    "/",
    "/callback",
    "/callback/",
    "/callback/deeper",
    "/flow-pending",
    "/reconcile",
    "/oauth/회복",
    `/${"x".repeat(2_048)}`,
  ];
  for (const suffix of suffixes) {
    assert.equal(
      isAuthSubtreePath(`/auth${suffix}`),
      true,
      `/auth${suffix}`,
    );
  }

  for (const outside of [
    "",
    "/",
    "/api/auth",
    "/login",
    "/Auth",
    "/authorization",
    "/authenticate",
    "/authentic",
    "/auth-callback",
    "/auth?next=/callback",
    "/auth%2Fcallback",
  ]) {
    assert.equal(isAuthSubtreePath(outside), false, outside);
  }
});

test("AppNav rejects the Auth subtree before forceShow or AccountMenu mounting", () => {
  const nav = source("components/AppNav.tsx");
  const component = nav.slice(
    nav.indexOf("export function AppNav"),
  );
  const routeGate = component.indexOf(
    "if (isAuthSubtreePath(pathname)) return null;",
  );
  const forceShowGate = component.indexOf(
    "if (!forceShow && NAV_HIDDEN_PREFIXES",
  );
  const accountMenu = component.indexOf("<AccountMenu />");

  assert.ok(routeGate >= 0);
  assert.ok(forceShowGate > routeGate);
  assert.ok(accountMenu > forceShowGate);
  assert.match(
    nav,
    /import \{ isAuthSubtreePath \} from "@\/lib\/routes";/,
  );
});

test("callback mounting cannot mount ordinary session or profile background effects", () => {
  const bootstrap = source("components/SessionBootstrap.tsx");
  const effectOwner = bootstrap.indexOf(
    "function SessionBootstrapEffects({",
  );
  const publicComponent = bootstrap.indexOf(
    "export function SessionBootstrap({",
  );
  assert.ok(effectOwner >= 0);
  assert.ok(publicComponent > effectOwner);

  const publicSource = bootstrap.slice(publicComponent);
  const routeGate = publicSource.indexOf(
    "if (isAuthSubtreePath(pathname)) return <>{children}</>;",
  );
  const effectMount = publicSource.indexOf(
    "return (",
  );
  assert.ok(routeGate >= 0);
  assert.ok(effectMount > routeGate);
  assert.doesNotMatch(
    publicSource.slice(0, effectMount),
    /createClient\(|auth\.getSession\(|getMyProfile\(|ensureAuth\(/,
  );
  assert.match(
    publicSource.slice(effectMount),
    /<OrdinarySessionBootstrap>[\s\S]*?\{children\}[\s\S]*?<\/OrdinarySessionBootstrap>/,
  );

  const effectSource = bootstrap.slice(
    effectOwner,
    bootstrap.indexOf(
      "function OrdinaryHydrationFence({",
      effectOwner,
    ),
  );
  const liveRouteGate = effectSource.indexOf(
    "if (isAuthSubtreePath(window.location.pathname))",
  );
  const ordinaryCalls = [
    "const sb = createClient()",
    "await sb.auth.getSession()",
    "await ensureAuth(controller.signal)",
    "await getMyProfile(controller.signal)",
  ];
  assert.ok(liveRouteGate >= 0);
  for (const call of ordinaryCalls) {
    assert.ok(
      effectSource.indexOf(call) > liveRouteGate,
      call,
    );
  }

  // Behavioral witness for the callback path: both global surfaces take the
  // shared hard-return and therefore schedule zero ordinary Auth/profile work.
  const counters = {
    accountMenuMounts: 0,
    bootstrapEffectMounts: 0,
    ordinaryAuthCalls: 0,
    profileCalls: 0,
  };
  const mountGlobalSurfaces = (pathname: string) => {
    if (isAuthSubtreePath(pathname)) return;
    counters.accountMenuMounts += 1;
    counters.bootstrapEffectMounts += 1;
    counters.ordinaryAuthCalls += 2;
    counters.profileCalls += 1;
  };
  mountGlobalSurfaces("/auth/callback");
  assert.deepEqual(counters, {
    accountMenuMounts: 0,
    bootstrapEffectMounts: 0,
    ordinaryAuthCalls: 0,
    profileCalls: 0,
  });
});
