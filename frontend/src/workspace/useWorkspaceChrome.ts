import {useCallback, useEffect, useRef, useState} from 'react';

// Only pinning changes layout. Revealing overlays the terminal without a resize.
export function useWorkspaceChrome(pinned: boolean, forced: boolean, locked: boolean) {
  const [revealed, setRevealed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reveal = useCallback(() => setRevealed(true), []);
  const visible = pinned || forced || locked || hovered || focused || revealed;
  useEffect(() => {
    clearTimeout(timer.current);
    if (!pinned && !forced && !locked && !hovered && !focused && revealed) timer.current = setTimeout(() => setRevealed(false), 700);
    return () => clearTimeout(timer.current);
  }, [pinned, forced, locked, hovered, focused, revealed]);
  useEffect(() => {
    let edge: ReturnType<typeof setTimeout> | undefined;
    const move = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.buttons) return;
      if (event.clientY <= 4) {if (!edge) edge = setTimeout(() => {reveal(); edge = undefined;}, 180);}
      else {clearTimeout(edge); edge = undefined;}
    };
    document.addEventListener('pointermove', move);
    return () => {clearTimeout(edge); document.removeEventListener('pointermove', move);};
  }, [reveal]);
  return {visible, reveal, setHovered, setFocused};
}
