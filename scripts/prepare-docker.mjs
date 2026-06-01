import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiCacheDir = path.join(rootDir, '.docker-npm-cache', 'server')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, ...(options.env ?? {}) },
  })
  if (result.status === 0) return
  process.exit(result.status ?? 1)
}

function seedApiDependencyCache() {
  mkdirSync(apiCacheDir, { recursive: true })

  // 先更新服务端 lockfile，保证 API 镜像只安装真正需要的依赖。
  run('npm', [
    '--prefix',
    'server',
    'install',
    '--package-lock-only',
    '--cache',
    apiCacheDir,
    '--prefer-offline',
    '--no-audit',
    '--no-fund',
  ])

  const tempDir = mkdtempSync(path.join(tmpdir(), 'gip-api-deps-'))
  try {
    copyFileSync(path.join(rootDir, 'server', 'package.json'), path.join(tempDir, 'package.json'))
    copyFileSync(path.join(rootDir, 'server', 'package-lock.json'), path.join(tempDir, 'package-lock.json'))

    // 在临时目录执行安装，只填充 Docker 构建缓存，不污染仓库目录。
    run('npm', [
      '--prefix',
      tempDir,
      'ci',
      '--cache',
      apiCacheDir,
      '--prefer-offline',
      '--no-audit',
      '--no-fund',
      '--progress=false',
    ])
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function buildServerBundle() {
  const outputDir = path.join(rootDir, 'server-dist')
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })

  // 服务端先在本机打包，容器运行纯 JS，避免生产镜像安装 tsx/esbuild。
  run(path.join(rootDir, 'node_modules', '.bin', 'esbuild'), [
    'server/index.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node22',
    '--packages=external',
    '--outfile=server-dist/index.js',
  ])
}

function buildDockerDist() {
  const placeholderEnv = {
    VITE_DEFAULT_API_URL: '__VITE_DEFAULT_API_URL_PLACEHOLDER__',
    VITE_API_PROXY_AVAILABLE: '__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__',
    VITE_API_PROXY_LOCKED: '__VITE_API_PROXY_LOCKED_PLACEHOLDER__',
    VITE_DOCKER_DEPLOYMENT: '__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__',
    VITE_DOCKER_LEGACY_API_URL_USED: '__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__',
  }
  run('npm', ['run', 'build'], { env: placeholderEnv })
}

if (!existsSync(path.join(rootDir, 'server', 'package.json'))) {
  throw new Error('缺少 server/package.json，无法准备 Docker API 依赖')
}

seedApiDependencyCache()
buildServerBundle()
buildDockerDist()
