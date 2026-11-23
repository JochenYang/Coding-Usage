import { ChartPie } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { DistSliceVM } from '@/lib/overview'
import { DonutChart } from '@/components/charts/DonutChart'
import { formatAsOf, formatCompactValue } from '@/lib/format'
import { Tooltip } from '@/components/common/Tooltip'
import { useT } from '@/i18n/useT'

export interface DistributionCardProps {
  slices: DistSliceVM[]
  total: number
  /** Caption under the centre value: what the ring's shares are shares of */
  centerLabel: string
  /** The window the ring covers, shown as a chip in the header */
  rangeLabel: string
  /**
   * Epoch ms of the underlying local-agent scan. The range chip carries it on
   * hover: a point-in-time scan has to say how fresh it is somewhere, and the
   * chip is the one place a reader looks to learn what the ring shows.
   */
  asOf?: number | null
  className?: string
}

/**
 * Usage distribution card: ring and legend side by side, high-share agents
 * plus one folded "other" slice (the caller does the folding).
 */
export function DistributionCard({ slices, total, centerLabel, rangeLabel, asOf, className }: DistributionCardProps) {
  const t = useT()
  const chip = (
    <span className="rounded-md bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-text">
      {rangeLabel}
    </span>
  )

  return (
    <div className={cn('flex h-full flex-col rounded-2xl border border-border bg-card p-5', className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-foreground">
          <ChartPie className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <span className="truncate">{t.overview.distTitle}</span>
        </h2>
        {asOf != null ? (
          <Tooltip text={`${t.overview.asOfPrefix} ${formatAsOf(asOf)}`} className="shrink-0">
            {chip}
          </Tooltip>
        ) : (
          <span className="shrink-0">{chip}</span>
        )}
      </div>
      {/* The chart block centres in the flex remainder so the card stays
          balanced when a sibling column stretches the row (h-full) */}
      <div className="mt-4 flex flex-1 flex-col justify-center">
        <DonutChart
          segments={slices}
          centerValue={formatCompactValue(total)}
          centerLabel={centerLabel}
          size={124}
          thickness={16}
          orientation="horizontal"
          className="gap-4"
        />
      </div>
      {total <= 0 && (
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{t.overview.distUnavailable}</p>
      )}
    </div>
  )
}
