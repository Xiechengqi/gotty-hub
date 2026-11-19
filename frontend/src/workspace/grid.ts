export const SPLIT_MIN_WIDTH = 728;
export const SPLIT_VIEWPORT = `(min-width: ${SPLIT_MIN_WIDTH}px) and (min-height: 500px)`;

type Grid = {columns: number; rows: number; gap: number; capacity: number};

export function terminalGrid(count: number, width: number, height: number, fontSize: number, paged: boolean): Grid {
  // Geometric targets for comparing layouts. The terminal itself measures its
  // font and negotiates the PTY grid independently.
  const readableWidth = Math.ceil(fontSize * 0.62 * 42) + 16;
  const readableHeight = Math.ceil(fontSize * 1.25 * 12) + 36;
  let best: Grid = {columns: 1, rows: 1, gap: 0, capacity: 1};
  let score = -Infinity;
  const limit = paged ? Math.min(count, Math.max(1, Math.floor(width / readableWidth))) : count;
  for (let columns = 1; columns <= limit; columns++) {
    const rows = paged
      ? Math.min(Math.ceil(count / columns), Math.max(1, Math.floor(height / readableHeight)))
      : Math.ceil(count / columns);
    const capacity = columns * rows;
    const gap = Math.max(0, Math.min(2, (width / columns) / 12, (height / rows) / 12));
    const cellWidth = (width - (columns - 1) * gap) / columns;
    const cellHeight = (height - (rows - 1) * gap) / rows;
    const readability = Math.min(cellWidth / readableWidth, cellHeight / readableHeight);
    const content = Math.min(count, capacity);
    const bestContent = Math.min(count, best.capacity);
    if (!paged || content >= bestContent) {
      if (paged && content > bestContent || readability > score || readability === score && capacity < best.capacity) {
        best = {columns, rows, gap, capacity};
        score = readability;
      }
    }
  }
  return best;
}
