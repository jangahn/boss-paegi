import Link from "next/link";

/**
 * 「캐릭터 생성」 메뉴 아래 두 목록의 탭 — 생성 기록(과정, ai_generations) ↔ 캐릭터(결과, dolls).
 * 메뉴 항목을 늘리지 않고 두 대상이 과정/결과 관계임을 탭으로 드러낸다(v1.29).
 */
export function CharacterTabs({ active }: { active: "generations" | "dolls" }) {
  const tabs = [
    { key: "generations", href: "/admin/generations", label: "생성 기록" },
    { key: "dolls", href: "/admin/dolls", label: "캐릭터" },
  ] as const;
  return (
    <nav aria-label="캐릭터 생성 하위 탭" className="flex flex-wrap gap-1">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition ${
            t.key === active ? "bg-foreground text-paper-2" : "bg-foreground/5 text-zinc-500 hover:bg-foreground/10"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
