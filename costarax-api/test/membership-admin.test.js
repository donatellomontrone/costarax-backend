const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeLinkResult,
  replaceSupplierLink,
  replaceSupplierLinkViaRpc,
} = require('../lib/membership-admin')

test('normalizeLinkResult always returns stable array fields', () => {
  const result = normalizeLinkResult({ user_id: 'u1', supplier_id: 's1' }, 'u1')
  assert.deepEqual(result, {
    user_id: 'u1',
    supplier_id: 's1',
    business_id: null,
    displaced_user_ids: [],
    removed_supplier_ids: [],
    removed_business_ids: [],
  })
})

test('replaceSupplierLinkViaRpc returns null when the SQL function is missing', async () => {
  const db = {
    rpc: async () => ({
      data: null,
      error: { code: '42883', message: 'function public.admin_replace_supplier_link(uuid, uuid) does not exist' },
    }),
  }

  const result = await replaceSupplierLinkViaRpc(db, { userId: 'u1', supplierId: 's1' })
  assert.equal(result, null)
})

test('replaceSupplierLink prefers the SQL RPC path when available', async () => {
  let rpcCalls = 0
  const db = {
    rpc: async () => {
      rpcCalls += 1
      return {
        data: [{
          user_id: 'u1',
          supplier_id: 's1',
          displaced_user_ids: ['u2'],
          removed_supplier_ids: ['s_old'],
        }],
        error: null,
      }
    },
    from() {
      throw new Error('legacy fallback should not run when rpc succeeds')
    },
  }

  const result = await replaceSupplierLink(db, { userId: 'u1', supplierId: 's1' })
  assert.equal(rpcCalls, 1)
  assert.deepEqual(result, {
    user_id: 'u1',
    supplier_id: 's1',
    business_id: null,
    displaced_user_ids: ['u2'],
    removed_supplier_ids: ['s_old'],
    removed_business_ids: [],
  })
})
