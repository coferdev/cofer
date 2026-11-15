/**
 * The sign-up page's words when it offers both keys (passkey page, /s/, with Connect wallet on).
 * Shared by the page shell and the browser bundle, so tests can quote them exactly.
 */

/** Above the two buttons. */
export const SIGNUP_CHOICE = "Choose one way to set up your key. Either works.";

/** The intro when both options are offered: neutral, describes both. */
export const SIGNUP_INTRO = "Your key controls your seat: votes, deposits and exits. Nobody else can use it. Set it up with your own wallet, or with a passkey on this device.";

/** The intro when only the passkey is offered (Connect wallet off): unchanged from before. */
export const SIGNUP_INTRO_PASSKEY = "Creates a passkey on this device. It controls your seat: votes, deposits and exits. Nobody else can use it.";

export const PASSKEY_BUTTON = "Set up with a passkey";
export const WALLET_BUTTON = "Connect wallet";

/** Shown with the wallet option (the passkey option keeps its own "no recovery" warning). */
export const WALLET_SEAT_NOTE = "The wallet you connect controls your seat, so you must keep access to that wallet.";
