import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../deploy.sh', import.meta.url))

const DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$DOCKER_LOG"
failing() { [ "$FAIL_AT" = any ] || [ "$(git rev-parse HEAD)" = "$FAIL_AT" ]; }
case "$*" in
  "inspect carwash-postgres") exit 1 ;;
  inspect*) if [ "$FAIL" = health ] && failing; then echo starting; else echo healthy; fi ;;
  *"--target api "*) ! { [ "$FAIL" = build ] && failing; } ;;
  *"up -d"*) ! { [ "$FAIL" = up ] && failing; } ;;
esac
`

function bash(): string {
  if (process.platform !== 'win32') return 'bash'
  return join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '..', '..', '..', 'bin', 'bash.exe')
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function server() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-'))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), DOCKER, { mode: 0o755 })
  writeFileSync(join(root, 'no-sleep.sh'), 'sleep() { :; }\n')
  writeFileSync(join(root, 'gitconfig'), '[user]\n\tname = deploy\n\temail = deploy@example.com\n')
  const dockerLog = join(root, 'docker.log')
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    DOCKER_LOG: dockerLog,
    BASH_ENV: join(root, 'no-sleep.sh'),
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
  const origin = join(root, 'origin')
  mkdirSync(join(origin, 'deploy'), { recursive: true })
  copyFileSync(SCRIPT, join(origin, 'deploy', 'deploy.sh'))
  const commit = (release: string) => {
    writeFileSync(join(origin, 'release.txt'), release)
    git(origin, 'add', '.')
    git(origin, 'commit', '-q', '-m', release)
    return git(origin, 'rev-parse', 'HEAD')
  }
  git(origin, 'init', '-q', '-b', 'main')
  const previous = commit('one')
  git(root, 'clone', '-q', origin, 'server')
  const target = commit('two')
  const deploy = (fail: 'nothing' | 'build' | 'up' | 'health', at: string) =>
    spawnSync(bash(), [join(root, 'server', 'deploy', 'deploy.sh')], {
      encoding: 'utf8',
      env: { ...env, FAIL: fail, FAIL_AT: at },
    })
  const ups = () =>
    readFileSync(dockerLog, 'utf8')
      .split('\n')
      .filter((line) => line.includes('up -d')).length
  return { previous, target, deploy, ups, head: () => git(join(root, 'server'), 'rev-parse', 'HEAD') }
}

describe('deploy.sh', { timeout: 60_000 }, () => {
  it('goes live on the new commit when the stack starts and turns healthy', () => {
    const { target, deploy, ups, head } = server()
    const run = deploy('nothing', 'any')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Live:')
    expect(head()).toBe(target)
    expect(ups()).toBe(1)
  })

  it.each([
    ['an image fails to build', 'build', 1],
    ['the stack fails to start', 'up', 2],
    ['the stack never turns healthy', 'health', 2],
  ] as const)('rolls back to the commit before and starts it again when %s', (_, fail, starts) => {
    const { previous, target, deploy, ups, head } = server()
    const run = deploy(fail, target)
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('Rolled back.')
    expect(head()).toBe(previous)
    expect(ups()).toBe(starts)
  })

  it('says so when the rollback does not come up either', () => {
    const { previous, deploy, head } = server()
    const run = deploy('up', 'any')
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('Rollback is not healthy either')
    expect(head()).toBe(previous)
  })
})
