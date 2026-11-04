import { assert, describe, it } from 'vitest';
import { normalisePublishAt, zonedWallClockToUtc } from '../nodes/Postify/shared/utils';

describe('Publish At', () => {
	it('keeps an explicit offset or Z, normalising +0200 to +02:00 and adding seconds', () => {
		assert.deepEqual(normalisePublishAt('2026-11-01T09:00:00+02:00', 'UTC'), {
			ok: true,
			value: '2026-11-01T09:00:00+02:00',
		});
		assert.deepEqual(normalisePublishAt('2026-11-01 09:00 +0200', 'UTC'), {
			ok: true,
			value: '2026-11-01T09:00:00+02:00',
		});
		assert.deepEqual(normalisePublishAt('2026-11-01T07:00:00.123Z', 'Asia/Tokyo'), {
			ok: true,
			value: '2026-11-01T07:00:00Z',
		});
	});

	it('reads a time without an offset in the given timezone', () => {
		assert.deepEqual(normalisePublishAt('2026-11-01T09:00:00', 'America/New_York'), {
			ok: true,
			value: '2026-11-01T14:00:00Z',
		});
		assert.deepEqual(normalisePublishAt('2026-10-31T09:00:00', 'America/New_York'), {
			ok: true,
			value: '2026-10-31T13:00:00Z',
		});
		assert.deepEqual(normalisePublishAt('2026-11-01T09:00', 'UTC'), {
			ok: true,
			value: '2026-11-01T09:00:00Z',
		});
	});

	it('moves a wall-clock time inside a spring-forward gap forward by the skipped hour', () => {
		// Paris skips 02:00-03:00 on 2026-03-29; 02:30 does not exist and reads as 03:30 CEST.
		const instant = zonedWallClockToUtc('2026-03-29T02:30:00', 'Europe/Paris');
		assert.strictEqual(new Date(instant ?? 0).toISOString(), '2026-03-29T01:30:00.000Z');
	});

	it('refuses an unknown timezone, junk, and impossible dates', () => {
		assert.strictEqual(normalisePublishAt('2026-11-01T09:00:00', 'Mars/Olympus').ok, false);
		assert.strictEqual(normalisePublishAt('next tuesday', 'UTC').ok, false);
		assert.strictEqual(normalisePublishAt('', 'UTC').ok, false);
		assert.strictEqual(normalisePublishAt('2026-13-01T09:00:00Z', 'UTC').ok, false);
		assert.strictEqual(normalisePublishAt('2026-02-29T09:00:00Z', 'UTC').ok, false);
		assert.strictEqual(normalisePublishAt(new Date('invalid'), 'UTC').ok, false);
	});
});
