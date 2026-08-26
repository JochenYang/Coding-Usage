import { Users } from 'lucide-react'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n/useT'

export interface TeamPageProps {
  /** Extra classes appended to the page root */
  className?: string
}

/** Team management placeholder — ships in a later development phase */
export function TeamPage({ className }: TeamPageProps) {
  const t = useT()

  return (
    <div className={cn('space-y-4', className)}>
      <PageHeader title={t.nav.team} />

      <EmptyState
        icon={<Users className="h-6 w-6" />}
        title={t.pages.comingSoonTitle}
        description={t.pages.comingSoonDesc}
      />
    </div>
  )
}
