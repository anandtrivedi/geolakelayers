import { useState } from 'react'
import { api } from '../api'

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

// Copies "Bearer <token>" for this app, ready to paste as the Authorization header value in QGIS or a script
export function CopyToken () {
  const [state, setState] = useState<{ until?: string, error?: string }>({})
  const copy = async () => {
    try {
      const { token, expiresAt } = await api.token()
      await navigator.clipboard.writeText(`Bearer ${token}`)
      setState({ until: expiresAt ? new Date(expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'about an hour from now' })
    } catch (e: any) { setState({ error: e.message }) }
  }
  return (
    <span className='copy-token'>
      <button className='button ghost' onClick={copy}>Copy a token</button>
      {state.until && <span className='small muted'> Copied as <code>Bearer …</code>, ready to paste as the Authorization value. Good until {state.until}.</span>}
      {state.error && <span className='small error'> {state.error}</span>}
    </span>
  )
}
