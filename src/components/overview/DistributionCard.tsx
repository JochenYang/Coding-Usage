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

/** Overview distribution card: per-provider share of total token quota */
export function DistributionCard({ slices, total, className }: DistributionCardProps) {
  const t = useT()

  return (
    <div className={cn('rounded-2xl border border-border bg-card p-5', className)}>
      <h2 className="text-[15px] font-semibold text-foreground">{t.overview.distTitle}</h2>
      {/* DonutChart renders its own grey ring when slices is empty */}
      <div className="mt-3">
        <DonutChart
          segments={slices}
          centerValue={formatCompactValue(total)}
          centerLabel={t.overview.distTotal}
          size={140}
          thickness={14}
        />
      </div>
      {total <= 0 && (
        <p className="mt-3 text-[11px] leading-relaxed text-subtle">{t.overview.distUnavailable}</p>
      )}
    </div>
  )
}
