import type { SecondaryStorage } from '@better-auth/core/db'

export interface BunRedisStorageConfig {
  /**
   * The Redis client to issue commands through.
   *
   * Pass `Bun.redis` to use the default client, which connects lazily using
   * `REDIS_URL`. Its lifecycle stays yours: the storage never calls
   * `connect()` or `close()`.
   */
  client: Bun.RedisClient
  /**
   * Prefix prepended to every key, isolating this store from anything else
   * sharing the server.
   *
   * @default 'better-auth:'
   */
  keyPrefix?: string | undefined
}

// INCR then set EXPIRE only when the counter was just created (value == 1), so
// the TTL window is fixed from first creation and never extended.
const incrementScript = `
local value = redis.call("INCR", KEYS[1])
if value == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return value
`

// How many keys Redis samples per SCAN round-trip. A hint, not a limit.
const scanCount = 100

/**
 * Creates a Better Auth secondary storage backed by Bun's built-in Redis client.
 *
 * Requires Redis >= 6.2 for the `GETDEL` command.
 *
 * @example
 * ```ts
 * import { bunRedisStorage } from '@kevinmarrec/better-auth-bun-redis'
 *
 * const auth = betterAuth({
 *   secondaryStorage: bunRedisStorage({ client: Bun.redis }),
 * })
 * ```
 *
 * @returns A `SecondaryStorage` implementation, plus `listKeys()` and `clear()`
 */
export function bunRedisStorage({ client, keyPrefix = 'better-auth:' }: BunRedisStorageConfig) {
  const prefixKey = (key: string) => `${keyPrefix}${key}`

  // The SCAN MATCH argument is a glob pattern, so any glob metacharacter in the
  // prefix (`* ? [ ] \`) would match unrelated keys and let `clear()` delete
  // data outside this store. Escape them so the prefix matches literally.
  // Stored keys still use the raw prefix, so `keyPrefix.length` remains the
  // correct amount to strip in `listKeys()`.
  const escapedPrefix = keyPrefix.replace(/[\\*?[\]]/g, '\\$&')

  // Iterate every prefixed key with SCAN instead of KEYS: KEYS walks the whole
  // keyspace in a single blocking call, stalling the server on large datasets.
  // SCAN may return the same key on more than one page, so consumers needing
  // uniqueness must dedupe. Each yielded batch is non-empty.
  async function* scanBatches() {
    let cursor = '0'

    do {
      const [nextCursor, batch] = await client.scan(cursor, 'MATCH', `${escapedPrefix}*`, 'COUNT', scanCount)
      cursor = nextCursor

      if (batch.length > 0)
        yield batch
    } while (cursor !== '0')
  }

  return {
    /**
     * Reads the value stored at `key`, or `null` when it is absent or expired.
     */
    async get(key: string) {
      return client.get(prefixKey(key))
    },

    /**
     * Reads the value at `key` and removes it in the same operation, returning
     * `null` when it is absent.
     *
     * Backed by `GETDEL`, so concurrent callers cannot both receive the value —
     * which is what makes it safe for single-use tokens.
     */
    async getAndDelete(key: string) {
      return client.getdel(prefixKey(key))
    },

    /**
     * Increments the counter at `key` by one and returns the new value.
     *
     * When the key is absent it is created with a value of `1` and the given
     * `ttl`. The TTL is applied **only on creation**: later increments never
     * extend it, so the counter expires a fixed window after it first appeared.
     * Both steps run in a single Lua script, so the counter stays correct under
     * concurrent callers.
     *
     * @param key - Key holding the counter
     * @param ttl - Lifetime of the counter, in seconds, applied at creation
     */
    async increment(key: string, ttl: number) {
      // `send` is untyped, so the reply is coerced rather than trusted.
      return Number(await client.send('EVAL', [incrementScript, '1', prefixKey(key), String(ttl)]))
    },

    /**
     * Stores `value` at `key`, replacing any existing value.
     *
     * @param key - Key to store the value at
     * @param value - Value to store
     * @param ttl - Lifetime in seconds; omitted or non-positive stores the
     * value without an expiry
     */
    async set(key: string, value: string, ttl?: number | undefined) {
      const prefixedKey = prefixKey(key)

      if (ttl !== undefined && ttl > 0) {
        await client.setex(prefixedKey, ttl, value)
      }
      else {
        await client.set(prefixedKey, value)
      }
    },

    /**
     * Removes `key`. Deleting a key that does not exist is a no-op.
     */
    async delete(key: string) {
      await client.del(prefixKey(key))
    },

    /**
     * Lists the keys under the configured prefix, with the prefix stripped.
     *
     * Keys are enumerated with `SCAN`, a best-effort walk: it may report the
     * same key on more than one page, so the result is de-duplicated, and keys
     * added or removed while the scan runs may or may not appear. Order is not
     * guaranteed.
     */
    async listKeys(): Promise<string[]> {
      const keys = new Set<string>()

      for await (const batch of scanBatches()) {
        for (const key of batch)
          keys.add(key.slice(keyPrefix.length))
      }

      return [...keys]
    },

    /**
     * Deletes keys under the configured prefix.
     *
     * **Not atomic.** Keys are enumerated with `SCAN` and deleted page by page,
     * so if Redis errors or the connection drops mid-iteration the returned
     * promise rejects *after* earlier pages have already been deleted, leaving
     * the store partially cleared. A rejection therefore means "an unknown
     * subset of keys may already be gone", not "nothing changed".
     *
     * **Best-effort while the keyspace changes.** A resolved call is not proof
     * the store is empty when other clients are writing concurrently.
     *
     * `clear()` is idempotent, so callers needing a fully empty store should
     * retry until it resolves. An already-empty store is a no-op.
     */
    async clear(): Promise<void> {
      // `scanBatches` only yields non-empty pages, so DEL always receives at
      // least one key and an empty store never issues an invalid zero-arg DEL.
      for await (const batch of scanBatches())
        await client.del(...batch)
    },
  } satisfies SecondaryStorage & {
    listKeys: () => Promise<string[]>
    clear: () => Promise<void>
  }
}
