/** A file produced next to the generated Markdown (images, shapes). */
export interface ConvertedAsset {
  /** Path relative to the Markdown file's directory, always "/"-separated. */
  path: string;
  data: Uint8Array;
}

/** Result of converting one document, before anything is written to disk. */
export interface ConvertedDocument {
  markdown: string;
  assets: ConvertedAsset[];
}
