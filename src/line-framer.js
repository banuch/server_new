'use strict';

const LF = 0x0a;
const CR = 0x0d;
const PREVIEW_BYTES = 256;

/**
 * Turns an arbitrary TCP byte stream into newline-delimited frames.
 * TCP chunks are not message boundaries, so a frame may span many chunks and
 * one chunk may contain many frames.
 */
class LineFramer {
    constructor(maxFrameBytes) {
        this.maxFrameBytes = maxFrameBytes;
        this.buffer = Buffer.alloc(0);
        this.discardingOversizeFrame = false;
    }

    push(chunk) {
        if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);

        const events = [];
        let input = chunk;

        if (this.discardingOversizeFrame) {
            const newline = input.indexOf(LF);
            if (newline === -1) return events;

            this.discardingOversizeFrame = false;
            input = input.subarray(newline + 1);
        }

        if (input.length > 0) {
            this.buffer = this.buffer.length === 0
                ? Buffer.from(input)
                : Buffer.concat([this.buffer, input]);
        }

        while (this.buffer.length > 0) {
            const newline = this.buffer.indexOf(LF);

            if (newline === -1) {
                if (this.buffer.length > this.maxFrameBytes) {
                    events.push({
                        type: 'oversize',
                        observedBytes: this.buffer.length,
                        preview: this.buffer.subarray(0, PREVIEW_BYTES).toString('utf8'),
                    });
                    this.buffer = Buffer.alloc(0);
                    this.discardingOversizeFrame = true;
                }
                break;
            }

            let frame = this.buffer.subarray(0, newline);
            this.buffer = this.buffer.subarray(newline + 1);

            if (frame.length > 0 && frame[frame.length - 1] === CR) {
                frame = frame.subarray(0, frame.length - 1);
            }

            if (frame.length === 0) continue;

            if (frame.length > this.maxFrameBytes) {
                events.push({
                    type: 'oversize',
                    observedBytes: frame.length,
                    preview: frame.subarray(0, PREVIEW_BYTES).toString('utf8'),
                });
                continue;
            }

            events.push({ type: 'frame', data: Buffer.from(frame) });
        }

        return events;
    }

    takeIncompleteFrame() {
        if (this.discardingOversizeFrame || this.buffer.length === 0) return null;
        const incomplete = this.buffer;
        this.buffer = Buffer.alloc(0);
        return incomplete;
    }
}

module.exports = { LineFramer };
