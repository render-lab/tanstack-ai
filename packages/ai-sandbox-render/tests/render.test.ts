import { describe, expect, it } from 'vitest'
import { renderSandbox } from '../src/index'
import type { SandboxHandle } from '@tanstack/ai-sandbox'

// Auto-gate: only run with Render credentials (these tests create real,
// billed sandboxes). The SDK reads both from the environment itself.
const hasCreds =
  !!process.env.RENDER_API_KEY && !!process.env.RENDER_WORKSPACE_ID

const provider = renderSandbox({ timeoutSeconds: 1800 })

/** Run `body` against a fresh sandbox and always terminate it. */
async function withSandbox(
  input: Parameters<typeof provider.create>[0],
  body: (sbx: SandboxHandle) => Promise<void>,
): Promise<void> {
  const sbx = await provider.create(input)
  try {
    await body(sbx)
  } finally {
    await sbx.destroy()
  }
}

describe.skipIf(!hasCreds)(
  'render provider (gated on RENDER_API_KEY + RENDER_WORKSPACE_ID)',
  () => {
    it('runs exec, env and a full fs round trip', async () => {
      await withSandbox({ env: { CREATE_VAR: 'created' } }, async (sbx) => {
        const echo = await sbx.process.exec('pwd')
        expect(echo).toMatchObject({ stdout: '/workspace\n', exitCode: 0 })

        const failed = await sbx.process.exec('echo nope >&2; exit 7')
        expect(failed).toMatchObject({ stderr: 'nope\n', exitCode: 7 })

        await sbx.env.set({ BASE_VAR: 'base' })
        const env = await sbx.process.exec(
          'echo "$CREATE_VAR:$BASE_VAR:$EXTRA_VAR"',
          { env: { EXTRA_VAR: "it's" } },
        )
        expect(env.stdout).toBe("created:base:it's\n")

        await sbx.fs.write('/workspace/nested/note.txt', 'inside render')
        expect(await sbx.fs.read('nested/note.txt')).toBe('inside render')
        expect(await sbx.fs.lstat!('nested/note.txt')).toMatchObject({
          type: 'file',
          size: 13,
        })
        await sbx.process.exec('ln -s nested/note.txt link')
        expect(await sbx.fs.lstat!('link')).toMatchObject({ type: 'symlink' })
        expect(await sbx.fs.lstat!('absent')).toBeUndefined()

        await sbx.fs.write('bin', new Uint8Array([0, 1, 2, 250]))
        expect([...(await sbx.fs.readBytes('bin'))]).toEqual([0, 1, 2, 250])
        expect(await sbx.fs.list('/workspace')).toEqual(
          expect.arrayContaining([
            { name: 'nested', path: '/workspace/nested', type: 'dir' },
            { name: 'bin', path: '/workspace/bin', type: 'file' },
          ]),
        )
        await expect(sbx.fs.read('nested')).rejects.toThrow(/directory/)
        await sbx.fs.rename('bin', 'bin2')
        expect(await sbx.fs.exists('bin')).toBe(false)
        await sbx.fs.remove('/workspace/nested')
        expect(await sbx.fs.exists('/workspace/nested')).toBe(false)

        const git = await sbx.process.exec('git --version')
        expect(git.exitCode).toBe(0)
      })
    }, 120_000)

    it('snapshots, then restores with env reapplied and egress denied', async () => {
      await withSandbox({}, async (sbx) => {
        await sbx.fs.write('/workspace/kept.txt', 'kept')
        const ref = await sbx.snapshot!('live-test')
        const restored = await provider.restoreSnapshot!({
          snapshotId: ref.id,
          env: { AFTER: 'restore' },
          policy: { capabilities: { network: 'deny' } },
        })
        try {
          expect(await restored.fs.read('/workspace/kept.txt')).toBe('kept')
          const r = await restored.process.exec(
            'echo $AFTER; curl -sS -m 5 https://example.com >/dev/null; echo curl=$?',
          )
          expect(r.stdout).toContain('restore')
          expect(r.stdout).not.toContain('curl=0')
        } finally {
          await restored.destroy()
        }
      })
    }, 180_000)

    it('resumes a live sandbox and returns null once it is gone', async () => {
      const sbx = await provider.create({})
      const resumed = await provider.resume({ id: sbx.id })
      expect((await resumed!.process.exec('echo back')).stdout).toBe('back\n')
      await provider.destroy({ id: sbx.id })
      expect(await provider.resume({ id: sbx.id })).toBeNull()
      await provider.destroy({ id: sbx.id })
    }, 120_000)
  },
)
