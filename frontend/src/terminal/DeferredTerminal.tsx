import {useEffect, useState, type ReactNode} from 'react';

// Creating a tab does not open a socket. Once visited, keep the renderer and
// connection alive across tab switches; closing/revoking the tab unmounts it.
export function DeferredTerminal({visible, children}: {visible: boolean; children: ReactNode}) {
  const [visited, setVisited] = useState(visible);
  useEffect(() => {if (visible) setVisited(true);}, [visible]);
  return visible || visited ? children : null;
}
