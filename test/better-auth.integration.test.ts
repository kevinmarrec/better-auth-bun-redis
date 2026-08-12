import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { afterAll, beforeAll, expect, it } from 'bun:test'

import { bunRedisStorage } from '../src'

/**
 * Proves the storage actually works as a Better Auth secondary storage, rather
 * than merely satisfying its type. `satisfies SecondaryStorage` is a
 * compile-time claim; only a real `betterAuth()` instance exercises the calls
 * Better Auth makes, in the order it makes them.
 */
const client = new Bun.RedisClient(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379')

let counter = 0

function createAuth() {
  const keyPrefix = `auth:${process.pid}:${counter++}:`
  const storage = bunRedisStorage({ client, keyPrefix })

  return {
    storage,
    auth: betterAuth({
      baseURL: 'http://localhost:3000',
      secret: 'a-test-secret-that-is-long-enough-to-be-accepted',
      // The memory adapter does not create tables on demand.
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      secondaryStorage: storage,
      emailAndPassword: { enabled: true },
    }),
  }
}

beforeAll(async () => {
  await client.connect()
})

afterAll(() => {
  client.close()
})

it('round-trips a real session through the storage', async () => {
  const { auth, storage } = createAuth()

  const { headers } = await auth.api.signUpEmail({
    body: {
      email: 'someone@example.com',
      password: 'a-sufficiently-long-password',
      name: 'Someone',
    },
    returnHeaders: true,
  })

  // Better Auth wrote the session somewhere under our prefix.
  expect(await storage.listKeys()).not.toEqual([])

  const cookie = headers.get('set-cookie')
  expect(cookie).toBeTruthy()

  // And reads it back through the same storage.
  const session = await auth.api.getSession({
    headers: new Headers({ cookie: cookie! }),
  })

  expect(session?.user.email).toBe('someone@example.com')
})
