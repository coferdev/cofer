# Audit scope at `18f8b7a`

Commit `18f8b7ade9479b54630c2f6c314e78b6c7fa58fd` (2026-11-05). Every file below was in scope for the latest grade. The second column is the file's git blob id: anyone can check a file against it with `git ls-tree 18f8b7a -- <path>`, or check the whole list by re-running `git ls-tree -r 18f8b7a`.

**Not graded as code** (read as evidence or context): the tests (`contracts/test/`, `services/test/`), the contract mocks (`contracts/src/mocks/`, never deployed), the generated contract ABIs (`services/src/chain/abi/`), and the docs. **Not covered at all:** the third-party card provider, the bundler, paymaster and passkey server, the Robinhood Chain RPCs, and Chainlink feeds (see SECURITY.md, Scope).

## Contracts (deployed)

| File | Git blob | Lines |
| --- | --- | --- |
| `contracts/src/CoferFactory.sol` | `bc890523d9976d231ad7421ed7a50eb4fb5d821a` | 268 |
| `contracts/src/CoferPot.sol` | `e369fd9cee3494b27b78108d305e05ce3e59a75b` | 554 |
| `contracts/src/FeeRouter.sol` | `60c77c5b0bfc854929500c5d675abbe9be9b9fec` | 120 |
| `contracts/src/SwapAdapter.sol` | `02b404f95564ee8caea2dab5d84994c94f15765c` | 54 |
| `contracts/src/interfaces/ICoferFactory.sol` | `a719cca4beeb835c374b2c22fa89e811e67390c3` | 65 |
| `contracts/src/interfaces/ICoferPot.sol` | `11941d29a6ea267d316d8a1edf84f0f70d62a326` | 130 |
| `contracts/src/interfaces/IERC1271.sol` | `495b9189cbce918cee0e53819a3893d97dc3c879` | 6 |
| `contracts/src/interfaces/IExternal.sol` | `9d16870f3c2c26dc8371da841796f69930eb68d1` | 39 |
| `contracts/src/interfaces/IFeeRouter.sol` | `5822515986b6a4151d0d60a35643d5b714b28948` | 15 |
| `contracts/src/interfaces/ISwapAdapter.sol` | `7291845867aef50b66eadd6364067582c778a5e1` | 10 |
| `contracts/src/lib/Clones.sol` | `2d34540348733739cdaf9e8652a7b81d5cd5570e` | 39 |
| `contracts/src/lib/FullMath.sol` | `9131767e061619443894311f45a85b8fcc70435e` | 49 |
| `contracts/src/lib/ReentrancyGuard.sol` | `4279387dc276bdc0024ac369f67263f62837ad16` | 16 |
| `contracts/src/lib/SafeTransferLib.sol` | `68972eb38d8842f34301293491775cabc9eb2011` | 52 |
| `contracts/src/lib/SignatureChecker.sol` | `07dc5467189e96bea35abbeb0f794fade423e72c` | 41 |

## Contract build settings and deploy scripts

| File | Git blob | Lines |
| --- | --- | --- |
| `contracts/.npmrc` | `b5603d857b92e0904ccb1dab9af62d19133f9c0f` | 2 |
| `contracts/deployments/4663.example.json` | `97ffd1da82afc4bcfa6b985333b9d7f3816f8518` | 26 |
| `contracts/foundry.toml` | `ebd13092221b21874435de02f444cb3deece47be` | 23 |
| `contracts/package-lock.json` | `aca17faff5a843b4598ee3e957a93bc8ed7de788` | 1385 |
| `contracts/package.json` | `0b9fe04bbc3dde9b97e8eeb9cfb787e02cdb7063` | 13 |
| `contracts/script/Deploy.s.sol` | `8856b1c159f76134143389eef66d8b592aebaaf9` | 59 |
| `contracts/script/DeployTestnet.s.sol` | `d01ed6bcc03d5e021974c04a4878526eadb562bd` | 88 |

## Services: bot, signer API and page, relayer, indexer, keeper, notifier

| File | Git blob | Lines |
| --- | --- | --- |
| `services/src/api/router.ts` | `0be0bdd572c431aa5e675e5c686220b2a8fba08f` | 250 |
| `services/src/api/server.ts` | `91868df3400655ee74d77bdf2ad7de5848a9c389` | 80 |
| `services/src/bot/bot.ts` | `97093b018a76afff2106106de595eb375010749a` | 556 |
| `services/src/bot/exitList.ts` | `0260d7639b4629d0f91d0d076db2833b4affc3c7` | 62 |
| `services/src/bot/help.ts` | `ef78e1a1735ebbebaf9cb8562efeeaa2bf2a0060` | 23 |
| `services/src/bot/keyboards.ts` | `b34d4de24988ac36fc631014175d7e453e7d3de9` | 40 |
| `services/src/bot/newpotAdmin.ts` | `91a6b7abdaf5be9c7280a0bbce49ad7c4f5d995e` | 39 |
| `services/src/bot/newpotLimit.ts` | `a21dfd07b691d481ce2d2504e5c9896184b3fba3` | 16 |
| `services/src/bot/noMiniApp.ts` | `1dcc68d8a8f2b1eb7c75676cee2acfeba3cb6dc9` | 38 |
| `services/src/bot/parse.ts` | `306d908c2e545c1d8133b46d5c04d861f9b494fc` | 85 |
| `services/src/bot/privateReply.ts` | `f1277c997aefa5f3ec8fd79b4d535240034edb89` | 79 |
| `services/src/bot/rateLimit.ts` | `de794d6ef2b90ada83dc652de680136f802c4341` | 138 |
| `services/src/bot/resolveHandle.ts` | `e1d674f1abbf3aafbfece223e37a7182acdf64a9` | 49 |
| `services/src/cards/CardAdapter.ts` | `79adcb596b47034169192d93e86bb94636edc33d` | 36 |
| `services/src/cards/StubCardAdapter.ts` | `44cf3eade66763a9e93e6df1f731ade93d20f038` | 45 |
| `services/src/cards/select.ts` | `ad70ffed08f97eec98811ea0685e71e1524ee975` | 44 |
| `services/src/chain/addresses.ts` | `f2ee781c80a8ef888f33c31e58422764d88389cb` | 48 |
| `services/src/chain/clients.ts` | `233a8f726dd719186b279c22c28d6f8b3811b301` | 59 |
| `services/src/chain/quotes.ts` | `c16d8f9dceafbb17fb69b2be553caf2ad1b00ec6` | 128 |
| `services/src/core/alertFormat.ts` | `490af9fcbc78ea0613f0b88a178d1c2b764ba151` | 174 |
| `services/src/core/betaCap.ts` | `0568ff510463974c49fc274b01c0f034f37475c8` | 52 |
| `services/src/core/buyPause.ts` | `478afcad963fb1f1fcf28ea81b253325449b8aca` | 52 |
| `services/src/core/continuity.ts` | `10381b0cf3899c0217ff6edce286a0a918378eb4` | 108 |
| `services/src/core/deployCheck.ts` | `74d47850ade045e46eeb1b53b66b31057c8bc478` | 192 |
| `services/src/core/depositGate.ts` | `f214d11eb6b65110f8f1f5fd86baf9974921b584` | 51 |
| `services/src/core/depth.ts` | `c0befd4a9fe44546f543f78dbc89b739ecdebe80` | 41 |
| `services/src/core/errors.ts` | `b402d5e50e5e4e49cdbc17cdb5fe4d2209ae9290` | 129 |
| `services/src/core/feedHealth.ts` | `f3f07b464d109d5c0904c19e5c5d66181c582cf5` | 76 |
| `services/src/core/feedName.ts` | `5dda630f0e2bacd2e3e2d2fd5afa70dece49268f` | 17 |
| `services/src/core/geo.ts` | `d6e57969cf1d94307b070afe45be527f74d5bf1a` | 39 |
| `services/src/core/indexerLag.ts` | `8aa6a884aa2c2d342d00622b5888566703cc92f7` | 25 |
| `services/src/core/linkToken.ts` | `47d6603b29a453ace167a4dbe2a370fe560df977` | 53 |
| `services/src/core/outflow.ts` | `7944965e98616f47d8fd0b6a849476d2817e48cc` | 153 |
| `services/src/core/priceUpdating.ts` | `69595c4ccb8fbf30e8e2c97b1f42e4d78e17c2e9` | 53 |
| `services/src/core/proposal.ts` | `765a9bf701f2e8fd5e50d6134de00770a5d62173` | 243 |
| `services/src/core/relayerFunds.ts` | `affab78e8f8d7fc18b1613ebb0cec1f2254786d2` | 19 |
| `services/src/core/retryText.ts` | `7f0fb0d503216916a6893743526cd99c2ed91adf` | 49 |
| `services/src/core/roles.ts` | `633fc6b41ed3c32b8dbf60e716d4e3f4fa63b7df` | 30 |
| `services/src/core/serverHealth.ts` | `442747dbd3e3e57af02dd49a0b8bd12c2928be39` | 48 |
| `services/src/core/shares.ts` | `7b0af31f4ffc60c1334750734801d1687745a78c` | 64 |
| `services/src/core/signCheck.ts` | `b2c9365d8e9f33fcdd43717acf22f6c2e3c3c07d` | 121 |
| `services/src/core/signerCheck.ts` | `301fee5dc94e0f8da456bbec27f3db6ead18b15a` | 20 |
| `services/src/core/swap.ts` | `25137d6c5afc9e43cf5ec1dd4f25b2d1a356b7b2` | 61 |
| `services/src/core/telegramLogin.ts` | `df31ebba5d43dd3de078dfbc749554b9a56ae492` | 34 |
| `services/src/core/valuation.ts` | `592406c6894d51a3a0bb01ff33ee06c0ea20c840` | 97 |
| `services/src/core/votes.ts` | `3a225dfe8524e320737e7540d6d3feb8a698b025` | 79 |
| `services/src/db/client.ts` | `76740d8df04ff3904040e07946fb7635455eb48a` | 17 |
| `services/src/db/schema.ts` | `91813fa704075c8814b90f4db04b644e5d6bafd8` | 196 |
| `services/src/env.ts` | `73193e1b0ea9bcd6336bdee579d0e544652fd450` | 64 |
| `services/src/index.ts` | `113911c1e938b4e67800fa94b6f5da54ece2a731` | 71 |
| `services/src/indexer/adminEvents.ts` | `24504383b2a749cea56d0a34cb666ed99e7fa96e` | 192 |
| `services/src/indexer/indexer.ts` | `2a0cc36b5765342f8d670771ebb63d56646d3045` | 259 |
| `services/src/indexer/unknownVotes.ts` | `87455c924777701ba0ef163c0fe6db15188c76fd` | 81 |
| `services/src/keeper/alerts.ts` | `bbc7c2f7683750186d8cdb77af35c8f4957c52f5` | 187 |
| `services/src/keeper/health.ts` | `048f4e2bf964242f25eda061849b84f983284c39` | 99 |
| `services/src/keeper/jobAlerts.ts` | `1428b0cf11eed9a5b00f7bbb6710d7882b4a8cba` | 48 |
| `services/src/keeper/keeper.ts` | `7871c049b6d12a22f6f2166ffef913313ef0950a` | 568 |
| `services/src/keeper/serverHealth.ts` | `29ade813298a740a83d89bd8f436b90e219d606c` | 174 |
| `services/src/notifier/notifier.ts` | `114b7d9506e1788df4245e68f6545c45e6fc158c` | 165 |
| `services/src/queues.ts` | `0313270031ea813630699f2b5b5d9a25259beba4` | 95 |
| `services/src/relayer/relayer.ts` | `85286338a649cb1bc5d2d18086a5bb46c3a02d76` | 97 |
| `services/src/relayer/voteAlerts.ts` | `c15dbe04215c5bb452a256762c91d32a611cc434` | 56 |
| `services/src/services/proposals.ts` | `e7f0c66dfbcf19e1630672a5abfb8bc9495aa30b` | 264 |
| `services/src/stocks/canonical.ts` | `78861f8ee40d7b9b6313d066ce499afaf9c0e9ed` | 82 |
| `services/src/web/buffer-polyfill.ts` | `b7930fabe795022ae6fa41beeb4e133e51f74c76` | 9 |
| `services/src/web/client.ts` | `de2c687076fc292c447d29d20e15f203f96ec1aa` | 387 |
| `services/src/web/page.ts` | `553480f78b0dc98cd052bd7c599169d0d0fa5726` | 89 |
| `services/src/web/pageConfig.ts` | `0e0a41a348b99e35998553d31911d4c811336d56` | 9 |

## Services: scripts, database migrations, manifests

| File | Git blob | Lines |
| --- | --- | --- |
| `services/bun.lock` | `f91db29b39d0379a26f4908fa49327b9dd9b5faa` | 383 |
| `services/bunfig.toml` | `127972e5a683436972ad8fe2f52a83fc18065708` | 4 |
| `services/drizzle.config.ts` | `b6d7a027f4a083ce4daeb40ee61ea053e7d5a12d` | 8 |
| `services/drizzle/0000_init.sql` | `d73319a57eebba5f8d253cae4c10601b17d2e5fc` | 136 |
| `services/drizzle/0001_alerts.sql` | `bab746a5971220f5d432bbec7ae5a03686deabb7` | 5 |
| `services/drizzle/0002_feed_readings.sql` | `a50eeb11e2599fd7c87a81834ef8c3d7ab160c73` | 8 |
| `services/drizzle/0003_alerts_last_sent.sql` | `4843837485e5bae0b2e34181ca183c16e1de449b` | 0 |
| `services/drizzle/meta/0000_snapshot.json` | `f29004add6498c41bc04c1d406712e9fe4722a6f` | 900 |
| `services/drizzle/meta/0001_snapshot.json` | `c76914254f98f57f1f7dabb21b5fbcb326e1f0cd` | 932 |
| `services/drizzle/meta/0002_snapshot.json` | `267b4e75e505909eef8f3dede6dd91bdc71eacc7` | 982 |
| `services/drizzle/meta/0003_snapshot.json` | `06463270c18732d2cb5c1ea7075a7d33fc0ed926` | 989 |
| `services/drizzle/meta/_journal.json` | `5a6957d9b2ec6ab42158d9203652f83879ef8e10` | 33 |
| `services/package.json` | `59e6a478ac9aa969cf8307155e26bcc80a632d16` | 48 |
| `services/scripts/build-asset-list.ts` | `4c4568094534f4250c1e3475b5a6f941017ed56e` | 126 |
| `services/scripts/check-deploy.ts` | `98582e6cc9a105be208b3bfd4a95598ae7dbf16c` | 70 |
| `services/scripts/fork-swap-test.ts` | `e9588fbd458505a5a9019f934b3b4c908b0444e0` | 104 |
| `services/tsconfig.json` | `eedcec4e41679979cedc302e19d5c98173850984` | 17 |

## CI and repo tooling

| File | Git blob | Lines |
| --- | --- | --- |
| `.github/dependabot.yml` | `8d86a0c8e6702434c4fdc882cd152f84c8665371` | 8 |
| `.github/workflows/analysis.yml` | `1e4d11f05dc3dd6773be6f21b418ee94cbbf9e83` | 58 |
| `.github/workflows/ci.yml` | `fa48045fafb7916f459e86cff3f39937d830d4d6` | 49 |
| `contracts/slither.config.json` | `f6fe1fa0ce9c95c7dbab8efed3d8215d1f452332` | 4 |
| `contracts/slither.db.json` | `fddb93b146fb39feacc573ef51ae63508902edd7` | 178 |
| `tools/banned-words.ts` | `db23cab3b2c95916e9dff5d353746dbd2c5ca707` | 60 |

In scope: 113 files, 15260 lines (the two lockfiles account for most of them).
