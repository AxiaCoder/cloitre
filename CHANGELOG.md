# Changelog

## [0.6.0](https://github.com/AxiaCoder/cloitre/compare/v0.5.0...v0.6.0) (2026-10-28)


### Features

* **tabs:** a tab title showed the status symbol Claude Code puts before the topic ([#80](https://github.com/AxiaCoder/cloitre/issues/80)) ([c4b15e2](https://github.com/AxiaCoder/cloitre/commit/c4b15e290a2c76ca1f521fd4772a7c4d083b909e))

## [0.5.0](https://github.com/AxiaCoder/cloitre/compare/v0.4.0...v0.5.0) (2026-10-26)


### Features

* **rail:** a project with no live session shows as paused ([#76](https://github.com/AxiaCoder/cloitre/issues/76)) ([df2df65](https://github.com/AxiaCoder/cloitre/commit/df2df65d1ecf587a9f2b9d5fd5844bc3a907ddb7))
* **tabs:** a session tab shows the title its session sets, and keeps it across restarts ([#67](https://github.com/AxiaCoder/cloitre/issues/67)) ([8242314](https://github.com/AxiaCoder/cloitre/commit/824231499ea03c2ae81666254893d49c0737cc98))
* **tabs:** a tab and its project show when a session is blocked or done ([#73](https://github.com/AxiaCoder/cloitre/issues/73)) ([b337517](https://github.com/AxiaCoder/cloitre/commit/b337517796da50e3239033002ec7c87e375fdc51))
* **tabs:** a tab and its project show when a session is working or stopped on an error ([#75](https://github.com/AxiaCoder/cloitre/issues/75)) ([217f1da](https://github.com/AxiaCoder/cloitre/commit/217f1da948a79af19e635f1424882d04ebb0dc1f))

## [0.4.0](https://github.com/AxiaCoder/cloitre/compare/v0.3.0...v0.4.0) (2026-10-26)


### Features

* **icon:** the app shows its own icon instead of the Tauri logo ([#63](https://github.com/AxiaCoder/cloitre/issues/63)) ([d410868](https://github.com/AxiaCoder/cloitre/commit/d41086875e5a777bddfeebe2ba04ccc72bc5ca29))
* **marker:** a project marker combines a color and a symbol, with a "No color" choice ([#64](https://github.com/AxiaCoder/cloitre/issues/64)) ([ae37ac8](https://github.com/AxiaCoder/cloitre/commit/ae37ac88fdd800cbfc842be4a23958d0f618d0ec))
* **release:** each release notes a Defender scan and publishes SHA-256 checksums, and the README explains the SmartScreen warning ([#61](https://github.com/AxiaCoder/cloitre/issues/61)) ([e75a252](https://github.com/AxiaCoder/cloitre/commit/e75a252904b86532f6babb2c5a2a4971e2b2e659))


### Bug Fixes

* **menu:** Tab no longer leaves the project menu while it is open ([#66](https://github.com/AxiaCoder/cloitre/issues/66)) ([77d5bc7](https://github.com/AxiaCoder/cloitre/commit/77d5bc7fd813bc070de00e3941ac2bb7685531be))

## [0.3.0](https://github.com/AxiaCoder/cloitre/compare/v0.2.0...v0.3.0) (2026-10-25)


### Features

* **updates:** the app offers newer releases and installs them from signed update files ([#59](https://github.com/AxiaCoder/cloitre/issues/59)) ([d6beb70](https://github.com/AxiaCoder/cloitre/commit/d6beb707ae26c0e9497c08c34dc60cbca050a8df))

## [0.2.0](https://github.com/AxiaCoder/cloitre/compare/v0.1.0...v0.2.0) (2026-10-25)


### Features

* **app:** a development build runs beside the installed app, with its own data folder and a (dev) title ([#45](https://github.com/AxiaCoder/cloitre/issues/45)) ([14013aa](https://github.com/AxiaCoder/cloitre/commit/14013aa729172caadbb48ebe3ce1cfadcf2f3224))
* **app:** launching the app while it runs focuses the running window instead of starting a second instance ([#32](https://github.com/AxiaCoder/cloitre/issues/32)) ([080a62a](https://github.com/AxiaCoder/cloitre/commit/080a62a3d011caa8e535ae7c2bc3011cc9978cbb))
* Claude Code runs in an xterm.js window, and the status line corruption is traced to emoji widths ([#13](https://github.com/AxiaCoder/cloitre/issues/13)) ([6db0168](https://github.com/AxiaCoder/cloitre/commit/6db0168fbef7aab6e618c4f3b8e3b017f73dd257))
* **launch:** claude is found outside a terminal PATH, and the permission list is a tested guarantee ([#21](https://github.com/AxiaCoder/cloitre/issues/21)) ([78aeae3](https://github.com/AxiaCoder/cloitre/commit/78aeae35f0456ee7d24f35f997afc4e214c52024))
* **projects:** a project is always selected when one exists, and the last one comes back on reopen ([#29](https://github.com/AxiaCoder/cloitre/issues/29)) ([7a8efd5](https://github.com/AxiaCoder/cloitre/commit/7a8efd518a6010033d480900df828ff18d2ac538))
* **projects:** claude starts only in a registered project folder, and the list survives a restart ([#22](https://github.com/AxiaCoder/cloitre/issues/22)) ([4de5bdd](https://github.com/AxiaCoder/cloitre/commit/4de5bdd5b24277434a437680c4208ba6b1e4d07d))
* **projects:** each project shows a stored color or an icon, chosen from a right-click menu ([#34](https://github.com/AxiaCoder/cloitre/issues/34)) ([4947b35](https://github.com/AxiaCoder/cloitre/commit/4947b35ecae91017a8082fd1f0b48b5ea1cc37df))
* **projects:** only one folder picker opens at a time ([#36](https://github.com/AxiaCoder/cloitre/issues/36)) ([3ef67f6](https://github.com/AxiaCoder/cloitre/commit/3ef67f6803a49e8bb3033dea177ea61673be940c))
* **projects:** the project menu shows whether a color or an icon is in use, and removes the project ([#50](https://github.com/AxiaCoder/cloitre/issues/50)) ([0fb29b2](https://github.com/AxiaCoder/cloitre/commit/0fb29b282ba9063cf371c0e61dd3c92e12a78110))
* **recordings:** sessions are recorded in development builds only, the 20 newest kept, reads capped at 64 MiB ([#33](https://github.com/AxiaCoder/cloitre/issues/33)) ([1f0f2bd](https://github.com/AxiaCoder/cloitre/commit/1f0f2bd2d1a5926596a180c6979255891b8d943f))
* **sessions:** tabs come back on reopen and resume their own conversation, even after /clear ([#25](https://github.com/AxiaCoder/cloitre/issues/25)) ([9490924](https://github.com/AxiaCoder/cloitre/commit/9490924b230729c63dcfe50e3ab4959feff601ca))
* **shell:** the window follows the mockup, and a session that cannot start shows its full error ([#26](https://github.com/AxiaCoder/cloitre/issues/26)) ([5ddfc40](https://github.com/AxiaCoder/cloitre/commit/5ddfc40517c105403642e652e80531d4015ea4e7))
* **tabs:** each project reopens on the tab that was in front ([#31](https://github.com/AxiaCoder/cloitre/issues/31)) ([90c9c4f](https://github.com/AxiaCoder/cloitre/commit/90c9c4fd275e970275d162a989cddd0584a196ba))
* **tabs:** several tabs per project, each with its own session, and switching stops none ([#24](https://github.com/AxiaCoder/cloitre/issues/24)) ([8c73bb3](https://github.com/AxiaCoder/cloitre/commit/8c73bb3db4dd210a865f73208b3999378a27fd7e))
* **version:** package.json holds the only version number, and the window title shows it ([#55](https://github.com/AxiaCoder/cloitre/issues/55)) ([394ae86](https://github.com/AxiaCoder/cloitre/commit/394ae86d983057b133cdfd0bf52362900af2fd16))


### Bug Fixes

* **keys:** Ctrl+C copies the terminal selection instead of interrupting the session ([#48](https://github.com/AxiaCoder/cloitre/issues/48)) ([fe3ca86](https://github.com/AxiaCoder/cloitre/commit/fe3ca86d7e8ec3e860312a5733ee581776261b8b))
* **pty:** composed emoji reach xterm.js unchanged, through Microsoft's ConPTY 1.25 shipped with the Windows build ([#39](https://github.com/AxiaCoder/cloitre/issues/39)) ([d47442d](https://github.com/AxiaCoder/cloitre/commit/d47442d560ea8492392d7572dc2d0ad7e2361944))
* **pty:** stopping a session left alive the processes claude started in their own console ([#23](https://github.com/AxiaCoder/cloitre/issues/23)) ([0687187](https://github.com/AxiaCoder/cloitre/commit/06871872775557d9a5ee0102d5b6cefa1c6214c7))
