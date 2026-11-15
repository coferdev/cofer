/** The sign-up choice: the exact words, and the order of the button area (text and layout only). */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PASSKEY_LOSS_WARNING } from "../src/core/passkeyWarning";
import { PASSKEY_BUTTON, SIGNUP_CHOICE, SIGNUP_INTRO, SIGNUP_INTRO_PASSKEY, WALLET_BUTTON, WALLET_SEAT_NOTE } from "../src/core/signupText";
import { PAGE_CSS, signerPage } from "../src/web/page";

const client = readFileSync(join(import.meta.dir, "..", "src", "web", "client.ts"), "utf8");
const unesc = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const html = unesc(signerPage("tok", { chainId: 46630, rpcUrl: "https://r", bundlerUrl: "", paymasterUrl: "", passkeyServerUrl: "", usdg: "0x1", walletOn: true, mode: "passkey" }));

describe("sign-up choice: exact words", () => {
  test("the line above the buttons, the two labels, the intro and the wallet line", () => {
    expect(SIGNUP_CHOICE).toBe("Choose one way to set up your key. Either works.");
    expect(PASSKEY_BUTTON).toBe("Set up with a passkey");
    expect(WALLET_BUTTON).toBe("Set up with a wallet");
    expect(SIGNUP_INTRO).toBe("Your key controls your seat: votes, deposits and exits. Nobody else can use it. Set it up with a passkey on this device, or with your own wallet.");
    expect(WALLET_SEAT_NOTE).toBe("The wallet you connect controls your seat, so you must keep access to that wallet.");
  });

  test("with only the passkey offered (Connect wallet off), the intro is the passkey one, as before", () => {
    expect(SIGNUP_INTRO_PASSKEY).toBe("Creates a passkey on this device. It controls your seat: votes, deposits and exits. Nobody else can use it.");
    expect(client).toContain('$("body").textContent = choice.wallet ? SIGNUP_INTRO : SIGNUP_INTRO_PASSKEY;');
  });
});

describe("sign-up choice: layout", () => {
  test("order: choice line, passkey button, passkey warning, or, wallet button, wallet line; all start hidden", () => {
    const parts = [
      `<p id="choice" hidden>${SIGNUP_CHOICE}</p>`,
      '<button id="action">...</button>',
      `<p id="keywarn" class="warn" hidden>${PASSKEY_LOSS_WARNING}</p>`,
      '<p id="or" class="or" hidden>or</p>',
      '<button id="walletBtn" hidden>Connect wallet</button>',
      `<p id="walletNote" class="warn" hidden>${WALLET_SEAT_NOTE}</p>`,
    ];
    let at = -1;
    for (const p of parts) {
      const i = html.indexOf(p);
      expect(i).toBeGreaterThan(at);
      at = i;
    }
  });

  test("the divider is a line with \"or\" in the middle, and stays hidden until shown", () => {
    expect(PAGE_CSS).toContain('.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--muted);opacity:.4}');
    expect(PAGE_CSS).toContain(".or[hidden]{display:none}"); // display:flex must not undo the hidden attribute
  });

  test("the choice line and the divider show only when both options are offered", () => {
    expect(client).toContain('if (choice.wallet) {\n      $("choice").hidden = false;\n      $("or").hidden = false;\n    }');
    expect(client).toContain("act.textContent = PASSKEY_BUTTON;");
    // the wallet button gets its label and its own line wherever it is offered (also beside the in-app notice)
    const offer = client.slice(client.indexOf("const offerWallet = () => {"), client.indexOf("// Inside an app's built-in browser"));
    expect(offer).toContain("walletBtn.textContent = WALLET_BUTTON;");
    expect(offer).toContain('$("walletNote").hidden = false;');
    expect(client).not.toContain('"Create passkey"');
  });
});
