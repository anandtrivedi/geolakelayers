import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
// DM Sans / DM Mono bundled with the build: the app runs behind egress controls, so no font CDN
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/700.css'
import '@fontsource/dm-mono/400.css'
import '@fontsource/dm-mono/500.css'
import './styles.css'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
