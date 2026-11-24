interface SearchScrollPosition {
  /** Current scroll offset of the chooser list. */
  readonly current: number;
  /** Top of the search field, in list content coordinates. */
  readonly fieldTop: number;
  /** Bottom of the first match, or of the field when nothing matches. */
  readonly matchBottom: number;
  /** Visible height of the list, which ends at the keyboard. */
  readonly viewportHeight: number;
}

/**
 * Returns the smallest scroll that shows the search field and the first
 * match. When both cannot fit, as at the largest iOS text size, the field
 * wins so people can still see what they type.
 */
export function searchScrollOffset({
  current,
  fieldTop,
  matchBottom,
  viewportHeight,
}: SearchScrollPosition): number {
  return Math.min(fieldTop, Math.max(current, matchBottom - viewportHeight));
}
