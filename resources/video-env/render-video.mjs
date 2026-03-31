/**
 * MDium Video Render Script
 *
 * Usage: node render-video.mjs <temp-dir> <output-path> [--fps 30] [--concurrency 4] [--format mp4]
 *
 * The temp-dir must contain:
 *   - project.json (VideoProject data)
 *   - A Vite project set up with the composition
 *   - node_modules installed
 *
 * Communicates progress via stdout JSON lines:
 *   {"type":"status","message":"..."}
 *   {"type":"progress","phase":"render"|"encode","percent":0-100}
 *   {"type":"done","outputPath":"..."}
 *   {"type":"error","message":"..."}
 */

import { execSync, spawn } from "child_process";
import { existsSync, readFileSync, mkdirSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import http from "http";

const args = process.argv.slice(2);
const tempDir = args[0];
const outputPath = args[1];

function getArg(name, defaultVal) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const fps = parseInt(getArg("--fps", "30"), 10);
const concurrency = parseInt(getArg("--concurrency", "4"), 10);
const format = getArg("--format", "mp4");

function log(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function startViteServer(projectDir, port) {
  log({ type: "status", message: "Starting Vite dev server..." });

  const isWin = process.platform === "win32";
  const npxCmd = isWin ? "npx.cmd" : "npx";

  const vite = spawn(npxCmd, ["vite", "--port", String(port), "--host", "127.0.0.1"], {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWin,
    ...(isWin ? { windowsHide: true } : {}),
  });

  // Forward Vite stderr for diagnostics
  if (vite.stderr) {
    vite.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) console.error(`[vite] ${text}`);
    });
  }

  // Wait for server to be ready
  const maxWait = 60000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await fetch(`http://127.0.0.1:${port}`);
      log({ type: "status", message: `Vite server ready on port ${port}` });
      return vite;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  vite.kill();
  throw new Error("Vite server failed to start within 60s");
}

async function verifyPlaywrightBrowser() {
  try {
    const { chromium } = await import(
      pathToFileURL(path.join(tempDir, "node_modules", "playwright/index.mjs")).href
    ).catch(() => import("playwright"));

    const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
    if (!existsSync(execPath)) {
      throw new Error(
        `Chromium not found at: ${execPath}. ` +
        `Run 'npx playwright install chromium' to install it.`
      );
    }
    log({ type: "status", message: `Chromium found: ${execPath}` });
  } catch (e) {
    if (e.message && e.message.includes("Chromium not found")) throw e;
    // If we can't check, continue and let launch() fail with a better error
    log({ type: "status", message: `Browser check skipped: ${e.message}` });
  }
}

async function renderFrames(url, config, framesDir, concurrencyCount) {
  log({ type: "status", message: "Rendering frames..." });
  mkdirSync(framesDir, { recursive: true });

  // Verify Playwright browser is available
  await verifyPlaywrightBrowser();

  // Verify critical files exist in temp dir
  const mainTsx = path.join(tempDir, "src", "main.tsx");
  const compositionDir = path.join(tempDir, "src", "composition");
  const typesTs = path.join(tempDir, "types.ts");
  if (!existsSync(mainTsx)) {
    throw new Error(`Template main.tsx not found: ${mainTsx}`);
  }
  if (!existsSync(compositionDir)) {
    throw new Error(`Composition directory not found: ${compositionDir}`);
  }
  if (!existsSync(typesTs)) {
    throw new Error(`types.ts not found: ${typesTs}`);
  }

  // Dynamic import of renderer (uses playwright)
  const { renderFrames: render } = await import(
    pathToFileURL(path.join(tempDir, "node_modules", "@open-motion/renderer/src/index.ts")).href
  ).catch(() => {
    // Fallback: use vendored renderer directly
    return import(pathToFileURL(path.join(tempDir, "open-motion/renderer/src/index.ts")).href);
  });

  const result = await render({
    url,
    config,
    outputDir: framesDir,
    compositionId: "video-project",
    concurrency: concurrencyCount,
    onProgress: (frame) => {
      const percent = Math.round((frame / config.durationInFrames) * 100);
      log({ type: "progress", phase: "render", percent });
    },
  });

  return result.audioAssets || [];
}

async function encodeVideo(framesDir, outputFile, videoFps, audioAssets, durationInFrames) {
  log({ type: "status", message: "Encoding video..." });

  const { encodeVideo: encode } = await import(
    pathToFileURL(path.join(tempDir, "node_modules", "@open-motion/encoder/src/index.ts")).href
  ).catch(() => {
    return import(pathToFileURL(path.join(tempDir, "open-motion/encoder/src/index.ts")).href);
  });

  await encode({
    framesDir,
    fps: videoFps,
    outputFile,
    audioAssets,
    durationInFrames,
    onProgress: (percent) => {
      log({ type: "progress", phase: "encode", percent: Math.round(percent) });
    },
  });
}

async function main() {
  try {
    if (!tempDir || !outputPath) {
      throw new Error("Usage: node render-video.mjs <temp-dir> <output-path>");
    }

    const projectJson = JSON.parse(readFileSync(path.join(tempDir, "project.json"), "utf-8"));
    const totalDuration = calculateTotalDuration(projectJson);
    const config = {
      width: projectJson.meta.width,
      height: projectJson.meta.height,
      fps: fps,
      durationInFrames: totalDuration,
    };

    // 1. Start Vite dev server
    const port = await findAvailablePort();
    const viteProcess = await startViteServer(tempDir, port);

    try {
      const url = `http://127.0.0.1:${port}`;
      const framesDir = path.join(tempDir, "frames");

      // 2. Render frames with Playwright
      // Note: page-level Audio components also collect audio assets, but we
      // build the audio list solely from the project JSON to avoid duplicates
      // and to use reliable local file paths (not Tauri asset:// URLs).
      await renderFrames(url, config, framesDir, concurrency);

      // 3. Build audio assets from project data
      const allAudioAssets = [];

      // Add narration audio from each scene
      let frameOffset = 0;
      for (const scene of projectJson.scenes) {
        const ttsVolume = projectJson.audio?.tts?.volume ?? 1.0;

        if (scene.narrationSegments?.length) {
          // Segment-based audio: each segment placed sequentially within the scene
          let segFrameOffset = frameOffset;
          for (const seg of scene.narrationSegments) {
            if (seg.audioPath && existsSync(seg.audioPath)) {
              allAudioAssets.push({
                src: seg.audioPath,
                startFrame: segFrameOffset,
                volume: ttsVolume,
              });
            } else if (seg.audioPath) {
              log({ type: "status", message: `Warning: audio file not found: ${seg.audioPath}` });
            }
            const segFrames = seg.durationMs
              ? Math.ceil((seg.durationMs / 1000) * fps)
              : 0;
            segFrameOffset += segFrames;
          }
        } else if (scene.narrationAudio) {
          if (existsSync(scene.narrationAudio)) {
            allAudioAssets.push({
              src: scene.narrationAudio,
              startFrame: frameOffset,
              volume: ttsVolume,
            });
          } else {
            log({ type: "status", message: `Warning: audio file not found: ${scene.narrationAudio}` });
          }
        }

        const sceneDuration = scene.durationInFrames || 150;
        const transitionFrames = scene.transition?.durationInFrames || 0;
        frameOffset += sceneDuration - transitionFrames;
      }

      // Add BGM
      if (projectJson.audio?.bgm?.src) {
        if (existsSync(projectJson.audio.bgm.src)) {
          allAudioAssets.push({
            src: projectJson.audio.bgm.src,
            startFrame: 0,
            volume: projectJson.audio.bgm.volume ?? 0.3,
            isBgm: true,
          });
        } else {
          log({ type: "status", message: `Warning: BGM file not found: ${projectJson.audio.bgm.src}` });
        }
      }

      log({ type: "status", message: `Audio assets: ${allAudioAssets.length} files` });

      // 4. Encode video
      await encodeVideo(framesDir, outputPath, fps, allAudioAssets, totalDuration);

      log({ type: "done", outputPath });
    } finally {
      viteProcess.kill();
    }
  } catch (err) {
    log({ type: "error", message: err.message || String(err) });
    process.exit(1);
  }
}

function calculateTotalDuration(project) {
  let total = 0;
  const scenes = project.scenes || [];
  for (let i = 0; i < scenes.length; i++) {
    const duration = scenes[i].durationInFrames || 150;
    total += duration;
    if (i < scenes.length - 1) {
      total -= scenes[i].transition?.durationInFrames || 0;
    }
  }
  return Math.max(total, 1);
}

main();
