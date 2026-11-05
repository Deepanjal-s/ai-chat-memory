import fs from 'node:fs'
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import PDFDocument from 'pdfkit'
import { citeText, type Block, type DocModel, type Run } from './model'

const chatgptLink = (externalId: string) => `https://chatgpt.com/c/${encodeURIComponent(externalId)}`
const fmtDate = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
const runsText = (runs: Run[]) => runs.map((r) => (r.tag ? `[${r.tag}] ` : '') + r.text + citeText(r.cites)).join('')

// ---- Markdown -----------------------------------------------------------------------------------

export function renderMarkdown(doc: DocModel): Buffer {
  const out: string[] = [`# ${doc.title}`, '', `_${doc.subtitle}. ${doc.scope}. Generated ${fmtDate(doc.generatedAt)}._`, '']
  for (const s of doc.sections) {
    out.push(`## ${s.heading}`, '')
    for (const b of s.blocks) out.push(mdBlock(b), '')
  }
  out.push('## Sources', '')
  for (const src of doc.sources) {
    out.push(
      `${src.n}. ${src.conversationTitle} — ${src.date?.slice(0, 10) ?? 'undated'}${src.origin === 'live_capture' ? ' (live capture)' : ''} — ` +
        `conversation ${src.externalId}, message ${src.messageId} — ${chatgptLink(src.externalId)}`,
    )
  }
  return Buffer.from(out.join('\n'), 'utf8')
}

function mdBlock(b: Block): string {
  switch (b.type) {
    case 'paragraph':
      return runsText(b.runs)
    case 'note':
      return `> ${b.text}`
    case 'bullets':
      return b.items.map((r) => `- ${runsText(r)}`).join('\n')
    case 'table': {
      const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
      return [`| ${b.headers.map(esc).join(' | ')} |`, `|${b.headers.map(() => '---').join('|')}|`, ...b.rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n')
    }
  }
}

// ---- DOCX ---------------------------------------------------------------------------------------

function docxRuns(runs: Run[]): TextRun[] {
  return runs.flatMap((r) => [
    ...(r.tag ? [new TextRun({ text: `${r.tag}: `, bold: true, color: '1F4FD1' })] : []),
    new TextRun({ text: r.text }),
    ...(r.cites?.length ? [new TextRun({ text: r.cites.map((c) => `[${c}]`).join(''), superScript: true, color: '555555' })] : []),
  ])
}

export async function renderDocx(doc: DocModel): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: doc.title })] }),
    new Paragraph({ children: [new TextRun({ text: doc.subtitle, italics: true, color: '555555' })] }),
    new Paragraph({ children: [new TextRun({ text: `${doc.scope} · Generated ${fmtDate(doc.generatedAt)}`, color: '777777', size: 18 })] }),
  ]
  for (const s of doc.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 300 }, children: [new TextRun(s.heading)] }))
    for (const b of s.blocks) {
      if (b.type === 'paragraph') children.push(new Paragraph({ spacing: { after: 120 }, children: docxRuns(b.runs) }))
      else if (b.type === 'note')
        children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: b.text, italics: true, color: '666666' })] }))
      else if (b.type === 'bullets') for (const it of b.items) children.push(new Paragraph({ bullet: { level: 0 }, children: docxRuns(it) }))
      else if (b.type === 'table') {
        const cell = (text: string, header = false) =>
          new TableCell({
            shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E8EEFC' } : undefined,
            children: [new Paragraph({ children: [new TextRun({ text, bold: header, size: 20 })] })],
          })
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [new TableRow({ tableHeader: true, children: b.headers.map((h) => cell(h, true)) }), ...b.rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) }))],
          }),
        )
      }
    }
  }
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 300 }, children: [new TextRun('Sources')] }))
  for (const src of doc.sources) {
    children.push(
      new Paragraph({
        spacing: { after: 60 },
        border: { bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } },
        children: [
          new TextRun({ text: `[${src.n}] `, bold: true }),
          new TextRun({ text: `${src.conversationTitle} — ${src.date?.slice(0, 10) ?? 'undated'}${src.origin === 'live_capture' ? ' (live capture)' : ''} — message ${src.messageId} — ` }),
          new ExternalHyperlink({ link: chatgptLink(src.externalId), children: [new TextRun({ text: 'open in ChatGPT', style: 'Hyperlink' })] }),
        ],
      }),
    )
  }
  const document = new Document({
    creator: 'Conversation Memory',
    title: doc.title,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [
      {
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: `${doc.title} · page `, size: 16, color: '888888' }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '888888' })],
              }),
            ],
          }),
        },
        children,
      },
    ],
  })
  return Packer.toBuffer(document)
}

// ---- PDF ----------------------------------------------------------------------------------------

/** A Unicode TrueType font if one is available (Docker image installs DejaVu; Windows has Arial). */
function unicodeFont(): { regular: string; bold: string } | null {
  const candidates = [
    { regular: process.env.PDF_FONT ?? '', bold: process.env.PDF_FONT_BOLD ?? process.env.PDF_FONT ?? '' },
    { regular: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' },
    { regular: 'C:\\Windows\\Fonts\\arial.ttf', bold: 'C:\\Windows\\Fonts\\arialbd.ttf' },
    { regular: '/System/Library/Fonts/Supplemental/Arial.ttf', bold: '/System/Library/Fonts/Supplemental/Arial Bold.ttf' },
  ]
  return candidates.find((c) => c.regular && fs.existsSync(c.regular) && fs.existsSync(c.bold)) ?? null
}

export function renderPdf(doc: DocModel): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 }, bufferPages: true, info: { Title: doc.title, Creator: 'Conversation Memory' } })
    const chunks: Buffer[] = []
    pdf.on('data', (c: Buffer) => chunks.push(c))
    pdf.on('end', () => resolve(Buffer.concat(chunks)))
    pdf.on('error', reject)

    const font = unicodeFont()
    let REG = 'Helvetica'
    let BOLD = 'Helvetica-Bold'
    // Without a Unicode font, characters outside Latin-1 are replaced rather than rendered as garbage.
    let clean = (s: string) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...').replace(/\u2192/g, '->').replace(/[^\x00-\xff]/g, '?')
    if (font) {
      pdf.registerFont('Body', font.regular)
      pdf.registerFont('Body-Bold', font.bold)
      REG = 'Body'
      BOLD = 'Body-Bold'
      clean = (s: string) => s
    }
    const ink = '#161a21'
    const muted = '#5a6270'
    const accent = '#1f4fd1'

    pdf.font(BOLD).fontSize(20).fillColor(ink).text(clean(doc.title))
    pdf.moveDown(0.3).font(REG).fontSize(10).fillColor(muted).text(clean(`${doc.subtitle}. ${doc.scope}. Generated ${fmtDate(doc.generatedAt)}.`))
    pdf.moveDown(1)

    const runLine = (runs: Run[], indent = 0, bullet = false) => {
      const opts = { indent, continued: true } as PDFKit.Mixins.TextOptions
      if (bullet) pdf.font(REG).fontSize(10.5).fillColor(ink).text('•  ', { indent, continued: true })
      runs.forEach((r, i) => {
        const last = i === runs.length - 1
        if (r.tag) pdf.font(BOLD).fillColor(accent).text(clean(`${r.tag}: `), { ...opts, indent: bullet ? 0 : indent })
        pdf.font(REG).fontSize(10.5).fillColor(ink).text(clean(r.text), { continued: !!r.cites?.length || !last })
        if (r.cites?.length) pdf.fillColor(muted).fontSize(8).text(r.cites.map((c) => `[${c}]`).join(''), { continued: !last })
        pdf.fontSize(10.5)
      })
      pdf.moveDown(0.35)
    }

    for (const s of doc.sections) {
      if (pdf.y > pdf.page.height - 140) pdf.addPage()
      pdf.moveDown(0.5).font(BOLD).fontSize(14).fillColor(accent).text(clean(s.heading))
      pdf.moveDown(0.3)
      for (const b of s.blocks) {
        if (b.type === 'paragraph') runLine(b.runs)
        else if (b.type === 'note') pdf.font(REG).fontSize(9.5).fillColor(muted).text(clean(b.text)).moveDown(0.4)
        else if (b.type === 'bullets') b.items.forEach((it) => runLine(it, 0, true))
        else if (b.type === 'table') {
          for (const row of b.rows) {
            runLine([{ text: row.map((c, i) => `${b.headers[i]}: ${c}`).join('  ·  ') }], 0, true)
          }
        }
      }
    }

    pdf.addPage().font(BOLD).fontSize(14).fillColor(accent).text('Sources')
    pdf.moveDown(0.4)
    for (const src of doc.sources) {
      pdf.font(BOLD).fontSize(9.5).fillColor(ink).text(`[${src.n}] `, { continued: true })
      pdf.font(REG).text(clean(`${src.conversationTitle} - ${src.date?.slice(0, 10) ?? 'undated'}${src.origin === 'live_capture' ? ' (live capture)' : ''} - message ${src.messageId} - `), { continued: true })
      pdf.fillColor(accent).text('open in ChatGPT', { link: chatgptLink(src.externalId), underline: true })
      pdf.moveDown(0.2)
    }

    const range = pdf.bufferedPageRange()
    for (let i = range.start; i < range.start + range.count; i++) {
      pdf.switchToPage(i)
      pdf.font(REG).fontSize(8).fillColor(muted).text(clean(`${doc.title} · page ${i + 1} of ${range.count}`), 56, pdf.page.height - 40, { align: 'center', lineBreak: false })
    }
    pdf.end()
  })
}
