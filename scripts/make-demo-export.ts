/**
 * Writes a synthetic ChatGPT export (.zip) for trying the app without real data:
 *   npx tsx scripts/make-demo-export.ts demo-export.zip
 * The data is invented: one project (VK7SPORTS) discussed across several conversations, with a decision that
 * changes later, open tasks, a problem and its fix, plus unrelated conversations.
 */
import fs from 'node:fs'
import yazl from 'yazl'
import { conversation, marketingConversation, t, vk7Conversation } from '../tests/fixtures/build-export'

const out = process.argv[2] ?? 'demo-export.zip'
const convs = [
  vk7Conversation(
    [{ id: 'u3', parent: 'a2b', role: 'user', text: 'Pending: add a players table and decide on hosting by end of March.', time: t('2026-03-02T09:00:00Z') }],
    'u3',
  ),
  conversation({
    id: 'demo-vk7-req-0001',
    title: 'VK7SPORTS app requirements',
    create: t('2026-03-10T08:00:00Z'),
    update: t('2026-03-10T08:40:00Z'),
    current: 'r4',
    messages: [
      { id: 'rr', parent: null },
      { id: 'r1', parent: 'rr', role: 'user', text: 'Requirements for VK7SPORTS: the app must support live match scores for cricket and football. It has to work offline for coaches. Payments must use Razorpay.', time: t('2026-03-10T08:00:00Z') },
      { id: 'r2', parent: 'r1', role: 'assistant', text: 'Noted. I recommend React Native so one codebase serves Android and iOS.', time: t('2026-03-10T08:01:00Z'), model: 'gpt-4o' },
      { id: 'r3', parent: 'r2', role: 'user', text: "Decision: we'll go with React Native for the VK7SPORTS mobile app. Pending: prepare the API contract by 15 April.", time: t('2026-03-10T08:20:00Z') },
      { id: 'r4', parent: 'r3', role: 'assistant', text: 'Here is a draft API contract outline for VK7SPORTS.', time: t('2026-03-10T08:21:00Z'), model: 'gpt-4o' },
    ],
  }),
  conversation({
    id: 'demo-vk7-scale-0002',
    title: 'VK7SPORTS live score scaling issues',
    create: t('2026-05-20T11:00:00Z'),
    update: t('2026-05-20T11:45:00Z'),
    current: 's4',
    messages: [
      { id: 'sr', parent: null },
      { id: 's1', parent: 'sr', role: 'user', text: 'The VK7SPORTS live score feed has an issue: database writes are failing under match-day load.', time: t('2026-05-20T11:00:00Z') },
      { id: 's2', parent: 's1', role: 'assistant', text: 'You could use Redis as a write buffer in front of the database, and batch writes every second.', time: t('2026-05-20T11:01:00Z'), model: 'gpt-4o' },
      { id: 's3', parent: 's2', role: 'user', text: 'Decision: VK7SPORTS will use MongoDB for match statistics instead of PostgreSQL. Completed: the Redis write buffer is now live.', time: t('2026-05-20T11:30:00Z') },
      { id: 's4', parent: 's3', role: 'assistant', text: 'Understood. Here is a migration plan from PostgreSQL to MongoDB for match statistics.', time: t('2026-05-20T11:31:00Z'), model: 'gpt-4o' },
    ],
  }),
  marketingConversation(),
  conversation({
    id: 'demo-arch-0003',
    title: 'AI project backend architecture',
    create: t('2026-05-12T08:00:00Z'),
    update: t('2026-05-12T08:20:00Z'),
    current: 'x3',
    messages: [
      { id: 'xr', parent: null },
      { id: 'x1', parent: 'xr', role: 'user', text: 'For the HELIXAI project backend, should we use FastAPI or Node?', time: t('2026-05-12T08:00:00Z') },
      {
        id: 'x2',
        parent: 'x1',
        role: 'assistant',
        text: '## Recommendation\n\n- **Node/TypeScript** if the team is JavaScript-first\n- **FastAPI** for ML-heavy work\n\n```ts\nconst app = express()\n```',
        time: t('2026-05-12T08:00:30Z'),
        model: 'gpt-4o',
      },
      { id: 'x3', parent: 'x2', role: 'user', text: 'I prefer TypeScript for all new HELIXAI services. Decision: HELIXAI backend will use Node with TypeScript.', time: t('2026-05-12T08:10:00Z') },
    ],
  }),
]
const zip = new yazl.ZipFile()
zip.addBuffer(Buffer.from(JSON.stringify(convs)), 'conversations.json')
zip.addBuffer(Buffer.from('<html></html>'), 'chat.html')
zip.addBuffer(Buffer.from('{}'), 'user.json')
zip.end()
zip.outputStream.pipe(fs.createWriteStream(out)).on('close', () => console.log(`Wrote ${out}`))
