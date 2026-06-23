import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// CS 조정 대상 조회 — userId(uuid) / 이메일 / 닉네임. 관리자만.
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as { query?: string } | null;
  const q = body?.query?.trim();
  if (!q) return NextResponse.json({ error: "missing_query" }, { status: 400 });

  const admin = createAdminClient();
  let userId: string | null = null;

  try {
    if (UUID_RE.test(q)) {
      userId = q;
    } else if (q.includes("@")) {
      const { data } = await admin
        .from("member_accounts")
        .select("user_id")
        .eq("email", q)
        .maybeSingle();
      userId = (data?.user_id as string | undefined) ?? null;
    } else {
      // 닉네임 — 동명이인 가능 → 정확히 1명일 때만.
      const { data } = await admin
        .from("profiles")
        .select("id")
        .eq("display_name", q)
        .limit(2);
      if ((data?.length ?? 0) === 1) userId = data![0].id as string;
      else if ((data?.length ?? 0) > 1)
        return NextResponse.json({ error: "ambiguous_nickname" }, { status: 409 });
    }

    if (!userId) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const { data: m } = await admin
      .from("member_accounts")
      .select("user_id, gen_credits, profiles(display_name)")
      .eq("user_id", userId)
      .maybeSingle();
    if (!m) return NextResponse.json({ error: "not_a_member" }, { status: 404 });

    const prof = m.profiles as
      | { display_name: string | null }
      | { display_name: string | null }[]
      | null;
    const displayName = (Array.isArray(prof) ? prof[0] : prof)?.display_name ?? null;

    return NextResponse.json({
      userId: m.user_id,
      displayName,
      genCredits: m.gen_credits,
    });
  } catch (e) {
    log.warn("admin.lookup_fail", { adminId: gate.user.id, ...errInfo(e) });
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
}
