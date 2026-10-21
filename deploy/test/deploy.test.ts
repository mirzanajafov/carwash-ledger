import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../deploy.sh', import.meta.url))

const DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$DOCKER_LOG"
case "$*" in
  "inspect carwash-postgres") exit 1 ;;
  inspect*) echo healthy ;;
  *"up -d"*) [ "$(git rev-parse HEAD)" != "$FAIL_AT" ] ;;
esac
`

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function commit(repo: string, release: string): string {
  writeFileSync(join(repo, 'release.txt'), release)
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=deploy', '-c', 'user.email=deploy@example.com', 'commit', '-q', '-m', release)
  return git(repo, 'rev-parse', 'HEAD')
}

function server() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-'))
  roots.push(root)
  const origin = join(root, 'origin')
  mkdirSync(join(origin, 'deploy'), { recursive: true })
  git(origin, 'init', '-q', '-b', 'main')
  copyFileSync(SCRIPT, join(origin, 'deploy', 'deploy.sh'))
  const previous = commit(origin, 'one')
  git(root, 'clone', '-q', origin, 'server')
  const target = commit(origin, 'two')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), DOCKER, { mode: 0o755 })
  const dockerLog = join(root, 'docker.log')
  const deploy = (failAt: string) =>
    spawnSync('bash', [join(root, 'server', 'deploy', 'deploy.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, DOCKER_LOG: dockerLog, FAIL_AT: failAt },
    })
  const ups = () =>
    readFileSync(dockerLog, 'utf8')
      .split('\n')
      .filter((line) => line.includes('up -d')).length
  return { previous, target, deploy, ups, head: () => git(join(root, 'server'), 'rev-parse', 'HEAD') }
}

describe('deploy.sh', () => {
  it('goes live on the new commit when the stack starts and turns healthy', () => {
    const { target, deploy, ups, head } = server()
    const run = deploy('none')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Live:')
    expect(head()).toBe(target)
    expect(ups()).toBe(1)
  })

  it('rolls back to the commit before and starts it again when the new stack fails to start', () => {
    const { previous, target, deploy, ups, head } = server()
    const run = deploy(target)
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('Rolled back.')
    expect(head()).toBe(previous)
    expect(ups()).toBe(2)
  })
})
