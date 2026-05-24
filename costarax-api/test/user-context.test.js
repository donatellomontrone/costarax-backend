const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeUiRole,
  chooseSupplierMembership,
  chooseBusinessMembership,
  scoreSupplierMembership,
  scoreBusinessMembership,
} = require('../lib/user-context')

test('normalizeUiRole maps buyer and super_admin to UI roles', () => {
  assert.equal(normalizeUiRole('buyer'), 'business')
  assert.equal(normalizeUiRole('super_admin'), 'admin')
  assert.equal(normalizeUiRole('supplier'), 'supplier')
  assert.equal(normalizeUiRole(null), null)
})

test('scoreSupplierMembership prefers approved and active suppliers', () => {
  assert.equal(scoreSupplierMembership({ suppliers: { status: 'approved', active: true } }), 150)
  assert.equal(scoreSupplierMembership({ suppliers: { status: 'approved', active: false } }), 100)
  assert.equal(scoreSupplierMembership({ suppliers: { status: 'pending', active: true } }), 60)
  assert.equal(scoreSupplierMembership({ suppliers: { status: 'rejected', active: false } }), -100)
})

test('chooseSupplierMembership picks the strongest supplier membership', () => {
  const rows = [
    { supplier_id: 'sup_pending', suppliers: { status: 'pending', active: true, name: 'Pending supplier' } },
    { supplier_id: 'sup_approved', suppliers: { status: 'approved', active: false, name: 'Approved supplier' } },
    { supplier_id: 'sup_best', suppliers: { status: 'approved', active: true, name: 'Best supplier' } },
  ]

  const chosen = chooseSupplierMembership(rows)
  assert.equal(chosen.supplier_id, 'sup_best')
  assert.equal(chosen.suppliers.name, 'Best supplier')
})

test('scoreBusinessMembership prefers approved businesses', () => {
  assert.equal(scoreBusinessMembership({ businesses: { status: 'approved' } }), 100)
  assert.equal(scoreBusinessMembership({ businesses: { status: 'pending' } }), 10)
  assert.equal(scoreBusinessMembership({ businesses: { status: 'rejected' } }), -100)
})

test('chooseBusinessMembership picks the strongest business membership', () => {
  const rows = [
    { business_id: 'biz_pending', businesses: { status: 'pending', name: 'Pending business' } },
    { business_id: 'biz_best', businesses: { status: 'approved', name: 'Approved business' } },
  ]

  const chosen = chooseBusinessMembership(rows)
  assert.equal(chosen.business_id, 'biz_best')
  assert.equal(chosen.businesses.name, 'Approved business')
})
