/**
 * Trusted marker for an abort that OmniRoute's own routing deadline caused.
 *
 * A model attempt that the combo or target deadline cuts is the provider not answering in time,
 * and the router must learn that from the model's usage record. A client that gives up is not a
 * provider failure and must stay unrecorded. Telling them apart by the abort reason's name or
 * message would let an upstream error impersonate a local deadline, so the reason objects created
 * here are tracked by identity and nothing else is accepted.
 */
export type RoutingDeadlineKind = "routing_deadline" | "target_timeout";

const trustedReasons = new WeakMap<object, RoutingDeadlineKind>();

export function createRoutingDeadlineReason(kind: RoutingDeadlineKind): DOMException {
  const reason = new DOMException(
    kind === "routing_deadline" ? "Combo deadline" : "Target headers deadline",
    "TimeoutError"
  );
  trustedReasons.set(reason, kind);
  return reason;
}

/** The deadline kind when `reason` is a reason this module created, otherwise null. */
export function routingDeadlineKind(reason: unknown): RoutingDeadlineKind | null {
  return reason !== null && typeof reason === "object"
    ? (trustedReasons.get(reason) ?? null)
    : null;
}
