export function makeHeadingId(text: string): string {
  return (
    "heading-" +
    text
      .toLowerCase()
      .replace(/[^\w\s\u3040-\u9fff-]/g, "")
      .replace(/\s+/g, "-")
  );
}
