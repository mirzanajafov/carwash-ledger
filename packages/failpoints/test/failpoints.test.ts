import { afterEach, describe, expect, it } from 'vitest'
import { armFailpoints, disarmFailpoints, failpoint, parseFailpoints, type FailpointName } from '../src/index.ts'

afterEach(() => disarmFailpoints())

describe('failpoints', () => {
  it('do nothing until armed', () => {
    const hits: FailpointName[] = []
    armFailpoints(new Map(), (name) => hits.push(name))
    failpoint('post.before_commit')
    expect(hits).toEqual([])
  })

  it('fire an armed point with its probability and leave the others alone', () => {
    const hits: FailpointName[] = []
    const draws = [0.05, 0.2]
    armFailpoints(new Map([['post.before_commit', 0.1]]), (name) => hits.push(name), () => draws.shift()!)
    failpoint('post.after_commit')
    failpoint('post.before_commit')
    failpoint('post.before_commit')
    expect(hits).toEqual(['post.before_commit'])
  })

  it('stop firing once disarmed', () => {
    const hits: FailpointName[] = []
    armFailpoints(new Map([['snapshot.before_commit', 1]]), (name) => hits.push(name))
    disarmFailpoints()
    failpoint('snapshot.before_commit')
    expect(hits).toEqual([])
  })

  it('parse a spec and reject unknown names and bad probabilities', () => {
    expect(parseFailpoints('post.after_lock=0.01, post.after_commit=0.5')).toEqual(
      new Map([
        ['post.after_lock', 0.01],
        ['post.after_commit', 0.5],
      ]),
    )
    expect(parseFailpoints('')).toEqual(new Map())
    expect(() => parseFailpoints('post.nowhere=0.1')).toThrow('unknown failpoint')
    expect(() => parseFailpoints('post.after_lock=2')).toThrow('probability')
  })
})
