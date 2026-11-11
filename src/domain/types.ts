export interface Slot {
  id: string;
  provider: string;
  start: string;
  end: string;
}

export interface SlotWithAvailability extends Slot {
  available: boolean;
}

export type BookingStatus = 'confirmed' | 'cancelled';

export interface Booking {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: BookingStatus;
  created_at: string;
}

export interface NewBooking {
  slot_id: string;
  name: string;
  email: string;
}

/** A finished HTTP outcome, so it can be stored and replayed for idempotent retries. */
export interface ApiResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function errorResult(status: number, message: string, headers?: Record<string, string>): ApiResult {
  return { status, body: { error: message }, headers };
}
