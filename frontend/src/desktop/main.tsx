import React from 'react'
import ReactDOM from 'react-dom/client'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { ConfirmProvider } from '@panwatch/base-ui/components/ui/confirm-dialog'
import { ToastProvider } from '@panwatch/base-ui/components/ui/toast'
import i18n, { i18nReady } from '../i18n'
import { applyMarketColorScheme, readMarketColorPreference } from '../lib/market-colors'
import DesktopApp from './DesktopApp'
import '../index.css'
import './desktop.css'

function DesktopProviders({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('common')
  return <ConfirmProvider labels={{ title: t('actions.confirm'), cancel: t('actions.cancel'), confirm: t('actions.confirm') }}>{children}</ConfirmProvider>
}

void i18nReady.then(() => i18n.loadNamespaces(['desktop', 'configuration', 'bizUi'])).then(() => {
  const applyColors = (locale = i18n.resolvedLanguage || i18n.language) => applyMarketColorScheme(readMarketColorPreference(), locale)
  applyColors()
  i18n.on('languageChanged', applyColors)
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>
        <ToastProvider><DesktopProviders><DesktopApp /></DesktopProviders></ToastProvider>
      </I18nextProvider>
    </React.StrictMode>,
  )
})
