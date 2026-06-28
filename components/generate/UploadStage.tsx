export function UploadStage({
  preview,
  onFile,
  error,
}: {
  preview: string | null;
  onFile: (f: File) => void;
  error: string | null;
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-5">
      <div className="text-center">
        <h1 className="text-3xl font-bold">사진 업로드</h1>
        <p className="mt-2 text-sm text-zinc-500">
          다음 화면에서 얼굴 영역을 직접 맞출 수 있어요.
        </p>
      </div>

      <div className="w-full rounded-2xl border border-foreground/10 ui-surface p-4 text-xs leading-relaxed">
        <p className="mb-2 font-semibold text-foreground/80">좋은 결과를 위한 팁</p>
        <ul className="space-y-1 text-zinc-500">
          <li>
            <span className="text-emerald-400">✓</span> 얼굴이 잘 보이는{" "}
            <strong className="font-semibold text-foreground/80">정면 사진</strong>
          </li>
          <li>
            <span className="text-emerald-400">✓</span> 밝은 곳에서 또렷하게 찍힌 사진
          </li>
          <li>
            <span className="text-emerald-400">✓</span> 모자·마스크는 벗고 찍으면 더
            잘 나와요 <span className="text-zinc-600">(안경은 그대로 반영돼요)</span>
          </li>
          <li>
            <span className="text-rose-400">✗</span> 옆모습·어두운·흐릿한 사진,
            여러 명이 함께 찍힌 사진은 피해주세요
          </li>
        </ul>
      </div>

      <label className="flex aspect-[3/4] w-full cursor-pointer items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-foreground/20 bg-foreground/5 transition hover:bg-foreground/10 active:bg-foreground/15">
        {preview ? (
          // sentry-block-face: 업로드 원본 얼굴은 Session Replay 에서 차단(정책 #1/PIPA)
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt=""
            data-sentry-block
            className="sentry-block-face h-full w-full object-cover"
          />
        ) : (
          <span className="text-zinc-500">탭해서 사진 선택</span>
        )}
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
      </label>

      <div className="w-full space-y-1 text-center text-[11px] leading-relaxed text-zinc-500">
        <p>업로드한 원본은 캐릭터 생성 직후 자동으로 폐기됩니다.</p>
        <p>결과가 마음에 안 들면 다시 만들 수 있어요 — 매번 조금씩 달라져요.</p>
      </div>

      {error && (
        <p className="w-full rounded-lg bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
