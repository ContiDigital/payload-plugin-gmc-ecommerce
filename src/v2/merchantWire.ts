export const GMC_MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n

/**
 * Validate Merchant protobuf int64 values before converting them to BigInt.
 *
 * The lexical bound is intentional: it rejects arbitrarily large digit
 * strings without asking the JavaScript runtime to allocate and parse an
 * attacker-controlled bigint first.
 */
export const isGmcNonNegativeInt64String = (value: unknown): value is string => {
  return (
    typeof value === 'string' &&
    /^(?:0|[1-9]\d{0,18})$/.test(value) &&
    BigInt(value) <= GMC_MAX_SIGNED_INT64
  )
}

const MIN_PROTOBUF_TIMESTAMP_NANOS = BigInt(Date.parse('0001-01-01T00:00:00Z')) * 1_000_000n
const MAX_PROTOBUF_TIMESTAMP_NANOS =
  BigInt(Date.parse('9999-12-31T23:59:59Z')) * 1_000_000n + 999_999_999n

/** Parse a protobuf Timestamp JSON value to an exact Unix-nanosecond instant. */
export const parseGmcRfc3339Timestamp = (value: unknown): bigint | null => {
  if (typeof value !== 'string') {
    return null
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    )
  if (!match) {
    return null
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone] =
    match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const offsetHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3))
  const offsetMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6))
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null
  }
  const epochMilliseconds = Date.parse(
    `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${zone}`,
  )
  if (!Number.isFinite(epochMilliseconds)) {
    return null
  }
  const instantNanos =
    BigInt(epochMilliseconds) * 1_000_000n + BigInt(fraction.padEnd(9, '0') || '0')
  return instantNanos >= MIN_PROTOBUF_TIMESTAMP_NANOS &&
    instantNanos <= MAX_PROTOBUF_TIMESTAMP_NANOS
    ? instantNanos
    : null
}

export const isGmcRfc3339Timestamp = (value: unknown): value is string =>
  parseGmcRfc3339Timestamp(value) !== null
