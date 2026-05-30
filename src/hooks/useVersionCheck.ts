import { useState, useEffect } from 'react'
import { appMeta } from '../lib/appMeta'

function compareVersions(a: string, b: string) {
  const aParts = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const bParts = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(aParts.length, bParts.length)

  for (let i = 0; i < length; i += 1) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0)
    if (diff !== 0) return diff
  }

  return 0
}

export interface LatestRelease {
  tag: string
  url: string
}

/**
 * 检查配置的最新 Release 版本。
 * - 仅当最新 Release 版本高于当前 __APP_VERSION__ 时提示。
 * - 用户点击后调用 dismiss()，本次浏览期间不再提示（sessionStorage）。
 * - 刷新页面后重新检查。
 */
export function useVersionCheck() {
  const [latestRelease, setLatestRelease] = useState<LatestRelease | null>(null)
  const [dismissed, setDismissed] = useState(() =>
    sessionStorage.getItem('version-dismissed') === 'true',
  )

  useEffect(() => {
    let cancelled = false

    fetch(appMeta.releaseApiUrl, { headers: { Accept: appMeta.releaseApiAccept } })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        const tag: string = data.tag_name ?? ''
        const version = tag.replace(/^v/, '')
        if (version && compareVersions(version, __APP_VERSION__) > 0) {
          setLatestRelease({
            tag,
            url: data.html_url ?? appMeta.releasesUrl,
          })
        }
      })
      .catch(() => {
        /* 静默失败，不影响正常使用 */
      })

    return () => {
      cancelled = true
    }
  }, [])

  const dismiss = () => {
    setDismissed(true)
    sessionStorage.setItem('version-dismissed', 'true')
  }

  const hasUpdate = latestRelease !== null && !dismissed

  return { hasUpdate, latestRelease, dismiss }
}
