import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { searchMembers, findWithdrawnByEmail } from "@/lib/admin-users";
import { MemberSearch } from "@/components/admin/MemberSearch";
import { fmtKst, shortId, firstParam } from "@/lib/admin-format";
import { PaperPanel } from "@/components/dossier";

// 회원 검색 — 실시간 운영이라 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const sp = await searchParams;
  const q = firstParam(sp.q)?.trim() || null;
  // 활성 회원(search_members) + 탈퇴자 원본 이메일 매칭(0037 — 스크럽돼 search_members 가 못 찾음).
  const [candidates, withdrawn] = q
    ? await Promise.all([searchMembers(q), findWithdrawnByEmail(q)])
    : [[], []];

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <h1 className="font-bold text-2xl sm:text-3xl">회원 관리</h1>
        <MemberSearch q={q} />

        {q === null ? (
          <p className="text-sm text-zinc-500">
            이메일·닉네임(부분 일치) 또는 userId(정확)로 검색하세요. 탈퇴 회원은 원본 이메일로 찾을 수 있어요.
          </p>
        ) : candidates.length === 0 && withdrawn.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-foreground/15 p-8 text-center text-sm text-zinc-500">
            &ldquo;{q}&rdquo; 에 해당하는 회원이 없어요.
          </p>
        ) : (
          <>
            {candidates.length > 0 && (
              <>
                <p className="text-xs text-zinc-500">
                  활성 회원 {candidates.length}
                  {candidates.length >= 30 ? "+" : ""}명
                </p>
                <PaperPanel className="p-1.5">
                  <ul className="flex flex-col gap-1.5">
                    {candidates.map((c) => (
                      <li key={c.userId} className="min-w-0">
                        <Link
                          href={`/admin/users/${c.userId}`}
                          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-foreground/10 bg-foreground/5 p-3 text-sm transition hover:bg-foreground/10"
                        >
                          <b>{c.displayName ?? "(닉네임 없음)"}</b>
                          {c.isAdmin && (
                            <span className="rounded-lg border border-emerald-600/40 px-1.5 text-[10px] text-emerald-600">
                              admin
                            </span>
                          )}
                          <span className="text-zinc-500">{c.email ?? "—"}</span>
                          <span className="ml-auto whitespace-nowrap text-xs text-zinc-400">
                            크레딧 {c.genCredits} · 가입 {fmtKst(c.memberSince)} · {shortId(c.userId)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </PaperPanel>
              </>
            )}

            {withdrawn.length > 0 && (
              <>
                <p className="mt-2 text-xs text-red-500">
                  탈퇴 회원(원본 이메일 일치) {withdrawn.length}명 — 상세에서 재활성 가능
                </p>
                <PaperPanel className="p-1.5">
                  <ul className="flex flex-col gap-1.5">
                    {withdrawn.map((w) => (
                      <li key={w.userId} className="min-w-0">
                        <Link
                          href={`/admin/users/${w.userId}`}
                          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm transition hover:bg-red-500/10"
                        >
                          <span className="rounded-lg border border-red-500/40 px-1.5 text-[10px] text-red-500">
                            탈퇴
                          </span>
                          <span className="text-zinc-500">{w.originalEmail ?? "—"}</span>
                          <span className="ml-auto whitespace-nowrap text-xs text-zinc-400">
                            탈퇴 {fmtKst(w.deletedAt)} · {shortId(w.userId)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </PaperPanel>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
