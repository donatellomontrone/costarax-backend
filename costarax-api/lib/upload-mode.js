function normalizeIdList(input) {
  return [...new Set((Array.isArray(input) ? input : [input]).filter(Boolean).map(String))]
}

function projectCatalogSizeAfterUpload(existingIds, incomingIds, replaceAll = false) {
  const incoming = normalizeIdList(incomingIds)
  if (replaceAll) return incoming.length
  const merged = new Set(normalizeIdList(existingIds))
  incoming.forEach(id => merged.add(id))
  return merged.size
}

module.exports = {
  normalizeIdList,
  projectCatalogSizeAfterUpload,
}
