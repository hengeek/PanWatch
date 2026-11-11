import { auth as enAuth } from './locales/en-US/auth'
import { common as enCommon } from './locales/en-US/common'
import { configuration as enConfiguration } from './locales/en-US/configuration'
import { desktop as enDesktop } from './locales/en-US/desktop'
import { leftSide as enLeftSide } from './locales/en-US/left-side'
import { navigation as enNavigation } from './locales/en-US/navigation'
import { settings as enSettings } from './locales/en-US/settings'
import { bizUi as enBizUi } from './locales/en-US/biz-ui'
import { auth as zhAuth } from './locales/zh-CN/auth'
import { common as zhCommon } from './locales/zh-CN/common'
import { configuration as zhConfiguration } from './locales/zh-CN/configuration'
import { desktop as zhDesktop } from './locales/zh-CN/desktop'
import { leftSide as zhLeftSide } from './locales/zh-CN/left-side'
import { navigation as zhNavigation } from './locales/zh-CN/navigation'
import { settings as zhSettings } from './locales/zh-CN/settings'
import { bizUi as zhBizUi } from './locales/zh-CN/biz-ui'
import type { TranslationShape } from './resource-types'

export const zhCN = {
  common: zhCommon,
  configuration: zhConfiguration,
  auth: zhAuth,
  navigation: zhNavigation,
  settings: zhSettings,
  bizUi: zhBizUi,
  leftSide: zhLeftSide,
  desktop: zhDesktop,
} as const

export const enUS = {
  common: enCommon,
  configuration: enConfiguration,
  auth: enAuth,
  navigation: enNavigation,
  settings: enSettings,
  bizUi: enBizUi,
  leftSide: enLeftSide,
  desktop: enDesktop,
} as const satisfies TranslationShape<typeof zhCN>

export const resources = {
  'zh-CN': zhCN,
  'en-US': enUS,
} as const

export type NavigationItemKey = keyof typeof zhCN.navigation.items
