import type { RedisClient } from 'bun'
import { expect, it, mock } from 'bun:test'

import { bunRedisStorage } from '../src'

/**
 * A stand-in for `Bun.RedisClient` recording the commands it receives.
 *
 * These tests assert on the commands the storage *emits*, which a real server
 * cannot show: that the prefix is applied, that `SETEX` is preferred over
 * `SET` only when a TTL is given, that `GETDEL` is used rather than a Lua
 * fallback. The behaviour those commands produce is covered against a real
 * Redis in `storage.integration.test.ts`.
 */
function createClient(overrides: Partial<Record<keyof RedisClient, unknown>> = {}) {
  return {
    get: mock(async () => null),
    set: mock(async () => 'OK'),
    setex: mock(async () => 'OK'),
    del: mock(async () => 1),
    getdel: mock(async () => null),
    send: mock(async () => null),
    scan: mock(async () => ['0', []]),
    ...overrides,
  } as unknown as RedisClient
}

it('prefixes keys with "better-auth:" by default', async () => {
  const client = createClient()

  await bunRedisStorage({ client }).get('session-1')

  expect(client.get).toHaveBeenCalledWith('better-auth:session-1')
})

it('honours a custom key prefix', async () => {
  const client = createClient()

  await bunRedisStorage({ client, keyPrefix: 'app/' }).get('session-1')

  expect(client.get).toHaveBeenCalledWith('app/session-1')
})

it('stores without a TTL using SET', async () => {
  const client = createClient()

  await bunRedisStorage({ client }).set('session-1', 'value')

  expect(client.set).toHaveBeenCalledWith('better-auth:session-1', 'value')
  expect(client.setex).not.toHaveBeenCalled()
})

it('stores with a TTL using SETEX', async () => {
  const client = createClient()

  await bunRedisStorage({ client }).set('session-1', 'value', 60)

  expect(client.setex).toHaveBeenCalledWith('better-auth:session-1', 60, 'value')
  expect(client.set).not.toHaveBeenCalled()
})

it('treats a non-positive TTL as no TTL', async () => {
  const client = createClient()

  await bunRedisStorage({ client }).set('session-1', 'value', 0)

  expect(client.set).toHaveBeenCalledWith('better-auth:session-1', 'value')
  expect(client.setex).not.toHaveBeenCalled()
})

it('deletes the prefixed key', async () => {
  const client = createClient()

  await bunRedisStorage({ client }).delete('session-1')

  expect(client.del).toHaveBeenCalledWith('better-auth:session-1')
})

it('reads and deletes atomically with the native GETDEL', async () => {
  const client = createClient({ getdel: mock(async () => 'value') })

  const result = await bunRedisStorage({ client }).getAndDelete('session-1')

  expect(result).toBe('value')
  expect(client.getdel).toHaveBeenCalledWith('better-auth:session-1')
  expect(client.send).not.toHaveBeenCalled()
})

it('increments through a single EVAL carrying the key and the TTL', async () => {
  const client = createClient({ send: mock(async () => 1) })

  await bunRedisStorage({ client }).increment('rate-limit', 60)

  const [command, args] = (client.send as ReturnType<typeof mock>).mock.calls[0]!
  expect(command).toBe('EVAL')
  expect(args.slice(1)).toEqual(['1', 'better-auth:rate-limit', '60'])
  expect(args[0]).toContain('INCR')
  expect(args[0]).toContain('EXPIRE')
})

it('returns the incremented counter as a number', async () => {
  const client = createClient({ send: mock(async () => '3') })

  const result = await bunRedisStorage({ client }).increment('rate-limit', 60)

  expect(result).toBe(3)
})

it('lists keys via SCAN, stripping the prefix and deduping across pages', async () => {
  const scan = mock(async (cursor: string) => cursor === '0'
    ? ['7', ['better-auth:a', 'better-auth:b']]
    : ['0', ['better-auth:b', 'better-auth:c']])
  const client = createClient({ scan })

  const keys = await bunRedisStorage({ client }).listKeys()

  expect(keys.toSorted()).toEqual(['a', 'b', 'c'])
})

it('scans with MATCH and COUNT rather than the blocking KEYS', async () => {
  const client = createClient()

  await bunRedisStorage({ client }).listKeys()

  expect(client.scan).toHaveBeenCalledWith('0', 'MATCH', 'better-auth:*', 'COUNT', 100)
})

it('escapes glob metacharacters so SCAN matches the prefix literally', async () => {
  const client = createClient()

  await bunRedisStorage({ client, keyPrefix: 'ba*:' }).clear()

  expect(client.scan).toHaveBeenCalledWith('0', 'MATCH', 'ba\\*:*', 'COUNT', 100)
})

it('strips the raw prefix even when it contains glob metacharacters', async () => {
  const client = createClient({ scan: mock(async () => ['0', ['ba*:session']]) })

  const keys = await bunRedisStorage({ client, keyPrefix: 'ba*:' }).listKeys()

  expect(keys).toEqual(['session'])
})

it('deletes every page of keys when clearing', async () => {
  const scan = mock(async (cursor: string) => cursor === '0'
    ? ['7', ['better-auth:a']]
    : ['0', ['better-auth:b', 'better-auth:c']])
  const client = createClient({ scan })

  await bunRedisStorage({ client }).clear()

  expect(client.del).toHaveBeenCalledTimes(2)
  expect(client.del).toHaveBeenNthCalledWith(1, 'better-auth:a')
  expect(client.del).toHaveBeenNthCalledWith(2, 'better-auth:b', 'better-auth:c')
})

it('issues no DEL when clearing an empty store', async () => {
  const client = createClient()

  await bunRedisStorage({ client }).clear()

  expect(client.del).not.toHaveBeenCalled()
})

it('propagates a mid-iteration failure, leaving earlier pages deleted', async () => {
  const scan = mock(async (cursor: string) => {
    if (cursor === '0')
      return ['7', ['better-auth:a']]
    throw new Error('connection lost')
  })
  const client = createClient({ scan })

  await expect(bunRedisStorage({ client }).clear()).rejects.toThrow('connection lost')
  expect(client.del).toHaveBeenCalledWith('better-auth:a')
})
