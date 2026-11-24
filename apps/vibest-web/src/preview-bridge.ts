const BRIDGE_SCRIPT = `<script data-vibest-web-bridge="true">
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
    if (!el || el === document.documentElement || el === document.body || el.hasAttribute("data-vibest-web-bridge")) {
      return null;
    }
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    return {
      selector: buildUniqueSelector(el),
      tagName: el.tagName.toLowerCase(),
      textPreview: String(el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 56),
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

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.source !== "vibest-web-parent") return;
    if (d.type === "inspect-point") {
      const el = document.elementFromPoint(Number(d.x) || 0, Number(d.y) || 0);
      window.parent.postMessage({
        source: "vibest-web-bridge",
        type: "hover-element",
        target: inspectTarget(el),
      }, "*");
    } else if (d.type === "pick-point") {
      const el = document.elementFromPoint(Number(d.x) || 0, Number(d.y) || 0);
      window.parent.postMessage({
        source: "vibest-web-bridge",
        type: "picked-element",
        target: inspectTarget(el),
      }, "*");
    } else if (d.type === "scroll-by") {
      window.scrollBy(Number(d.dx) || 0, Number(d.dy) || 0);
    }
  });

  const notifyReady = () => {
    window.parent.postMessage({ source: "vibest-web-bridge", type: "bridge-ready" }, "*");
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
