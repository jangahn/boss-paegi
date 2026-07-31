"use client";

import {
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { ensureAuth } from "@/lib/auth-client";
import {
  createClient,
  startSupabaseUnlockedSessionWriter,
} from "@/lib/supabase/client";
import {
  clearProfileCache,
  getMyProfile,
} from "@/lib/profile";
import {
  clearSentryIdentity,
  setSentryIdentity,
} from "@/lib/sentry-context";
import { drainScoreSubmissionOutbox } from "@/lib/score-outbox";
import { markPlayConversionSent } from "@/lib/acquisition";
import { log, errInfo } from "@/lib/log";
import {
  acquireSessionReconciliation,
} from "@/lib/session-reconciliation";
import { isOAuthFlowId } from "@/lib/oauth-flow-lease";
import {
  reconcileOAuthFlowBrowserBarrier,
  readOAuthFlowBrowserBarrier,
} from "@/lib/oauth-flow-browser-barrier";
import {
  resolveOAuthFlowBrowserRecoveryPath,
} from "@/lib/oauth-flow-browser-recovery";
import { isAuthSubtreePath } from "@/lib/routes";
import {
  readExactVisibleOAuthCallbackFlow,
} from "@/lib/http/auth-transport-fetch";
import {
  parseOAuthFlowDiscoveredStatus,
  parseOAuthFlowDiscoveryAbsent,
  parseOAuthFlowMinimalRecovery,
} from "@/lib/oauth-flow-status";
import {
  readBoundedClientJsonResponse,
} from "@/lib/client-mutation";
import {
  runAuthCrossContextExclusive,
} from "@/lib/auth-cross-context";

const OAUTH_DISCOVERY_MAX_RESPONSE_BYTES = 64 * 1024;

type OrdinaryHydrationGate = {
  readonly ready: boolean;
  readonly pending: Promise<void>;
  readonly release: () => void;
};

function createOrdinaryHydrationGate(): OrdinaryHydrationGate {
  let ready = false;
  let resolvePending: (() => void) | null = null;
  const pending = new Promise<void>((resolve) => {
    resolvePending = resolve;
  });
  return {
    get ready() {
      return ready;
    },
    pending,
    release() {
      if (ready) return;
      ready = true;
      resolvePending?.();
      resolvePending = null;
    },
  };
}

function discoveredMinimalFlowId(value: unknown): string | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const flowId = (value as Record<string, unknown>).flowId;
  return isOAuthFlowId(flowId) &&
    parseOAuthFlowMinimalRecovery(value, flowId)
    ? flowId
    : null;
}

async function discoverOAuthFlowBeforeBootstrap(
  signal: AbortSignal,
): Promise<string | null> {
  return runAuthCrossContextExclusive(signal, () =>
    startSupabaseUnlockedSessionWriter(signal, async () => {
      const response = await fetch(
        "/api/auth/oauth-flow/status",
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ flowId: null }),
          signal,
        },
      );
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase();
      const parsed = await readBoundedClientJsonResponse(
        response,
        OAUTH_DISCOVERY_MAX_RESPONSE_BYTES,
        signal,
      );
      if (
        response.status !== 200 ||
        contentType !== "application/json" ||
        !parsed.ok
      ) {
        throw new Error(
          `oauth_flow_discovery_${response.status}`,
        );
      }
      if (parseOAuthFlowDiscoveryAbsent(parsed.value)) {
        if (
          readExactVisibleOAuthCallbackFlow() !== null ||
          readOAuthFlowBrowserBarrier() !== null
        ) {
          throw new Error(
            "oauth_flow_discovery_absence_mismatch",
          );
        }
        return null;
      }
      const status =
        parseOAuthFlowDiscoveredStatus(parsed.value);
      const flowId =
        status?.flowId ??
        discoveredMinimalFlowId(parsed.value);
      if (flowId === null) {
        throw new Error(
          "oauth_flow_discovery_response_invalid",
        );
      }
      if (status) {
        if (
          readExactVisibleOAuthCallbackFlow() !== flowId
        ) {
          throw new Error(
            "oauth_flow_discovery_marker_not_confirmed",
          );
        }
        reconcileOAuthFlowBrowserBarrier(flowId, true);
        if (readOAuthFlowBrowserBarrier() !== flowId) {
          throw new Error(
            "oauth_flow_discovery_barrier_unavailable",
          );
        }
      }
      return flowId;
    }),
  );
}

/**
 * 앱 진입 시 익명 세션을 보장 (없으면 생성) + Sentry user(userKey+닉네임) 부착.
 * 어느 페이지에서든 supabase 쿼리를 바로 쓸 수 있게.
 */
function SessionBootstrapEffects({
  onReady,
}: {
  onReady: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // The outer route gate prevents this component from mounting on `/auth`.
    // Recheck the live URL before starting work to close a router snapshot /
    // effect scheduling race during navigation into the Auth subtree.
    if (isAuthSubtreePath(window.location.pathname)) {
      return;
    }
    const recoveryPath =
      resolveOAuthFlowBrowserRecoveryPath(document.cookie);
    if (recoveryPath !== null) {
      window.location.replace(recoveryPath);
      return;
    }
    const controller = new AbortController();
    let reconciliation:
      | ReturnType<typeof acquireSessionReconciliation>
      | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    // ensureAuth() 가 실패 시 이미 log.error("auth.anon_sign_in_fail") 를 남기므로
    // 여기서 또 로깅하면 같은 사건이 두 줄(레벨·포맷 불일치)로 갈린다 → 침묵.
    (async () => {
      const discoveredFlow =
        await discoverOAuthFlowBeforeBootstrap(
          controller.signal,
        );
      if (discoveredFlow !== null) {
        window.location.replace(
          `/auth/flow-pending?flow=${encodeURIComponent(discoveredFlow)}`,
        );
        return;
      }
      const sb = createClient();
      reconciliation = acquireSessionReconciliation({
        readCurrentUserId: async () => {
          const { data, error } = await sb.auth.getSession();
          if (error) throw error;
          return data.session?.user.id ?? null;
        },
        subscribeAuthChanges: (listener) => {
          const {
            data: { subscription },
          } = sb.auth.onAuthStateChange((event, session) => {
            // Never await another auth call inside Supabase's callback. The
            // reconciler defers and serializes the authoritative getSession.
            listener(event, session?.user.id ?? null);
          });
          return () => subscription.unsubscribe();
        },
        clearProfileCache,
        clearSentryIdentity,
      });
      const session = await ensureAuth(controller.signal);
      // Auth events emitted by the expected bootstrap sign-in are ignored
      // until this baseline is stable, then confirmed by a fresh getSession.
      reconciliation.completeBootstrap(session.user.id);
      // session.user.email — 멤버=값, 익명=null. 이미 세션에 있어 추가 DB 조회 X.
      // (email 은 Sentry 식별 + admin 추출 전용 — getMyProfile/캐시엔 넣지 않음.)
      const email = session.user.email ?? undefined;
      setSentryIdentity(session.user.id, undefined, email); // 닉네임 조회 전에 userKey+email 먼저
      if (controller.signal.aborted) return;
      // This is the only ordinary-route hydration release. Until the exact
      // null-flow discovery and stable Auth baseline both finish, the server
      // HTML remains visible but its ordinary client subtree is dehydrated, so
      // no sibling effect, Supabase transport, or storage writer can race the
      // preflight.
      setFailed(false);
      setReady(true);
      onReady();
      // A score/report may have committed immediately before a reload or tab
      // close. Replay the durable body with its original submissionId.
      void drainScoreSubmissionOutbox(session.user.id, {
        signal: controller.signal,
        onSuccess: (entry) => {
          if (entry.body.trackFirstTouchPlay) markPlayConversionSent();
        },
      }).catch((error) => {
        log.warn("score.outbox_drain_fail", errInfo(error));
      });
      try {
        const profile = await getMyProfile(controller.signal);
        setSentryIdentity(
          session.user.id,
          profile?.display_name,
          email,
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          log.warn(
            "auth.bootstrap_profile_fail",
            errInfo(error),
          );
        }
      }
    })().catch(() => {
      if (controller.signal.aborted) return;
      // Discovery and ensureAuth intentionally acquire H in separate phases.
      // If another tab begins OAuth in that gap, the Auth writer fails closed;
      // immediately re-read the live shared hints so this tab converges to the
      // new flow instead of remaining indefinitely on an ordinary page.
      const liveRecoveryPath =
        resolveOAuthFlowBrowserRecoveryPath(document.cookie);
      if (liveRecoveryPath !== null) {
        window.location.replace(liveRecoveryPath);
        return;
      }
      // A transient discovery/Auth failure is not evidence that an already
      // stable identity changed. Document invalidation would make the page
      // inert and reload it, defeating the bounded local retry below. Dispose
      // this attempt's observer and let the next attempt acquire a clean owner.
      reconciliation?.release();
      reconciliation = null;
      setFailed(true);
      retry = setTimeout(() => {
        setAttempt((value) => value + 1);
      }, 5_000);
    });
    return () => {
      controller.abort();
      if (retry) clearTimeout(retry);
      reconciliation?.release();
    };
  }, [attempt, onReady]);

  if (ready) return null;
  return (
    <p
      role={failed ? "alert" : "status"}
      aria-live="polite"
      className="sr-only"
    >
      {failed
        ? "안전한 로그인 상태를 다시 확인하고 있어요."
        : "로그인 상태를 확인하고 있어요…"}
    </p>
  );
}

/**
 * Render ordinary content into the initial server HTML, but suspend its
 * browser hydration until OAuth discovery and the Auth baseline are stable.
 *
 * Suspending a completed server-rendered boundary preserves its HTML for
 * reading, indexing, and native navigation while preventing descendant
 * effects and event replay from running before the parent releases the fence.
 */
function OrdinaryHydrationFence({
  gate,
  children,
}: {
  gate: OrdinaryHydrationGate;
  children: ReactNode;
}) {
  if (typeof window !== "undefined" && !gate.ready) {
    throw gate.pending;
  }
  return <>{children}</>;
}

function OrdinarySessionBootstrap({
  children,
}: {
  children: ReactNode;
}) {
  const [gate] = useState(createOrdinaryHydrationGate);
  return (
    <>
      <SessionBootstrapEffects onReady={gate.release} />
      <Suspense fallback={null}>
        <OrdinaryHydrationFence gate={gate}>
          {children}
        </OrdinaryHydrationFence>
      </Suspense>
    </>
  );
}

/**
 * Keep ordinary Supabase initialization out of every Auth callback/recovery
 * route. Splitting the effect owner into a child preserves the Rules of Hooks
 * while guaranteeing that the effect itself is never mounted on `/auth`.
 */
export function SessionBootstrap({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  if (isAuthSubtreePath(pathname)) return <>{children}</>;
  return (
    <OrdinarySessionBootstrap>
      {children}
    </OrdinarySessionBootstrap>
  );
}
