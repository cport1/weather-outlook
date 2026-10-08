# Changelog

## [2.0.0-alpha.3](https://github.com/cport1/weather-outlook/compare/v2.0.0-alpha.2...v2.0.0-alpha.3) (2026-10-08)


### Bug Fixes

* **test:** keep the boot-splash snapshot independent of the package version ([580b872](https://github.com/cport1/weather-outlook/commit/580b8724e548b2e01e3b6a7093db4c318740fcf6))

## [2.0.0-alpha.2](https://github.com/cport1/weather-outlook/compare/v2.0.0-alpha.1...v2.0.0-alpha.2) (2026-10-08)


### Features

* **capabilities:** Windows Terminal/conhost unicode detection and $COLUMNS fallback ([d53e46a](https://github.com/cport1/weather-outlook/commit/d53e46a9d6bdc5c58b325ec1973d00dda73e993a))
* **cli:** wire config, add, doctor, [@saved](https://github.com/saved) locations, unit flags, --format, --fields and --compact ([769e600](https://github.com/cport1/weather-outlook/commit/769e600898ca7632d9674f8bd8a7deafdc8e5ba1))
* **config:** zod-validated config file with saved locations, units, theme and provider keys ([f235ae9](https://github.com/cport1/weather-outlook/commit/f235ae9611c1212d1d4e33e3c7267e323919fa0b))
* **dist:** standalone executables via bun build --compile ([e57e745](https://github.com/cport1/weather-outlook/commit/e57e745608e28f3cdb6f471b0561e0d0a7cc7169)), closes [#51](https://github.com/cport1/weather-outlook/issues/51)
* **doctor:** terminal, cache and provider diagnostics with a glyph test pattern ([e8849e0](https://github.com/cport1/weather-outlook/commit/e8849e069e290b922ecfa3524f9e781ee542adab))
* **fx:** hail, sleet and drizzle particles with ground splashes ([a43f28e](https://github.com/cport1/weather-outlook/commit/a43f28ee9225488f586d7f3fd0c750800e086dcb))
* **hazards:** worldwide cyclones, fires, alerts, events and US outlooks ([0d4aaf5](https://github.com/cport1/weather-outlook/commit/0d4aaf56821a17632ed320cf938eee8e9a1d7bd8))
* **http:** stale-while-revalidate, LRU cache cap, Expires/If-Modified-Since and per-host rate limits ([06ab718](https://github.com/cport1/weather-outlook/commit/06ab718839cab460587aa318a65823dd369e80af))
* **location:** IP fallback chain, reverse geocoding for coordinates, ambiguous-name picker ([a1ad392](https://github.com/cport1/weather-outlook/commit/a1ad392925386c545cc0209e3606190d72feecf4))
* **map:** cached base layer, antimeridian-safe paths, states and city labels ([fe503e8](https://github.com/cport1/weather-outlook/commit/fe503e8d02f3b93dc34b46407fc52c444d391f8e))
* **map:** compose risk outlooks with field layers; E/R keys, inspectable events, credits ([4e189a7](https://github.com/cport1/weather-outlook/commit/4e189a7f7de0205cde7c46f8a40f81bfa82b7427))
* **map:** flickering fire sprites ([c61d74b](https://github.com/cport1/weather-outlook/commit/c61d74b861c3b3b7cc6db5e63009a62c7141652c))
* **map:** global field layers, day/night terminator, aurora oval, inspect model ([f75003f](https://github.com/cport1/weather-outlook/commit/f75003f1677b920c7bddac40b0397ea9f58d15a3))
* **oneshot:** responsive layout under 70 columns and a five-line --compact card ([87e4f90](https://github.com/cport1/weather-outlook/commit/87e4f90db1c2ce270ad10f4e944512911b8e78b3))
* **radar:** NEXRAD loop in the US, satellite layer, data credits and --images ([ace7f16](https://github.com/cport1/weather-outlook/commit/ace7f16b7f8754b55154cec5bce2697ff82bea06)), closes [#40](https://github.com/cport1/weather-outlook/issues/40) [#43](https://github.com/cport1/weather-outlook/issues/43) [#56](https://github.com/cport1/weather-outlook/issues/56) [#42](https://github.com/cport1/weather-outlook/issues/42)
* **render:** sky gradient by sun elevation, moon phase disk, animated icons, gauges, fire flicker ([17b5c55](https://github.com/cport1/weather-outlook/commit/17b5c5539b2e4cd653502e82b2787c9194626a26))
* **report:** --fields projection and wttr.in-style --format tokens that fetch only what they show ([55e6184](https://github.com/cport1/weather-outlook/commit/55e61848997135d1c0a1a730629da9212fd35d9d))
* **schema:** publish JSON Schema for the --json outputs ([24d8922](https://github.com/cport1/weather-outlook/commit/24d8922533bc116850525de3ce1c2b0bee5c7407))
* **tui:** clickable tabs, location search, hourly charts, gauges, count-up and boot splash ([43f24b6](https://github.com/cport1/weather-outlook/commit/43f24b6ab472fb42abaaa31778c2dbd1221468d9))
* **tui:** map mouse navigation, eased camera, goto, inspect mode and layer keys ([1215295](https://github.com/cport1/weather-outlook/commit/12152951b570e1a909be27abadf06eba978b1f0e))
* **tui:** midnight, daylight, solarized and mono themes with NO_COLOR fallback ([25b9310](https://github.com/cport1/weather-outlook/commit/25b93105c7f551e96f7887f7e9fe8c8a75d17825))
* **units:** per-measure units, Beaufort wind and locale-aware 12/24h clock ([0b78b8f](https://github.com/cport1/weather-outlook/commit/0b78b8ff28da0908a4e5123d18f724980f47483d))


### Bug Fixes

* **location:** resolve US state abbreviations like "Paris, TX" ([7c662af](https://github.com/cport1/weather-outlook/commit/7c662af2cb297a1559ca0ec14c41c42c8aebb88e))
* **map:** antimeridian land fill, label collisions, stale tab highlight ([041fa5c](https://github.com/cport1/weather-outlook/commit/041fa5c287dcb8b3b1667a9d69dc82c1cdc026b3))
* **map:** don't repeat your location's name as a city label ([1aee79a](https://github.com/cport1/weather-outlook/commit/1aee79ac73757caf1872489d83396d7c02e06163))
* **radar:** dim the satellite base so echoes and labels stand out ([8c96a48](https://github.com/cport1/weather-outlook/commit/8c96a489f56ff925bfbec9cd1d12af9c1c6e58e5))
* **tui:** fit header tabs at 80 columns and cover risk badge and map inspect in view tests ([d37dbbc](https://github.com/cport1/weather-outlook/commit/d37dbbcc2545ef41170ba80f1593ef1179ec5c09))

## [2.0.0-alpha.1](https://github.com/cport1/weather-outlook/compare/v2.0.0-alpha.0...v2.0.0-alpha.1) (2026-10-08)


### Features

* v2 terminal weather dashboard ([#58](https://github.com/cport1/weather-outlook/issues/58)) ([1337752](https://github.com/cport1/weather-outlook/commit/133775228d9a2b3403c99d4b6c55916473d3499e))
