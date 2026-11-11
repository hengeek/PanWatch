import React from 'react'
import ReactDOM from 'react-dom/client'
import i18n, { i18nReady } from '../i18n'
import DesktopApp from './DesktopApp'
import './desktop.css'

void i18nReady
  .then(() => i18n.loadNamespaces(['common', 'desktop']))
  .then(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode><DesktopApp /></React.StrictMode>,
    )
  })
