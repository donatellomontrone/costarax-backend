const test = require('node:test')
const assert = require('node:assert/strict')

const {
  computePrunableProductIds,
  pruneUnreferencedProducts,
} = require('../lib/orphan-products')

test('computePrunableProductIds removes anything still referenced', () => {
  const result = computePrunableProductIds(
    ['p1', 'p2', 'p3', 'p3'],
    ['p2', 'p4']
  )

  assert.deepEqual(result, ['p1', 'p3'])
})

test('pruneUnreferencedProducts deletes only products with no live refs', async () => {
  const deletedBatches = []
  const deletedSingles = []

  const db = {
    from(table) {
      return {
        select() {
          return this
        },
        eq(column, value) {
          if (column !== 'id') throw new Error(`unexpected eq column ${column}`)
          if (table === 'products') {
            deletedSingles.push(value)
            return Promise.resolve({ error: null })
          }
          throw new Error(`unexpected eq table ${table}`)
        },
        in(column, batch) {
          if (column !== 'product_id' && column !== 'id') {
            throw new Error(`unexpected column ${column}`)
          }

          if (table === 'supplier_prices') {
            return Promise.resolve({ data: batch.includes('p2') ? [{ product_id: 'p2' }] : [], error: null })
          }
          if (table === 'buyer_watchlist') {
            return Promise.resolve({ data: batch.includes('p3') ? [{ product_id: 'p3' }] : [], error: null })
          }
          if (table === 'quote_items') {
            return Promise.resolve({ data: [], error: null })
          }
          if (table === 'products') {
            deletedBatches.push([...batch])
            return Promise.resolve({ error: null })
          }

          throw new Error(`unexpected table ${table}`)
        },
        delete() {
          return this
        },
      }
    },
  }

  const result = await pruneUnreferencedProducts(db, ['p1', 'p2', 'p3'])

  assert.deepEqual(result, {
    checked: 3,
    deleted: 1,
    pruned_ids: ['p1'],
  })
  assert.deepEqual(deletedBatches, [['p1']])
  assert.deepEqual(deletedSingles, [])
})

test('pruneUnreferencedProducts skips optional reference tables without permission', async () => {
  const db = {
    from(table) {
      return {
        select() {
          return this
        },
        eq(column, value) {
          if (table === 'products' && column === 'id') {
            return Promise.resolve({ error: null })
          }
          throw new Error(`unexpected eq ${table}.${column}=${value}`)
        },
        in(column, batch) {
          if (table === 'supplier_prices' && column === 'product_id') {
            return Promise.resolve({ data: [], error: null })
          }
          if ((table === 'buyer_watchlist' || table === 'quote_items') && column === 'product_id') {
            return Promise.resolve({ data: null, error: { message: `permission denied for table ${table}` } })
          }
          if (table === 'products' && column === 'id') {
            return Promise.resolve({ error: null })
          }
          throw new Error(`unexpected call ${table}.${column} on ${batch}`)
        },
        delete() {
          return this
        },
      }
    },
  }

  const result = await pruneUnreferencedProducts(db, ['p-safe'])

  assert.deepEqual(result, {
    checked: 1,
    deleted: 1,
    pruned_ids: ['p-safe'],
  })
})

test('pruneUnreferencedProducts falls back to per-id deletes on foreign key conflicts', async () => {
  const db = {
    from(table) {
      return {
        select() {
          return this
        },
        eq(column, value) {
          if (table === 'products' && column === 'id') {
            if (value === 'p2') {
              return Promise.resolve({ error: { message: 'update or delete on table \"products\" violates foreign key constraint' } })
            }
            return Promise.resolve({ error: null })
          }
          throw new Error(`unexpected eq ${table}.${column}=${value}`)
        },
        in(column, batch) {
          if ((table === 'supplier_prices' || table === 'buyer_watchlist' || table === 'quote_items') && column === 'product_id') {
            return Promise.resolve({ data: [], error: null })
          }
          if (table === 'products' && column === 'id') {
            return Promise.resolve({ error: { message: 'update or delete on table \"products\" violates foreign key constraint' } })
          }
          throw new Error(`unexpected call ${table}.${column} on ${batch}`)
        },
        delete() {
          return this
        },
      }
    },
  }

  const result = await pruneUnreferencedProducts(db, ['p1', 'p2'])

  assert.deepEqual(result, {
    checked: 2,
    deleted: 1,
    pruned_ids: ['p1'],
  })
})
