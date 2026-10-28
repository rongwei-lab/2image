import { readRuntimeEnv } from './runtimeEnv'

function readMetaEnv(value: string | undefined, fallback: string): string {
  const trimmed = readRuntimeEnv(value)
  return trimmed || fallback
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

const defaultRepositoryOwner = 'CookSleep'
const defaultRepositoryName = 'gpt_image_playground'
const defaultRepositorySlug = `${defaultRepositoryOwner}/${defaultRepositoryName}`
const defaultRepositoryUrl = `https://github.com/${defaultRepositorySlug}`

const repositoryUrl = trimTrailingSlash(
  readMetaEnv(import.meta.env?.VITE_APP_REPOSITORY_URL, defaultRepositoryUrl),
)
const issuesUrl = trimTrailingSlash(
  readMetaEnv(import.meta.env?.VITE_APP_ISSUES_URL, `${repositoryUrl}/issues`),
)
const releasesUrl = trimTrailingSlash(
  readMetaEnv(import.meta.env?.VITE_APP_RELEASES_URL, `${repositoryUrl}/releases/latest`),
)

const releaseApiUrl = readRuntimeEnv(import.meta.env?.VITE_APP_RELEASE_API_URL)

export const appMeta = {
  name: readMetaEnv(import.meta.env?.VITE_APP_NAME, 'Gpt To Image'),
  authorName: readMetaEnv(import.meta.env?.VITE_APP_AUTHOR_NAME, `@${defaultRepositoryOwner}`),
  repositoryUrl,
  issuesUrl,
  releasesUrl,
  releaseApiUrl: releaseApiUrl || `https://api.github.com/repos/${defaultRepositorySlug}/releases/latest`,
  releaseApiAccept: readMetaEnv(
    import.meta.env?.VITE_APP_RELEASE_API_ACCEPT,
    'application/vnd.github.v3+json',
  ),
  upstream: {
    name: 'GPT Image Playground',
    authorName: `@${defaultRepositoryOwner}`,
    repositoryUrl: defaultRepositoryUrl,
    licenseUrl: `${defaultRepositoryUrl}/blob/main/LICENSE`,
    licenseName: 'MIT',
  },
}
