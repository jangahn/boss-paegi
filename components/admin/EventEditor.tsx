"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Spinner } from "@/components/Spinner";
import { FadeImg } from "@/components/FadeImg";
import { ModalShell } from "@/components/ModalShell";
import { Markdown } from "@/components/events/Markdown";
import { createClient } from "@/lib/supabase/client";
import {
  parseAdminUploadConfirmAck,
  parseAdminUploadInitAck,
} from "@/lib/admin-upload-http-contract";
import { PUBLIC_ENV } from "@/lib/env";
import { EVENTS_BUCKET } from "@/lib/storage-path";
import { EVENT_TYPES, EVENT_TYPE_LABEL, type EventType, type EventView } from "@/lib/events/types";
import {
  clearClientUploadOperation,
  stableClientUploadOperation,
} from "@/lib/client-upload-operation";
import {
  isOperationRequestId,
  parseAdminEventMutationResult,
  parseAdminMutationReceipt,
  type AdminEventMutationResult,
} from "@/lib/admin-mutation";
import {
  clientMutationResponseNeedsReconciliation,
  runClientMutation,
  runReplayedJsonMutation,
} from "@/lib/client-mutation";
import { useClientOperationScope } from "@/lib/use-client-operation-scope";

/** ISO(UTC) → KST datetime-local(YYYY-MM-DDTHH:mm). 빈값 "". */
function isoToKstLocal(iso: string | null): string {
  if (!iso) return "";
  const s = new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }); // "YYYY-MM-DD HH:mm:ss"
  return s.slice(0, 16).replace(" ", "T");
}

const inputCls =
  "w-full rounded-lg border border-foreground/15 ui-field p-2 text-sm outline-none focus:border-foreground/40";

type PendingEventSave = { requestId: string; targetKey: string };
const EVENT_SAVE_STORAGE_KEY = "boss-paegi:admin-event-save";

function readPendingEventSave(): PendingEventSave | null {
  const raw = sessionStorage.getItem(EVENT_SAVE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      isOperationRequestId(value.requestId) &&
      typeof value.targetKey === "string" &&
      (value.targetKey.startsWith("new:") ||
        /^[0-9a-f-]{36}$/i.test(value.targetKey))
    ) {
      return {
        requestId: value.requestId,
        targetKey: value.targetKey,
      };
    }
  } catch {
    // Corrupt tab-local state has no authority and is removed below.
  }
  sessionStorage.removeItem(EVENT_SAVE_STORAGE_KEY);
  return null;
}

function createPendingEventSave(id: string | null): PendingEventSave {
  const pending = {
    requestId: crypto.randomUUID(),
    targetKey: id ?? `new:${crypto.randomUUID()}`,
  };
  sessionStorage.setItem(EVENT_SAVE_STORAGE_KEY, JSON.stringify(pending));
  return pending;
}

function clearPendingEventSave() {
  sessionStorage.removeItem(EVENT_SAVE_STORAGE_KEY);
}

type PendingEventSaveRecovery =
  | { state: "aborted" }
  | { state: "pending" }
  | { state: "completed"; result: AdminEventMutationResult };

type EventPostOutput = {
  ok?: boolean;
  id?: string;
  version?: number;
  error?: string;
  code?: string;
};

async function recoverPendingEventSave(
  pending: PendingEventSave,
  signal?: AbortSignal,
): Promise<PendingEventSaveRecovery> {
  const requestBody = JSON.stringify({
    operation: "event_save",
    requestId: pending.requestId,
    targetKey: pending.targetKey,
  });
  const outcome = await runReplayedJsonMutation({
    input: "/api/admin/mutations/receipt",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    },
    signal,
    classify: (response, body) => {
      const receipt = response.ok
        ? parseAdminMutationReceipt(body)
        : null;
      if (receipt) {
        return { kind: "confirmed", value: receipt };
      }
      if (
        clientMutationResponseNeedsReconciliation(
          response.status,
          response.ok,
        )
      ) {
        return {
          kind: "unconfirmed",
          reason: "event_receipt_response_unconfirmed",
        };
      }
      return {
        kind: "rejected",
        error: `event_receipt_http_${response.status}`,
      };
    },
  });
  if (outcome.kind !== "confirmed") {
    throw new Error("event_save_recovery_failed");
  }
  const receipt = outcome.value;
  if (receipt.state !== "completed") return { state: receipt.state };
  const result = parseAdminEventMutationResult(receipt.result);
  if (!result) throw new Error("event_save_recovery_result_invalid");
  return { state: "completed", result };
}

/**
 * 이벤트/공지 편집기 — 단일 행 CRUD(버전 이력 없음).
 * 저장(초안/수정) · 발행/발행취소 · 삭제(소프트) · 커버/본문 이미지 업로드 · 마크다운 미리보기.
 */
export function EventEditor({ event }: { event: EventView | null }) {
  const router = useRouter();
  const isNew = !event;

  const [id, setId] = useState<string | null>(event?.id ?? null);
  const [version, setVersion] = useState(event?.mutation_version ?? 0);
  const [status, setStatus] = useState<"draft" | "published">(event?.status ?? "draft");
  const [type, setType] = useState<EventType>(event?.type ?? "notice");
  const [title, setTitle] = useState(event?.title ?? "");
  const [summary, setSummary] = useState(event?.summary ?? "");
  const [body, setBody] = useState(event?.body ?? "");
  const [coverPath, setCoverPath] = useState<string | null>(event?.cover_image_path ?? null);
  const [coverUrl, setCoverUrl] = useState<string | null>(event?.coverUrl ?? null);
  // 미리보기용 서버 리사이즈 썸네일(기존 이벤트). 새 업로드 시 null → 새 풀 coverUrl 로 표시.
  const [coverThumbUrl, setCoverThumbUrl] = useState<string | null>(event?.coverThumbUrl ?? null);
  const [startsAt, setStartsAt] = useState(isoToKstLocal(event?.starts_at ?? null));
  const [endsAt, setEndsAt] = useState(isoToKstLocal(event?.ends_at ?? null));
  const [popupActive, setPopupActive] = useState(event?.popup_active ?? false);
  const [bannerHome, setBannerHome] = useState(event?.banner_home_active ?? false);
  const [bannerGallery, setBannerGallery] = useState(event?.banner_gallery_active ?? false);
  const [bannerLeaderboard, setBannerLeaderboard] = useState(event?.banner_leaderboard_active ?? false);
  const [priority, setPriority] = useState(event?.priority ?? 0);
  const [pinned, setPinned] = useState(event?.pinned ?? false);
  const [noindex, setNoindex] = useState(event?.noindex ?? false);
  const [dismissDays, setDismissDays] = useState(event?.popup_dismiss_days ?? 7);

  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<null | "cover" | "inline">(null);
  const [preview, setPreview] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const busyRef = useRef(false);
  const uploadRef = useRef(false);
  const runScopedOperation = useClientOperationScope();

  const validForm = title.trim().length > 0 && summary.trim().length > 0 && body.trim().length > 0;

  const savePayload = (
    pending: PendingEventSave,
    eventId = id,
    eventVersion = version,
  ) => ({
    action: "save" as const,
    id: eventId,
    expectedVersion: eventVersion,
    requestId: pending.requestId,
    targetKey: pending.targetKey,
    type,
    title: title.trim(),
    summary: summary.trim(),
    body: body.trim(),
    coverImagePath: coverPath,
    startsAt: startsAt || null,
    endsAt: endsAt || null,
    popupActive,
    bannerHomeActive: bannerHome,
    bannerGalleryActive: bannerGallery,
    bannerLeaderboardActive: bannerLeaderboard,
    priority,
    pinned,
    noindex,
    popupDismissDays: dismissDays,
  });

  const post = async (
    payload: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    out: EventPostOutput;
    status: number;
    aborted: boolean;
  }> => {
    const requestBody = JSON.stringify(payload);
    const outcome = await runScopedOperation((signal) =>
      runReplayedJsonMutation<{
        status: number;
        result: AdminEventMutationResult;
      }>({
        input: "/api/admin/events",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        },
        signal,
        classify: (response, body) => {
          const result = response.ok
            ? parseAdminEventMutationResult(body)
            : null;
          if (result) {
            return {
              kind: "confirmed",
              value: { status: response.status, result },
            };
          }
          const errorBody =
            body &&
            typeof body === "object" &&
            !Array.isArray(body)
              ? (body as {
                  error?: unknown;
                  code?: unknown;
                })
              : null;
          const error =
            typeof errorBody?.error === "string"
              ? errorBody.error
              : undefined;
          if (
            clientMutationResponseNeedsReconciliation(
              response.status,
              response.ok,
            )
          ) {
            return {
              kind: "unconfirmed",
              reason: "event_response_unconfirmed",
              error,
            };
          }
          return {
            kind: "rejected",
            error: {
              status: response.status,
              error,
              code:
                typeof errorBody?.code === "string"
                  ? errorBody.code
                  : undefined,
            },
          };
        },
      }),
    );
    if (outcome.kind === "confirmed") {
      return {
        ok: true,
        out: outcome.value.result,
        status: outcome.value.status,
        aborted: false,
      };
    }
    if (outcome.kind === "aborted") {
      return {
        ok: false,
        out: { error: "요청이 취소됐어요." },
        status: 0,
        aborted: true,
      };
    }
    const rejection =
      outcome.kind === "rejected" &&
      outcome.error &&
      typeof outcome.error === "object" &&
      !Array.isArray(outcome.error)
        ? (outcome.error as {
            status?: unknown;
            error?: unknown;
            code?: unknown;
          })
        : null;
    return {
      ok: false,
      out: {
        error:
          typeof rejection?.error === "string"
            ? rejection.error
            : "서버 응답을 확인하지 못했어요. 같은 요청으로 다시 확인하세요.",
        code:
          typeof rejection?.code === "string"
            ? rejection.code
            : undefined,
      },
      status:
        rejection && Number.isSafeInteger(rejection.status)
          ? (rejection.status as number)
          : 0,
      aborted: false,
    };
  };

  // A response can be lost after the DB commit. On a same-tab reload, recover
  // the durable receipt before offering another create/save.
  useEffect(() => {
    const pending = readPendingEventSave();
    if (!pending) return;
    const matchesPage = event
      ? pending.targetKey === event.id
      : pending.targetKey.startsWith("new:");
    let cancelled = false;
    if (!matchesPage) {
      queueMicrotask(() => {
        if (!cancelled) {
          setMsg({
            ok: false,
            text: "다른 글의 미확정 저장 결과가 이 탭에 남아 있어요. 원래 글을 다시 열어 결과를 확인하세요.",
          });
        }
      });
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const recovery = await runScopedOperation((signal) =>
          recoverPendingEventSave(pending, signal),
        );
        if (cancelled) return;
        if (recovery.state === "aborted") {
          clearPendingEventSave();
          return;
        }
        if (recovery.state !== "completed") return;
        const recoveredId = recovery.result.id;
        const recoveredVersion = recovery.result.version;
        clearPendingEventSave();
        setId(recoveredId);
        setVersion(recoveredVersion);
        setMsg({ ok: true, text: "이전 저장 요청의 완료를 확인했어요." });
        if (!event) router.replace(`/admin/events/${recoveredId}`);
        else router.refresh();
      } catch {
        // Keep the tab-local request UUID; a later retry cannot double-create.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [event, router, runScopedOperation]);

  // 이미지 업로드(커버/인라인) — 서명 URL 발급 → 스토리지 직접 업로드 → 검증·public URL.
  const upload = async (file: File): Promise<{ path: string; url: string }> => {
    const scope = "admin:event-image";
    const operation = await stableClientUploadOperation({
      scope,
      binding: file.type,
      blob: file,
    });
    const initBody = JSON.stringify({
        mime: file.type,
        requestId: operation.requestId,
        month: operation.month,
    });
    const initOutcome = await runScopedOperation((signal) =>
      runReplayedJsonMutation({
        input: "/api/admin/event-image",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: initBody,
        },
        signal,
        classify: (response, raw) => {
          const acknowledgement = response.ok
            ? parseAdminUploadInitAck(raw, { surface: "event" })
            : null;
          if (acknowledgement) {
            return {
              kind: "confirmed",
              value: acknowledgement,
            };
          }
          if (
            clientMutationResponseNeedsReconciliation(
              response.status,
              response.ok,
            )
          ) {
            return {
              kind: "unconfirmed",
              reason: "event_upload_init_unconfirmed",
            };
          }
          return {
            kind: "rejected",
            error: `event_upload_init_http_${response.status}`,
          };
        },
      }),
    );
    if (initOutcome.kind !== "confirmed") {
      throw new Error("upload_init_failed");
    }
    const d1 = initOutcome.value;
    const sb = createClient();
    const uploadOutcome = await runScopedOperation((signal) =>
      runClientMutation({
        attempt: async () => {
          const { error } = await sb.storage
            .from(EVENTS_BUCKET)
            .uploadToSignedUrl(d1.path, d1.token, file);
          return error
            ? { kind: "rejected" as const, error }
            : { kind: "confirmed" as const, value: true };
        },
        signal,
        deadlineMs: 60_000,
        attemptMs: 45_000,
      }),
    );
    if (uploadOutcome.kind !== "confirmed") {
      throw new Error("upload_failed");
    }
    const confirmBody = JSON.stringify({ path: d1.path });
    const confirmOutcome = await runScopedOperation((signal) =>
      runReplayedJsonMutation({
        input: "/api/admin/event-image",
        init: {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: confirmBody,
        },
        signal,
        classify: (response, raw) => {
          const acknowledgement = response.ok
            ? parseAdminUploadConfirmAck(raw, {
                path: d1.path,
                bucket: EVENTS_BUCKET,
                urlField: "url",
                storageUrl: PUBLIC_ENV.SUPABASE_URL,
              })
            : null;
          if (acknowledgement) {
            return {
              kind: "confirmed",
              value: acknowledgement,
            };
          }
          if (
            clientMutationResponseNeedsReconciliation(
              response.status,
              response.ok,
            )
          ) {
            return {
              kind: "unconfirmed",
              reason: "event_upload_confirm_unconfirmed",
            };
          }
          return {
            kind: "rejected",
            error: `event_upload_confirm_http_${response.status}`,
          };
        },
      }),
    );
    if (confirmOutcome.kind !== "confirmed") {
      throw new Error("upload_confirm_failed");
    }
    const d2 = confirmOutcome.value;
    clearClientUploadOperation(scope, operation.requestId);
    return { path: d2.path, url: d2.url };
  };

  const onPickCover = async (file: File | undefined) => {
    if (!file || uploadRef.current) return;
    uploadRef.current = true;
    setUploading("cover");
    setMsg(null);
    try {
      const { path, url } = await upload(file);
      setCoverPath(path);
      setCoverUrl(url);
      setCoverThumbUrl(null); // 새 업로드는 풀 URL 로 즉시 표시(저장·재로드 후 썸네일).
    } catch (e) {
      setMsg({ ok: false, text: `커버 업로드 실패 (${(e as Error).message})` });
    } finally {
      uploadRef.current = false;
      setUploading(null);
    }
  };

  const onPickInline = async (file: File | undefined) => {
    if (!file || uploadRef.current) return;
    uploadRef.current = true;
    setUploading("inline");
    setMsg(null);
    try {
      const { url } = await upload(file);
      setBody((b) => `${b}${b.endsWith("\n") || b === "" ? "" : "\n\n"}![](${url})\n`);
    } catch (e) {
      setMsg({ ok: false, text: `본문 이미지 업로드 실패 (${(e as Error).message})` });
    } finally {
      uploadRef.current = false;
      setUploading(null);
    }
  };

  const save = async (): Promise<{ id: string; version: number } | null> => {
    const existing = readPendingEventSave();
    const matchesCurrent =
      !!existing &&
      (existing.targetKey === id ||
        (id === null && existing.targetKey.startsWith("new:")));
    if (existing && !matchesCurrent) {
      setMsg({
        ok: false,
        text: "다른 글의 미확정 저장 결과를 확인 중이에요. 해당 탭을 새로고침한 뒤 다시 시도하세요.",
      });
      return null;
    }
    let eventId = id;
    let eventVersion = version;
    if (existing) {
      // A prior POST may have committed even though fetch rejected. Resolve
      // that delivery under the database request lock before reusing or
      // replacing it. If the form changed meanwhile, a completed create is
      // first recovered and the current form is then saved as an update to
      // that same row; it can never become a second create.
      let recovery: PendingEventSaveRecovery;
      try {
        recovery = await runScopedOperation((signal) =>
          recoverPendingEventSave(existing, signal),
        );
      } catch {
        setMsg({
          ok: false,
          text: "이전 저장 결과를 확인하지 못했어요. 잠시 후 다시 시도하세요.",
        });
        return null;
      }
      if (recovery.state === "pending") {
        setMsg({
          ok: false,
          text: "이전 저장 요청이 아직 처리 중이에요. 잠시 후 다시 시도하세요.",
        });
        return null;
      }
      if (recovery.state === "aborted") {
        clearPendingEventSave();
      } else {
        if (id !== null && recovery.result.id !== id) {
          setMsg({
            ok: false,
            text: "이전 저장 결과가 현재 글과 일치하지 않아요. 새로고침 후 확인하세요.",
          });
          return null;
        }
        clearPendingEventSave();
        eventId = recovery.result.id;
        eventVersion = recovery.result.version;
        setId(eventId);
        setVersion(eventVersion);
      }
    }
    const pending = createPendingEventSave(eventId);
    const { ok, out, status } = await post(
      savePayload(pending, eventId, eventVersion),
    );
    if (
      !ok ||
      !out.id ||
      !Number.isSafeInteger(out.version) ||
      (out.version as number) < 0
    ) {
      // A received 4xx is a definitive non-commit/conflict. A 5xx can occur
      // after commit (for example cache invalidation), so retain the UUID.
      if (status >= 400 && status < 500) clearPendingEventSave();
      setMsg({ ok: false, text: out.error ?? "저장 실패" });
      return null;
    }
    clearPendingEventSave();
    if (!id) setId(out.id);
    setVersion(out.version as number);
    return { id: out.id, version: out.version as number };
  };

  const onSave = async () => {
    if (busyRef.current || !validForm) return;
    busyRef.current = true;
    setBusy(true);
    setMsg(null);
    try {
      const saved = await save();
      if (saved) {
        setMsg({ ok: true, text: "저장했어요." });
        if (isNew) router.replace(`/admin/events/${saved.id}`);
        else router.refresh();
      }
    } catch {
      setMsg({ ok: false, text: "네트워크 오류 — 다시 시도하세요." });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const onPublish = async () => {
    if (busyRef.current || !validForm) return;
    busyRef.current = true;
    setBusy(true);
    setMsg(null);
    try {
      const saved = await save(); // 발행 전 최신 폼 저장
      if (!saved) return;
      const { ok, out } = await post({
        action: "publish",
        id: saved.id,
        expectedVersion: saved.version,
      });
      if (ok) {
        setStatus("published");
        if (Number.isSafeInteger(out.version)) {
          setVersion(out.version as number);
        }
        setMsg({ ok: true, text: "발행했어요 — 공개에 노출됩니다(노출 윈도우/플래그 기준)." });
        router.refresh();
      } else setMsg({ ok: false, text: out.error ?? "발행 실패" });
    } catch {
      setMsg({ ok: false, text: "네트워크 오류 — 다시 시도하세요." });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const onUnpublish = async () => {
    if (busyRef.current || !id) return;
    busyRef.current = true;
    setBusy(true);
    setMsg(null);
    try {
      const { ok, out } = await post({
        action: "unpublish",
        id,
        expectedVersion: version,
      });
      if (ok) {
        setStatus("draft");
        if (Number.isSafeInteger(out.version)) {
          setVersion(out.version as number);
        }
        setMsg({ ok: true, text: "발행을 취소했어요(초안으로). 공개 노출 중단." });
        router.refresh();
      } else setMsg({ ok: false, text: out.error ?? "발행취소 실패" });
    } catch {
      setMsg({ ok: false, text: "네트워크 오류 — 다시 시도하세요." });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (busyRef.current || !id) return;
    busyRef.current = true;
    setBusy(true);
    setConfirmDelete(false);
    setMsg(null);
    try {
      const { ok, out } = await post({
        action: "delete",
        id,
        expectedVersion: version,
      });
      if (ok) router.replace("/admin/events");
      else setMsg({ ok: false, text: out.error ?? "삭제 실패" });
    } catch {
      setMsg({ ok: false, text: "네트워크 오류 — 다시 시도하세요." });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 flex flex-col gap-5">
      {/* 상태 */}
      <div className="flex items-center gap-2 text-sm">
        <span
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
            status === "published"
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-amber-500/15 text-amber-700 dark:text-amber-300"
          }`}
        >
          {status === "published" ? "발행됨" : "초안"}
        </span>
        {id && (
          <Link href={`/news/${id}`} target="_blank" className="text-xs text-zinc-500 hover:text-foreground">
            공개 상세 →
          </Link>
        )}
      </div>

      <section className="flex flex-col gap-4 rounded-2xl border border-foreground/10 p-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-zinc-500">타입</span>
          <select value={type} onChange={(e) => setType(e.target.value as EventType)} className={`${inputCls} w-40`}>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EVENT_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-zinc-500">제목</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={inputCls} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-zinc-500">
            요약/배너 문구 <span className="text-zinc-400">· 팝업·배너·목록에 노출(≤200자)</span>
          </span>
          <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={200} className={inputCls} />
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-zinc-500">
            본문 <span className="text-zinc-400">· 마크다운(이미지는 아래 버튼으로 업로드해 삽입)</span>
          </span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={Math.max(8, body.split("\n").length)}
            maxLength={50000}
            className={inputCls}
          />
          <label className="mt-1 inline-flex w-fit cursor-pointer items-center gap-2 rounded-full border border-foreground/20 px-3 py-1.5 text-xs hover:bg-foreground/5">
            {uploading === "inline" ? <Spinner className="h-3.5 w-3.5" /> : "🖼"} 본문에 이미지 추가
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => void onPickInline(e.target.files?.[0])}
            />
          </label>
        </div>

        {/* 커버 이미지 */}
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-zinc-500">
            커버 이미지 <span className="text-zinc-400">· 목록 썸네일·OG(선택) · 권장 1200×630 (1.91:1)</span>
          </span>
          <div className="flex items-center gap-3">
            {coverUrl && (
              <FadeImg
                src={coverThumbUrl ?? coverUrl}
                className="aspect-[40/21] w-28 shrink-0 rounded-lg"
                fit="cover"
                placeholder="gray"
              />
            )}
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-foreground/20 px-3 py-1.5 text-xs hover:bg-foreground/5">
              {uploading === "cover" ? <Spinner className="h-3.5 w-3.5" /> : coverUrl ? "변경" : "업로드"}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => void onPickCover(e.target.files?.[0])}
              />
            </label>
            {coverUrl && (
              <button
                type="button"
                onClick={() => {
                  setCoverPath(null);
                  setCoverUrl(null);
                  setCoverThumbUrl(null);
                }}
                className="text-xs text-red-400 hover:underline"
              >
                제거
              </button>
            )}
          </div>
        </div>

        {/* 노출 윈도우 — datetime-local 은 고유 최소폭이 커서 소형 화면에선 세로 스택 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-zinc-500">노출 시작 <span className="text-zinc-400">· 비우면 즉시</span></span>
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-zinc-500">노출 종료 <span className="text-zinc-400">· 비우면 무기한</span></span>
            <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className={inputCls} />
          </label>
        </div>

        {/* 노출 구좌 */}
        <div className="flex flex-col gap-2 rounded-xl border border-foreground/10 ui-surface p-3">
          <span className="text-sm font-semibold text-zinc-500">노출 구좌</span>
          <p className="text-[11px] text-zinc-400">
            배너는 <b>홈·갤러리·랭킹 각각 독립</b>으로 켭니다. 한 지면에 활성 후보가 여러 개면 <b>우선순위(priority)가 가장 높은 1건만</b> 노출됩니다.
          </p>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={popupActive} onChange={(e) => setPopupActive(e.target.checked)} /> 홈 팝업
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={bannerHome} onChange={(e) => setBannerHome(e.target.checked)} /> 홈 배너
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={bannerGallery} onChange={(e) => setBannerGallery(e.target.checked)} /> 갤러리 배너
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={bannerLeaderboard} onChange={(e) => setBannerLeaderboard(e.target.checked)} /> 랭킹 배너
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> 목록 상단 고정
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={noindex} onChange={(e) => setNoindex(e.target.checked)} /> 검색 색인 제외
            </label>
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-zinc-500">우선순위</span>
              <input type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value) || 0)} className={`${inputCls} w-24`} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-zinc-500">팝업 안보기(일)</span>
              <input
                type="number"
                min={1}
                max={365}
                value={dismissDays}
                onChange={(e) => setDismissDays(Math.min(365, Math.max(1, Number(e.target.value) || 7)))}
                className={`${inputCls} w-20`}
              />
            </label>
          </div>
        </div>

        {/* 미리보기 */}
        <button
          type="button"
          onClick={() => setPreview((p) => !p)}
          className="self-start text-xs text-zinc-500 underline-offset-4 hover:text-foreground hover:underline"
        >
          {preview ? "미리보기 닫기" : "본문 미리보기 열기"}
        </button>
        {preview && (
          <div className="rounded-2xl border border-foreground/10 p-4">
            {coverUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={coverUrl} alt="" className="mb-3 max-h-60 w-full rounded-xl object-cover" />
            )}
            <h2 className="text-lg font-bold">{title || "(제목 없음)"}</h2>
            <p className="mb-3 mt-1 text-sm text-zinc-500">{summary}</p>
            <Markdown>{body || "(본문 없음)"}</Markdown>
          </div>
        )}

        {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>}

        {/* 액션 */}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={busy || !validForm}
            className="flex flex-1 items-center justify-center gap-2 rounded-full border border-foreground/20 py-3 text-sm font-semibold transition hover:bg-foreground/5 disabled:opacity-40"
          >
            {busy && <Spinner className="h-4 w-4" />}
            저장
          </button>
          {status === "published" ? (
            <button
              type="button"
              onClick={() => void onUnpublish()}
              disabled={busy}
              className="flex-1 rounded-full border border-amber-500/40 py-3 text-sm font-semibold text-amber-600 transition hover:bg-amber-500/10 disabled:opacity-40"
            >
              발행취소
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void onPublish()}
              disabled={busy || !validForm}
              className="flex-1 rounded-full bg-foreground py-3 text-sm font-semibold text-paper-2 transition hover:opacity-90 disabled:opacity-40"
            >
              발행
            </button>
          )}
          {id && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              className="rounded-full border border-red-500/30 px-4 py-3 text-sm font-semibold text-red-500 transition hover:bg-red-500/10 disabled:opacity-40"
            >
              삭제
            </button>
          )}
        </div>
      </section>

      {confirmDelete && (
        <ModalShell ariaLabel="이벤트 삭제 확인" onClose={() => setConfirmDelete(false)}>
          <h2 className="text-lg font-bold">이 글을 삭제할까요?</h2>
          <p className="mt-2 text-sm text-zinc-500">
            소프트 삭제됩니다 — 목록·상세·팝업·배너에서 즉시 사라져요. (행은 감사를 위해 보존됩니다.)
          </p>
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => setConfirmDelete(false)} className="flex-1 rounded-full border border-foreground/15 ui-surface py-2.5 text-sm">
              취소
            </button>
            <button type="button" onClick={() => void onDelete()} className="flex-1 rounded-full bg-red-500 py-2.5 text-sm font-semibold text-white">
              삭제
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
