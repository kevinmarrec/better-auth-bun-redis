import { expect, it } from 'vitest'

it('exposes no public API yet', async () => {
  expect(Object.keys(await import('../src'))).toEqual([])
})
