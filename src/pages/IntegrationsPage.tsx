import { Share2 } from 'lucide-react'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n/useT'

export interface IntegrationsPageProps {
  /** Extra classes appended to the page root */
  className?: string
}

/** Integrations management placeholder — ships in a later development phase */
export function IntegrationsPage({ className }: IntegrationsPageProps) {
  const t = useT()

  return (
    <div className={cn('space-y-4', className)}>
      <PageHeader title={t.nav.integrations} />

      <EmptyState
        icon={<Share2 className="h-6 w-6" />}
        title={t.pages.comingSoonTitle}
        description={t.pages.comingSoonDesc}
      />
    </div>
  )
}
