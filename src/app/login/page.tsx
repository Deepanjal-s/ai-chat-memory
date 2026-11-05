import { redirect } from 'next/navigation'
import { LoginForm } from '@/components/LoginForm'
import { Card } from '@/components/ui'
import { authConfigured, isAuthenticated } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  if (await isAuthenticated()) redirect('/')
  const configured = authConfigured()
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-bold text-accent-ink">CM</span>
          <div>
            <h1 className="text-base font-semibold text-ink">Conversation Memory</h1>
            <p className="text-xs text-ink-3">Private archive · sign in to continue</p>
          </div>
        </div>
        {configured ? (
          <LoginForm />
        ) : (
          <div className="space-y-2 text-sm text-ink-2">
            <p className="font-medium text-bad">Sign-in is not set up yet.</p>
            <p>
              Set <code>APP_PASSWORD_HASH</code> and <code>SESSION_SECRET</code> (at least 32 characters) in <code>.env.local</code>,
              then restart the app. Create the hash with:
            </p>
            <pre className="overflow-x-auto rounded-lg bg-panel-2 p-2 text-xs">npm run hash-password -- &quot;your password&quot;</pre>
          </div>
        )}
      </Card>
    </main>
  )
}
