const test = require('node:test')
const assert = require('node:assert/strict')

const { normalizeIdList, projectCatalogSizeAfterUpload } = require('../lib/upload-mode')

test('normalizeIdList removes duplicates and falsy entries', () => {
  assert.deepEqual(normalizeIdList(['a', 'a', '', null, 'b', 5]), ['a', 'b', '5'])
})

test('projectCatalogSizeAfterUpload merges incoming ids into existing catalog', () => {
  assert.equal(projectCatalogSizeAfterUpload(['p1', 'p2'], ['p2', 'p3', 'p3'], false), 3)
})

test('projectCatalogSizeAfterUpload replaces the catalog when replaceAll is true', () => {
  assert.equal(projectCatalogSizeAfterUpload(['p1', 'p2', 'p3'], ['p2', 'p4'], true), 2)
})
