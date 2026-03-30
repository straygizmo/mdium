import React from "react";
import ReactDOM from "react-dom/client";
import { CompositionProvider, registerComposition } from "@open-motion/core";
import { VideoComposition, calculateTotalDuration } from "./scene-to-composition";
import projectData from "../project.json";

const project = projectData as any;
const totalDuration = calculateTotalDuration(project);

const config = {
  width: project.meta.width,
  height: project.meta.height,
  fps: project.meta.fps,
  durationInFrames: totalDuration,
};

// Register composition metadata so the renderer can discover it
registerComposition({
  id: "video-project",
  component: () => <VideoComposition project={project} />,
  ...config,
});

function App() {
  const initialFrame =
    typeof (window as any).__OPEN_MOTION_FRAME__ === "number"
      ? (window as any).__OPEN_MOTION_FRAME__
      : 0;

  return (
    <CompositionProvider config={config} frame={initialFrame}>
      <VideoComposition project={project} />
    </CompositionProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
