import { cn } from '@/lib/cn'
import type { DistSliceVM } from '@/lib/overview'
import { DonutChart } from '@/components/charts/DonutChart'
import { formatCompactValue } from '@/lib/format'
import { useT } from '@/i18n/useT'

export interface DistributionCardProps {
  slices: DistSliceVM[]
  total: number
  className?: string
}

/** Overview distribution card: ring on top, high-share providers + other below */
export function DistributionCard({ slices, total, className }: DistributionCardProps) {
  const t = useT()

  return (
    <div className={cn('flex flex-col rounded-2xl border border-border bg-card p-5', className)}>
      <h2 className="text-[15px] font-semibold text-foreground">{t.overview.distTitle}</h2>
      {/* Vertical chart block centers in the flex remainder so the card stays
          balanced when a sibling column stretches the row (h-full) */}
      <div className="mt-3 flex flex-1 flex-col justify-center">
        <DonutChart
          segments={slices}
          centerValue={formatCompactValue(total)}
          centerLabel={t.overview.distTotal}
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
