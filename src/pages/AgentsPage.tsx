import { useT } from '@/i18n/useT'
import { useData } from '@/lib/data-context'
import { PageHeader } from '@/components/common/PageHeader'
import { LocalUsageCard } from '@/components/overview/LocalUsageCard'
import { AgentConfigSection } from '@/components/agent-config/AgentConfigSection'

/**
 * Agent management page (desktop-only capability): local AI coding agents
 * discovered on this machine (Codex / Kimi Code / OpenCode / ZCode / DSH), with their
 * real token consumption read from session logs via tokscale. API-key accounts
 * live on the Accounts and Plans pages — not here.
 *
 * The lower section edits the two agents that keep a provider tree on disk
 * (Kimi Code and MiniMax Code); see components/agent-config/.
 */
export function AgentsPage() {
  const t = useT()
  const { agentUsage, agentUsageLoading, refreshAgentUsage } = useData()

  return (
    <div className="space-y-4">
      <PageHeader title={t.manage.agentsTitle} description={t.manage.agentsDesc} />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">{t.manage.localAgents}</h2>
        <LocalUsageCard
          usage={agentUsage}
          loading={agentUsageLoading}
          onRefresh={refreshAgentUsage}
        />
      </section>

      <AgentConfigSection />
    </div>
  )
}
