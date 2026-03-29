import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

const apiKey = process.env.GEMINI_API_KEY ?? "";
const model = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-image-preview";
const outputDir = process.env.IMAGE_OUTPUT_DIR || path.join(process.cwd(), "images");

const ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
  "1:4",
  "4:1",
  "1:8",
  "8:1",
] as const;

const IMAGE_SIZES = ["512", "1K", "2K", "4K"] as const;

const server = new McpServer({
  name: "nano-banana-2",
  version: "1.0.0",
});

server.tool(
  "generate_image",
  "Generate an image from a text description using Gemini and save it to disk",
  {
    prompt: z.string().describe("Description of the image to generate"),
    filename: z.string().describe("Output filename (e.g. architecture-diagram.png)"),
    aspectRatio: z
      .enum(ASPECT_RATIOS)
      .default("16:9")
      .describe("Aspect ratio of the generated image"),
    imageSize: z
      .enum(IMAGE_SIZES)
      .default("1K")
      .describe("Resolution of the generated image"),
  },
  async ({ prompt, filename, aspectRatio, imageSize }) => {
    try {
      const dir = outputDir;
      fs.mkdirSync(dir, { recursive: true });

      const safeName = path.basename(filename);
      const filePath = path.join(dir, safeName);

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: {
            aspectRatio,
            imageSize,
          },
        },
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: [
            { type: "text" as const, text: `Error: Gemini API returned ${response.status}: ${errorText}` },
          ],
        };
      }

      const result = await response.json();

      // Extract base64 image data from Gemini response
      const parts = result.candidates?.[0]?.content?.parts;
      const imagePart = parts?.find(
        (p: { inlineData?: { mimeType: string; data: string } }) => p.inlineData
      );

      if (!imagePart?.inlineData?.data) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: No image data in response. Response: ${JSON.stringify(result).slice(0, 500)}`,
            },
          ],
        };
      }

      fs.writeFileSync(filePath, Buffer.from(imagePart.inlineData.data, "base64"));

      const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              path: `/images/${safeName}`,
              absolutePath: filePath,
              relativePath,
              mimeType: imagePart.inlineData.mimeType,
            }),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error generating image: ${message}` }],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
