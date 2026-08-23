import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { LocaleProvider } from './i18n/LocaleProvider'
import { ThemeProvider } from './components/ThemeProvider'

// LocaleProvider must wrap ThemeProvider so ThemeProvider's children (Header)
// can call useLocale() if needed in the future, and so the language switcher
// persists independently of the theme.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </LocaleProvider>
  </StrictMode>,
)
