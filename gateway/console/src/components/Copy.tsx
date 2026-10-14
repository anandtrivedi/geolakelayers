import { useState } from 'react'

export function Copy ({ text, label = 'Copy', primary = false }: { text: string, label?: string, primary?: boolean }) {
  const [done, setDone] = useState(false)
  return <button className={`button${primary ? '' : ' ghost'}`} onClick={async () => { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>{done ? 'Copied' : label}</button>
}

// Read-only URL with a movable cursor and a Copy button
export function UrlField ({ url, label, copyLabel, primary }: { url: string, label: string, copyLabel?: string, primary?: boolean }) {
  return (
    <div className='url-row'>
      <input className='url' readOnly value={url} title={url} aria-label={label} spellCheck={false} />
      <Copy text={url} label={copyLabel} primary={primary} />
    </div>
  )
}
