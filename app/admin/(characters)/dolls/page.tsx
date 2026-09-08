import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { listDolls, DOLL_STATE_FILTERS, type DollStateFilter } from "@/lib/admin-dolls";
import { DollFilterBar } from "@/components/admin/DollFilterBar";
import { DollsTable } from "@/components/admin/DollsTable";
import { Pagination } from "@/components/Pagination";
import { firstParam } from "@/lib/admin-format";
import { parsePageParam } from "@/lib/pagination";
import { isRoleId } from "@/lib/roles";
import { isGender } from "@/lib/gender";

// 캐릭터 현재 상태 — 실시간 운영이라 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminDollsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const sp = await searchParams;
  const ownerId = firstParam(sp.ownerId)?.trim() || null;
  const stateRaw = firstParam(sp.state);
  const state: DollStateFilter =
    stateRaw && (DOLL_STATE_FILTERS as readonly string[]).includes(stateRaw)
      ? (stateRaw as DollStateFilter)
      : "all";
  const roleRaw = firstParam(sp.role);
  const role = isRoleId(roleRaw) ? roleRaw : null;
  const genderRaw = firstParam(sp.gender);
  const gender = isGender(genderRaw) ? genderRaw : null;
  const page = parsePageParam(firstParam(sp.page));

  const buildHref = (p: number) => {
    const u = new URLSearchParams();
    if (state !== "all") u.set("state", state);
    if (role) u.set("role", role);
    if (gender) u.set("gender", gender);
    if (ownerId) u.set("ownerId", ownerId);
    if (p > 1) u.set("page", String(p));
    const qs = u.toString();
    return `/admin/dolls${qs ? `?${qs}` : ""}`;
  };

  const result = await listDolls({ state, role, gender, ownerId, page });
  if (result.rows.length === 0 && page > 1) redirect(buildHref(1));
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const filtered = !!(ownerId || role || gender || state !== "all");

  return (
    <>
        <p className="text-xs leading-relaxed text-zinc-500">
          지금 살아 있는 <b>캐릭터(결과물)</b>의 현재 상태입니다. 롤·성별은 <b>현재값</b>이며 캐릭터 상세에서만
          바꿀 수 있어요(생성 뒤 유저는 못 바꿈). <b>숨김</b>=신고 처리로 감춤(복구 가능) · <b>영구삭제</b>=객체 제거.
          만들던 과정(요청·거부·후보·크레딧)은 「생성 현황」 탭에서 봅니다.
        </p>

        <DollFilterBar state={state} role={role} gender={gender} ownerId={ownerId} />

        <p className="text-xs text-zinc-500">
          {result.total.toLocaleString()}개{filtered && " (필터 적용)"}
        </p>

        {result.rows.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-foreground/15 p-12 text-center text-zinc-500">
            {filtered ? "조건에 맞는 캐릭터가 없어요." : "캐릭터가 없어요."}
          </p>
        ) : (
          <DollsTable rows={result.rows} />
        )}

        <Pagination page={result.page} totalPages={totalPages} hrefFor={buildHref} />
    </>
  );
}
