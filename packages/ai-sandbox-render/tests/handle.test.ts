/**
 * Handle tests against a local `bash` standing in for Render's exec (see
 * `fakes.ts`). The case that matters most: `kill()` stops a backgrounded
 * child, not just this host's view of the stream.
 */
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UnsupportedCapabilityError } from '@tanstack/ai-sandbox'
import { RenderHandle, envFileContent } from '../src/handle'
import { fakeClient } from './fakes'

let dir: string
let fake: ReturnType<typeof fakeClient>
let handle: RenderHandle

beforeEach(async () => {
  // Resolved, because macOS tmpdir is a symlink and `pwd` prints the real path.
  dir = await realpath(await mkdtemp(join(tmpdir(), 'tsai-render-')))
  fake = fakeClient()
  handle = new RenderHandle({
    client: fake.sdk,
    id: 'sbx-test',
    workdir: dir,
    snapshotKind: 'filesystem',
  })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const lines = async (path: string) =>
  (await readFile(path, 'utf8').catch(() => '')).split('\n').length

describe('process', () => {
  it('runs in the workdir with the env overlay and returns the exit code', async () => {
    await handle.env.set({ A: "it's" })
    const r = await handle.process.exec(
      'pwd; echo "$A $B"; echo err >&2; exit 3',
      {
        env: { B: 'b' },
      },
    )
    expect(r).toEqual({
      stdout: `${dir}\nit's b\n`,
      stderr: 'err\n',
      exitCode: 3,
    })
  })

  it('maps /workspace and relative cwd onto the workdir', async () => {
    await handle.fs.mkdir('sub')
    const r = await handle.process.exec('pwd', { cwd: '/workspace/sub' })
    expect(r.stdout.trim()).toBe(join(dir, 'sub'))
  })

  it('never puts env values in the command string (Render stores it)', async () => {
    await handle.env.set({ SECRET: 'sk-overlay' })
    const r = await handle.process.exec('echo "$SECRET $TOKEN"', {
      env: { TOKEN: 'tok-per-call', SECRET: 'sk-override' },
    })
    expect(r.stdout).toBe('sk-override tok-per-call\n')
    const sent = fake.client.exec.mock.calls.map(
      (call: Array<unknown>) => call[1],
    )
    expect(sent.join('\n')).not.toMatch(/sk-overlay|sk-override|tok-per-call/)
  })

  it('rejects env names that are not shell identifiers', () => {
    expect(() => envFileContent({ 'A;rm': 'x' })).toThrow(
      /invalid env var name/,
    )
  })

  it('kill() stops a backgrounded child', async () => {
    const ticks = join(dir, 'ticks')
    const proc = await handle.process.spawn(
      `(while true; do echo t >> ${ticks}; sleep 0.05; done) & wait`,
    )
    await sleep(300)
    await proc.kill()
    expect(await proc.wait()).not.toBe(0)
    const after = await lines(ticks)
    await sleep(300)
    expect(await lines(ticks)).toBe(after)
  })

  it('an aborted exec kills the group and resolves with its exit code', async () => {
    const ticks = join(dir, 'ticks')
    const controller = new AbortController()
    const run = handle.process.exec(
      `(while true; do echo t >> ${ticks}; sleep 0.05; done) & wait`,
      { signal: controller.signal },
    )
    await sleep(300)
    controller.abort()
    expect((await run).exitCode).not.toBe(0)
    const after = await lines(ticks)
    await sleep(300)
    expect(await lines(ticks)).toBe(after)
  })

  it('a kill during the env upload never starts the command', async () => {
    const marker = join(dir, 'started')
    const upload = fake.client.upload.getMockImplementation()!
    fake.client.upload.mockImplementationOnce(async (...args: Array<any>) => {
      // Longer than killCommand's 2 s wait for the process-group file.
      await sleep(2500)
      return upload(...args)
    })
    const proc = await handle.process.spawn(`touch ${marker}`, {
      env: { TOKEN: 't' },
    })
    await proc.kill()
    expect(await proc.wait()).toBe(143)
    await expect(stat(marker)).rejects.toThrow()
    const sent: Array<string> = fake.client.exec.mock.calls.map(
      (call: Array<unknown>) => String(call[1]),
    )
    expect(sent.some((c) => c.includes(marker))).toBe(false)
  }, 10_000)

  it('streams spawn output and has no stdin', async () => {
    const proc = await handle.process.spawn('echo out; echo err >&2')
    const out: Array<string> = []
    for await (const chunk of proc.stdout) out.push(chunk)
    expect(out.join('')).toBe('out\n')
    expect(await proc.wait()).toBe(0)
    await expect(proc.stdin.write('x')).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    )
  })
})

describe('fs', () => {
  it('lists, renames, checks and removes through the shell', async () => {
    await handle.fs.mkdir('/workspace/a/b')
    await handle.process.exec('touch a/f')
    expect(await handle.fs.list('a')).toEqual(
      expect.arrayContaining([
        { name: 'b', path: 'a/b', type: 'dir' },
        { name: 'f', path: 'a/f', type: 'file' },
      ]),
    )
    await handle.fs.rename('a/f', 'a/g')
    expect(await handle.fs.exists('a/g')).toBe(true)
    expect(await handle.fs.exists('a/f')).toBe(false)
    // ponytail: lstat's GNU `stat` probe is covered by the live suite, not here (BSD stat differs).
    await handle.fs.remove('a')
    await expect(stat(join(dir, 'a'))).rejects.toThrow()
  })

  it('reads and writes through upload and download at absolute paths', async () => {
    await handle.fs.write('x.txt', 'hello')
    expect(fake.client.upload.mock.calls[0]?.[1]).toBe(join(dir, 'x.txt'))
    expect(await handle.fs.read('x.txt')).toBe('hello')
    await handle.fs.write(join(dir, 'b.bin'), new Uint8Array([0, 255]))
    expect([...(await handle.fs.readBytes(join(dir, 'b.bin')))]).toEqual([
      0, 255,
    ])
  })

  it('refuses to read a directory (Render returns a tar archive)', async () => {
    fake.files.set('/tmp/dir/', new Uint8Array([1]))
    await expect(handle.fs.read('/tmp/dir/')).rejects.toThrow(/is a directory/)
  })

  it('refuses to remove the root', async () => {
    await expect(handle.fs.remove('/')).rejects.toThrow(/refusing/)
  })
})

describe('capabilities', () => {
  it('rejects ports', async () => {
    await expect(handle.ports.connect(3000)).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    )
  })

  it('snapshots with the configured kind and a tsai- name', async () => {
    expect(await handle.snapshot('after-setup')).toEqual({
      id: 'snp-1',
      label: 'after-setup',
    })
    expect(fake.client.snapshots.create).toHaveBeenCalledWith({
      sandboxId: 'sbx-test',
      kind: 'filesystem',
      name: 'tsai-after-setup',
      wait: true,
    })
  })

  it('keeps the snapshot name within 64 characters and the full label in the ref', async () => {
    const label = 'x'.repeat(100)
    expect((await handle.snapshot(label)).label).toBe(label)
    const { name } = fake.client.snapshots.create.mock.calls[0][0]
    expect(name).toBe(`tsai-${'x'.repeat(59)}`)
  })
})
