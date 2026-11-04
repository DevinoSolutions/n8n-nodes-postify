/**
 * Reads a "Publish At" value as the ISO 8601 form `POST /v1/posts` accepts, which must carry a
 * timezone (`z.iso.datetime({ offset: true })` in Postify's contract).
 *
 * - A value with an offset (`2026-11-01T09:00:00+02:00`, `...Z`), a JS Date or a Luxon DateTime
 *   (what `{{ $now.plus({ hours: 2 }) }}` gives) names its own instant and is kept.
 * - A value with no offset is what n8n's date picker produces: a wall-clock time in the
 *   workflow's timezone (Workflow Settings > Timezone). It is read in that timezone, the way n8n
 *   reads it everywhere else, and sent as UTC.
 * - Anything else is refused before any request, so nothing is created or published.
 */

/** date, `T` or a space, hh:mm, optional :ss and fraction, then Z or an offset. */
const DATETIME =
	/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(?:\.\d{1,9})?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

export const DATETIME_EXAMPLE = '2026-11-01T09:00:00+02:00 or 2026-11-01T07:00:00Z';

export type PublishAtResult = { ok: true; value: string } | { ok: false; message: string };

interface DateLike {
	toISO?: () => string | null;
}

export function normalisePublishAt(input: unknown, timezone: string): PublishAtResult {
	let raw: string;
	if (input instanceof Date) {
		if (Number.isNaN(input.getTime())) {
			return { ok: false, message: "'Publish At' is not a real date and time" };
		}
		raw = input.toISOString();
	} else if (
		typeof input === 'object' &&
		input !== null &&
		typeof (input as DateLike).toISO === 'function'
	) {
		raw = String((input as DateLike).toISO?.() ?? '');
	} else {
		raw = typeof input === 'string' ? input.trim() : '';
	}

	const match = DATETIME.exec(raw);
	if (!match) {
		return {
			ok: false,
			message: `'Publish At' must be a date and time, such as ${DATETIME_EXAMPLE}${raw ? `, not ${raw}` : ''}`,
		};
	}
	const [, date, hourMinute, secondsPart, offset] = match;
	const seconds = secondsPart ? secondsPart.slice(1, 3) : '00';
	const wallClock = `${date}T${hourMinute}:${seconds}`;
	if (!isRealCalendarTime(wallClock)) {
		return {
			ok: false,
			message: `'Publish At' (${raw}) is not a real date and time. Use one such as ${DATETIME_EXAMPLE}.`,
		};
	}

	if (offset !== undefined) {
		const zone = offset.toUpperCase() === 'Z' ? 'Z' : `${offset.slice(0, 3)}:${offset.slice(-2)}`;
		return { ok: true, value: `${wallClock}${zone}` };
	}

	const instant = zonedWallClockToUtc(wallClock, timezone);
	if (instant === null) {
		return {
			ok: false,
			message: `'Publish At' (${raw}) has no timezone and the workflow timezone '${timezone}' is unknown. Add an offset, such as ${DATETIME_EXAMPLE}.`,
		};
	}
	return { ok: true, value: new Date(instant).toISOString().replace('.000Z', 'Z') };
}

/** Rejects values Date.parse rolls over instead of refusing, such as 2026-02-30. */
function isRealCalendarTime(wallClock: string): boolean {
	const [y, mo, d, h, mi, s] = wallClock.split(/[-T:]/).map(Number) as [
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
	return (
		utc.getUTCFullYear() === y &&
		utc.getUTCMonth() === mo - 1 &&
		utc.getUTCDate() === d &&
		utc.getUTCHours() === h &&
		utc.getUTCMinutes() === mi &&
		utc.getUTCSeconds() === s
	);
}

/** Milliseconds `timezone` is ahead of UTC at `instant`, or null for an unknown zone. */
function zoneOffsetMs(instant: number, timezone: string): number | null {
	let format: Intl.DateTimeFormat;
	try {
		format = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
	} catch {
		return null;
	}
	const parts: Record<string, number> = {};
	for (const part of format.formatToParts(new Date(instant))) {
		if (part.type !== 'literal') parts[part.type] = Number(part.value);
	}
	const asUtc = Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
		parts.second,
	);
	return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The UTC instant at which the clocks in `timezone` show `wallClock` (YYYY-MM-DDTHH:mm:ss). Two
 * passes settle the offset across a daylight-saving change; a wall-clock time that does not exist
 * (inside a spring-forward gap) moves forward by the skipped hour.
 */
export function zonedWallClockToUtc(wallClock: string, timezone: string): number | null {
	const guess = Date.parse(`${wallClock}Z`);
	const first = zoneOffsetMs(guess, timezone);
	if (first === null) return null;
	const second = zoneOffsetMs(guess - first, timezone);
	if (second === null) return null;
	return guess - second;
}

/** Split a comma-separated list (or accept an array) into trimmed, non-empty strings. */
export function toStringList(value: unknown): string[] {
	const parts = Array.isArray(value) ? value : String(value ?? '').split(',');
	return parts.map((part) => String(part).trim()).filter((part) => part.length > 0);
}
