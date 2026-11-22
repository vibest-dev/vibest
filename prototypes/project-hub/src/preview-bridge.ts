const BRIDGE_SCRIPT = `<script data-vibest-hub-bridge="true">
(() => {
  const esc = (val) => (window.CSS && typeof window.CSS.escape === "function" ? window.CSS.escape(val) : String(val).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&"));

  function buildUniqueSelector(el) {
    if (el.id) return "#" + esc(el.id);
    const parts = [];
    let current = el;
    while (current && current.tagName && current.tagName.toLowerCase() !== "html" && parts.length < 4) {
      const tag = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift("#" + esc(current.id));
        break;
      }
      const cls = Array.from(current.classList || []).slice(0, 2);
      const clsSuffix = cls.length > 0 ? "." + cls.map((c) => esc(c)).join(".") : "";
      const parentEl = current.parentElement;
      if (parentEl) {
        const sameTag = Array.from(parentEl.children).filter((sib) => sib.tagName === current.tagName);
        if (sameTag.length > 1) {
          const idx = sameTag.indexOf(current) + 1;
          parts.unshift(tag + clsSuffix + ":nth-of-type(" + idx + ")");
        } else {
          parts.unshift(tag + clsSuffix);
        }
      } else {
        parts.unshift(tag + clsSuffix);
      }
      current = parentEl;
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }

  function inspectTarget(el) {
    if (!el || el === document.documentElement || el === document.body || el.hasAttribute("data-vibest-hub-bridge")) {
      return null;
    }
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    return {
      selector: buildUniqueSelector(el),
      tagName: el.tagName.toLowerCase(),
      textPreview: String(el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 48),
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      xRatio: r.left / vw,
      yRatio: r.top / vh,
      wRatio: r.width / vw,
      hRatio: r.height / vh,
    };
  }

  let trackedSelectors = [];

  function computeTrackedRects() {
    const rects = {};
    for (const item of trackedSelectors) {
      if (!item || !item.id || !item.selector) continue;
      try {
        const matched = document.querySelector(item.selector);
        if (matched && !matched.hasAttribute("data-vibest-hub-bridge")) {
          const r = matched.getBoundingClientRect();
          rects[item.id] = { left: r.left, top: r.top, width: r.width, height: r.height };
        } else {
          rects[item.id] = null;
        }
      } catch {
        rects[item.id] = null;
      }
    }
    return rects;
  }

  function emitTrackedRects() {
    if (trackedSelectors.length === 0) return;
    window.parent.postMessage({
      source: "vibest-hub-bridge",
      type: "selector-rects",
      rects: computeTrackedRects(),
    }, "*");
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.source !== "vibest-hub-parent") return;
    if (d.type === "inspect-point") {
      const el = document.elementFromPoint(Number(d.x) || 0, Number(d.y) || 0);
      window.parent.postMessage({
        source: "vibest-hub-bridge",
        type: "hover-element",
        target: inspectTarget(el),
      }, "*");
    } else if (d.type === "pick-point") {
      const el = document.elementFromPoint(Number(d.x) || 0, Number(d.y) || 0);
      window.parent.postMessage({
        source: "vibest-hub-bridge",
        type: "picked-element",
        target: inspectTarget(el),
      }, "*");
    } else if (d.type === "query-selectors") {
      trackedSelectors = Array.isArray(d.threads) ? d.threads : [];
      emitTrackedRects();
    } else if (d.type === "scroll-by") {
      window.scrollBy(Number(d.dx) || 0, Number(d.dy) || 0);
      emitTrackedRects();
    }
  });

  window.addEventListener("scroll", () => requestAnimationFrame(emitTrackedRects), { passive: true });
  window.addEventListener("resize", () => requestAnimationFrame(emitTrackedRects));
  document.addEventListener("click", () => requestAnimationFrame(emitTrackedRects), true);

  const notifyReady = () => {
    window.parent.postMessage({ source: "vibest-hub-bridge", type: "bridge-ready" }, "*");
    emitTrackedRects();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", notifyReady, { once: true });
  } else {
    notifyReady();
  }
})();
</script>`

export function injectHtmlPreviewBridge(rawHtml: string): string {
  const closeBodyMatch = /<\/body\s*>/i.exec(rawHtml)

  if (closeBodyMatch) {
    return rawHtml.slice(0, closeBodyMatch.index) + BRIDGE_SCRIPT + rawHtml.slice(closeBodyMatch.index)
  }

  const closeHtmlMatch = /<\/html\s*>/i.exec(rawHtml)

  if (closeHtmlMatch) {
    return rawHtml.slice(0, closeHtmlMatch.index) + BRIDGE_SCRIPT + rawHtml.slice(closeHtmlMatch.index)
  }

  return `${rawHtml}\n${BRIDGE_SCRIPT}`
}
