import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getAdminEventById } from "@/lib/events";
import { EventEditor } from "@/components/admin/EventEditor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminEventEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const { id } = await params;
  const isNew = id === "new";
  const event = isNew ? null : await getAdminEventById(id);
  if (!isNew && !event) notFound();

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <Link href="/admin/events" className="text-xs text-zinc-500 hover:text-foreground">
          ← 이벤트/소식
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{isNew ? "새 글 작성" : "글 편집"}</h1>
        <EventEditor key={event?.id ?? "new"} event={event} />
      </div>
    </main>
  );
}
