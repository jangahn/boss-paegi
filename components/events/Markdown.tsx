import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { firstMarkdownImageSrc, parseEventImageSrc } from "@/lib/events/markdown-image";

// 이벤트/공지 본문 마크다운 렌더 — 어드민 작성이지만 공개 노출이므로 방어적.
//  · rehype-raw 미사용 → raw HTML 미렌더(XSS 안전).
//  · urlTransform: http/https/mailto·내부(/,#)만 허용(javascript: 등 차단).
//  · img: events 버킷 public URL 만 허용(외부 추적 픽셀 차단). a: 외부링크 target/rel 보강.
//  · img 자리(v1.60): 주소 조각의 가로세로(lib/events/markdown-image.ts)로 width/height 를 달아 도착 전에 자리를 잡는다.
//    크기 정보가 없으면 40:21 자리에 맞춘다. 첫 이미지는 바로 받는다(상단 대표 이미지).
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
  // 첫 이미지(상단 대표 이미지)만 lazy 대신 바로 받는다.
  const firstImageSrc = firstMarkdownImageSrc(children);
  return (
    <div className="prose-news flex flex-col gap-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-200 [&_a]:text-steel [&_a]:underline [&_a]:underline-offset-2 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mt-2 [&_h2]:text-lg [&_h2]:font-bold [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_img]:rounded-xl [&_strong]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-foreground/20 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-500 [&_code]:rounded [&_code]:bg-foreground/10 [&_code]:px-1 [&_h1]:text-balance [&_h2]:text-balance [&_h3]:text-balance [&_li]:text-balance [&_p]:text-pretty">
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
          img: ({ src, alt }) => {
            if (typeof src !== "string" || !isEventsImage(src)) return null;
            const { url, size } = parseEventImageSrc(src);
            const loading = src === firstImageSrc ? "eager" : "lazy";
            // 크기를 알면 width/height 만 단다 — 표시는 종전과 같다(원래 크기, 칸보다 크면 칸 폭 · height:auto).
            if (size) {
              // eslint-disable-next-line @next/next/no-img-element
              return <img src={url} alt={alt ?? ""} width={size.width} height={size.height} loading={loading} />;
            }
            return (
              <span className="block aspect-[40/21] w-full">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt={alt ?? ""} loading={loading} className="h-full w-full object-contain" />
              </span>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
