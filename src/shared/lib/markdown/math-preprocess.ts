export function preprocessMath(text: string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;

      part = part.replace(/\$\$([^$]+?)\$\$/gs, (_, math) => {
        const encoded = btoa(unescape(encodeURIComponent(math.trim())));
        return `<div class="math-block" data-math="${encoded}"></div>`;
      });

      part = part.replace(/\$([^$\n]+?)\$/g, (_, math) => {
        const encoded = btoa(unescape(encodeURIComponent(math.trim())));
        return `<span class="math-inline" data-math="${encoded}"></span>`;
      });

      return part;
    })
    .join("");
}
