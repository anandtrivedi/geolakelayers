import type { ReactNode } from 'react'
import guide from '../../../../docs/guide.md?raw'

// Renders docs/guide.md, the same file the README links to. Handles the little Markdown the guide uses:
// headings, paragraphs, bullet lists, pipe tables, `code` and **bold**.
function inline (text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).filter(Boolean).map((part, i) => {
    if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith('**')) return <b key={i}>{part.slice(2, -2)}</b>
    return part
  })
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())

export function Guide () {
  const blocks = guide.trim().split(/\n\s*\n/)
  return (
    <section className='card guide'>
      {blocks.map((block, i) => {
        const lines = block.split('\n')
        if (block.startsWith('# ')) return <h2 key={i}>{inline(block.slice(2))}</h2>
        if (block.startsWith('## ')) return <h3 key={i}>{inline(block.slice(3))}</h3>
        if (lines.every(l => l.startsWith('- '))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.slice(2))}</li>)}</ul>
        if (lines.every(l => l.startsWith('|'))) {
          const [head, , ...rows] = lines
          return (
            <table key={i} className='guide-table'>
              <thead><tr>{cells(head).map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
              <tbody>{rows.map((r, j) => <tr key={j}>{cells(r).map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>)}</tbody>
            </table>
          )
        }
        return <p key={i}>{inline(block.replace(/\n/g, ' '))}</p>
      })}
      <p className='muted small'>This page is <code>docs/guide.md</code> in the ArcGateway repository.</p>
    </section>
  )
}
