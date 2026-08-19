"use client";

import { createClient } from "@/lib/supabase/client";
import { notifyProfileChanged } from "@/lib/profile";
import { PUBLIC_ENV } from "@/lib/env";
import {
  parseAvatarClearHttpAck,
  parseAvatarReplaceHttpAck,
  parseAvatarUploadInitAck,
} from "@/lib/avatar-http-contract";
import {
  clearClientUploadOperation,
  stableClientUploadOperation,
} from "@/lib/client-upload-operation";
import {
  clientMutationResponseNeedsReconciliation,
  runClientMutation,
  runReplayedJsonMutation,
} from "@/lib/client-mutation";

const BUCKET = "avatars";
const MIN_DIM = 128;
const MAX_DIM = 512;

/**
 * 정사각 crop blob → 128~512 정사각 **JPEG** 로 정규화.
 * 너무 작으면 128×128 로 업스케일, 너무 크면 512×512 로 다운스케일.
 *
 * JPEG 고정 이유: `toBlob("image/webp")` 가 webp 미지원 브라우저(일부 Safari/iOS)에서
 * **PNG 로 silently 폴백**(canvas 스펙 기본값) → 512px 사진 PNG=무손실 400~600KB 로 비대해져
 * 프사 로딩이 느렸다. JPEG 는 toBlob 보편 지원·사진에 적합·알파 불필요(정사각 풀-드로) →
 * 512px 기준 ~40~80KB. (알파 없는 JPEG 라 빈 영역 검정 방지로 흰 배경 선채움.)
 */
async function normalizeSquare(blob: Blob): Promise<Blob> {
  const img = await loadImage(blob);
  const src = Math.min(img.width, img.height); // crop 은 정사각이지만 방어적으로 min
  const target = Math.min(MAX_DIM, Math.max(MIN_DIM, src));
  const canvas = document.createElement("canvas");
  canvas.width = target;
  canvas.height = target;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unsupported");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, target, target);
  const sx = (img.width - src) / 2;
  const sy = (img.height - src) / 2;
  ctx.drawImage(img, sx, sy, src, src, 0, 0, target, target);
  const out = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85)
  );
  if (!out) throw new Error("encode failed");
  return out;
}

function loadImage(src: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(src);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

/**
 * 프로필 사진 업로드 — 정사각 crop blob 정규화 → 서명 URL → 직접 업로드 → 검증/반영.
 * @param cropped PhotoCropper 가 만든 1:1 crop blob
 * @returns 반영된 public avatar URL
 */
export async function uploadAvatar(
  cropped: Blob,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const blob = await normalizeSquare(cropped);
  const mime = blob.type || "image/webp";
  const operation = await stableClientUploadOperation({
    scope: "avatar",
    binding: mime,
    blob,
  });

  const initBody = JSON.stringify({
    mime,
    requestId: operation.requestId,
  });
  const initOutcome = await runReplayedJsonMutation({
    input: "/api/avatar",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: initBody,
    },
    signal: options.signal,
    classify: (response, body) => {
      const acknowledgement = response.ok
        ? parseAvatarUploadInitAck(body, mime)
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
          reason: "avatar_upload_init_unconfirmed",
        };
      }
      return {
        kind: "rejected",
        error: `avatar_upload_init_http_${response.status}`,
      };
    },
  });
  if (initOutcome.kind !== "confirmed") {
    throw new Error("업로드 준비 응답을 확인하지 못했어요");
  }
  const init = initOutcome.value;
  const { path, token } = init;

  const sb = createClient();
  const uploadOutcome = await runClientMutation({
    attempt: async () => {
      const { error } = await sb.storage
        .from(BUCKET)
        // URL 은 uuid 로 콘텐츠-주소(변경 시 새 path) → 장기 immutable 캐시 안전(재방문 즉시).
        .uploadToSignedUrl(path, token, blob, {
          contentType: mime,
          cacheControl: "31536000",
        });
      return error
        ? { kind: "rejected" as const, error }
        : { kind: "confirmed" as const, value: true };
    },
    signal: options.signal,
    deadlineMs: 60_000,
    attemptMs: 45_000,
  });
  if (uploadOutcome.kind !== "confirmed") {
    throw new Error("업로드에 실패했어요");
  }

  const confirmBody = JSON.stringify({ path });
  const confirmOutcome = await runReplayedJsonMutation({
    input: "/api/avatar",
    init: {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: confirmBody,
    },
    signal: options.signal,
    classify: (response, body) => {
      const acknowledgement = response.ok
        ? parseAvatarReplaceHttpAck(body, {
            path,
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
          reason: "avatar_replace_unconfirmed",
        };
      }
      return {
        kind: "rejected",
        error: `avatar_replace_http_${response.status}`,
      };
    },
  });
  if (confirmOutcome.kind !== "confirmed") {
    throw new Error("프로필 반영 응답을 확인하지 못했어요");
  }
  const acknowledgement = confirmOutcome.value;
  clearClientUploadOperation("avatar", operation.requestId);
  notifyProfileChanged(); // 헤더 계정 정보 즉시 반영(새로고침 불필요)
  return acknowledgement.avatarUrl;
}

/** 프로필 사진 삭제 → 기본 프사로 복귀. */
export async function removeAvatar(
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const outcome = await runReplayedJsonMutation({
    input: "/api/avatar",
    init: { method: "DELETE" },
    signal: options.signal,
    classify: (response, body) => {
      const acknowledgement = response.ok
        ? parseAvatarClearHttpAck(body)
        : null;
      if (acknowledgement) {
        return { kind: "confirmed", value: true };
      }
      if (
        clientMutationResponseNeedsReconciliation(
          response.status,
          response.ok,
        )
      ) {
        return {
          kind: "unconfirmed",
          reason: "avatar_clear_unconfirmed",
        };
      }
      return {
        kind: "rejected",
        error: `avatar_clear_http_${response.status}`,
      };
    },
  });
  if (outcome.kind !== "confirmed") {
    throw new Error("프로필 삭제 응답을 확인하지 못했어요");
  }
  notifyProfileChanged(); // 헤더 계정 정보 즉시 반영(새로고침 불필요)
}
