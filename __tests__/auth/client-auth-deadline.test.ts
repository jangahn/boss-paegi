import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createBrowserClient } from "@supabase/ssr";
import ts from "typescript";
import { createAbortableFetch } from "../../lib/http/abortable-fetch.ts";
import {
  createSynchronousFetchScope,
  getOrCreateSynchronousFetchScope,
} from "../../lib/http/synchronous-fetch-scope.ts";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("signal-bound SDK fetch forwards owner cancellation", async () => {
  const owner = new AbortController();
  let observed: AbortSignal | null = null;
  const fetcher = ((
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    observed = init?.signal ?? null;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    });
  }) as typeof fetch;
  const request = createAbortableFetch(owner.signal, fetcher)(
    "https://example.test/auth",
  );
  const expected = new Error("owner_disposed");
  owner.abort(expected);
  await assert.rejects(
    request,
    (error: unknown) => error === expected,
  );
  assert.equal(
    (observed as AbortSignal | null)?.aborted,
    true,
  );
});

test("synchronous fetch scopes isolate overlapping owners and restore ordinary fetch", async () => {
  const observed = new Map<
    string,
    {
      signal: AbortSignal | null;
      resolve: (response: Response) => void;
      reject: (error: unknown) => void;
    }
  >();
  const fetcher = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) =>
    new Promise<Response>((resolve, reject) => {
      const key = String(input);
      const signal = init?.signal ?? null;
      observed.set(key, { signal, resolve, reject });
      signal?.addEventListener(
        "abort",
        () => reject(signal.reason),
        { once: true },
      );
    })) as typeof fetch;
  const scope = createSynchronousFetchScope(fetcher);
  const firstOwner = new AbortController();
  const secondOwner = new AbortController();

  const first = scope.start(
    firstOwner.signal,
    () => scope.fetch("https://example.test/first"),
  );
  const second = scope.start(
    secondOwner.signal,
    () => scope.fetch("https://example.test/second"),
  );
  const ordinary = scope.fetch("https://example.test/ordinary");

  const firstSignal = observed.get("https://example.test/first")?.signal;
  const secondSignal = observed.get("https://example.test/second")?.signal;
  assert.ok(firstSignal);
  assert.ok(secondSignal);
  assert.notEqual(firstSignal, secondSignal);
  assert.equal(
    observed.get("https://example.test/ordinary")?.signal,
    null,
  );

  const firstReason = new Error("first_disposed");
  firstOwner.abort(firstReason);
  await assert.rejects(first, (error: unknown) => error === firstReason);
  assert.equal(secondSignal.aborted, false);

  observed
    .get("https://example.test/second")
    ?.resolve(new Response(null, { status: 204 }));
  observed
    .get("https://example.test/ordinary")
    ?.resolve(new Response(null, { status: 204 }));
  await Promise.all([second, ordinary]);
});

test("pre-aborted synchronous fetch scope never starts SDK work", async () => {
  const scope = createSynchronousFetchScope(
    (() => Promise.resolve(new Response())) as typeof fetch,
  );
  const owner = new AbortController();
  const reason = new Error("already_disposed");
  owner.abort(reason);
  let started = false;

  await assert.rejects(
    scope.start(owner.signal, async () => {
      started = true;
      return "late";
    }),
    (error: unknown) => error === reason,
  );
  assert.equal(started, false);
});

test("fetch scope keeps body transport abortable until the SDK operation settles", async () => {
  let observedSignal: AbortSignal | null = null;
  let headersReceived!: () => void;
  const headers = new Promise<void>((resolve) => {
    headersReceived = resolve;
  });
  const fetcher = (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    assert.ok(init?.signal);
    observedSignal = init.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener(
          "abort",
          () => controller.error(init.signal?.reason),
          { once: true },
        );
        headersReceived();
      },
    });
    return new Response(body);
  }) as typeof fetch;
  const scope = createSynchronousFetchScope(fetcher);
  const owner = new AbortController();
  const running = scope.start(owner.signal, async () => {
    const response = await scope.fetch(
      "https://example.test/slow-body",
    );
    return response.text();
  });

  await headers;
  owner.abort(new Error("body_read_disposed"));
  assert.equal(
    (observedSignal as AbortSignal | null)?.aborted,
    true,
  );
  await assert.rejects(running);
});

test("exclusive fetch scope is FIFO and skips an aborted queued mutation", async () => {
  const scope = createSynchronousFetchScope(
    (() => Promise.resolve(new Response())) as typeof fetch,
  );
  const firstOwner = new AbortController();
  const secondOwner = new AbortController();
  let releaseFirst!: (value: string) => void;
  let secondStarted = false;
  const first = scope.startExclusive(
    firstOwner.signal,
    () =>
      new Promise<string>((resolve) => {
        releaseFirst = resolve;
      }),
  );
  const second = scope.startExclusive(
    secondOwner.signal,
    async () => {
      secondStarted = true;
      return "second";
    },
  );

  await Promise.resolve();
  assert.equal(secondStarted, false);
  const reason = new Error("queued_mutation_disposed");
  secondOwner.abort(reason);
  releaseFirst("first");
  assert.equal(await first, "first");
  await assert.rejects(second, (error: unknown) => error === reason);
  assert.equal(secondStarted, false);
});

test("Fast Refresh reuses the fetch scope retained by the browser singleton", async () => {
  const registry: Record<symbol, unknown> = {};
  const key = Symbol.for("boss-paegi.test.auth-request-scope");
  let observedSignal: AbortSignal | null = null;
  const fetchers: string[] = [];
  const retainedFetcher = ((
    _input: RequestInfo | URL,
  ) => {
    fetchers.push("retained");
    return Promise.resolve(new Response());
  }) as typeof fetch;
  const retainedScope = getOrCreateSynchronousFetchScope(
    registry,
    key,
    retainedFetcher,
  );
  const refreshedScope = getOrCreateSynchronousFetchScope(
    registry,
    key,
    ((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) =>
      new Promise<Response>((_resolve, reject) => {
        fetchers.push("refreshed");
        observedSignal = init?.signal ?? null;
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      })) as typeof fetch,
  );
  assert.equal(refreshedScope, retainedScope);

  const owner = new AbortController();
  const request = refreshedScope.start(
    owner.signal,
    () => refreshedScope.fetch("https://example.test/hmr"),
  );
  const reason = new Error("hmr_request_disposed");
  owner.abort(reason);
  assert.equal(
    (observedSignal as AbortSignal | null)?.aborted,
    true,
  );
  await assert.rejects(request, (error: unknown) => error === reason);
  assert.deepEqual(fetchers, ["refreshed"]);
});

test("installed auth SDK synchronously captures independent mutation signals", async () => {
  const observed: AbortSignal[] = [];
  let responseMode: "pending" | "success" = "pending";
  const fetcher = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    assert.ok(init?.signal);
    observed.push(init.signal);
    if (responseMode === "success") {
      const anonymous = String(input).endsWith("/signup");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: anonymous
              ? "anonymous-access"
              : "member-access",
            refresh_token: anonymous
              ? "anonymous-refresh"
              : "member-refresh",
            expires_in: 3600,
            token_type: "bearer",
            user: {
              id: anonymous ? "anonymous-user" : "member-user",
              aud: "authenticated",
              role: "authenticated",
              is_anonymous: anonymous,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    }
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    });
  }) as typeof fetch;
  const scope = createSynchronousFetchScope(fetcher);
  const client = createBrowserClient(
    "https://auth-signal-proof.supabase.co",
    "public-anon-key",
    {
      isSingleton: false,
      cookies: { getAll: () => [], setAll: () => {} },
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
      global: { fetch: scope.fetch },
    },
  );
  const anonymousOwner = new AbortController();
  const passwordOwner = new AbortController();
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const anonymous = scope.startExclusive(
      anonymousOwner.signal,
      () => client.auth.signInAnonymously(),
    );
    const password = scope.startExclusive(
      passwordOwner.signal,
      () =>
        client.auth.signInWithPassword({
          email: "reviewer@example.test",
          password: "not-a-secret",
        }),
    );

    await Promise.resolve();
    assert.equal(observed.length, 1);
    anonymousOwner.abort(new Error("anonymous_disposed"));
    assert.equal(observed[0].aborted, true);
    const anonymousResult = await anonymous;
    assert.ok(anonymousResult.error);
    await Promise.resolve();
    assert.equal(observed.length, 2);
    assert.notEqual(observed[0], observed[1]);
    assert.equal(observed[1].aborted, false);
    passwordOwner.abort(new Error("password_disposed"));
    const passwordResult = await password;
    assert.ok(passwordResult.error);

    responseMode = "success";
    const anonymousSuccess = scope.startExclusive(
      new AbortController().signal,
      () => client.auth.signInAnonymously(),
    );
    const passwordSuccess = scope.startExclusive(
      new AbortController().signal,
      () =>
        client.auth.signInWithPassword({
          email: "reviewer@example.test",
          password: "not-a-secret",
        }),
    );
    assert.equal((await anonymousSuccess).error, null);
    assert.equal((await passwordSuccess).error, null);
    const {
      data: { session },
      error: sessionError,
    } = await client.auth.getSession();
    assert.equal(sessionError, null);
    assert.equal(session?.user.id, "member-user");
  } finally {
    console.error = originalConsoleError;
  }
});

test("installed SSR default is browser-only singleton and server calls stay distinct", () => {
  const script = String.raw`
    const { createBrowserClient } = await import("@supabase/ssr");
    const serverOptions = {
      cookies: { getAll: () => [], setAll: () => {} },
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: true
      },
      global: {
        fetch: async () => new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
    };
    const serverClients = [
      createBrowserClient(
        "https://server-default-proof.supabase.co",
        "public-anon-key",
        serverOptions
      ),
      createBrowserClient(
        "https://server-default-proof.supabase.co",
        "public-anon-key",
        serverOptions
      )
    ];
    await Promise.all(serverClients.map((client) => client.auth.initialize()));
    const serverDistinct = new Set(serverClients).size;
    await Promise.all(serverClients.map((client) => client.auth.dispose()));

    globalThis.document = { visibilityState: "visible" };
    globalThis.window = {
      document: globalThis.document,
      location: {
        href: "https://app.example.test/",
        origin: "https://app.example.test"
      },
      addEventListener() {},
      removeEventListener() {}
    };
    globalThis.BroadcastChannel = class {
      addEventListener() {}
      removeEventListener() {}
      postMessage() {}
      close() {}
    };
    const warnings = [];
    console.warn = (...args) => warnings.push(args.map(String).join(" "));
    const options = {
      cookies: { getAll: () => [], setAll: () => {} },
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: true
      },
      global: {
        fetch: async () => new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
    };
    const first = createBrowserClient(
      "https://singleton-proof.supabase.co",
      "public-anon-key",
      options
    );
    const clients = [
      first,
      ...Array.from(
        { length: 6 },
        () => createBrowserClient(
          "https://singleton-proof.supabase.co",
          "public-anon-key",
          options
        )
      )
    ];
    await first.auth.initialize();
    await first.auth.dispose();
    process.stdout.write(JSON.stringify({
      serverDistinct,
      browserDistinct: new Set(clients).size,
      optionsExplicitlyOverrideSingleton:
        Object.prototype.hasOwnProperty.call(options, "isSingleton"),
      duplicateWarnings: warnings.filter(
        (warning) => warning.includes("Multiple GoTrueClient instances")
      ).length
    }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: new URL("../..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    serverDistinct: 2,
    browserDistinct: 1,
    optionsExplicitlyOverrideSingleton: false,
    duplicateWarnings: 0,
  });
});

type NamedFunction =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration;

function parsedSource(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source(path),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  );
}

function namedFunction(
  path: string,
  name: string,
): { file: ts.SourceFile; declaration: NamedFunction } {
  const file = parsedSource(path);
  let declaration: NamedFunction | undefined;
  const visit = (node: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node)) &&
      node.name?.getText(file) === name
    ) {
      if (declaration) {
        throw new Error(`duplicate_function:${path}:${name}`);
      }
      declaration = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!declaration?.body) {
    throw new Error(`missing_function_body:${path}:${name}`);
  }
  return { file, declaration };
}

function callExpressions(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (candidate: ts.Node) => {
    if (ts.isCallExpression(candidate)) calls.push(candidate);
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return calls;
}

function callName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) {
    return call.expression.text;
  }
  if (ts.isPropertyAccessExpression(call.expression)) {
    return call.expression.name.text;
  }
  return null;
}

function callsNamed(node: ts.Node, name: string): ts.CallExpression[] {
  return callExpressions(node).filter(
    (call) => callName(call) === name,
  );
}

function wrappedWriterTargets(path: string): string[] {
  const writerMethods = new Set([
    "signInAnonymously",
    "signInWithPassword",
    "signInWithOAuth",
  ]);
  const file = parsedSource(path);
  return callsNamed(file, "startSupabaseUnlockedSessionWriter").flatMap(
    (wrapper) => {
      const operation = wrapper.arguments[1];
      assert.ok(
        operation &&
          (ts.isArrowFunction(operation) ||
            ts.isFunctionExpression(operation)),
        `${path}: writer wrapper must receive an inline operation`,
      );
      const targets = callExpressions(operation)
        .map(callName)
        .filter(
          (name): name is string =>
            name !== null && writerMethods.has(name),
        );
      assert.ok(
        targets.length <= 1,
        `${path}: one SDK lock scope cannot contain multiple unlocked writers`,
      );
      // The same primitive also owns broader H→S reconciliation scopes whose
      // session mutation is a verified cookie clear rather than an auth-js
      // writer. They are not writer-wrapper coverage targets.
      return targets;
    },
  );
}

test("production client uses the official browser-only singleton default and exactly wraps auth-js unlocked writers", () => {
  const createClientFunction = namedFunction(
    "lib/supabase/client.ts",
    "createClient",
  );
  const createClientBody = createClientFunction.declaration.body;
  assert.ok(createClientBody);
  assert.equal(
    callsNamed(createClientBody, "createBrowserClient").length,
    1,
  );
  const singletonOverrides: ts.Node[] = [];
  const visitSingletonOverrides = (node: ts.Node) => {
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node)) &&
      node.name.getText(createClientFunction.file) ===
        "isSingleton"
    ) {
      singletonOverrides.push(node);
    }
    ts.forEachChild(node, visitSingletonOverrides);
  };
  visitSingletonOverrides(createClientBody);
  assert.equal(singletonOverrides.length, 0);

  const lockWrapper = namedFunction(
    "lib/supabase/client.ts",
    "runSupabaseUnlockedSessionWriter",
  );
  const lockWrapperBody = lockWrapper.declaration.body;
  assert.ok(lockWrapperBody);
  const lockCalls = callsNamed(
    lockWrapperBody,
    "exactSupabaseAuthLock",
  );
  assert.equal(lockCalls.length, 1);
  assert.equal(
    lockCalls[0].arguments[0]?.getText(lockWrapper.file),
    "authSdkLockName()",
  );
  assert.equal(
    lockCalls[0].arguments[1]?.getText(lockWrapper.file),
    "-1",
  );
  assert.equal(
    lockCalls[0].arguments[2]?.getText(lockWrapper.file),
    "operation",
  );

  const wrapped = [
    ...wrappedWriterTargets("lib/supabase/client.ts"),
    ...wrappedWriterTargets("lib/auth-oauth.ts"),
  ].sort();
  assert.deepEqual(wrapped, [
    "signInAnonymously",
    "signInWithOAuth",
    "signInWithPassword",
  ]);
});

test("installed auth-js version keeps only the three app-wrapped writers outside its legacy lock", () => {
  const authPackage = JSON.parse(
    source("node_modules/@supabase/auth-js/package.json"),
  ) as { version?: unknown };
  assert.equal(authPackage.version, "2.107.0");

  const authSource =
    "node_modules/@supabase/auth-js/src/GoTrueClient.ts";
  for (const method of [
    "signInAnonymously",
    "signInWithPassword",
    "signInWithOAuth",
    "_handleProviderSignIn",
    "_getUrlForProvider",
  ]) {
    const declaration = namedFunction(authSource, method).declaration;
    assert.ok(declaration.body);
    assert.equal(
      callsNamed(declaration.body, "_acquireLock").length,
      0,
      `${method} became internally locked; remove the app wrapper before upgrading`,
    );
  }

  for (const method of [
    "initialize",
    "getSession",
    "getUser",
    "signOut",
  ]) {
    const declaration = namedFunction(authSource, method).declaration;
    assert.ok(declaration.body);
    assert.equal(
      callsNamed(declaration.body, "_acquireLock").length,
      1,
      `${method} must remain SDK-locked and must never enter the app writer wrapper`,
    );
  }
});
