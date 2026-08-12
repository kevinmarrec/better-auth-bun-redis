# @kevinmarrec/better-auth-bun-redis

## Description

[Better Auth](https://www.better-auth.com) [secondary storage](https://www.better-auth.com/docs/concepts/database#secondary-storage) backed by [Bun](https://bun.sh)'s built-in [Redis client](https://bun.sh/docs/api/redis).

The official [`@better-auth/redis-storage`](https://www.npmjs.com/package/@better-auth/redis-storage) requires [ioredis](https://github.com/redis/ioredis), which exposes `call()` and `eval()` that `Bun.RedisClient` does not have. This package targets `Bun.RedisClient` directly, so a Bun project needs no third-party Redis client — and no runtime dependency at all.

## Requirements

- **Bun**, for `Bun.RedisClient`
- **Redis >= 6.2** or **Valkey**, for the native `GETDEL` command
- **Better Auth >= 1.6.0**, including the 1.7 release candidates

Tested in CI against Redis 8 and Valkey 9.

## Installation

```sh
bun add @kevinmarrec/better-auth-bun-redis
```

## Usage

```ts
import { bunRedisStorage } from '@kevinmarrec/better-auth-bun-redis'
import { betterAuth } from 'better-auth'

export const auth = betterAuth({
  secondaryStorage: bunRedisStorage({ client: Bun.redis }),
})
```

`Bun.redis` is the lazily-connected default client, reading `REDIS_URL` from the environment. Pass your own instance to control the connection:

```ts
const client = new Bun.RedisClient('redis://localhost:6379')

export const auth = betterAuth({
  secondaryStorage: bunRedisStorage({ client, keyPrefix: 'my-app:' }),
})
```

The client's lifecycle stays yours: this package never calls `connect()` or `close()`.

### Options

| Option      | Default          | Purpose                               |
| ----------- | ---------------- | ------------------------------------- |
| `client`    | –                | The `Bun.RedisClient` instance to use |
| `keyPrefix` | `'better-auth:'` | Prefix applied to every key           |

### Beyond the interface

Alongside Better Auth's `SecondaryStorage` methods, the returned object exposes two helpers, matching `@better-auth/redis-storage`:

- `listKeys()` — the stored keys, prefix stripped
- `clear()` — delete every key under the prefix

Both enumerate with `SCAN` rather than the blocking `KEYS`. `clear()` is **not atomic**: it deletes page by page, so a rejection means an unknown subset may already be gone. It is idempotent, so retry until it resolves.

## Contributing

Integration tests need a server:

```sh
docker compose up -d
```

Then run the suite against Redis (default) or Valkey:

```sh
bun test
```

```sh
REDIS_URL=redis://127.0.0.1:6380 bun test
```

## License

[MIT](./LICENSE)
