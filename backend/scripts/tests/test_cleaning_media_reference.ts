import assert from 'assert'
import { isCleaningMediaKey } from '../../src/lib/cleaningMediaReference'

assert.equal(isCleaningMediaKey('cleaning/media/task-1/photo-1'), true)
assert.equal(isCleaningMediaKey('/cleaning/media/task-1/photo-1'), false)
assert.equal(isCleaningMediaKey('cleaning/../private'), false)
assert.equal(isCleaningMediaKey('cleaning/media/task-1/photo-1?token=secret'), false)
assert.equal(isCleaningMediaKey('https://cdn.example.com/cleaning/photo.jpg'), false)

process.stdout.write('test_cleaning_media_reference: ok\n')
