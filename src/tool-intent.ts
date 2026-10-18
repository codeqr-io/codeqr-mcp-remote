import { DEFAULT_QRCODE_TYPE, QRCODE_CONTENT_TYPES } from './qrcode-content-types.js';
import { isPlaceholderDestination } from './placeholder-destination.js';
import type { EventFields } from './telemetry.js';

const INTENT_TOOLS = new Set(['create_qrcode', 'create_link']);

function hasUtmParam(url: string): boolean {
  try {
    return [...new URL(url).searchParams.keys()].some((key) => key.startsWith('utm_'));
  } catch {
    return false;
  }
}

// The model chooses `type`, so only declared content types are logged as sent.
function qrTypeOf(type: unknown): string {
  if (type === undefined) return DEFAULT_QRCODE_TYPE;
  return (QRCODE_CONTENT_TYPES as readonly unknown[]).includes(type) ? (type as string) : 'other';
}

const isNonEmptyArray = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

/**
 * What a creation call was for, as flags and a type. No argument value is
 * returned, so the destination itself never reaches a log line.
 */
export function toolIntentFields(
  name: string,
  args: Record<string, unknown> | undefined,
): Pick<EventFields, 'qrType' | 'placeholderDestination' | 'hasUtm' | 'hasTag' | 'hasRules'> {
  if (!INTENT_TOOLS.has(name) || !args) return {};

  const url = typeof args.url === 'string' ? args.url : undefined;
  return {
    qrType: name === 'create_qrcode' ? qrTypeOf(args.type) : undefined,
    placeholderDestination: url === undefined ? undefined : isPlaceholderDestination(url),
    hasUtm: url === undefined ? undefined : hasUtmParam(url),
    hasTag: isNonEmptyArray(args.tagIds) || isNonEmptyArray(args.tagNames),
    hasRules: isNonEmptyArray(args.rules),
  };
}
