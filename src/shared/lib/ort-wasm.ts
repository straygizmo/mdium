// Configure onnxruntime-web (through the transformers.js `env`) to load its
// WASM backend from the locally bundled copy under `/ort/` instead of the
// default jsDelivr CDN. Without this, pipeline initialization fetches the
// `.wasm` from the CDN, which hangs forever on a network-restricted/proxy
// machine (the "Building..." freeze). The files are copied into `public/ort/`
// by the `copy-ort-wasm` Vite plugin (see vite.config.ts).
//
// `numThreads = 1` avoids the multi-threaded ORT build, which needs
// cross-origin isolation (COOP/COEP) that the WebView2 app origin does not set.
export function configureLocalWasm(env: any): void {
  env.backends.onnx.wasm.wasmPaths = "/ort/";
  env.backends.onnx.wasm.numThreads = 1;
}
