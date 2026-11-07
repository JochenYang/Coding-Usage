import type { ReactNode } from 'react'

/**
 * Decorative floor for a card that is stretched to its row height.
 *
 * Cards in the plans grid are laid out by row, so a card with two lines of
 * content next to one with six is either left short (row edges visibly uneven)
 * or stretched with a large void at the bottom. The cards now fill their cell,
 * which fixes the edges and leaves the void. Where a card genuinely has no more
 * information to give, the void carries the brand's **monochrome** glyph — the
 * `.Mono` variant of the icon set, not the colourful mark. Documented as an
 * explicit exception in `docs/DESIGN_SYSTEM.md` §1.1.
 *
 * Two things make this work where the coloured mark did not:
 *
 * - `.Mono` draws with `currentColor` and has no inline size, so a single
 *   `text-foreground` + `opacity` pair reaches every brand. The `.Color` marks
 *   are multi-colour art (white kicks, blue gradients) and the `.Avatar` tiles
 *   carry inline `width`/`height`, which is why sizing and toning them
 *   consistently needed per-brand filter exceptions.
 * - Light and dark themes both work from the same `foreground` token, so there
 *   is no white-on-white case to special-case.
 *
 * The layer is inert (`aria-hidden`, `pointer-events-none`) and is clipped by
 * its own rounded box, so the card itself keeps `overflow: visible` (a future
 * focus ring or popover inside the card would not be cut off).
 */
export function CardWatermark({ icon }: { icon: ReactNode }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-2xl"
      data-card-watermark=""
    >
      {/* Cropped by the card's radius: the negative offsets are what make it
          read as a watermark rather than a second, competing icon. */}
      <div className="absolute -right-5 -bottom-6 h-32 w-32 text-foreground opacity-[0.06] [&_img]:h-full [&_img]:w-full [&_svg]:h-full [&_svg]:w-full">
        {icon}
      </div>
    </div>
  )
}
