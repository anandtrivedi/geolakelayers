import { useMemo, useState } from 'react'

// Paste an Experience Builder / Portal address and see whether ALLOWED_ORIGINS lets it call the gateway
export function OriginCheck ({ allowedOrigins }: { allowedOrigins: string[] }) {
  const [origin, setOrigin] = useState('')
  const tested = useMemo(() => {
    const v = origin.trim()
    if (!v) return null
    try {
      const o = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`).origin
      return { origin: o, ok: allowedOrigins.includes(o) }
    } catch (_) { return { origin: v, ok: false, invalid: true } }
  }, [origin, allowedOrigins])
  return (
    <>
      <input className='url origin-test' value={origin} onChange={e => setOrigin(e.target.value)} placeholder='Paste its address, e.g. https://portal.example.com/portal/apps/experiencebuilder/' aria-label='Experience Builder address' spellCheck={false} />
      {tested && <p className={`small ${tested.ok ? '' : 'error'}`}>
        {tested.invalid ? 'That isn\'t a web address.' : tested.ok ? `Yes: ${tested.origin} is allowed.` : `No: add ${tested.origin} to allowed_origins in the bundle and redeploy. Until then its sign-in popup closes and nothing loads.`}
      </p>}
    </>
  )
}
