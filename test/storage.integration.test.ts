import { afterAll, beforeAll, expect, it } from 'bun:test'

import { bunRedisStorage } from '../src'

/**
 * These tests run against a real Redis (`docker compose up -d`, or the service
 * container in CI). They cover what the mocked suite cannot prove: that the Lua
 * script Redis actually executes has the intended semantics, that `GETDEL`
 * exists on the server, and that TTLs are really applied. A mock would happily
 * accept commands Redis rejects — which is precisely the incompatibility this
 * package exists to avoid.
 */
const client = new Bun.RedisClient(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379')

// Each test gets its own prefix so a failing run cannot leak into the next one,
// and so `clear()` can be checked against neighbouring keys it must not touch.
let counter = 0
const nextPrefix = () => `test:${process.pid}:${counter++}:`

function createStorage(keyPrefix = nextPrefix()) {
  return { keyPrefix, storage: bunRedisStorage({ client, keyPrefix }) }
}

beforeAll(async () => {
  await client.connect()
})

afterAll(() => {
  client.close()
})

it('round-trips a value', async () => {
  const { storage } = createStorage()

  await storage.set('session', 'value')

  expect(await storage.get('session')).toBe('value')
})

it('returns null for a missing key', async () => {
  const { storage } = createStorage()

  expect(await storage.get('absent')).toBeNull()
})

it('deletes a value', async () => {
  const { storage } = createStorage()
  await storage.set('session', 'value')

  await storage.delete('session')

  expect(await storage.get('session')).toBeNull()
})

it('applies the TTL passed to set', async () => {
  const { keyPrefix, storage } = createStorage()

  await storage.set('session', 'value', 60)

  expect(await client.ttl(`${keyPrefix}session`)).toBeGreaterThan(0)
})

it('persists a value stored without a TTL', async () => {
  const { keyPrefix, storage } = createStorage()

  await storage.set('session', 'value')

  // -1 is Redis' answer for "key exists, no expiry".
  expect(await client.ttl(`${keyPrefix}session`)).toBe(-1)
})

it('reads and removes a key in one step', async () => {
  const { storage } = createStorage()
  await storage.set('session', 'value')

  expect(await storage.getAndDelete('session')).toBe('value')
  expect(await storage.get('session')).toBeNull()
})

it('returns null when getting and deleting a missing key', async () => {
  const { storage } = createStorage()

  expect(await storage.getAndDelete('absent')).toBeNull()
})

it('increments a counter from one upwards', async () => {
  const { storage } = createStorage()

  expect(await storage.increment('hits', 60)).toBe(1)
  expect(await storage.increment('hits', 60)).toBe(2)
  expect(await storage.increment('hits', 60)).toBe(3)
})

it('fixes the TTL window at creation instead of extending it', async () => {
  const { keyPrefix, storage } = createStorage()

  await storage.increment('hits', 100)
  // Shrink the window behind the storage's back: a correct implementation
  // leaves it alone, a naive INCR+EXPIRE would reset it to 100.
  await client.expire(`${keyPrefix}hits`, 10)
  await storage.increment('hits', 100)

  expect(await client.ttl(`${keyPrefix}hits`)).toBeLessThanOrEqual(10)
})

it('lists the stored keys with the prefix stripped', async () => {
  const { storage } = createStorage()
  await storage.set('a', '1')
  await storage.set('b', '2')

  expect((await storage.listKeys()).toSorted()).toEqual(['a', 'b'])
})

it('empties the store', async () => {
  const { storage } = createStorage()
  await storage.set('a', '1')
  await storage.set('b', '2')

  await storage.clear()

  expect(await storage.listKeys()).toEqual([])
})

it('clears an already-empty store without erroring', async () => {
  const { storage } = createStorage()

  expect(await storage.clear()).toBeUndefined()
})

it('leaves keys outside the prefix untouched when clearing', async () => {
  const { keyPrefix, storage } = createStorage()
  await storage.set('mine', 'value')
  const neighbour = `${keyPrefix}x:theirs`
  await client.set(neighbour, 'value')

  await createStorage(`${keyPrefix}x:`).storage.clear()

  expect(await storage.get('mine')).toBe('value')
  expect(await client.get(neighbour)).toBeNull()
})

it('does not let glob metacharacters in the prefix widen the clear', async () => {
  const base = nextPrefix()
  const { storage } = createStorage(`${base}*:`)
  await storage.set('mine', 'value')
  // Matches `<base>*:*` only if the `*` in the prefix is treated as a glob.
  const bystander = `${base}other:key`
  await client.set(bystander, 'value')

  await storage.clear()

  expect(await client.get(bystander)).toBe('value')
})
