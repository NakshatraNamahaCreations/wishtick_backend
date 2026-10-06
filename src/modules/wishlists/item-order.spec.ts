import { byImportance } from './item-order';
import { ItemImportance } from './wishlist.types';

describe('byImportance', () => {
  const item = (id: string, importance: ItemImportance | null) => ({ id, importance });

  it('puts Must have first, then Would love, then Nice to have', () => {
    const sorted = byImportance([
      item('a', ItemImportance.NICE_TO_HAVE),
      item('b', ItemImportance.WOULD_LOVE),
      item('c', ItemImportance.MUST_HAVE),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });

  it('keeps the added order inside each group', () => {
    const sorted = byImportance([
      item('w1', ItemImportance.WOULD_LOVE),
      item('m1', ItemImportance.MUST_HAVE),
      item('w2', ItemImportance.WOULD_LOVE),
      item('m2', ItemImportance.MUST_HAVE),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(['m1', 'm2', 'w1', 'w2']);
  });

  it('reads a missing importance as Would love, the default', () => {
    const sorted = byImportance([
      item('n', ItemImportance.NICE_TO_HAVE),
      item('x', null),
      item('m', ItemImportance.MUST_HAVE),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(['m', 'x', 'n']);
  });

  it('does not reorder the list it was given', () => {
    const input = [item('a', ItemImportance.NICE_TO_HAVE), item('b', ItemImportance.MUST_HAVE)];
    byImportance(input);
    expect(input.map((i) => i.id)).toEqual(['a', 'b']);
  });
});
