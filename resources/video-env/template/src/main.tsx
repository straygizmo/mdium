import React from "react";
import ReactDOM from "react-dom/client";
import { Composition } from "@open-motion/core";
import { VideoComposition, calculateTotalDuration } from "./scene-to-composition";
import projectData from "../project.json";

const project = projectData as any;
const totalDuration = calculateTotalDuration(project);

function App() {
  return (
    <Composition
      id="video-project"
      component={() => <VideoComposition project={project} />}
      width={project.meta.width}
      height={project.meta.height}
      fps={project.meta.fps}
      durationInFrames={totalDuration}
    />
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
