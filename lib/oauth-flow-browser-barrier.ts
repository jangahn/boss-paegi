import {
  isOAuthFlowId,
} from "./oauth-flow-lease.ts";

export const OAUTH_FLOW_BROWSER_BARRIER_KEY =
  "boss-paegi:oauth-flow-barrier:v1";

type BarrierRecord = {
  version: 1;
  flowId: string;
};

function storage(): Storage {
  if (
    typeof window === "undefined" ||
    !window.localStorage
  ) {
    throw new Error("oauth_flow_browser_barrier_unavailable");
  }
  return window.localStorage;
}

function parseBarrier(raw: string | null): BarrierRecord | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("oauth_flow_browser_barrier_invalid");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("oauth_flow_browser_barrier_invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !keys.includes("version") ||
    !keys.includes("flowId") ||
    record.version !== 1 ||
    !isOAuthFlowId(record.flowId)
  ) {
    throw new Error("oauth_flow_browser_barrier_invalid");
  }
  return { version: 1, flowId: record.flowId };
}

export function readOAuthFlowBrowserBarrier(): string | null {
  return parseBarrier(
    storage().getItem(OAUTH_FLOW_BROWSER_BARRIER_KEY),
  )?.flowId ?? null;
}

/**
 * Invalid/unreadable durable state is a fail-closed barrier. SessionBootstrap
 * sends that browser to flow discovery before any ordinary Auth writer; the
 * recovery page may reconcile it only after an exact flow-bound full/terminal
 * receipt. Queryless session absence is not authority to delete unknown bytes.
 * A browser that denies storage entirely cannot safely participate in session
 * mutation because a previously committed barrier cannot be excluded.
 */
export function browserHasOAuthFlowDurableBarrier(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return readOAuthFlowBrowserBarrier() !== null;
  } catch {
    return true;
  }
}

/**
 * Repairs only the one exact barrier key after the server has returned an
 * exact full (active=true) or privacy-minimal terminal receipt for flowId.
 * A valid different flow is never overwritten. Malformed bytes are not
 * authority and may be replaced only at this post-receipt boundary.
 */
export function reconcileOAuthFlowBrowserBarrier(
  flowId: string,
  active: boolean,
): void {
  if (!isOAuthFlowId(flowId)) {
    throw new Error("oauth_flow_browser_barrier_invalid");
  }
  const target = storage();
  const raw = target.getItem(OAUTH_FLOW_BROWSER_BARRIER_KEY);
  let current: BarrierRecord | null = null;
  try {
    current = parseBarrier(raw);
  } catch {
    target.removeItem(OAUTH_FLOW_BROWSER_BARRIER_KEY);
    if (target.getItem(OAUTH_FLOW_BROWSER_BARRIER_KEY) !== null) {
      throw new Error("oauth_flow_browser_barrier_unavailable");
    }
  }
  if (current && current.flowId !== flowId) {
    throw new Error("oauth_flow_browser_barrier_changed");
  }
  if (active) {
    target.setItem(
      OAUTH_FLOW_BROWSER_BARRIER_KEY,
      JSON.stringify({ version: 1, flowId }),
    );
    if (readOAuthFlowBrowserBarrier() !== flowId) {
      throw new Error("oauth_flow_browser_barrier_unavailable");
    }
    return;
  }
  target.removeItem(OAUTH_FLOW_BROWSER_BARRIER_KEY);
  if (target.getItem(OAUTH_FLOW_BROWSER_BARRIER_KEY) !== null) {
    throw new Error("oauth_flow_browser_barrier_unavailable");
  }
}

/**
 * Must run under H→outer exact S, after older SDK work has drained.
 * Persistence/readback is part of the precondition for issuing server intent.
 */
export function stageOAuthFlowBrowserBarrier(flowId: string): void {
  if (!isOAuthFlowId(flowId)) {
    throw new Error("oauth_flow_browser_barrier_invalid");
  }
  const target = storage();
  const current = parseBarrier(
    target.getItem(OAUTH_FLOW_BROWSER_BARRIER_KEY),
  );
  if (current && current.flowId !== flowId) {
    throw new Error("oauth_flow_already_active");
  }
  target.setItem(
    OAUTH_FLOW_BROWSER_BARRIER_KEY,
    JSON.stringify({ version: 1, flowId }),
  );
  if (readOAuthFlowBrowserBarrier() !== flowId) {
    throw new Error("oauth_flow_browser_barrier_unavailable");
  }
}

/**
 * CAS release. Callers clear it only after a durable terminal/release receipt,
 * while still holding H→S; a different/new flow is never removed.
 */
export function clearOAuthFlowBrowserBarrier(flowId: string): void {
  if (!isOAuthFlowId(flowId)) {
    throw new Error("oauth_flow_browser_barrier_invalid");
  }
  const target = storage();
  const current = parseBarrier(
    target.getItem(OAUTH_FLOW_BROWSER_BARRIER_KEY),
  );
  if (current === null) return;
  if (current.flowId !== flowId) {
    throw new Error("oauth_flow_browser_barrier_changed");
  }
  target.removeItem(OAUTH_FLOW_BROWSER_BARRIER_KEY);
  if (target.getItem(OAUTH_FLOW_BROWSER_BARRIER_KEY) !== null) {
    throw new Error("oauth_flow_browser_barrier_unavailable");
  }
}
