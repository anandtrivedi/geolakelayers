import type { ReactNode } from 'react'
import guide from '../../../../docs/guide.md?raw'
import install from '../../../../docs/install.md?raw'

// Renders docs/guide.md and docs/install.md, the same files the README links to. Handles the Markdown they use:
// headings, paragraphs, bullet and numbered lists, pipe tables, fenced code, > [!NOTE] callouts, images,
// links, `code` and **bold**.

// Screenshots the docs show, bundled so the Help drawer works without GitHub (the rest stay README-only)
const shots: Record<string, string> = Object.fromEntries(Object.entries(
  import.meta.glob(['../../../../screenshots/install-*.png', '../../../../screenshots/portal-*.png', '../../../../screenshots/settings-workspace-card.png'],
    { eager: true, query: '?url', import: 'default' }) as Record<string, string>
).map(([path, url]) => [path.split('/').pop()!, url]))

function inline (text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/).filter(Boolean).map((part, i) => {
    if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith('**')) return <b key={i}>{inline(part.slice(2, -2))}</b>
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (link) return /^https?:/.test(link[2]) ? <a key={i} href={link[2]} target='_blank' rel='noreferrer'>{link[1]}</a> : <b key={i}>{link[1]}</b>
    return part
  })
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
const special = /^(#{1,3} |```|> ?|\||- |\d+\. |!\[)/

export function Markdown ({ source }: { source: string }) {
  const lines = source.trim().split('\n')
  const out: ReactNode[] = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    const key = out.length
    if (!line.trim()) { i++; continue }
    if (line.startsWith('```')) {
      const code: string[] = []
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i])
      i++
      out.push(<pre key={key} className='snippet'>{code.join('\n')}</pre>)
    } else if (line.startsWith('>')) {
      const body: string[] = []
      for (; i < lines.length && lines[i].startsWith('>'); i++) body.push(lines[i].replace(/^> ?/, ''))
      const kind = body[0]?.match(/^\[!(NOTE|IMPORTANT|WARNING|TIP)\]$/)
      out.push(<div key={key} className={`md-callout ${kind ? kind[1].toLowerCase() : 'note'}`}><Markdown source={(kind ? body.slice(1) : body).join('\n')} /></div>)
    } else if (/^#{1,3} /.test(line)) {
      const level = line.indexOf(' ')
      const text = inline(line.slice(level + 1))
      out.push(level === 1 ? <h2 key={key}>{text}</h2> : level === 2 ? <h3 key={key}>{text}</h3> : <h4 key={key}>{text}</h4>)
      i++
    } else if (line.startsWith('|')) {
      const rows: string[] = []
      for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i])
      const [head, , ...body] = rows
      out.push(
        <table key={key} className='guide-table'>
          <thead><tr>{cells(head).map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
          <tbody>{body.map((r, j) => <tr key={j}>{cells(r).map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>)}</tbody>
        </table>
      )
    } else if (/^(- |\d+\. )/.test(line)) {
      const ordered = /^\d/.test(line)
      const items: string[] = []
      for (; i < lines.length && (/^(- |\d+\. )/.test(lines[i]) || /^ {2,}\S/.test(lines[i])); i++) {
        if (/^ {2,}\S/.test(lines[i])) items[items.length - 1] += ' ' + lines[i].trim()
        else items.push(lines[i].replace(/^(- |\d+\. )/, ''))
      }
      const lis = items.map((t, j) => <li key={j}>{inline(t)}</li>)
      out.push(ordered ? <ol key={key}>{lis}</ol> : <ul key={key}>{lis}</ul>)
    } else if (line.startsWith('![')) {
      const [, alt, src] = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/) || []
      const url = src && shots[src.split('/').pop()!]
      if (url) out.push(<figure key={key} className='md-figure'><img src={url} alt={alt} loading='lazy' /><figcaption>{alt}</figcaption></figure>)
      i++
    } else {
      const para: string[] = []
      for (; i < lines.length && lines[i].trim() && (!para.length || !special.test(lines[i])); i++) para.push(lines[i])
      out.push(<p key={key}>{inline(para.join(' '))}</p>)
    }
  }
  return <>{out}</>
}

export function Guide ({ widgetSource }: { widgetSource?: string | null }) {
  return (
    <section className='card guide'>
      <Markdown source={guide} />
      {widgetSource && <p className='small'>The Databricks Data widget's source and install notes: <a href={widgetSource} target='_blank' rel='noreferrer'>{widgetSource.replace(/^https:\/\//, '')}</a></p>}
      <p className='muted small'>This page is <code>docs/guide.md</code> in the GeoLakeLayers repository.</p>
    </section>
  )
}

export function Install () {
  return (
    <section className='card guide'>
      <Markdown source={install} />
      <p className='muted small'>This page is <code>docs/install.md</code> in the GeoLakeLayers repository.</p>
    </section>
  )
}
