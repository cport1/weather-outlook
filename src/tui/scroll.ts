/**
 * OpenTUI lays text out across the full scrollbox content width and then draws
 * the vertical scrollbar over the last column, hiding a character per line.
 * Reserving a one-column gutter makes wrapped text break before the scrollbar.
 * A fresh object per scrollbox: OpenTUI consumes the options it's given.
 */
export const scrollbarGutter = () => ({ paddingRight: 1 });
