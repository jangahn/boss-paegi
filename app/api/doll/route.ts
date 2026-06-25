import "server-only";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { dollPath } from "@/lib/storage-path";
import { removeBackground } from "@/lib/fal";
import { normalizeDollImage } from "@/lib/image-utils";
import {
  DOLLS_BUCKET as BUCKET,
  cleanupCandidateStorage,
} from "@/lib/generation";
import { deleteFaceTmp, tmpFacePath } from "@/lib/character-gen/upload-face";
import { log, errInfo, urlHost } from "@/lib/log";
import { asRole, isRoleId, type RoleId } from "@/lib/roles";

export const runtime = "nodejs";
// 누끼(birefnet ~2s) + fetch/normalize/upload/insert. 30s 면 충분.
// 명시 안 하면 플랫폼 기본값(Hobby 10s)에 묶여 느린 누끼가 잘릴 수 있음.
export const maxDuration = 30;

/** 신뢰 호스트 — fal 결과 또는 우리 Supabase storage(후보 복사본) */
function isTrustedImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.hostname.endsWith("fal.media")) return true;
    const sb = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (sb && u.hostname === new URL(sb).hostname) return true;
    return false;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // 갤러리/생성은 회원 전용 — 익명(비회원)은 차단.
  if (user.is_anonymous) {
    return NextResponse.json({ error: "member_only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    imageUrl?: string;
    styleMeta?: Record<string, unknown>;
    generationId?: string;
    role?: string;
  } | null;
  if (!body?.imageUrl) {
    return NextResponse.json({ error: "imageUrl_required" }, { status: 400 });
  }
  if (!isTrustedImageUrl(body.imageUrl)) {
    log.warn("doll.untrusted_url", {
      userId: user.id,
      host: urlHost(body.imageUrl),
    });
    return NextResponse.json({ error: "untrusted_url" }, { status: 400 });
  }

  const genId = body.generationId ?? null;
  log.info("doll.pick", { userId: user.id, genId, srcHost: urlHost(body.imageUrl) });

  // 누끼 제거
  let cleanedUrl: string;
  try {
    cleanedUrl = await Sentry.startSpan(
      { name: "doll.bg_removal", op: "fal.birefnet", attributes: { genId: genId ?? "none" } },
      () => removeBackground(body.imageUrl!)
    );
  } catch (e) {
    log.error("doll.bg_removal_fail", { userId: user.id, genId, ...errInfo(e) });
    return NextResponse.json({ error: "bg_removal_failed" }, { status: 502 });
  }

  const src = await fetch(cleanedUrl);
  if (!src.ok) {
    log.error("doll.fetch_fail", {
      userId: user.id,
      genId,
      status: src.status,
      host: urlHost(cleanedUrl),
    });
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }
  const raw = await src.arrayBuffer();

  // 캐릭터 정중앙 + 일정 비율 frame 으로 정규화 (lib/image-utils)
  let normalized: Buffer;
  try {
    normalized = await Sentry.startSpan(
      { name: "doll.normalize", op: "image.process", attributes: { genId: genId ?? "none" } },
      () => normalizeDollImage(raw)
    );
  } catch (e) {
    log.error("doll.normalize_fail", { userId: user.id, genId, ...errInfo(e) });
    return NextResponse.json({ error: "normalize_failed" }, { status: 500 });
  }

  const dollId = crypto.randomUUID();
  const path = `${user.id}/${dollId}.png`;

  const admin = createAdminClient();

  // 생성 시 고른 롤 — ai_generations 가 권위(클라 body 는 폴백). 미지/없음은 boss.
  let dollRole: RoleId = "boss";
  if (genId) {
    const { data: genRole } = await admin
      .from("ai_generations")
      .select("role")
      .eq("id", genId)
      .eq("owner_id", user.id)
      .single();
    dollRole = asRole(genRole?.role);
  } else if (isRoleId(body.role)) {
    dollRole = body.role;
  }

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, normalized, { contentType: "image/png", upsert: false });
  if (uploadError) {
    log.error("doll.upload_fail", {
      userId: user.id,
      genId,
      dollId,
      ...errInfo(uploadError),
    });
    return NextResponse.json(
      { error: "upload_failed", detail: uploadError.message },
      { status: 500 }
    );
  }

  // private 버킷 — image_url 에 **경로** 저장(읽을 때 signedDollUrl 로 서명). getPublicUrl 미사용.
  const { data: doll, error: insertError } = await admin
    .from("dolls")
    .insert({
      id: dollId,
      owner_id: user.id,
      image_url: path,
      style_meta: body.styleMeta ?? {},
      role: dollRole,
    })
    .select()
    .single();
  if (insertError) {
    log.error("doll.insert_fail", {
      userId: user.id,
      genId,
      dollId,
      ...errInfo(insertError),
    });
    return NextResponse.json(
      { error: "insert_failed", detail: insertError.message },
      { status: 500 }
    );
  }

  // 이 doll 이 특정 generation 에서 골라진 거라면: picked 처리 + 안 고른 후보 정리
  if (body.generationId) {
    const { error: pickErr } = await admin
      .from("ai_generations")
      .update({ status: "picked", picked_doll_id: dollId })
      .eq("id", body.generationId)
      .eq("owner_id", user.id);
    if (pickErr) {
      // picked 전이 실패 → generation 이 done(미선택)으로 남아 24h 내 갤러리에
      // ready 후보로 다시 노출됨. '인형은 저장됐는데 generation 이 안 닫힌' 케이스.
      log.error("doll.pick_transition_fail", {
        userId: user.id,
        genId,
        dollId,
        ...errInfo(pickErr),
      });
    }
    await cleanupCandidateStorage(admin, user.id, body.generationId);
    // 정책 #1(원본 즉시 폐기) 확정 정리 — pick 은 "생성 완료" 확정 시점이고
    // picked 행은 /api/generations 쿼리에서 제외되므로 폴링 정리 재시도가 사라진다.
    // 여기서 awaited 로 임시 얼굴을 반드시 폐기(폴링의 best-effort 정리에 의존하지 않음).
    await deleteFaceTmp(tmpFacePath(user.id, body.generationId)).catch((e) =>
      log.warn("gen.face_cleanup_fail", {
        userId: user.id,
        genId: body.generationId,
        ...errInfo(e),
      })
    );
  }

  log.info("doll.save_success", { userId: user.id, genId, dollId });
  return NextResponse.json({ doll });
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // 갤러리/생성은 회원 전용 — 익명(비회원)은 차단.
  if (user.is_anonymous) {
    return NextResponse.json({ error: "member_only" }, { status: 403 });
  }

  const { data } = await supabase
    .from("dolls")
    .select("id, image_url, created_at, role")
    .order("created_at", { ascending: false })
    .limit(50);

  return NextResponse.json({ dolls: data ?? [] });
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // 갤러리/생성은 회원 전용 — 익명(비회원)은 차단.
  if (user.is_anonymous) {
    return NextResponse.json({ error: "member_only" }, { status: 403 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id_required" }, { status: 400 });
  }

  // owner 검증 + Storage 파일 path 받아오기
  const { data: doll, error: selErr } = await supabase
    .from("dolls")
    .select("id, owner_id, image_url")
    .eq("id", id)
    .single();
  if (selErr || !doll) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (doll.owner_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Storage 파일 삭제 (admin — owner 검증은 위에서 통과)
  const admin = createAdminClient();
  const storagePath = dollPath(doll.image_url); // private 후 image_url=경로(URL도 관용 처리)
  if (storagePath) {
    // remove() 는 throw 가 아니라 { error } 반환 — best-effort 지만 실패 시
    // storage 객체가 고아로 남으므로(개인정보 정책 리스크) 추적 가능하게 남김.
    const { error: rmErr } = await admin.storage.from(BUCKET).remove([storagePath]);
    if (rmErr) {
      log.warn("doll.storage_remove_fail", {
        userId: user.id,
        dollId: id,
        storagePath,
        ...errInfo(rmErr),
      });
    }
  }

  // dolls row 삭제 — scores.doll_id 는 FK on delete set null 이라 점수는 살아남음
  const { error: delErr } = await supabase.from("dolls").delete().eq("id", id);
  if (delErr) {
    log.error("doll.delete_fail", { userId: user.id, dollId: id, ...errInfo(delErr) });
    return NextResponse.json(
      { error: "delete_failed", detail: delErr.message },
      { status: 500 }
    );
  }

  log.info("doll.delete", { userId: user.id, dollId: id });
  return NextResponse.json({ ok: true });
}

/** 캐릭터 롤 변경 (갤러리 점세개 메뉴). 쓰기 API라 unknown role 은 400(렌더의 boss 폴백과 달리 엄격). */
export async function PATCH(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.is_anonymous) {
    return NextResponse.json({ error: "member_only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    id?: string;
    role?: string;
  } | null;
  if (!body?.id) {
    return NextResponse.json({ error: "id_required" }, { status: 400 });
  }
  if (!isRoleId(body.role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  // owner 검증 (DELETE 패턴 동일)
  const { data: doll, error: selErr } = await supabase
    .from("dolls")
    .select("id, owner_id")
    .eq("id", body.id)
    .single();
  if (selErr || !doll) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (doll.owner_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { error: updErr } = await admin
    .from("dolls")
    .update({ role: body.role })
    .eq("id", body.id);
  if (updErr) {
    log.error("doll.role_update_fail", {
      userId: user.id,
      dollId: body.id,
      role: body.role,
      ...errInfo(updErr),
    });
    return NextResponse.json(
      { error: "update_failed", detail: updErr.message },
      { status: 500 }
    );
  }

  log.info("doll.role_change", { userId: user.id, dollId: body.id, role: body.role });
  return NextResponse.json({ ok: true, role: body.role });
}
