// These functions are INJECTED into the page via chrome.scripting.executeScript.
// They must be fully self-contained (no imports / outer-scope references), because
// only their source is shipped into the page context.

export function getPageInfo(maxChars: number) {
  function selectorFor(el: Element): string {
    if ((el as HTMLElement).id) return "#" + CSS.escape((el as HTMLElement).id);
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if ((node as HTMLElement).id) {
        parts.unshift("#" + CSS.escape((node as HTMLElement).id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  const sel = "a, button, input, textarea, select, [role=button], [role=link], [onclick], [contenteditable=true]";
  const nodes = Array.from(document.querySelectorAll(sel)).slice(0, 200);
  const elements = nodes
    .map((el) => {
      const he = el as HTMLElement;
      const label =
        (he.innerText || "").trim().slice(0, 80) ||
        el.getAttribute("aria-label") ||
        (el as HTMLInputElement).placeholder ||
        el.getAttribute("name") ||
        el.getAttribute("value") ||
        "";
      return {
        tag: el.tagName.toLowerCase(),
        type: (el as HTMLInputElement).type || "",
        label,
        selector: selectorFor(el),
      };
    })
    .filter((e) => e.label || e.tag === "input" || e.tag === "textarea");

  const text = (document.body ? document.body.innerText : "").slice(0, maxChars);
  return { url: location.href, title: document.title, text, elements };
}

export function clickBySelector(selector: string): string {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return "not found: " + selector;
  el.scrollIntoView({ block: "center" });
  el.click();
  return "clicked " + selector;
}

export function typeBySelector(selector: string, text: string): string {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return "not found: " + selector;
  el.focus();
  if ("value" in (el as any)) {
    (el as HTMLInputElement).value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    el.textContent = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return "typed into " + selector;
}

export function extractBySelector(selector: string): string {
  const els = Array.from(document.querySelectorAll(selector));
  if (!els.length) return "not found: " + selector;
  return els
    .map((e) => ((e as HTMLElement).innerText || e.textContent || "").trim())
    .join("\n")
    .slice(0, 6000);
}
