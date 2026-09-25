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
    // 의도치 않은 두 줄(v1.57, v1.58 다듬음) — 더 쪼개지지 않는 블록(칸 · 버튼 · 문단 · 목록 항목 · 플렉스 항목, 자식이 전부 인라인)마다
    // ① 짧은 글(공백 빼고 12자 이하: 닉네임 · 값 · 버튼)이 꺾이거나 ② 60자 이하 글의 마지막 줄이 한두 글자뿐인 꼬리 줄바꿈
    // (결재란 「광견병걸린너구 / 리」, 판정 등급 「…시작됐습 / 니다」). 문단 속 굵은 글씨처럼 흐르다 줄이 바뀌는 인라인 요소는
    // 그 문단 전체로 보고, 절대 · 고정 위치 자식(숫자 배지 등)의 글자는 줄 계산에서 뺀다.
    const leafBlock = !["inline", "contents"].includes(cs.display) && ![...el.children].some((c) => {
      const d = getComputedStyle(c).display;
      return d !== "inline" && d !== "none";
    });
    if (leafBlock && cs.whiteSpace !== "nowrap" && !formControl && tag !== "OPTION") {
      const full = (el.innerText || "").replace(/\\s+/g, " ").trim();
      const visibleLen = full.replace(/\\s/g, "").length;
      if (visibleLen > 0 && full.length <= 60) {
        const rows = [];
        const rg = document.createRange();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          let skip = false;
          for (let a = n.parentElement; a && a !== el; a = a.parentElement) {
            const ps = getComputedStyle(a).position;
            if (ps === "absolute" || ps === "fixed") { skip = true; break; }
          }
          if (skip) continue;
          const t = n.textContent;
          for (let i = 0; i < t.length; ) {
            const cp = t.codePointAt(i);
            const len = cp > 0xffff ? 2 : 1;
            if (!/\\s/.test(t[i])) {
              rg.setStart(n, i);
              rg.setEnd(n, i + len);
              const b = rg.getBoundingClientRect();
              if (b.width > 0 || b.height > 0) {
                // 같은 줄 = 세로로 절반 이상 겹침(글자 크기가 섞인 줄 — 24px 숫자 옆 12px 「점」 — 은 윗변이 10px 넘게 달라도 한 줄)
                const row = rows.find((x) => Math.min(x.bottom, b.bottom) - Math.max(x.top, b.top) > 0.5 * Math.min(x.bottom - x.top, b.height));
                if (row) { row.count += 1; row.top = Math.min(row.top, b.top); row.bottom = Math.max(row.bottom, b.bottom); }
                else rows.push({ top: b.top, bottom: b.bottom, count: 1 });
              }
            }
            i += len;
          }
        }
        if (rows.length >= 2) {
          const last = rows.reduce((a, b) => (b.top > a.top ? b : a));
          if (visibleLen <= 12) push("short-wrapped", "warn", el, { heading: nearestHeading(el), lines: rows.length });
          if (last.count <= 2) push("orphan-wrap", "warn", el, { heading: nearestHeading(el), lines: rows.length, lastLine: last.count });
        }
      }
    }
  }
  return { vw, sw, findings: out };
})()`;
