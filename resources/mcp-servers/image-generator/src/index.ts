import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";

const provider = process.env.IMAGE_PROVIDER ?? "openai";
const apiKey = process.env.IMAGE_API_KEY ?? "";
const model = process.env.IMAGE_MODEL ?? "dall-e-3";
const outputDir = process.env.IMAGE_OUTPUT_DIR ?? process.cwd();

const server = new McpServer({
  name: "image-generator",
  version: "1.0.0",
});

server.tool(
  "generate_image",
  "Generate an image from a text description and save it to disk",
  {
    prompt: z.string().describe("Description of the image to generate"),
    width: z.number().default(1024).describe("Image width in pixels"),
    height: z.number().default(768).describe("Image height in pixels"),
    filename: z.string().describe("Output filename (e.g. architecture-diagram.png)"),
  },
  async ({ prompt, width, height, filename }) => {
    try {
      const dir = outputDir;
      fs.mkdirSync(dir, { recursive: true });

      const safeName = path.basename(filename);
      const filePath = path.join(dir, safeName);

      if (provider === "openai") {
        const client = new OpenAI({ apiKey });

        // DALL-E 3 only supports specific sizes
        const size = mapToSupportedSize(width, height);

        const response = await client.images.generate({
          model,
          prompt,
          n: 1,
          size,
          response_format: "b64_json",
        });

        const b64 = response.data[0]?.b64_json;
        if (!b64) {
          return { content: [{ type: "text", text: "Error: No image data returned" }] };
        }

        fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
      } else {
        return {
          content: [{ type: "text", text: `Error: Unsupported provider "${provider}"` }],
        };
      }

      const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              path: `/images/${filename}`,
              absolutePath: filePath,
              relativePath,
            }),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error generating image: ${message}` }] };
    }
  }
);

/** Map requested dimensions to DALL-E 3 supported sizes */
function mapToSupportedSize(width: number, height: number): "1024x1024" | "1024x1792" | "1792x1024" {
  const ratio = width / height;
  if (ratio > 1.3) return "1792x1024";  // landscape
  if (ratio < 0.77) return "1024x1792"; // portrait
  return "1024x1024";                    // square
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
