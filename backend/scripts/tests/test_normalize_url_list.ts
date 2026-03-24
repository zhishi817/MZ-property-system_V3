import { normalizeUrlList } from '../../src/lib/normalizeUrlList'

function assertEq(name: string, actual: any, expected: any) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${name} expected=${e} actual=${a}`)
}

assertEq('array', normalizeUrlList([' https://a ', ' ', 1, null, 'https://b']), ['https://a', 'https://b'])
assertEq('json-array-string', normalizeUrlList('["https://a"," https://b "]'), ['https://a', 'https://b'])
assertEq('single-string', normalizeUrlList(' https://a '), ['https://a'])
assertEq('empty-string', normalizeUrlList('   '), [])
assertEq('null', normalizeUrlList(null), [])
assertEq('number', normalizeUrlList(123), [])

process.stdout.write('ok\n')
