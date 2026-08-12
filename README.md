# @kevinmarrec/better-auth-bun-redis

## Description

[Better Auth](https://www.better-auth.com) [secondary storage](https://www.better-auth.com/docs/concepts/database#secondary-storage) backed by [Bun](https://bun.sh)'s built-in [Redis client](https://bun.sh/docs/api/redis).

The official [`@better-auth/redis-storage`](https://www.npmjs.com/package/@better-auth/redis-storage) requires [ioredis](https://github.com/redis/ioredis). This package targets `Bun.RedisClient` directly, so a Bun project needs no third-party Redis client at all.

## Status

🚧 Work in progress — the package is published but does not export anything yet.

## Requirements

- Bun, for `Bun.RedisClient`
- Redis >= 6.2, for the native `GETDEL` command
- Better Auth >= 1.7.0-rc.5

## License

[MIT](./LICENSE)
