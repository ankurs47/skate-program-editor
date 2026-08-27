# Third-party code in this folder

`mp3-encoder.js` is generated, not written here. It is built by
`tools/build-mp3-encoder.js` from published packages, and it is committed, so the
editor needs no network once the page is open and no third party can change what
it does. Do not edit it; rebuild it.

The rest of this repository is MIT. This file is not, and the difference matters
to anyone redistributing it.

| Component                                                                                        | Version | License |
| ------------------------------------------------------------------------------------------------ | ------- | ------- |
| [mediabunny](https://github.com/Vanilagy/mediabunny)                                             | 1.55.3  | MPL-2.0 |
| [@mediabunny/mp3-encoder](https://github.com/Vanilagy/mediabunny/tree/main/packages/mp3-encoder) | 1.55.3  | MPL-2.0 |
| [LAME](https://lame.sourceforge.io/), embedded in the above as WebAssembly                       | —       | LGPL    |

The Mozilla Public License 2.0 is file-level copyleft: the covered files stay
under it, including in a bundle like this one, and their source has to be
available to anyone who receives them. Both packages' copyright headers are kept
at the end of `mp3-encoder.js`, which is where esbuild puts them and why the
build does not strip comments. The unmodified sources are the published
versions named above.

LAME is LGPL and is included here as compiled WebAssembly, unmodified.

Nothing in this folder is loaded until someone exports an MP3.
