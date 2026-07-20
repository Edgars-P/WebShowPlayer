import { describe, expect, it } from 'vitest';
import { parseDropTarget } from './dropTarget';

// Drop targets are resolved by reading a string off whatever element is under
// the pointer, so this parse is the one place a bad marker turns into a cue
// landing somewhere it wasn't dropped.
describe('parseDropTarget', () => {
  it('reads a grid cell', () => {
    expect(parseDropTarget('cell:2:5')).toEqual({ kind: 'cell', row: 2, col: 5 });
  });

  it('reads a tab id, colons and all', () => {
    expect(parseDropTarget('tab:tab:abc123')).toEqual({ kind: 'tab', id: 'tab:abc123' });
  });

  it('refuses anything else', () => {
    for (const spec of [null, '', 'cell', 'cell:2', 'cell:a:b', 'cell:2:5:9', 'tab:', 'other:1']) {
      expect(parseDropTarget(spec)).toBeNull();
    }
  });
});
