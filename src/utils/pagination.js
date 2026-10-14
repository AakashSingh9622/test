// Har list endpoint ek hi pagination rule use karta hai taaki koi bhi request poori table na kheench le
// (1000+ rows par bhi response jaldi aaye): page >= 1, pageSize 1..MAX_PAGE_SIZE (default 25).
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function parsePagination(q = {}, defaultPageSize = DEFAULT_PAGE_SIZE) {
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const size = Math.floor(Number(q.pageSize)) || defaultPageSize;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, size));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

module.exports = { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parsePagination };
