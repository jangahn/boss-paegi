import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import {
  createElement,
  Suspense,
  useEffect,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";

const repositoryRoot = path.resolve(
  import.meta.dirname,
  "../..",
);
const verifyBuiltHtml =
  process.env.BOSS_PAEGI_VERIFY_BUILT_HTML === "1";

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return port;
}

function markupWithoutScripts(html: string): string {
  return html.replace(
    /<script\b[^>]*>[\s\S]*?<\/script>/giu,
    "",
  );
}

test("the SSR-preserving hydration fence renders content before running descendant effects", async () => {
  let ready = false;
  let releasePending: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    releasePending = resolve;
  });
  let descendantEffects = 0;

  function Fence({
    browser,
    children,
  }: {
    browser: boolean;
    children?: ReactNode;
  }) {
    if (browser && !ready) throw pending;
    return children;
  }

  function AuthSensitiveChild() {
    useEffect(() => {
      descendantEffects += 1;
    }, []);
    return createElement("h1", null, "공개·법무 본문");
  }

  const serverMarkup = renderToStaticMarkup(
    createElement(
      Suspense,
      { fallback: null },
      createElement(
        Fence,
        { browser: false },
        createElement(AuthSensitiveChild),
      ),
    ),
  );
  assert.match(serverMarkup, /<h1>공개·법무 본문<\/h1>/u);
  assert.equal(descendantEffects, 0);

  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        Suspense,
        { fallback: null },
        createElement(
          Fence,
          { browser: true },
          createElement(AuthSensitiveChild),
        ),
      ),
    );
  });
  assert.equal(renderer?.toJSON(), null);
  assert.equal(descendantEffects, 0);

  await act(async () => {
    ready = true;
    releasePending?.();
    await pending;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });
  assert.equal(
    (renderer?.toJSON() as TestRenderer.ReactTestRendererJSON)
      .children?.[0],
    "공개·법무 본문",
  );
  assert.equal(descendantEffects, 1);
  await act(async () => {
    renderer?.unmount();
  });
});

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    }),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 5_000);
    }),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

test(
  "the production build returns public and legal h1 content in the initial HTML",
  { skip: !verifyBuiltHtml, timeout: 90_000 },
  async (t) => {
    assert.equal(
      existsSync(path.join(repositoryRoot, ".next", "BUILD_ID")),
      true,
      "run npm run build before the build-artifact regression",
    );
    const port = await reservePort();
    const output: string[] = [];
    const child = spawn(
      process.execPath,
      [
        path.join(
          repositoryRoot,
          "node_modules",
          "next",
          "dist",
          "bin",
          "next",
        ),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_ENV: "production",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const capture = (chunk: Buffer) => {
      output.push(chunk.toString("utf8"));
      if (output.join("").length > 128 * 1024) output.shift();
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    t.after(() => stopServer(child));

    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 45_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(origin, {
          redirect: "manual",
          signal: AbortSignal.timeout(2_000),
        });
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // The production server is still starting.
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
    }
    assert.equal(
      ready,
      true,
      `Next production server did not become ready:\n${output.join("")}`,
    );

    const surfaces = [
      {
        path: "/",
        h1: /<h1\b[^>]*>[\s\S]*?직장인 스트레스 해소 게임[\s\S]*?<\/h1>/iu,
      },
      {
        path: "/faq",
        h1: /<h1\b[^>]*>[\s\S]*?소개[\s\S]*?<\/h1>/iu,
      },
      {
        path: "/terms",
        h1: /<h1\b[^>]*>[\s\S]*?이용약관[\s\S]*?<\/h1>/iu,
      },
      {
        path: "/privacy",
        h1: /<h1\b[^>]*>[\s\S]*?개인정보처리방침[\s\S]*?<\/h1>/iu,
      },
    ] as const;

    for (const surface of surfaces) {
      const response = await fetch(`${origin}${surface.path}`, {
        headers: { accept: "text/html" },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(
        response.status,
        200,
        `${surface.path} returned ${response.status}`,
      );
      assert.match(
        response.headers.get("content-type") ?? "",
        /^text\/html(?:;|$)/iu,
      );
      const markup = markupWithoutScripts(await response.text());
      assert.match(markup, surface.h1, surface.path);
      assert.doesNotMatch(
        markup,
        /<main\b[^>]*min-h-\[60vh\][^>]*>[\s\S]*?로그인 상태를 확인하고/iu,
        `${surface.path} regressed to the blocking bootstrap spinner`,
      );
    }
  },
);
