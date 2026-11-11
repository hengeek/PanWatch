// Keep dictionaries outside the entry bundle and load namespaces on demand.
export const resourceLoaders = {
  'zh-CN': {
    common: () => import('./locales/zh-CN/common').then(m => m.common),
    navigation: () => import('./locales/zh-CN/navigation').then(m => m.navigation),
    auth: () => import('./locales/zh-CN/auth').then(m => m.auth),
    configuration: () => import('./locales/zh-CN/configuration').then(m => m.configuration),
    settings: () => import('./locales/zh-CN/settings').then(m => m.settings),
    bizUi: () => import('./locales/zh-CN/biz-ui').then(m => m.bizUi),
    leftSide: () => import('./locales/zh-CN/left-side').then(m => m.leftSide),
    desktop: () => import('./locales/zh-CN/desktop').then(m => m.desktop),
  },
  'en-US': {
    common: () => import('./locales/en-US/common').then(m => m.common),
    navigation: () => import('./locales/en-US/navigation').then(m => m.navigation),
    auth: () => import('./locales/en-US/auth').then(m => m.auth),
    configuration: () => import('./locales/en-US/configuration').then(m => m.configuration),
    settings: () => import('./locales/en-US/settings').then(m => m.settings),
    bizUi: () => import('./locales/en-US/biz-ui').then(m => m.bizUi),
    leftSide: () => import('./locales/en-US/left-side').then(m => m.leftSide),
    desktop: () => import('./locales/en-US/desktop').then(m => m.desktop),
  },
} as const
