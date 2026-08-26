import { cn } from '@/lib/cn'
import { LineChart } from '@/components/charts/LineChart'
import { useT } from '@/i18n/useT'

export interface TrendPoint {
  label: string
  value: number
}

export interface TrendCardProps {
  points: TrendPoint[]
  className?: string
}

/** Overview trend card: consumed-tokens line chart over the last 7 days */
export function TrendCard({ points, className }: TrendCardProps) {
  const t = useT()

  return (
    <div className={cn('h-full rounded-2xl border border-border bg-card p-5 flex flex-col', className)}>
      {/* Header: title on the left, range/unit chips on the right */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-foreground">{t.overview.trendTitle}</h2>
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {t.overview.trendRange(7)}
          </span>
          <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            Tokens
          </span>
        </div>
      </div>

      {points.length >= 2 ? (
        <div className="mt-3 flex-1">
          <LineChart points={points} height={200} className="w-full" />
        </div>
      ) : (
        // Centered placeholder until at least two days of data exist
        <div className="mt-3 flex flex-1 items-center justify-center py-10">
          <span className="text-xs text-subtle">{t.overview.emptyTitle}</span>
        </div>
      )}
    </div>
  )
}
