import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import type { Access } from '../api'

// Permission hints and refusals, shared by the forms that write to Unity Catalog

/** A note shown before a write when the caller's grants don't seem to allow it. Nothing when they do, or can't be read. */
export function AccessHint ({ action, name, doing }: { action: 'MODIFY' | 'CREATE_TABLE', name: string | null | undefined, doing: string }) {
  const [access, setAccess] = useState<Access | null>(null)
  useEffect(() => {
    setAccess(null)
    const valid = action === 'CREATE_TABLE' ? /^\w+\.\w+$/.test(name || '') : /^\w+\.\w+\.\w+$/.test(name || '')
    if (!valid) return
    const timer = setTimeout(() => api.access(action, name!).then(setAccess).catch(() => {}), 400)
    return () => clearTimeout(timer)
  }, [action, name])
  if (!access || access.ok !== false) return null
  return (
    <p className='access-hint small'>
      {doing} needs {access.missing!.join(', ')}. GeoLakeLayers found no grant that gives you that; ask an owner or admin, or try anyway if you have access another way.
    </p>
  )
}

/** An error from a write. A preflight refusal ("no grant found") offers to try anyway. */
export function WriteError ({ error, onRetry }: { error: unknown, onRetry?: () => void }) {
  if (!error) return null
  const e = error as ApiError
  return (
    <div className='error small write-error'>
      <span>{e.message || String(error)}</span>
      {e.code === 'preflight' && onRetry && <button className='button ghost' onClick={onRetry}>Try anyway</button>}
    </div>
  )
}
