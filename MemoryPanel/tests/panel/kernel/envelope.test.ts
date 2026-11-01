import { describe, expect, it } from 'vitest';
import { mapHttpStatusFromEnvelopeCode } from '../../../src/panel/kernel/envelope.js';

describe('mapHttpStatusFromEnvelopeCode', () => {
  it('maps success and 3-digit HTTP codes unchanged', () => {
    expect(mapHttpStatusFromEnvelopeCode(0)).toBe(200);
    expect(mapHttpStatusFromEnvelopeCode(409)).toBe(409);
    expect(mapHttpStatusFromEnvelopeCode(500)).toBe(500);
  });

  it('maps 5-digit kernel codes to their HTTP class', () => {
    expect(mapHttpStatusFromEnvelopeCode(40901)).toBe(409);
    expect(mapHttpStatusFromEnvelopeCode(50001)).toBe(500);
    expect(mapHttpStatusFromEnvelopeCode(40401)).toBe(404);
  });

  it('keeps unknown / non-HTTP codes as 502', () => {
    expect(mapHttpStatusFromEnvelopeCode(7)).toBe(502);
    expect(mapHttpStatusFromEnvelopeCode(99999)).toBe(502);
    expect(mapHttpStatusFromEnvelopeCode(123)).toBe(502);
  });
});
