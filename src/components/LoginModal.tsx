import { useState } from 'react'
import type { FormEvent } from 'react'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { registerCloud } from '../lib/cloudApi'
import { useStore } from '../store'

interface LoginModalProps {
  onClose: () => void
}

export default function LoginModal({ onClose }: LoginModalProps) {
  const cloudLogin = useStore((state) => state.cloudLogin)
  const showToast = useStore((state) => state.showToast)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useCloseOnEscape(true, onClose)
  usePreventBackgroundScroll(true)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!email.trim() || !password) {
      showToast('请输入邮箱和密码', 'error')
      return
    }

    if (mode === 'register') {
      if (password.length < 8) {
        showToast('密码至少需要 8 位', 'error')
        return
      }
      if (password !== confirmPassword) {
        showToast('两次输入的密码不一致', 'error')
        return
      }
      try {
        setSubmitting(true)
        const result = await registerCloud({ email: email.trim(), password })
        setPassword('')
        setConfirmPassword('')
        setMode('login')
        showToast(result.status === 'approved' ? '注册成功，请登录' : '注册申请已提交，请等待管理员审批', 'success')
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error')
      } finally {
        setSubmitting(false)
      }
      return
    }

    try {
      setSubmitting(true)
      await cloudLogin(email.trim(), password)
      showToast('已登录云端工作台', 'success')
      onClose()
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const switchMode = (nextMode: 'login' | 'register') => {
    setMode(nextMode)
    setPassword('')
    setConfirmPassword('')
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#1f2025] shadow-2xl border border-gray-200 dark:border-white/[0.08] p-5"
      >
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {mode === 'login' ? '登录云端工作台' : '申请注册'}
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {mode === 'login' ? '登录后任务、图片和 Agent 上下文会同步到服务器。' : '提交后需要管理员在后台审批，通过后即可登录。'}
          </p>
        </div>
        <label className="block mb-3">
          <span className="block mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">邮箱</span>
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-lg border border-gray-200 dark:border-white/[0.1] bg-white dark:bg-white/[0.04] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            autoComplete="email"
          />
        </label>
        <label className="block mb-3">
          <span className="block mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">密码</span>
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            className="w-full rounded-lg border border-gray-200 dark:border-white/[0.1] bg-white dark:bg-white/[0.04] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            autoComplete="current-password"
          />
        </label>
        {mode === 'register' && (
          <label className="block mb-5">
            <span className="block mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">确认密码</span>
            <input
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              type="password"
              className="w-full rounded-lg border border-gray-200 dark:border-white/[0.1] bg-white dark:bg-white/[0.04] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
              autoComplete="new-password"
            />
          </label>
        )}
        {mode === 'login' && <div className="mb-5" />}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={mode === 'login' ? onClose : () => switchMode('login')}
            className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            {mode === 'login' ? '取消' : '返回登录'}
          </button>
          {mode === 'login' && (
            <button
              type="button"
              onClick={() => switchMode('register')}
              className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
            >
              申请注册
            </button>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {submitting ? (mode === 'login' ? '登录中...' : '提交中...') : (mode === 'login' ? '登录' : '提交申请')}
          </button>
        </div>
      </form>
    </div>
  )
}
