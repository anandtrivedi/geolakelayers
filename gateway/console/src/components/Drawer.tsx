import { useEffect } from 'react'
import type { ReactNode } from 'react'

// Right-side panel over the page (Help, Table setup). Esc or the backdrop closes it.
export function Drawer ({ open, title, onClose, children, wide = false }: { open: boolean, title: string, onClose: () => void, children: ReactNode, wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className='drawer-layer'>
      <div className='drawer-backdrop' onClick={onClose} />
      <aside className={`drawer${wide ? ' wide' : ''}`} role='dialog' aria-modal='true' aria-label={title}>
        <div className='drawer-head'>
          <h2>{title}</h2>
          <button className='icon-button' aria-label='Close' onClick={onClose}>×</button>
        </div>
        <div className='drawer-body'>{children}</div>
      </aside>
    </div>
  )
}
