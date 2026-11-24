import { searchScrollOffset } from './search-scroll-offset';

describe('searchScrollOffset', () => {
  it('stays put when the field and first match are already visible', () => {
    expect(
      searchScrollOffset({
        current: 0,
        fieldTop: 300,
        matchBottom: 600,
        viewportHeight: 700,
      }),
    ).toBe(0);
  });

  it('scrolls just far enough to bring the first match above the keyboard', () => {
    expect(
      searchScrollOffset({
        current: 0,
        fieldTop: 400,
        matchBottom: 800,
        viewportHeight: 500,
      }),
    ).toBe(300);
  });

  it('keeps the field at the top when the field and match cannot both fit', () => {
    expect(
      searchScrollOffset({
        current: 0,
        fieldTop: 900,
        matchBottom: 1600,
        viewportHeight: 500,
      }),
    ).toBe(900);
  });

  it('scrolls back to the field when it is above the visible area', () => {
    expect(
      searchScrollOffset({
        current: 1200,
        fieldTop: 900,
        matchBottom: 1100,
        viewportHeight: 500,
      }),
    ).toBe(900);
  });
});
