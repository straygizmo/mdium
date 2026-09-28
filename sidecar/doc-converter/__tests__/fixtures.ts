// Builders for small Office/PDF documents used by the converter tests.
import JSZip from "jszip";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import * as XLSX from "xlsx";

export async function buildDocx(): Promise<Uint8Array> {
  const cell = (text: string) => new TableCell({ children: [new Paragraph(text)] });
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: "Quarterly Report", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun("Revenue grew "), new TextRun({ text: "strongly", bold: true })] }),
          new Table({
            rows: [
              new TableRow({ children: [cell("Region"), cell("Sales")] }),
              new TableRow({ children: [cell("East"), cell("120")] }),
            ],
          }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

export function buildXlsx(): Uint8Array {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Item", "Qty"],
    ["Apple", 3],
    ["Pear", 5],
  ]);
  XLSX.utils.book_append_sheet(wb, sheet, "Stock");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

/** A one-slide pptx with a title, a bullet, speaker notes and an image. */
export async function buildPptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?>
     <p:presentation xmlns:p="${NS_P}" xmlns:r="${NS_R}">
       <p:sldIdLst><p:sldId r:id="rA"/></p:sldIdLst>
     </p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?>
     <Relationships xmlns="${NS_REL}">
       <Relationship Id="rA" Type="${NS_R}/slide" Target="slides/slide1.xml"/>
     </Relationships>`,
  );
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0"?>
     <p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">
       <p:cSld><p:spTree>
         <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
           <p:txBody><a:p><a:r><a:t>Roadmap</a:t></a:r></a:p></p:txBody></p:sp>
         <p:sp><p:nvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
           <p:txBody><a:p><a:r><a:t>Ship the converter</a:t></a:r></a:p></p:txBody></p:sp>
         <p:pic><p:blipFill><a:blip r:embed="rImg"/></p:blipFill></p:pic>
       </p:spTree></p:cSld></p:sld>`,
  );
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    `<?xml version="1.0"?>
     <Relationships xmlns="${NS_REL}">
       <Relationship Id="rImg" Type="${NS_R}/image" Target="../media/image1.png"/>
       <Relationship Id="rN" Type="${NS_R}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
     </Relationships>`,
  );
  zip.file(
    "ppt/notesSlides/notesSlide1.xml",
    `<?xml version="1.0"?>
     <p:notes xmlns:p="${NS_P}" xmlns:a="${NS_A}">
       <p:cSld><p:spTree>
         <p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
           <p:txBody><a:p><a:r><a:t>Mention the deadline</a:t></a:r></a:p></p:txBody></p:sp>
       </p:spTree></p:cSld></p:notes>`,
  );
  zip.file("ppt/media/image1.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  return zip.generateAsync({ type: "uint8array" });
}

/**
 * A minimal valid PDF: one page per entry, each line drawn with Helvetica at
 * the given size, top to bottom.
 */
export function buildPdf(pages: { text: string; size: number }[][]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add("");
  const pagesObj = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];
  for (const lines of pages) {
    let y = 780;
    const ops = lines
      .map(({ text, size }) => {
        y -= size * 2;
        const escaped = text.replace(/[\\()]/g, (c) => `\\${c}`);
        return `BT /F1 ${size} Tf 72 ${y} Td (${escaped}) Tj ET`;
      })
      .join("\n");
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
