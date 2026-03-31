import { createContext } from 'react';

export const AbsoluteFrameContext = createContext<number>(0);

/**
 * Accumulated frame offset through nested Sequences.
 * Each Sequence adds its `from` value so children can compute their absolute start frame.
 */
export const SequenceOffsetContext = createContext<number>(0);
