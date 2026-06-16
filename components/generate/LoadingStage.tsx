export function LoadingStage({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="m-auto flex flex-col items-center gap-4 text-center">
      <div className="h-16 w-16 animate-spin rounded-full border-4 border-foreground/20 border-t-foreground" />
      <p className="text-lg font-medium">{label}</p>
      {sub && <p className="text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}
