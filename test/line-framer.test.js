'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LineFramer } = require('../src/line-framer');

test('assembles a JSON frame split across TCP chunks', () => {
    const framer = new LineFramer(1024);

    assert.deepEqual(framer.push('{"device'), []);
    const events = framer.push('Id":"A1"}\n');

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'frame');
    assert.equal(events[0].data.toString(), '{"deviceId":"A1"}');
});

test('extracts multiple frames from one TCP chunk and accepts CRLF', () => {
    const framer = new LineFramer(1024);
    const events = framer.push('{"n":1}\n{"n":2}\r\n\n');

    assert.deepEqual(
        events.map((event) => event.data.toString()),
        ['{"n":1}', '{"n":2}'],
    );
});

test('rejects an oversized frame and recovers at the next newline', () => {
    const framer = new LineFramer(8);

    const first = framer.push('123456789');
    assert.equal(first.length, 1);
    assert.equal(first[0].type, 'oversize');

    assert.deepEqual(framer.push('discarded\n'), []);
    const recovered = framer.push('{}\n');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].data.toString(), '{}');
});
