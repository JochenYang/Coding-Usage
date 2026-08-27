import { useState } from 'react'
import { cn } from '@/lib/cn'
import { LineChart } from '@/components/charts/LineChart'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/beui/select'
import { useT } from '@/i18n/useT'

export interface TrendPoint {
  label: string
  value: number
}

export interface TrendCardProps {
  points: TrendPoint[]
  className?: string
}

/** Metrics the trend chart can plot (single entry today; tokens series is the only source) */
const METRICS = [{ id: 'tokens', label: 'Tokens' }] as const

/** Overview trend card: consumed-tokens line chart over the last 7 days */
export function TrendCard({ points, className }: TrendCardProps) {
  const t = useT()
  const [metric, setMetric] = useState<string>('tokens')

  return (
    <div className={cn('h-full rounded-2xl border border-border bg-card p-5 flex flex-col', className)}>
      {/* Header: title on the left, range chip + metric selector on the right */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-foreground">{t.overview.trendTitle}</h2>
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {t.overview.trendRange(7)}
          </span>
          {/* Interactive select styled as the former static chip; single entry
              until a second metric series (e.g. cost) becomes available */}
          <Select value={metric} onValueChange={setMetric}>
            <SelectTrigger className="h-auto w-auto gap-1 rounded-md border-none bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METRICS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
