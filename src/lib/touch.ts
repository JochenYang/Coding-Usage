/**
 * Whether this event came from a pointer that is *hovering*: not a touch, and
 * not currently pressed. Which input the user is holding right now is not
 * something a device capability can answer — a touchscreen laptop hovers and
 * taps, and iPadOS reports a fine hovering pointer for a finger — so both
 * paths stay live and each handler branches on the event it was given.
 *
 * A pen resting on the glass is making contact, not hovering: `buttons` is the
 * tell, and it sends a pen tap down the same route a finger takes.
 *
 * This answers what an *enter* asks. A leave is the other half of a pair and
 * has to be read against the enter that started it — `useHoverGesture` in
 * `lib/hooks/use-hover-gesture` does that, and hover surfaces should use it
 * rather than asking this question twice.
 */
export const isHoveringPointer = (event: {
  pointerType: string;
  buttons: number;
}) => event.pointerType !== "touch" && event.buttons === 0;
