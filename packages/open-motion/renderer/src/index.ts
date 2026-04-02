import { chromium, Page, BrowserType } from 'playwright';
export { chromium } from 'playwright';
import { getTimeHijackScript, VideoConfig } from '@open-motion/core';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export { computeSkippableFrames, analyzeScenes, type SceneInfo, type SceneData } from './static-ranges';

// Check if Playwright browsers are installed
export const checkBrowserInstallation = async (browserType: BrowserType): Promise<boolean> => {
  try {
    // Try to get the browser path - this will throw if not installed
    const browserPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || browserType.executablePath();
    return !!browserPath;
  } catch (error) {
    return false;
  }
};

// Helper to extract a single frame from a video using FFmpeg
const extractFrame = (videoPath: string, time: number, outputPath: string) => {
  try {
    // -ss before -i is faster as it seeks before decoding
    execSync(`ffmpeg -y -ss ${time} -i "${videoPath}" -frames:v 1 -q:v 2 "${outputPath}"`, { stdio: 'ignore' });
    return true;
  } catch (e) {
    console.error(`Failed to extract frame from ${videoPath} at ${time}s`, e);
    return false;
  }
};

// Helper to resolve asset path with publicDir
const resolveAssetPath = (src: string, publicDir?: string): string => {
  if (!src.startsWith('/') || src.startsWith('//')) {
    return src;
  }

  const possiblePaths: string[] = [];

  // Add specified publicDir as first priority
  if (publicDir) {
    possiblePaths.push(path.join(publicDir, src.substring(1)));
  }

  // Add common fallback paths - only add if not already covered
  const commonPaths = [
    path.join(process.cwd(), 'public', src.substring(1)),
    path.join(process.cwd(), 'static', src.substring(1)),
    path.join(process.cwd(), 'assets', src.substring(1)),
  ];

  for (const p of commonPaths) {
    if (!possiblePaths.includes(p)) {
      possiblePaths.push(p);
    }
  }

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return src;
};

export interface RenderOptions {
  url: string;
  config: VideoConfig;
  outputDir: string;
  compositionId?: string;
  inputProps?: any;
  concurrency?: number;
  onProgress?: (frame: number) => void;
  publicDir?: string;
  timeout?: number;
  fonts?: RenderFont[];
  skippableFrames?: Set<number>;
}

export interface RenderFont {
  /** CSS font-family name to register (e.g. "Noto Sans JP") */
  family: string;
  /** Path to a local font file (woff2/woff/ttf/otf) */
  path: string;
  weight?: string | number;
  style?: string;
}

export interface GetCompositionsOptions {
  inputProps?: any;
  chromiumOptions?: any;
  timeout?: number;
}

export const getCompositions = async (url: string, options: GetCompositionsOptions = {}) => {
  const { inputProps = {}, timeout = 30000 } = options;
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const page = await browser.newPage();

  if (timeout) {
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
  }

  await page.goto(url);
  await page.waitForLoadState('networkidle');

  // Wait for React to mount and all compositions to register
  // We wait for the variable to exist AND for a small stabilization period
  await page.waitForFunction(() => window.__OPEN_MOTION_COMPOSITIONS__ !== undefined, { timeout }).catch(() => {});
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));

  const compositions = await page.evaluate(() => {
    return window.__OPEN_MOTION_COMPOSITIONS__ || [];
  });

  // Process calculateMetadata if available
  const processedCompositions = await page.evaluate(async ([compositions, inputProps]) => {
    for (const comp of compositions) {
      if (comp.calculateMetadata) {
        try {
          const metadata = await eval(`(${comp.calculateMetadata})`)(inputProps);
          Object.assign(comp, metadata);
        } catch (error) {
          console.warn(`Failed to calculate metadata for composition ${comp.id}:`, error);
        }
      }
    }
    return compositions;
  }, [compositions, inputProps]);

  await browser.close();
  return processedCompositions;
};

const getFontMimeAndFormat = (fontPath: string): { mime: string; format?: string } => {
  const ext = path.extname(fontPath).toLowerCase();
  switch (ext) {
    case '.woff2':
      return { mime: 'font/woff2', format: 'woff2' };
    case '.woff':
      return { mime: 'font/woff', format: 'woff' };
    case '.ttf':
      return { mime: 'font/ttf', format: 'truetype' };
    case '.otf':
      return { mime: 'font/otf', format: 'opentype' };
    default:
      return { mime: 'application/octet-stream' };
  }
};

export const renderFrames = async ({ url, config, outputDir, compositionId, inputProps = {}, concurrency = 1, publicDir, onProgress, timeout = 300000, fonts = [], skippableFrames }: RenderOptions) => {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const framesPerWorker = Math.ceil(config.durationInFrames / concurrency);
  let totalFramesRendered = 0;

  const renderBatch = async (startFrame: number, endFrame: number, workerId: number) => {
    console.log(`[open-motion] Worker ${workerId}: launching browser...`);
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--disable-dev-shm-usage', '--disable-setuid-sandbox', '--no-sandbox']
    });
    console.log(`[open-motion] Worker ${workerId}: browser launched`);
    const page = await browser.newPage({
      viewport: { width: config.width, height: config.height }
    });

    // Capture browser console/errors for diagnostics
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        console.error(`[open-motion] Worker ${workerId} browser ${msg.type()}: ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      const errMsg = err.message || String(err);
      pageErrors.push(errMsg);
      console.error(`[open-motion] Worker ${workerId} page error: ${errMsg}`);
    });

    if (timeout) {
      page.setDefaultTimeout(timeout);
      page.setDefaultNavigationTimeout(timeout);
    }

    const workerAudioAssets: any[] = [];
    const videoCache = new Map<string, string>(); // Path to local resolved path

    const fontPayloads = (fonts || []).flatMap((f) => {
      const resolvedPath = path.isAbsolute(f.path) ? f.path : path.resolve(process.cwd(), f.path);
      try {
        const { mime, format } = getFontMimeAndFormat(resolvedPath);
        const base64 = fs.readFileSync(resolvedPath, { encoding: 'base64' });
        return [
          {
            family: f.family,
            weight: f.weight,
            style: f.style,
            base64,
            mime,
            format,
          },
        ];
      } catch (e) {
        console.warn(`[open-motion] Failed to read font file: ${resolvedPath}`);
        return [];
      }
    });

    for (let i = startFrame; i <= endFrame && i < config.durationInFrames; i++) {
      // Static frame skipping: copy previous frame instead of rendering
      if (skippableFrames?.has(i) && i > startFrame) {
        const prevPath = path.join(outputDir, `frame-${(i - 1).toString().padStart(5, '0')}.png`);
        const curPath = path.join(outputDir, `frame-${i.toString().padStart(5, '0')}.png`);
        if (fs.existsSync(prevPath)) {
          fs.copyFileSync(prevPath, curPath);
          totalFramesRendered++;
          if (onProgress) {
            onProgress(totalFramesRendered);
          }
          continue;
        }
        // If previous frame doesn't exist, fall through to normal rendering
      }

      if (i === startFrame) {
        await page.addInitScript(({ frame, fps, hijackScript, compositionId, inputProps, fontPayloads }) => {
          window.__OPEN_MOTION_FRAME__ = frame;
          window.__OPEN_MOTION_COMPOSITION_ID__ = compositionId;
          window.__OPEN_MOTION_INPUT_PROPS__ = inputProps;
          window.__OPEN_MOTION_READY__ = false;
          window.__OPEN_MOTION_VIDEO_FRAMES__ = {};
          window.__OPEN_MOTION_ERROR__ = null;

          // Catch unhandled errors so waitForFunction doesn't hang for 300s
          window.addEventListener('error', (e) => {
            window.__OPEN_MOTION_ERROR__ = e.message || 'Unknown error';
            window.__OPEN_MOTION_READY__ = true;
            window.__OPEN_MOTION_DELAY_RENDER_COUNT__ = 0;
          });
          window.addEventListener('unhandledrejection', (e) => {
            window.__OPEN_MOTION_ERROR__ = (e.reason && e.reason.message) || String(e.reason) || 'Unhandled rejection';
            window.__OPEN_MOTION_READY__ = true;
            window.__OPEN_MOTION_DELAY_RENDER_COUNT__ = 0;
          });

          window.__OPEN_MOTION_FONTS_READY__ = Promise.resolve();
          if (fontPayloads && Array.isArray(fontPayloads) && 'fonts' in document) {
            window.__OPEN_MOTION_FONTS_READY__ = (async () => {
              for (const f of fontPayloads) {
                try {
                  const src = `url(data:${f.mime};base64,${f.base64})${f.format ? ` format('${f.format}')` : ''}`;
                  const face = new FontFace(f.family, src, {
                    weight: f.weight ? String(f.weight) : undefined,
                    style: f.style ? String(f.style) : undefined,
                  });
                  await face.load();
                  document.fonts.add(face);
                } catch (e) {
                  // ignore
                }
              }
              try {
                await document.fonts.ready;
              } catch (e) {
                // ignore
              }
            })();
          }

          // Execute hijack script (guard against early execution before DOM is ready)
          if (document.documentElement) {
            const script = document.createElement('script');
            script.textContent = hijackScript;
            document.documentElement.appendChild(script);
            script.remove();
          }

          // Reset styles - 保证 #root 占满整个视口，但不添加 flex center 避免影响内部组件布局
          if (document.head) {
            const style = document.createElement('style');
            style.textContent = 'body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; } #root { width: 100%; height: 100%; display: block; }';
            document.head.appendChild(style);
          }
        }, {
          frame: i,
          fps: config.fps,
          hijackScript: getTimeHijackScript(i, config.fps),
          compositionId,
          inputProps,
          fontPayloads,
        });

        console.log(`[open-motion] Worker ${workerId}: navigating to ${url}`);
        await page.goto(url);
        console.log(`[open-motion] Worker ${workerId}: page loaded`);
      } else {
        // Update frame for subsequent renders
        await page.evaluate(({ frame, fps, hijackScript }) => {
          window.__OPEN_MOTION_READY__ = false;
          window.__OPEN_MOTION_ERROR__ = null;
          window.__OPEN_MOTION_FRAME__ = frame;
          window.__OPEN_MOTION_VIDEO_ASSETS__ = []; // Reset for this frame
          eval(hijackScript);
          window.dispatchEvent(new CustomEvent('open-motion-frame-update', { detail: { frame } }));
        }, {
          frame: i,
          fps: config.fps,
          hijackScript: getTimeHijackScript(i, config.fps),
        });
      }

      // Wait for content to be ready (use explicit polling to avoid rAF hijack issues)
      const frameTimeout = i === startFrame ? timeout : Math.min(timeout, 60000);
      try {
        await page.waitForFunction(() => {
          const ready = window.__OPEN_MOTION_READY__ === true;
          const delayCount = window.__OPEN_MOTION_DELAY_RENDER_COUNT__ || 0;
          return ready && delayCount === 0;
        }, { timeout: frameTimeout, polling: 100 });
      } catch (waitErr) {
        // Collect diagnostic info on timeout
        const diag: Record<string, unknown> = await page.evaluate(() => {
          const root = document.getElementById('root');
          return {
            ready: window.__OPEN_MOTION_READY__,
            delayCount: window.__OPEN_MOTION_DELAY_RENDER_COUNT__,
            error: window.__OPEN_MOTION_ERROR__,
            hasRoot: !!root,
            rootEmpty: root ? root.innerHTML.length === 0 : true,
            rootSnippet: root ? root.innerHTML.substring(0, 200) : '(no #root)',
            title: document.title,
            bodyLen: document.body ? document.body.innerHTML.length : 0,
          };
        }).catch(() => ({ ready: 'unknown', delayCount: 'unknown', error: 'failed to evaluate' }));
        console.error(`[open-motion] Worker ${workerId} frame ${i} timeout. Page state:`, JSON.stringify(diag));
        if (pageErrors.length > 0) {
          console.error(`[open-motion] Collected page errors:`, pageErrors.join('; '));
        }
        throw new Error(
          `Frame ${i} timed out after ${frameTimeout}ms. ` +
          `ready=${diag.ready}, delayCount=${diag.delayCount}, ` +
          `rootEmpty=${diag.rootEmpty}, error=${diag.error}` +
          (pageErrors.length > 0 ? `. Page errors: ${pageErrors.join('; ')}` : '')
        );
      }

      // Check if the page reported an error
      const pageError = await page.evaluate(() => window.__OPEN_MOTION_ERROR__);
      if (pageError) {
        console.error(`[open-motion] Page error on frame ${i}: ${pageError}`);
        // Reset error flag and continue - best effort rendering
        await page.evaluate(() => { window.__OPEN_MOTION_ERROR__ = null; });
      }

      // Only wait for networkidle on the first frame to avoid hanging on persistent requests
      if (i === startFrame) {
        await page.waitForLoadState('networkidle');
      }

      // Check for OffthreadVideo assets
      const videoAssets = await page.evaluate(() => window.__OPEN_MOTION_VIDEO_ASSETS__ || []);

      if (videoAssets.length > 0) {
        const videoFrames: Record<string, string> = {};

        for (const asset of videoAssets) {
          // Resolve relative path to absolute using provided publicDir
          const localPath = resolveAssetPath(asset.src, publicDir);

          const tempFramePath = path.join(outputDir, `temp-${workerId}-${asset.id}.jpg`);
          if (extractFrame(localPath, asset.time, tempFramePath)) {
            const base64 = fs.readFileSync(tempFramePath, { encoding: 'base64' });
            videoFrames[asset.id] = `data:image/jpeg;base64,${base64}`;
            fs.unlinkSync(tempFramePath); // Cleanup temp file
          }
        }

        // Inject frames back into the page
        await page.evaluate((frames) => {
          window.__OPEN_MOTION_VIDEO_FRAMES__ = frames;
        }, videoFrames);

        // Brief wait for React to re-render the <img> tags with new src
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
      }

      // Additional small wait to ensure style/layout stability
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));

      // Ensure webfonts (if any) are loaded before screenshot
      await page.evaluate(async () => {
        try {
          const p = window.__OPEN_MOTION_FONTS_READY__;
          if (p && typeof p.then === 'function') {
            await p;
          }
        } catch (e) {
          // ignore
        }

        try {
          if ('fonts' in document) {
            await document.fonts.ready;
          }
        } catch (e) {
          // ignore
        }
      });

      // Extract audio assets
      const assets = await page.evaluate(() => window.__OPEN_MOTION_AUDIO_ASSETS__ || []);
      workerAudioAssets.push(...assets);

      const screenshotPath = path.join(outputDir, `frame-${i.toString().padStart(5, '0')}.png`);
      // Force a tiny bit of wait before each screenshot to ensure rendering
      await new Promise(r => setTimeout(r, 100));
      await page.screenshot({ path: screenshotPath, type: 'png' });

      totalFramesRendered++;
      if (onProgress) {
        onProgress(totalFramesRendered);
      }
    }

    await browser.close();
    return workerAudioAssets;
  };

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(renderBatch(i * framesPerWorker, (i + 1) * framesPerWorker - 1, i));
  }

  const results = await Promise.all(workers);
  const allAudioAssets = results.flat();

  // Unique audio assets based on src, startFrom, startFrame, and volume
  const uniqueAudioAssets = Array.from(
    new Map(
      allAudioAssets.map((asset) => [
        `${asset.src}-${asset.startFrom || 0}-${asset.startFrame || 0}-${asset.volume || 1}`,
        asset,
      ])
    ).values()
  );

  console.log('Frame rendering complete.');
  return { audioAssets: uniqueAudioAssets };
};
