import { isPlaceholderDestination } from './placeholder-destination.js';
import type { EventFields } from './telemetry.js';

const INTENT_TOOLS = new Set(['create_qrcode', 'create_link']);
const DEFAULT_QR_TYPE = 'url';

function hasUtmParam(url: string): boolean {
  try {
    return [...new URL(url).searchParams.keys()].some((key) => key.startsWith('utm_'));
  } catch {
    return false;
  }
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
    qrType: name === 'create_qrcode' ? (typeof args.type === 'string' ? args.type : DEFAULT_QR_TYPE) : undefined,
    placeholderDestination: url === undefined ? undefined : isPlaceholderDestination(url),
    hasUtm: url === undefined ? undefined : hasUtmParam(url),
    hasTag: isNonEmptyArray(args.tagIds) || isNonEmptyArray(args.tagNames),
    hasRules: isNonEmptyArray(args.rules),
  };
}
