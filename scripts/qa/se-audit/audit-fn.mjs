// 인페이지 측정 스크립트(단일 소스) — audit.mjs 와 one.mjs 가 공유
export const AUDIT_FN = `(() => {
  const vw = document.documentElement.clientWidth;
  const sw = document.documentElement.scrollWidth;
  const out = [];
  const seen = new Set();
  const desc = (el) => {
    const cls = (typeof el.className === "string" ? el.className : "").trim().replace(/\\s+/g, " ").slice(0, 90);
    const txt = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (cls ? "." + cls.split(" ").slice(0, 6).join(".") : "") + (txt ? " «" + txt + "»" : "");
  };
  const chain = (el) => {
    const parts = [];
    let cur = el.parentElement;
    for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
      const cls = (typeof cur.className === "string" ? cur.className : "").trim().split(/\\s+/).slice(0, 3).join(".");
      parts.push(cur.tagName.toLowerCase() + (cls ? "." + cls : ""));
      cur = cur.parentElement;
    }
    return parts.join(" < ");
  };
  const r4 = (r) => ({ l: Math.round(r.left), t: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right) });
  const push = (type, sev, el, extra) => {
    const key = type + "|" + desc(el);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(Object.assign({ type, sev, el: desc(el), chain: chain(el), rect: r4(el.getBoundingClientRect()) }, extra || {}));
  };
  const nearestHeading = (el) => {
    let cur = el;
    while (cur && cur !== document.body) {
      const h = cur.querySelector && cur.querySelector("h1,h2,h3,h4");
      if (h && h.textContent.trim()) return h.textContent.trim().slice(0, 40);
      cur = cur.parentElement;
    }
    return "";
  };
  if (sw > vw + 1) out.push({ type: "doc-overflow", sev: "error", el: "document", chain: "", rect: { w: sw, vw } });
  const all = document.querySelectorAll("body *");
  for (const el of all) {
    if (el.closest("script,style,noscript,svg *")) continue;
    if (el.tagName === "SVG" || el.tagName === "PATH") continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const tag0 = el.tagName;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.width <= 1 && r.height <= 1) continue; // sr-only 등 시각 숨김
    const transformed = (v) => v && v !== "none";
    if (transformed(cs.transform) || transformed(cs.rotate) || transformed(cs.scale) || transformed(cs.translate)) continue; // 회전 스탬프 등 변형 요소(Tailwind v4 는 rotate/scale/translate 개별 속성)
    if (parseFloat(cs.marginLeft) < 0 || parseFloat(cs.marginRight) < 0) continue; // 의도된 블리드(-mx-*)
    const pos = cs.position;
    if (pos === "fixed" || pos === "absolute") {
      if (r.right > vw + 2 || r.left < -2) {
        if (!(el.closest("[aria-hidden='true']"))) push("out-of-viewport", "error", el, { heading: nearestHeading(el) });
      }
      // 절대/고정 요소는 부모 박스 비교에서 제외
    } else {
      const p = el.parentElement;
      if (p && p !== document.body && p !== document.documentElement) {
        const pcs = getComputedStyle(p);
        const pr = p.getBoundingClientRect();
        if (pcs.display !== "contents" && pcs.display !== "inline" && pr.width > 0) {
          const over = r.right > pr.right + 2 || r.left < pr.left - 2;
          if (over) {
            const ox = pcs.overflowX;
            if (ox === "auto" || ox === "scroll") {
              push("scroll-container", "info", p, { heading: nearestHeading(p), childRight: Math.round(r.right), parentRight: Math.round(pr.right) });
            } else if (ox === "hidden" || ox === "clip") {
              push("clipped", "warn", el, { heading: nearestHeading(el), parentRight: Math.round(pr.right) });
            } else {
              push("child-overflow", "error", el, { heading: nearestHeading(el), parentRight: Math.round(pr.right), parent: desc(p) });
            }
          }
        }
      }
    }
    // 자기 내용이 자기 박스를 넘침(텍스트 스필/자식 스필) — 폼 컨트롤 내부 텍스트 스크롤은 네이티브 동작이라 제외
    const formControl = tag0 === "INPUT" || tag0 === "TEXTAREA" || tag0 === "SELECT";
    if (!formControl && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      const excess = el.scrollWidth - el.clientWidth;
      // 미세 초과(≤8px)가 후손의 의도된 블리드(-mx-*)·변형에서 온 것이면 무시
      if (excess <= 8 && [...el.querySelectorAll("*")].some((c) => { const s = getComputedStyle(c); return transformed(s.transform) || transformed(s.rotate) || transformed(s.scale) || transformed(s.translate) || parseFloat(s.marginLeft) < 0 || parseFloat(s.marginRight) < 0; })) continue;
      const ox = cs.overflowX;
      if (ox === "auto" || ox === "scroll") {
        push("scroll-container", "info", el, { heading: nearestHeading(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      } else if (ox === "hidden" || ox === "clip") {
        if (cs.textOverflow === "ellipsis") push("truncated", "info", el, { heading: nearestHeading(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
        else push("clipped", "warn", el, { heading: nearestHeading(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      } else if (ox === "visible") {
        push("content-overflow", "error", el, { heading: nearestHeading(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      }
    }
    // 짧은 라벨(알약·탭·버튼)이 두 줄로 꺾임
    const tag = el.tagName;
    if ((tag === "BUTTON" || tag === "A" || tag === "SPAN" || tag === "LABEL" || tag === "TH" || el.getAttribute("role") === "tab") && el.children.length === 0) {
      const t = (el.textContent || "").trim();
      if (t.length > 0 && t.length <= 8 && !/\\s/.test(t) && cs.whiteSpace !== "nowrap") {
        const range = document.createRange();
        range.selectNodeContents(el);
        const tops = new Set([...range.getClientRects()].filter((b) => b.width > 0).map((b) => Math.round(b.top)));
        if (tops.size >= 2) push("label-wrapped", "warn", el, { heading: nearestHeading(el), lines: tops.size });
      }
    }
  }
  return { vw, sw, findings: out };
})()`;
