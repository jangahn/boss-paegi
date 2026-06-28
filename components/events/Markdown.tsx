import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// 이벤트/공지 본문 마크다운 렌더 — 어드민 작성이지만 공개 노출이므로 방어적.
//  · rehype-raw 미사용 → raw HTML 미렌더(XSS 안전).
//  · urlTransform: http/https/mailto·내부(/,#)만 허용(javascript: 등 차단).
//  · img: events 버킷 public URL 만 허용(외부 추적 픽셀 차단). a: 외부링크 target/rel 보강.
// "use client" 없음 → 서버(상세 페이지)·클라(에디터 미리보기) 양쪽 렌더.

const EVENTS_PUBLIC_PREFIX = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/events/`;

function safeUrl(url: string): string {
  const u = url.trim();
  if (u.startsWith("/") || u.startsWith("#")) return u; // 내부
  try {
    const parsed = new URL(u);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? u : "";
  } catch {
    return ""; // 파싱 불가(상대·이상) → 차단
  }
}

function isEventsImage(src: string): boolean {
  return EVENTS_PUBLIC_PREFIX.length > "/storage/v1/object/public/events/".length && src.startsWith(EVENTS_PUBLIC_PREFIX);
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-news flex flex-col gap-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-200 [&_a]:text-steel [&_a]:underline [&_a]:underline-offset-2 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mt-2 [&_h2]:text-lg [&_h2]:font-bold [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_img]:rounded-xl [&_strong]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-foreground/20 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-500 [&_code]:rounded [&_code]:bg-foreground/10 [&_code]:px-1">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          a: ({ href, children }) => {
            const external = typeof href === "string" && /^https?:\/\//i.test(href);
            return (
              <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                {children}
              </a>
            );
          },
          img: ({ src, alt }) =>
            typeof src === "string" && isEventsImage(src) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt={alt ?? ""} loading="lazy" />
            ) : null,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
