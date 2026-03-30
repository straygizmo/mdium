import React, { useState, useEffect, useCallback, useRef } from 'react';
import { CompositionProvider, VideoConfig } from './index';
import { AudioSyncManager } from './AudioSync';

export interface PlayerProps {
  component: React.ComponentType<any>;
  config: VideoConfig;
  inputProps?: any;
  controls?: boolean;
  autoPlay?: boolean;
  loop?: boolean;
}

export const Player: React.FC<PlayerProps> = ({
  component: Component,
  config,
  inputProps = {},
  controls = true,
  autoPlay = false,
  loop = false,
}) => {
  const [frame, setFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const [scale, setScale] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<number>(undefined!);
  const lastTimeRef = useRef<number | undefined>(undefined);

  const videoAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updateScale = () => {
      const el = videoAreaRef.current;
      if (el) {
        const w = el.clientWidth;
        const h = el.clientHeight;
        const sw = w / config.width;
        const sh = h > 0 ? h / config.height : sw;
        const s = Math.min(1, sw, sh);
        if (s > 0) setScale(s);
      }
    };
    updateScale();
    const ro = new ResizeObserver(updateScale);
    if (videoAreaRef.current) ro.observe(videoAreaRef.current);
    return () => ro.disconnect();
  }, [config.width, config.height]);

  const animate = useCallback((time: number) => {
    if (lastTimeRef.current !== undefined) {
      const deltaTime = time - lastTimeRef.current;
      const frameStep = (deltaTime / 1000) * config.fps;

      setFrame((prevFrame) => {
        let nextFrame = prevFrame + frameStep;
        if (nextFrame >= config.durationInFrames) {
          if (loop) {
            nextFrame = 0;
          } else {
            nextFrame = config.durationInFrames - 1;
            setIsPlaying(false);
          }
        }
        return nextFrame;
      });
    }
    lastTimeRef.current = time;
    requestRef.current = requestAnimationFrame(animate);
  }, [config.fps, config.durationInFrames, loop]);

  useEffect(() => {
    if (isPlaying) {
      lastTimeRef.current = undefined;
      requestRef.current = requestAnimationFrame(animate);
    } else {
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }
    }
    return () => {
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }
    };
  }, [isPlaying, animate]);

  const togglePlay = () => setIsPlaying(!isPlaying);

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFrame(Number(e.target.value));
    setIsPlaying(false);
  };

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        maxWidth: config.width,
        border: '1px solid var(--border, #ccc)',
        borderRadius: '4px',
        overflow: 'hidden',
        background: 'var(--bg-surface, #f0f0f0)',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div ref={videoAreaRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', alignItems: 'start' }}>
        <div
          style={{
            width: config.width,
            height: config.height,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            background: '#fff',
            flexShrink: 0,
          }}
        >
        <CompositionProvider config={config} frame={frame} inputProps={inputProps}>
          <Component />
          <AudioSyncManager
            frame={frame}
            fps={config.fps}
            isPlaying={isPlaying}
            durationInFrames={config.durationInFrames}
          />
        </CompositionProvider>
        </div>
      </div>

      {controls && (
        <div style={{ padding: '10px', background: 'var(--bg-surface, #f0f0f0)', display: 'flex', alignItems: 'center', gap: '10px', position: 'relative', zIndex: 10, borderTop: '1px solid var(--border, #ccc)' }}>
          <button
            onClick={togglePlay}
            style={{
              padding: '4px 14px',
              background: 'var(--primary, #6366f1)',
              border: '1px solid var(--primary, #6366f1)',
              color: 'var(--bg-base, #fff)',
              borderRadius: '4px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          <input
            type="range"
            min="0"
            max={config.durationInFrames - 1}
            step="1"
            value={Math.floor(frame)}
            onChange={handleSeek}
            style={{ flex: 1 }}
          />
          <div style={{ minWidth: '80px', fontSize: '12px', textAlign: 'right', color: 'var(--text, #000)' }}>
            {Math.floor(frame)} / {config.durationInFrames}
          </div>
        </div>
      )}
    </div>
  );
};
