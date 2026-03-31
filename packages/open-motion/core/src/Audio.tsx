import React, { useContext, useEffect } from 'react';
import { SequenceOffsetContext } from './context';

export interface AudioProps {
  src: string;
  startFrom?: number;
  startFrame?: number;
  volume?: number;
  loop?: boolean;
}

export const Audio: React.FC<AudioProps> = (props) => {
  const sequenceOffset = useContext(SequenceOffsetContext);
  const startFrame = sequenceOffset + (props.startFrame ?? 0);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const assets: any[] = (window.__OPEN_MOTION_AUDIO_ASSETS__ =
      window.__OPEN_MOTION_AUDIO_ASSETS__ || []);

    const exists = assets.find(
      (a: any) =>
        a.src === props.src &&
        (a.startFrom || 0) === (props.startFrom || 0) &&
        (a.volume || 1) === (props.volume || 1) &&
        a.startFrame === startFrame
    );
    if (!exists) {
      console.log('[Audio] Registering asset:', props.src, 'startFrame:', startFrame, 'volume:', props.volume);
      assets.push({
        ...props,
        startFrame,
      });
    }

    return () => {
      const arr = window.__OPEN_MOTION_AUDIO_ASSETS__;
      if (!arr) return;
      const idx = arr.findIndex(
        (a: any) =>
          a.src === props.src &&
          (a.startFrom || 0) === (props.startFrom || 0) &&
          (a.volume || 1) === (props.volume || 1) &&
          a.startFrame === startFrame
      );
      if (idx !== -1) arr.splice(idx, 1);
    };
  }, [props.src, props.startFrom, props.volume, startFrame]);

  return null;
};
