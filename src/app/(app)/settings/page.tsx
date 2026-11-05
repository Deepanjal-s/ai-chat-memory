import { ActionButton, CaptureToggle, TokenCreator } from '@/components/Actions'
import { Badge, Card, CardHeader, PageHeader } from '@/components/ui'
import { aiDescription } from '@/lib/ai/llm'
import { config } from '@/lib/config'
import { getDb } from '@/lib/db/client'
import { fmtDateTime } from '@/lib/format'
import { captureStatus } from '@/lib/status'

export default async function SettingsPage() {
  const capture = await captureStatus(await getDb())
  const ai = aiDescription()
  return (
    <>
      <PageHeader title="Settings" subtitle="Automatic capture, connected browsers, and where your data may be sent." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader title="Live capture from ChatGPT in your browser" action={<Badge tone={capture.enabled ? 'ok' : 'neutral'}>{capture.enabled ? 'On' : 'Off'}</Badge>} />
          <div className="space-y-4 p-4 text-sm text-ink-2">
            <p>
              The Conversation Memory browser extension (Chrome or Edge) saves each ChatGPT conversation you open or continue, a few seconds after a reply
              finishes. It reads only what is on your screen, never your password or cookies, and sends it only to this app.
            </p>
            <div className="rounded-lg border border-warn bg-warn-soft p-3 text-ink">
              <p className="font-semibold text-warn">Please read before turning this on</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                <li>
                  OpenAI’s Terms of Use (effective 1 January 2026) prohibit using its services to “automatically or programmatically extract data or Output”.
                  Automatic capture of your own conversations falls within that wording. Whether to use it is the company’s decision.
                </li>
                <li>
                  It captures only conversations opened in this browser. It cannot see conversations you never open, or the ChatGPT desktop and phone apps.
                  Keep importing official exports (automatic from your Downloads folder) for complete history; exports also correct live captures.
                </li>
                <li>It depends on ChatGPT’s page layout. If OpenAI changes it, capture may stop until the extension is updated; the Status page will show this.</li>
              </ul>
            </div>
            <CaptureToggle enabled={capture.enabled} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Connected browsers" />
          <div className="space-y-3 p-4 text-sm text-ink-2">
            <p>
              Install the extension from the project’s <code>extension</code> folder (see README → Browser extension). Then create a pairing token here
              and paste it, with this app’s address, into the extension’s settings.
            </p>
            <TokenCreator />
            {capture.tokens.length > 0 && (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {capture.tokens.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span>
                      <span className="text-ink">{t.label}</span>
                      <span className="block text-xs text-ink-3">
                        Created {fmtDateTime(t.created_at)} · last used {fmtDateTime(t.last_used_at)}
                      </span>
                    </span>
                    {t.revoked_at ? <Badge>Revoked</Badge> : <ActionButton url={`/api/extension-tokens/${t.id}`} method="DELETE" label="Revoke" confirm="Disconnect this browser?" />}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="AI and data privacy" />
          <div className="space-y-3 p-4 text-sm text-ink-2">
            <p>
              <b className="text-ink">AI provider:</b> {ai.provider}
              {ai.model && <> ({ai.model})</>}.{' '}
              {ai.enabled
                ? 'Conversation excerpts are sent to this provider to extract knowledge, answer questions and write document overviews. Every call is logged on the Status page.' +
                  (config.aiProvider === 'gemini'
                    ? ' Note: on Google’s free (unpaid) Gemini tier, Google may use submitted content to improve its products and humans may review it. Enable billing on the Google project before processing confidential conversations.'
                    : '')
                : 'Knowledge extraction uses local rules and answers show verified records only. Nothing is sent to any AI service.'}
            </p>
            <p>
              <b className="text-ink">Semantic search:</b> {config.embeddingProvider === 'none' ? 'off (keyword search only; nothing sent).' : `${config.embeddingProvider} (${config.embeddingModel}); message text is sent to build the index.`}
            </p>
            <p className="text-xs text-ink-3">
              These are set by the administrator in the server configuration (<code>AI_PROVIDER</code>, <code>GEMINI_API_KEY</code> or{' '}
              <code>ANTHROPIC_API_KEY</code>, <code>EMBEDDING_PROVIDER</code>)
              because they decide where confidential data may go. Data is stored in <code className="break-all">{config.dataDir}</code>.
            </p>
          </div>
        </Card>
      </div>
    </>
  )
}
