"use client";

export const SESSION_RECONCILIATION_CHANNEL =
  "boss-paegi:session-reconciliation:v1";

const SESSION_RECONCILIATION_RUNTIME_KEY = Symbol.for(
  "boss-paegi.session-reconciliation.runtime.v1",
);
// A new module evaluation gets a new identity while duplicate mounts from the
// same evaluation share it. Fast Refresh can therefore replace, never stack,
// an older implementation owner retained behind Symbol.for.
const SESSION_RECONCILIATION_IMPLEMENTATION = {};

const CROSS_TAB_HINT_VERSION = 1;
const CROSS_TAB_HINT_TYPE = "auth-session-changed";
const REMOTE_HINT_SUPPRESSION_MS = 2_000;

export type SessionReconciliationState =
  | { phase: "bootstrapping" }
  | { phase: "stable"; userId: string }
  | {
      phase: "invalidating";
      previousUserId: string | null;
      observedUserId: string | null;
      reason: string;
    };

export type SessionReconciliationController = {
  completeBootstrap: (userId: string) => void;
  failBootstrap: (reason?: string) => void;
  notifyAuthChange: (
    event: string,
    observedUserId: string | null,
    options?: { broadcast?: boolean },
  ) => void;
  notifyExternalHint: (reason: string) => void;
  notifyDocumentResumed: (reason: string) => void;
  getState: () => SessionReconciliationState;
  stop: () => void;
};

export type SessionReconciliationControllerOptions = {
  readCurrentUserId: () => Promise<string | null>;
  invalidate: (args: {
    previousUserId: string | null;
    observedUserId: string | null;
    reason: string;
  }) => void;
  broadcastHint?: () => void;
  defer?: (callback: () => void) => () => void;
};

type ListenerTarget = {
  addEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
  removeEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
};

type ReconciliationWindow = ListenerTarget & {
  location: { reload: () => void };
};

type ReconciliationDocument = ListenerTarget & {
  visibilityState?: string;
  body?: {
    inert?: boolean;
    setAttribute?: (name: string, value: string) => void;
  } | null;
};

type ReconciliationBroadcastChannel = {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) => void;
  removeEventListener: (
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) => void;
  postMessage: (message: unknown) => void;
  close: () => void;
};

export type SessionReconciliationOwnerOptions = {
  readCurrentUserId: () => Promise<string | null>;
  subscribeAuthChanges: (
    listener: (event: string, userId: string | null) => void,
  ) => () => void;
  clearProfileCache: () => void;
  clearSentryIdentity: () => void;
  windowRef?: ReconciliationWindow;
  documentRef?: ReconciliationDocument;
  createBroadcastChannel?: (
    name: string,
  ) => ReconciliationBroadcastChannel | null;
  defer?: (callback: () => void) => () => void;
  now?: () => number;
  reload?: () => void;
};

export type SessionReconciliationOwner = {
  completeBootstrap: (userId: string) => void;
  failBootstrap: (reason?: string) => void;
  release: () => void;
};

type RuntimeOwner = {
  refs: number;
  implementation: object;
  controller: SessionReconciliationController;
  stop: () => void;
};

type SessionReconciliationRuntime = {
  documentMutationController: AbortController;
  invalidated: boolean;
  owner: RuntimeOwner | null;
};

type CrossTabHint = {
  version: typeof CROSS_TAB_HINT_VERSION;
  type: typeof CROSS_TAB_HINT_TYPE;
  senderTabId: string;
};

function defaultDefer(callback: () => void): () => void {
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}

function validUserId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256
  );
}

function normalizeUserId(value: unknown): string | null {
  if (value === null) return null;
  if (validUserId(value)) return value;
  throw new Error("invalid_authoritative_session_user");
}

/**
 * Pure reconciliation state machine. Auth events are only hints: a changed
 * user or SIGNED_OUT event must be confirmed by an authoritative getSession
 * read before the document is invalidated.
 */
export function createSessionReconciliationController(
  options: SessionReconciliationControllerOptions,
): SessionReconciliationController {
  const defer = options.defer ?? defaultDefer;
  let state: SessionReconciliationState = {
    phase: "bootstrapping",
  };
  let active = true;
  let checking = false;
  let pendingCheck:
    | { reason: string; observedUserId: string | null }
    | null = null;
  let scheduledDrain: { cancel: () => void } | null = null;

  const invalidate = (
    reason: string,
    observedUserId: string | null,
  ) => {
    if (!active || state.phase === "invalidating") return;
    const previousUserId =
      state.phase === "stable" ? state.userId : null;
    state = {
      phase: "invalidating",
      previousUserId,
      observedUserId,
      reason,
    };
    try {
      options.invalidate({
        previousUserId,
        observedUserId,
        reason,
      });
    } catch {
      // The state remains irreversibly latched even if an injected cleanup
      // adapter fails. Production invalidation isolates each side effect.
    }
  };

  const armDrain = (
    reason: string,
    observedUserId: string | null,
  ) => {
    if (
      !active ||
      state.phase !== "stable" ||
      checking ||
      scheduledDrain !== null
    ) {
      return;
    }
    const token = { cancel: () => {} };
    scheduledDrain = token;
    let cancellation: (() => void) | undefined;
    try {
      cancellation = defer(() => {
        if (scheduledDrain !== token) return;
        scheduledDrain = null;
        void drainChecks();
      });
    } catch {
      if (scheduledDrain === token) scheduledDrain = null;
      invalidate(
        `${reason}:reconciliation-schedule-failed`,
        observedUserId,
      );
      return;
    }
    if (typeof cancellation !== "function") {
      if (scheduledDrain === token) {
        scheduledDrain = null;
        invalidate(
          `${reason}:reconciliation-schedule-failed`,
          observedUserId,
        );
      }
      return;
    }
    token.cancel = cancellation;
    // A custom scheduler may invoke the callback synchronously. Do not leave
    // a stale scheduled token behind, and dispose the already-fired handle.
    if (scheduledDrain !== token) {
      try {
        cancellation();
      } catch {
        // The callback already started and active/state fence late work.
      }
    }
  };

  const drainChecks = async () => {
    if (checking || !active || state.phase !== "stable") return;
    checking = true;
    try {
      while (
        active &&
        state.phase === "stable" &&
        pendingCheck !== null
      ) {
        const check = pendingCheck;
        pendingCheck = null;
        let currentUserId: string | null;
        try {
          currentUserId = normalizeUserId(
            await options.readCurrentUserId(),
          );
        } catch {
          if (active && state.phase === "stable") {
            invalidate(
              `${check.reason}:authoritative-read-failed`,
              check.observedUserId,
            );
          }
          return;
        }
        if (!active || state.phase !== "stable") return;
        if (currentUserId !== state.userId) {
          invalidate(check.reason, currentUserId);
          return;
        }
      }
    } finally {
      checking = false;
      if (
        active &&
        state.phase === "stable" &&
        pendingCheck !== null &&
        scheduledDrain === null
      ) {
        armDrain(
          pendingCheck.reason,
          pendingCheck.observedUserId,
        );
      }
    }
  };

  const scheduleCheck = (
    reason: string,
    observedUserId: string | null,
  ) => {
    if (!active || state.phase !== "stable") return;
    pendingCheck = { reason, observedUserId };
    armDrain(reason, observedUserId);
  };

  return {
    completeBootstrap(userId) {
      if (!active || state.phase === "invalidating") return;
      if (!validUserId(userId)) {
        invalidate("bootstrap:invalid-user", null);
        return;
      }
      if (state.phase === "bootstrapping") {
        state = { phase: "stable", userId };
        // A server-side OAuth callback updates cookies without emitting a
        // client SDK event. Announce every newly-established baseline so
        // already-open tabs re-read their own authoritative cookie session.
        try {
          options.broadcastHint?.();
        } catch {
          // Focus/visibility/pageshow remain the compatibility fallback.
        }
      }
      scheduleCheck("bootstrap", userId);
    },
    failBootstrap(reason = "bootstrap:failed") {
      invalidate(reason, null);
    },
    notifyAuthChange(event, observedUserId, notifyOptions) {
      if (!active || state.phase !== "stable") return;
      const needsConfirmation =
        event === "SIGNED_OUT" ||
        observedUserId === null ||
        observedUserId !== state.userId;
      if (!needsConfirmation) return;
      if (notifyOptions?.broadcast !== false) {
        try {
          options.broadcastHint?.();
        } catch {
          // The SDK auth event remains available even if BroadcastChannel
          // creation or delivery is unavailable in this browser.
        }
      }
      scheduleCheck(`auth:${event}`, observedUserId);
    },
    notifyExternalHint(reason) {
      scheduleCheck(reason, null);
    },
    notifyDocumentResumed(reason) {
      scheduleCheck(`document:${reason}`, null);
    },
    getState() {
      return { ...state };
    },
    stop() {
      if (!active) return;
      active = false;
      pendingCheck = null;
      try {
        scheduledDrain?.cancel();
      } catch {
        // Cleanup is best-effort; active=false fences any late callback.
      }
      scheduledDrain = null;
    },
  };
}

function browserAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof document !== "undefined"
  );
}

function getRuntime(): SessionReconciliationRuntime | null {
  if (!browserAvailable()) return null;
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const retained = globals[SESSION_RECONCILIATION_RUNTIME_KEY] as
    | SessionReconciliationRuntime
    | undefined;
  if (
    retained &&
    retained.documentMutationController &&
    typeof retained.documentMutationController.abort === "function" &&
    retained.documentMutationController.signal &&
    typeof retained.invalidated === "boolean"
  ) {
    return retained;
  }
  const created: SessionReconciliationRuntime = {
    documentMutationController: new AbortController(),
    invalidated: false,
    owner: null,
  };
  globals[SESSION_RECONCILIATION_RUNTIME_KEY] = created;
  return created;
}

/**
 * Signal shared by every client mutation in the current document. It remains
 * aborted after an auth identity change, so no queued or newly-started
 * mutation can execute under a stale UI actor before the reload completes.
 */
export function getDocumentMutationSignal(): AbortSignal | undefined {
  return getRuntime()?.documentMutationController.signal;
}

function invalidateDocumentOnce(
  runtime: SessionReconciliationRuntime,
  options: SessionReconciliationOwnerOptions,
  documentRef: ReconciliationDocument,
  windowRef: ReconciliationWindow,
  reason: string,
): void {
  if (runtime.invalidated) return;
  runtime.invalidated = true;
  runtime.documentMutationController.abort(
    new Error(`session_document_invalidated:${reason}`),
  );
  try {
    if (documentRef.body) {
      documentRef.body.inert = true;
      documentRef.body.setAttribute?.("aria-busy", "true");
    }
  } catch {
    // Continue clearing identity and reloading even on a partial DOM shim.
  }
  try {
    options.clearProfileCache();
  } catch {
    // A denied localStorage read must not retain the Sentry identity or UI.
  }
  try {
    options.clearSentryIdentity();
  } catch {
    // Reload is still required if the telemetry SDK is unavailable.
  }
  try {
    (options.reload ?? (() => windowRef.location.reload()))();
  } catch {
    // The document remains inert and all client mutations remain aborted.
  }
}

function createTabId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `tab-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2)}`;
  }
}

function isCrossTabHint(value: unknown): value is CrossTabHint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 3 &&
    keys[0] === "senderTabId" &&
    keys[1] === "type" &&
    keys[2] === "version" &&
    record.version === CROSS_TAB_HINT_VERSION &&
    record.type === CROSS_TAB_HINT_TYPE &&
    typeof record.senderTabId === "string" &&
    record.senderTabId.length > 0 &&
    record.senderTabId.length <= 128
  );
}

function defaultBroadcastChannelFactory(
  name: string,
): ReconciliationBroadcastChannel | null {
  const apiName = ["Broadcast", "Channel"].join("");
  const BroadcastChannelConstructor = Reflect.get(
    globalThis,
    apiName,
  ) as
    | (new (channelName: string) => ReconciliationBroadcastChannel)
    | undefined;
  if (typeof BroadcastChannelConstructor !== "function") {
    return null;
  }
  return new BroadcastChannelConstructor(name);
}

/**
 * Owns one document-wide reconciliation subscription. The owner is retained
 * through duplicate SessionBootstrap mounts and stored behind Symbol.for so
 * StrictMode and Fast Refresh cannot create concurrent auth observers.
 */
export function acquireSessionReconciliation(
  options: SessionReconciliationOwnerOptions,
): SessionReconciliationOwner {
  const runtime = getRuntime();
  const windowRef =
    options.windowRef ??
    (browserAvailable()
      ? (window as unknown as ReconciliationWindow)
      : undefined);
  const documentRef =
    options.documentRef ??
    (browserAvailable()
      ? (document as unknown as ReconciliationDocument)
      : undefined);
  if (!runtime || !windowRef || !documentRef) {
    return {
      completeBootstrap() {},
      failBootstrap() {},
      release() {},
    };
  }

  if (
    runtime.owner !== null &&
    runtime.owner.implementation !==
      SESSION_RECONCILIATION_IMPLEMENTATION
  ) {
    runtime.owner.stop();
    runtime.owner = null;
  }

  if (runtime.owner === null) {
    const tabId = createTabId();
    const now = options.now ?? Date.now;
    let remoteHintUntil = 0;
    let channel: ReconciliationBroadcastChannel | null = null;
    const controller = createSessionReconciliationController({
      readCurrentUserId: options.readCurrentUserId,
      defer: options.defer,
      broadcastHint: () => {
        channel?.postMessage({
          version: CROSS_TAB_HINT_VERSION,
          type: CROSS_TAB_HINT_TYPE,
          senderTabId: tabId,
        } satisfies CrossTabHint);
      },
      invalidate: ({ reason }) => {
        invalidateDocumentOnce(
          runtime,
          options,
          documentRef,
          windowRef,
          reason,
        );
      },
    });

    const createChannel =
      options.createBroadcastChannel ??
      defaultBroadcastChannelFactory;
    try {
      channel = createChannel(SESSION_RECONCILIATION_CHANNEL);
    } catch {
      channel = null;
    }

    const onBroadcastMessage = (event: MessageEvent<unknown>) => {
      if (
        !isCrossTabHint(event.data) ||
        event.data.senderTabId === tabId
      ) {
        return;
      }
      remoteHintUntil = now() + REMOTE_HINT_SUPPRESSION_MS;
      controller.notifyExternalHint("cross-tab");
    };
    let channelListenerAdded = false;
    if (channel) {
      try {
        channel.addEventListener("message", onBroadcastMessage);
        channelListenerAdded = true;
      } catch {
        try {
          channel.close();
        } catch {
          // BroadcastChannel is an optional acceleration path.
        }
        channel = null;
      }
    }

    const onVisibilityChange = () => {
      if (documentRef.visibilityState === "visible") {
        controller.notifyDocumentResumed("visibility");
      }
    };
    const onFocus = () => controller.notifyDocumentResumed("focus");
    const onPageShow = () =>
      controller.notifyDocumentResumed("pageshow");
    let visibilityListenerAdded = false;
    let focusListenerAdded = false;
    let pageShowListenerAdded = false;
    try {
      documentRef.addEventListener(
        "visibilitychange",
        onVisibilityChange,
      );
      visibilityListenerAdded = true;
      windowRef.addEventListener("focus", onFocus);
      focusListenerAdded = true;
      windowRef.addEventListener("pageshow", onPageShow);
      pageShowListenerAdded = true;
    } catch {
      controller.failBootstrap(
        "bootstrap:lifecycle-listener-failed",
      );
    }

    let unsubscribeAuth = () => {};
    try {
      const unsubscribe = options.subscribeAuthChanges(
        (event, userId) => {
          controller.notifyAuthChange(event, userId, {
            broadcast: now() >= remoteHintUntil,
          });
        },
      );
      if (typeof unsubscribe !== "function") {
        throw new Error("invalid_auth_subscription_disposer");
      }
      unsubscribeAuth = unsubscribe;
    } catch {
      controller.failBootstrap("bootstrap:subscription-failed");
    }

    runtime.owner = {
      refs: 0,
      implementation: SESSION_RECONCILIATION_IMPLEMENTATION,
      controller,
      stop: () => {
        controller.stop();
        try {
          unsubscribeAuth();
        } catch {
          // Ignore an SDK disposer failure; the controller is already fenced.
        }
        if (visibilityListenerAdded) {
          documentRef.removeEventListener(
            "visibilitychange",
            onVisibilityChange,
          );
        }
        if (focusListenerAdded) {
          windowRef.removeEventListener("focus", onFocus);
        }
        if (pageShowListenerAdded) {
          windowRef.removeEventListener("pageshow", onPageShow);
        }
        try {
          if (channelListenerAdded) {
            channel?.removeEventListener(
              "message",
              onBroadcastMessage,
            );
          }
          channel?.close();
        } catch {
          // No live controller remains to consume a late channel event.
        }
      },
    };
  }

  const owner = runtime.owner;
  owner.refs += 1;
  let released = false;
  return {
    completeBootstrap(userId) {
      if (!released) owner.controller.completeBootstrap(userId);
    },
    failBootstrap(reason) {
      if (!released) owner.controller.failBootstrap(reason);
    },
    release() {
      if (released) return;
      released = true;
      owner.refs -= 1;
      if (owner.refs === 0 && runtime.owner === owner) {
        owner.stop();
        runtime.owner = null;
      }
    },
  };
}
