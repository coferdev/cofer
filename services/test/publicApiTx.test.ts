import { describe, expect, test } from "bun:test";
import recorded from "./fixtures/tx-receipts-46630.json";
import { fakePublicApi, fakeTx, getJson, publicServer } from "./publicApiHarness";
import { TX_PAGE_CSP } from "../src/web/txPage";

const DEP = recorded.kinds.Deposited;

describe("GET /v1/tx/:hash", () => {
  test("a Cofer transaction, explained, with every amount as a string", async () => {
    const r = await getJson(publicServer(), `/v1/tx/${DEP}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ hash: DEP, cofer: true, status: "succeeded", kind: "deposit", block: recorded.receipts.find((x) => x.transactionHash === DEP)!.blockNumber });
    expect(r.body.data.events[0].args).toEqual({ member: "0xD6D8195a52Fa752A5bBaf76b598336FecAc9c585", amount: "100000000", shares: "100000000000000000000", navBefore: "0" });
    expect(r.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("a bad hash is 400; an unknown hash is 404", async () => {
    expect((await getJson(publicServer(), "/v1/tx/0x1234")).status).toBe(400);
    const r = await getJson(publicServer(), `/v1/tx/0x${"00".repeat(32)}`);
    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe("No transaction with this hash on this chain (yet).");
  });

  test("each hash is read from the chain once", async () => {
    let reads = 0;
    const base = fakeTx();
    const app = publicServer(fakePublicApi({ tx: { ...base, receipt: async (h) => (reads++, base.receipt(h)) } }));
    await app.request(`/v1/tx/${DEP}`);
    await app.request(`/v1/tx/${DEP.toUpperCase().replace("0X", "0x")}`);
    expect(reads).toBe(1);
  });
});

describe("the /tx page", () => {
  test("the form, with no script and a strict policy", async () => {
    const r = await publicServer().request("/tx");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe(TX_PAGE_CSP);
    const html = await r.text();
    expect(html).toContain('<form method="get" action="/tx">');
    expect(html).not.toMatch(/<script|\son\w+=/i);
  });

  test("a pasted hash goes to its page; the page shows the explanation", async () => {
    const app = publicServer();
    const go = await app.request(`/tx?hash=${DEP}`);
    expect(go.status).toBe(302);
    expect(go.headers.get("location")).toBe(`/tx/${DEP}`);
    const page = await (await app.request(`/tx/${DEP}`)).text();
    expect(page).toContain("deposited 100 USDG into group account 0x50F19AdD1EE10AF538C1F8bE5bcbA4011F100115");
    expect(page).not.toMatch(/<script/i);
  });

  test("a bad hash is refused and never echoed into the page", async () => {
    const r = await publicServer().request("/tx?hash=<b>x</b>");
    expect(r.status).toBe(400);
    const page = await r.text();
    expect(page).toContain("A transaction hash is 0x followed by 64 hex characters.");
    expect(page).not.toContain("<b>x</b>");
  });
});
