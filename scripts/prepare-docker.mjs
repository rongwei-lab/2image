import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiCacheDir = path.join(rootDir, '.docker-npm-cache', 'server')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
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
    'install',
    '--package-lock-only',
    '--cache',
    apiCacheDir,
    '--prefer-offline',
    '--no-audit',
    '--no-fund',
  ], { cwd: path.join(rootDir, 'server') })

  const tempDir = mkdtempSync(path.join(tmpdir(), 'gip-api-deps-'))
  try {
    copyFileSync(path.join(rootDir, 'server', 'package.json'), path.join(tempDir, 'package.json'))
    copyFileSync(path.join(rootDir, 'server', 'package-lock.json'), path.join(tempDir, 'package-lock.json'))

    // 在临时目录执行安装，只填充 Docker 构建缓存，不污染仓库目录。
    run('npm', [
      'ci',
      '--cache',
      apiCacheDir,
      '--prefer-offline',
      '--no-audit',
      '--no-fund',
      '--progress=false',
    ], { cwd: tempDir })
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function buildServerBundle() {
  const outputDir = path.join(rootDir, 'server-dist')
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })

  // 服务端先在本机打包，容器运行纯 JS，避免生产镜像安装 tsx/esbuild。
  await build({
    absWorkingDir: rootDir,
    entryPoints: ['server/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    define: { 'import.meta.env': '{}' },
    loader: { '.css': 'empty' },
    outfile: 'server-dist/index.js',
    plugins: [{
      name: 'server-platform',
      setup(build) {
        build.onResolve({ filter: /(^|\/)platform$/ }, (args) => {
          if (path.resolve(args.resolveDir, args.path) !== path.join(rootDir, 'src/lib/platform')) return
          return { path: path.join(rootDir, 'server/platform.ts') }
        })
      },
    }],
  })
}

function buildDockerDist() {
  const placeholderEnv = {
    VITE_DEFAULT_API_URL: '__VITE_DEFAULT_API_URL_PLACEHOLDER__',
    VITE_API_PROXY_AVAILABLE: '__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__',
    VITE_API_PROXY_LOCKED: '__VITE_API_PROXY_LOCKED_PLACEHOLDER__',
    VITE_DOCKER_DEPLOYMENT: '__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__',
    VITE_DOCKER_LEGACY_API_URL_USED: '__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__',
    // 与 Dockerfile 内置构建保持一致，便于运行时注入预置配置策略。
    VITE_SHOW_PRESET_CONFIG_ONLY: '__VITE_SHOW_PRESET_CONFIG_ONLY_PLACEHOLDER__',
    VITE_LOCK_PRESET_CONFIG_PARAMS: '__VITE_LOCK_PRESET_CONFIG_PARAMS_PLACEHOLDER__',
    VITE_PREVENT_PRESET_CONFIG_DELETION: '__VITE_PREVENT_PRESET_CONFIG_DELETION_PLACEHOLDER__',
    VITE_DEFAULT_UI_FONT: '__VITE_DEFAULT_UI_FONT_PLACEHOLDER__',
    VITE_DEFAULT_MONO_FONT: '__VITE_DEFAULT_MONO_FONT_PLACEHOLDER__',
    VITE_BUILTIN_FONT_SOURCE: '__VITE_BUILTIN_FONT_SOURCE_PLACEHOLDER__',
  }
  run('npm', ['run', 'build'], { env: placeholderEnv })
}

if (!existsSync(path.join(rootDir, 'server', 'package.json'))) {
  throw new Error('缺少 server/package.json，无法准备 Docker API 依赖')
}

seedApiDependencyCache()
await buildServerBundle()
buildDockerDist()
