# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.21.1](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.21.0...v0.21.1) (2026-08-24)


### Bug Fixes

* **test:** stop chdir-ing in L0 gate tests so mutation testing can run again ([#272](https://github.com/rotifer-protocol/rotifer-playground/issues/272)) ([39c82d8](https://github.com/rotifer-protocol/rotifer-playground/commit/39c82d8c181dee344cbd4c5c4cbdef0910190ec9))

## [0.21.0](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.20.0...v0.21.0) (2026-08-23)


### Features

* **cloud:** put the Chinese disclosure where the disclosure lives ([#265](https://github.com/rotifer-protocol/rotifer-playground/issues/265)) ([bcd29df](https://github.com/rotifer-protocol/rotifer-playground/commit/bcd29df2b18c58eef7cef6c92317fe3598af351d))
* **profiles:** hold the disclosure's translations where the disclosure lives ([#263](https://github.com/rotifer-protocol/rotifer-playground/issues/263)) ([4f2a373](https://github.com/rotifer-protocol/rotifer-playground/commit/4f2a3732bb7bf91d43ada99962c6b2caac0b848a))


### Bug Fixes

* **engines:** state the Node floor the CLI already has ([#269](https://github.com/rotifer-protocol/rotifer-playground/issues/269)) ([370e550](https://github.com/rotifer-protocol/rotifer-playground/commit/370e55006c2f7284fafc7df65a688b56e4ee837f))
* **init:** ship the gene the recommended first command depends on ([#268](https://github.com/rotifer-protocol/rotifer-playground/issues/268)) ([d579f23](https://github.com/rotifer-protocol/rotifer-playground/commit/d579f239c2c2744b60c2300d81b0bd305973594e))
* **l0:** judge provenance by who wrote the manifest, not by whether one exists ([#267](https://github.com/rotifer-protocol/rotifer-playground/issues/267)) ([10d53ca](https://github.com/rotifer-protocol/rotifer-playground/commit/10d53ca9869355b335ce10b650fddd5bd7bc6275))

## [0.20.0](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.19.2...v0.20.0) (2026-08-21)


### Features

* **skills:** give the three published Skills a public home ([#254](https://github.com/rotifer-protocol/rotifer-playground/issues/254)) ([e412b82](https://github.com/rotifer-protocol/rotifer-playground/commit/e412b8276339b017536198def73da7a49909a02d))
* **skills:** publish the Gene manual the other three point at ([#258](https://github.com/rotifer-protocol/rotifer-playground/issues/258)) ([caaee46](https://github.com/rotifer-protocol/rotifer-playground/commit/caaee46e48df2bd4f17d505d66a8193123fc5952))


### Bug Fixes

* **plugins:** Cursor was the last host calling the bundle something else ([#259](https://github.com/rotifer-protocol/rotifer-playground/issues/259)) ([b8dcb7a](https://github.com/rotifer-protocol/rotifer-playground/commit/b8dcb7a72648961341280395420cb2cfb14e368a))
* **readme:** the freshness check I added had no exit ([#260](https://github.com/rotifer-protocol/rotifer-playground/issues/260)) ([28947be](https://github.com/rotifer-protocol/rotifer-playground/commit/28947bea7e951c2731becb4cfb157158d373c063))
* **readme:** the Status line said v0.10.1 while npm served 0.19.2 ([#257](https://github.com/rotifer-protocol/rotifer-playground/issues/257)) ([7109596](https://github.com/rotifer-protocol/rotifer-playground/commit/710959675dc5e4278152e9998813c895aa997f94))

## [0.19.2](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.19.1...v0.19.2) (2026-08-21)


### Bug Fixes

* **cloud:** unpublish never once worked, and now it is on the record ([#249](https://github.com/rotifer-protocol/rotifer-playground/issues/249)) ([5f1c2a5](https://github.com/rotifer-protocol/rotifer-playground/commit/5f1c2a575496d3cde5196a617cf3c191d9fc30f9))
* **l0:** judge by provenance when the gate cannot run, and cover the last paths ([#251](https://github.com/rotifer-protocol/rotifer-playground/issues/251)) ([4490211](https://github.com/rotifer-protocol/rotifer-playground/commit/449021140c38a4e136775a0b3e88831f2ab9b54a))
* **l0:** move the gate onto the Sandbox trait and cover genome + agent paths ([#248](https://github.com/rotifer-protocol/rotifer-playground/issues/248)) ([f7c6c83](https://github.com/rotifer-protocol/rotifer-playground/commit/f7c6c83645f9079891d727130e00553f34b773fb))
* **l0:** run the L0 gate on the Node.js fallback path too ([#247](https://github.com/rotifer-protocol/rotifer-playground/issues/247)) ([a1bac93](https://github.com/rotifer-protocol/rotifer-playground/commit/a1bac937149b36a8901b88fd7200f408512f7fec))
* **plugins:** the bundled evolve skill was wearing a published skill's name ([#243](https://github.com/rotifer-protocol/rotifer-playground/issues/243)) ([56f118e](https://github.com/rotifer-protocol/rotifer-playground/commit/56f118e4f3e4089b527d7ee809acaa5cf5b422e8))
* **plugins:** the CodeBuddy listing named the box after one thing inside it ([#250](https://github.com/rotifer-protocol/rotifer-playground/issues/250)) ([18e7de8](https://github.com/rotifer-protocol/rotifer-playground/commit/18e7de88b0449a4755da10024b545570bf069831))
* **release:** ask GitHub whether the PR can merge, instead of recomputing it ([#245](https://github.com/rotifer-protocol/rotifer-playground/issues/245)) ([2e1604e](https://github.com/rotifer-protocol/rotifer-playground/commit/2e1604e00e3f7cf0117b2df116c1212d8bc9bf3d))
* **test:** ask the loader, don't guess the platform package name ([#253](https://github.com/rotifer-protocol/rotifer-playground/issues/253)) ([2561810](https://github.com/rotifer-protocol/rotifer-playground/commit/2561810c2f25640d6633656f7da3f3b43a91a721))

## [0.19.1](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.19.0...v0.19.1) (2026-08-20)


### Bug Fixes

* **release:** wait for every required check, not just the ones that reported ([#242](https://github.com/rotifer-protocol/rotifer-playground/issues/242)) ([2ea00ee](https://github.com/rotifer-protocol/rotifer-playground/commit/2ea00ee0f298a85f6f2661cccb6ceada3909b0c1))
* **test:** the window fixtures assumed the lockfile was not in the window ([#240](https://github.com/rotifer-protocol/rotifer-playground/issues/240)) ([4369d77](https://github.com/rotifer-protocol/rotifer-playground/commit/4369d77e52c1864ba7c9cf6dac810d5f493c5e51))

## [0.19.0](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.18.0...v0.19.0) (2026-08-20)


### Features

* **identity:** move the official genes to an account someone can sign in to ([#234](https://github.com/rotifer-protocol/rotifer-playground/issues/234)) ([c43c843](https://github.com/rotifer-protocol/rotifer-playground/commit/c43c84365725dda625d8796d2ff51e39bb2f83e4))


### Bug Fixes

* **arena:** a sandbox run is not enough to call a score measured ([#233](https://github.com/rotifer-protocol/rotifer-playground/issues/233)) ([768dd68](https://github.com/rotifer-protocol/rotifer-playground/commit/768dd68f55682f3c9003007b7e1fceca24709077))
* **identity:** the ownership move also trips the version-chain guard ([#236](https://github.com/rotifer-protocol/rotifer-playground/issues/236)) ([f8c5340](https://github.com/rotifer-protocol/rotifer-playground/commit/f8c534010192643bce91252bd520afd6f25e068d))
* **reputation:** an owner who loses every gene keeps a ghost score ([#237](https://github.com/rotifer-protocol/rotifer-playground/issues/237)) ([89cb647](https://github.com/rotifer-protocol/rotifer-playground/commit/89cb647649b173e4b65225e93e6175672f0a3547))

## [0.18.0](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.17.0...v0.18.0) (2026-08-20)


### Features

* **arena:** a leaderboard that says what it knows ([#226](https://github.com/rotifer-protocol/rotifer-playground/issues/226)) ([9732a41](https://github.com/rotifer-protocol/rotifer-playground/commit/9732a41de573adb4a3ca0e744c072dd5244f9ab7))


### Bug Fixes

* **reputation:** R(g) stops spending scores the board already withheld ([#228](https://github.com/rotifer-protocol/rotifer-playground/issues/228)) ([5901cec](https://github.com/rotifer-protocol/rotifer-playground/commit/5901cec700c830c6333f1a0b441c02dcd84198f1))

## [0.17.0](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.16.0...v0.17.0) (2026-08-19)


### Features

* **arena:** apply the invalidation criteria to the board ([#224](https://github.com/rotifer-protocol/rotifer-playground/issues/224)) ([607a2fe](https://github.com/rotifer-protocol/rotifer-playground/commit/607a2febaf6c8b0fe11cb6c062ae307201f2b144))
* **arena:** carry base_fitness and the discount, and stop holding Hybrid to an artifact ([#220](https://github.com/rotifer-protocol/rotifer-playground/issues/220)) ([6fcc73d](https://github.com/rotifer-protocol/rotifer-playground/commit/6fcc73dfbfd4fee07858f8834aa4311a46dd894c))
* **arena:** give legacy rows the provenance their numbers can prove ([#223](https://github.com/rotifer-protocol/rotifer-playground/issues/223)) ([10fb0d4](https://github.com/rotifer-protocol/rotifer-playground/commit/10fb0d4eb63d77e14d6e06a8d93b6fa09ad0513e))
* **cli:** compile honours declared fidelity; F(g) carries the discount it owed ([#222](https://github.com/rotifer-protocol/rotifer-playground/issues/222)) ([ac7d21b](https://github.com/rotifer-protocol/rotifer-playground/commit/ac7d21b4fccd455decedd0578061bb036a85a972))

## [0.16.0](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.15.0...v0.16.0) (2026-08-19)


### Features

* **arena:** the invalidation criteria, as code anyone can run ([#214](https://github.com/rotifer-protocol/rotifer-playground/issues/214)) ([4719278](https://github.com/rotifer-protocol/rotifer-playground/commit/47192784670602907e5d8810ed01e07822f97978))
* **cli:** rotifer unpublish — let an author take a version down ([#217](https://github.com/rotifer-protocol/rotifer-playground/issues/217)) ([d8f411f](https://github.com/rotifer-protocol/rotifer-playground/commit/d8f411faa257aa46a486cb5fd5dc73dde403d34e))
* **telemetry:** publish the evidence that would show double-counting returning ([#218](https://github.com/rotifer-protocol/rotifer-playground/issues/218)) ([46e5122](https://github.com/rotifer-protocol/rotifer-playground/commit/46e5122b44ab83fa4c4cfa1936b361879b409973))


### Bug Fixes

* **genes:** make the bundled corpus compilable again ([#216](https://github.com/rotifer-protocol/rotifer-playground/issues/216)) ([c7b018f](https://github.com/rotifer-protocol/rotifer-playground/commit/c7b018f2014086b183d4b66dfe42edd16b6e256a))

## [0.15.0](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.14.1...v0.15.0) (2026-08-18)


### Features

* **arena:** publish the per-run evidence behind a score ([#212](https://github.com/rotifer-protocol/rotifer-playground/issues/212)) ([1b94a95](https://github.com/rotifer-protocol/rotifer-playground/commit/1b94a9587a6e4262b56e34d77e9ce17e25193a95))
* **arena:** write paths declare how a score was measured, server attests what it can ([#210](https://github.com/rotifer-protocol/rotifer-playground/issues/210)) ([618d51d](https://github.com/rotifer-protocol/rotifer-playground/commit/618d51d1772fcf3795404146e47f4f3a5fe51bc7))
* **db:** give arena_entries provenance and invalidation columns ([#208](https://github.com/rotifer-protocol/rotifer-playground/issues/208)) ([7308f97](https://github.com/rotifer-protocol/rotifer-playground/commit/7308f9722a4ec39a8fd24c0913dc3ebb9ff1fb97))


### Bug Fixes

* **db:** make log_gene_invocation idempotent within 5 seconds ([#204](https://github.com/rotifer-protocol/rotifer-playground/issues/204)) ([0ffc92f](https://github.com/rotifer-protocol/rotifer-playground/commit/0ffc92ff373cfaeaa3229c911d934a52b50918cb))
* **plugin:** lead both dsh rows with the brand ([#209](https://github.com/rotifer-protocol/rotifer-playground/issues/209)) ([dcaf01b](https://github.com/rotifer-protocol/rotifer-playground/commit/dcaf01b9704df4b17f852a5b14c463931c4d8e09))
* **test:** stop the suite reading and deleting the runner's credentials ([#211](https://github.com/rotifer-protocol/rotifer-playground/issues/211)) ([dbd895f](https://github.com/rotifer-protocol/rotifer-playground/commit/dbd895f599892b80f1846d71135a246902013cdc))

## [0.14.1](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.14.0...v0.14.1) (2026-08-18)


### Bug Fixes

* **plugin:** give the dsh bundle an install command that works ([#202](https://github.com/rotifer-protocol/rotifer-playground/issues/202)) ([adf7bc3](https://github.com/rotifer-protocol/rotifer-playground/commit/adf7bc3478303cabc5cd61f5a2b8364887ac2b90))

## [0.14.0](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.13.1...v0.14.0) (2026-08-18)


### Features

* **plugin:** ship the same plugin to DeepSeek Harness as a declarative bundle ([#200](https://github.com/rotifer-protocol/rotifer-playground/issues/200)) ([14ca37a](https://github.com/rotifer-protocol/rotifer-playground/commit/14ca37a5efcc7a50fefecf00d30bb6832d34dcb6))

## [0.13.1](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.13.0...v0.13.1) (2026-08-18)


### Bug Fixes

* **cli:** a test run must not report Gene invocations to production ([#197](https://github.com/rotifer-protocol/rotifer-playground/issues/197)) ([a928f05](https://github.com/rotifer-protocol/rotifer-playground/commit/a928f05a30f6d551f8128de0e867d4c6b1afe775))
* **deps:** update h2 to 0.4.16 for RUSTSEC-2026-0258 ([#196](https://github.com/rotifer-protocol/rotifer-playground/issues/196)) ([70dcafd](https://github.com/rotifer-protocol/rotifer-playground/commit/70dcafd63199fd14282e9bfd5d5e6f6d5fb51c27))
* **plugin:** carry the display name in the manifest instead of a publish flag ([#195](https://github.com/rotifer-protocol/rotifer-playground/issues/195)) ([1464415](https://github.com/rotifer-protocol/rotifer-playground/commit/14644150ed7f0c738071c1513e3fee6e08aa011f))

## [0.13.0](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.12.0...v0.13.0) (2026-08-18)


### Features

* **plugin:** pin and narrow the MCP launch, and publish the same plugin to ClawHub ([#188](https://github.com/rotifer-protocol/rotifer-playground/issues/188)) ([45fd590](https://github.com/rotifer-protocol/rotifer-playground/commit/45fd59043e18206aa5e27525ffc50242028788f9))


### Bug Fixes

* **cli:** let the invocation report settle before process.exit kills it ([#192](https://github.com/rotifer-protocol/rotifer-playground/issues/192)) ([de15509](https://github.com/rotifer-protocol/rotifer-playground/commit/de15509ca2f16606d47ddcdf0044be798c15b58b))
* **db:** mirror migration 20260630123659, applied to production outside this repo ([#187](https://github.com/rotifer-protocol/rotifer-playground/issues/187)) ([bc45d7b](https://github.com/rotifer-protocol/rotifer-playground/commit/bc45d7b385d219e7f660016cf7cd5a167cf2db94))
* **plugin:** put the OpenClaw declaration where OpenClaw reads it ([#190](https://github.com/rotifer-protocol/rotifer-playground/issues/190)) ([5f6890a](https://github.com/rotifer-protocol/rotifer-playground/commit/5f6890a8e5f9a601548e8f61e3a83b842b63f16c))

## [0.12.0](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.11.0...v0.12.0) (2026-08-17)


### Features

* **cli:** record Cloud-installed Gene executions as invocations ([#181](https://github.com/rotifer-protocol/rotifer-playground/issues/181)) ([e0bfffb](https://github.com/rotifer-protocol/rotifer-playground/commit/e0bfffb4b47eb275489f9c6edde0b37959e76d97))


### Bug Fixes

* **arena:** a run only counts as successful when its output honours outputSchema ([#182](https://github.com/rotifer-protocol/rotifer-playground/issues/182)) ([acd74e8](https://github.com/rotifer-protocol/rotifer-playground/commit/acd74e83dcf9ea1d637896b5b0479707e34106db))
* **deps:** restore the four 0.11.0 optional-dependency entries in package-lock ([#185](https://github.com/rotifer-protocol/rotifer-playground/issues/185)) ([8da273c](https://github.com/rotifer-protocol/rotifer-playground/commit/8da273c8d6d04d240caa72b4b3a95249d2c445b4))

## [0.11.0](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.10.2...v0.11.0) (2026-08-17)


### Features

* **cli:** rotifer rollback and rotifer uninstall ([#179](https://github.com/rotifer-protocol/rotifer-playground/issues/179)) ([e2accb9](https://github.com/rotifer-protocol/rotifer-playground/commit/e2accb9177fda91d5e96ac6f0ebc1d2404b75bef))
* **npm:** reserve the unscoped 'rotifer' name ([#176](https://github.com/rotifer-protocol/rotifer-playground/issues/176)) ([dc9ecbf](https://github.com/rotifer-protocol/rotifer-playground/commit/dc9ecbfed0320359a0e806bcab161bd6ab379fe7))


### Bug Fixes

* **ci:** drop registry-url so the reservation publish can use OIDC ([#177](https://github.com/rotifer-protocol/rotifer-playground/issues/177)) ([c05e1a5](https://github.com/rotifer-protocol/rotifer-playground/commit/c05e1a597eddc24a4241e7c65253e1a13d3510f7))
* **ci:** keep the lockfiles in step with release-please bumps ([#173](https://github.com/rotifer-protocol/rotifer-playground/issues/173)) ([33a7e42](https://github.com/rotifer-protocol/rotifer-playground/commit/33a7e4259ca70d0ab09a3739ed99da58c5331e30))
* **supabase:** cast before comparing uuid to text in the arena total_calls trigger ([#180](https://github.com/rotifer-protocol/rotifer-playground/issues/180)) ([22e5941](https://github.com/rotifer-protocol/rotifer-playground/commit/22e594115b5080a06313ca50f3e3e031507e6128))

## [0.10.2](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.10.1...v0.10.2) (2026-08-14)


### Bug Fixes

* **release:** stop VS Code-only changes from bumping the npm package ([#166](https://github.com/rotifer-protocol/rotifer-playground/issues/166)) ([ae256d6](https://github.com/rotifer-protocol/rotifer-playground/commit/ae256d6eb939de50d28704d17cfdc5945702eb27))
* **sandbox:** reject artifacts with an async express() at runtime ([#169](https://github.com/rotifer-protocol/rotifer-playground/issues/169)) ([338322f](https://github.com/rotifer-protocol/rotifer-playground/commit/338322fcc296fe190c4301f5adf09344ed46b5a7))

## [0.10.1](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.10.0...v0.10.1) (2026-08-11)


### Bug Fixes

* **deps:** sync package-lock to the 0.10.0 platform packages ([#157](https://github.com/rotifer-protocol/rotifer-playground/issues/157)) ([78fa0cb](https://github.com/rotifer-protocol/rotifer-playground/commit/78fa0cb8a36819a28f95eea66f670ebf6153f878))
* **release:** make the package-lock sync PR actually open, and fail loudly if it cannot ([#159](https://github.com/rotifer-protocol/rotifer-playground/issues/159)) ([e297ef8](https://github.com/rotifer-protocol/rotifer-playground/commit/e297ef8014552fbcdea75822f9d1cb8ad393f764))

## [0.10.0](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.9.0...v0.10.0) (2026-08-10)


### Features

* **ci:** upload npm audit advisory detail to findings column ([#131](https://github.com/rotifer-protocol/rotifer-playground/issues/131)) ([367f89b](https://github.com/rotifer-protocol/rotifer-playground/commit/367f89b271d70d470783757664f89b8025ce0ea2))
* **p2p:** Identify + connection/memory limits (Milestone B foundations) ([#114](https://github.com/rotifer-protocol/rotifer-playground/issues/114)) ([20258cd](https://github.com/rotifer-protocol/rotifer-playground/commit/20258cdb41dbcb52bd5269fd5ec962c9c9e2b411))
* **p2p:** remember peers across restarts so bootstrap stops being critical ([#155](https://github.com/rotifer-protocol/rotifer-playground/issues/155)) ([b413f0f](https://github.com/rotifer-protocol/rotifer-playground/commit/b413f0f23d49969649488279e8d71f3816a330aa))


### Bug Fixes

* **chat:** cap paper chunks in RAG context so canonical docs keep their slots ([#123](https://github.com/rotifer-protocol/rotifer-playground/issues/123)) ([88dff20](https://github.com/rotifer-protocol/rotifer-playground/commit/88dff20f9148f7d6cddd4875042ae5ae6493a615))
* **chat:** dedupe bilingual twins so they stop burning the non-doc cap ([#146](https://github.com/rotifer-protocol/rotifer-playground/issues/146)) ([d434a7b](https://github.com/rotifer-protocol/rotifer-playground/commit/d434a7b3b9fd1f7b3d48eb0481dd77f153e82b55))
* **chat:** generalise context cap from papers to all non-doc sources ([#124](https://github.com/rotifer-protocol/rotifer-playground/issues/124)) ([7439467](https://github.com/rotifer-protocol/rotifer-playground/commit/7439467ab15e09e169f7fe9a0b176670f63805bc))
* **deps:** bump crossbeam-epoch to 0.9.20 for RUSTSEC-2026-0204 ([#147](https://github.com/rotifer-protocol/rotifer-playground/issues/147)) ([ba0ee3f](https://github.com/rotifer-protocol/rotifer-playground/commit/ba0ee3f862259851db9a9308515379e278edd4e0))
* **deps:** bump quinn-proto to 0.11.15 (RUSTSEC-2026-0185) ([#116](https://github.com/rotifer-protocol/rotifer-playground/issues/116)) ([a0b8d7b](https://github.com/rotifer-protocol/rotifer-playground/commit/a0b8d7bbed90a6ef8b966c8b1cda3a855ef0c6f4))
* **p2p:** drop the unresolvable /dns4/ bootstrap default ([#153](https://github.com/rotifer-protocol/rotifer-playground/issues/153)) ([3fd42a6](https://github.com/rotifer-protocol/rotifer-playground/commit/3fd42a69a44c2f4d7b22a4f9cda8907bc6be43ea))

## [0.9.0](https://github.com/rotifer-protocol/rotifer-playground/compare/v0.8.6...v0.9.0) (2026-06-22)


### Features

* **cli:** add `rotifer doctor` toolchain health command (R5) ([049df01](https://github.com/rotifer-protocol/rotifer-playground/commit/049df012365e990cacd7bde1b909ca73485fc771))
* **migrations:** Sprint C Phase 4 — content_hash server-side validation ([b14740e](https://github.com/rotifer-protocol/rotifer-playground/commit/b14740e7c5c68dbae2297ec251d251ad063b8c11))
* **migrations:** Sprint C Phase 5 — protocol consistency v09 baseline ([6d40b06](https://github.com/rotifer-protocol/rotifer-playground/commit/6d40b0686fd31ed69de1e8545f318937670e5a24))
* **migrations:** Sprint C Phase 6a — downloads RLS hardening ([901263a](https://github.com/rotifer-protocol/rotifer-playground/commit/901263a9d737cb66db5900f241f237b50d4fc655))
* **network:** run a real libp2p node from the CLI (phase 1) ([#80](https://github.com/rotifer-protocol/rotifer-playground/issues/80)) ([1fe6f29](https://github.com/rotifer-protocol/rotifer-playground/commit/1fe6f29035f7be13c96ab5b1b416d72d7636483d))
* **network:** run the P2P node as a background daemon with a local control channel (phase 2) ([#81](https://github.com/rotifer-protocol/rotifer-playground/issues/81)) ([710a4b4](https://github.com/rotifer-protocol/rotifer-playground/commit/710a4b4cc85c510ba28aa385e90ccd372832ba94))
* **p2p:** implement application-layer security primitives (flood/replay/eclipse/sybil) ([#82](https://github.com/rotifer-protocol/rotifer-playground/issues/82)) ([a0f8a7e](https://github.com/rotifer-protocol/rotifer-playground/commit/a0f8a7e5641cabd011b76ff9f58604b32df1b0ac))
* **p2p:** LAN demo plumbing — configurable listen host (--host) + announcement propagation (`network received`) ([#87](https://github.com/rotifer-protocol/rotifer-playground/issues/87)) ([d94f540](https://github.com/rotifer-protocol/rotifer-playground/commit/d94f54015c1d660ba5f404cc99f03f13d4fd7842))
* **p2p:** real libp2p networking — identity, swarm, Kademlia DHT, GossipSub ([#74](https://github.com/rotifer-protocol/rotifer-playground/issues/74)) ([59573f3](https://github.com/rotifer-protocol/rotifer-playground/commit/59573f38d13e47d854109b4bfaab626b03b9e9ca))
* **p2p:** verify message signatures + authenticate gossip publishers (§3.2 iteration 2) ([#83](https://github.com/rotifer-protocol/rotifer-playground/issues/83)) ([44a5c66](https://github.com/rotifer-protocol/rotifer-playground/commit/44a5c662905b502d73f5a99b3c6d27a7240e0851))
* **p2p:** wire the per-peer rate limiter into the live gossip receive path (§3.2 iteration 3) ([#84](https://github.com/rotifer-protocol/rotifer-playground/issues/84)) ([027e322](https://github.com/rotifer-protocol/rotifer-playground/commit/027e3227e0188c489314feeb1fd9154a516b5d09))
* **phenotype:** add Hybrid Fidelity types — externalDependencies / simulationSpec / degradationSpec + FIDELITY_DISCOUNT (v0.9 §3.11) ([9403f5b](https://github.com/rotifer-protocol/rotifer-playground/commit/9403f5b1a8b6820f006fb6283bcf431530197171))
* **phenotype:** align gene transparency field to spec §4.2 (F8, §3.3) ([#86](https://github.com/rotifer-protocol/rotifer-playground/issues/86)) ([c725c2f](https://github.com/rotifer-protocol/rotifer-playground/commit/c725c2f95eee5efc5d2f596755d6039d2f0a0a08))
* **phenotype:** validator + shared types + publish/agent-list updates ([22f2ca8](https://github.com/rotifer-protocol/rotifer-playground/commit/22f2ca8a33ef1f385ea5f4917fc2a42b5bb36623))
* **publish:** auto V(g) badge upload + --skip-vg flag (Phase 1) ([4c47cce](https://github.com/rotifer-protocol/rotifer-playground/commit/4c47ccebc49f1c342c9b915b2cd4ded8c494b29e))
* **supabase:** close v0.9 stage-2 B-R6 — pgTAP all-green + TS E2E live + CI blocking ([242e413](https://github.com/rotifer-protocol/rotifer-playground/commit/242e4138a5b862ce2f282896f9c7d6f88577bd50))
* **supabase:** impl compute_path_diversity (v0.9 stage 2 B-R5, Ramanujan R1) ([c93950f](https://github.com/rotifer-protocol/rotifer-playground/commit/c93950f5f43661aa51867a3a3e640a2ba390eca1))
* **supabase:** impl get_display_fitness + get_display_weight (v0.9 stage 2 B-R3+R4) ([5e4b0e1](https://github.com/rotifer-protocol/rotifer-playground/commit/5e4b0e125b79e7e5dc4fca01be5ec41a695e84dc))
* **supabase:** impl reset_season() RPC + activate pg_cron (v0.9 stage 2) ([2616878](https://github.com/rotifer-protocol/rotifer-playground/commit/261687814c02f370beb792a39551169f79d0ae7a))
* **v0.8.8 §3.4 §3.7:** default-publish config + V(g) gate coverage ([c7983de](https://github.com/rotifer-protocol/rotifer-playground/commit/c7983de4a0f2f0ce973344d5eb6130f1e81dd4bd))


### Bug Fixes

* align degradationBehavior + failureSemantics with Rust IR PascalCase 5 enum ([099540c](https://github.com/rotifer-protocol/rotifer-playground/commit/099540c49969f86894297a00c1e6bfa42c7d0a94))
* **auth:** bind the CLI login callback to the allow-listed localhost:9876 ([#77](https://github.com/rotifer-protocol/rotifer-playground/issues/77)) ([b6179b4](https://github.com/rotifer-protocol/rotifer-playground/commit/b6179b4d046ff96a204fdb42e2225a7844027d1d))
* **cli/versions:** accept @owner/name single-arg form for ref-syntax parity ([95298b8](https://github.com/rotifer-protocol/rotifer-playground/commit/95298b86819d3a6d7d6fb073d8cdf2161c3c6b6d))
* **cli:** parse @owner/name in gene refs + route reputation + refresh whoami ([460225e](https://github.com/rotifer-protocol/rotifer-playground/commit/460225ec40ca6b4691e3f891adfd74c9a210bf00))
* **cloud/badge:** align uploadSafetyBadge URL with worker /safety route ([848c571](https://github.com/rotifer-protocol/rotifer-playground/commit/848c5714394b4a49f091cac00fe7e61c204b2bba))
* **compile:** async-express guard at compile time + offline toolchain preflight ([#57](https://github.com/rotifer-protocol/rotifer-playground/issues/57), [#58](https://github.com/rotifer-protocol/rotifer-playground/issues/58)) ([c690a9a](https://github.com/rotifer-protocol/rotifer-playground/commit/c690a9a7643024b5eff736f91042c63f4cc9ca02))
* **db:** make search_path pin migration replay-safe ([bc1828e](https://github.com/rotifer-protocol/rotifer-playground/commit/bc1828e25880f74d2fa6bdf729f4fd6daf8f74de))
* **db:** unfreeze reputation cron silent failure ([b0c7fc3](https://github.com/rotifer-protocol/rotifer-playground/commit/b0c7fc3b94519deea2125ed9a5ad2aabd03a60d9))
* **deps:** align @napi-rs/cli constraint to ^3.7.0 to match lockfile ([#54](https://github.com/rotifer-protocol/rotifer-playground/issues/54)) ([dada9f7](https://github.com/rotifer-protocol/rotifer-playground/commit/dada9f73aac97d914404862c377d4812026f71b7)), closes [#52](https://github.com/rotifer-protocol/rotifer-playground/issues/52)
* **deps:** upgrade wasmtime 42.0.2 -&gt; 43.0.2 (RUSTSEC-2026-0114) ([20bb434](https://github.com/rotifer-protocol/rotifer-playground/commit/20bb4343821ef760a3754a7e010f83bdd818adb2))
* **genes:** polymarket-scanner transparency "Open" → "OPEN" (v0.3.1, F8) ([#105](https://github.com/rotifer-protocol/rotifer-playground/issues/105)) ([894db2d](https://github.com/rotifer-protocol/rotifer-playground/commit/894db2d29112e25719197c4618494a76c5bc00bf))
* **hello:** block incompatible fallback genome for web3 template ([6e24098](https://github.com/rotifer-protocol/rotifer-playground/commit/6e24098267fed0e8d9d7c887e7f63bc21effc300))
* **phenotype:** widen readonly enum arrays for .includes() type compat ([a762070](https://github.com/rotifer-protocol/rotifer-playground/commit/a762070487ecf45780877fe841e2bc2be7058b62))
* **release:** cover the 3 stale version surfaces in release-please ([#108](https://github.com/rotifer-protocol/rotifer-playground/issues/108)) ([5a5d75b](https://github.com/rotifer-protocol/rotifer-playground/commit/5a5d75b4788c2e772db04c1ad255821e85424062))
* **sandbox:** surface guest stderr on WASM trap (R4) ([95a529b](https://github.com/rotifer-protocol/rotifer-playground/commit/95a529bba601021285ff83455cb848502ea72a56))
* **supabase:** unblock publish — qualify digest() + degrade hash mismatch to warning ([98d1fd5](https://github.com/rotifer-protocol/rotifer-playground/commit/98d1fd5c4a2796139e5664663345ad1927702fe9))
* **vscode:** use vortex logo for plugin icons ([e95731e](https://github.com/rotifer-protocol/rotifer-playground/commit/e95731ea1a763463001399993614b58b5fb249c1))
* **wrap:** route validation errors through structured formatter, no stack-trace leak ([#55](https://github.com/rotifer-protocol/rotifer-playground/issues/55)) ([e705323](https://github.com/rotifer-protocol/rotifer-playground/commit/e70532362c5d1a4591a429ef75cb1e1afed1ec0c)), closes [#51](https://github.com/rotifer-protocol/rotifer-playground/issues/51)

## [0.8.6] - 2026-04-16

### Fixed

- **Javy async Gene WASM trap** — `express()` returning a Promise now produces a clear error message instead of an opaque "Pending jobs in the event queue" WASM trap ([#29](https://github.com/rotifer-protocol/rotifer-playground/pull/29))
- **Compile cache ignoring source changes** — `rotifer compile` now prefers TypeScript/JavaScript source files over a stale `gene.wasm`; previously, the existing WASM was reused even after source edits ([#29](https://github.com/rotifer-protocol/rotifer-playground/pull/29))
- **irHash serialization mismatch** — phenotype `irHash` field is now stripped before passing to the native Rust binding, preventing serde deserialization failures on the native execution path ([#29](https://github.com/rotifer-protocol/rotifer-playground/pull/29))
- **WASM sandbox fuel exhaustion** — default `max_fuel` increased from 1M to 500M; default memory raised to 256 MiB; timeout extended to 60s — Javy/QuickJS Genes no longer hit "fuel exhausted" on trivial workloads ([#29](https://github.com/rotifer-protocol/rotifer-playground/pull/29))

### Added

- **Native addon distribution** — prebuilt native bindings are now shipped via platform-specific npm packages (`@rotifer/playground-darwin-arm64`, `-darwin-x64`, `-linux-x64-gnu`, `-win32-x64-msvc`); `npm install` automatically pulls the correct binary for the user's platform ([#28](https://github.com/rotifer-protocol/rotifer-playground/issues/28))
- **`napi-build.yml` reusable workflow** — 4-platform matrix build for native addons (macOS ARM/x64, Linux x64, Windows x64)
- **`sync:native-versions` script** — one-command version sync across all platform packages
- **Version alignment checks** — `verify:versions` now validates platform package versions and `optionalDependencies` consistency

### Changed

- Release pipeline now builds and publishes native addons before the main package (`native-build → publish-native → publish`)
- CI `rust-check` job now verifies napi compilation with `@napi-rs/cli` instead of `cargo build`

## [0.8.5] - 2026-04-08

### Changed

- **Public release-line consolidation** — aligned the CLI package with the current public `v0.8.5` release line across rotifer.dev, IDE/plugin distribution surfaces, and MCP installation metadata
- **Shipped v0.8.x surface clarified** — current release messaging now reflects the already-shipped Skill→Gene migration path, CLI UX refresh, version update notifications, and related ecosystem-facing improvements from the `v0.8.x` cycle
- **Reserved version gap documented** — `v0.8.2` to `v0.8.4` remain reserved internal iteration numbers rather than retroactively published public releases

## [0.8.1] - 2026-03-27

### Added

- **API Apocalypse experiment** — chaos engineering benchmark proving fitness-based auto-failover: Rotifer Agent 83.3% source uptime vs Baseline 33.3% (2.5x improvement, 0 human intervention)
- **DomainFailoverEngine** — L2 Calibration auto-failover integrated into core runtime with TryPool composition type
- **`rotifer wrap --from-clawhub`** — one-command Skill→Gene migration tool (100% coverage on Top 50 ClawHub Skills)
- **V(g) Top 50 scan report** — automated quality analysis of ClawHub ecosystem (38,141 Skills, 25M downloads)
- **AI documentation quality** — 19-question Golden QA test suite + LLM-as-Judge evaluator with CI integration
- 6 weather parser genes for experiment (3 sources × 2 format versions)
- SVG animation generator with rotifer.dev design system alignment
- Experiment results with 3 reproducible runs

### Changed

- **Reputation model alignment** — cold-start `R(g)` now uses phase-based weights (W0/W1/W2) instead of a fixed 0.5/0.3/0.2 split
- **Creator reputation** — now uses a diminishing-returns weighted sum of positive gene reputations, instead of a plain average
- **Arena safety scoring** — `V(g)` now incorporates the shipped static security scanner (`Security_Leak_Risk`) during `arena submit`

## [0.8.0] - 2026-02-17

### Added

- **Supabase deep security audit** — RLS validation, API auth bypass testing, Edge Function permission boundaries across all v0.7 attack surfaces
- **WASM malicious payload protection** — IR upload payload validation (size limits, magic bytes verification, custom section whitelist)
- **IR sandbox escape testing** — 15+ WASM security tests (memory OOB, infinite loops, host function abuse, resource exhaustion)
- **P2P Protocol RFC** — complete design document covering transport, discovery, messaging, security model, and Cloud binding collaboration
- **Security Checklist mechanism** — reusable version-level security checklist template integrated into CI and release flow
- **Epoch automation** — pg_cron daily reputation computation + monthly decay trigger with idempotent `compute_all_reputations()` RPC
- **ContributionMetrics data model** — anti-manipulation ready contribution tracking (`gene_invocation_log`, `gene_contribution_metrics`)
- **V(g) Security Leak Risk data collection** — leak risk scoring pipeline for badge system
- **LLM-Native Gene Phenotype standard** — Prompt Gene + Guard Gene phenotype definitions
- **Evolution API Level 1.5** — Gene recommendation + Arena observability REST endpoints
- **V(g) Safety Badge data pipeline** — automated safety badge generation and caching
- **AI documentation assistant** — RAG-powered chat component on rotifer.dev with rate limiting, content filtering, and analytics
- **WebMCP Phase 1** — 14 Agent-ready marketplace tools (10 read + 4 write with auth + confirm)
- **ICP filing preparation** — China market regulatory prerequisites
- **Spec evolutionary sync** — CP-1 Code→Spec reverse audit alignment

### Changed

- Infrastructure resilience improvements (Forgejo migration preparation, GitLab→GitHub CI migration)
- Release flow updates per ADR-097 (ops-release layer registry)

## [0.7.9] - 2026-03-20

### Added

- **V(g) security scanner** — static analysis engine with 7 rules (S-01 to S-07) detecting dynamic code execution, system commands, obfuscation, external communication, env access, persistent connections, and filesystem operations
- **CLI: `rotifer vg [path]`** — run V(g) security scan on any Skill or Gene directory with `--json`, `--all`, `--id` options
- **Security grade mapping** — A/B/C/D/? grades based on finding severity (CRITICAL/HIGH/MEDIUM)
- Scanner supports `.ts`, `.js`, `.mts`, `.mjs`, `.cjs`, `.tsx`, `.jsx`, `.sh`, `.py` file extensions
- Comment-line skipping in scan results to reduce false positives
- Unit tests: scanner rules (S-01 to S-07 pattern matching) and scanner core (grade computation, file collection, edge cases)

## [0.7.8] - 2026-02-17

### Added

- **Security tests** — 5 new test files: path traversal, command injection, token safety, malicious input, credential file permissions (18 tests)
- **Resilience tests** — 4 new test files: network failure, API error handling, token expiry, config corruption (15 tests)
- **Edge case tests** — 5 new test files: Unicode names, concurrent operations, duplicate args, version handling, empty project (16 tests)
- Test coverage: 275 → **332 tests** (+57)

## [0.7.7] - 2026-02-17

### Added

- **CLI: `rotifer info <gene-ref>`** — display detailed gene information (description, domain, version, fitness, reputation)
- **CLI: `rotifer list`** — list local genes in current project with optional `--domain` filter
- **CLI: `rotifer run <gene-name>`** — directly execute a single gene with WASM sandbox or Node.js fallback
- **CLI: `rotifer versions <owner> <name>`** — display version history chain for a gene
- **CLI: `rotifer whoami`** — show current authentication status
- **CLI: `rotifer stats <gene-ref>`** — display download statistics for a gene
- **CLI: `rotifer compare <id...>`** — compare 2-5 genes side by side by fitness and reputation

### Changed

- **VSCode Extension v0.7.6** — full feature catch-up from v0.1.1: 26 commands, 3 tree views, 5 webview panels, OAuth auth manager

## [0.7.6] - 2026-03-19

### Fixed

- **Gene list deduplication** — `rotifer search` and VSCode extension now return only the latest version per (owner, name) pair, fixing inflated gene counts and duplicate entries
- **SQL root fix** — `search_genes` RPC uses `DISTINCT ON (owner_id, name)` CTE to deduplicate at database level

## [0.7.5] - 2026-02-17

### Added

- **Gene Domain Registry** — new `domain_registry` table reduces domain fragmentation across the ecosystem
  - `rotifer wrap` now suggests domains from local cache when `--domain` is omitted (interactive TTY selection, non-TTY auto-pick)
  - Domain format validation on `rotifer publish` (`a-z0-9` + dots only)
  - Local domain cache (`~/.rotifer/domain_registry.json`) auto-refreshed after `publish` and `install`
- **Gene Version Chain** (Spec §4.6) — `previous_version_id` and `changelog` fields on `genes` table
  - `rotifer publish --changelog "..."` stores version notes (max 500 chars)
  - `previous_version_id` auto-linked on publish (queries latest same-name gene by owner)
  - Trigger-based RLS: `previous_version_id` must reference same-owner gene
  - Backfill migration links existing multi-version genes chronologically
- **Domain suggest RPC** — `suggest_domain(description)` full-text search on `domain_registry`

### Fixed

- **Windows login compatibility** — `rotifer login` now opens the browser correctly on Windows; previously `start` treated the URL as a window title instead of a URI
- Extract `openBrowser()` utility to `src/utils/open-browser.ts` for cross-platform browser launching (win32/darwin/linux)

## [0.7.0] - 2026-03-01

### Added

- **Hybrid Gene Type** — genes can now access external networks through a controlled gateway
  - `rotifer init --fidelity hybrid` generates template with `network` config
  - `rotifer compile` supports Hybrid Gene (WASM + network declarations)
  - `rotifer publish` validates `allowedDomains` (no localhost/private IPs)
  - Network Gateway: domain whitelist, 30s timeout, 1MB response limit, 10 req/min rate limit
  - 11 unit tests for gateway security; 7 publish validation tests
- **Dogfooding: AI Documentation Assistant** — 4-Gene pipeline built with Rotifer
  - `doc-retrieval` (Hybrid) — pgvector semantic search over documentation
  - `answer-synthesizer` (Hybrid) — LLM-agnostic answer generation (Claude / OpenAI)
  - `source-linker` (Native) — maps sources to documentation URLs
  - Supabase pgvector setup with `doc_chunks` table and `match_documents` RPC
  - Document indexing script (`index-docs.ts`) for Markdown chunking + embedding
  - 8 E2E tests for 4-Gene Seq pipeline
- **IDE Plugin v1** (Cursor / VS Code)
  - Gene Explorer sidebar: search, filter, view details, install
  - One-click gene installation
  - Reputation score display per gene
  - Right-click "Publish as Rotifer Gene" for SKILL.md files
- **Gene Composition Pipeline Hardening**
  - Schema compatibility pre-check at `rotifer agent create`
  - Error propagation and pipeline interruption handling
  - Pipeline execution logging (input/output/duration per gene)
  - 5 schema compatibility tests
- **Supabase Security Audit** (Vision Roadmap D6)
  - RLS policy verification for all tables (zero bypass)
  - SECURITY DEFINER function audit (no privilege escalation)
  - WASM upload malicious payload protection
  - API authentication bypass testing
  - Reusable security test scripts

### Changed

- CLI now supports `--fidelity hybrid` in `init` and `wrap` commands
- `rotifer agent run` injects NetworkGateway for Hybrid Gene execution
- Test count: 254 → 300+ (Rust + TS combined)

[0.7.0]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.7.0

## [0.6.5] - 2026-02-27

### Added

- **RotiferBinding Trait** — protocol binding abstraction layer
  - `binding_id()`, `metering_unit()`, `capabilities()`, `execute_ir()`, `negotiate()`
  - `LocalBinding` — refactored existing WasmtimeSandbox as a binding implementation
  - `Web3MockBinding` — simulates Web3 environment constraints (Gas metering, 16MB memory, 5s timeout, no filesystem)
  - Capability Negotiation: Compatible / PartiallyCompatible / Incompatible paths
  - `IrTransferRequest` and `transfer_ir()` for cross-binding IR transfer API
- **Cross-Binding Integration Tests** — 9 tests (planned 6 + 3 bidirectional transfer)
  - Basic interop, resource over-limit rejection, optional extension functions
  - Required function missing rejection, Gas metering validation, no-IR degradation
- **IR Specification Feedback Report** — `ir-cross-binding-validation.md`

### Changed

- Rust test count: 224 → 254 (+30 binding tests)
- All existing tests pass unchanged (refactoring preserved behavior)

[0.6.5]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.6.5

## [0.6.0] - 2026-02-25

### Added

- **Gene Detail Pages** — each gene now has a dedicated page at `/genes/[name]/` with:
  - README rendering (Markdown→HTML via `marked`)
  - Phenotype schema display (inputSchema/outputSchema)
  - Stats: version, R(g), downloads, WASM size, dates
  - One-click install command copy
- **Creator Profile Pages** — each creator has a page at `/developers/[user]/` with:
  - R(d) reputation score and stats grid
  - Published gene list with links
- **Gene Registry Upgrade** — `/genes/` listing page now fetches from Cloud API
  - Client-side search (name + description fuzzy match)
  - Domain and fidelity filters
  - Sort by newest / reputation / downloads
  - Fallback to static `genes.json` if Cloud API unavailable
- **Cloud API Extensions** (Supabase Migration 004):
  - `genes.readme` column — stores gene README as Markdown text
  - `arena_history` view — gene fitness over time
  - `get_gene_stats()` RPC — download stats by time period (7d/30d/90d)
- **CLI `publish` README Support** — `rotifer publish` automatically reads and uploads `README.md`
- **5 Native Showcase Genes**:
  - `text-summarizer` (text.summarize) — extractive text summarization
  - `json-validator` (data.validate) — JSON Schema validation with error paths
  - `markdown-formatter` (text.format) — Markdown formatting normalization
  - `code-complexity` (code.analyze) — cyclomatic complexity analysis
  - `url-extractor` (text.extract) — URL extraction and categorization
- **Gene Cold Start** — 51 total genes (40 Skill Import + 5 Genesis + 5 Native showcase + 1 test)
- **Bilingual Pages** — all new pages available in English and Chinese

### Changed

- Gene detail README rendering now converts Markdown to HTML at build time using `marked`

## [0.5.5] - 2026-02-25

### Added

- **L0 Kernel Gate** — pre-execution permission enforcement
  - `L0Gate::check()` validates domain whitelist, resource limits, network and filesystem access
  - `AuditLog` — append-only execution audit trail (`.rotifer/audit.jsonl`)
  - NAPI `l0Check()` — run L0 gate checks from the CLI without executing the gene
- **WASM Sandbox Execution Path** — compiled genes now execute through the real WASM sandbox
  - NAPI `executeGene()` — accepts WASM bytes + input, returns output + `fuel_consumed` / `memory_peak_kb` / `duration_ms`
  - `rotifer test` prefers WASM sandbox for compiled genes; Node.js fallback for uncompiled genes
  - `rotifer agent run` prefers WASM sandbox; new `--no-sandbox` flag for explicit Node.js fallback
  - `rotifer arena submit` runs genes in WASM sandbox for real F(g) metrics
- **AlgebraExecutor CLI Integration** — Rust five-operator algebra engine now exposed to CLI
  - NAPI `executeAlgebra()` — accepts algebra expression JSON + gene WASM map
  - `rotifer agent create --composition <Seq|Par|Cond|Try>` — configure composition type
  - `rotifer agent create --par-merge <first|concat|merge>` — merge strategy for Par branches
- **Compliance Testing** — `rotifer test --compliance` runs 6 structural checks:
  - C1: Sandbox execution verification (sandbox_type == "wasm")
  - C2: Fuel consumption verification (fuel_consumed > 0)
  - C3: L0Gate pre-execution check pass
  - C4: Phenotype field completeness (Gene Standard)
  - C5: F(g) computability (all input metrics available)
  - C6: IR segment integrity (custom WASM sections)

### Changed

- **F(g) Fitness Formula** — switched from additive to multiplicative model (formula_version: 2)
  - Old: `(success_rate + latency_score + resource_efficiency) / 3`
  - New: `[S_r · ln(1+C_util) · (1+R_rob)] / [L · Cost]`
  - Any single zero-valued factor drives the entire score to zero (no mutual compensation)
  - Added `coverage` and `robustness` metrics (default 0.5 when unmeasured)
  - `formula_version` field enables v1/v2 coexistence in Arena
- **ConstraintSet** — added `Serialize`/`Deserialize` derives for JSON round-tripping
- Test count: 165 → 188 TS tests; 224 Rust tests (all passing)

[0.5.5]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.5.5

## [0.5.0-alpha.2] - 2026-02-24

### Added

- **Skill Import Pipeline** — convert AI IDE skills into Rotifer genes
  - `rotifer scan --skills [--skills-path <dir>]` — discover SKILL.md files with YAML frontmatter
  - `rotifer wrap <name> --from-skill <path>` — wrap a SKILL.md as a gene with phenotype
  - Metadata-only publishing: Wrapped genes upload phenotype + SKILL.md without WASM
  - Supports Cursor, Codex, and custom skill directories
  - 21 new tests (E2E + unit) for scan --skills, wrap --from-skill, and parseSkillFrontmatter
  - Skill Import Guide (EN + ZH) added to website documentation

### Changed

- Test count: 144 → 165 (21 new skill import tests)
- Website sidebar updated with Skill Import guide

[0.5.0-alpha.2]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.5.0-alpha.2

## [0.5.0-alpha.1] - 2026-02-23

### Added

- **Reputation System** — measurable trust signals for genes and creators
  - Gene reputation R(g) = α·Arena + β·Usage + γ·Stability (weights: 0.5, 0.3, 0.2)
  - Creator reputation R(d) initially launched as a plain average of gene reputations plus community bonus
  - Time-based decay (5%/month, floor at 0.01) prevents reputation stagnation
  - `rotifer reputation <gene-ref>` — view gene reputation breakdown
  - `rotifer reputation --mine` — view your creator reputation
  - `rotifer reputation --leaderboard` — top creators ranked by reputation
  - Database migration `003_reputation.sql` with `gene_reputation` and `developer_reputation` tables
  - Server-side reputation computation via PostgreSQL functions
  - Reputation leaderboard API (`get_reputation_leaderboard()`)

- **P2P Gene Network Scaffolding** — CLI scaffolding and type definitions for future decentralized gene discovery (stub only; no libp2p integration yet)
  - P2P type system: `GeneAnnouncement`, `DiscoveryQuery`, `DiscoveryResponse`, `NodeStatus`
  - Network protocol names reserved: `/rotifer/gene-discovery/1.0.0`, `/rotifer/gene-announce/1.0.0`
  - `rotifer network start` — initialize local network config (stub; no actual P2P node)
  - `rotifer network peers` — list bootstrap peer entries (stub; no live discovery)
  - `rotifer network search` — placeholder; falls back to Cloud Registry
  - `rotifer network status` — show network configuration
  - Architecture: Cloud-first hybrid model designed; P2P layer to be implemented in a future version

- **Comprehensive Documentation** — 18 new documentation pages
  - CLI Command Reference: Gene Lifecycle, Arena, Cloud, Agent (EN + ZH)
  - Gene Development Guide (EN + ZH)
  - Composition Patterns Guide with Seq/Par/Cond/Try examples (EN + ZH)
  - Cloud Binding Guide (EN + ZH)
  - Architecture Deep-Dive Guide (EN + ZH) — URAA, Fitness, Arena, Agent lifecycle, Bindings
  - Examples: Hello Gene, HTTP Fetch, Search+Summarize Pipeline, MCP Migration (EN + ZH)
  - Updated Astro sidebar with Guides, CLI Reference, and Examples sections

### Changed

- CLI now has 20 commands (was 16): added `reputation`, `network start/peers/search/status`
- `rotifer search` now shows R(g) reputation score column
- `rotifer arena list --cloud` now shows R(g) reputation alongside F(g) and V(g)
- Rust core: added `reputation` and `p2p` modules (p2p module contains type definitions and stubs only)
- Test count: 114 → 144 (30 new tests for reputation, network scaffolding, and cloud reputation)

[0.5.0-alpha.1]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.5.0-alpha.1

## [0.4.0-alpha.1] - 2026-02-23

### Added

- **Cloud Binding** — Cross-creator gene sharing via Supabase-backed REST API
  - `rotifer login` — GitHub OAuth authentication via PKCE flow
  - `rotifer logout` — Clear cloud credentials
  - `rotifer publish <gene>` — Upload gene (phenotype + WASM) to cloud registry, saves `.cloud-manifest.json`
  - `rotifer search [query]` — Search and browse cloud gene registry
  - `rotifer install <gene-ref>` — Download gene from cloud to local project
  - Cloud Binding REST API specification (`docs/cloud-binding-api.md`)
  - Supabase database schema with RLS policies (see `supabase/README.md` for self-hosting guide)

- **Cloud Arena** — Remote Arena competition across creators
  - `rotifer arena submit --cloud` — Submit gene to cloud Arena
  - `rotifer arena list --cloud` — View cloud Arena rankings
  - `rotifer arena watch --cloud` — Real-time cloud ranking updates (polling)
  - Server-side ranking via PostgreSQL `get_arena_rankings()` function

- **Endpoint-agnostic design** — CLI supports custom Cloud Binding endpoints via `--endpoint` flag or `~/.rotifer/cloud.json` config, enabling multiple deployments (global Supabase + rotifer.cloud China)

- **Supabase CLI integration** — Project linked via `supabase link`, migrations pushed via `supabase db push`

### Fixed

- OAuth login: switched from implicit flow to PKCE for secure token exchange
- Missing user profile on first login: added DB trigger `handle_new_user()` with backfill
- `rotifer publish` now saves `.cloud-manifest.json` in source gene dir for `arena submit --cloud` linkage
- `rotifer publish` graceful error when not logged in (was showing raw stack trace)

### Changed

- CLI description updated from "local development environment" to "development environment" (reflects cloud capabilities)
- Test count: 91 → 114 (23 new cloud tests)

## [0.3.0-alpha.1] - 2026-02-17

### Added

- **TS→WASM Auto-Compilation** (Javy / QuickJS)
  - `rotifer compile` auto-detects `index.ts`/`index.js` and compiles to Native WASM
  - Pipeline: TypeScript → esbuild (bundle) → WASI shim → Javy (QuickJS→WASM) → Rotifer IR
  - New `--lang <ts|wasm>` option to force compilation mode
  - `javy-compiler.ts` utility with `compileTypeScriptToWasm()`, `isJavyAvailable()`, `findGeneSource()`

- **WASI Sandbox Support** (`rotifer-core::sandbox`)
  - `WasmtimeSandbox` now supports both Direct (`express`) and WASI (`_start`) execution modes
  - Minimal WASI shim: 9 host functions (`fd_read`, `fd_write`, `clock_time_get`, etc.)
  - Auto-detection of WASI vs Direct modules at runtime

- **IR Verifier Updates**
  - SIMD instructions downgraded from error to warning (common in Javy/QuickJS output)
  - `_start` entry point accepted alongside `express` for WASI modules

### Changed

- Test coverage: 180 → 275 tests (91 TypeScript + 184 Rust)
- Documentation updated across README (EN/ZH), Getting Started (EN/ZH), and website

[0.3.0-alpha.1]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.3.0-alpha.1

## [0.2.0-alpha.1] - 2026-02-22

### Added

- **IR Compiler Pipeline** (`rotifer-core::compiler`)
  - Custom section builders: `rotifer.version`, `rotifer.phenotype`, `rotifer.constraints`, `rotifer.metering`
  - WASM injector with `irHash` computation (SHA-256 content-addressable)
  - IR verifier: static validation of exports, prohibited instructions, memory limits
  - 5 genesis WASM genes: `echo`, `wrap`, `search`, `summarize`, `translate`
  - `compile_to_ir()` API and NAPI bindings

- **CLI Upgrades**
  - `rotifer compile` — full IR compilation with `--wasm`, phenotype update, `compile-result.json`
  - `rotifer arena watch` — real-time ranking diff monitoring with summaries

- **Algebra Parallelism**
  - `Par` operator now uses true CPU parallelism via `std::thread::scope`

- **crates.io Publish**
  - `rotifer-core` published as an independent Rust crate
  - Full rustdoc coverage on all 150+ public API items

### Fixed

- `Try` operator: now correctly returns primary result on success (was re-executing)

### Changed

- Test coverage: 22 → 180 tests across 10 modules (including edge cases)
- Dependencies: added `rmp-serde`, `wasm-encoder`, `wasmparser`

[0.2.0-alpha.1]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.2.0-alpha.1

## [0.1.0-alpha.1] - 2026-02-20

### Added

- **CLI Framework**: 10 commands covering the full gene development lifecycle
  - `rotifer init` — project scaffolding with Genesis genes and Arena preview
  - `rotifer scan` — discover candidate functions from source files
  - `rotifer wrap` — wrap functions as Rotifer genes (Phenotype generation)
  - `rotifer test` — L2 sandbox testing (schema validation, conformance)
  - `rotifer compile` — Phenotype validation and gene fingerprinting
  - `rotifer arena submit` — submit genes to local Arena with admission gate
  - `rotifer arena list` — view Arena rankings with F(g), V(g), Fidelity
  - `rotifer arena watch` — placeholder for live ranking updates
  - `rotifer agent create` — create Agents with gene genomes
  - `rotifer agent list` — view all registered Agents

- **Rust Core** (`rotifer-core` crate)
  - Type system: Context, GeneResult, Phenotype, Gene, Agent, AlgebraExpr
  - WASM Sandbox via wasmtime (resource limits, fuel consumption, epoch interruption)
  - Arena Engine: local ranking with fitness-based sorting
  - Algebra Executor: Seq, Par, Cond, Try, Transform composition
  - Fitness computation: simplified F(g) model with admission threshold
  - SQLite storage: genes, agents, arena entries
  - Gene compiler: scan, wrap, schema generation
  - Agent manager: create, activate, terminate lifecycle

- **napi-rs Bridge** (`rotifer-napi` crate)
  - PlaygroundBinding facade: 10 methods bridging Rust Core to TypeScript
  - Source file scanner (TypeScript + Rust function detection)

- **5 Genesis Genes** (pre-installed with every project)
  - `genesis-web-search` — full search with multiple results
  - `genesis-web-search-lite` — lightweight single-answer search
  - `genesis-file-read` — local file reading
  - `genesis-code-format` — source code formatting
  - `genesis-l0-constraint` — L0 sandbox constraint checker

- **Developer Experience** (ADR-11)
  - Three-act Demo: Wow (30s) → Aha (5min) → Hooked (30min)
  - Rust-style error messages with codes, suggestions, and docs links
  - Automatic pre-submission testing on `arena submit`
  - Deterministic Arena rankings from Phenotype content hashing

- **Templates**: gene scaffold + Seq/Par composition examples
- **Test Suite**: 29 tests (unit + E2E) covering full lifecycle
- **demo.sh**: automated three-act demonstration script

### Protocol Compliance

Implements Rotifer Protocol Specification (Frozen):
- **Full**: Phenotype, AlgebraExpr, WASM Sandbox, Fitness F(g), Arena
- **Simplified**: Agent Lifecycle, Gene Lifecycle, RotiferBinding
- **Stub**: Formal Verification, Cross-Binding Consistency, ZK Proofs

[0.1.0-alpha.1]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.1.0-alpha.1
