// 구조화 데이터(JSON-LD) 주입 — 서버 컴포넌트에서 <JsonLd data={...} /> 로 1개/여러 개.
export function JsonLd({ data }: { data: object | object[] }) {
  const arr = Array.isArray(data) ? data : [data];
  return (
    <>
      {arr.map((d, i) => (
        <script
          key={i}
          type="application/ld+json"
          // 신뢰된 서버 데이터(config)만 직렬화 — XSS 방지 위해 '<' 이스케이프.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(d).replace(/</g, "\\u003c") }}
        />
      ))}
    </>
  );
}
