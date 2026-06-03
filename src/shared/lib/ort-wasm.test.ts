import { describe, it, expect } from "vitest";
import { configureLocalWasm } from "./ort-wasm";

describe("configureLocalWasm", () => {
  it("points wasmPaths at the local /ort/ dir and forces single thread", () => {
    const env: any = { backends: { onnx: { wasm: {} } } };
    configureLocalWasm(env);
    expect(env.backends.onnx.wasm.wasmPaths).toBe("/ort/");
    expect(env.backends.onnx.wasm.numThreads).toBe(1);
  });
});
