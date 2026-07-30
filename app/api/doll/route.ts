import "server-only";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { dollPath } from "@/lib/storage-path";
import { removeBackground } from "@/lib/fal";
import { normalizeDollImage } from "@/lib/image-utils";
import {
  DOLLS_BUCKET as BUCKET,
  cleanupCandidateStorage,
  candidatePrefix,
} from "@/lib/generation";
import { deleteFaceTmp, tmpFacePath } from "@/lib/character-gen/upload-face";
import { PROVENANCE_SCHEMA_VERSION } from "@/lib/character-gen/provenance";
import { log, errInfo } from "@/lib/log";
import { asRole, isRoleId } from "@/lib/roles";
import {
  GENERATION_COST_FROZEN_BODY,
  GENERATION_COST_ROLLOUT_HEADER,
  generationCostPathEnabled,
} from "@/lib/generation-cost-rollout";

export const runtime = "nodejs";
// 누끼(birefnet ~2s) + fetch/normalize/upload/insert. 30s 면 충분.
// 명시 안 하면 플랫폼 기본값(Hobby 10s)에 묶여 느린 누끼가 잘릴 수 있음.
export const maxDuration = 30;

/**
 * 후보 선택(pick) — **서버 권위**. 클라 계약 = {generationId, candidateIndex}.
 *   서버가 소유 generation 을 조회해 status(done/선택가능)·candidateIndex(0~2)·해당 canonical 경로가
 *   candidate_urls 에 실존하는지 검증하고, 검증된 경로를 **내부 서명**해 birefnet 에 넘긴다.
 *   클라 imageUrl/styleMeta/role 은 비권위(과도기 imageUrl 은 index 파싱에만, 경로는 서버 재구성).
 *   멱등(이미 picked 면 기존 doll)·동시성(done→picked 조건부 1승·패자 보상삭제)·pick 후 provenance 갱신.
 */
export async function POST(req: NextRequest) {
  // Only POST can start paid birefnet work. Keep this before auth/body/DB so a
  // rolling old deployment has an externally provable, exact freeze boundary;
  // GET/DELETE remain available while the generation cost ledger is deployed.
  if (!generationCostPathEnabled()) {
    return NextResponse.json(GENERATION_COST_FROZEN_BODY, {
      status: 503,
      headers: { [GENERATION_COST_ROLLOUT_HEADER]: "frozen" },
    });
  }

  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;

  const body = (await req.json().catch(() => null)) as {
    generationId?: string;
    candidateIndex?: number;
    imageUrl?: string; // 과도기(구 클라) — 신뢰 안 하고 index 파싱에만.
  } | null;
  const genId = body?.generationId;
  if (!genId) {
    return NextResponse.json({ error: "generationId_required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // 소유 generation 조회(서버 권위).
  const { data: gen, error: genErr } = await admin
    .from("ai_generations")
    .select("role, status, candidate_urls, picked_doll_id")
    .eq("id", genId)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (genErr) {
    log.error("doll.gen_lookup_fail", { userId: user.id, genId, ...errInfo(genErr) });
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!gen) return NextResponse.json({ error: "generation_not_found" }, { status: 404 });

  // candidateIndex 결정 — body 우선, 없으면 과도기 imageUrl 에서 파싱(신뢰X, 검증만).
  let candidateIndex: number | null =
    typeof body?.candidateIndex === "number" ? body.candidateIndex : null;
  if (candidateIndex === null && body?.imageUrl) {
    const m = /\/candidates\/[^/]+\/(\d+)\.jpg/.exec(body.imageUrl);
    candidateIndex = m ? Number(m[1]) : null;
  }
  if (
    candidateIndex === null ||
    !Number.isInteger(candidateIndex) ||
    candidateIndex < 0 ||
    candidateIndex > 2
  ) {
    return NextResponse.json({ error: "invalid_candidate_index" }, { status: 400 });
  }

  // 멱등 — 이미 picked 면 기존 doll 반환(재제출/더블클릭 흔한 케이스, birefnet 전에 단락).
  if (gen.status === "picked" && gen.picked_doll_id) {
    const { data: existing } = await admin
      .from("dolls")
      .select("*")
      .eq("id", gen.picked_doll_id)
      .maybeSingle();
    if (existing) return NextResponse.json({ doll: existing });
  }
  if (gen.status !== "done" && gen.status !== "picked") {
    return NextResponse.json({ error: "not_selectable" }, { status: 409 });
  }

  // canonical 후보 경로 서버 구성 + candidate_urls 멤버십 검증(클라 URL 비신뢰).
  const candidateUrls: string[] = Array.isArray(gen.candidate_urls) ? gen.candidate_urls : [];
  const canonicalPath = `${candidatePrefix(user.id, genId)}/${candidateIndex}.jpg`;
  if (!candidateUrls.includes(canonicalPath)) {
    log.warn("doll.candidate_not_member", { userId: user.id, genId, candidateIndex });
    return NextResponse.json({ error: "candidate_not_found" }, { status: 404 });
  }

  // 검증된 경로를 내부 서명 → birefnet.
  const { data: signed, error: signErr } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(canonicalPath, 600);
  if (signErr || !signed?.signedUrl) {
    log.error("doll.sign_fail", { userId: user.id, genId, candidateIndex, ...errInfo(signErr) });
    return NextResponse.json({ error: "sign_failed" }, { status: 500 });
  }

  // 누끼
  let cleanedUrl: string;
  try {
    cleanedUrl = await Sentry.startSpan(
      { name: "doll.bg_removal", op: "fal.birefnet", attributes: { genId } },
      () => removeBackground(signed.signedUrl)
    );
  } catch (e) {
    log.error("doll.bg_removal_fail", { userId: user.id, genId, ...errInfo(e) });
    return NextResponse.json({ error: "bg_removal_failed" }, { status: 502 });
  }

  const srcRes = await fetch(cleanedUrl);
  if (!srcRes.ok) {
    log.error("doll.fetch_fail", { userId: user.id, genId, status: srcRes.status });
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }
  const raw = await srcRes.arrayBuffer();

  let normalized: Buffer;
  try {
    normalized = await Sentry.startSpan(
      { name: "doll.normalize", op: "image.process", attributes: { genId } },
      () => normalizeDollImage(raw)
    );
  } catch (e) {
    log.error("doll.normalize_fail", { userId: user.id, genId, ...errInfo(e) });
    return NextResponse.json({ error: "normalize_failed" }, { status: 500 });
  }

  const dollId = crypto.randomUUID();
  const path = `${user.id}/${dollId}.png`;
  const dollRole = asRole(gen.role); // 롤은 ai_generations 권위.

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, normalized, { contentType: "image/png", upsert: false });
  if (uploadError) {
    log.error("doll.upload_fail", { userId: user.id, genId, dollId, ...errInfo(uploadError) });
    return NextResponse.json({ error: "upload_failed" }, { status: 500 });
  }

  // doll insert — style_meta = 비민감 포인터만(전체 프롬프트/파라미터는 어드민 전용 gen_params 정본).
  const stylePointer = {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    sourceGenerationId: genId,
    candidateIndex,
  };
  const { data: doll, error: insertError } = await admin
    .from("dolls")
    .insert({ id: dollId, owner_id: user.id, image_url: path, style_meta: stylePointer, role: dollRole })
    .select()
    .single();
  if (insertError) {
    await admin.storage.from(BUCKET).remove([path]); // 보상: 업로드 객체 제거.
    log.error("doll.insert_fail", { userId: user.id, genId, dollId, ...errInfo(insertError) });
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  // 조건부 done→picked (동시성 1승). picked_index = 서버 검증 candidateIndex.
  const { data: claimed, error: pickErr } = await admin
    .from("ai_generations")
    .update({ status: "picked", picked_doll_id: dollId, picked_index: candidateIndex })
    .eq("id", genId)
    .eq("owner_id", user.id)
    .eq("status", "done")
    .select("id");
  if (pickErr) {
    // 전이 DB 오류 — doll 은 저장됨. generation done 유지(재노출) → 후보 정리하지 않음(전이 성공 전).
    log.error("doll.pick_transition_fail", { userId: user.id, genId, dollId, ...errInfo(pickErr) });
    return NextResponse.json({ doll });
  }
  if ((claimed?.length ?? 0) === 0) {
    // 레이스 패배(다른 pick 이 먼저 picked) — 방금 만든 doll/storage 보상삭제 + 기존 picked doll 반환.
    await admin.from("dolls").delete().eq("id", dollId);
    await admin.storage.from(BUCKET).remove([path]);
    const { data: after2 } = await admin
      .from("ai_generations")
      .select("picked_doll_id")
      .eq("id", genId)
      .maybeSingle();
    if (after2?.picked_doll_id) {
      const { data: winner } = await admin
        .from("dolls")
        .select("*")
        .eq("id", after2.picked_doll_id)
        .maybeSingle();
      if (winner) return NextResponse.json({ doll: winner });
    }
    return NextResponse.json({ error: "pick_conflict" }, { status: 409 });
  }

  // pick 성공 → gen_params 에 postprocess/picked 추가(status·picked_doll_id·picked_index 정합). best-effort.
  try {
    const { data: gpRow } = await admin
      .from("ai_generations")
      .select("gen_params")
      .eq("id", genId)
      .maybeSingle();
    const gp = gpRow?.gen_params as Record<string, unknown> | null;
    if (gp && typeof gp === "object") {
      const nowIso = new Date().toISOString();
      gp.postprocess = { model: "fal-ai/birefnet", candidateIndex, completedAt: nowIso };
      gp.picked = { candidateIndex, dollId, pickedAt: nowIso };
      await admin.from("ai_generations").update({ gen_params: gp }).eq("id", genId);
    }
  } catch (e) {
    log.warn("doll.provenance_pick_merge_fail", { genId, ...errInfo(e) });
  }

  // 정리(후보 스토리지 + 임시 얼굴) — 전이 성공 후에만. after() 로 응답 직후 실행.
  after(async () => {
    await cleanupCandidateStorage(admin, user.id, genId).catch((e) =>
      log.warn("gen.candidate_cleanup_fail", { userId: user.id, genId, ...errInfo(e) })
    );
    await deleteFaceTmp(tmpFacePath(user.id, genId)).catch((e) =>
      log.warn("gen.face_cleanup_fail", { userId: user.id, genId, ...errInfo(e) })
    );
  });

  log.info("doll.save_success", { userId: user.id, genId, dollId, candidateIndex });
  return NextResponse.json({ doll });
}

export async function GET() {
  // 회원 전용 + 동의 완료 게이트(lazy 모델: 미동의 로그인 차단). 익명/무세션/미동의 → 401/403.
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const supabase = await createClient();

  const { data } = await supabase
    .from("dolls")
    .select("id, image_url, created_at, role")
    .order("created_at", { ascending: false })
    .limit(50);

  return NextResponse.json({ dolls: data ?? [] });
}

export async function DELETE(req: NextRequest) {
  // 회원 전용 + 동의 완료 게이트(lazy 모델: 미동의 로그인 차단). 익명/무세션/미동의 → 401/403.
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;
  const supabase = await createClient();

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
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;
  const supabase = await createClient();

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
