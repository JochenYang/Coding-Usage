import { cn } from '@/lib/cn'
import type { DistSliceVM } from '@/lib/overview'
import { DonutChart } from '@/components/charts/DonutChart'
import { formatCompactValue } from '@/lib/format'
import { useT } from '@/i18n/useT'

export interface DistributionCardProps {
  slices: DistSliceVM[]
  total: number
  /** Caption under the center value; defaults to the quota fallback label */
  centerLabel?: string
  /** Epoch ms of the underlying local-agent scan; renders "as of HH:MM" */
  asOf?: number | null
  className?: string
}

/** Overview distribution card: ring on top, high-share providers + other below */
export function DistributionCard({ slices, total, centerLabel, asOf, className }: DistributionCardProps) {
  const t = useT()

  return (
    <div className={cn('flex flex-col rounded-2xl border border-border bg-card p-5', className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-foreground">{t.overview.distTitle}</h2>
        {/* Local-agent data is a point-in-time scan — say how fresh it is so a
            slow-moving month total doesn't read as broken */}
        {asOf != null && (
          <span className="shrink-0 text-[11px] text-subtle tabular-nums">
            {`${t.overview.asOfPrefix} ${new Date(asOf).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}`}
          </span>
        )}
      </div>
      {/* Vertical chart block centers in the flex remainder so the card stays
          balanced when a sibling column stretches the row (h-full) */}
      <div className="mt-3 flex flex-1 flex-col justify-center">
        <DonutChart
          segments={slices}
          centerValue={formatCompactValue(total)}
          centerLabel={centerLabel ?? t.overview.distTotal}
          size={140}
          thickness={14}
          orientation="vertical"
        />
      </div>
      {total <= 0 && (
        <p className="mt-3 text-[11px] leading-relaxed text-subtle">{t.overview.distUnavailable}</p>
      )}
    </div>
  )
}
