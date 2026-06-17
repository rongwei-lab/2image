/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __DEV_PROXY_CONFIG__: unknown

interface ImportMetaEnv {
  readonly VITE_DEFAULT_API_URL?: string
  readonly VITE_API_PROXY_AVAILABLE?: string
  readonly VITE_API_PROXY_LOCKED?: string
  readonly VITE_DOCKER_DEPLOYMENT?: string
  readonly VITE_DOCKER_LEGACY_API_URL_USED?: string
  readonly VITE_SHOW_DEFAULT_CONFIG_ONLY?: string
  readonly VITE_APP_NAME?: string
  readonly VITE_APP_AUTHOR_NAME?: string
  readonly VITE_APP_REPOSITORY_URL?: string
  readonly VITE_APP_ISSUES_URL?: string
  readonly VITE_APP_RELEASES_URL?: string
  readonly VITE_APP_RELEASE_API_URL?: string
  readonly VITE_APP_RELEASE_API_ACCEPT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
